# api

The shared service, on local port 3001. It serves no page and has one caller,
Caddy: it authorises certificate issuance for customer domains, and for the
zone's own names when the zone is served with manual DNS, and generates,
offline, the domain table and the preview-lock fragment. That is its entire
scope.

**This service will never receive a form.** Every project handles its own, in
its own directory and behind its own service. The landing page's contact form
lived here for a while, and that was an architectural mistake. One service
holding a feature for every site means one fault deprives that site of its
form at the same time as every other, and one compromise hands over every
customer's submissions at once. A
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
| The served zone and its subdomains, with a DNS provider | 403 | already covered by the wildcard and the apex |
| Invalid hostname, IP address | 403 | cannot be certified |

With manual DNS the served zone's names are decided differently, see below.

Two consequences worth keeping in mind:

- the endpoint sits in the path of a handshake, so no network request and no
  disk read per call: the table is re-read at most every ten seconds;
- if the service is stopped, no customer domain obtains or renews its
  certificate. Hence `Restart=always` and `Before=caddy.service` in the unit.

## The zone's own names

The zone's certificates follow its TLS policy, `/etc/caddy/tls-zone.caddy`,
which `sitesolide setup` lays and the Caddyfile's `(tls-zone)` snippet imports
(`bin/cli/tls.ts`). This service reads that same file, with the table's
ten-second window, for one thing: whether it says `on_demand`. Caddy and the
endpoint therefore cannot disagree on how the zone is certified, and no
variable has to reach a running process.

| The zone's policy | The zone's names | Why |
|---|---|---|
| a DNS provider's, or no file | all refused, `covered by the wildcard` | Caddy never asks for them; a second certificate for a covered name would count against the authority's limits. The answer of every release before the file, word for word |
| `on_demand`, manual DNS | `<zone>` and `www.<zone>` allowed; `<label>.<zone>` allowed for a site deployed on the machine; every other name refused | the wildcard record points every name at the machine: a random name allowed would let anyone spend the authority's fifty certificates a week on the zone |

A name allowed is always one Caddy routes: the zone and its www to the
landing's block, a deployed site's label to the wildcard block or the site's
own. A name of two labels or more under the zone never is, the wildcard
matching one label only, and the table of customer domains never decides a
name of the zone, whatever it lists.

The deployed sites come from `/etc/caddy/zone-names`, one label per line. This
service cannot read `/srv/sites`, its unit hides it, so the list is written on
the machine from the folders there, by one script, `zoneNamesScript` in
`src/zone-names.ts`, which writes nothing on a zone with a DNS provider:
`sitesolide deploy` once the site's folder exists and before its verification,
`sitesolide remove` once the folder is gone, `bin/deploy-caddy.sh` before each
deposit, `bin/generate-domains.sh`, and the dashboard's installer for a token's
deployment, from the copy the dashboard borrows. A folder whose name is not one
DNS label, the landing's, is left out. The list
is read like the table, with one difference: a name it lacks makes it read
again once a second has passed since the last read, so that a site deployed a
moment ago gets its certificate at the first handshake, and a flood of random
names costs one read per second at most.

**At most twenty names new to the zone a day** (`NEW_ZONE_NAMES_CAP` and
`NEW_ZONE_NAMES_WINDOW_MS` in `src/config.ts`). A listed name this service has
never allowed is new; past twenty in a rolling 24 hours, a new name is
refused, the reason logged and the cap said once in the journal, until the
oldest of them is a day old. Known names are never refused by it: those listed
at the first reading of the list after a start, and every name allowed since,
so a renewal, which Caddy asks about again, always goes through, and so do the
zone and its www. It bounds a burst, a token that may create projects or
anything else that lists sites faster than the owner looks, before it spends
the authority's fifty new certificates a week on the zone. It is kept in
memory: the unit gives this service no writable directory, and a restart costs
no renewal since every name listed then is known.

A token's deployment is listed only once it is in place, after its archive
was judged and its `install` ran, and kept even if what follows fails: a name
is never certifiable for a deployment that is about to vanish.

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

`src/locks.ts` decides the Caddy fragment that closes previews behind a code.
It serves no request, and nothing in this service writes it: the dashboard's
gatekeeper does, the one path that changes a site's general access on the
machine, for the site's *Access* section and for `sitesolide lock` alike
(dashboard/src/gatekeeper/). It installs the fragment into
`/etc/caddy/locks/verrous.caddy`, imported by glob from the wildcard block
**and from the preview block of every app** (`/etc/caddy/sites/<slug>.caddy`).
That second import is not optional: an app's block is more specific than the
wildcard and takes precedence over it, so without it that app would be the only
one unable to open with a code.

It reads two sources, and the separation is the point:

| Source | Content | Where it lives |
|---|---|---|
| `/srv/sites/<slug>/sitesolide.json` | `"lock": true`, the intent | on the machine, which the next `sitesolide deploy` writes back into the project's repository |
| `/etc/caddy/locks-codes.json` | `{ "<slug>": "A7B2K9" }`, the code | on the machine alone, the deployment account's in 0600 |

The gatekeeper draws the code there with `generateCode`, writes both files and
the fragment in one transaction, validates, reloads Caddy and checks the site,
and puts everything back on a failure. A code is replaced without a commit.

**A lock requested without a valid code is an error that stops everything**, not
a site left silently open, and so is a code in force for a manifest that no
longer asks for one: the fragment is not generated, and nothing in service
changes.

The decisions live in `src/locks.ts`, with no disk access: drawing the code and
its alphabet, validation, the cookie name, the Caddy stanza, the complete
fragment, the codes file read and written, the code a stanza in service
carries. The gatekeeper only adds reading and writing the files.

The code is not a cryptographic secret: Caddy compares it in clear text, so it
is written in clear text in the fragment. The gatekeeper therefore writes the
fragment `0640`, root's and Caddy's group's: a project's service reads
`/etc/caddy`, and a fragment open to all handed every site's code to any
deployed app, the codes file's `0600` keeping nothing. `src/locks.ts` says at
the top what that implies, and what the lock does not protect.

## Local development

```bash
bun install
DOMAINS_FILE=./domaines.map bun run dev
curl "http://127.0.0.1:3001/interne/domaine-autorise?domain=example.com"
```

`TLS_ZONE_FILE` and `ZONE_NAMES_FILE` point the zone's policy and its list of
sites elsewhere the same way; absent, the zone is a DNS provider's.

## Tests

```bash
bun test      # authorisation decisions, domain table, locks, routes
bun run check # tests, then type checking
```

The decisions live in `src/`, separate from the server, and take their clock and
their file path as parameters: the tests therefore cross the ten-second cache
window without waiting, and open no port. What is covered: refusal by default,
the served zone set aside, undeclared subdomains, deferred re-reading, log
rate limiting, and the zone's names with each policy (`tests/zone.test.ts`).

`/health` returns the number of currently authorised domains, which is enough to
check after a deployment that the table was read.

## Deployment

```bash
bin/deploy-api.sh
```

The code goes to `/srv/api/releases/<timestamp>-<commit>`, and only moving the
`current` symlink puts it in service. Rolling back: point the link at the
previous release and restart.
