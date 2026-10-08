/**
 * What each reading of the machine means, decided without the machine.
 *
 * Pure: every function receives what was read, `systemctl`'s text, a byte
 * count, a date, and returns a verdict. Nothing here touches the disk, the
 * network or the clock, so that every threshold is checked by a test rather
 * than discovered on the night it fires. The readings belong to
 * `src/machine.ts`, the memory of what was already said to `src/alerts.ts`.
 *
 * A verdict is one of three words. `ok` and `fail` are what they say;
 * `unknown` is a reading that could not be taken, and it is not a failure: the
 * alert state machine keeps the check where it was. A dead `systemctl` must
 * not turn into "every service recovered", nor a Caddy that is down into
 * "every site failed" on top of the one alert that matters.
 */

export type Severity = "critical" | "warning";

/**
 * What a check is about. The dashboard leaves out the kinds it already judges
 * itself, a project's unit, the disk and the memory: two rows for one fact
 * would only make the list longer.
 */
export type Kind =
  | "caddy"
  | "restarts"
  | "site"
  | "certificate"
  | "unit"
  | "platform"
  | "disk"
  | "memory"
  | "backup"
  | "monitor";

export type Verdict = "ok" | "fail" | "unknown";

export type Result = {
  /** Stable from one run to the next: the state machine follows it. */
  id: string;
  kind: Kind;
  /** What the check names: a host, a unit, a mount point. */
  label: string;
  severity: Severity;
  /** The served directory concerned, for the dashboard's link, or null. */
  slug: string | null;
  verdict: Verdict;
  /**
   * What was seen, a sentence in English that reads alone: in a message, in
   * the journal and among the dashboard's Issues. It opens with a capital
   * unless it opens with a name, a unit, an address or a path, which keep
   * their case. Never a secret.
   */
  summary: string;
};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `systemctl show`'s `Key=value` lines, as they come. */
export type Properties = Record<string, string>;

export function readProperties(output: string): Properties {
  const properties: Properties = {};
  for (const line of output.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    properties[line.slice(0, separator)] = line.slice(separator + 1).trim();
  }
  return properties;
}

/** One line of `systemctl list-units --plain --no-legend`. */
export type ListedUnit = { name: string; load: string; active: string; sub: string };

/**
 * The four first columns of `systemctl list-units --type=service --all --plain
 * --no-legend`. The description that follows may hold spaces and is dropped.
 * A failed unit may be preceded by a bullet on some versions even under
 * `--plain`; it is skipped rather than taken for a name.
 */
export function readUnitList(output: string): ListedUnit[] {
  const units: ListedUnit[] = [];
  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] === "●" || columns[0] === "*") columns.shift();
    const [name, load, active, sub] = columns;
    if (name === undefined || load === undefined || active === undefined || sub === undefined) continue;
    if (!name.endsWith(".service")) continue;
    units.push({ name, load, active, sub });
  }
  return units;
}

// --- Caddy -------------------------------------------------------------------

/**
 * Caddy is active, or it is not. `reloading` counts as active: it is what
 * `systemctl reload caddy` shows for the instant of a configuration change,
 * which every deployment makes.
 */
export function judgeCaddy(show: Properties | null): Result {
  const base = { id: "caddy", kind: "caddy", label: "caddy", severity: "critical", slug: null } as const;
  if (show === null) return { ...base, verdict: "unknown", summary: "Caddy's state could not be read from systemctl" };
  if (show.LoadState !== "loaded") {
    return { ...base, verdict: "fail", summary: `caddy.service is not loaded (${show.LoadState ?? "unknown"})` };
  }
  const active = show.ActiveState ?? "unknown";
  const sub = show.SubState ?? "unknown";
  if (active === "active" || active === "reloading") {
    return { ...base, verdict: "ok", summary: `Caddy is ${active} (${sub})` };
  }
  const result = show.Result !== undefined && show.Result !== "" ? `, result ${show.Result}` : "";
  return { ...base, verdict: "fail", summary: `Caddy is ${active} (${sub})${result}` };
}

/** How long an automatic restart of Caddy stays worth an alert. */
export const RESTART_WINDOW_MS = 15 * MINUTE;

/** What the monitor keeps of Caddy's restart counter between two runs. */
export type RestartMemory = { count: number; increasedAt: number | null };

