# Commands

Every command runs from a project's folder, the one holding its
`sitesolide.json`, except `setup`, `upgrade`, `init`, `machine`, `people`,
`help` and `--version`. This is what `sitesolide --help` prints.

```text
sitesolide setup <user@host>    install a fresh Debian 13 machine, resumable, a no-op once done
   --zone <dns.zone> --email <you@example.com>
   --contact <you@example.com>   shown on the page that asks for a preview code
   --user <name>                the account that deploys, deploy by default as root
   --skip-dns                   create the DNS records by hand: setup lists them and waits
   --dns-replace                replace records that point elsewhere, on your decision alone
   --cloudflare-token-stdin     read the Cloudflare token from standard input
   --minimal                    leave out backups, the installer and the egress proxy
   --any-os                     go on with a system other than Debian 13, at your own risk
   --config-dir <dir>           another installation's own configuration folder
   --dry-run                    check every step, change nothing
sitesolide upgrade              bring every installed component to this release's code, resumable
   --dry-run                    list each component, up to date, out of date or missing, change nothing
sitesolide help                 this list, with or without a configuration; --help after any command
sitesolide --version            the release this binary was built from, dev from a checkout
sitesolide init                 write ~/.config/sitesolide/config.json
   --server <user@host> --zone <dns.zone> --email <you@example.com>
   --contact <you@example.com>   shown on the page that asks for a preview code
sitesolide detect               the sitesolide.json this folder implies, written nowhere
   --write                      write it, never over an existing one
   --slug <name>                name the project, rather than after its folder
sitesolide deploy               prepare, build, push, install, restart, verify
   --dry-run                    show the unit and the fragment, install nothing, build nothing
   --build                      with --dry-run: run the build too, the folder's own code, here
   --compare                    with --dry-run: build, then list what would change on the server
   --force                      switch a hand-written unit to the generated one
   --yes [--slug <name>]        no sitesolide.json: write the inferred one, then deploy
sitesolide status               what the server actually runs
sitesolide logs [--follow]      journalctl for this project
   --lines <n>                  how many lines back, 50 by default
sitesolide backups              this project's data snapshots, read only
sitesolide share                this project's general access and people with access
   <email|@domain>...           give them access, Can open by default
   --role <role>                can-open, viewer, developer or admin
   --expires <24h|7d|30d|never> for password access, 7d by default
   --remove <email|@domain>...  take their access away; password access by the name it is listed under
sitesolide people               everyone with access, their roles, who may create projects
   <email> --may-create         let them create projects, Admin of what they create
   <email> --no-create          take that right back
   --migrate-without-portal     carry access over without the portal's database, when it does not read
sitesolide lock   [--dry-run]   close the preview behind a code, or show it
   --status                     wanted / installed / measured, without touching
   --new-code                   replace the code in force by a fresh one
sitesolide unlock [--dry-run]   reopen the preview and drop its code
sitesolide domain               where this project's own domain stands
   --activate [--force]         switch the site onto it, then rebuild the table
   --deactivate                 back to the preview subdomain
sitesolide remove --confirm <slug>
                                take the project off the machine, for good, its name freed from the token that created it
   --dry-run                    show every step, remove nothing
sitesolide run -- <command>     load the secret from the vault and run
sitesolide mcp                  serve these commands to an agent, over MCP on stdio
sitesolide login --url <https://dashboard.zone>
                                a person with a token: deploy without SSH
   --token-stdin                read the token from standard input
sitesolide machine create|list|destroy --provider hetzner
                                a VM ordered by API, before setup: sitesolide machine lists the options
any command --api               go through the dashboard's API even with a server
SITESOLIDE_CONFIG_DIR=<dir>     before any command: read that installation's configuration

--json, on every command but init and run: one JSON event per line, see docs/agents.md
secrets live on the server: manage them in the Secrets section of https://dashboard.<zone>
general access of a deployed site is set from the dashboard too: deploy follows the server
```

