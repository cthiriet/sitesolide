/**
 * `sitesolide refresh`: a deployed project's systemd units generated again,
 * from the manifest the machine already carries, without sending any code.
 *
 * The protections live in each project's generated unit, the port rules and
 * the system-call filter among them (see renderUnit in unit.ts), and a unit
 * is only rewritten by `deploy`, which also sends the folder's code: an app
 * whose code on the workstation is not the one in production keeps the units
 * of the release that last deployed it. `upgrade` never touches a project's
 * units. This command writes them alone, project by project, over the
 * owner's SSH, and needs no project folder.
 *
 * WHAT IT WORKS FROM. The manifest the last deployment left on the machine,
 * `/srv/sites/<slug>/sitesolide.json`, read and validated by the code
 * deploy uses, and the configuration's zone and contact for the
 * placeholders, as deploy replaces them. One that does not read, or that
 * this release refuses, refuses its project, naming why, and nothing is
 * changed for it: deploying the project again writes a current one.
 *
 * WHAT IT CHECKS AND LAYS FIRST, as deploy does, before any unit: a secret
 * file of the old form the project may not read refuses it; then the
 * project's store folders are laid, for a project whose units are current
 * too, so that a `files/` folder deleted by hand comes back (every unit of
 * the project fails to start without it). After a restart, the runtime
 * secrets the store lacks are said, never asked for.
 *
 * WHAT IT WRITES. Each unit is decided by decideUnit exactly as deploy decides
 * it without `--force`: a current unit is left alone; a missing one, or one an
 * earlier release generated, is written; one edited by hand is kept, and
 * said, and never replaced, this command having no `--force`. A main unit
 * edited by hand, in a project of several, keeps all of them: it is what
 * starts the others, and deploy refuses the same case. No unit is ever
 * removed. When one was written, systemd is reloaded and the project's
 * services restarted as deploy restarts them, then checked as deploy checks
 * them: active, still running ten seconds later, and the site over HTTPS.
 *
 * `--all` takes every project of the machine one at a time, in the order of
 * their names, and stops at the first whose restart or check fails: one site
 * down at most, never several. The run ends with what it did to each.
 *
 * The orchestration, reading the machine, the lock shared with the
 * gatekeeper and the restart, lives in bin/sitesolide.ts, beside deploy's own
 * steps it reuses. What decides is here, pure: returns values, touches
 * nothing.
 */
import { isApp, isValidSlug, readManifest, type Manifest } from "./manifest";
import { unitPath } from "./services";
import { decideUnit, type GeneratedUnit, type UnitAction } from "./unit";

// --- the command line ------------------------------------------------------------

export type RefreshTarget = { all: true } | { all: false; slug: string };
export type RefreshOptions = { target: RefreshTarget; dryRun: boolean };
export type Refusal = { message: string; details: string[] };

export const REFRESH_USAGE = "usage: sitesolide refresh <slug> | --all [--dry-run] [--json]";

/** The command line after `refresh`, read; a refusal for anything it does not take. */
export function parseRefreshArguments(arguments_: readonly string[]): RefreshOptions | Refusal {
  const refuse = (...details: string[]): Refusal => ({ message: REFRESH_USAGE, details });
  const slugs: string[] = [];
  for (const argument of arguments_) {
    if (argument === "--all" || argument === "--dry-run" || argument === "--json") continue;
    if (argument === "--force") {
      return refuse(
        "not an option of refresh: --force",
        "refresh never replaces a unit edited by hand: sitesolide deploy --force, in the project's folder, does, on your decision",
      );
    }
    if (argument.startsWith("-")) return refuse(`not an option of refresh: ${argument}`);
    slugs.push(argument);
  }
  const all = arguments_.includes("--all");
  if (all && slugs.length > 0) return refuse("a slug or --all, not both");
  if (slugs.length > 1) return refuse("one project at a time, or --all for every one");
  const dryRun = arguments_.includes("--dry-run");
  if (all) return { target: { all: true }, dryRun };
  const [slug] = slugs;
  if (slug === undefined) return refuse("name a deployed project, or --all for every one: sitesolide status lists them");
  if (!isValidSlug(slug)) return refuse(`${slug} is not a project's slug: lowercase letters, digits and dashes`);
  return { target: { all: false, slug }, dryRun };
}

