# portal

The sign-in in front of every restricted site. Two ways in: the owner, with
a passkey or the owner's password, and password access, one password per guest
and per site. Who may open a site is not the portal's to keep: it is the
steward's registry of guests, which the portal reads as a projection the
steward writes for it. A restricted site also learns whether the owner or a
guest came in, through a request header it can trust.

A restricted project carries `"portal": true` in its `sitesolide.json`,
which is what its general access *Restricted* means, set from the dashboard
once the project is deployed, and writes not one line of authentication:
before every request, Caddy asks the portal whether the visitor has a valid
cookie (`forward_auth`). If so the request continues, with who the visitor is;
if not the portal answers 401 itself, with its sign-in page in the body.

```json
{ "portal": true, "portalExempt": ["/webhook/*"] }
```

Customer previews have nothing to do here: they keep their ten-character lock,
general access *Anyone with the code*, and `validate()` refuses a project
carrying both. The lock's page only reuses the sign-in template, see below.

## How it works

```
browser --> Caddy, block for shop.<zone>
              |
              +-- forward_auth --> portal 127.0.0.1:3026 /verifier
              |                      200 : the request continues, with X-Sitesolide-*
              |                      401 : the sign-in page
              |
              +-- /_portal/* --> the portal itself: sign in, sign out, the passkey's handoff
              +-- the rest   --> file_server, or the project's service

browser --> Caddy, block for portal.<zone>
              +-- /sante, /passkey, /passkey/options, /passkey/verify --> the portal

steward (root) --> /etc/sitesolide-portal/access.json, root:site-portal 0640
                   who may open each site, written after every change of access;
                   the portal reads it again whenever it changes

dashboard (site-dashboard) --> portal 127.0.0.1:3026 /admin/audit, never through Caddy
root, the steward's relay   --> portal 127.0.0.1:3026 /admin/access, what the portal reads its access from
```

Signing in happens on the site itself, at `/_portal/connexion` for a password,
and sets a `__Host-portal` cookie **for that site alone**. You therefore sign in
once per site and per device; a password manager fills the field across every
subdomain of the zone.

**No site shows a sign-out button**: the cookie expires on its own. The
`/_portal/deconnexion` route still exists, a `POST` from the site's own origin,
and a site's app may offer it: it erases the cookie for that host and sends the
browser to `/`. It records a sign-out only for someone who was in. The other
sites' cookies are not touched: each lapses on its own, or closes with that
site's sign-out.

The cookie has three forms, signed by an HMAC whose key mixes a draw kept in
`data/key` with the password hash:

| Holder | Cookie | Signed over | Lives | Revocation |
|---|---|---|---|---|
| owner | `<expiry>.<signature>` | the host, the expiry | 30 days | change the password, or delete `data/key` and restart: everyone is signed out everywhere |
| owner, by passkey | `<expiry>.pk.<passkey>.<signature>` | the host, the expiry, the passkey's reference | 30 days | remove the passkey on the dashboard: refused on the very next request |
| password access | `<expiry>.<access>.<signature>` | the host, the expiry, the access's identifier | 30 days at most, never beyond the access | remove the guest from the site: refused on the very next request |

The owner's cookie is self-sufficient, nothing is kept server-side. A password
access's names its identifier, which the gate looks up in the steward's
projection on every request: that is what makes removal immediate rather than
waiting for the cookie to lapse. A cookie of the form a company account once
received, `<expiry>.id.<identity>.<signature>`, opens nothing any more: its
holder meets the sign-in page.

## Public or restricted: the portal on and off

**A deployed project is restricted, or made public, from the dashboard**, in
the site's *Access* section: *Restrict* puts the portal in front, *Make
public* takes it off, which makes you retype the slug since anyone may then
open the site, and *Use a code* swaps it for a preview code in the same
transaction. The dashboard does not touch Caddy: it
relays to the steward, which launches the gatekeeper, a root one-shot that
rewrites `/srv/sites/<slug>/sitesolide.json` and `/etc/caddy/sites/<slug>.caddy`,
validates the whole configuration, reloads Caddy with `systemctl reload caddy`,
checks that the site answers the portal's 401, or answers without it, and that
every other site still answers, then restores the previous state at the
slightest discrepancy. [dashboard/README.md](../dashboard/README.md) describes
the transaction, its lock and its refusals.

