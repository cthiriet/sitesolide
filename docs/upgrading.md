# Upgrading a running installation

## The operator's path: `sitesolide upgrade`

From 0.3 on, bringing a machine to a new release is two commands, run from the
workstation by the person who owns the machine. Read the notes of every
release in between first: a release that asks for more than this says so
below, under its own heading.

1. **The CLI.** Install the new binary, or `git pull` a checkout and run
   `bin/test.sh` there. Both read the same `~/.config/sitesolide/config.json`.

   ```bash
   curl -fsSL https://github.com/cthiriet/sitesolide/releases/latest/download/install.sh | sh
   ```

2. **What would change.** It reads the machine and changes nothing there:

   ```bash
   sitesolide upgrade --dry-run
   ```

   Every component is listed `up to date`, `out of date` with what differs and
   what would run, or `missing`. A component is out of date when what this
   release would install differs from what is installed, measured on both
   sides, never assumed from version numbers.

3. **The upgrade.** It redeploys the components found out of date, and only
   those, one after the other:

   ```bash
   sitesolide upgrade
   ```

   Run it again afterwards: every component reads `up to date`, and nothing
   changes on the machine. Another installation is upgraded with
   `SITESOLIDE_CONFIG_DIR=<dir>` before the command, as for every command.

Upgrade the CLI when traffic is lowest: a dashboard, a portal or a Caddyfile
redeployed reloads Caddy, which resets the connections being opened at that
instant, for about a tenth of a second; a new drop-in restarts it.

### What it compares, and what it runs

Each component is checked first, reading only, then redeployed only if the
check found a difference, through the very script or `sitesolide deploy` that
`sitesolide setup` runs for it. The check is what setup checks for the
component (active, enabled, its files present), plus:

| Component | Out of date when | Redeployed by |
|---|---|---|
| Caddy's drop-in | `override.conf` differs from the release's | setup's own step: the drop-in installed, `daemon-reload`, `systemctl restart caddy` |
| backups | `backup.js` or one of its three units differs | `bin/deploy-backup.sh install`; the timer stays as it is |
| egress proxy | `egress.js` or its unit differs | `bin/deploy-egress.sh` |
| steward | `steward.js`, its unit or the portal relay's two units differ, or it started before the egress proxy's unit was last laid, or before the backups' folder existed | `bin/deploy-steward.sh` |
| dashboard | `sitesolide deploy --dry-run --compare` finds a difference: a file to send or delete, its manifest, a missing unit, its Caddy block | `sitesolide deploy` in `dashboard/` |
| collector | one of its two units differs | `bin/deploy-collector.sh` |
| gatekeeper | `gatekeeper.js` or one of its templates differs, or the single template from before is still there | `bin/deploy-gatekeeper.sh` |
| installer | `installer.js`, its template or its environment file differs | `bin/deploy-installer.sh` |
| the Caddyfile | `/etc/caddy/Caddyfile` differs from the release's | `bin/deploy-caddy.sh`, which validates, reloads, verifies and restores on failure |
| shared service | the release in service differs from `api/`, file by file, or its unit does | `bin/deploy-api.sh` |
| portal | as the dashboard | `sitesolide deploy` in `portal/` |
| monitor | `monitor.js`, its unit or its timer differs | `bin/deploy-monitor.sh` |

A component built by its script, the steward or the monitor for instance, is
measured by the script itself: `--fingerprint` builds it exactly as it would to
install it and prints the SHA-256 of every file it would lay, which the check
compares with `sha256sum` on the machine, the measure the script verifies after
installing. The same sources built by the same Bun give the same bytes; a
binary and a checkout built with another Bun may differ, and then upgrade
redeploys what they build, once.

The order is the one this page has always given: the backup install before the
steward, whose unit opens the backups' folder only if it exists when the
steward starts; the egress proxy before the steward too, which starts again
after it so that it may write the connectors' folder; the root components that
only listen before the dashboard, which they accept old and new; the collector,
the gatekeeper and the installer after the dashboard; the Caddyfile, the shared
service, the portal and the monitor last.