/**
 * Has systemd restarted Caddy on its own since the last run?
 *
 * Since the drop-in sets `Restart=always`, a `caddy stop` sent to the admin API
 * no longer takes the sites down for long: systemd starts Caddy again within
 * seconds, and the only trace left is `NRestarts`. That counter going up is
 * worth an alert of its own, because something stopped Caddy and will do it
 * again. It is a warning held for fifteen minutes, then recovered: an event
 * turned into a state, so that it goes through the same state machine and
 * cannot repeat every minute.
 *
 * The first reading is a baseline and says nothing: restarts older than the
 * monitor are not news. The counter going down is a restart asked of systemd,
 * which resets it, and is not news either.
 */
export function judgeRestarts(
  show: Properties | null,
  memory: RestartMemory | null,
  now: number,
): { result: Result; memory: RestartMemory | null } {
  const base = { id: "caddy-restarts", kind: "restarts", label: "caddy", severity: "warning", slug: null } as const;
  const raw = show?.NRestarts;
  const count = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(count) || count < 0) {
    return { result: { ...base, verdict: "unknown", summary: "Caddy's restart counter could not be read" }, memory };
  }

  let next: RestartMemory;
  if (memory === null) next = { count, increasedAt: null };
  else if (count > memory.count) next = { count, increasedAt: now };
  else next = { count, increasedAt: memory.increasedAt };

  if (next.increasedAt !== null && now - next.increasedAt < RESTART_WINDOW_MS) {
    const ago = Math.max(0, Math.round((now - next.increasedAt) / MINUTE));
    return {
      result: {
        ...base,
        verdict: "fail",
        summary:
          `Caddy was restarted by systemd on its own ${ago === 0 ? "less than a minute" : `${ago} min`} ago ` +
          `(NRestarts ${count}): something stopped it, see journalctl -u caddy`,
      },
      memory: next,
    };
  }
  return { result: { ...base, verdict: "ok", summary: "No automatic restart of Caddy in the last 15 min" }, memory: next };
}

// --- units -------------------------------------------------------------------

/** The unit this very run belongs to, which never judges itself. */
export const SELF_UNIT = "sitesolide-monitor.service";

/** The platform's own units carry this prefix, the landing's aside. */
export const PLATFORM_PREFIX = "sitesolide-";

/**
 * A unit that crashes in a loop is `activating (auto-restart)` most of the
 * time, never `failed`, since `Restart=always` keeps trying: read as healthy,
 * it would never be reported.
 */
function crashLooping(unit: ListedUnit): boolean {
  return unit.active === "activating" && unit.sub === "auto-restart";
}

/**
 * The units of the projects, and the failed units of the platform.
 *
 * `projectUnits` maps a project's main unit, without `.service`, to its
 * directory: `<slug>`, or `sitesolide-landing` for the landing. A project's
 * other services are `<slug>.<name>.service`, found by that prefix, a slug never
 * holding a dot. They come from what systemd has loaded, not from the
 * manifests: what the machine runs is the truth for a failed unit, and a unit a
 * manifest declares but that is missing is the dashboard's to report.
 *
 * A project's unit fails when it is failed, crashing in a loop, or stopped:
 * nothing on the platform stops a project's service for good, `sitesolide
 * remove` deletes it. The platform's units fail only when failed or looping,
 * since several are one-shots whose rest state is `inactive`; they are
 * warnings, a stopped collector or steward degrading the dashboard rather than
 * a site.
 */
