/**
 * What to do next, for every refusal the CLI can print: the `hint` of an
 * `error` event under `--json`.
 *
 * The messages already say what went wrong, and their details often say what
 * to do, in prose written for a person who knows the machine. An agent needs
 * the one action it can take, and needs to know the actions it must not take:
 * re-running with `--force`, touching the server by hand, guessing a secret.
 * Each hint says both when both matter.
 *
 * Kept in one table, read by the output layer, rather than written at each of
 * the fifty call sites of `die`: the refusals stay worded where they are, and
 * the human output does not change. `bin/tests/cli-hints.test.ts` reads every
 * literal `die(` of bin/sitesolide.ts and fails on one this table does not
 * cover, so a new refusal cannot ship without its hint.
 *
 * The order matters: the first pattern that matches wins, so the narrower ones
 * come first.
 *
 * Pure: returns text.
 */

/** A read over SSH that failed, whatever it was reading. */
const READ_FAILED =
  "a read over SSH failed, nothing was changed: run the same command again; if it fails twice, check that `ssh <server> true` connects without a prompt (load the key with ssh-add)";

/** Someone else holds the lock shared with the dashboard's gatekeeper. */
const LOCK_BUSY = "someone else is changing Caddy right now: wait a minute, then run the same command again";

export const HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  // --- the project folder and its manifest
  [/^no sitesolide\.json in .*: inferred one shown above/, "review the manifest shown in the `inferred` event, then run `sitesolide deploy --yes` to write it and deploy, or `sitesolide detect --write` to write it without deploying"],
  [/already exists on the server, and this folder has no sitesolide\.json/, "pick another name with --slug <name>; never deploy over a project you did not create"],
  [/^nothing deployable recognised in /, "write sitesolide.json by hand (docs/manifest.md), or arrange the folder as `details` describe and run `sitesolide detect` again"],
  [/^no usable slug in the folder name/, "pass one explicitly: --slug <name>, lowercase letters, digits and dashes"],
  [/^sitesolide\.json already exists in /, "the folder already has a manifest: edit it, or delete it first if the inferred one should replace it"],
  [/^sitesolide\.json not found in .*, and none can be inferred/, "write sitesolide.json by hand (docs/manifest.md), or arrange the folder as `details` describe; `sitesolide detect` says what it recognises"],
  [/^sitesolide\.json not found in /, "run `sitesolide detect` in this folder to see the manifest it implies; `sitesolide deploy --yes` writes it and deploys"],
  [/^sitesolide\.json rejected once the portal/, "fix the keys listed in `details` in sitesolide.json, keeping `portal` as the server has it, then run the same command again"],
  [/^sitesolide\.json rejected/, "fix the keys listed in `details` in sitesolide.json (docs/manifest.md describes every key), then run the same command again"],
  [/^source leads outside the repository/, "point `source` inside the repository that holds sitesolide.json, or let the owner deploy it from their sites repository; never point it at another folder of this workstation"],
  [/^source not found/, "fix `source` in sitesolide.json: a path relative to the folder holding it, to a folder that exists"],
  [/^exclude: .* present on disk and not excluded/, "add the names listed in `details` to `exclude` in sitesolide.json, then run deploy again"],
  [/^port: required, and only deploy chooses one/, "run `sitesolide deploy`: it picks a free port on the server and writes it into sitesolide.json"],
  [/^--json is not available for /, "run that command without --json"],
  [/^--slug: /, "pass a slug made of lowercase letters, digits and dashes, 63 characters at most"],
  [/^--lines: /, "pass a whole number of lines between 1 and 1000"],
  [/^unknown command/, "run `sitesolide` with no argument to list the commands"],

  // --- the build and what it produces
  [/^build failed/, "run the build command from the message in the project folder, fix what it reports, then deploy again"],
  [/^publicDir not found/, "make `build` produce that folder, or point `publicDir` in sitesolide.json at the folder that holds index.html"],
  [/^publicDir is empty/, "the build produced nothing to serve: fix it so that publicDir holds the site; an empty folder would wipe the live one"],

  // --- the machine, read before anything is pushed
  [/no longer matches the manifest/, "do not re-run with --force on your own: show the differing lines in `details` to the owner, who decides whether the manifest or the file on the server is right"],
  [/is already the name of a service of the server/, "pick another slug in sitesolide.json; never deploy under the name of a system service, and never remove, rename or mask anything on the server to make room"],
  [/^port already taken on the server/, "change `port` in sitesolide.json to a free port between 3000 and 3099, or delete the key and let deploy pick one"],
  [/^no free port left on the server/, "the owner has to free a port by removing a project the server no longer needs; deploy cannot pick one"],
  [/^the loopback rule in service predates the project set/, "the owner has to lay the current loopback rule first (the command is in `details`); an agent must not run it"],
  [/^\/etc\/sitesolide-loopback-projects\.nft refused/, "tell the owner: the loopback rule on the server refused this project's ports; nothing more can be done from here"],
  [/^the egress proxy is installed on the server but not running/, "tell the owner: the egress proxy has stopped (`journalctl -u sitesolide-egress` on the server says why); deploy nothing that declares egress or connectors until it runs again, and never start it by hand"],
  [/the egress proxy is not installed on the server/, "the owner has to install the egress proxy first (bin/deploy-egress.sh, egress/README.md); until then, remove `egress` and `connectors` from sitesolide.json, or ask for `network: outbound`"],
  [/^cannot read the manifests on the server/, READ_FAILED],
  [/^cannot read the status of the server/, READ_FAILED],
  [/^cannot read the system users/, READ_FAILED],
  [/^cannot read the loopback's project set/, READ_FAILED],
  [/^cannot tell whether/, READ_FAILED],
  [/^read refused by the server/, READ_FAILED],

  // --- the door and the lock, shared with the dashboard
  [/^cannot take the Caddy lock/, "the lock could not be taken, nothing was changed: run the same command again; if it fails twice, check that `ssh <server> true` connects without a prompt"],
  [/try again in a moment/, LOCK_BUSY],
  [/is not a workstation lock holder line/, "unset CADDY_LOCK_HELD in this environment, then run the command again"],
  [/changed from the dashboard during this deploy/, "the server changed while deploy ran: run `sitesolide deploy` again"],
  [/^portal of .* changed from the dashboard/, "run `sitesolide deploy` in the project's folder first, so that sitesolide.json follows the server, then run this command again"],
  [/is behind the portal: turn it off from the dashboard first/, "ask the owner to turn the portal off in the dashboard's Access section, then run `sitesolide deploy` in this folder, then this command"],
  [/^the portal is not ready/, "the portal has to be deployed before a site can sit behind it: ask the owner, or remove `portal` from sitesolide.json"],
  [/^interrupted by /, "the run was interrupted between two steps: run the same command again"],

  // --- secrets: never in the repository
  [/^secret missing on the server/, "ask the owner to create this file and its variables in the dashboard's Secrets section (the address is in `details`), then run deploy again; never put secret values in the repository or in sitesolide.json"],
  [/^secrets are managed in the Secrets section/, "secrets are set in the dashboard's Secrets section, at the address in the message; there is nothing to run here"],
  [/^no secret declared in the manifest/, "`sitesolide run` only loads declared secrets: declare `secrets` in sitesolide.json if the command needs one"],
  [/^usage: sitesolide run/, "pass the command after a double dash: sitesolide run -- <command>"],
  [/^missing from the vault/, "only the owner can put that file in the workstation's vault, at the path in the message; never write a secret yourself"],

  // --- after the push
  [/^install failed/, "read the `output` events just before this error: install runs as the project's account, in the walls `details` describe; run the command in the project folder to reproduce it, move a step that writes outside app/ into build, then deploy again"],
  [/^write refused/, "the server refused a write over SSH: check that the deployment account still has sudo, then run the same command again"],
  [/should answer the portal's 401/, "the site is served in the clear although declared behind the portal: tell the owner at once, and deploy nothing else until it is fixed"],
  [/answered 404: nothing is served at the site's root/, "make / answer 200: an app without `routes` receives / and must answer it; with `routes`, or for a static site, put an index.html in publicDir (docs/manifest.md, under start); a redirect does not count either; then deploy again"],
  [/unreachable: /, "the deployment is installed but the address did not answer: read `sitesolide logs --json`, then `sitesolide status --json`, and fix the service before deploying again"],
  [/^unexpected response: /, "the service answers with an error after the deployment: read `sitesolide logs --json` to find why, fix the code, then deploy again"],
  [/^failed \([0-9]+\): /, "read the `output` events just before this error, they carry the failing command's own message; fix that cause, then run the same command again"],

  // --- domains and removal: the owner's decisions
  [/^no domain declared in the manifest/, "declare the owner's domain first in sitesolide.json: \"domain\": { \"name\": \"example.com\", \"active\": false }"],
  [/does not resolve to /, "point the domain's DNS record at the server, wait for it to propagate, then run this again; --force only on the owner's explicit decision"],
  [/^removal needs the slug typed back/, "re-run with --confirm <slug>, and only if the owner asked for this project to be removed: the server keeps no backup"],

  // --- the binary's kit, see bin/cli/kit.ts
  [/^cannot unpack the kit into /, "the binary could not write its scripts into the folder the message names: free some disk space or fix that folder's permissions, or set XDG_CACHE_HOME to a writable folder, then run the same command again"],
  [/^the kit embedded in this binary /, "the binary is damaged: install the release again with install.sh, then run the same command again"],
  [/^this binary carries no kit/, "this binary was compiled without bin/build.ts: install a release with install.sh, or build one with `bun bin/build.ts`"],

  // --- the workstation's configuration
  [/^missing settings: /, "the owner has to run `sitesolide init` once on this workstation; never guess the server or the zone"],
  [/ is required$/, "pass every setting: sitesolide init --server <user@host> --zone <dns.zone> --email <address>"],
];

/**
 * The hints of a run through the dashboard's control API, by the code its
 * refusal carries: the API's own (docs/team.md), the installer's for a
 * deployment that failed on the machine, and the CLI's for what it refuses
 * before a request leaves. Their messages are worded on the machine, where no
 * pattern of HINTS reads them; a code this table lacks falls back to them.
 * `share` reports by code whichever way it runs, over the owner's SSH too:
 * bin/tests/cli-hints.test.ts fails on a code of bin/cli/sharing.ts this
 * table lacks.
 */
export const REMOTE_HINTS: Readonly<Record<string, string>> = {
  // --- refused before a request leaves
  "no-dry-run": "review sitesolide.json with the user, then run `sitesolide deploy` without --dry-run once they agree: the machine judges the manifest before anything is built or uploaded",
  "unknown-option": "run the command without that option; `details` lists the ones it takes with a team token",
  "needs-ssh": "this command is the owner's: ask the owner of the machine to run it; with a team token, only deploy, status, logs, share and login run",
  usage: "run one of the commands `details` lists",
  // --- the control API
  unauthenticated: "the token is missing, unknown, expired or revoked: ask the owner of the machine for one, then run `sitesolide login`; never guess a token or borrow another one",
  "too-many-attempts": "wait the seconds `details` names, then run the same command once; never retry in a loop",
  "out-of-scope": "the token may not do this: change what `details` names (in sitesolide.json for a deployment, in the command for sharing), or ask the owner of the machine, who may widen the token or do it themselves; never pick another slug or another token to get around it",
  reserved: "the slug belongs to the platform: pick another one in sitesolide.json",
  "invalid-manifest": "fix every point of `details` in sitesolide.json (docs/manifest.md), then deploy again",
  invalid: "fix what the message names, then run the same command again",
  "not-found": "no such project for this token: check the slug in sitesolide.json, and run `sitesolide status` for the projects it reaches",
  busy: "a deployment of this project is already running: wait for it to finish, then deploy again",
  "too-large": "exclude dependencies, caches and build leftovers in sitesolide.json: the machine installs the dependencies itself",
  expired: "the archive arrived too late: run `sitesolide deploy` again",
  "not-available": "the machine does not carry what this needs yet, the control API or a portal that knows sharing: tell the owner of the machine, with the message, which names what to update; nothing more can be done from here until then",
  failure: "something broke on the machine: tell the owner of the machine, with the message; do not retry in a loop",
  unreachable: "the dashboard did not answer: check the network and the address (`sitesolide login --url`), then run the same command again",
  unreadable: "the address answered with something that is not the control API: check it with `sitesolide login --url https://dashboard.<zone>`",
  // --- sharing, with a token or over the owner's SSH
  "no-portal": "sharing applies only to a site behind the portal: deploy it first if it is not deployed, or deploy it again if its block lags behind; putting a site behind the portal, or making it public, is the owner's, from the dashboard's Access section",
  "portal-unreachable": "the portal did not answer on the server, nothing was changed: tell the owner of the machine (`systemctl status portal` on the server); never restart it yourself",
  "ssh-failed": "a command over SSH failed, nothing was changed: run the same command again; if it fails twice, check that `ssh <server> true` connects without a prompt (load the key with ssh-add)",
  // --- a deployment that failed on the machine
  "install-failed": "run the install command from the message in the project folder, fix what it reports, then deploy again",
  "secret-missing": "ask the owner of the machine to create that file in the dashboard's Secrets section, then deploy again; never put secret values in the repository or in sitesolide.json",
  "edited-by-hand": "do not re-run with --force, a token has none: tell the owner of the machine, who reads the file and decides",
  "system-unit": "pick another slug in sitesolide.json: this one names a service of the machine",
  "caddy-busy": LOCK_BUSY,
  "door-changed": "the portal changed from the dashboard while the deployment ran: deploy again",
  "port-taken": "delete `port` from sitesolide.json and let the machine choose one, or pick a free one between 3000 and 3099",
  "no-port": "the owner has to free a port by removing a project the machine no longer needs",
  "bundle-refused": "replace symbolic links and special files with the files they point to, or exclude them in sitesolide.json, then deploy again",
  "public-empty": "make the build produce the site in publicDir: an empty folder would wipe the live one",
  "portal-not-ready": "the portal has to be deployed first: tell the owner of the machine",
  "service-failed": "read `sitesolide logs --json` to see why the service did not start, fix the code, then deploy again",
  "verify-failed": "a 404 means nothing answers at /: make it answer 200, from the app, which receives / unless the manifest has routes, or from an index.html in publicDir (docs/manifest.md, under start); otherwise read `sitesolide logs --json`; a site declared behind the portal that answers in the clear must be reported to the owner of the machine at once",
  "machine-unreadable": "the machine could not be read, nothing was changed: deploy again in a minute, then tell the owner of the machine if it persists",
};

/** The hint of a refusal through the API: its code's, or what its message says. */
export function hintForFailure(code: string, message: string): string {
  return Object.hasOwn(REMOTE_HINTS, code) ? REMOTE_HINTS[code]! : hintFor(message);
}

/** What a refusal no pattern covers gets: never a workaround. */
export const DEFAULT_HINT =
  "read `message` and `details`, fix the cause they name, then run the same command again; never work around a refusal with --force or by changing the server by hand";

export function hintFor(message: string): string {
  for (const [pattern, hint] of HINTS) {
    if (pattern.test(message)) return hint;
  }
  return DEFAULT_HINT;
}
