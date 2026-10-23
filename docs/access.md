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
  needs. A token minted with *Manage secrets* also sets the variables of its
  projects, never reading one back.

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
| Does | by role, see below: from opening a site to looking after all of the project | deploys, reads logs, restarts the service, gives Can open on what it deploys; with *Manage secrets*, lists variable names and sets and removes variables, never reading one back |
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
| Admin | everything of the project: reads its secrets, chooses its general access, Public, Restricted or Anyone with the code, and a new code, gives people access to it, a role at most their own, and restores its backups |

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
dashboard and the portal among them, their settings, the tokens of others, the
connectors, and the roles people hold on projects they are not Admin of.

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
project that token creates, once its first deployment has ended, provided
nobody has been given access to the project meanwhile; otherwise, and for a
creation not settled within a day, the owner gives its roles by hand.

**Giving someone access** is the project's Admin's, or the owner's: from the
site's *Access* section, or `sitesolide share <email> --role <role>` in the
project's folder ([commands.md](commands.md#access-to-a-project)). An Admin
gives at most their own role, on their project alone. A whole domain, whoever
gives it, the owner included, is one of the company's domains when the owner
listed them (`OIDC_ALLOWED_DOMAINS`); while that list is empty, any domain is
given unlocked from the dashboard or by the owner over SSH, never with a
token. No email is sent: the command prints the line to send, and a
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
marked; the owner and its Admins choose among the three there, *Make public*,
*Restrict* or *Use a code*. A site that opens with a code shows it to them,
with its link to copy, and *New code*, which stops the old one at once; a
Viewer or a Developer reads that the site opens with one, and whom to ask.
The code is drawn on the machine, six characters without O, I, 0 or 1, and
`sitesolide lock` from the project's folder reaches the same path. A site that
serves its own domain opens the same way on every address, the preview and
the domain together, and the section names both before anything changes. Then its
people with access: an *Add people* field taking an email or a
`@domain` and a role, which says before anything is sent whether the person
signs in with their company account or gets password access, and every entry
with its role, password access with its expiry. One line under the list names
who also opens the site without being on it: the owner, and the admin emails
set on the server. *What each role can do* opens under the field, the
reader's own marked. A Viewer or a Developer reads all of it without a
control, and whom to ask to add someone.