### What it never does

- **Install a component.** One the machine does not carry is reported
  `missing`, and left alone: `sitesolide setup`, run again for that machine,
  installs it, the backups, the installer and the egress proxy of a
  machine set up with `--minimal` for instance.
- **Touch a secret.** No file of `/etc/sitesolide` is read, no password is drawn
  nor rotated: those are setup's first install and the dashboard's.
- **Force.** A unit or a Caddy block someone edited on the machine stays as
  `sitesolide deploy` leaves it: a unit is reported and kept, a block stops the
  component with the differing lines. `sitesolide deploy --force` in that
  component's folder of a checkout replaces it, on your decision.
- **Stop or start Caddy** but through `bin/deploy-caddy.sh` and `systemctl`;
  never `caddy stop` nor `caddy start`.

### When it stops

A failure stops at its component and says which, the end of what its script
printed, and the command that shows more, such as
`ssh deploy@203.0.113.10 'sudo journalctl -u sitesolide-steward -n 50'`. The
components before it are upgraded, the ones after it untouched. Fix the cause,
then run `sitesolide upgrade` again: the components already up to date are
skipped, and it resumes at the one that failed.

### What stays by hand

- **Each site.** A site is redeployed by `sitesolide deploy` in its folder,
  when you next deploy it; upgrade only brings the platform's own components.
- **The loopback rule.** Setup lays it; a release that changes it says so in
  its notes, and `bin/deploy-loopback.sh close` lays it again, from a checkout
  or from the kit the binary unpacked into `~/.cache/sitesolide/<version>-<hash>/`.
  It changes what every service may reach, and keeps its own safety net.

