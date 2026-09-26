import { file } from "bun";
import { join } from "node:path";
import { contextOf, measure, cleanUp } from "./src/api";
import {
  BODY_MAX,
  DATA_DIR,
  SNAPSHOT_STEP_MS,
  PURGE_STEP_MS,
  PORT,
  PUBLIC_DIR,
  PUBLIC_URL,
} from "./src/config";
import { write } from "./src/snapshot";
import { cacheControl, resolveAsset } from "./src/http";
import { HEADERS, plainText } from "./src/responses";

const server = Bun.serve({
  port: PORT,

  /**
   * Caddy is the only client, from the same machine.
   *
   * **Without this line, Bun listens on `0.0.0.0`** and the port is offered to
   * anything that reaches the machine. The host's firewall and ufw close it
   * today, but a firewall rule must not be the only thing protecting a service:
   * here, the visitor's address would no longer be the one Caddy reports, and
   * ingestion would write for whoever reached it directly.
   */
  hostname: "127.0.0.1",

  /**
   * A measurement signal fits in two hundred bytes. The ceiling is applied by
   * Bun before the body is read in full: without it, a malicious page would
   * grow the service's memory up to the systemd unit's ceiling, which would
   * kill it, and every site would stop being measured.
   */
  maxRequestBodySize: BODY_MAX,

  development: process.env.NODE_ENV !== "production",

  routes: {
    /**
     * Ingestion, and the only route of this service.
     *
     * It is exempted from the portal by the manifest, along with the script:
     * these are the only two paths an anonymous visitor reaches, and the portal
     * stays in front of everything else. There is nothing behind any more, the
     * pages having moved to the dashboard, but a door guarding a service
     * without a page costs nothing and will matter the day a page comes back.
     */
    "/e": {
      // Bun passes the server as the second argument, and it is the server that
      // knows the peer's address. It only serves as a fallback: online, the
      // peer is Caddy, and the visitor's address is the one X-Forwarded-For
      // carries.
      POST: async (req, server) =>
        measure(
          await req.text(),
          contextOf(req, server.requestIP(req)?.address ?? "", Date.now()),
        ),
    },
  },

  /** The rest: the files of `public/`, which Caddy serves itself online. */
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") {
      return plainText("method not allowed", 405);
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const resolved = resolveAsset(path, PUBLIC_DIR);
    if (resolved === null) return plainText("not found", 404);

    const asset = file(resolved);
    if (!(await asset.exists())) return plainText("not found", 404);

    return new Response(asset, {
      headers: { ...HEADERS, "Cache-Control": cacheControl(path) },
    });
  },

  error(err) {
    // The detail goes to the service's log, never to the caller: an error
    // message from SQLite names columns and file paths.
    console.error("uncaught error:", err);
    return plainText("internal error", 500);
  },
});

/**
 * Maintenance runs inside the service rather than in a systemd timer.
 *
 * A `sqlite3` launched from outside would open a second write connection on a
 * database this service already holds, and a massive `DELETE` would take the
 * lock on it while ingestion writes. Here it shares the connection, and so the
 * queue.
 */
async function maintain(): Promise<void> {
  try {
    const { byAge, byCount, salts } = await cleanUp(Date.now());
    if (byAge + byCount + salts > 0) {
      console.log(`purge: ${byAge} expired, ${byCount} beyond the ceiling, ${salts} salts`);
    }
  } catch (err) {
    // A failed purge must not stop the service: it keeps receiving, and the
    // next round will pick the work back up.
    console.error("purge failed:", err);
  }
}

/**
 * The snapshot dropped for the dashboard, more often than maintenance.
 *
 * The dashboard's collector passes every minute: dropping it less often would
 * make the numbers stale while saving nothing, dropping it more often would
 * bring nothing since nobody would come to fetch them in the meantime.
 */
async function publish(): Promise<void> {
  try {
    await write(join(DATA_DIR, "instantane.json"), Date.now());
  } catch (err) {
    // A missed snapshot is made up for at the next minute. The dashboard, for
    // its part, says the age of what it shows: a drop that stopped would be
    // seen there without this service having to report it.
    console.error("snapshot failed:", err);
  }
}

setInterval(() => void publish(), SNAPSHOT_STEP_MS);
await publish();

// An explicit `void`: the timer cannot await the promise, and `maintain`
// already catches everything that could throw.
setInterval(() => void maintain(), PURGE_STEP_MS);

// The timer alone is not enough: without this first round, the day before
// yesterday's salts would survive one hour longer on every restart, and a
// service relaunched in a loop would never destroy them.
await maintain();

console.log(`analytics on http://localhost:${server.port} (public: ${PUBLIC_URL})`);
