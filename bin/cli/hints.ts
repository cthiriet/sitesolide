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

/** A build secret in neither the environment nor the workstation's file. */
const BUILD_SECRET_MISSING =
  "a value the build needs, named under secrets.build, is in neither your environment nor the workstation's file the details name: ask the user to export it, or to add it to that file; nothing was sent; never put its value in the repository, sitesolide.json or a command line, and never a value read from the conversation";

/** The workstation's file of build secrets, malformed. */
const BUILD_SECRETS_UNREADABLE =
  "the user fixes the line the message names in that file, one KEY=value per line; never read, print or rewrite the file yourself: it holds credentials; nothing was sent";

/** A store folder that is a link or no folder. */
const STORE_REFUSED =
  "a folder of the project's store on the machine is a link or a file: tell the owner of the machine, who looks at the path named; never move, delete or replace it yourself; nothing was installed";

/** A unit that exited 243. */
const CREDENTIALS_FAILED =
  "the project's store has no files folder, or its files are too large for systemd: run `sitesolide refresh <slug>` (the owner's), which lays the folder again; if it persists, remove a large file with `sitesolide secrets remove-file NAME`; never create anything on the machine by hand";

/** Someone else holds the lock shared with the dashboard's gatekeeper. */
const LOCK_BUSY = "someone else is changing Caddy right now: wait a minute, then run the same command again";