A machine upgrades one release at a time: from 0.1, follow
[From 0.1 to 0.2](#from-01-to-02) first, then [From 0.2 to 0.3](#from-02-to-03),
then `sitesolide upgrade` for every release after, reading the notes below
for each, [Access: one registry](#access-one-registry) first.

## Access: one registry

Who may do what on a project now lives in one place, the steward's access
registry, and the portal reads a projection of it. `sitesolide upgrade` is
all it takes; read this first, for what changes for the sites and for you.

**Before you run it.**

- **An app that reads `X-Sitesolide-Role`** must be updated, and deployed,
  before the portal is: the header now carries the role, `admin` for the
  owner's password and the admin emails, `visitor`, `viewer`, `developer` or
  `admin` for someone signed in with a company account, `visitor` for password
  access, which carries no `X-Sitesolide-User`. Its old values, `member` and
  `guest`, are gone. An app that let `guest` read only now tests
  `role === "visitor" && user === null`, or better, the role it means.
- **Everyone with a role above Can open on a project opens its site** when it
  is restricted: a Developer of a restricted site no longer needs Can open
  besides. Read each restricted site's people with access afterwards,
  `sitesolide share` in its folder.
- `sitesolide members` is gone: `sitesolide share <email> --role <role>`
  from a project's folder gives a role, `sitesolide people` lists everyone and
  `sitesolide people <email> --may-create` gives the right to create projects.
  `sitesolide share --domain` and `--only-admins` are gone too: a domain is
  written `@acme.com`, and general access, public or restricted, is the
  dashboard's.

**What changes in the dashboard.**

- **One place per question.** In a site, one *Access* section replaces its
  *Access*, *Sharing*, *Guests* and *Members*: its general access first,
  Public, Restricted or Anyone with the code, then its people with access,
  each with a role, and *Add people*. At the machine level, *People*, the
  owner's, replaces *Members*: everyone across projects, their roles, who may
  create projects, the domains; *Tokens* replaces *Team*, each token saying
  who made it. The old addresses, bookmarks included, lead to the new pages.
- **Password access waits for the unlock** when it is given from the
  dashboard, as a role above Can open does: the owner's password, or an
  Admin's forced sign-in, since it lets in someone from outside the company.
  So does a whole domain while `OIDC_ALLOWED_DOMAINS` is empty. Can open for
  a company account or one of the listed domains, lowering and removing still
  never wait, nor does restricting a site, and the owner's `sitesolide share`
  over SSH asks for nothing.
- **Someone who can only open sites is told so** when they try the dashboard,
  `can-open-only`, apart from someone on no list, `no-role`.
- **Activity** lists a change of general access as `access.general`, where it
  said `door.update`: a filter or an export that looked for the old name looks
  for the new one, or for `access.` to find every change of access. The rows
  written before the registry still read, in today's words.
- **Changes of access are kept 180 days, and bounded.** The steward writes
  every accepted change of access to a file of its own, `access-log.jsonl`
  beside its journal, seeded from the journal and topped up at each start
  with what it lacks; refusals stay in the journal. Its rows are never pushed
  out before 180 days: once it holds 20,000 of them, or 12 MB, a change that
  lets more people in is refused, `log-full`, until older ones age out, while
  removing and lowering still work, and you still change access from your
  workstation with `sitesolide share` and `sitesolide people`. Such changes
  are also counted, 120 an hour for each person, each token and you in the
  dashboard, 2,000 for you over SSH, `too-many-changes` past it.
- **Every token from before becomes someone's**, once, at the steward's first
  start. A token whose email, what you typed when creating it and shown as
  its label, is the address of a person who signs in to the dashboard, a role
  above Can open or the create right, becomes that person's, made by you: it
  is narrowed to their roles from then on, and revoked when they leave,
  removed or lowered so that they keep no role above Can open and no create
  right. Every other token becomes your own, its scope unchanged. To keep a
  shared CI token yours when its email is a person's: after upgrading, on the
  *Tokens* page, make a token with *Whose token* set to *Mine* and the same
  projects, put it in the CI, then revoke the one that became the person's.

**What `sitesolide upgrade` runs, in this order.**

1. **The steward.** At its first start it makes the registry, once, from
   `members.json` and the portal's database, then writes the portal's
   projection: [migration.md](migration.md#access-the-registry-made-from-the-stores-before-it)
   says what it carries over, what it sets aside and why. The running portal,
   the old one, keeps deciding from its own tables, which still say the same.
   `bin/deploy-steward.sh` ends on `access registry 600 root:root, its
   projection for the portal 640 root:site-portal`. A store that does not
   read leaves no registry, and is tried again later; when it is the portal's
   database, a table past 16 MB (`oversized-table`) among others, `sitesolide
   people --migrate-without-portal` carries the rest over without it, and the
   tokens are made someone's at once.
2. **The dashboard.** Its access API speaks to the steward, and its pages
   are the ones above: a site's Access, People and Tokens.
3. **The installer**, which reads the registry when it starts.
4. **The portal**, last: from its first request it decides from the
   projection, and leaves the mark that keeps it from ever reading its old
   tables again.

Run them together, as `sitesolide upgrade` does: a change of access made in
the old dashboard between the steward's step and the dashboard's would go to
the portal's old tables, which nothing reads any more.

**Check.**

```bash
sitesolide people
cd <a restricted project> && sitesolide share
ssh deploy@203.0.113.10 'sudo curl -s http://127.0.0.1:3026/admin/access'
```

`people` lists everyone with their roles; `share` lists the site's people
with access and says nothing of the portal; the portal answers `"reading":
"steward"`. A password the portal handed out before the upgrade still opens
its site, as password access, and a cookie set before it is still valid. In
the dashboard, a site's *Access* lists the same people as `share`, and
*People* the same as `people`.

**Going back** is the previous commit of the steward, the dashboard, the
installer and the portal, which read the old stores as they stood at the
migration: every change of access made since is lost for them. See
[migration.md](migration.md#going-back).

**Deleting `access.json` is no way to start over.** The steward makes it
again at the next request from the old stores, as they stood at the
migration, so every change of access made since is gone; within the next 30
seconds its sweep revokes the live tokens of everyone the rebuilt registry
gives no rights. A deletion made by mistake is undone by putting back a copy
of the file, root `0600`:
`ssh deploy@203.0.113.10 'sudo install -m 600 -o root -g root <copy> /var/lib/sitesolide-steward/access.json'`.
Everyone's roles and access come back with it; the changes made to the
rebuilt registry in between are lost, and the tokens the sweep revoked stay
revoked, to be minted again. The machine's backups do not hold the steward's
state: make that copy yourself, `sudo cp -p` of the file, before you edit it
by hand.

## From 0.2 to 0.3

0.3 changes how you install and drive sitesolide, not what runs on the
machine. Nothing there needs to be redeployed, and no site reloads.

1. **The CLI.** Install the binary, or keep a checkout and `git pull`: both
   read the same `~/.config/sitesolide/config.json`.

   ```bash
   curl -fsSL https://github.com/cthiriet/sitesolide/releases/latest/download/install.sh | sh
   ```

   From a checkout, `bin/test.sh` first, as always. The binary deploys
   `dashboard/` and `portal/` from the copies it carries, built at release
   time; a checkout builds them as before.
2. **Terraform is gone.** Your machine, its firewall, its DNS records and its
   Hetzner backups stay exactly as they are. `~/.config/sitesolide/terraform/`
   is no longer read: copy its two tokens into your password manager, then
   keep the folder as a record or delete it. **Never run `terraform apply` or
   `terraform destroy` against that state from a 0.3 checkout**: with the
   `.tf` files gone, Terraform plans the destruction of everything it created,
   the server first. Whoever wants Terraform to keep managing the machine keeps
   a 0.2 checkout for it.
3. **`sitesolide setup` on this machine.** It recognises a machine it did not
   install (no `setup.json` beside your configuration) and only reads it: it
   reports when every step is done and refuses otherwise, changing nothing.
   `--dry-run` shows what it finds:

   ```bash
   sitesolide setup deploy@203.0.113.10 --zone example.com --email you@example.com --dry-run
   ```
4. **`sitesolide upgrade --dry-run`**, then `sitesolide upgrade`, as
   [above](#the-operators-path-sitesolide-upgrade): a binary builds the
   components with its own Bun, and may find some of them to redeploy.

New machines are made with `sitesolide machine create` and `sitesolide setup`:
see [install.md](install.md).

## From 0.1 to 0.2

How to bring a machine that runs 0.1 to 0.2 without any site going down, from
a 0.2 checkout: `sitesolide upgrade` came later, and this jump also asks for
gestures it never makes, a portal deployed with `--force` and components
installed for the first time. Every command runs from the workstation, by the
person who owns the machine, in this order. Each step works without the next, so the upgrade can stop anywhere and
resume another day; each one says what to check and how to go back.

This order was rehearsed on a test machine installed from 0.1 and serving the
landing, a static site, an app, a restricted site and analytics, with a
probe opening a fresh connection to every site every second throughout. No
request failed because of the upgrade itself. Every Caddy reload, though,
resets the connections that are being opened at that instant, for about a
tenth of a second: that is how Caddy behaves on every deploy, in 0.1 as in 0.2.
Steps 3, 4 and 6 each reload Caddy, as does switching a site between public and restricted; in the
rehearsal one reload out of ten fell on the probe and reset that second's
requests. Upgrade when traffic is lowest.

The components each have a longer section of their own, linked at each step,
with every check and every rollback in detail. This page is the order.

### What 0.2 changes for you before you touch the machine

The CLI is stricter, and some deployments that passed in 0.1 are refused or
behave differently. `bin/test.sh` validates every manifest of this repository
and of your sites repository against the new rules: run it first, and fix any
manifest it refuses before deploying anything.

| In 0.1 | In 0.2 |
|---|---|
| any valid slug | `caddy`, `ssh`, `cron`, `www`, every `systemd-*` and `sitesolide-*`, and any name systemd already gives to a unit deploy did not write, are refused |
| a header value could hold anything but a newline | no `{`, `}`, `$`, `"`, `\` or backtick: Caddy read `{$VAR}` and `{env.VAR}` there, which handed its environment to whoever wrote the manifest |
| an `env` value could hold spaces | refused: systemd split it into extra assignments |
| a `start` could begin with `+` or `!` | refused: systemd ran it as root |
| `install` ran as the deployment account, with sudo | it runs as `site-<slug>`, in a transient unit with its service's walls, the network but not the loopback, only `app/` writable |
| `deploy --dry-run` ran the build | it shows the build and does not run it; `--dry-run --build` runs it |
| `.git` and `.env` files left with the code | they never leave, at any depth, and Caddy answers 404 for any an earlier deploy left in `public/` |
| ports checked before the build | checked again under the Caddy lock; 3022, 3026 and 3029 belong to the dashboard, the portal and analytics alone |
| `source` could lead anywhere | outside your `sites` repository, only inside the manifest's own repository |

The whole list, and why each changed: [commands.md](commands.md#upgrading-to-the-hardened-deploy)
and [dashboard/README.md](../dashboard/README.md#upgrading-the-manifests-strings-egress-the-deployment-cap).

### 0. On the workstation

```bash
git pull
bin/test.sh
```

Every test passes, the manifests of your sites repository included. Check that
`~/.config/sitesolide/config.json` names your sites repository under `sites`.
If it names a folder that holds no project with a `package.json`, three tests
fail for want of a project to read (`no folder of the sites repository is
forgotten`, `at least one application site is covered`, and the one that reads
the sites repository's manifests): that is the folder, not your manifests.

### 1. Caddy's restart policy

The drop-in gains `Restart=always`: a Caddy stopped through its admin API
comes back in two seconds instead of staying down. Applying it needs a
`daemon-reload` and no restart.

```bash
ssh you@machine 'sudo install -m 644 /dev/stdin /etc/systemd/system/caddy.service.d/override.conf && sudo systemctl daemon-reload' < infra/caddy/caddy.service.d/override.conf
ssh you@machine 'systemctl show caddy -p Restart -p StartLimitIntervalUSec -p MainPID'
```

Check: `Restart=always`, `StartLimitIntervalUSec=0`, and the same `MainPID` as
before the command. Back: install the previous file, `daemon-reload`.
Details: [infra/README.md](../infra/README.md#caddys-restart-policy).

### 2. The root components that only listen

They accept the old dashboard and the new one, and change nothing served.

```bash
bin/deploy-backup.sh install   # the backup component's folders and units; starts nothing
bin/deploy-steward.sh          # the new routes: tokens, backups, connectors, the new secret files
```

The backup install comes first because the steward's unit makes its state
folder writable only if it exists when the steward starts. Check: the
steward's script verifies itself; the dashboard still shows every site's
secrets. Back: the same scripts from 0.1.

### 3. The dashboard, then the gatekeeper

```bash
cd dashboard && sitesolide deploy && cd ..
bin/deploy-gatekeeper.sh
```

The dashboard's block was written by 0.1's generator: `deploy` says "written by
an earlier release, the current one replaces it" and replaces it without
`--force`. Its `install` now runs as `site-dashboard`. This deploy also lays
0.2's Caddyfile: `sitesolide deploy` installs a block through
`bin/deploy-caddy.sh`, which deposits the repository's Caddyfile with it. Its
file servers start hiding `.git` and `.env*` here, and the landing starts
taking the identity headers off what visitors send. The gatekeeper embeds
the block generator: it comes right after, so that switching a site between
public and restricted from the dashboard writes the current blocks. Check: the
new pages, for tokens and connectors, and sections, *Backups* among them,
appear and say what is not installed yet; with the dashboard unlocked, making
a test site public, then restricted again, still works. Pick a site whose `/`
answers 200 without the portal: the
gatekeeper restores the previous block when the open site answers 404, as
analytics does, which is a correct refusal and no sign of trouble. Back:
deploy the previous `dashboard/`, run the previous gatekeeper script; the new
tables of `dashboard.db` stay, unread.

### 4. The Caddyfile and the portal

```bash
bin/deploy-caddy.sh
cd portal && sitesolide deploy --force && cd ..
```

`bin/deploy-caddy.sh` answers `nothing to do` when step 3 already laid the
Caddyfile; it is here for a machine where the dashboard was deployed some
other way. The portal needs `--force`: its unit gains outbound network, to
reach a sign-in provider, and its block gains the sign-in routes. Run
`cd portal && sitesolide deploy` without `--force` first: it stops before
pushing anything and prints the divergence, cut short after five lines.
[portal/README.md](../portal/README.md#upgrading) lists what it must be. Then
run it with `--force`. Check: `curl -s -o /dev/null -w '%{http_code}\n' 'https://portal.<zone>/admin/sharing/..%2f..%2fsante'`
answers `400`; a protected site still opens with the cookie you already had; a
password access still opens its site.

### 5. What you choose to turn on

Each of these is independent and opt-in. None changes a site until you use it.

| To get | Run | Then | Details |
|---|---|---|---|
| alerts when something breaks | `bin/deploy-monitor.sh` | a healthchecks.io URL in the dashboard's *Secrets*, `dashboard-monitor.env` | [monitor/README.md](../monitor/README.md#deployment) |
| hourly backups of every project's data | `bin/deploy-backup.sh enable` | optional bucket in `dashboard-backup.env` | [dashboard/src/backup/README.md](../dashboard/src/backup/README.md#deployment) |
| sign-in with a company account | nothing more | the `OIDC_*` settings in the portal's `portal.env`, *Restart service* | [portal/README.md](../portal/README.md) |
| deploys by colleagues and agents with a token | `bin/deploy-installer.sh` | a token on the *Tokens* page | [dashboard/README.md](../dashboard/README.md#deployment-of-the-control-api) |
| people with access to a project, a role each: Can open, Viewer, Developer who sets secrets without reading them, Admin who looks after the project, each minting tokens of their own within their roles, and creating projects once you grant it | `sitesolide upgrade`, which brings the steward, its portal relay, the dashboard, the installer and the portal up to date | the sign-in with a company account above, then `sitesolide share <email> --role <role>` in a project's folder, and `sitesolide people <email> --may-create` for the right to create projects | [dashboard/README.md](../dashboard/README.md#access) |
| projects that reach only listed hosts, connectors | `bin/deploy-egress.sh`, then `bin/deploy-steward.sh` again: the steward started before `/etc/sitesolide-egress` existed, and only a restart makes it writable for it | `egress` or `connectors` in a manifest | [egress/README.md](../egress/README.md#deployment) |

### 6. Each site, when you next deploy it

Nothing forces a redeploy. When you next run `sitesolide deploy` in an app's
folder, its block is replaced without `--force` (a static site has no block,
and its redeploy changes nothing in Caddy): a file server gains the
hiding of `.git` and `.env*`, a protected site the identity headers, an open
site the removal of forged ones. Until a site is redeployed it keeps the
behaviour of 0.1, which includes an open app receiving whatever
`X-Sitesolide-*` header a visitor sends: an app that starts reading those
headers is redeployed before it trusts them.

### Going back to 0.1 entirely

Check out 0.1 and run steps 3 and 4 from it, then step 2. Sites already
redeployed with 0.2 keep working; their next deploy from 0.1 needs `--force`
once, since 0.1 does not know the newer blocks. Data written by the new
components (tokens, backups, audit rows) stays on the machine, unread.
