# People and tokens

Each project has a general access, Public, Restricted or Anyone with the code,
and a list of people with access, each with a role: Can open, Viewer,
Developer or Admin. The owner can do everything; tokens let people and agents
deploy, never beyond their person's roles.

The owner of the machine deploys over SSH, as root. Nobody else needs that, and
nobody else should have it. Two things let others work on the machine, and
neither is root:

- **people with access**: someone, by their email, holds a role on a project,
  opens its site when it is restricted, and from Viewer up signs in to the
  dashboard with their company account;
- **tokens**: a key, personal and revocable, with which `sitesolide deploy`
  sends a project to the dashboard over HTTPS. The machine installs it the way
  it installs the owner's, and the holder never holds root. The same works for
  an agent in a sandbox with no SSH key: a token in its environment is all it
  needs.

In the dashboard, each of them has one place: a site's *Access* section for
who may open that site and who may do what on it, the *People* page for
everyone across projects, the owner's alone, and the *Tokens* page for the
tokens.

## People with access, beside tokens

| | A person with access | A token |
|---|---|---|
| Is | someone, by email, with a role on each of their projects | a key, `sst_...`, held by a person or an agent |
| Signs in | to a restricted site, with their company account or their password access; to the dashboard, with their company account, from Viewer up or with the right to create projects | nowhere: the CLI and the control API present it |
| Sees | in the dashboard, the projects they are Viewer, Developer or Admin of | the projects it may deploy, through `sitesolide status` |
| Does | by role, see below: from opening a site to looking after all of the project | deploys, reads logs, gives Can open on what it deploys |
| Lasts | until they are removed; half a day per sign-in to the dashboard, an unlock ten minutes; password access until its expiry | until it expires or is revoked; a person's own, also until that person no longer signs in to the dashboard |
| In the audit | their email | `token:<id>`, and the person's email for their own |

