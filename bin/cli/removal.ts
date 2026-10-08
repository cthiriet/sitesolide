/**
 * What removing a project from the machine takes, and in what order.
 *
 * The command that was missing: `deploy` knew how to put everything in place,
 * nothing knew how to take anything away. An abandoned project therefore stayed
 * served by the VM, with the repository saying nothing more about it, and its
 * system user, its secret and its data directory outlived it indefinitely.
 *
 * This file runs nothing: it returns strings, which bin/sitesolide.ts passes to
 * the executor. That is what allows testing the order and the content of each
 * action without ever touching production, where a mistake here erases a site.
 */

import { OWNER_SOCKET, readCurlAnswer } from "./access";
import { secretPath, projectPaths, systemUser, unitArgument } from "./unit";

/**
 * The order is the deployment's in reverse, and it is no more negotiable than
 * that one.
 *
 * **The Caddy block goes first, except in front of the portal.** `deploy` puts
 * it in place last for an open site, once the service is up, precisely because
 * a block pointing at an absent service answers 502. Deleting the other way
 * round would produce exactly that: the directory erased and the block still in
 * service, so an address in error for as long as the second step takes, and
 * lastingly so if it fails.
 *
 * A site behind the portal follows the reverse order, like `deploy` which puts
 * its door in place before its files: see removalSteps.
 *
 * **The user goes last**, after the data directory that belongs to it:
 * `userdel` otherwise leaves files with no owner, which the next system user
 * would inherit on the same UID.
 */
/**
 * Where the dashboard's steward keeps the previous version of each secret it
 * rewrites: `STATE_FOLDER` from dashboard/steward.ts, followed by
 * `precedents/`. Copied out here, the CLI importing nothing from the dashboard.
 */
export const PREVIOUS_DIR = "/var/lib/sitesolide-steward/precedents";

export type Action = {
  /** What is shown, in the CLI's language. */
  title: string;
  /** The command passed to the remote shell. */
  command: string;
};

export type ProjectToRemove = {
  slug: string;
  isApplication: boolean;
  /** The manifest's `secrets` files, each at /etc/sitesolide/<name>. */
  secrets: readonly string[];
  /**
   * The project's units without `.service`, the main one first: the slug
   * alone for a single service, see servicesOf in manifest.ts.
   */
  units?: readonly string[];
};

const UNIT_TITLE = "stop and remove the systemd unit";

/**
 * The remote actions of a removal, in order.
 *
 * Each one tolerates absence: a removal run again after a failure half way
 * through must be able to go all the way, and a half-deployed project does not
 * have every piece. That is the point of the `|| true` and of the `-f`, which
 * hide no useful error here: there is nothing to learn from "this file no
 * longer exists".
 */
export function removalActions(project: ProjectToRemove): Action[] {
  const { slug, isApplication } = project;
  const paths = projectPaths(slug);
  const account = systemUser(slug);
  const actions: Action[] = [];

  if (isApplication) {
    // `disable --now` stops and removes the startup link in one action. A
    // service already stopped is not an error, hence the `|| true`: without it,
    // a removal resumed after the fact would fail on its first step. Every
    // unit of the project goes in the same action, the main one first.
    const units = project.units !== undefined && project.units.length > 0 ? project.units : [slug];
    actions.push({
      title: UNIT_TITLE,
      command: [
        `sudo systemctl disable --now ${units.map(unitArgument).join(" ")} 2>/dev/null || true`,
        `sudo rm -f ${units.map((unit) => `/etc/systemd/system/${unit}.service`).join(" ")}`,
        "sudo systemctl daemon-reload",
      ].join(" && "),
    });
  }

  // The whole directory, data included. This is the irreversible action of the
  // lot: the VM has no backup, and a SQLite database that goes does not return.
  actions.push({
    title: "remove the served directory, data included",
    command: `sudo rm -rf ${paths.root}`,
  });

  for (const secret of project.secrets) {
    actions.push({
      title: `remove the secret ${secret}`,
      command: `sudo rm -f ${secretPath(secret)}`,
    });
    // Its previous version goes with it. Left behind, a project recreated under
    // the same name would find in the dashboard a key of its predecessor to
    // restore; the steward would refuse it on the uid, but nothing justifies
    // keeping it.
    actions.push({
      title: `remove the previous version of ${secret} kept by the dashboard`,
      command: `sudo rm -f ${PREVIOUS_DIR}/${secret}`,
    });
  }

  if (isApplication) {
    // After the directory, never before: see the header of Action.
    actions.push({
      title: "remove the system user",
      command: `id -u ${account} >/dev/null 2>&1 && sudo userdel ${account} || true`,
    });
  }

  return actions;
}

export type RemovalStep =
  | { kind: "action"; action: Action }
  /** The removal of the Caddy block, by bin/deploy-caddy.sh and its transaction. */
  | { kind: "block" };