**The machine is then the source of truth.** The repository knows nothing about
it until a `sitesolide deploy` has come back through this project: that is what
takes the machine's general access, rewrites the local `sitesolide.json` and
asks you to commit it. Until then `bin/deploy-caddy.sh`, `domain` and
`remove` refuse to contradict the machine, and say so; `sitesolide lock`
changes it through the same gatekeeper.

General access is the owner's to choose: making a site public or giving it a
code waits for the dashboard's unlock, restricting it never does (see
[docs/access.md](../docs/access.md)). A token never switches it: a deployment
leaves an existing site's general access as it finds it.

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

**`portalExempt` is kept in reserve** when the portal comes off: without
`portal` it does nothing and `validate()` accepts it, but a portal put back
reopens the same paths, signed webhooks included, instead of closing them
silently. **Guests are kept too**: a Public site keeps its list, and opens to
the same guests once it is Restricted again.

A first deployment, which the machine knows nothing about, takes the
repository's: `"portal": true` in the manifest, then `sitesolide deploy`,
which puts the portal in front before the files.

## Password access

For a guest: one site, and a password for it, nothing more. The owner gives
it, from the site's *Access* section in the dashboard or with `sitesolide
share <email>` over SSH, with an expiry chosen then: 24 hours, 7 days (the
default), 30 days or none. A token never gives it.

- **The steward draws the password at random**, four groups of four
  (`Xith-G4r4-nRJs-uDMV`, about 92 bits), and **shows it once**, to whoever gave
  the access, who sends it on. Lost, the access is removed and given again,
  which draws another.
- **The registry and the portal's projection keep only its SHA-256**, beside
  the identifier its cookie carries and its expiry. argon2id slows down whoever
  guesses a human-chosen password; this one has nothing to guess, and a fast
  hash finds it by index instead of checking accesses one at a time, 64 MiB
  each.
- **It is typed on the same page as the owner's.** Sign-in looks first for a
  password access for that host, by its hash, then checks the owner's password.
  An access meant for another site, expired or removed, counts as a failure.
  Its success leaves the site's failures as they stand: they count attempts
  at the owner's password too, and holding one access proves nothing of the
  owner's, which opens every site as admin. Only the owner's own success
  clears them, or a quiet day: failures nobody added to for 24 hours are
  forgotten, so that a burst long past does not make every later typo on the
  site wait up to an hour. Whoever waits a day between bursts gains a few
  tries a day, fewer than the hour's wait already lets through.
- **Expiry closes like removal**: the access is refused as soon as it passes,
  cookie in hand, and the cookie set does not outlive it anyway. Removed, it
  leaves the projection, and its cookie is refused at the next request.
- **The site learns `X-Sitesolide-Role: visitor`, and no email**: the address
  was typed by whoever gave the access, never verified, so it is no identity.
- **Changing the owner's password** also signs password access out, without
  invalidating the passwords.
- **Given before the registry**, when the portal kept these passwords in its
  own `invites` table, it was carried over with its identifier, its hash and
  its expiry: the passwords handed out and the cookies in circulation keep
  working. One given under a name rather than an email
  keeps that name ("Client Bob"), and signs in as `password:<id>` in the audit.

## The owner's passkey

The sign-in page leads with **Sign in with a passkey** once the owner has
registered one on the dashboard (see
[dashboard/README.md](../dashboard/README.md#passkeys)), the password
following under *Were you given a password?* for guests. It lets the owner
in as the owner, `admin`, as the owner's password did; password access is
untouched.

**Once a passkey signs in here, the owner's portal password opens
nothing**, as the dashboard's password stops opening the dashboard. It is
typed on the origin of every protected site, its own domain included, where
a hosted site taken over could serve a copy of the sign-in page and collect
it, and it opens every protected site as `admin`; a passkey answers the
portal's own origin alone. The form still takes it, for password access,
which works as before: the owner's password is not even verified, and a
refusal counts as a failure, as any wrong password does, its message saying
that the owner signs in with a passkey. "A passkey signs in here" is what
the sign-in page offers: a projection naming at least one key for the
portal's relying party. When it names none, none for this zone, or cannot be
read, the password works as before, so that a steward or a projection gone
wrong never locks the owner out of every site. Root's removal of the last
passkey, `sitesolide passkey remove <id>` over SSH, gives the password back
at the next sign-in, the dashboard's with it.

**The ceremony runs on the portal's own host**, `portal.<zone>`, never on
the site: the site's
`/_portal/passkey` sets a binding cookie and sends the browser to the
portal with a sealed flow naming the site's host; the portal's page runs the
ceremony against `POST /passkey/options` and `POST /passkey/verify`, then
sends the browser back to the site's `/_portal/passkey/complete` with a
one-time code, redeemed within a minute, on that host alone, by the browser
that holds the binding, for the owner's cookie alone. A site on its own
domain takes the same road, so the passkey is offered there too: a passkey
answers only a page under the zone it was registered for, and the portal's
host is one.

| Measure | Detail |
|---|---|
| Relying party | the zone, so that the dashboard's passkey serves here |
| Origin | `https://portal.<zone>` alone, never another host of the zone: a hosted site taken over gets assertions naming its own origin, refused here and at the steward |
| Public keys | the steward's projection, `/etc/sitesolide-portal/passkeys.json`, ids and public keys alone, read again when it changes; the portal keeps no counter and writes nothing back |
| User verification | required |
| Rate limiting | per client, as Caddy saw it: twenty challenges and ten verifications a minute, beside caps for the whole machine; failures recorded at most thirty a minute |
| What it grants | **the one site it was asked for**: the cookie is bound to that host, as every portal cookie is, and opens neither another site nor the dashboard, which asks for its own passkey ceremony |
| Revocation | the cookie names the passkey, which the gate looks up in the projection on every request: a passkey removed on the dashboard closes every site it opened at their next request |

