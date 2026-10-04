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

## Caddy's restart policy

The unit the Caddy package ships (`caddyserver/dist`, `init/caddy.service`)
sets **no `Restart=` at all**, and systemd's default is `no`. That is why the
outage of 11 August 2026 lasted 23 minutes: `caddy stop` asked the admin API to
quit, Caddy exited cleanly with `Result=success`, and nothing was configured to
start it again. It was not the clean exit that kept `Restart=always` from
firing; there was no `Restart=always`.

`caddy.service.d/override.conf` now sets it:

| Directive | Why |
|---|---|
| `Restart=always` | restarted however it ended, exit 0 included; only a stop asked of systemd (`systemctl stop`, a restart, a shutdown) prevents it |
| `RestartSec=2s` | a blip, not an outage |
| `RestartSteps=4`, `RestartMaxDelaySec=30s` | a Caddy that cannot start is retried after 2, 4, 8, 15 then every 30 seconds, not every 2 seconds for ever (systemd 254 and later; older ones ignore both and keep 2 s) |
| `StartLimitIntervalSec=0`, in `[Unit]` | never give up: the causes of a Caddy that will not start are mostly transient, and the monitor alerts all the same |

The reasoning, including the choice of never giving up over a start limit that
would leave the unit failed, is in the drop-in's comment. Applying it takes a
`sudo systemctl daemon-reload` and **no restart**: PID 1 consults the policy
when the process ends. The steps are in
[monitor/README.md](../monitor/README.md#deployment).

It is not a licence to use `caddy stop` or `caddy start`. A restart is still a
blip on every site, the restart counter that drives the steps only resets on a
start or restart asked of systemd, and the admin API can do worse than stop
Caddy: load a configuration that serves nothing while the process stays alive,
which no restart policy sees and only the monitor's HTTPS probes do.

### The proof, on a test VM

Never on the machine that serves the sites. On a Debian 13 test VM with the
`caddy` package installed:

```bash
# 1. The package's unit alone: the outage of 11 August, reproduced.
systemctl cat caddy | grep -i '^Restart' || echo "no Restart= in the package's unit"
sudo curl -s -X POST http://127.0.0.1:2019/stop      # what `caddy stop` sends
sleep 5
systemctl show caddy -p NRestarts -p ActiveState -p Result
# expected: NRestarts=0, ActiveState=inactive, Result=success

# 2. The drop-in, then the same stop.
sudo systemctl start caddy
sudo mkdir -p /etc/systemd/system/caddy.service.d
sudo install -m 644 override.conf /etc/systemd/system/caddy.service.d/override.conf
sudo systemctl daemon-reload
systemctl show caddy -p Restart -p RestartUSec -p StartLimitIntervalUSec -p MainPID
sudo curl -s -X POST http://127.0.0.1:2019/stop
sleep 5
systemctl show caddy -p NRestarts -p ActiveState -p Result -p MainPID
# expected: NRestarts=1, ActiveState=active, Result=success, a new MainPID

# 3. A stop asked of systemd is respected.
sudo systemctl stop caddy
sleep 5
systemctl show caddy -p NRestarts -p ActiveState
# expected: ActiveState=inactive, NRestarts unchanged
sudo systemctl start caddy   # and NRestarts back to 0: a manual start resets it

# 4. The steps: four automatic restarts in a row, and the next one waits 30 s.
for i in 1 2 3 4; do sudo curl -s -X POST http://127.0.0.1:2019/stop; sleep 20; done
systemctl show caddy -p NRestarts -p RestartUSecNext -p ActiveState
# expected: NRestarts=4, RestartUSecNext=30s, ActiveState=active
journalctl -u caddy --since "-2min" | grep -i "scheduled restart job"
sudo systemctl restart caddy
systemctl show caddy -p NRestarts -p RestartUSecNext
# expected: NRestarts=0, RestartUSecNext=2s: a restart asked of systemd resets the steps
```

For the test VM only: the drop-in names `/etc/caddy/cloudflare.env` and
`/etc/caddy/sitesolide.env` without a dash, so both must exist there, empty or
with test values, or Caddy will not start under it at all.

## The monitor

`monitor/` checks the machine every minute and alerts on what goes down and
recovers, with a heartbeat that notices the machine itself dying: see
[monitor/README.md](../monitor/README.md). Its unit and timer are in
`infra/monitor/`, `sitesolide-monitor.service` and `.timer`, placed by
`bin/deploy-monitor.sh`. It runs as `sitesolide-monitor`, a system account
of its own that the script makes, with no privilege, and keeps its state in
`/var/lib/sitesolide-monitor/`, that account's; nothing runs until that script
has. Not as a dynamic account: dbus-daemon cannot resolve one, and `systemctl`
then reads no unit.

## Hardening to do once it works

- Restrict `ssh_allowed_from` to a fixed IP rather than the whole world
- Set `PermitRootLogin` to `no` once you have checked you can reach the non-root
  account
