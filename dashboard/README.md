# dashboard

What the machine actually runs, at `dashboard.<zone>`, behind a password, on two
levels. **The machine**: *Sites*, the home page, with the state of the machine,
the discrepancies between what the repositories ask for and what the machine
does, the only part of the dashboard that teaches you something, and the list
of sites; *Activity*, the audit of the whole machine, every component's in one
log; *Tokens*, the tokens that deploy without SSH; *People*, everyone with
access to a project, their roles, and who may create projects; *Connectors*,
the credentials the egress proxy lends to projects. **A site**: *Overview*,
*Audience*, *Secrets*, *Access* and *Backups*, everything that concerns that
site and only it, *Access* saying who may open it and who may do what on it.
Someone with a role on a project signs in with their company account, and
sees Sites and Activity reduced to their projects, and in a project the
sections their role there opens: see [Access](#access).

Bookmarks of the pages from before keep working: `/team/` opens *Tokens*,
`/members/` *People*, and a site's `/site/sharing/`, `/site/guests/` and
`/site/members/` its *Access*, the site kept (`web/src/lib/pages.ts`).

**Few writes, and each one is a decision.** No button sets a preview lock. One
machine serves every site, with no staging and no automatic recovery: what
touches their shared configuration stays in the workstation's scripts, under the
eyes of whoever runs them. A few exceptions, and in each the dashboard only
relays to a component that judges for itself what it accepts:

- **who may open a site and who may do what on it**, a site's *Access* and the
  *People* page. The steward keeps the one registry, judges every change by
  its rules, and writes the projection the portal reads; the dashboard never
  touches the portal's decisions. A token gives Can open on the projects it
  may deploy through the control API, by the same steward: see
  [Access by token](#access-by-token);
- **the secret files of every deployed project** in `/etc/sitesolide`, and the
  restart of its service, the *Secrets* section. The steward, a root daemon,
  decides;
- **a project's general access, public or restricted**, in its *Access*
  section, the only button in the dashboard that reloads Caddy. The steward
  asks the gatekeeper, a root one-shot that validates, reloads, probes every
  site and restores at the slightest discrepancy;
- **the egress proxy's connectors and their grants**, the *Connectors* page,
  written by the steward under the same unlock as a secret, see
  [Connectors](#connectors);
- **a deployment by a token**, the control API under `/api/v1/` and the
  *Tokens* page. The steward judges every token and starts the installer, a
  root one-shot that deploys one project as `sitesolide deploy` would. See
  [The control API](#the-control-api);
- **a project's data, put back as a snapshot had it**, the *Backups* section.
  The steward starts a restore one-shot, which saves the current data first,
  swaps the folders and puts them back if the service does not come back. See
  [src/backup/README.md](src/backup/README.md);
- **the work of the people who sign in here on their projects**, a project's
  sections as their role opens them. The steward opens a person's session
  from an assertion the portal signed, unlocks them on a forced sign-in, and
  judges by role every restart, secret, change of general access, restore and
  change of access they ask for. See [Access](#access).

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

The rest of what guards it:

| Measure | Detail |
|---|---|
| Session | 32-byte token, kept **hashed** in the database, `__Host-` cookie, `HttpOnly`, `SameSite=Strict`, seven days; a person's, signed in with their company account, twelve hours, under their email in the same table (see [Sessions](#sessions)) |
| Rate limiting | after 3 failures, 5 s doubling up to an hour, **global** rather than per address: one password, and changing address would sidestep a per-IP counter for free. The sign-ins of people with a company account are counted per identity, beside it |
| `Origin` | compared to the literal `PUBLIC_URL`, on sign-in, sign-out, every change of access and every non-`GET` secrets route, general access included. Behind Caddy, `req.url` announces `127.0.0.1:3022` and cannot serve as a reference. With `SameSite=Strict` it stands in for a CSRF token: `src/sessions.ts` says why a token would add nothing |
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
   |-- writes /var/lib/sitesolide-steward/access-log.jsonl  the changes of access, kept 180 days
   |-- reads  /etc/caddy/sites/<slug>.caddy              whether the portal is in front of it
   |-- writes /etc/sitesolide-egress/*.json              the connectors, see Connectors
   |-- reads  /var/backups/sitesolide/<slug>/            the snapshots, by name
   |-- reads  /var/lib/sitesolide-backup/backup.db       the bucket's index, the audit
   |-- writes /var/lib/sitesolide-backup/requests/       a restore request, consumed by the one-shot
   |-- keeps  /var/lib/sitesolide-steward/access.json    who may do what on each project, see Access
   |-- keeps  /var/lib/sitesolide-steward/member-sessions.json  the sessions of people who sign in
   |-- writes /etc/sitesolide-portal/access.json         the projection the portal decides from
   |-- lays   /etc/sitesolide-portal/assertion.key       the private key the portal signs dashboard sign-ins with
   |-- reads  /srv/sites/portal/data/portal.db           once, a checked copy, to make the first registry
   |-- asks   /run/sitesolide-portal-relay/portal.sock   the portal's admin API: what it decides from
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
  the owner has one, which unlocking from another of their sessions
  replaces; each session of a person has its own (see [A person's unlock](#a-persons-unlock)).
  Neither evicts the other. The steward keeps only their hashes.
- **The token never goes to the browser.** The dashboard's service keeps it in
  memory, attached to the session's hash, and forgets it on sign-out,
  where it revokes it, as on its own restart: you unlock again, nothing more.
- **Rate limiting per principal**, taken from sign-in: three failures, then 5 s
  doubling up to an hour. The owner's, global to their one password, **is
  held on disk** and survives a steward restart; *Change password* counts its
  attempts there like an unlock. A person's counts their refused forced
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
ten minutes, among them the portal's sign-in settings, and giving people
roles or password access. Without an unlock, it can give Can open to the
company's people and domains, and take anyone's access away, through the
steward, which records each under the owner's name (see the [threat model of access](#threat-model)). It never touches Caddy itself, the
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

## Access

Who may do what on a project, in one model. Per project, its **general
access**, who may open the site at all, and its **people with access**, a
list of entries `{ who, role }`, `who` an email or a whole domain written
`@acme.com`. Beside the projects, one person may do everything: **the
owner**, whoever holds the dashboard's password, made by `sitesolide setup`,
who keeps it to sign in and to unlock. Everyone else holds what the list
gives them, project by project, signs in with their company account through
the portal's identity provider, and never holds the dashboard's password or
root; they mint tokens of their own, never stronger than their roles, see
[A person's own tokens](#a-persons-own-tokens).

**General access** is what the machine already carries, not a list the
registry keeps:

| General access | Who opens the site | What carries it |
|---|---|---|
| **Public** | anyone | the manifest's `portal` flag off, and its block |
| **Restricted** | the people with access, signed in by the portal in front of the site | the manifest's `portal` flag on, and its block's `forward_auth` |
| **Anyone with the code** | whoever has the preview code | the preview lock, `sitesolide lock` |

Public and restricted switch from a site's *Access*, under the unlock,
through the steward and the gatekeeper: see [The portal, from the
dashboard](#the-portal-from-the-dashboard). The code is set and removed with
`sitesolide lock` alone, from the project's folder, never from the page.

**People with access** hold one rung of a ladder, each including the ones
below:

| Role | On that project | Unlock |
|---|---|---|
| **Can open** (`visitor`) | opens the site when its general access is restricted, and sees nothing in the dashboard | none |
| **Viewer** | also sees the project in the dashboard: its state, audience and activity | none |
| **Developer** | also restarts its service; lists its secret files, names and metadata; sets, replaces and removes a variable, replaces a file read whole, creates a declared file, and never reads a value back; deploys it with a token of their own | to write, to mint a token |
| **Admin** | everything of the project: what a Developer does, reads a value or a file back, restores a file's previous version, switches its general access between public and restricted, gives and takes away access to it, a role at most their own, lists and restores its backups; a token of theirs may also deploy it in the open, declare a domain and reach outside hosts | to read, write, restore, switch general access, give a role above Can open or password access, mint a token |

Who may hold which role is the steward's to decide, alone
([src/access/rules.ts](src/access/rules.ts)), on rules few and strict:

- **a domain is Can open only**, and only once signing in with a company
  account is set up: everyone at acme.com opens the site, and nobody
  administers anything for being there;
- **a person inside the company's domains** signs in with their company
  account and may hold any role. The company's domains are
  `OIDC_ALLOWED_DOMAINS`, read from `portal.env`: with that list empty,
  anyone the provider vouches for; the admin emails always;
- **a person outside them**, or anyone when no provider is set up, is Can
  open only, with **password access**: the steward draws a password of four
  groups of four characters, shown once, which they type on the portal's
  sign-in page, for 24 hours, 7 days (the default), 30 days or with no
  expiry, chosen when it is given. The registry and the portal keep its
  SHA-256 alone: drawn at random, it leaves nothing to guess, and a fast hash
  finds it by lookup;
- **an Admin gives at most their own role, on their project alone**, and a
  domain only among the company's; **the owner gives anything**;
- **removing someone, or lowering them, holds from their next request**, on
  the site as in the dashboard.

Beside the roles, one right per person, the owner's to give: **may create
projects**. A person who holds it mints a token that may create projects,
and becomes Admin of each one it creates. And `OIDC_ADMIN_EMAILS` keeps its
meaning: those addresses open every restricted site, as `admin`, and
*People* shows them as such.

**Who signs in to the dashboard**: someone with a role above Can open on a
project, or the create right. Someone with Can open alone, or password access
alone, opens sites and nothing more: the dashboard refuses their sign-in,
saying they have no role on it. When someone's last role above Can open
goes, removed or lowered, and they do not hold the create right, their
dashboard sessions close and their tokens are revoked.

The table of powers is the steward's, [src/people/powers.ts](src/people/powers.ts),
and the page reads it to offer what the steward will accept. Nothing in it
reaches the machine itself: a role is never given on the platform's
projects, `dashboard`, `portal`, `api`, `analytics` and the landing, and the
steward refuses a person any file it lays for root, `dashboard.env` and
`portal.env` among them, whatever a registry edited by hand would claim. A
password hash changes with the dashboard's own password, the owner's alone;
so do the preview codes, the tokens of others, the connectors and the
*People* page.

### One registry, the steward's

```
steward.js         root, the only writer
   |-- reads/writes /var/lib/sitesolide-steward/access.json   the registry, root 0600, written atomically
   `-- writes       /etc/sitesolide-portal/access.json        its projection, root:site-portal 0640
                         |
portal             site-portal: reads the projection again whenever it changes
dashboard          site-dashboard: reads neither, asks the steward
```

**The registry** holds, per project, its entries, each `{ who, role, by,
createdAt, updatedAt }`, and for password access `password: { id, hash,
expiresAt }`; the people who may create projects, `creators`; and
`migration`, when and from what it was first made, with what it set aside.
It is root's for the reason the tokens' registry is: one the dashboard or
the portal could write would let either of them make anyone an Admin of
anything. The steward reads it at every decision, so a role taken away
holds from the next request, and makes every change in one queue: two
changes read side by side would each write a registry without the other's.
A file that does not read is never guessed at: every person is refused
until the owner looks, the journal and every answer saying why.

**The projection** is what the portal needs and nothing more: per host,
`<slug>.<zone>`, `{ slug, people: { email: role }, domains, passwords: [{ id,
who, hash, expiresAt }] }`. It lies beside the assertion key, in the same
folder with the same rights, for the same reason (see [The key
pair](#the-key-pair)): root writes it, the portal's account reads it, the
dashboard's cannot. The steward writes it **before** the registry: a change
the portal cannot be told of is no change, and the registry stays as it
was; a registry write that fails after it leaves the projection a step
ahead, which the next change or the next start writes again. At startup the
steward writes it again from the registry, which also sets right one edited
by hand; with its folder or the portal's group missing, it says so once, and
tries again within the minute once the portal is deployed.

**The portal decides from it, and stores no list any more.** It checks the
file's inode, size and modification time at every request, one `stat`, and
reads it again whole when they move, so a removal holds at the next request.
A projection that does not read opens nothing but the owner's password and
the admin emails. A portal that finds none and has never read one decides
from its own tables of before, `sharing` and `invites`, read-only, so that
the order of an upgrade opens and closes nothing; once it has read one, it
leaves a mark, `data/access-from-steward`, and never reads those tables
again. Its sessions stay its own. `GET /admin/access`, on the loopback, says
what it decides from: `{ reading: "steward" | "portal" | "unreadable",
writtenAt }`. The header a restricted site reads, `X-Sitesolide-Role`, now
carries the role on this ladder: see [portal/README.md](../portal/README.md).

**The steward asks it, through the relay, and tells nothing.** Every access
answer says what the portal decides from, `portal.reading`, from `GET
/admin/access` asked through `sitesolide-portal-relay`: a socket only root
opens, `/run/sitesolide-portal-relay/portal.sock`, behind which systemd's own
`systemd-socket-proxyd`, root with no capability and the loopback alone,
forwards to the portal's port and to nothing else
(infra/steward/sitesolide-portal-relay.socket). The steward's own unit keeps
no network. `portal` is a portal still deciding from its own tables, from
before the registry or before its first projection, which the page and
`sitesolide share` say to upgrade; `unknown`, a portal the steward could not
ask. Nothing is written through the relay: the portal reads, and is never
told.

**The first registry is made from the stores before it**, once, at the
steward's first start on this code: `members.json`, in its own state folder,
and the portal's database, read as root from a checked copy. What is
carried, what is set aside and why, and how to go back, are in
[docs/migration.md](../docs/migration.md#access-the-registry-made-from-the-stores-before-it).

### Who decides what

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
steward.js         root: the signature with its own public key, the audience, the expiry, the nonce
                   never seen, a role above Can open or the create right in access.json; the session drawn
   |-- reads        /var/lib/sitesolide-steward/access.json            the registry, 0600
   |-- reads/writes /var/lib/sitesolide-steward/member-sessions.json   sessions and nonces, hashes only
   |-- keeps        /var/lib/sitesolide-steward/assertion.pub          the public key, 0600
   `-- lays         /etc/sitesolide-portal/assertion.key               the private key, root:site-portal 0640
```

**The portal says who; the steward says what they may do.** The dashboard
is assumed compromised, as everywhere in this README, so it is never
believed when it names someone. The portal, the one authority on
identities, runs its usual sign-in (portal/README.md, "Signing in with a
company account") and signs what the provider proved: an Ed25519 assertion
(portal/src/assertion.ts) of the verified email, when the person last signed
in at the provider, for the dashboard alone, for five minutes, with a nonce.
The steward checks it with the public key it keeps itself, refuses it
replayed, too old, or for an email the registry gives neither a role above
Can open nor the create right, and only then opens a session. Every write a
person asks for carries that session, and the steward judges it against the
registry as it reads at that moment: the person still there, their role on
that project. Its journal names the email it verified, never one a request
carries. A compromised dashboard can act only for the people whose sessions
pass through it, within their roles; it can neither raise anyone above Can
open nor give password access without an unlock, nor forge an assertion, the
private key being out of its reach.

**What a person sees, the dashboard filters**, from data it already holds:
`/api/state` keeps their projects alone and drops the machine's own figures,
`/api/audit` keeps the rows of their projects and their own
(src/people/view.ts, src/audit/merge.ts), the backups keep those of the
projects where their role shows them (src/people/relay.ts). A site's
Secrets and Backups, and the *Tokens* page, answer at the owner's addresses:
`server.ts` sends a person's session to src/people/relay.ts (`either()`),
which adds their session and unlock and relays to the steward, which judges.
`/api/access` tells the owner from a person itself, and sends a person's
request to the steward's `/access/person/*` routes (src/access/routes.ts);
*People* is the owner's alone. The owner's handlers read the owner's
sessions alone (`ownerSessions` in src/routes.ts), so that a route
forgetting to dispatch still refuses a person, and every other route answers
a person 403 before its handler runs. `/api/session` names the one signed in,
`owner` or `person`, with a person's email, roles and create right.

The page shows a person what is theirs and hides the rest
(`machinePagesFor` and `sectionsFor` in web/src/lib/pages.ts): Sites and
Activity, *Tokens* for their own tokens when a role or the create right lets
them mint one, and in a project the sections their role there opens:

| Role | Sections |
|---|---|
| Viewer | Overview, Audience, Access, read only: its general access, a note that only the project's Admins see the list, and what each role can do |
| Developer | the same and Secrets, values write-only; *Restart* in the Overview's Service panel |
| Admin | Overview, Audience, Secrets, Access, where they give people access, and Backups |

A page that is not theirs, reached by its address, says so in an empty state
rather than an error, and the service refuses it too.

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
created `0755` by `bin/deploy-steward.sh`; the file is `root:site-portal
0640`: root writes it, the portal's account reads it, the dashboard's
cannot. It never enters an environment, where every process of the portal's
account and a crash report would see it. `portal.env` keeps its rule, a hash
and the `OIDC_*` settings, nothing else. The steward's unit makes the folder
writable with `ReadWritePaths=-/etc/sitesolide-portal`, the dash for a
machine where it does not exist yet. The access projection lies beside the
key, for the same reasons.

### Sessions

A person's session is the steward's: it draws the token when the assertion
checks out, the dashboard sets it as the browser's `__Host-session` and keeps
its hash in `dashboard.db`, under the person's email in the `identity`
column of `sessions`, beside the owner's (`owner`). Every request of theirs
presents it, and the dashboard asks the steward who it belongs to, the
answer kept five seconds (src/people/identity.ts): removed, or left with Can
open alone, a person sees nothing more within seconds, and their next write
is refused at once. Both sides keep hashes only; the steward keeps its own in
`member-sessions.json`, so that restarting it, or the dashboard, signs
nobody out.

| Measure | Detail |
|---|---|
| Lifetime | twelve hours, the steward's and the cookie's alike. The portal spares a dashboard sign-in the provider only while its own session is younger than twelve hours (`DASHBOARD_REAUTH_S`): a person closed at the provider is out of the dashboard a day after they last proved themselves there at most, as out of every site |
| Assertion | five minutes, once: its nonce is remembered on disk until it would have expired. A sign-in at the provider older than a day opens no session |
| Rate limiting | per identity, three refusals tolerated then five seconds doubling up to an hour, and ten sign-ins in ten minutes for one email; sixty sign-ins a minute for the whole machine; the owner's password counter unchanged, global (src/people/limiter.ts) |
| Bounds | ten live sessions per person, the oldest giving way; a thousand on the machine; two hundred people who sign in to the dashboard; six hundred entries per project |
| Rotation | a new owner's password closes the owner's sessions, never a person's, which do not rest on it |
| Sign-out | closes the dashboard's row and the steward's session, which journals `dashboard.signout` |

### A person's unlock

Whatever reads or writes a secret, switches general access, restores data,
gives a role above Can open or gives password access asks for the person's
own unlock, the way the owner's asks for the password. A person has no password: they sign in
again, made to by the provider.

```
page, Unlock                                  the person's session open
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

- **One token per session**, ten minutes fixed, which use does not extend,
  kept by its hash in the steward's memory (src/people/unlocks.ts): a
  restart of the steward locks everyone. The same person unlocking again in
  that session replaces it; another person, the same person in another
  browser, the owner, each keeps their own. The dashboard keeps the token in
  memory against the session's hash, in a store apart from the owner's, and
  never sends it to the browser.
- **The provider's word, not the portal's clock.** The portal asks every
  provider for `max_age=0`, and all but Google for `prompt=login`, which
  Google does not document; by the OpenID Connect specification a provider
  asked for `max_age` says in `auth_time` when the person signed in, and the
  portal signs `reauth` only when that time falls within the flow
  (portal/src/oidc.ts, `freshReauth`). A provider that ignores the request
  hands back its old sign-in, and the unlock is refused, never believed:
  with Google, check on the installation that it does ask again before
  relying on these unlocks.
- **The steward checks it all again**: `reauth`, `auth_time` five minutes
  old at most, the email the session's own, the nonce spent with the
  sign-ins'. A sign-in's assertion, which may ride on the provider's
  session, never unlocks.
- **The session survives the provider's site.** The session cookie is
  `SameSite=Strict`, and the way back from a provider on another domain is a
  cross-site navigation, which never carries it. The dashboard keeps, from
  `begin`, the session against the binding, which does travel (`Lax`), ten
  minutes at most, a thousand in flight at most.
- **Bounded**: a person's refused unlocks, three tolerated then five seconds
  doubling up to an hour; sixty attempts a minute for the whole machine; the
  owner's password counter untouched. A Viewer everywhere has nothing to
  unlock and is told so.
- **Locked** on demand, at sign-out, and for every session of someone who no
  longer signs in.

### A person's work, judged by the steward

The page asks the owner's routes, `/api/secrets/*`, `/api/backups`, whoever
is signed in; for a person, src/people/relay.ts relays to the steward's
`/members/*` routes with the session and the person's unlock token, and
src/people/actions.ts judges, in the order of the risk: the session, the
person's unlock where the power needs one, the role on that project, the
machine's own projects and files refused, then the operation, under the
steward's lock, where the session, the unlock and the role are asked again.
The operations are the owner's own code, src/secrets/steward.ts and
src/backup/routes.ts, handed the person as `who`: the journal and the
backups' audit name the email the steward verified, never one a request
carries.

- **A Developer reads nothing back.** The listing hides every value, size
  and previous version from them, a write answers with the file's names
  only, and a read is refused by role before any file is opened, the refusal
  journaled with their role.
- **General access goes the owner's road.** An Admin switching their site
  between public and restricted takes `/members/portal`, under their unlock,
  the steward checking the role before it asks the gatekeeper, as it would
  for the owner. The preview code stays `sitesolide lock`'s.
- **People with access are the access routes'**, `/access/person/*`, judged
  by src/access/rules.ts with the Admin as the one who gives: see
  [Granting, changing, removing](#granting-changing-removing).
- **A restore's requester is the steward's to say**, the person's email,
  written into the request the restore one-shot reads.

### A person's own tokens

A person deploys from their workstation's CLI, or an agent of theirs, with a
token they mint on the *Tokens* page, which shows them their own tokens
alone. The steward judges it, in src/people/tokens.ts, and **a person's
token is never stronger than the person**:

| In the scope | Takes, as the registry reads at that moment |
|---|---|
| a slug | a Developer or an Admin role on it (`deploy`) |
| `create` | the person's create right |
| `public`, `domain`, `outbound` | Admin of every slug of the token (`deploy.public`, `deploy.domain`, `deploy.outbound`); with `create` alone, the projects it creates being theirs to administer |

```
page, Tokens, New token                      the person's session, unlocked
   |  POST /api/tokens { label, expiresAt, scope }
   v
server.ts          src/people/relay.ts: origin, session, the person's unlock kept in memory
   |  POST /team/member/tokens { session, token, label, expiresAt, scope }   on the steward's socket
   v
steward.js         src/control/steward.ts: the session and the unlock asked of the sign-in routes,
                   again in the registry's queue; the scope against the person's rights now;
                   the token written with `member`, their email on it; token.create journaled
```

- **Minted under the person's own unlock**, the forced sign-in at the
  provider, and asked again once its turn has come; a refusal names every
  reason in the steward's words, and enters the journal, bounded per
  minute. A Viewer everywhere without the create right mints nothing and has
  no *Tokens* page; one with the create right unlocks for it. Ten live
  tokens per person at most, so that one person cannot fill the two hundred
  of `team.json`.
- **Narrowed at every use.** `team.json` keeps the scope as minted and the
  person's email, in its `member` field; the steward reads `access.json`
  whenever the token authenticates, which every request of the control API
  does, and hands on the scope narrowed to the person's rights: the slugs
  where they still deploy, the projects it created likewise, `create` while
  they hold the right, the options while they are Admin of every project it
  still reaches. Before the token's own rule (`decideSlug`), which counts a
  project the token created as its own, the person's role on the slug
  decides: a project lowered to Viewer is refused even to the token that
  created it. The request the installer reads names the person, and the
  installer reads the registry once more when it starts
  (src/installer/main.ts), refusing `out-of-scope` before anything is
  written: the steward's copy is seconds old, a deployment can wait behind
  another.
- **An existing project keeps its general access**, for a person's token
  too: its Admin or the owner chose it, and a deployment never changes it.
  An owner's token without `public` deploys no public site, an existing one
  included, so that a stolen one publishes nothing; a person's token answers
  to the person's role instead, and a Developer deploys a public project as
  it stands (src/control/policy.ts, `decideDoor`). What opens a site, a new
  project in the open, paths exempted from the portal, takes `public`.
- **What a person's token creates is theirs to administer.** At the start of
  a project's first deployment, before anything is written on the machine,
  the steward makes the person its Admin in `access.json`, in the registry's
  queue, journaled as `project.create` under their email, then records the
  token's ownership in `team.json`, as for any token.
- **Access by a person's token** gives Can open alone, and only where the
  person is Admin now: see [Access by token](#access-by-token).
- **Someone who no longer signs in takes their tokens with them.** Once the
  registry is written, outside its queue, the steward closes their sessions
  and asks the control routes to revoke every live token of theirs,
  journaled as `token.revoke` under the owner or the Admin who took their
  last role above Can open; and a token whose person the registry no longer
  lets sign in is refused anyway. Revoking one of their own needs no unlock;
  the owner's *Tokens* page lists every token, a person's own marked, and
  revokes any.

The steward's routes for it, on the dashboard's socket, under `/team/`, a
protocol name the *Tokens* page kept:

| Route | What it does |
|---|---|
| `POST /team/member/list` `{ session }` | the person's tokens, their roles and create right, the end of their unlock |
| `POST /team/member/tokens` `{ session, token, label, expiresAt, scope }` | mints one, the person's unlock asked |
| `POST /team/member/revoke` `{ session, id }` | revokes one of theirs; anyone else's reads as unknown |

### Granting, changing, removing

From a site's *Access* and the *People* page, with `sitesolide share` and
`sitesolide people` over the owner's SSH, or with `sitesolide share` and a
token ([docs/commands.md](../docs/commands.md)). All of them end at the
steward, which judges by src/access/rules.ts, reading the sign-in settings
from `portal.env` at each change:

| Who asks | From | May give | Asks for |
|---|---|---|---|
| the owner, over SSH | `sitesolide share`, `sitesolide people`, on the owner's socket | any role, to anyone the rules admit, on any deployed project; the create right | nothing more: it is root |
| the owner, in the dashboard | a site's *Access*, *People* | the same | the password unlock, to give a role above Can open, password access or the create right |
| an Admin | their project's *Access* | a role at most their own, Admin included, on that project alone; a domain only among the company's | their own unlock, a forced sign-in, to give a role above Can open or password access |
| a token | `sitesolide share`, `/api/v1/projects/<slug>/access` | Can open alone, see [Access by token](#access-by-token) | nothing more: it never gives more than Can open |

- **Giving Can open to a company account or a domain, removing and
  lowering never wait for an unlock.** Closing someone out never waits for
  a password, and the worst a compromised dashboard does with it is remove
  everyone, or open a site to people the company's own sign-in vouches for,
  as the owner's session shared sites without an unlock before the
  registry. Raising someone above Can open asks for the unlock, the same
  ten minutes as creating a token: a Developer restarts services and writes
  secrets. So does **password access**, Can open as it is: it lets in
  someone from outside the company, whom no company account vouches for,
  and a dashboard session alone, which a compromised dashboard holds, must
  not hand that out. Over the owner's socket root needs no unlock for it.
- **Who removes whom**: anyone who manages the project removes or lowers
  anyone they could have given that role; a token, Can open entries alone.
  Removing someone from *People* takes them off every project and takes the
  create right back, the owner's alone.
- **A role only goes on a deployed project**, never on the platform's own
  (`dashboard`, `portal`, `api`, `analytics`, `landing`, `www`, the
  landing's folder); an entry of a project removed since can still be
  changed or removed.
- **Password access is given once.** Asked again, it keeps its password;
  removing it and giving it anew draws another. It opens the site and
  nothing more: to give its holder a role, remove it first. A password given
  to an email also lets that email in with its company account, should the
  portal admit that account at sign-in.
- **The create right** goes only to someone who can sign in with their
  company account; giving it in the dashboard asks for the unlock, taking it
  back does not, and journals `people.create` either way.
- **No email is sent**: the page and the command give the line to send,
  `Open https://<slug>.<zone>/ and sign in with your <provider> account.`,
  and a password once, to send yourself.
- **Every change is journaled** by the steward, `access.add`,
  `access.change` or `access.remove`, under the owner, the Admin's email or
  `token:<id>`, with the project and "who: Role", the expiry for password
  access, in its access log, `access-log.jsonl`, kept 180 days; a refusal
  as `rejects`, in the journal, bounded per minute (see
  [How long each source keeps its audit](#how-long-each-source-keeps-its-audit)).

`sitesolide share` and `sitesolide people` speak to the steward's **owner
socket**, `/run/sitesolide-steward-owner/owner.sock`, which only root opens:
a runtime folder of its own, `0700`, the socket `0600`, both root's. Root
asks it with `curl` on the machine, the JSON body on standard input so that
no address goes through a shell, and needs no unlock there: it is root. The
socket carries the access routes, and one of the control routes': the token
ownership of a project `sitesolide remove` took off the machine (see "The
control API", Tokens).

### The steward's routes

In src/access/protocol.ts and src/people/protocol.ts. On the dashboard's
socket, the owner's routes carry no session: the dashboard calls them for
the owner's sessions alone, and what they allow without the live unlock,
reading, giving Can open, removing, is what the owner's session allows.

| Socket | Route | What it does |
|---|---|---|
| owner's, dashboard's | `GET /access?slug=<slug>` | a project's general access, people with access, sign-in settings, and what the portal decides from |
| owner's, dashboard's | `PUT /access/entry` `{ slug, who, role, expiresInS? }` | gives access or changes a role, the password once when one is drawn; on the dashboard's, `token`, the owner's live unlock, for a role above Can open or password access |
| owner's, dashboard's | `DELETE /access/entry` `{ slug, who }` | takes access away, never an unlock |
| owner's, dashboard's | `GET /people` | everyone, their roles per project, the create right, the domains, the sign-in settings |
| owner's, dashboard's | `PUT /people/person` `{ email, create }` | the create right; on the dashboard's, `token` to give it |
| owner's, dashboard's | `DELETE /people/person` `{ email }` | someone taken off every project and the create right, signed out |
| dashboard's | `POST /access/person/list` `{ session, slug }` | an Admin reads their project's access |
| dashboard's | `PUT /access/person/entry` `{ session, token?, slug, who, role, expiresInS? }` | an Admin gives access or changes a role, their unlock for a role above Can open or password access |
| dashboard's | `DELETE /access/person/entry` `{ session, slug, who }` | an Admin takes access away |
| dashboard's | `GET /members/key` | the public key, laid first if missing |
| dashboard's | `POST /members/signin` `{ assertion }` | a session, from an assertion it verifies |
| dashboard's | `POST /members/whoami` `{ session }` | who the session is, their roles above Can open and create right now |
| dashboard's | `POST /members/signout` `{ session }` | closes it |
| dashboard's | `POST /members/restart` `{ session, slug }` | a Developer's or an Admin's restart, judged under the lock |
| dashboard's | `POST /members/unlock` `{ session, assertion }` | a person's unlock, from a forced sign-in's assertion |
| dashboard's | `POST /members/lock` `{ session, token }` | locks it |
| dashboard's | `POST /members/secrets/projects`, `/members/secrets/value`, `/variable`, `/file`, `/restore`, `/content`, `/members/portal`, `/members/backups/restore` | a person's work on their projects, see src/people/actions.ts |
| dashboard's | `POST /control/access/list` `{ bearer, slug }`, `PUT` and `DELETE /control/access` `{ bearer, slug, who, role? }` | a token's, see [Access by token](#access-by-token) |
| dashboard's | `POST /team/member/list`, `/team/member/tokens`, `/team/member/revoke` | a person's own tokens, see [A person's own tokens](#a-persons-own-tokens) |
| owner's | `DELETE /team/project` `{ slug }` | a project removed: the name its token owned, free again, once the machine no longer carries it |

The routes of before the registry, `/members`, `/members/member`,
`/members/project/member`, `/members/sharing`, `/members/guests` and
`/control/sharing`, are gone and answer `no such route`. The session routes
kept their `/members/` paths, and a person's tokens their `/team/` ones:
renaming them would only make a dashboard and a steward of different days
disagree. The files on the machine keep their names for the same reason,
`member-sessions.json` and `team.json` in the steward's state folder, and
`members.json`, read-only since the registry: they are the machine's state,
not words of the page.

On the dashboard's side, the page reaches these routes at the owner's
addresses: `/api/tokens` and `/api/tokens/revoke` for tokens, and
`/api/secrets/restart` for a restart, which `server.ts` sends, for a person's
session, to `/members/restart`.

A person's restart is the Secrets section's restart, under the same lock and
the same eight seconds of observation, without its check that the unit reads
a managed file: a person restarts a service to restart it. Their role is
asked again once the lock is taken: removed while it waited, nothing
restarts. A static site has no service; the dashboard is never anyone's but
the owner's.

### Threat model

| Threat | What stops it |
|---|---|
| A compromised dashboard | It cannot raise anyone above Can open, nor give the create right: the registry is root's, and that takes the owner's unlock or an Admin's, which takes a forced sign-in the portal signs. It cannot forge an assertion: the private key is the portal's alone. Every write and every secret read is judged by the steward on its own registry, by role, and it never reads a value a person's role does not reach. It acts for the people whose sessions pass through it while it is compromised, within their roles, and during a person's unlock within what that unlock opens, their projects' secrets for an Admin. Without any unlock it can give Can open to the company's people and domains, and remove anyone, as it could share sites and remove people before: only through the steward, under the owner's name or a session's, every change in the steward's journal. Password access, which lets someone from outside the company in, takes an unlock, as a role above Can open does. It sees a password access's password once, as it carries it to the page; never a hash nor an identifier, since the steward hands out views. It can no longer name a person or a token as the author of a change it made: the steward writes the actor it verified, and the portal records no change of access at all. It mints a person's token only during that person's unlock, within their roles, and every use of it is narrowed to their roles by the steward. During an owner's unlock it can do what an unlock allows, roles included, as it can already create a token. |
| A compromised portal | As before, it opens every restricted site, can sign an assertion for anyone, a forced sign-in's included, and act as anyone who signs in to the dashboard, within their roles, their unlock included. It cannot change the registry, root's, nor the projection, which root writes and it only reads: it gives nobody a role. It records no change of access any more, so it can no longer write one under anyone's name. |
| A stolen token | Can open alone, on the projects it reaches, a person's own only where the person is Admin now, to the company's people and domains; never password access for someone outside them, never a role above Can open; it removes Can open entries alone. Every change is in the steward's journal under `token:<id>`. See [Access by token](#access-by-token). |
| A stolen person's token | Within the person's roles at each request, not as minted: lowered, they narrow it; no longer signing in, it is revoked and refused. Revoked from the person's *Tokens* page or the owner's, no unlock. Every deployment under `token:<id>`, the person named. |
| A person above their roles | The steward refuses the scope before the token exists, every reason journaled; and should the registry move after, it narrows the token at every use and the installer at its start. |
| A stolen session cookie | Half a day at most, within that person's roles, and without their unlock, which needs a forced sign-in at the provider: what reads or writes a secret, switches general access, restores or raises someone above Can open stays closed. Removing them closes it at the next request. |
| A stolen unlock token | Useless alone: it is valid only with the session it was granted to, for its person, ten minutes, and the dashboard never sends it to a browser. |
| A Developer reading a secret | Refused by the steward before any file is opened: the listing and every answer show names and metadata only, never a value, a size or a previous version. What they write still reaches the service, which may expose it: the role trusts them with the project's behaviour, not with reading its keys back. |
| An Admin reaching further | One project, their own: the steward refuses another project, the platform's projects, the files it keeps for root, a password hash, a domain outside the company's, and a role above their own; a role they give lands on their project alone. |
| Someone outside the company | Can open alone, with password access: a password of their own, for one site, until its expiry, kept as a SHA-256 by the registry and the portal; they never sign in to the dashboard. |
| A registry that does not read | Nothing is guessed: every person is refused, and the journal and every answer say why, until the owner repairs it. A projection that does not read opens nothing but the owner's password and the admin emails. |
| A provider that does not ask again | The portal believes the provider's `auth_time`, not its own clock: an old sign-in returned to a forced request is refused, and the steward wants `reauth` and five minutes. |
| A replayed assertion | Its nonce is spent at the first session it opens, on disk; five minutes later it has expired anyway. |
| A code carried to a site, a site's code carried here | A code says which it was minted for: a dashboard's is redeemed for an assertion only, a site's for a cookie only (portal/src/handoff.ts). |
| A flood of refusals | Twenty refusals a minute enter the journal at most, failed sign-ins, refused changes of access and refused work together, so that a flood cannot push its history out; the rest are refused unrecorded. |

### Upgrading: access

One registry for who may do what, the steward's, and the portal reading its
projection, replacing the dashboard's people of `members.json` and the
portal's own lists of who could open a site and of the passwords it handed
out (its `sharing` and `invites` tables). `sitesolide upgrade` runs the four
steps in their order, together; by hand:

```bash
bin/deploy-steward.sh               # 1. the registry, made once from the stores before it, and its projection
cd dashboard && sitesolide deploy   # 2. the access routes, a site's Access section, People and Tokens
bin/deploy-installer.sh             # 3. a person's deployment narrowed by the registry when it starts
cd portal && sitesolide deploy      # 4. the projection read from the first request
```

**Before anything.** An app that reads `X-Sitesolide-Role` must be updated,
and deployed, before step 4: the header now carries the role, and its old
values, `member` and `guest`, are gone ([docs/upgrading.md](../docs/upgrading.md#access-one-registry)).
And everyone with a role above Can open on a project, Viewer, Developer or
Admin, now opens its site when it is restricted, which was not true before,
the dashboard's roles and the portal's own lists being separate: read each
restricted site's people with access afterwards, `sitesolide share` in its
folder.

1. **The steward.** Its unit does not change: the projection lies in
   `/etc/sitesolide-portal`, already writable for the key, and the portal's
   database is read under `ProtectSystem=strict` with the
   `CAP_DAC_READ_SEARCH` it holds. At its first start it makes
   `access.json` from `members.json` and a checked copy of the portal's
   `portal.db`, writes the projection, then the registry, and journals
   `access.migrate`, actor `system`, with the counts. The running portal,
   the old one, keeps deciding from its own tables, which still say the
   same: nothing opens or closes. `members.json` is never written again, nor
   the portal's `sharing` and `invites` tables; they stay, read-only, until
   the next release. The journal gains `access.add`, `access.change`,
   `access.remove`, `access.migrate`, `people.create`, `dashboard.signin`,
   `dashboard.signin_failed` and `dashboard.signout`, which an older
   dashboard shows by their name; the `member.*` rows written before still
   read. Beside the journal it starts the access log, `access-log.jsonl`,
   seeded once with the accepted changes of access the journal already
   holds (see [How long each source keeps its
   audit](#how-long-each-source-keeps-its-audit)). The relay stays, asked
   `GET /admin/access` now. Check: the script
   ends on `access registry 600 root:root, its projection for the portal 640
   root:site-portal`, and `sitesolide people` lists everyone with their
   roles. A store that does not read leaves no registry: the script stops on
   the owner's socket, every person is refused, and `sudo journalctl -u
   sitesolide-steward | grep access:` says which store and why; the next
   request, or the next start, tries again.
2. **The dashboard.** Its access routes, `/api/access`, `/api/people` and
   `/api/v1/projects/<slug>/access`, speak to the steward, and its pages
   follow the registry: one *Access* section per site, in place of its
   *Access*, *Sharing*, *Guests* and *Members*; *People*, in place of
   *Members*; *Tokens*, in place of *Team*, its routes now `/api/tokens` and
   `/api/tokens/revoke`. The old addresses lead to the new pages. *Activity*
   lists a change of general access as `access.general`, `door.update`
   before, and the rows written before the registry in today's words.
   Before step 1 the access routes answer that the steward does not keep
   people with access yet. Check: a site's *Access* lists who could open it
   before the upgrade, password access with its expiry, and *People*
   everyone with their roles. A change made in the old dashboard between
   step 1 and this step goes to the portal's old tables, which nothing reads
   any more: run the steps together.
3. **The installer.** It reads `access.json` when it starts. Check: a
   person's token deploying a project where they were just lowered to Viewer
   fails `out-of-scope`, nothing written. Before it, the older installer
   reads `members.json`, frozen at the migration, and the steward's own
   narrowing holds, a few seconds older.
4. **The portal**, last. From its first request it decides from the
   projection, and leaves the mark that keeps it from ever reading its old
   tables again. Its old admin routes, `PUT /admin/sharing/:host`, `GET`
   and `POST /admin/guests` and `DELETE /admin/invites/:id`, answer `410
   moved`, after the actor rule. Check, on the machine: `sudo curl -s
   http://127.0.0.1:3026/admin/access` answers `"reading":"steward"`, and
   `sitesolide share` no longer warns that the portal decides from its own
   tables. A password the portal handed out before the upgrade still opens
   its site, as password access, and a cookie set before it stays valid.

**Rolling back** is the previous commit of the steward, the dashboard and
the portal together, from a checkout of before: `bin/deploy-steward.sh`,
then `sitesolide deploy` in `dashboard/`, then `sitesolide deploy --force`
in `portal/`; and `bin/deploy-installer.sh`, since the newer installer would
go on narrowing a person's deployment by `access.json`, which nothing writes
any more. They read `members.json` and the portal's tables as they stood
at the migration: every change of access made since is lost for them, and
password access given since does not exist for them. `access.json`, the
projection and the access log stay beside them, unread; `X-Sitesolide-Role`
goes back to `member` and `guest`. Upgrading again keeps the registry as it stood; to
make it afresh from the old stores, delete
`/var/lib/sitesolide-steward/access.json` first, which loses the changes
made after the first migration instead. The detail is in
[docs/migration.md](../docs/migration.md#going-back).

## The audit

The machine-level *Activity* page answers "who did what": who deployed, who
signed in where, who changed who may open a site or do what on it, what the
egress proxy refused or lent, which backups ran and who restored one, which
secrets were read or changed. Every component keeps its own audit, in its own database, in the
shape they all share: an ISO date, an actor, a dotted action, a target, and a
JSON detail that never carries a secret. The dashboard reads them all and
merges them, newest first. Every event, and who records it, is listed in
[docs/concepts.md](../docs/concepts.md#audit).

```
page, Activity
   |  GET /api/audit : session, no unlock
   v
server.ts          reads, merges, bounds; writes nothing
   |-- dashboard.db                       its own: tokens, token deployments
   |-- 127.0.0.1:3026/admin/audit         the portal, the loopback rule's one exception
   |-- 127.0.0.1:3129/audit               the egress proxy, answered to site-dashboard alone
   `-- the steward's socket               /backups/audit, /log
```

- **No new road, no new privilege.** The portal's audit client,
  [src/portal-audit.ts](src/portal-audit.ts), and the same clients as the
  Connectors, Backups and Secrets pages, which already read these routes one
  at a time ([src/audit/sources.ts](src/audit/sources.ts)).
- **The session is enough**, and a person's reads the rows of their projects
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
| `dashboard` | `audit` in `dashboard.db` | everything, never pruned: a few rows per token and per token deployment | all of it, by pages |
| `portal` | `audit` in `portal.db` | 180 days; past 100,000 rows the oldest go, those of the last 30 days excepted; sign-ins and sign-outs repeated within a minute make one row | all of it, by pages |
| `egress` | `audit` in `/var/lib/sitesolide-egress/` | 90 days, pruned every hour; refusals and connector calls counted by the minute | all of it, by pages |
| `backups` | `audit` in `/var/lib/sitesolide-backup/backup.db` | everything, never pruned: one row per hourly run, some 8,800 a year, and one per restore | all of it, by pages, from a steward that knows pages; the latest 50 from an older one |
| `steward` | `/var/lib/sitesolide-steward/journal.jsonl`, and beside it `access-log.jsonl` | the journal, the last 500 to 1,000 operations: past 1,000 lines, the file keeps its last 500; the access log, every accepted change of access for 180 days, 20,000 lines at most, pruned every hour | both as one history, by pages, from a steward that knows pages; the latest 50 from an older one |

**Changes of access are the steward's to record now.** Before the access
registry the portal recorded them, `sharing.update`, `guest.create` and
`guest.revoke`, kept 180 days, and those rows still read. Since, the portal
records sign-ins and sign-outs alone, and the steward journals every change of
access, `access.add`, `access.change`, `access.remove`, `access.migrate` and
`people.create`, under the actor it verified, in a file of its own,
`access-log.jsonl`, root's, `0600`: kept 180 days, as the portal kept them,
and 20,000 lines at most whatever happens, the oldest going first; pruned at
most once an hour, on the append that follows, and at the steward's start, or
on the next append once it passes 12 MB, so that it always reads whole. A
file of its own because the journal rotates by line count and every unlock,
read and sign-in writes to it: a busy week would push a month-old change of
access out. A refusal is no change and stays in the journal, bounded per
minute, rotated with the rest. Both files hold lines of the same shape, and
`GET /log` reads them as one history, by date. At its first start a steward of this
version carries over to the access log the accepted changes of access the
journal already holds, once: an access log that exists is never seeded
again.

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

A site's *Access* section opens on its general access as the machine carries
it, the three ways a site may open, the current one marked, a disagreement
between the deployed manifest and the running block said first, in red; the
site's Overview puts the two side by side in its *General access* panel. The
owner and the project's Admins switch it between public and restricted when
the steward accepts, *Make public* or *Restrict*: restricted is the portal
turned on in front of the site, public the portal turned off, which retypes
the slug to confirm. Anyone with the code, the preview lock, appears there
too, read-only: it remains `sitesolide lock`'s business, and the page gives
the commands, `sitesolide lock --new-code` and `sitesolide unlock` while a
code is set. Who may open a restricted site is the steward's registry, not
this switch: see [Access](#access).

```
page, Access
   |  /api/access/general, /api/secrets/portal : session, Origin, unlocked
   v
server.ts                  relays, with no rule; a person's request through src/people/relay.ts
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

**The steward never touches Caddy.** Putting the portal in front of a site
rewrites a block and
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
like the gatekeeper: they read whether the machine puts the portal in front of
a site, then write minutes later, and
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
sandbox with no key. A **token** deploys over HTTPS instead, through this
dashboard, and its holder never holds root. The owner's SSH path does not
change. The holder's side is in [docs/access.md](../docs/access.md); this is the
machine's side.

```
sitesolide deploy (a person, an agent)          Authorization: Bearer sst_...
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
the loopback's project set, the portal confirmed under the lock. Two things
differ, both on purpose:

- `install` runs before the files are put in place, in the staging directory,
  because the project's account may write there and not in `app/`. A failing
  install changes nothing served.
- A block or a unit that is exactly what the previous deposited manifest
  generates is replaced without `--force`: the machine can tell a manifest
  that changed from a hand edit, which the workstation cannot. A real hand
  edit still stops the deployment, and the owner settles it over SSH.

### Tokens

- **Created on the *Tokens* page, unlocked.** A token can run code on the
  machine: it asks for the same ten-minute unlock as the Secrets section,
  checked by the steward. **Revoked without the unlock**, so that closing a
  stolen token never waits on the password; the worst a compromised dashboard
  does with that route is revoke every token.
- **Shown once, kept as a SHA-256**, for the reason
  [portal/README.md](../portal/README.md) gives for password access: 256 random
  bits leave nothing to guess, and a fast hash finds the token by lookup. The
  value is `sst_` and 43 characters of base64url.
- **One per person**: a label, an email, an optional expiry, and a scope, all
  off by default: existing slugs it may deploy; whether it may create projects,
  deploy public sites, use outbound network (`network: outbound` or `egress`),
  declare a domain. The owner's belong to the owner; a person who signs in to
  the dashboard mints their own, narrowed to their roles at every use: see
  [A person's own tokens](#a-persons-own-tokens).
- **Ownership**: a project a token creates is recorded as its own at the start
  of its first deployment, before anything is written, so that a first
  deployment that fails half way stays its creator's, and nobody else's.
  **Removed with `sitesolide remove`, its name is free again**: once the
  folder is gone, the command asks the steward's owner socket,
  `DELETE /team/project { slug }`, which forgets the token's ownership only if
  the machine no longer carries the project, and journals `project.remove`
  under `owner`, the token in the detail. A removal stopped half way keeps
  the ownership, and running it again, which tolerates every absence,
  finishes both. A steward from before says nothing to release, and the
  command says to upgrade and run it again.
- **Failed authentications** are rate limited per address, three tolerated,
  then five seconds doubling up to an hour. Per address and not global, unlike
  the sign-in: there are as many holders as tokens, and a global counter would
  let anyone lock every holder out.

### What a token's project may not do

Judged by the installer on the manifest it received, after `validate()`, and
earlier by the steward and the dashboard: see
[src/control/policy.ts](src/control/policy.ts).

- **Reserved slugs**: `dashboard`, `portal`, `api`, `analytics`, `landing`,
  `www` and the landing's directory, whatever the scope; a slug another token
  created; an existing slug the token was not granted.
- **Private by default**: a new project goes behind the portal unless the token
  may deploy public sites and the manifest asks for it; an existing project
  keeps the general access the machine carries. `portalExempt`, which opens paths, needs
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

### Access by token

A person, or an agent, who deployed a tool gives the people who need it
access: `sitesolide share alice@acme.com` in its folder, or the routes under
it, `GET /api/v1/projects/<slug>/access`, `PUT` with `{ who, role }` and
`DELETE` with `{ who }`.

```
sitesolide share (a person, an agent)          Authorization: Bearer sst_...
   |  HTTPS, dashboard.<zone>/api/v1/projects/<slug>/access
   v
server.ts          the token may deploy the project; the body's shape, `who` and `role` alone
   |  PUT /control/access { bearer, slug, who, role }   on the steward's socket
   v
steward.js         the bearer, the project it reaches, then the access rules with the token
   |               as the one who gives: Can open alone, the company's people and domains
   |-- writes      /etc/sitesolide-portal/access.json, then access.json
   `-- journals    access.add, access.change or access.remove, under token:<id>
```

The dashboard only checks what it can refuse early; the steward judges and
writes, by the rules every change of access takes (src/access/rules.ts),
with the token as the one who gives. In order:

1. **The token may deploy the project**, its own or granted: any other slug
   reads as `not-found`, as for its logs, on the dashboard and again on the
   steward.
2. **The body is `who`, and `role` for a `PUT`**, nothing else: an `actor`
   key, or any other, is refused as an unexpected field. `role` is `visitor`
   when absent.
3. **Can open alone.** A higher role is refused `out-of-scope`: it is given
   from the dashboard, or by the owner over SSH.
4. **A person's own token only where that person is Admin now**, to read
   the people with access as to change them, read from the registry at that
   moment, once a change's turn has come; the owner's tokens, on any project
   they reach.
5. **A domain only among the company's domains**, `OIDC_ALLOWED_DOMAINS`,
   which the owner chose; with that list empty, none at all, since `@gmail.com`
   would be half the internet. A domain already there is not widened by
   keeping it.
6. **Never password access.** A person outside the company's domains is
   refused: whoever holds a token is not the one who chose the company's
   people, and password access is given from the dashboard or by the owner
   over SSH.
7. **Can open entries alone are removed**: a token takes nobody's role away.
8. **The steward writes** the projection, then the registry, and journals the
   change under `token:<id>`, a refusal as `rejects`; the dashboard records
   nothing, so that one change is one line of *Activity*. The answer carries
   the entry, the change and the project's access as it stands, without the
   admin emails.

General access is never a token's: public or restricted is a site's
*Access*, the preview code `sitesolide lock`. A steward from before the
registry answers these routes `no such route`, which the API turns into
`not-available`, saying to run `sitesolide upgrade`; a steward that does not
answer, into `failure`, 502.

### Threat model

| Threat | What stops it |
|---|---|
| A stolen token | Its scope: the projects granted and its own, private sites unless allowed. Every deployment is in the audit with the token's id and email. Of access, Can open alone, to the company's people and domains, never password access for someone outside them, and the removal of Can open entries, every change in the steward's journal under `token:<id>`. Revoking takes one click and no password; an expiry ends it anyway. |
| A malicious archive | Read by the project's account in a confined unit, never by root; links, devices, `..`, absolute paths and duplicates refused, data and entries capped while reading; nothing served changes until the whole archive extracted. |
| A malicious manifest | Re-validated on the machine with the CLI's `validate()`, then the scope; the unit and block are generated from it by the same generators as over SSH. Every string that lands in a block or a unit is judged for it: header values with no `"`, `\`, `{`, `}`, `$` or backtick, since Caddy fills `{$NAME}` and `{env.NAME}` from its own environment, the Cloudflare token included; routes and exemptions that are plain paths; a `start` with no `+`, `!` or other prefix systemd reads, `+` and `!` meaning root; environment values with no space or quote, which would set a second variable; secret names that are plain file names; a `%` escaped. The generators refuse the same again rather than write it. Unknown keys refused, secrets limited to its own file, memory capped. |
| Path traversal | The tar reader's refusals, the extraction's `O_EXCL` and `O_NOFOLLOW`, the unit that sees only the staging directory; on root's side, slugs and deployment ids checked against their shape before they enter a path. |
| Resource exhaustion | Upload counted while it streams (Bun's own cap does not hold for a chunked body), 100 MiB; extraction 512 MiB, 20,000 entries, 256 MiB of memory, five minutes; `install` 1G and fifteen minutes; three deployments running at a time on the machine, claimed when the archive arrives, one per project; three waiting for their archive per token, the newest replacing the oldest, and none of them counted against the machine; an archive that does not arrive in fifteen minutes expires. |
| A token reaching another project | The slug decision on the steward, again on the installer; secrets limited to `<slug>.env`; `install` runs without the loopback, where the other projects listen, and the extraction without any network. |
| A replayed request | The installer refuses a request older than ten minutes or for another slug, and writes nothing for it. |
| A compromised dashboard | It sees the bearers that pass and can use them within their scope, a person's within the person's roles, and read deployment logs; it cannot mint a token without the password or a person's own unlock, nor deploy without one, nor hand root a file it could not read, nor name a token as the actor of a change of access it made itself: the steward journals the token it judged. |
| A token giving access too widely | It gives Can open alone, on the projects it may deploy, a person's own only where the person is Admin now, to the company's people and domains alone, never password access to someone outside them, never public; it removes Can open entries alone. The steward judges it and writes, every change is in its journal under `token:<id>`, and the owner or an Admin takes it back from *Access*. |
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
cd dashboard && sitesolide deploy   # 1. the API and the Tokens page
bin/deploy-steward.sh               # 2. the token registry and the control routes
bin/deploy-installer.sh             # 3. the installer's code, its template, its environment file
```

1. **The dashboard.** `/api/v1/` answers `not-available`, and the *Tokens* page
   says to run the steward's script: the steward in place answers
   `404 no such route` to the control routes, which the dashboard reads as
   "not yet". Check, with a value that has a token's shape and is nobody's:
   `curl -s https://dashboard.<zone>/api/v1/whoami -H "Authorization: Bearer sst_$(printf '0%.0s' $(seq 43))"`
   answers 503 `not-available`, and the *Tokens* page shows the same banner; the
   other pages are unchanged. Roll back: deploy the previous commit of
   `dashboard/`; the two new tables of `dashboard.db` stay, unread.
2. **The steward.** The *Tokens* page lists tokens and creates them; the same
   `curl` now answers 401 `unauthenticated`, and a deployment answers
   `not-available` until the installer is there. The steward's script checks
   itself as before. Check, on the machine:
   `sudo -u site-dashboard curl -s --unix-socket /run/sitesolide-steward/secretaire.sock http://steward/team/tokens`
   answers `{"tokens":[]}`. Roll back: `bin/deploy-steward.sh` from the previous
   commit; `team.json` stays, unread, and the tokens come back with the steward.
3. **The installer.** `bin/deploy-installer.sh` writes
   `/etc/sitesolide-installer.env` with `DEPLOY_ACCOUNT`, the account of your
   `server`, and verifies the template with `systemd-analyze verify`. It starts
   nothing. Check: create a token on the *Tokens* page for yourself, with "May
   create projects", and deploy `examples/bun-app` with it from a workstation
   with no server (`SITESOLIDE_API=... SITESOLIDE_TOKEN=... sitesolide deploy`);
   then `journalctl -u sitesolide-installer@bun-app`. Roll back:
   `sudo rm /etc/systemd/system/sitesolide-installer@.service /etc/sitesolide-installer.env /usr/local/lib/sitesolide/installer.js && sudo systemctl daemon-reload`;
   deployments then answer `not-available` again.

Revoking every token closes the API without touching anything else: *Tokens*,
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
cd dashboard && sitesolide deploy   # 2. the API's early refusals, the cap, the limiter, the Tokens page
bin/deploy-gatekeeper.sh            # 3. the same generator for the portal's block
```

1. **The installer.** Check: a token deployment whose manifest carries
   `"headers": { "X-Test": "{$CLOUDFLARE_API_TOKEN}" }` fails with
   `invalid-manifest` and writes nothing; `examples/bun-app` still deploys.
   Roll back: `bin/deploy-installer.sh` from the previous commit.
2. **The dashboard.** Check: the same manifest is refused at
   `POST /api/v1/deployments` before any upload; a token without outbound
   network gets `egress: your token may not reach outside hosts`; the *Tokens*
   page's outbound permission mentions the hosts a service lists. Roll back:
   deploy the previous commit of `dashboard/`; no table changed.
3. **The gatekeeper.** Check: making a site public, then restricted again,
   from its *Access* section still works. Roll back: `bin/deploy-gatekeeper.sh` from the
   previous commit.

The steward needs nothing: it judges tokens and slugs, not manifests.

### Upgrading: access by token

A release before the access registry gave tokens `GET` and `PUT
/api/v1/projects/<slug>/sharing`, which the dashboard relayed to the portal's
own tables, and `sitesolide share` read the portal on the loopback over the
owner's SSH. Both roads are gone. A token now goes through
`/api/v1/projects/<slug>/access` to the steward ([Access by
token](#access-by-token)), the owner's SSH to the steward's owner socket, and
neither touches the portal, which reads its projection. A machine that
predates either needs nothing of that release: [Upgrading:
access](#upgrading-access) brings it to the registry in one go.

```bash
bin/test.sh                         # 0. on the workstation
sitesolide upgrade                  # 1. the steward, the dashboard, the installer, the portal
```

0. **The workstation.** Pull, then `bin/test.sh`: a CLI from before the
   registry still asks `.../sharing`, which the API's catch-all answers
   `not-found`, `no such route`, and the CLI says as `not-available`.
1. **The machine.** Check, in the folder of a restricted site: `sitesolide
   share` prints its general access and people with access, `over SSH, as the
   owner`, and changes nothing; root asks the owner's socket with `curl`,
   which `sitesolide setup` installs. Then with a token of yours that may
   deploy that site, from a workstation with no server
   (`SITESOLIDE_API=https://dashboard.<zone> SITESOLIDE_TOKEN=sst_...`):
   `sitesolide share` prints the same `through https://dashboard.<zone>`;
   `sitesolide share colleague@<your domain>` gives them Can open, and
   *Activity* shows `access.add` under `token:<id>`; `sitesolide share
   @gmail.com` is refused `out-of-scope` unless `gmail.com` is among
   `OIDC_ALLOWED_DOMAINS`. Then `sitesolide share --remove colleague@<your
   domain>` to put it back.

**Rolling back** is [Upgrading: access](#upgrading-access)'s: the steward,
the dashboard and the portal of before, together.

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
| `src/access/` (but its web routes, `routes.ts` and `client.ts`), `src/people/steward.ts`, `sessions.ts`, `system.ts`, `actions.ts`, `powers.ts`, `unlocks.ts`, `tokens.ts`, `portal.ts`, `infra/steward/sitesolide-portal-relay.*`, `portal/src/assertion.ts`, `portal/src/access.ts` | `bin/deploy-steward.sh`; the last two `sitesolide deploy` in `portal/` too |
| `installer.ts`, `src/installer/`, `src/control/policy.ts`, `src/people/tokens.ts`, `src/access/registry.ts`, `src/people/powers.ts`, `infra/installer/`, `bin/cli/` generators | `bin/deploy-installer.sh` |
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
vault. Its steward carries the real access and sign-in routes, its registry
made by the real migration from a `members.json` and a portal database of
before, and its portal signs people in: *Sign in with Google* on the sign-in
page leads to a page of the bench's that signs in one of its people:
alice@example.com, a Developer on `cms`, an Admin on `calendar` and a Viewer
on `photos`; bruno@example.com, an Admin on `cms` and a Developer on
`calendar`; chloe@example.com, a Viewer on `calendar`; maya@example.com, who
may create projects; or stranger@example.com, whom the registry does not
name. People and a domain can open `cms` and `calendar`, and five password
accesses are carried over. `BENCH_NO_SSO=1` runs a portal with no provider,
where everyone added gets password access.
The same page stands for the provider's forced sign-in when a person
unlocks, and the bench's steward judges a person's secrets and general access
by role before its own fake operations, and her own tokens on the *Tokens*
page with the real rules of src/people/tokens.ts; the owner's *Tokens* page
lists one of hers, marked.

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
started by the simulated `systemctl` (tests/control-api.test.ts). Access by
token is tested with the access routes, below. What only a machine can prove, `useradd` and `userdel`, `systemd-run`'s confinement and
the template unit, is not covered here.

For access: the rules, pure, who may name whom, the ladder and who may give
what, domains, password access and its four durations, the platform's
projects, removing, the registry read back and refused, who signs in to the
dashboard, and the portal's projection, a removal in the very next one
(tests/access-rules.test.ts); the steward's access routes on a throwaway
tree, the owner over SSH and in the dashboard, an Admin through their
session, a token through the control routes, the projection written before
every answer, someone whose last role above Can open goes signed out with
their tokens, the registry root's alone and the projection the portal's
group's (tests/access-steward.test.ts); the migration, every store carried
over, what it sets aside, conflicts toward the higher role, made once, a
portal database that does not read or sits behind a link, and the old stores
left for a rollback (tests/access-migrate.test.ts); the dashboard's access
routes against a simulated steward, the origin, the unlock carried, `locked`
turned into the page's 423, general access never the code
(tests/access-routes.test.ts).

For the people who sign in: every decision of the steward's on a throwaway
tree, a signature by another key, another audience, an assertion expired,
replayed, even after a restart, too old, an email the registry gives no role
above Can open, a Viewer's restart, a project with no role, someone removed,
even while their restart waited its turn, and the journal naming who it
verified (tests/people-steward.test.ts); the sessions and what a person sees
of the snapshot (tests/people-view.test.ts); sessions with an identity, the
steward asked who they are, the rate limiting
(tests/people-sessions.test.ts); and a person's whole road through the real
`server.ts` in its own process, the steward's routes on a real socket and a
portal of the tests' making that signs with the steward's key
(tests/people-flow.test.ts): the way back from the provider carrying no
Strict cookie, someone who can only open a site refused at sign-in, a forced
sign-in unlocking, one not forced or for another account refused, a
Developer's write and refused read, an Admin's read and the access they give,
which the portal is told through the projection, and the owner's unlock
beside a person's.

For their powers: each decision of the steward's on a throwaway tree with a
real backup reader (tests/people-actions.test.ts): an unlock only on a
forced sign-in for the session's own email, fresh and once, one per session,
neither evicting the owner's nor another person's, locked on demand, at
sign-out and when they no longer sign in, counted per person; a Developer
listing names only, writing, refused a read before any file is read; an
Admin reading; another project, a viewed one, the platform's, a registry
edited by hand and a password hash refused; a write that waited behind a
restart refused once its person was removed; general access and a restore by
role, the actor the steward's. The table itself and the unlocks, pure
(tests/people-powers.test.ts).

For a person's own tokens: what a person may mint and what one of theirs may
do once their roles move, pure (tests/people-tokens.test.ts); the control
routes with an access registry the test changes as the owner would
(tests/control-people.test.ts): minting within the roles under the person's
unlock, refused above them, a Viewer refused, the create right required, the
options an Admin's; the identity narrowed at every use, a role lowered to
Viewer or Can open stopping deployments and logs, a project the token created
included, the create right taken back; someone who no longer signs in
refused, then revoked under who took them off; a creation making the person
Admin before the token owns it, the installer told whose token it is. The
installer refusing a person lowered, removed or without the create right
since, and stripping a Developer's options (tests/installer-main.test.ts); a
person's general access kept (tests/control-policy.test.ts); and the whole
road through the real `server.ts`, a person minting on the *Tokens* page
after a forced sign-in, refused above their roles, deploying, narrowed and
then removed (tests/people-flow.test.ts).

For the audit: each source's rows in the shared shape, bounded, and garbage
left out (tests/audit-merge.test.ts); the merge, the filters and a cursor
followed to the end against simulated sources, every row once and in order
whatever the page size, a source down, too old, not installed, stalled past
the deadline or throwing, and a budget that runs out (tests/audit-aggregate.test.ts);
each reader against the answers its component really gives, a steward that
pages and one that does not, and the whole route against a portal and an
egress proxy on real ports and a steward on a real socket
(tests/audit-sources.test.ts).
