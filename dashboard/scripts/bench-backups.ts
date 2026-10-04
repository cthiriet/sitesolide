/**
 * The backups as the page bench's fake steward tells them (scripts/page-bench.ts):
 * snapshots every hour for a day and a half, then one a day, an offsite copy,
 * and the troubles the page must know how to say:
 *
 * - `photos` is a static site, `example.com` the landing with no manifest;
 * - `builder`'s last run failed, the disk being too full;
 * - `library` carries the leftovers of an interrupted restore: no restore offered;
 * - a restore of `roster` fails, the service not coming back, and the previous
 *   data is put back; every other restore succeeds, in about nine seconds,
 *   through the phases the real one-shot writes;
 * - `dashboard` is not restored from itself.
 *
 * BENCH_NO_BACKUPS=1: the component is not installed. BENCH_OLD_STEWARD=1: the
 * steward predates the backups, and answers `no such route`.
 *
 * The messages are those of src/backup/, imported, so that the bench says what
 * the machine says.
 */
import { snapshotName } from "../borrowed/backups";
import type { AuditEntry, BackupsView, RestoreView, SnapshotView } from "../src/backup/protocol";
import { INTERRUPTED_REASON } from "../src/backup/recovery";
import { DASHBOARD_REASON, NOT_INSTALLED_REASON, RUNNING_REASON } from "../src/backup/routes";

type Folder = { slug: string; manifest: Record<string, unknown> | null };
type Routes = Record<string, Record<string, (req: Request) => Response | Promise<Response>>>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RETENTION = { hourly: 24, daily: 7, weekly: 4, preRestore: 3 };

const isApp = (folder: Folder) =>
  folder.manifest === null || typeof folder.manifest.start === "string" || typeof folder.manifest.services === "object";

const refusal = (status: number, error: string, message: string) => Response.json({ error, message }, { status });

