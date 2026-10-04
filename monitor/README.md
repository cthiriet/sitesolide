# monitor

Every minute, a pass over the machine that serves every site: is Caddy
running, does every site answer over HTTPS, did a project's service fail, is
there room on the disk and in memory, is a certificate about to expire, is the
last backup recent. It says so **once** when something goes down and **once**
when it recovers, and it pings an outside heartbeat that notices the machine
itself dying.

It exists because of 11 August 2026: a `caddy stop` sent to the admin API took
every site down for 23 minutes, the journal showed an orderly shutdown, and
nobody knew until a visitor said so. The drop-in in
`infra/caddy/caddy.service.d/override.conf` now has systemd restart Caddy
within seconds; this monitor is what tells you it had to, and what notices
everything a restart does not cure.

**Opt-in.** Nothing runs until `bin/deploy-monitor.sh` has run once. With no
alerting configured it writes to the journal only, which is what the machine
did before, and no worse.

## What it checks

| Check | How | Severity | Fails when |
|---|---|---|---|
| Caddy | `systemctl show caddy.service` | critical | not `active` (or `reloading`) |
| Caddy's automatic restarts | `NRestarts` going up since the last pass | warning | systemd restarted Caddy on its own in the last 15 minutes: something stopped it |
| every served site | `GET https://<host>/` on `127.0.0.1:443`, the certificate verified for `<host>` | critical | no answer, a failed handshake, or a status of 500 and above |
| certificates | the certificate Caddy serves for the bare domain, the zone's wildcard and each customer domain | warning | expires within 14 days |
| projects' units | `systemctl list-units`, every `<slug>.service`, `<slug>.<name>.service` and `sitesolide-landing.service` | critical | failed, stopped, or crashing in a loop (`activating (auto-restart)`) |
| the platform's units | every other `sitesolide-*.service` | warning | failed or crashing in a loop |
| disk | `statfs` on `/`, `/srv` and `/var`, merged by device | critical | 90 % used, cleared below 85 % |
| memory | `MemAvailable` in `/proc/meminfo` | warning | less than 10 % available, cleared at 15 % |
| backups | `/var/lib/sitesolide-backup/last-run.json`, when it exists | warning | the last run failed, a project failed, or it finished more than 26 hours ago |
| the monitor itself | what it could not read, an alerting address that is not one | warning | any of those |

**The served sites come from what the machine declares**, never from inside a
project: the names of the directories under `/srv/sites`, each served at
`<slug>.<zone>`, the landing's at the bare domain and its `www`, and the
customer domains of `/etc/caddy/domaines.map`. That is the dashboard's host
table and the gatekeeper's probes, read the same way. Anything below 500
answers: a locked preview's 401, the portal's redirect to its sign-in and a
root that serves nothing all prove Caddy serves the host with a valid
certificate.

**When Caddy is down, the sites are not probed.** One alert for Caddy, not one
more per site on top of it.

**The probes have 25 seconds in all**, eight at a time, five seconds each, so
that a hung Caddy cannot keep the run past its unit's limit and the heartbeat
from leaving. A probe starts only if its whole five seconds still fit: one given
the last fraction of the budget would time out on its own clock and be judged a
site that does not answer, the same site every pass. What does not fit is not
checked this pass, keeps its state, and is counted in the status, the journal
(`3 not checked`) and the dashboard. The next pass starts with what is failing,
then with what has waited longest, so that every host gets its turn.

## How it alerts

**Twice in a row, or three times in five passes, before an alert; twice in a
row before a recovery.** A deployment restarts its service and may miss one
probe; a site that blinks once, or twice minutes apart, costs no message.
Something down is reported within two to three minutes. Counted in a row only,
a site failing every other pass, half its visitors refused, would never have
been reported: three failures among the last five passes catch it within five
minutes, and the alert holds until two passes in a row succeed.

