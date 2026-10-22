# Porkbun

`sitesolide setup --dns porkbun` points the zone at the machine through the DNS
[Porkbun](https://porkbun.com/) serves for the domains registered with it, with
nothing to install on the workstation, and gives Caddy the module that obtains
the zone's wildcard certificate through a DNS-01 challenge, then renews it.
What every DNS provider shares is in [setup.md](../setup.md#dns).

```console
$ read -rs SITESOLIDE_DNS_PORKBUN_API_KEY && export SITESOLIDE_DNS_PORKBUN_API_KEY
$ read -rs SITESOLIDE_DNS_PORKBUN_SECRET_API_KEY && export SITESOLIDE_DNS_PORKBUN_SECRET_API_KEY
$ sitesolide setup root@203.0.113.10 --zone example.com --email you@example.com --dns porkbun
```

## The domain, and the API

A domain **registered at Porkbun and served by its name servers**,
`curitiba.ns.porkbun.com`, `fortaleza.ns.porkbun.com`,
`maceio.ns.porkbun.com` and `salvador.ns.porkbun.com`, or the same four
directly under `porkbun.com` for a domain delegated before the `ns` label:
that is how the setup wizard recognises a domain Porkbun serves. Porkbun keeps
a zone for every domain of the account, delegated to it or not, and accepts
writes to it either way: records written for a domain whose NS records name
someone else change nothing that resolves. Use another `--dns` for those.

Setup speaks the API v3 at `https://api.porkbun.com/api/json/v3`. Its old
address, `porkbun.com/api/json/v3`, answers nothing but a 403 page now. The
zone may be the domain itself, `example.com`, or a name inside it,
`apps.example.com` in the domain `example.com`: setup looks for the domain
among the account's, then for each parent, and the records are then
`apps.example.com` and `*.apps.example.com` in the parent.

## The keys

An **API key and its secret key**, made for this domain alone, with the DNS
permission alone. They are laid on the machine, where Caddy needs them every
two months or so to renew the certificate, so they must reach this domain's
records and nothing else: a key made before Porkbun had permissions has full
access, purchases included, and must never be the one used here. That is also
why setup reads them from variables of its own, never from those Porkbun's
tools read.

1. On [porkbun.com](https://porkbun.com/), *Account* at the top right, then
   *API Access*.
2. A title for the key, `sitesolide example.com` for instance, and its
   restrictions: the **permissions**, a custom set with **DNS** alone (read
   comes with every key); the **allowed domains**, this domain alone. An **IP
   allowlist** is optional; if you set one, it must hold both the address of
   the workstation that runs setup and the machine's addresses, IPv4 and
   IPv6, since Caddy renews from there.
3. *Create API Key*. The secret key is shown once: put both in your password
   manager, not in a file.
4. **Turn API Access on for the domain**: *Account*, *Domain Management*, the
   domain's *Details* at the far right, *API Access*. Without it, no key
   reaches the domain's records, whatever it may do.

A key's restrictions can be changed later from the gear beside it on the *API
Access* page. Setup checks the keys first, with `/ping`, which says whether
they are valid and which permissions they carry: a key without DNS is refused
before anything else is read. A domain without API Access, or left out of the
key's allowed domains, is refused at its first read, saying which.

To change the keys, make a new pair as above and run setup again with it: a
value different from the machine's replaces it, and Caddy reads it at its next
start. Then delete the old key from *API Access*.

## What setup creates

| Name | Type | Value | TTL |
|---|---|---|---|
| `<zone>` | A | the machine's IPv4 | 600 |
| `*.<zone>` | A | the machine's IPv4 | 600 |
| `<zone>` | AAAA | the machine's IPv6, when it has one | 600 |
| `*.<zone>` | AAAA | the machine's IPv6, when it has one | 600 |

Six hundred seconds is the lowest TTL Porkbun takes, as its documentation says
of most accounts, and the one the Caddy module writes too.

A record that already says the same is left as it is. One that points
elsewhere is refused, listed, and nothing is written: an address that is not
the machine's, a CNAME, an AAAA when the machine has no IPv6. `--dns-replace`
replaces them, the owner's decision. Records of other types, mail and text
above all, are never touched.

Porkbun keeps each record apart, under an id of its own: setup edits the one it
keeps in place, by its id, and deletes the others by theirs, the CNAME first,
since Porkbun refuses an address record beside one.

## What Caddy keeps on the machine

Setup adds the module to Caddy with
`caddy add-package github.com/caddy-dns/porkbun`, which Caddy's build service
lists and builds; `caddy list-modules` then lists `dns.providers.porkbun`. It
is built on [libdns/porkbun](https://github.com/libdns/porkbun), which speaks
`api.porkbun.com`.

The keys are in `/etc/caddy/cloudflare.env`, root:caddy 0640, the file Caddy's
unit loads whatever the provider: the name is the first provider's, and
machines in service load it by that name.

```
SITESOLIDE_DNS_PORKBUN_API_KEY=pk1_...
SITESOLIDE_DNS_PORKBUN_SECRET_API_KEY=sk1_...
```

The zone's `tls` block, in `/etc/caddy/tls-zone.caddy`, names the module and
reads both keys from Caddy's environment; the file itself holds no secret:

```caddyfile
dns porkbun {
	api_key {env.SITESOLIDE_DNS_PORKBUN_API_KEY}
	api_secret_key {env.SITESOLIDE_DNS_PORKBUN_SECRET_API_KEY}
}
```

The module resolves the placeholders through Caddy's replacer when Caddy
provisions it, and sends the keys in the JSON body of its requests, over
https, the form the API has always taken.

## The variables

| Variable | What it holds |
|---|---|
| `SITESOLIDE_DNS_PORKBUN_API_KEY` | the API key, `pk1_` then 64 hexadecimal digits |
| `SITESOLIDE_DNS_PORKBUN_SECRET_API_KEY` | the secret key, `sk1_` then 64 hexadecimal digits |

They are read from the environment, from standard input with
`--dns-credentials-stdin` (one `VARIABLE=value` line each), or typed at a
prompt that does not echo; never from an option. A value with the other's
prefix is refused before anything leaves. Setup sends them in the
`X-API-Key` and `X-Secret-API-Key` headers of each request and nowhere else,
never in a body, an address or a message, where they are replaced should a
line from Porkbun ever carry them.

## Tests

`SITESOLIDE_PORKBUN_DNS_API` points setup at another address than
`https://api.porkbun.com/api/json/v3`, for a local fake of the API
(`bin/tests/fake-dns-porkbun.ts`). It takes https, or http on the loopback
only, so that the keys never travel in the clear.
