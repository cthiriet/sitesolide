/**
 * The contract between the steward, which reads the backups and starts a
 * restore, the dashboard's service, which relays it, and the page, which
 * imports nothing from here but types. Shapes only, no rule: the steward
 * decides what may be restored, and its refusal is shown as it stands.
 *
 * The steward's routes, on its socket:
 *
 *   GET  /backups?slug=<s>        -> BackupsResponse
 *   POST /backups/restore         RestoreRequest -> 202 RestoreResponse
 *   GET  /backups/audit[?slug=<s>] -> BackupAuditResponse, the last 50
 *        [&limit=<n>[&before=<id>]] -> BackupAuditResponse with `paged`, a page of `n` older than `id`
 *
 * The dashboard's, without the token, which it keeps:
 *
 *   GET  /api/backups?slug=<s>
 *   POST /api/backups/restore     { slug, snapshot, confirmation }
 *   GET  /api/backups/audit[?slug=<s>]
 *
 * A steward from before this contract answers 404 `no such route`: the page
 * says the steward needs updating, and nothing else breaks.
 */
import type { SnapshotKind } from "../../borrowed/backups";
import type { AuditEntry } from "./database";
import type { RetentionPolicy } from "./retention";
import type { WithToken } from "../secrets/protocol";

export type { AuditEntry } from "./database";
export type { RetentionPolicy } from "./retention";
export type { SnapshotKind } from "../../borrowed/backups";

export type SnapshotView = {
  /** The file name, and what a restore names. */
  name: string;
  takenAt: number;
  kind: SnapshotKind;
  /** The archive's size on the server, or the encrypted object's when only the bucket has it. */
  bytes: number | null;
  local: boolean;
  offsite: boolean;
};

/** This project's line of the last run, the times in milliseconds. */
export type LastRunView = { startedAt: number; finishedAt: number; ok: boolean; snapshot: string | null; error: string | null };

/**
 * `running`: started, or in progress, `message` says the phase.
 * `ok`, `failure`, `rejects`: over, `message` says how; `failure` says in
 * which state it left the site. `unknown`: a result the steward cannot trust.
 */
export type RestoreState = "running" | "ok" | "failure" | "rejects" | "unknown";

export type RestoreView = {
  state: RestoreState;
  message: string;
  snapshot: string | null;
  /** The snapshot of the data it replaced, which undoes it. */
  preRestore: string | null;
  actor: string | null;
  startedAt: number | null;
  /** When the result was last written. */
  at: number | null;
};

export type BackupsView = {
  slug: string;
  /** The component is on the machine: its restore template and its state folder. */
  installed: boolean;
  /** Why this site has no snapshots on purpose: opted out, no data folder. null otherwise. */
  excluded: string | null;
  lastRun: LastRunView | null;
  /** When the machine's last run finished, whatever this site did in it. */
  machineRunAt: number | null;
  retention: RetentionPolicy | null;
  offsite: { target: string | null; error: string | null };
  /** Newest first. */
  snapshots: SnapshotView[];
  restore: RestoreView | null;
  /** The steward would accept a restore; otherwise `reason` says why not. */
  restorable: boolean;
  reason: string | null;
};

export type BackupsResponse = { backups: BackupsView };

/**
 * `confirmation`: the slug, retyped: a restore replaces the data in service.
 * `actor`: who asks, as the dashboard knows its session; recorded in the
 * component's audit, never trusted for anything else.
 */
export type RestoreRequest = WithToken & { slug: string; snapshot: string; confirmation: string; actor: string };

export type RestoreResponse = { restore: RestoreView };

/** `paged`: the answer to `limit`, which a steward that predates pages ignores, as for its log. */
export type BackupAuditResponse = { entries: AuditEntry[]; paged?: true };