**Once down, then silence until it recovers**, however long it lasts and even if
it blinks in between. A disk or memory that hovers at its threshold does not go
down and up every minute: the alert clears at a lower threshold than the one
that raised it. A check that disappears while down, a removed site, says so
once ("no longer checked") and is forgotten. A reading that could not be taken,
a `systemctl` that did not answer, changes nothing: it is neither a failure nor
a recovery, and the monitor reports its own blindness as one warning.

**One message per pass**, however many checks changed: a hundred sites going
down at once is one message, cut to fit with a count of what was left out, and
what was left out follows in the next pass's message, so that no site that went down
in a storm goes unnamed.

Two channels, both optional, both set in **`/etc/sitesolide/dashboard-monitor.env`**,
from the dashboard:

| Variable | What it does |
|---|---|
| `HEARTBEAT_URL` | a dead man's switch, [healthchecks.io](https://healthchecks.io) style. Every pass pings it: the URL itself while the platform stands, `<url>/fail` while the platform itself is down, with the list of what is down in either case. The outside service alerts when the pings stop: **the only thing that notices the machine itself dying**, which no check run on it ever could. |
| `ALERT_WEBHOOK_URL` | one message per pass that has something to say, in the body the service at that address takes (below). |
| `ALERT_WEBHOOK_FORMAT` | which body, when the address does not say it: `slack`, `discord`, `googlechat`, `text` or `json`. |

Each service refuses or mangles the others' body, so the format follows the
address: `hooks.slack.com` is `slack`, `discord.com` and `discordapp.com` are
`discord`, `chat.googleapis.com` is `googlechat`, `ntfy.sh` is `text`, and any
other address `json`, unless `ALERT_WEBHOOK_FORMAT` says otherwise, for a
self-hosted ntfy for instance.

| Format | Body |
|---|---|
| `slack` | `{"text": ...}`, with `<`, `>` and `&` escaped: nothing in a summary can become a link or a `<!channel>` |
| `discord` | `{"content": ..., "allowed_mentions": {"parse": []}}`: no `@everyone`, no mention of anybody |
| `googlechat` | `{"text": ...}` and nothing else, Google Chat refusing a field it does not know |
| `text` | the message as the raw body, what [ntfy](https://ntfy.sh) takes, with a title and a high priority when something critical went down |
| `json` | `{"text": ..., "content": ...}`, for a service that reads one of the two (Mattermost reads `text`) |

**What was tested, and what was not.** The tests check each body against a
local receiver standing in for the service; none was sent to Slack, Discord,
Google Chat or ntfy.sh from here. The bodies follow each service's documented
incoming webhook; the first message on a new channel is the real test, and
`sudo journalctl -u sitesolide-monitor` says `webhook not delivered (HTTP 400)`
when a service refuses one.

**Only the platform fails the heartbeat**: Caddy, a disk, the memory, the
monitor's own blindness (a reading it could not take, an alerting address that
is not one), the bare domain and the dashboard's site. Everything else, one
project's site or unit however critical, a certificate, a backup, Caddy's
restarts, pings success, its summary in the ping's body. The reason is the
outside service itself: it alerts once when a check goes down and never again
until it comes back up, so a heartbeat held on `/fail` is a dead man's switch
that no longer hears anything, and the machine can die unnoticed for as long as
it stays there. What breaks the platform breaks every site and is fixed within
the hour; one project left broken for a week, or a certificate fourteen days
from expiry, must not disarm the switch all that time. Those go to the
webhook, the dashboard and the journal, one message when they go down and one
when they recover, and travel in the body of every successful ping.

**A webhook that refuses keeps its notices** for the next pass, a day and five
hundred notices at most, and the dashboard says how many wait. Neither address is ever
written anywhere: not in the journal, not in the status, not in an error.
**Both must be `https`**: an address in plain http is refused as a problem of
the monitor, since it would hand the secret, and every message, to each
network on the way.

