/**
 * The machine's readings, taken as an unprivileged account.
 *
 * It decides nothing: every function returns what it read, or why it could
 * not, and src/checks.ts judges. Nothing here needs root, and the unit gives
 * none (infra/monitor/sitesolide-monitor.service):
 *
 *   - systemd answers `systemctl show` and `list-units` to any account, over
 *     D-Bus; nothing here asks it to change anything;
 *   - /srv/sites is listed, by name only, and /etc/caddy/domaines.map is 0644;
 *   - /proc/meminfo and statfs are open to everyone;
 *   - Caddy is asked over HTTPS on the loopback's 443, like any visitor, and
 *     never through its admin API on 2019, which the loopback rule closes to
 *     this account anyway;
 *   - the backup status is read if the backup job left it readable.
 */
import { readdirSync, readFileSync, renameSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, type TLSSocket } from "node:tls";
import {
  readProperties,
  readUnitList,
  readValidTo,
  type BackupReading,
  type CertificateReading,
  type DiskStats,
  type ListedUnit,
  type ProbeResponse,
  type Properties,
} from "./checks";
import type { Config } from "./config";
import { deliver, type Delivery } from "./notify";

export type Reading<T> = { value: T } | { error: string };

/** Everything a run asks of the machine. The tests hand it a fake one. */
export type Machine = {
  caddy(): Promise<Reading<Properties>>;
  units(): Promise<Reading<ListedUnit[]>>;
  /** The names of the directories under /srv/sites. */
  folders(): Reading<string[]>;
  /** The domain table, null when it does not exist yet. */
  domains(): Reading<string | null>;
  meminfo(): string | null;
  disks(paths: readonly string[]): Array<{ path: string; stats: DiskStats | null }>;
  backup(): Promise<BackupReading>;
  probe(host: string, timeoutMs: number): Promise<ProbeResponse>;
  certificate(sni: string, timeoutMs: number): Promise<CertificateReading>;
  readState(): string | null;
  writeState(text: string): void;
  writeStatus(text: string): void;
  send(request: { url: string; init: RequestInit }, timeoutMs: number): Promise<Delivery>;
  log(line: string): void;
};

export type Execution = { code: number; stdout: string; stderr: string };

/** systemctl answers a reading in milliseconds; a bus that hangs must not eat the run. */
export const SYSTEMCTL_TIMEOUT_MS = 5_000;

/** At most this much of a command's output is kept. */
const MAX_OUTPUT = 512 * 1024;

/** Runs a command, bounded in time, with a minimal PATH. Never throws. */
export async function spawn(command: string[], timeoutMs: number): Promise<Execution> {
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const process = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: "/usr/bin:/bin", SYSTEMD_PAGER: "", SYSTEMD_COLORS: "0" },
      signal: timeout,
      killSignal: "SIGKILL",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (timeout.aborted) return { code: 124, stdout: "", stderr: `timed out after ${timeoutMs} ms` };
    return { code, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(-4096) };
  } catch (error) {
    return { code: 127, stdout: "", stderr: `cannot run ${command[0]}: ${(error as Error).message}` };
  }
}

