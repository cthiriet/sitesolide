# portal

The sign-in in front of every restricted site. Three ways in: the owner's
password; password access, one password per person and per site for someone
outside the company; and, once an identity provider is configured, **the
company's own accounts**, Google Workspace, Microsoft Entra, Okta or Keycloak.
Who may open a site is not the portal's to keep: it is the steward's registry
of people with access, each with a role, which the portal reads as a
projection the steward writes for it. A restricted site also learns who came
in, and with which role, through three request headers it can trust.

A restricted project carries `"portal": true` in its `sitesolide.json`,
which is what its general access *Restricted* means, set from the dashboard
once the project is deployed, and writes not one line of authentication:
before every request, Caddy asks the portal whether the visitor has a valid
cookie (`forward_auth`). If so the request continues, with who the visitor is;
if not the portal answers 401 itself, with its sign-in page in the body.

```json
{ "portal": true, "portalExempt": ["/webhook/*"] }
```

Customer previews have nothing to do here: they keep their six-character lock,
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
              +-- /_portal/* --> the portal itself: sign in, sign out, the provider's handoff
              +-- the rest   --> file_server, or the project's service

browser --> Caddy, block for portal.<zone>
              +-- /sante, /oidc/start, /oidc/callback, /oidc/signout --> the portal

steward (root) --> /etc/sitesolide-portal/access.json, root:site-portal 0640
                   who may open each site, written after every change of access;
                   the portal reads it again whenever it changes

dashboard (site-dashboard) --> portal 127.0.0.1:3026 /admin/sharing (how people sign in, its old name kept), /admin/audit,
                               /admin/dashboard/flow, /admin/dashboard/redeem
                               never through Caddy
root, the steward's relay   --> portal 127.0.0.1:3026 /admin/access, what the portal reads its access from
either of them              --> PUT /admin/sharing/:host, /admin/guests, /admin/invites/:id: 410, moved to the steward
```

Signing in happens on the site itself, at `/_portal/connexion` for a password,
and sets a `__Host-portal` cookie **for that site alone**. You therefore sign in
once per site and per device; a password manager fills the field across every
subdomain of the zone, and the identity provider remembers you across sites.

**No site shows a sign-out button**: the cookie expires on its own. The
`/_portal/deconnexion` route still exists, a `POST` from the site's own origin,
and a site's app may offer it: it closes the cookie for that host. With a
provider configured, it also ends the portal's own session: its answer is a
page that sends the browser on to `portal.<zone>/oidc/signout`, with a ticket
naming the site, sealed for a minute, and the portal's host erases its session
and sends the browser back to the site. Until the next sign-in succeeds, that
browser counts as signed out, and a sign-in asks the provider which account
(`prompt=select_account`): on a shared computer, the next person clicking *Sign
in with ...* would otherwise come back as the previous one. A page and not a
redirect, because a browser applies the site's own `form-action` to every
redirect after a form; it carries `X-Portal`, so a front end that signs out with
`fetch` reloads on it. The other sites' cookies are not touched: each lapses on
its own, or closes with that site's sign-out.

The cookie has three forms, signed by an HMAC whose key mixes a draw kept in
`data/key` with the password hash:

| Holder | Cookie | Signed over | Lives | Revocation |
|---|---|---|---|---|
| owner | `<expiry>.<signature>` | the host, the expiry | 30 days | change the password, or delete `data/key` and restart: everyone is signed out everywhere |
| password access | `<expiry>.<access>.<signature>` | the host, the expiry, the access's identifier | 30 days at most, never beyond the access | remove it from the site's people with access: refused on the very next request |
| identity | `<expiry>.id.<identity>.<signature>` | the host, the expiry, the verified email and name | 24 hours at most, never beyond the portal session it came from | remove the person from the site's people with access: refused on the very next request |

The owner's cookie is self-sufficient, nothing is kept server-side. A password
access's names its identifier, which the gate looks up in the steward's
projection on every request, and an identity's names an email, which the gate
judges against the site's people with access in that projection on every
request: that is what makes removal immediate rather than waiting for the
cookie to lapse. The first two forms are the ones from before identities,
unchanged, and the registry carried every password access over with its
identifier: the cookies in circulation stay valid across the upgrade.

## Public or restricted: the portal on and off

**A deployed project is restricted, or made public, from the dashboard**, in
the site's *Access* section: *Restrict* puts the portal in front, *Make
public* takes it off, which makes you retype the slug since anyone may then
open the site. The dashboard does not touch Caddy: it
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
asks you to commit it. Until then `bin/deploy-caddy.sh`, `sitesolide lock`,
`unlock`, `domain` and `remove` refuse to contradict the machine, and say so.

General access is switched by the owner, or by an Admin of the project:
making a site public waits for their unlock, restricting it never does (see
[docs/access.md](../docs/access.md#people-with-access-beside-tokens)).
A token never switches it: a deployment leaves an existing site's general
access as it finds it.

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
silently. **People with access are kept too**: a Public site keeps its list,
and opens to the same people once it is Restricted again.

A first deployment, which the machine knows nothing about, takes the
repository's: `"portal": true` in the manifest, then `sitesolide deploy`,
which puts the portal in front before the files.

## Password access

For someone the portal cannot identify with a company account: a person
outside the company's domains (`OIDC_ALLOWED_DOMAINS`), or anyone when no
provider is configured. They are given Can open on one site, and a password
for it. The owner or an Admin of the project gives it, from the site's
*Access* section or with `sitesolide share <email>`, with an expiry chosen
then: 24 hours, 7 days (the default), 30 days or none. A token never gives it.

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
- **Expiry closes like removal**: the access is refused as soon as it passes,
  cookie in hand, and the cookie set does not outlive it anyway. Removed, it
  leaves the projection, and its cookie is refused at the next request.
- **The site learns `X-Sitesolide-Role: visitor`, and no `X-Sitesolide-User`**:
  the email was typed by whoever gave the access, never verified by a
  provider, so it is no identity.
- **Changing the owner's password** also signs password access out, without
  invalidating the passwords.
- **Given before the registry**, when the portal kept these passwords in its
  own `invites` table, it was carried over with its identifier, its hash and
  its expiry: the passwords handed out and the cookies in circulation keep
  working. One given under a name rather than an email
  keeps that name ("Client Bob"), and signs in as `password:<id>` in the audit.

## Signing in with a company account

Optional, and off until the portal's environment says otherwise: without the
settings below the portal behaves exactly as it always has, and its sign-in page
shows no button.

Any provider that speaks OpenID Connect works: the portal reads its discovery
document, sends the person there with the authorization code flow, PKCE
(S256), a `state` and a `nonce`, and verifies the ID token it gets back against
the provider's published keys, with WebCrypto and no dependency: RS256, ES256
and their siblings, never `none` nor an HMAC. The token must name the
configured issuer and this client, must not have expired (one minute of
tolerance for clocks), must carry the flow's nonce, and must carry an email the
provider verified (`email_verified`, or `xms_edov` for Microsoft Entra, which
sends no `email_verified`; `xms_edov` counts only when the issuer is
`login.microsoftonline.com`, the one provider that defines it). The address must
arrive exactly as an address: a space or a character outside ASCII anywhere in
it refuses the sign-in rather than being cleaned into someone else's.

### One callback, on the portal's own host

A provider redirects only to addresses registered in advance, and a site cannot
be registered each time one is protected. Every sign-in therefore goes through
**one fixed callback, on `portal.<zone>`**:

```
shop.<zone>/_portal/oidc            binding cookie on the site, the flow sealed for that host
  -> portal.<zone>/oidc/start       known already? straight back with a code; otherwise:
  -> the provider                   the person signs in
  -> portal.<zone>/oidc/callback    token verified, portal session, one-time code minted
  -> shop.<zone>/_portal/oidc/complete?code=...   code redeemed for that host, cookie set
```

The portal remembers who signed in on its own host for 24 hours, so the next
site skips the provider and only bounces through the portal. A site's cookie
never outlives that session: a site reached in its last minute gets a minute,
not a day, so an account closed at the provider is out of every site 24 hours
after it last signed in there. Nothing relies on a cookie shared across the
zone, which is why a customer's own domain would work the same way.

What each step defends, tested in `tests/sso.test.ts` against a provider the
tests run themselves, through real HTTP:

- **No code for a host this machine does not serve as a restricted site.** The
  flow is sealed when it begins, with the host Caddy announced through
  `X-Portal-Hote`: only a protected site's fragment relays `/_portal/*`, so only
  a protected host can begin one, and an altered flow is refused before the
  provider.
- **Login CSRF.** The callback needs the transaction cookie set on the portal's
  host when that browser left for the provider, named after its `state`: a
  callback address sent to someone else finds nothing.
- **Session fixation.** The code is bound to a binding cookie drawn on the site
  when the flow began, which the flow and the code only carry as a hash: a link
  carrying someone's code, opened in another browser, signs nobody in, and burns
  the code.
- **Replay.** A code lives sixty seconds, in the portal's memory only, under its
  hash, and is gone at the first attempt to redeem it, right or wrong, on the
  right host or not. The transaction cookie is erased by the callback. A flow
  mints one code, ever: replaying `/oidc/start` with the same flow and a portal
  session mints no second one, and one email holds ten codes in flight at most,
  so one account cannot fill the ten thousand the portal keeps.
- **Code interception.** The provider's authorization code is worth nothing
  without the PKCE verifier, held in the transaction cookie of the browser that
  started, and the client secret. A provider that names itself in the callback
  (`iss`, RFC 9207) must name the configured one.
- **Open redirect.** The return path is the one the sign-in page carried,
  judged by the same rule as the password's: a path of the same host, never
  `//elsewhere`.

On the portal's own host Caddy does not overwrite `X-Portal-Hote`, so the
visitor chooses it there: `/oidc/start`, `/oidc/callback` and `/oidc/signout`
never read it, the last one taking its site from the sealed ticket. The site's
routes, `/_portal/oidc` and `/_portal/oidc/complete`, are only reachable
through a protected site, which sets it.

### The settings

In `portal.env`, from the dashboard: the `portal` site's *Secrets*, then
*Restart service*. The steward accepts these names in that file and still
refuses any other, `DATA_DIR` or `PORT` for instance, which would change how the
portal runs.

| Variable | What it holds |
|---|---|
| `OIDC_ISSUER` | the provider's issuer, exactly as its discovery document writes it |
| `OIDC_CLIENT_ID` | the client the provider registered for this portal |
| `OIDC_CLIENT_SECRET` | its secret; read back only once changes are unlocked, like any secret |
| `OIDC_ALLOWED_DOMAINS` | optional, comma separated: only emails at these domains may sign in at all, and with Google only accounts of their Workspace (`hd`), see below. They are the company's domains of the access rules: a person at one of them may be given any role, anyone else password access. Empty, anyone the provider vouches for may sign in, and still only opens the sites they have access to |
| `OIDC_ADMIN_EMAILS` | optional, comma separated: always let in, on every restricted site, as `admin`, and shown as such in the dashboard's *People* |
| `OIDC_PROVIDER_NAME` | optional, the button's label after "Sign in with". Defaults to Google or Microsoft from their issuer, "your company account" otherwise |

The callback to register at the provider is the portal's own address followed
by `/oidc/callback`: **`https://portal.<zone>/oidc/callback`**, with your zone in
place of `<zone>`. The portal learns its address from `PUBLIC_URL`, which its
manifest writes as `https://{slug}.{zone}`.

Half configured, the portal offers nothing and prints at startup what is
missing, never a value: `journalctl -u portal`. Removing the settings, then
restarting the portal, closes every identity session at the next request, an
admin's included.

### Google Workspace

1. In the Google Cloud console of your Workspace organization, create or pick a
   project, then *APIs & Services*, *OAuth consent screen*: user type
   **Internal**, so that only your organization's accounts can sign in. The
   default scopes are enough: `openid`, `email`, `profile`.
2. *Credentials*, *Create credentials*, *OAuth client ID*, application type
   **Web application**. Under *Authorized redirect URIs*, add exactly
   `https://portal.<zone>/oidc/callback`. Create, and copy the client ID and
   the client secret.
3. In the dashboard, `portal` site, *Secrets*, `portal.env`:
   `OIDC_ISSUER` = `https://accounts.google.com`, `OIDC_CLIENT_ID`,
   `OIDC_CLIENT_SECRET`, `OIDC_ALLOWED_DOMAINS` = your domain,
   `OIDC_ADMIN_EMAILS` = your own address. *Restart service*.

**Why Internal, and what `OIDC_ALLOWED_DOMAINS` adds with Google.** Google says
`email_verified` of any account whose address was proved once, a personal
Google account opened with a work address included, and that account outlives
the mailbox: someone who left the company keeps a Google account that still
carries `alice@acme.com`, verified. Google speaks for a company address only
when the account belongs to the company's Workspace, which the token names in
its `hd` claim. So, with Google:

- with `OIDC_ALLOWED_DOMAINS` set, the portal also requires `hd` to be one of
  those domains, which turns such a personal account away; list every domain of
  your Workspace there, the primary one included. The admin emails are let in
  by name, `hd` or not;
- without it, `hd` is not checked, by design: anyone Google vouches for may sign
  in, and only opens the sites they have access to by address or domain, which
  such a personal account would match. Keep the consent screen **Internal**
  then: only your Workspace's accounts reach the portal at all.

Other providers vouch for their own directory and send no `hd`: nothing more
is checked for them.

### Microsoft Entra ID

1. Entra admin center, *Identity*, *Applications*, *App registrations*, *New
   registration*. Supported account types: **Accounts in this organizational
   directory only** (single tenant). Redirect URI: platform **Web**,
   `https://portal.<zone>/oidc/callback`. Register.
2. On the overview, copy the *Application (client) ID* and the *Directory
   (tenant) ID*.
3. *Certificates & secrets*, *New client secret*: copy its **Value**, not its
   ID. It expires, 24 months at most: note the date, and replace it in
   `portal.env` before then, or nobody signs in with Microsoft that day.
4. *Token configuration*, *Add optional claim*, token type **ID**: tick
   `email` and `xms_edov`, and accept the Microsoft Graph permission it asks
   for. Without `xms_edov` the portal cannot tell a verified address from one
   the account's holder typed, and refuses every sign-in.
5. In `portal.env`: `OIDC_ISSUER` =
   `https://login.microsoftonline.com/<tenant ID>/v2.0`, `OIDC_CLIENT_ID`,
   `OIDC_CLIENT_SECRET`, `OIDC_ALLOWED_DOMAINS`, `OIDC_ADMIN_EMAILS`. *Restart
   service*. The multi-tenant `common` issuer is refused: its discovery document
   names a template, not an issuer.

An account without an email address in Entra cannot sign in: access is given
by email.

### Okta, Keycloak

The same three values. Okta: a *Web Application* integration with the sign-in
redirect URI above, issuer `https://<your org>.okta.com` or the authorization
server's, `https://<your org>.okta.com/oauth2/default`. Keycloak: a confidential
client with the standard flow, the redirect URI above, issuer
`https://<host>/realms/<realm>`; `email_verified` follows the user's *Email
verified* flag.

### The portal needs the network

A sign-in calls the provider: its discovery document, its keys, its token
endpoint. The portal's manifest therefore declares `"network": "outbound"`,
which lifts the loopback-only confinement of its unit, everything else holding.
That is the price of the feature, and it is paid whether or not a provider is
configured.

## Signing in to the dashboard

People with a role above Can open on a project, Viewer, Developer or Admin, or
the right to create projects, sign in to the dashboard with the same provider,
through this same portal ([dashboard/README.md](../dashboard/README.md#access)).
Someone with Can open alone, by name or through a domain, does not: the
steward refuses them with `can-open-only`, which the dashboard says as "You
can open the sites shared with you. The dashboard is for Viewers and above:
ask an Admin of the project if you need more." Someone on no list is refused
with `no-role`: "This account has no access to any project here. Ask the
owner, or an Admin of the project, to add you." The dashboard is never
restricted and has no network: it cannot run a sign-in, and must not be believed when it
names someone. So it asks the portal over the loopback, and the portal runs
the flow it runs for a protected site, with the dashboard's host in the
site's place:

```
dashboard.<zone>/api/sso/begin       binding cookie on the dashboard
  -> POST /admin/dashboard/flow      loopback: a flow sealed for the dashboard's host, around that binding
  -> portal.<zone>/oidc/start        as for a site; the portal's session spares the provider if younger than 12 hours
  -> the provider, portal.<zone>/oidc/callback
  -> dashboard.<zone>/api/sso/complete?code=...
  -> POST /admin/dashboard/redeem    loopback: the code and the binding, for a signed assertion
```

**A code says what it was minted for.** A dashboard's flow mints a code for
the dashboard, which `/admin/dashboard/redeem` alone redeems, for an
assertion; a site's mints a code for that site, which its
`/_portal/oidc/complete` alone redeems, for a cookie. Either carried to the
other is refused, and burnt (`wrong-audience`). The binding, the transaction
cookie, a code living a minute and burnt at the first attempt, one code per
flow: everything above holds for the dashboard's too.

**The assertion** (src/assertion.ts) is a compact JWT signed with Ed25519: the
verified email and name, `auth_time`, when the person last signed in at the
provider, `aud` the dashboard, five minutes of life, a nonce. The dashboard
hands it to the steward, which checks it with a public key it keeps itself
and opens the person's session, reading their roles in its registry; the
portal judges the allowed domains once more before it signs.

**The key** is the steward's: it draws the pair as root, keeps the public
half, and lays the private half in `/etc/sitesolide-portal/assertion.key`,
`root:site-portal 0640`, which this service reads at every redemption: a key
laid or replaced needs no restart. Not in `portal.env`, which the dashboard's
Secrets section reads after an unlock: a compromised dashboard would read the
key there and forge assertions. Missing, a redemption answers `no-key` and
nobody signs in to the dashboard; the sites are untouched.

**A forced sign-in, for a person's unlock.** Someone signed in to the
dashboard reads or writes their projects' secrets, makes a site public,
restores its data, gives someone a role above Can open, or gives password
access only unlocked, and they unlock by signing in again
([dashboard/README.md](../dashboard/README.md#a-persons-unlock)). The
dashboard then asks for a flow with `reauth`: the portal's session spares
nothing, the provider is asked for `max_age=0`, and for `prompt=login` unless
it is Google, which documents no such prompt. By the OpenID Connect
specification a provider asked for `max_age` says in the ID token's
`auth_time` when the person signed in; the callback reads it, and mints a
code only when that time falls within the flow and five minutes
(`freshReauth` in src/oidc.ts). An older sign-in coming back, a provider that
ignored the request, or no `auth_time` at all, refuses it, recorded as
`stale-authentication`. The assertion then says `reauth`, which the steward
demands before it unlocks; a sign-in's never does.

**The dashboard's address follows from this one's.** The manifest names the
portal `https://{slug}.{zone}`; the dashboard is `https://dashboard.{zone}`.
A portal whose address does not start with `portal.` offers no dashboard
sign-in, and says so at startup. `DASHBOARD_URL` names it otherwise; it is not
one of the names the steward accepts in `portal.env`, so a dashboard cannot
send codes elsewhere by setting it. At startup the portal prints `dashboard
sign-in offered, back to https://dashboard.<zone>`.

## Who may open a site

The steward decides, the portal reads. A restricted site opens to:

| Who | Signs in with | The role the site learns |
|---|---|---|
| the owner | the owner's password | `admin` |
| an admin email, `OIDC_ADMIN_EMAILS` | their company account | `admin`, on every site |
| a person among the site's people with access | their company account | their entry's role: `visitor` (Can open), `viewer`, `developer` or `admin` |
| everyone at a domain among them, `@acme.com` | their company account at that domain, subdomains not included | `visitor`, or their own entry's role when it is higher |
| a person with password access | the password drawn for them | `visitor` |

**Every role opens the site.** Viewer, Developer and Admin are the project's
roles in the dashboard, each including the ones below it, and Can open is
the lowest rung: someone given Developer on a project opens its restricted site
as someone given Can open does. [docs/access.md](../docs/access.md#people-with-access-beside-tokens)
says what each role does in the dashboard. The portal only asks "may this
person open the site", and passes the role on.

**Public is not a role, nor an entry.** It is the portal turned off, general
access *Public*, from the site's *Access* section through the steward and the
gatekeeper, see above.

**Who may change it.** Every way ends at the steward, which judges each change
by one set of rules (`dashboard/src/access/rules.ts`), writes it, and records
it in its journal, `access.add`, `access.change` or `access.remove`:

| Who | How | What they may do |
|---|---|---|
| the owner | the dashboard's *Access* section; `sitesolide share` in the project's folder, over SSH, root asking the steward's owner socket | anything; recorded as `owner` |
| an Admin of the project | its *Access* section, through their session | their project only, a role at most their own; a domain only among `OIDC_ALLOWED_DOMAINS`; recorded under their email |
| a token | `sitesolide share` with a token, or `/api/v1/projects/<slug>/access` | Can open alone, on the projects it reaches, and for a person's own token only where that person is Admin now; people who sign in with a company account, a domain only among `OIDC_ALLOWED_DOMAINS`, none when that list is empty; never password access; removes Can open entries alone; recorded as `token:<id>` |

A domain is Can open only, and only once a provider is configured. A person
outside the company's domains is Can open only, with password access. Giving
someone a role above Can open, or password access, asks for the unlock of
whoever gives it in the dashboard; Can open for a company account or a
domain, removing someone, lowering them and restricting a site never wait.
[docs/access.md](../docs/access.md#giving-access-to-what-you-deployed) has the
holder's side.

**The projection.** After every change the steward writes
`/etc/sitesolide-portal/access.json`, `root:site-portal 0640`, beside the
assertion key and for the same reason: root writes it, the portal's account
reads it, the dashboard's cannot. Per host, `<slug>.<zone>`: its people and
their roles, its domains, and its password access, each an identifier, who it
was given to, a SHA-256 and an expiry, never a password. The steward writes it
before its own registry, so that a change the portal cannot be told of is no
change, and writes it again from the registry at every start.

**Read again when it changes.** The portal keeps no list of its own. Before
every decision it looks at the file's inode, size and modification time, one
`stat` and nothing more when it has not moved; a file that moved is read whole
and judged (`readProjection`, in `src/access.ts`). Someone removed is refused,
and someone lowered seen in their new role, at their next request, cookie in
hand. Caddy is never touched, and nothing restarts.

**A projection that does not read opens nothing from it**: one that is not
JSON or not of the expected shape, a link, a folder, more than 8 MiB. The
owner's password and the admin emails, which need no list, still open every
site. The journal says so once (`journalctl -u portal`), and the file is read
again at its next change.

**Before the steward writes it.** A portal that finds no projection, and has
never read one, decides from its own tables as it did before the registry,
`sharing` and `invites` in `data/portal.db`, which it no longer writes: so the
order of an upgrade opens and closes nothing. Someone those tables let in
opens as `visitor`, an admin email as `admin`. The first time the portal reads
a projection it leaves a mark, `data/access-from-steward`: from then on a
missing projection opens nothing either, and the old tables are never read
again. `GET /admin/access` says which it reads, and the steward asks it
through its relay, so that `sitesolide share` warns while the portal still
decides from its own tables.

The rules of an email and a domain live in `src/sharing.ts`, pure, which the
dashboard and the steward borrow, the page included: the page refuses an
address with the exact rule the portal applies. An address is compared
exactly, in lowercase, and narrower than the RFC allows: no quoted local part,
no space, no accent, every one of them a way to make two strings look like the
same person. The ladder of roles and the projection's format live in
`src/access.ts`, borrowed the same way, so that the steward writes exactly
what the portal reads.

## Who came in: the identity headers

On a `200`, the portal tells Caddy who the visitor is, and the site's block
copies it onto the request the site receives:

| Header | Value |
|---|---|
| `X-Sitesolide-User` | the verified email, lowercase. Absent for the owner's password and for password access |
| `X-Sitesolide-User-Name` | the display name the provider gave, **percent-encoded UTF-8**: `decodeURIComponent` it. Absent when unknown |
| `X-Sitesolide-Role` | `admin` for the owner's password and an admin email; for a company account, the role of their entry, the higher of their own and their domain's: `visitor` (Can open), `viewer`, `developer` or `admin`; `visitor` for password access |

**It changed with the access registry.** Before it, the role read `member` for
anyone the site's list let in and `guest` for someone with a password. An app
that compared it with either must be updated: `guest` is now `visitor` with no
`X-Sitesolide-User`, and `member` is now the person's own role. Password access
carries no `X-Sitesolide-User` because its email was typed by whoever gave the
access, never verified by a provider.

**The visitor cannot forge them.** The block takes every `X-Sitesolide-*` header
the visitor sent off every request, the service's paths, the files and the
exempted paths alike, before the portal is asked, then copies the portal's on.
Caddy sorts `request_header` after `forward_auth` on its own, which would take
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
Public, or never restricted, and every customer domain. Its block carries the
same two `request_header` lines, at the block's level, where they need no
`route` since nothing in the block copies anything on. Its app is told nobody,
and never a stranger's `X-Sitesolide-Role: admin`.

**Trust them only once the site's block carries them.** A block deployed before
this release, protected or not, takes nothing off, and its app receives
whatever the visitor sends. A protected one keeps working with this portal: the
dashboard says so for that site. The next `sitesolide deploy` of the site, or
its general access switched from the dashboard, upgrades the block. An
exempted path never carries them: it does not go through the portal.

Reading them in a Bun service:

```ts
Bun.serve({
  port: Number(process.env.PORT),
  hostname: "127.0.0.1",
  fetch(req) {
    const email = req.headers.get("x-sitesolide-user"); // verified, lowercase, or null
    const encoded = req.headers.get("x-sitesolide-user-name");
    const name = encoded === null ? null : decodeURIComponent(encoded);
    const role = req.headers.get("x-sitesolide-role"); // "admin", "developer", "viewer" or "visitor"
    if (role === "visitor" && email === null) return new Response("Read only with password access", { status: 403 });
    return new Response(`Hello ${name ?? email ?? "owner"}`);
  },
});
```

## The admin API

On the portal's port, called by the dashboard, and by root through the
steward's relay:

| Route | What it does |
|---|---|
| `GET /admin/access` | what the portal decides who may open a site from: `{ "reading", "writtenAt" }`, `reading` being `steward` (the projection), `portal` (its own tables, no projection read yet) or `unreadable` (a projection that does not read, or none since the mark), and `writtenAt` the projection's date when it reads one, null otherwise. The steward asks it through its relay, and says it in every access answer |
| `GET /admin/sharing` | how people sign in: configured or not, the provider's name, the portal's address, the admin emails and allowed domains, never the client secret nor its identifier; and `sites: []`, kept empty for a dashboard from before the registry |
| `PUT /admin/sharing/:host`, `GET` and `POST /admin/guests`, `DELETE /admin/invites/:id` | `410 moved`: who may open a site is the steward's now. The actor rule below still comes first |
| `GET /admin/audit?limit=&before=` | the audit, most recent first, by pages |
| `POST /admin/dashboard/flow` | `{ binding, returnTo, chooseAccount, reauth }`: a flow sealed for the dashboard's host, a forced sign-in with `reauth`, and the address to send the browser to; `not-offered` without a provider |
| `POST /admin/dashboard/redeem` | `{ code, binding }`: the code burnt, and, minted for the dashboard on this binding, an assertion signed for it, the path to come back to, and `reauth` |

They have no secret, and that is deliberate: the only accounts that can reach
that port are root, Caddy and `site-dashboard`, through the exception
`bin/cli/loopback.ts` adds to the loopback rule, and a shared secret would
protect nothing more. The steward, which keeps no network, comes as root
through `sitesolide-portal-relay`, a socket only root opens, behind which
systemd's proxy forwards to this port and nowhere else; it asks
`GET /admin/access` alone now. None of these routes changes who may open a
site: the steward writes that, in the projection, and nothing here can.

**The routes that moved answer to anyone.** `PUT /admin/sharing/:host`,
`GET` and `POST /admin/guests` and `DELETE /admin/invites/:id` change nothing
any more: they answer `410 moved` whatever the body names and whoever asks,
so there is no actor to believe or refuse.

Caddy never relays them: a protected site forwards to the portal only
`/_portal/*` and the `forward_auth` call to `/verifier`, and the portal's own
host only `/sante`, `/oidc/start`, `/oidc/callback` and `/oidc/signout`.
`bin/tests/cli-portal.test.ts` checks that no fragment aims at anything else.
The portal's own block refuses an ambiguous path with 400, as a protected
block does: Caddy compared `/admin/sharing/..%2f..%2fsante` cleaned, as
`/sante`, and relayed it raw, which Bun routed to the admin API. As one more
net, any request carrying `X-Forwarded-For`, which Caddy puts on what it
relays, is refused.

To read them by hand on the machine:
`sudo curl http://127.0.0.1:3026/admin/access`.

## The audit

The portal records in its own database, table `audit`, the shape every component
of the repository shares (`id`, `at` in ISO 8601 UTC, `actor`, `action`,
`target`, `detail` as JSON):

| Action | Actor | Detail |
|---|---|---|
| `portal.signin` | `owner`, the email, or for password access the email it was given to, `password:<id>` for a name carried over from before the registry | `method`: `password`, `password-access` or `oidc`, and the `role` for an identity; `name` for a password access given under a name; `count` when repeated |
| `portal.signin_failed` | `anonymous`, or the email when the provider named one | `method`, and for a provider the `reason`: `bad-signature`, `wrong-audience`, `expired`, `wrong-nonce`, `unverified-email`, `unusable-email`, `domain-not-allowed`, `unmanaged-account`, `not-shared`, `wrong-browser`, `expired-session`...; a dashboard's sign-in refused here names the dashboard's host, and a code carried to the wrong side reads `wrong-audience` too |
| `portal.signout` | who the cookie names, as for a sign-in | none, or `count` when repeated |
| `sharing.update`, `guest.create`, `guest.revoke` | in rows written before the registry alone, as they were written | who could open a site changed, a password access given or removed; the portal writes none any more |

Rows from before the registry also name a password access's sign-in
`guest:<access>`, its `method` `guest`, and read as they were written. A change of who may open
a site is the steward's to record now, in its journal, under the owner, an
Admin's email or `token:<id>`: `access.add`, `access.change`, `access.remove`,
and `access.migrate` once, actor `system`, when the registry was made. The
dashboard's *Activity* reads both.

Never a password, a code or a token. What a stranger can cause is bounded where
it happens: failed password attempts by the rate limiting, a row per attempt
allowed; failed sign-ins with the provider, thirty per site and per minute, the
rest of that minute unrecorded; a code that was never minted, and a sign-out by
someone who was not in, never. What a holder of a cookie or a password access
can repeat as fast as the network allows, a sign-in or a sign-out, makes one
row per actor, site and minute: the row keeps the time of the first, and
`detail.count` says how many came in that minute. Beyond 180 days, or beyond
100,000 rows, the oldest events are forgotten, except that the row cap never
takes a row of the last 30 days: a loop of sign-ins cannot push the last
month out of the audit, and the file may then grow past the cap, by at most a row a
minute per actor, site and action. The dashboard reads them through
`GET /api/portal/audit`.

## The page

**Sign-in and the preview lock's page are one template**, `src/page.ts`: same
card, same mark, two forms. The lock's page, served by Caddy and not by this
service, is generated by `bin/lock.sh` just before it is deployed:

```bash
bun run lock-page ./somewhere.html
```

It is not committed, because its footer carries the address to ask for a code,
which belongs to each installation.

Its CSS is hand-written and inline, and that is the repository's one Tailwind
exception: the lock's page is served for every URL of the locked host, and its
own resources would serve themselves in a loop.

With a provider configured, the sign-in page offers *Sign in with ...* above the
password: a link, not a form, since the flow leaves for the portal's own host
and the CSP's `form-action 'self'` would refuse a form's redirect there. To
someone signed in who has no access to the site, it says so, with *Use another
account*, which asks the provider to choose.

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
  where Caddy does not set it, only `/sante` and the provider's two steps reach
  the service, which never read it: that is the manifest's `routes` allow list.
- **A protected site trusts Caddy**, and that trust only holds because of the
  loopback rule, `bin/deploy-loopback.sh`: without it, any service on the machine
  could reach the site's port without going through Caddy, identity headers
  included.
- **The portal goes in front before the files.** `deploy` reverses its order
  for a protected site: otherwise its files would be served in the clear by the
  wildcard block until the fragment arrives. And it refuses to send anything
  while the portal does not answer with a hash in place.
- **An exempted path is public.** It does not go through the portal, and the
  site answers for it alone, a signed webhook, typically. It carries no identity.
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

- The password is typed on every site: an XSS flaw in one of them could capture
  it. Acceptable as long as those sites share one author. Signing in with the
  provider types nothing on the site.
- A compromised portal opens every restricted site; that is the price of one
  shared sign-in. It gives neither their data, each service staying confined to
  its own directory, nor the customer sites, nor the certificates. Since the
  provider, the portal can also reach the network. Since people sign in to the
  dashboard through it, it can also sign an assertion for anyone, and act in
  the dashboard as anyone who signs in there, within their roles. It cannot
  change the registry, which is root's, nor the projection, which root writes
  and it only reads; and it records no change of access any more, so it can
  write none under anyone's name.
- A compromised dashboard cannot give anyone a role above Can open, password
  access, nor the right to create projects, without the owner's live unlock or
  a person's forced sign-in, which it does not hold. It can give Can open to
  people who sign in with a company account and to the company's domains,
  under the owner's name or that of a person whose session passes through it,
  as it could open a site to them before the registry: only through the
  steward, which judges the change by its rules and records it. It can take
  off anyone the owner, or that person, may take off, and restrict their
  sites, since closing never waits. It never sees a password hash nor an access's
  identifier, the steward handing it views alone; a password it gives, it sees
  once, as the person at the page would. During an unlock it can also make a site Public, retyping the slug
  only guarding against a misclick; and it can rewrite the provider's settings
  in `portal.env`, pointing the portal at a provider it controls and naming
  itself admin, which opens every restricted site at the next restart.
  Changing the owner's password also requires the dashboard's own, which the
  steward checks, but which compromised code would capture as it is typed. It
  never touches Caddy itself: the gatekeeper refuses everything its rules
  refuse, and restores.
- A stolen token can give Can open on the projects it reaches, and for a
  person's own token only where that person is Admin, to people who sign in
  with a company account and to the company's domains, never password access
  to an outsider, never a role above Can open, never Public; and it can remove
  Can open entries. Every change is in the steward's journal under
  `token:<id>`; revoking the token on the *Tokens* page stops it, and the owner
  or an Admin removes what it gave, from the dashboard or with `sitesolide
  share --remove`.
- An account closed at the provider keeps its site cookies until they lapse, 24
  hours at most after it last signed in at the provider: a site's cookie never
  outlives the portal session it came from. Removing the person from a site's
  people with access, or from the admin emails, closes it at once.
- Signing out of one site does not sign out of the others: each keeps its own
  cookie until it lapses. It ends the portal's session, so no new site opens
  without the provider, which then asks which account.
- A site's own JavaScript reads none of the cookies, all `HttpOnly`, but its
  server receives them on every request, like any cookie of its host: a
  compromised site can replay its own visitors' cookies on itself, nowhere else.
- Rate limiting is per site and in memory: a stranger can block new password
  sign-ins to one site for an hour, cookies already held keep working, and other
  sites are untouched. Filling the handoff codes in flight, ten thousand, takes a
  thousand accounts the provider accepts, ten codes each, every code a minute's
  worth: new sign-ins wait that minute, nothing opens. With
  `OIDC_ALLOWED_DOMAINS` empty and a provider open to anyone, those accounts
  are anyone's.

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
hash and the provider's settings, and the steward refuses any other variable in
it. Changing the password signs everyone out, password access and company
accounts included.

Locally, the hash goes on the command line rather than through `bun --env-file`,
which expands the `$` of an argon2id hash:

```bash
PASSWORD_HASH="$(bun -e 'console.log(await Bun.password.hash("test"))')" bun run dev
```

## Upgrading

What runs on the machine keeps working at every step below, and each step can
wait for the next. Every command is run by the author, from the workstation.

1. **The portal.** `cd portal && sitesolide deploy`, then the same with
   `--force`. Without it, deploy stops before pushing anything and prints the
   divergence, cut short after five lines; `--force` is needed because the
   unit gains `PUBLIC_URL` and loses its loopback-only confinement
   (`"network": "outbound"`: its `IPAddressDeny` and `IPAddressAllow` lines go),
   and the portal's own block gains `/oidc/start /oidc/callback /oidc/signout`
   in its `@dynamic` matcher, the two `@portal_ambiguous` lines, the two
   `request_header -X-Sitesolide*`, `-X_sitesolide*` lines, and a
   `file_server { hide .git .env* }` in place of the bare `file_server`. Nothing
   else may differ. Check:
   `curl -s https://portal.<zone>/sante` answers `{"ok":true,"configure":true}`;
   `curl -s -o /dev/null -w '%{http_code}\n' 'https://portal.<zone>/admin/sharing/..%2f..%2fsante'`
   answers `400`; a protected site still opens with the cookie you already had,
   no sign-in asked; a password access still opens its site. The blocks of the other sites are
   untouched: they keep working, and pass no identity yet.
2. **The dashboard.** `cd dashboard && sitesolide deploy`. It starts saying, for
   a restricted site, that signing in with a company account is not set up,
   and its snapshot which blocks pass the identity headers.
3. **The steward**, `bin/deploy-steward.sh`, before setting any `OIDC_*`
   variable: an older steward refuses them in `portal.env`, and declares a
   `portal.env` that carries one out of management, *Change password*
   included. Check: the `portal` site's *Secrets* still shows `portal.env`
   managed.
4. **The gatekeeper**, `bin/deploy-gatekeeper.sh`, right after the dashboard: it
   embeds the block generator. An older one refuses to turn the portal on or off
   a site whose block was upgraded ("differs from what sitesolide.json
   generates"), and making a site Public writes a block that takes nothing
   off, where the dashboard now says the app is told nobody. This one
   accepts both generations, protected or open, and writes the current one.
5. **The provider**, when you want it: register the portal as above, set the
   `OIDC_*` variables in `portal.env`, *Restart service*. Check:
   `journalctl -u portal` says `sign-in with ... offered, callback
   https://portal.<zone>/oidc/callback`; a protected site's sign-in page shows
   the button; your admin email gets in.
6. **Each app site, protected or not**, starting with any whose app reads the
   `X-Sitesolide-*` headers: `sitesolide deploy` in its folder. It says the block
   "was written by an earlier release, the current one replaces it", without
   `--force`: a protected block gains the identity stanza, an open block and a
   customer domain gain the two `request_header` lines. Check:
   `sudo grep -c 'request_header -X' /etc/caddy/sites/<slug>.caddy` counts 2,
   or 4 with a customer domain; for a protected site, the dashboard no longer
   says its app is not told who signed in. Until then, an open site's
   app receives whatever `X-Sitesolide-*` a visitor sends, as it always has.
7. **The Caddyfile**, whenever: `bin/deploy-caddy.sh`. The landing's block gains
   the same two lines, in front of its `/api/*` service; the wildcard and
   on-demand blocks only serve files, and are unchanged. The script validates,
   reloads, checks every site and restores at the first error.

Signing out, once the portal and a protected site's block are both current:
a `POST` to a protected site's `/_portal/deconnexion` from its own pages shows
*Signed out.*, passes through `portal.<zone>/oidc/signout`, and comes back to
the site's sign-in page; the next *Sign in with ...* goes to the provider and
asks which account.

**Signing in to the dashboard** needs this portal, the steward that lays its
key, and the dashboard that asks: see [dashboard/README.md](../dashboard/README.md#upgrading-access).
`sitesolide upgrade` runs all three. Check: `journalctl -u portal` says
`dashboard sign-in offered`, and someone with a role signs in.

**Who may open a site, from the steward.** The release of the access registry
deploys the steward first: at its first start it makes the registry from the
old stores and writes the projection, while this portal, the previous one,
keeps deciding from its own tables, which still say the same. Then the
dashboard and the installer, and this portal last, which `sitesolide upgrade`
does in that order ([docs/upgrading.md](../docs/upgrading.md#access-one-registry)).
From its first request the new portal reads the projection, and leaves the
mark that keeps it from its old tables for good. Before it is deployed, update
and deploy every app that reads `X-Sitesolide-Role`: `member` and `guest` are
gone, see [Who came in](#who-came-in-the-identity-headers). Check, on the
machine: `sudo curl -s http://127.0.0.1:3026/admin/access` answers
`"reading":"steward"` and the projection's `writtenAt`; `journalctl -u portal`
says `access: projection of ... read`; `sitesolide share` in a restricted
site's folder lists its people with access and no warning about the portal; a
password access given before the upgrade still opens its site, and a cookie
set before it is still valid. Roll back: redeploy the previous commit of
`portal/` with `--force`, with the steward and the dashboard of that commit
([docs/migration.md](../docs/migration.md#going-back)). It reads its own
tables again, as they stood when the registry was made, and leaves the
projection unread: a change of access made since, and password access given
since, do not exist for it, and `X-Sitesolide-Role` says `member` and `guest`
again.

**Rolling back identities.** The portal from before them reads the owner's and
the password access's cookies as always and refuses the identity cookies, four
pieces where it expects two or three: people signed in with the provider see the sign-in page
again. The `sharing` and `audit` tables stay in `portal.db`, unread. Blocks
already upgraded keep working with it: they take the visitor's headers off, and
copy nothing; a site's sign-out goes back to the 303 home it was. Redeploy the
previous commit of `portal/` with `--force`. An older
steward will then find `OIDC_*` variables in `portal.env` and leave it
unmanaged: remove them by hand from `/etc/sitesolide/portal.env`, or keep the
current steward.

## Tests

```bash
bun run check                                            # decisions, routes, database, page, the whole sign-in flow, typing
bun test ../bin/tests/cli-portal-caddy.test.ts           # the generated fragment, in a real Caddy
bun test ../bin/tests/cli-portal-identity-caddy.test.ts  # the identity headers, in a real Caddy
```

`tests/sso.test.ts` runs this server and an identity provider of the tests'
making, `tests/provider.ts`, through real HTTP: the whole flow, the second site
that skips the provider, a dashboard's sign-in redeemed for an assertion the
steward's key verifies, a dashboard's code refused on a site, a forced sign-in
that skips the portal's session, asks the provider for `prompt=login` and
`max_age=0` and signs an assertion saying `reauth`, one refused when the
provider answers with an older `auth_time` or none, and every refusal, a token signed by another key, for
another client, expired, with another nonce, an unverified email, a disallowed
domain, a callback or a code opened in another browser, a code replayed or
carried to another host, a flow altered on the way or replayed for a second
code, more codes in flight than one email may hold; then a site cookie capped by
a session about to expire, and a sign-out that ends the portal's session and
makes the next sign-in ask which account.

`tests/admin.test.ts` has every moved route answer `410` whatever its body
names, and reads what `GET /admin/access` says.

`tests/projection.test.ts` reads the steward's projection from disk: a read
that failed on the way, too many open files or an I/O error, tried again a few
seconds later rather than at the next change; a rewrite
seen at the very next call, a file that has not moved never read again, a
malformed one, a link, a folder or a file beyond the bound opening nothing but
the admin emails, the old tables read before the first projection only, and
never again once the mark is left. `tests/access.test.ts` judges the
projection's format, the role an email holds, and a password access's expiry
and actor.

The two `bin/tests` files run Caddy on your workstation, `admin off` on a free
port, in front of this service and fake sites: what the portal promises hangs
entirely on the order in which Caddy sorts directives, and an order is
measured, not read. The first also checks that the admin API cannot be reached
through the site. The second sends forged identity headers to every kind of
path, the underscore spellings put on inside Caddy since they cannot
arrive, to a protected site, an open one and its customer domain; signs in and
out through the portal's own block with the provider; checks that this block
refuses an ambiguous path; and that a block from before identities still works
with this portal.