/**
 * The whole removal in order, the block's removal included, `block` saying
 * whether there is one to remove.
 *
 * **In front of the portal, what is served goes before the block.** A protected
 * site's block carries its door, and removing it hands the address back to the
 * zone's wildcard block, which serves `/srv/sites/<slug>/public` to everyone.
 * In an open site's order, the files of a closed site were therefore served in
 * the clear during bin/deploy-caddy.sh's check, and indefinitely if the command
 * was interrupted before the directory was erased. The service is stopped and
 * `public/` removed first: the block that goes uncovers nothing any more.
 *
 * The 502 that the open order avoids is of no consequence here: the door
 * answers 401 to strangers before reaching the service, and deploy-caddy.sh's
 * check only queries a site that still serves something.
 *
 * The rest of the directory, data and deposited manifest included, always goes
 * after the block: the manifest is what tells a removal run again that a block
 * put up from the dashboard is still to be removed, and the data does not go as
 * long as the block's removal has not succeeded.
 */
export function removalSteps(
  project: ProjectToRemove,
  options: { block: boolean; isProtected: boolean },
): RemovalStep[] {
  const actions = removalActions(project);
  const asSteps = (list: Action[]): RemovalStep[] => list.map((action) => ({ kind: "action", action }));
  if (!options.block) return asSteps(actions);
  if (!options.isProtected) return [{ kind: "block" }, ...asSteps(actions)];

  const unit = actions.filter((action) => action.title === UNIT_TITLE);
  const rest = actions.filter((action) => action.title !== UNIT_TITLE);
  const publicDir = projectPaths(project.slug).publicDir;
  return [
    ...asSteps(unit),
    ...asSteps([
      {
        title: "take down the public files first, which the wildcard block would serve to anyone",
        command: `sudo rm -rf ${publicDir}`,
      },
    ]),
    { kind: "block" },
    ...asSteps(rest),
  ];
}

/**
 * What is left to do by hand, and that this command will not do.
 *
 * **The site's code is never deleted by the CLI.** It lives in another
 * repository, under git, and a deployment command that erased sources would be
 * a tool nobody dares run any more. `git rm -r` does it better, and its history
 * keeps the site recoverable.
 */
export function leftToDo(slug: string, siteFolder: string | null): string[] {
  return [
    siteFolder === null
      ? `remove the site folder from the sites repository: git rm -r ${slug}`
      : `remove the site folder: git rm -r ${siteFolder}`,
    "if your workstation's vault holds a credential for it, delete that file too",
    "check what still mentions it: README, CLAUDE.md, your notes",
  ];
}

// --- the token that created it --------------------------------------------------------

/**
 * The steward's last word on a removed project: the token that created it,
 * if one did, no longer owns its name, so that another token may create a
 * project of that name later, and its people with access are dropped, so that
 * such a project starts from nobody. Root asks the steward's owner socket on
 * the machine, the slug on standard input; the steward refuses while the
 * machine still carries the project, so this comes once the folder is gone.
 */
export function ownershipReleaseCommand(): string {
  return `sudo curl -sS --max-time 10 -X DELETE -H 'Content-Type: application/json' --data-binary @- -w '\\n%{http_code}\\n' --unix-socket ${OWNER_SOCKET} http://steward/tokens/project`;
}

export type OwnershipRelease =
  /** `access`: the people with access dropped with it, 0 from a steward that kept none. */
  | { kind: "released"; token: string; access: number }
  | { kind: "none"; access: number }
  /** A steward from before it, or one with no owner's socket: nothing released. */
  | { kind: "outdated" }
  | { kind: "failed"; reason: string };

/** What the steward answered, read whole. Never thrown: the project is gone whatever this says. */
export function readOwnershipRelease(done: { code: number; output: string; error: string }): OwnershipRelease {
  if (done.code === 7) return { kind: "outdated" };
  if (done.code !== 0) return { kind: "failed", reason: done.error.trim() || `exit ${done.code}` };
  const answer = readCurlAnswer(done.output);
  if (answer === null) return { kind: "failed", reason: "an answer this CLI cannot read" };
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(answer.body);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    return { kind: "failed", reason: `the steward answered ${answer.status} with something this CLI cannot read` };
  }
  if (answer.status === 404 && body.message === "no such route") return { kind: "outdated" };
  if (answer.status !== 200) return { kind: "failed", reason: typeof body.message === "string" ? body.message : `refused (${answer.status})` };
  const access = typeof body.access === "number" && Number.isInteger(body.access) && body.access >= 0 ? body.access : 0;
  return typeof body.forgotten === "string" ? { kind: "released", token: body.forgotten, access } : { kind: "none", access };
}

/**
 * The confirmation required: the slug, typed again.
 *
 * A flag on its own protects nothing, `--yes` gets typed without reading.
 * Typing the project's name again requires knowing which one is being deleted,
 * and **makes impossible the removal launched from the wrong directory**, which
 * is how this accident actually happens.
 */
export function isValidConfirmation(typed: string | undefined, slug: string): boolean {
  return typed !== undefined && typed.trim() === slug;
}
