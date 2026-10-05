# infra

What the machine runs besides the projects: Caddy's configuration and the
drop-in that restarts it, and the systemd units of the services that serve the
others. The architecture they carry is described in
[docs/concepts.md](../docs/concepts.md).

| Folder | What it holds | Placed by |
|---|---|---|
| `caddy/` | the Caddyfile, its snippets, the drop-in `caddy.service.d/override.conf` | `bin/deploy-caddy.sh`, `sitesolide setup` |
| `gatekeeper/` | the units that alone touch Caddy from the machine | `bin/deploy-gatekeeper.sh` |
| `steward/` | the root daemon that writes secrets for the dashboard | `bin/deploy-steward.sh` |
| `collector/` | the timer that snapshots the machine for the dashboard | `bin/deploy-collector.sh` |
| `loopback/` | the nftables rule that isolates services on the loopback | `bin/deploy-loopback.sh` |
| `monitor/` | the monitor's unit and timer | `bin/deploy-monitor.sh` |
| `backup/` | the hourly snapshot of every project's data | `bin/deploy-backup.sh` |
| `installer/` | what installs a project for a team token | `bin/deploy-installer.sh` |
| `egress/` | the proxy that lets a project reach only the hosts it lists | `bin/deploy-egress.sh` |

The machine itself is no longer described here. `sitesolide machine create`
orders one from a cloud provider's API ([docs/machine.md](../docs/machine.md)),
and `sitesolide setup` hardens and installs any Debian 13 machine
([docs/setup.md](../docs/setup.md)). Up to 0.2, Terraform did the first and
cloud-init part of the second; see [docs/upgrading.md](../docs/upgrading.md)
for what that leaves on a workstation.

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
