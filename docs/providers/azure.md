# Microsoft Azure

`sitesolide machine create --provider azure` orders a virtual machine from
[Microsoft Azure](https://azure.microsoft.com/) through Azure Resource
Manager's API, with nothing of Azure's to install on the workstation and no
state file to keep. What every provider shares, where credentials come from
and how `list` and `destroy` decide, is in [machine.md](../machine.md).

```console
$ az login                                          # or a service principal, below
$ sitesolide machine create --provider azure --name web
-> machine web at Azure: Standard_B2als_v2 at germanywestcentral, debian-13
   credentials: the Azure CLI, signed in
...
-> ready
   name      web
   type      Standard_B2als_v2 at germanywestcentral
   ipv4      203.0.113.12
   ipv6      none

next: sitesolide setup sitesolide@203.0.113.12 --zone <your zone> --email <you> --user deploy
```

## The credentials

Two ways, and the subscription in both.

**The Azure CLI, signed in.** After `az login`, sitesolide asks the CLI for a
token for Resource Manager (`az account get-access-token`), for the
subscription `AZURE_SUBSCRIPTION_ID` names, or the CLI's default one
(`az account set --subscription <ID>` changes it). The token acts with your own
account's roles and lasts about an hour; sitesolide asks for a fresh one at
each command and never keeps it. The CLI is asked whenever the environment
holds no whole service principal.

**A service principal**, for a workstation without the CLI or an automation.
With the CLI, once:

```bash
az ad sp create-for-rbac --name sitesolide --role Contributor --scopes /subscriptions/<subscription ID>
```

It prints `appId`, `password` and `tenant`: they go into `AZURE_CLIENT_ID`,
`AZURE_CLIENT_SECRET` and `AZURE_TENANT_ID`, beside `AZURE_SUBSCRIPTION_ID`,
the variables Azure's SDKs and Terraform read. In the portal instead: in
*Microsoft Entra ID*, *App registrations*, *New registration*, any name, then
in the registration *Certificates & secrets*, *New client secret*, and copy its
**Value** (not its *Secret ID*); then in *Subscriptions*, the subscription,
*Access control (IAM)*, *Add role assignment*, *Privileged administrator
roles*, **Contributor**, and the registration as the member. The secret is
exchanged at Microsoft Entra for a token at each command: it is sent in the
Authorization header of that request, or, should Entra refuse it there, once
more in the request's form body, as Microsoft's own libraries send it; never in
an address, and nowhere else.

**Give sitesolide a subscription of its own.** Contributor on a subscription
reaches everything in it and nothing outside it: in a subscription that holds
only this machine, the credentials can touch nothing else you run at Azure,
and *Cost Management* shows at a glance what sitesolide costs you. The role is
given on the subscription, never on a management group or the tenant: a
machine's resource group is created by sitesolide, and creating one needs the
subscription. A custom role narrower than Contributor can work, if it allows
resource groups, tags, virtual machines, disks, network security groups,
virtual networks, public addresses, network interfaces, the registration of
`Microsoft.Compute` and `Microsoft.Network`, and reading sizes, quotas, images
and operations; sitesolide is written against Contributor.

The values are read from the environment, or typed at the setup wizard's
prompt, which asks for a service principal (a token, a few thousand characters
that expire within the hour, is the CLI's to hand out), or read from standard
input with `--token-stdin`, one `VARIABLE=value` line each:

```bash
<your password manager's command printing the four lines> | sitesolide machine list --provider azure --token-stdin
```

The secret and the tokens are never an option, never written to a file, and
never printed: should a message ever carry one, it is replaced with `[token]`.

## What `create` makes

A resource group of its own, `sitesolide-<name>`, at the location, holding
everything else. The group and every resource in it carry the tags
`managed-by=sitesolide` and `sitesolide-machine=<name>`: they are how `list`
finds machines and how `destroy` tells them from what it must never touch.

| Resource | What it is |
|---|---|
| Resource group `sitesolide-<name>` | At `germanywestcentral` (Frankfurt) unless `--location`, or the variable `AZURE_DEFAULTS_LOCATION`, says otherwise. A group an earlier run created keeps its location, and what it still lacks is created there, with a warning when `--location` asked for another. |
| Network security group `<name>-nsg` | Inbound TCP 22, 80 and 443, and ICMP, from the Internet; Azure's own last rule drops everything else inbound. |
| Virtual network `<name>-vnet` | `10.0.0.0/16`, one subnet `<name>-subnet`, `10.0.0.0/24`: the machine is alone in it. |
| Public IPv4 `<name>-ip` | Standard, static: it stays the machine's while the machine is stopped or deallocated, so the DNS records stay right. |
| Network interface `<name>-nic` | The subnet, the address and the security group. |
| Virtual machine `<name>` | `Standard_B2als_v2` (2 vCPU, 4 GiB, AMD) with Debian's own `debian-13` image (`Debian:debian-13:13-gen2`, `13-arm64` on an arm size) unless `--type` and `--image` say otherwise; `--image` also takes an image URN, `publisher:offer:sku:version`. Your workstation's key for the account `sitesolide`, password logins off. |
| OS disk `<name>-osdisk` | Standard SSD, created by Azure with the machine and deleted with it; Azure creates it without tags, and `create` tags it right after. |

There is no SSH key resource at Azure: the key is written into the machine.
Azure takes Ed25519 keys and RSA keys of 2048 bits at least; an ECDSA key, or
a smaller RSA key, is refused before anything is asked of Azure. `--backups` is refused: sitesolide does not
turn on Azure's own backups.

**The account is `sitesolide`, not `root`.** Debian's image on Azure creates the
account Azure names, with your key and passwordless sudo, and lets no one log
in as root; Azure refuses `root` as that name anyway. `sitesolide setup`
connects as `sitesolide`.

**No IPv6.** Azure routes IPv6 only into a dual-stack virtual network, with a
second address on the interface billed apart, and whether Debian's image then
configures it has not been checked on a real machine. The machine has a public
IPv4 alone: there is no AAAA record to make.

Before anything is created, `create` reads what could refuse it: a resource
group of that name sitesolide did not create, or a resource inside its group
that sitesolide did not create (never touched: pick another name), a location
that is not one, a size Azure does not sell there or not to this subscription
(the refusal lists the cheapest sizes it does, with their list price), a vCPU
quota the size's family has spent (a new subscription often starts at zero for
a family: raise it in the portal under *Quotas*, *Compute*), an image Azure
does not offer there. The one thing it may do before those refusals is register
the `Microsoft.Compute` and `Microsoft.Network` resource providers on a
subscription that never used them, as the portal and the Azure CLI do on a
first machine: it is free, creates nothing, and reading the sizes needs it.

The list of sizes says what the subscription may order, not what Azure can
place right now. If Azure refuses the order itself, or fails to place the
machine, the refusal lists the sizes to try instead, or suggests another
`--location`, and what this run created is deleted again: the resource group,
which takes everything in it, when this run created it; else each resource
this run made, the last first. What an earlier run made is left as it was; a
deletion that fails leaves the resource, tagged, for the next run, which reuses
it, or for `destroy`.

It then waits for Azure to finish each resource, the machine to run, and port
22 to accept a connection, each wait bounded, and prints the `setup` command
that comes next. Every step is idempotent: a run interrupted anywhere, or a
wait that timed out, is finished by running the same command again, which finds
what the first run made, and waits for what Azure is still making. A timed-out
wait undoes nothing.

It installs nothing and hardens nothing: the machine carries no custom data,
and `sitesolide setup` does the hardening over SSH, where it can be checked and
run again.

## What it costs

Azure bills the machine for as long as it is allocated: one shut down from
inside is still billed, one *stopped (deallocated)* from the portal is not. The
disk and the static address are billed for as long as they exist, the machine
running or not, and outbound traffic past a monthly allowance is billed too. The virtual network and the
security group are free. The prices are on Azure's pages for
[Linux virtual machines](https://azure.microsoft.com/pricing/details/virtual-machines/linux/),
[managed disks](https://azure.microsoft.com/pricing/details/managed-disks/),
[IP addresses](https://azure.microsoft.com/pricing/details/ip-addresses/) and
[bandwidth](https://azure.microsoft.com/pricing/details/bandwidth/), and, for
your subscription, in *Cost Management*.

The setup wizard and a refused `--type` show each size's monthly price from
Azure's public [retail price list](https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices):
Linux, pay as you go, the hourly price times 730, in US dollars. It is a list
price: it ignores your agreement's discounts and credits, and the disk and the
address beside the machine. The price list takes no credentials and is sent
none. `machine list` shows no price, the API giving none.

## Listing

```bash
sitesolide machine list --provider azure
```

The resource groups tagged `managed-by=sitesolide` and named after the machine
they hold, with each machine's size, location, power state and address. A group
whose machine a run never got to create is listed as `incomplete`; the next
`create` finishes it, `destroy` removes it. Machines sitesolide did not create
are not listed.

## Destroying

```bash
sitesolide machine destroy web --provider azure
```

At a terminal, the name is typed back to confirm; anywhere else, `--confirm
web` says it, and a value that is not the name stops everything.

The resource group goes, and with it everything in it: the machine, its disk,
its address, its interface, its network and its security group. Azure takes
several minutes; the command waits for it, bounded, and lists what went.
A group without both tags is refused, and so is a group holding anything
sitesolide did not create, which deleting the group would delete too: move it
out, or delete the group from the portal if it has to go. The OS disk Azure
made with the machine counts as the machine's, tagged or not yet, and that disk
alone: **a data disk attached in the portal since** is yours, and stops
`destroy` until you move it to another resource group or delete it yourself.

`--delete-key` has nothing to delete: Azure holds no key of its own.

Kept: nothing sitesolide made. Azure may have created a `NetworkWatcherRG`
resource group by itself, the first time a virtual network was made in the
region; it is free, Azure's, and left as it is.

**DNS records are not touched.** They live in your zone, not at Azure: delete
the A record that pointed at the machine yourself, or it keeps naming an
address Azure will give to someone else.

## Tests

`SITESOLIDE_AZURE_API` points the command at another address than
`https://management.azure.com`, `SITESOLIDE_AZURE_LOGIN` at another than
`https://login.microsoftonline.com`, and `SITESOLIDE_AZURE_PRICES` at another
than `https://prices.azure.com`, for a local fake of all three
(`clouds/fakes/azure.ts`). Each takes https, or http on the loopback only, so
that no credential ever travels in the clear.