export function judgeUnits(units: readonly ListedUnit[], projectUnits: ReadonlyMap<string, string>): Result[] {
  const results: Result[] = [];
  const slugs = new Set(projectUnits.values());

  for (const unit of units) {
    if (unit.load !== "loaded" || unit.name === SELF_UNIT) continue;
    const bare = unit.name.slice(0, -".service".length);
    const dot = bare.indexOf(".");
    const owner = projectUnits.get(bare) ?? (dot > 0 && slugs.has(bare.slice(0, dot)) ? bare.slice(0, dot) : undefined);
    const state = `${unit.name} is ${unit.active} (${unit.sub})`;

    if (owner !== undefined) {
      const failing = unit.active === "failed" || unit.active === "inactive" || crashLooping(unit);
      results.push({
        id: `unit:${unit.name}`,
        kind: "unit",
        label: unit.name,
        severity: "critical",
        slug: owner,
        verdict: failing ? "fail" : "ok",
        summary: state,
      });
      continue;
    }

    if (unit.name.startsWith(PLATFORM_PREFIX)) {
      const failing = unit.active === "failed" || crashLooping(unit);
      results.push({
        id: `unit:${unit.name}`,
        kind: "platform",
        label: unit.name,
        severity: "warning",
        slug: null,
        verdict: failing ? "fail" : "ok",
        summary: state,
      });
    }
  }
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

// --- sites over HTTPS ----------------------------------------------------------

export type ProbeResponse = { status: number } | { error: string };

/**
 * A site answers when Caddy hands back anything below 500, certificate
 * verified on the way.
 *
 * A 401 is a locked preview or a site behind the portal, a 302 the portal's
 * sign-in, a 404 a site whose root serves nothing, an API for instance: all of
 * them prove Caddy serves the host with a valid certificate, which is what
 * this check is for. A 502 is a service behind Caddy that does not answer, and
 * a failed handshake an expired or wrong certificate.
 */
export function judgeProbe(host: string, slug: string | null, response: ProbeResponse): Result {
  const base = { id: `site:${host}`, kind: "site", label: host, severity: "critical", slug } as const;
  if ("error" in response) {
    return { ...base, verdict: "fail", summary: `https://${host}/ did not answer: ${response.error}` };
  }
  return {
    ...base,
    verdict: response.status < 500 ? "ok" : "fail",
    summary: `https://${host}/ answered ${response.status}`,
  };
}

/** A probe that was not attempted: the state machine keeps the site where it was. */
export function notProbed(host: string, slug: string | null, reason: string): Result {
  return { id: `site:${host}`, kind: "site", label: host, severity: "critical", slug, verdict: "unknown", summary: reason };
}

// --- certificates ----------------------------------------------------------------

/** Below this, a certificate that has not been renewed deserves a look. */
export const CERTIFICATE_WARNING_DAYS = 14;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The `valid_to` of a peer certificate, written by OpenSSL as
 * `Oct  9 17:58:41 2026 GMT`, in milliseconds, or null. Parsed here rather than
 * handed to `Date.parse`, which accepts that form in Bun today without any
 * standard promising it will tomorrow.
 */
export function readValidTo(text: string): number | null {
  const parts = /^([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4}) GMT$/.exec(text.trim());
  if (parts === null) return null;
  const month = MONTHS.indexOf(parts[1]!);
  if (month === -1) return null;
  const [day, hour, minute, second, year] = parts.slice(2).map(Number) as [number, number, number, number, number];
  const ms = Date.UTC(year, month, day, hour, minute, second);
  const date = new Date(ms);
  // Date.UTC carries 31 February over into March: the re-reading refuses it.
  if (date.getUTCDate() !== day || date.getUTCMonth() !== month) return null;
  return ms;
}

export type CertificateReading = { notAfter: number } | { error: string };

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A certificate that expires within fourteen days is a warning.
 *
 * Caddy renews a certificate well before that, around a third of its lifetime
 * before the end, so one this close to expiry means renewal has been failing
 * for days: a DNS token that lost its rights, a customer domain whose DNS moved
 * away. A warning and not critical: the site still works, and the day it stops,
 * the HTTPS probe fails its handshake and says so as critical.
 *
 * A certificate that could not be read is unknown, not failed: the site's own
 * probe already reports a host that does not answer.
 */
export function judgeCertificate(
  target: { id: string; label: string; slug: string | null },
  reading: CertificateReading,
  now: number,
): Result {
  const base = { id: target.id, kind: "certificate", label: target.label, severity: "warning", slug: target.slug } as const;
  if ("error" in reading) {
    return { ...base, verdict: "unknown", summary: `The certificate for ${target.label} could not be read: ${reading.error}` };
  }
  const left = reading.notAfter - now;
  const days = Math.floor(left / DAY);
  const day = isoDay(reading.notAfter);
  if (left <= 0) {
    return { ...base, verdict: "fail", summary: `The certificate for ${target.label} expired on ${day}` };
  }
  if (left < CERTIFICATE_WARNING_DAYS * DAY) {
    const when = days === 0 ? "in less than a day" : `in ${days} day${days === 1 ? "" : "s"}`;
    return { ...base, verdict: "fail", summary: `The certificate for ${target.label} expires ${when}, on ${day}` };
  }
  return { ...base, verdict: "ok", summary: `The certificate for ${target.label} is valid until ${day}` };
}

// --- disk and memory --------------------------------------------------------------

/**
 * Two thresholds each, the higher to raise the alert and the lower to end it.
 * A disk that hovers at 90 % would otherwise go down and recover every few
 * minutes, which is exactly the storm this monitor must never produce.
 */
export const DISK_ALERT_PERCENT = 90;
export const DISK_CLEAR_PERCENT = 85;
export const MEMORY_ALERT_PERCENT = 10;
export const MEMORY_CLEAR_PERCENT = 15;

export type DiskStats = { bsize: number; blocks: number; bfree: number; bavail: number };

/** Bytes, in the unit a person reads at a glance. */
export function bytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let rank = 0;
  while (size >= 1000 && rank < units.length - 1) {
    size /= 1000;
    rank++;
  }
  return `${rank === 0 ? size : size.toFixed(1)} ${units[rank]}`;
}

