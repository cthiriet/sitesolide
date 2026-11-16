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
| backups | `backup.js` or one of its three units differs, or restic, the repository or its key is missing | `bin/deploy-backup.sh install`; the timer stays as it is |
| egress proxy | `egress.js` or its unit differs | `bin/deploy-egress.sh` |
| steward | `steward.js`, its unit or the portal relay's two units differ, or it started before the backups' folder existed | `bin/deploy-steward.sh` |
| shared service | the release in service differs from `api/`, file by file, or its unit does | `bin/deploy-api.sh`, before the dashboard, whose deployment is the first to deposit the Caddyfile, whose certificates its ask endpoint allows |
| dashboard | `sitesolide deploy --dry-run --compare` finds a difference: a file to send or delete, its manifest, a missing unit, its Caddy block; every new release, whose version its page names | `sitesolide deploy` in `dashboard/` |
| collector | `collector.js`, its unit or its timer differs | `bin/deploy-collector.sh` |
| gatekeeper | `gatekeeper.js` or one of its templates differs | `bin/deploy-gatekeeper.sh` |
| installer | `installer.js`, its template or its environment file differs | `bin/deploy-installer.sh` |
| the Caddyfile | `/etc/caddy/Caddyfile` differs from the release's | `bin/deploy-caddy.sh`, which validates, reloads, verifies and restores on failure |
| portal | as the dashboard | `sitesolide deploy` in `portal/` |
| monitor | `monitor.js`, its unit or its timer differs | `bin/deploy-monitor.sh` |

A component built by its script, the steward, the collector or the monitor for instance, is
measured by the script itself: `--fingerprint` builds it exactly as it would to
install it and prints the SHA-256 of every file it would lay, which the check
compares with `sha256sum` on the machine, the measure the script verifies after
installing. The same sources built by the same Bun give the same bytes; a
binary and a checkout built with another Bun may differ, and then upgrade
redeploys what they build, once.

The order is the one this page has always given: the backup install before the
steward, whose unit opens the backups' folder only if it exists when the
steward starts; the root components that only listen before the dashboard,
which they accept old and new; the collector, the gatekeeper and the installer
after the dashboard; the Caddyfile, the shared service, the portal and the
monitor last.

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
  The units a release generates reach the apps already deployed without their
  code through `sitesolide refresh --all`, see
  [commands.md](commands.md#refreshing-the-apps-units).
- **The loopback rule.** Setup lays it; a release that changes it says so in
  its notes, and `bin/deploy-loopback.sh close` lays it again, from a checkout
  or from the kit the binary unpacked into `~/.cache/sitesolide/<version>-<hash>/`.
  It changes what every service may reach, and keeps its own safety net.
- **Caddy itself**, below.
- **Bun itself**, below.

### Upgrading Caddy

Caddy comes from its own apt repository, which unattended upgrades do not
follow, and a machine whose zone has a DNS provider runs a binary rebuilt
with that provider's module. The package is held (`apt-mark hold caddy`,
laid by setup): its own binary lacks the module, and an apt upgrade that put
it back would leave Caddy refusing the zone's policy at its next restart,
every site with it. `apt list --upgradable` goes on listing caddy; that is
expected. Nothing upgrades Caddy but you, and Caddy is what the internet
talks to: read its [releases](https://github.com/caddyserver/caddy/releases)
for security fixes, and upgrade this way.

1. **The new versions pinned**, from a checkout: `bun bin/update-pins.ts`
   lists what `infra/caddy/build.sh` pins, Caddy, its DNS module, Go's
   toolchain and xcaddy, beside the newest of each. Change the lines at the
   top of `build.sh`, and the module's in its `case`; `GO_TOOLCHAIN` has to
   satisfy the `go` line of Caddy's `go.mod`, which the listing shows. Commit.
   There is no hash to record: Go checks every source the build fetches
   against its checksum database.
2. **A binary of the new version with the module, beside the one in
   service**, never over it, built on the machine by that file. It fails
   unless the binary says the pinned version and carries the pinned module:

   ```bash
   ssh <server> 'sudo sh -s github.com/caddy-dns/cloudflare dns.providers.cloudflare /var/tmp/caddy.new' < infra/caddy/build.sh
   ```

   Never Caddy's build service (`caddy add-package`, or the download API of
   caddyserver.com): nothing checks what it builds.
3. **The configuration in service, validated by the new binary**, with the
   environment systemd hands Caddy:

   ```bash
   ssh <server> "sudo bash -c 'set -a; . /etc/caddy/cloudflare.env; . /etc/caddy/sitesolide.env; set +a; /var/tmp/caddy.new validate --config /etc/caddy/Caddyfile --adapter caddyfile'"
   ```

4. **The swap, the old binary kept, and a restart**: a reload never loads a
   new binary. Never `caddy stop` nor `caddy start`, see CLAUDE.md. Every site
   blinks for the second the restart takes; no deployment should run then.

   ```bash
   ssh <server> 'sudo cp -p /usr/bin/caddy /usr/bin/caddy.previous && sudo install -m 0755 /var/tmp/caddy.new /usr/bin/caddy && sudo systemctl restart caddy && systemctl is-active caddy && caddy version'
   ```

