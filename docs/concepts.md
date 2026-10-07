# How it works

The parts, what each one is allowed to do, and why the boundaries are drawn
where they are.

## Three decisions

**One machine, on purpose.** There is no staging environment and no automatic
failover. What breaks production breaks every site at once, and nothing repairs
itself. That constraint is what keeps the system small enough to understand
completely, and it is why the deployment path verifies and rolls back rather
than assuming.

**The server is the source of truth.** For a deployed project, the portal door
and its secrets are what the machine carries, not what the repository says. The
CLI reads the machine, and refuses to contradict it.

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
| The shared service (`api/`) | its own account | answer `ask` for on-demand TLS, generate preview locks |
| The dashboard | `site-dashboard` | read a snapshot file, relay to the steward, call the portal |
| The portal | `site-portal` | answer Caddy's `forward_auth`, sign people in with the identity provider, sign the dashboard's identity assertions, believe an actor other than `owner` from root alone |
| The steward | root | write `/etc/sitesolide`, restart services, command the gatekeeper, keep the dashboard's members and judge what they do, their own tokens included, ask the portal for a Project admin or a team token through its relay |
| The portal relay | root, no capability, on demand | forward the steward's connections to the portal's admin API, and to nothing else |
| The gatekeeper | root, one-shot | rewrite one project's block, reload Caddy, probe, roll back |
| The installer | root, one-shot | deploy one project for a team token, the archive read by the project's own account |
| The collector | root, on a timer | read the machine, drop a snapshot where the dashboard can read it |
| The monitor | `sitesolide-monitor`, on a timer | read what any account reads, ask Caddy for every site over HTTPS, alert |
| The egress proxy | `sitesolide-egress` | let each project reach the hosts its manifest lists, lend it the connectors granted to it |
| The backup run | root, on a timer | list the projects, store the archives their own accounts hand it, prune, upload |
| A backup copy or extraction | `site-<slug>`, one-shot | read or write that project's data, nothing else, no network |
| A restore | root, one-shot | swap one project's data folder, restart its services, put the data back if they fail |

**The dashboard reads nothing itself.** Its unit replaces `/srv` with an empty
mount, so it cannot open another project's files, and the loopback rule stops it
reaching other services. What it displays comes from a snapshot file a root
timer wrote for it. A compromised dashboard therefore leaks exactly what the
page already showed.

**Only the gatekeeper touches Caddy from the machine**, and only for the one
project named in its unit. Two unit templates rather than one instance, so that
each can only write into `/srv/sites/%i`: a compromised gatekeeper holds the one
site you named it for.

