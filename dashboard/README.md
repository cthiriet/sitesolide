# dashboard

What the machine actually runs, at `dashboard.<zone>`, behind a password, on two
levels. **The machine**: *Sites*, the home page, with the state of the machine,
the discrepancies between what the repositories ask for and what the machine
does, the only part of the dashboard that teaches you something, and the list
of sites; *Activity*, the latest operations on secrets and portals. **A site**:
*Overview*, *Audience*, *Secrets*, *Guests* and *Access*, everything that
concerns that site and only it.

**Few writes, and each one is a decision.** No button sets a preview lock. One
machine serves every site, with no staging and no automatic recovery: what
touches their shared configuration stays in the workstation's scripts, under the
eyes of whoever runs them. Three exceptions, and in all three the dashboard only
relays to a component that judges for itself what it accepts:

- **guest access**, the *Guests* section, which touches only the portal's
  database;
- **the secret files of every deployed project** in `/etc/sitesolide`, and the
  restart of its service, the *Secrets* section. The steward, a root daemon,
  decides;
- **a project's portal door**, the *Access* section, the only button in the
  dashboard that reloads Caddy. The steward asks the gatekeeper, a root one-shot
  that validates, reloads, probes every site and restores at the slightest
  discrepancy.

## The web service does not read the machine

That is the architectural point, and it fits in one drawing:

```
sitesolide-collector.timer  ->  collector.ts (root)  ->  /srv/sites/dashboard/data/state.json
                                                                   | 0600 site-dashboard
                                                    server.ts (site-dashboard, confined)
```

The service exposed to the web has no read privileges at all: its unit is the
one `bin/cli/unit.ts` generates for any project, without a single directive
fewer, `/srv` replaced by an empty mount where only its own directories are
bound back in. A compromise therefore yields nothing beyond what the page was
already showing, plus what the steward grants an unlocked session.

This detour is not excess caution, it is the only path:

- removing the unit's confinement would weaken it for **every** project, the
  generator being shared;
- `/etc/caddy/lock-codes.json` is `0600` and owned by the deployment account. A
  mount does not get around Unix permissions: a privileged reader is needed for
  the lock codes either way.

**The file dropped holds the raw reading, not the finished snapshot.**
`collector.ts` reads and interprets nothing; all the judgement lives in
`src/state.ts`, which the unprivileged service runs when it displays. The
privileged component stays as stupid as possible, and a display rule that
changes is fixed by an ordinary `sitesolide deploy`, without touching what runs
as root.

## Audience goes through the same relay

The visit numbers come from another service, `analytics`, which receives page
views from measured sites, aggregates them and drops a snapshot in its own data
directory.

**This service can neither open that database nor reach it.** Its unit replaces
`/srv` with an empty mount, and the loopback rule reserves ports 3000 to 3099 to
Caddy and root. The collector, already privileged and already passing every
minute, is therefore the only path, and it carries two files in both directions:

```
/srv/sites/analytics/data/snapshot.json  ->  state.json, `audience` field
/srv/sites/analytics/data/hosts.json     <-  host to served directory
```

The downward one is the more interesting: `analytics` does not know which hosts
the machine serves, since it sees neither the other projects' manifests nor
Caddy's domain table. The collector writes it that table, which serves as its
allow list: a deployed site becomes measurable within the minute with nothing to
declare, and a host the machine does not serve writes nothing. It is the
collector's only write outside that directory, declared in its unit, and it
carries no secret: that correspondence is already readable in the Caddyfile and
in DNS.

The interpretation lives here, in [src/audience.ts](src/audience.ts): the
snapshot carries only counts, and the bounce rate and average time are computed
at display time. It carries **no visitor fingerprint**, which `analytics` checks
on its side.

## The password

On a new machine, the script draws it, shows it once, and prints its argon2id
hash:

```bash
bun run fingerprint
```

Twenty-four characters from an alphabet of 56 without `I`, `l`, `O`, `o`, `0` or
`1`, by rejection and not by modulo: 56 does not divide 256, and a modulo would
make the first characters come up more often than the last.
[src/password.ts](src/password.ts) says so and
[tests/password.test.ts](tests/password.test.ts) checks it against a fixed byte
sequence. The draw is verified against its own hash before being announced: a
hash that did not verify its password would otherwise only be discovered on the
first refused sign-in, the only copy of the right one being lost by then.

