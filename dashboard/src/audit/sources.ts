/**
 * The five sources of the machine's audit, each read the way the dashboard
 * already reaches it, and no other:
 *
 * | Source      | Road                                         | Route                  |
 * |-------------|----------------------------------------------|------------------------|
 * | `dashboard` | its own database, dashboard.db               | none, a query          |
 * | `portal`    | the loopback, the one port the rule opens it | GET /admin/audit       |
 * | `egress`    | the loopback, 127.0.0.1:3129, outside the rule's range, answered to site-dashboard alone | GET /audit |
 * | `backups`   | the steward's socket                         | GET /backups/audit     |
 * | `steward`   | the steward's socket                         | GET /log               |
 *
 * No new privilege and no new path: these are the routes the Sharing,
 * Connectors, Backups and Secrets pages already read, with the clients they
 * already use. What is new is only that they are read together.
 *
 * Each reader turns what it gets into one of four states. An answer that does
 * not come, a refusal, or a body that does not read: `unavailable`. A route
 * the component does not know: `outdated`, with what to run. A component the
 * server does not have: `not-installed`, decided from what the dashboard can
 * already see, never guessed from a silence alone.
 */
import type { SharingPortal } from "../sharing";
import type { Steward } from "../secrets/client";
import { RETURNED_ENTRIES } from "../secrets/log";
import type { BackupSteward } from "../backup/client";
import type { ConnectorsSteward, EgressReader } from "../connectors/client";
import type { ControlStore } from "../control/store";
import type { AuditReader, Readers, ReaderResult } from "./aggregate";
import { fromJournal, fromTableRow, isAfter, type Position, type SourceRow } from "./normalize";
import type { AuditSource } from "./protocol";

/** The most the portal and the egress proxy hand over at once; they bound a larger ask to it without a word. */
export const PAGE_MAX = 500;

/**
 * What the steward's two routes hand over when asked for no page, which is all
 * a steward that predates pages ever answers: the latest fifty.
 * RETURNED_ENTRIES in src/secrets/log.ts, AUDIT_ENTRIES in
 * src/backup/routes.ts; tests/audit-sources.test.ts checks they still agree.
 */
export const STEWARD_WINDOW = RETURNED_ENTRIES;

/** A whole page of five hundred rows, with room to spare; anything larger is not an audit page. */
export const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

/** The site every steward knows, since it is the one asking: see `backupsNotInstalled`. */
const DASHBOARD_SLUG = "dashboard";

type Answer =
  | { kind: "unreachable" }
  | { kind: "answered"; status: number; body: Record<string, unknown> | null };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A call and its JSON body, read piece by piece up to MAX_ANSWER_BYTES. A
 * rejection, a timeout or a body cut short: unreachable. A body that is too
 * big or not a JSON object: answered, with no body.
 */
async function receive(call: () => Promise<Response>): Promise<Answer> {
  let response: Response;
  try {
    response = await call();
  } catch {
    return { kind: "unreachable" };
  }
  const status = response.status;
  if (response.body === null) return { kind: "answered", status, body: null };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      bytes += part.value.byteLength;
      if (bytes > MAX_ANSWER_BYTES) {
        await reader.cancel();
        return { kind: "answered", status, body: null };
      }
      chunks.push(part.value);
    }
  } catch {
    return { kind: "unreachable" };
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(Bun.concatArrayBuffers(chunks)));
    return { kind: "answered", status, body: isObject(parsed) ? parsed : null };
  } catch {
    return { kind: "answered", status, body: null };
  }
}

const failed = (state: "unavailable" | "not-installed" | "outdated", message: string): ReaderResult => ({ kind: "failed", state, message });

/** A component's own words for a refusal, when it gave some. */
function said(body: Record<string, unknown> | null): string | null {
  const message = body?.message;
  return typeof message === "string" && message !== "" ? message : null;
}

/**
 * The rows of a page in the shared shape. Rows that do not read are left
 * out; a page where none reads is garbage, not an empty page, and says so.
 */
