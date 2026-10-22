# Akamai (Linode) DNS Manager

`sitesolide setup --dns linode-dns` points the zone at the machine through the
API of Akamai's [DNS Manager](https://techdocs.akamai.com/cloud-computing/docs/dns-manager),
the DNS of Linode, with nothing to install on the workstation, and gives Caddy
the module that obtains the zone's wildcard certificate through a DNS-01
challenge, then renews it. What every DNS provider shares is in
[setup.md](../setup.md#dns).

```console
$ read -rs SITESOLIDE_DNS_LINODE_TOKEN && export SITESOLIDE_DNS_LINODE_TOKEN
$ sitesolide setup root@203.0.113.10 --zone example.com --email you@example.com --dns linode-dns
```

## The zone

A **domain** of the DNS Manager, under *Domains* in
[Cloud Manager](https://cloud.linode.com/domains), whose NS records at the
registrar name `ns1.linode.com` to `ns5.linode.com`. That is also how the setup
wizard recognises a zone the DNS Manager serves. Akamai's own Edge DNS, whose
name servers end in `akam.net`, is another product, which sitesolide does not
speak.

The zone may be the domain itself, `example.com`, or a name inside it,
`apps.example.com` in the domain `example.com`: setup looks for the zone, then
for each parent, and the records are then `apps` and `*.apps` in the parent.

A domain the DNS Manager holds as a **secondary**, a copy of another name
server, is refused before anything is written: its records are edited at its
primary.

## The token

A **personal access token** that reaches Domains and nothing else. It is laid
on the machine, where Caddy needs it every two months to renew the
certificate: a token that can also order Linodes would be one break-in away
from all of them. That is why setup reads it from a variable of its own, and
never from `LINODE_TOKEN`, `LINODE_CLI_TOKEN` or linode-cli's configuration,
which usually hold a broader token.

1. In [Cloud Manager](https://cloud.linode.com/profile/tokens), the menu under
   your username at the top right, *API Tokens*, *Create a Personal Access
   Token*.
2. A label, `sitesolide-dns` for instance, and an expiry. **Read/Write** on
   *Domains*, **No Access** on everything else.
3. *Create Token*. It is shown once: put it in your password manager, not in a
   file.

Every record operation asks for the scope `domains:read_write` and nothing
more. Setup reads the domains and the records of the zone and of its wildcard,
then creates, changes or deletes those records; Caddy's module creates the
challenge's TXT record and deletes it once the certificate is issued.

**What it reaches.** Made by the account's own user, the token can change every
record of every domain of the account, mail records included, and delete whole
domains, though setup itself only ever touches the four records below. To
narrow it to this zone, make it as a **restricted user** instead: in Cloud
Manager's *Users & Grants*, *Add a User*, restricted, with **Read-Write** on
this domain alone, **None** on every other, and without the right to add
domains (the grants' `domain` list holds one entry a domain). Then, signed in
as that user, make the token as above: it can do no more than its user. On an
account that has moved to Akamai's Identity and Access, roles replace grants:
Akamai's reference lists `domain_viewer` for reading a domain's records and
`domain_admin` for changing or deleting them, on that domain.

**Its expiry.** Caddy renews the certificate with it every two months: once the
token expires, renewals fail, and the certificate lapses a month later. Choose
an expiry past the machine's life, or make a new token before it expires and
run setup again with it.

The token is 64 hexadecimal characters.

## What setup creates

| Name | Type | Value | TTL |
|---|---|---|---|
| *(empty)* | A | the machine's IPv4 | 300 |
| `*` | A | the machine's IPv4 | 300 |
| *(empty)* | AAAA | the machine's IPv6, when it has one | 300 |
| `*` | AAAA | the machine's IPv6, when it has one | 300 |

Names are relative to the domain, as the DNS Manager writes them, the empty
name for the domain itself: `apps` and `*.apps` for `apps.example.com` held in
`example.com`. Three hundred seconds is the lowest TTL Akamai's reference lists
for a record. A record whose answer at creation carries another TTL, as
DNSControl reports the API does, has it set again at once.

A record that already says the same is left as it is. One that points
elsewhere is refused, listed, and nothing is written: an address that is not
the machine's, a CNAME, an AAAA when the machine has no IPv6. `--dns-replace`
replaces them, the owner's decision: deletions first, since a CNAME has to go
before an address record can take its name, then the changes, then the new
records. Records of other types, mail and text above all, are never touched.

## What Caddy keeps on the machine

Setup adds the module `github.com/caddy-dns/linode` to Caddy with
`caddy add-package`; `caddy list-modules` then lists `dns.providers.linode`.

The token is in `/etc/caddy/cloudflare.env`, root:caddy 0640, the file Caddy's
unit loads whatever the provider: the name is the first provider's, and
machines in service load it by that name.

```
SITESOLIDE_DNS_LINODE_TOKEN=...
```

The zone's `tls` block, in `/etc/caddy/tls-zone.caddy`, names the module and
reads the token from Caddy's environment; the file itself holds no secret:

```caddyfile
dns linode {env.SITESOLIDE_DNS_LINODE_TOKEN}
dns_ttl 30s
propagation_timeout 20m
```

The module replaces the placeholder when Caddy starts (its `Provision` runs
Caddy's replacer on the token, `{env.*}` included). For each certificate it
creates a TXT record at `_acme-challenge.<zone>` in the domain that holds the
zone, and deletes it once the certificate is issued.

The two other lines are the module's own advice, adapted. `dns_ttl 30s` gives
the challenge's record a short TTL: without it, the record takes the domain's
default, a day, and a resolver that read a failed attempt's value could keep
it through the next one. The DNS Manager rounds a TTL it does not take to its
nearest value. `propagation_timeout 20m` lets Caddy wait up to twenty minutes
for the record to reach the five name servers before it asks for the
certificate, rather than its default two: the DNS Manager has been said to
publish a change within a minute, and only every quarter of an hour.

To change the token, make a new one as above and run setup again with it: a
value different from the machine's replaces it, and Caddy reads it at its next
start. Then revoke the old one under *API Tokens*.

## The variables

| Variable | What it holds |
|---|---|
| `SITESOLIDE_DNS_LINODE_TOKEN` | the personal access token, 64 hexadecimal characters |

It is read from the environment, from standard input with
`--dns-credentials-stdin`, or typed at a prompt that does not echo; never from
an option. It travels in the Authorization header of Akamai's API and nowhere
else, never in an address or a message, where it is replaced should a line
from Akamai ever carry it.

## Tests

`SITESOLIDE_LINODE_DNS_API` points setup at another address than
`https://api.linode.com/v4`, for a local fake of the API
(`bin/tests/fake-dns-linode-dns.ts`). It takes https, or http on the loopback
only, so that the token never travels in the clear.