Store it immediately, it cannot be recovered. The hash comes out alone on
standard output: `bin/dashboard-password.sh` runs this script and puts that hash
on the machine, in `/etc/sitesolide/dashboard.env` as `root:root 0600`, without
writing it anywhere on the way.

`--typed` hashes a password you have already chosen. It is then typed without
echo and never passed as an argument, which would land in the shell history and
in the process list. The service holds only the hash, never the password.

**After that it changes from the dashboard**, in the `dashboard` site's
*Secrets*: *Change password* on `PASSWORD_HASH`, the current password retyped, a
new one drawn by the steward the same way and shown once, or chosen. **That
password also unlocks every site's secrets**, checked a second time by the
steward rather than by the service. The steward re-reads the hash on every
attempt, so a new one counts immediately for unlocking; the service re-reads it
only at startup, and sign-in keeps the old one until *Restart service*. On that
restart the service sees the hash has changed and closes every session
([tests/rotation.test.ts](tests/rotation.test.ts)): you sign in again with the
new one.

The rest of the door:

| Measure | Detail |
|---|---|
| Session | 32-byte token, kept **hashed** in the database, `__Host-` cookie, `HttpOnly`, `SameSite=Strict`, seven days |
| Rate limiting | after 3 failures, 5 s doubling up to an hour, **global** rather than per address: one user, and changing address would sidestep a per-IP counter for free |
| `Origin` | compared to the literal `PUBLIC_URL`, on sign-in, sign-out, guest access and every non-`GET` secrets route, portal included. Behind Caddy, `req.url` announces `127.0.0.1:3022` and cannot serve as a reference. With `SameSite=Strict` it stands in for a CSRF token: `src/sessions.ts` says why a token would add nothing |
| With no hash | the service starts, says so in its log, and refuses everyone. It never opens |

**What this password does not protect.** The dashboard shows the lock codes,
which are not cryptographic secrets: they live in clear text in the Caddy
fragment because Caddy compares them in clear text, and `api/src/locks.ts` says
at the top what that implies. A secret's value, on the other hand, is shown only
after unlocking, in its site's *Secrets*.

**`public/` carries no data**, and that is structural: Caddy serves it directly,
without ever waking Bun, as for any `publicDir`. The fragment routes only
`/api/*` to this service, so all state sits behind the session.

## The page

`web/` holds an Astro project with shadcn/ui: Astro 7, React 19, Tailwind 4 and
Base UI. The build drops the page into `../public`, the manifest's `publicDir`,
and **`web/` is excluded from the rsync**: neither Astro, nor React, nor any of
their dependencies go up to the machine, which receives only HTML, CSS and
JavaScript. The production surface does not grow by one executable byte.

The page renders no data at build time: it calls `/api/*` once open, which is
the only way to put content behind a session while Caddy serves the files in the
clear. Its design rules, tokens, primitives, vocabulary and layout, are in
[web/DESIGN.md](web/DESIGN.md).

## Secrets

**The machine is the source of truth.** `/etc/sitesolide` is the production
vault: systemd reads each service's environment there at startup, some services
open their files there themselves, and the dashboard manages it for **every
deployed project**. No copy waits on the workstation: see
[../docs/secrets.md](../docs/secrets.md).

### What the page shows

In a site's *Secrets*: the state of its service and *Restart service*, what is
wrong, then each of its files, with the expected owner and mode, and the states
*Restart pending*, *Unmanaged*, *Missing* and *Write-only*. Then that site's
activity. Changing site or section unmounts the rows, and with them any revealed
value. **Without unlocking, no values.** After *Unlock* and retyping the
password, for ten minutes:

- from a variables file, show a value for thirty seconds, copy it, set or remove
  a variable; *Generate* draws 32 bytes in base64url for a token the site issues
  itself;
- from a file read whole, show its contents if it is readable, replace it;
- on a `PASSWORD_HASH`, *Change password*, and nothing else;
- create a declared file that is missing;
- restore the previous version of a file, when the steward accepts;
- restart the service and read the verdict; *Save & restart* chains the write
  and the restart.

*Activity*, at machine level, lists the last fifty operations across every site,
unlocks included, with no values at all. A revealed value is masked again after
thirty seconds, on locking, when the tab goes to the background, or when the
page is left.

### The steward decides, the dashboard relays

