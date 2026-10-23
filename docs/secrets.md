# Secrets

API keys, tokens, passwords, a service account's key file: what must never
enter git.

**The platform sorts every value by who may read it back.** A value anyone may
read goes in the manifest, in git. A value nobody should read once it is set
goes in the project's store, on the server, where the services receive it at
start and no route hands it back but to the owner. A value the build needs
stays with whoever deploys. `sitesolide.json` names the secrets; it never
holds one.

## Four homes, by who may read the value back

| Who may read the value back | Where it lives | Declared in `sitesolide.json` as | Received by |
|---|---|---|---|
| everyone: it is in git | the manifest's `env` | the value itself | the build and every service |
| nobody once it is set, but the owner, in the unlocked dashboard | the project's store, `/etc/sitesolide/projects/<slug>/env` on the server | a name under `secrets`, or `secrets.runtime` | every service and backup command of the project, when it starts |
| the same, as a file read whole | `/etc/sitesolide/projects/<slug>/files/<name>` | a name under `secrets.files` | every service and backup command, at `$CREDENTIALS_DIRECTORY/files_<name>` |
| whoever deploys | their environment, else `~/.config/sitesolide/secrets/<slug>.env` on their workstation | a name under `secrets.build` | the build alone |

A project that only needs variables lists their names:

```json
{
  "slug": "shop",
  "start": "/usr/local/bin/bun run server.ts",
  "env": { "NODE_ENV": "production", "VITE_STRIPE_KEY": "pk_live_51Hx", "PUBLIC_URL": "https://{slug}.{zone}" },
  "secrets": ["ADMIN_TOKEN", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]
}
```

One that also needs a file, or a value at build time, uses the long form:

```json
"secrets": {
  "runtime": ["POSTGRES_PASSWORD", "HCLOUD_TOKEN"],
  "files": ["gcp.json", "tls.key"],
  "build": ["CMS_TOKEN"]
}
```