function readRows(source: AuditSource, list: unknown, where: string): SourceRow[] | ReaderResult {
  if (!Array.isArray(list)) return failed("unavailable", `${where} sent an unreadable answer.`);
  const rows = (source === "steward" ? fromJournal(list) : list.map((raw) => fromTableRow(source, raw))).filter(
    (row): row is SourceRow => row !== null,
  );
  if (list.length > 0 && rows.length === 0) return failed("unavailable", `${where} sent an unreadable answer.`);
  return rows;
}

/**
 * A route that only hands over its latest entries: what comes after `after`
 * among them. Read to their end, the source is too; `window` says the end is
 * the route's and not the component's, when it handed over a full window.
 *
 * Put in order first. The journal is listed in the order its lines were
 * appended, and a clock set back between two lines lists a newer one after
 * an older: the merge, which takes each source as a stream in its own order,
 * would otherwise take the older one for a row already read and drop it.
 */
function windowed(rows: SourceRow[], listed: number, after: Position | null, size: number): ReaderResult {
  const ordered = [...rows].sort((a, b) => (isAfter(a.position, b.position) ? 1 : isAfter(b.position, a.position) ? -1 : 0));
  const left = after === null ? ordered : ordered.filter((row) => isAfter(row.position, after));
  return {
    kind: "rows",
    rows: left.slice(0, size),
    end: left.length <= size,
    window: listed >= STEWARD_WINDOW ? STEWARD_WINDOW : null,
  };
}

export type AuditDependencies = {
  store: Pick<ControlStore, "readAudit">;
  portal: Pick<SharingPortal, "audit">;
  egress: Pick<EgressReader, "audit">;
  steward: Pick<Steward, "readLog">;
  backups: Pick<BackupSteward, "readBackupAudit" | "readBackups">;
  connectors: Pick<ConnectorsSteward, "read">;
  /**
   * Whether the snapshot lists the portal among the deployed sites, null
   * without a snapshot: the one way to tell a portal that is down from a
   * portal that was never deployed.
   */
  portalDeployed: () => Promise<boolean | null>;
};