The audit records `portal.signin` with `method: passkey`, and a refused
ceremony as `portal.signin_failed`.

## Who may open a site

The steward decides, the portal reads. A restricted site opens to:

| Who | Signs in with | `X-Sitesolide-Role` |
|---|---|---|
| the owner | a passkey, or the owner's password | `admin`, on every site |
| a guest of the site | the password drawn for them | `visitor` |

**Public is not an entry.** It is the portal turned off, general access
*Public*, from the site's *Access* section through the steward and the
gatekeeper, see above.

**Who may change it.** The owner alone, from the dashboard's *Access* section
or with `sitesolide share` in the project's folder, over SSH, root asking the
steward's owner socket. Every way ends at the steward, which judges each change
by one set of rules (`dashboard/src/access/rules.ts`), writes it, and records
it in its journal, `access.add` or `access.remove`, under `owner`. A token
never gives anyone access. [docs/access.md](../docs/access.md) has the
owner's side.

**The projection.** After every change the steward writes
`/etc/sitesolide-portal/access.json`, `root:site-portal 0640`, beside the
passkeys' projection: root writes it, the portal's account reads it, the
dashboard's cannot. Per host, `<slug>.<zone>`: its password accesses, each an
identifier, who it was given to, a SHA-256 and an expiry, never a password.
The steward writes it before its own registry, so that a change the portal
cannot be told of is no change, and writes it again from the registry at
every start. A projection written while people signed in with a company
account also carries `people` and `domains`: they are ignored, and the
steward's next write leaves them out.

**Read again when it changes.** The portal keeps no list of its own. Before
every decision it looks at the file's inode, size and modification time, one
`stat` and nothing more when it has not moved; a file that moved is read whole
and judged (`readProjection`, in `src/access.ts`). A guest removed is refused
at their next request, cookie in hand. Caddy is never touched, and nothing
restarts.