/**
 * The share of a filesystem in use, counted as `df` does: what is used over
 * what is used plus what an ordinary account may still take. The blocks
 * reserved for root are left out of both, so the figure matches the one the
 * author would check by hand.
 *
 * Critical: a full disk stops SQLite's writes, the journal and Caddy's
 * certificate storage at once, for every site.
 */
export function judgeDisk(path: string, stats: DiskStats | null, wasBad: boolean): Result {
  const base = { id: `disk:${path}`, kind: "disk", label: path, severity: "critical", slug: null } as const;
  if (stats === null || stats.blocks <= 0) {
    return { ...base, verdict: "unknown", summary: `The size of ${path} could not be read` };
  }
  const used = stats.blocks - stats.bfree;
  const reachable = used + stats.bavail;
  if (reachable <= 0) return { ...base, verdict: "unknown", summary: `The size of ${path} could not be read` };
  const percent = Math.round((used / reachable) * 100);
  const threshold = wasBad ? DISK_CLEAR_PERCENT : DISK_ALERT_PERCENT;
  return {
    ...base,
    verdict: percent >= threshold ? "fail" : "ok",
    summary: `${path} is ${percent}% full, ${bytes(stats.bavail * stats.bsize)} free`,
  };
}

/** `MemTotal` and `MemAvailable` of /proc/meminfo, in bytes, or null. */
export function readMeminfo(text: string): { total: number; available: number } | null {
  const value = (key: string): number | null => {
    const line = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(text);
    return line === null ? null : Number(line[1]) * 1024;
  };
  const total = value("MemTotal");
  const available = value("MemAvailable");
  if (total === null || available === null || total <= 0) return null;
  return { total, available };
}

/**
 * Memory the machine could still hand out, `MemAvailable`, the cache counting
 * as free since the kernel reclaims it. A warning rather than critical: a
 * build may take most of it for a minute, and when a service is actually
 * killed for lack of memory, its unit and its site say so as critical.
 */
export function judgeMemory(text: string | null, wasBad: boolean): Result {
  const base = { id: "memory", kind: "memory", label: "memory", severity: "warning", slug: null } as const;
  const memory = text === null ? null : readMeminfo(text);
  if (memory === null) return { ...base, verdict: "unknown", summary: "/proc/meminfo could not be read" };
  const percent = Math.round((memory.available / memory.total) * 100);
  const threshold = wasBad ? MEMORY_CLEAR_PERCENT : MEMORY_ALERT_PERCENT;
  return {
    ...base,
    verdict: percent < threshold ? "fail" : "ok",
    summary: `${percent}% of memory available, ${bytes(memory.available)} of ${bytes(memory.total)}`,
  };
}

// --- backups -------------------------------------------------------------------

/**
 * Beyond this, the last backup is too old. A daily run plus two hours of
 * slack: a run that starts late or takes long is not news, a missed day is.
 */
export const BACKUP_MAX_AGE_MS = 26 * HOUR;

/**
 * Beyond this, a repository's last check is too old: the backup job checks
 * each repository once a day, and three days without one means its daily
 * maintenance keeps failing to start.
 */
export const BACKUP_CHECK_MAX_AGE_MS = 72 * HOUR;

export type BackupReading = { missing: true } | { text: string } | { error: string };

