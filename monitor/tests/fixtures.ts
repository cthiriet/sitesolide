/**
 * What the integration tests share: a test authority and its certificates,
 * drawn by openssl, and a `systemctl` that answers from files.
 *
 * Nothing here reaches a machine. The names are under `test-zone.invalid`,
 * which resolves nowhere, and every server they meet listens on the loopback.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OPENSSL = Bun.which("openssl");

export function openssl(folder: string, ...arguments_: string[]): void {
  const output = Bun.spawnSync([OPENSSL!, ...arguments_], { cwd: folder, stdout: "ignore", stderr: "pipe" });
  if (output.exitCode !== 0) throw new Error(`openssl ${arguments_[0]}: ${output.stderr.toString()}`);
}

/** A test authority in `folder`, `ca.pem` and `ca.key`. */
export function drawAuthority(folder: string): void {
  // The authority's extensions from a configuration of its own, never -addext:
  // OpenSSL 1.1, first on the PATH of GitHub's macOS runner, applies its
  // default v3_ca section as well, the certificate carries basicConstraints
  // twice, and Bun refuses every leaf it signed. LibreSSL and OpenSSL 3 agree.
  writeFileSync(join(folder, "authority.cnf"), "[req]\ndistinguished_name = dn\n[dn]\n[authority]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign\nsubjectKeyIdentifier = hash\n");
  openssl(folder, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "90",
    "-subj", "/CN=Monitor sample", "-config", "authority.cnf", "-extensions", "authority");
}

/** `<name>.pem` and `<name>.key`, signed by the authority, for these names, valid this many days. */
export function drawCertificate(folder: string, name: string, names: string[], days: number): void {
  openssl(folder, "req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${names[0]}`);
  const sans = names.map((dns) => `DNS:${dns}`).join(",");
  writeFileSync(join(folder, `${name}.ext`), `subjectAltName=${sans}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`);
  openssl(folder, "x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
    "-out", `${name}.pem`, "-days", String(days), "-extfile", `${name}.ext`);
}

/**
 * A `systemctl` in `folder` that answers `show` with the file `caddy` and
 * `list-units` with the file `units`, records every call in `calls`, refuses
 * anything else, and fails as a dead bus would while a file `broken` exists.
 */
export function fakeSystemctl(folder: string): string {
  mkdirSync(folder, { recursive: true });
  const path = join(folder, "systemctl");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `dir="${folder}"`,
      'echo "$*" >> "$dir/calls"',
      '[ -e "$dir/broken" ] && { echo "Failed to connect to bus: No such file or directory" >&2; exit 1; }',
      'case "$1" in',
      '  show) cat "$dir/caddy" ;;',
      '  list-units) cat "$dir/units" ;;',
      '  *) echo "unexpected systemctl $*" >&2; exit 1 ;;',
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  return path;
}

/** A port nobody listens on right now. */
export function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
}
