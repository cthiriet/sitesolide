/**
 * The contract of the Activity page: one audit for the whole machine, read
 * from the audits every component already keeps for itself.
 *
 * Each component records what it did in its own table, in the shape they all
 * share (an ISO date, an actor, a dotted action, a target, a detail in JSON
 * that never carries a secret), and exposes it read-only through the road the
 * dashboard already takes to reach it. This contract adds no table and no
 * road: the dashboard reads those audits, puts each row in the same shape
 * with the name of the component that wrote it, and merges them newest first.
 *
 *   GET /api/audit                                     behind the session, no unlock
 *     ?source=<name>        repeated or comma separated, every source when absent
 *     &actor=<text>         part of the actor, any case
 *     &action=<prefix>      `portal.` or `deploy.success`
 *     &target=<slug|host>   a site's rows, its hosts included
 *     &from=<ISO>&to=<ISO>  from inclusive, to exclusive
 *     &limit=<n>            100 by default, 500 at most
 *     &cursor=<opaque>      the `cursor` of the previous answer, same filters
 *   -> AuditResponse
 *
 * Shapes and constants only, like the other protocol files: the page imports
 * nothing from here but types.
 */

/**
 * Who recorded the row, named after the component that keeps the table:
 *
 * - `dashboard`: the control API's tokens and deployments, in dashboard.db;
 * - `portal`: sign-ins, sign-outs and sharing changes, in the portal's database;
 * - `egress`: refusals, connector uses and connector changes, in the proxy's;
 * - `backups`: the scheduled runs and the restores, in backup.db;
 * - `steward`: the secrets' operations and the portal doors, in its journal.
 */
export const AUDIT_SOURCES = ["dashboard", "portal", "egress", "backups", "steward"] as const;

export type AuditSource = (typeof AUDIT_SOURCES)[number];

/** One row, whichever component wrote it. */
export type AuditRow = {
  /** `<source>:<the row's id in that source>`, unique across the answer. */
  id: string;
  source: AuditSource;
  /** ISO 8601, UTC. */
  at: string;
  /** An email, `owner` (the dashboard password's holder), `token:<id>`, `guest:<id>`, `anonymous` or `system`. */
  actor: string;
  /** Dotted: `portal.signin`, `deploy.success`, `secrets.set`. */
  action: string;
  /** A slug, a host or a connector's name, as the component recorded it. */
  target: string | null;
  /** The site the target names, when the snapshot knows it: the slug itself, or the site serving a host. */
  site: string | null;
  /** What happened, bounded in size and depth. Never a secret value: each component guarantees it, and tests it. */
  detail: Record<string, unknown> | null;
};

/**
 * `ok`: read. `unavailable`: no answer, a refusal, or an answer that does not
 * read. `not-installed`: the component is not on this server.
 * `outdated`: it answers, but predates the route the dashboard reads.
 */
export type SourceState = "ok" | "unavailable" | "not-installed" | "outdated";

export type SourceStatus = {
  name: AuditSource;
  state: SourceState;
  /** What happened and what to do, for anything but `ok`. */
  message: string | null;
  /**
   * Set when the route this dashboard reads only exposes the component's
   * latest entries, and this answer reached the end of them: older ones stay
   * on the server, unread here.
   */
  window: number | null;
};

export type AuditResponse = {
  /** Newest first. */
  rows: AuditRow[];
  /** One per source read for this answer; a source read to its end on an earlier page is not read again. */
  sources: SourceStatus[];
  /** The next, older page, with the same filters; null once every source is read to its end. */
  cursor: string | null;
  /** The rows read from the components to build this page, matching the filters or not. */
  scanned: number;
};

/** A page, unless asked otherwise. */
export const DEFAULT_LIMIT = 100;

/** The total row cap of one answer. */
export const MAX_LIMIT = 500;
