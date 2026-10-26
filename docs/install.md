# Installing sitesolide

From nothing to a first deployed project in three commands. Budget a quarter of
an hour, most of it the machine installing packages while you wait.

```bash
curl -fsSL https://github.com/cthiriet/sitesolide/releases/latest/download/install.sh | sh
```

```bash
sitesolide setup
```

```bash
cd your-project && sitesolide deploy
```

`sitesolide setup`, alone at a terminal, asks which cloud, which region and
which size, checks your domain at its DNS provider, shows the plan with its price,
then orders the machine and installs it: see [the wizard](setup.md#the-wizard).
The same, without questions, for a script or an agent:

```bash
sitesolide machine create --provider hetzner --name web
```

```bash
sitesolide setup root@203.0.113.10 --zone example.com --email you@example.com
```

## What you need first

- **A domain, at any registrar.** Every project gets a subdomain of it, and the
  machine serves the bare domain too. Where its DNS is served by Cloudflare,
  Route 53, Azure, DigitalOcean, Hetzner, Scaleway, Vultr, Akamai, OVHcloud,
  Gandi or Porkbun, setup creates the records and Caddy obtains one wildcard
  certificate, with credentials scoped to the zone; anywhere else, you create
  two records by hand and each project gets its own certificate. See
  [setup.md](setup.md#dns).
- **The DNS credentials**, for a provider: Cloudflare's is a token created at
  [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
  with **Create Custom Token**, restricted to that zone, with `Zone / Zone /
  Read` and `Zone / DNS / Edit`; each other provider's page in [dns/](dns/)
  says how to make its own. Setup uses them from your workstation to create the
  records, and lays them on the machine, where Caddy uses them for the
  wildcard certificate.
- **An SSH key** on your workstation, `~/.ssh/id_ed25519` or another.
- **A machine**: either an account at one of the clouds of
  [machine.md](machine.md), Hetzner, DigitalOcean, AWS, Google Cloud, Azure,
  Vultr, Akamai (Linode) or Scaleway, and sitesolide orders one, or any fresh
  Debian 13 VM, from any provider, that you reach as `root` with that key, or
  as an account with sudo that asks no password.

## 1. Install the CLI

```bash
curl -fsSL https://github.com/cthiriet/sitesolide/releases/latest/download/install.sh | sh
```

One executable for your system and processor, macOS or Linux, checked against
the release's checksums and put in `~/.local/bin`. It needs neither Bun nor a
clone of this repository: everything the CLI runs is inside it. Your
workstation needs only what it already has, `bash`, `ssh`, `rsync` and `curl`.

From a checkout instead, for development: `ln -sf "$PWD/bin/sitesolide.ts"
~/.local/bin/sitesolide`, with [Bun](https://bun.com) installed.

## 2. A machine

`sitesolide setup` alone at a terminal orders it for you, from the cloud you
pick: skip to [3](#3-install-it) and run it bare. Without the wizard, each
cloud's page in [providers/](providers/) says how to make its credentials; at
Hetzner, with a token of a project of its own (*Security*, *API tokens*,
**Read & Write**):

```bash
read -rs HCLOUD_TOKEN && export HCLOUD_TOKEN
```

```bash
sitesolide machine create --provider hetzner --name web
```

It uploads your public key, creates a firewall that opens 22, 80, 443 and ICMP,
orders a `cx23` (2 vCPU, 4 GB) running Debian 13, and waits until SSH answers,
under a minute. `--type`, `--location` and `--backups` change the defaults;
`sitesolide machine list` and `sitesolide machine destroy` do the rest. Any
other cloud is `--provider digitalocean`, `aws`, `gcp`, `azure`, `vultr`,
`linode` or `scaleway`. See [machine.md](machine.md).

Anywhere else, create a Debian 13 VM with your key for `root`, and go on.

## 3. Install it

```bash
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
```

```bash
sitesolide setup root@203.0.113.10 --zone example.com --email you@example.com
```

`--email` is the address the certificate authority warns about expiry;
`--contact`, optional, is shown to a visitor who lands on a locked preview.

Setup hardens the machine (a `deploy` account with sudo, ssh by key only and
closed to root, ufw, fail2ban, automatic security updates), creates the
zone's DNS records, an A for `<zone>` and `*.<zone>`, and an AAAA for each when
the machine has an IPv6, installs Caddy with its DNS module and Bun, then deploys every
service of the platform in the order a fresh machine accepts: the shared API,
the dashboard and the root daemon behind it, the portal, the rule that isolates
services on the loopback, the monitor, backups, the installer that deploys
with a token, and the egress proxy. It writes `~/.config/sitesolide/config.json`, which every other
command reads.

It shows two passwords, once each: the dashboard's, and the portal's, the
owner's password at the sign-in of restricted sites. Store
them in a password manager before the terminal scrolls them away; both are
changed from the dashboard afterwards.

It can be run again at any time. On a machine already installed it reads
everything and changes nothing; after a failure it resumes at the step that
failed. Every step, what it checks and what it changes, is in
[setup.md](setup.md).

The dashboard is then at `https://dashboard.example.com`.

## 4. Deploy something of your own

```bash
cd your-project && sitesolide deploy
```

A folder without `sitesolide.json` gets one inferred from what it holds:
`sitesolide detect` shows it, `sitesolide deploy --yes` writes it and deploys.
The repository's `examples/static-site`, `examples/bun-app` and
`examples/background` deploy as they are. Each answers at
`https://<slug>.example.com`.

To put it on its own domain, add it to the manifest, point its DNS at the
machine (behind a Cloudflare Tunnel, a proxied CNAME to the tunnel instead,
see [tunnel.md](tunnel.md#a-sites-own-domain)), and:

```bash
sitesolide domain --activate
```

That writes `domain.active`, puts the manifest on the machine and rebuilds the
domain table, the last step being the one that authorises the certificate and
serves the domain. `sitesolide domain --deactivate` takes it back out: the
domain stops answering at once, an app's once its block is this release's,
and its certificate is left to expire, never renewed. An app deployed before
keeps answering on its certificate until it is deployed again, which the
command says.

## 5. Know when something breaks

One machine serves everything, so its failures are everyone's. The monitor
setup installed checks every minute that Caddy runs, that every site
answers over HTTPS, that no service failed, and that disk, memory,
certificates and backups are fine. Out of the box it only writes to the
journal. Give it a heartbeat, a free [healthchecks.io](https://healthchecks.io)
check that alerts when the pings stop, which is the only thing that notices the
machine itself dying, and optionally a Slack, Discord or ntfy webhook: five
minutes, described in [monitor/README.md](../monitor/README.md#alerting-healthchecksio-in-five-minutes).
What the monitor finds down also shows among the dashboard's Issues.

## 6. Let others in, without SSH

Colleagues and agents deploy with a personal token instead of root SSH: create
one on the dashboard's *Tokens* page, and send its holder to [access.md](access.md),
"People and tokens". Setup installed what it needs, unless it ran with
`--minimal`. Once signing in with a company account is set up
([portal/README.md](../portal/README.md#signing-in-with-a-company-account)), give
colleagues a role on a project instead, from its *Access* section in the
dashboard or with `sitesolide share <email> --role developer` in its folder:
they sign in to the dashboard and mint their own tokens, never stronger than
their roles.

## Another DNS provider

`--dns` names it: setup creates the records through its API, adds its module
to Caddy and lays its credentials for the wildcard's renewals. Every provider
sitesolide speaks, and what its credentials need, is in [dns/](dns/); the
wizard reads the zone's name servers and offers the one that serves it.

```bash
sitesolide setup root@203.0.113.10 --zone example.com --email you@example.com --dns route53
```

## Any registrar, no API

`--dns manual`: setup lists the two records to create, `<zone>` and
`*.<zone>`, and waits for them; each project then gets its own certificate at
its first visit, through HTTP-01 or TLS-ALPN-01, for the names of the sites
deployed and those alone. It costs a second or two on a project's first visit,
an issuance per name, and each project's name in public Certificate
Transparency logs. See [setup.md](setup.md#dns).

## Installing by hand

What setup runs, from a checkout, for whoever wants every step in front of
them. The hardening setup does first is described in [setup.md](setup.md);
on another machine, do its equivalent by hand. These run once, in this order,
each one idempotent: the order is the one a fresh machine accepts, every step
leaning on the one before it. `sitesolide
init --server deploy@203.0.113.10 --zone example.com --email you@example.com`
first, so that the scripts know the machine.

```bash
# Caddy from its own repository, then the Cloudflare DNS module the wildcard
# certificate needs, which the standard build lacks
ssh you@203.0.113.10 'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list && sudo apt-get update && sudo apt-get install -y caddy && sudo caddy add-package github.com/caddy-dns/cloudflare'

# Bun, at /usr/local/bin/bun, where every unit looks for it. Its installer
# needs unzip, which a bare Debian image lacks
ssh you@203.0.113.10 'sudo apt-get install -y unzip && curl -fsSL https://bun.com/install | sudo BUN_INSTALL=/usr/local bash'

# The Cloudflare token Caddy reads for its certificates
ssh you@203.0.113.10 'sudo install -m 0640 -o root -g caddy /dev/stdin /etc/caddy/cloudflare.env' <<< 'CLOUDFLARE_API_TOKEN=your-token'
```

`caddy add-package` replaces the package's binary, and an upgrade of the
package puts the standard one back: run it again after every `apt upgrade`
that touches Caddy, or the next reload refuses the configuration for want of
the DNS module.

Then Caddy's configuration, in three moves:

```bash
# Lays the zone file and an empty domain table, then stops: Caddy's unit does
# not load the zone variables yet
bin/deploy-caddy.sh

# The drop-in that loads them, and restarts Caddy whatever the way it stopped
ssh you@203.0.113.10 'sudo mkdir -p /etc/systemd/system/caddy.service.d && sudo install -m 644 /dev/stdin /etc/systemd/system/caddy.service.d/override.conf && sudo systemctl daemon-reload && sudo systemctl restart caddy' < infra/caddy/caddy.service.d/override.conf

# The Caddyfile itself; the first certificates take about a minute
bin/deploy-caddy.sh
```

That stop is not decorative: the Caddyfile reads `$SITESOLIDE_ZONE`, and
reloading Caddy without it would serve empty addresses on every site at once.
On a first install the script waits up to two minutes per address for the
authority to issue the certificates; on a machine already serving it does not
wait, since a silent address there is an outage. The drop-in also sets
`Restart=always`, see
[infra/README.md](../infra/README.md#caddys-restart-policy).

Then the two services that need nothing else:

```bash
bin/deploy-api.sh        # on-demand TLS and preview locks, and its account
bin/deploy-gatekeeper.sh # the only thing that touches Caddy from the machine
```

### The dashboard and the portal

The dashboard first, with its password: it is the one secret the dashboard
cannot create for itself, since it is what opens it. The steward and the
collector come right after, because both need the dashboard's account and
code to exist.

```bash
bin/dashboard-password.sh    # shows the password once, puts its hash on the machine
cd dashboard && sitesolide deploy
bin/deploy-steward.sh        # the root daemon that writes secrets
bin/deploy-collector.sh      # the timer that snapshots the machine for the dashboard
```

The dashboard is then at `https://dashboard.your-zone.tld`. Every other secret
is created there. The portal's comes next:

```bash
cd portal && sitesolide deploy
```

It stops on `portal.env`, missing on the machine, and says where to create it:
in the dashboard, *Secrets*, the portal's `portal.env`, then *Change password*,
which shows the portal's password once. Run the deploy again.

Last, the rule that isolates the services from one another, and the monitor.
The rule checks that the dashboard reaches the portal, so it comes once both
are deployed:

```bash
bin/deploy-loopback.sh close   # the nftables rule that isolates the services
bin/deploy-monitor.sh          # the timer that checks every site each minute, and alerts
```

Then the optional components, in this order: the steward runs again after
each one that lays something it reads.

```bash
bin/deploy-backup.sh install && bin/deploy-steward.sh && bin/deploy-backup.sh enable
bin/deploy-installer.sh        # deploys with a token
bin/deploy-egress.sh && bin/deploy-steward.sh
```

## Troubleshooting

**"Host key verification failed" on a machine you just created.** The provider
gave it the address of a machine you used before, and ssh remembers the old
one's key: `ssh-keygen -R 203.0.113.10`, then run the same command again. On a
machine you did not just create, stop instead: something else answers there.

**ssh suddenly answers "connection refused".** fail2ban banned your address
after failed logins, for ten minutes by default: wait, or from the provider's
console run `fail2ban-client status sshd` and `fail2ban-client unban <address>`.

**`caddy validate` refuses a configuration that looks fine.** Run by hand it
does not load `/etc/caddy/cloudflare.env` or `/etc/caddy/sitesolide.env`, so the
DNS module sees an empty token and the addresses are empty. That refusal is not
a defect of the file. Use `bin/deploy-caddy.sh`, which loads both the way systemd
does.

**Never `caddy stop` or `caddy start`.** They talk to the admin API on
`127.0.0.1:2019`, that is to say to production, whatever `--config` you pass.
`sudo systemctl reload caddy` applies a configuration without an interruption.

**A project answers 404 under the wildcard.** Its directory exists but nothing
serves it: either `public/` is empty or the service is not running.
`sitesolide status` says which.

**A preview asks for a code you do not have.** The site's *Access* section in
the dashboard shows it, to the owner and the site's Admins; `sitesolide lock`
in the project's folder prints the code in force without changing it.
