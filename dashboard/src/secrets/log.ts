/**
 * The log of the steward's operations, one JSON line per operation, in two
 * files: the journal, `journal.jsonl`, and the access log, `access-log.jsonl`,
 * which keeps the accepted changes of access apart (see "The access log"
 * below).
 *
 * Pure: encodes, re-reads, truncates, prunes, merges. Appending to the files
 * belongs to system.ts.
 *
 * No entry carries a value, nor the hash of a value: the hash of a short value
 * is found again by raw force. The shape of `LogEntry` already forbids
 * it, and `isValidEntry` bounds each field on top of that, so that a value
 * passed by mistake in the place of a name does not slip in whole.
 */
import type { LogEntry, Operation, OperationResult, VerdictKind } from "./protocol";

export const OPERATIONS: Operation[] = [
  "unlock",
  "lock",
  "read",
  "set",
  "remove",
  "create",
  "restore",
  "replace",
  "password",
  "portal",
  "restart",
  "access.add",
  "access.change",
  "access.remove",
  "access.migrate",
  "people.create",
  "dashboard.signin",
  "dashboard.signin_failed",
  "dashboard.signout",
  "member.invite",
  "member.role",
  "member.remove",
  "member.signin",
  "member.signin_failed",
  "member.signout",
  "sharing",
  "guest.create",
  "guest.revoke",
  "backup.restore",
  "token.create",
  "token.revoke",
  "project.create",
  "project.remove",
];

/**
 * Who a line written before the journal named its actor speaks for: the
 * dashboard's password, the only way the steward could be asked anything then.
 */
export const EARLIER_ACTOR = "owner";

/**
 * An actor as the steward writes one: `owner`, `anonymous` for a sign-in that
 * names nobody it could verify, `system` for what it did on its own, a token
 * it judged, or an email it verified. Nothing else enters the journal in that
 * place.
 */
