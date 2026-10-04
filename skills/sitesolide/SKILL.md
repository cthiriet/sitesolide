---
name: sitesolide
description: Deploy a project folder to the user's own sitesolide server, and check on it afterwards. Use when the user asks to deploy, publish, ship or put online a site, an app or a tool, to share it with colleagues, to see whether it is up, or to read its logs, in a setup that has the sitesolide CLI or its MCP server.
when_to_use: Requests such as "deploy this", "put it online", "publish the site", "share this tool with my team", "is it up?", "why does the site return 500?" or "show me the logs", and any folder holding a sitesolide.json.
---

# Deploying with sitesolide

sitesolide serves every project of its owner from one machine they own. A
project is a folder; `sitesolide deploy` builds it on this workstation, uploads
it, installs a confined service and its Caddy block, and checks that the site
answers over HTTPS. There is no staging: **what you deploy is live, for every
visitor, at once.**

Use the MCP tools when they are available (`detect`, `deploy`, `status`,
`logs`, `lock_status`). Otherwise run the CLI with `--json`: every line of
standard output is one JSON event, the last one a `result` or an `error`.

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
   - the slug, which is the address: `<slug>.<their zone>`.
   Write `sitesolide.json` (`detect --write`, or by hand) and edit it there.
3. **Dry run.** `deploy` with `dry_run: true` (`sitesolide deploy --dry-run
   --json`). It reads the server, shows the generated unit and block and every
   step, and changes nothing. Show the user what it plans.
4. **Deploy**, once the user agrees: `deploy` (`sitesolide deploy --json`). A
   folder still without a manifest needs `accept_inferred: true` (`--yes`).
5. **Read the result.** On success, give the user the `url`. When
   `manifestWritten` is true, `sitesolide.json` changed on disk (a port chosen,
   an inferred manifest, a door set from the dashboard): commit it.

## When it fails

Every error carries a `hint`: follow it. The usual ones:

- **A secret is missing on the server.** The deploy stopped before restarting
  anything. Tell the user to create the file and its values in the dashboard's
  *Secrets* section, at the address the error gives, then deploy again. Never
  put a secret value in the repository, in `sitesolide.json`, or in `env`: the
  validation refuses names that look like secrets, and a secret in git is a
  secret to change.
- **The service fails at the restart, or the site answers 500 or 502.** Read
  `logs` (`sitesolide logs --json --lines 100`): each entry has its unit,
  priority and message. Priority 3 and below are errors. Fix the code, deploy
  again.
- **A block or unit "no longer matches the manifest".** Someone edited it on
  the machine. Show the user the differing lines; only they decide whether
  `--force` replaces it.
- **A port is taken.** Delete `port` from `sitesolide.json`; deploy picks a free
  one and writes it back.
- **The name already exists on the server.** Another project uses it: pick
  another with `slug` (`--slug`), never deploy over it.

## Never

- Never touch the server by hand: no `ssh`, no `sudo`, no `systemctl`, no
  editing files there, and never `caddy stop` or `caddy start`, which stop every
  site at once. Everything goes through the CLI or the tools.
- Never retry a refusal with `--force` or a workaround on your own.
- Never remove a project, lock or unlock a preview, or switch a domain unless
  the user asked for exactly that: those are their commands, not tools.
- Never read, print or guess a secret, nor ask the user to paste one.

## Status and other reads

`status` lists every project on the machine with its service state and
memory. `lock_status` (`sitesolide lock --status --json`) says whether a
preview is closed behind an access code, without revealing the code.

The full reference: `docs/agents.md` in the sitesolide repository, and
`docs/manifest.md` for every key of `sitesolide.json`.
