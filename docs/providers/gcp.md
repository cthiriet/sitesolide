# Google Compute Engine

`sitesolide machine create --provider gcp` orders a VM instance from
[Google Compute Engine](https://cloud.google.com/products/compute) through its
REST API, with nothing to install on the workstation and no state file to
keep: no SDK, no Terraform, and the `gcloud` CLI only if you want it to hand
over its credentials. What every provider shares, where credentials come from
and how `list` and `destroy` decide, is in [machine.md](../machine.md).

```console
$ gcloud auth login && gcloud config set project sitesolide-prod
$ sitesolide machine create --provider gcp --name web
-> machine web at Google Cloud: e2-small at europe-west4-a, debian-13
   credentials: the gcloud CLI, signed in
...
-> ready
   name      web
   type      e2-small at europe-west4-a
   ipv4      203.0.113.10

next: sitesolide setup sitesolide@203.0.113.10 --zone <your zone> --email <you> --user deploy
```

## The project

**Give sitesolide a project of its own.** Credentials granted on a project
reach everything in it: in a project that holds only this machine, they can
touch nothing else you run at Google Cloud, and the billing report shows at a
glance what sitesolide costs you. In the
[Google Cloud console](https://console.cloud.google.com/): the project picker,
*New project*; link it to a billing account, which Compute Engine requires.

**Turn the Compute Engine API on** in that project: *APIs & Services*,
*Library*, *Compute Engine API*, *Enable*, or
`gcloud services enable compute.googleapis.com`. Until it is on, every call is
refused with `provider-api-disabled`, and the refusal says so. It takes a few
minutes to apply.

**The project needs its `default` network**, which a new project gets unless an
organization policy (`compute.skipDefaultNetworkCreation`) prevents it. The
machine is attached to it, and sitesolide creates no network of its own: a
project without one is refused before anything is created, with
`no-default-network`. Its owner creates it from *VPC network*, *Create VPC
network*, named `default`, with automatic subnets, or with
`gcloud compute networks create default --subnet-mode=auto`.

The project is named by `GOOGLE_CLOUD_PROJECT`, the variable Google's client
libraries read; when it is unset, by `CLOUDSDK_CORE_PROJECT`, then by the key
file's `project_id`, then by `gcloud config get-value project`.

## The credentials

Three ways, the first found winning:

1. **`GOOGLE_OAUTH_ACCESS_TOKEN`**, an access token, the variable the Terraform
   provider reads. `gcloud auth print-access-token` prints one; it lasts an
   hour.
2. **A service account's JSON key**, the file `GOOGLE_APPLICATION_CREDENTIALS`
   names, as Google's client libraries read it. sitesolide reads the file's
   `client_email` and `private_key`, signs a JWT with the key on the
   workstation, and exchanges it at `https://oauth2.googleapis.com/token` for
   an access token of the `https://www.googleapis.com/auth/compute` scope
   alone, valid an hour. The key never leaves the workstation; the signed JWT
   and the token are scrubbed from every line printed. The file's `token_uri`
   is not followed: the exchange only ever goes to Google's endpoint.
   `SITESOLIDE_GCP_CLIENT_EMAIL` and `SITESOLIDE_GCP_PRIVATE_KEY` carry the
   same two values for `--token-stdin` or a CI secret; their names are
   sitesolide's own, so that a private key another program of the workstation
   keeps in its environment is never picked up.
3. **The `gcloud` CLI, signed in** with `gcloud auth login`:
   `gcloud auth print-access-token`, the token of its active account. Nothing
   is asked and nothing is written.

A key file is a long-lived secret: prefer `gcloud`, signed in as yourself, on a
workstation. Many organizations forbid service account keys by policy
(`iam.disableServiceAccountKeyCreation`), in which case `gcloud` is the way.

### The permissions

The account, yours or the service account's, needs on the project:

- **Compute Admin** (`roles/compute.admin`), simplest in a project of
  sitesolide's own; or, narrower,
- **Compute Instance Admin (v1)** (`roles/compute.instanceAdmin.v1`) for the
  instance and its disk, **Compute Network Admin**
  (`roles/compute.networkAdmin`) for the static address, and **Compute Security
  Admin** (`roles/compute.securityAdmin`) for the firewall rules.

To make the service account: *IAM & Admin*, *Service Accounts*, *Create service
account*; grant it those roles at the *Grant this service account access to the
project* step; then the account, *Keys*, *Add key*, *Create new key*, *JSON*.
The file downloads once: keep it out of every repository, and point
`GOOGLE_APPLICATION_CREDENTIALS` at it.

The instance is created without a service account, so it needs no
`iam.serviceAccounts.actAs`, and the machine itself holds no Google
credentials. A refusal for want of a permission names it: Google's message says
which (`Required 'compute.firewalls.create' permission`).

## Zones and types

`--location` takes a zone, `europe-west4-a`; the region, `europe-west4`, follows
from it. `--type` takes a machine type, `e2-small`. The defaults are `e2-small`,
2 shared vCPUs and 2 GB of memory, the cheapest current x86 type with at least
2 GB (`e2-micro` has 1), in `europe-west4-a`, Eemshaven in the Netherlands, the
cheapest of Google's German, French and Dutch regions for E2 when this was
written. `CLOUDSDK_COMPUTE_ZONE`, gcloud's default zone, moves the default
zone.

The wizard offers one zone of each region, and the types of the zone of the E2
series and of the current general-purpose ones (N4, N4D, C4, C4D, C3, C3D, N2,
N2D), x86, at least 2 GB, up to 8 vCPUs, E2 first: the API gives no price, so
this order stands in for "cheapest first". Any other type may be given with
`--type`. The Arm series (C4A, N4A, T2A) boot Debian's arm64 image, and the
series that only take Hyperdisk (N4, N4D, C4, C4D and the Arm ones) boot from
Hyperdisk Balanced rather than Balanced Persistent Disk.

`e2-small` and `e2-medium` are shared-core: two vCPUs that burst, on a fraction
of a physical core.

## What `create` makes

Four resources, all named after the machine. The instance and the address carry
the labels `managed-by=sitesolide` and `sitesolide-machine=<name>`; firewall
rules have no labels on Google Cloud, and carry the same two words at the start
of their description instead.

| Resource | What it is |
|---|---|
| Firewall rule `sitesolide-<name>` | On the `default` network, for the instances carrying the network tag `sitesolide-<name>`: inbound TCP 22, 80 and 443, and ICMP, from `0.0.0.0/0`, at priority 1000. |
| Firewall rule `sitesolide-<name>-deny` | The same target, every other inbound packet denied, at priority 1001. The default network comes with rules of its own, `default-allow-internal`, `default-allow-ssh`, `default-allow-rdp` and `default-allow-icmp`, at priority 65534, which apply to every instance and which sitesolide never changes: this rule is what drops RDP and the network's internal traffic before they reach the machine. |
| Static address `sitesolide-<name>` | A regional external IPv4 address, Premium tier, in the zone's region. The address an instance gets by default may change when it is stopped and started, and your DNS records point at it: the static one stays. |
| Instance `<name>` | Debian 13 from Google's `debian-cloud` project, the latest image of the `debian-13` family (`debian-13-arm64` for an Arm type), on a 20 GB boot disk deleted with the instance; the tag, the address, no service account; your key in its metadata. |

The default network's subnets are IPv4 only: the machine has no IPv6 address.

**The login is `sitesolide`.** The key, `--ssh-key` or the first of
`~/.ssh/id_ed25519.pub`, `id_ecdsa.pub`, `id_rsa.pub`, goes in the instance's
`ssh-keys` metadata as `sitesolide:<key>`; Google's guest agent creates that
account and puts it in its `google-sudoers` group, with sudo and no password.
Google's images do not let root in with a key. The instance's metadata also
sets `enable-oslogin` to `FALSE`, since an organization that turns OS Login on
for the whole project would make the guest agent ignore the key, and
`block-project-ssh-keys` to `TRUE`, since the agent would otherwise make a
sudoer of every key in the project's metadata too. An organization policy that
requires OS Login (`compute.requireOsLogin`) wins over the instance's metadata:
the key is then ignored and `setup` cannot log in. setup connects as
`sitesolide` and does what needs root through `sudo -n`.

A name Google cannot hold is refused before anything leaves, by `create` and by
the wizard as it is typed: it starts with a letter, and holds 47 characters at
most here, the longest name sitesolide derives from it being
`sitesolide-<name>-deny`.

Before anything is created, `create` reads what could refuse it: an instance of
that name sitesolide did not create, in any zone (it is never touched: pick
another name), the zone, the type in that zone (the refusal lists
the types worth trying there), the image, the default network and its subnet in
the region, a firewall rule of one of the two names that is not sitesolide's,
and an address of that name that is not sitesolide's or is already in use. A
refusal leaves nothing behind.

Google accepts an instance at once and may fail it a moment later, when the
zone has no room for the type (`ZONE_RESOURCE_POOL_EXHAUSTED`) or a quota is
reached. If it refuses the order, at once or then, the refusal suggests the
other zones of the region and other types, and the two rules and the address
this run created are deleted again: without an instance, nothing in sitesolide
would ever list or remove them. What an earlier run made, or the project already
held, is left as it was. If the order's outcome is unknown, a wait that timed
out, a network failure or an error on Google's side, nothing is deleted, since
the instance may yet exist: running the same command again finds it.

What an earlier run left without an instance, its address and its rules, is
reused by the next `create`; until then the address is billed. Any refusal of a
`create` that found such leftovers names them, the address with its region, and
says how they go: the same `create` reuses them, and `sitesolide machine destroy
<name> --provider gcp` removes them. An address of the machine's left in another
region than the one asked for is warned of: it stays billed until the machine is
destroyed, which releases it.

It then waits for each operation to finish and the instance to run, then for
port 22 to accept a connection, each wait bounded, and prints the `setup`
command that comes next. Every step is idempotent: a run interrupted anywhere is
finished by running the same command again, which finds what the first run
made, the rules by their name and description, the address by its labels, or by
its name and description when the run was interrupted before labelling it.

It installs nothing and hardens nothing: no startup script, `sitesolide setup`
does the hardening over SSH, where it can be checked and run again.

## What it costs

Google bills, until each one is deleted:

- the instance, by the second while it runs (a minute at least), at the price
  of its type and region;
- its 20 GB boot disk, by the GB and the month, running or stopped;
- **the static IPv4 address, by the hour, whether the instance runs or not**:
  Google bills every external IPv4 address, and a reserved address that no
  running instance uses at a higher rate;
- the traffic leaving Google for the internet.

The prices are on Google's pages for
[instances](https://cloud.google.com/compute/vm-instance-pricing),
[disks](https://cloud.google.com/compute/disks-image-pricing) and
[IP addresses](https://cloud.google.com/vpc/network-pricing#ipaddress), and,
for your project, in the console's *Billing* reports. The Compute Engine API
gives no price: `machine list` shows none, and a refused `--type` lists sizes
without them. The free tier's `e2-micro` is in three US regions and has 1 GB of
memory: it is not the default.

`--backups` means nothing here: sitesolide does not set up Google's snapshot
schedules. Its own backups, restic to a bucket, are what keeps the data.

## Listing

```bash
sitesolide machine list --provider gcp
```

The instances labelled `managed-by=sitesolide` in every zone of the project,
with their type, zone, status and address. Instances sitesolide did not create
are not listed.

A machine whose instance is not there, never created by an interrupted run or
already deleted by an interrupted destroy, while its address or its rules
remain, is listed too, with the status `incomplete`, the type `none`, the
address's region and the reserved address: it is still billed. `destroy`
removes what is left of it, and `create` reuses it; the wizard orders a new
instance for it.

## Destroying

```bash
sitesolide machine destroy web --provider gcp
```

At a terminal, the name is typed back to confirm; anywhere else, `--confirm
web` says it, and a value that is not the name stops everything. An instance
without the `managed-by=sitesolide` label is refused, as is one that was
replaced since it was read: delete it from the console if it has to go.

- **The instance** goes first, and its boot disk with it. Every other disk
  attached and set to go with it goes too, and is named among what was
  removed; a disk that was not set to go with it is kept and said, since Google
  bills it until someone deletes it. For an `incomplete` machine there is no
  instance: this step is skipped, and the destroy stops, deleting nothing,
  should an instance of sitesolide's of that name have appeared since it was
  read.
- **The static address** is released next: every address labelled for this
  machine, in any region, an interrupted run's included. One still used by
  another resource is kept and said; Google may count the instance for a moment
  after it went, which is waited out.
- **The two firewall rules** go last, each only when it is sitesolide's: its
  name is `sitesolide-<name>` or `sitesolide-<name>-deny`, its description
  starts with `managed-by=sitesolide sitesolide-machine=<name>`, and it targets
  the tag `sitesolide-<name>` and nothing else, no other tag and no service
  account. A rule that fails any of the three is left as it is, and said. Both
  are kept while another instance of the project carries the tag, since
  deleting them would open or close ports on it.
- **The key** lived in the instance's metadata and went with it; Google keeps no
  copy, so `--delete-key` has nothing to delete.

The command ends by listing what it removed and what it kept.

A destroy interrupted after the instance went is finished by running it again:
the machine is then `incomplete`, and the second run removes the address and the
rules that are left.

**DNS records are not touched.** They live in your zone, not at Google: delete
the A record that pointed at the machine yourself, or it keeps naming an
address Google will give to someone else.

## Tests

`SITESOLIDE_GCP_API` points the command at another address than
`https://compute.googleapis.com/compute/v1`, and `SITESOLIDE_GCP_OAUTH` at
another token endpoint than `https://oauth2.googleapis.com/token`, for a local
fake of both (`bin/tests/fake-gcp.ts`). The fake checks a service account's
JWT as Google does, its RS256 signature, scope, audience and lifetime. Each
takes https, or http on the loopback only, so that the credentials never travel
in the clear.
