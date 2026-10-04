/**
 * What the dashboard remembers of the control API, in its own database: the
 * deployments it was asked for, and the audit of who did what.
 *
 * Two new tables in `dashboard.db`, created if missing: an additive migration,
 * which an older dashboard never reads and a newer one finds empty. The token
 * registry is not here, it is the steward's (see protocol.ts for why); this
 * database only says which token asked for which deployment, so that a token
 * reads its own deployments and no one else's.
 *
 * The audit table has the shape every component of the platform shares, so
 * that a later view can put them side by side: an ISO date, an actor
 * (`owner`, `token:<id>`, `system`), a dotted action, a target, and a detail in
 * JSON that never carries a secret.
 *
 * Built around a connection rather than opening one: the tests give it a
 * database in a temporary directory, the server the one in DATA_DIR, opened
 * by `openDatabase` of src/database.ts.
 */
import type { Database } from "bun:sqlite";
import type { AuditEntry, DeploymentState } from "./protocol";

export const CONTROL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS audit (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     target TEXT,
     detail TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS audit_at ON audit (at)`,
  `CREATE TABLE IF NOT EXISTS deployments (
     id TEXT PRIMARY KEY,
     token_id TEXT NOT NULL,
     email TEXT NOT NULL,
     slug TEXT NOT NULL,
     state TEXT NOT NULL,
     creating INTEGER NOT NULL,
     manifest TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     started_at INTEGER,
     finished_at INTEGER,
     message TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS deployments_state ON deployments (state)`,
] as const;

export type { AuditEntry };

export type DeploymentRow = {
  id: string;
  tokenId: string;
  email: string;
  slug: string;
  state: DeploymentState;
  creating: boolean;
  manifest: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  message: string | null;
};

type RawRow = Omit<DeploymentRow, "creating" | "state"> & { creating: number; state: string };

const COLUMNS =
  "id, token_id AS tokenId, email, slug, state, creating, manifest, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt, message";

function row(raw: RawRow | null): DeploymentRow | null {
  if (raw === null) return null;
  return { ...raw, state: raw.state as DeploymentState, creating: raw.creating === 1 };
}

export type ControlStore = ReturnType<typeof createControlStore>;

export function createControlStore(db: Database) {
  for (const statement of CONTROL_SCHEMA) db.run(statement);

  const queries = {
    audit: db.query<undefined, [string, string, string, string | null, string | null]>(
      "INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)",
    ),
    listAudit: db.query<{ id: number; at: string; actor: string; action: string; target: string | null; detail: string | null }, [string, number]>(
      "SELECT id, at, actor, action, target, detail FROM audit WHERE action LIKE ? ORDER BY at DESC, id DESC LIMIT ?",
    ),
    create: db.query<undefined, [string, string, string, string, string, number, string, number]>(
      "INSERT INTO deployments (id, token_id, email, slug, state, creating, manifest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ),
    byId: db.query<RawRow, [string]>(`SELECT ${COLUMNS} FROM deployments WHERE id = ?`),
    inState: db.query<RawRow, [string]>(`SELECT ${COLUMNS} FROM deployments WHERE state = ? ORDER BY created_at`),
    activeForSlug: db.query<RawRow, [string]>(
      `SELECT ${COLUMNS} FROM deployments WHERE slug = ? AND state IN ('awaiting-bundle', 'running') ORDER BY created_at DESC LIMIT 1`,
    ),
    countActive: db.query<{ n: number }, []>("SELECT count(*) AS n FROM deployments WHERE state IN ('awaiting-bundle', 'running')"),
    markRunning: db.query<undefined, [number, string]>(
      "UPDATE deployments SET state = 'running', started_at = ? WHERE id = ? AND state = 'awaiting-bundle'",
    ),
    finish: db.query<undefined, [string, number, string | null, string]>(
      "UPDATE deployments SET state = ?, finished_at = ?, message = ? WHERE id = ? AND state IN ('awaiting-bundle', 'running')",
    ),
    recent: db.query<RawRow, [number]>(`SELECT ${COLUMNS} FROM deployments ORDER BY created_at DESC LIMIT ?`),
  };

  return {
    /** Never throws: an audit that cannot be written must not undo what it records. */
    recordAudit(entry: { at: number; actor: string; action: string; target: string | null; detail: Record<string, unknown> | null }): void {
      try {
        queries.audit.run(
          new Date(entry.at).toISOString(),
          entry.actor,
          entry.action,
          entry.target,
          entry.detail === null ? null : JSON.stringify(entry.detail),
        );
      } catch (error) {
        console.error(`audit: not written (${(error as Error).name})`);
      }
    },

    /** The latest entries, newest first, of the actions starting with `prefix`. */
    listAudit(limit: number, prefix = ""): AuditEntry[] {
      const like = `${prefix.replace(/[%_\\]/g, "")}%`;
      return queries.listAudit.all(like, limit).map((entry) => {
        let detail: Record<string, unknown> | null = null;
        try {
          detail = entry.detail === null ? null : (JSON.parse(entry.detail) as Record<string, unknown>);
        } catch {
          detail = null;
        }
        return { ...entry, detail };
      });
    },

    createDeployment(created: { id: string; tokenId: string; email: string; slug: string; creating: boolean; manifest: string; createdAt: number }): void {
      queries.create.run(created.id, created.tokenId, created.email, created.slug, "awaiting-bundle", created.creating ? 1 : 0, created.manifest, created.createdAt);
    },

    deployment(id: string): DeploymentRow | null {
      return row(queries.byId.get(id));
    },

    inState(state: DeploymentState): DeploymentRow[] {
      return queries.inState.all(state).map((raw) => row(raw)!);
    },

    activeForSlug(slug: string): DeploymentRow | null {
      return row(queries.activeForSlug.get(slug));
    },

    countActive(): number {
      return queries.countActive.get()?.n ?? 0;
    },

    /** True when the deployment was waiting for its archive and now runs. */
    markRunning(id: string, at: number): boolean {
      return queries.markRunning.run(at, id).changes === 1;
    },

    /** True only for the transition itself: a final state is never rewritten, so its audit is recorded once. */
    finish(id: string, state: "succeeded" | "failed" | "expired", at: number, message: string | null): boolean {
      return queries.finish.run(state, at, message, id).changes === 1;
    },

    recent(limit: number): DeploymentRow[] {
      return queries.recent.all(limit).map((raw) => row(raw)!);
    },
  };
}