```
browser
   |  session, Origin
   v
server.ts          site-dashboard, confined, no privileges
   |  HTTP over /run/sitesolide-steward/secretaire.sock
   |  directory 0750 root:site-dashboard, socket 0660
   v
steward.js         root, hardened sitesolide-steward.service
   |-- reads  /srv/sites/*/sitesolide.json               the projects, and their secrets
   |-- lists  /etc/sitesolide                            the files present, by name
   |-- reads  /etc/sitesolide/dashboard.env              the hash, root:root 0600
   |-- writes /etc/sitesolide/<file>                     atomic write
   |-- keeps  /var/lib/sitesolide-steward/precedents/    the previous version
   |-- writes /var/lib/sitesolide-steward/journal.jsonl  with no values at all
   |-- reads  /etc/caddy/sites/<slug>.caddy              whether the door is on
   `-- runs   systemctl reset-failed | restart | show <unit>
              systemctl start sitesolide-gatekeeper-<on|off>@<slug>
```

**The dashboard judges no secret rule.** It checks the origin, the session and
the shape of the body, adds the token it holds, and relays. The steward's
refusal goes straight back to the page, which shows it under the field
concerned: a rule copied into the relay or into the page would diverge from the
steward's without protecting anything, since the steward is the one that writes.
Unlike the collector, the judgement cannot live in the unprivileged service,
which would bypass it: the steward itself runs the pure modules of
`src/secrets/`, tested without a machine.

**A Unix socket rather than a port.** The loopback rule reserves ports 3000 to
3099 to Caddy and root, and has only one exception, the portal. A socket is
guarded by its directory's permissions, with no second nftables exception, and
the dashboard's unit opens it exactly as `bin/cli/unit.ts` generates it, without
one extra directive. No peer identity can be read from it, `requestIP` returning
`null`: the permissions are the only guard.

**The socket never exists with the wrong permissions.** Bun creates it according
to the umask, setting none, and changing its permissions afterwards leaves a
window, the bench saw it 85 times in ten restarts. The steward therefore
creates it under a temporary name, gives it the `site-dashboard` group and mode
`0660`, then renames it: the known name only appears with its permissions.

**Its code does not live in `app/`.** The collector runs from
`/srv/sites/dashboard/app/`, which every `sitesolide deploy` replaces. For a
root daemon that writes secrets, updating stays a deliberate act:
`bin/deploy-steward.sh` builds `steward.ts` into one file with
`bun build --target=bun`, installs it as `root:root 0644` under
`/usr/local/lib/sitesolide/`, places the unit and restarts only it. **A rule
changed in `src/secrets/` only counts in production after that script**: a
`sitesolide deploy` updates only the relay and the page.

**The unit is hardened**: read-only system outside `/etc/sitesolide` and its own
directories, no IP addresses at all, capabilities reduced to `CAP_CHOWN` and
`CAP_DAC_READ_SEARCH`, `MemoryMax=128M`.

### Unlocking

- **The password is the dashboard's**, retyped, and **checked by the steward**
  against `PASSWORD_HASH` in `/etc/sitesolide/dashboard.env`, re-read on every
  attempt. The dashboard's service checks only its shape.
- **`dashboard.env` belongs to root**, `0600`. The dashboard's service still
  receives it through `EnvironmentFile`, which PID 1 reads as root before giving
  it its identity, but cannot rewrite the hash that opens every secret, and that
  no longer rests on `ProtectSystem=strict` alone. **The steward refuses a hash
  that does not belong to root**: nobody unlocks then.
- **A fixed ten-minute token**, which use does not extend, and only one alive:
  unlocking from another session replaces the previous one. The steward keeps
  only its hash.
- **The token never goes to the browser.** The dashboard's service keeps it in
  memory, attached to the session's hash, and forgets it on sign-out,
  where it revokes it, as on its own restart: you unlock again, nothing more.
- **Global rate limiting**, taken from sign-in: three failures, then 5 s doubling
  up to an hour. **It is held on disk** and survives a steward restart. *Change
  password* counts its attempts there like an unlock.
- **One argon2id verification at a time**, new hashes included. Each costs about
  65 MiB, and two at once get the service killed at 128 MiB: measured on the
  bench, where raising `MemoryMax` only moved the threshold.

### The scope: every deployed project

A project is a directory under `/srv/sites`, static or app, the landing
included. The steward re-reads the manifests on every request, and brings two
sources together:

- **the manifest's `secrets`** for an app: flat environment files the generated
  unit reads with `EnvironmentFile=`, creatable before they exist;
- **the files present in `/etc/sitesolide`** that carry a site's name, for what
  no manifest declares, the landing's or a hand-made service's: managed once
  present, never created from here.

Either way the owner is `site-<slug>`, root for `dashboard.env` alone, and the
mode follows from the name: `0600` for an environment file, `0400` for a file
read whole, `0444` for a `.pub`. A file that does not match is listed as
unmanaged, with the command that repairs it.

### Three guard rails

| Rule | Files | Why |
|---|---|---|
| **write-only**: replaced, never read back, size not shown | files read whole and closed to other accounts | a private key never comes back to the screen, and its size would already give away its algorithm |
| **Change password only**: never read, never set by hand, never restored, the old one erased | any `PASSWORD_HASH`, in any file | a hash is cracked offline, and restoring would revalidate the password you changed because it had leaked |
| **hash only**: no other variable | `dashboard.env`, `portal.env` | one more variable there would change what the service does, not a secret |

### What a compromise yields

A compromised dashboard yields what the page already showed, plus what an
unlocked session grants: reading and writing the secrets of every project, for
ten minutes, and creating guest access. It never touches Caddy itself, the
gatekeeper refuses everything its own rules refuse, and restores. It cannot
rewrite the hash that unlocks the secrets, which belongs to root.

## The portal, from the dashboard

A site's *Access* section shows its door as the machine carries it, the deployed
manifest and the running block side by side, and offers *Turn on portal* or
*Turn off portal* when the steward accepts. The preview lock appears there too,
read-only: it remains `bin/lock.sh`'s business, and the page gives the commands.

```
page, Access
   |  /api/secrets/portal : session, Origin, unlocked
   v
