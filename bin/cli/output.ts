/**
 * What `--json` prints: one event per line on standard output, for a program
 * rather than a person.
 *
 * The builders of small software are more and more often agents, and an agent
 * reading `-> build (bun run build)` has to guess where a step ends and what
 * the run concluded. With `--json`, every line the CLI would have printed
 * becomes an event, the run ends with exactly one `result` or one `error`, and
 * nothing else reaches standard output: the output of the build, of rsync and
 * of the scripts of bin/ arrives as `output` events, so that a line of theirs
 * can never be mistaken for one of ours.
 *
 *   {"type":"step","message":"build (bun run build)"}
 *   {"type":"planned","message":"rsync -a --delete ..."}
 *   {"type":"result","ok":true,"command":"deploy","url":"https://shop.example.com/"}
 *   {"type":"error","message":"build failed: bun run build","details":[],"hint":"..."}
 *
 * The human output is not built from these events and does not change: the
 * output layer of bin/sitesolide.ts chooses one or the other, and only there.
 *
 * Also here, the readings that turn what the machine prints for a person, the
 * status table, the journal and the lock table, into data. They read the very
 * text the human commands show, so that the two modes never ask the machine
 * different questions, the journal's JSON aside. The status table's script
 * sits beside its reading, STATUS_SCRIPT.
 *
 * Pure, the line splitter of a stream aside: returns values, touches nothing.
 */
import type { ServiceKind } from "./manifest";

/** Every event `--json` can print. `docs/agents.md` describes them for whoever reads them. */
export type OutputEvent =
  /** A step of the run, the `-> ...` lines of the human output. */
  | { type: "step"; message: string }
  /** Something said along the way: a file found present, a decision explained. */
  | { type: "info"; message: string }
  /** What a dry run would have done, and did not. */
  | { type: "planned"; message: string }
  /**
   * Something went wrong without stopping the run: the old form of `secrets`,
   * runtime secrets the store lacks, a legacy file missing, a store that could
   * not be listed. `details` name the commands that fix it, never a value.
   */
  | { type: "warning"; message: string; details: string[] }
  /** A line printed by a command the CLI launched: the build, rsync, a script of bin/. */
  | { type: "output"; stream: "stdout" | "stderr"; line: string }
  /** A file the run generated and shows: a systemd unit, a Caddy block. */
  | { type: "file"; name: string; content: string }
  /** The manifest inferred from a folder that has none, see bin/cli/infer.ts. */
  | { type: "inferred"; kind: string; manifest: Record<string, unknown>; reasons: string[]; notes: string[] }
  /** One journal entry, for `logs`. */
  | { type: "log"; at: string | null; unit: string | null; priority: number | null; message: string }
  /**
   * One line of `setup`'s or `upgrade`'s checklist: a step found already
   * done, run now, skipped, still to do in a dry run, or failed. See
   * bin/cli/steps.ts.
   */
  | { type: "check"; step: string; status: "done" | "ok" | "skip" | "todo" | "fail"; title: string; detail: string | null }
  /**
   * The last event of a run that succeeded, with what it concluded. deploy's
   * carries `missingSecrets`, the declared runtime names and files the store
   * lacks (null when they could not be read, or in a dry run), and
   * `buildSecrets`, each build secret's name and where its value came from.
   */
  | ({ type: "result"; ok: true; command: string } & Record<string, unknown>)
  /** The last event of a run that failed: what, why, and what to do next. */
  | { type: "error"; message: string; details: string[]; hint: string };

/** One event, one line: JSON never carries a raw line break inside a string. */
export function formatEvent(event: OutputEvent): string {
  return JSON.stringify(event);
}

/**
 * The event a line of the human output stands for, or null for a line that
 * only spaces the human output out.
 *
 * The CLI's messages already carry their kind in their shape: `-> ` opens a
 * step, `[dry-run] ` a planned command, `!! ` a warning. Reading it here
 * spares every call site a second, JSON-only, wording of the same message.
 */