// --- the manifest on the machine -------------------------------------------------

export type Deposited =
  | { kind: "app"; manifest: Manifest }
  | { kind: "static"; manifest: Manifest }
  | { kind: "refused"; reasons: string[] };

/**
 * The manifest found in `/srv/sites/<folder>`, read as deploy reads one. It
 * must name its own folder: its units are named after its slug, and a
 * manifest copied into another project's folder would write that project's
 * units under another's name.
 */
export function readDeposited(folder: string, raw: string): Deposited {
  const { manifest, errors } = readManifest(raw);
  if (manifest === undefined || errors.length > 0) return { kind: "refused", reasons: errors };
  if (manifest.slug !== folder) return { kind: "refused", reasons: [`/srv/sites/${folder}/sitesolide.json names ${manifest.slug}, not ${folder}`] };
  return { kind: isApp(manifest) ? "app" : "static", manifest };
}

// --- the units --------------------------------------------------------------------

/** One unit: what it is, where it lives, what this release generates, what the machine has ("" for nothing), and the decision. */
export type UnitPlan = { unit: string; path: string; text: string; installed: string; action: UnitAction };

export type ProjectPlan = {
  /** `outdated` when a unit is to be written, `kept` when one edited by hand is all that differs, `current` otherwise. */
  state: "outdated" | "current" | "kept";
  units: UnitPlan[];
  write: UnitPlan[];
  current: UnitPlan[];
  kept: UnitPlan[];
  /** The main unit of a project of several was edited by hand: none of its units is written. */
  mainKept: boolean;
};

/**
 * Each unit decided as deploy decides it without `--force`, `installed`
 * being the machine's text of each, in the order of `units`, "" for a unit
 * that is not there.
 */
export function planUnits(units: readonly GeneratedUnit[], installed: readonly string[]): ProjectPlan {
  const plans = units.map(({ unit, text }, i): UnitPlan => {
    const onMachine = installed[i] ?? "";
    return { unit, path: unitPath(unit), text, installed: onMachine, action: decideUnit({ installed: onMachine, generated: text, replace: false }) };
  });
  const mainKept = plans.length > 1 && plans[0]!.action === "diverged";
  const write = mainKept ? [] : plans.filter((plan) => plan.action === "install");
  const kept = plans.filter((plan) => plan.action === "diverged");
  const current = plans.filter((plan) => plan.action === "present");
  const state = write.length > 0 ? "outdated" : kept.length > 0 ? "kept" : "current";
  return { state, units: plans, write, current, kept, mainKept };
}

// --- what it says -------------------------------------------------------------------

/**
 * What happened to a project: `refreshed`, its units written and its services
 * restarted and checked; `outdated`, what a dry run says of a project it would
 * refresh; `current`; `kept`, a unit edited by hand all that differs;
 * `refused`, its manifest on the machine, or a unit name, in the way; `static`,
 * no unit to refresh.
 */
export type ProjectState = "refreshed" | "outdated" | "current" | "kept" | "refused" | "static";

export type ProjectReport = {
  slug: string;
  state: ProjectState;
  /** The units written, or that a dry run would write. */
  write: string[];
  current: string[];
  kept: string[];
  /** Why a refused project was refused. */
  reasons: string[];
  /** The site's address and what it answered, once checked; null otherwise. */
  url: string | null;
  status: number | null;
};

export function emptyReport(slug: string, state: ProjectState): ProjectReport {
  return { slug, state, write: [], current: [], kept: [], reasons: [], url: null, status: null };
}

