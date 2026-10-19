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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * An authority of the test's own and the certificates it signs, one per list
 * of names. What a test of the name check needs: a chain the client trusts
 * whole, so that a refusal can only be about the name. Made and removed like
 * the self-signed ones above.
 */
export function authority(leaves: string[][]): { ca: string; leaves: { cert: string; key: string }[] } {
  const folder = mkdtempSync(join(DATA_DIR, "ca-"));
  const run = (args: string[]) => {
    const result = Bun.spawnSync([OPENSSL!, ...args], { cwd: folder });
    if (result.exitCode !== 0) throw new Error(`openssl: ${result.stderr.toString()}`);
  };
  try {
    // The authority's extensions from a configuration of its own, never -addext:
    // OpenSSL 1.1, first on the PATH of GitHub's macOS runner, applies its
    // default v3_ca section as well, the certificate carries basicConstraints
    // twice, and Bun refuses every leaf it signed. LibreSSL and OpenSSL 3 agree.
    writeFileSync(join(folder, "authority.cnf"), "[req]\ndistinguished_name = dn\n[dn]\n[authority]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign,cRLSign\nsubjectKeyIdentifier = hash\n");
    run([
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1",
      "-subj", "/CN=sitesolide test authority",
      "-config", "authority.cnf", "-extensions", "authority",
    ]);
    const issued = leaves.map((names, index) => {
      run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${index}.key`, "-out", `${index}.csr`, "-subj", `/CN=${names[0]}`]);
      writeFileSync(
        join(folder, `${index}.ext`),
        `subjectAltName=${names.map((name) => `DNS:${name}`).join(",")}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`,
      );
      run([
        "x509", "-req", "-in", `${index}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", String(1000 + index),
        "-out", `${index}.pem`, "-days", "1", "-extfile", `${index}.ext`,
      ]);
      return { cert: readFileSync(join(folder, `${index}.pem`), "utf8"), key: readFileSync(join(folder, `${index}.key`), "utf8") };
    });
    return { ca: readFileSync(join(folder, "ca.pem"), "utf8"), leaves: issued };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * A TLS server that answers any request with a small 200 and keeps every
 * decrypted byte it was sent: what proves a credential never reached it, not
 * even as a request the server would have refused.
 */
export function recordingTlsServer(tls: { cert: string; key: string }) {
  const received: string[] = [];
  let handshakes = 0;
  let connections = 0;
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    socket: {
      // A connection the proxy opened, whatever became of its handshake: a
      // client that refuses the certificate's name may abort the handshake
      // before the server counts it as done (Bun 1.4 on Linux does, 1.3 on
      // macOS completes it and the proxy refuses after).
      open() {
        connections++;
      },
      handshake() {
        handshakes++;
      },
      data(socket, chunk) {
        received.push(new TextDecoder().decode(chunk));
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        socket.end();
      },
    },
  });
  return { port: listener.port, received, handshakes: () => handshakes, connections: () => connections, stop: () => listener.stop(true) };
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