**A member of the dashboard is judged as root.** The dashboard's members, the
people the owner invites by email with a role per project, sign in with their
work account, and the dashboard believes no name it is told: the portal, the
one authority on who someone is, signs an assertion of the email the provider
verified, for the dashboard, for five minutes, once; the steward checks it
with a public key it keeps itself before it opens the session, and judges
every write a member asks for against its own registry, at that moment. The
key pair is the steward's: it lays the private half where only the portal's
account reads it, `/etc/sitesolide-portal/assertion.key`. A compromised
dashboard acts only for the members whose sessions pass through it, within
their roles; it can neither make a member nor widen one. What a member sees,
the dashboard filters from data it already holds. See
[dashboard/README.md](../dashboard/README.md#members).

Their roles: a Viewer looks; a Developer also restarts the project's service
and writes its secrets without ever reading one back; a Project admin looks
after all of the project, its secrets read, its door, sharing, guests,
backups, and its members, a role at most their own. **A member's secret read,
a door, a restore, a role given, a token minted, each waits for the member's
own unlock**: a forced sign-in at the provider, which the portal asks for
(`prompt=login`, `max_age=0`) and reads back in the provider's own ID token,
and the steward checks again, for ten minutes and that member's session
alone. The steward never hands a Developer a value, whatever the dashboard
relays. A Project admin's sharing and guests reach the portal from the
steward, as root, through a relay: the steward keeps no network, and the
portal records the email the steward verified, believing an actor other than
`owner` from root alone, which it tells by the uid of the connection.

**A member's own tokens are never stronger than the member.** A Developer
mints a token that deploys their project, a Project admin one that may also
deploy public sites, declare a domain or reach outside hosts, and a member the
owner granted the right to create projects one that creates them, which makes
them Project admin of what it creates. The steward reads the registry at
every use of such a token, and again when the installer starts: a role
lowered to Viewer stops that project's deployments at the next request, and a
member removed takes their tokens with them. See
[team.md](team.md#a-members-own-tokens).

**Everything that reloads Caddy shares one lock**, `/run/sitesolide-gatekeeper/caddy.lock`.
The CLI, the deploy scripts and the gatekeeper all take it. Without it, a door
set from the dashboard between a read and a write was silently overwritten, and
the site served in the clear.

## The loopback rule

An nftables rule reserves ports 3000 to 3099, **and Caddy's admin API on 2019**,
to Caddy and root. That API authenticates nobody: a service that could reach it
would open every portal-protected site at once, or stop Caddy.

This is what makes a project behind the portal able to trust Caddy. It has no
door of its own; it trusts the header Caddy puts on the request, and that trust
is only founded because nothing else on the machine can forge it.

One exception, deliberate: the dashboard may reach the portal, where it creates
and revokes guest access, sets each site's sharing, reads the portal's audit,
and has its members' sign-ins sealed and redeemed.
Those routes have no other guard than this rule, and a test refuses any fragment
that would expose them. Root reaches them too: `sitesolide share` over the
owner's SSH, and the steward for a Project admin or a team token, through
`sitesolide-portal-relay`, a systemd proxy that forwards a socket only root
opens to the portal's port and to nothing else, so that the steward's own
unit keeps no network at all. The portal tells root from the dashboard the way
the egress proxy tells its callers apart, by the uid of the connection's
other end in `/proc/net/tcp`: only root may name who acts, a member's email
or a token, and the dashboard speaks as `owner`, whatever it sends.

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

Once installed, the machine snapshots every app's data folder every hour, keeps
a day of hourly snapshots, a week of daily ones and a month of weekly ones, and
can copy them, encrypted on the machine, to a bucket elsewhere. A snapshot is
restored one project at a time from the dashboard's *Backups* section, which
saves the current data first so that a restore can itself be undone, and puts
it back if the service does not come back on the restored data. Two sites are
restored by hand only: the dashboard, which would cut off the page doing it,
and the portal, whose old copy would let back in every guest revoked since.

The boundary is the same as everywhere: **root never opens a project's file**,
nor walks its folder. The copy, which measures the data too, and the
extraction run as the project's own account, in a transient unit with its
service's walls and no network, each within its own time; root only stores
what they hand it, as archives no project can read. A manifest opts out with
`"backup": false`. See
[dashboard/src/backup/README.md](../dashboard/src/backup/README.md).

## Previews and the portal

Two different things, often confused.

**A preview lock** closes one site behind a six-character code, for showing work
to a client before launch. The code lives on the machine, never in the
repository. Every URL of the locked host is rewritten to a door page that stands
on its own, inline CSS, inline icon, no external request, because anything it
asked for would come back as HTML.

**The portal** is the door of your personal projects, which Caddy consults with
`forward_auth` before every request. One shared password opens them all; the
dashboard can also mint per-person guest access, one password per person and per
site; and once an identity provider is configured, people sign in with their
company account, Google Workspace, Microsoft Entra or any OpenID Connect
provider, and the dashboard's *Sharing* section decides per site who gets in:
the admins only, a list of people, or everyone at a domain. `sitesolide share`
does the same from a project's folder, over the owner's SSH, or with a team
token through the dashboard and the steward, which lets a token open a site
only to the domains the portal admits and hands the change to the portal as
root. A change of sharing touches only the portal's database, never Caddy, and
holds from the next request.

A project behind the portal writes no door of its own. It trusts Caddy, which is
sound only because of the loopback rule. It also learns who came in, from three
request headers, `X-Sitesolide-User`, `X-Sitesolide-User-Name` and
`X-Sitesolide-Role`: its block takes the visitor's own off every request before
copying the portal's on, so a site can trust them once its block has been
deployed with them. A site not behind the portal has them taken off too, and
learns nobody. See [portal/README.md](../portal/README.md).

## Audit

Every component that acts records what it did in its own database, in one
shape: an ISO date, an actor, a dotted action, a target, and a detail in JSON
that never carries a secret value. An actor is an email, a member of the
dashboard's or a visitor's, `owner` for whoever holds the dashboard's
password, `token:<id>` for a team token, `guest:<id>`, `anonymous` before
anyone is known, or `system`. The steward writes a member's email as it
verified it, never as a request names it, and the portal takes a member's
email or a token as the actor from root alone. A deployment by a member's own
token is recorded under `token:<id>`, the member's email in its detail,
`member`. Nothing gathers these tables
on the machine: the dashboard's *Activity* page reads each through the road it
already takes to that component, and merges them, newest first. How long each
keeps its rows is in [dashboard/README.md](../dashboard/README.md#the-audit).

| Event | Source | Actor | Target | What it records |
|---|---|---|---|---|
| `token.create`, `token.revoke` | dashboard | `owner` | none | a team token created or revoked from the owner's *Team* page, its label, email and scope |
| `token.create`, `token.revoke` | steward | a member's email, or who removed them | none | a member's own token created or revoked, its id and scope; one refused above their roles, with the steward's reason; the tokens of a member removed, revoked under the owner or the Project admin who took their last role |
| `project.create` | steward | a member's email | slug | a project a member's own token created, which made them its Project admin; the token in the detail |
| `project.remove` | steward | `owner` | slug | a project `sitesolide remove` took off the machine: the name its team token owned, free again for another token; that token in the detail |
| `deploy.start` | dashboard | `token:<id>` | slug | a token's deployment handed to the installer; `member` for a member's own token |
| `deploy.success`, `deploy.failure` | dashboard | `token:<id>` | slug | how it ended, the error's code for a failure; `member` for a member's own token |
| `portal.signin` | portal | `owner`, `guest:<id>` or an email | host | a sign-in with the shared password, a guest password or a work account, its role; repeats within a minute counted on one row |
| `portal.signin_failed` | portal | `anonymous` or an email | host | a wrong password, or a work account refused and why |
| `portal.signout` | portal | as it signed in | host | a sign-out |
| `sharing.update` | portal | `owner`, or `token:<id>` or a Project admin's email from the steward, as root | host | who gets in changed: the mode, the people and domains added and removed |
| `guest.create`, `guest.revoke` | portal | `owner`, or a Project admin's email from the steward, as root | host | a guest access given or revoked, the guest's label and expiry, never the password |
| `sharing.update`, `guest.create`, `guest.revoke`, `backup.restore` | steward | a member's email | slug | a member's change refused before it reached the portal or the backups: their role, or a domain the portal does not admit; a member's own token refused sharing, by role |
| `egress.denied` | egress | `system` | slug, or none | connections refused, by destination and reason, counted by the minute |
| `connector.use` | egress | `system` | slug | a connector's calls, counted by the minute, and how many failed |
| `connector.update` | egress | `owner` | connector | a connector created, changed or removed; a replaced value is said, never shown |
| `connector.grant` | egress | `owner` | slug | a connector granted to a site, or withdrawn |
| `backup.run` | backups | `system` | none | an hourly run: snapshots taken and pruned, the offsite copy, the sites that failed |
| `backup.restore` | backups | `owner` or a Project admin's email | slug | a restore, its snapshot and how it ended |
| `member.invite`, `member.role`, `member.remove` | steward | `owner`, or a Project admin's email | the member's email, or the project for a Project admin's change, the member in the detail | a member invited, their roles or their right to create projects changed, or removed, with their roles and that right; a Project admin's change refused, with their role |
| `member.signin` | steward | the member's email | the member's email | a member's session opened, from an assertion it verified |
| `member.signin_failed` | steward | the email, or `anonymous` when the assertion did not verify | the email, or none | a sign-in refused: not a member, an assertion replayed, signed by another key, expired, too old; a minute holds twenty at most |
| `member.signout` | steward | the member's email | the member's email | a member signed out |
| `secrets.unlock`, `secrets.lock` | steward | `owner`, or a member's email | none, or the member's email | the secrets unlocked, or the password or the forced sign-in refused, and locked |
| `secrets.read`, `secrets.set`, `secrets.remove` | steward | `owner`, or a member's email | slug | a variable read, set or removed, by its name; a member's refused by role, with that role |
| `secrets.create`, `secrets.restore`, `secrets.replace` | steward | `owner`, or a member's email | slug | a secret file created, put back to its previous version, or replaced |
| `secrets.password` | steward | `owner` | slug | a password hash changed |
| `door.update` | steward | `owner`, or a Project admin's email | slug | a site's portal turned on or off from *Access* |
| `service.restart` | steward | `owner`, or a member's email | slug | a service restarted from *Secrets*, or by a Developer or Project admin, with its verdict; a member's refused restart, with their role |

The steward's rows say how each operation ended, `ok`, `rejects` or `failure`,
in their detail's `result`. Their source is the steward's journal, which has
no ids: the dashboard gives them the shared shape as it reads them. A line of
the journal written before it named its actor reads as `owner`, the only one
it acted for then.

The *Activity* page shows the owner the whole machine; a member, the rows of
their projects and their own.

## What the deploy actually does

In order, and the order is the point:

1. Read the manifest, refuse it if anything is wrong. Nothing has been sent yet.
2. Read the machine: does the dashboard say this project is behind the portal?
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
7. Take the Caddy lock, read the door and every port again under it, then put
   down the manifest, and rebuild the loopback's project set when the
   manifests say something other than what it carries.
8. Run `install` as the project's account, in its service's walls.
9. Restart every service, check each one is active, and write the block.
10. Verify over HTTPS that the site answers.

For a project behind the portal, the door goes down **before** its files, and
comes off **after** them. Placed the other way around, its files would be served
in the clear by the wildcard block for the length of the deployment, and
indefinitely if the command was interrupted.

`--dry-run` prints the generated unit and block, and every command it would run,
without touching anything, nor running the build, which is the folder's own
code; `--dry-run --build` runs it too.

A team member deploys with a token instead of SSH, and the same order runs on
the machine, in the installer, with the same decisions: see
[dashboard/README.md](../dashboard/README.md), "The control API", and
[team.md](team.md).

## Reading further

- [docs/install.md](install.md), from nothing to a first deployment
- [docs/manifest.md](manifest.md), every key, and what it changes
- [docs/commands.md](commands.md), what the CLI does
- [infra/README.md](../infra/README.md), the machine itself
- [dashboard/README.md](../dashboard/README.md), the dashboard, the steward and the gatekeeper
- [dashboard/src/backup/README.md](../dashboard/src/backup/README.md), the data snapshots and their restore
- [portal/README.md](../portal/README.md), the shared door, guest access, signing in with a company account, sharing and the identity headers
- [analytics/README.md](../analytics/README.md), how a visit is counted, and why it is anonymous
- [monitor/README.md](../monitor/README.md), what is checked every minute, and who hears of it
- [egress/README.md](../egress/README.md), the hosts a project may reach, and the credentials it is lent
