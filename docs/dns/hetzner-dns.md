# Hetzner DNS

`sitesolide setup --dns hetzner-dns` points the zone at the machine through the
DNS of the [Hetzner Console](https://console.hetzner.com/), with nothing to
install on the workstation, and gives Caddy the module that obtains the zone's
wildcard certificate through a DNS-01 challenge, then renews it. What every DNS
provider shares is in [setup.md](../setup.md#dns).

```console
$ read -rs SITESOLIDE_DNS_HETZNER_TOKEN && export SITESOLIDE_DNS_HETZNER_TOKEN
$ sitesolide setup root@203.0.113.10 --zone example.com --email you@example.com --dns hetzner-dns
```

## The zone, and the API

A **primary zone of the Hetzner Console**, under *DNS* in one of your
projects. Its NS records name `hydrogen.ns.hetzner.com`,
`oxygen.ns.hetzner.com` and `helium.ns.hetzner.de`, or, for an older zone,
`ns1.first-ns.de`, `robotns2.second-ns.de` and `robotns3.second-ns.com`: that
is how the setup wizard recognises a zone Hetzner serves. A secondary zone,
whose records Hetzner copies from name servers of yours, is refused: create the
records there, or use `--dns manual`. The DNS of konsoleH web hosting,
`ns1.your-server.de`, is another product, which this API does not reach.

Setup speaks the **Cloud API**, `https://api.hetzner.cloud/v1/zones`, where
Hetzner moved DNS when it made it generally available on 10 November 2025.
The old DNS Console and its API, `dns.hetzner.com/api/v1`, were switched off in
May 2026; their zones live in the Hetzner Console now, and **their tokens do
not work** with the Cloud API.

The zone may be the Hetzner zone itself, `example.com`, or a name inside it,
`apps.example.com` in the zone `example.com`: setup looks for the zone, then
for each parent, and the records are then `apps.example.com` and
`*.apps.example.com` in the parent. (Hetzner holds no zone for a subdomain.)

## The token

A **Read & Write** API token of a **project that holds the zone and nothing
else**. It is laid on the machine, where Caddy needs it every two months to
renew the certificate. Hetzner scopes a token by project, never by resource or
by kind: a token of the project your servers live in could delete them. The
project is the only fence, so give the zone one of its own. That is also why
setup reads the token from a variable of its own and never from `HCLOUD_TOKEN`,
which the hcloud CLI and `sitesolide machine` read, and which orders servers.

1. In the [Hetzner Console](https://console.hetzner.com/), create a project,
   `dns` for instance.
2. Put the zone in it: create it there under *DNS*, or, from the project that
   holds it now, open the zone list, the three dots of the zone, *Transfer to
   Project*.
3. In the new project, *Security*, *API tokens*, *Generate API token*, with
   the **Read & Write** permission. A *Read* token lists the zone but cannot
   change it. The token is shown once: put it in your password manager, not in
   a file.

It is 64 letters and digits. It never expires: delete it from the same page
when the machine no longer serves the zone.

## What setup creates

| Name | Type | Value | TTL |
|---|---|---|---|
| `<zone>` | A | the machine's IPv4 | 60 |
| `*.<zone>` | A | the machine's IPv4 | 60 |
| `<zone>` | AAAA | the machine's IPv6, when it has one | 60 |
| `*.<zone>` | AAAA | the machine's IPv6, when it has one | 60 |

Sixty seconds is the lowest TTL Hetzner takes, so that a move to another
machine is seen within a minute.

A record that already says the same is left as it is. One that points
elsewhere is refused, listed, and nothing is written: an address that is not
the machine's, a CNAME, an AAAA when the machine has no IPv6. `--dns-replace`
replaces them, the owner's decision. Records of other types, mail and text
above all, and the zone's own SOA and NS, are never touched.

Hetzner keeps the values of a name and a type together, in a record set
(RRSet). Replacing one value changes that value alone: setup reads the set,
writes it back with that one value replaced, the others and their comments
kept, and deletes a value by removing that value alone, which removes the set
only when it was the last. Each write is an action of the Cloud API, and setup
waits for it to finish before the next one, two minutes at most.

## What Caddy keeps on the machine

Setup adds the module to Caddy with
`caddy add-package github.com/caddy-dns/hetzner@v2.0.1`; `caddy list-modules`
then lists `dns.providers.hetzner`. The version is not a detail: Caddy's build
service knows the package under its old path and, without a version, builds
v1.0.0, which spoke the switched-off DNS API and fails every renewal. Version 2
speaks the Cloud API, through `github.com/libdns/hetzner/v2` and Hetzner's own
`hcloud-go`.

The token is in `/etc/caddy/cloudflare.env`, root:caddy 0640, the file Caddy's
unit loads whatever the provider: the name is the first provider's, and
machines in service load it by that name.

```
SITESOLIDE_DNS_HETZNER_TOKEN=...
```

The zone's `tls` block, in `/etc/caddy/tls-zone.caddy`, names the module and
reads the token from Caddy's environment; the file itself holds no secret:

```caddyfile
dns hetzner {env.SITESOLIDE_DNS_HETZNER_TOKEN}
propagation_delay 30s
```

The module resolves the placeholder when Caddy starts. The delay is the
module's own advice: Hetzner's name servers take a moment to publish a change,
and Caddy checks for the challenge's record only after it.

To change the token, generate a new one as above and run setup again with it:
a value different from the machine's replaces it, and Caddy reads it at its
next start. Then delete the old one from the project's *API tokens*.

## The variables

| Variable | What it holds |
|---|---|
| `SITESOLIDE_DNS_HETZNER_TOKEN` | the project's API token, 64 letters and digits |

It is read from the environment, from standard input with
`--dns-credentials-stdin` (the token alone, or a `VARIABLE=value` line), or
typed at a prompt that does not echo; never from an option. It travels in the
Authorization header of each request and nowhere else, never in an address or
a message, where it is replaced should a line from Hetzner ever carry it.

## Tests

`SITESOLIDE_HETZNER_DNS_API` points setup at another address than
`https://api.hetzner.cloud/v1`, for a local fake of the API
(`bin/tests/fake-dns-hetzner-dns.ts`). It takes https, or http on the loopback
only, so that the token never travels in the clear.
