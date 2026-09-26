/**
 * The lock that the CLI, the scripts in bin/ and the dashboard's gatekeeper
 * share before touching Caddy's configuration.
 *
 * The gatekeeper puts up and takes down a site's portal on the VM: it rewrites
 * the deposited manifest and the block, validates and reloads. `sitesolide
 * deploy`, bin/deploy-caddy.sh and bin/lock.sh read the VM's door, then deposit
 * minutes later, and may restore a backup with `rsync --delete`. A gatekeeper
 * action falling inside that window was overwritten with nothing to say so: a
 * site closed from the dashboard went back to being served in the clear. The
 * lock closes the window.
 *
 * **One directory, `/run/sitesolide-gatekeeper/caddy.lock`**, created by a
 * non-recursive `mkdir`, which succeeds for a single one of the candidates or
 * fails for all of them: the take is atomic with nothing else. The parent is
 * created beforehand, by `mkdir -p`. The directory holds `holder`, a line
 * `<who> <pid> <ms>`. The time is the VM's, written by the VM: the gatekeeper
 * compares with the same clock, and a workstation twenty minutes behind would
 * not pass its own lock off as stale.
 *
 * **Held, it makes the caller refuse** with the holder and the UTC time of the
 * take, saying when it is the dashboard changing a door. **Past fifteen
 * minutes, it is stale**, by the holder's time, or by the directory's if the
 * holder is unreadable: an action killed without being able to hand it back, by
 * a `kill -9` or a workstation cut off. It is then taken over, and the output
 * says so. An unreadable holder in a recent directory is held: that is a
 * candidate that has not written it yet.
 *
 * **Taking over or handing back goes through a rename**, never through the `rm`
 * of a directory in place: the lock is first moved aside in a single action,
 * then read again where it is, and erased only if it is still the one we
 * thought. Otherwise it is put back. Handing back, on every path, aims only at
 * the lock whose holder is still the line written at the take.
 *
 * **Ownership is passed on** to a script launched by an action that already
 * holds the lock, through `CADDY_LOCK_HELD` which carries the whole line: the
 * script checks on the VM that the holder is indeed that one, then takes and
 * hands back nothing.
 *
 * Everything that leaves for the VM is generated here and goes under
 * `sudo sh -c '…'`. Each script starts with
 * `: caddy-lock <action> <arguments>;`, with no effect for the shell: the
 * command thus reads by itself in sudo's log, and the simulated VM of the tests
 * recognises it without imitating it. No value coming from outside enters it
 * without having been checked by readHolder.
 *
 * Pure, with one exception: takeLock, releaseLock and checkOwnership
 * chain the commands through an executor they are handed, which is what allows
 * testing them on a tree on the workstation.
 */

/** Where the gatekeeper keeps its state, and the shared lock. */
export const RUN_DIR = "/run/sitesolide-gatekeeper";
export const LOCK_NAME = "caddy.lock";
export const HOLDER_NAME = "holder";

/** Past this, a lock is taken to be abandoned, and taken over. */
export const STALE_MS = 15 * 60 * 1000;
const STALE_MIN = STALE_MS / 60_000;

/**
 * The holders the workstation writes. The gatekeeper writes `gatekeeper`, and
 * any name of the form `[a-z][a-z0-9-]{0,31}` reads: a holder unknown here is
 * still a holder, which we name in the refusal rather than take for unreadable.
 */
export const HOLDERS = ["deploy-caddy", "lock", "deploy", "generate-domains", "deploy-gatekeeper"] as const;
export type Who = (typeof HOLDERS)[number];

/** The name the dashboard's gatekeeper writes. */
export const GATEKEEPER = "gatekeeper";

/** The variable that passes ownership of the lock on to a called script. */
export const HELD_VARIABLE = "CADDY_LOCK_HELD";

export const MARKERS = {
  taken: "TAKEN",
  held: "HELD",
  stale: "STALE",
  recent: "RECENT",
  end: "END",
  release: "RELEASED",
  other: "OTHER",
  absent: "ABSENT",
  owned: "OWNED",
} as const;

