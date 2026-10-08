# How it works

The parts, what each one is allowed to do, and why the boundaries are drawn
where they are.

## Three decisions

**One machine, on purpose.** There is no staging environment and no automatic
failover. What breaks production breaks every site at once, and nothing repairs
itself. That constraint is what keeps the system small enough to understand
completely, and it is why the deployment path verifies and rolls back rather
than assuming.

**The server is the source of truth.** For a deployed project, its general
access and its secrets are what the machine carries, not what the repository
says. The CLI reads the machine, and refuses to contradict it.

**Nothing in the repository names a machine.** The server, the zone and the
contact address have no defaults at all: the CLI stops and points at
`sitesolide init` rather than guessing. That is what makes this repository
publishable, and what makes your copy yours.

## A project is a folder

There is no registry, no database of projects, no control plane. A project
exists because `/srv/sites/<slug>` exists on the machine, and it is served
because Caddy's wildcard block resolves `<slug>.<zone>` to
`/srv/sites/<slug>/public` by naming convention. Adding a project changes no
shared configuration file.

A static project stops there: Caddy serves the files and nothing runs. An app
gets two more files, both generated from its manifest, a systemd unit and a
Caddy block, and costs 8 to 40 MB of memory.

A project that runs several processes, a front, the API it calls, a worker
behind it, declares them under `services` and gets one unit per service. The
first keeps the project's name, `<slug>.service`, and the others are
`<slug>.<name>.service`, hanging on it: starting, stopping or restarting the
main unit does the same to them, which is why the dashboard, the steward and
the collector, which know a project by its main unit, need nothing more. The
block sends each service its own paths.

Those two generated files live nowhere but on the machine. `deploy` generates
them from the manifest each time, installs the unit, and hands the block to
`bin/deploy-caddy.sh`, which validates it on the machine with the blocks already
in service: a block is only correct in the company of the others, and the
machine is where they all are. A deployment never touches another project's
block.

## Isolation

Each project gets a system account, a directory under `/srv/sites/<slug>` and a
systemd unit that confines it. `/srv` is replaced by an empty mount and only
that project's own directories are bound back in, so a compromised project
cannot read another one's files even if Unix permissions would have allowed it.
An app that declares no secret has `/etc/sitesolide` made inaccessible, which
hides even the names of the files.

