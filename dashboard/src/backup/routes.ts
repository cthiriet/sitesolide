/**
 * The steward's backup routes: what a site's snapshots are, and the restore
 * the dashboard asks for. Built around their dependencies, like the steward's
 * own routes (src/secrets/steward.ts), which mounts them: the token, the
 * reading of the body and the exclusion lock are the steward's, not copies.
 *
 * The steward does not restore. It checks the request, writes it where the
 * restore one-shot will read it, and starts `sitesolide-restore@<folder>` with
 * `--no-block`: a restore can take longer than any request should stay open,
 * and the page follows it through `GET /backups`, which reads the result file
 * the one-shot rewrites at every phase.
 *
 * In the order of the risk, as for the secrets: the body and the token, the
 * site, the snapshot, the retyped slug, the requester, then the state of the
 * site. Every refusal names what to do; none quotes a value.
 */
import { isBackedUp } from "../../borrowed/manifest";
import { readSnapshotName } from "../../borrowed/backups";
import type { ErrorCode } from "../secrets/protocol";
import { readPageQuery } from "../secrets/log";
import { checkSite, isSiteFolder, type Site } from "../secrets/scope";
import type { BackupReader } from "./reader";
import { recoveryPlan } from "./recovery";
import { DASHBOARD_REFUSAL, PORTAL_REFUSAL, excludedFromRestore, isActor, judgeResult, restoreUnit } from "./request";
import type { BackupAuditResponse, BackupsResponse, BackupsView, RestoreResponse, RestoreView, SnapshotView } from "./protocol";

export type Command = { code: number; output: string };
type Body = Record<string, unknown>;

export type BackupRouteDependencies = {
  /** null: a steward built without the component's paths, which says backups are not set up. */
  reader: BackupReader | null;
  sites: () => Promise<Map<string, Site>>;
  bodyWithToken: (req: Request, texts: string[], others?: string[]) => Promise<Body | Response>;
  underLock: (req: Request, body: Body, task: () => Promise<Response>) => Promise<Response>;
  systemctl: (args: string[], timeoutMs: number) => Promise<Command>;
  fail: (code: ErrorCode, message: string) => Response;
  now: () => number;
  /** Root's uid when owners are checked, null on the workstation. */
  uidRoot: number | null;
};

export type BackupRoutes = {
  list: (req: Request) => Promise<Response>;
  restore: (req: Request) => Promise<Response>;
  audit: (req: Request) => Promise<Response>;
  /**
   * The restore itself, under a lock its caller already holds, the body
   * judged and its requester set: a Project admin's, through
   * src/members/actions.ts, with the email the steward verified.
   */
  start: (req: Request, body: Record<string, unknown>) => Promise<Response>;
};

export const NOT_INSTALLED_REASON = "backups are not set up on this server: run sitesolide setup again for this machine, without --minimal";
export const DASHBOARD_REASON = DASHBOARD_REFUSAL;
export const PORTAL_REASON = PORTAL_REFUSAL;
export const RUNNING_REASON = "a restore of this site is in progress";
/** The audit entries a page reads at once. */
export const AUDIT_ENTRIES = 50;
const SHOW_TIMEOUT_MS = 5000;
const START_TIMEOUT_MS = 10_000;

const ACTIVE_STATES = ["active", "activating", "reloading", "deactivating"];

