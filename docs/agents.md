# Agents

Small software is more and more often written by an agent: Claude Code, Codex,
Cursor. sitesolide gives an agent three ways in, and none of them gives it more
than a person at a terminal has:

- **the CLI with `--json`**, for an agent that runs commands;
- **an MCP server**, `sitesolide mcp`, for an agent that calls tools;
- **a skill**, `skills/sitesolide/SKILL.md`, which teaches the workflow.

All three run the same commands, with the same refusals. A deploy an agent
starts reads the door the dashboard set, takes the Caddy lock, checks the
secrets on the machine and rolls a broken Caddy block back exactly as yours
would.

## What an agent may do, and what stays yours

| An agent can | It cannot |
|---|---|
| infer a manifest for a folder (`detect`) | remove a project, which the machine keeps no backup of |
| dry-run a deploy, and deploy | lock or unlock a preview, switch a domain |
| read the server's status, a project's logs, its lock state | `--force` over a file someone edited on the machine |
| | read, set or guess a secret |

Secrets are set in the dashboard's *Secrets* section, by you. A deploy that
needs one the machine lacks stops and names the page where to create it; the
agent tells you, and runs the deploy again once you have. Nothing an agent
writes into the repository or the manifest ever carries a secret value: the
manifest validation refuses an `env` key that looks like one.

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
one `result` or one `error`. A failure exits non-zero.

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
| `result` | `ok`, `command`, and the command's data | the end of a run that succeeded |
| `error` | `message`, `details`, `hint` | the end of a run that failed |

What `result` carries:

| Command | Fields |
|---|---|
| `deploy` | `slug`, `kind` (`static`, `service`, `services`), `dryRun`, `port`, `portChosen` (`kept`, `free`) when chosen, `portal`, `inferred` when the manifest was, `manifestWritten`, `url`, `status` (HTTP, null in a dry run) |
| `detect` | `kind`, `manifest`, `reasons`, `notes`, `written` |
| `status` | `projects` (each with its `services`), `ports`, `memory`, in megabytes |
| `logs` | `slug`, `units`, `entries` |
| `lock --status` | `slug`, `lock`: `wanted`, `installed`, `withoutCode`, `withCode`, `domain` |
| `domain` | `slug`, `domain`: `name`, `aliases`, `active`, `table`, `dns`, `https` |
| `remove` | `slug`, `dryRun` |

**`manifestWritten: true` means `sitesolide.json` changed on disk**: an
inferred manifest, a port chosen, or a door the dashboard set. Commit it.

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
| `lock_status` | `folder` | no |

`folder` is an absolute path. `deploy`'s description says first that it
changes the live server: leave it on "ask" in your client rather than allowing
it once and for all, so that every real deploy is yours to approve.

It speaks both eras of the protocol: 2026-07-28, with no handshake and the
version on every request, and 2025-11-25 back to 2024-11-05, with `initialize`.
`notifications/cancelled` interrupts a command as Ctrl-C would: the step in
progress finishes, then it stops and releases the Caddy lock.

### Registering it

The README links `bin/sitesolide.ts` as `~/.local/bin/sitesolide`. With that
on your `PATH`:

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
the argument `mcp`. Without the link on the `PATH`, give the full path:
`bun /path/to/sitesolide/bin/sitesolide.ts mcp`.

## The skill

`skills/sitesolide/SKILL.md` teaches an agent the workflow: detect, review the
manifest with you, dry-run, deploy, read the result, read the logs when
something fails, and where secrets go. Claude Code finds it in
`~/.claude/skills/`:

```bash
mkdir -p ~/.claude/skills
ln -s "$PWD/skills/sitesolide" ~/.claude/skills/sitesolide
```

or, for one repository only, in its `.claude/skills/`. It works with the MCP
server or without it, through the CLI.

## llms.txt

`llms.txt`, at the root of the repository, is the index of these documents in
the [llmstxt.org](https://llmstxt.org) format, for an agent that reads before
it acts.

## Upgrading

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

**What only the machine can confirm**, on the first real deploy of each kind:

- an inferred Python app's `start` uses `${PORT}`, which systemd expands from
  the unit's own `Environment=PORT=`: `systemctl show <slug> -p ExecStart` shows
  the line, `ss -ltn | grep <port>` shows uvicorn or gunicorn listening on it;
- `sitesolide logs --json` relies on `journalctl -o json --output-fields`,
  systemd 236 or later: it prints `log` events with a `unit` and a `priority`;
- an inferred Python app's `install` uses `/usr/local/bin/uv`, which the machine
  must carry, like every Python project here.
