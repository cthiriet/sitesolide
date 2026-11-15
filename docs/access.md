# Access and tokens

Each project has a general access, Public, Restricted or Anyone with the
code, and a list of guests, each with a password for that one site. The
owner does everything; a token deploys, never gives anyone access.

Every deployment goes through the dashboard's API with a token, the owner's
included: none goes over SSH. The owner keeps root SSH for installing and
upgrading the machine and for its machine-wide commands; nobody else needs
it, and nobody else should have it. Two things reach the machine beside the
owner, and neither is root:

- **guests**: someone, by their email, opens a restricted site with a
  password the machine drew for them, and nothing more: no dashboard, no
  token;
- **tokens**: a key, revocable, minted by the owner, with which `sitesolide
  deploy` sends a project to the dashboard over HTTPS. The machine installs
  it the way it installs the owner's, and the holder never holds root. The
  same works for an agent in a sandbox or a CI with no SSH key: a token in
  its environment is all it needs. A token minted with *Manage secrets* also
  sets, generates and removes its projects' secrets, never reading one back.

In the dashboard, a site's *Access* section holds who may open that site,
and the *Tokens* page the tokens.

## Who may open a site

| General access | Who opens the site |
|---|---|
| Public | anyone |
| Restricted | the owner and the site's guests, through the portal's sign-in page |
| Anyone with the code (the preview code) | anyone with the code, and the owner |

