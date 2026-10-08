# Agents

Small software is more and more often written by an agent: Claude Code, Codex,
Cursor. sitesolide gives an agent three ways in, and none of them gives it more
than a person at a terminal has:

- **the CLI with `--json`**, for an agent that runs commands;
- **an MCP server**, `sitesolide mcp`, for an agent that calls tools;
- **a skill**, `skills/sitesolide/SKILL.md`, which teaches the workflow.

All three run the same commands, with the same refusals. A deploy an agent
starts reads the general access the dashboard set, takes the Caddy lock,
checks the secrets on the machine and rolls a broken Caddy block back exactly
as yours would.

## What an agent may do, and what stays yours

| An agent can | It cannot |
|---|---|
| infer a manifest for a folder (`detect`) | remove a project, which the machine keeps no backup of |
| dry-run a deploy, and deploy | lock or unlock a preview, switch a domain |
| read the server's status, a project's logs, its lock state | `--force` over a file someone edited on the machine |
| give the people you named access to a project, by email or `@domain`, with a role, and read who has access | give access to anyone you did not name, or make a site Public, which is its general access, the dashboard's |
| list the machines sitesolide created at a cloud provider | destroy one, unless you asked for that machine to be destroyed |
| check a machine with `setup --dry-run`, and install it when you asked | replace DNS records that point elsewhere (`setup --dns-replace`), unless you decided it |
| list what a new release would change with `upgrade --dry-run`, and upgrade when you asked | redeploy a component by hand, or force over a file edited on the machine |
| list everyone with access, and who may create projects, with `people` | grant or take back the right to create projects, unless you asked for that person: it lets them into the dashboard |
| | read, set or guess a secret, a provider's token included |

Secrets are set in the dashboard's *Secrets* section, by you. A deploy that
needs one the machine lacks stops and names the page where to create it; the
agent tells you, and runs the deploy again once you have. Nothing an agent
writes into the repository or the manifest ever carries a secret value: the
manifest validation refuses an `env` key that looks like one.

## Giving access to what was deployed

Building a small tool ends with "give it to the people who need it". Two
tools, and one command behind both:

- `access` (`sitesolide share --json`) reads a project's general access
  (Public, Restricted to the people with access, or Anyone with the code), its
  people with access, each with their role, and the line to send them;
- `share` (`sitesolide share <who>... --json`) gives people access, by email
  or a whole domain written `@acme.com`, with a role: `can-open` (Can open, the
  default), `viewer`, `developer` or `admin`, each including the ones below
  it; or takes it away, with `remove`. One direction per call.

**Giving access lets real people into the app and the data it holds**, from
their next request, and from Viewer up into the project in the dashboard: the
tool's description says so first. An agent asks the user before every call,
naming the exact addresses, domains and role, gives access to those and nobody
else, and reads `access` before and after to show the user who has it. Leave
`share` on "ask" in your client.

**Password access is shown once.** Someone outside the company's domains, or
anyone when signing in with a company account is not set up, is given Can open
with a password the machine draws for them. It comes back once, in an `info`
event and in the result's `changes`, for the user to send them: tell the user,
and never store, log or repeat it anywhere else. `expires` sets how long it
lasts, `24h`, `7d` (the default), `30d` or `never`.

```console
$ sitesolide share alice@acme.com --json
{"type":"step","message":"access to notes, https://notes.example.com/, over SSH, as the owner"}
{"type":"step","message":"alice@acme.com: Can open on notes"}
{"type":"info","message":"general access: Restricted: visitors are asked to sign in."}
...
{"type":"info","message":"send: Open https://notes.example.com/ and sign in with your Google account."}
{"type":"result","ok":true,"command":"share","slug":"notes","url":"https://notes.example.com/","general":"restricted","entries":[{"who":"@acme.com","kind":"domain","role":"can-open","by":"owner","createdAt":1791450000000,"updatedAt":1791450000000,"password":null},{"who":"alice@acme.com","kind":"person","role":"can-open","by":"owner","createdAt":1791450000000,"updatedAt":1791450000000,"password":null}],"signIn":{"configured":true,"allowedDomains":["acme.com"]},"message":"Open https://notes.example.com/ and sign in with your Google account.","changed":true,"changes":[{"who":"alice@acme.com","change":"add","role":"can-open"}]}
```

