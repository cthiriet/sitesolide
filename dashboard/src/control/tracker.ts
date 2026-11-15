/**
 * Follows the deployments the dashboard started, to their end, whether or not
 * anybody is still asking.
 *
 * A client that uploads and walks away must still leave an audit entry saying
 * how its deployment ended, and its archive must not stay in the spool. Every
 * few seconds, the tracker reads the installer's result of each running
 * deployment through the steward, records the final state once, and empties
 * the spool of what is finished, expired or unknown. A restart of the dashboard
 * resumes where it was: the running deployments are in its database.
 *
 * `settle` is the single place a final state is recorded: the API calls it
 * too, when a client reading its deployment sees the end before the tracker.
 * The store's transition only happens once, and so does the audit entry.
 */
import { reach, type ControlSteward } from "./client";
import { UPLOAD_WINDOW_MS, type InstallerResult } from "./protocol";
import type { Spool } from "./spool";
import type { ControlStore, DeploymentRow } from "./store";

export type Tracker = {
  tick: () => Promise<void>;
  settle: (row: DeploymentRow, result: InstallerResult) => void;
  /** Records a deployment that ended without the installer, a refusal at its start. */
  fail: (row: DeploymentRow, message: string, code: string) => void;
};

/** How long a started installer may stay silent before it is taken for one that never ran. */
export const START_GRACE_MS = 90_000;

export function createTracker(dependencies: { store: ControlStore; steward: ControlSteward; spool: Spool; clock?: () => number }): Tracker {
  const { store, steward, spool } = dependencies;
  const clock = dependencies.clock ?? Date.now;

  function audit(row: DeploymentRow, action: string, detail: Record<string, unknown>): void {
    store.recordAudit({
      at: clock(),
      actor: `token:${row.tokenId}`,
      action,
      target: row.slug,
      detail: { email: row.email, deployment: row.id, ...detail },
    });
  }

  function settle(row: DeploymentRow, result: InstallerResult): void {
    if (result.state === "running") return;
    const message = result.error === null ? null : `${result.error.code}: ${result.error.message}`;
    if (!store.finish(row.id, result.state, result.finishedAt ?? clock(), message)) return;
    if (result.state === "succeeded") audit(row, "deploy.success", { creating: row.creating, url: result.url });
    else audit(row, "deploy.failure", { creating: row.creating, error: result.error?.code ?? "unknown" });
    spool.remove(row.id);
  }

  function fail(row: DeploymentRow, message: string, code: string): void {
    if (!store.finish(row.id, "failed", clock(), `${code}: ${message}`)) return;
    audit(row, "deploy.failure", { creating: row.creating, error: code });
    spool.remove(row.id);
  }

  let busy = false;

  async function tick(): Promise<void> {
    // A tick that outlasts the interval is not doubled by the next one.
    if (busy) return;
    busy = true;
    try {
      const now = clock();
      for (const row of store.inState("awaiting-bundle")) {
        if (now - row.createdAt <= UPLOAD_WINDOW_MS) continue;
        if (store.finish(row.id, "expired", now, "the archive never arrived")) spool.remove(row.id);
      }

      for (const row of store.inState("running")) {
        const reached = await reach(() => steward.deployment(row.id));
        if (reached.kind !== "received") continue;
        if (reached.status === 404) {
          if (now - (row.startedAt ?? row.createdAt) > START_GRACE_MS) {
            fail(row, "the installer left no result: the owner must read journalctl -u sitesolide-installer@" + row.slug, "no-result");
          }
          continue;
        }
        const result = reached.body.result as InstallerResult | undefined;
        if (reached.status === 200 && result !== undefined) settle(row, result);
      }

      // The spool holds only what is waiting or running: anything else is a
      // leftover of a crash, and an archive nobody will install.
      const active = new Set([...store.inState("awaiting-bundle"), ...store.inState("running")].map((row) => row.id));
      for (const id of spool.list()) if (!active.has(id)) spool.remove(id);
    } catch (error) {
      console.error(`control: tracker failed (${(error as Error).name})`);
    } finally {
      busy = false;
    }
  }

  return { tick, settle, fail };
}
