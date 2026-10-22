# Cloudflare

`sitesolide setup` points the zone at the machine through
[Cloudflare's API](https://developers.cloudflare.com/api/), and gives Caddy the
module that obtains the zone's wildcard certificate through a DNS-01
challenge, then renews it. It is the default: `--dns cloudflare` says nothing
more than setup without the option. What every DNS provider shares is in
[setup.md](../setup.md#dns).

```console
$ read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN
$ sitesolide setup root@203.0.113.10 --zone example.com --email you@example.com
```

## The zone

A zone of your Cloudflare account, whose NS records at the registrar name
Cloudflare's servers, `<name>.ns.cloudflare.com`: that is also how the setup
wizard recognises a zone Cloudflare serves. The zone may be the domain itself,
`example.com`, or a name inside it, `apps.example.com` in the zone
`example.com`: setup looks for the zone, then for each parent, and the records
are then `apps.example.com` and `*.apps.example.com` in the parent.

## The token

An **API token**, not the Global API Key, for this zone alone. It is laid on the
machine, where Caddy needs it every two months to renew the certificate: a
token that reaches the whole account would be one break-in away from all of
it.

1. [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens),
   *Create Token*, the *Edit zone DNS* template, or *Create Custom Token*.
2. Permissions `Zone / Zone / Read` and `Zone / DNS / Edit`.
3. *Zone Resources*: *Include*, *Specific zone*, this zone.
4. *Continue to summary*, *Create Token*. It is shown once: put it in your
   password manager, not in a file.

It is read from `CLOUDFLARE_API_TOKEN`, from standard input with
`--cloudflare-token-stdin` (or `--dns-credentials-stdin`), or typed at a prompt
that does not echo. A token Cloudflare cannot verify as a user token, an
account-owned one, is used all the same when it reads the zone.

## What setup makes

| Name | Type | Content |
|---|---|---|
| `<zone>` | A | the machine's IPv4, DNS only, TTL auto |
| `*.<zone>` | A | the same |
| `<zone>` | AAAA | the machine's IPv6, when it has one |
| `*.<zone>` | AAAA | the same |

A record that already says this is left as it is. One that points elsewhere, a
CNAME at one of these names, an AAAA when the machine has no IPv6, or a record
proxied through Cloudflare, whose proxy would answer in the machine's place, is
refused, named, and nothing is written; only `--dns-replace`, your decision,
replaces it. Mail and text records are never touched.

## What stays on the machine

`/etc/caddy/cloudflare.env`, root:caddy 0640, holds `CLOUDFLARE_API_TOKEN=`
and nothing else, and `/etc/caddy/tls-zone.caddy` the `tls` block every block
of the zone imports:

```text
tls {
	dns cloudflare {env.CLOUDFLARE_API_TOKEN}
}
```

The module is `github.com/caddy-dns/cloudflare`, which setup adds to Caddy with
`caddy add-package`. A token given on a later run and different from the one on
the machine replaces it; Caddy reads it at its next start.

## Tests

`SITESOLIDE_CLOUDFLARE_API` points setup at another address than
`https://api.cloudflare.com/client/v4`, for the local mock
(`bin/tests/cloudflare-mock.ts`). It takes https, or http on the loopback only,
so that the token never travels in the clear.
