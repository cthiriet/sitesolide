/**
 * The proxy's audit: what it refused, which credentials were used, and what
 * changed in the connectors and their grants. One table, `audit`, in the shape
 * every component shares, so that a later Activity view reads them all alike.
 *
 * **Counted, not logged one request at a time.** A project calling a
 * connector in a loop, or a library retrying a refused host every second,
 * would otherwise write a row per request, and the table would say nothing a
 * person could read. Refusals and uses are counted in memory per project and
 * destination, then written once a minute, one row per pair with its count
 * and its first and last time. Refusals are also capped per minute: beyond
 * MAX_DENIED_KEYS distinct pairs, the rest folds into a single row that says
 * how many were dropped.
 *
 * **Never a secret.** A row carries a host, a project, a connector's name and
 * address, never a header value; the connectors' values are not even passed
 * to this module.
 *
 * `connector.update` and `connector.grant` are recorded when the proxy sees the
 * files change, against what it saw last, kept in the `seen` table: the
 * steward writes them and the proxy owns this database, and comparing states
 * also catches a change made by hand on the machine.
 */
import type { Database } from "bun:sqlite";
import type { ConnectorsFile, GrantsFile } from "../../bin/cli/connectors";

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS audit_at ON audit (at)",
  // The last state of the connectors and grants the proxy recorded, without
  // the values: what the next change is compared to.
  "CREATE TABLE IF NOT EXISTS seen (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
];

export type AuditRow = {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
};

/** Distinct refused pairs written per flush; the rest fold into one row. */
export const MAX_DENIED_KEYS = 50;

/** How long rows are kept. */
export const RETENTION_DAYS = 90;

/** The actor of what the proxy observed itself: refusals and uses. */
export const SYSTEM_ACTOR = "system";

type Counter = { count: number; first: string; last: string };
type Denied = Counter & { target: string | null; destination: string | null; reason: string; account: string | null };
type Used = Counter & { slug: string; connector: string; failures: number; statuses: Record<string, number> };

type SeenConnector = { baseUrl: string; header: string; updatedAt: string; secretUpdatedAt: string };
type SeenGrant = { slug: string; connector: string };

export type Audit = {
  /** A refusal: `target` the project, null when the caller is not one. */
  denied: (entry: { target: string | null; destination: string | null; reason: string; account?: string | null }) => void;
  /** A connector's use; `status` null when the upstream could not be reached. */
  used: (slug: string, connector: string, status: number | null) => void;
  /** Compares the files to what was last seen, and records the differences. */
  observe: (connectors: ConnectorsFile, grants: GrantsFile) => number;
  /** Writes the counters, one row per pair. Returns the rows written. */
  flush: () => number;
  /** The latest rows, newest first, before `before` when given. */
  recent: (limit: number, before?: number | null) => AuditRow[];
  /** Removes the rows older than the retention. */
  prune: () => number;
};

