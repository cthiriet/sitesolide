# egress

What an app may reach outside the machine.

An app's network used to be all or nothing: `"network": "localhost"`, which
cuts everything but the loopback, DNS included, or `"network": "outbound"`,
which opens the whole Internet. An app an agent wrote to post a message to a
company chat needed the second, and with it the means to send anything
anywhere. This component sits between the two: **`egress`** in a project's
`sitesolide.json` lists the hosts it may reach. Its unit still blocks every
address but the loopback; its HTTP clients are pointed at this proxy, which
lets those hosts through and refuses the rest.

It is opt-in, see [Deployment](#deployment). The key is described in
[docs/manifest.md](../docs/manifest.md#egress).

## How a connection goes

```
service of shop               site-shop, IPAddressDeny=any, IPAddressAllow=localhost
   |  HTTPS_PROXY=http://127.0.0.1:3128
   |  CONNECT api.example.com:443
   v
egress proxy                  sitesolide-egress, server.ts
   |-- /proc/net/tcp           the uid of the caller's socket   -> site-shop -> shop
   |-- /srv/sites/shop/sitesolide.json    is api.example.com:443 in `egress`?
   |-- resolves api.example.com, judges EVERY address           private, loopback, metadata...
   `-- connects to an address it judged, answers 200, then pipes the bytes
```

**Two ports**, 3128 and 3129, outside the blocks the loopback rule closes,
3000 to 3099 and 21000 to 29999 (see
[concepts](../docs/concepts.md#the-loopback-rule)): inside one, the projects
could not reach the proxy at all. On 3128 the proxy pipes bytes it never reads
([src/proxy.ts](src/proxy.ts)); on 3129 it answers the dashboard's two
read-only routes and nothing else ([src/status.ts](src/status.ts)), and two
ports keep a tunnel from ever being read as anything else. Both are raw
`Bun.listen` listeners counted against one admission
([src/admission.ts](src/admission.ts)): one count of connections per project
and for the whole proxy, one budget for the bytes waiting for a slow end,
whichever port a connection came to. What they bound, descriptors and memory,
is the process's.

**Nobody else listens on them.** Outside the range, the loopback rule no
longer keeps a project off them, and it judges who connects, never who
listens: a project waiting on 3128 while the proxy restarted would have
received every other project's outgoing calls. Every generated unit refuses
them to its service (`SocketBindDeny=3128-3129`, bin/cli/unit.ts), from each
project's first deployment with that generator.

**Plain HTTP** in absolute form, what `HTTP_PROXY` produces, goes through the
same checks; the head is rewritten for the origin with `Connection: close`,
then the connection becomes the same pipe. Whatever the client sends next on
it can only reach the address already judged.

## Who is calling

The proxy never trusts anything the caller sends to say who it is. The kernel
already knows: every TCP socket carries the uid of the account that opened it,
and `/proc/net/tcp` and `/proc/net/tcp6` list them. The proxy takes the
caller's address and port, finds the ESTABLISHED socket whose local end is
that and whose remote end is the proxy, reads its uid, and `/etc/passwd`
turns it into `site-<slug>`. A token would have had to reach every project
without landing in its unit, which is world-readable, and be rotated when it
leaked; this has nothing to leak.

It fails closed at every step: no matching line, two lines that disagree, a
uid with no account, an account that is not `site-<slug>`. It holds because
every project runs in the host's network namespace, and because the proxy's
unit hides neither its sockets nor `/proc/net`: the unit says so, and
[tests/unit-file.test.ts](tests/unit-file.test.ts) refuses `PrivateNetwork`
and `ProcSubset=pid` there. The parser is tested on fixtures in the kernel's
format ([tests/proc-net.test.ts](tests/proc-net.test.ts)) and on a real
kernel's tables, in a container, when asked:

```bash
EGRESS_KERNEL_TEST=1 bun test tests/proc-kernel.test.ts
```

## Which clients go through it

The unit sets `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`, in upper and lower
case, for a project that declares `egress`. Most clients read them by
themselves; the ones that do not simply fail to connect, the network being
closed, so the gap shows at the first call.

| Client | Reads the variables |
|---|---|
| Bun's `fetch` | yes, both spellings, and `NO_PROXY` |
| curl | yes; for plain HTTP only the lowercase `http_proxy`, which the unit sets |
| Go's `net/http` | yes, the default transport uses `ProxyFromEnvironment` |
| Python's `requests` and `urllib` | yes |
| Node's built-in `fetch` | **no**, by default: pass a proxy agent, or check whether your Node version honours `NODE_USE_ENV_PROXY=1` |

`NO_PROXY` covers `localhost`, `127.0.0.1` and `::1`: a project's services call
each other there.

## When a change applies

At the next connection. Each request costs one `stat` of the caller's
manifest, which is parsed again only when it changed: an allowlist deployed a
second ago applies to the very next call. No timer, and no root process
copying anything for the proxy: the manifests are `0644` in `0755` folders,
deposited by `deploy`, readable by the proxy and not writable by the
project's own service.

At runtime the proxy reads `egress` alone, not the whole manifest judged
again: a rule added to another key later must not cut a project off until the
proxy is rebuilt. An entry that does not read is skipped, which narrows and
never widens.

## Audit

The component's own table, `audit`, in `/var/lib/sitesolide-egress/egress.db`,
in the shape every component shares (`at`, `actor`, `action`, `target`,
`detail`). It never holds a header's value.

| Action | Actor | Target | When |
|---|---|---|---|
| `egress.denied` | `system` | the project, or null when the caller is not one | counted per project and destination, one row a minute per pair with its count, at most 50 pairs a minute, the rest folded into one row |

Rows are kept 90 days. The dashboard reads the table through the status
port, `GET /audit` and `GET /status`, which answer the `site-dashboard`
account alone, identified like any caller.

## Threat model

**What it stops.**

- An app reaching a host its manifest does not list: directly, the kernel
  drops the packets (`IPAddressDeny=any`); through the proxy, it is refused
  with a sentence naming the host and the manifest.
- An app resolving names of its choosing: it has no DNS at all, the proxy
  resolves only the listed hosts, which closes the DNS channel an app would
  otherwise use to leak data in the names it looks up.
- Server-side request forgery through a listed name: a host whose DNS answer
  points at the loopback, a private or CGNAT network, link-local, multicast or
  the cloud's metadata service is refused, every address checked, one bad
  answer refusing the host, and the connection goes to the address that was
  checked, never to a second resolution. The unit refuses the same ranges at
  the kernel, against a fault in the code.
- The same through the machine's own public address. A service listening on
  `0.0.0.0` or `::` answers there too, and a connection from the machine to
  itself never crosses the provider's firewall. No rule can name that address
  in advance, so the proxy reads every address of the machine's interfaces,
  again every 30 seconds, and refuses them like the loopback. A reading that
  fails keeps the last good one; with none, nothing goes out. The unit cannot
  refuse them at the kernel, not knowing them; it keeps `AF_NETLINK` open for
  the reading. A provider that translates the public address rather than
  setting it on an interface (AWS, GCP) leaves it out of that list, and a
  connection to it then leaves the machine and comes back through the
  provider's firewall like anyone else's.
- A project passing itself off as another: the uid comes from the kernel.
- A project answering in the proxy's place: its unit refuses it 3128 and 3129,
  so it cannot wait there for the proxy to restart.
- One project taking the proxy down for every other, by either port. Its
  connections are counted from the moment the kernel names it, before any
  head, both ports together, and refused past 128; the proxy's past 1024.
  Every byte waiting for a slow end, in a tunnel or in an answer of the status
  port, counts against the project's budget and the proxy's: past one, the
  connections it covers stop reading until half has drained. Measured open
  while the second port ran on `Bun.serve`: 3000 idle connections from one
  caller held, after which another project's CONNECT went unanswered once
  descriptors ran short.

**What it does not stop.**

- **A certificate inside a tunnel.** A CONNECT is TLS end to end between the
  app and the host: the proxy does not check the certificate there, and could
  not. The app's client does, against the name it asked for, as it would
  without a proxy; a client told to skip that check is on its own.
- **Exfiltration to a host on the project's own list.** An allowed API that
  stores arbitrary data, a paste service, an issue tracker: the proxy does not
  look inside TLS and could not judge what it saw. The list is the boundary;
  keep it short.
- **A wildcard over a domain where anyone gets a subdomain**: `*.github.io`,
  `*.herokuapp.com`, a bucket host. That entry is an open door. Validation
  refuses `*.com` but cannot know every public suffix: `*.co.uk` passes.
- **A few projects slowing every other.** Past 32 MiB waiting in the whole
  proxy, no tunnel is read until half has drained: several projects each
  holding their 8 MiB of unread bytes slow down everyone's. Eight projects
  holding their 128 connections fill the proxy's 1024. That is the trade made
  against the proxy being killed for memory or for descriptors, which would
  cut them all.
- **The proxy itself.** It reaches every listed host. It runs as its own
  account, with no capability, a read-only system, the secrets and Caddy
  hidden; a compromise yields that reach, nothing of `/etc/sitesolide`.
- **Whoever deploys.** `deploy` writes the manifest, so the deployment account
  decides each project's list.
- **`network: outbound`**, which this does not restrict at all, and which the
  manifest refuses next to `egress`.
- **Root**, on the machine.

## Limits

| What | Value |
|---|---|
| Open connections, all projects, both ports together | 1024, then 503 |
| Open connections per project, both ports together, counted once the kernel names the caller, before its head | 128, then 503 |
| Request head, on either port | 16 KiB, 10 s to arrive |
| Idle tunnel, or an answer of the status port never read | closed after 10 min with no byte delivered either way; a byte sent to a side already gone does not count |
| Connection, resolution | 10 s, 5 s; an address that answers past its delay is closed at once |
| Bytes waiting for one side of a tunnel | 64 KiB, then the other side is no longer read |
| Bytes waiting in all of one project's connections, both ports | 8 MiB, then none of them is read until half has drained |
| Bytes waiting in the whole proxy, both ports | 32 MiB, then no connection is read until half has drained |
| Bytes sent before a tunnel opens | 2 MiB per connection, then 400 |
| A refused connection, once answered | read and dropped until the client closes, 1 s and 64 KiB at most, then cut; 1024 at a time per port, then closed at once |
| Refused pairs held between two audit writes | 10 000, the rest only counted |

**Memory.** The unit gives the proxy 256 MiB, and the byte limits above keep
what it holds for slow readers under 100 MiB in the worst case, for every
project and both ports together: the arithmetic is next to the constants, in
[src/proxy.ts](src/proxy.ts). The mark of one direction alone could not: a
pause lands only once Bun has drained the kernel's receive buffer, up to
6.5 MiB a direction, which is why each project's bytes and the proxy's are
counted as well. A paused socket must also stay paused: Bun 1.3 starts
reading a paused socket again whenever a write to it comes up short, and a
single tunnel whose two ends both sent without reading took the proxy past
3 GiB in under a second until the proxy put the pause back after every such
write. `/status` gives `buffered`, the bytes waiting now.

**A refusal lingers.** A client refused while it is still sending, a body
behind its head or a head too large, would get a reset if the proxy closed
with its bytes unread, and a reset makes the client's kernel throw away the
answer it had not read yet: "connection reset" instead of the sentence that
says why, 2 attempts in 40 on a loaded test machine. So the proxy answers,
sends a FIN behind the answer, and reads and drops what still comes until the
client closes, as nginx's lingering close does. Bun 1.3.11 needs care there:
`end()` closes the descriptor at once, and a socket shut down while paused is
closed too; see `linger()` in [src/proxy.ts](src/proxy.ts).

## Deployment

Opt-in. Nothing on the machine changes until these steps, and no project's
unit changes until that project declares `egress` and is deployed again.
`deploy` refuses such a project, before pushing anything, on a machine where
the proxy does not run.

The commands are the author's to run, in this order.

1. **Check the two ports are free**, on the machine:

   ```bash
   ssh <server> "ss -ltn '( sport = :3128 or sport = :3129 )'"   # nothing but the header
   ```

   `bin/deploy-egress.sh` checks it again and stops if something else listens.

2. **Install the proxy**:

   ```bash
   bin/deploy-egress.sh
   ```

   It builds `egress.js`, creates the `sitesolide-egress` account if missing,
   installs the file and the unit, enables and starts it. It then checks: the
   installed file is the one built, the service listens on 127.0.0.1:3128 and
   :3129, `site-dashboard` gets 200 on `/status` (the proof that the proxy
   identifies callers under its hardened unit), and `nobody` gets 403 on
   `/status` and on a CONNECT. A failure stops there and prints the journal
   command. It touches neither Caddy nor any site.

   Then check the proxy reads the machine's own addresses under its unit,
   which the script does not:

   ```bash
   ssh <server> "sudo -u site-dashboard curl -s http://127.0.0.1:3129/status"
   ```

   `ownAddresses` must be a number, the loopback and the public addresses
   counted. `null` means the interfaces could not be read, and every egress
   is refused with a 503 that says so until they are: the unit's
   `RestrictAddressFamilies` and `SystemCallFilter` are where to look.

3. **Move a project**: add `egress` to its manifest (and drop
   `"network": "outbound"` if it had it), `sitesolide deploy`. Check its
   journal for refusals, which name the host:

   ```bash
   ssh <server> "sudo journalctl -u <slug> -n 50"
   ```

   and the dashboard's Activity for `egress.denied`.

**Check after a change of the proxy's code**: `bin/deploy-egress.sh` again,
which rebuilds, replaces and verifies. `sitesolide deploy` never updates it.

| What changes | The command |
|---|---|
| `egress/`, `infra/egress/`, `bin/cli/egress.ts` | `bin/deploy-egress.sh` |

**Rollback.** Move the projects back first, `"network": "outbound"` or no key,
and deploy them: a project whose unit points at a stopped proxy reaches
nothing. Then:

```bash
ssh <server> "sudo systemctl disable --now sitesolide-egress \
  && sudo rm /etc/systemd/system/sitesolide-egress.service /usr/local/lib/sitesolide/egress.js \
  && sudo systemctl daemon-reload"
```

`/var/lib/sitesolide-egress` stays, the audit included, for a reinstall;
remove it by hand once you are sure.

## Local development

```bash
bun install
DATA_DIR=/tmp/egress SITES_DIR=/tmp/egress/sites \
  PROXY_PORT=4128 STATUS_PORT=4129 bun server.ts
```

On a workstation without `/proc/net` every caller is unknown, and refused:
the integration tests inject the caller instead.

## Tests

```bash
bun run check   # tests, then type checking
```

What is covered: host matching (wildcards, case, final dots, international
names, ports), the classification of every special address range, IPv4-mapped,
NAT64 and 6to4 included, the `/proc/net` parser and the identification on
fixtures, the policy's re-reading, the audit's counting and capping, and, on
real sockets with a TLS server of the test's own: an allowed CONNECT end to
end, a refused host, a refused private resolution, a refused resolution to the
machine's own address, read from interfaces the test injects, plain HTTP
forwarding, large transfers in both directions, a slow reader stopping the
proxy from reading the other side, both ends flooding included, a project's
budget and the proxy's, the bytes sent before a tunnel opens capped, a refusal
read by a client still sending its request, and the linger that follows cut by
time and by bytes, a tunnel closed whichever end goes first, the per-project
limit counted before any head, and the status port: its two routes answered to
the dashboard's account alone, an answer larger than one write delivered
whole, a head that does not read or never ends refused, and its connections
counted per project and for the proxy, against the CONNECT port's admission
too.
