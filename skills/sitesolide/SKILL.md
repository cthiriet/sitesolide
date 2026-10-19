---
name: sitesolide
description: Deploy a project folder to the user's own sitesolide server, and check on it afterwards. Use when the user asks to deploy, publish, ship or put online a site, an app or a tool, to give colleagues access to it, to see whether it is up, or to read its logs, in a setup that has the sitesolide CLI or its MCP server.
when_to_use: Requests such as "deploy this", "put it online", "publish the site", "run this every hour on the server", "keep this bot running", "share this tool with my colleagues", "give alice access", "is it up?", "why does the site return 500?" or "show me the logs", and any folder holding a sitesolide.json.
---

# Deploying with sitesolide

sitesolide serves every project of its owner from one machine they own. A
project is a folder; `sitesolide deploy` builds it on this workstation, uploads
it, installs a confined service and its Caddy block, and checks that the site
answers over HTTPS. There is no staging: **what you deploy is live, for every
visitor, at once.**

Use the MCP tools when they are available (`detect`, `deploy`, `status`,
`logs`, `access`, `share`, `lock_status`). Otherwise run the CLI with
`--json`: every line of standard output is one JSON event, the last one a
`result` or an `error`.

## The workflow

1. **Detect.** In a folder without `sitesolide.json`, call `detect` (or
   `sitesolide detect --json`). It infers the manifest from the folder and
   writes nothing. Read its `notes`: they name the secrets the code reads and
   the calls it makes to the network.
2. **Review with the user.** Show the manifest and the notes. Decide with them,
   never alone:
   - `"network": "outbound"` when the code calls another server: without it the
     service reaches only the loopback, DNS included;
   - `"secrets": ["<slug>.env"]` when the code reads a secret;
   - a `backup` command for a service that runs a server database in the
     data folder, PostgreSQL or MongoDB: without one, the hourly snapshot
     refuses the project (`docs/manifest.md`, "A service's backup command");
   - work that is not a web server, written by hand under `services`, never
     as the top-level `start`: a worker, `"internal": true` and no `port`,
     runs for good and should exit cleanly on SIGTERM; a scheduled service,
     `"schedule": "*:0/15"` (systemd calendar syntax: `hourly`, `daily`,
     `Mon..Fri 08:00`) and optionally `"timeout": "15m"` (1h by default),
     runs to its end at those times. `"cpu": "50%"` caps a service at half a
     core. A project of those alone, without `publicDir`, serves no page and
     takes no `domain`. A headless browser, heavy computing or mass email
     from the machine itself does not belong on the machine that serves every
     site: say so first (`docs/manifest.md`, "What fits on the machine");
   - the slug, which is the address: `<slug>.<their zone>`.
   Write `sitesolide.json` (`detect --write`, or by hand) and edit it there.
3. **Dry run.** `deploy` with `dry_run: true` (`sitesolide deploy --dry-run
   --json`). It reads the server, shows the generated unit and block and every
   step, and changes nothing; it does not run the project's build either, which
   is the folder's own code. Show the user what it plans. With a token instead
   of SSH, a dry run is refused: review `sitesolide.json` with the user.
4. **Deploy**, once the user agrees: `deploy` (`sitesolide deploy --json`). A
   folder still without a manifest needs `accept_inferred: true` (`--yes`);
   with a token, write it first with `sitesolide detect --write`.
5. **Read the result.** On success, give the user the `url`. When
   `manifestWritten` is true, `sitesolide.json` changed on disk (a port chosen,
   an inferred manifest, general access set from the dashboard): commit it.
6. **Give access to the people who need it.** A restricted site opens to its
   people with access alone. Read `access` first (`sitesolide share --json`),
   ask the user who should get in and with which role, then `share` with
   exactly those addresses or that domain (`who`), and nobody else
   (`sitesolide share alice@acme.com --json`, `@acme.com` for everyone at a
   domain). The role is Can open (`can-open`) unless the user names `viewer`,
   `developer` or `admin`, which also let the person into the project in the
   dashboard. Access lets real people into the app and its data: tell the user
   who will get in, and wait for their yes. Give them the `message` of the
   result to send. Someone outside the company's domains gets password access:
   the password comes back once, in the result's `changes`, for the user to
   send; never store or repeat it. `remove` takes access away.

## When it fails

Every error carries a `hint`: follow it. The usual ones:

- **`missing settings`.** Nothing is configured on this workstation. A new
  server is `sitesolide machine create`, then `sitesolide setup`, run only when
  the user asks, with their own tokens from the environment; a server already
  installed is `sitesolide init`; someone with a token runs `sitesolide
  login`. Never guess a server or a zone.
- **A secret is missing on the server.** The deploy stopped before restarting
  anything. Tell the user to create the file and its values in the dashboard's
  *Secrets* section, at the address the error gives, then deploy again. With a
  token that may manage secrets, they may instead run `sitesolide secrets set
  NAME` in their own terminal, which asks for the value without echoing it.
  Never put a secret value in the repository, in `sitesolide.json`, or in
  `env`: the validation refuses names that look like secrets, and a secret in
  git is a secret to change.
- **The service fails at the restart, or the site answers 500 or 502.** Read
  `logs` (`sitesolide logs --json --lines 100`): each entry has its unit,
  priority and message. Priority 3 and below are errors. Fix the code, deploy
  again.
- **A service fell right after its restart.** The deploy watches every
  server and worker for ten seconds and names each one that stopped or was
  restarted: read `logs`, fix the code, deploy again.
- **A schedule systemd does not read.** The deploy stopped before writing
  anything: fix the expression in `schedule`, check it with the user, deploy
  again.
- **A block or unit "no longer matches the manifest".** Someone edited it on
  the machine. Show the user the differing lines; only they decide whether
  `--force` replaces it.
- **A port is taken.** Delete `port` from `sitesolide.json`; deploy picks a free
  one and writes it back.
- **The name already exists on the server.** Another project uses it: pick
  another with `slug` (`--slug`), never deploy over it.
- **Access refused.** `out-of-scope`: whoever asks may not give that. A token
  gives Can open alone, to people of the company's domains or one of those
  domains, never password access; ask the user to give it from the dashboard,
  or the owner. `not-found`: the project is not deployed, or the person has no
  access to take away. `steward-outdated` or `not-available`: the machine
  needs `sitesolide upgrade`, the owner's to run. A warning that the portal
  still decides from its own tables goes to the user.

## Never

- Never touch the server by hand: no `ssh`, no `sudo`, no `systemctl`, no
  editing files there, and never `caddy stop` or `caddy start`, which stop every
  site at once. Everything goes through the CLI or the tools.
- Never retry a refusal with `--force` or a workaround on your own.
- Never remove a project, lock or unlock a preview, switch a domain, destroy a
  machine, upgrade it (`sitesolide upgrade`; `--dry-run` only reads) or replace
  DNS records with `setup --dns-replace` unless the user asked for exactly
  that: those are their commands, not tools.
- Never retry `setup` in a loop on a refused connection: most likely fail2ban
  banned this workstation, for 10 minutes.
- Never give access to anyone the user did not name, nor a role they did not
  name, and never make a site Public: general access is theirs, from the
  dashboard.
- Never read, print or guess a secret, nor ask the user to paste one. `sitesolide
  secrets set NAME --stdin` is for the user to run, or for a value you
  generate yourself and pipe, a random key (`openssl rand -hex 32 |
  sitesolide secrets set SESSION_SECRET --stdin --json`); never for a value
  from the conversation, and never with the value as an argument. A name
  that looks like a value is refused `looks-like-value`, never quoted: tell
  the user it may be in the shell's history and to change it at its source.
  There is no MCP tool for it, on purpose.

## Status and other reads

`status` lists every project on the machine with its service state and
memory; a scheduled service shows its schedule, its last run and how it
ended, and its next run, and is `inactive` between two runs, which is not an
outage. Its runs are in `logs`, beside the other services. `access`
(`sitesolide share --json`) says a project's general access and its people
with access, with their roles. `lock_status`
(`sitesolide lock --status --json`) says whether a preview is closed behind an
access code, without revealing the code.

With a token minted with *Manage secrets*, `sitesolide secrets --json` lists
the project's secret files and their variable names, never a value, and
whether a restart is pending, and such a token sets and removes the variables
of `<slug>.env` (`secrets set NAME --stdin`, `secrets remove NAME...`,
`--restart` to apply them); a token without it is refused. `unconfirmed`
means a change was sent and no answer came: check with `sitesolide secrets
--json`, then run the same command once more, never in a loop. `sitesolide
restart --json`, for any token that deploys the project, restarts the service
and ends in an `error` unless it holds: read `logs` then. Over the owner's
SSH, both point to the dashboard.

The full reference: `docs/agents.md` in the sitesolide repository, and
`docs/manifest.md` for every key of `sitesolide.json`.