/** How long ago, in the largest unit that fits. */
export function ago(ms: number): string {
  if (ms < MINUTE) return "less than a minute";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min`;
  if (ms < 2 * DAY) return `${Math.floor(ms / HOUR)} h`;
  return `${Math.floor(ms / DAY)} days`;
}

/** At most this many project names in a summary, then a count. */
const MAX_NAMED = 5;

/**
 * The status the backup job leaves in /var/lib/sitesolide-backup/last-run.json:
 *
 *   { "startedAt": ISO, "finishedAt": ISO, "ok": boolean,
 *     "projects": { "<slug>": { "ok": boolean, "snapshot": string | null, "error": string | null } },
 *     "checks": { "local": Check | null, "offsite": Check | null } }
 *
 * `checks`, absent from a job before restic, the last daily check of the
 * server's repository and of the bucket's, `{ "at": ISO, "ok": boolean,
 * "error": string | null }`, null before the first or without a bucket, and
 * `since` and `offsiteSince`, when checks of each were first due.
 *
 * A missing file is no check at all, backups being installed separately; a
 * file that is there but unreadable or malformed is a failure, since it is
 * exactly what a broken backup job would leave. A run that failed, or one that
 * finished more than 26 hours ago, is a warning: nothing is down, but the next
 * accident would have nothing recent to restore from. So is a repository
 * whose check failed, or was not checked for three days: its snapshots may
 * not restore.
 */
export function judgeBackup(reading: BackupReading, now: number): Result | null {
  if ("missing" in reading) return null;
  const base = { id: "backup", kind: "backup", label: "backups", severity: "warning", slug: null } as const;
  if ("error" in reading) {
    return { ...base, verdict: "fail", summary: `The backup status could not be read: ${reading.error}` };
  }

  let status: unknown;
  try {
    status = JSON.parse(reading.text);
  } catch {
    return { ...base, verdict: "fail", summary: "The backup status is not valid JSON" };
  }
  const record = status as { finishedAt?: unknown; ok?: unknown; projects?: unknown } | null;
  const finished = typeof record?.finishedAt === "string" ? Date.parse(record.finishedAt) : Number.NaN;
  if (typeof record !== "object" || record === null || typeof record.ok !== "boolean" || !Number.isFinite(finished)) {
    return { ...base, verdict: "fail", summary: "The backup status does not have the expected shape" };
  }

  const projects =
    typeof record.projects === "object" && record.projects !== null ? Object.entries(record.projects) : [];
  const failed = projects
    .filter(([, project]) => (project as { ok?: unknown } | null)?.ok !== true)
    .map(([slug]) => slug)
    .sort();
  const age = ago(Math.max(0, now - finished));

  if (!record.ok || failed.length > 0) {
    const named = failed.slice(0, MAX_NAMED).join(", ");
    const more = failed.length > MAX_NAMED ? ` and ${failed.length - MAX_NAMED} more` : "";
    const which = failed.length > 0 ? ` for ${named}${more}` : "";
    return { ...base, verdict: "fail", summary: `The last backup run failed${which}, ${age} ago` };
  }
  if (now - finished > BACKUP_MAX_AGE_MS) {
    return { ...base, verdict: "fail", summary: `The last backup run finished ${age} ago, more than 26 h` };
  }
  const checks = (record as { checks?: unknown }).checks;
  const problems: string[] = [];
  if (typeof checks === "object" && checks !== null) {
    for (const [key, sinceKey, which] of [
      ["local", "since", "server's"],
      ["offsite", "offsiteSince", "bucket's"],
    ] as const) {
      const check = (checks as Record<string, unknown>)[key] as { at?: unknown; ok?: unknown; error?: unknown } | null | undefined;
      if (typeof check !== "object" || check === null) {
        // None yet: fine on a first day, a maintenance that never runs past three.
        const due = (checks as Record<string, unknown>)[sinceKey];
        const since = typeof due === "string" ? Date.parse(due) : Number.NaN;
        if (Number.isFinite(since) && now - since > BACKUP_CHECK_MAX_AGE_MS) problems.push(`the ${which} repository was never checked, its checks due for ${ago(now - since)}`);
        continue;
      }
      const at = typeof check.at === "string" ? Date.parse(check.at) : Number.NaN;
      if (!Number.isFinite(at) || typeof check.ok !== "boolean") continue;
      const when = ago(Math.max(0, now - at));
      if (!check.ok) problems.push(`the ${which} repository check failed ${when} ago${typeof check.error === "string" ? ` (${check.error.slice(0, 200)})` : ""}`);
      else if (now - at > BACKUP_CHECK_MAX_AGE_MS) problems.push(`the ${which} repository was last checked ${when} ago, more than 72 h`);
    }
  }
  if (problems.length > 0) {
    const text = problems.join("; ");
    return { ...base, verdict: "fail", summary: `Backups: ${text}` };
  }
  const count = `${projects.length} project${projects.length === 1 ? "" : "s"}`;
  return { ...base, verdict: "ok", summary: `The last backup run finished ${age} ago, ${count}` };
}

// --- the monitor itself ------------------------------------------------------------

/**
 * What this run could not do: a reading that failed, an alerting address that
 * is not one. A warning, so that a monitor half blind says so on the dashboard
 * and to the webhook, rather than reporting "all clear" on what it did not see.
 */
export function judgeSelf(problems: readonly string[]): Result {
  const base = { id: "monitor", kind: "monitor", label: "monitor", severity: "warning", slug: null } as const;
  if (problems.length === 0) return { ...base, verdict: "ok", summary: "The monitor read everything it checks" };
  return { ...base, verdict: "fail", summary: `The monitor could not run fully: ${problems.join("; ")}` };
}
