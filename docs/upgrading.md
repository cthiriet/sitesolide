# Upgrading a running installation

A machine upgrades one release at a time: from 0.1, follow
[From 0.1 to 0.2](#from-01-to-02) first, then [From 0.2 to 0.3](#from-02-to-03).

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

New machines are made with `sitesolide machine create` and `sitesolide setup`:
see [install.md](install.md).

## From 0.1 to 0.2

How to bring a machine that runs 0.1 to 0.2 without any site going down. Every
command runs from the workstation, by the person who owns the machine, in this
order. Each step works without the next, so the upgrade can stop anywhere and
resume another day; each one says what to check and how to go back.

This order was rehearsed on a test machine installed from 0.1 and serving the
landing, a static site, an app, a site behind the portal and analytics, with a
probe opening a fresh connection to every site every second throughout. No
request failed because of the upgrade itself. Every Caddy reload, though,
resets the connections that are being opened at that instant, for about a
tenth of a second: that is how Caddy behaves on every deploy, in 0.1 as in 0.2.
Steps 3, 4 and 6 each reload Caddy, as does turning a portal on or off; in the
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
bin/deploy-steward.sh          # the new routes: team tokens, backups, connectors, the new secret files
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
the block generator: it comes right after, so that turning a portal on or off
from the dashboard writes the current blocks. Check: the new pages (*Team*,
*Connectors*) and sections (*Sharing*, *Backups*) appear and say what is not
installed yet; with the dashboard unlocked, turning a test site's portal off and
on still works. Pick a site whose `/` answers 200 without the portal: the
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
guest still gets in.

### 5. What you choose to turn on

Each of these is independent and opt-in. None changes a site until you use it.

| To get | Run | Then | Details |
|---|---|---|---|
| alerts when something breaks | `bin/deploy-monitor.sh` | a healthchecks.io URL in the dashboard's *Secrets*, `dashboard-monitor.env` | [monitor/README.md](../monitor/README.md#deployment) |
| hourly backups of every project's data | `bin/deploy-backup.sh enable` | optional bucket in `dashboard-backup.env` | [dashboard/src/backup/README.md](../dashboard/src/backup/README.md#deployment) |
| sign-in with a company account, sharing | nothing more | the `OIDC_*` settings in the portal's `portal.env`, *Restart service* | [portal/README.md](../portal/README.md) |
| deploys by colleagues and agents with a token | `bin/deploy-installer.sh` | a token on the *Team* page | [dashboard/README.md](../dashboard/README.md#deployment-of-the-control-api) |
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
