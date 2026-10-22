# Gandi LiveDNS

`sitesolide setup --dns gandi` points the zone at the machine through
[Gandi](https://www.gandi.net/)'s LiveDNS, with nothing to install on the
workstation, and gives Caddy the module that obtains the zone's wildcard
certificate through a DNS-01 challenge, then renews it. What every DNS provider
shares is in [setup.md](../setup.md#dns).

```console
$ read -rs SITESOLIDE_DNS_GANDI_TOKEN && export SITESOLIDE_DNS_GANDI_TOKEN
$ sitesolide setup root@203.0.113.10 --zone example.com --email you@example.com --dns gandi
```

## The domain, and the API

A domain **served by LiveDNS**, Gandi's DNS. Its NS records name three
servers of the form `ns-<number>-a.gandi.net`, `-b` and `-c`, `ns-151-a`,
`ns-193-b` and `ns-165-c` for one: that is how the setup wizard recognises a
domain LiveDNS serves. A domain still on Gandi's classic DNS,
`a.dns.gandi.net` and its companions, is out of the API's reach: move it to
LiveDNS in the Gandi admin first, or use `--dns manual`.

Setup speaks the LiveDNS API, `https://api.gandi.net/v5/livedns`. The zone may
be the domain itself, `example.com`, or a name inside it, `apps.example.com` in
the domain `example.com`: setup looks for the domain, then for each parent,
and the records are then `apps` and `*.apps` in the parent.

**A domain of another organization.** Gandi has been seen to answer 404 on the
records of a domain that belongs to an organization other than the default
one of the token's user, unless each request names the organization; the
[libdns/gandi](https://github.com/libdns/gandi) README, which the Caddy module
uses, documents it. Setup does not name it: when it stops on a 404 for the
domain's records, this is the likely cause, and `--dns manual` the way
through until it does.

## The token

A **personal access token** restricted to this domain, with one permission. It
is laid on the machine, where Caddy needs it every two months or so to renew
the certificate, so it must reach this domain and nothing else. That is also
why setup reads it from a variable of its own, never from one Gandi's tools
read.

1. In the [Gandi admin](https://admin.gandi.net/), *Organizations*, the
   organization that owns the domain, its *Sharing* tab, then *Create a
   token* at the bottom of the page.
2. A name, `sitesolide example.com` for instance, and an expiry: choose the
   longest, a year.
3. *Token resources*: **Restrict to selected products**, and pick this domain
   alone.
4. *Permissions*, under the domains: **Manage domain name technical
   configurations**, and nothing else. Gandi ticks *See and renew domain names*
   with it, which it needs. It is the permission LiveDNS's records ask for,
   and it reaches the domain's other technical settings too: that is why the
   token must name this domain alone.
5. Create it. The token is shown once: put it in your password manager, not in
   a file.

Not the **API key** of the account's security settings: Gandi has deprecated
it, it cannot be restricted to anything, it carries every right of its owner,
and the Caddy module no longer takes it.

**The token expires**, after a year at most. Caddy renews the certificate
about a month before its own end, and with an expired token the renewal fails;
the monitor warns once the certificate is fourteen days from its end (see
[monitor/README.md](../../monitor/README.md)). Before the token's date, make a
new one as above and run setup again with it: a value different from the
machine's replaces it, and Caddy reads it at its next start. Then delete the
old one from the same *Sharing* tab.

## What setup creates

| Name | Type | Value | TTL |
|---|---|---|---|
| `<zone>` | A | the machine's IPv4 | 300 |
| `*.<zone>` | A | the machine's IPv4 | 300 |
| `<zone>` | AAAA | the machine's IPv6, when it has one | 300 |
| `*.<zone>` | AAAA | the machine's IPv6, when it has one | 300 |

Three hundred seconds is the lowest TTL LiveDNS takes, so that a move to
another machine is seen within five minutes.

A record that already says the same is left as it is. One that points
elsewhere is refused, listed, and nothing is written: an address that is not
the machine's, a CNAME, an AAAA when the machine has no IPv6. `--dns-replace`
replaces them, the owner's decision. Records of other types, the domain's NS,
mail and text above all, are never touched.

LiveDNS keeps the values of a name and a type together, in a record set, under
one TTL. A set is created with a POST, which Gandi refuses when someone made
it since setup read the zone, rather than overwriting it. Replacing one value
changes that value alone: setup reads the set and writes it back with that
one value replaced and the others kept, under a TTL of 300. A value is deleted
by writing the set back without it, its TTL kept, and the set itself only goes
when it held that value alone.

## What Caddy keeps on the machine

Setup adds the module to Caddy with
`caddy add-package github.com/caddy-dns/gandi`, which Caddy's build service
lists and builds; `caddy list-modules` then lists `dns.providers.gandi`. Its
current version, built on [libdns/gandi](https://github.com/libdns/gandi), sends
the token as a Bearer, as a personal access token wants it.

The token is in `/etc/caddy/cloudflare.env`, root:caddy 0640, the file Caddy's
unit loads whatever the provider: the name is the first provider's, and
machines in service load it by that name.

```
SITESOLIDE_DNS_GANDI_TOKEN=...
```

The zone's `tls` block, in `/etc/caddy/tls-zone.caddy`, names the module and
reads the token from Caddy's environment; the file itself holds no secret:

```caddyfile
dns gandi {env.SITESOLIDE_DNS_GANDI_TOKEN}
```

The module resolves the placeholder through Caddy's replacer when Caddy
provisions it.

## The variables

| Variable | What it holds |
|---|---|
| `SITESOLIDE_DNS_GANDI_TOKEN` | the personal access token, letters, digits and the few signs a token is made of, on one line |

It is read from the environment, from standard input with
`--dns-credentials-stdin` (the token alone, or a `VARIABLE=value` line), or
typed at a prompt that does not echo; never from an option. It travels in the
Authorization header of each request and nowhere else, never in an address or
a message, where it is replaced should a line from Gandi ever carry it. The
addresses Gandi's answers name are never followed.

## Tests

`SITESOLIDE_GANDI_DNS_API` points setup at another address than
`https://api.gandi.net/v5`, for a local fake of the API
(`bin/tests/fake-dns-gandi.ts`). It takes https, or http on the loopback only,
so that the token never travels in the clear.