const ACTOR = /^(owner|anonymous|system|token:[A-Za-z0-9_-]{1,64}|[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+)$/;
export const RESULTS: OperationResult[] = ["ok", "rejects", "failure"];

/** A slug, a file name, a variable name, a short reason: nothing longer. */
export const MAX_FIELD = 160;

/** Beyond `MAX_LINES`, the file is rewritten with its last `KEPT_LINES` lines. */
export const MAX_LINES = 1000;
export const KEPT_LINES = 500;

/** What `GET /log` returns. */
export const RETURNED_ENTRIES = 50;

/**
 * The names the journal carried before they were translated, and the ones they
 * are read as now.
 *
 * journal.jsonl on the VM is the only thing in the secrets section that
 * remembers anything from one deployment to the next: every line written before
 * the rename still spells its operation in French. Without this table,
 * `isValidEntry` would judge those lines malformed, `reread` would drop them one
 * by one, and the Activity section would come back empty the day the rename is
 * deployed.
 *
 * It is applied when re-reading, never when writing: `encodeEntry` only accepts
 * the current names, so the file stops growing older entries the moment the new
 * steward starts. The table is what carries the past, not a second spelling
 * still in use.
 */
export const EARLIER_OPERATIONS: Readonly<Record<string, Operation>> = {
  deverrouillage: "unlock",
  verrouillage: "lock",
  lecture: "read",
  pose: "set",
  retrait: "remove",
  creation: "create",
  restauration: "restore",
  remplacement: "replace",
  motdepasse: "password",
  redemarrage: "restart",
  // Renamed by an earlier pass than the others, and missed by it: the journal
  // on the machine still carries it.
  portail: "portal",
};

/**
 * The field names a line carried before the rename. Without them the key
 * check of `isValidEntry` refused every earlier line before any value was
 * looked at, and the table above translated nothing: the 37 lines of the only
 * journal in service came back as an empty Activity section.
 */
export const EARLIER_FIELDS: Readonly<Record<string, string>> = {
  fichier: "file",
  resultat: "result",
};

/** The same, for how an operation turned out. */
export const EARLIER_RESULTS: Readonly<Record<string, OperationResult>> = {
  refus: "rejects",
  echec: "failure",
};

/**
 * The same, for a restart's verdict. It is not a field of its own: the steward
 * writes it as the first word of `detail`, before the systemd state, so only
 * that word is translated and the rest of the line is left as it was written.
 */
export const EARLIER_VERDICTS: Readonly<Record<string, VerdictKind>> = {
  actif: "active",
  boucle: "looping",
  programme: "scheduled",
  echec: "failure",
};

/**
 * The current name of a value the journal may carry under an earlier one, or
 * null. Through `Object.hasOwn`: a line whose operation reads "constructor"
 * must not find the prototype's.
 */
function renamed<T extends string>(table: Readonly<Record<string, T>>, value: unknown): T | null {
  if (typeof value !== "string" || !Object.hasOwn(table, value)) return null;
  return table[value] ?? null;
}

/** A `detail` whose first word is a verdict written before the rename, brought to the current name. */
function currentDetail(operation: unknown, detail: unknown): unknown {
  if (operation !== "restart" || typeof detail !== "string") return detail;
  const comma = detail.indexOf(",");
  const head = comma === -1 ? detail : detail.slice(0, comma);
  const verdict = renamed(EARLIER_VERDICTS, head);
  return verdict === null ? detail : verdict + detail.slice(head.length);
}

/**
 * A line as it was written, read under the current names. Anything already
 * current, and anything that is not an entry at all, comes back untouched:
 * `isValidEntry` stays the only judge of what is kept.
 */
export function underCurrentNames(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
  const e: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    // An earlier name only stands in for a current one that is absent: a line
    // carrying both is malformed, and stays so for isValidEntry to refuse.
    const current = Object.hasOwn(EARLIER_FIELDS, key) ? EARLIER_FIELDS[key]! : key;
    e[Object.hasOwn(entry, current) && current !== key ? key : current] = value;
  }
  const operation = renamed(EARLIER_OPERATIONS, e.operation) ?? e.operation;
  const result = renamed(EARLIER_RESULTS, e.result) ?? e.result;
  const detail = currentDetail(operation, e.detail);
  return { ...e, operation, result, detail };
}

const field = (value: unknown): boolean =>
  value === null || (typeof value === "string" && value.length <= MAX_FIELD && !/[\n\r\0]/.test(value));

export function isValidEntry(entry: unknown): entry is LogEntry {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  const keys = Object.keys(e).sort().join(",");
  if (keys !== "a,actor,detail,file,member,operation,result,slug,variable") return false;
  return (
    typeof e.a === "number" &&
    Number.isFinite(e.a) &&
    OPERATIONS.includes(e.operation as Operation) &&
    RESULTS.includes(e.result as OperationResult) &&
    typeof e.actor === "string" &&
    e.actor.length <= MAX_FIELD &&
    ACTOR.test(e.actor) &&
    field(e.member) &&
    (e.member === null || ACTOR.test(e.member as string)) &&
    field(e.slug) &&
    field(e.file) &&
    field(e.variable) &&
    field(e.detail)
  );
}

/**
 * A line from before the journal named its actor and its member: the seven
 * fields it carried then, read as the owner's, about no member. Anything else
 * comes back untouched, for `isValidEntry` to judge.
 */
export function withActor(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
  const e = entry as Record<string, unknown>;
  if (Object.keys(e).sort().join(",") !== "a,detail,file,operation,result,slug,variable") return entry;
  return { ...e, actor: EARLIER_ACTOR, member: null };
}

/** The line to append, newline included. Throws on a malformed entry. */
export function encodeEntry(entry: LogEntry): string {
  const clean: LogEntry = {
    a: entry.a,
    operation: entry.operation,
    result: entry.result,
    actor: entry.actor,
    member: entry.member,
    slug: entry.slug,
    file: entry.file,
    variable: entry.variable,
    detail: entry.detail,
  };
  if (!isValidEntry(clean)) throw new Error("malformed journal entry");
  return `${JSON.stringify(clean)}\n`;
}

