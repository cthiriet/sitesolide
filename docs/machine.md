# A machine from a cloud provider

`sitesolide machine` orders the VM that `sitesolide setup` then installs, from
the provider's API, with nothing to install on the workstation and no state
file to keep. `sitesolide setup`, typed alone at a terminal, asks the same
questions interactively and runs these commands itself: see
[setup.md](setup.md#the-wizard).

```console
$ sitesolide machine providers
   hetzner       Hetzner          credentials: HCLOUD_TOKEN
   digitalocean  DigitalOcean     no credentials: DIGITALOCEAN_TOKEN
   aws           AWS              credentials: the aws CLI
   ...
$ sitesolide machine create --provider hetzner --name web
-> machine web at Hetzner: cx23 at fsn1, debian-13
   credentials: HCLOUD_TOKEN
...
-> ready
   name      web
   type      cx23 at fsn1
   ipv4      203.0.113.10

next: sitesolide setup root@203.0.113.10 --zone <your zone> --email <you>
```

## The providers

| `--provider` | Cloud | Credentials | Logs in as | Its page |
|---|---|---|---|---|
| `hetzner` | Hetzner Cloud | `HCLOUD_TOKEN` | `root` | [hetzner.md](providers/hetzner.md) |
| `digitalocean` | DigitalOcean | `DIGITALOCEAN_TOKEN` | `root` | [digitalocean.md](providers/digitalocean.md) |
| `aws` | Amazon EC2 | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, or the `aws` CLI signed in | `admin` | [aws.md](providers/aws.md) |
| `gcp` | Google Compute Engine | `GOOGLE_OAUTH_ACCESS_TOKEN` and `GOOGLE_CLOUD_PROJECT`, a service account key, or `gcloud` signed in | `sitesolide` | [gcp.md](providers/gcp.md) |
| `azure` | Microsoft Azure | a service principal, or the `az` CLI signed in | `sitesolide` | [azure.md](providers/azure.md) |
| `vultr` | Vultr | `VULTR_API_KEY` | `root` | [vultr.md](providers/vultr.md) |
| `linode` | Akamai Cloud (Linode) | `LINODE_TOKEN` | `root` | [linode.md](providers/linode.md) |
| `scaleway` | Scaleway | `SCW_SECRET_KEY` and `SCW_DEFAULT_PROJECT_ID` | `root` | [scaleway.md](providers/scaleway.md) |

Each page says how to make the credentials with the least permission that
works, what `create` makes there, what it costs, and what `destroy` removes.
The defaults are the provider's cheapest current x86 type with at least 2 GB of
memory, in Germany, France or the Netherlands, on Debian 13; `--type`,
`--location` and `--image` choose otherwise, and a refused `--type` lists the
ones that location sells.

**What has run for real.** Hetzner, DigitalOcean and Google Cloud have ordered
machines through their real APIs, which `setup` then installed and served
sites from, before `destroy` left nothing behind. AWS, Azure, Scaleway, Vultr
and Akamai follow their providers' documentation and pass the same tests
against local fakes of their APIs, but have not yet ordered a real machine:
say so if one of them refuses something its page says it takes.

**Give sitesolide an account, a project or a subscription of its own** where
the provider has them. Credentials reach everything their scope reaches: in a
scope that holds only this machine, they can touch nothing else you run there,
and the provider's console shows at a glance what sitesolide costs you.

## The credentials

They are read, in this order, from:

1. **standard input**, with `--token-stdin`, and from nowhere else then: a
   provider that needs one token takes it alone on its line, one that needs
   several takes `VARIABLE=value` lines, as an environment file holds them;
2. **the environment**, the variables the provider's own tools read;
3. **the provider's own CLI, already signed in**, when the environment lacks
   one: `aws configure export-credentials`, `gcloud auth print-access-token`,
   `az account get-access-token`. Nothing is asked, nothing is written: the
   CLI is only asked what it already holds. A value of the environment that
   is not secret, a project or a region, still wins over the CLI's, and a
   secret is never taken half from one place and half from another.

`sitesolide machine providers` says, for every provider, whether this
workstation holds credentials and where they come from, never what they are.

They are never an option: an option sits in the shell's history and in what
`ps` shows to every user of the workstation. sitesolide sends them to the
provider's API, in a header or a request signature, and nowhere else, never
writes them to a file, and never prints them: every line it prints passes
through a filter that replaces each secret it knows, an access token it
obtained along the way included, with `[token]`.

## The SSH key

The key is, in this order, the one `--ssh-key` names, a `.pub` file or the
SHA256 fingerprint of a key the SSH agent holds; the first of
`~/.ssh/id_ed25519.pub`, `id_ecdsa.pub` and `id_rsa.pub`; else the key the SSH
agent holds. The agent is the one ssh itself asks, `IdentityAgent` in
`~/.ssh/config` when it names one, else `SSH_AUTH_SOCK`: OpenSSH's own, the
macOS keychain's, or a password manager's, 1Password's, Bitwarden's or
Secretive's, which keep their keys out of `~/.ssh`. When the agent holds
several keys and `~/.ssh` none, `create` names each one and stops, since which
key a machine trusts is not guessed: `--ssh-key` then takes its fingerprint, as
`ssh-add -l` prints it. The setup wizard asks instead.

The login that follows the order, and setup's after it, run without a prompt.
A key file behind a passphrase has to be loaded in the agent first, `ssh-add
~/.ssh/id_ed25519`: `create` checks it before ordering anything, and says so,
rather than bill a machine nobody can log in to.

A password manager's agent also asks you to approve each use of a key, and
refuses when nobody does: `create`, waiting for the machine to let its account
in, says so when the agent did not sign with the key. Approve the request, or
run the same command again once you are at the workstation.

## What `create` makes

Every provider makes the same three things, under its own names, and labels
each of them `managed-by=sitesolide` and `sitesolide-machine=<name>`, or tags
them so where the provider has no labels. The labels are how `list` finds them
and how `destroy` tells them from what it must never touch.

| What | Why |
|---|---|
| Your workstation's public key, `--ssh-key` or the first of `~/.ssh/id_ed25519.pub`, `id_ecdsa.pub`, `id_rsa.pub`, else the key the SSH agent holds | the only way in: no password is ever set |
| A firewall named after the machine | inbound TCP 22, 80 and 443, and ICMP, from everywhere; everything else inbound is dropped before it reaches the machine |
| The machine | Debian 13, a public IPv4 that stays the same across a stop and a start, since the DNS records point at it, and IPv6 where the provider routes it |

Before anything is created, `create` reads what could refuse it: a machine
of that name sitesolide did not create (never touched: pick another name), a
type or a location the provider does not sell, a name or a key the provider
would not take, a firewall of that name that is not sitesolide's. A refusal
leaves nothing behind. When the order itself is refused for certain, what this
run had created for it is deleted again, and the refusal lists the types to
try instead. When its outcome is unknown, no answer, a failure on the
provider's side, an answer cut short, nothing is deleted: a machine may be
booting behind it, and deleting its firewall would leave it open. The same
command run again finds what was made and goes on.

It then waits, each wait bounded, for the provider to say the machine runs,
for port 22 to answer, and for the machine to let its account in with the key,
then prints the `setup` command that comes next. Every step is idempotent: a
run interrupted anywhere, or a wait that timed out, is finished by running the
same command again, which finds what the first run made.

It installs nothing and hardens nothing: `sitesolide setup` does both over
SSH, where each step can be checked and run again.

**The account.** Most images let `root` in with the key, and setup connects as
`root`. Where the image refuses root, AWS's Debian images, which let in
`admin`, and the account Google and Azure make for the key, setup connects as
that account, which has sudo without a password, and is told to make the
usual `deploy` account all the same: `next` then reads `sitesolide setup
admin@<ipv4> --zone <your zone> --email <you> --user deploy`.

## Listing

```bash
sitesolide machine list --provider <provider>
```

The machines labelled `managed-by=sitesolide`, with their type, location,
status, addresses and monthly price where the provider gives one. Machines
sitesolide did not create are not listed.

A machine whose run stopped before the machine itself existed, or whose
destroy stopped half way, is listed with the status `incomplete` where it left
billed resources behind, a reserved address above all: `create` with the same
name reuses them, `destroy` removes them, and a refusal of `create` names
them.

## Destroying

```bash
sitesolide machine destroy web --provider <provider>
```

At a terminal, the name is typed back to confirm; anywhere else, `--confirm
web` says it, and a value that is not the name stops everything. A machine
without the `managed-by=sitesolide` label is refused: delete it from the
console if it has to go.

The machine goes first, with its disk and the provider's backups of it where
the provider deletes them with it. Then what was created for it alone: its
firewall, unless something else still uses it, its reserved address. The SSH
key stays, since other machines may be created with it; `--delete-key`
deletes it too, and only when it was uploaded for this machine. A volume or an
address attached to it by hand is never deleted: the provider detaches it and
keeps billing it, and the command says so. On Azure, where everything lives
in one resource group, a disk the group holds that sitesolide did not make
stops the destroy until its owner moves or deletes it. The command ends by
listing what it removed and what it kept, and each provider's page says what
that is there.

**DNS records are not touched.** They live in your zone, not at the provider:
delete the A and AAAA records that pointed at the machine yourself, or they
keep naming an address the provider will give to someone else.

## For agents

`--json` prints one JSON event per line and ends with one `result` or one
`error` carrying a `hint`, as every other command does ([agents.md](agents.md)).
`destroy` never prompts under `--json`: it needs `--confirm <name>`, which an
agent passes only when the owner asked for that machine to be destroyed. The
wizard is for a person at a terminal: an agent runs `machine create`, then
`setup` with its options.

## Tests

Each provider reads `SITESOLIDE_<PROVIDER>_API`, `SITESOLIDE_HETZNER_API` for
Hetzner, as another address than its API, for a local fake of it
(`bin/tests/fake-<provider>.ts`). It takes https, or http on the loopback only,
so that credentials never travel in the clear.
