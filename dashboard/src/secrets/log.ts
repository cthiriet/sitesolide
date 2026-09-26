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
];
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
  if (keys !== "a,detail,file,operation,result,slug,variable") return false;
  return (
    typeof e.a === "number" &&
    Number.isFinite(e.a) &&
    OPERATIONS.includes(e.operation as Operation) &&
    RESULTS.includes(e.result as OperationResult) &&
    field(e.slug) &&
    field(e.file) &&
    field(e.variable) &&
    field(e.detail)
  );
}

/** The line to append, newline included. Throws on a malformed entry. */
export function encodeEntry(entry: LogEntry): string {
  const clean: LogEntry = {
    a: entry.a,
    operation: entry.operation,
    result: entry.result,
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
      const entry = underCurrentNames(JSON.parse(line));
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

/** The text to rewrite if the log has grown too much, null otherwise. */
export function truncate(text: string, max: number = MAX_LINES, kept: number = KEPT_LINES): string | null {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= max) return null;
  return `${lines.slice(-kept).join("\n")}\n`;
}
