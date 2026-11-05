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
   servers and offers Cloudflare's API first when they are Cloudflare's,
   records made by hand first otherwise. With Cloudflare, the token, scoped
   to the zone, is checked against the zone before anything is ordered (a
   write permission is only tried when setup writes the records); address
   and CNAME records already there for `<zone>` and `*.<zone>` that are not
   the machine's are listed, and replaced only on a yes (`--dns-replace`).
   Mail and text records are never touched. See [DNS](#dns).
6. **The plan**, with its price, confirmed once. Nothing is ordered, nothing is
   changed before this yes.

It then runs `sitesolide machine create`, then setup with the steps below, and
ends by printing both commands, so that the same install can be run again
without a question. A token typed at the wizard stays in memory and is never
written on the workstation: a cloud's reaches that cloud alone, and
Cloudflare's reaches Cloudflare, then the machine, where Caddy needs it, as
with every setup (see [the DNS credentials and the passwords](#the-dns-credentials-and-the-passwords)).

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
- **A domain, at any registrar.** Where Cloudflare serves its DNS, setup
  creates the records through its API and Caddy obtains one wildcard
  certificate, with a token from
  [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
  holding `Zone / Zone / Read` and `Zone / DNS / Edit` on that zone alone.
  Anywhere else, `--dns manual`: you create two records by hand. See
  [DNS](#dns).
- **Your SSH key loaded** in the agent: setup never prompts, and accepts the
  machine's host key on first contact only.

A machine with no public address, at home behind a NAT or in a VM on a
machine that serves something else, is installed through a Cloudflare
Tunnel: `--tunnel`, see [tunnel.md](tunnel.md).

## The steps

Each step is a check that only reads, and a run that does what the check found
missing. The output is a checklist: `[done]` already there, `[ok]` done now,
`[skip]` left out, `[fail]` the step that stopped the run.

| Step | Done when | What it changes on the machine |
|---|---|---|
| preflight | always read | nothing: system, architecture, free disk, sudo, addresses, ssh port |
| configuration | `config.json` names this server and zone | your workstation: `~/.config/sitesolide/config.json`, and `setup.json` beside it |
| dns | `x<random>.<zone>` and `<zone>` resolve to the machine | Cloudflare, through its API: `<zone>` and `*.<zone>`, an A each, an AAAA each when the machine has an IPv6; skipped under `--dns manual` and `--skip-dns`, which list them for you to create |
| packages | sudo ufw fail2ban unattended-upgrades rsync git curl unzip installed, `nft` present | apt; fail2ban installed without being started |
| account | the deploy account exists, `sudo -n` works for it, it holds the operator's keys | `useradd`, `/etc/sudoers.d/90-sitesolide-<user>`, its `authorized_keys` |
| firewall | ufw active, incoming denied, the ssh port, 80 and 443 allowed | ufw |
| updates | `apt-config` shows the two `APT::Periodic` settings at 1 | `/etc/apt/apt.conf.d/20auto-upgrades` |
| directories | `/srv/sites`, `/srv/api`, `/srv/data` exist | `mkdir` |
| ssh | `sshd -T` says no root login, no password, no keyboard-interactive | `/etc/ssh/sshd_config.d/00-sitesolide.conf`, `systemctl reload ssh` |
| fail2ban | enabled and active | `systemctl enable fail2ban`, a restart, your address spared for the run |
| caddy | the package installed and Cloudflare's module listed, `dns.providers.cloudflare`; none under `--dns manual` | Caddy's apt repository, `caddy add-package`, or a build on the machine when Caddy's build service does not deliver within five minutes |
| bun | `/usr/local/bin/bun` exists | Bun's installer |
| dns-credentials | `/etc/caddy/cloudflare.env` root:caddy 0640, holding the token given, and a running Caddy started after it was written | that file, once the token is proven against the zone, any other DNS credential it held kept; a restart of Caddy when the token changes on a running machine, since Caddy reads it at its start, unless the next step restarts it |
| tls-zone | `/etc/caddy/tls-zone.caddy` root:root 0644, the zone's `tls` block: Cloudflare's DNS challenge, or `on_demand` | that file; `/etc/caddy/zone-names` under `--dns manual`; a restart of Caddy when it changes on a running machine; refused on a Caddyfile from before this file, which `sitesolide upgrade` brings first |
| dns-leftovers | `/etc/caddy/cloudflare.env` holds no credential the policy in place does not read | the others taken out, Cloudflare's token under `--dns manual`, a removed provider's under either, once the new policy is in service: a switch keeps them until then |
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
| loopback | the `sitesolide_boucle` table loaded, its unit enabled; behind a tunnel, its line for the connector's account | `bin/deploy-loopback.sh close` |
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

Cloudflare's token comes from `CLOUDFLARE_API_TOKEN`, from standard input
with `--cloudflare-token-stdin` (the token alone, or a
`CLOUDFLARE_API_TOKEN=` line), or from a prompt that does not echo; there is
no option that takes it as an argument. It is asked for only when a step
needs it: once the records resolve and the file is on the machine, a later
run needs none. It reaches Cloudflare in a header, and the machine inside a
script on ssh's standard input, where Caddy keeps it in
`/etc/caddy/cloudflare.env`, root:caddy 0640, to renew the wildcard. It is
never printed, and the scripts setup launches do not inherit it. Given on a
later run and different from the one on the machine, it replaces it, and
Caddy reads it at its next start. See [dns/cloudflare.md](dns/cloudflare.md).

**Make it for the zone alone.** It stays on the machine for as long as it
serves the zone: a token that can also change other zones, or the whole
account, would be one break-in away from all of it. `CLOUDFLARE_API_TOKEN` is
wrangler's variable too, and often holds such a token: the wizard says so
when it finds one there, and setup lays whatever it holds.

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
| `manual` | by you, at any registrar | one per name, on demand | below |

Both have served real machines, switches between the two included. A zone
whose DNS is at another provider, a cloud's own or a registrar's, takes
`manual`, or moves its DNS to Cloudflare first. Ten other providers were
offered for a while, without ever serving a real zone, and were removed: a
machine set up with one goes on serving as it is, and setup refuses to run on
it again until told which of the two it moves to, see
[upgrading.md](upgrading.md#every-dns-provider-but-cloudflare-removed).

With Cloudflare, setup adds its module to Caddy (`caddy add-package`), lays
the token in `/etc/caddy/cloudflare.env`, and writes
`/etc/caddy/tls-zone.caddy`, the `tls` block every block of the zone imports,
naming the module and reading the token from Caddy's environment.

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

`--skip-dns` keeps Cloudflare for the certificates and leaves the records to
you: setup lists them and waits, as under `manual`.

## A test installation: `--acme staging`

Let's Encrypt limits what one domain obtains: fifty new certificates a week,
five a week for the same names. A machine set up, destroyed and set up again
for tests reaches that quickly, and then serves its sites without a
certificate. `--acme staging` asks Let's Encrypt's staging environment
instead, whose limits a test does not reach: `/etc/caddy/tls-zone.caddy` then
names its directory, `ca https://acme-staging-v02.api.letsencrypt.org/directory`,
and says it is a test installation.

Its certificates are real ones that no browser and no system trusts. The
probes setup, `deploy` and the scripts make over HTTPS accept them unverified
on such an installation, since they carry nothing secret and read a status
alone; the CLI's calls to the dashboard's API, which carry a token, do not,
and the monitor reports the sites' certificates as failing. Never use it for
sites people visit.

Setup records it in `config.json` (`"acme": "staging"`) and keeps it on later
runs; `--acme production` brings the installation back to Let's Encrypt.

## After setup

```bash
cd your-project && sitesolide deploy
```

Then give the monitor a heartbeat, five minutes:
[monitor/README.md](../monitor/README.md#alerting-healthchecksio-in-five-minutes).
Setup does not run a full `apt upgrade`: unattended-upgrades applies the
security updates every day. Nothing reboots the machine for a new kernel:
see [updates and reboots](concepts.md#updates-and-reboots) for what to do.