**That file sets the alerting and nothing else.** It is edited from a web
page, and systemd hands the monitor every variable in it, so the monitor reads
only `HEARTBEAT_URL`, `ALERT_WEBHOOK_URL` and `ALERT_WEBHOOK_FORMAT` from its
environment, beside the zone. The paths a test tree moves, `SITES_DIR`,
`DOMAINS_FILE`, `PROBE_ADDRESS`, `PROBE_PORT`, `DISK_PATHS`,
`BACKUP_STATUS_FILE` and `STATE_DIRECTORY`, are read only when the run is given
`--test-tree` on its command line, which the unit never does: a `DISK_PATHS=`
slipped into that file would otherwise leave no disk checked, without a word.

## What an alert looks like

The webhook, when a site's service stops answering:

```
sitesolide monitor, example.com: 1 down
DOWN https://shop.example.com/ answered 502 (since 2026-10-04 14:02 UTC)
```

When Caddy was stopped and systemd brought it back:

```
sitesolide monitor, example.com: 1 down
WARNING Caddy was restarted by systemd on its own 1 min ago (NRestarts 1): something stopped it, see journalctl -u caddy (since 2026-10-04 14:05 UTC)
```

And the recovery:

```
sitesolide monitor, example.com: 1 recovered
RECOVERED https://shop.example.com/ answered 200 (after 8 min)
```

The heartbeat's body, which healthchecks.io shows in the check's log and in its
email. With a project down, the ping succeeds:

```
ok for the platform: 1 of 41 checks down, none of them platform-wide
DOWN https://shop.example.com/ answered 502
```

With the platform down, it goes to `/fail`, the platform's lines first:

```
down: 2 of 41 checks
DOWN Caddy is inactive (dead), result success
DOWN https://shop.example.com/ answered 502
```

The journal, `sudo journalctl -u sitesolide-monitor`, one line per notice and
one line per pass:

```
DOWN site:shop.example.com: https://shop.example.com/ answered 502
41 checks, 1 down, 0 failing; heartbeat ok, webhook ok
```

The dashboard shows what is down among the home page's **Issues**, linked to
the site, critical as an error: `https://shop.example.com/ answered 502
(monitor, for 12 min)`. It leaves out a project's unit, the disk and the
memory, which it already judges itself. A status older than five minutes shows
as "Monitor silent", never as the present.

## Alerting: healthchecks.io in five minutes

The free tier is enough: one check, pinged every minute.