export function benchBackupRoutes(options: { start: number; folders: Folder[]; isValidToken: (body: Record<string, unknown>) => boolean }): Routes {
  const { start, folders } = options;
  const installed = process.env.BENCH_NO_BACKUPS !== "1";
  const outdated = process.env.BENCH_OLD_STEWARD === "1";
  const lastHour = Math.floor(start / HOUR) * HOUR;

  const snapshots = new Map<string, SnapshotView[]>();
  const restores = new Map<string, RestoreView>();
  const audit: AuditEntry[] = [];
  let id = 0;
  const record = (entry: Omit<AuditEntry, "id">) => audit.unshift({ id: ++id, ...entry });

  for (const folder of folders.filter(isApp)) {
    const list: SnapshotView[] = [];
    const base = 2 * 1024 * 1024 + folder.slug.length * 377_000;
    for (let i = 0; i < 30; i++) {
      const takenAt = lastHour - i * HOUR + 2 * 60_000;
      list.push({ name: snapshotName(folder.slug, takenAt, "scheduled"), takenAt, kind: "scheduled", bytes: base - i * 4096, local: true, offsite: i < 24 });
    }
    for (let d = 2; d < 8; d++) {
      const takenAt = lastHour - d * DAY + 2 * 60_000;
      list.push({ name: snapshotName(folder.slug, takenAt, "scheduled"), takenAt, kind: "scheduled", bytes: base - d * 50_000, local: d < 5, offsite: true });
    }
    snapshots.set(folder.slug, list);
  }
  const cms = snapshots.get("cms");
  if (cms !== undefined) {
    const takenAt = start - 3 * DAY - 4 * HOUR;
    cms.push({ name: snapshotName("cms", takenAt, "pre-restore"), takenAt, kind: "pre-restore", bytes: 2_700_000, local: true, offsite: true });
    cms.sort((a, b) => b.takenAt - a.takenAt);
    restores.set("cms", {
      state: "ok",
      message: "Restored cms from the snapshot of a week ago. cms is running. The data it replaced is saved as a before-restore snapshot.",
      snapshot: cms[cms.length - 1]!.name,
      preRestore: snapshotName("cms", takenAt, "pre-restore"),
      actor: "owner",
      startedAt: takenAt,
      at: takenAt + 9000,
    });
    record({ at: new Date(takenAt + 9000).toISOString(), actor: "owner", action: "backup.restore", target: "cms", detail: { result: "ok", snapshot: cms[cms.length - 1]!.name } });
  }
  for (let i = 5; i >= 0; i--) {
    const failed = i === 0 ? ["builder"] : [];
    record({ at: new Date(lastHour - i * HOUR + 3 * 60_000).toISOString(), actor: "system", action: "backup.run", target: null, detail: { ok: failed.length === 0, snapshots: 9, pruned: 1, failed } });
  }

  function view(folder: Folder): BackupsView {
    const slug = folder.slug;
    const list = snapshots.get(slug) ?? [];
    const restore = restores.get(slug) ?? null;
    const excluded = folder.manifest?.backup === false ? "opted out by its sitesolide.json" : isApp(folder) ? null : "a static site has no data folder";
    const failedRun = slug === "builder";
    let reason: string | null = null;
    if (!installed) reason = NOT_INSTALLED_REASON;
    else if (slug === "dashboard") reason = DASHBOARD_REASON;
    else if (restore?.state === "running") reason = RUNNING_REASON;
    else if (!isApp(folder)) reason = "no data folder to restore into";
    else if (slug === "library") reason = INTERRUPTED_REASON;
    else if (list.length === 0) reason = "no snapshot yet";
    return {
      slug,
      installed,
      excluded,
      lastRun: isApp(folder)
        ? {
            startedAt: lastHour + 2 * 60_000,
            finishedAt: lastHour + 3 * 60_000,
            ok: !failedRun,
            snapshot: failedRun ? null : (list[0]?.name ?? null),
            error: failedRun ? "not enough disk space: 812 MB free, 1460 MB needed" : null,
          }
        : null,
      machineRunAt: lastHour + 3 * 60_000,
      retention: installed ? RETENTION : null,
      offsite: { target: "sitesolide-backups at fsn1.your-objectstorage.com", error: null },
      snapshots: installed ? list : [],
      restore,
      restorable: reason === null,
      reason,
    };
  }

  /** The one-shot's phases, rewritten as the real one rewrites its result file. */
  async function simulate(slug: string, snapshot: SnapshotView, actor: string) {
    const startedAt = Date.now();
    const phases = ["Extracting the snapshot.", `Stopping ${slug}.`, "Saving the current data first.", "Putting the snapshot in place.", `Starting ${slug}.`];
    const base: RestoreView = { state: "running", message: "Waiting for any backup run to finish.", snapshot: snapshot.name, preRestore: null, actor, startedAt, at: startedAt };
    restores.set(slug, base);
    for (const message of phases) {
      await Bun.sleep(1800);
      restores.set(slug, { ...base, message, at: Date.now() });
    }
    await Bun.sleep(1500);
    const preTakenAt = startedAt + 4000;
    const preRestore = snapshotName(slug, preTakenAt, "pre-restore");
    const list = snapshots.get(slug) ?? [];
    list.unshift({ name: preRestore, takenAt: preTakenAt, kind: "pre-restore", bytes: list[0]?.bytes ?? 1_000_000, local: true, offsite: false });
    const failed = slug === "roster";
    const when = new Date(snapshot.takenAt).toISOString().slice(0, 16).replace("T", " ");
    const done: RestoreView = failed
      ? { ...base, state: "failure", preRestore, at: Date.now(), message: `${slug} did not start on the restored data (${slug} looping, activating/auto-restart). The previous data is back and ${slug} is running again.` }
      : { ...base, state: "ok", preRestore, at: Date.now(), message: `Restored ${slug} from the snapshot of ${when} UTC. ${slug} is running. The data it replaced is saved as a before-restore snapshot.` };
    restores.set(slug, done);
    record({ at: new Date().toISOString(), actor, action: "backup.restore", target: slug, detail: { result: done.state, snapshot: snapshot.name, preRestore } });
  }

  const unknownRoute = () => refusal(404, "not-found", "no such route");

  return {
    "/backups": {
      GET: (req) => {
        if (outdated) return unknownRoute();
        const folder = folders.find((candidate) => candidate.slug === new URL(req.url).searchParams.get("slug"));
        if (folder === undefined) return refusal(403, "out-of-scope", "not a site deployed under /srv/sites");
        return Response.json({ backups: view(folder) });
      },
    },
    "/backups/audit": {
      GET: (req) => {
        if (outdated) return unknownRoute();
        const slug = new URL(req.url).searchParams.get("slug");
        return Response.json({ entries: audit.filter((entry) => slug === null || entry.target === slug || entry.target === null).slice(0, 50) });
      },
    },
    "/backups/restore": {
      POST: async (req) => {
        if (outdated) return unknownRoute();
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        if (!options.isValidToken(body)) return refusal(401, "locked", "locked, unlock again");
        const folder = folders.find((candidate) => candidate.slug === body.slug);
        if (folder === undefined) return refusal(403, "out-of-scope", "not a site deployed under /srv/sites");
        const current = view(folder);
        if (!current.installed) return refusal(404, "not-found", NOT_INSTALLED_REASON);
        if (folder.slug === "dashboard") return refusal(403, "out-of-scope", DASHBOARD_REASON);
        const snapshot = current.snapshots.find((candidate) => candidate.name === body.snapshot);
        if (snapshot === undefined) return refusal(404, "not-found", `no such snapshot of ${folder.slug} any more`);
        if (body.confirmation !== folder.slug) return refusal(400, "invalid", `type ${folder.slug} to confirm the restore`);
        if (current.reason === RUNNING_REASON) return refusal(409, "already-present", RUNNING_REASON);
        if (current.reason !== null) return refusal(409, "unmanaged", current.reason);
        void simulate(folder.slug, snapshot, typeof body.actor === "string" ? body.actor : "owner");
        return Response.json({ restore: restores.get(folder.slug) }, { status: 202 });
      },
    },
  };
}
