/**
 * Every source's rows brought to the one shape of protocol.ts, and bounded.
 *
 * Pure: takes what a component answered, returns rows or nothing. A row that
 * does not read is left out rather than guessed at, and a value too long, too
 * deep or of a kind JSON does not carry is cut here: the page receives at
 * most what it can show, whatever a component sends.
 *
 * Bounding is not the guarantee that no secret enters a row. That guarantee
 * belongs to each component, which never writes one into its audit, and is
 * tested where each one writes. This module only makes sure that a component
 * gone wrong cannot make the answer, or the page, grow without limit.
 */
import type { AuditRow, AuditSource } from "./protocol";

/**
 * A row's place in its source's own order, newest first: the larger `[0]`
 * first, then, for an equal `[0]`, the smaller `[1]`. An id-ordered table has
 * `[id, 0]`; the steward's journal, which has no ids, `[ms, rank among the
 * entries of that same millisecond]`.
 */
export type Position = readonly [number, number];

/** A row as a source hands it over: in the shared shape, without its site, and where it stands in that source. */
export type SourceRow = { position: Position; row: Omit<AuditRow, "site"> };

/** An actor, an action, a target: longer is no name. */
export const MAX_TEXT = 256;
/** A string inside a detail. */
export const MAX_DETAIL_STRING = 1000;
/** Keys of one object, items of one array, inside a detail. */
export const MAX_DETAIL_KEYS = 50;
export const MAX_DETAIL_ITEMS = 50;
/**
 * The level at which an object or an array becomes a mark: the detail is
 * level 0, `detail.statuses` level 1, and an object four levels down reads
 * as `…`. No component nests that deep today.
 */
export const MAX_DETAIL_DEPTH = 4;

