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
  // --- setup: first, since a step's failure may quote a message of the
  // patterns below, a domain that does not resolve for one
  [/^usage: sitesolide setup|^setup: .* is not valid: /, "pass the machine as user@host and the options it needs: sitesolide setup root@<address> --zone <dns.zone> --email <address>; docs/setup.md lists them all"],
  [/^the configuration names another (server|zone|account)/, "do not edit, move or delete that configuration: it may point at a machine in service; a second installation gets its own folder, --config-dir <dir> on setup and SITESOLIDE_CONFIG_DIR=<dir> for every command after it; ask the owner when unsure"],
  [/is the configured server, installed without setup/, "this machine is in service: do not run setup on it, and never remove the configuration to get past this; the steps in `details` are the owner's to run by hand, following docs/upgrading.md"],
  [/^cannot reach .* over SSH/, "check the address and that the machine is up, then that `ssh <user@host> true` connects without a prompt (load the key with ssh-add); a refused connection may be a fail2ban ban, which lapses after 10 minutes: never retry in a loop; then run the same command again"],
  [/^setup stopped at [a-z0-9-]+: the connection to the machine was refused or dropped/, "the machine stopped answering ssh, most likely fail2ban banning this workstation: never retry in a loop; wait 10 minutes for the ban to lapse, or have the owner run `sudo fail2ban-client status sshd` from the provider's console, then run the same command again"],
  [/^cannot read .*: the preflight/, "the machine answered something setup does not recognise: check that `ssh <user@host> true` gives a plain shell, then run the same command again"],
  [/, not Debian 13$/, "create a Debian 13 machine and run setup on it; going on with --any-os is the owner's decision alone"],
  [/has no sudo without a password$/, "connect as root, or give that account passwordless sudo first; setup never types a password"],
  [/^unsupported architecture/, "create an amd64 or arm64 machine: Caddy and Bun are installed for those"],
  [/free on \/ of .*, setup needs/, "free some disk on the machine, or create one with a larger disk, then run the same command again"],
  [/already serves the zone /, "check --zone: never set up a machine over the zone it already serves; ask the owner"],
  [/IPv4 is private/, "give the machine's public IPv4 as the host, sitesolide setup root@<public address>, or create the records by hand with --skip-dns"],
  [/no Cloudflare token|Cloudflare token given is not one/, "the owner sets CLOUDFLARE_API_TOKEN in the environment, or pipes the token to --cloudflare-token-stdin; never pass it as an argument nor print it; with another DNS provider, --skip-dns and docs/setup.md"],
  [/Cloudflare token is not/, "the owner creates a token at dash.cloudflare.com/profile/api-tokens with Zone / Zone / Read and Zone / DNS / Edit on the zone, then runs setup again with it; never print it"],
  [/no Cloudflare zone the token can read/, "check --zone, and that the token covers that zone; then run the same command again"],
  [/^setup stopped at dns: records that point elsewhere/, "do not re-run with --dns-replace on your own: show the records in `details` to the owner, who decides whether they may be replaced"],
  [/^setup stopped at resolution: /, "the records exist but this workstation does not see them yet: wait a few minutes, then run the same command again; it resumes there"],
  [/^setup stopped at ssh: /, "sshd was not left half changed, `details` say how it stands: check that `ssh <deploy user>@<host> sudo -n true` works, then run the same command again; never edit sshd's configuration by hand to get past this"],
  [/^setup stopped at /, "read `details`: they name what failed and the command that shows more; fix that cause, then run the same setup command again, which resumes at that step; never change the machine by hand to get past a check"],

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
  [/^the kit has no component named /, "name one of the kit's components, a folder holding a sitesolide.json: dashboard, portal, analytics"],

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
 * table lacks. So does `machine`, which talks to a cloud provider's API rather
 * than to the dashboard: bin/tests/cli-machine.test.ts fails on a code of
 * bin/cli/machine.ts or bin/cli/providers/ this table lacks.
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
  // --- `machine`: a VM ordered from a cloud provider's API, see bin/cli/machine.ts
  "machine-usage": "run one of the commands `details` lists: sitesolide machine create, list or destroy, each with --provider",
  "machine-option": "run the command again without that option, with the options `details` lists; a token is never an option, only an environment variable or --token-stdin",
  "unknown-provider": "pass --provider with one of the names `details` lists; no other provider is supported yet",
  "machine-name": "name the machine with lowercase letters, digits and dashes, 63 characters at most, starting and ending with a letter or a digit",
  "no-provider-token": "the owner creates a token as `details` says, then sets the variable the message names or pipes the token to --token-stdin; never put a token in a command line, a file of the repository or a message, and never guess or borrow one",
  "provider-endpoint": "unset SITESOLIDE_HETZNER_API: it only serves tests, and the token only leaves over https, or over http to the loopback",
  "no-ssh-key": "pass --ssh-key with the path of a public key, the .pub file; if this workstation has none, its owner creates one with ssh-keygen -t ed25519; never pass a private key",
  "invalid-server-type": "pick one of the types `details` lists, sold at that location, and pass it with --type; the cheapest come first",
  "invalid-location": "pick one of the locations `details` lists and pass it with --location",
  "type-unavailable": "the provider would not sell that type there right now: run the same command with one of the types `details` lists as --type, or with another --location; `details` also says what this run had created, deleted again or left for the next run to reuse",
  "machine-exists": "pick another --name: a machine of that name exists in the project and sitesolide did not create it; never delete or rename it to make room",
  "firewall-taken": "pick another --name: a firewall of that name exists and sitesolide did not create it; never delete or rename it to make room",
  "machine-not-found": "check the name with `sitesolide machine list --provider <provider>`: nothing was destroyed",
  "machine-not-managed": "sitesolide only destroys the machines it created: if this one has to go, its owner deletes it from the provider's console",
  "confirm-mismatch": "pass --confirm with the machine's exact name, and only if the owner asked for this machine to be destroyed: every site it serves goes with it",
  "needs-confirm": "re-run with --confirm <name>, and only if the owner asked for this machine to be destroyed: its disk and the provider's backups of it go for good",
  "machine-timeout": "the provider is still working on it: run the same command again in a few minutes, it picks the machine up where it stands; `sitesolide machine list --provider <provider>` shows its status",
  "machine-off": "the machine exists but is powered off: its owner powers it on from the provider's console, then runs the same command again",
  "ssh-timeout": "the machine runs but port 22 did not answer yet: run the same create command again in a minute, it resumes at this wait; if it persists, look at the machine's console at the provider",
  "action-failed": "the provider says why in `message`: fix what it names, or run the same command again if it says to retry; the provider's console shows the project as it stands",
  "provider-unauthenticated": "the provider refused the token: the owner creates a new one with Read & Write permission in the project (Security, API tokens), then sets its variable, HCLOUD_TOKEN for Hetzner, or pipes it to --token-stdin; never guess or borrow a token",
  "provider-forbidden": "the token may read but not change: the owner creates a token with Read & Write permission in the project, then runs the same command with it",
  "provider-limit": "the provider's project reached one of its limits: its owner removes what it no longer needs, or asks the provider to raise the limit",
  "provider-name-taken": "a resource of that name already exists at the provider: pick another --name, or run `sitesolide machine list --provider <provider>` to see the machines sitesolide created",
  "provider-busy": "the resource was busy or changed during the request: run the same command again in a minute",
  "provider-unavailable": "the provider cannot do it at that location right now: pick another --type or --location, or run the same command again later",
  "provider-invalid": "the provider refused the request: fix what `message` and `details` name, then run the same command again",
  "provider-rate-limited": "wait the seconds `details` names, then run the same command once; never retry in a loop",
  "provider-failure": "the provider failed on its side: run the same command again in a few minutes, it resumes where it stopped; the provider's status page says whether it is down",
  "provider-unreachable": "the provider's API did not answer: check this workstation's network, then run the same command again",
  "provider-unreadable": "the address answered with something that is not the provider's API: unset SITESOLIDE_HETZNER_API, which only serves tests",
  "provider-not-found": "a resource disappeared during the run: run `sitesolide machine list --provider <provider>`, then the same command again",
  "machine-unexpected": "an unexpected failure: run the same command again; if it persists, report it with the message; never work around it by changing the provider's project by hand",
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
