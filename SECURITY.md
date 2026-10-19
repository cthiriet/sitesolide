# Security

## Reporting a vulnerability

**Privately, through GitHub**: the repository's *Security* tab, *Report a
vulnerability*, or directly
<https://github.com/cthiriet/sitesolide/security/advisories/new>. The report
reaches the maintainer alone, and the fix is discussed in the same private
advisory.

Please do not open a public issue, a pull request or a discussion for a
vulnerability: on a platform that serves every project from one machine, a
hole made public before its fix is open on every installation at once.

A useful report says:

- the version, from `sitesolide --version`, or the commit;
- the component: the CLI, `setup`, a generated unit or Caddy block, the
  portal, the dashboard, the steward, the gatekeeper, the installer, the
  shared service, the egress proxy, the backups, the monitor, analytics;
- who the attacker is, in the terms of
  [docs/concepts.md](docs/concepts.md#who-may-touch-what): a visitor, a
  person with a role on a project, a token, a project's own code, a
  component already compromised;
- what they reach that the table says they should not, and the steps to get
  there.

One person maintains this project. A report is answered as soon as it is
read; a fix ships as a new release, with what the upgrade leaves by hand in
[docs/upgrading.md](docs/upgrading.md), and the advisory is published once
that release is out, crediting the reporter unless they ask otherwise.

## Supported versions

The latest release. Fixes are not backported: an installation upgrades to the
release that carries the fix, see [docs/upgrading.md](docs/upgrading.md).

## Scope

The threat model is [Who may touch what](docs/concepts.md#who-may-touch-what):
each component has one job, and anything that lets one do more is in scope.
In particular:

- a project's service reading another project's files or secrets, reaching
  another project's service over the loopback, or listening on a port
  reserved to Caddy, the portal or the egress proxy;
- getting past the portal, a preview lock or a site's general access, or
  forging the identity headers a restricted site trusts;
- a person, a token or a password access doing more than its role allows:
  reading a secret as a Developer, giving a role above one's own, a token
  reaching a project it was not granted;
- a compromised component, the dashboard, the portal, a project, reaching
  further than its section of the threat model says;
- a project reaching a host its manifest does not list, or a connector it
  was not granted, see [egress/README.md](egress/README.md#threat-model);
- a backup copy, extraction or restore touching another project's data or
  root's;
- `setup` or `deploy` leaving the machine weaker than the documentation says.

The sections that go further: the dashboard's
[threat model of access](dashboard/README.md#threat-model), the portal's
[What the portal does not protect](portal/README.md#what-the-portal-does-not-protect),
and the egress proxy's.

## What is known, and not a vulnerability

These are limits of the design, stated so that nobody spends a weekend
proving them:

- **One kernel.** Every project runs on the same kernel, confined by a system
  account and systemd's directives, with no container and no user namespace.
  A kernel exploit, or an escape from systemd's confinement, gets root on the
  machine and every project on it.
- **No system call filter on a project's units** (`SystemCallFilter=`); the
  backup units have one.
- **The owner's SSH account has passwordless sudo.** Whoever holds its key
  holds the machine; that is what "only the owner holds SSH" means.
- **A preview code is about 30 bits, and nothing limits the attempts.** It
  keeps a passing visitor out, not an adversary, see
  [api/src/locks.ts](api/src/locks.ts); use Restricted for anything that
  deserves authentication.
- **A project can slow its neighbours.** Workers and scheduled services yield
  the processor to the sites, but a server has no CPU cap unless its manifest
  sets `cpu`.
- **A project sends what it likes to the hosts its manifest lists.** The list
  is the boundary.
- **What sitesolide trusts**: the identity provider, Cloudflare and its DNS
  token, the cloud provider and its console, the bucket's provider for
  availability (not for confidentiality: restic encrypts on the machine).
  Whoever controls one of them is not stopped here.
- **What `setup` downloads**, as root, over HTTPS: Bun's installer, piped to
  bash; Caddy's apt repository and its key; and, through `caddy add-package`,
  a build of Caddy with the Cloudflare module. sitesolide's own releases are
  checked against checksums from the same release, which catch a broken
  download, not a compromised release; they are not signed.

A vulnerability in Bun, Caddy, systemd, restic or Debian belongs to their
maintainers. How sitesolide configures them belongs here.