export function eventFor(line: string): OutputEvent | null {
  const message = line.trimStart();
  if (message.trim() === "") return null;
  if (message.startsWith("-> ")) return { type: "step", message: message.slice(3) };
  if (message.startsWith("[dry-run] ")) return { type: "planned", message: message.slice("[dry-run] ".length) };
  if (message.startsWith("!! ")) return { type: "warning", message: message.slice(3), details: [] };
  return { type: "info", message: message.trimEnd() };
}

/**
 * Calls `onLine` for every line of a stream, the last one included when it
 * has no line break. A chunk ends anywhere, in the middle of a line or of a
 * character: the decoder keeps a split character, and the buffer a split line.
 *
 * `limit`, for a stream someone else writes: a line longer than `length`
 * characters is never held whole, nor handed over; `onOverflow` is called
 * once for it, and reading resumes at the next line.
 */
export async function forEachLine(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
  limit?: { length: number; onOverflow: () => void },
): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  /** The rest of a line already found too long, dropped up to its end. */
  let skipping = false;
  const deliver = (line: string): void => {
    if (limit !== undefined && line.length > limit.length) limit.onOverflow();
    else onLine(line);
  };
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    let end = pending.indexOf("\n");
    while (end !== -1) {
      const line = pending.slice(0, end).replace(/\r$/, "");
      pending = pending.slice(end + 1);
      if (skipping) skipping = false;
      else deliver(line);
      end = pending.indexOf("\n");
    }
    if (limit !== undefined && pending.length > limit.length) {
      if (!skipping) limit.onOverflow();
      skipping = true;
      pending = "";
    }
  }
  pending += decoder.decode();
  if (pending !== "" && !skipping) deliver(pending.replace(/\r$/, ""));
}

// --- what a project runs -----------------------------------------------------

/** How many services of each kind a project declares, see ServiceKind in manifest.ts. */
export type Runs = { servers: number; workers: number; scheduled: number };

export function runsOf(services: readonly { kind: ServiceKind }[]): Runs {
  const count = (kind: ServiceKind): number => services.filter((service) => service.kind === kind).length;
  return { servers: count("server"), workers: count("worker"), scheduled: count("scheduled") };
}

/**
 * What the first line of `deploy` says a project runs. A project that only
 * serves is named as it always was, `service` or `3 services`; once a worker
 * or a scheduled service is among them, each kind is counted on its own,
 * `2 services, 1 worker, 1 scheduled`, a service then meaning one that
 * listens on its port.
 */
export function describeRuns(isApplication: boolean, runs: Runs): string {
  if (!isApplication) return "static";
  if (runs.workers === 0 && runs.scheduled === 0) return runs.servers > 1 ? `${runs.servers} services` : "service";
  const parts: string[] = [];
  if (runs.servers > 0) parts.push(`${runs.servers} service${runs.servers > 1 ? "s" : ""}`);
  if (runs.workers > 0) parts.push(`${runs.workers} worker${runs.workers > 1 ? "s" : ""}`);
  if (runs.scheduled > 0) parts.push(`${runs.scheduled} scheduled`);
  return parts.join(", ");
}

// --- status ------------------------------------------------------------------

/** One unit of a project, as `status` reads it on the machine. Memory figures in megabytes. */
export type UnitStatus = {
  /**
   * `active`, `inactive`, `failed`...; null for a project with no unit, a
   * static site. `waiting` for a scheduled service between two runs, its
   * timer armed: inactive is its ordinary state, not a service that is down.
   */
  service: string | null;
  memoryMB: number | null;
  peakMB: number | null;
  limitMB: number | null;
};

/**
 * When a scheduled service runs, as its timer says it: the calendar
 * expression, the last run with how it ended, and the next. The times are
 * systemd's, as `systemctl show` writes them, `Mon 2026-10-12 14:00:00 UTC`;
 * null for a run that never happened, or none to come.
 */