**The owner** is whoever holds the dashboard's passkeys, or its password
until the first one ([below](#the-owners-passkeys)), the first account, made
by `setup`. The owner opens every site, signs in to the dashboard, and alone
chooses a site's general access: from its *Access* section, *Make public*,
*Restrict* or *Use a code*, or with `sitesolide lock` and `unlock` over SSH
([commands.md](commands.md)). A code is drawn on the machine, ten characters
without O, I, 0 or 1; *New code* stops the old one at once. A site that
serves its own domain opens the same way on every address, the preview and
the domain together, and takes no code.

**A guest** has password access, "Can open": the machine draws a password
for them, for that one site, shown once to the owner, who sends it on, with
an expiry chosen then, 24 hours, 7 days (the default), 30 days or none
([portal/README.md](../portal/README.md#password-access)). The owner gives
it from the site's *Access* section, under the unlock, or with `sitesolide
share <email>` from the project's folder over SSH
([commands.md](commands.md#access-to-a-project)); removing it, from either,
needs no unlock and holds from the guest's next request. The site learns
`X-Sitesolide-Role: visitor` for a guest and `admin` for the owner, and no
identity: the email was typed by the owner, never verified. A guest matters
only while the site is Restricted: a Public site keeps its list for when it
is restricted again.

**Reading a secret back is the owner's alone**, in the dashboard, unlocked:
no token, no agent and no command over SSH gets a value from the server once
it is set.

**Unlocking** is the owner proving themselves again: with a fresh passkey,
or the dashboard's password while none is registered, for ten minutes. It
guards what writes a secret, makes a site public, opens it with a code or
gives it a new one, restores data, mints a token, or gives password access.
Restricting a site, removing a guest and restarting a service never wait
for it. A token minted with *Manage secrets* sets secrets without one:
minting it took the unlock, and that permission is the opt-in, see [Secrets
with a token](#secrets-with-a-token).

### The owner's passkeys

The owner signs in to the dashboard with a passkey, and unlocks with a
fresh one; the same passkey signs them in to a restricted site, as the
owner, from its sign-in page. Once one exists, the dashboard's password
neither signs in nor unlocks. The first one comes from root: `sitesolide
passkey link`, over the owner's SSH, prints a link valid fifteen minutes,
once, which registers a passkey and signs in. Register a second one from the
*Server* page, on another device or a security key. Losing them all, root
mints a new link the same way; `sitesolide passkey remove <id>` removes
any, the last one included, which gives the password back. See
[commands.md](commands.md#passkeys) and
[dashboard/README.md](../dashboard/README.md#passkeys).

## Tokens

Only the owner mints a token, on the dashboard's *Tokens* page under the
unlock, or the owner's own with `sitesolide login --owner`. It is shown once,
and reaches either every project, as the owner (below), or the projects the
owner picks, with the options ticked then: creating projects, which are then
the token's own, deploying public sites, declaring a domain, outbound
network, *Manage secrets*. A token never gives anyone access, and never opens
a site. Revoking one needs no unlock. Everything a token does is audited
under `token:<id>`: its sheet on the *Tokens* page lists its last ten lines,
and *All activity* opens the rest in *Activity*.

## The owner's own token

The owner deploys with a token too: their own, for every project
(`scope.all`). It reaches every project the server carries but the
platform's own, the dashboard and the portal, and those another token holds;
creates any project, opens a site to the public, declares a domain and
`"network": "outbound"`, sets secrets, keeps a `lock` key, is bounded by no
token cap, and deploys under a name a removed project left. It alone carries
two options: `--force`, which replaces a unit or a block edited by hand on the
machine, and `--adopt`, which takes a name back from the token that holds it
(`DELETE /api/v1/projects/<slug>/claim`), its store moved aside as previous
versions.

It is minted in one of two ways, both the owner's alone:

```bash
sitesolide login --owner        # over the owner's SSH access, into the vault, never shown
```

which asks the steward's owner socket, `POST /tokens/owner`, root's alone:
root over SSH is the proof the dashboard's unlock stands for. The secret
travels on the SSH session into `~/.config/sitesolide/secrets/team-token`,
0600, the dashboard's address beside it, never on a screen, in an event or
an argument. A vault already holding a token the dashboard accepts for every
project keeps it, unless `--replace`. Or on the dashboard's *Tokens* page,
under the unlock: *New token*, *Every project, as you*, then `sitesolide
login --url https://dashboard.<zone>` with it. `sitesolide setup` ends by
naming the first.

It is the strongest credential after root SSH: whoever holds it deploys code
to every project. Keep it on the owner's workstation; give an agent or a CI a
token of the projects it works on instead, and revoke it from the *Tokens*
page when a laptop is lost.
## What you get from the owner

- the dashboard's address, `https://dashboard.<zone>`;
- a token, `sst_...`, shown to the owner once when they created it on the
  dashboard's *Tokens* page. Keep it like a password: whoever holds it deploys
  what it allows.

A token deploys only what the owner allowed when creating it: the existing
projects they granted, and, if they allowed it, new projects, which are then
the token's. It sets secrets only if they ticked *Manage secrets*. Everything
is **private by default**: a project a token creates is Restricted, unless
the token may deploy public sites.

## Sign in

You need the CLI, one executable that needs neither Bun nor a clone:

```bash
curl -fsSL https://github.com/cthiriet/sitesolide/releases/latest/download/install.sh | sh
sitesolide login --url https://dashboard.<zone>
```

`login` asks for the token, at a prompt that does not echo it, checks it
against the dashboard, and says who it belongs to and what it may do. It
keeps the token in `~/.config/sitesolide/secrets/team-token` (0600), the
address it checked it against beside it, `team-token-api`, and the address in
`~/.config/sitesolide/config.json` under `api`. `--token-stdin` reads the token
from standard input instead of a prompt.

**The token in the vault goes to that address alone.** `config.json` is no
secret, and the environment chooses which one is read: a `SITESOLIDE_API` or
a `config.json` naming another dashboard would otherwise have sent the token
there. Either is refused, `unauthenticated`, saying to run `sitesolide login
--url` for the new address. A vault filled before `login` wrote the address
sends its token to the `api` of the `config.json` beside it, as it did; one
kept elsewhere, by `vault` or `SITESOLIDE_VAULT`, needs `sitesolide login`
once more. A `team-token` or a `team-token-api` that is a link, or that has a
second name, is not read. The dashboard's certificate is checked whatever the
environment says, `NODE_TLS_REJECT_UNAUTHORIZED=0` included. What the CLI
cannot refuse is an environment that adds an authority of its own,
`NODE_EXTRA_CA_CERTS`, beside a proxy, `HTTPS_PROXY`, that answers with a
certificate it signed: an agent's sandbox is set up by whoever trusts it.

`deploy` always goes through the dashboard, whatever the configuration
holds. A workstation with no `server` in its configuration uses the dashboard
for `status`, `logs`, `secrets` and `restart` too. Every other
command (`share`, `lock`, `unlock`, `domain`, `remove`, `rename`, `disable`,
`enable`, `run`, `passkey`, `refresh`, `backups`) needs the owner's SSH
access and says so.

### In an agent's sandbox

No files to keep: set two variables, which win over the files.

```bash
export SITESOLIDE_API=https://dashboard.<zone>
export SITESOLIDE_TOKEN=sst_...
sitesolide deploy
```

Both, together: a `SITESOLIDE_API` alone does not take the vault's token
elsewhere.

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

1. **The manifest goes first, to be planned.** The dashboard judges it, with
   the same validation as the CLI's and your token's scope, then the steward
   plans it as the installer would, `POST /api/v1/deployments/plan`, writing
   nothing: every reason it refuses comes back before anything is built or
   sent. What the machine keeps of the project, general access set from the
   dashboard and the former names a rename left, is written back into
   `sitesolide.json`. Before even that, the CLI finds the value of every name
   under `secrets.build` (below): one missing stops the deployment with
   nothing sent.
2. **The build runs on your workstation**, as for the owner: the machine
   receives its result, not your toolchain. It gets a clean environment: a
   short list of your variables a toolchain needs (`PATH`, `HOME`, the
   locale and the like), the manifest's `env`, and the names under
   `secrets.build`, read from your environment, else from
   `~/.config/sitesolide/secrets/<slug>.env`, and printed by name, never by
   value.
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
lowest free one, and keeps it on later deployments. The CLI writes it into
`sitesolide.json`, after `start`, once the deployment succeeded: commit it.
`deploy.sh` prints it for you to write.

**A dry run is the machine's plan.** `sitesolide deploy --dry-run` sends the
manifest alone, to `POST /api/v1/deployments/plan`, and shows what the
installer would lay: the systemd units and the Caddy block generated from
the manifest the machine would keep, its ports chosen and its door, and what
the store lacks; it builds nothing unless `--build`, writes nothing, and is
refused exactly where the deployment would be.

### What a token's project may not do

| In the manifest | Refused unless | Why |
|---|---|---|
| `portalExempt` | the token may deploy public sites | exempted paths are public |
| a static site (no `start`) | the token may deploy public sites | a static site cannot be restricted yet |
| `"network": "outbound"` | the token may use outbound network | services reach only the loopback otherwise |
| `egress` | the token may use outbound network | the hosts it lists are reached through the egress proxy, a way out all the same |
| `domain` | the token may declare a domain | switching to it stays the owner's job: the machine's `active` stands whatever the manifest says, and a name or an alias it did not cover before stays inactive; on a domain switched on, a new name or alias is refused, since it would switch the whole domain off |
| `lock` | the owner's token for every project | a preview code is chosen by the owner in the site's *Access* section, or with `sitesolide lock` over the owner's SSH |
| `memory` above 1G, more than 6 services | the owner's token for every project | one machine serves everyone |

A manifest without `portal` is not refused: a new project a token creates
without the public permission is Restricted whatever the manifest says. A
project that already exists keeps the general access the machine carries:
it is switched from the dashboard, never from a deployment. A token without
the public permission does not deploy an existing public site either, so that
a stolen one publishes nothing.

Every string of the manifest that lands in the project's Caddy block or systemd
unit is judged for that, the same way for the owner and for a token: header
values without `"`, `\`, `{`, `}`, `$` or a backtick, routes that are plain
paths, a `start` that begins with the program itself, environment values with
no space or quote, secret names that are variable names, or plain file
names. See
[docs/manifest.md](manifest.md).

**Secrets** live on the machine and nowhere else, and a missing one never
stops a deployment. Before sending anything, `deploy` reads which of the
names `sitesolide.json` declares the project's store lacks; at a terminal,
with a token that may manage secrets, it offers to set each now, typed
without echo, or to generate it on the server, and otherwise warns. The
machine's log says the same, and the deployment's `missingSecrets` lists
them. The owner sets them in the dashboard's *Secrets* section, or a token that may manage secrets with
`sitesolide secrets set`, see [Secrets with a token](#secrets-with-a-token);
the service reads them at its next restart. What still stops: a build
secret missing on your workstation, before anything is sent, and a store the
machine cannot lay before the units (`store-refused`, `store-failed`).

**`install` runs on the machine** as the project's account, with the network
but not the loopback, none of the machine's ports to listen on, a throwaway
`HOME`, and fifteen minutes at most. The
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
line, and one final `result` or `error` carrying a `hint`. An option a
command does not take with a token is refused, and nothing is sent.

## Secrets with a token

A project's secrets live on the server, in its store, and nowhere else: a
value is typed once, goes to the machine, and never comes back out of it.
`sitesolide.json` lists their names, never a value; see
[secrets.md](secrets.md) for where each kind of value lives. A token minted
with *Manage secrets* lists those names, sets, generates and removes any
variable of its project's store, and sets and removes the files its services
read whole. **It never reads a value back**: no route returns one, nor a
file's content or size, nor a previous version, whoever holds the token, the
owner's included. Only the owner reads a value back, in
the dashboard, unlocked. From the project's folder:

```bash
sitesolide secrets                                  # names, their state, what is missing; never a value
sitesolide secrets set API_KEY                      # the value typed at a prompt that does not echo it
sitesolide secrets set API_KEY --stdin < key.txt
sitesolide secrets generate SESSION_SECRET          # a random value drawn on the server, never shown
sitesolide secrets remove OLD_KEY OLD_URL --restart
sitesolide secrets set-file gcp.json < gcp.json     # a file read whole, from a pipe or a redirect
sitesolide secrets remove-file gcp.json
sitesolide restart                                  # restart, then say whether the service holds
```

```console
$ sitesolide secrets
-> secrets of shop, through https://dashboard.example.com
   ADMIN_TOKEN             set
   STRIPE_SECRET_KEY       set
   STRIPE_WEBHOOK_SECRET   missing: sitesolide secrets set STRIPE_WEBHOOK_SECRET
   files, read at $CREDENTIALS_DIRECTORY/files_<name>: gcp.json set
   build, kept by whoever deploys: CMS_TOKEN
   restart pending: sitesolide secrets ... --restart, or the dashboard's Restart service
   a value is never shown here
```

**The manifest names, the server holds.** A name under `secrets` in
`sitesolide.json` is a variable every service of the project receives at
start, `missing` until the store holds a value for it. A name the manifest
does not list yet may be set all the same, ahead of the commit that declares
it. A name under `secrets.files` is a file every service reads at
`$CREDENTIALS_DIRECTORY/files_<name>`, the `files_` prefix being systemd's.
A name under `secrets.build` is read by the build alone, on the workstation
that deploys, from its environment or `~/.config/sitesolide/secrets/<slug>.env`:
the machine never holds it, and `secrets` only lists it.

**A missing value never stops a deploy.** `sitesolide deploy` reads the
store before it sends anything, and at a terminal asks, for each declared
name the store lacks, whether to set it now, typed without echo, to generate
it on the server, or to leave it unset. Under `--json`, or without a
terminal, it warns instead, and its `result` carries `missingSecrets`. A
service that cannot start without the variable fails its restart, and the
deploy names it. A token without *Manage secrets* is not asked: the
machine's log of the deployment names what is missing. A missing build
secret is the one that stops, before anything is sent, since the build needs
it on the workstation.

**The value never goes on the command line**, where the shell's history and
every user's process list would keep it. `secrets set NAME` asks for it at a
prompt that does not echo it, or, with `--stdin`, reads all of standard input,
one trailing line break dropped; `--stdin` is refused while standard input is
a terminal, where the value would show as it is typed (`stdin-is-terminal`):
pipe it, or drop `--stdin` to be prompted. At the prompt, Backspace, Ctrl-U
and Ctrl-W edit the value; an escape sequence, an arrow key among them, any
other control key, or a paste of several lines is refused, what remains of
the paste drained, and nothing is sent. `NAME=value`, or anything after the
name, is refused before a request leaves, and so is a name that looks like a
value, over 64 characters or starting like a service's key (`sk_`, `ghp_`,
`AKIA` and their kind, `looks-like-value`); neither refusal quotes it, and a
value typed there may be in the shell's history, to be changed at its
source. The value is checked before it leaves by the steward's own rules,
one line, no null byte, valid Unicode with no noncharacter, 8 KiB at most,
so that a refused one was never sent; an empty one is refused too: an unset
variable piped by mistake would empty the secret in service. Under `--json`
nothing prompts, and `set` needs `--stdin`. A change sent whose answer never
came, the connection cut, is `unconfirmed`: it may be written; `sitesolide
secrets --json` lists the names, and the same command run once more writes it
again, harmlessly.

**Generate draws the value on the server**, 32 random bytes written in hex by
default, `--format base64url` and `--bytes` from 16 to 64 otherwise, and
returns its name alone: nobody sees it, the holder of the token included. It
is for a key the project checks itself, a session secret, an internal token,
a database password before its first use; never for a provider's key, which
the provider issues and someone sets. A name already set in the store is
refused `already-present` unless `--replace`, which draws a new one: the old value stops working at the next
restart.

**A file** is read whole from standard input, never from a terminal, and
sent as base64: 64 KiB a file, 32 files and 512 KiB per project; its name is
letters, digits, `.`, `_` and `-`, starting with a letter or a digit, 64
characters at most. The machine keeps it root's alone, and systemd hands
each service a private copy, readable by the service's account alone, at
`$CREDENTIALS_DIRECTORY/files_<name>`. A file the manifest does not declare
yet may be set too; every service loads every file of the project's store.

| A token with *Manage secrets* may | It may not |
|---|---|
| list its projects' secret names, which the store holds and which not yet, what is missing, the files, the build's names, and whether a restart is pending | read a value, a file's content or size, or a previous version |
| set, generate, replace and remove any variable of its project's store, declared in `sitesolide.json` or not | change `PASSWORD_HASH`, which the owner alone changes |
| set and remove the store's files | set a variable the deployment or the unit already sets, `PORT` among them, or one that changes how the runtime behaves, `LD_PRELOAD` or `HTTPS_PROXY`: refused to anyone, from the dashboard too |
| write the store of a project it may create, before its first deployment, and restart the service, with `--restart` or `sitesolide restart` | restore the store's previous version: the owner's, from the dashboard |

- **One change, one write, all or nothing.** Every name and value is judged
  before anything is written; the store keeps the previous version of its
  variables and of each file, which the owner restores from
  *Secrets*. A value on one line, with no null byte, valid Unicode, 8 KiB at
  most, and no Unicode noncharacter, U+FDD0 to U+FDEF or the last two code
  points of a plane, for which systemd would read none of the project's
  variables; all of them together 256 KiB at most. A change that would pass
  that, or the files' bounds, is refused whole, which tells whoever holds
  the token, roughly, how much the store already holds: the one thing it
  learns of what it cannot read.
- **A set never says whether the value changed**: it is always written and
  journaled. A name to remove that the store does not hold comes back in
  `absent`, nothing done for it.
- **Ahead of the first deployment.** A token that may create a project may
  set its secrets before deploying it, so that the first start finds them.
  The first write records the project as the token's, as a deployment
  that creates it does. A name
  the token may not create, or one whose store or snapshots the machine
  still keeps from a removed project, is refused as a deployment would be.
- **Listing needs *Manage secrets* too**: a token without it is refused, and
  the refusal is journaled, as "Tried to list the secrets", never as a value
  read.
- **Restarting** takes no permission of its own: any token that deploys the
  project restarts it.
  It is refused `busy` while a deployment of the project runs, which restarts
  it at its end, asked again once the restart's turn has come, and
  `not-found` for a static site. A token restarts one service at a time: a
  second restart while its first runs is `busy`. Restarts of one project wait
  for each other, never for anyone's change of secrets. The service is
  watched for eight seconds: `active`, `looping` or `failure`, and
  `sitesolide restart` exits non-zero unless it holds. A value reaches the
  service at its next start, never while it runs.
- **Bounds, per token and per hour**: 120 for changes, each variable name set
  or removed costing one, a generated value one, a file one, a request one at
  least, `{}` included, and a store it created one more; 30 restarts; and 60
  refused requests, counted before the refusal is journaled. Past any of them,
  `too-many-attempts` and the seconds to wait, and a refusal past its bound
  is journaled no more. One token writes 210 lines of the steward's journal
  an hour at most, and the journal keeps its latest 500 lines at least: a
  stolen token cannot push what it did in the last hour out of it by itself.
- **No unlock.** The owner's change in the dashboard asks for the unlock; a
  token's does not. Minting it took the unlock, and *Manage secrets* is what the
  owner opted into: whoever holds the token sets values until it expires or is
  revoked, within the bounds above, every change in sight in the token's sheet
  and in *Activity*.
- **A token without the public permission** changes the secrets of a
  project only when it could deploy that project as the machine carries it,
  no path exempted from the portal, no domain or outbound network it could
  not declare itself, and the project is Restricted, the portal in place in
  front of it; and the store of a project it is creating, which will be
  Restricted: a stolen one changes nothing of a project in the open, nor of
  one it could not deploy. What the guests of a restricted project reach,
  the values it changes still drive. It still lists and restarts.
- **A token revoked while the change waited its turn** writes nothing.

Every change is journaled by the steward, one line per name, never its value,
under `token:<id>`: the project's *Activity* reads "Set API_KEY" by the
token, and the token's sheet on the *Tokens* page lists it beside its
deployments. So is every refusal the steward decides, within the bound above:
a token without *Manage secrets*, a reserved name. The dashboard refuses a malformed body alone before asking it.
The sheet shows the token's last ten lines; *Activity*, narrowed to the
token, reads further back, until the journal drops the line.

**For an agent**: `sitesolide secrets generate NAME` draws a random key on the
server, which nobody sees; `sitesolide secrets set NAME --stdin` is for the
user to run, or for a value the agent generates itself and pipes; never a
value read from the conversation, which the conversation then keeps. See
[agents.md](agents.md#secrets-and-restarts).

### Over HTTPS, without the CLI

The value stays out of every command line, and out of the shell's history:
`IFS= read -rs` takes it without echo, its spaces and backslashes kept as
typed, `printf`, a shell builtin, hands it to `jq` on its standard input, and
`curl` sends the body from its own.

```bash
API=https://dashboard.<zone>
AUTH="Authorization: Bearer $SITESOLIDE_TOKEN"

# the names, their state and what is missing, never a value
curl -s -H "$AUTH" $API/api/v1/projects/<slug>/store

# one variable set, then the service restarted
IFS= read -rs VALUE
printf '%s' "$VALUE" | jq -Rs '{set: {API_KEY: .}, restart: true}' |
  curl -s -H "$AUTH" -X PATCH -H 'Content-Type: application/json' --data-binary @- \
    $API/api/v1/projects/<slug>/store
unset VALUE
# -> 200 { "store": { "slug": "<slug>", "variables": [{ "name": "API_KEY", "source": "store", ... }], "missing": [], ... },
#          "created": false, "set": ["API_KEY"], "generated": [], "removed": [], "absent": [],
#          "files": { "set": [], "removed": [] },
#          "restart": { "verdict": { "kind": "active", "state": "active", "subState": "running", "restarts": 0 } } }

# a random key drawn on the server, never returned
curl -s -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name": "SESSION_SECRET"}' $API/api/v1/projects/<slug>/store/generate

# a file, its bytes in base64
base64 < gcp.json | tr -d '\n' | jq -Rs '{content: .}' |
  curl -s -H "$AUTH" -X PUT -H 'Content-Type: application/json' --data-binary @- \
    $API/api/v1/projects/<slug>/store/files/gcp.json

# names alone carry no secret: they go on the line
curl -s -H "$AUTH" -X PATCH -H 'Content-Type: application/json' \
  -d '{"remove": ["OLD_KEY"]}' $API/api/v1/projects/<slug>/store
curl -s -H "$AUTH" -X DELETE -H 'Content-Type: application/json' \
  -d '{}' $API/api/v1/projects/<slug>/store/files/gcp.json

curl -s -H "$AUTH" -X POST $API/api/v1/projects/<slug>/restart
```

`-H "$AUTH"` puts the token among curl's arguments, as everywhere on this page;
on a machine others share, `-H @file` reads the header from a file instead.
When a change asks for a restart and the restart is refused, `busy` or past
its bound, the write stands with its own status, and `restart` says why. A
change with a restart may take two of the steward's long waits, the write's
then the restart's: the dashboard keeps the connection open for both.

## Giving access to what you deployed

A token never gives anyone access. A project deployed with a token opens to
the owner alone until the owner gives it guests, from its *Access* section or
with `sitesolide share` over SSH, or changes its general access (see [Who
may open a site](#who-may-open-a-site)). Ask the owner. `sitesolide share`
on a workstation with a token is refused `needs-ssh`.

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
| `POST /api/v1/deployments/plan` `{ manifest, force }` | judges the manifest as a deployment would and plans it, writing nothing: `{ plan }`, `slug`, `creating`, `existing`, `portal`, `allocated` (the ports the machine would choose), `manifest` (the text the installer would lay, its ports and the machine's door applied) and `placeholders`; what `sitesolide deploy --dry-run` shows |
| `POST /api/v1/deployments` `{ manifest, force }` | judges the manifest, opens a deployment for 15 minutes; a token holds three waiting for their archive, a fourth replaces the oldest. `force`, true to replace a unit or a block edited by hand, the owner's token for every project alone |
| `DELETE /api/v1/projects/<slug>/claim` | the owner's token for every project alone: takes the name back from the token that holds it, its store moved aside as previous versions; `{ claim }`, `slug`, `released` (the token's id, or null), `dropped` (`variables`, `files`, names only): `sitesolide deploy --adopt` |
| `PUT /api/v1/deployments/<id>/bundle` | the archive, 100 MiB compressed at most; starts the installer |
| `GET /api/v1/deployments/<id>?after=<n>` | state, log lines from `n`, `next`, `error`, `url`, `placeholders` (what `{zone}` and `{contact}` become, for the build), and once the installer is done `missingSecrets`, the declared `runtime` names and `files` the store lacked, null for a static site |
| `GET /api/v1/projects` | the projects the token reaches, with their status |
| `GET /api/v1/projects/<slug>` | one of them |
| `GET /api/v1/projects/<slug>/logs?lines=<n>&cursor=<c>` | the journal, and a cursor for the next call |
| `GET /api/v1/projects/<slug>/store` | needs *Manage secrets*. `{ store }`: `slug`, `exists`, `state` (`managed`, `absent` or `unmanaged`, then with a `reason`), `variables` (each `name`, `source`: `store` or `none`, and `declared`), `missing` (declared names with no value), `files` (each `name`, `state`: `set`, `missing` or `unmanaged`, `declared`, `reason`, `modifiedAt`, `restartPending`; `bytes` null), `build` and `public` (the build's names, and `env` as written), `unitReadsStore`, `modifiedAt`, `restartPending`, `previous` and `may`. Never a value |
| `PATCH /api/v1/projects/<slug>/store` `{ set, remove, restart }` | needs *Manage secrets*. `set`, an object of names and values, `remove`, a list of names, `restart`, true to restart once written: each optional, `{}` alone creates the store. One write, all or nothing: 200, or 201 when it created the store, `{ store, created, set, generated, removed, absent, files, restart }`, `restart` being null, `{ verdict }`, or `{ error, message, wait }` for a restart refused, `wait` there for `too-many-attempts` alone, the write's status kept |
| `POST /api/v1/projects/<slug>/store/generate` `{ name, format, bytes, replace, restart }` | needs *Manage secrets*. A random value drawn on the server for `name`: `format` `hex`, the default, or `base64url`, `bytes` 16 to 64, 32 by default; a name already set is refused `already-present` unless `replace`. The same answer as a change, the name in `generated`, never the value |
| `PUT /api/v1/projects/<slug>/store/files/<name>` `{ content, restart }` | needs *Manage secrets*. A file read whole, `content` its bytes in base64, 64 KiB at most, 32 files and 512 KiB per project; the same answer, the name in `files.set` |
| `DELETE /api/v1/projects/<slug>/store/files/<name>` `{ restart }` | needs *Manage secrets*. Removes that file, never the folder; the same answer, the name in `files.removed` |
| `POST /api/v1/projects/<slug>/restart` | any token that deploys the project. Restarts its service and watches it eight seconds: 200 `{ verdict: { kind, state, subState, restarts } }`, `kind` being `active`, `looping` or `failure`, 200 even when it did not come back |

| Code | Status | What to do |
|---|---|---|
| `unauthenticated` | 401 | the token is missing, unknown, expired or revoked, or a person's token from when people signed in with a company account: ask the owner for a new one |
| `too-many-attempts` | 429 | too many wrong tokens from your address, or the token's hour of secrets, restarts or refusals used up, 120 changes, 30 restarts and 60 refused requests: wait `wait` seconds |
| `out-of-scope` | 403 | the token may not do this: outside its scope; for secrets, a token without *Manage secrets*, `PASSWORD_HASH`, a static site, which has no service to read a store, or, with an owner's token that does not deploy public sites, a project not Restricted on the machine or one it could not deploy as it stands; the message says whom to ask |
| `reserved` | 403 | the slug belongs to the platform, or, for a new project, starts with the name of one of its projects and a dash (`dashboard-*`, `portal-*`), which names the platform's own files, or is the name of a removed project the machine still keeps backup snapshots or a store of secrets of, which a project created under it would be handed: pick another, or ask the owner, who may deploy it over SSH or clear what was left |
| `invalid-manifest` | 422 | fix every point of `details` |
| `invalid` | 400 | the request itself is malformed; for secrets, an unexpected field, a name that is not a variable's or one the machine keeps for itself, a value over one line, with a null byte, not valid Unicode, with a Unicode noncharacter or over 8 KiB, a name both set and removed, variables that would pass 256 KiB, a file name that is not letters, digits, `.`, `_` and `-`, or a file past its bounds; the message names a variable only when it has a variable name's shape, and never quotes a value |
| `not-found` | 404 | no such deployment or project for this token, or a static site, which has no service to restart |
| `busy` | 409 | a deployment of this project is already running, or, when the archive arrives, three deployments already run on the machine: send it again in a minute, the deployment waits for it until its 15 minutes are up; for secrets and restarts, a deployment of the project running, which restarts it at its end, the token's previous restart still under way, or the machine busy with other changes: ask again in a moment |
| `unmanaged` | 409 | the store or one of its files is there in a form the steward does not rewrite: a link, the wrong owner or mode, lines written by hand; nothing was changed, the owner fixes it on the machine |
| `already-present` | 409 | generating a name already set in the store: `replace` draws a new one, and the old value stops working at the next restart |
| `too-large` | 413 | exclude dependencies and caches; a change of secrets over 512 KiB: split it |
| `expired` | 410 | the archive arrived after 15 minutes: start again |
| `not-available` | 503 | the machine does not carry the control API yet, or predates secrets by token or the store of secrets: tell the owner, who runs `sitesolide upgrade` |
| `failure` | 500, 502 | something broke on the machine, an access registry that does not read among others, or, creating a project, the backups' index that does not read, which never passes for nothing left under the name: the message says where the owner should look |

`locked` never comes back from this API: it is the dashboard's answer to a
change of the owner's that needs the unlock.

A failed deployment carries its own `error.code`, the step that stopped it:
`install-failed`, `edited-by-hand`, `system-unit`, `caddy-busy`,
`bundle-refused`, `service-failed`, `verify-failed` and a few more, each with a
message that says what to do. A secret missing is never one of them: the
log names it, and `missingSecrets` lists it. `store-refused` stops it
when the project's store on the machine is not a folder root owns, a link
for instance: the owner looks at it, nothing was changed. `store-failed`
stops it when the store's folders cannot be laid at all: without its
`files/` folder every start of the project would fail, so nothing is served,
and the owner runs `sitesolide upgrade`, then looks at the machine. A service that
exits 243 failed to load its secret files, the store's `files/` folder
missing or its files too large for systemd: `service-failed` says so, and
`sitesolide refresh <slug>`, the owner's, lays the folder again. A schedule systemd on the machine does not read
comes back as `invalid-manifest`, before anything is written; a server or a
worker that falls within ten seconds of its restart, as `service-failed`.

### Without the CLI, in one script

[deploy.sh](../deploy.sh), at the root of this repository and on every
release, makes these calls for a workstation or a sandbox that holds the
token and nothing of sitesolide: it needs bash, curl, tar, gzip, find, mktemp
and one JSON reader among jq, node, bun and python3, the first found.
Download it outside the project, or its archive carries it:

```bash
curl -fsSL https://github.com/cthiriet/sitesolide/releases/latest/download/deploy.sh -o ~/deploy.sh
export SITESOLIDE_API=https://dashboard.<zone>
read -rs SITESOLIDE_TOKEN && export SITESOLIDE_TOKEN   # typed, kept out of the history
bash ~/deploy.sh --dry-run                   # the machine's plan, nothing built, sent nor changed
bash ~/deploy.sh                             # from the project's folder, or name it
bash ~/deploy.sh --force                     # over a unit or a block edited by hand, the owner's token alone
bash ~/deploy.sh --archive bundle.tar.gz     # build and write the archive, send nothing
```

`--dry-run` posts the manifest to the plan route and prints what the machine
would lay, the manifest it would keep with its ports and door, then stops.
The ports a deployment chose are printed, for you to write into
`sitesolide.json`; the CLI writes them itself.

It is `sitesolide deploy` with a token, step for step: the same refusals
before anything leaves (a folder of dependencies present and not excluded, a
`source` or a `publicDir` leading out of the repository, a link among what
would be sent, an empty `publicDir`), the manifest first, the build on the
workstation, the archive with the CLI's exclusions, then the machine's log
to the end. It exits 0 only once the machine says `succeeded`. curl reads the
token's header from a file descriptor, never from its arguments, and the
build runs in a clean environment, as the CLI's does: of yours, only the
variables every build inherits and the build secrets the manifest names under
`secrets.build`, then the manifest's own `env`, never `SITESOLIDE_TOKEN` nor
any other `SITESOLIDE_` variable. A build secret comes from the environment
alone, exported before the run, never from the workstation's file: one the
environment lacks stops the run before anything is sent, and its value never
goes on a command line. The build runs as you all the same, with what you may
read: deploy, and run `--archive`, which builds too, only a project whose
build you would run yourself. `bin/tests/deploy-script.test.ts` holds
its archive to the CLI's on the same folder, read back by the installer's own
reader, with each of the four JSON readers.

## When it goes wrong

- **`not-available`**: the owner has not installed the control API on this
  machine yet, see [dashboard/README.md](../dashboard/README.md), "The control
  API".
- **`needs-ssh` on `share`**: a token gives no access. Ask the owner.
- **Too many changes, or the access log full** (the owner's): the steward
  keeps every change of access 180 days and never pushes one out early, and
  counts the changes that let someone in, 120 an hour from the dashboard,
  2000 over SSH. Past that it refuses them: wait, then try again. Once the
  access log is full it refuses them until older changes age out, while
  removing a guest still works, and so does `sitesolide share` over SSH.
- **`out-of-scope` on `secrets`**: the token was minted without *Manage
  secrets*, or the project is a static site, whose values a build needs go
  under `secrets.build` and stay with whoever deploys. Mint a token with the
  permission, or ask the owner; never try another token.
- **`unmanaged` on `secrets set`**: the store, or one of its files, is not
  in a form the steward rewrites, a link or a file written by hand. Nothing
  was changed: tell the owner of the machine.
- **A deploy that warns of missing secrets**: the deployment went through,
  and the service starts without them. Set each with `sitesolide secrets set
  NAME`, or `sitesolide secrets generate NAME` for a random key, then
  `sitesolide restart`.
- **A warning that the portal cannot read who may open a site**: only the
  owner opens a restricted site until it can. Guests are kept; the owner
  reads `journalctl -u portal`.
- **`edited-by-hand`**: a file of your project on the machine, its unit or its
  Caddy block, was changed by hand. The owner reads it and deploys once with
  their own token for every project and `--force`; yours works again
  afterwards.
- **`caddy-busy`**: the owner or the dashboard is changing Caddy. Nothing served
  changed: deploy again in a moment.
- **A project you created and can no longer deploy**: your token was revoked.
  Your projects stay on the machine; the owner grants them to your new token.
  Once the owner removes one with `sitesolide remove`, its name is free
  again: any token that may create projects may create one of that name,
  once the machine keeps none of its backup snapshots. Until then the name
  is `reserved` to every token: a project created under it would list its
  predecessor's snapshots and restore them. The owner deploys it with their
  own token for every project, or clears what was left.