/** The first line of what a failed command said, short enough for a summary. */
function firstLine(execution: Execution): string {
  const line = (execution.stderr.trim().split("\n")[0] ?? "").trim();
  const text = line === "" ? `exit code ${execution.code}` : line;
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

function errorCode(error: unknown): string {
  const { code, name, message } = error as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof code === "string" && code !== "") return code;
  if (typeof name === "string" && name !== "" && name !== "Error") return name;
  const text = typeof message === "string" ? message : String(error);
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

/**
 * Writes through a temporary file and a rename, in the same directory: the
 * collector copies status.json every minute and must never read half of it.
 */
export function writeAtomically(path: string, content: string): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

export type MachineOptions = {
  systemctl: string;
  meminfoFile: string;
};

export function createMachine(config: Config, options: MachineOptions = { systemctl: "systemctl", meminfoFile: "/proc/meminfo" }): Machine {
  const stateFile = join(config.stateDir, "state.json");
  const statusFile = join(config.stateDir, "status.json");

  return {
    async caddy() {
      const properties = ["LoadState", "ActiveState", "SubState", "Result", "NRestarts"].flatMap((p) => ["-p", p]);
      const execution = await spawn([options.systemctl, "show", "caddy.service", ...properties], SYSTEMCTL_TIMEOUT_MS);
      if (execution.code !== 0) return { error: `systemctl show: ${firstLine(execution)}` };
      return { value: readProperties(execution.stdout) };
    },

    async units() {
      const execution = await spawn(
        [options.systemctl, "list-units", "--type=service", "--all", "--plain", "--no-legend", "--no-pager"],
        SYSTEMCTL_TIMEOUT_MS,
      );
      if (execution.code !== 0) return { error: `systemctl list-units: ${firstLine(execution)}` };
      return { value: readUnitList(execution.stdout) };
    },

    folders() {
      try {
        const names = readdirSync(config.sitesDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
        return { value: names };
      } catch (error) {
        return { error: `${config.sitesDir}: ${errorCode(error)}` };
      }
    },

    domains() {
      try {
        return { value: readFileSync(config.domainsFile, "utf8") };
      } catch (error) {
        if (errorCode(error) === "ENOENT") return { value: null };
        return { error: `${config.domainsFile}: ${errorCode(error)}` };
      }
    },

    meminfo() {
      // readFileSync and not Bun.file: procfs announces a size of zero bytes,
      // and a reading that trusts it returns an empty string. The collector
      // learnt it on 31 August 2026.
      try {
        return readFileSync(options.meminfoFile, "utf8");
      } catch {
        return null;
      }
    },

    disks(paths) {
      const seen = new Set<number>();
      const found: Array<{ path: string; stats: DiskStats | null }> = [];
      for (const path of paths) {
        try {
          const device = statSync(path).dev;
          if (seen.has(device)) continue;
          seen.add(device);
          const stats = statfsSync(path);
          found.push({ path, stats: { bsize: stats.bsize, blocks: stats.blocks, bfree: stats.bfree, bavail: stats.bavail } });
        } catch {
          found.push({ path, stats: null });
        }
      }
      return found;
    },

    async backup() {
      try {
        return { text: readFileSync(config.backupFile, "utf8") };
      } catch (error) {
        const code = errorCode(error);
        if (code === "ENOENT") return { missing: true };
        // EACCES says what to do: the file carries no secret, the backup job
        // only has to leave it readable.
        return { error: code === "EACCES" ? `permission denied, ${config.backupFile} must be readable by every account` : code };
      }
    },

    async probe(host, timeoutMs) {
      // The Host header and the TLS server name both name the site: Bun
      // 1.3.11 takes the SNI and the name the certificate must carry from the
      // former (measured by the gatekeeper on 17 September 2026), later
      // versions from the latter. A certificate for another name fails with
      // ERR_TLS_CERT_ALTNAME_INVALID either way, which is `curl --resolve`.
      //
      // `redirect: "manual"`: the portal's sign-in is a redirect, and an answer
      // in itself. `decompress: false` and the body cancelled unread: only the
      // status counts, and a site has no say in how much the monitor reads.
      const url = `https://${config.probe.address}:${config.probe.port}/`;
      const tls: BunFetchRequestInitTLS = { serverName: host };
      if (config.probe.ca !== null) tls.ca = config.probe.ca;
      const options: BunFetchRequestInit & { decompress: boolean } = {
        headers: { Host: host, "Accept-Encoding": "identity", "User-Agent": "sitesolide-monitor" },
        redirect: "manual",
        keepalive: false,
        decompress: false,
        signal: AbortSignal.timeout(timeoutMs),
        tls,
      };
      try {
        const response = await fetch(url, options);
        await response.body?.cancel();
        return { status: response.status };
      } catch (error) {
        return { error: errorCode(error) };
      }
    },

    certificate(sni, timeoutMs) {
      // The certificate is read without being judged: an expired or wrong one
      // must still give its date, and the probe above is what refuses it.
      return new Promise<CertificateReading>((resolve) => {
        let settled = false;
        let socket: TLSSocket | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (reading: CertificateReading): void => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          socket?.destroy();
          resolve(reading);
        };
        timer = setTimeout(() => finish({ error: "TimeoutError" }), timeoutMs);
        try {
          const opened = connect(
            {
              host: config.probe.address,
              port: config.probe.port,
              servername: sni,
              rejectUnauthorized: false,
              ALPNProtocols: ["http/1.1"],
              ...(config.probe.ca === null ? {} : { ca: config.probe.ca }),
            },
            () => {
              const notAfter = readValidTo(opened.getPeerCertificate().valid_to ?? "");
              finish(notAfter === null ? { error: "no expiry date in the certificate" } : { notAfter });
            },
          );
          socket = opened;
          opened.on("error", (error) => finish({ error: errorCode(error) }));
        } catch (error) {
          finish({ error: errorCode(error) });
        }
      });
    },

    readState() {
      try {
        return readFileSync(stateFile, "utf8");
      } catch {
        return null;
      }
    },

    writeState(text) {
      writeAtomically(stateFile, text);
    },

    writeStatus(text) {
      writeAtomically(statusFile, text);
    },

    send(request, timeoutMs) {
      return deliver(request, timeoutMs);
    },

    log(line) {
      console.log(line);
    },
  };
}