export type ScheduleStatus = {
  schedule: string;
  lastRun: string | null;
  /** systemd's Result of the last run, `success`, `exit-code`, `timeout`...; null when it never ran. */
  lastResult: string | null;
  nextRun: string | null;
};

export type ServiceStatus = UnitStatus & { name: string; unit: string } & Partial<ScheduleStatus>;

export type ProjectStatus = UnitStatus & {
  slug: string;
  /** As `du -h` writes it, `12M`; null when it could not be measured. */
  size: string | null;
  /**
   * The project's other services, `<slug>.<name>`, for a project that
   * declares several; a scheduled one carries its schedule, see
   * ScheduleStatus.
   */
  services: ServiceStatus[];
};

export type MachineStatus = {
  projects: ProjectStatus[];
  /** The ports listening on 127.0.0.1. */
  ports: number[];
  /** `free -m`'s memory line, in megabytes, keyed by its column names; null when absent. */
  memory: Record<string, number> | null;
};

/**
 * What `sitesolide status` runs on the machine, a read from start to end: the
 * machine's state is read there, never in a file of the repository, which
 * would lie from the first deployment made from somewhere else. One string,
 * with real line breaks: the pieces joined by "; " produced ";;" that the
 * remote shell refused, and the empty output passed for silence. readStatus
 * reads what it prints back into data.
 */
export const STATUS_SCRIPT = `
echo "=== projects served ==="
printf "%-22s %-8s %-10s %-8s %-8s %s\n" PROJECT SIZE SERVICE MEMORY PEAK LIMIT
megabytes() {
  case "$1" in
    ""|"[not set]"|infinity) echo "-" ;;
    *) echo "$(($1 / 1048576))MB" ;;
  esac
}
# One line per unit: the project's main one, named after its folder, then the
# others of a project with several services, <slug>.<name>, indented under it.
row() {
  name=$1 size=$2 unit=$3
  # A static site has no unit, and the landing's one does not carry the name of
  # its folder: showing "inactive" in those two cases would suggest a service
  # that is down. LoadState tells a missing unit from a stopped one.
  if [ "$(systemctl show "$unit" -p LoadState --value 2>/dev/null)" = loaded ]; then
    service=$(systemctl is-active "$unit" 2>/dev/null || true)
  else
    service="-"
  fi
  # A scheduled service runs when its timer starts it, and between two runs
  # it is inactive, which is not a service that is down: it reads "waiting"
  # while its timer is armed. A failed last run still reads failed, and an
  # inactive service whose timer is not armed inactive: nothing would run it.
  timer=/etc/systemd/system/$unit.timer
  if [ -e "$timer" ] && [ "$service" = inactive ] && [ "$(systemctl is-active "$unit.timer" 2>/dev/null)" = active ]; then
    service=waiting
  fi
  memory=$(megabytes "$(systemctl show "$unit" -p MemoryCurrent --value 2>/dev/null)")
  # The peak since the last start, which systemd keeps itself. It is the only way
  # to read a MemoryMax decision back: the current value says nothing of the
  # moment when the service consumed the most, and sampling from the outside
  # misses the short spikes. It resets to zero on every restart, so a figure
  # taken just after a deployment measures nothing.
  peak=$(megabytes "$(systemctl show "$unit" -p MemoryPeak --value 2>/dev/null)")
  # The ceiling in service, and not the manifest's one: it is the unit set on the
  # machine that decides, and a manifest changed without deploy --force does not change it.
  # The three columns together are what makes the decision readable again.
  cap=$(megabytes "$(systemctl show "$unit" -p MemoryMax --value 2>/dev/null)")
  printf "%-22s %-8s %-10s %-8s %-8s %s\n" "$name" "$size" "$service" "$memory" "$peak" "$cap"
  # A scheduled service: when it runs, its last run and how it ended, and
  # the next, on a line of their own under its row. The times are systemd's,
  # "n/a" or nothing for one that never was. The last run is the service's
  # own start, not the timer's LastTriggerUSec: a persistent timer stamps
  # the moment it was first started, a deployment, as a trigger that ran
  # nothing, and a run started by hand is no trigger at all.
  [ -e "$timer" ] || return 0
  schedule=$(sed -n 's/^OnCalendar=//p' "$timer" | head -n 1)
  last=$(systemctl show "$unit" -p ExecMainStartTimestamp --value 2>/dev/null)
  next=$(systemctl show "$unit.timer" -p NextElapseUSecRealtime --value 2>/dev/null)
  case "$last" in
    ""|n/a) last=never ;;
    *) last="$last ($(systemctl show "$unit" -p Result --value 2>/dev/null))" ;;
  esac
  case "$next" in ""|n/a) next=none ;; esac
  printf "    schedule %s; last run %s; next run %s\n" "$schedule" "$last" "$next"
}
for folder in /srv/sites/*/; do
  slug=$(basename "$folder")
  row "$slug" "$(du -sh "$folder" 2>/dev/null | cut -f1)" "$slug"
  for file in /etc/systemd/system/"$slug".*.service; do
    [ -e "$file" ] || continue
    unit=$(basename "$file" .service)
    row "  .\${unit#"$slug".}" "" "$unit"
  done
done

echo
echo "=== ports listening on loopback ==="
ss -ltn 2>/dev/null | grep 127.0.0.1 | awk '{print $4}' | sort -u

echo
echo "=== memory ==="
free -m | head -2
`;

