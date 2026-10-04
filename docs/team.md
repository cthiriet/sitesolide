# Deploying as a team member

The owner of the machine deploys over SSH, as root. You do not need that, and
should not have it: the owner gives you a **token**, personal and revocable,
and `sitesolide deploy` sends your project to the dashboard over HTTPS. The
machine installs it the way it installs the owner's, and you never hold root.

The same works for an agent in a sandbox with no SSH key: a token in its
environment is all it needs.

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

You need [Bun](https://bun.com) and the CLI:

```bash
git clone https://github.com/cthiriet/sitesolide && cd sitesolide
ln -sf "$PWD/bin/sitesolide.ts" ~/.local/bin/sitesolide
sitesolide login --url https://dashboard.<zone>
```

`login` asks for the token, checks it against the dashboard, and says who it
belongs to and what it may do. It keeps the token in
`~/.config/sitesolide/secrets/team-token` (0600), and the address in
`~/.config/sitesolide/config.json` under `api`. `--token-stdin` reads the token
from standard input instead of a prompt.

A workstation with no `server` in its configuration uses the dashboard for
`deploy`, `status` and `logs`. Every other command (`lock`, `domain`, `remove`,
`run`) needs the owner's SSH access and says so.

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
3. **The archive** carries your code in `app/`, without what `exclude` lists,
   `.git` and the manifest, and your `publicDir` in `public/`: exactly what the
   owner's rsync would send. Symbolic links are refused; replace them with the
   files they point to.
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

| Code | Status | What to do |
|---|---|---|
| `unauthenticated` | 401 | the token is missing, unknown, expired or revoked: ask the owner |
| `too-many-attempts` | 429 | too many wrong tokens from your address: wait `wait` seconds |
| `out-of-scope` | 403 | the token may not do this: the message says whom to ask |
| `reserved` | 403 | the slug belongs to the platform: pick another |
| `invalid-manifest` | 422 | fix every point of `details` |
| `invalid` | 400 | the request itself is malformed |
| `not-found` | 404 | no such deployment or project for this token |
| `busy` | 409 | a deployment of this project is already running, or, when the archive arrives, three deployments already run on the machine: send it again in a minute, the deployment waits for it until its 15 minutes are up |
| `too-large` | 413 | exclude dependencies and caches |
| `expired` | 410 | the archive arrived after 15 minutes: start again |
| `not-available` | 503 | the machine does not carry the control API yet: tell the owner |
| `failure` | 500, 502 | something broke on the machine: the message says where the owner should look |

A failed deployment carries its own `error.code`, the step that stopped it:
`install-failed`, `secret-missing`, `edited-by-hand`, `caddy-busy`,
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
