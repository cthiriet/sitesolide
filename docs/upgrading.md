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
| steward | `steward.js`, its unit or the portal relay's two units differ, or it started before the egress proxy's unit was last laid, or before the backups' folder existed | `bin/deploy-steward.sh` |
| shared service | the release in service differs from `api/`, file by file, or its unit does | `bin/deploy-api.sh`, before the dashboard, whose deployment is the first to deposit the Caddyfile, whose certificates its ask endpoint allows |
| dashboard | `sitesolide deploy --dry-run --compare` finds a difference: a file to send or delete, its manifest, a missing unit, its Caddy block; every new release, whose version its page names | `sitesolide deploy` in `dashboard/` |
| collector | one of its two units differs | `bin/deploy-collector.sh` |
| gatekeeper | `gatekeeper.js` or one of its templates differs, or the single template from before is still there | `bin/deploy-gatekeeper.sh` |
| installer | `installer.js`, its template or its environment file differs | `bin/deploy-installer.sh` |
| the Caddyfile | `/etc/caddy/Caddyfile` differs from the release's | `bin/deploy-caddy.sh`, which validates, reloads, verifies and restores on failure |
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
  The units a release generates reach the apps already deployed without their
  code through `sitesolide refresh --all`, see
  [commands.md](commands.md#refreshing-the-apps-units).
- **The loopback rule.** Setup lays it; a release that changes it says so in
  its notes, and `bin/deploy-loopback.sh close` lays it again, from a checkout
  or from the kit the binary unpacked into `~/.cache/sitesolide/<version>-<hash>/`.
  It changes what every service may reach, and keeps its own safety net.

A machine upgrades one release at a time: from 0.1, follow
[From 0.1 to 0.2](#from-01-to-02) first, then [From 0.2 to 0.3](#from-02-to-03),
then `sitesolide upgrade` for every release after, reading the notes below
for each, [Access: one registry](#access-one-registry) first, then
[Anyone with the code, from the dashboard](#anyone-with-the-code-from-the-dashboard).

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

## The server's own settings, on a page of their own

**What the release brings.** The heartbeat, the alert webhook, the dashboard
and portal passwords, company sign-in and the offsite copy of the backups
belong to no site, yet the only way to change them was the dashboard site's
Secrets, as variables of files named by their file. The owner now finds them
on a Server page, in the sidebar: one row per setting, its state, when a
change applies, and a Change or Set up button. The Sites page shows what is
still missing as a "Set up this server" guide with the same rows, which goes
once everything is set or skipped, and which its viewer may hide.

Each setting has a step-by-step guide: the steps to take outside, at
healthchecks.io or a bucket's provider for instance, the value typed into the
dashboard and sent to the steward as typed, the unlock asked for just in time,
then what the server makes of it. For the heartbeat, that is the monitor's
first ping after the change, which the dashboard learns from the monitor's
status, never from the file that holds the address. No file or variable name
reaches the screen, and no value is read back from the server: a field left
empty keeps what is there.

**What `sitesolide upgrade` brings**: the dashboard. Caddy is not reloaded,
and nothing on the machine changes by itself: the settings stay where they
are, in the same files.

**What changes for you.**

- **A change of the heartbeat or the webhook no longer offers a restart.**
  The monitor rereads its file every minute, and the backups read theirs at
  each run: "Save & restart" on those files said the dashboard would read
  them at its next start, which was wrong, and restarted it for nothing. A
  project's own file still offers it.
- **A save cut partway says so.** A setting made of several values, an
  offsite bucket for instance, is written one value after another: a refusal
  or an expired unlock in the middle now names what went through and what did
  not, and the unlock is asked before the first write when it would not last
  the save.
- **Hiding the guide and skipping an item stay in the browser**, as the names
  of the settings only: another browser shows the guide again.
- **Server carries a dot in the sidebar** while no heartbeat is set: nothing
  outside the machine would notice it go down.
- The dashboard site's Secrets page still lists those files, and now says
  when each of them is read.

**Going back.** `sitesolide upgrade` with the previous binary. The settings
saved from the Server page are the same variables in the same files, and the
previous dashboard reads them as it did.

## A domain switched off stops answering

**What the release brings.** `sitesolide domain --deactivate` takes a
domain out of the domain table, which stops its certificate's renewal, the
`ask` endpoint refusing it. An app's blocks for its own domain served it all
the same for as long as Caddy held the certificate it had already obtained:
measured, a domain switched off kept answering its app with a 200, on a
machine served directly as behind a tunnel. Those blocks now serve only while
the table carries the domain for that app, and answer a 404 otherwise, with
`X-Sitesolide-Domain: inactive <zone>`, the zone the machine serves, and
`Cache-Control: no-store`, on the domain and on the names that send to it.
Caddy reads the table at the reload that `domain --activate` and
`--deactivate` already do: the blocks are the same in both states. A static site's domain already stopped answering, Caddy's
nameless block finding no folder for it in the table.

Behind a Cloudflare Tunnel, `sitesolide domain --activate` lets through a
name whose certificate Caddy still holds from an earlier activation, which
it refused without `--force`: its root answers that 404 rather than the
connector's 502, and the machine, asked over SSH on its own loopback, read
only, answers it with the same header, the same zone. Another installation
the record still points at names another zone, and is refused.

**What `sitesolide upgrade` brings**: the gatekeeper and the installer, which
write an app's blocks with this release's generator, and the dashboard, which
carries its copy. Caddy is not reloaded, and nothing changes for the projects
by itself: an app's block takes the new form when it is next written, by
`sitesolide deploy`, by a change of its access from the dashboard or
`sitesolide lock`, or by a token's deployment, none of which needs
`--force` for it.

**`sitesolide upgrade` first, then the apps.** A gatekeeper or an installer
from before takes the new block for one edited by hand: it refuses to change
the site's access with "redeploy the site first", which deploying again
cannot fix, and refuses a token's deployment of it. Deploy an app with the
new CLI only once the machine is upgraded.

**Then each app that serves its own domain**, or declares one, when traffic
allows: `sitesolide deploy` in its folder. It says the block "was written by
an earlier release, the current one replaces it". `sitesolide refresh --all`
does not do it: it writes the apps' units, never their Caddy block. Check:
`curl -sI https://<domain>/` answers as before for a domain switched on, and
a domain switched off whose certificate Caddy kept answers `404` with
`x-sitesolide-domain: inactive <zone>`.

**What changes for you.**

- **A domain switched off answers 404 at once**, its `www` and its aliases
  with it, rather than its site until its certificate expires, once the
  app's block is this release's. `sitesolide domain --deactivate` on an app
  whose block predates it switches all the same, and says that the domain
  keeps answering while Caddy holds its certificate, until `sitesolide
  deploy`; `--activate` says it too. `sitesolide domain --activate` switches
  it on again as before.
- **A token's deployment that adds a name to a domain switched on is
  refused**, a new alias or another name: it used to switch the whole domain
  off in the manifest, and the next regeneration of the table, run by
  anyone, would now take the live domain out at once. The deployment says
  so, `out-of-scope`; deploy without the new names, or the owner adds them
  over SSH, the DNS checked. A token's deployment that keeps the names, or
  drops some, leaves the domain as the machine has it.
- **A domain active in the manifest and missing from the table**, which the
  dashboard flags as *Not routed*, is no longer served by an app's new block
  either: `bin/generate-domains.sh` writes the table again. Its access still
  changes from the dashboard: the gatekeeper names the domain with the
  addresses that already did not answer, rather than judging its 404 and
  rolling the change back.
- **Behind a tunnel, `--force` is no longer needed** to switch on again an
  app's domain whose block is this release's. A static site's still answers
  a plain 404 there, and still needs it.
- **Hand edits inside a `handle` count.** `deploy`, the gatekeeper and the
  installer compare a `handle` whole, its lines in order, as they compare a
  `route`: a line moved out of the gate, or a block of the domain's names
  left without it, is a hand edit. No block an earlier release generated
  holds a `handle`, so none compares differently.

**Going back.** `sitesolide upgrade` with the previous binary brings back the
previous gatekeeper and installer, which take this release's blocks for
blocks edited by hand: they refuse to change the access of such a site, and
the previous `sitesolide deploy` stops on its block without `--force`.
Deploy each app on its own domain with the previous release and `--force`
first; its domain then answers again whenever Caddy holds its certificate,
switched on or not.

## What each site takes, back on the Sites list

**What the release brings.** The Sites list says again what each site takes,
without a figure on every row: a small ring of the memory its services hold
against their limit, beside the figure, amber or red near the limit; "CPU
18%" beside the name of a site that takes 15 % of the processor or more; and
a CPU sort, which the strip's Load also gives. The machine's load, memory and
disk are one quiet line at the top of the page rather than a panel. A
project that serves no page shows no access icon, and no access filter counts
it. A table no longer overflows its panel at middle widths, where its end was
cut off: it takes two lines a row sooner.

**What `sitesolide upgrade` brings**: the dashboard. Caddy is not reloaded.

**What changes for you.**

- **A site's CPU is a share of the whole processor**, on its Overview as in
  the list, the scale of the Load gauge: "30%, 1.8 of 6 cores" where the
  Overview said "180% of one core".
- **Sorting by Memory adds no column**: Memory has its own on every row.
  Sorting by CPU or by Disk adds theirs.
- **A worker or a scheduled job is no longer counted under Public** in the
  Access filter: it serves no page.

**Going back.** `sitesolide upgrade` with the previous binary.

## A calmer dashboard, in the site's look

**What the release brings.** The dashboard, the portal's sign-in page and the
door page of locked previews take the look of sitesolide.fr: its mineral
paper, its teal accent, and in the dashboard Hanken Grotesk and IBM Plex Mono.
The dashboard also shows less at a time: one line per site, token, person,
connector or snapshot; the details of a token, a person, a connector or an
event in a side sheet; and each page's history in Activity, which a History
link in the page's header opens filtered. Sites are filtered by access and by
kind. What is fine says nothing: a site in trouble says so in its row, in a
word.

**What `sitesolide upgrade` brings**: the dashboard, with its steward and
gatekeeper, the portal, and the monitor. Caddy is not reloaded for them.

**What changes for you.**

- **The password is asked when you press a change.** The "Unlock changes"
  buttons are gone: a button that changes something carries a small lock while
  the dashboard is locked, and pressing it asks for the dashboard password,
  then does what it says. While unlocked, the header says so, with the minutes
  left and a way to lock again.
- **Each page's history moved to Activity.** Tokens no longer lists recent
  deployments and token activity, and Secrets, Backups and Connectors no
  longer carry an activity panel: their History link opens Activity filtered
  on them, and a token's last actions are in its sheet.
- **A site's resource figures moved to its Overview.** The Sites list no
  longer shows CPU, memory or size in every row; sorting by Memory or Disk
  brings that figure back as a column.
- **A secret the manifest names and the store lacks is now an issue**: a
  warning on the site's row, counted by the sidebar and the verdict, as it
  already was on the site's Secrets page. The dashboard learns the names from
  the steward's listing of the stores, never a value.
- **A failed backup run reads as a warning everywhere**, on the home and on
  the site's Backups page, as the monitor already rated it.
- The door page of a site already locked keeps its old look until the
  gatekeeper next acts on that site, a new code or a change of access.

**Going back.** `sitesolide upgrade` with the previous binary.

## A site's own domain behind a Cloudflare Tunnel

**What the release brings.** A machine served through a Cloudflare Tunnel
serves a site's own domain whose zone is at Cloudflare in the tunnel's own
account. `sitesolide domain --activate` no longer refuses there: it checks
that Cloudflare's edge serves every name the domain table adds, and lists the
proxied CNAMEs to the tunnel when one is missing. Caddy certifies the domain
through the DNS-01 challenge with the machine's own Cloudflare token, Let's
Encrypt behind Cloudflare's own certificate at the edge. The whole of it is in
[tunnel.md](tunnel.md#a-sites-own-domain).

**What `sitesolide upgrade` brings to a machine behind a tunnel**: the
tunnel's component, out of date, laid again by setup's own run.

- **The connector's configuration**, `/etc/cloudflared/config.yml`: one rule
  that hands every name Cloudflare routes into the tunnel to Caddy, in place
  of the zone's two and the 404 for any other name, and its unit, whose
  comment says so. The connector is restarted once: the sites answer 502 for
  the few seconds the edge takes to see it connected again.
- **Caddy's options for the tunnel**, `/etc/caddy/global.d/tunnel.caddy`,
  which gain a global issuer: Let's Encrypt through Cloudflare's DNS module,
  with the token already in `/etc/caddy/cloudflare.env`. Caddy is reloaded
  once. It is the issuer of the policies that name none, those of the
  customer domains, of which such a machine had none; the zone's issuer,
  which Caddy builds on top of it, comes out as it was, the global one
  holding the zone's own directive and nothing else, and its wildcard is
  not obtained again.

Nothing of this on a machine served directly: the tunnel's component is left
out of its report, and its Caddyfile is not touched.

**What the owner does for a domain**, in Cloudflare's dashboard: the proxied
CNAMEs `sitesolide domain --activate` lists, in the domain's zone of the
tunnel's account, and `Zone / Zone / Read` and `Zone / DNS / Edit` on that
zone added to the machine's token, which keeps its value; then
`sitesolide domain --activate`, from the site's folder, once `sitesolide
upgrade` has run: on a machine still holding 0.10.0's tunnel files it
refuses, since the domain would get the connector's 404.

**Going back.** A domain activated behind the tunnel is deactivated first,
`sitesolide domain --deactivate` with this release: the previous one's
connector answers 404 for it, and its Caddy would renew its certificate over
challenges that cannot reach the machine. The machine's token then needs
nothing on the domain's zone: take `Zone / Zone / Read` and `Zone / DNS /
Edit` on it off the token at dash.cloudflare.com/profile/api-tokens, which
keeps its value. Then `sitesolide upgrade` with the previous binary lays
back its connector's configuration and Caddy's options, restarting the one
and reloading the other once.

## A machine behind a Cloudflare Tunnel

**What the release brings.** `sitesolide setup --tunnel <credentials>`
installs a machine the Internet cannot reach, a box at home behind its
router's NAT or a VM on a machine that already serves something else,
through a Cloudflare Tunnel its owner created with `cloudflared`: the zone's
records point at the tunnel, a hardened connector hands every request to
Caddy over the loopback, and the firewall closes everything but ssh.
`infra/vm/install.sh` lays the machine as a walled VM on such a host. The
whole of it is in [tunnel.md](tunnel.md).

The dashboard's Sites page lists the platform's own projects, the
dashboard, the portal and analytics, under a *Platform* filter of their own,
and elsewhere only while they have an issue or a restart pending. A project
is one of them when its slug is deployed on that project's own port: an
owner's project named `analytics` on another port stays with the sites.

**What `sitesolide upgrade` brings to a machine served directly**, in its
usual order:

- **the backups**, whose copy of the machine's own state takes
  `/etc/cloudflared` on a machine that has it;
- **the dashboard**, which names the new release and keeps the platform's
  own projects under *Platform*;
- **the gatekeeper and the installer**, which write the new blocks below;
- **the Caddyfile**, laid again and Caddy reloaded once. It imports
  `/etc/caddy/global.d/*.caddy`, the tunnel's options on a machine behind
  one, nothing on a machine served directly, and hands the landing's form
  `X-Forwarded-For` as `{client_ip}`, the value Caddy wrote before;
- **the monitor**, which reads the connector on a machine that has one.

The tunnel's own component is left out of the report on a machine that has
none. No project is refreshed or restarted. A project's block now hands its
services `X-Forwarded-For` as `{client_ip}`: on a machine served directly
that is the peer's address, the very value Caddy wrote before, so the
blocks in service keep serving as they are, and the next deploy of each
project replaces its block without `--force`.

**Moving a machine in service behind a tunnel** is a run of setup with
`--tunnel`, once upgraded: the connector first, then the records, and 80
and 443 closed once resolvers see Cloudflare, so the sites answer all
along. See [tunnel.md](tunnel.md#installing-the-machine). In this release,
a customer's own domain cannot reach a machine behind a tunnel, and `domain
--activate` is refused there: [A site's own domain behind a Cloudflare
Tunnel](#a-sites-own-domain-behind-a-cloudflare-tunnel) brings it.

**Going back.** `sitesolide upgrade` with the previous binary, on a machine
served directly. A machine behind a tunnel leaves it first, as
[tunnel.md](tunnel.md#leaving-a-tunnel) says: the previous release neither
watches nor upgrades its connector, and its Caddyfile drops the options
that keep the visitor's address.

## Secrets: a project's store alone

**What the release brings.** A project's secrets live in its store alone,
`/etc/sitesolide/projects/<slug>/`. This release no longer reads a project's
flat files of `/etc/sitesolide`, and `secrets` in `sitesolide.json` takes
variable names only: a list of file names, `"secrets": ["shop.env"]`, the
form from before 0.8, is refused like any entry that is not a variable's
name. `sitesolide secrets migrate` and its `--retire`, *Merge into the store*
and *Retire* in the dashboard, and the token routes for a project's files,
`GET /api/v1/projects/<slug>/secrets` and `PATCH
/api/v1/projects/<slug>/secrets/<file>`, are gone. The dashboard's and the
portal's manifests no longer declare `secrets`: their units read
`/etc/sitesolide/<slug>.env` by themselves, and those two files, with
`dashboard-monitor.env` and `dashboard-backup.env`, are all that stays flat
in `/etc/sitesolide`. See [secrets.md](secrets.md).

**Before upgrading, with 0.8**, every project must read its store alone. For
each one whose manifest still lists file names, or whose units still read a
file of `/etc/sitesolide`, run in its folder `sitesolide secrets migrate`,
then `sitesolide secrets migrate --restart`, then `sitesolide secrets migrate
--retire`; list the variable names in its manifest, which `sitesolide secrets
--json` gives, and deploy it. Then check, names only:

```bash
ssh you@your-machine 'sudo grep -H "^EnvironmentFile=-/etc/sitesolide/[^/]*$" /etc/systemd/system/*.service'
```

Only `dashboard.service` and `portal.service` may answer.

**What `sitesolide upgrade` brings**, in its usual order: the steward, which
no longer lists nor writes a project's flat files; the dashboard and the
portal, whose manifests declare nothing and whose units stay as they are;
the installer, which no longer reads a project's flat files. The release
also simplifies the code of every component without changing what it does,
so each one is laid again, and the Caddyfile, whose comments changed, is
laid again and Caddy reloaded once. The units and Caddy blocks generated for
the projects are the same, byte for byte: no project is refreshed or
restarted. Nothing on the machine changes form.

**What changes for you.**

- **A project's flat file is read by nothing.** Deployed again or refreshed,
  a project whose units still named one loses them, and the values that file
  held with them: migrate before upgrading.
- **`sitesolide remove`** deletes the project's store and its previous
  versions, and no flat file.
- **A token may create `dashboard-notes`**, a project whose slug starts like
  a platform project's: that refusal only kept the platform's flat files
  from being attached to it by name.
- **A site no manifest describes**, the landing or a service made by hand,
  no longer has files listed in the dashboard; they stay on the machine,
  untouched, read by whatever unit names them.
- **The copies 0.8's `--retire` kept**, under
  `/var/lib/sitesolide-steward/precedents/projects/<slug>/legacy/`, are read
  by nothing: delete them by hand once the store has served without them.

**Going back.** `sitesolide upgrade` with the previous binary. The stores are
read as before, and the dashboard and the portal it deploys declare their
files again.

## The dashboard names its release

**What the release brings.** The dashboard says which release it was built
from, at the foot of its sidebar and in its menu on a phone, so that an
upgrade can be seen to have landed without a look over SSH. The dashboard, the
portal's sign-in page and the door page of locked previews draw the mark as
the landing page does: a petrol face ringed with a line over a hard shadow.

**What `sitesolide upgrade` brings**: the dashboard, the portal and the
gatekeeper, which writes the door page from the portal's template. Nothing on
the machine changes form, and Caddy is not reloaded for them.

**What changes for you.**

- From this release on, every new release redeploys the dashboard, since its
  page names the version: a restart of its service, a few seconds, at each
  upgrade.
- The door page of a site already locked keeps the old mark until the
  gatekeeper next acts on that site, a new code or a change of access.

**Going back.** `sitesolide upgrade` with the previous binary.

## Secrets: names in the manifest, values in a store per project

**What the release brings.** `sitesolide.json` names a project's secrets,
`"secrets": ["API_KEY"]`, and their values live in the project's store on
the server, `/etc/sitesolide/projects/<slug>/`: variables every service and
backup command receives at start, and files read whole at
`$CREDENTIALS_DIRECTORY/files_<name>`. `secrets.build` names what the build
takes from whoever deploys. A value is set from the dashboard, with
`sitesolide secrets set NAME`, over SSH as the owner or with a token, or
drawn on the server with `sitesolide secrets generate NAME`, and nobody but
the owner, in the unlocked dashboard, ever reads one back. See
[secrets.md](secrets.md).

**What `sitesolide upgrade` brings**, in its usual order: the steward first,
which keeps the stores, judges their routes and answers the owner's
`sitesolide secrets` over SSH; then the dashboard, whose *Secrets* section
lists each project's store, and the installer, which lays a project's store
before its units and no longer stops a deployment on a missing secret; the
backups, whose backup commands receive the store; the monitor, which words a
unit that could not load its secret files. `sitesolide upgrade --dry-run`
lists what differs. Nothing on the machine changes form: no file of
`/etc/sitesolide` moves, and no project's store exists until its next
deployment, a `sitesolide refresh` of it, or its first value.

**Every app's units change at its next deployment**, or at `sitesolide
refresh <slug>`. Each service unit of an app gains four lines: the store's
`env`; `LoadCredential=` for its `files/` folder;
`InaccessiblePaths=-/etc/sitesolide`, which hides the folder from the
service; and `ProtectProc=invisible`, which hides the processes of other
accounts. A unit 0.7 or an earlier release wrote is the generator's own and
is replaced without `--force`, and so is one the generator made from the
manifest the previous deployment left on the machine. One edited by hand
stays as it is, and says so. The dashboard's and the portal's units do not change:
their password hashes stay in their own files, and they have no store.

**Before upgrading, on the machine**, names only, never a content:

```bash
ssh you@your-machine 'sudo find /etc/sitesolide -mindepth 1 -maxdepth 2 | sort'
```

Check there that no service reads a file of `/etc/sitesolide` by its path:
the folder becomes invisible to every service at its next deployment. Check
also that nothing is already named `projects`.

**What changes for you.**

- **A missing secret no longer stops a deployment.** A declared name the
  store lacks is asked for at a terminal, and warned otherwise. A missing
  build secret stops it, before anything is sent.
- **A project that declared files** moves to its store before a later
  release, see [Secrets: a project's store alone](#secrets-a-projects-store-alone).
- **The build gets a clean environment.** It inherits only what locates things
  and the toolchains from yours, `PATH`, `HOME`, `LANG` and their kin; a
  variable it read from your shell, a proxy or a registry's token, now goes
  under `secrets.build`. `NODE_ENV` from your shell no longer reaches it, and
  the manifest's project `env` now does.
- **`env` refuses a value that starts like a provider's key**, `sk_live_...`,
  whatever its name, and accepts a name with a framework's public prefix,
  `NEXT_PUBLIC_STRIPE_KEY`, which it used to refuse.
- **Only the owner reads a value back.** An Admin of a project no longer
  reads one: their dashboard shows every value write-only.
- **`sitesolide secrets` works over SSH**, as the owner, for every app but
  the dashboard and the portal, and with a token it changes any name of the
  project's store. A static site has no store:
  its build secrets stay with whoever deploys.
- **`sitesolide run`**, for a project whose manifest lists names, reads
  `~/.config/sitesolide/secrets/<slug>.env` with a strict parser and never a
  shell: `export A=b` or a space around `=` stop it, with the line number,
  and `$(...)` is a value taken as it is, never run.
- **A name a token holds stops your deploy.** A token's deployment accepted,
  or its write that made a project's store ahead of one, holds the name,
  and so does a creation that made the token Admin of a project the machine
  carries: `sitesolide deploy` over SSH stops on such a name, naming the
  token, before it asks for any value, and `sitesolide deploy --adopt` takes
  the name back, what the project's store held moved aside and named, then
  deploys. Your first `sitesolide secrets set` into a store a token's write
  made ahead takes it back the same way. A deployment of the token's under way is
  waited for. A steward from before claims holds none; claims that do not
  read stop it unless `--adopt`, and are restored from the steward's
  backups, never deleted.

**Whoever works with a token installs the new CLI.** A CLI from before 0.8
refuses a manifest that lists names before anything is pushed. The new CLI
facing a steward or a dashboard not upgraded yet stops before anything is
sent: upgrade the machine first.

**Going back.** `sitesolide upgrade` with the previous binary. The values in
the stores stay on the machine, unread by the previous steward and dashboard;
a unit written by this release still reads its store until it is written
again, which the previous CLI does only with `--force`, reading the new lines
as edited by hand. A project whose manifest already lists names cannot be
deployed by the previous CLI.

## Machines from eight clouds, and any domain

**What the release brings.** `sitesolide machine` orders the machine from
Hetzner, DigitalOcean, AWS, Google Cloud, Azure, Scaleway, Vultr or Akamai, and
`sitesolide setup` typed alone at a terminal asks rather than takes options.
`setup --dns` names who serves the zone: eleven providers through their APIs,
or `manual`, records made by hand and a certificate per name, which works with
any registrar. See [machine.md](machine.md) and [setup.md](setup.md#dns).

**The Caddyfile no longer says how the zone's certificates are obtained.** Its
`(tls-zone)` snippet held Cloudflare's DNS challenge inline; it now imports
`/etc/caddy/tls-zone.caddy`, a file of the machine that `sitesolide setup`
lays from the DNS it is given, a provider's DNS challenge or, with manual DNS,
a certificate per name on demand. See
[infra/README.md](../infra/README.md#the-zones-tls-policy).

**What `sitesolide upgrade` brings**: the Caddyfile, out of date, goes through
`bin/deploy-caddy.sh`, which finds the file missing on a machine that holds a
Cloudflare token and lays Cloudflare's policy, root:root 0644, inside its
transaction: after the backup, before the Caddyfile that imports it, then
validated, reloaded and verified with it, and taken away again by the restore
if anything fails. The policy is the block the Caddyfile carried, to the byte:
Caddy adapts the new Caddyfile with it to the configuration it ran before,
which `bin/tests/cli-tls-caddy.test.ts` checks in a real Caddy against the
Caddyfile of 0.6.4. The one difference is Caddy's own, the new file added to
the paths its file servers hide. The shared service is redeployed too: it
reads the same file, and on a zone with a DNS provider it refuses the zone's
names exactly as before. Nothing else changes: the same certificates, the
same token in `/etc/caddy/cloudflare.env`, no restart of Caddy, and
`sitesolide setup` run again finds the file it would lay.

**What changes for you**: nothing, unless the machine has no Cloudflare token.
`bin/deploy-caddy.sh` then stops before any write, saying the file is missing:
`sitesolide setup` lays it. A hand edit of the file is overwritten by the next
setup that finds it different; the file is the zone's policy, not a place for
settings.

`sitesolide setup`, run again on a machine an earlier release set up, finds
three steps it did not have: Caddy's DNS credentials, the policy file, and no
other provider's credentials left in `/etc/caddy/cloudflare.env`. On a machine
upgraded first, all three are done and nothing changes. Its Caddy step now
waits five minutes at most for Caddy's build service, then builds Caddy with
the DNS module on the machine itself.

**Going back.** The previous release's Caddyfile carries the policy inline and
ignores the file, which stays harmlessly in `/etc/caddy`.

## An app's port stays in the range the loopback rule closes

**An app's top-level `port` could be any port from 1024 to 65535.** The
loopback rule lets only Caddy and the project itself reach 3000 to 3099; an
app listening on 8080 was reachable by every other project of the machine,
past its portal or its code. The ports of `services` were already held to the
range, and `deploy` only ever chose ports inside it, so only a port written by
hand could be outside. `validate()` now holds the top-level `port` to 3000 to
3099 too.

**What `sitesolide upgrade` brings**: the components that read a manifest,
rebuilt with the rule, the installer and the dashboard among them. Nothing on
the machine changes form, and a project outside the range keeps serving as it
did.

**What changes for you**, only if a project listens outside the range:

- `sitesolide refresh --all --dry-run` names it, refused, with the reason.
- `deploy`, `refresh`, a token deployment and the dashboard's *Access* section
  refuse it until it moves.
- To move it, set `port` in its `sitesolide.json` to a free port of the range,
  or leave the key out and `deploy` picks one, then run
  `sitesolide deploy --force` in its folder: the port of its unit and of its
  Caddy block changes, which `deploy` otherwise reads as files edited by hand.
  `sitesolide deploy --dry-run --compare` first lists what it would replace.

**Going back.** `sitesolide upgrade` with the previous binary; a project moved
into the range stays valid for it.

## A static site's `headers` are refused

A static site has no Caddy block of its own, and the shared blocks that serve
it never wrote the `headers` its manifest declared: they were accepted and
ignored. `validate()` now refuses the key without `start`. A static site that
declares it is refused by `deploy` and by its *Access* section until the key
is taken out, which changes nothing it serves.

## Every app filters its system calls

**An app could make any system call its account was allowed.** The
platform's own services ran under systemd's `@system-service` filter; the
units generated for projects did not, so a compromised app reached every
call of the kernel, the ones that trace a process, mount or load a module
included, and any flaw of the kernel behind them. Every generated service
unit now carries `SystemCallArchitectures=native`,
`SystemCallFilter=@system-service` and `SystemCallErrorNumber=EPERM`: a call
outside the set fails with `EPERM`, the process goes on.

**What `sitesolide upgrade` brings**: the installer, with the new generator,
so that a deployment by token writes the same unit as one by SSH; and the
dashboard and the portal, deployed as projects, whose units take the filter
then. Every other app takes it at its next deployment. A unit 0.6 or an
earlier release wrote is the generator's own and is replaced without
`--force`; one edited by hand stays as it is, and says so.

**Every app at once, without sending its code**: `sitesolide refresh --all`,
after the upgrade, gives every app on the machine the filter, and the port
rules too to an app last deployed before 0.6.0. It writes each project's
units again from the manifest its last deployment left on the machine,
restarts its services and checks them as deploy does, one project at a time,
and stops at the first that does not hold. `sitesolide refresh --all
--dry-run` first lists the units it would write; see
[commands.md](commands.md#refreshing-the-apps-units).

**What changes for you.** Nothing for a server in Bun, Node, Python or Go.
Each was deployed under the filter on a Debian 13 machine on x86_64, Bun
1.3.14 and 1.4.3, Node 20, Python 3.13 and Go 1.24, serving, writing its
data, starting a child process, a thread or a worker. One call was refused:
Node asks for memory protection keys as it starts (`pkey_alloc`), which
systemd's default action would have answered by killing it, and which
`EPERM` turns into a Node that goes on without them. A program that needs a
call outside the set, a profiler that traces, gets `EPERM` and says so in its
own error; give it that call in a drop-in, see
[Isolation](concepts.md#isolation).

**Going back.** A drop-in holding `[Service]` and an empty
`SystemCallFilter=` lifts the filter from one unit. The previous release's
`deploy` reads a unit with the filter as edited by hand and leaves it, unless
run with `--force`.

## One project holds its share of the egress proxy

**One project could take the egress proxy down for every other.** The
connectors' port counted no connections, read an answer as fast as its
upstream sent it whether the app read it or not, and read a body as fast as
the app sent it whatever the upstream took: thousands of idle connections from
one project, one large answer read slowly, or 32 bodies to a slow upstream,
ran the proxy out of descriptors or of memory, and every project's egress and
connectors with it. The connectors' port now runs on the same raw listener as
the CONNECT port, counts its connections with it, and streams both ways under
the same byte budgets. A review of the rewrite closed what it brought or kept:
a body in one-byte chunks cost the heap twenty times what the budgets counted,
an upstream connection given up on stayed open, a `TRACE` went up with the
credential the proxy adds and came back echoed, a `GET` or a `HEAD` carried a
body an upstream could read as a second request, and a header byte past ASCII
was sent twice encoded, on both ports.

**What `sitesolide upgrade` brings**: the egress proxy alone, the steward
restarted after it as always. Nothing else moves, and nothing on the machine
changes form: the connectors, the grants and the audit are read as they were.

**What changes for you.** Nothing, unless an app calls a connector:

- **A connector call is one connection**, answered `Connection: close`, with a
  TLS connection of its own upstream, whose certificate is checked against the
  connector's host name. A project's connections count against its 128 on
  both ports together. A call is refused 503 past its project's 32 under way,
  counted until the last byte of its answer and no longer its headers, past
  the proxy's 256, or while its project or the proxy holds too many bytes
  nobody has read; an answer whose head does not come within 30 s is a 504,
  no longer a 502.
- **An answer reaches the app as the upstream sent it**, compressed only if
  the app's own client asked with `Accept-Encoding`, as Bun's `fetch` does and
  decodes.
- **Refused**: HTTP/1.0, 505; a request with both `Content-Length` and
  `Transfer-Encoding`, 400; `TRACE`, `TRACK` and `CONNECT`, 405. A `GET` or a
  `HEAD` goes up without a body.

**Going back.** `sitesolide upgrade` with the previous binary puts the previous
proxy back; nothing it reads changed.

## What a project, a token or a cloned folder could reach

A review of the whole platform found ways past its boundaries, and this
release closes them. None took more than what the platform hands out on
purpose: an app deployed on the machine, a token, a repository someone cloned
and deployed over SSH, a page on a sibling subdomain.

**Every app could read every preview code.** The gatekeeper wrote the preview
locks' fragment, `/etc/caddy/locks/verrous.caddy`, readable by every account,
with every code in force in the clear, and a project's service sees
`/etc/caddy`. The fragment is now root's and Caddy's group's, `0640`. Any
code drawn before this release may have been read by any project: draw each
again, below.

**An app could listen where others are sent.** The loopback rule judges who
connects to a port, never who listens on it. An app could wait on the
portal's port while the portal restarted, during an upgrade, and answer every
sign-in check as it liked; on the egress proxy's ports, it read every
project's outgoing calls. Every generated unit now lets a server listen on its
own port alone among Caddy's admin API, 2019, the range 3000 to 3099 and the
proxy's 3128 and 3129, and a worker or a scheduled service on none of them
(`SocketBindAllow=`, `SocketBindDeny=`); a service's backup command, the
manifest's `install` and the extraction of a token's archive too. The
slug `public` is refused as well: a request for `.<zone>`, an empty first
label, landed in the folder a project of that name would have, its manifest
and its code served past its portal.

**A cloned repository deployed over SSH could reach the machine's files.**
`deploy` now refuses, before anything is pushed:

- **a `publicDir` that is a link out of the repository**, which sent
  `~/.ssh` and served it to anyone;
- **a link among the public files that leads out of them**, which Caddy
  follows on the machine: `robots.txt -> /etc/caddy/cloudflare.env` served the
  zone's DNS token.

**A token could do more than its scope said.** Its deployment could switch the
project's domain on, which `sitesolide domain --activate` does only after
checking the DNS: the machine's switch now stands. It could create a project
under the name of one removed and inherit what the machine still keeps under
that name, the snapshots its creator then restores as Admin and the connector
grants: no token creates such a name now, `reserved`. Its refused changes of
access went to the journal unbounded, and pushed out every change of secrets
made in the hour; its accepted ones could fill the access log, which then
lets nobody more in for 180 days but the owner over SSH. Both are bounded
now. An expired token still counted toward the 200 live ones, so that tokens
a second long stopped everyone minting. And the CLI sent its token to
whatever address `SITESOLIDE_API` named: it now sends the token it keeps to
the dashboard `login` checked it against, and nowhere else.

**Smaller ones.** A WebSocket opened from a sibling subdomain reached a
restricted site with its visitor's cookie: the portal now wants the site's
Origin on a handshake, a GET though it is. Signing in with password access
cleared the failures counted against the owner's password; a sign-out minted a
ticket for anyone who posted, which signed out of the portal whoever opened
it. The dashboard could be framed by a page on another subdomain, read a
sign-in body of any size, and the collector, root, followed a link at the
place of the dashboard's previous snapshot. The settings file of the backups,
written from the *Secrets* page, could name the program root runs as restic.
A connector's request body sent in chunks went past its 10 MiB, and a call
whose app hung up kept its answer streaming into the proxy. A value with a
Unicode noncharacter made systemd drop every variable of its file; a secret
file created under the name of an earlier one kept that one's previous
version; a project deployed over SSH as `dashboard-backup` listed the
backups' keys in its own *Secrets*; a token's label could carry a terminal
control. Each is closed, and each component's README says how.

**What `sitesolide upgrade` brings**, in its usual order: the backups, whose
settings file no longer moves root's programs or folders, the zone read after
it, and whose service backup commands listen on none of the machine's ports;
the egress proxy, which counts a connector's body as it streams and lets an
upstream go when its caller hangs up; the steward, which keeps from every
token the name of a removed project the machine still keeps snapshots or
grants of, bounds a token's changes of access, counts live tokens alone,
refuses the labels and the values above, creates a secret file with no
previous version, keeps the machine's files to the dashboard, and reads the
portal's answer within a bound; the dashboard, with its sign-in body bounded,
its pages refusing to be framed, the collector's new reading, and its own unit
with the bind lines; the gatekeeper, which writes the fragment `0640` to
Caddy's group, and whose script closes the one in place; the installer, which
keeps the machine's domain switch and writes the bind lines, its runs of
`install` and of the extraction listening on none of those ports; the shared
service, whose only change is a comment of `src/locks.ts`; the portal, with
the WebSocket's Origin, the sign-out ticket, and the failures it keeps until
the owner signs in or a quiet day passes; the monitor, whose unit reads the
zone after `dashboard-monitor.env`, so that a `SITESOLIDE_ZONE` written from
*Secrets* never points its probes elsewhere. Caddy's drop-in, the collector's
units, the Caddyfile and the loopback rule do not move. No file
on the machine changes form: `team.json`, the access registry and its log, the
secret files and the backups' index are read as they stand.

**Then by hand, once**, after `sitesolide upgrade` has run to its end:

1. **Check the preview locks' fragment.** The gatekeeper's script, which
   upgrade runs, gives it to Caddy's group and closes it; a machine that never
   opened a site with a code has none.

   ```bash
   ssh <server> 'sudo stat -c "%U:%G %a" /etc/caddy/locks/verrous.caddy'
   # -> root:caddy 640
   ```

   Anything else, `644` from an upgrade stopped before the gatekeeper, is
   closed by hand, the group first, so that Caddy never meets the file closed
   to it. Nothing reloads, nothing served changes:

   ```bash
   ssh <server> 'sudo chgrp caddy /etc/caddy/locks/verrous.caddy && sudo chmod 0640 /etc/caddy/locks/verrous.caddy'
   ```

2. **Draw a new code for every site opened with a code.** Every project could
   read the old ones. The sites whose general access is *Anyone with the
   code*:

   ```bash
   ssh <server> "grep -lE '\"lock\": *true' /srv/sites/*/sitesolide.json"
   ```

   For each, *New code* in its *Access* section, under the unlock, or
   `sitesolide lock --new-code` in its folder; then send the new link to
   whoever should still have it. The old link stops opening the site at once.

3. **Deploy every app again**, so that its units gain the bind lines:
   `sitesolide deploy` in each project's folder, over your SSH, or a
   deployment with its token. The dashboard and the portal are done, upgrade
   having just deployed them. A static site has no unit. A unit the previous
   release generated is recognised as the generator's own and replaced without
   `--force`. Check one:

   ```bash
   ssh <server> 'systemctl cat <slug> | grep -c SocketBindDeny'
   # -> 3, and as many in each <slug>.<name> of the project
   ```

   Deploy them after upgrade, not before: the installer from before reads a
   unit with the new lines as edited by hand, and stops that project's token
   deployments on `edited-by-hand` until the installer is upgraded.

4. **Check that systemd enforces those lines.** It does through BPF, and a
   systemd built without it ignores them without a word, the units starting
   as before:

   ```bash
   ssh <server> 'systemctl --version | grep -o +BPF_FRAMEWORK'
   # -> +BPF_FRAMEWORK; nothing printed, the lines hold nothing on that machine
   ```

5. **Check that no project is named `public`**, a name now refused:

   ```bash
   ssh <server> 'test -e /srv/sites/public && echo "a project named public" || echo none'
   ```

   One that is there serves its manifest and its code at `.<zone>` until it
   is removed. This release's CLI refuses its manifest, the `remove` command
   included: run `sitesolide remove --confirm public` in its folder with the
   previous binary, then deploy it under another slug.

**Worth a look**, reading only: the links among the deployed sites' public
files, `ssh <server> 'sudo find /srv/sites/*/public -type l -exec ls -l {} +'`.
One that leads out of its folder, which the next `deploy` of that site
refuses, had Caddy serve its target until now: change what it pointed at,
then deploy the site with the link replaced. And the names in
*Sites > dashboard > Secrets > dashboard-backup.env*: the bucket's
`BACKUP_S3_*`, `BACKUP_ENCRYPTION_PASSPHRASE`, the retention, the reserve and
the child's time, nothing else. A name you did not write there was written by whoever held the
dashboard's unlock.

**What changes for you.**

- **A changed manifest no longer needs `--force` for its block.** A block in
  service that is exactly what the manifest deposited on the machine
  generates is the generator's own, and `deploy` replaces it, as the
  installer already did for a token: `upgrade`, which never forces, would
  otherwise stop at the dashboard, whose manifest gains the headers that
  refuse framing. A block edited by hand on the machine still stops
  `deploy` until `--force`.
- **Over your SSH, `deploy` may stop on a manifest that deployed before**,
  saying which link, with nothing pushed: `publicDir leads outside the
  repository`, or `carries links that lead out of publicDir`. Replace a link
  with the file it points to. A manifest in your sites repository keeps a
  `publicDir` that leads anywhere, as its `source` already did.
- **A token no longer creates a name a removed project left things under.**
  The refusal, `reserved`, counts the snapshots and the connector grants left,
  never what they hold. Deploy it yourself over SSH, which is how a removed
  project comes back with its data; or withdraw the grants on the
  *Connectors* page and forget the snapshots by hand
  ([dashboard/src/backup/README.md](../dashboard/src/backup/README.md#a-name-a-removed-project-left-behind)),
  and a token may create it again.
- **Each app's units change at its next deployment**, without `--force`. A
  bind refused fails with `EPERM`: a server that opened a second port of the
  machine's, 2019, 3000 to 3099 or 3128 and 3129, or UDP on its own port, and
  a worker, a scheduled service or a backup command that listened inside
  that range. Declare a service of its own, with its own `port`, for what
  listens there. A port outside those stays free. A unit edited by hand
  on the machine stays as it is, without the lines, until `--force`.
- **A token's deployment keeps the machine's domain switch.** A domain it
  declares, a new name or alias, stays inactive until `sitesolide domain
  --activate` in the project's folder over your SSH.
- **The slug `public` is refused**, to the owner as to a token.
- **A token fills half of the access log at most.** Past half, what it would
  let in, Can open given or a project created, is refused `not-available`
  until older rows age out; its removals still work, and people and you are
  not held back. Its refused changes of access count among its 60 refusals an
  hour, then `too-many-attempts`.
- **Live means neither revoked nor expired**, for the 200 tokens of the
  machine as for the ten of a person.
- **A label with a control character is refused**, C1 included. A label
  minted before that carries one is printed by the CLI with `?` in its
  place, when its person leaves.
- **A value with a Unicode noncharacter is refused**, U+FDD0 to U+FDEF and the
  last two code points of every plane, from the dashboard, a token or the
  CLI: systemd would read none of the file's variables.
- **A secret file created from the dashboard has no previous version**: one
  kept under its name, from an earlier file, is dropped first.
- **A WebSocket on a restricted site needs the site's Origin.** Every browser
  sends it; a client of your own outside a browser sends it too, or is
  refused 403.
- **A site's sign-in failures** are no longer cleared by password access
  signing in, only by the owner's own success, or forgotten after 24 hours
  with none.
- **A sign-out with a provider** ends the portal's session of the person who
  signed out alone, and only the owner's ends whatever session that browser
  holds; password access is signed out of the site and sent home. A sign-out
  link opened in another browser ends nobody's session there.
- **The backups' settings file** sets the bucket, the retention and the
  reserve. A `BACKUP_RESTIC`, `SYSTEMCTL`, `SITES_DIR` or any other variable
  that moved a program or a folder is ignored under systemd, and so is a
  `SITESOLIDE_ZONE` there.
- **The dashboard refuses to be framed**, `Content-Security-Policy:
  frame-ancestors 'none'` and `X-Frame-Options: DENY`, and a sign-in body over
  8 KiB, 413.
- **A connector's request body over 10 MiB** is refused 413 as it streams,
  `body too large` in the proxy's audit, whether it announced its length or
  came in chunks.

**Whoever works with a token installs the new CLI** too, from the same
`install.sh` as step 1 above: the token's binding to its dashboard and the
prompt that no longer echoes it are the CLI's. `sitesolide login` now writes
the address it checked the token against beside it in the vault,
`team-token-api`. A vault filled by an earlier `login` holds none, and its
token goes to the `api` of the `config.json` beside the vault's folder, as
before. A `SITESOLIDE_API` or a `config.json` naming another dashboard is
refused `unauthenticated` with the vault's token: `sitesolide login --url`
again, or `SITESOLIDE_TOKEN` beside it, as in a sandbox. A vault kept
elsewhere, by `vault` or `SITESOLIDE_VAULT`, needs `sitesolide login` once
more.

**Going back.** `sitesolide upgrade` with the previous binary. The previous
gatekeeper writes the fragment `0644` again at its next change of a site's
general access or code, every code readable by every project once more. A unit
with the bind lines reads as edited by hand to the previous CLI, which keeps
it, and to the previous installer, which stops that project's token
deployments on `edited-by-hand`: `sitesolide deploy --force` in its folder,
with the previous CLI, writes it without them. `team-token-api` stays in the
vault, unread. The registry, its log and `team.json` stay as they are.

## Secrets with a token

A token may now manage secrets. Minted with *Manage secrets*, it lists its
projects' secrets and sets and removes their values, never reading one back;
any token that deploys a project also restarts it. From a workstation with a token, `sitesolide secrets`,
`secrets set`, `secrets remove` and `sitesolide restart` do it, see
[access.md](access.md#secrets-with-a-token).

**What `sitesolide upgrade` brings**, in its usual order: the steward, which
judges the new routes and keeps each token's hourly bounds; the dashboard,
with the routes, *Manage secrets* in the *New token* dialog, and *Token
activity* reading the steward's journal; the installer, whose refusal of a
missing secret now names `sitesolide secrets set`. The backups, the egress
proxy, the collector, the gatekeeper, the shared service, the portal, the
monitor, the Caddyfile and Caddy's drop-in do not move. No file on the
machine changes form: `team.json` keeps its version, and a token minted
before reads as without the permission.

**A dashboard ahead of its steward**, deployed alone or with the steward's
step failed, answers the new routes `not-available`, saying to run
`sitesolide upgrade`, and refuses to mint a token with *Manage secrets*, the
dialog saying the server's steward predates the permission. Running upgrade
to the end mends both.

**What changes for you.** One thing right away: **every token already minted
restarts the services of the projects it deploys**, a person's own while they
are Developer or Admin there, 30 times an hour at most, each restart in the
journal under the token. No permission is ticked for it: a token that deploys
code already restarts the service at each deployment. Revoke a token whose
holder should not restart. Secrets wait for someone to mint a token with
*Manage secrets*: every token already minted, yours and everyone's, lists and
manages none. Then:

- whoever holds that token sets variables without an unlock: ticking the box
  is that decision. Mint it for the projects that need it, with an expiry;
- an owner's token that does not deploy public sites changes the secrets of
  the Restricted projects it could deploy as they stand alone;
- the *Tokens* page's *Token activity* lists, beside deployments, the secrets
  a token set or removed and the restarts it made, and so does each project's
  *Activity*;
- over your SSH, `sitesolide secrets` and `sitesolide restart` point to the
  dashboard, as `secrets` did.

**Whoever works with a token installs the new CLI** too, from the same
`install.sh` as step 1 above: the commands are the CLI's, and the binary
they have predates them. A previous CLI refuses them before anything is
sent: `sitesolide secrets` as a command that needs the owner's SSH, and
`sitesolide restart` as a command it does not know, a usage error. An agent
without the CLI calls the routes over HTTPS
([access.md](access.md#over-https-without-the-cli)).

**Going back.** `sitesolide upgrade` with the previous binary. The previous
steward reads `team.json` as it stands, the new key ignored, and knows no
secrets route, which the dashboard answers `not-available`. The values tokens
set stay on the machine, and their lines in the journal.

## A token may not take a platform project's name

The steward refuses a token creating a project named after a platform project
and a dash, `dashboard-*`, `portal-*`, `api-*`, `analytics-*`, `landing-*`,
`www-*`, as `reserved`; a project of such a name already on the machine stays
deployable.

**What `sitesolide upgrade` brings**: the steward, which refuses the new
names; the dashboard, whose folder carries the steward's sources, with nothing
new for it. The backups, the egress proxy, the collector, the gatekeeper, the
shared service, the portal, the monitor, the Caddyfile and Caddy's drop-in do
not move. Nothing changes form on the machine.

**Going back.** `sitesolide upgrade` with the previous binary.

## Workers and scheduled services

A project can run work that answers no request. Under `services`, an
internal service without a `port` is a worker, which runs for good and
listens on nothing; a service with a `schedule`, a systemd calendar
expression, is started by a timer at the times it names and runs to its end.
`cpu` caps a service's processor. A project of such services alone, with no
`publicDir`, serves no page and its address says so. See
[docs/manifest.md](manifest.md#services).

**What `sitesolide upgrade` brings**: the components that read a manifest,
rebuilt: the backups, the egress proxy, the steward, the dashboard, the
gatekeeper, the installer and the monitor. The Caddyfile, Caddy's drop-in, the
collector, the shared service, the portal and the loopback rule do not move.
The units and blocks of the projects already deployed are generated as
before, line for line: none reads as edited by hand, none needs `--force`.

**What changes for you.**

- **Upgrade before deploying the first project with a `schedule`.** The
  previous monitor and dashboard read a scheduled service between two runs,
  `inactive` by design, as a service down. The new monitor reports a failed
  run as a warning and a timer that stopped as an outage.
- **`deploy` watches the services it restarted for ten seconds**, a server or
  a worker, and fails when one is no longer active or was restarted by
  systemd meanwhile. A project that fell at once after its restart, and was
  restarted every two seconds behind a successful deployment, now fails its
  deployment: `sitesolide logs` says why. The wait runs beside the Caddy step
  and the check over HTTPS.
- **`deploy` asks systemd on the machine** whether it reads each schedule,
  before anything is written.
- **`sitesolide logs` reads the journal through `sudo -n`.** On a machine
  `sitesolide setup` installed, it printed "No entries" for every project:
  the deployment account is in no group that reads the system journal. It
  needs the account's sudo without a password, which every deployment
  already does.
- **A token deployment no longer chooses a port for an internal service that
  names none**: it is a worker. One the machine already gave a port to keeps
  it.
- **A project whose services are all internal, with no `publicDir`**, was
  refused, and now deploys as a project that serves no page.
- **Removing a project** clears the failed state of its units, which systemd
  otherwise keeps in `systemctl --failed` once their files are gone.

**Going back.** Remove first, with this release's CLI, every project that
declares a worker, a `schedule` or `cpu`: the previous release refuses those
keys, and would read a scheduled service between two runs as a service down.
Then `sitesolide upgrade` with the previous binary.

## Whose token, from a menu that says who each person is

*Whose token*, in the *New token* dialog, is a menu drawn by the page rather
than the browser's: each person of People over a line saying where they
deploy and whether they may create projects. A Viewer everywhere is no longer
offered, since the steward mints them no token; with nobody to offer, the
menu is left out.

**What `sitesolide upgrade` brings**: the dashboard alone.

**What changes for you.** Nothing beyond the dialog.

**Going back.** `sitesolide upgrade` with the previous binary.

## A token's projects are ticked, not typed

The *New token* dialog lists the projects on the server to tick, where the
owner used to type slugs from memory; creating projects is one more row of
that list, *New projects*. A permission a chosen project cannot be deployed
without is ticked for you and says which project needs it: public sites for
a project that is not Restricted, or that exempts paths from the portal, and
a domain for one that declares it. A token with nothing to deploy, no
project and no *New projects*, is refused by the form.

**What `sitesolide upgrade` brings**: the dashboard alone. The tokens already
minted are untouched, and the steward judges a new one as before.

**What changes for you.** Nothing beyond the dialog.

**Going back.** Deploy the previous release's dashboard: `sitesolide
upgrade` with the previous binary. The tokens minted with this dialog stay as
they are.

## The machine's own state is backed up

Every run now takes, first, a snapshot named `machine`: `/etc/sitesolide`,
every project's store and the platform's own files; `/var/lib/sitesolide-steward`, the access
registry, the previous versions of the secrets and the steward's log; and
`/etc/caddy`, the preview codes, the zone's settings, the DNS token and the
domains table. It is read back, kept, copied to the bucket and checked like a
project's snapshot. Until now a lost machine took all of it along: the data
came back from the bucket, and every key had to be minted again.

**What `sitesolide upgrade` brings**: the backup component, which takes it;
the steward and the dashboard, which never take `machine` for a site. Check
after the next run, or at once with `ssh you@your-machine 'sudo systemctl
start sitesolide-backup.service'`: `sudo cat
/var/lib/sitesolide-backup/last-run.json` names `machine` first, with a
snapshot. Its files are put back by hand, never from a page:
[dashboard/src/backup/README.md](../dashboard/src/backup/README.md#the-machines-own-state).

**What changes for you.**

- `deploy` refuses the slug `machine`. A project deployed under that slug
  before this release is no longer a site to the steward nor to the backups:
  deploy it under another slug before upgrading, and remove the old one.
- The monitor's backup line counts `machine` among the projects, and names it
  when its snapshot fails.
- The secrets now sit in the bucket too, encrypted with
  `BACKUP_ENCRYPTION_PASSPHRASE`: whoever holds that passphrase and read
  access to the bucket holds every secret of the machine, as they already
  held every project's data.

**Going back.** Forget the snapshots of `machine` first, in the server's
repository and in the bucket's: the previous steward takes any deployed
folder for a site, `machine` included, and a project deployed under that
slug with the previous CLI would list them and could restore every secret
into its own data.

```bash
ssh you@your-machine
sudo -i
export RESTIC_REPOSITORY=/var/backups/sitesolide-restic RESTIC_PASSWORD_FILE=/var/backups/sitesolide-restic.key
restic forget --prune $(restic snapshots --path /machine.tar --json | python3 -c 'import json, sys; print(" ".join(s["id"] for s in json.load(sys.stdin)))')
```

Then the same with the bucket's repository, as [Restoring by
hand](../dashboard/src/backup/README.md#restoring-by-hand-when-the-dashboard-does-not-answer)
opens it. The previous component takes no new snapshot of `machine`.

## A site closes on every address

Restricted and Anyone with the code now close a site on its own domain too,
not only on its preview: the dashboard and `sitesolide lock` used to refuse a
site that served its own domain, since the domain would have stayed open. The
domain's other names, its aliases and the `www` the table adds to a second
level domain, now send to the domain with a permanent redirect. They used to
fall into Caddy's nameless block, which serves `public/` and never wakes an
app: an app on its own domain answered its `www` without its service, every
`/api/*` there a 404.

**What `sitesolide upgrade` brings**, in its usual order: the steward and the
dashboard, which offer all three accesses to a site on its own domain and name
both addresses before a change; the gatekeeper, which checks the domain beside
the preview after every change, and writes an app's block anew when the one in
service is an earlier release's; the Caddyfile, whose nameless block lets a
static site's code close its domain; and the portal, which judges a domain's
visitors on its site's people. Two changes reach sites at once, and nothing else
does until a site is deployed or its access changed:

- the nameless block no longer serves an app's folder: a name the table
  carries for an app and its block does not claim answers 404 instead of the
  app's `public/`, which skipped its portal. The `www` of an app deployed
  before this release is one such name, until the app is deployed again;
- the preview locks in service keep matching their previews alone; the
  gatekeeper writes all of them in the new form at its next change of any
  site's code.

**Then each app site that serves its own domain**, when traffic allows:
`sitesolide deploy` in its folder. It says the block "was written by an
earlier release, the current one replaces it", without `--force`. Check:
`curl -sI https://www.<domain>/` answers `301` to `https://<domain>/`, and
`https://<domain>/` answers as before. Until then its `www` keeps falling into
the nameless block; restricting it or giving it a code from the dashboard
writes the new block in the same change.

**What changes for you.**

- **A site that opens with a code and serves its own domain** stays open
  there until its stanza is written again: `sitesolide lock` in its folder,
  or *New code* in its Access section, after the deployment above. Either
  rewrites every site's stanza at once. The dashboard no longer calls such a
  code in place.
- `sitesolide domain --activate` on a restricted site, or one that opens with
  a code, no longer refuses the restricted one, and refuses either while what
  Caddy serves would not close the domain: an app's block other than the one
  its manifest generates (deploy it first), a Caddyfile from before (upgrade
  first), or a code's stanza from before (`sitesolide lock` first).
- A deployment refuses a domain name, an alias or their `www` that another
  project declares, active or not, and an alias in the served zone.
- The link that carries a site's code leads to its own domain once it serves
  one.
- `bin/lock.sh state`, which `sitesolide lock --status` runs, measures the
  domain with the code too.
- An app reading `X-Sitesolide-*` behind the portal receives them on its
  domain as on its preview.

**Going back.** A portal from before refuses the announcement of a domain's
block, so a restricted site on its own domain is closed to everyone there,
its preview unaffected: make it public before going back, or upgrade again.
The previous gatekeeper refuses to change the access of a site whose block is
this release's, as one it did not write: deploy such a site with the previous
release first. The redirect of a domain's other names stays until the site is
deployed with the previous release.

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
revoked, to be minted again. The machine's backups hold the steward's state
from 0.4.2 on, an hour old at most; make a copy yourself all the same,
`sudo cp -p` of the file, before you edit it by hand.

## Anyone with the code, from the dashboard

A site's general access is now chosen among its three from its *Access*
section, Anyone with the code included: the owner and the site's Admins open a
site with a code there, read the code, draw a new one, and go back to Public
or Restricted, a switch between Restricted and the code in one transaction.
`sitesolide lock` and `unlock` no longer change the machine themselves: they
ask the steward on its owner socket, which launches the same gatekeeper. One
path changes a site's general access, whoever asks.

**What `sitesolide upgrade` brings**, in its usual order: the steward and its
`POST /general` routes, the dashboard, then the gatekeeper and its four
templates, `-on@`, `-off@`, `-code@` and `-renew@`. `bin/deploy-gatekeeper.sh`
lays what they open for writing and cannot create, when missing:
`/etc/caddy/locks/`, an empty `/etc/caddy/locks-codes.json` for the
deployment account in `0600`, and `/srv/garde/`. A machine that has locked a
preview before carries them already, and they are left as they are, codes in
force included. The Caddyfile changes by a comment only, which upgrade
redeploys through `bin/deploy-caddy.sh` all the same.

**Until the gatekeeper step has run**, `sitesolide lock` on that machine says
to run `sitesolide upgrade`, and the dashboard's *Use a code* is refused by a
gatekeeper that does not know it: nothing changes, and running upgrade to the
end mends both.

**What changes for you.**

- `bin/lock.sh enable`, `code` and `disable` are gone; `bin/lock.sh state`,
  which `sitesolide lock --status` runs, stays, and reads what the machine's
  manifest asks for rather than the repository's.
- The next `sitesolide deploy` writes into `sitesolide.json` the general
  access the machine carries, `lock` included, as it already did for
  `portal`; `sitesolide lock` writes it at once.
- `sitesolide lock` on a site that serves its own domain is refused, as the
  dashboard refuses it: the code would close the preview and leave the domain
  open. Switch the site back to its preview first, `sitesolide domain
  --deactivate`. `LOCK_DESPITE_DOMAIN` is gone with the script that read it.
  The release after this one closes the domain too, see *A site closes on
  every address*.
- A Viewer or a Developer of a site that opens with a code reads that it opens
  with one, no longer the code itself: its Admins and the owner hold it.

**Going back.** The previous release's `bin/lock.sh` writes the same files the
gatekeeper does, `sitesolide.json`, the codes file and `verrous.caddy`: a
workstation still on it keeps working, without the dashboard knowing what it
did until the next snapshot. Going back to the previous gatekeeper leaves the
two new templates installed, which nothing launches once the previous steward
is back.

## Backups stored by restic

The backup component stores its snapshots with restic: one repository on the
server, `/var/backups/sitesolide-restic`, and, with a bucket, a second one in
it, `<prefix>-restic`, filled by `restic copy`. An hour now stores what
changed since the hour before, compressed, rather than a whole archive; the
bucket is read back with stock restic on any machine, the passphrase alone.
What runs around it does not change: the copy as the project, the backup
commands, the bounds, the status file, the restore and its rollback. See
[dashboard/src/backup/README.md](../dashboard/src/backup/README.md).

**What `sitesolide upgrade` brings**, in its usual order: the backup install
first, which now installs Debian's `restic` package if it is missing (and
refuses one older than 0.18.0), draws the repository's key and initialises
the repository; then the steward, which reads the snapshots from the index
the run writes instead of the archives' folder, and the dashboard, whose
*Backups* section shows what each snapshot added and the last daily check;
the monitor last, which learns to warn on a failed check. The run's and the
restore's units go from 256M to 512M of memory, restic running beside Bun.

**Then a run by hand**, which upgrade does not start:

```bash
ssh you@your-machine 'sudo systemctl start sitesolide-backup.service; sudo cat /var/lib/sitesolide-backup/last-run.json'
```

It imports the archives of the version before into the repository, each
proved byte for byte, and writes the index the new steward reads; until it
runs, within the hour otherwise, the *Backups* section lists no snapshot, the
archives still on the disk. With a bucket, it also creates the bucket's
repository with the server's chunker parameters, copies every snapshot there,
and imports the objects the server no longer has. The archives and the
objects are deleted seven days after their copy was verified.

**What changes for you.**

- Snapshots are named `<folder>-<time>.tar`, `.tar.gz` being the archives of
  the version before; `sitesolide backups` gains an ADDED column.
- The bucket's passphrase, `BACKUP_ENCRYPTION_PASSPHRASE`, is now the bucket
  repository's password: changing it in the dashboard alone cuts the bucket
  off. Change it with `restic key add` first, as the README says.
- On Backblaze B2, a lifecycle rule keeping prior versions 30 days, and the
  multipart one, as the README's *The offsite copy* says.
- A recovery drill from your workstation with stock restic, once: a
  passphrase never tried is a passphrase you do not have.

**Going back.** Within seven days of the import, the previous release's
`bin/deploy-backup.sh install`, steward and dashboard find their archives and
objects where they left them, and never see the repository. The snapshots
taken since exist only in restic, restored by hand. Past seven days, the
previous release starts from an empty history. The next release removes the
import, and its install refuses a machine that has not imported everything:
upgrade through this one.

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