/** `12MB` -> 12, `-` -> null: the shape `megabytes()` of the status script writes. */
function megabytes(value: string | undefined): number | null {
  const match = /^([0-9]+)MB$/.exec(value ?? "");
  return match === null ? null : Number(match[1]);
}

function unitStatus(service: string | undefined, memory: string | undefined, peak: string | undefined, limit: string | undefined): UnitStatus {
  return {
    service: service === undefined || service === "-" ? null : service,
    memoryMB: megabytes(memory),
    peakMB: megabytes(peak),
    limitMB: megabytes(limit),
  };
}

/**
 * The text of `sitesolide status`, read back into data.
 *
 * The rows are written by `printf` with a space between every column, and no
 * column carries a space of its own, so splitting on spaces is enough. Two
 * columns can be empty, and an empty column leaves no word: the size of a
 * project's other services, always, and the size of a project `du` could not
 * measure. A row of five words is therefore one without its size.
 *
 * A scheduled service's row is followed by a line of its own, its schedule,
 * see readSchedule, which completes that row.
 */
export function readStatus(text: string): MachineStatus {
  const status: MachineStatus = { projects: [], ports: [], memory: null };
  let section = "";
  let memoryColumns: string[] = [];
  for (const line of text.split("\n")) {
    const heading = /^=== (.+) ===$/.exec(line.trim());
    if (heading !== null) {
      section = heading[1]!;
      continue;
    }
    if (line.trim() === "") continue;
    const words = line.trim().split(/\s+/);

    if (section === "projects served") {
      if (words[0] === "PROJECT") continue;
      const schedule = readSchedule(line);
      if (schedule !== null) {
        const service = status.projects.at(-1)?.services.at(-1);
        if (service !== undefined) Object.assign(service, schedule);
        continue;
      }
      if (line.startsWith("  .")) {
        const parent = status.projects.at(-1);
        if (parent === undefined) continue;
        const [name = "", service, memory, peak, limit] = words;
        const short = name.slice(1);
        parent.services.push({ name: short, unit: `${parent.slug}.${short}`, ...unitStatus(service, memory, peak, limit) });
        continue;
      }
      const [slug = "", ...rest] = words;
      const [size, service, memory, peak, limit] = rest.length >= 5 ? rest : [undefined, ...rest];
      status.projects.push({ slug, size: size ?? null, ...unitStatus(service, memory, peak, limit), services: [] });
    } else if (section === "ports listening on loopback") {
      const port = /:([0-9]+)$/.exec(line.trim());
      if (port !== null) status.ports.push(Number(port[1]));
    } else if (section === "memory") {
      if (words[0] === "total") {
        memoryColumns = words;
      } else if (words[0] === "Mem:" && memoryColumns.length > 0) {
        const values = words.slice(1).map(Number);
        status.memory = Object.fromEntries(memoryColumns.map((column, i) => [column, values[i] ?? 0]));
      }
    }
  }
  return status;
}