What `validate` accepts and refuses under `secrets` and `env` is in
[manifest.md](manifest.md#secrets). `env` is for what anyone may read: a
framework's public variables (`NEXT_PUBLIC_`, `VITE_` and the like), an
address, a region. A name that announces a secret, `STRIPE_KEY`, and a value
that starts like a provider's key, `sk_live_...`, are refused there.

## Setting the values

**Nothing is set from the repository.** The values reach the server from
three places, and none of them shows one back, but the owner's unlocked
dashboard, for thirty seconds:

- **The dashboard**, in the project's *Secrets* section: *Set* opens a dialog
  where the value is typed, never pre-filled; *Generate* draws one on the
  server; *Upload* sends a file; *Remove* takes a name or a file out. The
  names the deployed manifest declares and the store lacks are flagged at the
  top, each with *Set* and *Generate*.
- **The CLI**, from the project's folder: over SSH as the owner, or with a
  token minted with *Manage secrets* ([access.md](access.md#secrets-with-a-token)):

  ```text
  sitesolide secrets                                   this folder's project's secrets: names, sources, states, never a value
  sitesolide secrets set <NAME> [--restart]            its value typed at a prompt that does not echo it
  sitesolide secrets set <NAME> --stdin                its value from standard input, one trailing line break dropped
  sitesolide secrets generate <NAME> [--restart]       a random value drawn on the server, never shown
     --format hex|base64url --bytes <16-64> --replace
  sitesolide secrets remove <NAME>... [--restart]      take variables out of the store
  sitesolide secrets set-file <NAME> [--restart] < path   a file read whole, 64 KiB at most
  sitesolide secrets remove-file <NAME> [--restart]
  ```

  A value never goes on the command line, where the shell's history and the
  process list would keep it: `set` asks for it at a prompt that does not echo
  it, or reads a pipe with `--stdin`. See
  [commands.md](commands.md#secrets).
- **`sitesolide deploy`**, at a terminal: it reads which declared names the
  store lacks and asks, for each, whether to set it now, generate it on the
  server, or leave it unset.

The listing says where each name comes from and what is missing:

```text
-> secrets of shop, over SSH, as the owner
   ADMIN_TOKEN             set
   STRIPE_SECRET_KEY       set, overrides shop-stripe.env
   STRIPE_WEBHOOK_SECRET   missing: sitesolide secrets set STRIPE_WEBHOOK_SECRET
   files, read at $CREDENTIALS_DIRECTORY/files_<name>: gcp.json set (2318 bytes), tls.key missing (sitesolide secrets set-file tls.key < tls.key)
   legacy: shop-stripe.env, read by the service, covered by the store: sitesolide secrets migrate --retire
   build, kept by whoever deploys: CMS_TOKEN
   public, from sitesolide.json's env: NODE_ENV, VITE_STRIPE_KEY, PUBLIC_URL
   restart pending: sitesolide secrets ... --restart, or the dashboard's Restart service
   a value is never shown here
```

A name a legacy file alone supplies reads `from shop-stripe.env` rather than
`set`, and a file's size is said to the owner alone, over SSH as in the
dashboard.

**A service reads its values when it starts**, and a running process never
sees a change: a restart, an automatic restart after a crash, or the next
deployment applies it. The dashboard and the listing say *restart pending*
until then; `--restart`, or *Restart service* in the dashboard, restarts and
says whether the service holds.

## Deploy never waits on a runtime secret

A missing runtime name does not stop a deployment. At a terminal, `deploy`
asks before it builds and before it takes the machine's Caddy lock, so that
nobody waits on a person thinking:

```text
STRIPE_WEBHOOK_SECRET is not set on the server. [s]et it now (typed, not shown), [g]enerate a random value on the server, or [l]eave it unset?
```

Without a terminal, or with `--json`, it warns once, `runtime secrets not set
on the server: A, B`, with the commands that set them, and the final result
lists them under `missingSecrets`. A missing file is never prompted for: one
line gives the `set-file` command. With a token, a project it may create is
asked about before its first deployment, as any other; one whose store the
machine does not let it hold ahead is asked about once the deployment made
it, then one restart is offered. A token without *Manage secrets* is asked
nothing, and the machine's log names what is missing.

An app that cannot live without a value stops at start, and the deployment
fails on its stability check, naming the unit; `sitesolide logs` says why.

What still stops a deployment, and why:

| Stops | When | Why |
|---|---|---|
| a build secret missing | before anything is read on the machine or sent | the remedy is on your workstation, and nothing is half done |
| a workstation secrets file that does not parse | the same | a guess would build with a wrong value |
| a legacy file that is the machine's, another project's, or owned by another account | before anything is pushed | root reads whatever a unit names |
| the store's folder is a link, not a folder, or not root's | before the units and the code | systemd would read through it |
| the store's folders cannot be laid | the same | without `files/`, every start of the project fails |
| the build, `install` or the stability check fails | as always | |

**243/CREDENTIALS.** systemd fails every start of a project whose
`files/` folder is missing, or whose files exceed what it loads for a unit,
and logs it as "Failed to set up credentials: Protocol error", which sends
one looking elsewhere. `deploy`, `refresh`, a token's deployment, a backup
command's run and the monitor word it instead: `<unit> could not load its secret files
(243/CREDENTIALS): the store's files folder is missing, or its files are too
large; sitesolide refresh <slug> lays the folder again`.

## Generate

A key the project checks itself, a session secret, an internal token, a
database password before its first use, needs no person to know it.
`sitesolide secrets generate NAME`, *Generate* in the dashboard, or `g` at
the deploy prompt draws one on the server: 32 random bytes by default, 16 to
64 with `--bytes`, written in hex, or in base64url without padding with
`--format base64url`. **The value is never returned, journaled or logged**;
the owner may reveal it later in the dashboard.

A name already set, in the store or by a legacy file the service reads, is
refused without `--replace`: `NAME is already set; --replace draws a new value
in the store, which overrides it`. The old value stops working at the next
restart. A provider's key, Stripe's or AWS's, is never generated: it is set
with `sitesolide secrets set NAME`.

## Files read whole

A file declared under `secrets.files`, `gcp.json`, reaches every service of
the project as `$CREDENTIALS_DIRECTORY/files_gcp.json`: a private copy owned
by the project's account, `site-<slug>`, mode `0400`. The `files_` prefix is
systemd's own and cannot be removed: write it where the code reads the file.

```js
const key = await Bun.file(`${process.env.CREDENTIALS_DIRECTORY}/files_gcp.json`).json()
```

**There is no placeholder.** systemd sets `CREDENTIALS_DIRECTORY` in every
service and backup command of a project that has a store, and the platform
writes no path of its own: `{credentials}` in an `env` value, a `start` or a
backup `command` is refused, since nothing would replace it, and `%d` cannot
be written, every `%` reaching the program as it is.

- **In code**, read the variable `CREDENTIALS_DIRECTORY`.
- **In `start` or a backup `command`**, write `${CREDENTIALS_DIRECTORY}/files_tls.key`:
  systemd expands `$NAME` from the service's environment on its command line.
- **A program configured only through a variable holding a path**,
  `GOOGLE_APPLICATION_CREDENTIALS` for instance, gets it from a start script:

  ```sh
  #!/bin/sh
  export GOOGLE_APPLICATION_CREDENTIALS="$CREDENTIALS_DIRECTORY/files_gcp.json"
  exec /srv/sites/engine/app/.venv/bin/uvicorn main:app --port "$PORT"
  ```

A file is any bytes, 64 KiB at most, 32 files and 512 KiB in all per
project. Its name is a letter or a digit, then letters, digits, `.`, `_` and
`-`, 64 characters at most, never a leading dot nor a `/`: systemd skips a dot
file without a word, and would flatten `sub/x` into `files_sub_x`. The server
also checks systemd's own budget for a unit's credentials, past which every
start would fail. A file the manifest does not declare may be set ahead,
before the first deployment or before the manifest names it: every unit loads
the whole folder, and the listing marks it *not declared*. A declared file not
set yet leaves the service starting without it, and is listed *missing*; an
empty file is listed *missing* too.

## Who reads and who writes

| Who | A project's store |
|---|---|
| The owner, in the dashboard, unlocked with its password | everything: lists the names, **reads a value back** (*Reveal*, thirty seconds on screen), sets, generates, removes, uploads and removes files, restores the previous version, merges and retires legacy files |
| The owner over SSH, `sitesolide secrets` | lists the names, sets, generates, removes, sets and removes files, merges and retires legacy files, for a project not deployed yet too; never a value back |
| An Admin of the project | lists the names; sets, generates, removes, uploads, removes files and restores the previous version after unlocking; never a value back |
| A Developer of the project | lists the names; sets, generates, removes, uploads and removes files after unlocking; never a value back, no restore |
| A token with *Manage secrets* | lists the names; sets, generates and removes any name of its project's store, and its files, with no unlock: ticking the box was that decision; for a project it may create, before its first deployment too, which makes the name its own. Never a value back, whoever holds it |
| A token without it | nothing: `deploy` says it may not list secrets, and the machine's log names any that is missing |
| A Viewer, or someone who can only open the site | nothing: the Secrets section is not theirs |

**Only the owner reads a value back**, and only in the unlocked dashboard.
Admin no longer does, in a store or in a legacy file: a Developer's or an
Admin's dashboard shows every value write-only. Nothing of the token API, the
CLI, the MCP tools or the build returns one. Even what tells a value apart is
the owner's, in the dashboard and over SSH: whether a legacy file is covered
by the store, and a file's size.

The steward decides every one of these, as root, on its own access registry,
and a compromised dashboard, which relays the requests, cannot make one pass.
A Developer or an Admin unlocks by signing in again with the identity
provider, for ten minutes: see
[access.md](access.md#people-with-access-beside-tokens) and
[dashboard/README.md](../dashboard/README.md#access). The platform's own
projects, the dashboard, the portal, the shared service and analytics, are
the owner's alone.

**The services of a project trust each other.** They run under one account
and receive the same store, so one can read another's environment and files;
there is no store per service. Between projects, nothing is shared or
readable.

## The store on the server

| Path | Owner, mode | Holds |
|---|---|---|
| `/etc/sitesolide/projects/<slug>/` | root, `0700` | the project's store |
| `/etc/sitesolide/projects/<slug>/env` | root, `0600` | the runtime variables, one `NAME=value` per line |
| `/etc/sitesolide/projects/<slug>/files/<name>` | root, `0600` | each file read whole |
| `/var/lib/sitesolide-steward/precedents/projects/<slug>/` | root, `0600` files | the previous version of `env` and of each file |

**No account but root reads the store.** systemd reads it as root before the
service takes its identity: `env` through `EnvironmentFile=`, the files
through `LoadCredential=`, which hands the service its private copies. Every
unit of an app hides `/etc/sitesolide` from the service
(`InaccessiblePaths=`), and hides the processes of other accounts
(`ProtectProc=invisible`). The unit's text depends on the manifest alone:
setting or removing a value never rewrites a unit.

**Bounds**: a value 8 KiB, the `env` file 256 KiB, a file 64 KiB, 32 files
and 512 KiB of files. A value is one line, valid Unicode, with no null byte
and no Unicode noncharacter (U+FDD0 to U+FDEF, the last two code points of a
plane): systemd reads a file holding one as invalid and starts the service
with none of its variables. A refused value never lands.

**Made before the units.** Every deployment of an app, over SSH or by token,
and `sitesolide refresh`, lay the store's folders before they write a unit:
`files/` must exist, empty or not, or every start fails with 243. The steward
never deletes `files/` nor the project's folder, only files inside them; a
folder deleted by hand is laid again by the next deploy or
`sitesolide refresh <slug>`. The first write also makes the store, which is
how the owner fills one with `sitesolide secrets` before the project's first
deployment, and a token with *Manage secrets* one for a project it may
create. Static sites and the storeless projects, the dashboard and
the portal, have none.

**One previous version** of `env` and of each file is kept before every
write. *Restore previous version*, for the owner and an Admin, swaps the
variables' previous version back, after listing the names that would appear
and disappear; a file's previous version is kept for the owner to put back
by hand. A store made fresh, for a slug removed and created again, starts
with none.

**`sitesolide remove`** deletes the project's store and its previous
versions, after its units are stopped.

**The backups keep a copy**, so that a lost machine does not take its
secrets along: every hour, `/etc/sitesolide` and the steward's state go into
the server's restic repository with the machine's own state, then to the
bucket if one is configured, encrypted by restic before it leaves. No page
lists or restores that copy; its files are put back by hand
(dashboard/src/backup/README.md, "The machine's own state"). Whoever reads
`dashboard-backup.env`, the owner from the *Secrets* page, holds the
passphrase and the bucket's keys, and so every file of that copy.

**Every change is journaled**, in the project's *Activity*: who set, removed
or generated which name, which file was set or removed, never a value nor its
length.

## Build secrets

A value the build needs, a private CMS's token or a package registry's, is
named under `secrets.build` and taken from whoever deploys, never from the
server:

1. their environment, `CMS_TOKEN=... sitesolide deploy` or an exported
   variable;
2. else `~/.config/sitesolide/secrets/<slug>.env` on their workstation, read
   strictly, and only for the names declared.

An empty value counts as set. `deploy` says where each came from, `build
secret CMS_TOKEN from your environment`, never the value. **A missing one
stops the deployment before anything is read on the machine or sent**, over
SSH as with a token: `build secrets missing: CMS_TOKEN`, then export it, or
add it to the workstation file. A file that does not parse stops it the same
way, with its line number and reason, never the line. A dry run whose build
does not run only warns.

**The build gets a clean environment**, in this order, the later winning:

1. from your environment, only these: `PATH`, `HOME`, `USER`, `LOGNAME`,
   `SHELL`, `TERM`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR`, `LANG`,
   `LANGUAGE`, `TZ`, `TMPDIR`, `CI`, the toolchains'
   locations (`BUN_INSTALL`, `NVM_DIR`, `NVM_BIN`, `VOLTA_HOME`, `PNPM_HOME`,
   `COREPACK_HOME`, `GOPATH`, `GOROOT`, `GOCACHE`, `GOMODCACHE`, `CARGO_HOME`,
   `RUSTUP_HOME`, `JAVA_HOME`, `ANDROID_HOME`, `PYENV_ROOT`, `UV_CACHE_DIR`,
   `DENO_DIR`, `HOMEBREW_PREFIX`, `HOMEBREW_CELLAR`, `HOMEBREW_REPOSITORY`,
   `SDKROOT`, `DEVELOPER_DIR`), and every `LC_*` and `XDG_*`;
2. the manifest's project-level `env`, its placeholders replaced;
3. the build secrets;
4. what the CLI sets for its own tools.

Never a `SITESOLIDE_*` variable of yours, a token exported as
`SITESOLIDE_TOKEN` first among them. `NODE_ENV` is not inherited: the
manifest sets it, and a workstation's `development` must not reach a
production build. Nor is `SSH_AUTH_SOCK`: the SSH agent it names holds the
keys that log into your server, with sudo, and the build is the folder's own
code. A build that needs another variable of yours, a proxy, or the agent to
fetch a private dependency, names it under `secrets.build`: that is what
"taken from whoever deploys" means.
`deploy.sh`, the script that deploys without the CLI, takes build secrets
from the environment alone, and never puts a value on a command line.

A static site may have build secrets, and `env` once it has a `build`: no
service reads anything at runtime there, so `secrets.runtime` and
`secrets.files` are refused.

## What your workstation keeps

`~/.config/sitesolide/secrets/` holds what **your workstation itself** needs,
and only that: the token `sitesolide login` keeps, `team-token`; the API
token a command-line tool sends to one of your services; and
`<slug>.env`, the project's build secrets and the variables of
`sitesolide run`.

`sitesolide run -- <command>`, from a project's folder, reads
`~/.config/sitesolide/secrets/<slug>.env` and runs the command with every
variable it holds in its environment, never through a shell:

```bash
cd my-tool && sitesolide run -- bun scripts/sync.ts
```

The file is read strictly, the format the store's `env` uses: one
`NAME=value` per line, no space around `=`, the value bare or entirely in
single or double quotes, `#` comments on lines of their own. A line it cannot
read stops the run with its number and reason, never its content. For a
manifest in the legacy form, `run` loads the files it declares from that
folder, as before.

It is not a copy of production. A value only the machine uses stays on the
machine, and one the workstation keeps has two copies to hold equal: change it
on the server, then in that file.

The folder is outside every repository, beside the configuration file, so no
`git add` can ever publish it. Claude Code is denied reading and writing there,
see `.claude/settings.json`.

## Legacy files, and moving to the store

Before the store, a manifest declared flat files of `/etc/sitesolide`:

```json
"secrets": ["shop.env", "shop-stripe.env"]
```

**That form is still read**, every entry holding a dot, and `deploy` warns:
`secrets: shop.env, shop-stripe.env are file names, the old form: they keep
loading before the project's store; run sitesolide secrets migrate, then list
the variable names`. Each unit reads the legacy files first, in the
manifest's order, then the store last, so **the store wins on a shared
name**. Two rules keep what the dashboard shows as the value in force the one
the next start gets:

- a name may not leave the store while a legacy file of the project, read by
  a unit, declared, or kept as a leftover, holds it, since that file's value
  would come back, nor while such a file cannot be read to tell; a restore,
  or a removal in a batch, that would take it out is refused the same way:
  `NAME is also in shop-stripe.env, which the service reads before the
  store: removing it here would bring that file's value back. Retire the file
  first (sitesolide secrets migrate --retire), or remove NAME from it`. The
  owner alone, who reads every value anyway, may still take out a name every
  such file holds with the store's very value, which changes nothing in
  force: that is how a merge is undone before its files are retired. For
  anyone else the answer never depends on a value;
- a name the store holds may not be set in a legacy file, where it would have
  no effect: `NAME is set in the project's store, which overrides
  shop-stripe.env: change it there`.

A legacy file is owned by `site-<slug>`, mode `0600`, and its name is the
project's: `<slug>.env`, `<slug>-<name>`, or `<slug>-secrets/<name>`. `deploy`
and `refresh` refuse, before anything is pushed or written, a declared file
that is one of the machine's own, one a more specific site deployed there
holds, `acme-crm.env` for `acme` when `acme-crm` is there, or one present that
is not a plain file of `site-<slug>`: root reads whatever a unit names. A
missing legacy file no longer stops a deployment: it is a warning, and the
service starts without its variables. A site no manifest describes, the
landing or a service made by hand, keeps its files by name, as before.

**Moving a project to the store**, its values never seen by anyone:

1. `sitesolide deploy`, the manifest unchanged, or `sitesolide refresh
   <slug>`: the units read the legacy files, then the empty store.
2. `sitesolide secrets migrate --dry-run`, then `sitesolide secrets migrate`,
   or *Merge into the store* in the dashboard: every legacy variable is copied
   into the store, with its value. Two legacy files holding a name with
   different values refuse the whole merge, naming the name and the files;
   remove the duplicate from one of them in the dashboard, then merge again.
3. `sitesolide secrets migrate --restart`, or a deployment: the service
   starts on the store's values, identical.
4. `sitesolide secrets migrate --retire`, or *Retire* in the dashboard: each
   legacy file the store covers, every variable in it present in the store
   with the same value, after a restart that loaded the store, is kept as its
   previous version and deleted.
5. In the repository, `secrets` becomes the names, `sitesolide secrets
   --json` listing them; commit, deploy.

Merging and retiring are the owner's alone. Steps 4 and 5 may come in either
order. Never `sitesolide refresh --all` for any of them. The detail, and how
to go back, is in [migration.md](migration.md#secrets-the-per-project-store).

## The platform's own files

`dashboard.env` and `portal.env` stay flat files for good: they hold the
hash of a password, read by their own unit, and the dashboard and the portal
have no store. `dashboard-monitor.env` and `dashboard-backup.env`, the
machine's, stay where they are. The dashboard manages them from the
dashboard's and the portal's own *Secrets*, the owner alone:

| Rule | Files | Why |
|---|---|---|
| **write-only**: replaced, never read back, size not shown | legacy files read whole and closed to other accounts | a private key never comes back to the screen, and its size would already give away its algorithm |
| **Change password only**: never read, never set by hand, never restored, the old one erased | any `PASSWORD_HASH`, in any file | a hash is cracked offline, and restoring would revalidate the password you changed because it had leaked |
| **hash only**: no other variable | `dashboard.env`, `portal.env` | one more variable there would change what the service does: a socket path would send the next password typed to another socket |

`PASSWORD_HASH` is never a store's name either: it is changed with *Change
password*, in the dashboard's and the portal's files alone.

**What belongs to no project is not the dashboard's**: `cloudflare.env`, the
token Caddy reads for its certificates, lives in `/etc/caddy` and is changed on
the machine. Nor is the key people sign in to the dashboard with: the steward
draws it and lays its private half in `/etc/sitesolide-portal/`, where only
the portal's account reads it and the Secrets section never shows it, see
[dashboard/README.md](../dashboard/README.md#the-key-pair).

No secret is shared, and that is the rule: the shared service `api/` sends no
mail and makes no call. Each project has its own store, read under its own
account.

## The dashboard's own password

`dashboard.env` belongs to root, `0600`, not to `site-dashboard`. The
dashboard's service still receives it, since `EnvironmentFile=` is read by
PID 1 as root before the service takes its identity. In exchange, a
compromised dashboard cannot rewrite the hash that unlocks the secrets.

`dashboard-backup.env`, the bucket's settings and keys, is root's `0600` too,
handed by PID 1 to the backup run, which reads there the bucket, the
retention, the disk reserve and nothing that moves a program or a folder:
whoever holds the dashboard's unlock writes it, and is not root on the
machine. See
[dashboard/src/backup/README.md](../dashboard/src/backup/README.md#setting-it-up).

`dashboard-monitor.env`, the monitor's alerting addresses, is root's `0600` as
well, and listed under the dashboard's site. PID 1 hands it to the monitor; the
dashboard's service never reads it, so a compromised dashboard cannot learn the
heartbeat's address without an unlocked session and ping it to hide that the
machine is down. Create it empty once, then fill it from the dashboard: see
[monitor/README.md](../monitor/README.md#alerting-healthchecksio-in-five-minutes).

It is the one secret the dashboard cannot create for itself, being what opens
it. On a machine that has none yet:

```bash
bin/dashboard-password.sh
```

It draws a password, shows it once on your terminal, and puts its hash on the
machine straight from memory: nothing is written on the way. Store the password
before closing the terminal. Once the dashboard runs, **its password changes
from the dashboard**, through *Change password* in the dashboard site's own
*Secrets*. If it is lost, `bin/dashboard-password.sh --replace`.

## The tokens that create the machine

The Hetzner token `sitesolide machine` uses and the Cloudflare token
`sitesolide setup` uses are not the machine's secrets but yours, and sitesolide
keeps neither on your workstation: each is read from an environment variable or
from standard input for the length of one command, never from an option, which
the shell's history and `ps` would show. Keep them in your password manager.

The Cloudflare token also lives on the machine, in `/etc/caddy/cloudflare.env`,
root:caddy 0640, where Caddy reads it for the wildcard certificate: setup lays
it there. Restrict it to the one zone, `Zone / Zone / Read` and `Zone / DNS /
Edit`, so that the machine holds no more than it needs. See
[machine.md](machine.md) and [setup.md](setup.md).

Up to 0.2 both lived in `~/.config/sitesolide/terraform/terraform.tfvars`;
[upgrading.md](upgrading.md) says what to do with that folder.
