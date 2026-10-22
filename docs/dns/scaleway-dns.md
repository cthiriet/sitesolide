# Scaleway Domains and DNS

`sitesolide setup --dns scaleway-dns` points the zone at the machine through
the API of [Scaleway Domains and DNS](https://www.scaleway.com/en/domains-name/),
with nothing to install on the workstation, and gives Caddy the module that
obtains the zone's wildcard certificate through a DNS-01 challenge, then renews
it. What every DNS provider shares is in [setup.md](../setup.md#dns).

```console
$ read -rs SITESOLIDE_DNS_SCALEWAY_SECRET_KEY && export SITESOLIDE_DNS_SCALEWAY_SECRET_KEY
$ export SITESOLIDE_DNS_SCALEWAY_ORGANIZATION_ID=<your organization ID>
$ sitesolide setup root@203.0.113.10 --zone example.com --email you@example.com --dns scaleway-dns
```

## The zone

A **DNS zone of Scaleway Domains and DNS** that uses Scaleway's own name
servers, `ns0.dom.scw.cloud` and `ns1.dom.scw.cloud`: a domain registered at
Scaleway, or an external domain added to it and pointed there. That is how the
setup wizard recognises a zone Scaleway serves.

The zone may be the Scaleway zone itself, `example.com`, or a name inside it,
`apps.example.com` in the zone `example.com`: setup looks for the zone, then
for each parent, and the records are then `apps.example.com` and
`*.apps.example.com` in the parent. A sub-zone of its own at Scaleway,
`apps.example.com` created as a DNS zone, is used as it is.

## The API key

The secret key of an API key of an **IAM application whose only policy gives
`DomainsDNSFullAccess` on the project that holds the zone**. It is laid on the
machine, where Caddy needs it every two months to renew the certificate: a key
that can also order Instances would be one break-in away from all of it. That
is why setup reads it from a variable of its own and never from
`SCW_SECRET_KEY`, which the scw CLI and `sitesolide machine` read.

Scaleway scopes a permission set to a project or to the whole organization,
never to a single zone: its resource-level conditions cover IAM, Key Manager
and Secret Manager alone. `DomainsDNSFullAccess` is the narrowest set that
writes records (`DomainsDNSReadOnly` only reads), and it reaches every zone,
and every domain, of the project. Keep the zone in a project of its own, made
for it, so that the key reaches nothing else.

1. In the [Scaleway console](https://console.scaleway.com/), *Organization
   settings*: copy the *Organization ID*. It is no secret.
2. *IAM*, *Applications*, *Create application*, `sitesolide-dns` for instance.
3. *IAM*, *Policies*, *Create policy*, for that application, with one rule:
   the scope *Access to resources*, the project that holds the zone and no
   other, the permission set **DomainsDNSFullAccess** (under *Domains & Web
   Hosting*) and no other.
4. The application, *API keys*, *Generate an API key*. The secret key is shown
   once: put it in your password manager, not in a file. The access key, the
   `SCW...` identifier shown beside it, is not needed.

Leave the key without an expiration date, or mind the date: past it, renewals
fail.

## What setup creates

| Name | Type | Value | TTL |
|---|---|---|---|
| `<zone>` | A | the machine's IPv4 | 60 |
| `*.<zone>` | A | the machine's IPv4 | 60 |
| `<zone>` | AAAA | the machine's IPv6, when it has one | 60 |
| `*.<zone>` | AAAA | the machine's IPv6, when it has one | 60 |

A record that already says the same is left as it is. One that points
elsewhere is refused, listed, and nothing is written: an address that is not
the machine's, a CNAME, an AAAA when the machine has no IPv6. `--dns-replace`
replaces them, the owner's decision. Records of other types, mail and text
above all, and the zone's NS, are never touched.

Scaleway keeps each value as a record of its own, with an id: setup changes or
deletes a record by that id, which leaves every other record of the name, of
any type, as it was, and a record it replaces keeps its TTL. Each change asks
Scaleway not to create a zone that would not exist, and Scaleway applies and
versions it at once.

## What Caddy keeps on the machine

Setup adds the module `github.com/caddy-dns/scaleway` to Caddy with
`caddy add-package`; `caddy list-modules` then lists `dns.providers.scaleway`.

The two values are in `/etc/caddy/cloudflare.env`, root:caddy 0640, the file
Caddy's unit loads whatever the provider: the name is the first provider's, and
machines in service load it by that name.

```
SITESOLIDE_DNS_SCALEWAY_SECRET_KEY=...
SITESOLIDE_DNS_SCALEWAY_ORGANIZATION_ID=...
```

The zone's `tls` block, in `/etc/caddy/tls-zone.caddy`, names the module and
reads both from Caddy's environment; the file itself holds no secret:

```caddyfile
dns scaleway {
	secret_key {env.SITESOLIDE_DNS_SCALEWAY_SECRET_KEY}
	organization_id {env.SITESOLIDE_DNS_SCALEWAY_ORGANIZATION_ID}
}
```

The module resolves both placeholders when Caddy starts, and refuses to start
without an organization ID, although the calls it makes, to the records of the
zone, do not send it.

To change the key, generate a new one as above and run setup again with it: a
value different from the machine's replaces it, and Caddy reads it at its next
start. Then delete the old key from the application's *API keys*.

## The variables

| Variable | What it holds |
|---|---|
| `SITESOLIDE_DNS_SCALEWAY_SECRET_KEY` | the API key's secret key, a UUID |
| `SITESOLIDE_DNS_SCALEWAY_ORGANIZATION_ID` | the organization's ID, a UUID, not secret |

They are read from the environment, from standard input with
`--dns-credentials-stdin`, one `VARIABLE=value` line each, or typed at a prompt,
the secret key at one that does not echo; never the secret key from an option.
The secret key travels in the X-Auth-Token header of each request and nowhere
else, never in an address or a message, where it is replaced should a line
from Scaleway ever carry it.

## Tests

`SITESOLIDE_SCALEWAY_DNS_API` points setup at another address than
`https://api.scaleway.com`, for a local fake of the API
(`bin/tests/fake-dns-scaleway-dns.ts`). It takes https, or http on the loopback
only, so that the secret key never travels in the clear.