const CUT = "…";

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}${CUT}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON value within the bounds, or undefined when it has no place in a detail. */
function bound(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return cut(value, MAX_DETAIL_STRING);
  if (depth >= MAX_DETAIL_DEPTH) return Array.isArray(value) || isObject(value) ? CUT : undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_DETAIL_ITEMS)
      .map((item) => bound(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (isObject(value)) {
    // Object.fromEntries defines own properties: a key "__proto__" stays a key
    // and never becomes the prototype of what the page reads.
    const entries: [string, unknown][] = [];
    for (const key of Object.keys(value).slice(0, MAX_DETAIL_KEYS)) {
      const kept = bound(value[key], depth + 1);
      if (kept !== undefined) entries.push([cut(key, MAX_TEXT), kept]);
    }
    return Object.fromEntries(entries);
  }
  return undefined;
}

/**
 * A detail within the bounds: an object, or null. A component that stores it
 * as text (the egress proxy) hands it over still encoded; text that is not a
 * JSON object reads as no detail.
 */
export function boundDetail(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (!isObject(value)) return null;
  return bound(value, 0) as Record<string, unknown>;
}

/** A name that has to be there: a string, not empty, cut to MAX_TEXT. */
function name(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? cut(value, MAX_TEXT) : null;
}

/** A date the browser and the merge both read, in its canonical form. */
function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * A row of a table in the shared shape, from the dashboard, the portal, the
 * egress proxy or the backups. Null when it does not read: an id that is not
 * a positive whole number, a missing actor or action, a date that does not
 * parse.
 */
export function fromTableRow(source: AuditSource, raw: unknown): SourceRow | null {
  if (!isObject(raw)) return null;
  const id = raw.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return null;
  const at = isoDate(raw.at);
  const actor = name(raw.actor);
  const action = name(raw.action);
  if (at === null || actor === null || action === null) return null;
  const target = raw.target === null || raw.target === undefined ? null : name(raw.target);
  return {
    position: [id, 0],
    row: { id: `${source}:${id}`, source, at, actor, action, target, detail: boundDetail(raw.detail) },
  };
}

/**
 * The steward's operations, and the action each one is listed under. The
 * secrets' own keep their name under `secrets.`; the two that are not about a
 * secret say what they change: a site's general access, a service's restart.
 */
export const STEWARD_ACTIONS: Readonly<Record<string, string>> = {
  unlock: "secrets.unlock",
  lock: "secrets.lock",
  read: "secrets.read",
  set: "secrets.set",
  remove: "secrets.remove",
  create: "secrets.create",
  restore: "secrets.restore",
  replace: "secrets.replace",
  password: "secrets.password",
  portal: "access.general",
  restart: "service.restart",
  "access.add": "access.add",
  "access.change": "access.change",
  "access.remove": "access.remove",
  "access.migrate": "access.migrate",
  "people.create": "people.create",
  "dashboard.signin": "dashboard.signin",
  "dashboard.signin_failed": "dashboard.signin_failed",
  "dashboard.signout": "dashboard.signout",
  // Rows written before the access registry, read under the names they carry.
  "member.invite": "member.invite",
  "member.role": "member.role",
  "member.remove": "member.remove",
  "member.signin": "member.signin",
  "member.signin_failed": "member.signin_failed",
  "member.signout": "member.signout",
  sharing: "sharing.update",
  "guest.create": "guest.create",
  "guest.revoke": "guest.revoke",
  "backup.restore": "backup.restore",
  "token.create": "token.create",
  "token.revoke": "token.revoke",
  "project.create": "project.create",
  "project.remove": "project.remove",
};

/**
 * Who a journal line from before the steward named its actor speaks for:
 * whoever held the dashboard's password, the only one the steward acted for
 * then. A line written since names its actor itself, as the steward verified
 * it: `owner`, or a member's email.
 */
export const STEWARD_ACTOR = "owner";

function optional(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? cut(value, MAX_DETAIL_STRING) : null;
}

/**
 * The steward's journal, newest first as `GET /log` answers it, in the shared
 * shape. The journal has no ids: a line's place is its millisecond and its
 * rank among the lines of that same millisecond, counted from the newest,
 * which a line appended later never changes.
 *
 * The journal's own fields go into the detail: `result`, `file`, `variable`,
 * and its `detail`, a refusal's code or a restart's verdict, as `note`. A
 * variable is a name: the journal never holds a value, see src/secrets/log.ts.
 */
export function fromJournal(entries: readonly unknown[]): SourceRow[] {
  const ranks = new Map<number, number>();
  const rows: SourceRow[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const ms = entry.a;
    const operation = entry.operation;
    if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms < 0 || typeof operation !== "string") continue;
    // Through Object.hasOwn: an operation spelled "constructor" finds nothing.
    if (!Object.hasOwn(STEWARD_ACTIONS, operation)) continue;
    const rank = ranks.get(ms) ?? 0;
    ranks.set(ms, rank + 1);
    const detail: Record<string, unknown> = {};
    const result = optional(entry.result);
    const file = optional(entry.file);
    const variable = optional(entry.variable);
    const note = optional(entry.detail);
    if (result !== null) detail.result = result;
    if (file !== null) detail.file = file;
    if (variable !== null) detail.variable = variable;
    if (note !== null) detail.note = note;
    const actor = name(entry.actor) ?? STEWARD_ACTOR;
    const member = name(entry.member);
    const slug = name(entry.slug);
    // A member's own events are about them: the email they concern is the
    // target, as a site's slug is for an operation on that site.
    if (member !== null && member !== actor) detail.member = member;
    rows.push({
      position: [ms, rank],
      row: {
        id: `steward:${ms}.${rank}`,
        source: "steward",
        at: new Date(ms).toISOString(),
        actor,
        action: STEWARD_ACTIONS[operation]!,
        target: slug ?? member,
        detail,
      },
    });
  }
  return rows;
}

/** True when `position` comes after `reference` in its source's order, that is, older. */
export function isAfter(position: Position, reference: Position): boolean {
  return position[0] < reference[0] || (position[0] === reference[0] && position[1] > reference[1]);
}
