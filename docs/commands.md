# Commands

Every command runs from a project's folder, the one holding its
`sitesolide.json`, except `init`. This is what `sitesolide --help` prints.

```text
sitesolide init                 write ~/.config/sitesolide/config.json
   --server <user@host> --zone <dns.zone> --email <you@example.com>
   --contact <you@example.com>   shown on a locked preview's door
sitesolide detect               the sitesolide.json this folder implies, written nowhere
   --write                      write it, never over an existing one
   --slug <name>                name the project, rather than after its folder
sitesolide deploy               prepare, build, push, install, restart, verify
   --dry-run                    show the unit and the fragment, install nothing
   --force                      switch a hand-written unit to the generated one
   --yes [--slug <name>]        no sitesolide.json: write the inferred one, then deploy
sitesolide status               what the server actually runs
sitesolide logs [--follow]      journalctl for this project
   --lines <n>                  how many lines back, 50 by default
sitesolide backups              this project's data snapshots, read only
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
`detect`, `deploy`, `status`, `logs` and `lock --status` as tools to an MCP
client. Both are described in [agents.md](agents.md).

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

--json, on every one of them: one JSON event per line, see docs/agents.md
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