export function lockPath(root = RUN_DIR): string {
  return `${root}/${LOCK_NAME}`;
}

export type Holder = { who: string; pid: number; since: number };

function isWho(text: string): text is Who {
  return (HOLDERS as readonly string[]).includes(text);
}

/**
 * The holder's line, read strictly: a name, a pid, milliseconds, separated by a
 * single space. Everything else is unreadable, and that is also what guarantees
 * that an accepted line carries no character the remote shell would interpret.
 */
export function readHolder(text: string): Holder | null {
  const found = /^([a-z][a-z0-9-]{0,31}) ([0-9]{1,10}) ([0-9]{1,15})$/.exec(text.trim());
  if (found === null) return null;
  return { who: found[1]!, pid: Number(found[2]), since: Number(found[3]) };
}

export function holderLine(holder: Holder): string {
  return `${holder.who} ${holder.pid} ${holder.since}`;
}

/** `14:03:07 UTC`: the time alone, a lock never living more than a quarter of an hour. */
export function utcTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 19)} UTC`;
}

function requireWho(who: string): Who {
  if (!isWho(who)) throw new Error(`unknown lock holder: ${who}`);
  return who;
}

function requirePid(pid: number): number {
  if (!Number.isInteger(pid) || pid < 0 || pid > 9_999_999_999) throw new Error(`invalid pid: ${pid}`);
  return pid;
}

function requireLine(line: string): string {
  const holder = readHolder(line);
  if (holder === null) throw new Error(`invalid lock holder line: ${line}`);
  return holderLine(holder);
}

function requireRoot(root: string): string {
  if (/[\s'"$\\`;]/.test(root)) throw new Error(`unexpected root: ${root}`);
  return root;
}

/**
 * The VM's time in milliseconds in `$t`. `%3N` belongs to GNU date, the VM's;
 * another `date` copies it out as is, and the time then falls back to the
 * second, which is enough for a quarter-of-an-hour lock.
 */
const VM_TIME = `t=$(date +%s%3N); case "$t" in *[!0-9]*) t="$(date +%s)000";; esac;`;

/**
 * The take itself: `mkdir -p` of the parent directory, then `mkdir` of the
 * lock. On success, the holder is written with the VM's time, and a write that
 * fails hands the directory back at once: a lock without a holder would tell
 * nobody who took it. Held, the answer gives the VM's time, whether the
 * directory is more than fifteen minutes old, and what the holder carries.
 */
function takeBody(who: Who, pid: number, root: string): string[] {
  const m = MARKERS;
  return [
    `r=${root};`,
    `d="$r/${LOCK_NAME}";`,
    `mkdir -p "$r" || exit 1;`,
    `if mkdir "$d" 2>/dev/null; then`,
    ` ${VM_TIME}`,
    ` l="${who} ${pid} $t";`,
    ` printf "%s\\n" "$l" > "$d/${HOLDER_NAME}" || { rm -rf "$d"; exit 1; };`,
    ` echo "${m.taken} $l";`,
    `elif [ -d "$d" ]; then`,
    ` ${VM_TIME}`,
    ` echo "${m.held} $t";`,
    ` if [ -n "$(find "$d" -maxdepth 0 -mmin +${STALE_MIN} 2>/dev/null)" ]; then echo ${m.stale}; else echo ${m.recent}; fi;`,
    ` cat "$d/${HOLDER_NAME}" 2>/dev/null;`,
    " echo;",
    ` echo ${m.end};`,
    "else exit 1; fi",
  ];
}

export function takeScript(who: Who, pid: number, root = RUN_DIR): string {
  const q = requireWho(who);
  const p = requirePid(pid);
  return [`: caddy-lock take ${q} ${p};`, ...takeBody(q, p, requireRoot(root))].join(" ");
}

/**
 * Is the lock, where it is, in the expected state? The same holder, word for
 * word, or for an unreadable holder (`line` null), a directory still fifteen
 * minutes old. A rename inside the same parent directory does not change the
 * date of the renamed directory: the condition reads again after it.
 */