`sitesolide setup` is the whole base install of [install.md](install.md),
hardening and DNS records included, in one command that can be run again at
any time: see [setup.md](setup.md). `sitesolide upgrade` is its other half,
for a machine in service: it brings the components setup installed to the
code of the binary or the checkout it runs from, and redeploys only those
that differ, see [Upgrading the machine](#upgrading-the-machine).
`SITESOLIDE_CONFIG_DIR` points every command at another configuration folder
than `~/.config/sitesolide`, for a second installation driven from the same
workstation.

`sitesolide run` loads the files the manifest declares from
`~/.config/sitesolide/secrets/`, the few credentials your workstation presents
to production itself, then runs the command. See [secrets.md](secrets.md).

`sitesolide logs` shows every service of a project, interleaved by time.

`deploy --dry-run --compare` runs the build, as `--build` does, then measures
on the server what this deployment would change there, and changes nothing:
the files its rsync would send or delete (compared by content, a time or a
mode alone does not count), the deposited manifest, a missing unit, a Caddy
block that differs. A unit edited on the machine is reported and never
counted, deploy leaving it as it is without `--force`; a block edited there is
refused, as deploy refuses it. `upgrade` asks exactly this of the dashboard and
the portal.

## Upgrading the machine

`sitesolide upgrade` runs from anywhere, against the machine the configuration
names, as the account that deploys:

```console
$ sitesolide upgrade --dry-run
-> upgrade of deploy@203.0.113.10, zone example.com, to the code of release v0.4.0, dry run: nothing is changed on the machine
up to date   Caddy's drop-in
up to date   backups
up to date   egress proxy
out of date  steward             differs: steward.js; would run bin/deploy-steward.sh
   dashboard/: sitesolide deploy --dry-run --compare, which builds it first
out of date  dashboard           differs: /srv/sites/dashboard/public: 18 entries to send or delete; would run sitesolide deploy in dashboard/
...
missing      installer           not installed: sitesolide setup installs it
```

Each component is checked first, reading only: what setup checks for it, and
the fingerprint of what would be installed against what is, the SHA-256 the
deploy script itself verifies after installing. Only a component that differs
is redeployed, through the script or the `sitesolide deploy` setup runs for it,
in the order [upgrading.md](upgrading.md) gives. A component the machine does
not carry is reported missing, and `sitesolide setup` installs it. A failure
stops at its component, quotes the end of what its script printed and the
command that shows more; the same command again resumes there. A second run
right after a successful one finds everything up to date and changes nothing.
It never reads nor rotates a secret, and never touches Caddy but through
`bin/deploy-caddy.sh` and `systemctl`. See [upgrading.md](upgrading.md).

## Access to a project

Who may open a project, and who may do what on it, is one list per project,
its people with access, which the steward keeps: each entry an email or a
whole domain, `@acme.com`, with a role, Can open (`can-open`), Viewer,
Developer or Admin, each including the ones below it.
[access.md](access.md#people-with-access-beside-tokens) says what each role does.
`sitesolide share`, in the project's folder, reads the list and changes it;
the dashboard's *Access* section is the other way.

```console
$ sitesolide share
-> access to notes, https://notes.example.com/, over SSH, as the owner
   general access: Restricted: visitors are asked to sign in.
   people with access:
     alice@acme.com      Developer
     @acme.com           Can open
     client@example.org  Can open, password access until 2026-11-07 09:00 UTC
   Also open it without being listed: the owner, and owner@acme.com, set on the server to open every site.

$ sitesolide share bob@acme.com carol@acme.com --role developer
-> access to notes, https://notes.example.com/, over SSH, as the owner
-> bob@acme.com: Developer on notes
-> carol@acme.com: Developer on notes
   ...
   send: Open https://notes.example.com/ and sign in with your Google account.

$ sitesolide share dana@example.net --expires 30d
-> access to notes, https://notes.example.com/, over SSH, as the owner
-> dana@example.net: Can open, password access until 2026-11-07 09:00 UTC on notes
   password for dana@example.net: Xith-G4r4-nRJs-uDMV
   shown once: send it to them yourself, with the address; the machine keeps only its hash
   ...

$ sitesolide share --remove @acme.com
-> access to notes, https://notes.example.com/, over SSH, as the owner
-> @acme.com no longer has access to notes: refused from their next request
   ...
```

With no argument it shows the project's general access, its people with
access, each with their role and password access with its expiry, and who
else opens it without being on the list. Emails and `@domain`s
are given access, Can open unless `--role` names another; someone already on
the list gets the role named, raised or lowered, and someone who has it
already is left as they are. A domain is Can open only, and only once signing
in with a company account is set up. Someone outside the company's domains, or
anyone when that is not set up, is Can open only, with **password access**:
the machine draws a password for them, which the command prints once, and the
access lasts what `--expires` says, 7 days by default. `--remove` takes access
away, from the person's next request. Several people are handled one by one:
a refusal stops before the next, and says who was already given access.

Nothing is sent to anyone: after giving someone access with an account, the
command prints the line to send, `send:`, and for password access the
password, once. Two things are never done here: general access, Public or
Restricted, from the dashboard's *Access* section, and the preview code,
`sitesolide lock`. `--domain` and `--only-admins`, from before, are refused
with a pointer: a domain is written `@acme.com`.

With `--json`, the `result` carries `slug`, `url`, `general` (`public`,
`restricted`, `code`, or null for a project not deployed), `entries`, `signIn`
(`configured`, `allowedDomains`), `message` (the line to send, null until
signing in with a company account is set up), `changed`, and after a change
`changes`, each `{ who, change, role }`, `change` being `add`, `role`, `none`
or `remove`, and `password` for password access just given:

```console
$ sitesolide share dana@example.net --json
...
{"type":"result","ok":true,"command":"share","slug":"notes","url":"https://notes.example.com/","general":"restricted","entries":[...,{"who":"dana@example.net","kind":"password","role":"can-open","by":"owner","createdAt":1791450000000,"updatedAt":1791450000000,"password":{"expiresAt":1792054800000,"expired":false}}],"signIn":{"configured":true,"allowedDomains":["acme.com"]},"message":"Open https://notes.example.com/ and sign in with your Google account.","changed":true,"changes":[{"who":"dana@example.net","change":"add","role":"can-open","password":"Xith-G4r4-nRJs-uDMV"}]}
```

The owner's `share` runs over SSH: root on the machine asks the steward on
its owner socket, `/run/sitesolide-steward-owner/owner.sock`, which only root
opens, the body on standard input so that no address goes through a shell.
The steward judges the change by its access rules, writes the portal's
projection and its registry, and records it in its journal under `owner`.
Root is the owner: no unlock is asked. It touches nothing else, Caddy least of
all. With a token, the command goes through the dashboard to the steward, and
gives Can open alone: see [access.md](access.md#giving-access-to-what-you-deployed).
While the portal on the machine still decides from its own tables, halfway
through an upgrade, the command warns of it: `sitesolide upgrade` deploys the
portal that reads the registry.

## People

Everyone with access, machine-wide, for the owner, from any folder: their
roles per project, their password access, who may create projects, the
domains, and the admin emails, which open every site as admin, set on the
server in `OIDC_ADMIN_EMAILS`. The dashboard's *People* page is the other way. Roles are given per
project, with `sitesolide share`; `people` grants the right to create
projects.

```console
$ sitesolide people
-> people of https://dashboard.example.com, over SSH, as the owner
   alice@acme.com      notes: Developer, shop: Viewer
   client@example.org  notes: Can open, password access until 2026-11-07 09:00 UTC
   you@acme.com        no project; every site, as admin: set on the server in OIDC_ADMIN_EMAILS
   @acme.com           Can open: blog, notes
   the company's domains: acme.com; anyone else gets password access

$ sitesolide people alice@acme.com --may-create
-> people of https://dashboard.example.com, over SSH, as the owner
-> alice@acme.com may create projects, Admin of each one they create: open https://dashboard.example.com and sign in with their company account
   alice@acme.com  notes: Developer, shop: Viewer; may create projects
```

`--may-create` grants the right to create projects to someone who signs in
with a company account, whatever their roles, none included: they sign in to
the dashboard, mint a token that may create projects, and become Admin of each
project it creates. `--no-create` takes it back and leaves their roles;
someone then left with no role above Can open no longer signs in to the
dashboard, their sessions closed and their tokens revoked.

With `--json`, the listing's `result` carries `people` (each `who`, `roles` by
project, `can-open` for Can open, `create`, `passwords`, each `slug`,
`expiresAt`, `expired`, and `admin`), `domains` (each `slug`, `domain`),
`signIn` and `changed: false`;
`--may-create` and `--no-create`, `email`, `create`, `roles`, `change`
(`create` or `none`) and `changed`.

Root on the machine asks the steward on its owner socket, as for `share`, and
the steward records the change in its journal under `owner`. With a token, the
command is refused before anything is sent: it is the owner's. See
[access.md](access.md#people-with-access-beside-tokens) for what each person sees,
and [dashboard/README.md](../dashboard/README.md#access) for the machine's
side.

## A folder without a manifest

`sitesolide detect` reads the folder and prints the manifest it implies: a Go
module, a FastAPI or Flask app, a package.json app or generated site, a folder
of files. It reads no machine and needs no configuration. `--write` writes the
manifest, never over an existing one.

`sitesolide deploy` in such a folder prints the same manifest and stops; `--yes`
writes it and deploys, unless the machine already serves a project of that
name. An app whose manifest declares no `port` gets a free one from `deploy`,
written back into `sitesolide.json` to be committed. See
[agents.md](agents.md#zero-configuration) for what is recognised, and what is
never decided for you: secrets and the network.

## A machine from a cloud provider

`sitesolide machine` orders the VM itself, before there is a configuration to
read: it talks to the provider's API, never over SSH. See
[machine.md](machine.md) for what it creates, what it costs and what the token
needs.

```text
sitesolide machine create --provider hetzner --name <name>
                                order a VM, its firewall and your SSH key, ready for setup
   --type <type>                cx23 by default; a refusal lists what the location sells
   --location <location>        fsn1 by default
   --image <image>              debian-13 by default
   --backups                    the provider's daily backups, about 20 % on the price
   --ssh-key <path.pub>         ~/.ssh/id_ed25519.pub, id_ecdsa.pub or id_rsa.pub by default
sitesolide machine list --provider hetzner
                                the machines sitesolide created, their addresses and price
sitesolide machine destroy <name> --provider hetzner
                                delete the machine and its firewall, for good
   --confirm <name>             the name typed back, where no terminal can ask for it
   --delete-key                 delete the SSH key uploaded for it too
any machine command --token-stdin
                                read the token from standard input rather than HCLOUD_TOKEN

--json, on every one of them: one JSON event per line, see docs/agents.md
the token is never an option, where ps would show it: see docs/machine.md
```

`create` ends on the command that comes next, `sitesolide setup
root@<ipv4> --zone <your zone> --email <you>`, once port 22 answers.

## For agents

`--json` prints one JSON event per line on standard output, nothing else, and
ends with a `result` or an `error` carrying a `hint`. `sitesolide mcp` serves
`detect`, `deploy`, `status`, `logs`, `share` (and `access`, its read alone)
and `lock --status` as tools to an MCP client; `setup` and `upgrade`, which
change the machine itself, are not tools. Both are described in
[agents.md](agents.md).

## With a token

A workstation with no `server`, but the dashboard's address and a token, never
touches SSH: someone's own, or an agent's. See [access.md](access.md).

```text
sitesolide login --url <https://dashboard.zone>   keep the token, check it
   --token-stdin                                  read it from standard input
sitesolide deploy                                 build here, upload, follow the machine's log
sitesolide status                                 the projects this token may deploy
sitesolide logs [--follow]                        the journal of this folder's project
   --lines <n>                                    how many lines back, 50 by default, 500 at most
sitesolide share                                  this folder's project's general access and people with access
   <email|@domain>...                             give them Can open: people inside the company's domains, or one of them
   --remove <email|@domain>...                    take their Can open away

--json, on every one of them: one JSON event per line, see docs/agents.md
SITESOLIDE_API and SITESOLIDE_TOKEN in the environment win over the files.
```

`login` keeps the token in `~/.config/sitesolide/secrets/team-token`, 0600, and
the address in `config.json` under `api`. `SITESOLIDE_API` and
`SITESOLIDE_TOKEN` in the environment win over both, for an agent's sandbox.
A person's own token says so: `login` and `status` print whose roles bound
it, and what it may do is the steward's reading of those roles at that
moment. `share` gives Can open alone, and never password access, see
[access.md](access.md#giving-access-to-what-you-deployed).

`deploy` sends the manifest first, so that a refusal arrives before the build,
then a gzip-compressed tar holding `app/` and `public/`, exactly what rsync
would have sent, and follows the machine's log until the end; it exits
non-zero when the deployment fails. A manifest with a `start` and no `port`
gets one chosen on the machine.

Any other option is refused before a request leaves, `deploy --dry-run` first:
a dry run reads the machine over the owner's SSH access, which a token does
not carry, and the control API has no route that judges without deploying.
`--json` prints the same events as over SSH, and one final `result` or `error`.

The other commands need the owner's SSH access and say so. The owner, whose
configuration has a `server`, keeps SSH for every command; `--api` makes one
go through the dashboard instead, to see what a token's holder sees.

`sitesolide backups` lists the snapshots the machine keeps of the project's
data folder, on the server and in the bucket, and its last run. It reads and
changes nothing: a restore is made from the dashboard's *Backups* section, which
saves the current data first. See
[dashboard/src/backup/README.md](../dashboard/src/backup/README.md).

## Upgrading to the hardened deploy

A release of the CLI that closes holes found in review: what an agent, a token
or a cloned folder could make `deploy` do. It changes how some deployments
behave, listed below. The commands are yours to run, in this order. It came
before `sitesolide upgrade`, which now does steps 2 and 3 on its own, only for
what differs: see [Upgrading the machine](#upgrading-the-machine).

**What changes for you.**

| Before | Now |
|---|---|
| any valid slug | `caddy`, `ssh`, `cron`, `nftables`, `www`, every `systemd-*` and `sitesolide-*`... are refused, and so is a slug systemd already gives to a unit deploy did not write and that does not serve `/srv/sites/<slug>`, `--force` or not |
| `deploy --dry-run` ran the build | it shows the build and does not run it; `--dry-run --build` runs it |
| `install` ran in `app/` as the deployment account, with sudo | it runs as `site-<slug>`, in a transient unit with its service's walls: the network but not the loopback, only `app/` writable, `HOME` in a throwaway `/tmp`, 1G and fifteen minutes at most |
| ports checked before the build | checked again under the Caddy lock, before the manifest is deposited; 3022, 3026 and 3029 are refused to every project but the dashboard, the portal and analytics |
| `.git` sent with the code, `public/` sent as it is | `.git` and every `.env*` never leave, at any depth; the next deploy removes those an earlier one left in `public/`, and Caddy answers 404 for them |
| `source` could lead anywhere | from a manifest outside the `sites` repository of your configuration, only inside its own repository |
| a token's `deploy --dry-run` deployed for real | refused, as is every option the token's path does not carry; `--json` speaks events there too |

**1. The workstation.** Pull, then `bin/test.sh`. Check that `sitesolide
deploy --dry-run` in a project with a `build` prints `[dry-run] build (...), not
run`, and that `config.json` names your sites repository under `sites` (`sitesolide
init --sites <path>` otherwise): a manifest there keeps a `source` that climbs
out, as `mini-lab` does.

**2. What the machine runs from this repository**, before redeploying any other
site: they recognise the Caddy blocks the new generator writes, whose file server
hides `.git` and `.env*`. Until they are updated, the dashboard refuses to change
the general access of a site redeployed with the new CLI ("redeploy the site first"), and
a token's deploy of it stops on `edited-by-hand`; nothing served changes.

```bash
cd dashboard && sitesolide deploy   # the dashboard itself, and its own block
bin/deploy-steward.sh               # policy.ts
bin/deploy-gatekeeper.sh            # bin/cli/fragment.ts
bin/deploy-installer.sh             # src/installer/, policy.ts, bin/cli/
```

Each script checks what it installs. Then the dashboard's *Access* section
should switch a test site between Public and Restricted as before.

**3. The Caddyfile**, whose landing, wildcard and customer-domain blocks now hide
`.git` and `.env*`:

```bash
bin/deploy-caddy.sh                 # validates with systemd's environment, reloads, restores on failure
```

Check: `curl -s -o /dev/null -w '%{http_code}\n' https://<static-site>.<zone>/.git/config`
answers `404`, and the site's home `200`.

**4. Every app, one by one**, with `sitesolide deploy`. Its block is replaced
without `--force` ("written by an earlier release, the current one replaces
it"), and its `install` now runs as `site-<slug>`: the step reads `->
dependencies (...), as site-<slug> in its service's walls`. An install that
wrote outside `app/`, needed root or a tool installed into `HOME` now fails with
`install failed`, the code in place and the service not restarted: move that
step into `build`, or install the tool on the machine. The platform's own
manifests, the dashboard's and analytics' `bun install --production`, run in
`app/` and need nothing more.

**5. Leftovers.** A `.env` an earlier deploy put in `app/` stays there, since an
excluded file is protected from rsync's `--delete`, and Bun still loads it at
start. Read them, then remove the stale ones:

```bash
ssh <server> "sudo find /srv/sites/*/app -maxdepth 3 -name '.env*' -not -path '*/node_modules/*'"
```

**Rolling back.** Check out the previous commit on the workstation, and run
steps 2 and 3 from it. A site whose block was written by this release then reads,
to the previous CLI, as a block that "no longer matches the manifest":
`sitesolide deploy --force` in its folder puts the previous block back.
