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

These run once, in this order. Each one is idempotent.

```bash
# Bun, Caddy and the directory layout
ssh you@203.0.113.10 'curl -fsSL https://bun.com/install | sudo -u root bash'

# The Cloudflare token Caddy reads for its certificates
ssh you@203.0.113.10 'sudo install -m 0640 -o root -g caddy /dev/stdin /etc/caddy/cloudflare.env' <<< 'CLOUDFLARE_API_TOKEN=your-token'

# The zone variables the Caddyfile substitutes
bin/deploy-caddy.sh
```

`deploy-caddy.sh` refuses to run until Caddy's unit loads
`/etc/caddy/sitesolide.env`, and tells you the three commands that fix it. That
guard is not decorative: the Caddyfile reads `$SITESOLIDE_ZONE`, and reloading
Caddy without it would serve empty addresses on every site at once.

Then the services that serve the others:

```bash
bin/deploy-api.sh        # on-demand TLS and preview locks
bin/deploy-loopback.sh close   # the nftables rule that isolates the services
bin/deploy-steward.sh    # the root daemon that writes secrets
bin/deploy-gatekeeper.sh # the only thing that touches Caddy from the machine
bin/deploy-collector.sh  # the timer that snapshots the machine for the dashboard
```

## 4. Deploy the dashboard and the portal

The dashboard first, with its password: it is the one secret the dashboard
cannot create for itself, since it is what opens it.

```bash
bin/dashboard-password.sh    # shows the password once, puts its hash on the machine
cd dashboard && sitesolide deploy
```

The dashboard is then at `https://dashboard.your-zone.tld`. Every other secret
is created there. The portal's comes next:

```bash
cd portal && sitesolide deploy
```

It stops on `portal.env`, missing on the machine, and says where to create it:
in the dashboard, *Secrets*, the portal's `portal.env`, then *Change password*,
which shows the portal's password once. Run the deploy again.

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