/**
 * The line `status` prints under a scheduled service's row, or null for any
 * other line: `    schedule hourly; last run Mon 2026-10-12 14:00:00 UTC
 * (success); next run Mon 2026-10-12 15:00:00 UTC`, `never` for a service
 * that has not run yet, `none` when no run is to come. Split on `; `, which
 * neither a schedule (isValidSchedule) nor a time of systemd's carries.
 */
export function readSchedule(line: string): ScheduleStatus | null {
  const match = /^\s+schedule (.+); last run (.+); next run (.+)$/.exec(line.trimEnd());
  if (match === null) return null;
  const [, schedule = "", last = "", next = ""] = match;
  const run = /^(.+) \(([a-z-]*)\)$/.exec(last);
  return {
    schedule,
    lastRun: run === null ? null : run[1]!,
    lastResult: run === null || run[2] === "" ? null : run[2]!,
    nextRun: next === "none" ? null : next,
  };
}

// --- journal -----------------------------------------------------------------

/** A journal field as `journalctl -o json` writes it: text, or bytes when it is not valid UTF-8. */
function journalText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte))) {
    return new TextDecoder().decode(new Uint8Array(value as number[]));
  }
  return null;
}

/**
 * One line of `journalctl -o json`, as a `log` event. A line that is not a
 * journal entry is kept as its message rather than dropped: what journalctl
 * says about itself is worth as much as what the service said.
 */
export function readJournalEntry(line: string): Extract<OutputEvent, { type: "log" }> {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return { type: "log", at: null, unit: null, priority: null, message: line };
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return { type: "log", at: null, unit: null, priority: null, message: line };
  }
  const fields = entry as Record<string, unknown>;
  const microseconds = Number(fields.__REALTIME_TIMESTAMP);
  const priority = Number(fields.PRIORITY);
  return {
    type: "log",
    at: Number.isFinite(microseconds) && fields.__REALTIME_TIMESTAMP !== undefined ? new Date(microseconds / 1000).toISOString() : null,
    unit: journalText(fields._SYSTEMD_UNIT),
    priority: Number.isInteger(priority) && fields.PRIORITY !== undefined ? priority : null,
    message: journalText(fields.MESSAGE) ?? "",
  };
}

// --- lock --------------------------------------------------------------------

/** One row of `bin/lock.sh state`. Never the code itself: the table does not carry it. */
export type LockState = {
  /** What the manifest on the machine asks for. */
  wanted: boolean;
  /** Whether Caddy carries the lock's stanza. */
  installed: boolean;
  /** The HTTP status a visitor without the code gets. */
  withoutCode: number | null;
  /** The HTTP status with the code in service, null when no code is installed. */
  withCode: number | null;
  /** The final domain column as the script writes it, null for a project without one. */
  domain: string | null;
};

/**
 * The project's row of the table `bin/lock.sh state` prints, or null when the
 * table has none: a dry run, or a script that stopped before its row.
 */
export function readLockState(text: string, slug: string): LockState | null {
  for (const line of text.split("\n")) {
    const words = line.trim().split(/\s+/);
    if (words[0] !== slug || words.length < 6) continue;
    const [, wanted, installed, withoutCode, withCode, ...domain] = words;
    const code = (value: string | undefined): number | null => (value !== undefined && /^[0-9]{3}$/.test(value) ? Number(value) : null);
    return {
      wanted: wanted === "true",
      installed: installed === "yes",
      withoutCode: code(withoutCode),
      withCode: code(withCode),
      domain: domain.join(" ") === "-" ? null : domain.join(" "),
    };
  }
  return null;
}
