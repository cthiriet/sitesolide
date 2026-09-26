/**
 * `server.ts` launched for real, in a subprocess: importing it would start a
 * server on the service's port, inside the very process of the tests, and its
 * maintenance timer would stop them handing control back.
 *
 * `PORT=0` makes a free port be drawn, which the startup line announces. Each
 * launch receives its own `DATA_DIR`, under the tests' one, so that its
 * database crosses no other file's.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";

export interface StartedServer {
  db: string;
  port: number;
  stop: () => void;
}

export async function startServer(dir: string): Promise<StartedServer> {
  // The directory is created here because the service does not create it:
  // online, it is `sitesolide deploy` that puts it there, and the systemd unit
  // grants write access to it alone. A service that created its own data
  // directory would hide the day the unit had not given it to it.
  const dataDir = join(DATA_DIR, dir);
  mkdirSync(dataDir, { recursive: true });

  const child = Bun.spawn([process.execPath, "server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, PORT: "0", NODE_ENV: "production", DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "inherit",
  });

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let lu = "";
  let port = "";
  const limit = Date.now() + 5000;
  while (Date.now() < limit) {
    const { value, done } = await reader.read();
    if (done) break;
    lu += decoder.decode(value, { stream: true });
    const found = /http:\/\/localhost:(\d+)/.exec(lu);
    if (found?.[1] !== undefined) {
      port = found[1];
      break;
    }
  }
  reader.releaseLock();

  if (port === "") {
    child.kill();
    throw new Error(`server.ts did not announce its address: ${lu}`);
  }

  // The address is rebuilt on the loopback: the service listens only there, and
  // `localhost` may resolve to IPv6 first on some machines.
  return {
    db: `http://127.0.0.1:${port}`,
    port: Number(port),
    stop: () => child.kill(),
  };
}
