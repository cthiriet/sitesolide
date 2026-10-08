# Setting up a machine in one command

`sitesolide setup` does the whole base install of [install.md](install.md), the
hardening a fresh machine needs included, in one command. It can be run again
at any time: on a machine already installed it reads everything and changes
nothing, and after a failure it starts again at the step that failed.

```bash
export CLOUDFLARE_API_TOKEN=...          # or --cloudflare-token-stdin, or typed when asked
sitesolide setup root@203.0.113.10 --zone example.com --email you@example.com
```

## What you need first

- **A fresh Debian 13 machine**, from any provider, reachable as `root` with
  your SSH key, or as an account with passwordless sudo. Setup refuses another
  system unless `--any-os` says to go on at your own risk.
- **A domain on Cloudflare**, and a token from
  [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
  with `Zone / Zone / Read` and `Zone / DNS / Edit` on that zone. The same token
  creates the records from your workstation and lets Caddy obtain the wildcard
  certificate on the machine.
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
| dns | `x<random>.<zone>` and `<zone>` resolve to the machine | Cloudflare: `<zone>` and `*.<zone>`, A and AAAA, DNS only, TTL auto |
| packages | sudo ufw fail2ban unattended-upgrades rsync git curl unzip installed, `nft` present | apt; fail2ban installed without being started |
| account | the deploy account exists, `sudo -n` works for it, it holds the operator's keys | `useradd`, `/etc/sudoers.d/90-sitesolide-<user>`, its `authorized_keys` |
| firewall | ufw active, incoming denied, the ssh port, 80 and 443 allowed | ufw |
| updates | `apt-config` shows the two `APT::Periodic` settings at 1 | `/etc/apt/apt.conf.d/20auto-upgrades` |
| directories | `/srv/sites`, `/srv/api`, `/srv/data` exist | `mkdir` |
| ssh | `sshd -T` says no root login, no password, no keyboard-interactive | `/etc/ssh/sshd_config.d/00-sitesolide.conf`, `systemctl reload ssh` |
| fail2ban | enabled and active | `systemctl enable fail2ban`, a restart, your address spared for the run |
| caddy | the package installed and `dns.providers.cloudflare` listed | Caddy's apt repository, `caddy add-package` |
| bun | `/usr/local/bin/bun` exists | Bun's installer |
| cloudflare-token | `/etc/caddy/cloudflare.env` root:caddy 0640, holding the token given | that file |
| resolution | this workstation resolves the zone and its wildcard to the machine | nothing: it waits, ten minutes at most |
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

## The token and the passwords

The Cloudflare token comes from `CLOUDFLARE_API_TOKEN`, from standard input
with `--cloudflare-token-stdin`, or from a prompt that does not echo; there is
no option that takes it as an argument. It is asked for only when a step needs
it: once the records resolve and the file is on the machine, a later run needs
none. It reaches Cloudflare in a header and the machine inside a script on
ssh's standard input; it is never printed, and the scripts setup launches do
not inherit it. Given on a later run and different from the one on the
machine, it replaces it, and Caddy reads it at its next start.

The dashboard's password is drawn by `bin/dashboard-password.sh` and shown once
on standard error. The portal's, the owner's password at the sign-in of
restricted sites, is drawn on your workstation, its argon2id hash written to
the machine, and the password shown once at the end of the run, on standard
error, even when the run fails afterwards. Neither is ever drawn again
by a later run, and neither appears in a `--json` event: both are changed from
the dashboard.

## Another DNS provider

`--skip-dns` leaves Cloudflare's API alone: setup prints the records to create,
`<zone>` and `*.<zone>`, A and AAAA, DNS only, and waits for them, thirty
minutes at most, before Caddy. Caddy still needs a DNS module for the wildcard
certificate, which [install.md](install.md#another-host-another-dns) describes:
replace `cloudflare` in the Caddyfile's `(tls-zone)` snippet with your
provider's module, add it with `caddy add-package`, and lay
`/etc/caddy/cloudflare.env`, root:caddy 0640, with the variables that module
reads before running setup. With that file in place and no token given, setup
leaves it as it is.

## After setup

```bash
cd your-project && sitesolide deploy
```

Then give the monitor a heartbeat, five minutes:
[monitor/README.md](../monitor/README.md#alerting-healthchecksio-in-five-minutes).
Setup does not run a full `apt upgrade`: unattended-upgrades applies the
security updates every day.
