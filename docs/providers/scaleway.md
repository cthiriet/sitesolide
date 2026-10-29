# Scaleway

`sitesolide machine create --provider scaleway` orders an Instance from
[Scaleway](https://www.scaleway.com/en/virtual-instances/) through its
[Instance API](https://www.scaleway.com/en/developers/api/instance/), with
nothing to install on the workstation and no state file to keep. What every
provider shares, where credentials come from and how `list` and `destroy`
decide, is in [machine.md](../machine.md).

```console
$ read -rs SCW_SECRET_KEY && export SCW_SECRET_KEY      # paste the secret key: nothing is echoed
$ export SCW_DEFAULT_PROJECT_ID=<the project's ID>
$ sitesolide machine create --provider scaleway --name web
-> machine web at Scaleway: DEV1-S at fr-par-1, debian-13
   credentials: SCW_SECRET_KEY, SCW_DEFAULT_PROJECT_ID
...
-> ready
   name      web
   type      DEV1-S at fr-par-1
   ipv4      203.0.113.10
   ipv6      2001:db8:b:4d:dc00:ff:fe0c:d0e, network 2001:db8:b:4d::/64

next: sitesolide setup root@203.0.113.10 --zone <your zone> --email <you>
```

## The API key

**Give sitesolide a project of its own, and a key that reaches only it.** A
Scaleway API key carries the permissions of its bearer: the account's owner may
do everything, billing and every other project included. Make the key for an
IAM application instead, which may do only what `sitesolide machine` does, in
that project only. In the [Scaleway console](https://console.scaleway.com/):

1. Create a project for sitesolide, from the project switcher at the top left,
   and copy its ID from *Project settings*: that is `SCW_DEFAULT_PROJECT_ID`.
2. *IAM*, *Applications*, *Create application*: name it `sitesolide-machine`.
3. *IAM*, *Policies*, *Create policy*: its principal is that application, and
   its one rule grants **InstancesFullAccess**, **BlockStorageFullAccess** and
   **SSHKeysFullAccess**, with the scope *Specific projects*: the project of
   step 1. Nothing else.
4. *IAM*, *API keys*, *Generate API key*, with the application as its bearer.
   The secret key, a UUID, is shown once: copy it into your password manager.
   The access key beside it is not needed.

The three permission sets are what a machine touches: the server, its security
group and its flexible addresses are Instances; its boot volume is Block
Storage; the key it lets in lives in IAM. The Marketplace, where the image is
found, and the catalogue of types and prices are public. If a call is refused
with a 403, its message names what the key was trying to do: add that
permission set to the rule, never a wider one.

The key is read from `SCW_SECRET_KEY` and the project from
`SCW_DEFAULT_PROJECT_ID`, the variables the `scw` CLI and Scaleway's Terraform
provider read, or both from standard input with `--token-stdin`, one
`VARIABLE=value` line each:

```bash
<your password manager's read command> | sitesolide machine list --provider scaleway --token-stdin
```

When the environment holds no key and the [scw CLI](https://www.scaleway.com/en/cli/)
is set up on the workstation, its active profile is used: `scw config get
secret-key` and `scw config get default-project-id`, which print what `scw
init` stored. A project in the environment still wins over the CLI's. The
command says where it found them, and never shows the key.

It is never an option: an option sits in the shell's history and in what `ps`
shows to every user of the workstation. sitesolide sends it in the X-Auth-Token
header of Scaleway's APIs and nowhere else, never writes it to a file, and
never prints it: should a message ever carry it, it is replaced with `[token]`
before it is printed.

## What `create` makes

Six resources, in the zone `--location` names. Each carries the tags
`managed-by:sitesolide` and `sitesolide-machine:<name>`, but the SSH key, which
IAM cannot tag: the tags are how `list` finds them and how `destroy` tells them
from what it must never touch.

| Resource | What it is |
|---|---|
| SSH key | Your workstation's public key: `--ssh-key`, else the first of `~/.ssh/id_ed25519.pub`, `id_ecdsa.pub`, `id_rsa.pub`. A key the project already holds, under any name, is reused; otherwise it is uploaded as `sitesolide-<name>`, and the Instance is tagged `sitesolide-key:<its id>`. Scaleway's images install every key of the project for `root` at each boot. |
| Security group `sitesolide-<name>` | Stateful: inbound TCP 22, 80 and 443, and ICMP, from `0.0.0.0/0` and `::/0`; every other inbound packet dropped, outbound allowed. Scaleway also blocks outbound SMTP by default. |
| Flexible IPv4 | The address DNS points at. The default address of an Instance is dynamic and changes when it is stopped; a flexible one stays the project's until it is deleted. |
| Flexible IPv6 | A /64, in which the Instance takes its address. |
| Instance `<name>` | `DEV1-S` at `fr-par-1` with Debian 13 unless `--type`, `--location` and `--image` say otherwise, the two addresses, the security group. |
| Boot volume | 40 GB of Block Storage made from the image with the Instance. Deleting an Instance leaves its Block Storage volumes behind, so this one is tagged right after the order. |

`DEV1-S`, 2 vCPU and 2 GB, is the cheapest x86 type with 2 GB of memory
Scaleway sells, and Paris the first zone that has it. The 40 GB volume is the
disk of the machine sitesolide is run on elsewhere, which leaves room for the
restic repository of its backups; it can be enlarged from the console later,
never shrunk. `--image` takes `debian-13`, which is the Marketplace's
`debian_trixie` for the zone and the type's architecture, another Marketplace
label, or an image ID; `setup` is verified on Debian 13 only.

The zones are `fr-par-1` to `fr-par-3`, `nl-ams-1` to `nl-ams-3` and `pl-waw-1`
to `pl-waw-3`. The setup wizard offers them, then the types of the chosen one,
the cheapest first: types at their end of service, out of stock, with less than
2 GB of memory, with a GPU or a Windows licence are left out.

Before anything is created, `create` reads what could refuse it: a server of
that name in any zone that sitesolide did not create (it is never touched: pick
another name), a zone sitesolide does not know, a type the zone does not sell
or no longer sells, a type it lists as out of stock (`shortage`), an image the
Marketplace does not have for that type there, a security group of that name
that is not sitesolide's, your key disabled in the project. Each refusal lists
what to try instead, and leaves nothing behind. A type listed as `scarce` is
ordered all the same, after a warning.

The stock can run out between the reading and the order. If Scaleway refuses the
order itself, the key, the security group and the addresses this run had
created for the server are deleted again. What an earlier run made, or the
project already held, is left as it was, and the refusal lists it, with what
it costs and how it goes; a deletion that fails leaves the resource for the
next run, which reuses it.

When the order's outcome is unknown, no answer, a failure on Scaleway's side
or an answer that cannot be read, nothing is undone: the Instance may exist,
and Scaleway deletes a flexible IP even when it is attached to one, which
would leave it without its address. The refusal says so; the same command
then finds the Instance and starts it, or reuses what this run made.

What a run leaves without an Instance, its addresses, its security group, a
boot volume whose Instance went, stays tagged, and the addresses and the
volume stay billed. `machine list` shows it as a machine whose status is
`incomplete`, whichever zone holds it: `machine destroy` removes it, and
`create` reuses the addresses and the group of its zone.

Scaleway creates an Instance stopped, and finds it a host when it starts.
`create` then tags the boot volume, powers the Instance on, and waits for it to
run, then for port 22 to accept a connection, each wait bounded, and prints the
`setup` command that comes next. If there is no host to start it on, the
Instance stays, stopped, and the refusal says so: the same command starts it
later, `destroy` removes it. Every step is idempotent: a run interrupted
anywhere, or a wait that timed out, is finished by running the same command
again, which finds what the first run made, and starts an Instance that was
ordered but never started. One that has run and is stopped now was stopped by
someone, and is left as it is.

It installs nothing and hardens nothing. The Instance carries no user data:
`sitesolide setup` does the hardening over SSH, as root, where it can be checked
and run again. Scaleway's images rewrite root's `authorized_keys` from the
project's keys at each boot: a key that should outlive a reboot belongs in the
project's SSH keys, not in that file.

## What it costs

Scaleway bills the Instance by the hour while it exists, up to a monthly price,
and bills apart from it the Block Storage volume and the flexible IPv4, which
stay billed while the Instance is stopped; the IPv6 prefix is included. The
prices are on [Scaleway's pricing page](https://www.scaleway.com/en/pricing/virtual-instances/)
and, for Block Storage, on [its own](https://www.scaleway.com/en/pricing/storage/).
`machine list` shows the monthly price the API gives for each type, in euros
before VAT, the volume and the IPv4 address not included, and a refused
`--type` lists the cheapest types in stock in the zone with theirs.

`--backups` is refused: Scaleway makes an image of an Instance on demand, and
has no backups of a whole machine on a schedule that sitesolide could turn on.
`setup`'s own backups snapshot every project hourly.

## Listing

```bash
sitesolide machine list --provider scaleway
```

The Instances of the project tagged `managed-by:sitesolide`, in every zone,
with their type, zone, state, addresses and monthly price. Instances sitesolide
did not create are not listed.

## Destroying

```bash
sitesolide machine destroy web --provider scaleway
```

At a terminal, the name is typed back to confirm; anywhere else, `--confirm
web` says it, and a value that is not the name stops everything. An Instance
without the `managed-by:sitesolide` tag is refused: delete it from the console
if it has to go.

The Instance is powered off and deleted first; Scaleway deletes only a stopped
Instance, and leaves its volumes and flexible addresses behind. Then go, in
every zone, each only when it carries sitesolide's tags for that machine: the
boot volume, once detached, the flexible IPv4 and IPv6, and the security
group, unless another Instance uses it. A volume or an address someone
attached since, without the tags, is kept and listed, since it stays billed
until it is deleted from the console. An `incomplete` machine has no Instance
to delete: the rest goes the same way.

The SSH key stays, since other machines may be created with it. `--delete-key`
deletes it too, and only the key the Instance's `sitesolide-key` tag names,
and only while it bears the name `create` gave it, `sitesolide-<name>`, or
that name followed by the first eight digits of its own fingerprint: a key the
project already held, another machine's whose name starts the same, or one
renamed since, is never deleted, nor any key of an `incomplete` machine. Mind
that a key deleted from the project also leaves every other Instance of the
project at its next boot. The command ends by listing what it removed and what
it kept.

**DNS records are not touched.** They live in your zone, not at Scaleway: delete
the A and AAAA records that pointed at the machine yourself, or they keep
naming an address Scaleway will give to someone else.

## Tests

`SITESOLIDE_SCALEWAY_API` points the command at another address than
`https://api.scaleway.com`, for a local fake of the Instance, IAM, Marketplace
and Block Storage APIs (`clouds/fakes/scaleway.ts`). It takes https, or http
on the loopback only, so that the key never travels in the clear.