**A projection that does not read opens nothing from it**: one that is not
JSON or not of the expected shape, a link, a folder, more than 8 MiB. The
owner, who needs no list, still opens every site. The journal says so once
(`journalctl -u portal`), and the file is read again at its next change.

**Before the steward writes it**, on a machine being set up, a missing
projection opens nothing either. `GET /admin/access` says what the portal
reads, and the steward asks it through its relay, so that `sitesolide share`
warns while the portal cannot read it. The tables `sharing` and `invites`,
where a portal up to 0.3 kept who could open a site, may still sit in
`data/portal.db`: nothing reads them.

The rule of an email lives in `src/email.ts`, pure, which the dashboard and
the steward borrow, the page included: the page refuses an address with the
exact rule the portal applies. An address is compared exactly, in lowercase,
and narrower than the RFC allows: no quoted local part, no space, no accent,
every one of them a way to make two strings look like the same person. The
projection's format lives in `src/access.ts`, borrowed the same way, so that
the steward writes exactly what the portal reads.

## Who came in: the identity headers

On a `200`, the portal tells Caddy who came in, and the site's block copies
it onto the request the site receives:

| Header | Value |
|---|---|
| `X-Sitesolide-Role` | `admin` for the owner, `visitor` for a guest with password access |

**It changed twice.** Before the access registry the role read `member` or
`guest`; while people signed in with a company account, it could also read
`viewer` or `developer`, and `X-Sitesolide-User` and `X-Sitesolide-User-Name`
carried their verified email and name. The portal sets neither of those two
any more. An app that compared the role with anything but `admin` and
`visitor`, or read either header, must be updated.

**The visitor cannot forge them.** The block takes every `X-Sitesolide-*` header
the visitor sent off every request, the service's paths, the files and the
exempted paths alike, before the portal is asked, then copies the portal's on.
`X-Sitesolide-User` and `X-Sitesolide-User-Name` are still taken off, so
that no visitor sends them to a site that once read them. Caddy
sorts `request_header` after `forward_auth` on its own, which would take
off the portal's headers instead: the stanza holds both in a `route`, the only
directive that keeps the written order. Measured in a real Caddy by
`bin/tests/cli-portal-identity-caddy.test.ts`, which sends
`X-Sitesolide-User: ceo@acme.test` with and without a cookie.

The underscore spellings go too, `X_Sitesolide_User` and its mixes: a CGI-style
app server, PHP's, Rack's or WSGI's, reads them as the dash form. Caddy 2.11
drops such a header on arrival, but nothing pins Caddy's version. Go
canonicalises a name on arrival, so every spelling an app could merge with the
portal's starts with `X-Sitesolide` or `X_sitesolide`: the block takes off
`X-Sitesolide*` and `X_sitesolide*`, see `IDENTITY_STRIP` in `bin/cli/portal.ts`.

**A public site takes them off too**: a site made
Public, or never restricted, and its own domain's block. Its block carries the
same two `request_header` lines, at the block's level, where they need no
`route` since nothing in the block copies anything on. Its app is told nobody,
and never a stranger's `X-Sitesolide-Role: admin`.

**Trust them only once the site's block carries them.** A block deployed before
identity headers existed, protected or not, takes nothing off, and its app receives
whatever the visitor sends. A protected one keeps working with this portal: the
dashboard says so for that site. The next `sitesolide deploy` of the site, or
its general access switched from the dashboard, upgrades the block. An
exempted path never carries them: it does not go through the portal.

Reading it in a Bun service:

```ts
Bun.serve({
  port: Number(process.env.PORT),
  hostname: "127.0.0.1",
  fetch(req) {
    const role = req.headers.get("x-sitesolide-role"); // "admin" for the owner, "visitor" for a guest
    if (role !== "admin") return new Response("Read only for guests", { status: 403 });
    return new Response("Hello owner");
  },
});
```