/**
 * Tolerant re-reading: a line truncated by an abrupt stop, or written by an
 * earlier version, is ignored rather than making the whole log unreadable. A
 * line written before the operations were translated is not ignored: it goes
 * through `underCurrentNames` first and is returned under its new name, so that
 * the history displays the same as what follows it.
 */
export function reread(text: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = withActor(underCurrentNames(JSON.parse(line)));
      if (isValidEntry(entry)) entries.push(entry);
    } catch {
      // corrupted line, ignored
    }
  }
  return entries;
}

/**
 * The last `n`, the most recent first: that is the order in which they are
 * read. `slug`: those of that site alone, its own last `n`, and not those of it
 * among everybody's last `n`.
 */
export function latest(entries: LogEntry[], n: number = RETURNED_ENTRIES, slug: string | null = null): LogEntry[] {
  if (n <= 0) return [];
  const kept = slug === null ? entries : entries.filter((entry) => entry.slug === slug);
  return kept.slice(-n).reverse();
}

/** The most `GET /log` hands over at once when asked for a page: half the journal at its fullest. */
export const MAX_PAGE_ENTRIES = 500;

export type PageQuery = { limit: number; before: number | null };

/**
 * `?limit=<n>[&before=<n>]`, which the dashboard's Activity page sends to
 * read a whole history rather than its latest fifty. Null when the request
 * names neither: the route then answers as it always did, so a dashboard that
 * predates pages reads what it read before. The backups' audit route takes
 * the same two, `before` an id there rather than a date.
 */
export function readPageQuery(params: URLSearchParams, max: number = MAX_PAGE_ENTRIES): PageQuery | null | { error: string } {
  const limits = params.getAll("limit");
  const befores = params.getAll("before");
  if (limits.length === 0 && befores.length === 0) return null;
  if (limits.length !== 1 || befores.length > 1) return { error: "give limit once, and before once at most" };
  const limit = Number(limits[0]);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) return { error: `limit: a whole number from 1 to ${max}` };
  const before = befores.length === 0 ? null : Number(befores[0]);
  if (before !== null && (!Number.isSafeInteger(before) || before < 0)) return { error: "before: a whole number" };
  return { limit, before };
}

/**
 * A page of the journal: the entries dated before `before`, in milliseconds,
 * newest first, the last appended first within one same millisecond, `limit`
 * at most; those of one site when it is named. By date and not by place in
 * the file: a clock set back between two lines would otherwise have two pages
 * overlap, or leave a line between them.
 */
export function page(entries: LogEntry[], query: PageQuery, slug: string | null = null): LogEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => (slug === null || entry.slug === slug) && (query.before === null || entry.a < query.before))
    .sort((x, y) => y.entry.a - x.entry.a || y.index - x.index)
    .slice(0, query.limit)
    .map(({ entry }) => entry);
}

/** The text to rewrite if the log has grown too much, null otherwise. */
export function truncate(text: string, max: number = MAX_LINES, kept: number = KEPT_LINES): string | null {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= max) return null;
  return `${lines.slice(-kept).join("\n")}\n`;
}

// --- The access log ------------------------------------------------------------------

/**
 * The access log: every accepted change of access, kept 180 days, in a file
 * of its own beside the journal, in the journal's very format.
 *
 * **Why a file of its own.** The journal rotates by line count, past 1,000
 * lines down to its last 500, and every unlock, read and sign-in writes to
 * it: on a busy week a change of access made a month ago is pushed out, and
 * who let whom in is the question an audit is read for. Rows marked to be
 * kept inside the journal would not do either: once the protected rows alone
 * passed its cap, every append would rewrite a file that only grows. A
 * separate file has its own bound and its own rule, by age, and since its
 * lines are the journal's (`LogEntry`, `encodeEntry`, `reread`), nothing
 * that reads lines changes. The portal kept sharing and guest changes 180
 * days before the steward took them over: the same, here.
 *
 * **What goes there**: a line whose operation is a change of access and
 * whose result is `ok` (`isAccessChange`): people with access, the create
 * right, general access (`portal`), a project created or removed. A refusal
 * is not a change: it stays in the journal, bounded per minute, rotated with
 * the rest.
 *
 * **Never pushed out young.** A row younger than the retention is kept,
 * whatever the count: the steward refuses a change of access once the log
 * holds `ACCESS_MAX_LINES` of them (`isAccessLogFull`), and counts each
 * actor's changes per hour, so that no flood takes away who let whom in.
 */