function stateCondition(path: string, line: string | null): string {
  return line === null
    ? `[ -n "$(find "${path}" -maxdepth 0 -mmin +${STALE_MIN} 2>/dev/null)" ]`
    : `[ "$(cat "${path}/${HOLDER_NAME}" 2>/dev/null)" = "${line}" ]`;
}

/**
 * Removes the lock if it is in the expected state, without ever erasing
 * somebody else's: moved aside by a single rename, read again, erased if it is
 * indeed the one we expected, put back otherwise. `after` and `otherwise` are the
 * commands that follow one case and the other.
 */
function removeIfState(line: string | null, after: string, otherwise: string): string[] {
  return [
    `d="$r/${LOCK_NAME}"; e="$d.aside.$$";`,
    `if ${stateCondition("$d", line)} && mv "$d" "$e" 2>/dev/null; then`,
    ` if ${stateCondition("$e", line)}; then rm -rf "$e"; ${after}`,
    ` else [ -e "$d" ] || mv "$e" "$d"; rm -rf "$e"; ${otherwise} fi;`,
    `else ${otherwise} fi;`,
  ];
}

/**
 * The takeover of a lock judged stale, then the take. The lock is removed only
 * if it is still in the judged state; a lock taken over in the meantime by
 * someone else, or just created, stays in place, and the take that follows
 * finds it held.
 *
 * `previous` is null for an unreadable holder: its content never enters the
 * script.
 */
export function takeoverScript(who: Who, pid: number, previous: string | null, root = RUN_DIR): string {
  const q = requireWho(who);
  const p = requirePid(pid);
  const r = requireRoot(root);
  const line = previous === null ? null : requireLine(previous);
  return [
    `: caddy-lock retake ${q} ${p} ${line ?? "-"};`,
    `r=${r};`,
    ...removeIfState(line, ":;", ":;"),
    ...takeBody(q, p, r),
  ].join(" ");
}

/** The hand back: erased if and only if the holder is still `line`. */
export function releaseScript(line: string, root = RUN_DIR): string {
  const l = requireLine(line);
  const m = MARKERS;
  return [
    `: caddy-lock release ${l};`,
    `r=${requireRoot(root)};`,
    ...removeIfState(
      l,
      `echo ${m.release};`,
      `if [ -d "$d" ]; then echo ${m.other}; cat "$d/${HOLDER_NAME}" 2>/dev/null; echo; echo ${m.end}; else echo ${m.absent}; fi;`,
    ),
  ].join(" ");
}

/** The check of a passed-on ownership, writing nothing. */
export function checkScript(line: string, root = RUN_DIR): string {
  const l = requireLine(line);
  const m = MARKERS;
  return [
    `: caddy-lock verify ${l};`,
    `d="${requireRoot(root)}/${LOCK_NAME}";`,
    `if [ "$(cat "$d/${HOLDER_NAME}" 2>/dev/null)" = "${l}" ]; then echo ${m.owned};`,
    `elif [ -d "$d" ]; then echo ${m.other}; cat "$d/${HOLDER_NAME}" 2>/dev/null; echo; echo ${m.end};`,
    `else echo ${m.absent}; fi`,
  ].join(" ");
}

/** The command as ssh passes it to the login shell. */
export function lockCommand(script: string): string {
  if (script.includes("'")) throw new Error("a lock script cannot hold a single quote");
  return `sudo sh -c '${script}'`;
}

// --- readings ----------------------------------------------------------------

export type Execution = { code: number; output: string; error: string };

export type TakeAnswer =
  | { kind: "taken"; line: string; holder: Holder }
  | { kind: "held"; now: number; stale: boolean; content: string }
  | { kind: "unreadable"; reason: string };

function failureReason(execution: Execution): string {
  return execution.error.trim().split("\n").at(-1)?.slice(0, 200) || `exit code ${execution.code}`;
}

/**
 * What the VM says about a take or a takeover. A command that fails, or an
 * answer that does not follow the format, is unreadable: neither a take nor a
 * free lock is deduced from it. `expected`, when given, is the holder asked for:
 * a take announced in somebody else's name is not ours.
 */
