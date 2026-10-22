# Setting up a machine in one command

`sitesolide setup` does the whole base install of [install.md](install.md), the
hardening a fresh machine needs included, in one command. Typed alone at a
terminal, it asks its questions instead, and orders the machine from a cloud
too: see [the wizard](#the-wizard). It can be run again
at any time: on a machine already installed it reads everything and changes
nothing, and after a failure it starts again at the step that failed.

```bash
export CLOUDFLARE_API_TOKEN=...          # or --cloudflare-token-stdin, or typed when asked
sitesolide setup root@203.0.113.10 --zone example.com --email you@example.com
```

## The wizard

`sitesolide setup` typed alone, at a terminal, asks its questions rather than
taking options, and orders the machine too:

```console
$ sitesolide setup
┌   sitesolide setup
│
◇  Where should sitesolide run?
│  On a new machine from a cloud provider
│
◇  credentials found for 2 of 8 providers
│
◇  Which cloud?
│  Hetzner
...
◇  The plan ──────────────────────────────────────────────╮
│  cloud      Hetzner, Falkenstein, DE (fsn1)               │
│  size       cx23  2 vCPU, 4 GB RAM, 40 GB disk            │
│  price      3.49 EUR a month before VAT                   │
│  ...                                                      │
```

1. **Where**: a new machine from a cloud, or a Debian 13 machine you already
   reach over SSH.
2. **Which cloud**, every provider of [machine.md](machine.md), each said with
   whether this workstation holds credentials for it, the cursor on the first
   that does. Missing ones are typed, the secret ones at a prompt that does
   not echo, and tried at once with a read: a refused one is asked again.
3. **Where, and which size**: the provider's locations and what it sells
   there, read live, with the monthly price where the provider's API gives
   one; AWS's and Google's do not, and their pages say where to read it.
4. **The machine's name**: one sitesolide did not create is never touched,
   and one it created earlier is picked up rather than ordered again. Then
   the SSH key: one behind a passphrase has to be loaded in the agent, which
   the wizard offers to do with `ssh-add`, since setup never types one. With
   no key in `~/.ssh`, it takes the one the SSH agent holds, a password
   manager's for instance, and asks which when it holds several; with none at
   all, it offers to make one with `ssh-keygen`.
5. **The domain, the email and its DNS**: the wizard reads the zone's name
   servers and offers the provider that serves it first, every other one
   sitesolide speaks, and records made by hand. With a provider, its
   credentials, scoped to the zone, are checked against the zone before
   anything is ordered (a write permission is only tried when setup writes
   the records); address and CNAME records already there for `<zone>` and
   `*.<zone>` that are not the machine's are listed, and replaced only on a
   yes (`--dns-replace`). Mail and text records are never touched. See
   [DNS](#dns).
6. **The plan**, with its price, confirmed once. Nothing is ordered, nothing is
   changed before this yes.

It then runs `sitesolide machine create`, then setup with the steps below, and
ends by printing both commands, so that the same install can be run again
without a question. A token typed at the wizard stays in memory and is never
written on the workstation: a cloud's reaches that cloud alone, and the DNS
credentials reach the DNS provider, then the machine, where Caddy needs them,
as with every setup (see [the DNS credentials and the passwords](#the-dns-credentials-and-the-passwords)).

On a workstation whose configuration already names a machine, which may be
one in service, the wizard first asks, its cursor on *Quit*, whether to set
up a separate installation, in a folder of its own (`--config-dir`), on
another machine and a domain outside the one in service, or to check and
finish the installation in place: that runs setup as a dry run, lists what it
would change, and changes it only on a yes.

## What you need first

- **A fresh Debian 13 machine**, from any provider, reachable as `root` with
  your SSH key, or as an account with passwordless sudo. Setup refuses another
  system unless `--any-os` says to go on at your own risk.
- **A domain, at any registrar.** Where its DNS has a module, see
  [DNS](#dns), setup creates the records through its API and Caddy obtains one
  wildcard certificate, with credentials scoped to the zone that you make
  there; Cloudflare is the default, with a token from
  [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
  holding `Zone / Zone / Read` and `Zone / DNS / Edit` on that zone. Anywhere
  else, `--dns manual`: you create two records by hand.
- **Your SSH key loaded** in the agent: setup never prompts, and accepts the
  machine's host key on first contact only.

## The steps

Each step is a check that only reads, and a run that does what the check found
missing. The output is a checklist: `[done]` already there, `[ok]` done now,
`[skip]` left out, `[fail]` the step that stopped the run.

| Step | Done when | What it changes on the machine |
|---|---|---|
| preflight | always read | nothing: system, architecture, free disk, sudo, addresses, ssh port |
| configuration | `config.json` names this server and zone | your workstation: `~/.config/sitesolide/config.json`, and `setup.json` beside it |
| dns | `x<random>.<zone>` and `<zone>` resolve to the machine | the DNS provider `--dns` names: `<zone>` and `*.<zone>`, an A each, an AAAA each when the machine has an IPv6; skipped under `--dns manual` and `--skip-dns`, which list them for you to create |
| packages | sudo ufw fail2ban unattended-upgrades rsync git curl unzip installed, `nft` present | apt; fail2ban installed without being started |
| account | the deploy account exists, `sudo -n` works for it, it holds the operator's keys | `useradd`, `/etc/sudoers.d/90-sitesolide-<user>`, its `authorized_keys` |
| firewall | ufw active, incoming denied, the ssh port, 80 and 443 allowed | ufw |
| updates | `apt-config` shows the two `APT::Periodic` settings at 1 | `/etc/apt/apt.conf.d/20auto-upgrades` |
| directories | `/srv/sites`, `/srv/api`, `/srv/data` exist | `mkdir` |
| ssh | `sshd -T` says no root login, no password, no keyboard-interactive | `/etc/ssh/sshd_config.d/00-sitesolide.conf`, `systemctl reload ssh` |
| fail2ban | enabled and active | `systemctl enable fail2ban`, a restart, your address spared for the run |
| caddy | the package installed and the DNS provider's module listed, `dns.providers.cloudflare` by default; none under `--dns manual` | Caddy's apt repository, `caddy add-package`, or a build on the machine when Caddy's build service does not deliver within five minutes |
| bun | `/usr/local/bin/bun` exists | Bun's installer |
| dns-credentials | `/etc/caddy/cloudflare.env` root:caddy 0640, holding every variable the provider's module reads, with the values given, and a running Caddy started after it was written | that file, once the credentials are proven against the zone, the previous provider's lines kept; a restart of Caddy when the values change on a running machine, since Caddy reads them at its start, unless the next step restarts it |
| tls-zone | `/etc/caddy/tls-zone.caddy` root:root 0644, the zone's `tls` block: the provider's DNS challenge, or `on_demand` | that file; `/etc/caddy/zone-names` under `--dns manual`; a restart of Caddy when it changes on a running machine; refused on a Caddyfile from before this file, which `sitesolide upgrade` brings first |
| dns-leftovers | `/etc/caddy/cloudflare.env` holds no credential the provider in place does not read | the previous provider's lines taken out, once the new policy is in service: a switch keeps them until then |
| resolution | this workstation resolves the zone and its wildcard to the machine | nothing: it waits, ten minutes at most, thirty when the records are made by hand |
| caddy-zone | `/etc/caddy/sitesolide.env` and `domaines.map` exist | `bin/deploy-caddy.sh`, which stops there on a first install |
| caddy-unit | the drop-in present, `Restart=always`, the zone variables loaded, Caddy active | the drop-in, `daemon-reload`, `systemctl restart caddy` |
| caddy-config | the Caddyfile is sitesolide's, Caddy active | `bin/deploy-caddy.sh` |
| api | `sitesolide-api` active and enabled | `bin/deploy-api.sh` |
| gatekeeper | its code and both unit templates present | `bin/deploy-gatekeeper.sh` |
| dashboard-password | `/etc/sitesolide/dashboard.env` exists | `bin/dashboard-password.sh`, which shows the password once |
| dashboard | `dashboard` active | `sitesolide deploy` in `dashboard/` |
| steward | `sitesolide-steward` active, its code present | `bin/deploy-steward.sh` |
| collector | its timer enabled and active | `bin/deploy-collector.sh` |
| portal-password | `/etc/sitesolide/portal.env` exists | the `site-portal` account, then the file, site-portal 0600 |
| portal | `portal` active | `sitesolide deploy` in `portal/` |
| loopback | the `sitesolide_boucle` table loaded, its unit enabled | `bin/deploy-loopback.sh close` |
| monitor | its timer enabled and active | `bin/deploy-monitor.sh` |
| backups | the backup timer enabled and active | `bin/deploy-backup.sh install`, `bin/deploy-steward.sh`, `bin/deploy-backup.sh enable` |
| installer | its code and unit template present | `bin/deploy-installer.sh` |
| egress | the proxy active, the steward restarted since | `bin/deploy-egress.sh`, `bin/deploy-steward.sh` |

`--minimal` leaves out the last three; running setup again without it adds
them. Caddy is only ever touched through `bin/deploy-caddy.sh` and
`systemctl`, never `caddy stop` nor `caddy start`. A component already active
is never deployed again: bringing the installed components to a newer
release's code is `sitesolide upgrade`'s, with these same checks and scripts,
see [upgrading.md](upgrading.md).

The records are made at the start, so that they propagate while the machine
installs; the scripts that follow probe the sites by name from your
workstation, which is why `resolution` waits for them before Caddy.

## Root, ssh and lockout

Connected as `root`, setup creates the deploy account (`--user`, `deploy` by
default) and does everything that needs root first. Only then does it close
ssh to root and to passwords, in this order: a new login as the deploy
account, running `sudo -n true`, must succeed; the drop-in is written and
checked with `sshd -t`; a timer is armed to withdraw it two minutes later;
sshd is reloaded; a second new login as the deploy account must find the
settings in effect, and only that disarms the timer. If the first login
fails, sshd is not touched. If anything fails after the reload, root login and
passwords come back on their own within two minutes.

Until the account step has made the deploy account, nothing logs in as it:
every check and every run goes through the root session, a `--dry-run` on a
fresh machine included. From the ssh step on, every step runs as the deploy
account, and so does a later run: `setup.json` records that root is closed,
and `sitesolide setup root@...` again goes straight to `deploy`.

## fail2ban, and not banning yourself

fail2ban counts refused logins, and a ban refuses every connection to the ssh
port, the session running the install included. So setup never logs in as an
account that does not exist, its package is installed without being started,
and it is only started in the last hardening step, once ssh is closed. Your
workstation's address, as the machine sees it, is spared while it starts and
until the end of the run, then withdrawn without a reload; nothing already
banned is ever unbanned by setup.

If the machine stops answering ssh during a run, the report says so: a ban
lasts 10 minutes by default. From the provider's console,
`sudo fail2ban-client status sshd` lists the banned addresses, and
`sudo fail2ban-client set sshd unbanip <address>` lifts one. Then run the same
command again.
Connected as a sudoer instead of root, setup checks the same things and does
what is missing through `sudo -n`, that account being the deploy account
unless `--user` names another.

## Resuming

Run the same command again. The report of a failure names the step, the end
of what it printed, and the command that shows more, such as
`ssh deploy@203.0.113.10 'sudo journalctl -u sitesolide-api -n 50'`. Nothing
is kept on the workstation about how far a run went: the checks read it on the
machine every time.

## What setup refuses

Before anything leaves your workstation it reads the configuration in place.
One that names **another server, another zone or another account** stops it:
that file may point at a machine in service, and setup touches neither. A
second installation gets its own folder:

```bash
sitesolide setup root@203.0.113.20 --zone test.example.com --email you@example.com --config-dir ~/.config/sitesolide-test
SITESOLIDE_CONFIG_DIR=~/.config/sitesolide-test sitesolide deploy
```

Every command reads `SITESOLIDE_CONFIG_DIR`, the scripts of `bin/` included.

A configuration that names **this very machine** without setup's own record of
installing it, `setup.json`, means it was installed another way: setup only
reads it, reports when every step is done, and refuses otherwise. On the
machine itself, a zone file naming another zone stops it too.

DNS records that **point elsewhere**, a CNAME where an address should be, an
AAAA when the machine has no IPv6, or a record proxied through Cloudflare are
listed and refused, and nothing is written. `--dns-replace` replaces them: the
owner's decision, never a default.

## The DNS credentials and the passwords

The DNS provider's credentials come from its variables, `CLOUDFLARE_API_TOKEN`
for Cloudflare and `SITESOLIDE_DNS_<...>` for the others (each page of
[dns/](dns/) names them), from standard input with `--dns-credentials-stdin`
(`VARIABLE=value` lines, or the token alone where one value is enough;
`--cloudflare-token-stdin` for Cloudflare's), or from a prompt that does not
echo; there is no option that takes them as an argument. They are asked for
only when a step needs them: once the records resolve and the file is on the
machine, a later run needs none. They reach the provider in a header or a
signature, and the machine inside a script on ssh's standard input, where
Caddy keeps them in `/etc/caddy/cloudflare.env`, root:caddy 0640, to renew the
wildcard: the file keeps that name whatever the provider, the one machines in
service load. They are never printed, and the scripts setup launches do not
inherit them. Given on a later run and different from those on the machine,
they replace them, and Caddy reads them at its next start.

**Make them for the zone alone.** They stay on the machine for as long as it
serves the zone: a token that can also order machines or change other zones
would be one break-in away from all of it. That is why setup never reads the
variables a cloud's own tools read, `DIGITALOCEAN_TOKEN` or `AWS_ACCESS_KEY_ID`,
for the DNS: a broad token in your environment is never laid on a machine by
accident.

The dashboard's password is drawn by `bin/dashboard-password.sh` and shown once
on standard error. The portal's, the owner's password at the sign-in of
restricted sites, is drawn on your workstation, its argon2id hash written to
the machine, and the password shown once at the end of the run, on standard
error, even when the run fails afterwards. Neither is ever drawn again
by a later run, and neither appears in a `--json` event: both are changed from
the dashboard.

## DNS

`--dns` says who serves the zone's DNS, and with it how the zone's
certificates are obtained. Setup records it in `config.json` and reads it
there again when run without the option, so that a later run never switches a
machine to another way unasked.

| `--dns` | Records | Certificates | Its page |
|---|---|---|---|
| `cloudflare`, the default | through the API | one wildcard, DNS-01 | [cloudflare.md](dns/cloudflare.md) |
| `route53` | through the API | one wildcard, DNS-01 | [route53.md](dns/route53.md) |
| `azure-dns` | through the API | one wildcard, DNS-01 | [azure-dns.md](dns/azure-dns.md) |
| `digitalocean-dns` | through the API | one wildcard, DNS-01 | [digitalocean-dns.md](dns/digitalocean-dns.md) |
| `hetzner-dns` | through the API | one wildcard, DNS-01 | [hetzner-dns.md](dns/hetzner-dns.md) |
| `scaleway-dns` | through the API | one wildcard, DNS-01 | [scaleway-dns.md](dns/scaleway-dns.md) |
| `vultr-dns` | through the API | one wildcard, DNS-01 | [vultr-dns.md](dns/vultr-dns.md) |
| `linode-dns` | through the API | one wildcard, DNS-01 | [linode-dns.md](dns/linode-dns.md) |
| `ovh` | through the API | one wildcard, DNS-01 | [ovh.md](dns/ovh.md) |
| `gandi` | through the API | one wildcard, DNS-01 | [gandi.md](dns/gandi.md) |
| `porkbun` | through the API | one wildcard, DNS-01 | [porkbun.md](dns/porkbun.md) |
| `manual` | by you, at any registrar | one per name, on demand | below |

With a provider, setup adds its module to Caddy (`caddy add-package`), lays
its credentials in `/etc/caddy/cloudflare.env`, and writes
`/etc/caddy/tls-zone.caddy`, the `tls` block every block of the zone imports,
naming the module and reading the credentials from Caddy's environment.

`caddy add-package` asks Caddy's build service, at caddyserver.com, for a
build with the module. That service is a single one, sometimes down for hours,
and Caddy waits on it for ever: setup gives it five minutes, then builds Caddy
on the machine instead, at the version the package installed, with Debian's Go
and a pinned xcaddy. Go fetches the toolchain Caddy asks for through its proxy
and checksum database, and everything it fetched is removed afterwards. The
build takes a few minutes and a gigabyte of memory.

**`--dns manual`** works with any registrar and asks no API anything. Setup
prints the records to create, `<zone>` and `*.<zone>`, an A each and an AAAA
each when the machine has an IPv6, and waits for them, thirty minutes at most,
before Caddy. `/etc/caddy/tls-zone.caddy` then says `on_demand`: each name gets
its own certificate at its first visit, through HTTP-01 or TLS-ALPN-01, and the
shared service's `ask` endpoint grants one only to the apex, `www` and the
names of the sites deployed on the machine, so that no visitor can spend the
authority's limits by asking for random names. What it costs: a first visit to
a new project waits a second or two for its certificate, Let's Encrypt allows
about fifty new certificates a week for the domain, and every name it
certifies is published in Certificate Transparency logs, where anyone can read
the names of your projects. See [api/README.md](../api/README.md).

`--skip-dns` keeps the provider for the certificates and leaves the records to
you: setup lists them and waits, as under `manual`.

## After setup

```bash
cd your-project && sitesolide deploy
```

Then give the monitor a heartbeat, five minutes:
[monitor/README.md](../monitor/README.md#alerting-healthchecksio-in-five-minutes).
Setup does not run a full `apt upgrade`: unattended-upgrades applies the
security updates every day. Nothing reboots the machine for a new kernel:
see [updates and reboots](concepts.md#updates-and-reboots) for what to do.