## The admin API

On the portal's port, called by the dashboard, and by root through the
steward's relay:

| Route | What it does |
|---|---|
| `GET /admin/access` | what the portal decides who may open a site from: `{ "reading", "writtenAt" }`, `reading` being `steward` (the projection) or `unreadable` (a projection that does not read, or none), and `writtenAt` the projection's date when it reads one, null otherwise. The steward asks it through its relay, and says it in every access answer |
| `GET /admin/audit?limit=&before=` | the audit, most recent first, by pages |

They have no secret, and that is deliberate: the only accounts that can reach
that port are root, Caddy and `site-dashboard`, through the exception
`bin/cli/loopback.ts` adds to the loopback rule, and a shared secret would
protect nothing more. The steward, which keeps no network, comes as root
through `sitesolide-portal-relay`, a socket only root opens, behind which
systemd's proxy forwards to this port and nowhere else; it asks
`GET /admin/access` alone. None of these routes changes who may open a
site: the steward writes that, in the projection, and nothing here can.

Caddy never relays them: a protected site forwards to the portal only
`/_portal/*` and the `forward_auth` call to `/verifier`, and the portal's own
host only `/sante` and the passkey's `/passkey`, `/passkey/options` and
`/passkey/verify`.
`bin/tests/cli-portal.test.ts` checks that no fragment aims at anything else.
The portal's own block refuses an ambiguous path with 400, as a protected
block does: Caddy compares a path such as `/admin/access/..%2f..%2fsante`
cleaned, as `/sante`, and would relay it raw, which Bun routes to the admin
API. As one more
net, any request carrying `X-Forwarded-For`, which Caddy puts on what it
relays, or `X-Portal-Hote`, is refused.

To read them by hand on the machine:
`sudo curl http://127.0.0.1:3026/admin/access`.

## The audit

The portal records in its own database, table `audit`, the shape every component
of the repository shares (`id`, `at` in ISO 8601 UTC, `actor`, `action`,
`target`, `detail` as JSON):

| Action | Actor | Detail |
|---|---|---|
| `portal.signin` | `owner`, or for password access the email it was given to, `password:<id>` for a name carried over from before the registry | `method`: `password`, `passkey` or `password-access`; `name` for a password access given under a name; `count` when repeated |
| `portal.signin_failed` | `anonymous` | `method`, and for a passkey the `reason`, `removed-passkey` for instance |
| `portal.signout` | who the cookie names, as for a sign-in | none, or `count` when repeated |
| `sharing.update`, `guest.create`, `guest.revoke` | in rows written before the registry alone, as they were written | who could open a site changed, a password access given or removed; the portal writes none any more |

Older rows read as they were written: a password access's sign-in as
`guest:<access>` with `method` `guest`, a company account's under its email
with `method` `oidc`. A change of who may open a site is the steward's to
record, in its journal: `access.add` and `access.remove` under `owner`. The
dashboard's *Activity* reads both.

Never a password, a code or a token. What a stranger can cause is bounded where
it happens: failed password attempts by the rate limiting, a row per attempt
allowed; failed passkey sign-ins, thirty a minute, the rest of that minute
unrecorded; a code that was never minted, and a sign-out by
someone who was not in, never. What a holder of a cookie or a password access
can repeat as fast as the network allows, a sign-in or a sign-out, makes one
row per actor, site and minute: the row keeps the time of the first, and
`detail.count` says how many came in that minute. Beyond 180 days, or beyond
100,000 rows, the oldest events are forgotten, except that the row cap never
takes a row of the last 30 days: a loop of sign-ins cannot push the last
month out of the audit, and the file may then grow past the cap, by at most a row a
minute per actor, site and action. The dashboard reads them through
`GET /admin/audit`, for its Activity page.

## The page

**Sign-in and the preview lock's page are one template**, `src/page.ts`: same
card, same mark, two forms. The lock's page, served by Caddy and not by this
service, is written by the dashboard's gatekeeper into `/srv/garde/<slug>/`
when a site opens with a code, from this very template; to look at it:

