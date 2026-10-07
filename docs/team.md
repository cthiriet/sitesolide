# Deploying as a team member

The owner of the machine deploys over SSH, as root. You do not need that, and
should not have it: the owner gives you a **token**, personal and revocable,
and `sitesolide deploy` sends your project to the dashboard over HTTPS. The
machine installs it the way it installs the owner's, and you never hold root.

The same works for an agent in a sandbox with no SSH key: a token in its
environment is all it needs.

## Members, beside tokens

Two ways for a colleague to work on the machine, which do not overlap:

| | A member | A token |
|---|---|---|
| Is | a person, by their work email | a key, `sst_...`, held by a person or an agent |
| Signs in | to the dashboard, with their work account, through the portal's identity provider | nowhere: the CLI and the control API present it |
| Sees | the projects the owner gave them a role on, in the dashboard | the projects it may deploy, through `sitesolide status` |
| Does | Viewer: the project's state, audience and activity; Developer and Project admin: also restart its service | deploys, reads logs, shares what it deploys |
| Lasts | half a day per sign-in, until the owner removes them | until it expires or the owner revokes it |
| In the audit | their email | `token:<id>` |

A member never holds a password, a token or root. The owner invites them from
the dashboard's *Members* page or with `sitesolide members add <email>
--project <slug> --role <viewer|developer|admin>` ([commands.md](commands.md#the-dashboards-members)),
then sends them the line it prints: the dashboard's address, and to sign in
with their work account. An address outside the portal's
`OIDC_ALLOWED_DOMAINS` is refused, as the portal would refuse it.

Signing in goes through the portal: the dashboard sends the browser there,
the portal runs its usual sign-in with the provider, and hands the dashboard a
short assertion it signed, which the steward checks as root before it opens
the session ([dashboard/README.md](../dashboard/README.md#members)). A member
sees Sites and Activity, each reduced to their projects, and in a project its
Overview and Audience; the rest of the dashboard is the owner's, hidden and
refused. Removed, a member is out at their next request.

What a member will gain later, setting a project's variables without reading
them, sharing it, restoring its data, and tokens of their own no stronger than
their roles, comes in later releases.

## What you get from the owner

- the dashboard's address, `https://dashboard.<zone>`;
- a token, `sst_...`, shown to the owner once when they created it on the
  dashboard's *Team* page. Keep it like a password: whoever holds it deploys
  what it allows.

A token deploys only what the owner allowed when creating it: the existing
projects they granted, and, if they allowed it, new projects, which are then
yours. Everything is **private by default**: a project you create sits behind
the portal, the shared sign-in, unless your token may deploy public sites.

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
`remove`, `run`) needs the owner's SSH access and says so.

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
   project notes, service, behind the portal
-> the machine
...
-> verify
   https://notes.example.com/ 401, behind the portal: unknown visitors get the sign-in page
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
| a static site (no `start`) | the token may deploy public sites | a static site cannot sit behind the portal yet |
| `"network": "outbound"` | the token may use outbound network | services reach only the loopback otherwise |
| `egress` | the token may use outbound network | the hosts it lists are reached through the egress proxy, a way out all the same |
| `domain` | the token may declare a domain | switching to it stays the owner's job |
| `secrets` other than `<slug>.env` | never | the unit hands the file to the service as root |
| `lock` | never | the preview lock is the owner's (`sitesolide lock`) |
| `memory` above 1G, more than 6 services | never | one machine serves everyone |

A project that already exists keeps the door the machine carries: the portal
of a deployed site changes from the dashboard, never from a deployment.

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
`<slug>.env` deploys only once the owner has created the file in the
dashboard's *Secrets* section; the deployment says so and stops before the
restart.

**`install` runs on the machine** as the project's account, with the network
but not the loopback, a throwaway `HOME`, and fifteen minutes at most. The
tools it calls must be on the machine (`bun` is; ask the owner for others), and
a tool that installs an interpreter into `HOME` must use the machine's own
instead, since `HOME` is gone afterwards.

## Status and logs

```bash
sitesolide status          # the projects your token reaches, their service and their door
sitesolide logs            # the journal of this folder's project
sitesolide logs --follow
```