function iso(text: string): number | null {
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

export function createBackupRoutes(dependencies: BackupRouteDependencies): BackupRoutes {
  const { reader, sites, fail, now } = dependencies;

  /** The site's snapshots, on the server and in the bucket, newest first. */
  function snapshotsOf(folder: string): SnapshotView[] {
    if (reader === null) return [];
    const byName = new Map<string, SnapshotView>();
    for (const snapshot of reader.local(folder)) {
      byName.set(snapshot.name, { name: snapshot.name, takenAt: snapshot.takenAt, kind: snapshot.kind, bytes: snapshot.bytes, local: true, offsite: false });
    }
    for (const row of reader.offsite(folder)) {
      const known = byName.get(row.name);
      if (known !== undefined) {
        known.offsite = true;
        continue;
      }
      const snapshot = readSnapshotName(folder, row.name);
      if (snapshot !== null) byName.set(row.name, { name: row.name, takenAt: snapshot.takenAt, kind: snapshot.kind, bytes: row.bytes, local: false, offsite: true });
    }
    return [...byName.values()].sort((a, b) => b.takenAt - a.takenAt || (a.name < b.name ? 1 : -1));
  }

  /**
   * The restore as the machine shows it: a request not consumed yet, a unit
   * still running, or the last result. A result that says `running` while the
   * unit is no longer is a restore that was cut short.
   */
  async function restoreView(folder: string): Promise<RestoreView | null> {
    if (reader === null) return null;
    const pending = reader.pending(folder, now());
    if (pending !== null) {
      return { state: "running", message: "Starting the restore.", snapshot: pending.snapshot, preRestore: null, actor: pending.actor, startedAt: pending.requestedAt, at: pending.requestedAt };
    }
    const unit = restoreUnit(folder);
    let active = false;
    if (unit !== null) {
      try {
        const shown = await dependencies.systemctl(["show", unit, "-p", "ActiveState", "--value"], SHOW_TIMEOUT_MS);
        active = shown.code === 0 && ACTIVE_STATES.includes(shown.output.trim());
      } catch {
        active = false;
      }
    }
    const judged = judgeResult(reader.result(folder), dependencies.uidRoot);
    if (judged === null) {
      return active ? { state: "running", message: "Starting the restore.", snapshot: null, preRestore: null, actor: null, startedAt: null, at: null } : null;
    }
    if ("unreadable" in judged) return { state: "unknown", message: judged.unreadable, snapshot: null, preRestore: null, actor: null, startedAt: null, at: null };
    const view: RestoreView = { state: judged.state, message: judged.message, snapshot: judged.snapshot, preRestore: judged.preRestore, actor: judged.actor, startedAt: judged.startedAt, at: judged.at };
    if (judged.state === "running" && !active) {
      return { ...view, state: "failure", message: `the restore stopped before finishing: check the site, and journalctl -u sitesolide-restore@${folder}` };
    }
    if (active && judged.state !== "running") return { ...view, state: "running", message: "Starting the restore." };
    return view;
  }

  /** Why a restore of this site would be refused now, or null. */
  function refusalReason(site: Site, restore: RestoreView | null, snapshots: SnapshotView[]): string | null {
    if (reader === null || !reader.installed()) return NOT_INSTALLED_REASON;
    const excluded = excludedFromRestore(site.folder);
    if (excluded !== null) return excluded;
    if (restore?.state === "running") return RUNNING_REASON;
    if (!reader.hasData(site.folder) && !reader.present(site.folder).previous) return "no data folder to restore into";
    const plan = recoveryPlan(reader.present(site.folder));
    if (plan.kind === "refuse") return plan.reason;
    if (snapshots.length === 0) return "no snapshot yet";
    return null;
  }

  function exclusion(site: Site): string | null {
    if (site.manifest !== null && !isBackedUp(site.manifest)) return "opted out by its sitesolide.json";
    if (site.isStatic) return "a static site has no data folder";
    if (reader !== null && !reader.hasData(site.folder)) return "no data folder";
    return null;
  }

  async function view(site: Site): Promise<BackupsView> {
    const folder = site.folder;
    const installed = reader !== null && reader.installed();
    const snapshots = snapshotsOf(folder);
    const status = reader?.status() ?? null;
    const mine = status?.projects[folder];
    const settings = reader?.settings() ?? { retention: null, offsite: { target: null, error: null } };
    const restore = await restoreView(folder);
    const reason = refusalReason(site, restore, snapshots);
    return {
      slug: folder,
      installed,
      excluded: exclusion(site),
      lastRun:
        status === null || mine === undefined
          ? null
          : { startedAt: iso(status.startedAt) ?? 0, finishedAt: iso(status.finishedAt) ?? 0, ok: mine.ok, snapshot: mine.snapshot, error: mine.error },
      machineRunAt: status === null ? null : iso(status.finishedAt),
      retention: settings.retention,
      offsite: settings.offsite,
      snapshots,
      restore,
      restorable: reason === null,
      reason,
    };
  }

  return {
    async list(req) {
      const wanted = new URL(req.url).searchParams.getAll("slug");
      if (wanted.length !== 1) return fail("invalid", "name exactly one site");
      const found = checkSite(await sites(), wanted[0]);
      if ("refusal" in found) return fail(found.refusal.error, found.refusal.message);
      const body: BackupsResponse = { backups: await view(found.site) };
      return Response.json(body);
    },

    async audit(req) {
      const params = new URL(req.url).searchParams;
      const wanted = params.getAll("slug");
      if (wanted.length > 1) return fail("invalid", "name one site at most");
      const slug = wanted[0] ?? null;
      if (slug !== null && !isSiteFolder(slug)) return fail("invalid", "not a site name");
      // The Activity page pages through the whole audit; the Backups section
      // asks for no page and reads the latest fifty, as it always did.
      const asked = readPageQuery(params);
      if (asked !== null && "error" in asked) return fail("invalid", asked.error);
      const body: BackupAuditResponse =
        asked === null ? { entries: reader?.audit(slug, AUDIT_ENTRIES) ?? [] } : { entries: reader?.audit(slug, asked.limit, asked.before) ?? [], paged: true };
      return Response.json(body);
    },

    async restore(req) {
      const body = await dependencies.bodyWithToken(req, ["slug", "snapshot", "confirmation", "actor"]);
      if (body instanceof Response) return body;
      return dependencies.underLock(req, body, () => start(req, body));
    },

    start: (req, body) => start(req, body),
  };

  /** The restore asked for, once the lock is held: the order of the risk, as for the secrets. */
  async function start(req: Request, body: Body): Promise<Response> {
    if (reader === null || !reader.installed()) return fail("not-found", NOT_INSTALLED_REASON);
    const found = checkSite(await sites(), body.slug);
    if ("refusal" in found) return fail(found.refusal.error, found.refusal.message);
    const { site } = found;
    const folder = site.folder;
    const excluded = excludedFromRestore(folder);
    if (excluded !== null) return fail("out-of-scope", excluded);

    const name = body.snapshot as string;
    if (readSnapshotName(folder, name) === null) return fail("invalid", `not a snapshot of ${folder}`);
    const snapshots = snapshotsOf(folder);
    if (!snapshots.some((snapshot) => snapshot.name === name)) return fail("not-found", `no such snapshot of ${folder} any more`);
    // A restore replaces the data in service: the slug is retyped.
    if (body.confirmation !== folder) return fail("invalid", `type ${folder} to confirm the restore`);
    if (!isActor(body.actor)) return fail("invalid", "the requester is not one the audit can record");

    const reason = refusalReason(site, await restoreView(folder), snapshots);
    if (reason === RUNNING_REASON) return fail("already-present", reason);
    if (reason !== null) return fail("unmanaged", reason);
    // Checked again just before the start: a restore launched for a
    // requester who has gone would change the site with nobody watching.
    if (req.signal.aborted) return fail("failure", "request abandoned");

    const unit = restoreUnit(folder)!;
    const request = {
      nonce: [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      snapshot: name,
      actor: body.actor as string,
      requestedAt: now(),
    };
    try {
      reader.writeRequest(folder, request);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      console.error(`backups: restore request not written (${typeof code === "string" ? code : "unknown"})`);
      return fail(
        "failure",
        code === "EROFS"
          ? "the steward cannot write restore requests yet: it started before the backup component was installed, run sitesolide upgrade to start it again"
          : "the restore request could not be written, see the steward's journal",
      );
    }
    let started: Command;
    try {
      started = await dependencies.systemctl(["start", "--no-block", unit], START_TIMEOUT_MS);
    } catch {
      started = { code: 1, output: "" };
    }
    if (started.code !== 0) {
      reader.removeRequest(folder);
      return fail("failure", `the restore could not be started: is ${unit.replace(`@${folder}`, "@")} installed?`);
    }
    console.log(`backups: restore of ${folder} started from ${name}`);
    const response: RestoreResponse = {
      restore: { state: "running", message: "Starting the restore.", snapshot: name, preRestore: null, actor: request.actor, startedAt: request.requestedAt, at: request.requestedAt },
    };
    return Response.json(response, { status: 202 });
  }
}
