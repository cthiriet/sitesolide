# A machine from a cloud provider

`sitesolide machine` orders the VM that `sitesolide setup` then installs, from
the provider's API, with nothing to install on the workstation and no state
file to keep. Hetzner Cloud is the only provider for now.

```console
$ read -rs HCLOUD_TOKEN && export HCLOUD_TOKEN      # paste the token: nothing is echoed
$ sitesolide machine create --provider hetzner --name web
-> machine web at Hetzner: cx23 at fsn1, debian-13
...
-> ready
   name      web
   type      cx23 at fsn1
   ipv4      203.0.113.10
   ipv6      2001:db8:10::1, network 2001:db8:10::/64

next: sitesolide setup root@203.0.113.10 --zone <your zone> --email <you>
```

## The token

Make one in the [Hetzner console](https://console.hetzner.com/): open the
project, then *Security*, *API tokens*, *Generate API token*, with the
**Read & Write** permission. A *Read* token lists machines but cannot create or
delete one.

**Give sitesolide a project of its own.** A token reaches everything in its
project and nothing outside it: in a project that holds only this machine, the
token can touch nothing else you run at Hetzner, and the console shows at a
glance what sitesolide costs you.

The token is read from `HCLOUD_TOKEN`, the variable Hetzner's own tools read,
or from standard input with `--token-stdin`:

```bash
<your password manager's read command> | sitesolide machine list --provider hetzner --token-stdin
```

It is never an option: an option sits in the shell's history and in what `ps`
shows to every user of the workstation. sitesolide sends it in the
Authorization header of Hetzner's API and nowhere else, never writes it to a
file, and never prints it: should a message ever carry it, it is replaced with
`[token]` before it is printed.

## What `create` makes

Three resources, each labelled `managed-by=sitesolide` and
`sitesolide-machine=<name>`. The labels are how `list` finds them and how
`destroy` tells them from what it must never touch.

| Resource | What it is |
|---|---|
| SSH key | Your workstation's public key: `--ssh-key`, else the first of `~/.ssh/id_ed25519.pub`, `id_ecdsa.pub`, `id_rsa.pub`. A key the project already holds, under any name, is reused; otherwise it is uploaded as `sitesolide-<name>`. |
| Firewall `<name>` | Inbound TCP 22, 80 and 443, and ICMP, from `0.0.0.0/0` and `::/0`; everything else inbound is dropped before it reaches the machine. |
| Server `<name>` | `cx23` at `fsn1` with `debian-13` unless `--type`, `--location` and `--image` say otherwise, a public IPv4 and IPv6, the key for `root`, the firewall. `--backups` turns on Hetzner's daily backups. |

Before anything is created, `create` reads what could refuse it: a server of
that name sitesolide did not create (it is never touched: pick another name), a
type the location does not sell (the refusal lists the cheapest ones it does,
with their price), a firewall of that name that is not sitesolide's. A refusal
leaves nothing behind.

It then waits for Hetzner to finish creating and starting the server, then for
port 22 to accept a connection, each wait bounded, and prints the `setup`
command that comes next. Every step is idempotent: a run interrupted anywhere,
or a wait that timed out, is finished by running the same command again, which
finds what the first run made.

It installs nothing and hardens nothing. The server carries no cloud-init
`user_data`: `sitesolide setup` does the hardening over SSH, as root, where it
can be checked and run again.

## What it costs

Hetzner bills the server from its creation until its deletion, by the hour up
to a monthly price; the public IPv4 address is billed on top of it, and backups
add 20 % to the server's price. The prices are on
[Hetzner's pricing page](https://www.hetzner.com/cloud/) and, for your project
and its currency, in the console. `machine list` shows the monthly price the API
gives for each machine, before VAT, and a refused `--type` lists the cheapest
types of the location with theirs.

## Listing

```bash
sitesolide machine list --provider hetzner
```

The servers labelled `managed-by=sitesolide`, with their type, location,
status, addresses and monthly price. Servers sitesolide did not create are not
listed.

## Destroying

```bash
sitesolide machine destroy web --provider hetzner
```

At a terminal, the name is typed back to confirm; anywhere else, `--confirm
web` says it, and a value that is not the name stops everything. A server
without the `managed-by=sitesolide` label is refused: delete it from the
console if it has to go.

The server goes first, with its disk and **the Hetzner backups of it**, which
the API deletes with the server. Its firewall goes next, unless it is still
applied to another server. The SSH key stays, since other machines may be
created with it; `--delete-key` deletes it too, and only when it was uploaded
for this machine. The command ends by listing what it removed and what it kept.

**DNS records are not touched.** They live in your zone, not at Hetzner: delete
the A and AAAA records that pointed at the machine yourself, or they keep
naming an address Hetzner will give to someone else.

## For agents

`--json` prints one JSON event per line and ends with one `result` or one
`error` carrying a `hint`, as every other command does ([agents.md](agents.md)).
`destroy` never prompts under `--json`: it needs `--confirm <name>`, which an
agent passes only when the owner asked for that machine to be destroyed.

## Tests

`SITESOLIDE_HETZNER_API` points the command at another address than
`https://api.hetzner.cloud/v1`, for a local fake of the API
(`bin/tests/fake-hetzner.ts`). It takes https, or http on the loopback only, so
that the token never travels in the clear.
