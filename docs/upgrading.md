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
| gatekeeper | `gatekeeper.js` or one of its templates differs | `bin/deploy-gatekeeper.sh` |
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

A machine upgrades one release at a time, reading the notes below for each.
They begin at 0.14.0: a machine on an earlier release is brought to 0.16
first, with that release's binary and [its
notes](https://github.com/cthiriet/sitesolide/blob/v0.16.0/docs/upgrading.md),
which go back to 0.1; this release converts nothing an earlier one left.

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