5. **Check**: the monitor's next pass (`journalctl -u sitesolide-monitor -n
   3`), a site of each kind over HTTPS. Should anything be wrong, the old
   binary goes back the same way:

   ```bash
   ssh <server> 'sudo install -m 0755 /usr/bin/caddy.previous /usr/bin/caddy && sudo systemctl restart caddy'
   ```

### Upgrading Bun

Bun at `/usr/local/bin/bun` runs every component and every project. Setup
installs the version `bin/cli/pins.ts` pins, from Bun's GitHub release, and
refuses a zip whose SHA-256 is not the pinned one; the release workflow builds
the binaries with the same version. Nothing upgrades it on its own.

1. **Bump the pin**, from a checkout: `bun bin/update-pins.ts` says the pinned
   version and the newest, and `bun bin/update-pins.ts bun <version>` pins
   another one. It takes each zip's SHA-256 from two places, the release's
   `SHASUMS256.txt` and the digest GitHub records for the asset, refuses when
   they disagree, and rewrites `bin/cli/pins.ts` and `release.yml`. Read the
   diff, run `bin/test.sh`, commit, and cut a release.
2. **Bring the machine to it** with that release: `sitesolide setup` run
   again finds Bun at another version and installs the pinned one, leaving
   every other step as it finds it. The file is replaced by a rename: what
   runs keeps its Bun until its next restart, and each component and project
   takes the new one when it restarts or is deployed.
3. **Check**: `ssh <server> '/usr/local/bin/bun --version'`.

A machine set up before the pin runs whatever Bun's installer gave it then;
its next `sitesolide setup` brings it to the pinned version, a downgrade when
the installer had given a newer one.

A machine upgrades one release at a time, reading the notes below for each.
They begin at 0.14.0: a machine on an earlier release is brought to 0.16
first, with that release's binary and [its
notes](https://github.com/cthiriet/sitesolide/blob/v0.16.0/docs/upgrading.md),
which go back to 0.1; this release converts nothing an earlier one left.

## A service listens on its declared port alone

**What the release brings.** Every generated unit gains one line, after its
other `SocketBindDeny=` lines: `SocketBindDeny=1-65535`. `SocketBindAllow=`
wins over it, so a server still binds its own port, and nothing else. Until
now every port outside 2019, the two blocks and the egress proxy's two stayed
free, and a service could listen on 8080, or a database on its default port
(3306, 5432, 6379), where another project's account could connect and read its
answers. The units written by `install` and by the installer's token-driven
runs, and a backup command that reaches its service on the loopback, carry the
line too.

**What can break.** A service, worker or scheduled service that listened on an
undeclared port now fails with `EPERM` when it binds. Declare a service of its
own with its own `port`, or listen on a Unix socket. A service that serves
outside clients on another port (an SSH server) declares it in
[`publicPorts`](manifest.md#publicports) before the refresh, with the owner's
token, and the owner opens the firewall for it by hand. A program that only
connects out is unaffected: DNS, TCP and UDP clients, `fetch` and the egress
proxy bind on port 0, which stays allowed. (`SocketBindDeny=any` was tried and
rejected: it also refuses port 0, which breaks a UDP send without an explicit
bind.)

**What you do.** `sitesolide refresh --all` writes every unit again with the
line: a unit this release's predecessor generated is the generator's own, and
is replaced without `--force`. A unit edited by hand is left as it is: add `SocketBindDeny=1-65535` after its other `SocketBindDeny=`
lines, then `systemctl daemon-reload` and restart the unit.

**What does not check it yet.** The monitor, `bin/deploy-loopback.sh` and the
check of the second block read the list of ports a unit denies
(`DENIED_BINDS`), and this line is not in it: adding it there would flag every
unit in service as critical, and block `deploy-loopback.sh`, until each had
been refreshed. A unit that lacks the line is therefore not reported until a
later release asks for it.

**What stays open.** A program that listens on a port the kernel picks (it binds
port 0) can still be reached by another account on the machine: port 0 cannot
be denied without breaking the clients that bind there. The rule remains one of
who connects, not of who listens.

## Company sign-in removed

**What the release brings.** Nobody signs in with a company account any more.
The portal's OpenID Connect sign-in goes, and with it everything that existed
only for it: members and the *People* page, people's sessions and their own
unlock, roles (Viewer, Developer, Admin), domain grants (`@acme.com`), the
right to create projects, people's own tokens (`/tokens/person/*`) and their
sweep, the company's domains and admin emails. What remains: the owner, with
a passkey, the password as the break-glass, and SSH; guests with password
access, who open one site and nothing more; general access per site; tokens
the owner mints, for every project or scoped, none of which gives anyone
access. The portal no longer sets `X-Sitesolide-User` or
`X-Sitesolide-User-Name` (it still strips both); `X-Sitesolide-Role` is
`admin` for the owner and `visitor` for a guest. The portal no longer needs
outbound network. See [access.md](access.md).

**The order.** `sitesolide upgrade` brings everything. By hand, the portal
first, then the steward (`bin/deploy-steward.sh`), then the dashboard. Either
order keeps guests in: the new portal reads the projection of before, and
the new steward still writes an empty `people` and `domains` in each site of
the projection, which the previous portal requires.

**What a machine of before keeps, and how it is read.** No code deletes a
file; each is tolerated:

- `/var/lib/sitesolide-steward/access.json`, the steward's registry: people
  and domains with a role, and `creators`, are left out as it is read, and
  dropped from the file at the registry's next change, a guest given or
  removed, a project renamed or removed. Password guests are kept as they
  stand, those listed under a name rather than an email included. Until that
  change, the steward's journal says it once per content of the file:
  `access: access.json names <n> people, domains or creators from company
  sign-in, which nothing reads any more: they go at its next change`.
  Someone who opened a site by their address and still needs it is given
  password access, `sitesolide share <email>`.
- The dashboard's sessions of people read as no session, and are purged at
  the owner's next sign-in.
- A token a person held is refused, reason `person` ("this token belonged to
  a person, and only the owner holds tokens now"), answered
  `unauthenticated`; it is listed on the *Tokens* page, where the owner
  revokes it. A project such a token created stays its name until the owner
  takes it back, `sitesolide deploy --adopt` in its folder.
- `portal.env`: leftover `OIDC_*` lines are ignored, and the portal says so
  once in its journal at startup.

**The CLI.** `sitesolide people` is gone, an unknown command now.
`share --role`, `--domain`, `--only-admins`, `--api` and `@domain` addresses
are refused with a pointer. `share` gives password access alone and
runs over the owner's SSH only: with a token it is refused `needs-ssh`.

**Then by hand, once everything is deployed.** Each step is optional, and
removes what nothing reads any more:

1. The `OIDC_*` lines of `/etc/sitesolide/portal.env`: `OIDC_ISSUER`,
   `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_ALLOWED_DOMAINS`,
   `OIDC_ADMIN_EMAILS` and `OIDC_PROVIDER_NAME`. The dashboard's *Secrets*
   section, under the unlock, removes each of them from `portal.env`, the
   only change it accepts there besides the password; or as root:

   ```bash
   ssh <server> "sudo sed -i '/^OIDC_/d' /etc/sitesolide/portal.env"
   ssh <server> "sudo systemctl restart portal"
   ```

   The restart drops the variables from the running portal and its warning
   from the journal. Then revoke the client at the identity provider, whose
   secret was on the machine.
2. The sign-in key pair, read by nothing now, and the files of people's
   sessions and of creations, if present:

   ```bash
   ssh <server> 'sudo rm -f /etc/sitesolide-portal/assertion.key /var/lib/sitesolide-steward/assertion.pub /var/lib/sitesolide-steward/member-sessions.json /var/lib/sitesolide-steward/creations.json'
   ```

3. A token a person held, on the *Tokens* page: *Revoke*.

**Going back.** The previous release's portal, steward and dashboard, in the
reverse order. The registry keeps its guests whatever happened; people and
domains it dropped at a change are not brought back, and are given again
from the previous dashboard.

## SSH closes to the internet

**What the release brings.** Port 22 can be restricted to networks
(`--ssh-from`) or to an interface (`--ssh-interface tailscale0`) in ufw, and
at Hetzner's firewall with `sitesolide machine firewall`; `setup --tailscale`
joins the machine to a tailnet; the sshd drop-in lets in the deploy account
alone, turns forwarding off and keeps modern algorithms; `setup --host-key`
pins the host key. See [ssh.md](ssh.md). Nothing closes port 22 unless the
owner asks, and nothing that was restricted is opened again.

**What `sitesolide upgrade` brings**: the component `ssh`, the new drop-in,
with the configuration's account as the one `AllowUsers` lets in, behind the
same safety net as setup's (a second login proves it, else it is withdrawn
two minutes later); and the component `ssh-firewall`, which applies the
access recorded in the configuration, and with none recorded finds port 22
open and leaves it so. Before it, check that nobody else logs in over SSH, an
agent's account or a backup's for instance: `AllowUsers` refuses them.

```bash
ssh deploy@<machine> "sudo journalctl -u ssh --since -30d | grep -o 'Accepted [a-z-]* for [^ ]*' | sort | uniq -c"
```

Every line should name the deploy account. The same login must not offer more
than five keys: `MaxAuthTries 5`, see [ssh.md](ssh.md#the-sshd-settings).

**Closing port 22 to the internet, on a machine in service, is three phases**,
each one reversible, each one checked before the next. Keep a second terminal
logged in over the public address until phase 2 is checked: an open session
survives every change below.

### Phase 0: the way back in, tried first

Nothing changes on the machine but a password for the console.

1. Set root's password for the provider's console, and keep it in your
   password manager: `ssh deploy@<machine> sudo passwd root`. sshd refuses
   root and passwords whatever it is.
2. Open the machine's console in Hetzner's console (*Servers*, the machine,
   *Console*), log in as root, run `ufw status`, log out. That is the way in
   when ufw or sshd shuts you out.
3. Note which firewall Hetzner applies to the machine (*Firewalls*). One made
   by `sitesolide machine create` is the one `sitesolide machine firewall`
   changes; check it reads it:

   ```bash
   sitesolide machine list --provider hetzner
   ```

   A firewall made another way, or none, is changed in the console, and
   `machine firewall` refuses it. Check that `hcloud firewall describe
   <firewall>` answers, or that you can edit its rules in the console: that is
   the way in when port 22 is closed there.

**Rollback:** nothing to roll back; `sudo passwd -l root` locks the password
again if you prefer to rely on the rescue system.

### Phase 1: the tailnet beside the public address

Port 22 stays open to all; the tailnet becomes a second way in.

1. Prepare the tailnet: the tag, the grant from your devices to `tag:server`
   on `tcp:22` with nothing back, Tailnet Lock, and a one-use, pre-approved
   auth key tagged `tag:server`, see [ssh.md](ssh.md#before-setup-the-tailnets-settings).
2. Upgrade first, so the drop-in and the firewall components are this
   release's: `sitesolide upgrade --dry-run`, then `sitesolide upgrade`.
3. Join, over the public address, the server as the configuration names it:

   ```bash
   sitesolide setup --dry-run deploy@<public address> --zone <your zone> --email <you> --tailscale
   op read "op://<vault>/<item>/credential" | sitesolide setup deploy@<public address> --zone <your zone> --email <you> --tailscale --tailscale-key-stdin
   ```

   Every other step reads `[done]`: setup changes nothing else on a machine
   it installed. On a machine it did not install, no `setup.json` beside the
   configuration, setup only reads, and the dry run says so; install
   Tailscale by hand then, as the step would:

   ```bash
   ssh deploy@<public address>
   curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
   gpg --show-keys --with-colons /usr/share/keyrings/tailscale-archive-keyring.gpg | grep '^fpr'
   ```

   The fingerprint must read `2596A99EAAB33821893C0A79458CA832957F5868`.
   Then, still on the machine:

   ```bash
   echo "deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/debian trixie main" | sudo tee /etc/apt/sources.list.d/tailscale.list
   sudo apt-get update && sudo apt-get install -y tailscale
   read -rs key && printf '%s' "$key" | sudo install -m 600 /dev/stdin /run/tailscale.key && unset key
   sudo tailscale up --auth-key=file:/run/tailscale.key --advertise-tags=tag:server --ssh=false --accept-dns=false --accept-routes=false
   sudo rm /run/tailscale.key
   ```
4. If Tailnet Lock is on, sign the node from a signing device:
   `tailscale lock status` lists it, `tailscale lock sign <node key>`.
5. Check, from the workstation, in the tailnet:

   ```bash
   ssh deploy@<tailnet name> 'tailscale status --self; ip -o addr show tailscale0'
   ssh-keygen -lF <tailnet name>
   ssh-keygen -lF <public address>
   ```

   The two fingerprints must be the same key's.

**Rollback:** `ssh deploy@<public address> 'sudo tailscale logout; sudo apt-get
purge -y tailscale'`, remove the machine from the tailnet's admin console,
and drop `"tailscale"` from `~/.config/sitesolide/config.json`.

### Phase 2: port 22 closed to the internet

1. Point the configuration at the tailnet name, and check it:

   ```bash
   sitesolide init --server deploy@<tailnet name> --zone <your zone> --email <you>
   ssh deploy@<tailnet name> true
   ```

2. Close it in ufw, over the tailnet. Upgrade refuses unless its own
   connection arrives on `tailscale0`, and records the access in the
   configuration once ufw holds it:

   ```bash
   sitesolide upgrade --dry-run --ssh-interface tailscale0
   sitesolide upgrade --ssh-interface tailscale0
   ```

   Upgrade rather than setup: setup's record of the install names the public
   address, and a tailnet name resolves elsewhere, so setup given the tailnet
   name only reads.

3. Close it at Hetzner's firewall: `sitesolide machine firewall <name>
   --provider hetzner --ssh-closed`, which checks the configured server
   reaches the machine without port 22 first, or the console, the rule for
   TCP 22 deleted.
4. Check, from a network outside the tailnet, a phone's connection for
   instance: `nc -vz -w 5 <public address> 22` times out, and
   `curl -sI https://<your zone>` still answers. From the tailnet, `ssh
   deploy@<tailnet name> true` works, and `sitesolide upgrade --dry-run` reads
   every component `up to date`.

**Rollback**, with SSH still working over the tailnet:

```bash
sitesolide machine firewall <name> --provider hetzner --ssh-public
sitesolide upgrade --ssh-public
sitesolide init --server deploy@<public address> --zone <your zone> --email <you>
```

**Rollback without SSH**, the tailnet down: the Hetzner rule for TCP 22 put
back from the console or `hcloud firewall add-rule <firewall> --direction in
--protocol tcp --port 22 --source-ips 0.0.0.0/0 --source-ips ::/0`, then, in
the machine's console as root, `ufw allow 22/tcp`. Once in over the public
address, `sitesolide init --server deploy@<public address> ...` then
`sitesolide upgrade --ssh-public` make the configuration agree. See [ssh.md](ssh.md#the-way-back-in).

**Going back to the previous release.** Its `upgrade` leaves ufw alone, but
its `setup` reads neither `sshFrom` nor `sshInterface`: it looks for a rule
starting `22/tcp ALLOW`, which a rule `on tailscale0` is not, and adds
`ufw allow 22/tcp`, open to all. Do not run the earlier release's `setup` on a
machine closed this way; the provider's firewall stays closed whatever it
does.

## The collector runs root's own build

**What the release brings.** The collector, the root timer that snapshots the
machine for the dashboard every minute, no longer runs
`/srv/sites/dashboard/app/collector.ts`, a file of the tree every deployment
of the dashboard rewrites, its `install` phase included as `site-dashboard`.
`bin/deploy-collector.sh` now builds it, as the steward and the monitor are
built, installs it `root:root 0644` as `/usr/local/lib/sitesolide/collector.js`
and checks its fingerprint. Its unit is confined like theirs:
`ProtectSystem=strict`, the dashboard's data folder the one place it writes,
four capabilities (`CAP_DAC_READ_SEARCH`, `CAP_DAC_OVERRIDE`, `CAP_CHOWN`,
`CAP_SYS_PTRACE`) rather than all of root's, `SystemCallFilter=@system-service`,
`AF_UNIX` and `AF_NETLINK` alone, the stores, the steward's state and the DNS
provider's token hidden. Each project's size is measured within 5 seconds, all
of them within 20, and one that takes longer reads as unknown rather than
holding back the snapshot of every project. See
[dashboard/README.md](../dashboard/README.md#the-web-service-does-not-read-the-machine).

**What `sitesolide upgrade` brings**: the dashboard, then the collector, found
out of date since `collector.js` is missing. Between the two, for a minute at
most, the unit in place still runs the copy the new dashboard brought to
`app/`, which works under it. No project is redeployed.

**The steps, on the owner's workstation:**

1. Install the new CLI, then `sitesolide upgrade --dry-run`, which lists the
   collector out of date, then `sitesolide upgrade`. The collector's script
   ends on one run by hand, and stops with its journal if that run fails.
2. Check the confined unit sees what it saw before; every command reads only:

   ```bash
   ssh <server> 'systemctl show sitesolide-collector.service -p Result -p ExecMainStatus'
   ssh <server> 'sudo journalctl -u sitesolide-collector -n 5 -o cat --no-pager'
   ssh <server> 'sudo systemd-analyze security sitesolide-collector.service | tail -n 1'
   ```

   `Result=success`, and a summary line `N folders collected`, none `of
   unknown size` on a quiet machine. Then in the dashboard: every project's
   size shown, its units' state, and on a site whose services talk to each
   other, the links under *Services*. A project with no size, or no link where
   there were some, is a reading the unit's confinement refuses: the journal
   says which, and the unit's comments say which directive opens what.
3. Nothing else: the copy of `collector.ts` in `/srv/sites/dashboard/app/`
   stays, run by nothing.

**If the confined unit fails on this machine**, its timer was already armed:
the dashboard announces a stale snapshot within two minutes, and every other
site is untouched. Going back, below, restores the snapshot while the cause is
looked into.

**Going back.** The previous release's checkout or binary, then
`bin/deploy-collector.sh` from it, which installs the unit that runs
`app/collector.ts` again. `/usr/local/lib/sitesolide/collector.js` stays,
run by nothing; `sudo rm /usr/local/lib/sitesolide/collector.js` removes it.

## Sign-ins verified as they stand, and protected sites framed by themselves alone

**What the release brings.** The dashboard's password is verified by the
steward against the hash as its file holds it now: after *Change password*,
the old one stops signing in at once, and the owner's other sessions close,
with no *Restart service*. A member's sign-in with a company account is
bounded per client, sixty a minute, rather than for the whole machine,
which anyone could fill. The portal answers 403 when a protected site is
loaded in a frame by a page of another origin, a sibling host of the zone
above all, and the sign-in page and a preview's door page refuse every
frame. See [dashboard/README.md](../dashboard/README.md) and
[portal/README.md](../portal/README.md).

**What `sitesolide upgrade` brings**: the steward, its `/signin` route; the
dashboard; the portal; the gatekeeper, whose next locks' fragment carries
the door page's headers. No project is redeployed. The order is the usual
one, the steward first; a dashboard ahead of its steward finds no `/signin`
and verifies with the hash it started with, as before.

**What changes for you.** A protected site shown inside a page of another
site of the zone, on purpose, now shows the portal's refusal instead: no
setting brings it back, the site has to be opened in its own tab. A public
site is untouched.

**Going back.** The previous dashboard verifies with its own hash again,
the previous portal lets frames through; the steward's route is left
unused.

## Preview codes of ten characters

**What the release brings.** A site whose general access is *Anyone with
the code* is now given a code of ten characters, 50 bits, where it was given
six, about 30. Caddy counts no attempt, so six characters fell to a script
guessing for a few days; ten take thousands of years. The codes already in
force are untouched: the codes file, the fragment Caddy compares them from,
the links already sent and the cookies of the visitors keep opening their
sites, and the door page accepts both lengths.

**What `sitesolide upgrade` brings**: the gatekeeper, which draws the new
codes and writes the new door page, and the dashboard. Nothing is converted
and no project is redeployed.

**Then, for each site locked before**, when its owner can send a new link:
*New code* in its *Access* section, or from its folder:

```bash
sitesolide lock --new-code
```

The old link stops opening the site at once, and the visitors who held its
cookie are shown the door page again: send them the new link.

**Going back.** A gatekeeper from before reads a ten-character code as
invalid and refuses to write the locks' fragment, which stops every change
of general access on the machine, the configuration in service staying as
it is. Before going back, give every site that holds a ten-character code
another general access, then lock it again once the previous release is in
place.

## Installs and outbound projects stay off private networks

**What the release brings.** A manifest's `install` and every unit with
`"network": "outbound"` no longer reach the cloud's metadata service
(169.254.169.254, all of link-local), multicast, nor the private ranges
(10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, fc00::/7, AWS's
fd00:ec2::254 among them). The install also loses its address families but
`AF_UNIX`, `AF_INET`, `AF_INET6` and `AF_NETLINK`. A token without the
outbound permission now installs from the package registries alone, through
the egress proxy; a token with it, the owner's included, keeps the public
network. An outbound unit keeps the loopback. A project that must reach a
private range declares it under `privateNetworks`, which only the owner's
token deploys. See [manifest.md](manifest.md#network) and
[egress/README.md](../egress/README.md#installs-without-the-outbound-permission).

**What `sitesolide upgrade` brings**: the installer (the install's network by
the token's scope, the registries' marker), the egress proxy (it reads the
marker), and the dashboard, whose own unit is `outbound` and gains the deny
line. A project's unit changes at its next deployment, without `--force`:
the unit an earlier release laid is recognised as the generator's own.

**The steps, in this order:**

1. **The resolver.** Read `/etc/resolv.conf` on the machine:

   ```bash
   ssh <server> cat /etc/resolv.conf
   ```

   `nameserver 127.0.0.53`, systemd-resolved's stub, or only public
   addresses (a provider's public resolvers, Hetzner's for instance): nothing
   to do. A `nameserver` in one of the ranges above, or on the loopback but
   127.0.0.53, GCP's 169.254.169.254, an AWS VPC's x.x.x.2 or 169.254.169.253:
   every outbound project and every install would resolve nothing once
   upgraded. Put systemd-resolved in front of it first, as root, keeping
   those addresses as its upstream:

   ```bash
   sudo apt-get install -y systemd-resolved
   sudo mkdir -p /etc/systemd/resolved.conf.d
   printf '[Resolve]\nDNS=<the addresses resolv.conf listed>\n' | sudo tee /etc/systemd/resolved.conf.d/upstream.conf
   sudo systemctl restart systemd-resolved
   cat /etc/resolv.conf            # nameserver 127.0.0.53
   resolvectl query example.com    # answers
   ```

   resolved itself runs outside the projects' walls and keeps reaching the
   provider's resolver; the projects ask it on 127.0.0.53, which the walls
   let through.
2. **Projects that reach a private network.** Any outbound project that
   talks to an address in those ranges, a database on the provider's private
   network for instance: add `"privateNetworks": ["<its range>"]` to its
   manifest. Only your own token deploys it.
3. Install the new CLI, then `sitesolide upgrade --dry-run`, then
   `sitesolide upgrade`. The egress proxy, the installer and the dashboard
   are among the components it lists out of date. A machine without the
   egress proxy (`setup --minimal` leaves it out) needs it for
   tokens without the outbound permission: `sitesolide setup <user@host>
   --zone <zone> --email <you>`, without `--minimal`, installs it.
4. Redeploy each outbound project, and those with an `install`, the way you
   deploy them. `systemctl cat <slug>` then shows the `IPAddressDeny=` line.
5. A token without the outbound permission whose project's `install` fetches
   a git dependency or a download from another host than a registry fails
   now, saying so: deploy it with a token allowed outbound network, or move
   the step into `build`.

**Going back.** The previous release's installer gives every install the
whole network again, and its proxy ignores the marker. A unit this release
generated reads, to the previous release, as edited by hand: redeploy with
`--force`, from the owner's token, to put that release's unit back. A
manifest carrying `privateNetworks` is refused there as an unknown key.

## The owner signs in with a passkey

**What the release brings.** The owner signs in to the dashboard with a
passkey, unlocks with a fresh one, and enters a restricted site as the
owner with the same passkey, from its sign-in page, on a domain of its own
too. Once a passkey exists, the dashboard's password neither signs in nor
unlocks. The first one is registered through a one-time link root mints
over SSH, `sitesolide passkey link`. The dashboard's sign-in failures are
now counted per client rather than globally, and an owner's session closes
after twelve hours without a request, within its seven days. Once a passkey
exists, the portal's own owner password no longer signs in to the
restricted sites either. Password access and company accounts are
unchanged. See
[dashboard/README.md](../dashboard/README.md#passkeys) and
[portal/README.md](../portal/README.md#the-owners-passkey).

**What `sitesolide upgrade` brings**: the steward (the registry,
`/var/lib/sitesolide-steward/passkeys.json`, created on the first
registration, and its projection for the portal,
`/etc/sitesolide-portal/passkeys.json`, laid at startup), the dashboard (the
routes, the *Passkeys* panel on the *Server* page, the passkey on the
sign-in page and in the unlock) and the portal (its passkey page, and three
routes on its own host, `/passkey`, `/passkey/options` and
`/passkey/verify`, which its redeployment adds to its Caddy block). The
dashboard's database keeps its tables: the `essais` table is no longer
read, and a flag is kept in `reglages` under `owner_passkeys`. No project is
redeployed: every fragment already sends `/_portal/*` to the portal.

**The steps, on the owner's workstation, in this order:**

1. Install the new CLI, then `sitesolide upgrade --dry-run`, then
   `sitesolide upgrade`. The steward is upgraded before the dashboard and
   the portal, which is the order that matters: a dashboard ahead of its
   steward finds no passkey route, says nothing of passkeys, and keeps the
   password signing in, so no order locks you out. Until the first passkey,
   the dashboard signs in with its password as before.
2. Mint the link, from the workstation, over your SSH access:

   ```bash
   sitesolide passkey link
   ```

   Open the printed `https://dashboard.<zone>/#passkey=...` in your own
   browser within fifteen minutes. It registers a passkey and signs you in;
   from then on the password no longer does, nor does the portal's owner
   password on a restricted site's sign-in page.
3. Register a second passkey, on another device or a security key, from the
   *Server* page, *Passkeys*, which asks for the unlock, now a passkey.
   `sitesolide passkey` lists both.
4. Check a restricted site: sign out of it, then *Sign in with a passkey* on
   its sign-in page lets you in as the owner.

**Recovery.** Every passkey lost: `sitesolide passkey link` again, over SSH.
A link that cannot be used, the browser offering no passkey for instance:
`sitesolide passkey` for the ids, then `sitesolide passkey remove <id>` for
each, which gives the dashboard's password, and the portal's, back once the
last one is gone.

**Going back.** The previous release's dashboard signs in with the password
again, and its steward ignores the registry, which stays on disk, root's;
the projection is ignored by a portal from before, and the cookies a passkey
opened stop opening anything there, their form unknown to it.

## Every deployment goes through a token

**What the release brings.** `sitesolide deploy` no longer goes over SSH, the
owner's included: it builds on the workstation and uploads through the
dashboard's API with a token. The CLI keeps SSH for `setup`, `upgrade`,
`refresh`, the owner's machine-wide commands, and the deployments of the
platform's own components, the dashboard and the portal, which setup and
upgrade make from the kit. The owner deploys with a new kind of token, their
own for every project (`scope.all`), which reaches every project the machine
carries but the platform's and those another token holds, carries every
permission, keeps a `lock` key, is bounded by no token cap, and alone carries
`deploy --force` and `deploy --adopt`. A dry run with a token is now the
machine's plan (`POST /api/v1/deployments/plan`), which writes nothing, and
the ports a deployment chose, the door set from the dashboard and the former
names a rename left are written back into `sitesolide.json`, as over SSH.
`setup --minimal` no longer leaves the installer out.

**What `sitesolide upgrade` brings**: the steward (the plan, the take back of
a name, the owner's socket's `POST /tokens/owner`, the widened scope), the
installer (`--force` carried, a member's request narrowed), and the
dashboard (the routes, the *Every project, as you* choice on the *Tokens*
page, and a `deployment_options` table its database creates by itself, the
deployments' table left as it is). No project is redeployed.

**The steps, on the owner's workstation, in this order:**

1. Install the new CLI, then `sitesolide upgrade --dry-run`, then
   `sitesolide upgrade`. The steward, the installer and the dashboard are
   among the components it lists out of date.
2. A machine set up with `--minimal` has no installer, and no deployment can
   go through without it: `sitesolide setup <user@host> --zone <zone> --email
   <you>`, without `--minimal`, installs it (and the backups and the egress
   proxy). `sitesolide upgrade --dry-run` lists it `missing` until then.
3. Mint your token: `sitesolide login --owner`. It asks the steward's owner
   socket over your SSH access, keeps the token in
   `~/.config/sitesolide/secrets/team-token`, 0600, with the dashboard's
   address beside it, and never shows it. Or mint it on the *Tokens* page,
   under the unlock, *New token*, *Every project, as you*, then `sitesolide
   login --url https://dashboard.<zone>`.
4. `sitesolide status --json` from any folder reads the machine over SSH as
   before; `cd <a project> && sitesolide deploy --dry-run` reads the plan
   through the token. Deploy as usual from there.
5. CI jobs or scripts that ran `sitesolide deploy` with only SSH set up now
   need `SITESOLIDE_API` and `SITESOLIDE_TOKEN`: give each a token of the
   projects it deploys, from the *Tokens* page, rather than yours.

Without a token, `sitesolide deploy` stops before anything is sent and says
how to mint one. Nothing on the machine changes for the projects it serves.

**Going back.** The previous release's binary deploys over SSH again, with
the same configuration. The owner's token stays valid on the steward until
revoked from the *Tokens* page; a steward from before ignores `all` and
reads it as a token that may create projects, with every permission, and
reaches no existing one: revoke it if you go back for good. The
`deployment_options` table is ignored by a dashboard from before.

## Renaming, turning off and deleting wait for the backups

**What the release brings.** A rename, a project turned off or on, and a
deletion take the backups' own lock, the one the hourly run and a restore
share: each waits up to two minutes for a run or a restore under way, then
refuses with nothing changed. Before, a rename during the hourly run moved
the folder it was copying, and that hour's snapshot of the project failed; a
deletion during a restore removed the folder the restore was swapping.

**What `sitesolide upgrade` brings**: the installer, with the two templates
now reaching `/run/sitesolide-backup`, the steward, and the dashboard. No
project is redeployed.

**Going back.** The previous release's binary, then `sitesolide upgrade`.

## Turning a project off, and deleting it from the dashboard

**What the release brings.** A project can be turned off and on again, and
deleted, from the "..." of its Overview in the dashboard, the owner's,
unlocked; `sitesolide disable` and `sitesolide enable` do the first two from
its folder. A new root one-shot, `sitesolide-lifecycle@<slug>`, does each
under the Caddy lock and puts everything back on failure. Turned off, a
project keeps everything, its services stopped, and every address answers a
503 that says so; its manifest on the machine carries `disabled`, a new key
the machine writes. Deleted, it goes as `sitesolide remove` takes it, its
backup snapshots kept. See
[docs/commands.md](commands.md#turning-a-project-off-and-deleting-it).

**What `sitesolide upgrade` brings**: the installer with the new template,
the steward, the dashboard, the gatekeeper, which refuses to change the
general access of a project turned off, and the monitor, which counts a
project turned off as no failure. No project is redeployed.

**What changes for you.** Deploying a project turned off is refused, as are
a change of its general access, a rename, `sitesolide domain`, and a restart,
whoever asks, until it is turned on. `sitesolide refresh --all` leaves it as
it is; its scheduled backup runs no backup command and saves its data as the
stopped services left it; a restore leaves it stopped.

The same release closes what an audit of renaming and removing found: a
removal sets a restricted site's `public/` aside before it takes its block
out, and a rename lays the new name's block before it moves the folder, so
the zone's wildcard never serves either; a token's deployment can no longer
write `disabled`, nor learn the new name of a project it has no access to;
token work waits while the owner renames, turns off or deletes the project;
and the monitor takes a site for turned off only when its manifest on the
machine says so, never on a header an app could send.

**Going back.** The previous release's binary, then `sitesolide upgrade`.
Turn every project on before: a project still off keeps its block and its
stopped services, and its `disabled`, which the previous release refuses as
an unknown key.

## Renaming a project

**What the release brings.** A project can be renamed, its address with it:
*Rename* on its Overview in the dashboard, the owner's, or `sitesolide
rename <new-slug>` in its folder. A new root one-shot,
`sitesolide-rename@<slug>`, moves everything the slug names on the machine,
the account renamed with its uid kept, the folder and its data, the store of
secrets, the units and the Caddy block generated again, the domain table,
reloads Caddy, starts the services and probes every site, and puts everything
back at the first failure; the steward then moves the people with access and
the tokens to the new name. The manifest gains `formerSlugs`, which the
machine writes: a checkout that still says the old name deploys to the
renamed project and rewrites its `sitesolide.json`, and a token's deployment
of the old name is refused with the name to write. See
[docs/commands.md](commands.md#renaming-a-project).

**What `sitesolide upgrade` brings**: the installer, with the rename's
template beside its own, through `bin/deploy-installer.sh`; the steward, for
the rename's route and the registries it moves; the dashboard, for its
*Rename* button. No project is redeployed.

**What changes for you.** A deployment of a project the machine does not
carry reads every deposited manifest once more, to tell a new project from a
renamed one. The data snapshots taken before a rename stay under the old
name in the backup repository; the next backup run starts the new one's.

**Going back.** The previous release's binary, then `sitesolide upgrade`.
A project renamed meanwhile keeps its new name, and its `formerSlugs`, which
the previous release refuses as an unknown key: remove the key from its
`sitesolide.json` before deploying it with that release.

## The wildcard serves slugs alone, and the zone sends HSTS

**What the release brings.** Over HTTP/2 and HTTP/3, Caddy up to 2.11.7
accepts a host that holds a slash. The wildcard block builds its root from
the host's label, `/srv/sites/<label>/public`, so `finance/.<zone>` served
the `public/` of an app behind its portal without asking anyone, and a longer
label any folder named `public` deeper in `/srv/sites`, an app's sources
among them (GHSA-r766-rf9f-588h, met on production). The wildcard block now
answers 404 to a label that is not a slug, and to an app's slug, whose names
are its own block's, as the customer domains' block already did. And every
host of the zone, the dashboard, the portal and the apps that declare the
bare domain included, now sends `Strict-Transport-Security`, from `(commun)`;
up to this release only `www` and a bare domain of the domain table did. A
client's domain still sends none.

**What `sitesolide upgrade` brings**: the Caddyfile, through
`bin/deploy-caddy.sh`, validated and reloaded. No project is redeployed: the
blocks in service import `(commun)` by name.

**Then by hand**, on a machine whose zone has a DNS provider:

1. **Hold the package**, which setup now does, so that no apt upgrade puts
   back a binary without the module: `sitesolide setup` again, or
   `ssh <server> 'sudo apt-mark hold caddy'`.
2. **Bring Caddy to 2.11.8 or later**, which refuses such a host before any
   route sees it, the way [Upgrading Caddy](#upgrading-caddy) says. The
   Caddyfile closes the hole without it; the new Caddy closes it for every
   block, and carries the other fixes of its releases.

**What changes for you.** A browser that has seen a host of the zone goes
there over HTTPS alone for a year, which every host of the zone already
serves. A host under the zone whose label is not a slug answers 404.

**Going back.** The previous release's binary, then `sitesolide upgrade`,
lays the previous Caddyfile again; browsers keep the HSTS they saw until it
expires. `sudo apt-mark unhold caddy` lets apt upgrade the package again,
which on a zone with a DNS provider puts back a binary without its module.
A Caddy brought up to date goes back with `/usr/bin/caddy.previous`, as
[Upgrading Caddy](#upgrading-caddy) says.

## Conversions of the releases before 0.14 removed

**What the release brings.** The code that carried a machine or a
workstation across a release before 0.14 is gone: every installation has been
through it, and it ran only to find nothing left to do.

- **The backups no longer import the archives written before restic**, the
  `.tar.gz` files under `/var/backups/sitesolide` and the `.enc` objects in the
  bucket, which 0.4.0 to 0.16 imported into the repositories and removed seven
  days after each copy was verified. `bin/deploy-backup.sh install` refuses a
  machine where an archive remains, or a copy was verified less than seven
  days ago, before it changes anything there, and names them. `backup.js
  decrypt` goes with them, and the run no longer writes
  `/var/backups/sitesolide`.
- **The access registry is no longer made from the stores before it**,
  `members.json` and the portal's `sharing` and `invites` tables, as 0.4.0
  made it at the steward's first start: a machine without a registry begins
  it empty. `sitesolide people --migrate-without-portal` and the steward's
  `POST /access/migrate` are gone. The portal no longer decides from its own
  tables while no projection is there, nor leaves its mark
  `data/access-from-steward`; a missing projection opens nothing but the
  owner's password and the admin emails, as it already did once the mark
  was there. Its routes that answered `410 moved`, `PUT
  /admin/sharing/:host`, `/admin/guests` and `DELETE /admin/invites/:id`,
  answer 404 like any route it does not know. The registry's record of what
  its making set aside, and the entries it gave, are read and kept as they
  stand.
- **The gatekeeper's install converts nothing any more.** It removed the
  single template of the releases before 0.4, `sitesolide-gatekeeper@.service`,
  and closed to Caddy's group a preview locks' fragment, `verrous.caddy`, an
  earlier gatekeeper had left `0644`, which a gatekeeper since 0.6 writes
  `0640` itself; `sitesolide upgrade` no longer counts a gatekeeper out of date
  for that template. Check both once, reading only, if a machine skipped
  0.4 or 0.6: `ssh <server> 'test ! -e
  /etc/systemd/system/sitesolide-gatekeeper@.service && sudo stat -c "%U:%G %a"
  /etc/caddy/locks/verrous.caddy'`, which answers `root:caddy 640`, or
  nothing on a machine that never locked a preview.
- **`bin/deploy-caddy.sh` no longer lays Cloudflare's policy** on a machine
  without `/etc/caddy/tls-zone.caddy` that holds a Cloudflare token, as it did
  for a machine upgraded from 0.6, whose Caddyfile carried that policy itself:
  such a machine now stops before any write, as any machine without the file
  did, and `sitesolide setup` lays it. Nor does setup refuse a new policy over
  a Caddyfile from before the file any more. The Caddyfile's comments say so,
  and it is laid again.
- **The workstation's configuration is read under its English keys alone.**
  `serveur`, `courriel` and `coffre`, renamed before 0.1, were still read
  and said to be outdated; `projets`, `projects` and `destinations` were
  dropped with a word. A `config.json` that still carries the French keys now
  reads as an incomplete configuration, naming what it lacks: rename them by
  hand, or run `sitesolide init`.
- **The tokens from before every token belonged to someone are no longer
  converted.** 0.4.0 to 0.16 made each one someone's at the steward's start,
  and wrote `team.json` as version 2; a `team.json` of version 1, or with no
  version, now does not read, and every token is refused until a human looks,
  as for any registry that does not read.
- **The names of before 0.4.0 are gone.** The steward no longer answers the
  token routes under `/team/` nor a person's under `/members/`, which a
  dashboard or a CLI of 0.3 called; the dashboard no longer reads a person of
  kind `member` nor a refusal `not-a-member` from a steward of 0.3; and the
  CLI no longer explains `door-changed`, an installer of 0.3's word.

**What `sitesolide upgrade` brings**: every component whose build changed,
measured as always: the backups, their code and their run's unit, after the
refusal above; the steward, the dashboard and the portal; the Caddyfile,
whose comments changed, laid again and Caddy reloaded once.

**When the backups' install refuses**, the upgrade stops there, the components
after it untouched. An archive left is one the backups in service could not
import, their journal saying why (`journalctl -u sitesolide-backup`): move it
off the machine, or delete it once read. A copy verified less than seven days
ago goes on the date the refusal gives, with the archive and its object; run
`sitesolide upgrade` again after it.

**What stays by hand.** What nothing reads any more, harmless where it lies:
the empty folder `/var/backups/sitesolide`, `ssh <server> 'sudo rmdir
/var/backups/sitesolide'`; `/var/lib/sitesolide-steward/members.json`; the
mark `/srv/sites/portal/data/access-from-steward`; and the `sharing` and
`invites` tables of the portal's `portal.db`, which nothing creates any
more. An `.enc` object of the format before restic left in the bucket is read
by nothing of this release: `bun backup.ts decrypt <file> <output>` in
`dashboard/` of a 0.16 checkout reads it.

**Going back.** `sitesolide upgrade` with the previous binary. What this
release reads, the previous one reads too, and its backups find nothing left
to import.

## Connectors removed

**What the release brings.** The egress proxy no longer lends credentials. The
dashboard loses its *Connectors* page, the steward its routes and its writes
into `/etc/sitesolide-egress`, and the manifest its `connectors` key, which
`sitesolide deploy`, `sitesolide refresh` and a token's deployment now refuse
with what to write instead: the credential among the project's secrets, the
host it calls under `egress`. The allow list stays as it is, on
127.0.0.1:3128, and 3129 now carries nothing but the dashboard's two
read-only routes, `GET /status` and `GET /audit`; both ports stay refused to
every project by its unit. The steward's unit no longer opens
`/etc/sitesolide-egress`, `bin/deploy-egress.sh` no longer creates it, and the
steward no longer has to start again after the proxy. Activity tells a proxy
that is not installed from one that is down by its unit file,
`/etc/systemd/system/sitesolide-egress.service`, and a bookmark to
`/connectors/` opens Activity, where the proxy's refusals are read.

**What `sitesolide upgrade` brings**: the egress proxy, the steward, whose unit
changes, the dashboard, and the components that embed the manifest's rules,
the backups, the gatekeeper, the installer and the monitor. Caddy is
not reloaded. No project's unit changes, the `egress` lines included, nor the
loopback rule: there is nothing to `refresh`.

**What stays by hand.** A project whose deployed manifest still declares
`connectors` keeps the unit it has, `SITESOLIDE_CONNECTORS` included, and
calls to that address are refused from now on; its next deployment, and
`sitesolide refresh`, refuse it until the key is gone. The files the steward
wrote stay on the machine, `connectors.json`, which holds the credentials
themselves, and `grants.json`:

```bash
ssh <server> "sudo ls -l /etc/sitesolide-egress"
ssh <server> "sudo rm -r /etc/sitesolide-egress"
```

Revoke each credential at its provider, then remove the folder once the
upgrade has run: neither the proxy nor the steward of this release reads it.
The proxy's database keeps the `seen` table it compared the files with, which
nothing reads any more, and its `connector.*` rows, pruned after 90 days.

**Going back.** `sitesolide upgrade` with the previous binary brings the page
and the routes back, and that release's `bin/deploy-egress.sh` lays the
folder again, empty, if it was removed.

## The MCP server removed

**What the release brings.** `sitesolide mcp` goes, with the tools it served:
nothing used it, and an agent that runs commands drives the CLI itself with
`--json`, the same commands with the same refusals and a `hint` on every
error. `sitesolide mcp` is now a command the CLI does not know. `--json`, the
hints, `llms.txt` and the skill stay, the skill naming the commands where it
named the tools.

**What `sitesolide upgrade` brings**: nothing of its own. The server ran on
the workstation alone.

**What stays by hand.** A client that registered the server fails to start it
from now on: take it out. In Claude Code,
`claude mcp remove --scope user sitesolide`, or the `sitesolide` entry of a
repository's `.mcp.json`; in Codex, the `[mcp_servers.sitesolide]` table of
`~/.codex/config.toml`; in Cursor, the `sitesolide` entry of
`~/.cursor/mcp.json` or of a project's `.cursor/mcp.json`. A skill linked
from a clone of this repository follows with its next pull.

**Going back.** The previous binary serves it again, registered as before.

## Every DNS provider but Cloudflare removed

**What the release brings.** `setup --dns` takes `cloudflare`, the default,
or `manual`, and nothing else. The ten other providers it took from 0.7 on
were only ever tried against local fakes of their APIs, never on a real zone,
while every installation in service uses Cloudflare: their code goes, with
their pages in `docs/dns/`, the `SITESOLIDE_DNS_<...>` variables they read,
and `--dns-credentials-stdin`, which read their credentials. Cloudflare's
token comes from `CLOUDFLARE_API_TOKEN` or `--cloudflare-token-stdin`, as it
always has. The wizard offers two ways: Cloudflare's API, first when the
zone's name servers are Cloudflare's, and records made by hand, first
otherwise, a zone at a cloud's own DNS included. Every cloud of
`sitesolide machine` stays.

**What `sitesolide upgrade` brings**: nothing of its own. The change is the
CLI's alone: no component of the machine changes with it, and Caddy is not
reloaded for it.

**What stays by hand.** A machine set up with one of those providers names it
in its configuration, `"dns"` in `config.json`, and goes on serving: Caddy
keeps the module it was built with, `/etc/caddy/cloudflare.env` that
provider's variables, and `/etc/caddy/tls-zone.caddy` its DNS challenge,
which neither `upgrade` nor `deploy` touches, so the wildcard keeps renewing.
`sitesolide setup` and `sitesolide init`, which read the name again, refuse
it, saying the way out. Move the machine to one of the two from the
workstation that set it up:

- to Cloudflare, once the zone's DNS is there, its name servers at the
  registrar being Cloudflare's, with a token made as
  [dns/cloudflare.md](dns/cloudflare.md) says:

  ```bash
  read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
  sitesolide setup <user@host> --zone <zone> --email <address> --dns cloudflare
  ```

- or to records made by hand, wherever the zone is, each name then getting
  its own certificate, see [setup.md](setup.md#dns):

  ```bash
  sitesolide setup <user@host> --zone <zone> --email <address> --dns manual
  ```

Either run adds what the new way needs, Cloudflare's module and token or
nothing, lays the new policy, restarts Caddy with it, and only then takes the
old provider's variables out of `/etc/caddy/cloudflare.env`; the
configuration records the choice. Revoke the old provider's credentials at
its console afterwards: nothing reads them any more. Caddy keeps the old
module in its build, unused.

**Going back.** The previous binary takes the provider again, its pages in
`docs/dns/` with it.

## Audience removed

**What the release brings.** The dashboard no longer has an *Audience*
section, and the platform no longer ships `analytics`: every project already
measures its visits with the tool it chose, and a second count that nobody
read cost a service, a port and a write as root every minute. The collector
no longer copies a snapshot from `analytics` nor writes it a host table, the
Site panel of a site's Overview loses its *Audience* line, and a bookmark to
`/site/audience/` opens the site's Overview. Port 3029 and the slug
`analytics` are no longer kept for the platform.

**What `sitesolide upgrade` brings**: the dashboard and the collector.
Caddy is not reloaded.

**What stays by hand.** A machine that deployed `analytics` keeps running
it, now listed among the owner's sites rather than under *Platform*, with
its database of visits. Take it off once nothing reads it any more, and
remove the `<script>` tag pointing at `analytics.<zone>/a.js` from the
measured sites first, or their pages keep asking for it:

```bash
sitesolide remove --confirm analytics
```

**Going back.** `sitesolide upgrade` with the previous binary brings the
section back; `analytics` itself is deployed again from that release's kit.

## Fewer badges on a site's Services

**What the release brings.** A line only declared no longer carries the
name of the variable that declares it on the canvas: its dashes already say
it is declared, and its sheet still names the variable. A badge that finds
no free place along its line, when a card is hovered, is left out rather
than laid over a card or another badge.

**What `sitesolide upgrade` brings**: the dashboard alone. Caddy is not
reloaded.

**Going back.** `sitesolide upgrade` with the previous binary.

## Who talks to whom, on a site's Services

**What the release brings.** A site that runs services has a Services
section beside its Overview: a canvas of its services, Railway's way,
visitors coming in through Caddy on the left, the services inside the
project's walls, what leaves the machine on the right, the egress proxy with
its hosts and the connectors. A line between two of them is a connection the
machine saw, open at the last reading or earlier in the week, or a port a
sibling names in its `env` or its `start`, declared and not seen yet. A
service's card says its kind, its port, its state when it is not fine and
what it holds; pressed, its sheet lists its connections, each way, and how
sure each is. Cards drag where you want them, and stay there in your
browser. A service's memory reads the same everywhere now, the Sites list's
ring against its limit and the figure, on the Overview and in its Services
table as on the canvas.

**What `sitesolide upgrade` brings**: the dashboard, and with it the
collector's script, which now also asks `ss` for the connections open on
the loopback once a minute, and the unit of each process that opened one.
Its unit does not change. Caddy is not reloaded.

**What changes for you.**

- **Every role that opens a site's Overview opens its Services**, a Viewer
  included: what it shows is the Overview's services, drawn.
- **The first map shows only what `sitesolide.json` declares**, and says so,
  until the collector's first pass after the upgrade, a minute later; a
  connection made between two passes shows once a pass falls on it, and is
  remembered for a week.

**Going back.** `sitesolide upgrade` with the previous binary. The links the
collector remembered stay in the dashboard's reading, which the previous
release ignores.

## The bare domain, a project's domain

**What the release brings.** The bare domain and its `www` had a block of
their own in the Caddyfile, which served `/srv/sites/<zone>/public`, a folder
no command writes, and relayed `/api/*` to port 3000, the contact form of a
landing that has since become static. An installation had no way to put
anything there. The bare domain is now a domain like a client's: the project
that declares it, `"domain": { "name": "<zone>" }` then `sitesolide domain
--activate`, serves it, a static site or an app (see
[the manifest's `domain`](manifest.md#domain)). Until one does, it answers 404,
as it did on a fresh machine. `www.<zone>` sends to it with a permanent
redirect, the path kept, and serves nothing.

Its certificate is obtained on demand at the first visit, as a client
domain's: over HTTP-01 or TLS-ALPN-01 on a machine served directly, over
DNS-01 with the zone's own token behind a Cloudflare Tunnel. It is no longer
under the zone's policy: the ask endpoint allows the zone and its `www`
whatever that policy.

**What `sitesolide upgrade` brings**: the shared service, whose ask endpoint
allows the bare domain, before anything deposits the new Caddyfile, the
dashboard's deployment being the first that does: the upgrade now runs it
right after the steward, so that the endpoint allows what the new Caddyfile
asks for. `bin/deploy-caddy.sh` checks it too, whoever runs it: it does not
deposit this Caddyfile over a shared service that refuses a bare domain a
project declares. The monitor and the
dashboard read the bare domain as the project's that declares it.

Behind a Cloudflare Tunnel, `sitesolide domain --activate` on the bare domain
no longer expects the connector's 502 a client's domain answers before its
activation: Caddy answers the zone and its `www` already, and the check passes
when the machine, asked on its loopback, answers what the edge relays.

**Before it, on a machine whose bare domain serves a folder named after the
zone**, a landing laid by hand: `bin/deploy-caddy.sh` stops before any write
that would deposit this Caddyfile, since it would leave that folder unserved,
and the upgrade stops with it, at the dashboard, whose deployment is the first
to deposit it. So does the deployment of any app with this release's CLI, for
the same reason: a static site's deploys, which deposit no Caddyfile, go on.
Make the site a project first:

1. Give it a manifest that declares the zone, a static site's for instance:

   ```json
   { "slug": "home", "publicDir": "public", "domain": { "name": "<zone>" } }
   ```

   A slug of your choice, not `landing`. Deploy it: `sitesolide deploy`. Its
   preview answers at `https://home.<zone>`.

2. Switch its domain on: `sitesolide domain --activate`. The table now routes
   the zone to `home`. The Caddyfile in service still serves the old folder
   on the bare domain, so nothing a visitor sees changes yet.

3. Run `sitesolide upgrade`. The shared service first, then the dashboard,
   whose deployment deposits the Caddyfile: it finds the zone declared and
   allowed, and deposits; its verification queries the bare domain, which now
   answers from `home`, and its `www`, which sends there.

4. Once it answers, remove the old folder, and what served the old landing
   beside it, by hand: its unit if it had one, its secrets' files, and its
   `data/`, which may hold what visitors sent.

## A second block of service ports

**What the release brings.** Every server listened on a port of 3000 to
3099, the one block the loopback rule closed. With the landing's, the shared
service's and the platform's own ports taken, a machine held fewer than a
hundred of them, and a project with a database takes two: at about 100 MiB
an app, a machine ran out of ports long before it ran out of memory. A
second block, 21000 to 29999, adds nine thousand. The first stays as it is:
every manifest and every unit in service keeps its port, and `deploy` still
gives the lowest free port of the first block while one is left there, then
of the second.

Why there. Not right after 3099: the egress proxy's 3128 and 3129 sit there,
and Caddy's admin API on 2019 below, each outside the blocks on purpose, with
rules of their own. Not from 20000: a machine behind a Cloudflare Tunnel
serves the connector's metrics on 20240, which the monitor reads as its own
account, and cloudflared takes 20241 to 20245 by default. And below 32768,
where Linux's ephemeral ports begin, so that no outgoing connection ever
takes one of its ports as its source.

**What `sitesolide upgrade` brings**: the components that read a manifest or
write a unit, rebuilt with both blocks. The backups, whose backup commands
listen on neither block; the steward, which hands a token's project a port of
either; the dashboard and the portal, whose own units gain the line; the
installer, which writes it into every unit of a token's deployment, and
refuses a port of the second block until the machine has opened it; the
monitor, with one more check, below. The backups and the installer carry a
mark of their bind lines, which `backup.js features` and `installer.js
--features` print, and which the machine is searched for before the block
opens. Caddy is not reloaded, and the loopback rule does not move: the second
block stays shut until the two steps below.

**Then by hand, in this order**, once `sitesolide upgrade` has run to its
end:

1. **Write every project's units again**, so that each gains
   `SocketBindDeny=21000-29999`:

   ```bash
   sitesolide refresh --all
   ```

   A unit the previous release wrote is recognised as the generator's own,
   replaced without `--force`, and its project restarted. One kept as edited
   by hand is listed in the summary: `sitesolide deploy --force` in its
   project's folder, or the line added by hand, then `systemctl
   daemon-reload` and a restart of the unit, the line holding nothing until
   both. The landing's unit, which no deployment writes, is not refreshed: if
   it runs as a `site-` account, add the line to it the same way. Check, as
   systemd has the units loaded:

   ```bash
   ssh <server> 'for unit in /etc/systemd/system/*.service; do [ -f "$unit" ] || continue; case "$unit" in *@.service) continue ;; esac; name=${unit##*/}; systemctl show -p User --value "$name" | grep -q "^site-" && ! systemctl show -p SocketBindDeny "$name" | grep -qx "SocketBindDeny=21000-29999" && echo "$name"; done'
   # -> nothing printed
   ```

2. **Lay the loopback rule again**, with both blocks, from a checkout or from
   the kit the binary unpacked:

   ```bash
   bin/deploy-loopback.sh close
   ```

   It reads the machine first and lays nothing while a unit that runs as a
   project's account, as systemd has it loaded, lacks a line, while the
   backups or the installer predate this release, or while something already
   listens on a port of the second block that no project declares, or that
   another account holds, named down to its process and unit: a scheduled run
   started under a unit of the previous release, up to 24 hours long, keeps
   its socket through `refresh` and any reload. Stop it, or wait for its end.
   A `systemctl` that fails or answers for fewer units than there are files
   reads as nothing, and nothing is laid. Then it lays
   `/etc/sysctl.d/90-sitesolide-service-ports.conf`, which keeps both blocks
   out of the ports the kernel hands out by itself, what the machine already
   reserved carried over, applies it, and lays nothing more while the kernel
   could still hand one out. Then the rule, verified as it always was, and
   also for the services' lines with both blocks, the previous rule restored
   otherwise. `observe` lays it all the same, but opens nothing: every
   account may still connect there. Check:

   ```bash
   ssh <server> 'sudo nft list table inet sitesolide_boucle | grep -m1 "ct state new"; cat /proc/sys/net/ipv4/ip_local_reserved_ports'
   # -> oifname "lo" tcp dport { 3000-3099, 21000-29999 } ct state new counter packets ... reject with tcp reset
   # -> 3000-3099,21000-29999
   ```

**Why this order.** The loopback rule judges who connects to a port, never
who listens on it: that is each unit's `SocketBindDeny=`. A unit of the
previous release denies 3000 to 3099 and no port of the second block, so its
project may listen on any of them; so may a backup command or an `install`
run by a component of the previous release. Were a port there given to
another project, the older one could take it first, between two restarts of
its owner or at boot, and Caddy would send it that project's visitors, their
cookies and the owner's password typed on its sign-in page. Were the rule not
to refuse other accounts there, every account could connect to the service
past its portal. And `SocketBindDeny=` sees only the port a program asks
for: a bind to port 0, or a listen without bind, gets one the kernel picks,
in a range that a machine whose ephemeral ports were widened would share
with the blocks.

**What the code holds, and what it can only say.**

- `bin/deploy-loopback.sh` lays no rule, the second block's or any other,
  while a unit that runs as a `site-` account lacks a bind line, read with
  `systemctl show` as systemd has it loaded, its drop-ins and a file not yet
  reloaded included; while the backups or the installer lack the mark of
  this release's bind lines; or while the kernel could hand a port of a block
  out by itself.
- `sitesolide deploy`, before anything is pushed, and the installer, for a
  token, read all of it again at every deployment that declares a port of
  the second block, and the loaded rule must refuse other accounts there,
  which neither a rule from before nor one in `observe` does; nor may
  another account already listen on the port, open block or not. Anything
  missing, the deployment is refused, `the server has not opened the second
  block of service ports` over SSH, `second-block-closed` through a token,
  naming what is missing and the steps above. A read that fails or comes back
  cut is no answer: a port of the second block is refused, one of the first
  deployed with a warning. Nothing is remembered.
- **What no check can hold**: a CLI of an earlier release, on another
  workstation or in an agent's hands, still deploys, and writes a unit without
  the line; `--force` with one strips it from a unit in service. The block
  being open, such a unit could take the port of a project already there. It
  is said, not prevented: every deployment of an app over SSH or with a token
  reads the machine and warns, naming the unit, and the monitor reports it as
  critical, the heartbeat failing with it (`monitor/README.md`). `sitesolide
  refresh --all` writes it again. A port of the second block taken by a
  stray socket is reported the same way, and refused to the next project.
- A port of the first block asks nothing of the sort, on any machine.

**What changes for you.**

- **A port of 21000 to 29999 is accepted** in `sitesolide.json`, at the top
  level and under `services`, and deploys on a machine that has opened the
  second block. A port between the blocks, 3100 to 20999, or from 30000 up,
  is refused, as any port outside 3000 to 3099 was.
- **A machine whose first block is full** gives the next app 21000, then
  21001. Before the steps above, the deployment that gets it is refused, the
  port written into `sitesolide.json` all the same: it deploys once the block
  is open, or set a port of the first block by hand.
- **Every unit gains one line**, `SocketBindDeny=21000-29999`, and so do a
  backup command's run and the installer's runs of `install`: a service, a
  worker or a command that listened on a port of that block, where nobody was
  sent, now fails with `EPERM`. Declare a service of its own, with its port
  there.
- **Every deployment of an app reads the machine once more**, one SSH round
  trip, and warns, the deployment going on, when the block is open and a unit
  may listen in it again.
- **The monitor checks where the projects may listen**: every unit that runs
  as a `site-` account, as systemd has it loaded, keeps every bind line it
  should, and nothing listens on a port of the second block that no project
  declares, or that another account holds. Critical once the second block is
  open, and then it fails the heartbeat too, the one channel that pages on a
  machine without a webhook; a warning before, which does not, for a unit
  that lacks one of the earlier lines, from before the bind lines or edited
  by hand, which nothing reported until now. It now reads each project's
  `sitesolide.json`, 0644, when a port of the second block is listened on.
- **The kernel's reserved ports** gain both blocks, written into
  `/etc/sysctl.d/90-sitesolide-service-ports.conf`. A program on the machine
  that counted on the kernel handing it one of those ports by itself gets
  another; asked for by name, a port still binds as before.
- **Deploy with this release's CLI once the block is open**, from every
  workstation: an older CLI writes a new project's unit without the line, and
  reads every unit of this release as edited by hand.

**Going back.** `sitesolide upgrade` with the previous binary. Every previous
component refuses a manifest with a port of the second block: move such a
project into the first block before, its `port` in `sitesolide.json` and
`sitesolide deploy --force` in its folder with this release. The previous CLI
reads a unit with the new line as edited by hand and keeps it, and the
previous installer stops that project's token deployments on
`edited-by-hand`: `sitesolide deploy --force` in its folder, with the
previous CLI, writes it without the line. The rule with both blocks may stay,
the previous release has no use for the second; `bin/deploy-loopback.sh
close` from the previous kit lays the first block alone again. The reserved
ports stay, harmless; `bin/deploy-loopback.sh remove` of this release takes
the file away, and the kernel forgets them at the next boot.