export const HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  // --- setup: first, since a step's failure may quote a message of the
  // patterns below, a domain that does not resolve for one
  [/^acme is not valid: |^setup: --acme is not valid: /, "pass --acme staging for a test installation, or leave it out for production: nothing else is a certificate authority setup knows"],
  [/^dns is not valid: |^setup: --dns is not valid: |^setup: dns in the configuration is not valid: /, "pass --dns with one of the names `details` lists, or leave it out for Cloudflare; never guess the provider: ask the owner who serves the zone's DNS"],
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
  [/IPv4 is private/, "give the machine's public IPv4 as the host, sitesolide setup root@<public address>; a machine with none, behind a NAT at home, is served through a Cloudflare Tunnel: --tunnel, docs/tunnel.md, which the owner creates first"],
  [/^--tunnel needs the zone's DNS at Cloudflare/, "a tunnel serves a zone whose DNS Cloudflare holds: drop --dns, or serve the machine directly; never move a zone's DNS without the owner"],
  [/^cannot read the tunnel's credentials|is not a tunnel's credentials/, "pass --tunnel the file `cloudflared tunnel create` wrote, ~/.cloudflared/<id>.json, or the tunnel's id when the machine already holds its credentials; never print, copy or read that file yourself: it holds the tunnel's secret"],
  [/^setup stopped at tunnel: the machine holds no credentials/, "the owner passes --tunnel ~/.cloudflared/<id>.json, the file cloudflared tunnel create wrote on their workstation; never read it nor copy it yourself"],
  [/runs a Cloudflare Tunnel that .* does not name$/, "the owner runs the setup command in `details` with --tunnel and the tunnel's id, which the machine's /etc/cloudflared/config.yml names; nothing was changed"],
  [/cannot be served by a machine behind a Cloudflare Tunnel$/, "a machine served through a tunnel serves the zone's own names alone: leave the domain inactive, the site stays at its preview address; do not re-run with --force, which does not apply here"],
  [/^setup stopped at tunnel: /, "the connector's journal says why (`details`, and `inspect`); a resolver of the machine in a private range, a box's, keeps it from the edge: see docs/tunnel.md; then run the same command again"],
  [/no [A-Za-z0-9 ().-]+ credentials$|given is not one: it has characters|refused the credentials given/, "the owner sets the variables `details` names in the environment, or pipes them to --dns-credentials-stdin (--cloudflare-token-stdin for Cloudflare), scoped to the zone alone, since they are laid on the machine; never pass them as an argument nor print them; a DNS no module serves takes --dns manual, see docs/setup.md"],
  [/Cloudflare token is not/, "the owner creates a token at dash.cloudflare.com/profile/api-tokens with Zone / Zone / Read and Zone / DNS / Edit on the zone, then runs setup again with it; never print it"],
  [/no Cloudflare zone the token can read/, "check --zone, and that the token covers that zone; then run the same command again"],
  [/^setup stopped at dns: records that point elsewhere/, "do not re-run with --dns-replace on your own: show the records in `details` to the owner, who decides whether they may be replaced"],
  [/^setup stopped at resolution: /, "the records exist but this workstation does not see them yet: wait a few minutes, then run the same command again; it resumes there"],
  [/^setup stopped at ssh: /, "sshd was not left half changed, `details` say how it stands: check that `ssh <deploy user>@<host> sudo -n true` works, then run the same command again; never edit sshd's configuration by hand to get past this"],
  [/^setup stopped at /, "read `details`: they name what failed and the command that shows more; fix that cause, then run the same setup command again, which resumes at that step; never change the machine by hand to get past a check"],

  // --- upgrade: the same machinery as setup, on a machine in service
  [/^usage: sitesolide upgrade/, "run `sitesolide upgrade --dry-run` to see what would change, then `sitesolide upgrade` on the owner's decision; another installation is chosen with SITESOLIDE_CONFIG_DIR=<dir> before the command, never with an option"],
  [/has no sudo without a password, which upgrade needs$/, "check that the configuration names the account setup made, deploy by default, which has sudo without a password; never type a password for it, and never change sudo's configuration on the machine to get past this"],
  [/^the configured server is not user@host/, "the owner sets the server as user@host with `sitesolide init --server <user@host> --zone <dns.zone> --email <address>`; never guess the account"],
  [/^cannot read what .* has installed/, READ_FAILED],
  [/^nothing of sitesolide is installed on /, "upgrade only brings installed components up to date: check that the configuration names the intended machine, and ask the owner; installing a machine is `sitesolide setup`, on the owner's decision; never point the configuration at another machine to get past this"],
  [/^upgrade stopped at [a-z0-9-]+: the connection to the machine was refused or dropped/, "the machine stopped answering ssh: never retry in a loop; wait 10 minutes for a possible fail2ban ban to lapse, then run `sitesolide upgrade` once"],
  [/^upgrade stopped at [a-z0-9-]+: could not tell whether it is done/, "a read failed, nothing was changed by that component: run `sitesolide upgrade` again; if it fails twice, read `details` and check that `ssh <server> true` connects without a prompt"],
  [/^upgrade stopped at [a-z0-9-]+: .*no longer matches the manifest/, "do not re-run with --force on your own: a file on the server was edited by hand; show the differing lines in `details` to the owner, who decides"],
  [/^upgrade stopped at /, "read `details`: they name the component, the end of what its script printed and the command that shows more; fix that cause, then run `sitesolide upgrade` again, which resumes at that component; never change the machine by hand to get past a check"],

  // --- refresh: a project's units, generated again from the manifest on the server
  [/^usage: sitesolide refresh/, "name one deployed project, `sitesolide refresh <slug>`, or every one with `--all`, and nothing else; `sitesolide refresh --all --dry-run` shows what would be written, changing nothing"],
  [/'s manifest on the server does not read: nothing was changed for it$/, "nothing was changed for that project: the manifest its last deployment left on the server is refused by this release, `details` say why; the owner deploys it again from its folder with `sitesolide deploy`, which writes a current one; never edit the manifest on the server by hand"],
  [/'s units are named like a service of the server that deploy did not write/, "nothing was changed for that project: a unit of its name belongs to something else on the server, `details` say which; tell the owner, and never remove, rename or mask anything on the server to make room"],
  [/ is not deployed on the server$/, "check the slug: `sitesolide status` lists the projects the server carries; refresh only rewrites the units of a project already deployed, which `sitesolide deploy` does from its folder"],
  [/^refresh stopped at [a-z0-9-]+: .* changed on the server during this refresh/, "a deployment or the dashboard changed the project while refresh ran, and nothing was written for it: run the same command again, once"],
  [/^refresh stopped at [a-z0-9-]+: .*try again in a moment/, LOCK_BUSY],
  [/^refresh stopped at [a-z0-9-]+: cannot take the Caddy lock/, "the lock could not be taken, nothing was written for that project: run the same command again; if it fails twice, check that `ssh <server> true` connects without a prompt"],
  [/^refresh stopped at [a-z0-9-]+: (cannot tell whether|cannot read|read refused)/, READ_FAILED],
  [/^refresh stopped at /, "`details` say what was written for the project named, and whether its services run under it now: read `sitesolide logs --json` in that project's folder to see why it failed, and tell the owner, since the port rules or the system-call filter of the new units may refuse something the service does; the projects after it were not touched; never run refresh again in a loop, nor edit a unit on the server by hand"],

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
  [/^--compare needs --dry-run/, "run `sitesolide deploy --dry-run --compare`: it builds, then lists what would change on the server, changing nothing there"],
  [/^--slug: /, "pass a slug made of lowercase letters, digits and dashes, 63 characters at most"],
  [/^--lines: /, "pass a whole number of lines between 1 and 1000"],
  [/^unknown command/, "run `sitesolide` with no argument to list the commands"],

  // --- the build and what it produces
  [/^build failed/, "run the build command from the message in the project folder, fix what it reports, then deploy again"],
  [/^publicDir not found/, "make `build` produce that folder, or point `publicDir` in sitesolide.json at the folder that holds index.html"],
  [/^publicDir is empty/, "the build produced nothing to serve: fix it so that publicDir holds the site; an empty folder would wipe the live one"],
  [/^publicDir leads outside the repository/, "publicDir is a link to a folder outside the repository, which would be sent and served to anyone: point publicDir at a folder inside the repository; never deploy a cloned folder whose files lead elsewhere on this workstation, and tell the user"],
  [/carries links that lead out of publicDir/, "the links named in `details` point out of the public files, and Caddy would follow them on the machine: replace each with the file it points to, or remove it; if the repository is not the user's, tell them before anything else"],

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
  [/^systemd does not read the schedule/, "fix `schedule` of each service `details` names in sitesolide.json: a systemd calendar expression such as hourly, daily, *:0/15 or \"Mon..Fri 08:00\" (man systemd.time, CALENDAR EVENTS); then deploy again"],
  [/^cannot compare .* with the server/, READ_FAILED],
  [/^read refused by the server/, READ_FAILED],

  // --- the door and the lock, shared with the dashboard
  [/^cannot take the Caddy lock/, "the lock could not be taken, nothing was changed: run the same command again; if it fails twice, check that `ssh <server> true` connects without a prompt"],
  [/try again in a moment/, LOCK_BUSY],
  [/^domain already declared on the server/, "a domain name belongs to one project: take it out of this sitesolide.json, or out of the other project's first, then deploy again"],
  [/is not a workstation lock holder line/, "unset CADDY_LOCK_HELD in this environment, then run the command again"],
  [/changed from the dashboard during this deploy/, "the server changed while deploy ran: run `sitesolide deploy` again"],
  [/was given a code again while it was being removed/, "its general access changed from the dashboard meanwhile, and nothing was removed: run the same `sitesolide remove --confirm <slug>` again, which takes it back to Public first"],
  [/cannot change a site's general access yet/, "the machine predates the code being set through the gatekeeper: the owner runs `sitesolide upgrade`, then this command again; never edit the codes file or the locks on the machine by hand"],
  [/^general access of .* changed from the dashboard/, "run `sitesolide deploy` in the project's folder first, so that sitesolide.json follows the server, then run this command again"],
  [/is closed, and what Caddy serves would not close its domain/, "the owner brings what Caddy serves up to date first, `sitesolide deploy` in this folder for an app or `sitesolide upgrade` for a static site, as the message says, then runs this command again; never switch the domain by hand"],
  [/^the portal is not ready/, "the portal has to be deployed before a site can sit behind it: ask the owner, or remove `portal` from sitesolide.json"],
  [/^interrupted by /, "the run was interrupted between two steps: run the same command again"],

  // --- secrets: never in the repository
  [/^build secrets missing: /, BUILD_SECRET_MISSING],
  [/^the build secrets file does not read: /, BUILD_SECRETS_UNREADABLE],
  [/ is being deployed.*: wait for its deployment to end/, "a deployment of this name is under way, and nothing was sent: wait for it to end, then run `sitesolide deploy` again once; never retry in a loop, and never take the name back with --adopt unless the owner asked for it"],
  [/^the tokens' claims on .* do not read on the server/, "the steward's record of the names tokens hold does not read, and nothing was sent: tell the owner of the machine, who restores the file the message names from the steward's backups and never deletes it; only the owner decides to deploy all the same with `sitesolide deploy --adopt`"],
  [/ is held by .*: sitesolide deploy --adopt takes the name back/, "a token holds this name, and nothing was sent: pick another slug in sitesolide.json, or ask the owner, who alone decides to take the name back with `sitesolide deploy --adopt`; never add --adopt on your own, it drops the token's hold"],
  [/ could not be taken back from /, "the name stays the token's, and nothing was sent: busy means its deployment runs, or the project is on the machine now, so wait and run `sitesolide deploy` again once; otherwise tell the owner of the machine, with the message"],
  [/^the store of secrets cannot be laid: /, STORE_REFUSED],
  [/store of secrets cannot be laid, which its units load/, STORE_REFUSED],
  [/^cannot tell whether the store's folders of /, READ_FAILED],
  [/could not load its secret files \(243\/CREDENTIALS\)/, CREDENTIALS_FAILED],
  [/is a static site: no service reads a store/, "a static site keeps no secret on the server: a value its build needs is named under secrets.build in sitesolide.json, and the user exports it, or keeps it in ~/.config/sitesolide/secrets/<slug>.env; never put the value in the repository"],
  [/keeps its password hash in .*\.env, read by its own unit/, "the dashboard's and the portal's password is changed with Change password, in the dashboard, by the owner; there is nothing to run here"],
  [/^secrets are managed in the Secrets section/, "the dashboard and the portal keep their password hash in a file of their own: the owner changes it with Change password, in the dashboard at the address in the message; there is nothing to run here"],
  [/^a service is restarted from the dashboard/, "the owner restarts it with Restart service, in the project's Overview on the dashboard at the address in the message; there is nothing to run here, and never a systemctl restart by hand over SSH"],
  [/^usage: sitesolide run/, "pass the command after a double dash: sitesolide run -- <command>"],
  [/^missing from the vault/, "only the owner can put that file in the workstation's vault, at the path in the message; never write a secret yourself"],
  [/^the vault's file does not read: /, "the user fixes the line the message names in that file, one KEY=value per line; never read, print or rewrite the file yourself: it holds credentials"],
  [/^run: .* is not on the PATH/, "name the command as a shell would find it, or by its absolute path, after the double dash"],

  // --- after the push
  [/^install failed/, "read the `output` events just before this error: install runs as the project's account, in the walls `details` describe; run the command in the project folder to reproduce it, move a step that writes outside app/ into build, then deploy again"],
  [/^write refused/, "the server refused a write over SSH: check that the deployment account still has sudo, then run the same command again"],
  [/should answer the portal's 401/, "the site answers anyone although sitesolide.json says Restricted: tell the owner at once, and deploy nothing else until it is fixed"],
  [/answered 404: nothing is served at the site's root/, "make / answer 200: an app without `routes` receives / and must answer it; with `routes`, or for a static site, put an index.html in publicDir (docs/manifest.md, under start); a redirect does not count either; then deploy again"],
  [/unreachable: /, "the deployment is installed but the address did not answer: read `sitesolide logs --json`, then `sitesolide status --json`, and fix the service before deploying again"],
  [/^unexpected response: /, "the service answers with an error after the deployment: read `sitesolide logs --json` to find why, fix the code, then deploy again"],
  [/^a service fell after its restart/, "the new code is in place and a service stopped or was restarted by systemd within seconds: read `sitesolide logs --json` to find why, fix the code or what it needs (a secret, a variable, a service it calls), then deploy again"],
  [/^failed \([0-9]+\): /, "read the `output` events just before this error, they carry the failing command's own message; fix that cause, then run the same command again"],

  // --- domains and removal: the owner's decisions
  [/^no domain declared in the manifest/, "declare the owner's domain first in sitesolide.json: \"domain\": { \"name\": \"example.com\", \"active\": false }"],
  [/does not resolve to /, "point the domain's DNS record at the server, wait for it to propagate, then run this again; --force only on the owner's explicit decision"],
  [/^removal needs the slug typed back/, "re-run with --confirm <slug>, and only if the owner asked for this project to be removed: what it wrote since the last backup is lost for good"],

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
 * refusal carries: the API's own (docs/access.md), the installer's for a
 * deployment that failed on the machine, and the CLI's for what it refuses
 * before a request leaves. Their messages are worded on the machine, where no
 * pattern of HINTS reads them; a code this table lacks falls back to them.
 * `share` and `people` report by code whichever way they run, over the
 * owner's SSH too: bin/tests/cli-hints.test.ts fails on a code of
 * bin/cli/access.ts this table lacks, and on one of bin/cli/remote.ts, whose
 * `secrets` and `restart` add their own. So does `machine`, which talks to a cloud provider's API rather
 * than to the dashboard: bin/tests/cli-machine.test.ts fails on a code of
 * bin/cli/machine.ts or bin/cli/providers/ this table lacks.
 */
export const REMOTE_HINTS: Readonly<Record<string, string>> = {
  // --- refused before a request leaves
  "no-dry-run": "review sitesolide.json with the user, then run `sitesolide deploy` without --dry-run once they agree: the machine judges the manifest before anything is built or uploaded",
  "unknown-option": "run the command without that option; `details` lists the ones it takes with a token",
  "needs-ssh": "this command is the owner's: ask the owner of the machine to run it; with a token, only deploy, status, logs, share, secrets, restart and login run",
  "value-in-arguments":
    "never put a secret's value on a command line: the user runs `sitesolide secrets set NAME` in their terminal and types it at the prompt; a value you generate yourself, a random key, you may pipe to `sitesolide secrets set NAME --stdin`; never a value read from the conversation; if a real value was on that line, tell the user to change it at its source",
  "needs-stdin":
    "nothing prompts here: ask the user to run `sitesolide secrets set NAME` in their own terminal and type the value; a value you generate yourself, a random key, you may pipe to `sitesolide secrets set NAME --stdin`; never a value read from the conversation",
  "stdin-is-terminal":
    "standard input is a terminal, where a value would show as it is typed: a value you generate yourself, a random key, you pipe to `sitesolide secrets set NAME --stdin`; otherwise the user runs `sitesolide secrets set NAME` without --stdin in their own terminal and types the value at the prompt, which does not echo it; never a value read from the conversation",
  "looks-like-value":
    "what stands where the variable's name goes looks like a secret's value: if it was one, tell the user it may now be in the shell's history and has to be changed at its source; then run `sitesolide secrets set NAME` with the variable's real name, the user typing the value at the prompt, or a value you generate yourself piped to --stdin; never a value read from the conversation; a variable really named so is set by the user from the dashboard's Secrets section",
  cancelled: "nothing was sent: run the same command again once the value is at hand",
  usage: "run one of the commands `details` lists",
  // --- the control API
  unauthenticated: "the token is missing, unknown, expired or revoked: ask the owner of the machine for one, then run `sitesolide login`; never guess a token or borrow another one",
  "too-many-attempts": "wait the seconds `details` names, then run the same command once; never retry in a loop",
  "out-of-scope": "this may not be done by whoever asks: change what the message names (in sitesolide.json for a deployment, in the command for access), or ask the owner of the machine, who may widen the token or do it themselves; never pick another slug, role or token to get around it, nor another file for a secret",
  reserved:
    "the slug belongs to the platform, or a removed project left its backups or a connector's grant under it: pick another one in sitesolide.json; only the owner of the machine frees such a name, never a token",
  "invalid-manifest": "fix every point of `details` in sitesolide.json (docs/manifest.md), then deploy again",
  invalid: "fix what the message names, then run the same command again",
  "not-found": "nothing by that name: check the slug in sitesolide.json, and the address or @domain in the command (`sitesolide share` lists who has access); with a token, `sitesolide status` lists the projects it reaches",
  busy: "a deployment of this project is already running, the token's previous restart is still under way, or the machine is busy with other changes: wait for it to finish, then run the same command again once; never retry in a loop",
  unmanaged:
    "the file on the machine was written by hand, in a form the dashboard does not rewrite, and nothing was changed: tell the owner of the machine, who fixes it from the dashboard's Secrets section; never work around it",
  "restart-failed":
    "the service did not hold after its restart: read `sitesolide logs --json` to see why, fix the cause, a value the user sets again with `sitesolide secrets set NAME` or the code deployed again, then run `sitesolide restart` once; a change of secrets made with it is already written; never restart in a loop",
  "too-large": "exclude dependencies, caches and build leftovers in sitesolide.json: the machine installs the dependencies itself",
  expired: "the archive arrived too late: run `sitesolide deploy` again",
  "not-available": "the machine does not carry what this needs yet, the control API, the access registry or the store of secrets by token: tell the owner of the machine, with the message, which names what to update; nothing more can be done from here until then",
  failure: "something broke on the machine: tell the owner of the machine, with the message; do not retry in a loop",
  unreachable: "the dashboard did not answer: check the network and the address (`sitesolide login --url`), then run the same command again",
  unconfirmed:
    "the change was sent and its answer never came, so it may be written: run `sitesolide secrets --json` to read the store's names, then run the same set or remove once more, which is harmless; never retry in a loop; if the dashboard stays unreachable, check the network and the address (`sitesolide login --url`)",
  unreadable: "the address answered with something that is not the control API: check it with `sitesolide login --url https://dashboard.<zone>`",
  // --- access, with a token or over the owner's SSH
  "ssh-failed": "a command over SSH failed, nothing was changed: run the same command again; if it fails twice, check that `ssh <server> true` connects without a prompt (load the key with ssh-add)",
  "steward-outdated": "the steward on the machine predates what this command needs, people with access or the store of secrets: run `sitesolide upgrade` from this workstation, then the same command again",
  // --- the store of secrets, see bin/cli/store-cli.ts
  "build-secret-missing": BUILD_SECRET_MISSING,
  "build-secrets-unreadable": BUILD_SECRETS_UNREADABLE,
  "store-refused": STORE_REFUSED,
  "store-failed":
    "the machine could not lay the project's store of secrets, which its units load: tell the owner of the machine, with the message; nothing was served; never create anything on the machine by hand, nor deploy again in a loop",
  "store-not-yours":
    "the project's store was not made by this token's own write: a token's creation never takes another's store; do not retry, tell the owner of the machine",
  "taken-meanwhile": "the project was deployed on the machine after this creation was accepted; pick another slug, or ask the owner",
  "store-unmanaged":
    "the project's store on the machine is in a state the steward does not rewrite, and nothing was changed: tell the owner of the machine, with the message; never work around it",
  "already-present":
    "the name already has a value: leave it, or, only if the user asks for a new one, they run `sitesolide secrets generate NAME --replace` themselves, which stops the old value working at the next restart",
  locked: "this change needs the dashboard's unlock: make it from the dashboard, or over the owner's SSH",
  migrating: "the machine is carrying access over to its registry: run the same command again in a minute; if it lasts, tell the owner of the machine, who reads the steward's log",
  "too-many-changes": "too many changes of access this hour: wait, then run the same command again; never retry in a loop",
  "log-full": "the access log is full of recent changes, which are kept 180 days: nobody more is let in until older ones age out, while removing and lowering still work; the owner may still change access from their workstation, with sitesolide share",
  conflict: "the access registry is already made: there is nothing left to carry over",
  "no-portal": "the project is not restricted: its general access is the dashboard's Access section",
  // --- a deployment that failed on the machine
  "install-failed": "run the install command from the message in the project folder, fix what it reports, then deploy again",
  "edited-by-hand": "do not re-run with --force, a token has none: tell the owner of the machine, who reads the file and decides",
  "system-unit": "pick another slug in sitesolide.json: this one names a service of the machine",
  "caddy-busy": LOCK_BUSY,
  "access-changed": "the project's general access changed from the dashboard while the deployment ran: deploy again",
  // The same, as an installer from before the rename names it.
  "door-changed": "the project's general access changed from the dashboard while the deployment ran: deploy again",
  "port-taken": "delete `port` from sitesolide.json and let the machine choose one, or pick a free one between 3000 and 3099",
  "domain-taken": "a domain name belongs to one project: take it out of this sitesolide.json, or ask the owner to take it out of the project that declares it",
  "no-port": "the owner has to free a port by removing a project the machine no longer needs",
  "bundle-refused": "replace symbolic links and special files with the files they point to, or exclude them in sitesolide.json, then deploy again",
  "public-empty": "make the build produce the site in publicDir: an empty folder would wipe the live one",
  "portal-not-ready": "the portal has to be deployed first: tell the owner of the machine",
  "service-failed": "read `sitesolide logs --json` to see why the service did not start, fix the code, then deploy again",
  "verify-failed": "a 404 means nothing answers at /: make it answer 200, from the app, which receives / unless the manifest has routes, or from an index.html in publicDir (docs/manifest.md, under start); otherwise read `sitesolide logs --json`; a site declared Restricted that answers anyone must be reported to the owner of the machine at once",
  "machine-unreadable": "the machine could not be read, nothing was changed: deploy again in a minute, then tell the owner of the machine if it persists",
  // --- `machine`: a VM ordered from a cloud provider's API, see bin/cli/machine.ts
  "machine-usage": "run one of the commands `details` lists: sitesolide machine create, list or destroy, each with --provider",
  "machine-option": "run the command again without that option, with the options `details` lists; a credential is never an option, only an environment variable, the provider's own CLI signed in, or --token-stdin",
  "unknown-provider": "pass --provider with one of the names `details` lists; `sitesolide machine providers` says which have credentials on this workstation",
  "machine-name": "name the machine with lowercase letters, digits and dashes, 63 characters at most, starting and ending with a letter or a digit",
  "no-provider-token": "the owner creates credentials as `details` says, then sets the variables the message names, signs in with the provider's own CLI, or pipes them to --token-stdin; never put a credential in a command line, a file of the repository or a message, and never guess or borrow one",
  "provider-endpoint": "unset the SITESOLIDE_<PROVIDER>_API variable the message names: it only serves tests, and credentials only leave over https, or over http to the loopback",
  "no-ssh-key": "pass --ssh-key with the path of a public key, the .pub file; if this workstation has none, its owner creates one with ssh-keygen -t ed25519; never pass a private key",
  "invalid-server-type": "pick one of the types `details` lists, sold at that location, and pass it with --type; the cheapest come first",
  "invalid-location": "pick one of the locations `details` lists and pass it with --location",
  "type-unavailable": "the provider would not sell that type there right now: run the same command with one of the types `details` lists as --type, or with another --location; `details` also says what this run had created, deleted again or left for the next run to reuse",
  "machine-exists": "pick another --name: a machine of that name exists in the account and sitesolide did not create it; never delete or rename it to make room",
  "firewall-taken": "pick another --name: a firewall of that name exists and sitesolide did not create it; never delete or rename it to make room",
  "machine-not-found": "check the name with `sitesolide machine list --provider <provider>`: nothing was destroyed",
  "machine-not-managed": "sitesolide only destroys the machines it created: if this one has to go, its owner deletes it from the provider's console",
  "confirm-mismatch": "pass --confirm with the machine's exact name, and only if the owner asked for this machine to be destroyed: every site it serves goes with it",
  "needs-confirm": "re-run with --confirm <name>, and only if the owner asked for this machine to be destroyed: its disk and the provider's backups of it go for good",
  "machine-timeout": "the provider is still working on it: run the same command again in a few minutes, it picks the machine up where it stands; `sitesolide machine list --provider <provider>` shows its status",
  "machine-off": "the machine exists but is powered off: its owner powers it on from the provider's console, then runs the same command again",
  "ssh-timeout": "the machine runs but port 22 did not answer yet: run the same create command again in a minute, it resumes at this wait; if it persists, look at the machine's console at the provider",
  "host-key-changed": "the address belonged to another machine before: if this machine was just created, remove the old key with the ssh-keygen -R command `details` gives, then run the same command again; if not, stop and tell the owner, something else answers there",
  "login-timeout": "port 22 answers but the machine did not let its account in with the key: check that the key is loaded (ssh-add -l lists it) or has no passphrase, then run the same create command again, which resumes at this wait; a host key warning means the address was someone else's before: remove its line from ~/.ssh/known_hosts",
  "action-failed": "the provider says why in `message`: fix what it names, or run the same command again if it says to retry; the provider's console shows the project as it stands",
  "provider-unauthenticated": "the provider refused the credentials: the owner makes new ones as the provider's page in docs/providers/ says, then sets their variables or pipes them to --token-stdin; never guess or borrow credentials",
  "provider-forbidden": "the credentials may read but not change, or lack a permission the message names: the owner grants it as the provider's page in docs/providers/ says, then runs the same command again",
  "provider-limit": "the provider's account reached one of its limits or quotas: its owner removes what it no longer needs, or asks the provider to raise the limit",
  "provider-name-taken": "a resource of that name already exists at the provider: pick another --name, or run `sitesolide machine list --provider <provider>` to see the machines sitesolide created",
  "provider-busy": "the resource was busy or changed during the request: run the same command again in a minute",
  "provider-unavailable": "the provider cannot do it at that location right now: pick another --type or --location, or run the same command again later",
  "provider-invalid": "the provider refused the request: fix what `message` and `details` name, then run the same command again",
  "provider-rate-limited": "wait the seconds `details` names, then run the same command once; never retry in a loop",
  "provider-failure": "the provider failed on its side: run the same command again in a few minutes, it resumes where it stopped; the provider's status page says whether it is down",
  "provider-unreachable": "the provider's API did not answer: check this workstation's network, then run the same command again",
  "provider-unreadable": "the address answered with something that is not the provider's API: unset the SITESOLIDE_<PROVIDER>_API variable, which only serves tests",
  "provider-not-found": "a resource disappeared during the run: run `sitesolide machine list --provider <provider>`, then the same command again",
  "no-default-vpc": "the region has no default VPC, or it has no default subnet: the owner creates them in the AWS console (VPC, Your VPCs, Actions, Create default VPC), then runs the same command again, or picks another --location; never create network resources in the account yourself",
  "no-default-network": "the project or region has no default network for the machine: its owner creates one as `details` says, or picks another --location or project, then runs the same command again; never create or change a network yourself",
  "provider-api-disabled": "the provider's API is not enabled for the account or project the message names: its owner enables it as `details` says, waits a few minutes, then runs the same command again; never enable it with other credentials",
  "invalid-image": "pass --image debian-13, the default, or an image of that location with the type's architecture; sitesolide setup is only verified on Debian 13",
  "machine-ambiguous": "several machines sitesolide created carry that name: nothing was changed; the owner removes the extra one from the provider's console; never pick one yourself",
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
