---
name: sitesolide
description: Deploy a project folder to the user's own sitesolide server, and check on it afterwards. Use when the user asks to deploy, publish, ship or put online a site, an app or a tool, to give colleagues access to it, to see whether it is up, or to read its logs. Needs a sitesolide token and nothing installed, deploy.sh doing it with bash and curl, or the sitesolide CLI when it is there.
when_to_use: Requests such as "deploy this", "put it online", "publish the site", "run this every hour on the server", "keep this bot running", "share this tool with my colleagues", "give alice access", "is it up?", "why does the site return 500?" or "show me the logs", and any folder holding a sitesolide.json.
---

# Deploying with sitesolide

sitesolide serves every project of its owner from one machine they own. A
project is a folder with a `sitesolide.json`; a deployment builds it on this
workstation, uploads it over HTTPS to the dashboard's API with a token, and
the machine installs a confined service and its Caddy block and checks that
the site answers over HTTPS. There is no staging: **what you deploy is live,
for every visitor, at once.**

## In short

```bash
curl -fsSL https://github.com/cthiriet/sitesolide/releases/latest/download/deploy.sh -o ~/deploy.sh
cd <the project's folder>          # the one holding sitesolide.json
bash ~/deploy.sh --dry-run         # the machine's plan: nothing built, sent nor changed
bash ~/deploy.sh                   # on the user's yes: build, send, follow to the end
bash ~/deploy.sh --status          # the address, and the state of each service
bash ~/deploy.sh --logs --lines 100
```

with `SITESOLIDE_API` and `SITESOLIDE_TOKEN` in the environment (below).
`deploy.sh` needs bash, curl, tar, gzip and one of jq, node, bun or python3,
which any machine that builds a project already has. Keep it outside the
project, or the archive carries it. It exits 0 only once the machine says the
deployment succeeded; on failure, its last line on standard error says why.

When the `sitesolide` CLI is installed, it does the same with more help, and
is then the one to use: run it with `--json`, every line of standard output
one JSON event, the last a `result` or an `error` carrying a `hint`.

| | deploy.sh | the CLI |
|---|---|---|
| plan | `bash ~/deploy.sh --dry-run` | `sitesolide deploy --dry-run --json` |
| deploy | `bash ~/deploy.sh` | `sitesolide deploy --json` |
| state | `bash ~/deploy.sh --status` | `sitesolide status --json` |
| journal | `bash ~/deploy.sh --logs --lines 100` | `sitesolide logs --json --lines 100` |
| write `sitesolide.json` | by hand | `sitesolide detect --json`, `--write` |
| ports the machine chose | printed: write them into `sitesolide.json` | written back |
| secrets, restart, access | the dashboard, or the CLI | `sitesolide secrets`, `restart`, `share` |

## The token

Every deployment goes through a token, `sst_` then 43 characters, the
owner's included: none goes over SSH. All you need is
`SITESOLIDE_API=https://dashboard.<zone>` and `SITESOLIDE_TOKEN` in your
environment, both together, from wherever the user keeps them (a password
manager's `op run`, a CI's secrets, a `read -rs` they type); with the CLI, a
token the user kept with `sitesolide login --url https://dashboard.<zone>
--token-stdin` does too. Never ask the user to paste a token into the
conversation, never print it, never put it on a command line, never read
`~/.config/sitesolide/secrets/`, never point `SITESOLIDE_API` at another
address than the one the user gave.

- The owner's own token covers every project and alone carries `--force`
  and `--adopt`. The owner mints it on the dashboard's Tokens page ("Every
  project, as you"), or with `sitesolide login --owner` over their SSH
  access. Suggest it when a deploy on the owner's workstation says it needs a
  token; minting is the user's to do.
- Any other token covers the projects it was given, and what it may not do
  is refused `out-of-scope`: never work around it with another slug or token.

## The workflow

1. **The manifest.** In a folder without `sitesolide.json`, write one: with
   the CLI, `sitesolide detect --json` infers it and writes nothing, its
   `notes` naming the secrets the code reads and the calls it makes to the
   network; without it, by hand, from what the code does. The smallest ones:
   a static site `{ "slug": "blog", "build": "bun run build", "publicDir":
   "dist" }`; an app `{ "slug": "api", "start": "/usr/local/bin/bun run
   server.ts", "exclude": ["node_modules"] }`, the machine choosing its port.
   `docs/manifest.md` in the sitesolide repository has every key; an unknown
   key is refused, never ignored.
