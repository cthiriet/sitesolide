# Vultr DNS

`sitesolide setup --dns vultr-dns` points the zone at the machine through the
API of [Vultr's DNS](https://docs.vultr.com/products/network/dns), with
nothing to install on the workstation, and gives Caddy the module that obtains
the zone's wildcard certificate through a DNS-01 challenge, then renews it.
What every DNS provider shares is in [setup.md](../setup.md#dns).

```console
$ read -rs SITESOLIDE_DNS_VULTR_API_KEY && export SITESOLIDE_DNS_VULTR_API_KEY
$ sitesolide setup root@203.0.113.10 --zone example.com --email you@example.com --dns vultr-dns
```

## The zone

A **DNS domain** of Vultr, under *Network*, *DNS* in the
[customer portal](https://my.vultr.com/), whose NS records at the registrar
name `ns1.vultr.com` and `ns2.vultr.com`. That is also how the setup wizard
recognises a zone Vultr serves.

The zone may be the domain itself, `example.com`, or a name inside it,
`apps.example.com` in the domain `example.com`: setup looks for the zone, then
for each parent, and the records are then `apps` and `*.apps` in the parent.

## The API key

**Not the account's own key.** A Vultr API key carries the permissions of its
user, and the account's own user may do everything: billing, every instance,
every other domain. This key is laid on the machine, where Caddy needs it
every two months to renew the certificate, so it belongs to a user that may do
DNS and nothing else. That is also why setup reads it from a variable of its
own, and never from `VULTR_API_KEY` or vultr-cli's configuration, which
usually hold a broader key. In the [customer portal](https://my.vultr.com/),
click the organization's name, then *Manage Organization*:

1. *Permission Policies*, **+**: name it `sitesolide-dns`, and allow, in the
   *Network* category, the DNS actions and only those: `network.dns.List`,
   `network.dns.Read`, `network.dns.Create`, `network.dns.Update` and
   `network.dns.Delete` (`network.dns.*`).
2. *Users*, **+**, *User Type* **Service User**: give it that policy, through a
   role or a group, or attached to the user directly.
3. Open the user, then under *API Access*, *Create API Key*. The key is shown
   once: put it in your password manager, not in a file.

| Action | Who needs it |
|---|---|
| `network.dns.List` | setup, to find the domain among the organization's. |
| `network.dns.Read` | setup, to read the records of the zone and of its wildcard before it changes anything. |
| `network.dns.Create` | setup, to create the records; Caddy's module, to create the challenge's TXT record. |
| `network.dns.Update` | setup, to change what `--dns-replace` replaces. |
| `network.dns.Delete` | setup, to delete what `--dns-replace` replaces; Caddy's module, to delete the challenge's record once the certificate is issued. |

**What it still reaches.** Vultr's DNS actions cover every DNS domain of the
organization, and `network.dns.Create` and `network.dns.Delete` cover whole
domains as well as records
([network actions](https://docs.vultr.com/platform/iam/policies/iam-policy-actions-map/network-actions)):
Vultr documents no narrower grant for DNS. The key can change every record of
every domain, though setup itself only ever touches the four below, and can
reach nothing else: no instance, no billing.

**Its access control list.** The same *API Access* holds an *Access Control
List*, which starts with *Any IPv4* and *Any IPv6*. Vultr refuses a call from
an address the list does not allow, with a 401 that setup reports as a refused
key. This key is used from two places: the workstation, where setup creates the
records, and the machine, where Caddy renews the certificate. Restrict the list
to the machine's addresses and the workstation's, or leave it open: a list
without the machine's addresses lets setup succeed and every renewal fail.

The key is 36 letters and digits.

## What setup creates

| Name | Type | Value | TTL |
|---|---|---|---|
| *(empty)* | A | the machine's IPv4 | 120 |
| `*` | A | the machine's IPv4 | 120 |
| *(empty)* | AAAA | the machine's IPv6, when it has one | 120 |
| `*` | AAAA | the machine's IPv6, when it has one | 120 |

Names are relative to the domain, as Vultr writes them, the empty name for the
domain itself: `apps` and `*.apps` for `apps.example.com` held in
`example.com`. Vultr documents no minimum TTL; 120 seconds is a value its API
has long accepted, and the console's default is 300.

A record that already says the same is left as it is. One that points
elsewhere is refused, listed, and nothing is written: an address that is not
the machine's, a CNAME, an AAAA when the machine has no IPv6. `--dns-replace`
replaces them, the owner's decision: deletions first, since a CNAME has to go
before an address record can take its name, then the changes, then the new
records. Vultr refuses records of one name and type whose TTLs differ, and
that order never leaves two: a record is changed only once the others of its
name and type are gone. Records of other types, mail and text above all, are
never touched.

## What Caddy keeps on the machine

Setup adds the module `github.com/caddy-dns/vultr` to Caddy with
`caddy add-package`; `caddy list-modules` then lists `dns.providers.vultr`.

The key is in `/etc/caddy/cloudflare.env`, root:caddy 0640, the file Caddy's
unit loads whatever the provider: the name is the first provider's, and
machines in service load it by that name.

```
SITESOLIDE_DNS_VULTR_API_KEY=...
```

The zone's `tls` block, in `/etc/caddy/tls-zone.caddy`, names the module and
reads the key from Caddy's environment; the file itself holds no secret:

```caddyfile
dns vultr {env.SITESOLIDE_DNS_VULTR_API_KEY}
```

The key is the directive's argument rather than an `api_token` line in a
block: the module's parser stores that line's own name in place of its value.
The module replaces the placeholder when Caddy starts (its `Provision` runs
Caddy's replacer on the key, `{env.*}` included). For each certificate it
creates a TXT record at `_acme-challenge.<zone>` in the domain that holds the
zone, and deletes it once the certificate is issued.

To change the key, make a new one as above and run setup again with it: a
value different from the machine's replaces it, and Caddy reads it at its next
start. Then delete the old one from the user's *API Access*.

## The variables

| Variable | What it holds |
|---|---|
| `SITESOLIDE_DNS_VULTR_API_KEY` | the service user's API key, 36 letters and digits |

It is read from the environment, from standard input with
`--dns-credentials-stdin`, or typed at a prompt that does not echo; never from
an option. It travels in the Authorization header of Vultr's API and nowhere
else, never in an address or a message, where it is replaced should a line
from Vultr ever carry it.

## Tests

`SITESOLIDE_VULTR_DNS_API` points setup at another address than
`https://api.vultr.com/v2`, for a local fake of the API
(`bin/tests/fake-dns-vultr-dns.ts`), which enforces the policy's actions and
refuses records of one name and type whose TTLs differ. It takes https, or
http on the loopback only, so that the key never travels in the clear.