export const ACCESS_LOG_NAME = "access-log.jsonl";

/**
 * The operations of a change of access: the registry's, and the names a
 * journal written before it carries, so that the rows of an earlier steward
 * are recognized when the access log is seeded and when the journal is
 * filtered.
 */
export const ACCESS_OPERATIONS: ReadonlySet<Operation> = new Set<Operation>([
  "access.add",
  "access.change",
  "access.remove",
  "access.migrate",
  "people.create",
  "portal",
  "project.create",
  "project.remove",
  "member.invite",
  "member.role",
  "member.remove",
  "sharing",
  "guest.create",
  "guest.revoke",
]);

/** How long a change of access is kept: the portal's audit kept them as long. */
export const ACCESS_RETENTION_MS = 180 * 24 * 3600 * 1000;

/**
 * The rows younger than the retention the access log holds at most: past
 * it, a change of access is refused rather than an older row pushed out.
 * Some 5 MB at the length of a usual line.
 */
export const ACCESS_MAX_LINES = 20_000;

/** The access log is pruned at most this often, on the append that follows, and at startup. */
export const ACCESS_PRUNE_INTERVAL_MS = 3600 * 1000;

/**
 * Past this size it is pruned on the next append whatever the hour, and
 * counted full: rows of the longest kind would otherwise take the file past
 * what it is read with before its count of lines is reached.
 */
export const ACCESS_PRUNE_BYTES = 12 * 1024 * 1024;

/**
 * What the access log is read with: a third above the size that has it
 * counted full, so that it always reads whole. Its cap fills some 5 MB.
 */
export const ACCESS_READ_BYTES = 16 * 1024 * 1024;

/** Does this line belong in the access log rather than the journal: an accepted change of access. */
export function isAccessChange(entry: LogEntry): boolean {
  return ACCESS_OPERATIONS.has(entry.operation) && entry.result === "ok";
}

/** The date of a line as it was written, null for one that does not parse or carries none. */
function lineDate(line: string): number | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const a = (parsed as Record<string, unknown>).a;
    return typeof a === "number" && Number.isFinite(a) ? a : null;
  } catch {
    return null;
  }
}

/**
 * The access log pruned: the lines older than the retention dropped, and
 * those alone, however many younger ones there are. A line that carries no
 * date is dropped too: no reader could read it either. Null when nothing is
 * dropped, so that the file is rewritten only when it changes.
 */
export function pruneAccessLog(text: string, now: number, retentionMs: number = ACCESS_RETENTION_MS): string | null {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const cutoff = now - retentionMs;
  const recent = lines.filter((line) => {
    const a = lineDate(line);
    return a !== null && a >= cutoff;
  });
  if (recent.length === lines.length) return null;
  return recent.length === 0 ? "" : `${recent.join("\n")}\n`;
}

/** The lines and bytes of an access log already pruned: is there room for one more change? */
export function isAccessLogFull(count: { lines: number; bytes: number }, max: number = ACCESS_MAX_LINES, maxBytes: number = ACCESS_PRUNE_BYTES): boolean {
  return count.lines >= max || count.bytes >= maxBytes;
}

/** What tells two lines apart: every field, in the order `encodeEntry` writes them. */
export function entryKey(entry: LogEntry): string {
  return JSON.stringify([entry.a, entry.operation, entry.result, entry.actor, entry.member, entry.slug, entry.file, entry.variable, entry.detail]);
}