export function createAudit(db: Database, now: () => Date = () => new Date()): Audit {
  for (const statement of SCHEMA) db.run(statement);

  const insert = db.prepare<undefined, [string, string, string, string | null, string | null]>(
    "INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)",
  );
  const latest = db.prepare<AuditRow, [number]>(
    "SELECT id, at, actor, action, target, detail FROM audit ORDER BY id DESC LIMIT ?",
  );
  const latestBefore = db.prepare<AuditRow, [number, number]>(
    "SELECT id, at, actor, action, target, detail FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?",
  );
  const readSeen = db.prepare<{ value: string }, [string]>("SELECT value FROM seen WHERE key = ?");
  const writeSeen = db.prepare<undefined, [string, string]>(
    "INSERT INTO seen (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );
  const expired = db.prepare<undefined, [string]>("DELETE FROM audit WHERE at < ?");

  let denied = new Map<string, Denied>();
  let used = new Map<string, Used>();

  const stamp = () => now().toISOString();

  function seen<T>(key: string): T | null {
    const row = readSeen.get(key);
    if (row === null) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  return {
    denied({ target, destination, reason, account = null }) {
      const at = stamp();
      const key = JSON.stringify([target, destination, reason, account]);
      const counter = denied.get(key);
      if (counter === undefined) denied.set(key, { target, destination, reason, account, count: 1, first: at, last: at });
      else {
        counter.count++;
        counter.last = at;
      }
    },

    used(slug, connector, status) {
      const at = stamp();
      const key = `${slug}/${connector}`;
      const counter = used.get(key) ?? { slug, connector, count: 0, failures: 0, statuses: {}, first: at, last: at };
      counter.count++;
      counter.last = at;
      const label = status === null ? "unreachable" : `${Math.floor(status / 100)}xx`;
      counter.statuses[label] = (counter.statuses[label] ?? 0) + 1;
      if (status === null || status >= 500) counter.failures++;
      used.set(key, counter);
    },

    observe(connectors, grants) {
      const at = stamp();
      const rows: [string, string, string, string | null, string | null][] = [];

      const before = seen<Record<string, SeenConnector>>("connectors");
      const after: Record<string, SeenConnector> = {};
      for (const [name, record] of Object.entries(connectors.connectors)) {
        after[name] = { baseUrl: record.baseUrl, header: record.header, updatedAt: record.updatedAt, secretUpdatedAt: record.secretUpdatedAt };
        const previous = before?.[name];
        const actor = record.updatedBy;
        if (previous === undefined) {
          rows.push([at, actor, "connector.update", name, JSON.stringify({ change: "created", baseUrl: record.baseUrl, header: record.header })]);
        } else if (
          previous.baseUrl !== record.baseUrl ||
          previous.header !== record.header ||
          previous.updatedAt !== record.updatedAt ||
          previous.secretUpdatedAt !== record.secretUpdatedAt
        ) {
          const changed = (["baseUrl", "header"] as const).filter((field) => previous[field] !== record[field]);
          const detail = {
            change: "updated",
            baseUrl: record.baseUrl,
            header: record.header,
            changed,
            valueReplaced: previous.secretUpdatedAt !== record.secretUpdatedAt,
          };
          rows.push([at, actor, "connector.update", name, JSON.stringify(detail)]);
        }
      }
      for (const name of Object.keys(before ?? {})) {
        if (after[name] !== undefined) continue;
        rows.push([at, connectors.updatedBy ?? SYSTEM_ACTOR, "connector.update", name, JSON.stringify({ change: "removed" })]);
      }

      const grantedBefore = seen<SeenGrant[]>("grants") ?? [];
      const keyOf = (grant: SeenGrant) => `${grant.slug}/${grant.connector}`;
      const beforeKeys = new Set(grantedBefore.map(keyOf));
      const afterKeys = new Set(grants.grants.map(keyOf));
      for (const grant of grants.grants) {
        if (beforeKeys.has(keyOf(grant))) continue;
        rows.push([at, grant.by, "connector.grant", grant.slug, JSON.stringify({ connector: grant.connector, granted: true })]);
      }
      for (const grant of grantedBefore) {
        if (afterKeys.has(keyOf(grant))) continue;
        rows.push([at, grants.updatedBy ?? SYSTEM_ACTOR, "connector.grant", grant.slug, JSON.stringify({ connector: grant.connector, granted: false })]);
      }

      db.transaction(() => {
        for (const row of rows) insert.run(...row);
        writeSeen.run("connectors", JSON.stringify(after));
        writeSeen.run("grants", JSON.stringify(grants.grants.map(({ slug, connector }) => ({ slug, connector }))));
      })();
      return rows.length;
    },

    flush() {
      const deniedNow = [...denied.values()];
      const usedNow = [...used.values()];
      denied = new Map();
      used = new Map();
      if (deniedNow.length === 0 && usedNow.length === 0) return 0;

      // The busiest pairs first, so that the cap keeps what matters.
      deniedNow.sort((a, b) => b.count - a.count);
      const kept = deniedNow.slice(0, MAX_DENIED_KEYS);
      const dropped = deniedNow.slice(MAX_DENIED_KEYS);
      const at = stamp();
      let written = 0;
      db.transaction(() => {
        for (const entry of kept) {
          const detail: Record<string, unknown> = { reason: entry.reason, count: entry.count, first: entry.first, last: entry.last };
          if (entry.destination !== null) detail.destination = entry.destination;
          if (entry.account !== null) detail.account = entry.account;
          insert.run(at, SYSTEM_ACTOR, "egress.denied", entry.target, JSON.stringify(detail));
          written++;
        }
        if (dropped.length > 0) {
          const count = dropped.reduce((sum, entry) => sum + entry.count, 0);
          insert.run(at, SYSTEM_ACTOR, "egress.denied", null, JSON.stringify({ reason: "rate limited", pairs: dropped.length, count }));
          written++;
        }
        for (const entry of usedNow) {
          const detail = {
            connector: entry.connector,
            count: entry.count,
            failures: entry.failures,
            statuses: entry.statuses,
            first: entry.first,
            last: entry.last,
          };
          insert.run(at, SYSTEM_ACTOR, "connector.use", entry.slug, JSON.stringify(detail));
          written++;
        }
      })();
      return written;
    },

    recent(limit, before = null) {
      const bounded = Math.max(1, Math.min(500, Math.floor(limit)));
      return before === null ? latest.all(bounded) : latestBefore.all(before, bounded);
    },

    prune() {
      const cutoff = new Date(now().getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      return expired.run(cutoff).changes;
    },
  };
}
