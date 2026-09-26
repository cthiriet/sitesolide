# portal

One password for every personal project, plus guest access, one per person and
per site, which the dashboard creates and revokes. A project behind the portal
carries `"portal": true` in its `sitesolide.json`, set from the dashboard once
the project is deployed, and writes not one line of authentication: before every
request, Caddy asks the portal whether the visitor has a valid cookie
(`forward_auth`). If so the request continues; if not the portal answers 401
itself, with its sign-in page in the body.

```json
{ "portal": true, "portalExempt": ["/webhook/*"] }
```

Customer previews have nothing to do here: they keep their six-character lock,
and `validate()` refuses a project carrying both. Their door page only shares
the sign-in template, see below.

## How it works

```
browser --> Caddy, block for shop.<zone>
              |
              +-- forward_auth --> portal 127.0.0.1:3026 /verifier
              |                      200 : the request continues
              |                      401 : the sign-in page
              |
              +-- /_portal/* --> the portal itself: sign in, sign out
              +-- the rest   --> file_server, or the project's service

dashboard (site-dashboard) --> portal 127.0.0.1:3026 /admin/guests
                               never through Caddy
```

Signing in happens on the site itself, at `/_portal/connexion`, and sets a
`__Host-portal` cookie valid for thirty days **for that site alone**. You
therefore sign in once per site and per device; a password manager fills the
field across every subdomain of the zone.

**No site shows a sign-out button**: the cookie expires on its own. The
`/_portal/deconnexion` route still exists and closes the cookie for one host, it
is simply displayed nowhere.

The cookie has two forms, signed by an HMAC whose key mixes a draw kept in
`data/key` with the password hash:

| Holder | Cookie | Signed over | Revocation |
|---|---|---|---|
| owner | `<expiry>.<signature>` | the host, the expiry | change the password, or delete `data/key` and restart: everyone is signed out everywhere |
| guest | `<expiry>.<access>.<signature>` | the host, the expiry, the access | revoke the access in the dashboard: refused on the very next request |

The owner's cookie is self-sufficient, nothing is kept server-side. A guest's
names its access, which the door reads back from the database on every request:
that is what makes revocation immediate rather than waiting for the cookie to
lapse.

## Turning the door on and off

**A deployed project gains or loses its door from the dashboard**, in the site's
*Access* section: *Turn on portal*, or *Turn off portal*, which makes you retype
the slug since the site becomes public. The dashboard does not touch Caddy: it
relays to the steward, which launches the gatekeeper, a root one-shot that
rewrites `/srv/sites/<slug>/sitesolide.json` and `/etc/caddy/sites/<slug>.caddy`,
validates the whole configuration, reloads Caddy with `systemctl reload caddy`,
checks that the site answers the portal's 401, or answers without it, and that
every other site still answers, then restores the previous state at the
slightest discrepancy. [dashboard/README.md](../dashboard/README.md) describes
the transaction, its lock and its refusals.

**The machine is then the source of truth.** The repository knows nothing about
it until a `sitesolide deploy` has come back through this project: that is what
takes the machine's door, rewrites the local `sitesolide.json` and asks you to
commit it. Until then `bin/deploy-caddy.sh`, `sitesolide lock`, `unlock`,
`domain` and `remove` refuse to contradict the machine, and say so.

**What the gatekeeper refuses**, with the reason shown on the page:

- the portal itself, which cannot guard itself;
- the dashboard, which has to stay reachable if the portal falls, or nothing
  would be left to say that it fell;
- the landing project, which has no `sitesolide.json`;
- a static site, a site locked in preview, a site declaring a `domain` even an
  inactive one: the rules of `validate()`, which the rewritten manifest has to
  pass;
- a block in service that differs from what the manifest generates, edited by
  hand or one deployment behind;
- the portal not answering with a hash in place, for a turn-on: the site would
  be closed to its owner too.

**`portalExempt` is kept in reserve** when the door comes off: without `portal`
it does nothing and `validate()` accepts it, but a door put back reopens the
same paths, signed webhooks included, instead of closing them silently.

A first deployment, which the machine knows nothing about, takes the
repository's door: `"portal": true` in the manifest, then `sitesolide deploy`,
which puts the door down before the files.

## Guest access

The dashboard creates them from a site's *Guests* section: for whom, and a
duration among 24 h, 7 days, 30 days or open-ended.

- **The password is drawn at random**, four groups of four
  (`Xith-G4r4-nRJs-uDMV`, about 92 bits), and **shown once**. Lost, it is
  revoked and another is drawn.
- **The database keeps only a SHA-256** of it, in `data/portal.db`. argon2id
  slows down whoever guesses a human-chosen password; this one has nothing to
  guess, and a fast hash finds it by index instead of checking accesses one at a
  time, 64 MiB each.
- **It is typed on the same page as the owner's.** Sign-in looks first for an
  access for that host, then checks the shared password. An access meant for
  another site, expired or revoked, counts as a failure.
- **Expiry closes like revocation**: the access is refused as soon as it passes,
  cookie in hand, and the cookie set does not outlive it anyway.
- **A guest has the same rights as the owner on that site.** Sites do not
  distinguish who comes in.
- **Changing the owner's password** also signs guests out, without invalidating
  their passwords. A lost database closes the guests out, never the owner.

### The admin API

