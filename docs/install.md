# Installing sitesolide

From a blank account to a first deployed project. Budget half an hour, most of
it waiting for DNS.

**The tested path is Hetzner Cloud plus Cloudflare.** That is what the Terraform
in `infra/` creates and what the author runs in production. Neither is
load-bearing: [Another host, another DNS](#another-host-another-dns) at the end
says exactly what to change.

## What you need first

- **A domain.** Every project gets a subdomain of it, and the machine serves the
  bare domain too.
- **Its DNS on a provider Caddy can solve DNS-01 against.** The wildcard
  certificate that covers `*.your-zone.tld` cannot be issued any other way.
  Cloudflare is what this guide uses; Caddy has modules for around thirty
  others.
- **Bun** on your workstation: `curl -fsSL https://bun.com/install | bash`.
- **Terraform**, if you want the machine created for you rather than by hand.

## 1. Create the machine

```bash
mkdir -p ~/.config/sitesolide/terraform
cp infra/terraform.tfvars.example ~/.config/sitesolide/terraform/terraform.tfvars
```

Fill it in: the Hetzner API token, the Cloudflare token, your domain, the name
of your SSH key as it appears in the Hetzner console, and the non-root account
to create. It lives outside the repository, beside the CLI's configuration, and
so does Terraform's state: nothing private sits in the tree you cloned.

The two Cloudflare tokens are created at
[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
with **Create Custom Token**, both restricted to the single zone:

| Token | Used by | Lives in |
|---|---|---|
| Terraform | the DNS records in `dns.tf` | `~/.config/sitesolide/terraform/terraform.tfvars`, on your workstation |
| Caddy | the DNS-01 challenge for the wildcard | `/etc/caddy/cloudflare.env`, on the machine |

Both need `Zone / DNS / Edit` and `Zone / Zone / Read`. Keeping them separate
means you can revoke the one that lives on the exposed machine without touching
your own.

```bash
bin/terraform.sh init
bin/terraform.sh plan      # always read the plan
bin/terraform.sh apply
```

This creates the VM, a firewall that opens 22, 80, 443 and ICMP, and the DNS
records. cloud-init sets up the non-root account, key-only SSH, ufw, fail2ban
and automatic security updates.

Check that the zone resolves to the new machine before going on:

```bash
dig +short your-zone.tld
dig +short anything.your-zone.tld
```

Both must answer with the IPv4 that `terraform output` printed.

## 2. Point the CLI at it

```bash
cd ..
ln -sf "$PWD/bin/sitesolide.ts" ~/.local/bin/sitesolide
sitesolide init \
  --server you@203.0.113.10 \
  --zone your-zone.tld \
  --email you@your-zone.tld \
  --contact you@your-zone.tld
```

This writes `~/.config/sitesolide/config.json`. Nothing in the repository knows
your machine; everything reads that file.

| Setting | What it is |
|---|---|
| `server` | `user@host`, as ssh takes it. The user owns the files the machine serves. |
| `zone` | The DNS zone. Each project gets `<slug>.<zone>`. |
| `email` | The address the certificate authority warns about expiry. |
| `contact` | Optional. Shown to a visitor who lands on a locked preview. |
| `vault` | Optional. What your workstation itself presents to production, read by `sitesolide run`. Defaults to `~/.config/sitesolide/secrets/`. See [secrets.md](secrets.md). |
| `sites` | Optional. A repository holding several of your projects, for the checks that read them all. |

Nothing else is kept on the workstation. Each project's systemd unit and Caddy
block are generated from its manifest when it deploys, and its secrets live on
the machine.

## 3. Install the base system

These run once, in this order. Each one is idempotent. The order is the one a
fresh machine accepts: every step leans on the one before it.

```bash
# Caddy from its own repository, then the Cloudflare DNS module the wildcard
# certificate needs, which the standard build lacks
ssh you@203.0.113.10 'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | sudo tee /etc/apt/sources.list.d/caddy-stable.list && sudo apt-get update && sudo apt-get install -y caddy && sudo caddy add-package github.com/caddy-dns/cloudflare'

# Bun, at /usr/local/bin/bun, where every unit looks for it. Its installer
# needs unzip, which cloud-init installs and a bare Debian image lacks
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

## 4. Deploy the dashboard and the portal

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

## 5. Deploy something of your own

```bash
cd examples/static-site
sitesolide deploy
```

It answers at `https://static-site.your-zone.tld`. `examples/bun-app` does the
same for an app with a port, a service and a secret.

To put it on its own domain, add it to the manifest, point its DNS at the
machine, and:

```bash
sitesolide domain --activate
```

That writes `domain.active`, puts the manifest on the machine and rebuilds the
domain table, the last step being the one that authorises the certificate.

## 6. Know when something breaks

One machine serves everything, so its failures are everyone's. The monitor
installed in step 3 checks every minute that Caddy runs, that every site
answers over HTTPS, that no service failed, and that disk, memory,
certificates and backups are fine. Out of the box it only writes to the
journal. Give it a heartbeat, a free [healthchecks.io](https://healthchecks.io)
check that alerts when the pings stop, which is the only thing that notices the
machine itself dying, and optionally a Slack, Discord or ntfy webhook: five
minutes, described in [monitor/README.md](../monitor/README.md#alerting-healthchecksio-in-five-minutes).
What the monitor finds down also shows among the dashboard's Issues.

## 7. Let others deploy, without SSH

Colleagues and agents deploy with a personal token instead of root SSH. Install
the control API once (the order and the checks are in
[dashboard/README.md](../dashboard/README.md), "The control API"):

```bash
cd dashboard && sitesolide deploy   # the API and the Team page
bin/deploy-steward.sh               # the token registry
bin/deploy-installer.sh             # what installs a project for a token
```

Then create a token on the dashboard's *Team* page, and send its holder to
[team.md](team.md), "Deploying as a team member".

## Another host, another DNS

**Another VPS.** Ignore `infra/*.tf` entirely. Create a Debian 13 machine any
way you like, then follow `infra/cloud-init.yaml` by hand: it is a short file,
and everything in it is standard. The rest of the install is unchanged; the CLI
only ever speaks ssh.

**Another DNS provider.** Two places name Cloudflare:

- `infra/caddy/Caddyfile`, in the `(tls-zone)` snippet:
  `dns cloudflare {env.CLOUDFLARE_API_TOKEN}`. Replace `cloudflare` with your
  provider's Caddy module and the variable with whatever it wants.
- `infra/dns.tf`, which creates the records. Drop it and create them by hand, or
  rewrite it for your provider.

Caddy's DNS modules are not in the standard binary: build one with
[xcaddy](https://github.com/caddyserver/xcaddy), or take a build that includes
your provider.

**No wildcard at all.** Possible but poorer: each project then gets its own
certificate over HTTP-01, which works, costs an issuance per subdomain, and
makes previews visible in certificate transparency logs. Remove the
`import tls-zone` lines and let Caddy do its default thing.

## Troubleshooting

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

**A preview asks for a code you do not have.** `sitesolide lock --status` prints
the code in force without changing it.