/**
 * The journal's accepted changes of access the access log does not hold yet,
 * younger than the retention, encoded: what an access log seeded by an
 * earlier steward, whose changes of access were fewer, is topped up with,
 * once, when this steward starts. Empty when there is nothing to add.
 */
export function accessLogTopUp(journalText: string, accessText: string, now: number, retentionMs: number = ACCESS_RETENTION_MS): string {
  const changes = reread(journalText).filter((entry) => isAccessChange(entry) && entry.a >= now - retentionMs);
  if (changes.length === 0) return "";
  const since = Math.min(...changes.map((entry) => entry.a));
  const held = new Set(reread(accessText).filter((entry) => entry.a >= since).map(entryKey));
  return changes.filter((entry) => !held.has(entryKey(entry))).map(encodeEntry).join("");
}

/**
 * The access log's first content, made from the journal when the file does
 * not exist yet: the accepted changes of access an earlier steward wrote
 * there, which the journal's rotation would otherwise take away. Encoded
 * again, so that a line from before the actor was named reads the same in
 * either file.
 */
export function accessLogSeed(journalText: string): string {
  return reread(journalText).filter(isAccessChange).map(encodeEntry).join("");
}

/**
 * What `GET /log` reads: the journal and the access log as one history, by
 * date, oldest first, as `latest` and `page` expect. Within one millisecond
 * the order is the files' own, the journal's lines before the access log's,
 * so that a page asked again lists them in the same order.
 *
 * A change of access the journal holds and the access log holds too is shown
 * once, from the access log; one the access log does not hold, written there
 * before its operation counted as one, stays. Null, no access log yet, and
 * the journal is read whole, as before it.
 */
export function mergeLogs(journal: LogEntry[], accessLog: LogEntry[] | null): LogEntry[] {
  if (accessLog === null) return [...journal].sort((x, y) => x.a - y.a);
  const changes = journal.filter(isAccessChange);
  let kept = journal;
  if (changes.length > 0) {
    const since = Math.min(...changes.map((entry) => entry.a));
    const held = new Set(accessLog.filter((entry) => entry.a >= since).map(entryKey));
    kept = journal.filter((entry) => !isAccessChange(entry) || !held.has(entryKey(entry)));
  }
  // A stable sort: equal dates keep the order of the concatenation.
  return [...kept, ...accessLog].sort((x, y) => x.a - y.a);
}

/** Where `GET /log` reads its two files from, and their identities as they lie (src/secrets/system.ts). */
export type HistorySource = {
  stamps: () => { journal: string | null; access: string | null };
  readJournal: () => Promise<string>;
  readAccessLog: () => Promise<string | null>;
};

/**
 * The journal and the access log as one history, parsed once per change of
 * either file and kept, then read one request at a time: a burst of `GET
 * /log`, a compromised dashboard's included, never holds more than one parsed
 * copy of a full access log, and a page asked again costs a `stat` and a
 * slice. `use` runs on the history in turn and must not keep it.
 */
export function createHistory(source: HistorySource): { read: <T>(use: (entries: LogEntry[]) => T) => Promise<T> } {
  let kept: { key: string; entries: LogEntry[] } | null = null;
  let turn: Promise<unknown> = Promise.resolve();

  async function entries(): Promise<LogEntry[]> {
    const stamps = source.stamps();
    const key = `${stamps.journal ?? "-"}|${stamps.access ?? "-"}`;
    if (kept !== null && kept.key === key) return kept.entries;
    // The old copy let go before the new one is read: never two at once.
    kept = null;
    const accessLog = await source.readAccessLog();
    const merged = mergeLogs(reread(await source.readJournal()), accessLog === null ? null : reread(accessLog));
    kept = { key, entries: merged };
    return merged;
  }

  return {
    read<T>(use: (entries: LogEntry[]) => T): Promise<T> {
      const next = turn.then(async () => use(await entries()));
      turn = next.catch(() => undefined);
      return next;
    },
  };
}