export function createReaders(dependencies: AuditDependencies): Readers {
  const { store, portal, egress, steward, backups, connectors } = dependencies;

  const dashboard: AuditReader = {
    async read(after, size) {
      try {
        const listed = store.readAudit(after?.[0] ?? null, size);
        const rows = readRows("dashboard", listed, "The dashboard's database");
        if (!Array.isArray(rows)) return rows;
        return { kind: "rows", rows, end: listed.length < size, window: null };
      } catch {
        return failed("unavailable", "The dashboard's database could not be read.");
      }
    },
  };

  const portalReader: AuditReader = {
    async read(after, size) {
      const asked = Math.min(size, PAGE_MAX);
      const answer = await receive(() => portal.audit(asked, after?.[0] ?? null));
      if (answer.kind === "unreachable") {
        const deployed = await dependencies.portalDeployed().catch(() => null);
        if (deployed === false) return failed("not-installed", "The portal isn't deployed on this server.");
        return failed("unavailable", "Can't reach the portal.");
      }
      // An older portal answers its plain 404 to a route it does not have.
      if (answer.status === 404) return failed("outdated", "The portal on this server predates its audit. Deploy portal/ again.");
      if (answer.status !== 200) return failed("unavailable", `The portal refused the dashboard (status ${answer.status}).`);
      const rows = readRows("portal", answer.body?.events, "The portal");
      if (!Array.isArray(rows)) return rows;
      return { kind: "rows", rows, end: (answer.body!.events as unknown[]).length < asked, window: null };
    },
  };

  /** The steward knows whether the egress proxy's folder exists: down is not the same as never installed. */
  async function egressNotInstalled(): Promise<boolean> {
    const answer = await receive(() => connectors.read());
    return answer.kind === "answered" && answer.status === 200 && answer.body?.installed === false;
  }

  const egressReader: AuditReader = {
    async read(after, size) {
      const asked = Math.min(size, PAGE_MAX);
      const answer = await receive(() => egress.audit(asked, after?.[0] ?? null));
      if (answer.kind === "unreachable") {
        if (await egressNotInstalled()) return failed("not-installed", "The egress proxy isn't installed on this server.");
        return failed("unavailable", "Can't reach the egress proxy.");
      }
      if (answer.status === 404) return failed("outdated", "The egress proxy on this server predates its audit. Run bin/deploy-egress.sh.");
      if (answer.status !== 200) {
        const why = said(answer.body);
        return failed("unavailable", why === null ? `The egress proxy refused the dashboard (status ${answer.status}).` : `The egress proxy refused the dashboard: ${why}.`);
      }
      const rows = readRows("egress", answer.body?.rows, "The egress proxy");
      if (!Array.isArray(rows)) return rows;
      return { kind: "rows", rows, end: (answer.body!.rows as unknown[]).length < asked, window: null };
    },
  };

  /** A steward too old for a route answers `no such route`, which is not a refusal. */
  function stewardRefusal(answer: Extract<Answer, { kind: "answered" }>, outdated: string): ReaderResult {
    const why = said(answer.body);
    if (answer.status === 404 && why === "no such route") return failed("outdated", outdated);
    return failed("unavailable", why === null ? `The steward refused the dashboard (status ${answer.status}).` : `The steward refused the dashboard: ${why}.`);
  }

  /**
   * No entry at all may mean no run yet, or no backups on this server. The
   * view of one site says which, and the dashboard's own is one every steward
   * with the backup routes knows.
   */
  async function backupsNotInstalled(): Promise<boolean> {
    const answer = await receive(() => backups.readBackups(DASHBOARD_SLUG));
    if (answer.kind !== "answered" || answer.status !== 200) return false;
    const view = answer.body?.backups;
    return isObject(view) && view.installed === false;
  }

  /**
   * A steward updated since the Activity page pages through the whole audit,
   * `paged` in its answer; an older one ignores the page asked for and hands
   * over its latest fifty, which are read as a window.
   */
  const backupsReader: AuditReader = {
    async read(after, size) {
      const asked = Math.min(size, PAGE_MAX);
      const answer = await receive(() => backups.readBackupAudit(null, { limit: asked, before: after?.[0] ?? null }));
      if (answer.kind === "unreachable") return failed("unavailable", "Can't reach the steward.");
      if (answer.status !== 200) return stewardRefusal(answer, "The steward on this server predates backups. Run bin/deploy-steward.sh.");
      const entries = answer.body?.entries;
      const rows = readRows("backups", entries, "The steward");
      if (!Array.isArray(rows)) return rows;
      if (after === null && rows.length === 0 && (await backupsNotInstalled())) {
        return failed("not-installed", "Backups aren't set up on this server. Run bin/deploy-backup.sh install, then enable.");
      }
      const listed = (entries as unknown[]).length;
      if (answer.body?.paged === true) return { kind: "rows", rows, end: listed < asked, window: null };
      return windowed(rows, listed, after, size);
    },
  };

  /**
   * The journal pages by date, and a millisecond can hold several lines: the
   * page is asked from the millisecond of the last line read, that one
   * included, and what was already read in it is set aside by its rank.
   */
  const stewardReader: AuditReader = {
    async read(after, size) {
      const asked = Math.min(size, PAGE_MAX);
      const answer = await receive(() => steward.readLog(null, { limit: asked, before: after === null ? null : after[0] + 1 }));
      if (answer.kind === "unreachable") return failed("unavailable", "Can't reach the steward.");
      if (answer.status !== 200) return stewardRefusal(answer, "The steward on this server predates its log. Run bin/deploy-steward.sh.");
      const entries = answer.body?.entries;
      const rows = readRows("steward", entries, "The steward");
      if (!Array.isArray(rows)) return rows;
      const listed = (entries as unknown[]).length;
      if (answer.body?.paged === true) {
        const ordered = windowed(rows, 0, after, asked);
        return ordered.kind === "rows" ? { ...ordered, end: listed < asked, window: null } : ordered;
      }
      return windowed(rows, listed, after, size);
    },
  };

  return { dashboard, portal: portalReader, egress: egressReader, backups: backupsReader, steward: stewardReader };
}