export type Summary = Record<"refreshed" | "outdated" | "current" | "kept" | "refused" | "static", string[]>;

/** The projects by what happened to them, each list in the order they were taken. */
export function summaryFields(reports: readonly ProjectReport[]): Summary {
  const of = (state: ProjectState): string[] => reports.filter((report) => report.state === state).map((report) => report.slug);
  return { refreshed: of("refreshed"), outdated: of("outdated"), current: of("current"), kept: of("kept"), refused: of("refused"), static: of("static") };
}

/** The lines after the first one, which says what was done: the projects left as they are, and why. */
function leftLines(summary: Summary): string[] {
  return [
    ...(summary.current.length > 0 ? [`already current: ${summary.current.join(", ")}`] : []),
    ...(summary.kept.length > 0 ? [`kept, edited by hand: ${summary.kept.join(", ")}`] : []),
    ...(summary.refused.length > 0 ? [`refused, nothing changed: ${summary.refused.join(", ")}`] : []),
    ...(summary.static.length > 0 ? [`static, no unit to refresh: ${summary.static.join(", ")}`] : []),
  ];
}

/** How a run ends: what it wrote, or would write in a dry run, then what it left. */
export function summaryLines(reports: readonly ProjectReport[], dryRun: boolean): string[] {
  const summary = summaryFields(reports);
  const first = dryRun
    ? summary.outdated.length === 0
      ? "nothing would be written"
      : `would be refreshed: ${summary.outdated.join(", ")}`
    : summary.refreshed.length === 0
      ? "nothing was written"
      : `refreshed: ${summary.refreshed.join(", ")}`;
  return [first, ...leftLines(summary)];
}

/**
 * The details of a run stopped at a project: what was written for it, and
 * whether its services run under it now, what came before it, and the
 * projects it never reached, left as they were. A run of one project, with
 * nothing before it nor after, has only the first.
 */
export function stoppedDetails(
  stopped: { slug: string; written: readonly string[]; restarted: boolean },
  reports: readonly ProjectReport[],
  notReached: readonly string[],
): string[] {
  const { slug, written, restarted } = stopped;
  const own =
    written.length === 0
      ? [`nothing was written for ${slug}`]
      : [
          `written for ${slug}: ${written.join(", ")}`,
          restarted
            ? "its services were restarted under them: if they held under the earlier units, the port rules or the system-call filter may refuse something they do; sitesolide logs, in its folder, says what"
            : "its services were not restarted: their next restart applies them",
        ];
  if (reports.length === 0 && notReached.length === 0) return own;
  const summary = summaryFields(reports);
  return [
    ...own,
    `refreshed before it: ${summary.refreshed.length === 0 ? "none" : summary.refreshed.join(", ")}`,
    ...leftLines(summary),
    ...(notReached.length > 0 ? [`not reached, left as they are: ${notReached.join(", ")}`] : []),
  ];
}

// --- the refusals, worded once for the run that stops and the one that goes on ----------

/** What every stop at a project starts with: the hints read it, see bin/cli/hints.ts. */
export function stoppedAt(slug: string): string {
  return `refresh stopped at ${slug}: `;
}

export function refusedManifest(slug: string): string {
  return `${slug}'s manifest on the server does not read: nothing was changed for it`;
}

export function foreignUnits(slug: string): string {
  return `${slug}'s units are named like a service of the server that deploy did not write: nothing was changed for it`;
}

export function foreignSecretFiles(slug: string): string {
  return `${slug} declares a secret file that is not its own, which its units would read as root: nothing was changed for it`;
}

export function storeRefused(slug: string): string {
  return `${slug}'s store of secrets cannot be laid, which its units load: nothing was changed for it`;
}

export function notDeployed(slug: string): string {
  return `${slug} is not deployed on the server`;
}

export function changedMeanwhile(slug: string): string {
  return `${slug} changed on the server during this refresh: run sitesolide refresh again`;
}
