# Amazon EC2

`sitesolide machine create --provider aws` orders an instance from
[Amazon EC2](https://aws.amazon.com/ec2/) through its Query API, with nothing
to install on the workstation and no state file to keep: no SDK, no Terraform,
and the `aws` CLI only if you want it to hand over its credentials. What every
provider shares, where credentials come from and how `list` and `destroy`
decide, is in [machine.md](../machine.md).

```console
$ aws sso login --profile sitesolide && export AWS_PROFILE=sitesolide
$ sitesolide machine create --provider aws --name web
-> machine web at AWS: t3.small at eu-central-1, debian-13
   credentials: the aws CLI, profile sitesolide
...
-> ready
   name      web
   type      t3.small at eu-central-1
   ipv4      203.0.113.10

next: sitesolide setup admin@203.0.113.10 --zone <your zone> --email <you> --user deploy
```

## The credentials

An access key, the pair `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, plus
`AWS_SESSION_TOKEN` when the key is temporary. They are read from those
variables, the ones every AWS tool reads, or from standard input with
`--token-stdin`, one `VARIABLE=value` line each:

```bash
<your password manager's read command> | sitesolide machine list --provider aws --token-stdin
```

When the environment holds none, sitesolide asks the `aws` CLI, if it is
installed, for the credentials it already resolves:
`aws configure export-credentials --format process`. That covers a profile of
`~/.aws/credentials`, `AWS_PROFILE`, and IAM Identity Center after
`aws sso login`, whose keys are temporary and expire on their own, which makes
it the better choice. Nothing is asked and nothing is written; the CLI's output
is read, never repeated.

**Give sitesolide an AWS account of its own**, a member account of your
organisation for instance. A key reaches everything its policy allows in its
account: in an account that holds only this machine, it can touch nothing else
you run at AWS, and the bill shows at a glance what sitesolide costs you.

**Give the key only the EC2 permissions it uses.** In the
[IAM console](https://console.aws.amazon.com/iam/): *Policies*, *Create
policy*, the *JSON* tab, this document:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SitesolideMachines",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeRegions",
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeInstanceTypeOfferings",
        "ec2:DescribeImages",
        "ec2:DescribeVpcs",
        "ec2:DescribeSubnets",
        "ec2:DescribeKeyPairs",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeAddresses",
        "ec2:DescribeVolumes",
        "ec2:ImportKeyPair",
        "ec2:CreateSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:AllocateAddress",
        "ec2:AssociateAddress",
        "ec2:RunInstances",
        "ec2:CreateTags",
        "ec2:TerminateInstances",
        "ec2:ReleaseAddress",
        "ec2:DeleteSecurityGroup",
        "ec2:DeleteKeyPair"
      ],
      "Resource": "*"
    }
  ]
}
```

`ec2:CreateTags` is there because every resource is tagged as it is created,
which AWS counts as tagging. The last four actions are the ones that delete.
To have the policy itself keep them to what sitesolide created, a second
statement *added* beside this one is not enough: IAM grants what any Allow
grants
([policy evaluation](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html)).
Either move the four out of the statement above into one of their own that
carries the condition, or add a Deny that refuses them on anything else:

```json
{
  "Sid": "OnlyWhatSitesolideCreated",
  "Effect": "Deny",
  "Action": ["ec2:TerminateInstances", "ec2:ReleaseAddress", "ec2:DeleteSecurityGroup", "ec2:DeleteKeyPair"],
  "Resource": "*",
  "Condition": { "StringNotEquals": { "aws:ResourceTag/managed-by": "sitesolide" } }
}
```

Then attach it to whoever uses sitesolide:

- **a person of IAM Identity Center**: a permission set with this policy, then
  `aws configure sso` and `aws sso login` on the workstation;
- **an IAM user**: *Users*, *Create user*, without console access, *Attach
  policies directly*, this policy; then the user, *Security credentials*,
  *Create access key*, for the *Command Line Interface* use. The secret is
  shown once: put it in your password manager, not in a file.

The credentials only ever leave in a Signature Version 4 signature: the
access key ID in the Authorization header of each request, the secret key as
an HMAC of the request and nowhere at all, the session token in the
`X-Amz-Security-Token` header. Never in an address, a message or a file; all
three are secret to sitesolide, and replaced with `[token]` should a line ever
carry one.

## Regions and types

`--location` takes a region, `eu-central-1`, and `--type` an instance type,
`t3.small`. The defaults are `t3.small`, a current x86 type with 2 GB of
memory, in `eu-central-1`, Frankfurt; `AWS_REGION`, or `AWS_DEFAULT_REGION`,
moves the default region, as for the `aws` CLI. A region must be enabled for
the account: the refusal lists those that are, and the others are enabled from
the console's *Account* page, *AWS Regions*.

**An account on AWS's Free plan**, which any account created since 15 July 2025
is until it is upgraded, may only order the types AWS marks *Free Tier
eligible*
([the list](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html)):
`t3.small` is one, which is why it is the default rather than `t3a.small`,
slightly cheaper but refused there. Another type is refused by the order
itself; the refusal lists the eligible types the region sells, and the other
way out, to upgrade the account from the Billing console, *Upgrade plan*. The
wizard offers the eligible types first, and says so beside them.

`t3`, `t3a` and `t4g` types are burstable: they run below their full speed on
average and spend credits above it. AWS starts them in its *unlimited* mode,
which bills the credits spent beyond those earned rather than slowing the
machine down; `sitesolide machine` leaves that as AWS sets it.
`m7i-flex.large`, `c7i-flex.large` and the other `m7` types are not burstable.
The wizard offers the types it knows to fit, among those the region sells; any
other type may be given with `--type`, Graviton ones included, `t4g` or `m7g`,
on Debian's arm64 image.

EC2 names nothing uniquely: an instance's name is its `Name` tag, and a name
could be given twice, in two regions. sitesolide keeps one machine per name in
the whole account: `create` looks in every enabled region first, and `list`,
`find` and `destroy` do too. A region the credentials may not read, which an
organisation's policy may forbid, is skipped, and `create` says which.

## What `create` makes

Four resources in the region, and the instance's disk, each tagged
`managed-by=sitesolide`, `sitesolide-machine=<name>` and `Name=<name>`. The
tags are how `list` finds them and how `destroy` tells them from what it must
never touch.

| Resource | What it is |
|---|---|
| Key pair | Your workstation's public key, `--ssh-key` or the first of `~/.ssh/id_ed25519.pub`, `id_ecdsa.pub`, `id_rsa.pub`. AWS imports ed25519 and RSA keys only: an ECDSA key is refused before anything is created. A key the region already holds, under any name, is reused; otherwise it is imported as `sitesolide-<name>`, without its comment. |
| Security group `sitesolide-<name>` | In the region's default VPC: inbound TCP 22, 80 and 443, and ICMP, from `0.0.0.0/0` and `::/0`; everything else inbound is dropped before it reaches the machine. |
| Elastic IP | The machine's public IPv4. The address an instance gets by default changes at every stop and start, and your DNS records point at it: the elastic IP stays. |
| Instance `<name>` | Debian 13 from Debian's own account (`136693071363`, the newest `debian-13-amd64-*` or `debian-13-arm64-*` image), in a default subnet of a zone that sells the type, with the key, the group, instance metadata through IMDSv2 only, and a 20 GB gp3 root volume, encrypted with the account's default EBS key and deleted with the instance. |

Before anything is created, `create` reads what could refuse it: an instance of
that name sitesolide did not create, in any region (it is never touched: pick
another name), a region the account has not enabled, a type the region does
not sell or that no zone with a default subnet sells (the refusal lists types
it does sell), Debian's image for the type's architecture, the default VPC, and
a security group of that name that is not sitesolide's. A refusal leaves
nothing behind.

**A region without a default VPC is refused**: sitesolide launches into it, and
creates no network of its own. Its owner creates one from the VPC console,
*Your VPCs*, *Actions*, *Create default VPC*.

If AWS refuses the order itself, for want of capacity in the zone, a quota
reached or the Free plan, the refusal suggests other types or another
`--location`, and the key pair, the security group and the elastic IP this run
created for the instance are deleted again. What an earlier run made is left
as it was, and the refusal names it, with the `destroy` command that removes
it: an elastic IP is billed by the hour while it exists.

The order carries a client token derived from the elastic IP it was made with:
asked again, with the same token, AWS returns the instance that order created
rather than a second one. So an order that meets a key pair or a group just
created, which AWS may not know everywhere for a moment, or a failure on AWS's
side that passes, is asked again for a minute. If its answer is still lost
after that, nothing is deleted, since the instance may exist; the next run
reuses the same address, hence the same token, and returns that instance if
there is one.

It then waits for the instance to run, associates the elastic IP with it, then
waits for port 22 to accept a connection, each wait bounded, and prints the
`setup` command that comes next. Every step is idempotent: a run interrupted
anywhere, or a wait that timed out, is finished by running the same command
again, which finds what the first run made. What an interrupted run left
without an instance is reused by the next one; meanwhile, `list` shows it as an
*incomplete* machine, and `destroy` removes it if you give up.

It installs nothing and hardens nothing. The instance carries no user data:
`sitesolide setup` does the hardening over SSH, where it can be checked and run
again. Debian's images let in `admin` with the key, with sudo and no password,
and refuse root: setup connects as `admin` and does what needs root through
`sudo -n`, then makes the deploy account the command printed names,
`--user deploy`. The instance's interface carries a private address, which AWS
maps to the elastic IP: setup is given the public one, which its DNS records
name.

## What it costs

AWS bills, until each one is deleted:

- the instance, by the second while it runs, at the price of its type and
  region, plus the credits a burstable type spends beyond those it earns;
- its 20 GB gp3 volume, by the GB and the month, running or stopped;
- **the public IPv4 address, by the hour, whether the instance runs or not**:
  AWS bills every public IPv4 address, an elastic IP associated or idle
  included;
- the traffic leaving AWS for the internet, beyond a monthly allowance.

The prices are on AWS's pages for
[instances](https://aws.amazon.com/ec2/pricing/on-demand/),
[volumes](https://aws.amazon.com/ebs/pricing/) and
[public IPv4 addresses](https://aws.amazon.com/vpc/pricing/), and, for your
account, in the console's *Billing and Cost Management*. The EC2 API gives no
price: `machine list` shows none, and a refused `--type` lists sizes without
them.

`--backups` means nothing here: sitesolide does not set up AWS's own copies of
the machine. Its own backups, restic to a bucket, are what keeps the data.

## Listing

```bash
sitesolide machine list --provider aws
```

The instances tagged `managed-by=sitesolide` in every enabled region, with
their type, region, state and addresses. Instances sitesolide did not create
are not listed, nor those already terminated.

A machine whose instance is missing, but for which an elastic IP or a security
group remains, in any region, is listed too, with the state `incomplete`: an
order that never went through, or a destroy that stopped halfway. Its elastic
IP is billed by the hour all the same. `create` with its name reuses what it
left; `destroy` removes it. A key pair alone does not make a machine listed,
since `destroy` keeps it on purpose and it costs nothing; `destroy <name>
--delete-key` still finds it.

## Destroying

```bash
sitesolide machine destroy web --provider aws
```

At a terminal, the name is typed back to confirm; anywhere else, `--confirm
web` says it, and a value that is not the name stops everything. An instance
without the `managed-by=sitesolide` tag is refused: terminate it from the
console if it has to go.

The instance is terminated first, and waited for. Its root volume goes with
it, and so does every volume attached since that is marked to be deleted on
termination: each of those is named among what was removed, since its data is
gone too. A volume that stays is kept and said, since it is billed until
someone deletes it.

Then, in every enabled region, what was created for the machine: the elastic
IPs allocated for it are released, while one that sitesolide did not allocate
is kept, and said, since AWS bills it until someone releases it; the security
group goes, unless another instance uses it, AWS holding it for a moment after
the instance went, which is waited out for three minutes at most. The key pair
stays, since other machines may be created with it; `--delete-key` deletes it
too, and only when it was imported for this machine. The command ends by
listing what it removed and what it kept.

An incomplete machine has no instance to terminate: `destroy` removes what it
left, in every region. A destroy interrupted after the termination is
finished the same way, by running it again.

**DNS records are not touched.** They live in your zone, not at AWS: delete
the A record that pointed at the machine yourself, or it keeps naming an
address AWS will give to someone else.

## Tests

`SITESOLIDE_AWS_API` points every region at another address than
`https://ec2.<region>.amazonaws.com`, for a local fake of the API
(`clouds/fakes/aws.ts`). Requests are still signed for their region and for
`ec2`, and the fake checks each signature as AWS does. It takes https, or http
on the loopback only, so that the credentials never travel in the clear.
