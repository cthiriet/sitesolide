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
  shared service, the egress proxy, the backups, the monitor;
- who the attacker is, in the terms of
  [docs/concepts.md](docs/concepts.md#who-may-touch-what): a visitor, a
  guest with password access, a token, a project's own code, a component
  already compromised;
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
  forging the `X-Sitesolide-Role` header a restricted site trusts;
- a guest, a token or an agent doing more than it was given: a password
  access opening another site or the dashboard, reading a secret's value
  back as anyone but the owner in the unlocked dashboard, a token or the
  build included, a token giving anyone access or reaching a project it was
  not granted;
- a compromised component, the dashboard, the portal, a project, reaching
  further than its section of the threat model says;
- a project reaching a host its manifest does not list, see
  [egress/README.md](egress/README.md#threat-model);
- a backup copy, extraction or restore touching another project's data or
  root's;
- signing in to the dashboard or unlocking it as the owner without a
  passkey once one is registered, with an assertion made for another origin
  than the dashboard's or the portal's, or registering a passkey without
  the owner's unlock or root's link;
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
  Its system calls are filtered to systemd's `@system-service` set, which
  narrows the kernel it reaches without closing it: files, sockets, processes
  and memory remain. A kernel exploit through what is left, or an escape from
  systemd's confinement, gets root on the machine and every project on it.
- **The owner's SSH account has passwordless sudo, for every command.**
  Whoever holds its key holds the machine; that is what "only the owner
  holds SSH" means. It is not narrowed to a list of commands because the CLI
  works by sending a script on standard input to `sudo -n sh -s`, for setup's
  and upgrade's checks and runs alike: a rule allowing `sh` is a rule
  allowing everything, and a fixed list of wrapper scripts would have to be
  upgraded before every upgrade that changes them, by the very sudo it
  restricts. A password for sudo would be typed over SSH on every run, or
  stored on the workstation beside the key, and would stop nobody who holds
  the key and waits for the next run. What protects the machine is therefore
  the key and the path to port 22: keys only, the deploy account alone in
  `AllowUsers`, a security key where the owner uses one, and port 22 closed
  to the internet behind a tailnet where the owner chooses to, see
  [docs/ssh.md](docs/ssh.md). The residual risk: a stolen workstation key,
  unlocked agent included, is root on the machine for as long as port 22
  reaches it.
- **Port 22 is open to the internet by default**, keys only, behind
  fail2ban. `--ssh-from`, `--ssh-interface tailscale0` and `sitesolide machine
  firewall --ssh-closed` narrow it; nothing narrows it without being asked.
- **A tailnet is trusted to deliver packets, not to authenticate.** With
  `--tailscale`, OpenSSH still checks the key, and Tailscale SSH stays off;
  whoever controls the Tailscale account can add a device to the tailnet,
  which Tailnet Lock prevents, and still needs the key to log in.
- **A preview code is 50 bits, and nothing limits the attempts.** Ten
  characters, out of reach of a script that guesses without being counted;
  a site locked before that release keeps its six-character code, about 30
  bits, until its owner draws a *New code*. It keeps a passing visitor out,
  not an adversary, see
  [api/src/locks.ts](api/src/locks.ts); use Restricted for anything that
  deserves authentication.
- **The services of one project trust each other.** They run as the same
  account and receive the same secrets, variables and files, and each can
  read the other's environment and copy of the files through `/proc`: no
  secret is scoped to one service. Between projects, those reads are
  denied.
- **A project can slow its neighbours.** Workers and scheduled services yield
  the processor to the sites, but a server has no CPU cap unless its manifest
  sets `cpu`.
- **A project sends what it likes to the hosts its manifest lists.** The list
  is the boundary.
- **Root's passkey link is the owner's credential for fifteen minutes.**
  Whoever reads it from the terminal before it is used registers a passkey
  and signs in as the owner; root over SSH already holds the machine.
- **A compromised dashboard, during the owner's unlock, can register a
  passkey of its own**, as it can read every secret then. It shows on the
  *Server* page and in the steward's journal; root removes it with
  `sitesolide passkey remove`.
- **What sitesolide trusts**: Cloudflare and its DNS
  token, the cloud provider and its console, the bucket's provider for
  availability (not for confidentiality: restic encrypts on the machine).
  Whoever controls one of them is not stopped here.
- **What `setup` downloads**, as root, over HTTPS: Bun's release zip, at the
  version `bin/cli/pins.ts` pins and refused unless its SHA-256 is the
  pinned one; Caddy's apt repository, and Cloudflare's under `--tunnel`, each
  key refused unless it is the one `bin/cli/pins.ts` pins by fingerprint; and the
  sources of Caddy, its Cloudflare module, xcaddy and Go's toolchain, at the
  versions `infra/caddy/build.sh` pins, each checked against Go's checksum
  database before Caddy is built on the machine. sitesolide's own releases are
  built by a job whose token only reads, and published by another that runs
  no code of the repository nor of npm, never overwriting a release's files;
  each file carries a provenance attestation, signed through Sigstore, which
  `install.sh` checks with `gh attestation verify` when gh is signed in, and
  otherwise checks against the release's own checksums alone. With
  `--tailscale`, setup adds Tailscale's apt repository, its key refused
  unless it is the one Tailscale publishes by fingerprint.

A vulnerability in Bun, Caddy, systemd, restic or Debian belongs to their
maintainers. How sitesolide configures them belongs here.
