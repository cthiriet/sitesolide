# infra

Terraform for the machine that serves the bare domain and every project. The
architecture it carries is described in [docs/concepts.md](../docs/concepts.md).

## What this creates

| Resource | Detail |
|---|---|
| `hcloud_server.web` | CX33 (4 vCPU, 8 GB, 80 GB), Debian 13, Falkenstein, backups on |
| `hcloud_firewall.web` | 22, 80, 443 and ICMP inbound |
| `cloudflare_record.*` | the A, AAAA, wildcard and mail records for the zone |
| cloud-init | non-root account with sudo, key-only SSH, ufw, fail2ban, automatic security updates |

Nothing here is load-bearing for the rest of the project. The CLI only ever
speaks ssh: another host, or a machine set up by hand from `cloud-init.yaml`,
works the same. See [docs/install.md](../docs/install.md).

## Use

```bash
mkdir -p ~/.config/sitesolide/terraform
cp infra/terraform.tfvars.example ~/.config/sitesolide/terraform/terraform.tfvars   # then fill it in
bin/terraform.sh init
bin/terraform.sh plan     # always read the plan before applying
bin/terraform.sh apply
```

`bin/terraform.sh` runs Terraform on this directory with your values and your
state kept in `~/.config/sitesolide/terraform/`, outside the repository: the
values name your zone and hold your tokens, the state carries your machine's
address, and none of it belongs in a tree anyone may read. Any other Terraform
command goes through it the same way, `bin/terraform.sh output` for instance.

The outputs give the IPv4, the IPv6 and the DNS records. Those are not created
by hand: `dns.tf` puts them in the Cloudflare zone itself, each tagged
`Managed by Terraform`. The output is there to read them back and check what is in
place:

```bash
bin/terraform.sh output dns_records
```

## Variables with no default

Three of them, because a default would name someone else's installation, and
two optional ones for mail:

| Variable | What it is |
|---|---|
| `zone` | The zone served. Every project gets a subdomain of it. |
| `spf_include` | Optional. The SPF include of whatever sends mail for the zone. Unset, no SPF record is written. |
| `dmarc_reports_email` | Optional. Where the aggregate DMARC reports go. Unset, no DMARC record is written. |
| `ssh_key_name` | The name of your SSH key as the Hetzner console shows it. |
| `user` | The non-root account. It owns the files the machine serves, and it is the account `sitesolide init` declares in its server. |

## Tokens

The Hetzner token and the Cloudflare token live in
`~/.config/sitesolide/terraform/terraform.tfvars`, outside every repository.
They appear in no file git could ever see.

Two distinct Cloudflare tokens, created at
[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
with **Create Custom Token**:

| Token | Used for | Lives in |
|---|---|---|
| Terraform | the DNS records in this code | `~/.config/sitesolide/terraform/terraform.tfvars`, on your workstation |
| Caddy | the DNS-01 challenge for the wildcard | `/etc/caddy/cloudflare.env`, on the machine |

Same permissions for both, restricted to the single zone (*Zone Resources:
Include, Specific zone*):

- `Zone` / `DNS` / `Edit`
- `Zone` / `Zone` / `Read`, needed to find the zone id from its name

Separating them lets you revoke the one that lives on the exposed machine
without interrupting Terraform, and the other way round.

## The state file

`terraform.tfstate` stays local and is not committed. It is the only memory of
the link between this code and the resources actually created.

Losing it erases nothing at Hetzner, but forces you to reimport the resources by
hand (`terraform import`). It lives in this directory, so in your workstation's
backup. The day a second person touches this infrastructure, a remote backend
(Hetzner Object Storage, S3 protocol) becomes necessary.

## Traps worth knowing

**cloud-init runs once.** Editing `cloud-init.yaml` does not reconfigure an
existing machine. Terraform deliberately ignores its changes
(`lifecycle.ignore_changes`); without that, the smallest edit would destroy and
recreate the server, and every site with it. To change the system configuration
of a running machine, do it there and carry the change back here for the next
rebuild.

**Changing `server_type` reboots the machine.** Scaling up works, but growing
the disk is permanent at Hetzner: there is no way back to a smaller plan.

**`terraform destroy` destroys production.** Once the first projects are served,
add a `lifecycle { prevent_destroy = true }` block on `hcloud_server.web`.

## Hardening to do once it works

- Restrict `ssh_allowed_from` to a fixed IP rather than the whole world
- Set `PermitRootLogin` to `no` once you have checked you can reach the non-root
  account