`GET /admin/guests`, `POST /admin/guests` and `DELETE /admin/invites/:id`, on the
portal's port. They have no secret, and that is deliberate: the only accounts
that can reach that port are root, Caddy and `site-dashboard`, through the
exception `bin/cli/loopback.ts` adds to the loopback rule, and a shared secret
would protect nothing more.

Caddy never relays them: a protected site forwards to the portal only
`/_portal/*` and the `forward_auth` call to `/verifier`, and the portal's own
host only `/sante`. `bin/tests/cli-portal.test.ts` checks that no fragment aims
at anything else. As one more net, any request carrying `X-Forwarded-For`, which
Caddy puts on what it relays, is refused.

To read them by hand on the machine:
`sudo curl http://127.0.0.1:3026/admin/guests`.

## The page

**Sign-in and the preview door page are one template**, `src/page.ts`: same
card, same mark, two forms. The door page, served by Caddy and not by this
service, is generated by `bin/lock.sh` just before it is deployed:

```bash
bun run lock-page ./somewhere.html
```

It is not committed, because its footer carries the address to ask for a code,
which belongs to each installation.

Its CSS is hand-written and inline, and that is the repository's one Tailwind
exception: the door page is served for every URL of the locked host, and its own
resources would serve themselves in a loop.

## What surprises people

- **The 401 is the sign-in page**, not a redirect. `sitesolide deploy` and
  `deploy-caddy.sh` accept only 200 and 401, and the second restores the
  previous configuration on the first other code. The `X-Portal: connexion`
  header distinguishes it from a lock: the CLI requires it of a protected site,
  a 200 there being a fatal error, and a site's front end reloads the page on
  seeing it in answer to a `fetch`.
- **CSRF protection for every site is here.** Any request that changes state has
  to carry the site's exact `Origin`, or 403. `SameSite` would not be enough:
  to a browser, a customer's preview is the same site as another subdomain.
- **`X-Portal-Hote` comes from Caddy, never from the visitor.** `header_up`
  overwrites it, and it is the host the cookie signs. On the portal's own host,
  where Caddy does not set it, only `/sante` reaches the service: that is the
  manifest's `routes` allow list.
- **A protected site trusts Caddy**, and that trust only holds because of the
  loopback rule, `bin/deploy-loopback.sh`: without it, any service on the machine
  could reach the site's port without going through Caddy.
- **The door goes down before the files.** `deploy` reverses its order for a
  protected site: otherwise its files would be served in the clear by the
  wildcard block until the fragment arrives. And it refuses to send anything
  while the portal does not answer with a hash in place.
- **An exempted path is public.** It does not go through the portal, and the
  site answers for it alone, a signed webhook, typically.
- **An ambiguous path is refused with 400.** Caddy decodes `%2f` and cleans `..`
  before comparing against the exemptions, while the service routes on the raw
  path: `/api/x%2f..%2f..%2fhook/y` looked like an exemption to Caddy and reached
  `/api/x/...` with no cookie. Found during a migration, measured in a real
  Caddy, closed by `@portal_ambiguous`.
- **Portal stopped, protected sites answer 502** and serve nothing.
  `lb_try_duration` makes a request wait out a restart.

## What the door does not protect

- The password is typed on every site: an XSS flaw in one of them could capture
  it. Acceptable as long as those sites share one author.
- A compromised portal opens every personal site; that is the price of one
  shared password. It gives neither their data, each service staying confined to
  its own directory, nor the customer sites, nor the certificates.
- A compromised dashboard can create guest access on a personal site. During an
  unlock it can also take the door off a site, retyping the slug only guards
  against a misclick, and make it public. Changing the shared password also
  requires the dashboard's own, which the steward checks, but which compromised
  code would capture as it is typed. It never touches Caddy itself: the
  gatekeeper refuses everything its rules refuse, and restores.
- Rate limiting is per site and in memory: a stranger can block new sign-ins to
  one site for an hour, cookies already held keep working, and other sites are
  untouched.

## Password

```bash
bun run fingerprint
```

Drawn at random, about 139 bits, shown once; the hash goes into
`<vault>/portal.env`. That is the path for a new machine: on the first pass,
`cd portal && sitesolide deploy` puts the file there itself.

**After that the password changes from the dashboard**, in the `portal` site's
*Secrets*: *Change password*, the dashboard's own password retyped, a new one
drawn and shown once, or chosen, sixteen characters minimum, then *Restart
service* so the portal re-reads its environment. The old hash is not kept and
does not come back: it may be the one that leaked. `portal.env` carries that
hash and nothing else, and the steward refuses any other variable in it.
Changing the password signs everyone out, guests included.

Locally, the hash goes on the command line rather than through `bun --env-file`,
which expands the `$` of an argon2id hash:

```bash
PASSWORD_HASH="$(bun -e 'console.log(await Bun.password.hash("test"))')" bun run dev
```

## Tests

```bash
bun run check                                   # decisions, routes, database, page, typing
bun test ../bin/tests/cli-portal-caddy.test.ts  # the generated fragment, in a real Caddy
```

The second runs Caddy on your workstation, `admin off` on a free port, in front
of this service and a fake site: what the door promises hangs entirely on the
order in which Caddy sorts directives, and an order is measured, not read. It
also lets a guest in, revokes them, and checks that the admin API cannot be
reached through the site.
