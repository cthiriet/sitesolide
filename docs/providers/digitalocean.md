# DigitalOcean

`sitesolide machine --provider digitalocean` orders a Droplet from
[DigitalOcean's API](https://docs.digitalocean.com/reference/api/reference/),
ready for `sitesolide setup`. What every provider shares, the SSH key the
workstation offers, the waits, `--json`, is in [machine.md](../machine.md);
this page says what is DigitalOcean's own.

```console
$ read -rs DIGITALOCEAN_TOKEN && export DIGITALOCEAN_TOKEN    # paste the token: nothing is echoed
$ sitesolide machine create --provider digitalocean --name web
-> machine web at DigitalOcean: s-1vcpu-2gb at fra1, debian-13
...
-> ready
   name      web
   type      s-1vcpu-2gb at fra1
   ipv4      203.0.113.10
   ipv6      2001:db8:10::4d8:a001, network 2001:db8:10::4d8:a000/124

next: sitesolide setup root@203.0.113.10 --zone <your zone> --email <you>
```

## The token

Make one in the [control panel](https://cloud.digitalocean.com/account/api/tokens):
*API*, the *Tokens* tab, *Personal access tokens*, *Generate New Token*. Give
it a name and an expiration, choose **Custom Scopes**, and tick these, which
are all the command uses:

| Scopes | What for |
|---|---|
| `droplet:create`, `droplet:read`, `droplet:update`, `droplet:delete` | order the Droplet, find it again, turn its backups on, destroy it |
| `firewall:create`, `firewall:read`, `firewall:delete` | the Cloud Firewall |
| `ssh_key:create`, `ssh_key:read`, `ssh_key:delete` | the workstation's key; deleting one only ever happens with `--delete-key`, or to undo a refused order |
| `tag:create`, `tag:read`, `tag:delete` | the tags that mark what sitesolide created |
| `regions:read`, `sizes:read`, `image:read` | what DigitalOcean sells where, read before anything is ordered |
| `actions:read` | follow the Droplet's creation |
| `reserved_ip:read`, `block_storage:read` | say, when a Droplet is destroyed, which reserved IPs and volumes it leaves behind, still billed |

If the picker adds scopes these depend on, keep them. A *Read Only* token lists
machines but cannot create or destroy one; a *Full Access* token works, and
reaches everything in the team. The token is shown once: put it in your
password manager before leaving the page.

**Give sitesolide a team of its own.** A token reaches every resource of the
team it was made in, whatever its scopes allow there: in a team that holds only
this machine, the token can touch nothing else you run at DigitalOcean, and the
team's billing shows at a glance what sitesolide costs you.

The token is read from `DIGITALOCEAN_TOKEN`, the variable DigitalOcean's
Terraform provider reads, or from standard input with `--token-stdin`. When
`DIGITALOCEAN_TOKEN` is unset, it is taken from `DIGITALOCEAN_ACCESS_TOKEN`,
which doctl reads, else from `doctl auth token`, when doctl is installed and
signed in. A token doctl obtained with `doctl auth login` expires within hours
and carries the scopes chosen at sign-in; running any doctl command renews it.

It is never an option, and it travels in the Authorization header of
DigitalOcean's API and nowhere else, as [machine.md](../machine.md) says.

## What `create` makes

| Resource | What it is |
|---|---|
| SSH key | Your workstation's public key. A key the account already holds, under any name, is reused; otherwise it is uploaded as `sitesolide-<name>`. |
| Tag `sitesolide-machine:<name>` | The tag the firewall applies to, which the Droplet carries. |
| Cloud Firewall `sitesolide-<name>` | Inbound TCP 22, 80 and 443, and ICMP, from `0.0.0.0/0` and `::/0`; outbound everything, since a Cloud Firewall also drops whatever leaves without a rule. It applies to the Droplets tagged `sitesolide-machine:<name>`, from the Droplet's first boot. |
| Droplet `<name>` | `s-1vcpu-2gb` at `fra1` (Frankfurt) with `debian-13-x64` unless `--type`, `--location` and `--image` say otherwise; a public IPv4 and IPv6; the key for `root`; tagged `managed-by:sitesolide` and `sitesolide-machine:<name>`. `--backups` turns on DigitalOcean's daily backups. |

DigitalOcean has no labels, so sitesolide marks what it creates with tags, and
not the same way for each resource:

- a Droplet is sitesolide's when it carries `managed-by:sitesolide`;
- a firewall cannot carry that tag: a firewall's tags are the Droplets it
  applies to, and `managed-by:sitesolide` would apply every machine's firewall
  to every other. sitesolide's is the one named `sitesolide-<name>` that
  applies to `sitesolide-machine:<name>`;
- an SSH key carries nothing. When `create` uploads one, the Droplet is also
  tagged `sitesolide-key:<key id>`, and that tag is the only thing
  `--delete-key` deletes a key by: a key you uploaded yourself is never
  deleted, whatever its name, even when the machine was created with it.

Before anything is created, `create` reads what could refuse it: a Droplet of
that name sitesolide did not create (Droplet names are not unique at
DigitalOcean, and are compared without regard to case: one that is not
sitesolide's is never touched), a region that does not exist or no longer
takes Droplets, a size the region does not sell, an image that does not exist
there, `--backups` where DigitalOcean takes none, a firewall named
`sitesolide-<name>` that is not sitesolide's. A refusal leaves nothing behind.

If DigitalOcean refuses the order itself, with an answer of 4xx, the key, the
tag and the firewall this run had created for it are deleted again, and a
refusal that names the size or the region lists the cheapest sizes sold there.
Any other outcome, no answer, a failure on DigitalOcean's side, a 429, an
answer cut short, undoes nothing: the Droplet may exist all the same, and
deleting its firewall would leave it open. Running the same command again
finds it, or what the first run made, and goes on.

A run that finds the Droplet an earlier run created also checks its firewall:
if `sitesolide-<name>` is gone, it is created again, and said. A firewall of
that name that is not sitesolide's is left as it is, and said too.

It then waits for the creation to complete, for the Droplet to be active with
its public address, and for the firewall to be applied, then for port 22. Each
wait is bounded, and a run interrupted anywhere is finished by running the same
command again.

The Droplet keeps its public IPv4 address until it is destroyed, powered off
and on included: DigitalOcean gives an address back to its pool only when a
Droplet is destroyed. No Reserved IP is needed for the DNS records to stay
right. DigitalOcean routes sixteen IPv6 addresses to each Droplet, a /124, and
configures one of them, the one the API reports: that address is the one an
AAAA record names.

DigitalOcean's monitoring agent is not installed: it is free, but it is a
second agent reporting to DigitalOcean, and sitesolide's own monitor watches the
machine. DigitalOcean's console agent, which its control panel's Droplet
Console needs, is left to DigitalOcean's default, which installs it.

## What it costs

DigitalOcean bills the Droplet from its creation until it is destroyed,
powered off or not, by the second, up to a monthly cap for the bundled sizes
such as the default; the public IPv4 is part of a bundled size's price, and is
billed on its own for the newer v5 configurations (`s5-...`). Backups add a
share of the Droplet's price, more for daily backups than for weekly ones;
firewalls and tags cost nothing. The prices are on [DigitalOcean's pricing page](https://www.digitalocean.com/pricing/droplets),
with the [details of Droplet billing](https://docs.digitalocean.com/products/droplets/details/pricing/)
and of [backups](https://docs.digitalocean.com/products/backups/details/pricing/).
`machine list` shows the monthly price the API gives for each Droplet, in US
dollars and before taxes, and a refused `--type` lists the cheapest sizes of
the region with theirs.

## Listing

```bash
sitesolide machine list --provider digitalocean
```

The Droplets tagged `managed-by:sitesolide`, with their size, region, status,
addresses and monthly price. Droplets sitesolide did not create are not listed.

## Destroying

```bash
sitesolide machine destroy web --provider digitalocean
```

The name is typed back, or passed with `--confirm web`, as for every provider.
A Droplet without the tag `managed-by:sitesolide` is refused, and the tags are
read again just before, from DigitalOcean rather than from what `list` said.

What goes, in this order:

1. the Droplet, with its disk; the command waits for DigitalOcean to stop
   listing it;
2. the firewall `sitesolide-<name>`, unless it still applies to another Droplet
   (another one tagged `sitesolide-machine:<name>`, or one added to it by hand);
3. the SSH key uploaded for this machine, only with `--delete-key`: the key
   was copied to the Droplet when it was created, and deleting it from the
   account changes nothing on the machines made with it;
4. the tags `sitesolide-machine:<name>` and `sitesolide-key:<id>`, once nothing
   carries them and no firewall names them.

What stays:

- **the volumes attached to the Droplet and the reserved IPs assigned to it.**
  DigitalOcean detaches them and keeps billing them; sitesolide never deletes
  them, since a volume holds data and a reserved IP may be named by DNS
  records, and lists each one it read before the Droplet went. Delete them from
  the control panel if nothing needs them any more;
- **the backups of the Droplet**, which DigitalOcean keeps after the Droplet
  until their retention ends, seven days for daily backups, four weeks for
  weekly ones; the control panel lists them under *Backups & Snapshots*;
- the tag `managed-by:sitesolide`, which every machine sitesolide creates
  shares;
- **the DNS records.** They live in your zone, not at DigitalOcean: delete the
  A and AAAA records that pointed at the machine yourself, or they keep naming
  an address DigitalOcean will give to someone else.

The command ends by listing what it removed and what it kept.

## Tests

`SITESOLIDE_DIGITALOCEAN_API` points the command at another address than
`https://api.digitalocean.com/v2`, for a local fake of the API
(`clouds/fakes/digitalocean.ts`). It takes https, or http on the loopback
only, so that the token never travels in the clear. The provider's own tests are
`clouds/tests/digitalocean.test.ts`.
