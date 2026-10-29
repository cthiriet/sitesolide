# Vultr

`sitesolide machine create --provider vultr` orders an instance from
[Vultr](https://www.vultr.com/) through its [API v2](https://www.vultr.com/api/),
with nothing to install on the workstation and no state file to keep. What
every provider shares, where credentials come from and how `list` and
`destroy` decide, is in [machine.md](../machine.md).

```console
$ read -rs VULTR_API_KEY && export VULTR_API_KEY      # paste the key: nothing is echoed
$ sitesolide machine create --provider vultr --name web
-> machine web at Vultr: vc2-1c-2gb at fra, debian-13
   credentials: VULTR_API_KEY
...
-> ready
   name      web
   type      vc2-1c-2gb at fra
   ipv4      203.0.113.10
   ipv6      2001:db8:10:0:5400:4ff:fe00:10, network 2001:db8:10::/64

next: sitesolide setup root@203.0.113.10 --zone <your zone> --email <you>
```

## The API key

**Do not hand sitesolide the account's own key.** A Vultr API key carries the
permissions of its user, and the account's own user may do everything: billing,
DNS, every other instance. Give the key to a user that may do only what
`sitesolide machine` does instead. In the [Vultr console](https://my.vultr.com/),
click the organization's name, then *Manage Organization*:

1. *Permission Policies*, **+**: name it `sitesolide-machine`, and allow, in
   the *Compute* category, the instance actions (`compute.instance.*`) and the
   SSH key actions (`compute.sshkey.*`), and in the *Network* category the
   firewall actions (`network.firewall.*`). Allowing also the listing of block
   storage and of reserved IPs (`network.reservedip.List`) lets `destroy` say
   what outlives the instance; without them it says it could not check.
   Nothing else.
2. *Users*, **+**, *User Type* **Service User**: give it that policy, through a
   role or a group, or attached to the user directly.
3. Open the user, then under *API Access*, *Create API Key*. The key is shown
   once: copy it into your password manager.

The regions, the plans and the images are public, and need no permission. If a
call is refused with a 403, its message names what the key was trying to do:
add that action to the policy, never a wider one.

**Restrict it to your address.** The same *API Access* holds an *Access Control
List*, which starts with *Any IPv4* and *Any IPv6*. When the workstation's
address is stable, add it with *Add IP to Allowlist* and turn the two defaults
off: a key copied elsewhere is then refused from anywhere else. Vultr answers a
call from an address the list does not allow with a 401, which sitesolide says
in so many words rather than calling the key wrong.

The key is read from `VULTR_API_KEY`, the variable vultr-cli and Vultr's
Terraform provider read, or from standard input with `--token-stdin`:

```bash
<your password manager's read command> | sitesolide machine list --provider vultr --token-stdin
```

When neither holds it and [vultr-cli](https://github.com/vultr/vultr-cli) is
configured on the workstation, its key is used: the `api-key` line of
`vultr-cli.yaml` in the configuration folder (`$XDG_CONFIG_HOME` or
`~/.config` on Linux, `~/Library/Application Support` on macOS), or of
`~/.vultr-cli.yaml`, in the order vultr-cli itself reads them. The command says
where it found it, and never shows it.

It is never an option: an option sits in the shell's history and in what `ps`
shows to every user of the workstation. sitesolide sends it in the
Authorization header of Vultr's API and nowhere else, never writes it to a
file, and never prints it: should a message ever carry it, it is replaced with
`[token]` before it is printed.

## What `create` makes

Three resources. Vultr has tags on instances only, so each resource carries
sitesolide's marks where it has room for them, and `destroy` reads them all:

| Resource | What it is | Its mark |
|---|---|---|
| SSH key | Your workstation's public key: `--ssh-key`, else the first of `~/.ssh/id_ed25519.pub`, `id_ecdsa.pub`, `id_rsa.pub`. A key the account already holds, under any name, is reused; otherwise it is uploaded as `sitesolide-<name>`, or, when another key has that name, `sitesolide-<name>-` followed by the first eight hex digits of this key's MD5 fingerprint. | Its name, and the instance's `sitesolide-key:<id>` tag when sitesolide uploaded it |
| Firewall group | Inbound TCP 22, 80 and 443, and ICMP, from `0.0.0.0/0` and `::/0`; Vultr drops everything else inbound before it reaches the instance. | Its description, `managed-by:sitesolide sitesolide-machine:<name>` |
| Instance `<name>` | `vc2-1c-2gb` at `fra` with Debian 13 x64 unless `--type`, `--location` and `--image` say otherwise, a public IPv4 and IPv6, the key for `root`, the firewall group. `--backups` turns on Vultr's automatic backups. | The tags `managed-by:sitesolide` and `sitesolide-machine:<name>` |

The instance is named by its label, which is also its hostname. `--image`
takes `debian-<release>`, which is the x64 image of that Debian release, or an
`os_id` from Vultr's list; `setup` is verified on Debian 13 only.

The default plan is Regular Cloud Compute with one vCPU and 2 GB, the cheapest
x86 plan with 2 GB of memory, in Frankfurt. The setup wizard offers the regions,
then the plans Vultr has in stock in the chosen one with 2 GB or more, the
cheapest first; GPU plans and plans without an IPv4 are left out.

Before anything is created, `create` reads what could refuse it: an instance of
that label sitesolide did not create (it is never touched: pick another name),
a region Vultr does not have, a plan it does not sell there, a plan it sells
there but has none of in stock right now, an image it does not have. Each
refusal lists what to try instead, and leaves nothing behind.

The stock can run out between the reading and the order. If Vultr refuses the
order itself, with a 4xx, the SSH key and the firewall group this run had
created for the instance are deleted again: without an instance, nothing in
sitesolide would ever list or remove them. What an earlier run made, or the
account already held, is left as it was; a deletion that fails leaves the
resource for the next run, which reuses it, and completes a firewall group
whose rules a run did not finish adding.

An order answered with a 5xx or a 429, or whose answer was lost or cannot be
read, may have created the instance all the same: then nothing is undone, and
the refusal says so. Deleting the firewall group would not stop the instance:
Vultr
[detaches the instances of a group it deletes](https://docs.vultr.com/products/network/firewall-groups/management/delete),
and the instance would run with every port open. Run the same command again: it
finds the instance if there is one, and reuses the key and the group otherwise.

A run that finds the machine already created makes sure it is behind its
firewall group, rules complete. When no group is attached, it says so, makes
the group again or reuses the one an earlier run left, and attaches it. A group
you attached yourself, which sitesolide did not make, is left as it is.

It then waits for the instance to be active, running and past the lock Vultr
holds on it while it installs, then for port 22 to accept a connection, each
wait bounded, and prints the `setup` command that comes next. Every step is
idempotent: a run interrupted anywhere, or a wait that timed out, is finished
by running the same command again, which finds what the first run made.

It installs nothing and hardens nothing. The instance carries no `user_data`:
`sitesolide setup` does the hardening over SSH, as root, where it can be
checked and run again. Vultr also gives root a password, which its answer to
the order carries once: sitesolide neither prints nor keeps it, and `setup`
turns password logins off.

The public IPv4 stays the instance's for as long as the instance exists,
stopped included, as Vultr's
[billing notes](https://docs.vultr.com/support/platform/billing/are-stopped-instances-still-billed-on-vultr)
say: no Reserved IP is needed for the DNS records to keep pointing at it.

## What it costs

Vultr bills the instance from its creation until its deletion, by the hour up
to a monthly price, stopped or not, and the automatic backups add 20 % to it.
The prices are on [Vultr's pricing page](https://www.vultr.com/pricing/). A few
regions cost more than the rest; the API gives their price, and sitesolide
shows and sorts by the region's own. `machine list` shows the monthly price of
each machine, in US dollars before tax, and a refused `--type` lists the
cheapest plans in stock in the region with theirs.

## Listing

```bash
sitesolide machine list --provider vultr
```

The instances tagged `managed-by:sitesolide`, with their plan, region, status,
addresses and monthly price. Instances sitesolide did not create are not
listed.

## Destroying

```bash
sitesolide machine destroy web --provider vultr
```

At a terminal, the name is typed back to confirm; anywhere else, `--confirm
web` says it, and a value that is not the name stops everything. An instance
without the `managed-by:sitesolide` tag is refused: delete it from the console
if it has to go.

The instance goes first, with its disk. Vultr keeps its two latest automatic
backups for seven days after the deletion, then purges them: to keep one,
convert it to a snapshot in the console before then. Block storage and reserved
IPs attached to the instance are read before it goes: Vultr detaches them and
keeps billing them, so `destroy` lists each among what it kept, and never
deletes one. Delete them from the console when they have to go.

The firewall group goes next, when its description says sitesolide made it for
that machine and no other instance uses it any more; a group the instance was
moved to by hand, whose description says nothing of sitesolide, is never
touched. The SSH key stays, since other machines may be created with it.
`--delete-key` deletes it too, and only the key the instance's
`sitesolide-key` tag names, and only while it carries a name sitesolide gives,
`sitesolide-<name>` or that name followed by its own fingerprint's first eight
digits: a key the account already held, or one renamed since, is never
deleted. The command ends by listing what it removed and what it kept.

**DNS records are not touched.** They live in your zone, not at Vultr: delete
the A and AAAA records that pointed at the machine yourself, or they keep
naming an address Vultr will give to someone else.

## Tests

`SITESOLIDE_VULTR_API` points the command at another address than
`https://api.vultr.com/v2`, for a local fake of the API
(`clouds/fakes/vultr.ts`). It takes https, or http on the loopback only, so
that the key never travels in the clear.