server.ts                  relays, with no rule
   v
steward.js                 rule, confirmation, writes one at a time
   |  systemctl start sitesolide-gatekeeper-<on|off>@<slug>.service
   v
gatekeeper.js              root, one-shot, one transaction per start
   |-- lock   /run/sitesolide-gatekeeper/caddy.lock
   |-- writes /srv/sites/<slug>/sitesolide.json, /etc/caddy/sites/<slug>.caddy
   |-- runs   caddy validate, systemctl reload caddy
   |-- probes https://<host>/ on 127.0.0.1:443, certificate verified
   `-- writes /run/sitesolide-gatekeeper/<slug>.json, the result
```

### Why a gatekeeper, and two units

**The steward never touches Caddy.** Putting a door up rewrites a block and
reloads the configuration that serves every site: the riskiest act on the
platform. That act lives apart, in `dashboard/gatekeeper.ts` and
`src/gatekeeper/`, tested without a machine all the way up to a real test Caddy.
The gatekeeper does not travel with the dashboard:
`bin/deploy-gatekeeper.sh` builds and installs it, like the steward. The steward
keeps a unit with no network; the gatekeeper, which probes the sites, has no
access to the secrets.

**Two unit templates, one per action**, with the slug alone as the instance.
They differ only by their action, which `tests/gatekeeper-units.test.ts` checks
line by line. An instance carrying the action in its name (`on-cms`) would stop
the unit from bounding writes to the site's directory: here
`ReadWritePaths=/srv/sites/%i`, and a compromised gatekeeper holds only the site
you name it for. The entry point receives `%n` and `GATEKEEPER_ACTION`, and refuses
to start if the two do not say the same thing: an `-off@` file copied without
changing its line does nothing rather than the opposite.

**The unit bounds what the code does not guarantee**: `CAP_DAC_OVERRIDE`, to
rewrite a manifest in a directory owned by the deployment account, and
`CAP_CHOWN`, to give it back; the site's `app/` and `public/` readable, `data/`,
`/etc/sitesolide` and the steward's state invisible; the loopback only, for the
probe; `TimeoutStartSec=80s` and `MemoryMax=256M`. `/etc/caddy/sites` stays
fully writable, the price of the act: a compromised gatekeeper can rewrite any
site's block, but not its files.

### The Caddy lock

**One act on Caddy at a time, across every site**, whether it comes from the
dashboard or from a workstation. `sitesolide deploy`, `remove`, `domain`,
`bin/deploy-caddy.sh`, `bin/lock.sh` and every script that reloads Caddy take it
like the gatekeeper: they read the machine's door, then write minutes later, and
may restore a backup with `rsync --delete`. A gatekeeper action falling in that
window was overwritten without a word, and a site closed from the dashboard was
served in the clear again.