1. Sign up at [healthchecks.io](https://healthchecks.io). Your email is
   already an integration.
2. **Add Check**. Name it after the machine. Schedule *Simple*, **Period 1
   minute, Grace 5 minutes**: the monitor pings every minute, and the grace
   absorbs a reboot or a slow pass without a false alarm. If the machine dies,
   you hear of it within six minutes.
3. Copy its ping URL, `https://hc-ping.com/<uuid>`. It is a secret: whoever
   holds it can ping it and hide that the machine is down.
4. Once the steward is deployed (see [Deployment](#deployment)), create the
   alerting file, empty, once:

   ```bash
   ssh you@your-machine 'sudo install -m 600 -o root -g root /dev/null /etc/sitesolide/dashboard-monitor.env'
   ```

   Like every file no manifest declares, the dashboard manages it once it is
   there and never creates it ([docs/secrets.md](../docs/secrets.md)).
5. In the dashboard, the **dashboard** site, *Secrets*, *Unlock*, then in
   `dashboard-monitor.env` set `HEARTBEAT_URL` to the ping URL. The monitor
   reads the file at its next pass, within the minute: nothing to restart. The
   page may show *Restart pending* on the dashboard site; it is about
   `dashboard.service`, which does not read this file, and can be ignored.
6. Within two minutes the check turns green on healthchecks.io, and
   `sudo journalctl -u sitesolide-monitor -n 1` ends with `heartbeat ok`.

For messages as well, add `ALERT_WEBHOOK_URL` in the same file: a Slack
incoming webhook, a Discord channel's webhook, a Google Chat space's webhook,
or `https://ntfy.sh/<topic>` with a topic nobody would guess, since ntfy.sh
topics are public.

To see the dead man's switch work, stop the monitor's timer, which stops
nothing else, and wait for the grace period:

```bash
ssh you@your-machine 'sudo systemctl stop sitesolide-monitor.timer'
# about six minutes later, healthchecks.io reports the check down
ssh you@your-machine 'sudo systemctl start sitesolide-monitor.timer'
```

## What it may read, and what it holds

It runs as `sitesolide-monitor`, a system account of its own with its own
group, no home and no login shell, which `bin/deploy-monitor.sh` makes when it
is missing, with no capability and a read-only system
(`infra/monitor/sitesolide-monitor.service`). Not `DynamicUser=yes`, which the
unit was at first: dbus-daemon runs with `SYSTEMD_NSS_DYNAMIC_BYPASS=1` and
cannot resolve a dynamic uid, so on a Debian 13 test VM every `systemctl show`
failed with `Transport endpoint is not connected`, and the monitor checked no
unit, Caddy included, on any pass. Everything it reads is open to any account:

| What | Why |
|---|---|
| `systemctl show`, `systemctl list-units` | systemd answers readings to anyone over D-Bus; the monitor asks for nothing else |
| the names under `/srv/sites` | which sites exist; nothing inside a project is opened |
| `/etc/caddy/domaines.map`, 0644 | the customer domains |
| `/proc/meminfo`, `statfs` | memory and disk |
| `127.0.0.1:443` | Caddy, over HTTPS, like a visitor; never the admin API on 2019, which the loopback rule closes to it anyway |
| `/var/lib/sitesolide-backup/last-run.json` | the backup status, if the backup job leaves it readable by every account (it carries no secret) |

It holds its state in `/var/lib/sitesolide-monitor/`, a directory of the
account's, `0700`, which only that account and root may open: `state.json`,
its memory between passes, and `status.json`, what the dashboard is handed. The
alerting file is root's, `0600`: PID 1 reads it before it drops to the account,
the dashboard's service cannot read it, and the dashboard manages it only from
an unlocked session, like every secret.

## The status the dashboard reads

`status.json`, the contract with `dashboard/src/monitor.ts`, written by
`src/status.ts` and checked from both sides by `dashboard/tests/monitor.test.ts`:

```json
{
  "version": 1,
  "generatedAt": 1791130920000,
  "zone": "example.com",
  "checks": 41,
  "down": [
    { "id": "site:shop.example.com", "kind": "site", "label": "shop.example.com", "severity": "critical",
      "slug": "shop", "summary": "https://shop.example.com/ answered 502", "since": 1791130200000 }
  ],
  "heartbeat": "ok",
  "webhook": "ok",
  "undelivered": 0,
  "unchecked": 0
}
```

Fields are added, never renamed: the dashboard and the monitor are deployed
separately, and each reads the other defensively.

**The collector does not copy the file as it stands.** It reads it as root,
in a directory the monitor's account owns, so a link put at `status.json`
would have root copy any file it can read into the dashboard's snapshot. It
opens the file without following a link, only if it is a regular file with a
single name, under a megabyte, owned by the owner of its directory, and it
parses it and writes anew the fields `dashboard/src/monitor.ts` knows; anything
else is replaced by the reason it was refused, which the dashboard shows. A new
field reaches the page once that module names it
([dashboard/README.md](../dashboard/README.md)).

## Code

| File | What it holds |
|---|---|
| `monitor.ts` | the entry point the unit runs |
| `src/checks.ts` | every decision: thresholds, verdicts, summaries. Pure |
| `src/alerts.ts` | the state machine: when to speak. Pure |
| `src/hosts.ts` | what the machine serves, from what it declares. Pure |
| `src/notify.ts` | the heartbeat's and the webhook's requests and words |
| `src/status.ts`, `src/store.ts` | the status for the dashboard, the memory between passes |
| `src/machine.ts` | the readings, as an unprivileged account |
| `src/run.ts` | one pass, in order |

```bash
bun install
bun run check   # tests, then type checking
```

The tests need no machine: the decisions alone, then whole passes against an
HTTPS server and a heartbeat and webhook receiver on the loopback, with a
`systemctl` that answers from files and records that it was only asked for
readings, then the probes in front of a real Caddy started with `admin off` on
free ports and stopped by its PID, and the bundle the deploy script builds.

## Deployment

The order matters, and each step changes nothing until the next one uses it.
Every command is for the author to run, from the workstation.

**0. Before.** `bin/deploy-caddy.sh` has run (the unit reads
`/etc/caddy/sitesolide.env`), and the dashboard and its collector are deployed
if you want the Issues panel to show what the monitor sees.

**1. Caddy's restart policy**, independent of the rest and worth having first.
See [infra/README.md](../infra/README.md#caddys-restart-policy) for what it
changes and the proof on a test VM.

```bash
scp infra/caddy/caddy.service.d/override.conf you@your-machine:/tmp/override.conf
ssh you@your-machine 'systemctl show caddy -p MainPID -p ExecStart'   # note the PID; ExecStart without --environ
ssh you@your-machine 'sudo install -m 644 -o root -g root /tmp/override.conf /etc/systemd/system/caddy.service.d/override.conf && sudo systemctl daemon-reload'
ssh you@your-machine 'systemctl show caddy -p Restart -p RestartUSec -p RestartSteps -p RestartMaxDelayUSec -p StartLimitIntervalUSec -p MainPID -p ActiveState'
```

Check: `Restart=always`, `RestartUSec=2s`, `RestartSteps=4`,
`RestartMaxDelayUSec=30s`, `StartLimitIntervalUSec=0`, `ActiveState=active` and
**the same `MainPID`**: no restart happened. If `ExecStart` still showed
`--environ` before, that older change also waits for a restart, which this step
does not need to make. Roll back: install the previous `override.conf` from
git and `sudo systemctl daemon-reload`.

**2. The steward**, so that `dashboard-monitor.env` is expected root's:

```bash
bin/deploy-steward.sh
```

Check: the script's own verifications. A steward older than this would list a
root-owned `dashboard-monitor.env` as unmanaged and suggest giving it to
`site-dashboard`: do not. Roll back: `bin/deploy-steward.sh` from the previous
commit.

**3. The dashboard**, for the collector that hands over the status and the
Issues that show it:

```bash
cd dashboard && sitesolide deploy
```

Check: the page opens; nothing about the monitor yet, since there is no status.
Roll back: deploy the previous commit.

**4. The alerting**, optional, and possible at any time after step 2: see
[Alerting](#alerting-healthchecksio-in-five-minutes).

**5. The monitor:**

```bash
bin/deploy-monitor.sh
```

It builds, checks the machine and the alerting file's owner and mode, makes
the `sitesolide-monitor` account if it is missing and hands it any state an
earlier unit left, installs the bundle and both units, verifies the
fingerprint and `systemd-analyze verify`, runs one pass by hand, checks that
the state directory is a plain directory of the account's, and enables the
timer only if all of that passed. Check:

```bash
ssh you@your-machine 'systemctl list-timers sitesolide-monitor.timer'
ssh you@your-machine 'sudo journalctl -u sitesolide-monitor -n 5 -o cat'
ssh you@your-machine 'getent passwd sitesolide-monitor && sudo stat -c "%F %U:%G %a" /var/lib/sitesolide-monitor'
```

The last journal line reads `N checks, 0 down, ...`. A first pass with problems
shows them as `failing`; they are confirmed, and alerted, at the second pass, a
minute later. With a heartbeat set, healthchecks.io turns green. The account
reads `sitesolide-monitor:x:<uid>:<gid>::/nonexistent:/usr/sbin/nologin`, a uid
below 1000, and its directory `directory sitesolide-monitor:sitesolide-monitor 700`.

Roll back, which leaves nothing behind:

```bash
ssh you@your-machine 'sudo systemctl disable --now sitesolide-monitor.timer'
ssh you@your-machine 'sudo rm -f /etc/systemd/system/sitesolide-monitor.service /etc/systemd/system/sitesolide-monitor.timer /usr/local/lib/sitesolide/monitor.js && sudo systemctl daemon-reload'
ssh you@your-machine 'sudo rm -rf /var/lib/sitesolide-monitor /var/lib/private/sitesolide-monitor && sudo userdel sitesolide-monitor'
```

The status must go too: left in place, the dashboard would report "Monitor
silent" for ever. `userdel` takes the account's group with it, no other
account being in it. Pause the healthchecks.io check, or it will report the
machine down.

**Updating**: `bin/deploy-monitor.sh` again, for any change to `monitor/` or
`infra/monitor/`. A `sitesolide deploy` never touches the monitor.

**Upgrading from the first version** (heartbeat for the platform only, probes
that wait their turn, three failures in five, a body per webhook service,
alerting addresses in https only). Either side first, the monitor and the
dashboard read each other's files whatever their age, and `state.json` is kept:

```bash
bin/deploy-monitor.sh                 # the monitor
cd dashboard && sitesolide deploy     # the collector that copies the status, and the page that shows it
ssh you@your-machine 'sudo journalctl -u sitesolide-monitor -n 3 -o cat'
```

Check: the last line reads `N checks, ...; heartbeat ok, ...`, and with only a
project down, healthchecks.io stays green, the project listed in the ping's
body, where it used to turn red. An address in plain `http://` is now refused
and shows as `WARNING The monitor could not run fully: ... must be an https
URL`: an `ALERT_WEBHOOK_URL` that way holds the heartbeat on `/fail`, a
`HEARTBEAT_URL` that way is no longer pinged at all and healthchecks.io
reports the machine down after its grace period; give either its `https://`
address in the dashboard. A Google Chat webhook that never received anything
starts receiving. On the dashboard, the Issues show `Monitor status refused by
the collector: ...` if the status file is ever anything but the monitor's own.
Roll back: `bin/deploy-monitor.sh` and `sitesolide deploy` from the previous
commit; the older monitor reads the newer `state.json`, the fields it does not
know ignored.

**Upgrading from the dynamic account.** Until this change the unit ran with
`DynamicUser=yes`, and on a machine where dbus-daemon cannot resolve a dynamic
uid, every pass reported `DOWN monitor: The monitor could not run fully:
systemctl show: ... Transport endpoint is not connected`, checked no unit, and,
the monitor's own blindness being platform-wide, held the heartbeat on
`/fail`. Only the monitor changes; the collector reads the status the same way
in both layouts, and `state.json` is kept:

```bash
bin/deploy-monitor.sh
```

What it changes on that machine, in its order:

1. **`-> account`**: `sitesolide-monitor` is made, `useradd --system
   --user-group`, a uid below 1000 and a group of the same name. Both the
   reading and `useradd` run with `SYSTEMD_NSS_DYNAMIC_BYPASS=1`: while a pass
   of the old unit runs, its dynamic account bears the same name, and would
   otherwise pass for the static one, or make `useradd` refuse.
2. **`-> state`**: the state is in `/var/lib/private/sitesolide-monitor`,
   behind the link `/var/lib/sitesolide-monitor`. Under systemd 257 it belongs
   to `nobody:nogroup`, since that release ID-maps a DynamicUser unit's state
   directory from the nobody user rather than chowning it to the dynamic uid;
   under an older one, to a dynamic uid that `stat` prints `UNKNOWN`. The
   script hands it to the account through the link, `chown -R
   sitesolide-monitor:sitesolide-monitor /var/lib/sitesolide-monitor/`, and
   says `was nobody:nogroup, handed to sitesolide-monitor`. Left to nobody,
   systemd 257 would not chown it under the new unit either but ID-map it
   again: it works, but on the host the directory would stay nobody's, open to
   whatever else runs as nobody once no `0700` directory of root's stands in
   front of it.
3. **Installation**, then `daemon-reload`: from then on every start, the
   timer's included, is the new unit's. Until then the old unit, if its timer
   fires, already runs as the static account, systemd.exec saying that a
   DynamicUser unit uses an existing account of the name it would have given
   its dynamic one.
4. **First run**: systemd finds the link into `/var/lib/private`, removes it
   and moves the directory back up to `/var/lib/sitesolide-monitor`, its files
   with it, and logs `Found pre-existing private StateDirectory= directory
   /var/lib/private/sitesolide-monitor, migrating to
   /var/lib/sitesolide-monitor`. Already the account's, it is left as it is.
   The script then checks it is a plain directory of `sitesolide-monitor`'s.

Where this comes from: systemd.exec(5) documents the `private` directory and
the link under `DynamicUser=`, and that a state directory whose owner differs
from `User=` and `Group=` is chowned recursively, its files with it, while one
that already belongs to them is left as it is; it says nothing of the move
back. That is in the code, systemd 257's
`setup_exec_directory()` in `src/core/exec-invoke.c`, both ways: a unit
turning DynamicUser off has its directory moved up out of `private`, and one
turning it on, moved down into it. The same function holds the ID-mapping of
a directory that belongs to the nobody user, for any account, which step 2
exists for.

`/var/lib/private` itself stays, root's, `0700`, empty unless another unit of
the machine uses DynamicUser with a state directory: it is systemd's, and left
alone.

Check:

```bash
ssh you@your-machine 'sudo journalctl -u sitesolide-monitor -n 3 -o cat'
ssh you@your-machine 'sudo stat -c "%F %U:%G %a" /var/lib/sitesolide-monitor; sudo ls -la /var/lib/private'
```

The last line reads `N checks, ...` and no line carries `could not run
fully`; the directory is `directory sitesolide-monitor:sitesolide-monitor 700`,
and `/var/lib/private` no longer holds `sitesolide-monitor`. Within two passes
the monitor's own warning is `RECOVERED`, healthchecks.io turns green, and any
unit that was already down, which the blind monitor could not see, is alerted
for the first time. Roll back: `bin/deploy-monitor.sh` from the previous
commit, which reinstalls the DynamicUser unit; its first start moves the
directory back into `/var/lib/private`, state kept. As long as the account
exists, that unit runs as it and keeps reading systemd; `sudo userdel
sitesolide-monitor` afterwards returns exactly to the blind monitor.

## Verification on a test VM

What the tests here cannot prove, systemd's behaviour and the sandbox on a
real Debian 13, is to be checked on a **test VM, never on the machine that
serves the sites**. With the platform installed on it as in
[docs/install.md](../docs/install.md), the drop-in applied and
`bin/deploy-monitor.sh` aimed at it.

On a VM that ran the DynamicUser unit, as the first test VM did, look first at
what it left, then run the script and look again:

```bash
# Before: the reason for the change, and the state behind systemd's link.
sudo systemd-run --wait --pipe -p DynamicUser=yes /usr/bin/systemctl show caddy -p ActiveState   # fails: Transport endpoint is not connected
sudo systemd-run --wait --pipe -p User=nobody /usr/bin/systemctl show caddy -p ActiveState       # ActiveState=active
sudo journalctl -u sitesolide-monitor -n 1 -o cat               # ... could not run fully: systemctl show: ...
sudo stat -c '%N' /var/lib/sitesolide-monitor                   # '/var/lib/sitesolide-monitor' -> 'private/sitesolide-monitor'
sudo stat -c '%U:%G %u:%g' /var/lib/private/sitesolide-monitor /var/lib/private/sitesolide-monitor/state.json
# nobody:nogroup 65534:65534 twice, systemd 257's ID-mapping

# bin/deploy-monitor.sh, from the workstation: "-> account" says
# "sitesolide-monitor created", "-> state" says "was nobody:nogroup, handed to
# sitesolide-monitor", and the script ends with the timer active.

# After: the account, the directory moved back up and the account's, no link,
# the state kept.
getent passwd sitesolide-monitor                                # sitesolide-monitor:x:<uid below 1000>:<gid>::/nonexistent:/usr/sbin/nologin
getent group sitesolide-monitor                                 # sitesolide-monitor:x:<gid>:
sudo stat -c '%F %U:%G %a' /var/lib/sitesolide-monitor          # directory sitesolide-monitor:sitesolide-monitor 700
sudo stat -c '%U:%G %n' /var/lib/sitesolide-monitor/*           # sitesolide-monitor:sitesolide-monitor, state.json and status.json
sudo test -e /var/lib/private/sitesolide-monitor || echo moved  # moved
sudo journalctl -u sitesolide-monitor -o cat | grep 'pre-existing private StateDirectory='   # systemd's move, at the first run
sudo journalctl -u sitesolide-monitor -o cat | grep -c 'RECOVERED monitor'                    # 1, within two passes
```

Then, on any test VM:

```bash
# The pass runs under its sandbox: systemctl over D-Bus as its own account,
# /proc/meminfo readable, the state directory writable.
sudo systemctl start sitesolide-monitor.service
systemctl show sitesolide-monitor.service -p Result -p User -p DynamicUser   # Result=success, User=sitesolide-monitor, DynamicUser=no
sudo systemd-run --wait --pipe -p User=sitesolide-monitor /usr/bin/systemctl show caddy -p ActiveState   # ActiveState=active
sudo journalctl -u sitesolide-monitor -n 20 -o cat              # no "could not run fully"; the last line "N checks, ..."
sudo grep -c '"id":"monitor"' /var/lib/sitesolide-monitor/status.json        # 0: the monitor is not among what is down
sudo grep -o '"unit:[^"]*"' /var/lib/sitesolide-monitor/state.json | head    # the units it now checks
systemd-analyze security sitesolide-monitor.service             # the exposure score

# The alerting file reaches it although its account cannot read it.
sudo install -m 600 -o root -g root /dev/null /etc/sitesolide/dashboard-monitor.env
echo 'HEARTBEAT_URL=https://hc-ping.com/<a test check>' | sudo tee /etc/sitesolide/dashboard-monitor.env > /dev/null
sudo systemctl start sitesolide-monitor.service
sudo journalctl -u sitesolide-monitor -n 1 -o cat               # ends with "heartbeat ok"

# A project's service down: one DOWN for its unit and its site, then one
# RECOVERED; the heartbeat stays green, the site in its body.
sudo systemctl stop <a test project>          # within 3 minutes: DOWN, heartbeat still ok
sudo systemctl start <a test project>         # within 3 minutes: RECOVERED

# Caddy stopped through its admin API: systemd brings it back, the monitor
# reports the restart as a warning and never Caddy as down.
sudo curl -X POST http://127.0.0.1:2019/stop    # what `caddy stop` sends; the loopback rule opens 2019 to root
systemctl show caddy -p NRestarts -p ActiveState               # NRestarts=1, ActiveState=active

# Caddy stopped through systemd: down, then recovered.
sudo systemctl stop caddy                     # within 3 minutes: DOWN Caddy, heartbeat on /fail
sudo systemctl start caddy

# The collector hands the status to the dashboard: a file of the account's in
# a directory of the account's, so copied rather than refused.
sudo systemctl start sitesolide-collector.service
sudo grep -o '"monitor":"{\\"[a-z]*' /srv/sites/dashboard/data/state.json  # "monitor":"{\"version
sudo stat -c '%U:%G %a' /srv/sites/dashboard/data/state.json /srv/sites/analytics/data/hotes.json
# site-dashboard:site-dashboard 600, site-analytics:site-analytics 640: the fchown on the descriptor

# A link at status.json is refused, and its target never reaches the snapshot.
sudo ln -sf /etc/sitesolide/dashboard-monitor.env /var/lib/sitesolide-monitor/status.json
sudo systemctl start sitesolide-collector.service
sudo grep -o '"monitor":"{\\"[a-z]*' /srv/sites/dashboard/data/state.json  # "monitor":"{\"refused
sudo rm /var/lib/sitesolide-monitor/status.json && sudo systemctl start sitesolide-monitor.service
```
