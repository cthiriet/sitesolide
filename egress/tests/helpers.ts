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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    run([
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1",
      "-subj", "/CN=sitesolide test authority",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
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
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    socket: {
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
  return { port: listener.port, received, handshakes: () => handshakes, stop: () => listener.stop(true) };
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