`--json` works here as over SSH (see [agents.md](agents.md)): one event per
line, and one final `result` or `error` carrying a `hint`. `deploy --dry-run`
is refused, and nothing is sent: a dry run reads the machine over the owner's
SSH access, which a token does not carry. Review `sitesolide.json` instead; the
machine judges it before anything is built or uploaded. Every other option a
command does not take with a token is refused the same way.

## Sharing what you deployed

A project you deploy with a token sits behind the portal, and opens to the
admins alone: the owner's password, the admin emails, guests with a password.
Once the owner has set up signing in with a company account
([portal/README.md](../portal/README.md#signing-in-with-a-work-account)), you
share it the way a Google Doc is shared, from its folder:

```bash
sitesolide share                            # who gets in, and the line to send them
sitesolide share alice@acme.com bob@acme.com
sitesolide share --domain acme.com          # everyone at acme.com
sitesolide share --remove bob@acme.com
sitesolide share --only-admins              # closed again, the lists kept for later
```

The dashboard relays each change to the portal as its *Sharing* section does,
and the portal records it in its audit under your token, `token:<id>`, never
as the owner. It holds from the next request. What a token may share is
narrower than what the owner may:

| You may | You may not |
|---|---|
| share a project you may deploy, your own or one granted to you | share another token's project, which reads as unknown |
| add or remove anyone, by their work email | open a site to a domain the portal does not admit at sign-in (`OIDC_ALLOWED_DOMAINS`); with no such list, to any domain at all |
| open it to a domain the portal admits, close a domain, go back to the admins | make a site public: that is turning its portal off, the owner's, from *Access* |

A person you add still signs in with an account the portal admits: an address
outside its domains gets in only if it is an admin, and the command warns of
it. Sharing touches the portal alone, never Caddy, and a site that is not
behind the portal, or not yet in the machine's snapshot, is refused with
`no-portal`.

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
| `GET /api/v1/projects/<slug>/sharing` | who may open it: `policy` (`mode`, `people`, `domains`), `updatedAt`, `url`, `sso` (`configured`, `providerName`), and `allowedDomains`, the only domains your token may open it to |
| `PUT /api/v1/projects/<slug>/sharing` `{ mode, people, domains }` | replaces the policy whole, the portal's body: `mode` is `admins`, `people` or `domain`; one refused entry refuses the change, named in `details` |

| Code | Status | What to do |
|---|---|---|
| `unauthenticated` | 401 | the token is missing, unknown, expired or revoked: ask the owner |
| `too-many-attempts` | 429 | too many wrong tokens from your address: wait `wait` seconds |
| `out-of-scope` | 403 | the token may not do this, a domain outside the ones the portal admits or `public` among them: the message says whom to ask |
| `reserved` | 403 | the slug belongs to the platform: pick another |
| `invalid-manifest` | 422 | fix every point of `details` |
| `invalid` | 400 | the request itself is malformed |
| `not-found` | 404 | no such deployment or project for this token |
| `busy` | 409 | a deployment of this project is already running, or, when the archive arrives, three deployments already run on the machine: send it again in a minute, the deployment waits for it until its 15 minutes are up |
| `too-large` | 413 | exclude dependencies and caches |
| `expired` | 410 | the archive arrived after 15 minutes: start again |
| `no-portal` | 409 | sharing a site that is not behind the portal, or not deployed yet: deploy it; only the owner puts a site behind the portal |
| `not-available` | 503 | the machine does not carry the control API yet, or its portal predates sharing: tell the owner |
| `failure` | 500, 502 | something broke on the machine: the message says where the owner should look |

A failed deployment carries its own `error.code`, the step that stopped it:
`install-failed`, `secret-missing`, `edited-by-hand`, `system-unit`, `caddy-busy`,
`bundle-refused`, `service-failed`, `verify-failed` and a few more, each with a
message that says what to do.

## When it goes wrong

- **`not-available`**: the owner has not installed the control API on this
  machine yet, see [dashboard/README.md](../dashboard/README.md), "The control
  API".
- **`edited-by-hand`**: a file of your project on the machine, its unit or its
  Caddy block, was changed by hand. The owner reads it and deploys once over SSH
  with `--force`; yours works again afterwards.
- **`caddy-busy`**: the owner or the dashboard is changing Caddy. Nothing served
  changed: deploy again in a moment.
- **A project you created and can no longer deploy**: your token was revoked.
  Your projects stay on the machine; the owner grants them to your new token.
