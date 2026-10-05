# Commands

Every command runs from a project's folder, the one holding its
`sitesolide.json`, except `init`, `help` and `--version`. This is what
`sitesolide --help` prints.

```text
sitesolide help                 this list, with or without a configuration; --help after any command
sitesolide --version            the release this binary was built from, dev from a checkout
sitesolide init                 write ~/.config/sitesolide/config.json
   --server <user@host> --zone <dns.zone> --email <you@example.com>
   --contact <you@example.com>   shown on a locked preview's door
sitesolide detect               the sitesolide.json this folder implies, written nowhere
   --write                      write it, never over an existing one
   --slug <name>                name the project, rather than after its folder
sitesolide deploy               prepare, build, push, install, restart, verify
   --dry-run                    show the unit and the fragment, install nothing, build nothing
   --build                      with --dry-run: run the build too, the folder's own code, here
   --force                      switch a hand-written unit to the generated one
   --yes [--slug <name>]        no sitesolide.json: write the inferred one, then deploy
sitesolide status               what the server actually runs
sitesolide logs [--follow]      journalctl for this project
   --lines <n>                  how many lines back, 50 by default
sitesolide backups              this project's data snapshots, read only
sitesolide share                who may open this project with their work account, and the line to send
   <email>...                   share it with these people
   --domain <domain>            with everyone at this domain
   --remove <email|domain>      take a person or a domain off
   --only-admins                back to the admins alone
sitesolide lock   [--dry-run]   close the preview behind a code, or show it
   --status                     wanted / installed / measured, without touching
   --new-code                   replace the code in force by a fresh one
sitesolide unlock [--dry-run]   reopen the preview and drop its code
sitesolide domain               where this project's own domain stands
   --activate [--force]         switch the site onto it, then rebuild the table
   --deactivate                 back to the preview subdomain
sitesolide remove --confirm <slug>
                                take the project off the machine, for good
   --dry-run                    show every step, remove nothing
sitesolide run -- <command>     load the secret from the vault and run
sitesolide mcp                  serve these commands to an agent, over MCP on stdio
sitesolide login --url <https://dashboard.zone>
                                a team member: keep a token, deploy without SSH
   --token-stdin                read the token from standard input
any command --api               go through the dashboard's API even with a server

--json, on every command but init and run: one JSON event per line, see docs/agents.md
secrets live on the server: manage them in the Secrets section of https://dashboard.<zone>
the portal of a deployed site is set from the dashboard too: deploy follows the server
```

`sitesolide run` loads the files the manifest declares from
`~/.config/sitesolide/secrets/`, the few credentials your workstation presents
to production itself, then runs the command. See [secrets.md](secrets.md).

`sitesolide logs` shows every service of a project, interleaved by time.

## Sharing a project

A project behind the portal opens to the admins alone until it is shared:
the owner's password, the admin emails, and guests with a password. `sitesolide
share`, in its folder, shares it the way a Google Doc is shared, with people by
their work email or with everyone at a domain, once the portal lets people sign
in with a company account ([portal/README.md](../portal/README.md#signing-in-with-a-work-account)).

```console
$ sitesolide share alice@acme.com bob@acme.com
-> sharing of notes, https://notes.example.com/, over SSH, as the owner
-> replace the policy: the admins alone -> the people listed, and the admins
   who gets in: the people listed, and the admins
   people: alice@acme.com, bob@acme.com
   the admins: the owner's password, the admin emails, and guests with a password
   send: Open https://notes.example.com/ and sign in with your Google work account.
   holds from their next request; the portal records the change in its audit
```

With no argument it shows who gets in and the line to send. Adding people to a
site open to the admins alone switches it to those people; `--domain` opens it
to everyone at the domain, subdomains not included; `--remove` takes a person
or a domain off; `--only-admins` closes it back. The portal keeps both lists
whatever the mode, as the dashboard's *Sharing* section does: someone shared
with earlier is let in again by a switch back, and the command says who before
it changes anything. A change holds from the next request, and the portal
records it in its audit.

Two things are never done here: making a site public, which is turning its
portal off, from the dashboard's *Access* section; and guest passwords, from
its *Guests* section, which shows a password once.

The owner's `share` runs over SSH: root on the machine asks the portal's admin
API on the loopback, after reading there that the site's manifest asks for the
portal and that its block carries it. It touches nothing else, Caddy least of
all. With a team token, it goes through the dashboard, which may refuse a
domain: see [team.md](team.md#sharing-what-you-deployed).

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

## For agents

`--json` prints one JSON event per line on standard output, nothing else, and
ends with a `result` or an `error` carrying a `hint`. `sitesolide mcp` serves
`detect`, `deploy`, `status`, `logs`, `share` (and `sharing`, its read alone)
and `lock --status` as tools to an MCP client. Both are described in
[agents.md](agents.md).

## With a team token

A workstation with no `server`, but the dashboard's address and a token, is a
team member's: it never touches SSH. See [team.md](team.md).

```text
sitesolide login --url <https://dashboard.zone>   keep the token, check it
   --token-stdin                                  read it from standard input
sitesolide deploy                                 build here, upload, follow the machine's log
sitesolide status                                 the projects this token may deploy
sitesolide logs [--follow]                        the journal of this folder's project
   --lines <n>                                    how many lines back, 50 by default, 500 at most
sitesolide share                                  who may open this folder's project, and the line to send
   <email>...                                     share it with these people
   --domain <domain>                              with everyone at a domain the portal admits
   --remove <email|domain>                        take a person or a domain off
   --only-admins                                  back to the admins alone

--json, on every one of them: one JSON event per line, see docs/agents.md
SITESOLIDE_API and SITESOLIDE_TOKEN in the environment win over the files.
```

`login` keeps the token in `~/.config/sitesolide/secrets/team-token`, 0600, and
the address in `config.json` under `api`. `SITESOLIDE_API` and
`SITESOLIDE_TOKEN` in the environment win over both, for an agent's sandbox.

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
go through the dashboard instead, to see what a team member sees.

`sitesolide backups` lists the snapshots the machine keeps of the project's
data folder, on the server and in the bucket, and its last run. It reads and
changes nothing: a restore is made from the dashboard's *Backups* section, which
saves the current data first. See
[dashboard/src/backup/README.md](../dashboard/src/backup/README.md).

## Upgrading to the hardened deploy

A release of the CLI that closes holes found in review: what an agent, a token
or a cloned folder could make `deploy` do. It changes how some deployments
behave, listed below. The commands are yours to run, in this order.

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
the portal of a site redeployed with the new CLI ("redeploy the site first"), and
a token's deploy of it stops on `edited-by-hand`; nothing served changes.

```bash
cd dashboard && sitesolide deploy   # the dashboard itself, and its own block
bin/deploy-steward.sh               # policy.ts
bin/deploy-gatekeeper.sh            # bin/cli/fragment.ts
bin/deploy-installer.sh             # src/installer/, policy.ts, bin/cli/
```

Each script checks what it installs. Then the dashboard's *Access* page should
toggle a test site's portal as before.

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
