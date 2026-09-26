# api

The shared service, on local port 3001. It serves no page and has one caller,
Caddy: it authorises certificate issuance for customer domains, and generates,
offline, the domain table and the preview-lock fragment. That is its entire
scope.

**This service will never receive a form.** Every project handles its own, in
its own directory and behind its own service. The landing page's contact form
lived here for a while, and that was an architectural mistake. Sharing a site
feature means one fault deprives that site of its form at the same time as every
other, and one compromise hands over every customer's submissions at once. A
defect should reach only the site that wrote it.

What stays shared is the only two things that genuinely are: certificates, whose
decision is about the whole machine and no site in particular, and locks, whose
fragment is unique and imported by every Caddy block. Nothing else comes in
here.

## The `ask` endpoint

```
GET /interne/domaine-autorise?domain=example.com
```

Caddy queries it **during the TLS handshake**, before asking for a certificate
for a domain it does not know. A `200` authorises issuance; anything else blocks
it, including no answer at all.

This is the guard on `on_demand_tls`: without it, anyone pointing DNS at the
machine would have certificates issued in your name and would exhaust the ACME
quotas. It is therefore never permissive by default, and three families of
domain are refused:

| Case | Answer | Why |
|---|---|---|
| Domain absent from the table | 403 | nothing ties it to a project |
| The served zone and its subdomains | 403 | already covered by the wildcard and the apex |
| Invalid hostname, IP address | 403 | cannot be certified |

Two consequences worth keeping in mind:

- the endpoint sits in the path of a handshake, so no network request and no
  disk read per call: the table is re-read at most every ten seconds;
- if the service is stopped, no customer domain obtains or renews its
  certificate. Hence `Restart=always` and `Before=caddy.service` in the unit.

## The domain table

`/etc/caddy/domaines.map`, produced by `bin/generate-domains.sh` from the
`sitesolide.json` files deployed alongside the projects, governs both the
routing by Caddy and the authorisation by this service. A domain therefore
cannot get a certificate without being served, nor be served without having been
authorised.

An unreadable file does not empty the list: the last known table stays in force
while a rewrite finishes. That fallback never authorises more than what already
was.

## The preview-lock fragment

`scripts/generate-locks.ts` is the service's second generator. It serves no
request: it writes to standard output the Caddy fragment that closes previews
behind a code, and `bin/lock.sh` installs it into `/etc/caddy/locks/`, imported
by glob from the wildcard block **and from the preview block of every app**
(`<projects>/<slug>/<slug>.caddy`). That second import is not optional: an app's
block is more specific than the wildcard and takes precedence over it, so
without it that app would be the only one unable to lock itself.

It reads two sources, and the separation is the point:

| Source | Content | Where it lives |
|---|---|---|
| `/srv/sites/<slug>/sitesolide.json` | `"lock": true`, the intent | committed in the project's repository, deployed with it |
| `/etc/caddy/lock-codes.json` | `{ "<slug>": "A7B2K9" }`, the code | on the machine, outside any repository |

The wanted state is therefore readable in git, while a code is replaced without
a commit. The action goes through `bin/lock.sh`, which `sitesolide lock` and
`sitesolide unlock` run from the project's directory.

That manifest is the only configuration file a project has, here as in its
repository. A project that keeps a lock without a manifest stops the generation
rather than silently dropping out of the table. Every path comes from an
environment variable (`SITES_DIR`, `CODES_FILE`, `DOOR_PAGES_DIR`, `SITESOLIDE_ZONE`),
none is hard-coded: the generator therefore runs on a workstation, against a
test tree.

**A lock requested without a valid code is an error that stops everything**, not
a site left silently open. The generator exits non-zero and the install script
stops before touching the running configuration.

The decisions live in `src/locks.ts`, with no disk access: drawing the code and
its alphabet, validation, the cookie name, the Caddy stanza and the complete
fragment. The script only adds reading the files.

The code is not a cryptographic secret: Caddy compares it in clear text, so it
is written in clear text in the fragment. `src/locks.ts` says at the top what
that implies, and what the lock does not protect.

## Local development

```bash
bun install
DOMAINS_FILE=./domaines.map bun run dev
curl "http://127.0.0.1:3001/interne/domaine-autorise?domain=example.com"
```

## Tests

```bash
bun test      # authorisation decisions, domain table, locks, routes
bun run check # tests, then type checking
```

The decisions live in `src/`, separate from the server, and take their clock and
their file path as parameters: the tests therefore cross the ten-second cache
window without waiting, and open no port. What is covered: refusal by default,
the served zone set aside, undeclared subdomains, deferred re-reading, and log
rate limiting.

`/health` returns the number of currently authorised domains, which is enough to
check after a deployment that the table was read.

## Deployment

```bash
bin/deploy-api.sh
```

The code goes to `/srv/api/releases/<timestamp>-<commit>`, and only moving the
`current` symlink puts it in service. Rolling back: point the link at the
previous release and restart.
