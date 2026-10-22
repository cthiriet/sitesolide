# Amazon Route 53

`sitesolide setup --dns route53` points the zone at the machine through the API
of [Amazon Route 53](https://aws.amazon.com/route53/), with nothing to install
on the workstation, and gives Caddy the module that obtains the zone's wildcard
certificate through a DNS-01 challenge, then renews it. What every DNS provider
shares is in [setup.md](../setup.md#dns).

```console
$ read -rs SITESOLIDE_DNS_ROUTE53_ACCESS_KEY_ID && export SITESOLIDE_DNS_ROUTE53_ACCESS_KEY_ID
$ read -rs SITESOLIDE_DNS_ROUTE53_SECRET_ACCESS_KEY && export SITESOLIDE_DNS_ROUTE53_SECRET_ACCESS_KEY
$ sitesolide setup root@203.0.113.10 --zone example.com --email you@example.com --dns route53
```

## The zone

A **public hosted zone** of Route 53, the one the domain's NS records name:
`ns-1372.awsdns-43.org`, `ns-81.awsdns-10.com`, and so on, a `.com`, a `.net`,
a `.org` and a `.co.uk`. That is also how the setup wizard recognises a zone
Route 53 serves. Name servers of your own, a reusable delegation set under
your domain, are not recognised by the wizard: say `--dns route53`.

The zone may be the hosted zone itself, `example.com`, or a name inside it,
`apps.example.com` in the hosted zone `example.com`: setup looks for the zone,
then for each parent, and the records are then `apps.example.com` and
`*.apps.example.com` in the parent.

A **private hosted zone**, which answers inside a VPC only, is never used.
Setup refuses, rather than guess, two cases where the records or the
certificate's challenge could land in a zone the internet does not read: two
public hosted zones of the same name, of which only the one the NS records
name is served; and a private hosted zone listed before the public one of the
same name, since Caddy's module takes the first hosted zone of a name that
Route 53 lists.

## The key

An access key of an **IAM user of its own**, whose policy reaches this zone
and nothing else. It is laid on the machine, where Caddy needs it every two
months to renew the certificate: a key that can also order machines, or change
another zone, would be one break-in away from all of it. That is why setup
reads it from variables of its own and never from `AWS_ACCESS_KEY_ID`, a
profile or the `aws` CLI, which usually hold a broader key. It must be a
long-term key, starting with `AKIA`: a temporary one, `ASIA`, expires within
hours and could not renew anything.

1. In the [Route 53 console](https://console.aws.amazon.com/route53/v2/hostedzones),
   *Hosted zones*, open the zone and copy its *Hosted zone ID*,
   `Z0123456789ABCDEFGHIJ` below. For `apps.example.com` held in
   `example.com`, it is the ID of `example.com`.
2. In the [IAM console](https://console.aws.amazon.com/iam/), *Policies*,
   *Create policy*, the *JSON* tab, this document, with your hosted zone ID in
   place of `Z0123456789ABCDEFGHIJ` and your zone in place of `example.com`
   (`\\052` is JSON for `\052`, the way Route 53's conditions write the
   wildcard's `*`):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "FindTheZone",
         "Effect": "Allow",
         "Action": ["route53:ListHostedZonesByName", "route53:ListHostedZones"],
         "Resource": "*"
       },
       {
         "Sid": "ReadTheZone",
         "Effect": "Allow",
         "Action": "route53:ListResourceRecordSets",
         "Resource": "arn:aws:route53:::hostedzone/Z0123456789ABCDEFGHIJ"
       },
       {
         "Sid": "PointTheZoneAtTheMachine",
         "Effect": "Allow",
         "Action": "route53:ChangeResourceRecordSets",
         "Resource": "arn:aws:route53:::hostedzone/Z0123456789ABCDEFGHIJ",
         "Condition": {
           "ForAllValues:StringEquals": {
             "route53:ChangeResourceRecordSetsNormalizedRecordNames": ["example.com", "\\052.example.com"],
             "route53:ChangeResourceRecordSetsRecordTypes": ["A", "AAAA", "CNAME"]
           }
         }
       },
       {
         "Sid": "AnswerTheChallenge",
         "Effect": "Allow",
         "Action": "route53:ChangeResourceRecordSets",
         "Resource": "arn:aws:route53:::hostedzone/Z0123456789ABCDEFGHIJ",
         "Condition": {
           "ForAllValues:StringLike": {
             "route53:ChangeResourceRecordSetsNormalizedRecordNames": ["_acme-challenge.example.com", "_acme-challenge.*.example.com"]
           },
           "ForAllValues:StringEquals": {
             "route53:ChangeResourceRecordSetsRecordTypes": ["TXT"]
           }
         }
       },
       {
         "Sid": "FollowTheChanges",
         "Effect": "Allow",
         "Action": "route53:GetChange",
         "Resource": "arn:aws:route53:::change/*"
       }
     ]
   }
   ```

3. *Users*, *Create user*, `sitesolide-dns` for instance, without console
   access; *Attach policies directly*, that policy and no other.
4. The user, *Security credentials*, *Create access key*, for an application
   running outside AWS. The secret is shown once: put both values in your
   password manager, not in a file.

What each statement is for:

| Statement | Who needs it |
|---|---|
| `FindTheZone` | setup and Caddy's module, to find the hosted zone's ID by its name, with `ListHostedZonesByName`; `ListHostedZones`, which the module's own documentation also asks for, shows nothing more. IAM cannot scope either to a zone: they let the key list the names and IDs of the account's hosted zones, and nothing in them. |
| `ReadTheZone` | setup, to read the records of the zone and its wildcard before it changes anything. |
| `PointTheZoneAtTheMachine` | setup, and on these two names only: the A and AAAA it creates, and what `--dns-replace` replaces, a CNAME included. |
| `AnswerTheChallenge` | Caddy's module, which writes a TXT record at `_acme-challenge.<zone>` for each certificate and deletes it once the certificate is issued. The second name covers a certificate Caddy would obtain for a single site, `_acme-challenge.<site>.<zone>`. |
| `FollowTheChanges` | Caddy's module, when it is told to wait for a change to reach every Route 53 server. Setup does not wait: the records propagate, within a minute, while the machine installs. Read only. |

Without the two conditions, the key could change any record of the hosted
zone, its mail and its NS records included. Route 53 checks the names in
their normalized form, lowercase, without the trailing dot, the wildcard
written `\052`
([condition keys](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/specifying-conditions-route53.html)).

## What setup creates

| Name | Type | Value | TTL |
|---|---|---|---|
| `<zone>` | A | the machine's IPv4 | 300 |
| `*.<zone>` | A | the machine's IPv4 | 300 |
| `<zone>` | AAAA | the machine's IPv6, when it has one | 300 |
| `*.<zone>` | AAAA | the machine's IPv6, when it has one | 300 |

A record that already says the same is left as it is. One that points
elsewhere is refused, listed, and nothing is written: an address that is not
the machine's, a CNAME, an AAAA when the machine has no IPv6, an **alias** to
an AWS resource, shown as `*.example.com A alias d111111abcdef8.cloudfront.net`.
`--dns-replace` replaces them, the owner's decision. Records of other types,
mail and text above all, are never touched.

Route 53 keeps the values of a name and a type together, in a record set.
Replacing one value of a set changes that value alone: its other values, its
TTL, its routing policy and its health check are kept. Each change is one
transactional batch that deletes the set exactly as setup read it and creates
it as it must be: a set someone changed in between makes Route 53 refuse the
whole batch, quoted, rather than be overwritten. Running setup again reads the
zone afresh.

## What Caddy keeps on the machine

Setup adds the module `github.com/caddy-dns/route53` to Caddy with
`caddy add-package`; `caddy list-modules` then lists `dns.providers.route53`.

The two values are in `/etc/caddy/cloudflare.env`, root:caddy 0640, the file
Caddy's unit loads whatever the provider: the name is the first provider's,
and machines in service load it by that name.

```
SITESOLIDE_DNS_ROUTE53_ACCESS_KEY_ID=AKIA...
SITESOLIDE_DNS_ROUTE53_SECRET_ACCESS_KEY=...
```

The zone's `tls` block, in `/etc/caddy/tls-zone.caddy`, names the module and
reads both from Caddy's environment; the file itself holds no secret:

```caddyfile
dns route53 {
	access_key_id {env.SITESOLIDE_DNS_ROUTE53_ACCESS_KEY_ID}
	secret_access_key {env.SITESOLIDE_DNS_ROUTE53_SECRET_ACCESS_KEY}
	region us-east-1
}
```

The module resolves the placeholders of `access_key_id`, `secret_access_key`
and `region` when Caddy starts. Both credentials are named explicitly: without
them, the AWS SDK inside the module would look for `AWS_ACCESS_KEY_ID`, the
`~/.aws` files, or the role of an EC2 instance. The region is Route 53's own,
which is global, rather than whatever `AWS_REGION` says.

To change the key, make a new one as above and run setup again with it: a
value different from the machine's replaces it, and Caddy reads it at its next
start. Then make the old key inactive in IAM, and delete it.

## The variables

| Variable | What it holds |
|---|---|
| `SITESOLIDE_DNS_ROUTE53_ACCESS_KEY_ID` | the access key ID, `AKIA` and 16 characters |
| `SITESOLIDE_DNS_ROUTE53_SECRET_ACCESS_KEY` | its secret access key, 40 characters |

They are read from the environment, from standard input with
`--dns-credentials-stdin`, one `VARIABLE=value` line each, or typed at a prompt
that does not echo; never from an option. Both are secret to sitesolide: the
access key ID travels in the Authorization header of each request, as
Signature Version 4 requires, the secret only as an HMAC of the request, and
neither in an address or a message, where they are replaced should a line from
AWS ever carry one.

## Tests

`SITESOLIDE_ROUTE53_DNS_API` points setup at another address than
`https://route53.amazonaws.com`, for a local fake of the API
(`bin/tests/fake-dns-route53.ts`), which checks every request's signature as
AWS does. It takes https, or http on the loopback only, so that the
credentials never travel in the clear.
