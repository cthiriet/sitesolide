# Akamai Cloud (Linode)

`sitesolide machine create --provider linode` orders a Linode from
[Akamai Cloud](https://www.akamai.com/cloud), formerly Linode, through its API
v4, with nothing to install on the workstation and no state file to keep. What
every provider shares, where credentials come from and how `list` and
`destroy` decide, is in [machine.md](../machine.md).

```console
$ read -rs LINODE_TOKEN && export LINODE_TOKEN      # paste the token: nothing is echoed
$ sitesolide machine create --provider linode --name web
-> machine web at Akamai (Linode): g6-standard-1 at fr-par, debian-13
   credentials: LINODE_TOKEN
...
-> ready
   name      web
   type      g6-standard-1 at fr-par
   ipv4      203.0.113.10
   ipv6      2001:db8::f03c:91ff:fe00:10

next: sitesolide setup root@203.0.113.10 --zone <your zone> --email <you>
```

## The token

Make a personal access token in
[Cloud Manager](https://cloud.linode.com/): open the menu under your username at
the top right, then *API Tokens*, *Create a Personal Access Token*. Give it an
expiry, **Read/Write** on *Linodes* and on *Firewalls*, and **No Access** on
everything else. A *Read Only* token lists machines but cannot create or delete
one. Cloud Manager shows the token once: copy it then.

A token reaches every Linode and every firewall of the account, not only those
sitesolide made: sitesolide itself only ever changes what carries its tags, but
the token could do more in other hands. Keep it as you would the account's
password, and let it expire.

The token is read from `LINODE_TOKEN`, the variable Akamai's Terraform provider
reads, or from standard input with `--token-stdin`:

```bash
<your password manager's read command> | sitesolide machine list --provider linode --token-stdin
```

When `LINODE_TOKEN` is not set, the token Akamai's own `linode-cli` already
uses is: `LINODE_CLI_TOKEN`, else the default user's token in its
configuration file (`LINODE_CLI_CONFIG`, else `~/.linode-cli`, else
`~/.config/linode-cli`). A value that does not have a token's shape is not
taken.

It is never an option: an option sits in the shell's history and in what `ps`
shows to every user of the workstation. sitesolide sends it in the
Authorization header of Akamai's API and nowhere else, never writes it to a
file, and never prints it: should a message ever carry it, it is replaced with
`[token]` before it is printed.

## What `create` makes

Two resources, each tagged `managed-by:sitesolide` and
`sitesolide-machine:<name>`: Akamai has tags, plain strings, where other
providers have labels. The tags are how `list` finds them and how `destroy`
tells them from what it must never touch.

| Resource | What it is |
|---|---|
| Firewall `sitesolide-<name>` | A Cloud Firewall: inbound TCP 22, 80 and 443, and ICMP, from `0.0.0.0/0` and `::/0`; everything else inbound is dropped before it reaches the machine. Outbound is open. |
| Linode `<name>` | `g6-standard-1` (1 vCPU, 2 GB) at `fr-par` (Paris) with `debian-13`, Akamai's `linode/debian13`, unless `--type`, `--location` and `--image` say otherwise. A public IPv4 and IPv6, your workstation's public key for `root`, the firewall attached from the start. `--backups` turns on Akamai's Backup service. |

No SSH key is uploaded to the account: the key travels in the order, and Akamai
writes it into root's `authorized_keys` on the new disk. No root password is
set: the API takes the key alone as the way into the disk, so the Linode has no
password login to guess at in the moments before `sitesolide setup` turns
password logins off.

A Linode's network comes in two generations at Akamai. In a region that offers
*Linode interfaces*, generally available since April 2026 and the default of
new accounts, `create` asks for them and puts the firewall on the public
interface; elsewhere it asks for the legacy configuration profile and puts the
firewall on the Linode. Either way the firewall is attached by the order
itself, and the Linode never boots without it. On Linode interfaces, `create`
also turns Network Helper on, whatever the account's default: it is what
configures the IPv6 address the AAAA record points at. An account set, under
*Account*, *Settings*, to allow only one generation for new Linodes may refuse
the other: the refusal says so.

The public IPv4 is the Linode's from its creation to its deletion, power cycles
included, so the DNS records that point at it keep working; no reserved address
is needed.

The machine's name becomes the Linode's label, which is unique in the account,
and the firewall's, which holds 32 characters at most: at Akamai a name is 3 to
21 characters, starts with a letter, and never holds two dashes in a row. A
name that does not fit is refused before anything is asked of the API.

Before anything is created, `create` reads what could refuse it: a Linode of
that name sitesolide did not create (it is never touched: pick another name), a
region that is unknown, down, or lacks Linodes, Cloud Firewall or, with
`--backups`, Backups (the refusal lists the regions that have them), a type
Akamai does not sell or says it cannot sell there right now (the refusal lists
the cheapest ones it does, with their price), a firewall of that label that is
not sitesolide's. A refusal leaves nothing behind.

If Akamai refuses the order itself, the firewall this run had created for the
Linode is deleted again: without a Linode, nothing in sitesolide would ever list
or remove it. It is kept when it protects something after all, or when a Linode
of that name turned up anyway, since an order that failed on the way back may
have gone through; the next run then finds both. What an earlier run made is
left as it was.

It then waits for Akamai to provision and boot the Linode (`provisioning`,
`booting`, then `running`), then for port 22 to accept a connection, each wait
bounded, and prints the `setup` command that comes next. Every step is
idempotent: a run interrupted anywhere, or a wait that timed out, is finished
by running the same command again, which finds what the first run made.

It installs nothing and hardens nothing. The Linode carries no cloud-init
`user_data`: `sitesolide setup` does the hardening over SSH, as root, where it
can be checked and run again.

## What it costs

Akamai bills the Linode from its creation until its deletion, by the hour,
powered off or not; the Backup service is billed on top of it, at a price that
depends on the type. The prices are on
[Akamai's pricing page](https://www.akamai.com/cloud/pricing), in US dollars
and before tax, and a few regions charge more than the rest. `machine list`
shows the monthly price the API gives for each machine at its region, and a
refused `--type` lists the cheapest types of the region with theirs.

## Listing

```bash
sitesolide machine list --provider linode
```

The Linodes tagged `managed-by:sitesolide`, with their type, region, status,
addresses and monthly price. Linodes sitesolide did not create are not listed.

## Destroying

```bash
sitesolide machine destroy web --provider linode
```

At a terminal, the name is typed back to confirm; anywhere else, `--confirm
web` says it, and a value that is not the name stops everything. A Linode
without the `managed-by:sitesolide` tag is refused: delete it from Cloud
Manager if it has to go. The Linode is read again just before it is deleted,
and refused if its tags or its label changed in between.

The Linode goes first, with its disks and **the Akamai backups of it**, which
the API deletes with the Linode; its address goes back to Akamai. Its firewall
goes next, only when it carries sitesolide's tags for that machine and protects
nothing else: deleting a Cloud Firewall strips its rules from everything it
protects, so one still attached to another Linode is kept, and said so. There
is no SSH key to keep or delete: it lived on the Linode's disk, and
`--delete-key` changes nothing here.

**Block Storage volumes are never deleted.** sitesolide does not create any,
but one you attached to the Linode is only detached when the Linode goes, and
Akamai keeps billing it: the command lists each one among what it kept, with
its size, so that you can delete it from Cloud Manager if its data is no longer
needed. The command ends by listing what it removed and what it kept.

**DNS records are not touched.** They live in your zone, not at Akamai: delete
the A and AAAA records that pointed at the machine yourself, or they keep
naming an address Akamai will give to someone else.

## Tests

`SITESOLIDE_LINODE_API` points the command at another address than
`https://api.linode.com/v4`, for a local fake of the API
(`clouds/fakes/linode.ts`). It takes https, or http on the loopback only, so
that the token never travels in the clear.
