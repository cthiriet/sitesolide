# DigitalOcean DNS

`sitesolide setup --dns digitalocean-dns` points the zone at the machine
through the API of [DigitalOcean's DNS](https://docs.digitalocean.com/products/networking/dns/),
with nothing to install on the workstation, and gives Caddy the module that
obtains the zone's wildcard certificate through a DNS-01 challenge, then renews
it. What every DNS provider shares is in [setup.md](../setup.md#dns).

```console
$ read -rs SITESOLIDE_DNS_DIGITALOCEAN_TOKEN && export SITESOLIDE_DNS_DIGITALOCEAN_TOKEN
$ sitesolide setup root@203.0.113.10 --zone example.com --email you@example.com --dns digitalocean-dns
```

## The zone

A **domain** of DigitalOcean's DNS, under *Networking*, *Domains* in the
[control panel](https://cloud.digitalocean.com/networking/domains), whose NS
records at the registrar name `ns1.digitalocean.com`, `ns2.digitalocean.com`
and `ns3.digitalocean.com`. That is also how the setup wizard recognises a zone
DigitalOcean serves. DigitalOcean sells no domains: the delegation is made at
the registrar. Its name servers do not serve a domain with DNSSEC enabled.

The zone may be the domain itself, `example.com`, or a name inside it,
`apps.example.com` in the domain `example.com`: setup looks for the zone, then
for each parent, and the records are then `apps` and `*.apps` in the parent.

## The token

A **personal access token with custom scopes**, for DNS alone. It is laid on
the machine, where Caddy needs it every two months to renew the certificate: a
token that can also order Droplets would be one break-in away from all of them.
That is why setup reads it from a variable of its own, and never from
`DIGITALOCEAN_TOKEN`, `DIGITALOCEAN_ACCESS_TOKEN` or doctl, which usually hold
a broader token.

1. In the [control panel](https://cloud.digitalocean.com/account/api/tokens),
   *API*, the *Tokens* tab, *Personal access tokens*, *Generate New Token*.
2. A name, `sitesolide-dns` for instance, and an expiration. Under *Scopes*,
   choose **Custom Scopes**, and tick `domain:read` and `domain:update`,
   nothing else.
3. *Generate Token*. It is shown once: put it in your password manager, not in
   a file.

| Scope | Who needs it |
|---|---|
| `domain:read` | setup, to find the domain and read the records of the zone and of its wildcard before it changes anything. |
| `domain:update` | setup, to create the records, and to change or delete those `--dns-replace` replaces; Caddy's module, to create the challenge's TXT record and delete it once the certificate is issued. |

DigitalOcean's reference lets `domain:update` create and delete a record as
well as change one (the security of *Create a New Domain Record* is
`domain:create` or `domain:update`, that of *Delete a Domain Record*
`domain:delete` or `domain:update`). `domain:create` and `domain:delete`,
which also add and delete whole domains, are not needed: leave them out.

**What it still reaches.** DigitalOcean scopes a token by kind of resource,
never by resource: the token can change every record of every domain of the
team it was made in, mail records included, though setup itself only ever
touches the four below. A team that holds this domain alone limits it to this
zone.

**Its expiration.** Caddy renews the certificate with it every two months:
once the token expires, renewals fail, and the certificate lapses a month
later. Choose an expiration past the machine's life, or make a new token
before it expires and run setup again with it.

The token is `dop_v1_` and 64 hexadecimal digits. Setup refuses a token from
before 2021, 64 digits alone, which predates custom scopes and reaches the
whole team, and an OAuth token from `doctl auth login`, `doo_v1_`, which
expires within hours.

## What setup creates

| Name | Type | Value | TTL |
|---|---|---|---|
| `@` | A | the machine's IPv4 | 30 |
| `*` | A | the machine's IPv4 | 30 |
| `@` | AAAA | the machine's IPv6, when it has one | 30 |
| `*` | AAAA | the machine's IPv6, when it has one | 30 |

Names are relative to the domain, as DigitalOcean writes them: `apps` and
`*.apps` for `apps.example.com` held in `example.com`. Thirty seconds is the
lowest TTL DigitalOcean accepts.

A record that already says the same is left as it is. One that points
elsewhere is refused, listed, and nothing is written: an address that is not
the machine's, a CNAME, an AAAA when the machine has no IPv6. `--dns-replace`
replaces them, the owner's decision: deletions first, since a CNAME has to go
before an address record can take its name, then the changes, then the new
records. Records of other types, the domain's NS records, mail and text above
all, are never touched.

## What Caddy keeps on the machine

Setup adds the module `github.com/caddy-dns/digitalocean` to Caddy with
`caddy add-package`; `caddy list-modules` then lists
`dns.providers.digitalocean`.

The token is in `/etc/caddy/cloudflare.env`, root:caddy 0640, the file Caddy's
unit loads whatever the provider: the name is the first provider's, and
machines in service load it by that name.

```
SITESOLIDE_DNS_DIGITALOCEAN_TOKEN=dop_v1_...
```

The zone's `tls` block, in `/etc/caddy/tls-zone.caddy`, names the module and
reads the token from Caddy's environment; the file itself holds no secret:

```caddyfile
dns digitalocean {env.SITESOLIDE_DNS_DIGITALOCEAN_TOKEN}
```

The module replaces the placeholder when Caddy starts (its `Provision` runs
Caddy's replacer on the token, `{env.*}` included). For each certificate it
creates a TXT record at `_acme-challenge.<zone>` in the domain that holds the
zone, and deletes it once the certificate is issued.

To change the token, make a new one as above and run setup again with it: a
value different from the machine's replaces it, and Caddy reads it at its next
start. Then delete the old one in the control panel.

## The variables

| Variable | What it holds |
|---|---|
| `SITESOLIDE_DNS_DIGITALOCEAN_TOKEN` | the personal access token, `dop_v1_` and 64 hexadecimal digits |

It is read from the environment, from standard input with
`--dns-credentials-stdin`, or typed at a prompt that does not echo; never from
an option. It travels in the Authorization header of DigitalOcean's API and
nowhere else, never in an address or a message, where it is replaced should a
line from DigitalOcean ever carry it.

## Tests

`SITESOLIDE_DIGITALOCEAN_DNS_API` points setup at another address than
`https://api.digitalocean.com/v2`, for a local fake of the API
(`bin/tests/fake-dns-digitalocean-dns.ts`), which enforces the scopes the
reference gives each operation. It takes https, or http on the loopback only,
so that the token never travels in the clear.
