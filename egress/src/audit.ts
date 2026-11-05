/**
 * The proxy's audit: what it refused. One table, `audit`, in the shape every
 * component shares, so that the Activity view reads them all alike.
 *
 * **Counted, not logged one request at a time.** A library retrying a refused
 * host every second would otherwise write a row per request, and the table
 * would say nothing a person could read. Refusals are counted in memory per
 * project and destination, then written once a minute, one row per pair with
 * its count and its first and last time. They are also capped per minute:
 * beyond MAX_DENIED_KEYS distinct pairs, the rest folds into a single row that
 * says how many were dropped.
 *
 * **Never a secret.** A row carries a host, a project and a reason, never a
 * header value.
 */
import type { Database } from "bun:sqlite";

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

/**
 * Distinct refused pairs held in memory between two flushes. A project asking
 * for a new host on every connection must not grow the proxy's memory without
 * bound: beyond this, refusals are only counted.
 */
export const MAX_TRACKED_KEYS = 10_000;

/** How long rows are kept. */
export const RETENTION_DAYS = 90;

/** The actor of what the proxy observed itself: its refusals. */
export const SYSTEM_ACTOR = "system";

type Denied = { count: number; first: string; last: string; target: string | null; destination: string | null; reason: string; account: string | null };

export type Audit = {
  /** A refusal: `target` the project, null when the caller is not one. */
  denied: (entry: { target: string | null; destination: string | null; reason: string; account?: string | null }) => void;
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
  const expired = db.prepare<undefined, [string]>("DELETE FROM audit WHERE at < ?");

  let denied = new Map<string, Denied>();
  /** Refusals beyond MAX_TRACKED_KEYS, counted without their pair. */
  let untracked = 0;

  const stamp = () => now().toISOString();

  return {
    denied({ target, destination, reason, account = null }) {
      const at = stamp();
      const key = JSON.stringify([target, destination, reason, account]);
      const counter = denied.get(key);
      if (counter === undefined && denied.size >= MAX_TRACKED_KEYS) {
        untracked++;
        return;
      }
      if (counter === undefined) denied.set(key, { target, destination, reason, account, count: 1, first: at, last: at });
      else {
        counter.count++;
        counter.last = at;
      }
    },

    flush() {
      const deniedNow = [...denied.values()];
      const uncounted = untracked;
      denied = new Map();
      untracked = 0;
      if (deniedNow.length === 0 && uncounted === 0) return 0;

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
        if (dropped.length > 0 || uncounted > 0) {
          const count = dropped.reduce((sum, entry) => sum + entry.count, 0) + uncounted;
          const detail: Record<string, unknown> = { reason: "rate limited", pairs: dropped.length, count };
          if (uncounted > 0) detail.untracked = uncounted;
          insert.run(at, SYSTEM_ACTOR, "egress.denied", null, JSON.stringify(detail));
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