The two meet in one place: **a person mints tokens of their own**, from the
*Tokens* page, never stronger than their roles. See [Your own
tokens](#your-own-tokens).

A person holds one role on each of their projects. Can open is the lowest,
Admin the highest, and each role includes the ones below it:

| Role | On that project |
|---|---|
| Can open (`can-open` in the CLI, `visitor` in the API) | opens its site when its general access is Restricted, and nothing in the dashboard |
| Viewer | also sees the project in the dashboard: its state, audience and activity |
| Developer | also deploys it with a token of their own, restarts its service, and sets, replaces and removes its secrets without ever reading one back: the dashboard shows them names, the server never hands them a value |
| Admin | everything of the project: reads its secrets, switches its general access between Public and Restricted, gives people access to it, a role at most their own, and restores its backups |

**Every role opens the site** when its general access is Restricted: a
Developer needs no Can open besides. A whole domain, written `@acme.com`, is
Can open only. A person outside the company's domains, `OIDC_ALLOWED_DOMAINS`
in the portal's settings, or anyone when signing in with a company account is
not set up, is Can open only, with **password access**: a password the machine
draws for them, for that one site, shown once to whoever gives it, until an
expiry chosen then, 24 hours, 7 days (the default), 30 days or none
([portal/README.md](../portal/README.md#password-access)).

**Who signs in to the dashboard**: someone with a role above Can open on at
least one project, or the right to create projects, with their company
account. Someone with Can open alone, by name or through a domain, opens sites
and nothing more: their sign-in is refused with `can-open-only`, "This account
can open some sites, but the dashboard starts at Viewer. Ask an Admin of the
project if you need more." Someone on no list is refused with
`no-role`, "This account has no access to any project here. Ask the owner, or
an Admin of the project, to add you."
When their last role above Can open goes, removed or lowered, and they do not
hold the right to create projects, their dashboard sessions close and their
tokens are revoked at once.

The machine itself stays the owner's: the platform's own projects, the
dashboard and the portal among them, their settings, the preview codes, the
tokens of others, the connectors, and the roles people hold on projects they
are not Admin of.

**The owner** is whoever holds the dashboard's password, the first account,
made by `setup`, and may do everything, on every project and on the machine.
Their *People* page lists everyone across projects, their roles, their
password access, who may create projects, the domains, and the admin emails,
"Every site, as admin: set on the server in OIDC_ADMIN_EMAILS";
`sitesolide people` prints the same from any folder
([commands.md](commands.md#people)). Taking someone off there takes them off
every project and revokes their tokens, which the confirmation lists;
*Remove expired* clears every password access that has ended.

**Creating projects is a right the owner grants per person**, beside their
roles: from *People*, or `sitesolide people <email> --may-create`, taken back
with `--no-create`. It may be all they hold, someone asked to create their own
projects, none yet; it takes an address that signs in with a company account.
Whoever holds it mints a token that may create, and becomes Admin of each
project that token creates.

**Giving someone access** is the project's Admin's, or the owner's: from the
site's *Access* section, or `sitesolide share <email> --role <role>` in the
project's folder ([commands.md](commands.md#access-to-a-project)). An Admin
gives at most their own role, on their project alone; a domain only among the
company's. No email is sent: the command prints the line to send, and a
password once for password access. Removing someone, or lowering them, holds
from their next request.

Signing in to the dashboard goes through the portal: the dashboard sends the
browser there, the portal runs its usual sign-in with the provider, and hands
the dashboard a short assertion it signed, which the server checks before
it opens the session ([dashboard/README.md](../dashboard/README.md#access)).
A person sees Sites and Activity, each reduced to their projects, *Tokens*
for their own tokens when a role or the create right lets them mint one, and
in a project the sections their role opens:

| Role | A project's sections |
|---|---|
| Viewer | Overview, Audience, and Access read only: its general access, its people with access, and whom to ask to add someone |
| Developer | the same, and Secrets, whose values they write and never read back |
| Admin | everything: Overview, Audience, Secrets, Access, where they give people access, and Backups |

The rest of the dashboard is the owner's, hidden and refused: People,
Connectors, and every project they hold no role on.

**A site's Access section** reads like a "Share" dialog, in one column, with
a link to its changes in Activity. First its general access, the three ways
it may open, Public, Restricted or Anyone with the code, the current one
marked; the owner and its Admins switch between Public and Restricted there,
while a preview code stays `sitesolide lock`'s, from the project's folder.
Then its people with access: an *Add people* field taking an email or a
`@domain` and a role, which says before anything is sent whether the person
signs in with their company account or gets password access, and every entry
with its role, password access with its expiry. One line under the list names
who also opens the site without being on it: the owner, and the admin emails
set on the server. *What each role can do* opens under the field, the
reader's own marked. A Viewer or a Developer reads all of it without a
control, and whom to ask to add someone.

**Unlocking, for a person, is signing in again.** Whatever reads or writes a
secret, makes a site public, restores data, mints a token, gives someone a
role above Can open, or gives password access asks for the person's own
unlock: *Unlock changes* sends them to the identity provider, which asks them
to prove themselves once more even if they are signed in there, and brings
them back unlocked for ten minutes, for their session alone. The owner
unlocks with the dashboard's password; neither unlock replaces the other, nor
another person's. Restricting a site, giving Can open to a company account or
to one of the company's listed domains, removing someone, lowering them and
restarting a service never wait for an unlock. A whole domain does while the
company's domains are not listed on the server, `OIDC_ALLOWED_DOMAINS` empty:
anyone the provider vouches for would then come in.

## Your own tokens

Someone who signs in to the dashboard deploys with a token they mint
themselves on its *Tokens* page: for their workstation's CLI, for an agent.
The server judges it, never the dashboard, and **a person's token is never
stronger than its person**:

| A token of theirs | Takes |
|---|---|
| a project to deploy | Developer or Admin there |
| creating projects | the create right the owner granted them; each project it creates makes them its Admin |
| deploying public sites, declaring a domain, outbound network | Admin of every project the token reaches; with creating alone, what it creates is theirs to administer |
| giving Can open, `sitesolide share` | Admin of that project |

A Viewer everywhere, without the create right, mints nothing, and sees no
*Tokens* page.

- **Minted under their own unlock**, the forced sign-in at the provider that
  every secret write asks for: *Unlock to create*, then *New token*. The
  dialog offers the projects where they are Developer or Admin, creating
  projects only with the right, and the options only for projects they
  administer. The token carries their email, whatever is sent, and is shown
  once, as the owner's are. Its row on *Tokens* names each project with
  their role there today, "calendar (Admin)", or "cms (paused: Viewer now)"
  where it no longer deploys.
- **Narrowed live.** The server reads the access registry at every use of the
  token, not only when it was minted: a role lowered to Viewer or Can open
  stops that project's deployments at the next request, the create right taken
  back stops new projects, and the options hold only while the person is Admin
  of every project the token reaches; one lowered turns them off for the whole
  token, and the person mints another for what they still administer. The
  installer reads the registry once more when it starts.
- **An existing project keeps its general access.** A deployed site is switched
  between Public and Restricted by its Admin or the owner, never by a
  deployment: a Developer's token deploys a public project as it stands, and
  opens nothing. A new project is restricted unless the token may deploy
  public sites; leaving paths open to anyone (`portalExempt`) takes that
  option too.
- **Giving access**, `sitesolide share`, takes the person's own power: Can open
  alone, on a project where they are Admin now.
- **When they no longer sign in to the dashboard, their tokens go with them**:
  revoked by the server at once, under whoever removed or lowered them, and
  refused anyway, since the registry no longer gives them a role. Revoking one
  needs no unlock, from their *Tokens* page, or the owner's, which lists every
  token and who made it, "Made by alice@example.com" or "Made by you for
  alice@example.com".
- **Ten live tokens per person**, so that one person cannot fill the
  machine's registry.

Everything is audited under the person: the server journals `token.create`
and `token.revoke` under their email, and `project.create` for a project
their token created; the dashboard's deployments, under `token:<id>`, name the
person in their detail.

## What you get from the owner

- the dashboard's address, `https://dashboard.<zone>`;
- a token, `sst_...`, shown to the owner once when they created it on the
  dashboard's *Tokens* page. Keep it like a password: whoever holds it deploys
  what it allows. Someone who signs in to the dashboard mints their own
  instead, see [Your own tokens](#your-own-tokens).

A token the owner creates deploys only what they allowed when creating it: the
existing projects they granted, and, if they allowed it, new projects, which
are then yours. Everything is **private by default**: a project you create
is Restricted, unless your token may deploy public sites.

## Sign in

You need the CLI, one executable that needs neither Bun nor a clone:

```bash
curl -fsSL https://github.com/cthiriet/sitesolide/releases/latest/download/install.sh | sh
sitesolide login --url https://dashboard.<zone>
```

`login` asks for the token, checks it against the dashboard, and says who it
belongs to and what it may do. It keeps the token in
`~/.config/sitesolide/secrets/team-token` (0600), and the address in
`~/.config/sitesolide/config.json` under `api`. `--token-stdin` reads the token
from standard input instead of a prompt.

A workstation with no `server` in its configuration uses the dashboard for
`deploy`, `status`, `logs` and `share`. Every other command (`lock`, `domain`,
`remove`, `run`, `people`) needs the owner's SSH access and says so.

### In an agent's sandbox

No files to keep: set two variables, which win over the files.

```bash
export SITESOLIDE_API=https://dashboard.<zone>
export SITESOLIDE_TOKEN=sst_...
sitesolide deploy
```

## Deploy

From the project's folder, the one with its `sitesolide.json`:

```console
$ sitesolide deploy
-> project notes, through https://dashboard.example.com
   deployment 3f2a..., a new project
-> archive
   12 file(s), 48211 bytes, 9120 compressed
-> upload
-> manifest, validated on the machine
   port 3002 chosen for the service
   project notes, service, restricted
-> the machine
...
-> verify
   https://notes.example.com/ 401, restricted: visitors are asked to sign in
-> deployed: https://notes.example.com/
```

In order:

1. **The manifest goes first.** The dashboard judges it, with the same
   validation as the owner's CLI and your token's scope, before anything is
   built or sent. Every reason it refuses comes back at once.
2. **The build runs on your workstation**, as for the owner: the machine
   receives its result, not your toolchain.
3. **The archive** carries your code in `app/`, without what `exclude` lists
   and the manifest, and your `publicDir` in `public/`: exactly what the
   owner's rsync would send. Neither tree ever carries `.git` nor a `.env`, at
   any depth. Symbolic links are refused; replace them with the files they
   point to.
4. **The machine installs it**: it extracts the archive as the project's own
   account, runs your `install` there, then follows the same steps as the
   owner's deployment. You read its log as it goes, and the command exits
   non-zero if the deployment fails.

**The port is optional.** A manifest with a `start` and no `port` gets the
lowest free one, and keeps it on later deployments. The CLI prints it: write
it in `sitesolide.json` to make it explicit.

### What a token's project may not do

| In the manifest | Refused unless | Why |
|---|---|---|
| no `portal`, or `portalExempt` | the token may deploy public sites | private by default |
| a static site (no `start`) | the token may deploy public sites | a static site cannot be restricted yet |
| `"network": "outbound"` | the token may use outbound network | services reach only the loopback otherwise |
| `egress` | the token may use outbound network | the hosts it lists are reached through the egress proxy, a way out all the same |
| `domain` | the token may declare a domain | switching to it stays the owner's job |
| `secrets` other than `<slug>.env` | never | the unit hands the file to the service as root |
| `lock` | never | the preview code is the owner's (`sitesolide lock`) |
| `memory` above 1G, more than 6 services | never | one machine serves everyone |

A project that already exists keeps the general access the machine carries:
it is switched from the dashboard, never from a deployment. A token without
the public permission does not deploy an existing public site either, so that
a stolen one publishes nothing; a person's own token does, general access
being its Admin's choice, which the deployment leaves as it is.

`connectors` needs no permission of the token: a manifest only asks for one,
and nothing reaches it until the owner grants it to the project from the
dashboard.

Every string of the manifest that lands in the project's Caddy block or systemd
unit is judged for that, the same way for the owner and for a token: header
values without `"`, `\`, `{`, `}`, `$` or a backtick, routes that are plain
paths, a `start` that begins with the program itself, environment values with
no space or quote, secret names that are plain file names. See
[docs/manifest.md](manifest.md).

**Secrets** live on the machine and nowhere else. A project that declares
`<slug>.env` deploys only once the owner, or the project's Developer or Admin,
has created the file in the dashboard's *Secrets* section; the deployment says
so and stops before the restart.

**`install` runs on the machine** as the project's account, with the network
but not the loopback, a throwaway `HOME`, and fifteen minutes at most. The
tools it calls must be on the machine (`bun` is; ask the owner for others), and
a tool that installs an interpreter into `HOME` must use the machine's own
instead, since `HOME` is gone afterwards.

## Status and logs

```bash
sitesolide status          # the projects your token reaches, their service, and their general access
sitesolide logs            # the journal of this folder's project
sitesolide logs --follow
```

`--json` works here as over SSH (see [agents.md](agents.md)): one event per
line, and one final `result` or `error` carrying a `hint`. `deploy --dry-run`
is refused, and nothing is sent: a dry run reads the machine over the owner's
SSH access, which a token does not carry. Review `sitesolide.json` instead; the
machine judges it before anything is built or uploaded. Every other option a
command does not take with a token is refused the same way.

## Giving access to what you deployed

A project you deploy with a token is Restricted, and opens to its people with
access, the owner and the admin emails alone. Once the owner has set up
signing in with a company account
([portal/README.md](../portal/README.md#signing-in-with-a-company-account)),
you give people Can open from its folder:

```bash
sitesolide share                              # its general access and its people with access
sitesolide share alice@acme.com bob@acme.com  # Can open for them
sitesolide share @acme.com                    # everyone at acme.com, one of the company's domains
sitesolide share --remove bob@acme.com        # refused from their next request
```

```console
$ sitesolide share alice@acme.com
-> access to notes, https://notes.example.com/, through https://dashboard.example.com
-> alice@acme.com: Can open on notes
   general access: Restricted: visitors are asked to sign in.
   people with access:
     alice@acme.com  Can open
     @acme.com       Can open
   The owner also opens it.
   send: Open https://notes.example.com/ and sign in with your company account.
```

The `send:` line comes only after a change that gives someone access with an
account, never on a plain listing. A token never reads the admin emails, so
the line before it names the owner alone. The server judges each change by
the access rules, writes it, and records it under your token, `token:<id>`,
never as the owner; it holds from the next request.
What a token may do is narrower than what an Admin or the owner may:

| You may | You may not |
|---|---|
| give Can open on a project your token reaches, your own or one granted to it; with a person's own token, one where that person is Admin now | touch another token's project, which reads as unknown |
| give it to people who sign in with a company account, by their company email | give password access: someone outside the company's domains is refused, and an Admin or the owner gives it from the dashboard |
| give it to one of the company's domains, `OIDC_ALLOWED_DOMAINS` | give another domain, or any domain at all when that list is empty |
| take a Can open entry off | give, change or take off Viewer, Developer or Admin: those are given from the dashboard, or by the owner over SSH |
| | make a site Public: general access is the dashboard's, its Admin's or the owner's |

Giving access never touches Caddy, and a project not deployed yet is refused
with `not-found`. A project whose general access is Public keeps its list, and
Can open matters once it is Restricted: the command says so, "notes is public,
so anyone can open it. Viewer, Developer and Admin still apply; Can open
matters once you restrict it."

## The API, for an agent without the CLI

Everything the CLI does is plain HTTPS with `Authorization: Bearer <token>`.
Every refusal is `{ "error": "<code>", "message": "<what to do>" }`, with
`details` listing every reason for a refused manifest.

```bash
API=https://dashboard.<zone>
AUTH="Authorization: Bearer $SITESOLIDE_TOKEN"

curl -s -H "$AUTH" $API/api/v1/whoami

# 1. the manifest, judged before anything is sent
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"manifest\": $(cat sitesolide.json)}" $API/api/v1/deployments
# -> 201 { "deployment": { "id": "...", "state": "awaiting-bundle", ... } }

# 2. the archive: a gzip-compressed tar holding app/ and public/ only
tar --format=ustar -czf bundle.tar.gz app public
curl -s -H "$AUTH" -X PUT --data-binary @bundle.tar.gz \
  $API/api/v1/deployments/<id>/bundle

# 3. follow: `after` is the previous answer's `next`
curl -s -H "$AUTH" "$API/api/v1/deployments/<id>?after=0"

# 4. give Can open on it
curl -s -H "$AUTH" -X PUT -H 'Content-Type: application/json' \
  -d '{"who": "alice@acme.com"}' $API/api/v1/projects/<slug>/access
# -> 201 { "entry": { "who": "alice@acme.com", "kind": "person", "role": "visitor", ... }, "change": "add", "access": { ... } }
```

| Route | What it does |
|---|---|
| `GET /api/v1/whoami` | the token's holder, scope and projects |
| `POST /api/v1/deployments` `{ manifest }` | judges the manifest, opens a deployment for 15 minutes; a token holds three waiting for their archive, a fourth replaces the oldest |
| `PUT /api/v1/deployments/<id>/bundle` | the archive, 100 MiB compressed at most; starts the installer |
| `GET /api/v1/deployments/<id>?after=<n>` | state, log lines from `n`, `next`, `error`, `url` |
| `GET /api/v1/projects` | the projects the token reaches, with their status |
| `GET /api/v1/projects/<slug>` | one of them |
| `GET /api/v1/projects/<slug>/logs?lines=<n>&cursor=<c>` | the journal, and a cursor for the next call |
| `GET /api/v1/projects/<slug>/access` | `{ access }`: `slug`, `host`, `url`, `general` (`access`: `public`, `restricted` or `code`, `modifiable`, `reason`; null for a project not deployed), `entries` (each `who`, `kind`: `person`, `domain` or `password`, `role`, `by`, `createdAt`, `updatedAt`, and `password`, `{ expiresAt, expired }` for password access, null otherwise), and `signIn` (`configured`, and `allowedDomains`, the only domains your token may give) |
| `PUT /api/v1/projects/<slug>/access` `{ who, role }` | gives `who`, an email or a `@domain`, Can open: `role` is `visitor`, its default, and any other is refused; `{ entry, change, access }`, `change` being `add` (201) or `none` for someone who already had it |
| `DELETE /api/v1/projects/<slug>/access` `{ who }` | takes a Can open entry off; `{ entry, change: "remove", access }` |

| Code | Status | What to do |
|---|---|---|
| `unauthenticated` | 401 | the token is missing, unknown, expired or revoked, or its person no longer signs in to the dashboard: ask the owner, or mint another if it is your own |
| `too-many-attempts` | 429 | too many wrong tokens from your address: wait `wait` seconds; or, creating a project, your changes of access for this hour used up: try again later |
| `out-of-scope` | 403 | the token may not do this: outside its scope, its person's role no longer allows it, or, for access, a role above Can open, someone who would need password access, a domain outside the company's, an entry above Can open to take off; the message says whom to ask |
| `reserved` | 403 | the slug belongs to the platform: pick another |
| `invalid-manifest` | 422 | fix every point of `details` |
| `invalid` | 400 | the request itself is malformed: `who` neither an email nor a `@domain`, a domain given more than Can open, or a domain while signing in with a company account is not set up |
| `not-found` | 404 | no such deployment or project for this token, a project not deployed yet, or, taking someone off, someone with no access |
| `busy` | 409 | a deployment of this project is already running, or, when the archive arrives, three deployments already run on the machine: send it again in a minute, the deployment waits for it until its 15 minutes are up |
| `too-large` | 413 | exclude dependencies and caches |
| `expired` | 410 | the archive arrived after 15 minutes: start again |
| `not-available` | 503 | the machine does not carry the control API yet, or predates the access registry: tell the owner, who runs `sitesolide upgrade`; or, creating a project, the access log is full: ask the owner |
| `failure` | 500, 502 | something broke on the machine, an access registry that does not read among others: the message says where the owner should look |

`locked` never comes back from this API: it is the dashboard's answer to a
change that needs its unlock, a role above Can open or password access, which
a token never gives.

A failed deployment carries its own `error.code`, the step that stopped it:
`install-failed`, `secret-missing`, `edited-by-hand`, `system-unit`, `caddy-busy`,
`bundle-refused`, `service-failed`, `verify-failed` and a few more, each with a
message that says what to do.

## When it goes wrong

- **`not-available`**: the owner has not installed the control API on this
  machine yet, see [dashboard/README.md](../dashboard/README.md), "The control
  API"; or, for `share`, the machine predates the access registry, which
  `sitesolide upgrade` brings.
- **`out-of-scope` on `share`**: the message says which rule: a role above Can
  open, someone outside the company's domains, who needs password access, or
  a domain the company does not list. Ask an Admin of the project, or the
  owner, to give it from the dashboard; never try another token.
- **Too many changes, or the access log full**: the server keeps every change
  of access 180 days and never pushes one out early, and counts, per person
  or token and per hour, the changes that let more people in or more done:
  adding someone, raising a role, creating a project. Past 120 in the hour it
  refuses them: wait, then try again. Once the access log is full it refuses
  them until older changes age out, while removing and lowering someone still
  work: ask the owner, who still changes access from their workstation with
  `sitesolide share` and `sitesolide people`.
- **A warning that the portal still decides from its own tables**: the machine
  is halfway through an upgrade. What you give is kept, and opens the site
  once the owner has run `sitesolide upgrade`, which deploys the portal.
- **`edited-by-hand`**: a file of your project on the machine, its unit or its
  Caddy block, was changed by hand. The owner reads it and deploys once over SSH
  with `--force`; yours works again afterwards.
- **`caddy-busy`**: the owner or the dashboard is changing Caddy. Nothing served
  changed: deploy again in a moment.
- **A project you created and can no longer deploy**: your token was revoked.
  Your projects stay on the machine; the owner grants them to your new token.
  Once the owner removes one with `sitesolide remove`, its name is free
  again: any token that may create projects may create one of that name.
  A person's own token answers to their role instead: a project they created
  is theirs to deploy as long as they are its Developer or Admin, with any
  token of theirs that names it.
