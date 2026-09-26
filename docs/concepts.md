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

Services cannot reach each other over the loopback either, see
[the loopback rule](#the-loopback-rule).

## Who may touch what

This is the part worth reading twice. Each component has exactly one job and no
more.

| Component | Runs as | May |
|---|---|---|
| Caddy | `caddy` | serve, and ask the shared service whether a domain is allowed |
| A project's service | `site-<slug>` | read its own directory, write its own data directory |
| The shared service (`api/`) | its own account | answer `ask` for on-demand TLS, generate preview locks |
| The dashboard | `site-dashboard` | read a snapshot file, relay to the steward, call the portal |
| The steward | root | write `/etc/sitesolide`, restart services, command the gatekeeper |
| The gatekeeper | root, one-shot | rewrite one project's block, reload Caddy, probe, roll back |
| The collector | root, on a timer | read the machine, drop a snapshot where the dashboard can read it |

**The dashboard reads nothing itself.** Its unit replaces `/srv` with an empty
mount, so it cannot open another project's files, and the loopback rule stops it
reaching other services. What it displays comes from a snapshot file a root
timer wrote for it. A compromised dashboard therefore leaks exactly what the
page already showed.

**Only the gatekeeper touches Caddy from the machine**, and only for the one
project named in its unit. Two unit templates rather than one instance, so that
each can only write into `/srv/sites/%i`: a compromised gatekeeper holds the one
site you named it for.

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
and revokes guest access. Those routes have no other guard than this rule, and a
test refuses any fragment that would expose them.

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

## Previews and the portal

Two different things, often confused.

**A preview lock** closes one site behind a six-character code, for showing work
to a client before launch. The code lives on the machine, never in the
repository. Every URL of the locked host is rewritten to a door page that stands
on its own, inline CSS, inline icon, no external request, because anything it
asked for would come back as HTML.

**The portal** is one shared password for your personal projects, which Caddy
consults with `forward_auth` before every request. The dashboard can also mint
per-person guest access, one password per person and per site.

A project behind the portal writes no door of its own. It trusts Caddy, which is
sound only because of the loopback rule.

## What the deploy actually does

In order, and the order is the point:

1. Read the manifest, refuse it if anything is wrong. Nothing has been sent yet.
2. Read the machine: does the dashboard say this project is behind the portal?
   Is the block in service one the generator would write, or one edited by hand
   there, which stops everything without `--force`?
3. Build locally.
4. Create the system account and the directories.
5. Install the systemd unit if it is missing.
6. Take the Caddy lock, read the door again under it, write the block.
7. Upload the code, then the public files.
8. Put down the manifest.
9. Restart the service, check it is active.
10. Verify over HTTPS that the site answers.

For a project behind the portal, the door goes down **before** its files, and
comes off **after** them. Placed the other way around, its files would be served
in the clear by the wildcard block for the length of the deployment, and
indefinitely if the command was interrupted.

`--dry-run` prints the generated unit and block, and every command it would run,
without touching anything.

## Reading further

- [docs/install.md](install.md), from nothing to a first deployment
- [docs/manifest.md](manifest.md), every key, and what it changes
- [docs/commands.md](commands.md), what the CLI does
- [infra/README.md](../infra/README.md), the machine itself
- [dashboard/README.md](../dashboard/README.md), the dashboard, the steward and the gatekeeper
- [portal/README.md](../portal/README.md), the shared door and guest access
- [analytics/README.md](../analytics/README.md), how a visit is counted, and why it is anonymous