`entries` lists every entry as it stands after the change: `who`, `kind`
(`person`, `domain`, or `password` for password access), `role`, `by`,
`createdAt`, `updatedAt`, and `password`, `{ expiresAt, expired }` for
password access, null otherwise. `changes` says what this call did, each
`{ who, change, role }`, `change` being `add`, `role`, `none` or `remove`
(`role` null then), with `password` for password access just given.
`message` is the line to send people who sign in with a company account, null
until that is set up; the `send:` event comes only after a change that gives
someone access with an account. A `warning` that the portal still decides
from its own tables means the machine is halfway through an upgrade: tell the
user, whose owner runs `sitesolide upgrade`; what was given is kept.

Never done this way: making a site Public, its general access, which is the
dashboard's; the preview code, `sitesolide lock`, the owner's. With a token,
`share` gives Can open alone, to people who sign in with a company account or
to one of the company's domains, never password access, and takes Can open
entries off: see [access.md](access.md#giving-access-to-what-you-deployed).

The refusals, each carrying its `hint`:

| Code | What it means | What to do |
|---|---|---|
| `usage`, `unknown-option` | the call itself is wrong | run what `details` lists |
| `invalid` | neither an email nor a `@domain`, a domain given more than Can open, someone outside the company's domains given more than Can open | fix what the message names |
| `out-of-scope` | whoever asks may not: a token giving more than Can open, password access or a domain outside the company's, or taking off an entry above Can open; a person's own token on a project they are not Admin of; a project of the platform | change what the message names, or ask the owner of the machine; never another slug, role or token |
| `not-found` | no such project for this token, a project not deployed, or someone with no access to take off | check the slug in `sitesolide.json`; `sitesolide status` lists the projects |
| `locked` | the change needs the dashboard's unlock | the user makes it from the dashboard, or the owner over SSH |
| `ssh-failed` | a command over SSH failed, nothing changed | run it again; if it fails twice, check that `ssh <server> true` connects without a prompt |
| `steward-outdated` | over the owner's SSH, the steward does not keep people with access yet | the user runs `sitesolide upgrade` when they decide to, then the same command again |
| `not-available` | with a token, the dashboard or its steward does not carry access yet | tell the owner of the machine, who runs `sitesolide upgrade` |
| `unauthenticated` | the token is missing, expired or revoked | ask the owner for one; never guess or borrow a token |
| `failure` | something broke on the machine | tell the owner of the machine, with the message; never retry in a loop |

## Zero configuration

A folder without a `sitesolide.json` is no longer a dead end:

```console
$ cd shop && sitesolide detect
-> this folder reads as a Bun app
   from: package.json; server.ts starts a server
{
  "slug": "shop",
  "publicDir": "public",
  "install": "/usr/local/bin/bun install --production",
  "start": "/usr/local/bin/bun run server.ts",
  "env": {
    "NODE_ENV": "production"
  },
  "exclude": [
    "node_modules"
  ]
}
   note: the dependencies are installed on the server, by bun install --production
   note: the code seems to reach the network (server.ts:2): a service only reaches the loopback by default, DNS included; add "network": "outbound" if it does
   note: the code reads STRIPE_SECRET_KEY: secrets live on the server, never in the repository; declare "secrets": ["shop.env"] and set their values in the dashboard's Secrets section
   note: no "port": deploy picks a free one on the server and writes it into sitesolide.json
   nothing was written; to write it: sitesolide detect --write
```

`detect --write` writes it, never over an existing one. `deploy` in such a
folder shows the same manifest and stops, giving the command that accepts it;
`deploy --yes` writes it and deploys. `--slug <name>` names the project
otherwise than after its folder.

`detect` reads the folder and nothing outside it: a symbolic link leading out,
a `package.json` linked to a file of your home directory for instance, is never
followed, and the folder is refused, naming the link. A file that does not parse
is said not to, without the parser's message, which quotes the file.

What is recognised, first match wins:

| The folder holds | The manifest |
|---|---|
| `go.mod` | a binary cross-compiled for linux/amd64 on the workstation, started from `app/` |
| `pyproject.toml` or `requirements.txt` naming FastAPI or Flask | a virtualenv built on the machine by uv, uvicorn or gunicorn on `${PORT}` |
| a `package.json` with a server: a start script, or a file that listens | the machine's Bun runs it, `public/` served by Caddy |
| a `package.json` whose generator builds files: Vite, Astro, Eleventy, Gatsby... | the build on the workstation, its output served |
| a server file alone, `server.ts` with `Bun.serve` | the machine's Bun runs it as it is |
| `index.html` under `public/`, `dist/`, `build/`, `_site/` or `out/` | that folder, served as it is |

**What is never decided for you.** A secret is never guessed: code that reads
`STRIPE_SECRET_KEY` gets a note, not a value nor a declared file. The network
is never opened: code that obviously calls out gets a note naming the line,
and `"network": "outbound"` stays your decision. Neither `.git` nor a `.env`
ever leaves, at any depth, from the code or the public folder, and a note names
the ones the folder holds. An `index.html` at the root of a folder is refused rather
than served from there, because the root would serve `.git` with it: move the
site into `public/`.

**A name the machine already serves is refused.** An inferred manifest names
the project after its folder, and a folder called `api` is not the only one:
`deploy --yes` stops if the machine already carries a project of that name,
before anything is written. Pick another with `--slug`.

**The port is chosen by `deploy`.** An app whose manifest has no `port` gets
the lowest one the machine's manifests leave free between 3000 and 3099, the
range the loopback rule closes, never one of the platform's own services.
A project the machine already carries keeps the port it has there. The port is
written into the local `sitesolide.json`, with a message: commit it, and every
later deploy, from any workstation, keeps it. A dry run says which port it
would take and writes nothing. A project of several `services` declares its
ports itself, since its services name each other's in their `env`.

**A dry run runs nothing of the folder.** The manifest's `build` is the
folder's own code, and a dry run is what an agent tries first, on a folder it
may have just cloned, from the workstation that holds root SSH to the machine:
it shows the build as a `planned` event, and does not run it. Only a person
typing `sitesolide deploy --dry-run --build` runs it in a dry run; the MCP
tool never does. Likewise, a name inference would put into a command, a folder
under `cmd/` or a server file, is declined unless it is made of letters,
digits, dots, dashes and underscores, and a manifest outside your sites
repository may only point `source` inside its own repository.

## The CLI with `--json`

Every command but `init` and `run` takes `--json`: standard output then
carries one JSON object per line, nothing else, and the run ends with exactly
one `result` or one `error`, always the last line: the Caddy lock is released
before it, so that what its release says comes first. A failure exits non-zero.
Through a token, the same holds.

```console
$ sitesolide deploy --dry-run --json
{"type":"step","message":"project shop, service"}
{"type":"step","message":"port 3042, the lowest free one on the server"}
{"type":"planned","message":"write /home/me/shop/sitesolide.json with \"port\": 3042"}
{"type":"file","name":"shop.service","content":"# Service of project shop, ..."}
{"type":"planned","message":"rsync -a --delete --exclude node_modules ..."}
{"type":"result","ok":true,"command":"deploy","slug":"shop","kind":"service","dryRun":true,"manifestWritten":false,"port":3042,"portChosen":"free","portal":false,"url":"https://shop.example.com/","status":null}
```

| `type` | Fields | What it is |
|---|---|---|
| `step` | `message` | a step of the run, the `->` lines of the human output |
| `info` | `message` | something said along the way |
| `planned` | `message` | what a dry run would have done |
| `warning` | `message`, `details` | something wrong that stops nothing |
| `output` | `stream`, `line` | a line printed by a command the CLI launched: the build, rsync, a script |
| `file` | `name`, `content` | a generated systemd unit or Caddy block |
| `inferred` | `kind`, `manifest`, `reasons`, `notes` | the manifest inferred for a folder without one |
| `log` | `at`, `unit`, `priority`, `message` | one journal entry, for `logs` |
| `check` | `step`, `status` (`done`, `ok`, `skip`, `todo`, `fail`), `title`, `detail` | one line of `setup`'s or `upgrade`'s checklist |
| `result` | `ok`, `command`, and the command's data | the end of a run that succeeded |
| `error` | `message`, `details`, `hint` | the end of a run that failed |

What `result` carries:

| Command | Fields |
|---|---|
| `deploy` | `slug`, `kind` (`static`, `service`, `services`), `dryRun`, `port`, `portChosen` (`kept`, `free`) when chosen, `portal`, `inferred` when the manifest was, `manifestWritten`, `url`, `status` (HTTP, null in a dry run); with `--compare`, `compared`, `changes` (what would change on the server, empty when nothing would) and `kept` (units edited on the machine, which deploy leaves) |
| `detect` | `kind`, `manifest`, `reasons`, `notes`, `written` |
| `status` | `projects` (each with its `services`), `ports`, `memory`, in megabytes |
| `logs` | `slug`, `units`, `entries` |
| `lock --status` | `slug`, `lock`: `wanted`, `installed`, `withoutCode`, `withCode`, `domain` |
| `domain` | `slug`, `domain`: `name`, `aliases`, `active`, `table`, `dns`, `https` |
| `remove` | `slug`, `dryRun` |
| `share` | `slug`, `url`, `general` (`public`, `restricted`, `code`, or null for a project not deployed), `entries` (each `who`, `kind`, `role`, `by`, `createdAt`, `updatedAt`, `password`), `signIn` (`configured`, `allowedDomains`), `message` (null until signing in with a company account is set up), `changed`, and after a change `changes` (each `who`, `change`: `add`, `role`, `none` or `remove`, `role`, and `password` for password access just given) |
| `people` | listing: `people` (each `who`, `roles` by project, `create`, `passwords`, `admin`), `domains` (each `slug`, `domain`), `signIn`, `changed: false`; `--may-create` and `--no-create`: `email`, `create`, `roles`, `change` (`create`, `none`), `changed` |
| `machine create` | `provider`, `created` (false when an earlier run had), `machine`, `resources` (each `kind`, `name`, `id`, `reused`), `next`, the `setup` command to run |
| `machine list` | `provider`, `machines`, each with `name`, `type`, `location`, `status`, `ipv4`, `ipv6`, `ipv6Network`, `monthlyPrice` (`net`, `gross`, `currency`), `backups`, `managed` |
| `machine destroy` | `provider`, `name`, `removed`, `kept`, `dns` |
| `setup` | `dryRun`, `server`, `zone`, `steps` (each `step`, `status`, `detail`); after a real run also `dashboard`, `portal`, `configuration`, `ran`, `already`, `skipped`, `passwords`, `next` |
| `upgrade` | `dryRun`, `server`, `zone`, `release`, `components` (each `component`, `title`, `state`: `up-to-date`, `out-of-date`, `missing`, `upgraded`, `failed`, `detail`, `run`), `upgraded`, `upToDate`, `outOfDate`, `missing`, `next` (the `setup` command that installs what is missing) |

**`upgrade` changes the machine in service.** `--dry-run` only reads it, and
says what would run; the run itself redeploys live components, the dashboard,
the portal, Caddy's configuration, and is the user's decision, never an
agent's own. It never reads a secret nor draws a password. A component it
reports `missing` is `setup`'s to install, on the same decision.

**`setup` never puts a password in an event.** The dashboard's and the
portal's, when a run draws them, go to standard error once, for the person at
the terminal; `passwords` only says that they did. See [setup.md](setup.md).

**`manifestWritten: true` means `sitesolide.json` changed on disk**: an
inferred manifest, a port chosen, or general access the dashboard set. Commit
it.

**Every `error` carries a `hint`**: the one action to take next, and the ones
not to, re-running with `--force` or changing the server by hand above all.
The hints live in `bin/cli/hints.ts`, and a test fails on a refusal without
one.

`logs --json` reads journalctl's own JSON, one `log` event per entry;
`--follow` keeps the stream open, `--lines <n>` goes further back.

**ssh never prompts under `--json`.** A passphrase or a host key to confirm
fails the connection at once rather than waiting for a keyboard an agent does
not have. Load the key into the agent first, `ssh-add`, and connect once by
hand so that the host key is known.

## The MCP server

`sitesolide mcp` speaks the Model Context Protocol on standard input and
output. Each tool runs the CLI with `--json` in the folder it names and
returns its events: the `result` or the `error`, and what led to it. It needs
no dependency and no configuration of its own: the CLI's configuration is read
by each command.

| Tool | Arguments | Changes anything |
|---|---|---|
| `detect` | `folder`, `slug` | no, and reads no machine |
| `deploy` | `folder`, `dry_run`, `accept_inferred`, `slug` | **yes**, the live site, unless `dry_run`, which runs not even the build |
| `status` | | no |
| `logs` | `folder`, `lines` | no |
| `access` | `folder` | no |
| `share` | `folder`, `who`, `role`, `expires`, `remove` | **yes**, who may open the app and its data, and from Viewer up who sees or changes the project in the dashboard |
| `lock_status` | `folder` | no |

`setup` and `upgrade` are not tools: they change the machine itself, and run
through the CLI, when the user asked. Neither is `people`: the right to create
projects lets someone into the dashboard, which is the owner's to give, over
their SSH. `folder` is an absolute path.
`deploy`'s description says first that it changes the live server, and `share`'s that it gives real people access: leave
both on "ask" in your client rather than allowing them once and for all, so
that every real deploy, and every person let in, is yours to approve.

It speaks both eras of the protocol: 2026-07-28, with no handshake and the
version on every request, and 2025-11-25 back to 2024-11-05, with `initialize`.
`notifications/cancelled` interrupts a command as Ctrl-C would: the step in
progress finishes, then it stops and releases the Caddy lock. A request whose id
is still in flight is refused, so that an answer or a cancellation always names
one command, and a message longer than a mebibyte is refused unread.

### Registering it

`install.sh` puts the `sitesolide` binary in `~/.local/bin`, see
[install.md](install.md). With that on your `PATH`:

**Claude Code**, for every project:

```bash
claude mcp add --scope user --transport stdio sitesolide -- sitesolide mcp
```

or in one repository, shared through its `.mcp.json`:

```json
{
  "mcpServers": {
    "sitesolide": { "type": "stdio", "command": "sitesolide", "args": ["mcp"] }
  }
}
```

**Codex**, in `~/.codex/config.toml`:

```toml
[mcp_servers.sitesolide]
command = "sitesolide"
args = ["mcp"]
```

**Cursor**, in `~/.cursor/mcp.json` or a project's `.cursor/mcp.json`:

```json
{ "mcpServers": { "sitesolide": { "command": "sitesolide", "args": ["mcp"] } } }
```

**Any other client** that launches stdio servers: the command `sitesolide`,
the argument `mcp`. Without it on the `PATH`, give the binary's full path, or
from a checkout `bun /path/to/sitesolide/bin/sitesolide.ts mcp`.

## The skill

`skills/sitesolide/SKILL.md` teaches an agent the workflow: detect, review the
manifest with you, dry-run, deploy, read the result, give the people who need
it access, read the logs when something fails, and where secrets go. Claude
Code finds it in `~/.claude/skills/`. The binary does not carry it: from a
clone of this repository, link it,

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/sitesolide" ~/.claude/skills/sitesolide
```

or copy `skills/sitesolide/SKILL.md` into `~/.claude/skills/sitesolide/`, or,
for one repository only, into its `.claude/skills/sitesolide/`. It works with
the MCP server or without it, through the CLI.

## llms.txt

`llms.txt`, at the root of the repository, is what an agent reads before it
acts, in the [llmstxt.org](https://llmstxt.org) format: how to tell whether
sitesolide is set up, the deploy loop, the `--json` contract, the MCP tools,
tokens, access, a new server, the rules an agent never breaks, and links
to these documents.

## Upgrading from 0.1

Agents arrived in 0.2: a workstation on 0.2 or later has all of this, and
[upgrading.md](upgrading.md) is the order from one release to the next.

Everything here runs on the workstation. **Nothing changes on the machine**,
and nothing has to be run there: the commands send the same remote commands
they always did, the journal's JSON aside, which `logs --json` alone asks for.

1. Pull the repository on the workstation. Check: `sitesolide detect` in a
   project folder prints a manifest, and `sitesolide deploy --dry-run --json`
   ends with a `result` line.
2. Optionally, register the MCP server and link the skill, as above. Check:
   `claude mcp list` shows `sitesolide` connected.

To roll back: check out the previous commit, `claude mcp remove sitesolide`,
and remove the `~/.claude/skills/sitesolide` link.

One behaviour changed: an app whose manifest has no `port` used to be refused,
and is now given one by `deploy`. Every manifest already deployed declares its
port and is untouched.

`share` and the `access` tool need the machine's side: a steward that keeps
the access registry, and with a token the dashboard of the same release, which
`sitesolide upgrade` brings both: see
[upgrading.md](upgrading.md#access-one-registry).

A later release hardened what an agent, a token or a cloned folder can make
`deploy` do: a dry run no longer runs the build, `install` runs as the project's
account in its service's walls, `.git` and `.env` never leave, and more. Some of
it does change the machine, and has an order: see [commands.md](commands.md),
"Upgrading to the hardened deploy".

**What only the machine can confirm**, on the first real deploy of each kind:

- an inferred Python app's `start` uses `${PORT}`, which systemd expands from
  the unit's own `Environment=PORT=`: `systemctl show <slug> -p ExecStart` shows
  the line, `ss -ltn | grep <port>` shows uvicorn or gunicorn listening on it;
- `sitesolide logs --json` relies on `journalctl -o json --output-fields`,
  systemd 236 or later: it prints `log` events with a `unit` and a `priority`;
- an inferred Python app's `install` uses `/usr/local/bin/uv`, which the machine
  must carry, like every Python project here.
