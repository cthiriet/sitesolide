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
import type { Socket } from "bun";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import type { Caller } from "../src/proc-net";
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

/**
 * A client that sends and reads nothing until told to, as one that writes its
 * whole request before looking at the answer does: whatever reaches it in the
 * meantime waits in its kernel, where a reset would throw it away unread.
 * `read` reads again, then everything until the proxy closes, or until the
 * delay.
 */
export async function lateReader(port: number) {
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
  socket.pause();
  return {
    socket,
    async read(timeoutMs = 3000): Promise<string> {
      socket.resume();
      const timer = setTimeout(() => {
        socket.end();
        resolve();
      }, timeoutMs);
      await promise;
      clearTimeout(timer);
      return new TextDecoder().decode(Bun.concatArrayBuffers(chunks));
    },
  };
}

/** An audit that only remembers what it was told. */
export function recordingAudit() {
  const denied: { target: string | null; destination: string | null; reason: string; account?: string | null }[] = [];
  return {
    denied,
    audit: {
      denied: (entry: (typeof denied)[number]) => void denied.push(entry),
      recent: () => [],
    },
  };
}

/** An identification by the client's port, as the kernel's would be, the table filled by the test. */
export function identifyByPort(owners: Map<number, Caller>) {
  return async (peer: { remotePort: number }): Promise<Caller> => {
    // The test learns its client's port once connected, which may come a
    // moment after the proxy asks.
    for (let i = 0; i < 200 && !owners.has(peer.remotePort); i++) await Bun.sleep(2);
    return owners.get(peer.remotePort) ?? { kind: "unknown", reason: "no owner in the test" };
  };
}

/** What a flooding end writes at a time: big enough to fill every buffer on the way quickly. */
export const BLOCK = new Uint8Array(1024 * 1024).fill(9);

/**
 * The most a socket's kernel receive buffer grows to: on Linux the third field
 * of net.ipv4.tcp_rmem, 6 MiB by default; on macOS net.inet.tcp.autorcvbufmax,
 * 4 MiB by default. Read from the machine running the tests, never assumed:
 * a constant that fits one is either too loose or too tight on the other.
 */
function receiveBufferMax(): number {
  const value =
    process.platform === "darwin"
      ? Bun.spawnSync(["sysctl", "-n", "net.inet.tcp.autorcvbufmax"]).stdout.toString()
      : readFileSync("/proc/sys/net/ipv4/tcp_rmem", "utf8").trim().split(/\s+/)[2];
  const bytes = Number(value?.trim());
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`the kernel's receive buffer maximum does not read: ${JSON.stringify(value)}`);
  return bytes;
}

/**
 * How far past a mark or a budget the socket being read when it is crossed may
 * still go, as DEFAULT_LIMITS in src/proxy.ts works it out: its pause lands
 * once its kernel receive buffer is drained, plus the one read of up to 512 KiB
 * Bun hands over. The tests' allowances follow from it: a guess of 4 MiB sat
 * under the 4.5 MiB macOS allows, and failed one release run in a few.
 */
export const OVERSHOOT = receiveBufferMax() + 512 * 1024;

/**
 * One end of a connection that writes as fast as the other lets it and reads
 * nothing: what makes the proxy hold bytes for it. `limit`, when set, is the
 * most it writes in all.
 */
export type Flood = { socket: Socket<undefined> | null; written: number; on: boolean; limit?: number };

/**
 * Writes until the socket takes no more, or until the flood's limit. A short
 * write turns a paused Bun socket's reading back on (see `write` in
 * src/sockets.ts): resume() then pause() puts it back, or this end would read
 * after all.
 */
export function pump(flood: Flood): void {
  while (flood.on && flood.socket !== null) {
    const left = (flood.limit ?? Infinity) - flood.written;
    if (left <= 0) return;
    const block = left < BLOCK.length ? BLOCK.subarray(0, left) : BLOCK;
    const written = flood.socket.write(block);
    if (written > 0) flood.written += written;
    if (written < block.length) {
      flood.socket.resume();
      flood.socket.pause();
      return;
    }
  }
}