export function readTakeAnswer(execution: Execution, expected?: { who: string; pid: number }): TakeAnswer {
  if (execution.code !== 0) return { kind: "unreadable", reason: failureReason(execution) };
  const lines = execution.output.split("\n");
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  const first = lines[0] ?? "";

  if (first.startsWith(`${MARKERS.taken} `)) {
    const holder = readHolder(first.slice(MARKERS.taken.length + 1));
    const other = expected !== undefined && (holder?.who !== expected.who || holder?.pid !== expected.pid);
    if (holder === null || other || lines.length !== 1) {
      return { kind: "unreadable", reason: "unexpected answer to the lock" };
    }
    return { kind: "taken", line: holderLine(holder), holder };
  }

  const held = new RegExp(`^${MARKERS.held} ([0-9]{1,15})$`).exec(first);
  const age = lines[1];
  if (held !== null && (age === MARKERS.stale || age === MARKERS.recent) && lines.at(-1) === MARKERS.end && lines.length >= 3) {
    return {
      kind: "held",
      now: Number(held[1]),
      stale: age === MARKERS.stale,
      content: lines.slice(2, -1).join("\n").trim(),
    };
  }
  return { kind: "unreadable", reason: first === "" ? "no answer" : "unexpected answer to the lock" };
}

export type TakeDecision =
  | { kind: "taken"; line: string }
  | { kind: "rejects"; message: string; details: string[] }
  /** To take over: `previous` is the line read, or null for an unreadable holder. */
  | { kind: "stale"; previous: string | null; announcement: string };

/**
 * The refusal of a held lock. The gatekeeper says on its side "Caddy is being
 * changed from the workstation (...)": here, it is the dashboard we name.
 */
function heldMessage(holder: Holder | null): string {
  if (holder === null) return "Caddy is being changed by an unidentified holder; try again in a moment";
  const since = utcTime(holder.since);
  return holder.who === GATEKEEPER
    ? `a portal change from the dashboard is in progress (since ${since}): try again in a moment`
    : `Caddy is being changed by ${holder.who} since ${since}; try again in a moment`;
}

/**
 * Taken, held, or stale. A readable holder is stale past fifteen minutes by the
 * VM's clock; an unreadable holder, when the directory itself is that old. An
 * unreadable holder in a recent directory is that of a candidate that has not
 * written it yet: it is held.
 */
export function decideTake(response: TakeAnswer): TakeDecision {
  if (response.kind === "taken") return { kind: "taken", line: response.line };
  if (response.kind === "unreadable") {
    return {
      kind: "rejects",
      message: `cannot take the Caddy lock: ${response.reason}`,
      details: [`${lockPath()} could not be created or read`],
    };
  }
  const holder = readHolder(response.content);
  const isStale = holder === null ? response.stale : response.now - holder.since > STALE_MS;
  if (!isStale) {
    return {
      kind: "rejects",
      message: heldMessage(holder),
      details: [`the lock ${lockPath()} is taken over once older than ${STALE_MIN} minutes`],
    };
  }
  return {
    kind: "stale",
    previous: holder === null ? null : holderLine(holder),
    announcement:
      holder === null
        ? `stale Caddy lock taken over: unidentified holder, more than ${STALE_MIN} minutes old`
        : `stale Caddy lock taken over: held by ${holder.who} since ${utcTime(holder.since)}, more than ${STALE_MIN} minutes ago`,
  };
}

export type Release = { kind: "released" } | { kind: "warning"; message: string; details: string[] };

function holderIn(output: string): Holder | null {
  const lines = output.split("\n").map((line) => line.trim());
  const end = lines.lastIndexOf(MARKERS.end);
  return end <= 1 ? null : readHolder(lines.slice(1, end).join("\n").trim());
}

/**
 * What the VM says about a hand back. A lock already absent is handed back; a
 * lock held by somebody else is left alone, and says so: it was taken over
 * during the action.
 */