Services cannot reach each other over the loopback either, except those of one
project, see [the loopback rule](#the-loopback-rule).

## Who may touch what

This is the part worth reading twice. Each component has exactly one job and no
more.

| Component | Runs as | May |
|---|---|---|
| Caddy | `caddy` | serve, and ask the shared service whether a domain is allowed |
| A project's service | `site-<slug>` | read its own directory, write its own data directory |
| The shared service (`api/`) | its own account | answer `ask` for on-demand TLS; its `src/locks.ts` decides the preview locks the gatekeeper writes |
| The dashboard | `site-dashboard` | read a snapshot file, relay to the steward, ask the portal for sign-ins and its audit |
| The portal | `site-portal` | answer Caddy's `forward_auth` from the projection the steward writes, sign people in with the identity provider or password access, sign the dashboard's identity assertions; keep no list of who may open a site |
| The steward | root | write `/etc/sitesolide`, restart services, command the gatekeeper, keep the access registry and write its projection for the portal, judge what each person and each token does, ask the portal through its relay what it decides from |
| The portal relay | root, no capability, on demand | forward the steward's connections to the portal's admin API, and to nothing else; the steward asks it `GET /admin/access` alone |
| The gatekeeper | root, one-shot | change one project's general access: its manifest, its block, the preview locks; reload Caddy, probe, roll back |
| The installer | root, one-shot | deploy one project for a token, the archive read by the project's own account |
| The collector | root, on a timer | read the machine, drop a snapshot where the dashboard can read it |
| The monitor | `sitesolide-monitor`, on a timer | read what any account reads, ask Caddy for every site over HTTPS, alert |
| The egress proxy | `sitesolide-egress` | let each project reach the hosts its manifest lists, lend it the connectors granted to it |
| The backup run | root, on a timer | list the projects, store the archives their own accounts hand it, prune, upload |
| A backup copy or extraction | `site-<slug>`, one-shot | read or write that project's data, nothing else, no network |
| A service's backup command | `site-<slug>`, one-shot | in its service's walls, with its secrets and the loopback alone, leave a consistent copy of the folder its server keeps live |
| A restore | root, one-shot | swap one project's data folder, restart its services, put the data back if they fail |

**The dashboard reads nothing itself.** Its unit replaces `/srv` with an empty
mount, so it cannot open another project's files, and the loopback rule stops it
reaching other services. What it displays comes from a snapshot file a root
timer wrote for it. A compromised dashboard therefore leaks exactly what the
page already showed.

**Only the gatekeeper touches Caddy from the machine**, and only for the one
project named in its unit. Four unit templates, one per action, `on`
(Restricted), `off` (Public), `code` (Anyone with the code) and `renew` (a new
code), rather than one instance, so that each can only write into
`/srv/sites/%i`, the blocks and the preview locks: a compromised gatekeeper
holds the one site you named it for. The dashboard reaches it through the
steward, and so does `sitesolide lock`, over the owner's SSH: one path changes
a site's general access, whoever asks.

**People with access are judged as root.** Per project, each person or
domain with access holds a role, each including the ones below it: *Can open*
opens the site when its general access is restricted; *Viewer* also sees the
project in the dashboard; *Developer* also deploys it, restarts it and writes
its secrets without ever reading one back; *Admin* also reads its secrets,
chooses its general access, gives and takes away access to it, a role at
most their own, and restores its backups. The steward keeps them in one
registry, `/var/lib/sitesolide-steward/access.json`, root's alone, judges
every change by its rules, and writes after each one the projection the portal
decides from, `/etc/sitesolide-portal/access.json`, which root writes and only
the portal's account reads: a removal holds at the next request. Someone
inside the company's domains signs in with their company account and may hold
any role; someone outside them gets password access, Can open alone, a
password the steward draws and shows once; a domain is Can open alone. The
owner, whoever holds the dashboard's password, may do everything. See
[dashboard/README.md](../dashboard/README.md#access).

**The dashboard believes no name it is told.** Someone with a role above Can
open signs in to it with their company account: the portal, the one authority
on who someone is, signs an assertion of the email the provider verified, for
the dashboard, for five minutes, once; the steward checks it with a public key
it keeps itself before it opens the session, and judges every write the
person asks for against its own registry, at that moment. The key pair is the
steward's: it lays the private half where only the portal's account reads it,
`/etc/sitesolide-portal/assertion.key`, beside the projection. A compromised
dashboard acts only for the people whose sessions pass through it, within
their roles, and raises nobody above Can open without an unlock. What a person
sees, the dashboard filters from data it already holds.

**A secret read, a site made public, opened with a code or given a new code, a
restore, a role above Can open given, password access given, a token minted,
each waits for the person's own unlock**: a forced sign-in at the provider, which the portal asks for
(`prompt=login`, `max_age=0`) and reads back in the provider's own ID token,
and the steward checks again, for ten minutes and that person's session
alone. The owner's unlock is the dashboard's password, retyped. Password
access waits because it lets in someone from outside the company, whom no
company account vouches for. Giving Can open to a company account or to one
of the company's listed domains, restricting a site, and taking access away,
never wait for either: closing someone out must not wait for a password. A
whole domain waits while the company's domains are not listed, since anyone
the provider vouches for would then come in.
The steward never hands a Developer a value, whatever the dashboard relays.

**A person's own tokens are never stronger than the person.** A Developer
mints a token that deploys their project, an Admin one that may also deploy
public sites, declare a domain or reach outside hosts, and someone the owner
granted the right to create projects one that creates them, which makes them
Admin of what it creates. The steward reads the registry at every use of such
a token, and again when the installer starts: a role lowered to Viewer stops
that project's deployments at the next request, and someone who no longer
signs in to the dashboard takes their tokens with them. A token gives Can open
alone, to the company's people and domains, never password access. See
[dashboard/README.md](../dashboard/README.md#a-persons-own-tokens).

**Everything that reloads Caddy shares one lock**, `/run/sitesolide-gatekeeper/caddy.lock`.
The CLI, the deploy scripts and the gatekeeper all take it. Without it, a site
made restricted from the dashboard between a read and a write was silently
overwritten, and served in the clear.

## The loopback rule

An nftables rule reserves ports 3000 to 3099, **and Caddy's admin API on 2019**,
to Caddy and root. That API authenticates nobody: a service that could reach it
would open every restricted site at once, or stop Caddy.

This is what makes a restricted project able to trust Caddy. It has no
sign-in of its own; it trusts the header Caddy puts on the request, and that trust
is only founded because nothing else on the machine can forge it.

One exception, deliberate: the dashboard may reach the portal, where it has
the sign-ins of people with a company account sealed and redeemed, reads how
people sign in, and reads the portal's audit. Those routes have no other guard
than this rule, and a test refuses any fragment that would expose them. Root
reaches them too, with one question about access and nothing else: the steward
asks `GET /admin/access`, whether the portal decides from its projection, through
`sitesolide-portal-relay`, a systemd proxy that forwards a socket only root
opens to the portal's port and to nothing else, so that the steward's own unit
keeps no network at all. Nobody changes who may open a site through the
portal any more: the steward writes the projection the portal reads, and the
routes that did it, `PUT /admin/sharing/:host`, `/admin/guests` and
`DELETE /admin/invites/:id`, answer `410 moved` to whoever asks.

And one set: a project that declares several `services` reaches its own ports,
and nobody else's. Its front calls its API, its API its worker, and a neighbour
still reaches none of them. The set holds `port . uid` pairs, rebuilt by
`deploy` from the manifests on the machine into
`/etc/sitesolide-loopback-projects.nft`, and replayed after the table at boot.
A project with a single service does not appear in it: it has nothing of its
own to call.

## Egress

A service reaches the loopback and nothing else, DNS included, unless its
manifest says otherwise. `"network": "outbound"` lifts that for everything;
`egress` lists the hosts it may reach instead, and keeps the rest closed.

The unit of a project with `egress` still refuses every address but the
loopback. Its HTTP clients are pointed at the egress proxy, on 127.0.0.1:3128,
outside the range the loopback rule closes, which lets the listed hosts
through. The proxy runs as its own account and decides on three readings:

- **who calls**, from the kernel: the uid of the caller's socket in
  `/proc/net/tcp`, turned into `site-<slug>`. Nothing the caller sends can say
  otherwise;
- **what that project may reach**, from its manifest on the machine, which the
  project's own service cannot rewrite;
- **where the host really points**: every address it resolves to is checked,
  and one inside the machine, a private network or the cloud's metadata
  service refuses it.

**Connectors** go one step further: credentials an administrator defines in
the dashboard, `slack`, `github`, and grants to a project. The app calls the
proxy in plain HTTP on the loopback, and the proxy forwards over HTTPS with the
credential added. A project gets one only when its manifest asks for it and
the dashboard granted it: the manifest is written by whoever wrote the app, and
must not be able to grant itself a company's credential.

What it does not stop matters as much: a project can still send whatever it
likes to a host on its own list. The list is the boundary. See
[egress/README.md](../egress/README.md) for the threat model.

## Certificates

Two paths, and they must not be confused.

**The zone** gets one wildcard certificate over DNS-01. That is the only way to
get a wildcard, and it needs a token that can edit the zone. Every project under
the zone shares that certificate. A block that diverged on TLS policy would
silently get its own certificate instead, so they all import the same snippet.

**A customer domain** gets its own certificate over HTTP-01, issued on first
request. The token on the machine cannot edit someone else's zone, and the
customer usually keeps their DNS elsewhere.

On-demand issuance is guarded by the `ask` endpoint: Caddy asks the shared
service, during the TLS handshake, whether a domain is allowed. It answers yes
only for domains in the table. Without that endpoint, anyone pointing DNS at the
machine would trigger issuances in your name, and those are counted.

That endpoint is why `api/` exists and why it stays tiny. A mistake in it takes
down certificate issuance for everyone at once.

## Secrets

The machine is the source of truth. `/etc/sitesolide` holds the environment
files, and they are read, placed and replaced from the dashboard's *Secrets*
section, which also restarts the service.

A service never reads its own secret file. systemd reads it as root, before
dropping privileges, and hands the variables to the process. The file stays
`0600`, owned by an account the service does not have.

`deploy` never pushes a secret. It checks that each file the manifest declares
is on the machine, and when one is not, it stops and says where to create it in
the dashboard. Where a file lands, whom it belongs to and under which mode
follow from its name and its site. See [secrets.md](secrets.md).

Two guard rails do not bend. Any `PASSWORD_HASH`, in any file, changes only
through *Change password*: the hash is never read back and never restored. And
`dashboard.env` is owned by root, so the dashboard's own service cannot rewrite
the hash that unlocks the secrets.

## Backups

Once installed, the machine snapshots every app's data folder every hour into
a restic repository, keeps a day of hourly snapshots, a week of daily ones and
a month of weekly ones, and can copy them, encrypted on the machine, to a
second repository in a bucket elsewhere, which stock restic reads back on any
machine. A snapshot is
restored one project at a time from the dashboard's *Backups* section, which
saves the current data first so that a restore can itself be undone, and puts
it back if the service does not come back on the restored data. Two sites are
restored by hand only: the dashboard, which would cut off the page doing it,
and the portal, whose old copy would bring back its old audit and the tables
it kept before the access registry.

The boundary is the same as everywhere: **root never opens a project's file**,
nor walks its folder. The copy, which measures the data too, and the
extraction run as the project's own account, in a transient unit with its
service's walls and no network, each within its own time; restic, run by
root, stores what the copy streams, in a repository no project can read. A manifest opts out with
`"backup": false`. A service that keeps a server database in the data,
PostgreSQL for one, declares a backup command that leaves a consistent copy
of it before the copy, which archives that copy instead of the live files; a
running server no service declares fails the snapshot rather than being
copied file by file. See [docs/manifest.md](manifest.md#a-services-backup-command)
and [dashboard/src/backup/README.md](../dashboard/src/backup/README.md).

## Previews and the portal

Two different things, often confused.

**A preview lock** closes one site behind a six-character code, for showing work
to a client before launch: its general access is then *Anyone with the code*.
The code is drawn on the machine by the gatekeeper and lives there, never in
the repository; the owner and the site's Admins read it in its *Access*
section, with the link that carries it, and draw a new one there. Every URL of
the locked host is rewritten to a code page that stands on its own, inline
CSS, inline icon, no external request, because anything it asked for would
come back as HTML.

**The portal** stands in front of every restricted site, and Caddy consults it
with `forward_auth` before every request. A project's **general access** is
one of three: **Public**, anyone opens it; **Restricted**, only its people
with access, the portal in front; **Anyone with the code**, the preview lock
above. Who opens a restricted site is its **people with access**: people
signing in with their company account, Google Workspace, Microsoft Entra or
any OpenID Connect provider, named by email or as a whole domain, each with a
role; people outside the company with **password access**, one password per
person and per site, drawn by the steward, shown once, until an expiry chosen
when it is given; and everywhere, the owner with the owner's password, and the
admin emails. They are given from a site's *Access* in the dashboard, or with
`sitesolide share` from a project's folder, over the owner's SSH, or with a
token through the dashboard and the steward, which lets a token give Can open
alone, to the company's people and domains. Every change goes to the steward's
registry and its projection, never to Caddy, and holds from the next request;
changing the general access, among the three, is what goes through the
gatekeeper, a switch between Restricted and the code in one transaction.

A restricted project writes no sign-in of its own. It trusts Caddy,
which is sound only because of the loopback rule. It also learns who came in,
from three request headers, `X-Sitesolide-User`, `X-Sitesolide-User-Name` and
`X-Sitesolide-Role`: the role on the project, from `visitor` (Can open) to
`admin`, and `admin` for the owner's password and the admin emails; password
access comes as `visitor` with no `X-Sitesolide-User`, the email having been
typed by whoever gave it, not verified by a provider. Its block takes the
visitor's own headers off every request before copying the portal's on, so a
site can trust them once its block has been deployed with them. A public site
has them taken off too, and learns nobody. See
[portal/README.md](../portal/README.md).

## Audit

Every component that acts records what it did in its own database, in one
shape: an ISO date, an actor, a dotted action, a target, and a detail in JSON
that never carries a secret value. An actor is an email, of someone with
access to a project or of someone given password access, `owner` for whoever
holds the dashboard's password, `token:<id>` for a token, `password:<id>` for
a password access given under a name rather than an email (`guest:<id>` on the
rows written before the access registry), `anonymous` before anyone is known,
or `system`. The steward writes a person's email as it verified it, never as
a request names it. A deployment by a person's own token is recorded under
`token:<id>`, the person's email in its detail's `member` field, a name
the rows keep. Nothing gathers
these tables on the machine: the dashboard's *Activity* page reads each
through the road it already takes to that component, and merges them, newest
first. How long each keeps its rows is in
[dashboard/README.md](../dashboard/README.md#the-audit).

Changes of access are the steward's to record: the portal, which no longer
keeps a list of who may open a site, records sign-ins and sign-outs alone.
The rows it wrote before the access registry, `sharing.update`,
`guest.create` and `guest.revoke`, still read, as do the steward's `member.*`
rows of before, which its `access.*`, `people.create` and `dashboard.*`
events replace; their action names stay as they were written, and the
*Activity* page says them in today's words. The steward keeps every accepted
change of access 180 days, in a file of its own beside its journal, which
rotates by line count: a refusal stays in the journal.

| Event | Source | Actor | Target | What it records |
|---|---|---|---|---|
| `token.create`, `token.revoke` | dashboard | `owner` | none | a token created or revoked from the owner's *Tokens* page, its label, email and scope |
| `token.create`, `token.revoke` | steward | a person's email, or who took their last role; `system` at the upgrade, and for the sweep | none | a person's own token created or revoked, its id and scope; one refused above their roles, with the steward's reason; the tokens of someone who no longer signs in, revoked under the owner or the Admin who took their last role above Can open; the live tokens of anyone the registry gives no rights, revoked by the sweep every 30 seconds; a token from before made a person's, once, at the upgrade |
| `project.create` | steward | a person's email | slug | a project a person's own token created, which made them its Admin; the token in the detail |
| `project.remove` | steward | `owner` | slug | a project `sitesolide remove` took off the machine: the name its token owned, free again for another token; that token in the detail |
| `deploy.start` | dashboard | `token:<id>` | slug | a token's deployment handed to the installer; the person's email in the `member` field, for a person's own token |
| `deploy.success`, `deploy.failure` | dashboard | `token:<id>` | slug | how it ended, the error's code for a failure; the `member` field for a person's own token |
| `access.add`, `access.change`, `access.remove` | steward | `owner`, an Admin's email, or `token:<id>` | slug, the person's email in the detail; the email alone for someone taken off every project | someone given access, their role changed, or their access taken away, as "who: Role", with the expiry of password access; a change refused, with the steward's reason, a minute holding twenty refusals at most |
| `access.migrate` | steward | `system`, or `owner` without the portal's database | none | the registry made, once, from the stores before it: the counts carried over and set aside |
| `people.create` | steward | `owner` | the person's email | the right to create projects given or taken back |
| `dashboard.signin` | steward | the person's email | the person's email | a session opened, from an assertion it verified, with their roles and create right |
| `dashboard.signin_failed` | steward | the email, or `anonymous` when the assertion did not verify | the email, or none | a sign-in refused: `can-open-only` for someone who only opens sites, `no-role` for someone on no list, an assertion replayed, signed by another key, expired, too old; a minute holds twenty refusals at most |
| `dashboard.signout` | steward | the person's email | the person's email | a person signed out |
| `portal.signin` | portal | `owner`, an email, or `password:<id>` | host | a sign-in with the owner's password, a company account, or password access (`method: "password-access"`, under the email it was given to, or `password:<id>` with its `name` in the detail), its role; `guest:<id>` on rows of before; repeats within a minute counted on one row |
| `portal.signin_failed` | portal | `anonymous` or an email | host | a wrong password, or a company account refused and why |
| `portal.signout` | portal | as it signed in | host | a sign-out |
| `sharing.update` | portal | `owner`, `token:<id>` or an email | host | written before the access registry only: who could open a site changed, the mode, the people and domains added and removed |
| `guest.create`, `guest.revoke` | portal | `owner` or an email | host | written before the access registry only: a password access given or removed, its label and expiry, never the password |
| `sharing.update`, `guest.create`, `guest.revoke` | steward | an email | slug | written before the access registry only: a change refused before it reached the portal |
| `egress.denied` | egress | `system` | slug, or none | connections refused, by destination and reason, counted by the minute |
| `connector.use` | egress | `system` | slug | a connector's calls, counted by the minute, and how many failed |
| `connector.update` | egress | `owner` | connector | a connector created, changed or removed; a replaced value is said, never shown |
| `connector.grant` | egress | `owner` | slug | a connector granted to a site, or withdrawn |
| `backup.run` | backups | `system` | none | an hourly run: snapshots taken and pruned, the offsite copy, the sites that failed |
| `backup.restore` | backups | `owner` or an Admin's email | slug | a restore, its snapshot and how it ended |
| `backup.restore` | steward | a person's email | slug | a restore refused by role before it reached the backups |
| `member.invite`, `member.role`, `member.remove`, `member.signin`, `member.signin_failed`, `member.signout` | steward | as they were written | as they were written | written before the access registry only: the dashboard's people of then, their roles and sign-ins |
| `secrets.unlock`, `secrets.lock` | steward | `owner`, or a person's email | none, or the person's email | changes unlocked, or the password or the forced sign-in refused, and locked again |
| `secrets.read`, `secrets.set`, `secrets.remove` | steward | `owner`, or a person's email | slug | a variable read, set or removed, by its name; a person's refused by role, with that role |
| `secrets.create`, `secrets.restore`, `secrets.replace` | steward | `owner`, or a person's email | slug | a secret file created, put back to its previous version, or replaced |
| `secrets.password` | steward | `owner` | slug | a password hash changed |
| `access.general` | steward | `owner`, or an Admin's email | slug | a site's general access chosen, Public, Restricted or Anyone with the code, `off`, `on` or `code` in the detail; listed as `door.update` before, the rows themselves unchanged |
| `access.code` | steward | `owner`, or an Admin's email | slug | a site that opens with a code given a new one; never the code, which no row holds |
| `service.restart` | steward | `owner`, or a person's email | slug | a service restarted from *Secrets*, or by a Developer or an Admin, with its verdict; a person's refused restart, with their role |

The steward's rows say how each operation ended, `ok`, `rejects` or `failure`,
in their detail's `result`. Their source is the steward's journal, which has
no ids: the dashboard gives them the shared shape as it reads them. A line of
the journal written before it named its actor reads as `owner`, the only one
it acted for then.

The *Activity* page shows the owner the whole machine; a person, the rows of
their projects and their own. Each row reads as a sentence, "Gave
dana@example.com Developer on cms", and *Access changes* narrows it to the
changes of access.

## What the deploy actually does

In order, and the order is the point:

1. Read the manifest, refuse it if anything is wrong. Nothing has been sent yet.
2. Read the machine: does the dashboard say this project is restricted?
   Is the block in service one the generator would write, or one edited by hand
   there, which stops everything without `--force`? Does systemd already run a
   service of that name that deploy did not write? Does another project already
   declare one of its ports? For a project with several services, does the
   loopback rule have room for its own ports? For a project with `egress` or
   `connectors`, does the egress proxy run?
3. Build locally.
4. Create the system account and the directories.
5. Install the systemd units that are missing, remove those of services the
   manifest no longer declares.
6. Upload the code, then the public files.
7. Take the Caddy lock, read the general access and every port again under it, then put
   down the manifest, and rebuild the loopback's project set when the
   manifests say something other than what it carries.
8. Run `install` as the project's account, in its service's walls.
9. Restart every service, check each one is active, and write the block.
10. Verify over HTTPS that the site answers.

For a restricted project, the portal goes in front **before** its files,
and comes off **after** them. Placed the other way around, its files would be served
in the clear by the wildcard block for the length of the deployment, and
indefinitely if the command was interrupted.

`--dry-run` prints the generated unit and block, and every command it would run,
without touching anything, nor running the build, which is the folder's own
code; `--dry-run --build` runs it too.

Someone with a token deploys over HTTPS instead of SSH, and the same order
runs on the machine, in the installer, with the same decisions: see
[dashboard/README.md](../dashboard/README.md), "The control API", and
[access.md](access.md).

## Reading further

- [docs/install.md](install.md), from nothing to a first deployment
- [docs/manifest.md](manifest.md), every key, and what it changes
- [docs/commands.md](commands.md), what the CLI does
- [infra/README.md](../infra/README.md), the machine itself
- [dashboard/README.md](../dashboard/README.md), the dashboard, the steward and the gatekeeper
- [dashboard/src/backup/README.md](../dashboard/src/backup/README.md), the data snapshots and their restore
- [portal/README.md](../portal/README.md), the owner's password, password access, signing in with a company account, the projection it decides from and the identity headers
- [analytics/README.md](../analytics/README.md), how a visit is counted, and why it is anonymous
- [monitor/README.md](../monitor/README.md), what is checked every minute, and who hears of it
- [egress/README.md](../egress/README.md), the hosts a project may reach, and the credentials it is lent
