/**
 * The log of the steward's operations, one JSON line per operation.
 *
 * Pure: encodes, re-reads, truncates. Appending to the file belongs to
 * system.ts.
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
];

/**
 * Who a line written before the journal named its actor speaks for: the
 * dashboard's password, the only way the steward could be asked anything then.
 */
export const EARLIER_ACTOR = "owner";

/**
 * An actor as the steward writes one: `owner`, `anonymous` for a sign-in that
 * names nobody it could verify, or an email it verified. Nothing else enters
 * the journal in that place.
 */
const ACTOR = /^(owner|anonymous|[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+)$/;
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

/** The most `GET /log` hands over at once when asked for a page: half the file at its fullest. */
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
