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
certificate, the dashboard, the portal, every deploy.

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
the machine, where Caddy renews the wildcard with it, so it must stay the
zone's alone.

## Installing the machine

```bash
export CLOUDFLARE_API_TOKEN=...
sitesolide setup root@192.168.1.40 --zone example.com --email you@example.com \
  --tunnel ~/.cloudflared/<id>.json
```

On top of [the usual steps](setup.md#the-steps):

| Step | What changes behind a tunnel |
|---|---|
| preflight | a private address is taken as it is: nothing points at it |
| configuration | `config.json` records the tunnel's id, `"tunnel"`, never its secret |
| dns | `example.com` and `*.example.com` become proxied CNAMEs to `<id>.cfargotunnel.com`; address records there are refused unless `--dns-replace` |
| firewall | ssh alone: 80 and 443 are closed, every request comes in through the connector's own connection |
| tunnel | `cloudflared` from Cloudflare's repository, `/etc/cloudflared/config.yml`, the credentials in `/etc/cloudflared/tunnel.json` (root, `0600`), the connector's unit, and Caddy's options for it; waited for until the edge answers |
| resolution | waits until your workstation resolves the zone to Cloudflare's edge |

The step runs before Caddy's configuration: what `bin/deploy-caddy.sh` and
every deploy verify next is asked of the sites' public addresses, through the
tunnel. Run again without `--tunnel`, setup takes the configuration's tunnel
and changes nothing. `--tunnel <id>` takes a tunnel whose credentials the
machine already holds at `/etc/cloudflared/<id>.json`, where Cloudflare's own
guide puts them: setup copies them to `tunnel.json` there, and they never
travel.

Under `--skip-dns` setup lists the two CNAMEs to create by hand, proxied, and
waits for them.

## What runs on the machine

**The connector**, `sitesolide-tunnel.service`
([infra/tunnel](../infra/tunnel/sitesolide-tunnel.service)), runs
`cloudflared` as an account drawn for it, with no capability, the system
read-only, the projects' secrets, Caddy's files and the steward's state out of
its sight. systemd hands it a copy of the credentials. It may not reach the
private ranges, `192.168.0.0/16` among them: compromised, it reaches no other
machine of the network it sits on. Its configuration sends the zone and its
wildcard to Caddy on `127.0.0.1:443`, the name asked as SNI so that Caddy
picks the site and its certificate as for any visitor, and answers 404 to any
other name.

**The visitor's address.** Every request reaches Caddy from the loopback, and
Cloudflare's edge sets the visitor's address in `Cf-Connecting-Ip`.
`/etc/caddy/global.d/tunnel.caddy` ([the file](../infra/tunnel/tunnel.caddy))
has Caddy believe that header from the loopback alone, and every block hands
its app the result as `X-Forwarded-For`, one value, the visitor's: the
analytics count visitors, and the dashboard's limiter counts each address on
its own. A visitor who sends their own `X-Forwarded-For` changes nothing, and
Cloudflare refuses a request that carries its own `Cf-Connecting-Ip`. What
the loopback lets through besides the connector is a process of the machine
itself.

**The certificates.** Caddy obtains the wildcard through the DNS-01
challenge, which needs no port open, exactly as on a machine with a public
address. The connector does not verify Caddy's certificate on the loopback,
where only Caddy listens on 443: verifying would add nothing a visitor sees,
and would turn a renewal that failed into every site down at the
certificate's expiry, which the monitor warns of fourteen days ahead.

**The monitor** checks the connector besides everything else: its unit, and
cloudflared's `/ready` on `127.0.0.1:20240`, which answers 200 once a
connection to the edge is up. A connector that stops, or runs and reaches
nothing, its tunnel deleted, is a critical check that fails the heartbeat:
every site is lost to the Internet then, while everything read on the
loopback looks fine.

**The backups** copy `/etc/cloudflared` with the rest of the machine's own
state. On a new machine, lay the copy's `tunnel.json` at
`/etc/cloudflared/<id>.json`, root's in `0600`, then run setup with `--tunnel
<id>`.

## What a tunnel does not carry

- **A customer's own domain.** Cloudflare routes into a tunnel the names of
  the account's own zones alone, and Let's Encrypt cannot reach the machine
  to certify another: `sitesolide domain --activate` refuses there. A site
  stays at `https://<slug>.<zone>`.
- **`--dns manual`, or a zone at another provider**: refused, for the same
  reason.
- **The wizard** offers no tunnel yet: the command above does it.

Visitors' requests go through Cloudflare, which decrypts them at its edge.
That is what a tunnel is; a machine with a public address serves them without
anyone in between.

## Upgrading

`sitesolide upgrade` keeps the connector's unit, its configuration and
Caddy's options current on a machine that has a tunnel, and says nothing of a
tunnel on one served directly. It never touches the credentials.

## Leaving a tunnel

setup does not move a machine off its tunnel. By hand: point the records at a
public address with `--dns-replace` on a machine that has one, open 80 and 443
(`sudo ufw allow 80/tcp`, `sudo ufw allow 443/tcp`), stop the connector
(`sudo systemctl disable --now sitesolide-tunnel`), remove
`/etc/caddy/global.d/tunnel.caddy` and reload Caddy (`sudo systemctl reload
caddy`), and take `"tunnel"` out of `config.json`.