```bash
bun run lock-page ./somewhere.html
```

It is not committed, because its footer carries the address to ask for a code,
which belongs to each installation.

Its CSS is hand-written and inline, and that is the repository's one Tailwind
exception: the lock's page is served for every URL of the locked host, and its
own resources would serve themselves in a loop.

It is drawn in Ledger, the landing page's design, light or dark as the browser
prefers, with the landing page's values and, where it has none, the
dashboard's, so that the dashboard's sign-in and this one read as one product:
the same mark, the same card on the same paper, the field sunk as the
dashboard's is, the same pressable teal, and the dashboard's error red, since
the landing page's own falls short of 4.5:1 on the notice. Its faces are named,
Hanken Grotesk and IBM Plex Mono, and never fetched: a font file cannot be
served beside the lock's page, and carried in `data:` they would add some
65 KB to every 401 of every protected site. A browser without them shows its
system face at Ledger's sizes and weights, the one difference left with the
dashboard, which serves its own.

The portal's own host shows the same card at its root, `public/index.html`,
committed and written from the template by `bun run home-page`; a test fails
when the two part.

Once a passkey is offered (see [The owner's passkey](#the-owners-passkey)),
the owner's password opens nothing here, and the page says so by its order:
*Sign in with a passkey* is the primary button, with a key drawn inline;
then, below a divider, the password under *Were you given a password?*,
beside a quiet *Enter*, for guests. The passkey's button is a link to the
site's `/_portal/passkey`, not a form: it redirects to the portal's own
host, where the ceremony runs, and the CSP's `form-action 'self'` would refuse
a form's redirect there. The password
is not folded behind a disclosure, since a guest who finds no field reads
the page as closed to them, and it is not focused, so as not to invite the
owner's. A refused password answers under its field, focused again; every
other message, the passkey's, leads the card. Without a
passkey offered the page is the one above, unchanged.

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
  A WebSocket handshake needs it too, a GET though it is: a page on a sibling
  host opens one with the visitor's cookie, and unlike a GET's answer, which
  the browser keeps from that page, a socket's messages are the page's to
  read. A handshake is told by `Sec-WebSocket-Key` as much as by `Upgrade`,
  which a proxy may drop on the way (`isWebSocketHandshake`, `src/gate.ts`).
  Every browser sends the Origin with one; a client outside a browser sends
  it too, or is refused.
- **A protected site is framed by its own origin alone.** A frame from
  another site carries no `Lax` cookie and shows the sign-in page, which no
  page may frame (`frame-ancestors 'none'` and `X-Frame-Options: DENY`, the
  door page of a preview lock too). A frame from a sibling host of the zone,
  the same site to a browser, does carry it, and a page there could have the
  visitor click through the app: `/verifier` answers 403 to a request whose
  `Sec-Fetch-Dest` is a frame and whose `Sec-Fetch-Site` is not
  `same-origin` (`isFramedElsewhere`, `src/gate.ts`). Here rather than a
  header in every block, so that no block in service needs deploying again.
  A browser that sends no `Sec-Fetch-*` is let through as before. A
  protected site meant to show inside another one of the zone is not
  supported; a public site keeps whatever framing it chooses, see
  [the manifest's `headers`](../docs/manifest.md#headers).
- **`X-Portal-Hote` comes from Caddy, never from the visitor.** `header_up`
  overwrites it, and it is the host the cookie signs. On the portal's own host,
  where Caddy does not set it, only `/sante` and the passkey's routes reach
  the service, which never read it: that is the manifest's `routes` allow list.
- **A site's own domain is judged on the site's guests.** Its block announces
  `X-Portal-Hote: <domain> <slug>.<zone>`: the host the browser is on, which
  signs the cookie, checks the Origin and is where a sign-in comes back to,
  then the site's address, under which the steward's projection files its
  password access. Both in the one header every protected block
  overwrites: a second header would pass through a block deployed before it
  existed, untouched, and a visitor allowed on one site would have the portal
  judge them against it on any other. A cookie is the domain's alone, so the
  preview and the domain each ask once; failed passwords count per site, the
  two addresses together. `readAnnounced` in `src/gate.ts`, `announcedFor` in
  `bin/cli/portal.ts`, measured in `bin/tests/cli-domain-caddy.test.ts`.
- **A protected site trusts Caddy**, and that trust only holds because of the
  loopback rule, `bin/deploy-loopback.sh`: without it, any service on the machine
  could reach the site's port without going through Caddy, identity headers
  included.
- **The portal goes in front before the files.** `deploy` reverses its order
  for a protected site: otherwise its files would be served in the clear by the
  wildcard block until the fragment arrives. And it refuses to send anything
  while the portal does not answer with a hash in place.
- **An exempted path is public.** It does not go through the portal, and the
  site answers for it alone, a signed webhook, typically. It carries no role.
- **An ambiguous path is refused with 400.** Caddy decodes `%2f` and cleans `..`
  before comparing against the exemptions, while the service routes on the raw
  path: `/api/x%2f..%2f..%2fhook/y` looked like an exemption to Caddy and reached
  `/api/x/...` with no cookie. Found during a migration, measured in a real
  Caddy, closed by `@portal_ambiguous`, which the portal's own block carries
  too, in front of its allow list.
- **Portal stopped, protected sites answer 502** and serve nothing.
  `lb_try_duration` makes a request wait out a restart. A restart also forgets
  the handoff codes in flight: whoever was in the middle of a redirect signs in
  again.
- **The stanza has one `route`**, and must keep only that: see *Who came in*.
  The comparison of blocks reads a `route` in its order, so a line moved inside
  it is a divergence, never a block judged identical. An open block carries its
  `request_header -X-Sitesolide*` at its own level, which is sound because it
  has no `forward_auth`. Never put one in the `(<slug>-routes)` snippet or in
  `(commun)`, which protected blocks import: measured, it then holds only as
  long as their `forward_auth` stays inside its `route`, and one outside, the
  earlier generation's or a hand-written one, sorts before it and loses the
  portal's headers.

## What the portal does not protect

- A password is typed on every site: an XSS flaw in one of them, or a hosted
  site taken over serving a copy of the sign-in page, could capture it. A
  passkey types nothing on the site, and once the owner holds a passkey the
  owner's password opens nothing (see
  [The owner's passkey](#the-owners-passkey)); a password access, one site's
  alone, stays exposed that way.
- A compromised portal opens every restricted site; that is the price of one
  shared sign-in. It gives neither their data, each service staying confined to
  its own directory, nor the customer sites, nor the certificates. It cannot
  change the registry, which is root's, nor the projection, which root writes
  and it only reads; and it records no change of access, so it can write none
  under anyone's name.
- A compromised dashboard cannot give password access without the owner's live
  unlock, which it does not hold. It can take a guest off and restrict a site,
  since closing never waits, only through the steward, which judges the change
  by its rules and records it. It never sees a password hash nor an access's
  identifier, the steward handing it views alone; a password it gives, it sees
  once, as the owner at the page would. During an unlock it can also make a
  site Public, retyping the slug only guarding against a misclick. Changing
  the owner's password also requires the dashboard's own, which the steward
  checks, but which compromised code would capture as it is typed. It never
  touches Caddy itself: the gatekeeper refuses everything its rules refuse,
  and restores.
- A stolen token gives nobody access: no route takes a token to change who may
  open a site. Revoking it on the dashboard's *Tokens* page stops whatever else
  it carries.
- Signing out of one site does not sign out of the others: each keeps its own
  cookie until it lapses.
- A site's own JavaScript reads none of the cookies, all `HttpOnly`, but its
  server receives them on every request, like any cookie of its host: a
  compromised site can replay its own visitors' cookies on itself, nowhere else.
- Rate limiting is in memory, per site and per client within it, and forgets a
  site's failures after a quiet day: whoever sends wrong passwords to one site
  makes their own address wait, up to an hour, and nobody else; cookies
  already held keep working. Filling the passkey's handoff codes in flight,
  ten thousand, makes new passkey sign-ins wait for codes to lapse, a minute
  each; nothing opens.

## Password

**On a new machine**, the first `cd portal && sitesolide deploy` stops on
`portal.env`, missing on the machine, and says where to create it: in the
dashboard, the `portal` site's *Secrets*, create `portal.env`, then *Change
password*, which draws the password and shows it once. Run the deploy again.
`deploy` never pushes a secret, see [docs/install.md](../docs/install.md). The
steward creates the file `site-portal:site-portal 0600`; one written by hand
with another owner is listed as unmanaged, with the command that repairs it,
and nothing, *Change password* included, touches it until then.

**After that the password changes from the dashboard**, in the `portal` site's
*Secrets*: *Change password*, the dashboard's own password retyped, a new one
drawn and shown once, or chosen, sixteen characters minimum, then *Restart
service* so the portal re-reads its environment. The old hash is not kept and
does not come back: it may be the one that leaked. `portal.env` carries that
hash alone, and the steward refuses any other variable in it, but for the
leftover `OIDC_*` settings of a portal that once signed people in with a
company account: tolerated, ignored, and removable from the same page (see
[docs/upgrading.md](../docs/upgrading.md)). Changing the password signs
everyone out, password access included.

Locally, the hash goes on the command line rather than through `bun --env-file`,
which expands the `$` of an argon2id hash:

```bash
PASSWORD_HASH="$(bun -e 'console.log(await Bun.password.hash("test"))')" bun run dev
```

## Tests

```bash
bun run check                                            # decisions, routes, database, page, the whole sign-in flow, typing
bun test ../bin/tests/cli-portal-caddy.test.ts           # the generated fragment, in a real Caddy
bun test ../bin/tests/cli-portal-identity-caddy.test.ts  # the identity headers, in a real Caddy
```

`tests/passkey-signin.test.ts` runs the owner's passkey sign-in through its
routes: the owner let in on one host alone, a site on its own domain taking the
same road, the code redeemed once by the browser that began on the host it was
minted for, and every refusal, an assertion made on another origin, another
Origin, an unknown passkey, a user not verified, a spent challenge, a forged
flow. `tests/handoff.test.ts` holds the one-time codes to the same rules.

`tests/routes.test.ts` and `tests/gate.test.ts` refuse a WebSocket handshake
from another origin, a GET though it is, keep the site's failures when
password access signs in, and forget them after a quiet day.

`tests/admin.test.ts` reads what `GET /admin/access` says, pages the audit,
and refuses a relayed request.

`tests/projection.test.ts` reads the steward's projection from disk: a read
that failed on the way, too many open files or an I/O error, tried again a few
seconds later rather than at the next change; a rewrite
seen at the very next call, a file that has not moved never read again, a
malformed one, a link, a folder or a file beyond the bound opening nothing, and
a projection of before read for its password accesses alone.
`tests/access.test.ts` judges the projection's format, the people and domains
of before ignored, and a password access's expiry and actor.

The two `bin/tests` files run Caddy on your workstation, `admin off` on a free
port, in front of this service and fake sites: what the portal promises hangs
entirely on the order in which Caddy sorts directives, and an order is
measured, not read. The first also checks that the admin API cannot be reached
through the site, and that a WebSocket handshake from another origin is
refused at the door while the site's own goes through, `forward_auth`
handing the portal the Origin, `Upgrade` and `Sec-WebSocket-Key` as the
browser sent them. The second sends forged identity headers to every kind of
path, the underscore spellings put on inside Caddy since they cannot
arrive, to a protected site, an open one and its customer domain; checks that
the portal's own block refuses an ambiguous path and serves nothing of the
site side, the admin API nor a company sign-in; and that a block from before
identities still works with this portal.
