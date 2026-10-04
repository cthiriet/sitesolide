/**
 * What the integration tests share: a certificate made on the spot, a raw
 * client that speaks to the proxy byte for byte, and a resolver and a router
 * that keep every connection on this workstation.
 *
 * **No connection leaves the machine.** The hosts are under
 * test-zone.invalid, which resolves nowhere; the resolver answers addresses
 * the classification calls public, and the router sends those to a local
 * server, refusing any address it does not know. A route forgotten in a test
 * lands on a closed local port, never on the address itself.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import type { Lookup } from "../src/resolve";

export const OPENSSL = Bun.which("openssl");

/**
 * A self-signed certificate for these names, made by openssl in a throwaway
 * folder and removed at once: no key is ever committed, and none outlives the
 * run.
 */
export function certificate(names: string[]): { cert: string; key: string } {
  const folder = mkdtempSync(join(DATA_DIR, "tls-"));
  try {
    const result = Bun.spawnSync([
      OPENSSL!,
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(folder, "key.pem"),
      "-out",
      join(folder, "cert.pem"),
      "-days",
      "1",
      "-subj",
      `/CN=${names[0]}`,
      "-addext",
      `subjectAltName=${names.map((name) => `DNS:${name}`).join(",")}`,
    ]);
    if (result.exitCode !== 0) throw new Error(`openssl: ${result.stderr.toString()}`);
    return { cert: readFileSync(join(folder, "cert.pem"), "utf8"), key: readFileSync(join(folder, "key.pem"), "utf8") };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** A resolver that knows only the names a test gives it. */
export function stubLookup(answers: Record<string, string[]>): Lookup & { asked: string[] } {
  const asked: string[] = [];
  const lookup = async (host: string) => {
    asked.push(host);
    const answer = answers[host];
    if (answer === undefined) throw new Error(`ENOTFOUND ${host}`);
    return answer;
  };
  return Object.assign(lookup, { asked });
}

/**
 * A router from the public addresses a test uses to local ports. It records
 * each address it is asked for: that is what proves the proxy connects to the
 * address it judged, and not to a second resolution of the name.
 */
export function stubRoute(table: Record<string, number>) {
  const asked: string[] = [];
  const route = (address: string, port: number) => {
    asked.push(`${address}:${port}`);
    const local = table[`${address}:${port}`];
    // Port 1 on the loopback is closed: an unknown route fails here.
    return { hostname: "127.0.0.1", port: local ?? 1 };
  };
  return Object.assign(route, { asked });
}

/** Sends raw bytes and reads everything until the proxy closes, or until the delay. */
export async function rawExchange(port: number, request: string | Uint8Array, timeoutMs = 5000): Promise<string> {
  const chunks: Uint8Array[] = [];
  const { promise, resolve } = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket, chunk) {
        chunks.push(new Uint8Array(chunk));
      },
      close() {
        resolve();
      },
      error() {
        resolve();
      },
    },
  });
  socket.write(request);
  const timer = setTimeout(() => {
    socket.end();
    resolve();
  }, timeoutMs);
  await promise;
  clearTimeout(timer);
  return new TextDecoder().decode(Bun.concatArrayBuffers(chunks));
}

/** An audit that only remembers what it was told. */
export function recordingAudit() {
  const denied: { target: string | null; destination: string | null; reason: string; account?: string | null }[] = [];
  const used: { slug: string; connector: string; status: number | null }[] = [];
  return {
    denied,
    used,
    audit: {
      denied: (entry: (typeof denied)[number]) => void denied.push(entry),
      used: (slug: string, connector: string, status: number | null) => void used.push({ slug, connector, status }),
      recent: () => [],
    },
  };
}
