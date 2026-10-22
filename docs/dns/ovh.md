# OVHcloud DNS

`sitesolide setup --dns ovh` points the zone at the machine through the
[OVHcloud API](https://eu.api.ovh.com/), with nothing to install on the
workstation, and gives Caddy the module that obtains the zone's wildcard
certificate through a DNS-01 challenge, then renews it. What every DNS provider
shares is in [setup.md](../setup.md#dns).

```console
$ export SITESOLIDE_DNS_OVH_ENDPOINT=ovh-eu SITESOLIDE_DNS_OVH_APPLICATION_KEY=<application key>
$ read -rs SITESOLIDE_DNS_OVH_APPLICATION_SECRET && export SITESOLIDE_DNS_OVH_APPLICATION_SECRET
$ read -rs SITESOLIDE_DNS_OVH_CONSUMER_KEY && export SITESOLIDE_DNS_OVH_CONSUMER_KEY
$ sitesolide setup root@203.0.113.10 --zone example.com --email you@example.com --dns ovh
```

## The zone

A **DNS zone hosted by OVHcloud**, the one the domain's NS records name: a
pair such as `dns10.ovh.net` and `ns10.ovh.net`, `dns100.ovh.us` and
`ns100.ovh.us` in the US region, and `dns200.anycast.me` and
`ns200.anycast.me` with the DNS Anycast option. That is how the setup wizard
recognises a zone OVHcloud serves.

The zone may be the OVHcloud zone itself, `example.com`, or a name inside it,
`apps.example.com` in the zone `example.com`: setup looks for the zone, then
for each parent, and the records are then `apps.example.com` and
`*.apps.example.com` in the parent.

OVHcloud has three APIs, one per region, and an account belongs to one of
them: `ovh-eu` (`https://eu.api.ovh.com/1.0`), `ovh-ca`
(`https://ca.api.ovh.com/1.0`) or `ovh-us` (`https://api.us.ovhcloud.com/1.0`).

## The keys

Three values: an **application key**, its **application secret**, and a
**consumer key** whose access rules reach this zone's records and nothing
else. They are laid on the machine, where Caddy needs them every two months to
renew the certificate: a consumer key with `GET /*`, or one that can reset the
zone, would be one break-in away from all of it. That is why setup reads them
from variables of its own and never from `OVH_APPLICATION_KEY` and its
companions, or an `ovh.conf`, which usually hold a key that reaches the whole
account.

The key page of your region makes all three at once: in Europe,
`https://api.eu.ovhcloud.com/createToken/`; in Canada,
`https://ca.api.ovh.com/createToken/`; in the US,
`https://api.us.ovhcloud.com/createToken/`. Open it with the rules in its
address, `example.com` replaced by your zone (for `apps.example.com` held in
`example.com`, the OVHcloud zone `example.com`):

```
https://api.eu.ovhcloud.com/createToken/?GET=/domain/zone/example.com/soa&GET=/domain/zone/example.com/record&GET=/domain/zone/example.com/record/*&POST=/domain/zone/example.com/record&PUT=/domain/zone/example.com/record/*&DELETE=/domain/zone/example.com/record/*&POST=/domain/zone/example.com/refresh
```

1. Sign in with the account that holds the zone.
2. *Script name* `sitesolide-dns`, a description.
3. **Validity: Unlimited.** The page offers shorter ones, a day by default on
   some regions' pages: past it, the consumer key expires and renewals fail.
4. Check the seven *Rights* the address filled in, and add none:

   | Method | Path | Who needs it |
   |---|---|---|
   | GET | `/domain/zone/example.com/soa` | setup, to find the zone |
   | GET | `/domain/zone/example.com/record` | setup and Caddy's module, to list a name's records |
   | GET | `/domain/zone/example.com/record/*` | both, to read each of them |
   | POST | `/domain/zone/example.com/record` | setup, its A and AAAA; the module, the challenge's TXT |
   | PUT | `/domain/zone/example.com/record/*` | setup, what `--dns-replace` points at the machine |
   | DELETE | `/domain/zone/example.com/record/*` | setup, what `--dns-replace` removes; the module, the challenge's TXT once used |
   | POST | `/domain/zone/example.com/refresh` | both: OVHcloud serves a change once the zone is refreshed |

5. *Create keys*. The page shows the three values once: put the secret and
   the consumer key in your password manager, not in a file.

The rules are the narrowest OVHcloud allows: they name one zone, and within it
its records alone. `POST /domain/zone/example.com/*` and the like would also
let the key reset the zone (`/reset`), import a zone file over it (`/import`),
or, with `DELETE`, turn its DNSSEC off.
The page also takes IP blocks, which would limit the key to the machine and
your workstation; setup does not need them, and a workstation's address
changes.

A key's rules are fixed when it is made. To change them, make a new one.

## What setup creates

| Name | Type | Value | TTL |
|---|---|---|---|
| `<zone>` | A | the machine's IPv4 | 60 |
| `*.<zone>` | A | the machine's IPv4 | 60 |
| `<zone>` | AAAA | the machine's IPv6, when it has one | 60 |
| `*.<zone>` | AAAA | the machine's IPv6, when it has one | 60 |

Sixty seconds is the lowest TTL OVHcloud's console accepts.

A record that already says the same is left as it is. One that points
elsewhere is refused, listed, and nothing is written: an address that is not
the machine's, a CNAME, an AAAA when the machine has no IPv6. `--dns-replace`
replaces them, the owner's decision. Records of other types, mail and text
above all, and the zone's NS, are never touched.

OVHcloud numbers each record: setup changes or deletes a record by its number,
which leaves every other record of the name as it was, and a record it changes
keeps its TTL. Each change is followed by a refresh of the zone, which is what
makes OVHcloud's name servers serve it.

## What Caddy keeps on the machine

Setup adds the module `github.com/caddy-dns/ovh` to Caddy with
`caddy add-package`; `caddy list-modules` then lists `dns.providers.ovh`.

The four values are in `/etc/caddy/cloudflare.env`, root:caddy 0640, the file
Caddy's unit loads whatever the provider: the name is the first provider's, and
machines in service load it by that name.

```
SITESOLIDE_DNS_OVH_ENDPOINT=ovh-eu
SITESOLIDE_DNS_OVH_APPLICATION_KEY=...
SITESOLIDE_DNS_OVH_APPLICATION_SECRET=...
SITESOLIDE_DNS_OVH_CONSUMER_KEY=...
```

The zone's `tls` block, in `/etc/caddy/tls-zone.caddy`, names the module and
reads all four from Caddy's environment; the file itself holds no secret:

```caddyfile
dns ovh {
	endpoint {env.SITESOLIDE_DNS_OVH_ENDPOINT}
	application_key {env.SITESOLIDE_DNS_OVH_APPLICATION_KEY}
	application_secret {env.SITESOLIDE_DNS_OVH_APPLICATION_SECRET}
	consumer_key {env.SITESOLIDE_DNS_OVH_CONSUMER_KEY}
}
```

The module resolves the four placeholders when Caddy starts, and its library,
OVHcloud's own go-ovh, knows the region by its name.

To change the keys, make new ones as above and run setup again with them:
values different from the machine's replace them, and Caddy reads them at its
next start. Then delete the old application, and its consumer key with it,
from the API console of your region: `DELETE /me/api/application/{applicationId}`,
its id listed by `GET /me/api/application`.

## The variables

| Variable | What it holds |
|---|---|
| `SITESOLIDE_DNS_OVH_ENDPOINT` | the region: `ovh-eu`, `ovh-ca` or `ovh-us`; not secret |
| `SITESOLIDE_DNS_OVH_APPLICATION_KEY` | the application key, 16 letters and digits; not secret |
| `SITESOLIDE_DNS_OVH_APPLICATION_SECRET` | the application secret, 32 letters and digits |
| `SITESOLIDE_DNS_OVH_CONSUMER_KEY` | the consumer key, 32 letters and digits |

They are read from the environment, from standard input with
`--dns-credentials-stdin`, one `VARIABLE=value` line each, or typed at a prompt,
the two secrets at one that does not echo; never a secret from an option.
Every request is signed as OVHcloud requires: the application key and the
consumer key travel in the X-Ovh-Application and X-Ovh-Consumer headers, the
secret only inside the signature, a SHA-1 of the request and the time OVHcloud
gives, and none of them in an address or a message, where they are replaced
should a line from OVHcloud ever carry one.

## Tests

`SITESOLIDE_OVH_DNS_API` points setup at another address than the region's,
for a local fake of the API (`bin/tests/fake-dns-ovh.ts`), which checks every
signature as OVHcloud does and enforces the consumer key's rules. It takes
https, or http on the loopback only, so that the credentials never travel in
the clear.