- **A directory**, `/run/sitesolide-gatekeeper/caddy.lock`, created by a
  non-recursive `mkdir` that succeeds for one candidate only, with a `holder`
  file: `<who> <pid> <ms>`, on the machine's clock.
- **Held, it refuses**, saying who holds it and since when.
- **Stale beyond fifteen minutes**, it is taken over, and the takeover is
  logged. One belonging to a gatekeeper whose process is dead is taken over
  immediately; not one belonging to a workstation tool, whose pid is that of one
  ssh command among others.
- **Handed over, never taken over**: a script launched under an action that
  holds it receives its line in `CADDY_LOCK_HELD`, checks on the machine that
  it is really in place, and neither takes nor releases anything.

## Deployment, in this order

```bash
cd dashboard && sitesolide deploy   # user, layout, unit, relay and page
bin/deploy-steward.sh               # builds, installs and checks the steward
bin/deploy-gatekeeper.sh            # builds, installs both unit templates, starts nothing
ADMIN_MODE=observe bin/deploy-loopback.sh close
bin/deploy-loopback.sh state        # hours later: who would have reached the admin API
bin/deploy-loopback.sh close        # then closed to all but root and caddy
```

**The order is not decorative.**

- **`deploy` first**: the steward's socket is open to the `site-dashboard`
  group, which only exists from then on, and the relay has to know the routes
  the steward will serve.
- **The steward next.** It checks on finishing that the installed file is the
  one built, that the directory is `750 root:site-dashboard` and the socket `660 root:site-dashboard`, that
  `site-dashboard` gets 200 on `/projects` with more than one project, and that
  another account gets nothing.
- **The gatekeeper after**, because it only serves the steward. The script holds
  the Caddy lock while installing, refuses to replace the code under a
  transaction in progress, and checks the fingerprint, `644 root:root`
  permissions and `systemd-analyze verify` on one instance of each template. **It
  starts no transaction**: the first will come from the dashboard.
- **The loopback last, in two steps.** Closing Caddy's admin API to every
  account but root and `caddy` is what makes the gatekeeper's model sound:
  without it, any service could push a configuration with no `forward_auth`. But
  `systemctl reload caddy` goes through it, as the `caddy` account:
  `ADMIN_MODE=observe` first counts who reaches it, without reopening the
  service ports already closed, then `close` refuses the others.

`bin/deploy-collector.sh` runs once, on a new machine, after `deploy`: it
refuses to place a timer whose script is not yet on the machine.

**Shared code travels through `borrowed/`.** The rsync carries only that
directory: an `import "../../api/src/locks"` works on your workstation and makes
the service fail to start on the machine. `scripts/borrow.ts` copies those files
before every build, and before every build of the steward and the gatekeeper,
which embed them: the gatekeeper embeds the CLI's block generator. [tests/borrowed.test.ts](tests/borrowed.test.ts) refuses any
import that reaches above the project.

**Updating.** The collector's code travels with the application and updates on an
ordinary `sitesolide deploy`. The steward's and the gatekeeper's do not:

| What changes | The command |
|---|---|
| `steward.ts`, `src/secrets/`, `infra/steward/` | `bin/deploy-steward.sh` |
| `gatekeeper.ts`, `src/gatekeeper/`, `infra/gatekeeper/`, `bin/cli/fragment.ts` | `bin/deploy-gatekeeper.sh` |
| anything else | `sitesolide deploy` |

## Local development

```bash
bun install
bun run dev              # the API, on 3022
bun run web:dev          # the page, with hot reload
bun run page-bench       # the whole dashboard with plausible fake data
```

The bench runs the real `server.ts` in a temporary directory, with a fake
steward on a Unix socket, a simulated gatekeeper and a state file rewritten
every thirty seconds. Nothing in it touches a machine, a real portal or a real
vault.

## Tests

```bash
bun run check   # tests, type checking, then the page's own tests
```

What is covered: the state judgement and every discrepancy it reports, the
session and its rate limiting, the password draw against a fixed byte sequence,
the secrets scope and its three guard rails, the steward's protocol on a real
Unix socket, the gatekeeper's transaction including its rollbacks, and the
gatekeeper in front of a real Caddy started on a free port with `admin off`.
