# dashboard

What the machine actually runs, at `dashboard.<zone>`, behind a password, on two
levels. **The machine**: *Sites*, the home page, with the state of the machine,
the discrepancies between what the repositories ask for and what the machine
does, the only part of the dashboard that teaches you something, and the list
of sites; *Activity*, the audit of the whole machine, every component's in one
log; *Team*, the
tokens that deploy without SSH; *Members*, the people who sign in here with
their work account, a role on each project; *Connectors*, the credentials the
egress proxy lends to projects. **A site**: *Overview*, *Audience*, *Secrets*,
*Guests*, *Sharing*, *Access* and *Backups*, everything that concerns that site
and only it, and *Members* for its Project admins. A member sees Sites and
Activity reduced to their projects, and in a project the sections their role
there opens: see [Members](#members).

**Few writes, and each one is a decision.** No button sets a preview lock. One
machine serves every site, with no staging and no automatic recovery: what
touches their shared configuration stays in the workstation's scripts, under the
eyes of whoever runs them. Four exceptions, and in all four the dashboard only
relays to a component that judges for itself what it accepts:

- **guest access and sharing**, the *Guests* and *Sharing* sections, which
  touch only the portal's database: a password for one person, or who may sign
  in with their work account, see [portal/README.md](../portal/README.md). A
  team token shares the projects it may deploy through the control API, by the
  same relay: see [Sharing by token](#sharing-by-token);
- **the secret files of every deployed project** in `/etc/sitesolide`, and the
  restart of its service, the *Secrets* section. The steward, a root daemon,
  decides;
- **a project's portal door**, the *Access* section, the only button in the
  dashboard that reloads Caddy. The steward asks the gatekeeper, a root one-shot
  that validates, reloads, probes every site and restores at the slightest
  discrepancy;
- **the egress proxy's connectors and their grants**, the *Connectors* page,
  written by the steward under the same unlock as a secret, see
  [Connectors](#connectors).
- **a deployment by a team token**, the control API under `/api/v1/` and the
  *Team* page. The steward judges every token and starts the installer, a root
  one-shot that deploys one project as `sitesolide deploy` would. See
  [The control API](#the-control-api).
- **a project's data, put back as a snapshot had it**, the *Backups* section.
  The steward starts a restore one-shot, which saves the current data first,
  swaps the folders and puts them back if the service does not come back. See
  [src/backup/README.md](src/backup/README.md).
- **the dashboard's members and their work on their projects**, the
  *Members* page, and a project's sections as their role opens them. The
  steward keeps the registry, opens a member's session from an assertion the
  portal signed, unlocks a member on a forced sign-in, and judges by role
  every restart, secret, door, sharing, guest, restore and invitation a member
  asks for. See [Members](#members).

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
/srv/sites/analytics/data/instantane.json  ->  state.json, `audience` field
/srv/sites/analytics/data/hotes.json       <-  host to served directory
```

The downward one is the more interesting: `analytics` does not know which hosts
the machine serves, since it sees neither the other projects' manifests nor
Caddy's domain table. The collector writes it that table, which serves as its
allow list: a deployed site becomes measurable within the minute with nothing to
declare, and a host the machine does not serve writes nothing. It is the
collector's only write outside that directory, declared in its unit, and it
carries no secret: that correspondence is already readable in the Caddyfile and
in DNS.

**Root writes there, in a directory site-analytics owns**, and in its own,
which site-dashboard owns: a link put at the name it writes would have root
overwrite, and hand over to that account, any file it can write. Both files go
through the steward's `writeAtomically`: a temporary file of an unguessable
name created by `O_EXCL | O_NOFOLLOW`, its mode and owner set on the open
descriptor, then a rename onto `hotes.json` or `state.json`, which replaces a
link without following it. A `data` directory that is itself a link gets no
host table at all.

The interpretation lives here, in [src/audience.ts](src/audience.ts): the
snapshot carries only counts, and the bounce rate and average time are computed
at display time. It carries **no visitor fingerprint**, which `analytics` checks
on its side.

## The monitor's status, by the same road

The monitor ([../monitor/README.md](../monitor/README.md)) runs every minute
as its own system account, `sitesolide-monitor`, and leaves
`/var/lib/sitesolide-monitor/status.json`, in a `0700` directory only that
account and root reach. The collector carries it into the reading, the
`monitor` field, but not as it stands: the directory belongs to the monitor's
account, so the file is opened without following a link, only if it is a small
regular file with a single name owned by the directory's owner, then parsed and
written anew from the fields [src/monitor.ts](src/monitor.ts) knows; anything
else takes its place as the reason it was refused, shown as a warning. That
module then turns what is down
into discrepancies: a site that does not answer over HTTPS, a certificate about
to expire, a failed backup sit among the home page's Issues, linked to their
site. A project's unit, the disk and the memory are left out, the page judging
them already; a status older than five minutes shows as "Monitor silent",
never as the present. No monitor installed, no field, nothing shown.

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
| Session | 32-byte token, kept **hashed** in the database, `__Host-` cookie, `HttpOnly`, `SameSite=Strict`, seven days; a member's, signed in with the provider, twelve hours, under their email in the same table (see [Members](#members)) |
| Rate limiting | after 3 failures, 5 s doubling up to an hour, **global** rather than per address: one password, and changing address would sidestep a per-IP counter for free. Members' sign-ins are counted per identity, beside it |
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

*Activity*, at machine level, lists these operations among every other
component's audit, unlocks included, with no values at all: see
[The audit](#the-audit). A revealed value is masked again after
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
   |-- writes /etc/sitesolide-egress/*.json              the connectors, see Connectors
   |-- reads  /var/backups/sitesolide/<slug>/            the snapshots, by name
   |-- reads  /var/lib/sitesolide-backup/backup.db       the bucket's index, the audit
   |-- writes /var/lib/sitesolide-backup/requests/       a restore request, consumed by the one-shot
   |-- keeps  /var/lib/sitesolide-steward/members.json   the members, their sessions, the key pair, see Members
   |-- lays   /etc/sitesolide-portal/assertion.key       the private key the portal signs members' sign-ins with
   |-- asks   /run/sitesolide-portal-relay/portal.sock   the portal's admin API, a Project admin's sharing and guests
   `-- runs   systemctl reset-failed | restart | show <unit>
              systemctl start sitesolide-gatekeeper-<on|off>@<slug>
              systemctl start --no-block sitesolide-restore@<slug>
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
- **A fixed ten-minute token**, which use does not extend, one per principal:
  the super admin has one, which unlocking from another of their sessions
  replaces; each member session has its own (see [A member's unlock](#a-members-unlock)).
  Neither evicts the other. The steward keeps only their hashes.
- **The token never goes to the browser.** The dashboard's service keeps it in
  memory, attached to the session's hash, and forgets it on sign-out,
  where it revokes it, as on its own restart: you unlock again, nothing more.
- **Rate limiting per principal**, taken from sign-in: three failures, then 5 s
  doubling up to an hour. The super admin's, global to their one password, **is
  held on disk** and survives a steward restart; *Change password* counts its
  attempts there like an unlock. A member's counts their refused forced
  sign-ins, in memory, under a cap of sixty unlock attempts a minute for the
  whole machine: neither slows the other.
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

Either way the owner is `site-<slug>`, root for `dashboard.env` and the
monitor's `dashboard-monitor.env` alone, and the mode follows from the name: `0600` for an environment file, `0400` for a file
read whole, `0444` for a `.pub`. A file that does not match is listed as
unmanaged, with the command that repairs it.

### Three guard rails

| Rule | Files | Why |
|---|---|---|
| **write-only**: replaced, never read back, size not shown | files read whole and closed to other accounts | a private key never comes back to the screen, and its size would already give away its algorithm |
| **Change password only**: never read, never set by hand, never restored, the old one erased | any `PASSWORD_HASH`, in any file | a hash is cracked offline, and restoring would revalidate the password you changed because it had leaked |
| **hash only**: no other variable | `dashboard.env`, `portal.env` | one more variable there would change what the service does, not a secret. `portal.env` also takes the portal's sign-in settings, `OIDC_*`, named one by one in `portal/src/sharing.ts` |

### What a compromise yields

A compromised dashboard yields what the page already showed, plus what an
unlocked session grants: reading and writing the secrets of every project, for
ten minutes, among them the portal's sign-in settings, and creating guest
access or sharing a site. It never touches Caddy itself, the
gatekeeper refuses everything its own rules refuse, and restores. It cannot
rewrite the hash that unlocks the secrets, which belongs to root.

## Connectors

The machine-level **Connectors** page manages the credentials the egress
proxy lends to projects without handing them over, see
[egress/README.md](../egress/README.md). It lists the connectors (name, base
address, header, never the value), who asks for which in their deployed
manifest, who has been granted which, and the proxy's activity: refusals,
connector use, changes.

```
page, Connectors
   |  /api/connectors/* : session, Origin, unlocked (the secrets' unlock)
   v
server.ts                  relays, with no rule; refuses an answer carrying the value
   |  /connectors, /connector, /grant on the steward's socket
   v
steward.js                 rules of bin/cli/connectors.ts, the exclusion lock
   `-- writes /etc/sitesolide-egress/connectors.json, grants.json
              root:sitesolide-egress 0640, atomic, owner and mode set first

server.ts  --  GET 127.0.0.1:3129/audit, /status  -->  egress proxy
               answered to site-dashboard alone, recognised by its uid
```

- **The value is write-only.** Typed in the page, sent once to the steward,
  written into the file, and never returned: no route reads it back, the relay
  refuses a response that would carry it, as for the passwords of the Secrets
  section.
- **Writes use the secrets' unlock** and wait in the steward's exclusion lock
  with every other write. A removal retypes the name: every project using the
  connector loses it at once.
- **A grant needs a deployed site**; a grant whose site is gone can still be
  withdrawn, and the page flags it, since it would follow the slug to the next
  project deployed under that name.
- **The audit is the proxy's**, `connector.update` and `connector.grant`
  recorded when it sees the files change, with `owner` as the author the steward
  writes into them. The steward's own journal does not repeat them.
- **Degrades gracefully.** A steward deployed before these routes answers `no
  such route`, which the page turns into *run bin/deploy-steward.sh*. Without
  the proxy's folder the page says the proxy is not installed and writes
  nothing. A file in another form than the steward's is listed as unmanaged and
  never rewritten. An unreachable proxy empties the activity panel alone.

The steward's unit gains `ReadWritePaths=-/etc/sitesolide-egress`, with the
dash: the folder exists only once `bin/deploy-egress.sh` has run.

## Members

People the super admin invites by email, who sign in to the dashboard with
their work account, through the portal's identity provider, and hold a role on
each project. The super admin is whoever holds the dashboard's password, made
by `sitesolide setup`: they keep it, to sign in and to unlock, and nothing
about it changes. A member never holds a password, a token or root.

| Role | On that project | Unlock |
|---|---|---|
| **Viewer** | sees it: its state, audience and activity | none |
| **Developer** | also restarts its service; lists its secret files, names and metadata; sets, replaces and removes a variable, replaces a file read whole, creates a declared file, and never reads a value back | to write |
| **Project admin** | everything of the project: what a Developer does, reads a value or a file back, restores a file's previous version, turns its portal door on or off, shares it, gives and revokes guest access, lists and restores its backups, and gives people a role on it, at most their own | to read, write, restore, turn the door, give a role |

The table is the steward's, `src/members/powers.ts`, and the page reads it to
offer what the steward will accept. Nothing in it reaches the machine itself:
a role is never given on the platform's projects, `dashboard`, `portal`, `api`,
`analytics` and the landing, and the steward refuses a member any file it lays
for root, `dashboard.env` and `portal.env` among them, whatever a registry
edited by hand would claim. A password hash changes with the dashboard's own
password, the super admin's alone; so do the preview locks, the tokens, the
connectors and the Members page.

```
browser, Sign in with ...                   the dashboard's own sign-in page
   |  GET /api/sso/begin                     binding cookie on the dashboard's host
   v
server.ts  --  POST /admin/dashboard/flow  -->  portal, on the loopback: a flow sealed for the dashboard's host
   |  303 to portal.<zone>/oidc/start
   v
portal  -->  identity provider  -->  portal /oidc/callback   the portal's usual sign-in
   |  303 to dashboard.<zone>/api/sso/complete?code=...
   v
server.ts  --  POST /admin/dashboard/redeem  -->  portal: the code, for an assertion it signed
   |  POST /members/signin { assertion }   on the steward's socket
   v
steward.js         root: the signature with its own public key, the audience, the expiry,
                   the nonce never seen, the email in members.json; the session drawn
   |-- reads/writes /var/lib/sitesolide-steward/members.json           the registry, 0600
   |-- reads/writes /var/lib/sitesolide-steward/member-sessions.json   sessions and nonces, hashes only
   |-- keeps        /var/lib/sitesolide-steward/assertion.pub          the public key, 0600
   `-- lays         /etc/sitesolide-portal/assertion.key               the private key, root:site-portal 0640
```

**The portal says who; the steward says what they may do.** The dashboard is
assumed compromised, as everywhere in this README, so it is never believed
when it names someone. The portal, the one authority on identities, runs its
usual sign-in (portal/README.md, "Signing in with a work account") and signs
what the provider proved: an Ed25519 assertion (portal/src/assertion.ts) of the
verified email, when the person last signed in at the provider, for the
dashboard alone, for five minutes, with a nonce. The steward checks it with
the public key it keeps itself, refuses it replayed, too old or for an email
its registry does not name, and only then opens a session. Every write a
member asks for carries that session, and the steward judges it against the
registry as it reads at that moment: the member still there, their role on
that project. Its journal names the email it verified, never one a request
carries. A compromised dashboard can act only for the members whose sessions
pass through it, within their roles; it can neither make a member, nor widen
one, nor forge an assertion, the private key being out of its reach.

**What a member sees, the dashboard filters**, from data it already holds:
`/api/state` keeps their projects alone and drops the machine's own figures,
`/api/audit` keeps the rows of their projects and their own
(src/members/view.ts, src/audit/merge.ts), the portal's guests and policies,
the backups and a project's members keep those of the projects where their
role shows them (src/members/relay.ts). A site's Secrets, Access, Sharing,
Guests and Backups answer at the super admin's addresses: `server.ts` sends a
member's session to src/members/relay.ts (`either()`), which adds their
session and unlock and relays to the steward, which judges. The super admin's
handlers read the owner's sessions alone (`ownerSessions` in src/routes.ts),
so that a route forgetting to dispatch still refuses a member, and every
other route answers a member 403 before its handler runs.
The page shows a member Sites and Activity, and in a project its Overview,
with *Restart* for a Developer or a Project admin, and its Audience.

### The key pair

**The steward draws it, as root.** At startup, and before every use, the
steward reads its public half, `assertion.pub` in its own state folder, and
the private half it laid for the portal; missing or not matching, it draws a
new pair, lays the private half first, then the public one. The portal reads
the private key at every redemption, so a pair laid or replaced needs no
restart of the portal.

**Why a file of its own, and not a variable in `portal.env`.** `portal.env`
is managed from the Secrets section: an unlocked dashboard reads its values,
restores its previous versions, and a compromised one, during an unlock,
would read the private key and forge assertions for anyone, for as long as
the key lived. The key therefore lives outside `/etc/sitesolide`, which the
Secrets section manages, in `/etc/sitesolide-portal/`, a folder root owns,
created `0755` by `bin/deploy-steward.sh`; the file is `root:site-portal 0640`:
root writes it, the portal's account reads it, the dashboard's cannot. It
never enters an environment, where every process of the portal's account and
a crash report would see it. `portal.env` keeps its rule, a hash and the
`OIDC_*` settings, nothing else. The steward's unit makes the folder writable
with `ReadWritePaths=-/etc/sitesolide-portal`, the dash for a machine where it
does not exist yet.

### Sessions

A member's session is the steward's: it draws the token when the assertion
checks out, the dashboard sets it as the browser's `__Host-session` and keeps
its hash in `dashboard.db`, under the member's email in the `identity` column
of `sessions`, beside the owner's (`owner`). Every member request presents it,
and the dashboard asks the steward who it belongs to, the answer kept five
seconds (src/members/identity.ts): removed, a member sees nothing more within
seconds, and their next write is refused at once. Both sides keep hashes only;
the steward keeps its own in `member-sessions.json`, so that restarting it,
or the dashboard, signs nobody out.

| Measure | Detail |
|---|---|
| Lifetime | twelve hours, the steward's and the cookie's alike. The portal spares a dashboard sign-in the provider only while its own session is younger than twelve hours (`DASHBOARD_REAUTH_S`): a person closed at the provider is out of the dashboard a day after they last proved themselves there at most, as out of every site |
| Assertion | five minutes, once: its nonce is remembered on disk until it would have expired. A sign-in at the provider older than a day opens no session |
| Rate limiting | per identity, three refusals tolerated then five seconds doubling up to an hour, and ten sign-ins in ten minutes for one email; sixty sign-ins a minute for the whole machine; the owner's password counter unchanged, global (src/members/limiter.ts) |
| Bounds | ten live sessions per member, the oldest giving way; a thousand on the machine; two hundred members, a hundred projects each |
| Rotation | a new owner's password closes the owner's sessions, never a member's, which do not rest on it |
| Sign-out | closes the dashboard's row and the steward's session, which journals `member.signout` |

### A member's unlock

Whatever reads or writes a secret, turns a door, restores data or gives a role
asks for the member's own unlock, the way the super admin's asks for the
password. A member has no password: they sign in again, made to by the
provider.

```
page, Unlock                                  the member's session open
   |  GET /api/sso/begin?reauth=1&return=...   their session kept against the binding
   v
server.ts  --  POST /admin/dashboard/flow { reauth: true }  -->  portal: a flow sealed with reauth
   |  303 to portal.<zone>/oidc/start
   v
portal  -->  provider with prompt=login and max_age=0         never the portal's own session
   |  /oidc/callback: the ID token's auth_time read back, within this flow and five minutes
   v
server.ts  --  POST /admin/dashboard/redeem  -->  portal: an assertion saying reauth
   |  POST /members/unlock { session, assertion }   on the steward's socket
   v
steward.js         root: the signature, reauth, auth_time five minutes old at most,
                   the email the session's, the nonce never seen; a token for that session
```

- **One token per member session**, ten minutes fixed, which use does not
  extend, kept by its hash in the steward's memory (src/members/unlocks.ts):
  a restart of the steward locks everyone. The same member unlocking again in
  that session replaces it; another member, the same member in another
  browser, the super admin, each keeps their own. The dashboard keeps the
  token in memory against the session's hash, in a store apart from the super
  admin's, and never sends it to the browser.
- **The provider's word, not the portal's clock.** The portal asks every
  provider for `max_age=0`, and all but Google for `prompt=login`, which
  Google does not document; by the OpenID Connect specification a provider
  asked for `max_age` says in `auth_time` when the person signed in, and the
  portal signs `reauth` only when that time falls within the flow
  (portal/src/oidc.ts, `freshReauth`). A provider that ignores the request
  hands back its old sign-in, and the unlock is refused, never believed: with
  Google, check on the installation that it does ask again before relying on
  members' unlocks.
- **The steward checks it all again**: `reauth`, `auth_time` five minutes old
  at most, the email the session's own, the nonce spent with the sign-ins'.
  A sign-in's assertion, which may ride on the provider's session, never
  unlocks.
- **The session survives the provider's site.** The session cookie is
  `SameSite=Strict`, and the way back from a provider on another domain is a
  cross-site navigation, which never carries it. The dashboard keeps, from
  `begin`, the session against the binding, which does travel (`Lax`), ten
  minutes at most, a thousand in flight at most.
- **Bounded**: a member's refused unlocks, three tolerated then five seconds
  doubling up to an hour; sixty attempts a minute for the whole machine; the
  super admin's password counter untouched. A Viewer everywhere has nothing to
  unlock and is told so.
- **Locked** on demand, at sign-out, and for every session of a member removed.

### A member's work, judged by the steward

The page asks the super admin's routes, `/api/secrets/*`, `/api/sharing`,
`/api/guests`, `/api/backups`, whoever is signed in; for a member,
src/members/relay.ts relays to the steward's member routes with the session
and the member's token, and src/members/actions.ts judges, in the order of
the risk: the session, the member's unlock where the power needs one, the
role on that project, the machine's own projects and files refused, then the
operation, under the steward's lock, where the session, the unlock and the
role are asked again. The operations are the super admin's own code,
src/secrets/steward.ts and src/backup/routes.ts, handed the member as `who`:
the journal and the backups' audit name the email the steward verified, never
one a request carries.

- **A Developer reads nothing back.** The listing hides every value, size and
  previous version from them, a write answers with the file's names only, and
  a read is refused by role before any file is opened, the refusal journaled
  with their role.
- **Sharing and guests reach the portal from the steward, as root.** The
  steward checks the role, that the site carries the portal in its manifest
  and its block, and a team token's rule for domains: a Project admin opens a
  site only to the domains the portal admits at sign-in, never to the public,
  which is the door, turned off. It then asks the portal's admin API with the
  member's email as actor, which the portal records. The steward's unit keeps
  no network: it reaches the portal through `sitesolide-portal-relay`, a
  socket only root opens, `/run/sitesolide-portal-relay/portal.sock`, behind
  which systemd's own `systemd-socket-proxyd`, root with no capability and
  the loopback alone, forwards to the portal's port and to nothing else
  (infra/steward/sitesolide-portal-relay.socket).
- **A restore's requester is the steward's to say**, the member's email,
  written into the request the restore one-shot reads.

### A Project admin's members

A project's *Members* section lists who holds a role on it, their role there
alone, nothing of their other projects. Its Project admin gives a role on it,
at most their own, to someone new or to a member, their other projects
untouched, under their unlock; they take a role away with no unlock, as the
super admin removes someone, and a member whose last role goes is no member
any more, signed out. Never on another project, never on the platform's,
never an address the portal would turn away. The journal names the Project
admin as actor, the project as slug, the member in its detail.

### Inviting, changing, removing

From the *Members* page, or with `sitesolide members` over the owner's SSH
([docs/commands.md](../docs/commands.md#the-dashboards-members)). Both end at the
steward, which judges: an address outside `OIDC_ALLOWED_DOMAINS`, read from
`portal.env`, is refused, as the portal would refuse it at sign-in, unless it
is one of the portal's admin emails; a role only goes on a deployed project,
never on the platform's own (`dashboard`, `portal`, `api`, `analytics`,
`landing`, `www`, the landing's folder). **Inviting and changing roles ask for
the unlock**, the same ten minutes as creating a token: a member can restart
services. **Removing does not**, as revoking a token does not: closing someone
out never waits for a password, and the worst a compromised dashboard does with
it is remove everyone. No email is sent: the page and the command give the line
to send.

`sitesolide members` speaks to the steward's **owner socket**,
`/run/sitesolide-steward-owner/owner.sock`, which only root opens: a runtime
folder of its own, `0700`, the socket `0600`, both root's. Root asks it with
`curl` on the machine, the body on standard input, and needs no unlock there:
it is root. The socket carries the registry and nothing else.

The steward's routes, in src/members/protocol.ts:

| Socket | Route | What it does |
|---|---|---|
| dashboard's | `GET /members` | the registry, and what portal.env says of signing in |
| dashboard's | `GET /members/key` | the public key, laid first if missing |
| dashboard's | `PUT /members/member` `{ token, email, roles }` | invite, or replace the roles whole: the live unlock |
| dashboard's | `DELETE /members/member` `{ email }` | remove, their sessions with them |
| dashboard's | `POST /members/signin` `{ assertion }` | a session for a member, from an assertion it verifies |
| dashboard's | `POST /members/whoami` `{ session }` | who the session is, their roles now |
| dashboard's | `POST /members/signout` `{ session }` | closes it |
| dashboard's | `POST /members/restart` `{ session, slug }` | a Developer's or Project admin's restart, judged under the lock |
| dashboard's | `POST /members/unlock` `{ session, assertion }` | a member's unlock, from a forced sign-in's assertion |
| dashboard's | `POST /members/lock` `{ session, token }` | locks it |
| dashboard's | `PUT /members/project/member` `{ session, token, slug, email, role }` | a Project admin gives a role on their project, unlocked |
| dashboard's | `DELETE /members/project/member` `{ session, slug, email }` | a Project admin takes it away |
| dashboard's | `POST /members/secrets/projects`, `/members/secrets/value`, `/variable`, `/file`, `/restore`, `/content`, `/members/portal`, `/members/sharing`, `/members/guests`, `/members/backups/restore` | a member's work on their projects, see src/members/actions.ts |
| owner's | `GET /members`, `PUT` and `DELETE /members/member` | the same, for root, with no unlock token |

A member's restart is the Secrets section's restart, under the same lock and
the same eight seconds of observation, without its check that the unit reads a
managed file: a member restarts a service to restart it. The member's role is
asked again once the lock is taken: removed while it waited, nothing restarts.
A static site has no service; the dashboard is never a member's.

### Threat model

| Threat | What stops it |
|---|---|
| A compromised dashboard | It cannot make a member, nor widen one: the registry is root's, inviting asks for an unlock, and every write and every secret read is judged by the steward on its own registry, by role. It cannot forge an assertion: the private key is the portal's alone, so it cannot unlock a member either, which takes a forced sign-in the portal signs. It never reads a value a member's role does not reach: the steward hands a Developer none, whatever is relayed. It acts for the members whose sessions pass through it while it is compromised, within their roles, and during a member's unlock within what that unlock opens, their projects' secrets for a Project admin. It reads what it already read. It can still write to the portal's admin API itself, as it always could, sharing and guests as the owner, and write a member's email as the actor there: the portal's record of a member's change is the steward's word only as far as the dashboard is sound. During an owner's unlock it can do what an unlock allows, inviting included, as it can already create a token. |
| A stolen member cookie | Half a day at most, within that member's roles, and without their unlock, which needs a forced sign-in at the provider: what reads or writes a secret, turns a door, restores or invites stays closed. Removing them closes it at the next request. |
| A stolen member unlock token | Useless alone: it is valid only with the session it was granted to, for its member, ten minutes, and the dashboard never sends it to a browser. |
| A Developer reading a secret | Refused by the steward before any file is opened: the listing and every answer show names and metadata only, never a value, a size or a previous version. What they write still reaches the service, which may expose it: the role trusts them with the project's behaviour, not with reading its keys back. |
| A Project admin reaching further | One project, their own: the steward refuses another project, the platform's projects, the files it keeps for root, a password hash, a domain the portal does not admit, the public, and a role above their own; a role they give lands on their project alone. |
| A provider that does not ask again | The portal believes the provider's `auth_time`, not its own clock: an old sign-in returned to a forced request is refused, and the steward wants `reauth` and five minutes. |
| A replayed assertion | Its nonce is spent at the first session it opens, on disk; five minutes later it has expired anyway. |
| A code carried to a site, a site's code carried here | A code says which it was minted for: a dashboard's is redeemed for an assertion only, a site's for a cookie only (portal/src/handoff.ts). |
| A compromised portal | It can sign an assertion for anyone, a forced sign-in's included, and act as any member within their roles, their unlock included, as it already opens every protected site. It cannot invite anyone beyond what a Project admin may, nor change a role elsewhere. |
| A flood of failed sign-ins | Twenty failures a minute enter the journal at most, so that a flood cannot push its history out; the rest are refused unrecorded. |

### Upgrading: members' powers

`sitesolide upgrade` runs the three steps in their order; by hand:

```bash
bin/deploy-steward.sh               # 1. the member actions, the unlocks, the portal relay
cd dashboard && sitesolide deploy   # 2. the sections by role, the unlock through the provider, a project's Members
cd portal && sitesolide deploy      # 3. the forced sign-in, guests recording their actor
```

1. **The steward.** Its unit does not change. The script places and starts
   `sitesolide-portal-relay.socket` and its service beside it, and checks the
   relay: `700 root:root` and `600 root:root`, site-dashboard refused, root
   answered by the portal. Check: `sudo curl -s --unix-socket
   /run/sitesolide-portal-relay/portal.sock http://portal/admin/sharing`
   answers the portal's list. The journal gains the operations `sharing`,
   `guest.create`, `guest.revoke` and `backup.restore`, refusals only, which
   an older dashboard shows by their name. Roll back: `bin/deploy-steward.sh`
   from the previous commit; the relay stays, unused, until `sudo systemctl
   disable --now sitesolide-portal-relay.socket` and its two files removed;
   members lose their powers, a restart excepted.
2. **The dashboard.** Check: a Developer's *Secrets* shows every file
   write-only, *Unlock* leads to the provider; a Project admin's project has
   *Access*, *Sharing*, *Guests*, *Backups* and *Members*. Before the steward,
   a member's sections answer that the steward does not know them. Roll back:
   deploy the previous commit of `dashboard/`.
3. **The portal.** Check: a member's unlock sends them to the provider's
   password page even while signed in there. An older portal ignores the
   forced sign-in and signs an assertion without `reauth`, which the steward
   refuses: the page says the unlock did not go through. Roll back: deploy the
   previous commit of `portal/`.

### Upgrading: members

The first release of members, for a machine that predates them. `sitesolide
upgrade` runs the three steps in their order; by hand:

```bash
bin/deploy-steward.sh               # 1. the registry, the owner's socket, the key pair, the key's folder
cd dashboard && sitesolide deploy   # 2. the sign-in with the provider, the Members page, the member views
cd portal && sitesolide deploy      # 3. the two routes the dashboard's sign-in needs
```

1. **The steward.** Its unit gains the owner's runtime folder and
   `ReadWritePaths=-/etc/sitesolide-portal`; the script creates that folder
   before restarting it, and checks the owner's socket: `700 root:root` and
   `600 root:root`, root answered, site-dashboard refused. Check: the script
   ends on `members' key laid for the portal, 640 root:site-portal`;
   `sitesolide members` lists nobody. The journal gains `actor` and `member`
   on every line; a line from before reads as `owner`. Roll back:
   `bin/deploy-steward.sh` from the previous commit; `members.json`,
   `member-sessions.json` and the key stay, unread, and the journal's newer
   lines are skipped by the older steward.
2. **The dashboard.** `dashboard.db` gains the `identity` column, every session
   in place the owner's. Check: the sign-in page offers *Sign in with ...* once
   the portal has a provider; the *Members* page lists the registry. Roll back:
   deploy the previous commit of `dashboard/`; the column stays, unread, and
   member sessions in flight read as the owner's no more than before, since an
   older dashboard has no route a member reaches.
3. **The portal.** Check: `journalctl -u portal` says `dashboard sign-in
   offered, back to https://dashboard.<zone>` once a provider is configured,
   and a member signs in. Without it, *Sign in with ...* lands back on the
   sign-in page saying signing in is not available. Roll back: deploy the
   previous commit of `portal/`.

## The audit

The machine-level *Activity* page answers "who did what": who deployed, who
signed in where, who changed who gets in, what the egress proxy refused or
lent, which backups ran and who restored one, which secrets were read or
changed. Every component keeps its own audit, in its own database, in the
shape they all share: an ISO date, an actor, a dotted action, a target, and a
JSON detail that never carries a secret. The dashboard reads them all and
merges them, newest first. Every event, and who records it, is listed in
[docs/concepts.md](../docs/concepts.md#audit).

```
page, Activity
   |  GET /api/audit : session, no unlock
   v
server.ts          reads, merges, bounds; writes nothing
   |-- dashboard.db                       its own: tokens, team deployments
   |-- 127.0.0.1:3026/admin/audit         the portal, the loopback rule's one exception
   |-- 127.0.0.1:3129/audit               the egress proxy, answered to site-dashboard alone
   `-- the steward's socket               /backups/audit, /log
```

- **No new road, no new privilege.** The same clients as the Sharing,
  Connectors, Backups and Secrets pages, which already read these routes one
  at a time ([src/audit/sources.ts](src/audit/sources.ts)).
- **The session is enough**, and a member's reads the rows of their projects
  and their own, never the rest (`restrict` in src/audit/merge.ts, part of the
  cursor). No row carries a secret value: each component
  sees to it where it writes, and a test in each says so, against the values
  in play (`portal/tests/sso.test.ts`, `egress/tests/audit.test.ts`,
  `tests/control-api.test.ts` and `control-team.test.ts`,
  `tests/backup-run.test.ts` and `backup-restore.test.ts`,
  `tests/secrets-steward.test.ts`).
- **A source down never empties the log.** Each one answers with its state:
  `ok`; `unavailable`, for no answer, a refusal or an answer that does not
  read; `outdated`, for a component older than the route it is read by, with
  what to run; `not-installed`, decided from what the dashboard already sees,
  the egress proxy's folder as the steward reports it, the backups as the
  steward's view of a site says, the portal when the snapshot lists no such
  site. The page shows every state once, at the top, and a banner for each
  source it could not read.
- **Bounded.** 250 rows asked of a source at a time and four times at most per
  page; eight seconds for the whole page, under the ten after which Bun cuts a
  silent connection; 500 rows at most per answer, 100 unless asked; 4 MiB at
  most read from a component; every detail cut in length, breadth and depth.
- **A cursor per source.** No two components share an id, a clock or a way to
  ask for older rows, so each is read as a stream in its own order and the
  cursor remembers where each one stands: rows recorded between two pages are
  neither repeated nor allowed to push an older one out. A cursor made under
  other filters is refused ([src/audit/merge.ts](src/audit/merge.ts)).
- **Filters**: one source or several, an actor by any part of it, an action by
  its beginning (`portal.`), a site, which finds the rows naming its hosts too,
  and a range of days. Filters that rarely match can bring back a short page,
  or an empty one: a source read to the end of its budget before the page is
  full holds back the older rows of the others, so the order holds, and the
  next page goes further.
- **The exports**, CSV and JSON lines, are made in the browser from the rows
  already read, under the filters in force. A CSV field a spreadsheet would
  read as a formula starts with an apostrophe: an actor can be a stranger's
  email.

### How long each source keeps its audit

Each component keeps its own, for its own reasons. The dashboard keeps no copy
of the others, and forgets nothing of its own.

| Source | Where | Kept | What the dashboard reads |
|---|---|---|---|
| `dashboard` | `audit` in `dashboard.db` | everything, never pruned: a few rows per token and per team deployment | all of it, by pages |
| `portal` | `audit` in `portal.db` | 180 days; past 100,000 rows the oldest go, those of the last 30 days excepted; sign-ins and sign-outs repeated within a minute make one row | all of it, by pages |
| `egress` | `audit` in `/var/lib/sitesolide-egress/` | 90 days, pruned every hour; refusals and connector calls counted by the minute | all of it, by pages |
| `backups` | `audit` in `/var/lib/sitesolide-backup/backup.db` | everything, never pruned: one row per hourly run, some 8,800 a year, and one per restore | all of it, by pages, from a steward that knows pages; the latest 50 from an older one |
| `steward` | `/var/lib/sitesolide-steward/journal.jsonl` | the last 500 to 1,000 operations: past 1,000 lines, the file keeps its last 500 | all of it, by pages, from a steward that knows pages; the latest 50 from an older one |

The steward's two routes, `GET /backups/audit` and `GET /log`, hand over their
latest 50, which is all the Backups and Secrets sections read. Asked for a
page, `?limit=<n>&before=<id or ms>`, a steward updated since answers it and
says `paged`; an older one ignores the question and answers its latest 50, and
once the log reaches their end the page says so, rather than let that end pass
for the beginning of time. The journal pages by date, the last appended first
within one millisecond, so that a clock set back between two lines neither
repeats one nor skips one.

### Deployment of the audit

A dashboard deployment is all the log needs: the route reads what every
component already exposes, and the page replaces the former *Activity*. The
steward's pages are a second step, which only reaches further back, and
which either order of the two survives.

```bash
cd dashboard && sitesolide deploy   # 1. the route and the page
bin/deploy-steward.sh               # 2. optional: the backups' audit and the journal read whole
```

1. **The dashboard.** Check: *Activity* lists the sources once at the top,
   each `Read`, `Latest 50` once the log reaches the end of what the steward
   hands over, or `Not installed` for a component the server does not have;
   the rows of every source come merged, newest first; *Site or host* set to a
   site's slug finds its portal sign-ins on its hosts. A component that does
   not answer shows its banner and leaves the others readable. The Backups and
   Secrets sections are unchanged. Roll back: deploy the previous commit of
   `dashboard/`; no table, file or route outside the dashboard changed.
2. **The steward.** Its two audit routes learn `limit` and `before`; without
   them they answer exactly as before, so a dashboard deployed earlier, or
   rolled back, reads what it always read. Check, on the machine:
   `sudo -u site-dashboard curl -s --unix-socket /run/sitesolide-steward/secretaire.sock 'http://steward/log?limit=1'`
   answers one entry and `"paged":true`; on the page, `Latest 50` no longer
   shows for the backups nor the steward. Roll back: `bin/deploy-steward.sh`
   from the previous commit; the page then reads their latest 50 again.

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

## The control API

Deploying over SSH means holding root on the machine: `sitesolide deploy`
drives `sudo`. That cannot be handed to a colleague, nor to an agent in a
sandbox with no key. A **team token** deploys over HTTPS instead, through this
dashboard, and its holder never holds root. The owner's SSH path does not
change. The holder's side is in [docs/team.md](../docs/team.md); this is the
machine's side.

```
sitesolide deploy (team member, agent)          Authorization: Bearer sst_...
   |  HTTPS, dashboard.<zone>/api/v1/
   v
server.ts          site-dashboard, confined: checks, stages the archive in data/control/<id>/
   |  HTTP over the steward's socket, the bearer relayed untouched
   v
steward.js         root: the token registry, the scope, the slug, the request
   |-- reads/writes /var/lib/sitesolide-steward/team.json             hashes only, 0600
   |-- writes       /var/lib/sitesolide-steward/installs/<slug>.json  the request, scope copied
   |-- runs         systemctl start --no-block sitesolide-installer@<slug>
   `-- reads        /run/sitesolide-installer/<id>.json               the progress, relayed
   v
installer.js       root, one-shot, one project: the pipeline of `sitesolide deploy`
   |-- systemd-run as site-<slug>, no network: installer.js --extract, the archive on stdin
   |-- systemd-run as site-<slug>, network but not the loopback: the manifest's `install`
   |-- useradd, the units, the trees moved into place, the manifest, the loopback's set
   |-- a new project refused before anything was served: its units, tree and account removed
   |-- the Caddy block through the gatekeeper's machine: lock, validate, reload, probe, restore
   `-- writes /run/sitesolide-installer/<id>.json, 0600, after every step
```

### Who runs as whom

| Piece | Runs as | Reads | Writes |
|---|---|---|---|
| The CLI | the holder | the project's folder, the token | nothing on the machine directly |
| `server.ts` | `site-dashboard` | its database, the snapshot | `data/control/<id>/bundle.tar.gz`, `deployments` and `audit` in `dashboard.db` |
| The steward | root, the socket | `team.json`, the installer's results, the journal | `team.json`, `installs/<slug>.json` |
| The installer | root, one-shot | the request, the staged archive's descriptor, the manifests | `/srv/sites/<slug>`, its units, its block, `/etc/passwd` through `useradd`, and `userdel` for a new project it refused |
| The extractor | `site-<slug>`, transient unit | the archive on stdin | the staging directory, nothing else |
| `install` | `site-<slug>`, transient unit | the staged `app/` | the staged `app/`, mounted at its final path |

**The registry is the steward's, not the dashboard's.** The dashboard is
assumed compromised everywhere else in this README: a registry it could write
would let it deploy code into any project, at any time, without the password.
Held by root, a token is judged where the decision is enforced. The dashboard
still checks the shape of what it receives, refuses early what the steward
would refuse (a manifest that does not validate, a scope it reads in the
identity the steward returns), and keeps what is its own: the deployments it
was asked for and the audit.

**Root never parses an archive.** The extraction is the project's own account,
in a unit that sees nothing of `/srv` but the staging directory, with no
network, 256 MiB and five minutes. Root opens the staged file with
`O_NOFOLLOW`, checks it is a regular file with one link that belongs to
`site-dashboard`, and hands the descriptor over: whatever path led there, the
file read is one the dashboard could already read. The reader
([src/installer/tar.ts](src/installer/tar.ts)) refuses absolute paths, `..`,
links of either kind, devices, pipes, duplicates, anything outside `app/` and
`public/`, and caps the data at 512 MiB and 20,000 entries as it reads.

**The same deployment as over SSH.** The installer does not run
`bin/sitesolide.ts` with a local executor: that file's executor only runs or
prints a command, and the pipeline around it is the workstation's (a local
build, rsync, `bin/deploy-caddy.sh`, which redeploys the Caddyfile and the
zone's variables from the workstation's copy, a rewrite of the local
manifest). It runs the same order ([src/installer/pipeline.ts](src/installer/pipeline.ts)
lists it step by step) with the same decisions, borrowed from `bin/cli/`
unchanged: the manifest's validation, the unit and block generators, the
block and unit decisions, the port conflicts, the units no longer declared,
the loopback's project set, the door confirmed under the lock. Two things
differ, both on purpose:

- `install` runs before the files are put in place, in the staging directory,
  because the project's account may write there and not in `app/`. A failing
  install changes nothing served.
- A block or a unit that is exactly what the previous deposited manifest
  generates is replaced without `--force`: the machine can tell a manifest
  that changed from a hand edit, which the workstation cannot. A real hand
  edit still stops the deployment, and the owner settles it over SSH.

### Tokens

- **Created on the *Team* page, unlocked.** A token can run code on the
  machine: it asks for the same ten-minute unlock as the Secrets section,
  checked by the steward. **Revoked without the unlock**, so that closing a
  stolen token never waits on the password; the worst a compromised dashboard
  does with that route is revoke every token.
- **Shown once, kept as a SHA-256**, for the reason
  [portal/README.md](../portal/README.md) gives for guest passwords: 256 random
  bits leave nothing to guess, and a fast hash finds the token by lookup. The
  value is `sst_` and 43 characters of base64url.
- **One per person**: a label, an email, an optional expiry, and a scope, all
  off by default: existing slugs it may deploy; whether it may create projects,
  deploy public sites, use outbound network (`network: outbound` or `egress`),
  declare a domain.
- **Ownership**: a project a token creates is recorded as its own at the start
  of its first deployment, before anything is written, so that a first
  deployment that fails half way stays its creator's, and nobody else's.
- **Failed authentications** are rate limited per address, three tolerated,
  then five seconds doubling up to an hour. Per address and not global, unlike
  the sign-in: there are as many holders as tokens, and a global counter would
  let anyone lock the whole team out.

### What a token's project may not do

Judged by the installer on the manifest it received, after `validate()`, and
earlier by the steward and the dashboard: see
[src/control/policy.ts](src/control/policy.ts).

- **Reserved slugs**: `dashboard`, `portal`, `api`, `analytics`, `landing`,
  `www` and the landing's directory, whatever the scope; a slug another token
  created; an existing slug the token was not granted.
- **Private by default**: a new project goes behind the portal unless the token
  may deploy public sites and the manifest asks for it; an existing project
  keeps the door the machine carries. `portalExempt`, which opens paths, needs
  the public permission; a static site cannot sit behind the portal yet, so a
  private token cannot deploy one.
- **Secrets**: `<slug>.env` and no other name. The unit hands a declared file to
  the service through `EnvironmentFile=`, read as root: a manifest naming
  `dashboard.env` or another project's file would read it.
- **No `lock`**: the preview lock is the owner's, and the installer keeps the
  one the machine carries.
- **Outbound network**: `network: outbound`, and `egress` with it, which
  reaches the hosts the manifest lists through the egress proxy, need the
  token's outbound permission. `connectors` does not: nothing reaches a
  connector until the owner grants it to the project from the dashboard.
- **Bounds**: 1G of memory per service, six services, `install` fifteen minutes
  and 1G, the archive 100 MiB compressed.
- **Ports**: a service with no port gets the lowest free one of 3000 to 3099,
  or the one it had; one another project declares is refused.

### Sharing by token

A team member, or an agent, who deployed a tool shares it with the people who
need it: `sitesolide share alice@acme.com` in its folder, or the two routes
under it, `GET` and `PUT /api/v1/projects/<slug>/sharing`.

```
sitesolide share (team member, agent)          Authorization: Bearer sst_...
   |  HTTPS, dashboard.<zone>/api/v1/projects/<slug>/sharing
   v
server.ts          the steward judges the bearer; the slug, the snapshot's door, the policy, the domains
   |  HTTP on the loopback, the Sharing section's own client
   v
portal             PUT /admin/sharing/<host> { mode, people, domains, actor: "token:<id>" }
   `-- writes      its database, and sharing.update in its audit
```

No new path: the dashboard already relays the *Sharing* section to the portal
there, the one service besides root and Caddy the loopback rule lets reach it.
The steward is asked only who the bearer is, as for every route; nothing in
the registry changes, and neither the steward nor the installer needs updating
for this.

What the dashboard checks, in order ([src/control/sharing.ts](src/control/sharing.ts)):

1. **The token may deploy the project**, its own or granted: any other slug
   reads as `not-found`, as for its logs.
2. **The body is the policy's three keys**, judged by the portal's own rule
   (`borrowed/sharing.ts`), each refused entry named in `details`. An `actor`
   key is refused: a token never speaks for the owner. `public` is refused as
   `out-of-scope`, saying the portal turned off is the owner's, from *Access*.
3. **The site carries the portal** in the snapshot, its manifest and its block,
   as for the *Sharing* section: otherwise `no-portal`.
4. **The domains**: the portal's `GET /admin/sharing` names the domains it
   admits at sign-in, `OIDC_ALLOWED_DOMAINS`. A domain the token adds, or opens
   by switching to domain mode, must be one of them; with none, a token opens a
   site to no domain. One the owner opened, kept open, is not widening, and
   closing is always allowed.
5. **The portal judges again** and records `sharing.update` under
   `token:<id>`: the dashboard records nothing of its own, so that one change
   is one line of the Activity view.

A portal from before sharing answers 404, which the API turns into
`not-available`; a portal that does not answer, into `failure`, 502.

### Threat model

| Threat | What stops it |
|---|---|
| A stolen token | Its scope: the projects granted and its own, private sites unless allowed. Every deployment is in the audit with the token's id and email. Revoking takes one click and no password; an expiry ends it anyway. |
| A malicious archive | Read by the project's account in a confined unit, never by root; links, devices, `..`, absolute paths and duplicates refused, data and entries capped while reading; nothing served changes until the whole archive extracted. |
| A malicious manifest | Re-validated on the machine with the CLI's `validate()`, then the scope; the unit and block are generated from it by the same generators as over SSH. Every string that lands in a block or a unit is judged for it: header values with no `"`, `\`, `{`, `}`, `$` or backtick, since Caddy fills `{$NAME}` and `{env.NAME}` from its own environment, the Cloudflare token included; routes and exemptions that are plain paths; a `start` with no `+`, `!` or other prefix systemd reads, `+` and `!` meaning root; environment values with no space or quote, which would set a second variable; secret names that are plain file names; a `%` escaped. The generators refuse the same again rather than write it. Unknown keys refused, secrets limited to its own file, memory capped. |
| Path traversal | The tar reader's refusals, the extraction's `O_EXCL` and `O_NOFOLLOW`, the unit that sees only the staging directory; on root's side, slugs and deployment ids checked against their shape before they enter a path. |
| Resource exhaustion | Upload counted while it streams (Bun's own cap does not hold for a chunked body), 100 MiB; extraction 512 MiB, 20,000 entries, 256 MiB of memory, five minutes; `install` 1G and fifteen minutes; three deployments running at a time on the machine, claimed when the archive arrives, one per project; three waiting for their archive per token, the newest replacing the oldest, and none of them counted against the machine; an archive that does not arrive in fifteen minutes expires. |
| A token reaching another project | The slug decision on the steward, again on the installer; secrets limited to `<slug>.env`; `install` runs without the loopback, where the other projects listen, and the extraction without any network. |
| A replayed request | The installer refuses a request older than ten minutes or for another slug, and writes nothing for it. |
| A compromised dashboard | It sees the bearers that pass and can use them within their scope, and read deployment logs; it cannot mint a token without the password, nor deploy without one, nor hand root a file it could not read. |
| A token sharing too widely | It shares only the projects it may deploy, opens them only to the domains the portal admits at sign-in, never to the public; every change is in the portal's audit under `token:<id>`, and the owner narrows it from *Sharing*. |
| A compromised project | Its service's unit binds `app/`, `public/` and `data/` alone, so it never sees the staging directory its next deployment is extracted into; once in place, the trees are handed to the deployment account and bound read-only, as over SSH. |

### Where the installer is the weak point

It is root with most of the system writable (`/etc` for `useradd` and
`userdel`, the units, `/srv/sites`, the Caddy blocks). It has to be: deploying a project is root on
the machine whichever way it is done. Its confinement bounds what a bug in its
own code would reach, not what it may legitimately do; what keeps a token from
using it as root is that it never interprets the archive, that every file it
writes is generated by the repository's generators, and that each decision is
the one `sitesolide deploy` already takes.

### Deployment of the control API

Opt-in, and in this order. Nothing happens on the machine until the third
step; each step degrades gracefully without the next.

```bash
cd dashboard && sitesolide deploy   # 1. the API and the Team page
bin/deploy-steward.sh               # 2. the token registry and the control routes
bin/deploy-installer.sh             # 3. the installer's code, its template, its environment file
```

1. **The dashboard.** `/api/v1/` answers `not-available`, and the *Team* page
   says to run the steward's script: the steward in place answers
   `404 no such route` to the control routes, which the dashboard reads as
   "not yet". Check, with a value that has a token's shape and is nobody's:
   `curl -s https://dashboard.<zone>/api/v1/whoami -H "Authorization: Bearer sst_$(printf '0%.0s' $(seq 43))"`
   answers 503 `not-available`, and the *Team* page shows the same banner; the
   other pages are unchanged. Roll back: deploy the previous commit of
   `dashboard/`; the two new tables of `dashboard.db` stay, unread.
2. **The steward.** The *Team* page lists tokens and creates them; the same
   `curl` now answers 401 `unauthenticated`, and a deployment answers
   `not-available` until the installer is there. The steward's script checks
   itself as before. Check, on the machine:
   `sudo -u site-dashboard curl -s --unix-socket /run/sitesolide-steward/secretaire.sock http://steward/team/tokens`
   answers `{"tokens":[]}`. Roll back: `bin/deploy-steward.sh` from the previous
   commit; `team.json` stays, unread, and the tokens come back with the steward.
3. **The installer.** `bin/deploy-installer.sh` writes
   `/etc/sitesolide-installer.env` with `DEPLOY_ACCOUNT`, the account of your
   `server`, and verifies the template with `systemd-analyze verify`. It starts
   nothing. Check: create a token on the *Team* page for yourself, with "May
   create projects", and deploy `examples/bun-app` with it from a workstation
   with no server (`SITESOLIDE_API=... SITESOLIDE_TOKEN=... sitesolide deploy`);
   then `journalctl -u sitesolide-installer@bun-app`. Roll back:
   `sudo rm /etc/systemd/system/sitesolide-installer@.service /etc/sitesolide-installer.env /usr/local/lib/sitesolide/installer.js && sudo systemctl daemon-reload`;
   deployments then answer `not-available` again.

Revoking every token closes the API without touching anything else: *Team*,
*Revoke* on each.

### Upgrading: the manifest's strings, egress, the deployment cap

A security review of the control API tightened what a manifest may write
into a Caddy block or a unit (bin/cli/manifest.ts, fragment.ts, unit.ts),
folded `egress` under the outbound permission, stopped deployments waiting for
their archive from counting against the machine, and made the rate limiting
read the address Caddy appends. Nothing changes on the machine until these
steps run, and each one stands without the next.

Before anything, on the workstation: `bin/test.sh`. Its manifest tests
validate every manifest of the repository and of the sites repository with
the new rules, which are the manifests deposited on the machine: a refusal
there is a manifest to fix before deploying anything. None of them holds a
`%`, so no unit in service diverges once the generator escapes it.

```bash
bin/deploy-installer.sh             # 1. the judge that counts: validate(), the scope, the generators
cd dashboard && sitesolide deploy   # 2. the API's early refusals, the cap, the limiter, the Team page
bin/deploy-gatekeeper.sh            # 3. the same generator for the portal's door
```

1. **The installer.** Check: a token deployment whose manifest carries
   `"headers": { "X-Test": "{$CLOUDFLARE_API_TOKEN}" }` fails with
   `invalid-manifest` and writes nothing; `examples/bun-app` still deploys.
   Roll back: `bin/deploy-installer.sh` from the previous commit.
2. **The dashboard.** Check: the same manifest is refused at
   `POST /api/v1/deployments` before any upload; a token without outbound
   network gets `egress: your token may not reach outside hosts`; the *Team*
   page's outbound permission mentions the hosts a service lists. Roll back:
   deploy the previous commit of `dashboard/`; no table changed.
3. **The gatekeeper.** Check: putting a site's portal up and down from the
   dashboard still works. Roll back: `bin/deploy-gatekeeper.sh` from the
   previous commit.

The steward needs nothing: it judges tokens and slugs, not manifests.

### Upgrading: sharing by token

`GET` and `PUT /api/v1/projects/<slug>/sharing`, and `sitesolide share` on the
workstations. Opt-in in the plainest sense: nothing changes on the machine
until somebody shares, and the routes only reach the portal's database, never
Caddy. The steward, the gatekeeper and the installer need nothing.

```bash
bin/test.sh                         # 0. on the workstation
cd dashboard && sitesolide deploy   # 1. the two routes
```

0. **The workstation.** Pull, then `bin/test.sh`. Check, in the folder of a
   site behind the portal: `sitesolide share` prints who gets in, `over SSH,
   as the owner`, and changes nothing. That read is the owner's way: root asks
   the portal on the loopback (`sudo curl -sS http://127.0.0.1:3026/admin/sharing`),
   after reading the site's manifest and block; it needs `curl` on the machine,
   which sitesolide setup installs, and a portal that knows sharing (portal/README.md,
   "Upgrading", step 1). A portal from before it is said so, and nothing is
   changed.
1. **The dashboard.** Check, with a token of yours that may deploy a site
   behind the portal, from a workstation with no server
   (`SITESOLIDE_API=https://dashboard.<zone> SITESOLIDE_TOKEN=sst_...`):
   `sitesolide share` prints the policy `through https://dashboard.<zone>`;
   `sitesolide share you@<your domain>` saves it, and the *Sharing* section of
   that site shows you listed; the portal's audit, `sudo curl -s
   'http://127.0.0.1:3026/admin/audit?limit=1'`, shows `sharing.update` with
   the actor `token:<id>`; `sitesolide share --domain gmail.com` is refused
   with `out-of-scope` unless `gmail.com` is in `OIDC_ALLOWED_DOMAINS`. Then
   `sitesolide share --remove you@<your domain>` to put it back. Before this
   step, the API's catch-all answers these routes `not-found`, `no such
   route`, which the CLI says as `not-available`: the dashboard does not carry
   sharing yet.

**Rolling back.** Deploy the previous commit of `dashboard/`: the two routes
answer `not-found` again, nothing else changes, and the policies a token set
stay in the portal, where the *Sharing* section shows and changes them.

### Upgrading: a refused new project leaves nothing behind

A verification on a test machine found that a new project the installer
refused, its archive above all (a `..`, a link), kept the account and the
empty `/srv/sites/<slug>/{app,public,data}` created before the archive was
judged: the zone's wildcard served that empty tree to everyone, and the
token's `status` listed it as a public project of no type. The installer now
removes what it created, units, tree, then account, when it stops before
anything was served, and only for a project whose tree did not exist: an
existing project, an account or a unit already on the machine are never
touched. A stop from the Caddy step on keeps everything, as before. The same
verification found a private token deploying `dashboard` told "this site is
public on the machine" (422) instead of `reserved` (403): the dashboard now
judges the reserved slugs first. Each step stands without the other.

```bash
bin/test.sh                         # 0. on the workstation
bin/deploy-installer.sh             # 1. the installer, which undoes what it created
cd dashboard && sitesolide deploy   # 2. the reserved slugs judged first
```

1. **The installer.** It now runs `/usr/sbin/userdel`, from the same package
   as `useradd` on Debian and Ubuntu, under the template unit as it stands:
   `/etc` is already writable for `useradd`. Check, with a token that may
   create projects, from a workstation with no server: in a throwaway folder
   holding a `server.ts`, a manifest `{ "slug": "undo-check", "start":
   "/usr/local/bin/bun run server.ts", "install": "false" }` fails with
   `install-failed`, and its log ends with `removed    /srv/sites/undo-check`
   and `removed    site-undo-check`; on the machine, `getent passwd
   site-undo-check` prints nothing and `ls /srv/sites/undo-check` finds
   nothing. `examples/bun-app` still deploys. A `userdel` that fails says so
   in the log and leaves the account: `sudo userdel site-<slug>` removes it.
   Roll back: `bin/deploy-installer.sh` from the previous commit.
2. **The dashboard.** Check: the same token deploying a folder whose manifest
   names `"slug": "dashboard"` gets `reserved`, 403, "pick another slug".
   Roll back: deploy the previous commit of `dashboard/`; no table changed.

## Deployment, in this order

```bash
cd dashboard && sitesolide deploy   # user, layout, unit, relay and page
bin/deploy-backup.sh install        # the backup component, before the steward; starts nothing
bin/deploy-steward.sh               # builds, installs and checks the steward
bin/deploy-gatekeeper.sh            # builds, installs both unit templates, starts nothing
bin/deploy-installer.sh             # builds, installs the installer's template, starts nothing
bin/deploy-backup.sh enable         # a first snapshot of every project, then the hourly timer
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
| `steward.ts`, `src/secrets/`, `src/connectors/` (steward side), `bin/cli/connectors.ts`, `infra/steward/`, `portal/src/sharing.ts` | `bin/deploy-steward.sh` |
| `gatekeeper.ts`, `src/gatekeeper/`, `infra/gatekeeper/`, `bin/cli/fragment.ts`, `bin/cli/portal.ts` | `bin/deploy-gatekeeper.sh` |
| `src/control/steward.ts`, `src/control/system.ts`, `src/control/tokens.ts`, `src/control/policy.ts` | `bin/deploy-steward.sh` |
| `src/members/steward.ts`, `registry.ts`, `sessions.ts`, `system.ts`, `actions.ts`, `powers.ts`, `unlocks.ts`, `portal.ts`, `infra/steward/sitesolide-portal-relay.*`, `portal/src/assertion.ts` | `bin/deploy-steward.sh`; the last one `sitesolide deploy` in `portal/` too |
| `installer.ts`, `src/installer/`, `src/control/policy.ts`, `infra/installer/`, `bin/cli/` generators | `bin/deploy-installer.sh` |
| `backup.ts`, `src/backup/` (but its steward routes), `infra/backup/` | `bin/deploy-backup.sh install` |
| `src/backup/routes.ts`, `src/backup/reader.ts` | `bin/deploy-steward.sh` |
| `src/backup/database.ts`, which both embed | `bin/deploy-backup.sh install` and `bin/deploy-steward.sh` |
| anything else | `sitesolide deploy` |

When the CLI's block generator changes the blocks it writes, as it did when its
file servers began to hide `.git` and `.env*`, update the gatekeeper and the
installer **before** redeploying other sites with the new CLI: until then, they
take a block of the new generation for a hand edit, and refuse a portal change
or a token's deploy of that site, changing nothing served. See
[docs/commands.md](../docs/commands.md), "Upgrading to the hardened deploy", for
the order of that release. The installer now also asks systemd what it knows of
a unit name before writing anything (`systemctl show -p LoadState -p
FragmentPath`), and stops on `system-unit` when it is a service of the machine.

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
vault. Its steward carries the real member routes, and its portal signs
members in: *Sign in with Google* on the sign-in page leads to a page of the
bench's that signs in alice@example.com, a Developer on `cms`, a Project admin
on `calendar` and a Viewer on `photos`, or stranger@example.com, whom the
registry does not name. The same page stands for the provider's forced
sign-in when a member unlocks, and the bench's steward judges a member's
secrets and door by role before its own fake operations.

## Tests

```bash
bun run check   # tests, type checking, then the page's own tests
```

What is covered: the state judgement and every discrepancy it reports, the
session and its rate limiting, the password draw against a fixed byte sequence,
the secrets scope and its three guard rails, the steward's protocol on a real
Unix socket, the gatekeeper's transaction including its rollbacks, and the
gatekeeper in front of a real Caddy started on a free port with `admin off`.

For the control API: the tokens and every scope decision; the tar reader
against hand-made malicious archives (traversal, links of both kinds, devices,
duplicates, a compression bomb, too many entries, a corrupt or truncated
archive); the installer's pipeline on a throwaway tree with a real extraction
in a child process, a real `install`, and every refusal, before and after the
files are in place; the steward's control routes on real files; and the whole
chain, the API on a real port, the steward on a real socket, the installer
started by the simulated `systemctl` (tests/control-api.test.ts); sharing by
token on a real port in front of a fake portal on another, every authorisation
and the actor the portal receives (tests/control-sharing.test.ts). What only a
machine can prove, `useradd` and `userdel`, `systemd-run`'s confinement and
the template unit, is not covered here.

For the members: every decision of the steward's on a throwaway tree, a
signature by another key, another audience, an assertion expired, replayed,
even after a restart, too old, an email the registry does not name, a viewer's
restart, a project with no role, a member removed, even while their restart
waited its turn, and the journal naming who it verified
(tests/members-steward.test.ts); the registry, the sessions and what a member
sees of the snapshot (tests/members-registry.test.ts); sessions with an
identity, the steward asked who they are, the rate limiting
(tests/members-sessions.test.ts); and a member's whole road through the real
`server.ts` in its own process, the steward's routes on a real socket and a
portal of the tests' making that signs with the steward's key
(tests/members-flow.test.ts), the way back from the provider carrying no
Strict cookie, a forced sign-in unlocking, one not forced or for another
account refused, a Developer's write and refused read, a Project admin's read,
sharing, guest and invitation, and the super admin's unlock beside a
member's.

For the members' powers: each decision of the steward's on a throwaway tree
with a real backup reader and a portal of the tests' making
(tests/members-actions.test.ts): an unlock only on a forced sign-in for the
session's own email, fresh and once, one per session, neither evicting the
super admin's nor another member's, locked on demand, at sign-out and on
removal, counted per member; a Developer listing names only, writing,
refused a read before any file is read; a Project admin reading; another
project, a viewed one, the platform's, a registry edited by hand and a
password hash refused; a write that waited behind a restart refused once its
member was removed; the door, sharing with the domain rule, guests and a
restore by role, the actor the steward's; invitations at most one's own role,
on one's own project. The table itself, the unlocks and a Project admin's
registry changes, pure (tests/members-powers.test.ts).

For the audit: each source's rows in the shared shape, bounded, and garbage
left out (tests/audit-merge.test.ts); the merge, the filters and a cursor
followed to the end against simulated sources, every row once and in order
whatever the page size, a source down, too old, not installed, stalled past
the deadline or throwing, and a budget that runs out (tests/audit-aggregate.test.ts);
each reader against the answers its component really gives, a steward that
pages and one that does not, and the whole route against a portal and an
egress proxy on real ports and a steward on a real socket
(tests/audit-sources.test.ts).