**Unlocking, for a person, is signing in again.** Whatever reads or writes a
secret, makes a site public, opens it with a code or gives it a new one,
restores data, mints a token, gives someone a role above Can open, or gives
password access asks for the person's own unlock: *Unlock changes* sends them to the identity provider, which asks them
to prove themselves once more even if they are signed in there, and brings
them back unlocked for ten minutes, for their session alone. The owner
unlocks with the dashboard's password; neither unlock replaces the other, nor
another person's. Restricting a site, giving Can open to a company account or
to one of the company's listed domains, removing someone, lowering them and
restarting a service never wait for an unlock. A whole domain does while the
company's domains are not listed on the server, `OIDC_ALLOWED_DOMAINS` empty:
anyone the provider vouches for would then come in. A token minted with
*Manage secrets* sets variables without one: minting it took the unlock, and
that permission is the opt-in, see [Secrets with a token](#secrets-with-a-token).

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
| managing secrets, `sitesolide secrets` | Developer or Admin there |
| restarting the service, `sitesolide restart` | Developer or Admin there, as for deploying it |

A Viewer everywhere, without the create right, mints nothing, and sees no
*Tokens* page.

- **Minted under their own unlock**, the forced sign-in at the provider that
  every secret write asks for: *Unlock to create*, then *New token*. The
  dialog offers the projects where they are Developer or Admin, creating
  projects only with the right, *Manage secrets*, and the options only for
  projects they administer. The token carries their email, whatever is sent, and is shown
  once, as the owner's are. Its row on *Tokens* names each project with
  their role there today, "calendar (Admin)", or "cms (paused: Viewer now)"
  where it no longer deploys, and *Can manage secrets* when it may, "Can
  manage secrets (paused: no project to deploy now)" once it reaches none.
- **Narrowed live.** The server reads the access registry at every use of the
  token, not only when it was minted: a role lowered to Viewer or Can open
  stops that project's deployments at the next request, the create right taken
  back stops new projects, and the options hold only while the person is Admin
  of every project the token reaches; one lowered turns them off for the whole
  token, and the person mints another for what they still administer.
  *Manage secrets* holds project by project, wherever they are Developer or
  Admin at that request. The installer reads the registry once more when it
  starts.
- **An existing project keeps its general access.** A deployed site's general
  access, Public, Restricted or Anyone with the code, is chosen by its Admin or
  the owner, never by a deployment: a Developer's token deploys a public project as it stands, and
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
person in their detail, and so do the secrets their token set or removed and
the restarts it made, which the steward journals under `token:<id>` with the
person beside it. The *Tokens* page's *Token activity* lists both.

## What you get from the owner

- the dashboard's address, `https://dashboard.<zone>`;
- a token, `sst_...`, shown to the owner once when they created it on the
  dashboard's *Tokens* page. Keep it like a password: whoever holds it deploys
  what it allows. Someone who signs in to the dashboard mints their own
  instead, see [Your own tokens](#your-own-tokens).

A token the owner creates deploys only what they allowed when creating it: the
existing projects they granted, and, if they allowed it, new projects, which
are then yours. It sets secrets only if they ticked *Manage secrets*. Everything is **private by default**: a project you create
is Restricted, unless your token may deploy public sites.

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

A workstation with no `server` in its configuration uses the dashboard for
`deploy`, `status`, `logs`, `share`, `secrets` and `restart`. Every other
command (`lock`, `unlock`, `domain`, `remove`, `run`, `people`, `refresh`,
`backups`) needs the owner's SSH access and says so.

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
| `portalExempt` | the token may deploy public sites | exempted paths are public |
| a static site (no `start`) | the token may deploy public sites | a static site cannot be restricted yet |
| `"network": "outbound"` | the token may use outbound network | services reach only the loopback otherwise |
| `egress` | the token may use outbound network | the hosts it lists are reached through the egress proxy, a way out all the same |
| `domain` | the token may declare a domain | switching to it stays the owner's job: the machine's `active` stands whatever the manifest says, and a name or an alias it did not cover before stays inactive |
| `secrets` other than `<slug>.env` | never | the unit hands the file to the service as root |
| `lock` | never | a preview code is chosen in the site's *Access* section, by its Admin or the owner, or with `sitesolide lock` over the owner's SSH |
| `memory` above 1G, more than 6 services | never | one machine serves everyone |

A manifest without `portal` is not refused: a new project a token creates
without the public permission is Restricted whatever the manifest says. A
project that already exists keeps the general access the machine carries:
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
`<slug>.env` deploys only once the file exists: the owner, or the project's
Developer or Admin, creates it in the dashboard's *Secrets* section, or a token
that may manage secrets with `sitesolide secrets set`, see [Secrets with a
token](#secrets-with-a-token). Until then the deployment says so and stops
before the restart.

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
line, and one final `result` or `error` carrying a `hint`. `deploy --dry-run`
is refused, and nothing is sent: a dry run reads the machine over the owner's
SSH access, which a token does not carry. Review `sitesolide.json` instead; the
machine judges it before anything is built or uploaded. Every other option a
command does not take with a token is refused the same way.

## Secrets with a token

A token minted with *Manage secrets* lists the secret files of the projects it
reaches, with their variable names, and sets and removes the variables of
`<slug>.env`. **It never reads a value back**: no route returns one, nor a
file's size, nor its previous version, whoever holds the token, an Admin's
own or the owner's included. From the project's folder:

```bash
sitesolide secrets                         # its files and variable names
sitesolide secrets set API_KEY             # the value typed at a prompt that does not echo it
sitesolide secrets set API_KEY --stdin < key.txt
sitesolide secrets remove OLD_KEY LEGACY_URL --restart
sitesolide restart                         # restart, then say whether the service holds
```

```console
$ sitesolide secrets
-> secrets of notes, through https://dashboard.example.com
   service: active, running
   notes.env: API_KEY, SMTP_URL
      restart pending: changed since the service started, sitesolide restart applies it
   notes-signing.key: a file read whole, set from the dashboard's Secrets section
   a value is never read back: sitesolide secrets set NAME writes one
```

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
so that a refused one was never sent; an empty one is refused too: an unset variable piped by
mistake would empty the secret in service. Under `--json` nothing prompts,
and `set` needs `--stdin`. A change sent whose answer never came, the
connection cut, is `unconfirmed`: it may be written; `sitesolide secrets
--json` lists the names, and the same command run once more writes it again,
harmlessly.

| A token with *Manage secrets* may | It may not |
|---|---|
| list its projects' secret files, their variable names, and whether a restart is pending | read a value, a file's size or its previous version |
| set, replace and remove the variables of `<slug>.env`, when the deployed `sitesolide.json` declares it | touch any other file: another `.env`, a file read whole, a file of the platform's projects; those are the dashboard's *Secrets* section |
| create `<slug>.env` when the deployed manifest declares it and it is missing | create or change a `<slug>.env` the deployed manifest does not declare |
| restart the service, with `--restart` or `sitesolide restart` | change a password hash, `PASSWORD_HASH`, which the owner alone changes |
| | set a variable the deployment or the unit already sets, `PORT` among them, or one that changes how the runtime behaves, `LD_PRELOAD` or `HTTPS_PROXY`: refused to anyone, from the dashboard too |

- **One change, one write, all or nothing.** Every name and value is judged
  before anything is written; the file keeps its previous version, which the
  owner or an Admin restores from *Secrets*. Fifty names a change at most; a
  value on one line, with no null byte, valid Unicode, 8 KiB at most, and no
  Unicode noncharacter, U+FDD0 to U+FDEF or the last two code points of a
  plane, for which systemd would read none of the file's variables; the file
  256 KiB at most. A `<slug>.env` a token creates starts with no previous
  version, whatever an earlier file of that name left. A change that would grow the file past that is refused
  whole, which tells whoever holds the token, roughly, how large the file
  already is: the one thing it learns of what it cannot read.
- **A set never says whether the value changed**: it is always written and
  journaled. A name to remove that the file does not carry comes back in
  `absent`, nothing done for it.
- **Listing needs *Manage secrets* too**: a token without it is refused, and
  the refusal is journaled, as "Tried to list the secrets", never as a value
  read.
- **Restarting** takes no permission of its own: any token that deploys the
  project restarts it, a person's own while they are Developer or Admin there.
  It is refused `busy` while a deployment of the project runs, which restarts
  it at its end, asked again once the restart's turn has come, and
  `not-found` for a static site. A token restarts one service at a time: a
  second restart while its first runs is `busy`. Restarts of one project wait
  for each other, never for anyone's change of secrets. The service is
  watched for eight seconds: `active`, `looping` or `failure`, and
  `sitesolide restart` exits non-zero unless it holds.
- **Bounds, per token and per hour**: 120 for changes, each variable name set
  or removed costing one, a request one at least, `{}` included, and a file it
  created one more; 30 restarts; and 60 refused requests, counted before the
  refusal is journaled, a refused change of access among them (see
  [Giving access](#giving-access-to-what-you-deployed)). Past any of them, `too-many-attempts` and the seconds
  to wait, and a refusal past its bound is journaled no more. One token writes
  210 lines of the steward's journal an hour at most, and the journal keeps
  its latest 500 lines at least: a stolen token cannot push what it did in
  the last hour out of it by itself.
- **No unlock.** A person's change in the dashboard asks for their unlock; a
  token's does not. Minting it took the unlock, and *Manage secrets* is what its
  maker opted into: whoever holds the token sets values until it expires or is
  revoked, within the bounds above, every change in sight on *Token activity*.
- **An owner's token without the public permission** changes the secrets of a
  project only when it could deploy that project as the machine carries it,
  no path exempted from the portal, no domain or outbound network it could
  not declare itself, and the project is Restricted, the portal in place in
  front of it: a stolen one changes nothing of a project in the open, nor of
  one it could not deploy. What the people given access to a restricted
  project reach, the values it changes still drive. It still lists and
  restarts. A person's own token follows their role instead, as for a
  deployment.
- **A person's own token** needs them Developer or Admin of the project at each
  request: lowered to Viewer, it is refused, the message naming their role. A
  token revoked, or its person lowered, while the change waited its turn
  writes nothing.

Every change is journaled by the steward, one line per variable, its name and
never its value, under `token:<id>` and, for a person's own token, their
email: the project's *Activity* reads "Set API_KEY" by "alice@example.com
(token)", and the *Tokens* page's *Token activity* lists it beside the token's
deployments. So is every refusal the steward decides, within the bound above:
a person lowered, a token without *Manage secrets*, a file other than
`<slug>.env`. The dashboard refuses a malformed body alone before asking it.
*Token activity* reads the journal's latest 250 lines: on a busy machine they
cover a short while, and an older change is on the project's *Activity*
until the journal drops it.

**For an agent**: `sitesolide secrets set NAME --stdin` is for the user to run,
or for a value the agent generates itself and pipes, a random session key; never
a value read from the conversation, which the conversation then keeps. There is
no MCP tool for it.

### Over HTTPS, without the CLI

The value stays out of every command line, and out of the shell's history:
`IFS= read -rs` takes it without echo, its spaces and backslashes kept as
typed, `printf`, a shell builtin, hands it to `jq` on its standard input, and
`curl` sends the body from its own.

```bash
API=https://dashboard.<zone>
AUTH="Authorization: Bearer $SITESOLIDE_TOKEN"

# the files and variable names, never a value
curl -s -H "$AUTH" $API/api/v1/projects/<slug>/secrets

# one variable set, then the service restarted
IFS= read -rs VALUE
printf '%s' "$VALUE" | jq -Rs '{set: {API_KEY: .}, restart: true}' |
  curl -s -H "$AUTH" -X PATCH -H 'Content-Type: application/json' --data-binary @- \
    $API/api/v1/projects/<slug>/secrets/<slug>.env
unset VALUE
# -> 200 { "file": { "name": "<slug>.env", "variables": ["API_KEY", ...], "writable": true, ... },
#          "created": false, "set": ["API_KEY"], "removed": [], "absent": [],
#          "restart": { "verdict": { "kind": "active", "state": "active", "subState": "running", "restarts": 0 } } }

# names alone carry no secret: they go on the line
curl -s -H "$AUTH" -X PATCH -H 'Content-Type: application/json' \
  -d '{"remove": ["OLD_KEY"]}' $API/api/v1/projects/<slug>/secrets/<slug>.env

curl -s -H "$AUTH" -X POST $API/api/v1/projects/<slug>/restart
```

`-H "$AUTH"` puts the token among curl's arguments, as everywhere on this page;
on a machine others share, `-H @file` reads the header from a file instead.
When a change asks for a restart and the restart is refused, `busy` or past
its bound, the write stands with its own status, and `restart` says why. A
change with a restart may take two of the steward's long waits, the write's
then the restart's: the dashboard keeps the connection open for both.

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
| | change a site's general access, Public, Restricted or Anyone with the code: it is the dashboard's, its Admin's or the owner's |

**Bounded per token and per hour.** Each change is counted among the token's
60 refused requests of the hour before it is judged, and given back once
accepted, or when it takes off someone who had no access: a refused change is
a line of the steward's journal, and past 60 the token is refused
`too-many-attempts`, journaled no more, so that a stolen token cannot push
the hour's changes out of the journal. What a token lets in also stops once
the access log is half full, see [When it goes wrong](#when-it-goes-wrong).

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
| `GET /api/v1/projects/<slug>/secrets` | needs *Manage secrets*. `{ secrets }`: `slug`, `service` (`unit`, `state`, `subState`, `startedAt`; null without one), and `files`, each `name`, `kind` (`variables` or `content`), `state` (`managed`, `absent` or `unmanaged`, then with a `reason`), `expected` (its owner and mode), `variables` and `passwords` (names), `modifiedAt`, `restartPending`, and `writable`, true for a declared `<slug>.env` alone; `readable` is false, `bytes` null and `previous` false, whatever the token |
| `PATCH /api/v1/projects/<slug>/secrets/<slug>.env` `{ set, remove, restart }` | needs *Manage secrets*. `set`, an object of names and values, `remove`, a list of names, `restart`, true to restart once written: each optional, `{}` alone creates the file; 50 names at most, none in both, 512 KiB at most. One write, all or nothing: 200, or 201 when it created the file, `{ file, created, set, removed, absent, restart }`, `restart` being null, `{ verdict }`, or `{ error, message, wait }` for a restart refused, `wait` there for `too-many-attempts` alone, the write's status kept |
| `POST /api/v1/projects/<slug>/restart` | any token that deploys the project. Restarts its service and watches it eight seconds: 200 `{ verdict: { kind, state, subState, restarts } }`, `kind` being `active`, `looping` or `failure`, 200 even when it did not come back |

| Code | Status | What to do |
|---|---|---|
| `unauthenticated` | 401 | the token is missing, unknown, expired or revoked, or its person no longer signs in to the dashboard: ask the owner, or mint another if it is your own |
| `too-many-attempts` | 429 | too many wrong tokens from your address: wait `wait` seconds; or, creating a project, your changes of access for this hour used up: try again later; or the token's hour of secrets, restarts or refusals used up, 120 changes, 30 restarts and 60 refused requests, refused changes of access included: wait `wait` seconds |
| `out-of-scope` | 403 | the token may not do this: outside its scope, its person's role no longer allows it, or, for access, a role above Can open, someone who would need password access, a domain outside the company's, an entry above Can open to take off; for secrets, a token without *Manage secrets*, a file other than `<slug>.env`, a `<slug>.env` the deployed manifest does not declare, `PASSWORD_HASH`, or, with an owner's token that does not deploy public sites, a project not Restricted on the machine or one it could not deploy as it stands; the message says whom to ask |
| `reserved` | 403 | the slug belongs to the platform, or, for a new project, starts with the name of one of its projects and a dash (`dashboard-*`, `portal-*`), which names the platform's own files, or is the name of a removed project the machine still keeps backup snapshots or connector grants of, which a project created under it would be handed: pick another, or ask the owner, who may deploy it over SSH or clear what was left |
| `invalid-manifest` | 422 | fix every point of `details` |
| `invalid` | 400 | the request itself is malformed: `who` neither an email nor a `@domain`, a domain given more than Can open, or a domain while signing in with a company account is not set up; for secrets, an unexpected field, a name that is not a variable's or one the machine keeps for itself, a value over one line, with a null byte, not valid Unicode, with a Unicode noncharacter or over 8 KiB, a name both set and removed, over 50 names, or a file that would pass 256 KiB; the message names a variable only when it has a variable name's shape, and never quotes a value |
| `not-found` | 404 | no such deployment or project for this token, a project not deployed yet, or, taking someone off, someone with no access; a static site, which has no service to restart; a `<slug>.env` missing when the change only removes |
| `busy` | 409 | a deployment of this project is already running, or, when the archive arrives, three deployments already run on the machine: send it again in a minute, the deployment waits for it until its 15 minutes are up; for secrets and restarts, a deployment of the project running, which restarts it at its end, the token's previous restart still under way, or the machine busy with other changes: ask again in a moment |
| `unmanaged` | 409 | the secret file is there, in a form the dashboard does not rewrite, written by hand: nothing was changed; the owner fixes it from *Secrets* |
| `too-large` | 413 | exclude dependencies and caches; a change of secrets over 512 KiB: split it |
| `expired` | 410 | the archive arrived after 15 minutes: start again |
| `not-available` | 503 | the machine does not carry the control API yet, or predates the access registry or secrets by token: tell the owner, who runs `sitesolide upgrade`; or, creating a project or giving Can open, the access log is half full, the half a token may fill, or full: ask the owner, or someone who gives access from the dashboard |
| `failure` | 500, 502 | something broke on the machine, an access registry that does not read among others, or, creating a project, the backups' index or the connectors' grants that do not read, which never pass for nothing left under the name: the message says where the owner should look |

`locked` never comes back from this API: it is the dashboard's answer to a
change that needs its unlock, a role above Can open or password access, which
a token never gives.

A failed deployment carries its own `error.code`, the step that stopped it:
`install-failed`, `secret-missing`, `edited-by-hand`, `system-unit`, `caddy-busy`,
`bundle-refused`, `service-failed`, `verify-failed` and a few more, each with a
message that says what to do. `secret-taken` stops it before anything is
written when the project would read a secret file that is not its own: a
file of the machine, one another project holds, or a `<slug>.env` already
there that does not belong to the project's account; it names the file,
never what it holds. A schedule systemd on the machine does not read
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
bash ~/deploy.sh                             # from the project's folder, or name it
bash ~/deploy.sh --archive bundle.tar.gz     # build and write the archive, send nothing
```

It is `sitesolide deploy` with a token, step for step: the same refusals
before anything leaves (a folder of dependencies present and not excluded, a
`source` or a `publicDir` leading out of the repository, a link among what
would be sent, an empty `publicDir`), the manifest first, the build on the
workstation, the archive with the CLI's exclusions, then the machine's log
to the end. It exits 0 only once the machine says `succeeded`. curl reads the
token's header from a file descriptor, never from its arguments, and the
build runs without `SITESOLIDE_TOKEN`, or any other `SITESOLIDE_` variable,
in its environment, but as you all the same, with what you may read: deploy,
and run `--archive`, which builds too,
only a project whose build you would run yourself. `bin/tests/deploy-script.test.ts` holds
its archive to the CLI's on the same folder, read back by the installer's own
reader, with each of the four JSON readers.

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
  `sitesolide share` and `sitesolide people`. A token stops earlier, at half
  the log, the rows its removals may still write counted: the other half
  stays for the people who give access from the dashboard, so that no token
  fills it for them.
- **`out-of-scope` on `secrets`**: the token was minted without *Manage
  secrets*, the file is not `<slug>.env`, or the deployed `sitesolide.json` does
  not declare it: add `"secrets": ["<slug>.env"]`, deploy, then set. Mint a
  token with the permission, or ask the owner; never try another token.
- **`unmanaged` on `secrets set`**: someone wrote the file by hand, `export`
  lines or quotes the dashboard does not read. Nothing was changed: the owner
  rewrites it from *Secrets*.
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
  again: any token that may create projects may create one of that name,
  once the machine keeps none of its backup snapshots and none of the
  connector grants it had. Until then the name is `reserved` to every token:
  a project created under it would list its predecessor's snapshots, restore
  them, and be lent its credentials. The owner deploys it over SSH, or clears
  what was left.
  A person's own token answers to their role instead: a project they created
  is theirs to deploy as long as they are its Developer or Admin, with any
  token of theirs that names it.