2. **Review with the user.** Show the manifest. Decide with them, never alone:
   - `"network": "outbound"` when the code calls another server: without it the
     service reaches only the loopback, DNS included;
   - where each value the code reads lives, the manifest naming it and never
     holding a secret value: `env` for what anyone may read, a public URL or
     a framework's public key (`VITE_`, `NEXT_PUBLIC_`); `"secrets":
     ["API_KEY"]` for a value the services read at runtime, kept on the
     server in the project's store; `"secrets": { "files": ["gcp.json"] }`
     for a file read whole, which the code opens at
     `$CREDENTIALS_DIRECTORY/files_gcp.json`; `"secrets": { "build":
     ["CMS_TOKEN"] }` for a value only the build needs, taken from the
     environment of whoever deploys;
   - a folder of dependencies (`node_modules`, `.venv`) under `exclude`: the
     machine installs its own, and one present and not excluded is refused;
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
3. **Dry run.** `bash ~/deploy.sh --dry-run`, or `sitesolide deploy
   --dry-run --json`. The machine judges the manifest as the deployment would
   and plans it, writing nothing: whether the project is new, the ports it
   would choose, the manifest it would keep, and a refusal comes back now,
   with every reason. It does not run the project's build. Show the user what
   it plans.
4. **Deploy**, once the user agrees: `bash ~/deploy.sh`, or `sitesolide
   deploy --json` (`--yes` for a folder still without a manifest, which
   writes the inferred one). The build runs here, in a clean environment
   without the token, then the archive goes up and the machine's log is
   followed to the end.
5. **Read the result.** On success, give the user the address
   (`-> deployed: https://...` in deploy.sh's log, `url` in the CLI's
   result), then check it with `--status`. A port the machine chose is
   printed: write it into `sitesolide.json` (the CLI writes it itself,
   `manifestWritten` true) and commit the manifest. The log names the
   runtime secrets the server has no value for (`missingSecrets` in the
   CLI's result): the deploy went through without them. For a key the
   project checks itself, a session secret or an internal token, offer
   `sitesolide secrets generate NAME --json`, which draws it on the server
   where nobody sees it; for a provider's key, ask the user to set it in the
   dashboard's *Secrets* section or with `sitesolide secrets set NAME` in
   their own terminal. Then restart: `sitesolide restart --json`, the
   dashboard, or a new deployment.
6. **Give access to the people who need it.** A restricted site opens to the
   owner and its guests alone. Over the owner's SSH, read
   `sitesolide share --json` first, ask the user who should get in, then give
   password access to exactly those addresses and nobody else
   (`sitesolide share alice@example.com --json`, `--expires 24h|7d|30d|never`,
   7d by default). A guest opens the site and nothing more. Access lets real
   people into the app and its data: tell the user who will get in, and wait
   for their yes. The password comes back once, in the result's `changes`,
   for the user to send; never store or repeat it. `--remove <email>` takes
   access away. With a token, `share` is refused `needs-ssh`: a token never
   gives anyone access; the owner gives it from the dashboard.

## When it fails

deploy.sh ends on one line that says what to do, the API's error code in
parentheses; every error of the CLI carries a `hint`. Follow it. The usual
ones:

- **`unauthenticated`, "SITESOLIDE_TOKEN is not set", "sitesolide deploy
  needs a token".** No token here, or one revoked: the user sets
  `SITESOLIDE_API` and `SITESOLIDE_TOKEN`, or, with the CLI, runs
  `sitesolide login`; the owner mints theirs with `sitesolide login --owner`.
  Never look for a token elsewhere.
- **`missing settings`.** Nothing is configured on this workstation. A new
  server is `sitesolide machine create --provider <cloud>`, then `sitesolide
  setup` with the `next` command it printed, run only when the user asks, with
  their own credentials from the environment or their cloud's CLI (`sitesolide
  machine providers` says which are there); a person may instead run
  `sitesolide setup` alone, which asks its questions; a server already
  installed is `sitesolide init`; someone with a token runs `sitesolide
  login`. Never guess a server or a zone.
- **A secret is missing on the server.** The deploy did not stop: its
  result's `missingSecrets` names it, and the service may fail its restart
  without it. Generate a random key the project checks itself with
  `sitesolide secrets generate NAME --json`; for any other, tell the user to
  set it in the dashboard's *Secrets* section or with
  `sitesolide secrets set NAME` in their own terminal, which asks for the
  value without echoing it; then restart. Never put a secret value in the repository, in `sitesolide.json`,
  or in `env`: the validation refuses names and values that look like
  secrets, and a secret in git is a secret to change.
- **A build secret is missing** (`build-secret-missing`). Nothing was sent:
  a name under `secrets.build` is neither in the environment nor in the
  workstation's `~/.config/sitesolide/secrets/<slug>.env`. Tell the user to
  export it or add it there; never read that file, never ask for the value.
- **The service fails at the restart, or the site answers 500 or 502.** Read
  `sitesolide logs --json --lines 100`: each entry has its unit, priority and
  message. Priority 3 and below are errors. Fix the code, deploy
  again.
- **A service fell right after its restart.** The deploy watches every
  server and worker for ten seconds and names each one that stopped or was
  restarted: read the logs, fix the code, deploy again.
- **A schedule systemd does not read.** The deploy stopped before writing
  anything: fix the expression in `schedule`, check it with the user, deploy
  again.
- **A block or unit "no longer matches the manifest"** (`edited-by-hand`).
  Someone edited it on the machine. Tell the user; only the owner decides
  whether `--force` replaces it, and only their own token carries it.
- **The name is held by another token.** The owner alone takes it back,
  with `sitesolide deploy --adopt`, on their decision.
- **A port is taken.** Delete `port` from `sitesolide.json`; deploy picks a free
  one and writes it back.
- **The name already exists on the server.** Another project uses it: pick
  another with `--slug`, never deploy over it.
- **Access refused.** `needs-ssh`: `share` with a token; the owner gives the
  access, from the dashboard or their workstation. `not-found`: the project
  is not deployed, or nobody of that name has access to take away.
  `steward-outdated`: the machine needs `sitesolide upgrade`, the owner's to
  run. A warning that the portal
  cannot read who may open a site goes to the user.

## Never

- Never touch the server by hand: no `ssh`, no `sudo`, no `systemctl`, no
  editing files there, and never `caddy stop` or `caddy start`, which stop every
  site at once. Everything goes through deploy.sh, the CLI or the dashboard.
- Never retry a refusal with `--force` or a workaround on your own.
- Never remove a project, lock or unlock a preview, switch a domain, destroy a
  machine, upgrade it (`sitesolide upgrade`; `--dry-run` only reads), rewrite
  every app's units (`sitesolide refresh`; `--dry-run` only reads) or replace
  DNS records with `setup --dns-replace` unless the user asked for exactly
  that: those are their commands, not yours.
- Never retry `setup` in a loop on a refused connection: most likely fail2ban
  banned this workstation, for 10 minutes.
- Never give access to anyone the user did not name, and never make a site Public: general access is theirs, from the
  dashboard.
- Never run `sitesolide passkey link` or `sitesolide passkey remove`, and
  never unlock the dashboard: the link signs in as the owner, so the user
  runs it in their own terminal and opens it in their own browser.
- Never read, print or guess a secret, nor ask the user to paste one. A
  random key is drawn on the server, `sitesolide secrets generate NAME`, and
  nobody sees it; `sitesolide secrets set NAME --stdin` is for the user to
  run, or for a value you generate yourself and pipe (`openssl rand -hex 32
  | sitesolide secrets set SESSION_SECRET --stdin --json`); never for a
  value from the conversation, and never with the value as an argument. A name that looks
  like a value is refused `looks-like-value`, never quoted: tell the user it
  may be in the shell's history and to change it at its source. Never
  replace a live secret (`--replace`): that is the user's.

## Status and other reads

`bash ~/deploy.sh --status` says the project's address, its general access
and the state of each service; `bash ~/deploy.sh --logs --lines 100` its
journal, 500 lines at most. Both only read, and need nothing but the token.

With the CLI, `sitesolide status --json` lists every project on the machine with its
service state and memory; a scheduled service shows its schedule, its last
run and how it ended, and its next run, and is `inactive` between two runs,
which is not an outage. Its runs are in the logs, beside the other services.
`sitesolide share --json` says a project's general access and its guests,
with the expiry of their password access. `sitesolide lock --status --json` says
whether a preview is closed behind an access code, without revealing the
code.

`sitesolide secrets --json` lists the project's secret names,
each set or missing, its files and its build's names, never a value, and
whether a restart is pending: over the owner's SSH, or with a token minted
with *Manage secrets*, which also sets, generates and removes any name of the
project's store (`secrets set NAME --stdin`, `secrets generate NAME`,
`secrets remove NAME...`, `--restart` to apply them); a token without it is
refused. Only the owner reads a value back, in the dashboard. `unconfirmed`
means a change was sent and no answer came: check with `sitesolide secrets
--json`, then run the same command once more, never in a loop. `sitesolide
restart --json`, for any token that deploys the project, restarts the
service and ends in an `error` unless it holds: read the logs then.

The full reference: `docs/agents.md` in the sitesolide repository, and
`docs/manifest.md` for every key of `sitesolide.json`.
