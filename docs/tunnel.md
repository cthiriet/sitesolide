# Serving from a machine the Internet cannot reach

A machine at home, behind its router's NAT, or a VM on a machine that already
does something else, has no public address: no visitor can open a connection
to it, and Let's Encrypt cannot either. A [Cloudflare
Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
turns that around. A connector on the machine, `cloudflared`, opens its own
connections out to Cloudflare's edge and keeps them open; Cloudflare answers
the zone's visitors and hands each request down one of those connections. The
machine opens no port to anyone.

```
visitor --HTTPS--> Cloudflare's edge ==tunnel, opened from the machine==> cloudflared --loopback--> Caddy :443 --> the app
```

`sitesolide setup --tunnel` installs a machine that way. Everything else is
the same as on a machine with a public address: Caddy, its wildcard
certificate, the dashboard, the portal, every deploy, and a site's own
domain, when its zone is at Cloudflare in the tunnel's account: see
[A site's own domain](#a-sites-own-domain).

## What you need

- **The zone's DNS at Cloudflare**, the default for setup: a tunnel serves
  the names of Cloudflare's own zones alone. The token is the one
  [setup.md](setup.md#what-you-need-first) describes, `Zone / Zone / Read`
  and `Zone / DNS / Edit` on the zone.
- **A Debian 13 machine you reach over SSH**, from your workstation on the
  same network for instance. Its address may be private: setup takes it as
  it is.
- **`cloudflared` on your workstation**, to create the tunnel once:
  `brew install cloudflared`, or the package of
  [Cloudflare's downloads](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).

## Creating the tunnel

The tunnel is yours to create, with Cloudflare's own tool:

```bash
cloudflared tunnel login                    # a browser opens: pick the zone's account
cloudflared tunnel create sitesolide        # writes ~/.cloudflared/<id>.json
rm ~/.cloudflared/cert.pem                  # optional: login's certificate, needed only to create or delete tunnels
```

The file `tunnel create` writes holds the tunnel's secret: whoever holds it
runs the tunnel, and so serves your zone's names in your machine's place.
Keep it as you would a key, out of every repository. It reaches nothing else:
no DNS, no other tunnel, no account.

setup does not create the tunnel through Cloudflare's API: that takes a token
allowed to make tunnels for the whole account, and the zone's token goes on
the machine, where Caddy renews the wildcard with it, so it must reach the
zones the machine serves and nothing else: the zone's, and those of the
sites' own domains, see [A site's own domain](#a-sites-own-domain).

## Installing the machine

```bash
export CLOUDFLARE_API_TOKEN=...
sitesolide setup root@192.168.1.40 --zone example.com --email you@example.com \
  --tunnel ~/.cloudflared/<id>.json
```

On top of [the usual steps](setup.md#the-steps), in this order:

| Step | What changes behind a tunnel |
|---|---|
| preflight | a private address is taken as it is: nothing points at it |
| firewall | ssh opened alone: no request comes in but through the connector's own connection |
| tunnel | `cloudflared` from Cloudflare's repository, `/etc/cloudflared/config.yml`, the credentials in `/etc/cloudflared/tunnel.json` (root, `0600`), the connector's account and unit, Caddy's options for it, and cloudflared's upgrades; waited for until the edge answers. Refused on a machine whose loopback has no `::1`. `config.json` then records the tunnel's id, `"tunnel"`, never its secret |
| dns | `example.com` and `*.example.com` become proxied CNAMEs to `<id>.cfargotunnel.com`; address records there are refused unless `--dns-replace` |
| resolution | waits until your workstation resolves the zone to Cloudflare's edge, and no longer to the machine's own address |
| web-ports | 80 and 443 closed, if an earlier run opened them |
| loopback | the rule's two more lines: from `::1`, Caddy's 443 to the connector's account alone |

The records come once the connector runs, and the web's ports close once
resolvers see Cloudflare: a machine that served the zone directly moves
behind a tunnel without a moment where its sites answer nowhere. All of it but
the loopback's lines runs before Caddy's configuration, since what
`bin/deploy-caddy.sh` and every deploy verify next is asked of the sites'
public addresses; the loopback rule comes where it always does, after the
portal.

Run again without `--tunnel`, setup takes the configuration's tunnel and
changes nothing, without the zone's token too: it reads the records through
the API when the token is at hand, and otherwise takes the ones it made
itself, which `setup.json` records, once the names resolve. `--tunnel <id>`
takes a tunnel whose credentials the machine already holds at
`/etc/cloudflared/<id>.json`, where Cloudflare's own guide puts them: setup
copies them to `tunnel.json` there, and they never travel. A value that is
neither a file nor an id, the token Cloudflare's dashboard shows in its
install command for instance, is refused without being shown back.

Under `--skip-dns` setup lists the two CNAMEs to create by hand, proxied, and
waits for them.

## What runs on the machine

**The connector**, `sitesolide-tunnel.service`
([infra/tunnel](../infra/tunnel/sitesolide-tunnel.service)), runs
`cloudflared` as its own account, `sitesolide-tunnel`, which owns nothing,
with no capability, the system read-only, the projects' secrets, Caddy's
files and the steward's state out of its sight. systemd hands it a copy of the
credentials. It may not reach the private ranges, `192.168.0.0/16` among
them: compromised, it reaches no other machine of the network it sits on. Its
configuration sends every name to Caddy on `[::1]:443`, in one rule, the
name asked as SNI so that Caddy picks the site and its certificate as for any
visitor. The names are chosen before they reach it: Cloudflare routes into
the tunnel only those whose records, in the tunnel's own account, point at
it. Caddy then decides by host what it serves, as on a machine served
directly, where any name a client sends reaches 443: a name it neither
covers with the zone nor finds in the domain table gets no certificate, and
the edge answers 502. No list of names lives in the connector's
configuration, so activating a site's own domain restarts nothing.

**The visitor's address.** Every request reaches Caddy from the connector,
over the loopback, and Cloudflare's edge sets the visitor's address in
`Cf-Connecting-Ip`. `/etc/caddy/global.d/tunnel.caddy` ([the
file](../infra/tunnel/tunnel.caddy)) has Caddy believe that header from `::1`
alone, where the connector reaches it, and every block hands its app the
result as `X-Forwarded-For`, one value, the visitor's: the analytics count
visitors, and the dashboard's limiter counts each address on its own. A
visitor who sends their own `X-Forwarded-For` changes nothing, and Cloudflare
refuses a request that carries its own `Cf-Connecting-Ip`.

`::1` is the connector's alone: [the loopback rule](concepts.md#the-loopback-rule)
refuses every other account, root included, a connection from there to
Caddy's 443. Everything else on the machine, the monitor's and the
gatekeeper's probes as any project's service, reaches Caddy on `127.0.0.1`,
where it believes no header: a service that sends one there is counted as
`127.0.0.1`, as on a machine served directly. Measured on a test machine
behind a tunnel: a project's account that named `203.0.113.66` in that
header reached the apps as that address, from `127.0.0.1` as from `::1`; now
it reaches them as `127.0.0.1` from the first and is refused on the second,
root too, while a visitor through the tunnel keeps their own address, after a
restart of the connector and a reboot alike.

The rule names the connector by its uid, which is why its account is a
static one rather than one systemd draws at each start; its cgroup, the
other way nftables tells a service, changes id at every restart. And not
`127.0.0.1` for the connector: every account shares it, and a connection to
another address of `127.0.0.0/8` still leaves from it.

**The loopback must keep its IPv6**, which Debian gives it. Without `::1` the
connector reaches no site, and the monitor, which reads Caddy on `127.0.0.1`,
sees nothing wrong. setup refuses such a machine. Turned off later,
`net.ipv6.conf.all.disable_ipv6=1` included, every site answers 502 through
the tunnel until it is turned back on, measured on the test machine.

**The certificates.** Caddy obtains the wildcard through the DNS-01
challenge, which needs no port open, exactly as on a machine with a public
address. A site's own domain, which a machine served directly certifies over
HTTP-01 or TLS-ALPN-01, goes through the DNS-01 challenge too:
`tunnel.caddy` sets a global issuer, Let's Encrypt with Cloudflare's DNS
module and the machine's own token, which becomes the issuer of every policy
that names none, the on-demand one of the customer domains and of each app's
domain. The `ask` endpoint still decides which names get one. Caddy builds
the zone's issuer on top of that global one, every field the zone's policy
leaves empty taken from it: the global issuer holds the zone's own
directive and nothing else, so that the zone's comes out as it was, and a
directory, resolvers or a timeout added there would reach the wildcard and
every preview too. Let's Encrypt rather than Caddy's internal
authority, which the edge would accept as well: the monitor and the
gatekeeper verify the certificate on the loopback and warn fourteen days
before it expires, and an internal certificate lasts twelve hours. The
connector does not verify Caddy's certificate on the loopback, where only
Caddy listens on 443: verifying would add nothing a visitor sees, and would
turn a renewal that failed into every site down at the certificate's expiry,
which the monitor warns of fourteen days ahead.

**The monitor** checks the connector besides everything else: its unit, and
cloudflared's `/ready` on `127.0.0.1:20240`, which answers 200 once a
connection to the edge is up. A connector that stops, or runs and reaches
nothing, its tunnel deleted, is a critical check that fails the heartbeat:
every site is lost to the Internet then, while everything read on the
loopback looks fine.

**cloudflared's upgrades.** Cloudflare's repository is among those the
security updates take (`/etc/apt/apt.conf.d/52sitesolide-cloudflared`), and
the connector is restarted once dpkg has replaced its binary: Cloudflare
supports a connector for about a year, and a box at home is often left alone
longer.

**The backups** copy `/etc/cloudflared` with the rest of the machine's own
state. On a new machine, lay the copy's `tunnel.json` at
`/etc/cloudflared/<id>.json`, root's in `0600`, then run setup with `--tunnel
<id>`.

## A site's own domain

A site's own domain reaches a machine behind a tunnel when its zone is at
Cloudflare **in the tunnel's own account**: Cloudflare routes into a tunnel
the names whose records point at it in that account alone, and answers its
error 1014 to a name of another account pointed there. The domain's owner
does two things in Cloudflare's dashboard, then activates the domain as on any
machine:

1. **The records.** A proxied CNAME to `<id>.cfargotunnel.com` for the domain,
   and one for each name the domain table adds, its `www` when it is a second
   level domain and its aliases. `sitesolide domain --activate` lists them,
   the tunnel's id written in.
2. **The token.** Caddy obtains the domain's certificate through the DNS-01
   challenge with the machine's own Cloudflare token, the one setup laid in
   `/etc/caddy/cloudflare.env`: it needs `Zone / Zone / Read` and
   `Zone / DNS / Edit` on the domain's zone too, added to the token at
   [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens).
   Editing a token's permissions keeps its value: nothing changes on the
   machine.

```bash
sitesolide domain --activate
```

Behind a tunnel it first reads the machine's tunnel files, the connector's
configuration and Caddy's options: those of 0.10.0 would let the switch
succeed and answer the domain 404, so it refuses until `sitesolide upgrade`
has laid this release's, `--force` or not. Then it checks every name on
Cloudflare's edge rather than in the DNS:

- `https://<name>/cdn-cgi/trace` must answer Cloudflare's trace, which the
  edge serves for any proxied name before the domain is activated;
- no name may still point at the machine's own address, a record from before
  the tunnel left DNS only;
- the name's root must not answer 520 to 526, the edge's own answers when it
  fails to reach an origin by its address: a record left proxied at an
  address resolves to Cloudflare and answers its trace like the others, but
  a name routed into the tunnel gets the connector's 502 before its
  activation, Caddy refusing its handshake. A proxied record pointing at a
  host that answers is not caught: its root answers that host's status.

A name that fails is refused with the records to create; `--force` goes
ahead anyway, as it does past the DNS check of a machine served directly.
Then it says what the token needs and the records, and switches the domain
the usual way: manifest, machine, table, no restart of the connector.

The visitor sees Cloudflare's own certificate for the zone, from its edge,
which Cloudflare issues for a zone's name and its first level below it; a
deeper alias needs a certificate of Cloudflare's own first. Behind the edge,
Caddy holds a certificate from Let's Encrypt, obtained on the first request
through the tunnel: the connector waits ten seconds for Caddy, the challenge
may take longer, and the first answers may be 502 until it is done, which
`domain --activate` waits for, ninety seconds at most. `sitesolide domain`
then says whether Cloudflare's edge serves the name, and why an origin's
failure answers what it answers:

- **520 to 526**: the edge reached for an address, never the tunnel's; the
  name's record most likely points at an address, proxied, and the CNAME it
  should be is printed;
- **502, and Caddy completes a verified handshake for the name** on the
  machine's loopback: Caddy holds the certificate, and the 502 comes from
  behind it, the app or its service, `sitesolide logs`;
- **502, and no handshake**: most likely no certificate, the token lacking
  the zone's permissions, with the last error Caddy's TLS logged about the
  name in its journal.

Deactivating the domain says what the token may lose: once no active domain
uses a zone, `Zone / Zone / Read` and `Zone / DNS / Edit` on it can be taken
off the machine's token, which keeps its value.

## What a tunnel does not carry

- **A domain whose zone is elsewhere**, at another DNS provider or in another
  Cloudflare account: Cloudflare routes nothing of it into the tunnel, and
  Let's Encrypt cannot reach the machine to certify it any other way. Its
  trace answers all the same when another account proxies it, so
  `domain --activate` cannot tell that case from the right one: the visitor
  gets Cloudflare's error 1014. A site stays at `https://<slug>.<zone>` then.
- **`--dns manual`, or a zone at another provider**, for the machine's own
  zone: refused, for the same reason.
- **The wizard** offers no tunnel yet: `sitesolide setup --tunnel` does it.

Visitors' requests go through Cloudflare, which decrypts them at its edge.
That is what a tunnel is; a machine with a public address serves them without
anyone in between.

## A VM on a machine you already run

A box at home that already serves something, a node of some kind whose
keys and data must not be at stake, can hold sitesolide's machine as a VM.
The VM is what sitesolide installs and hardens; around it, the host keeps
what is its own. [infra/vm/install.sh](../infra/vm/install.sh) lays the VM
on a Debian or Ubuntu host, arm64 or amd64, with KVM:

```bash
scp -r infra/vm host:sitesolide-vm             # this folder, from a checkout or a release's source
scp ~/.ssh/id_ed25519.pub host:sitesolide-vm/key.pub
ssh host sudo sitesolide-vm/install.sh --ssh-key sitesolide-vm/key.pub \
  --cpus 2 --memory 3072 --disk 20 --state /mnt/ssd/sitesolide-vm \
  --hide /mnt/ssd/bitcoin --hide /mnt/ssd/monero --hide /etc/bitcoin --hide /etc/monero
```

`--state` puts the guest's disk on a disk of your choosing, an SSD rather
than a Raspberry Pi's SD card, which constant writes wear out. On a disk
encrypted and unlocked by hand, the VM tries again every thirty seconds
until the guest's disk is there, and starts within half a minute of the
unlock. Every folder above it has to let QEMU's account through: a disk
mounted `0700` for its owner is refused, with the `chmod o+x` that lets it
through without listing what it holds. The packages are installed with
Ubuntu's `needrestart` suspended, which would otherwise restart on its own
the host's services whose libraries changed.

| What | How the host keeps its own |
|---|---|
| the account | QEMU runs as `sitesolide-vm`, which owns `/var/lib/sitesolide-vm` alone, with no capability, the system read-only, the home folders, `/run` with every socket of the host's services, and every `--hide` folder out of its sight, `/dev/kvm` its only device |
| the network | QEMU's user mode, IPv4 alone, and a wall of its own, the nftables table `sitesolide_vm`, which judges QEMU's sockets alone: no connection to any address of the host, its loopback where its other services listen and its public addresses included, nor to any private range, the home network and its box included, nor anywhere over IPv6, where every device of a home has a global address. The rest of the Internet is open over IPv4, and a connection that reaches the VM is answered. A packet the host's kernel sends on its own, neighbor discovery or a network mount, is none of the wall's |
| the wall's life | loaded before the network, laid again after every start, reload and stop of `nftables.service`, whose configuration begins with `flush ruleset`; the VM is bound to its unit and refuses to start without the table in the kernel. A `nft flush ruleset` typed by hand takes it away: `sudo systemctl reload sitesolide-vm-wall` lays it again |
| ssh | the guest's port 22 forwarded to the host's loopback alone, `127.0.0.1:2222`: reached through the host's own ssh, nothing else of the network sees it |
| memory | bounded at the guest's plus 768 MiB, swap excluded: a guest that outgrows it costs QEMU, which restarts, never the host's services |
| CPU and disk | `CPUWeight=20`, `IOWeight=20`: the host's own services come first when both want the machine; the disk is a raw file allocated whole at install, which never grows over the host's |
| a stop | the guest's power button, through QEMU's QMP socket, pressed until it shuts down: a host that reboots takes the VM down cleanly, and brings it back after the wall |

The guest asks public resolvers, `1.1.1.1` and `1.0.0.1`: the wall refuses
the host's loopback, where QEMU would otherwise send its DNS. They answer the
SOA queries the DNS-01 challenge needs.

From the workstation, the guest is reached through the host:

```
# ~/.ssh/config
Host sitesolide-vm
  HostName 127.0.0.1
  Port 2222
  User root
  ProxyJump host                                # the host, as this file names it
```

```bash
ssh sitesolide-vm true
export CLOUDFLARE_API_TOKEN=...
sitesolide setup root@sitesolide-vm --zone example.com --email you@example.com \
  --tunnel ~/.cloudflared/<id>.json
```

Every ssh connection reaches the guest from QEMU's gateway, `10.0.2.2`, so
fail2ban there bans every client at once: a few refused logins, root's once
setup has closed it among them, and nobody gets in for ten minutes. setup
spares that address while it runs, and nothing but the host's own ssh users
can knock at all. Once setup has run, the guest's account is `deploy`, which
the ssh configuration above then names as its `User`.

**Measured** on an Ubuntu 24.04 arm64 host with nested KVM, standing in for
a Raspberry Pi 5, with services standing in for a node's RPC on its loopback,
on its network address and on a public address of its own:

| The wall | the host's loopback | its network address | its public address | the Internet |
|---|---|---|---|---|
| none | reached | reached | reached | reached |
| private ranges alone, its first version | refused | refused | **reached** | reached |
| as laid now | refused | refused | refused | reached |

The guest had no IPv6, booted in ten seconds, came back on its own after the
host rebooted and shut down cleanly with it, in four seconds; the wall
outlived `nftables.service` started, reloaded, restarted and stopped, the VM
running all along; the host's own IPv6 neighbors still answered; a second run
of `install.sh` changed nothing and left the VM running; and `sitesolide
setup` through the host hardened the guest, closed root, opened ssh alone and
installed Caddy with its DNS module and Bun before the step that needs the
zone's token. Not measured on a Raspberry Pi itself: check `ls -l /dev/kvm`
there first.

## Upgrading

`sitesolide upgrade` keeps the connector's account, unit and configuration
and Caddy's options current on a machine that has a tunnel, and says nothing
of a tunnel on one served directly. It never touches the credentials. A
change to the connector restarts it: the sites answer 502 for the few seconds
the edge takes to see it connected again, measured at under ten.

The loopback rule is not upgrade's: `bin/deploy-loopback.sh close`, or a run
of setup, which checks for the connector's lines, lays them. It refuses to,
laying nothing, while Caddy's options for the tunnel are not the kit's or the
connector runs as another account than its own: run upgrade first.

## Leaving a tunnel

setup does not move a machine off its tunnel by itself. On a machine that has
a public address, in this order, so that the sites answer all along: take
`"tunnel"` out of `config.json`, and `tunnelRecords` out of `setup.json`
beside it; run setup with `--dns-replace`, which opens 80 and 443 and points
the records at the machine, while the connector still serves the resolvers
that have not caught up; then, once the zone resolves to the machine:

```bash
sudo rm /etc/caddy/global.d/tunnel.caddy && sudo systemctl reload caddy
sudo systemctl disable --now sitesolide-tunnel
sudo rm /etc/systemd/system/sitesolide-tunnel.service /etc/apt/apt.conf.d/52sitesolide-cloudflared && sudo systemctl daemon-reload
sudo userdel sitesolide-tunnel
```

Then, from the workstation, `bin/deploy-loopback.sh close` lays the rule
again without the connector's lines.

A site's own domain served through the tunnel moves the same way, before the
connector goes: its records pointed at the machine, DNS only, as a machine
served directly needs them. Its certificate stays valid, and Caddy renews it
over HTTP-01 or TLS-ALPN-01 once `tunnel.caddy` is gone. The machine's token
then needs no rights on the domains' zones, a machine served directly
certifying customer domains without their DNS: take `Zone / Zone / Read` and
`Zone / DNS / Edit` on each of them off it at
[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens),
which keeps its value, leaving the zone's own.

Until the unit file is gone, `sitesolide upgrade` takes the machine for one
behind a tunnel, and refuses it once the configuration names none.