export function readRelease(line: string, execution: Execution): Release {
  const first = execution.code === 0 ? execution.output.split("\n")[0]?.trim() : undefined;
  if (first === MARKERS.release || first === MARKERS.absent) return { kind: "released" };
  if (first === MARKERS.other) {
    const other = holderIn(execution.output);
    return {
      kind: "warning",
      message: "the Caddy lock was taken over during this step, and left to its new holder",
      details: [other === null ? "held now by an unidentified holder" : `held now by ${other.who} since ${utcTime(other.since)}`],
    };
  }
  return {
    kind: "warning",
    message: `the Caddy lock may still be held: ${execution.code === 0 ? "unexpected answer" : failureReason(execution)}`,
    details: [
      `it is taken over once older than ${STALE_MIN} minutes, or by hand on the server:`,
      `sudo rm -rf ${lockPath()}   (only if its ${HOLDER_NAME} reads: ${line})`,
    ],
  };
}

export type Ownership = { kind: "owned" } | { kind: "rejects"; message: string; details: string[] };

/** Is the passed-on ownership real? Only the exact holder attests to it. */
export function readOwnership(line: string, execution: Execution): Ownership {
  const first = execution.code === 0 ? execution.output.split("\n")[0]?.trim() : undefined;
  if (first === MARKERS.owned) return { kind: "owned" };
  const message = `${HELD_VARIABLE} says the caller holds the Caddy lock, and the server does not confirm it`;
  if (first === MARKERS.other) {
    return { kind: "rejects", message, details: [`expected ${line}`, heldMessage(holderIn(execution.output))] };
  }
  if (first === MARKERS.absent) {
    return { kind: "rejects", message, details: [`expected ${line}`, "the lock is not held at all"] };
  }
  return {
    kind: "rejects",
    message,
    details: [`expected ${line}`, `the server's answer is unreadable: ${execution.code === 0 ? "unexpected answer" : failureReason(execution)}`],
  };
}

// --- chains ------------------------------------------------------------------

/** Runs a command on the VM: ssh for real, `sh -c` in the tests. */
export type Remote = (command: string) => Promise<Execution>;

export type Acquisition =
  | { kind: "taken"; line: string; announcements: string[] }
  | { kind: "rejects"; message: string; details: string[] };

/**
 * Takes the lock, taking over a stale lock at most once. The takeover that
 * still finds the lock held refuses, even if it looks stale again: two
 * candidates do not fight over it in a loop.
 *
 * `root` and the remote script exist only for the tests.
 */
export async function takeLock(
  who: Who,
  pid: number,
  remote: Remote,
  root = RUN_DIR,
  command: (script: string) => string = lockCommand,
): Promise<Acquisition> {
  const first = decideTake(readTakeAnswer(await remote(command(takeScript(who, pid, root))), { who, pid }));
  if (first.kind !== "stale") return first.kind === "taken" ? { ...first, announcements: [] } : first;

  const second = decideTake(
    readTakeAnswer(await remote(command(takeoverScript(who, pid, first.previous, root))), { who, pid }),
  );
  if (second.kind === "taken") return { kind: "taken", line: second.line, announcements: [first.announcement] };
  if (second.kind === "rejects") return second;
  return {
    kind: "rejects",
    message: "the stale Caddy lock could not be taken over; try again in a moment",
    details: [`${lockPath()} changed while it was being taken over`],
  };
}

export async function releaseLock(
  line: string,
  remote: Remote,
  root = RUN_DIR,
  command: (script: string) => string = lockCommand,
): Promise<Release> {
  return readRelease(line, await remote(command(releaseScript(line, root))));
}

export async function checkOwnership(
  line: string,
  remote: Remote,
  root = RUN_DIR,
  command: (script: string) => string = lockCommand,
): Promise<Ownership> {
  const holder = readHolder(line);
  if (holder === null || !isWho(holder.who)) {
    return {
      kind: "rejects",
      message: `${HELD_VARIABLE} is not a workstation lock holder line: ${line.slice(0, 60)}`,
      details: [`expected <${HOLDERS.join("|")}> <pid> <milliseconds>`],
    };
  }
  return readOwnership(line, await remote(command(checkScript(line, root))));
}
