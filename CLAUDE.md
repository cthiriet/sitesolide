# Project instructions

This repository holds **sitesolide**: a deployment platform that serves every
project from a single VM. Read [README.md](README.md) for what it does and
[docs/concepts.md](docs/concepts.md) for who is allowed to touch what.
[CONTRIBUTING.md](CONTRIBUTING.md) covers Bun, SQLite, CSS, tests and commits,
follow it.

What follows is what an agent working here has to know beyond that.

## Production has no safety net

One machine serves everything. There is no staging, no second machine, no
automatic recovery: what breaks production breaks every site at once, and
nothing repairs itself.

### `caddy stop` and `caddy start` are forbidden on that machine

They do not address the file passed with `--config`. They post to the admin API,
`127.0.0.1:2019` by default, that is to say to the running production instance
whatever argument you give: `caddy stop --config /tmp/test.caddy` stops
production. It happened on 11 August 2026, 23 minutes of downtime on three
domains, and the journal showed nothing wrong, since from Caddy's point of view
the shutdown was orderly.

| What you want | The command |
|---|---|
| Apply a configuration | `sudo systemctl reload caddy` |
| Start, restart, stop | `sudo systemctl <verb> caddy` |
| Stop a test instance | `pkill -f` on its command line |
| Check a configuration | `bin/deploy-caddy.sh`, which loads the environment the way systemd does |

**A clean shutdown is not a failure to systemd.** The service exits with
`Result=success`, so `Restart=always` never fires and the machine stays silent
until someone intervenes. No external monitoring is in place to notice.

**`caddy validate` run by hand fails with nothing broken.** It does not load
`/etc/caddy/cloudflare.env` or `/etc/caddy/sitesolide.env`, which systemd
injects with `EnvironmentFile`: the Cloudflare token is then empty and the DNS
module refuses the configuration, and the zone variables are empty so the
addresses are too. That message is not a defect of the Caddyfile.

### Nothing is tried out on the machine that serves the sites

A configuration, a port, an image: all of it is checked on the workstation. If a
test really needs the machine, it runs with `admin off` so as not to share the
admin API, on a free port, and it is stopped by its PID.

### An agent given SSH access to production is given an allow list

Forbidding in prose is not enough: "change nothing, reload nothing" does not
forbid *starting* something, and that is exactly how the outage happened. A
subagent working on the machine receives the list of commands it may run, all
read-only, and an explicit ban on everything else. A privileged command an agent
asks for is put to the repository's author, never run on the agent's say-so.

## Secrets

**The machine is the source of truth, and the only holder.** `/etc/sitesolide`
is the production vault, and the dashboard holds the files of every deployed
project there. `sitesolide deploy` never pushes a secret: it checks one is
present, and points to the dashboard when it is not. The detail is in
[docs/secrets.md](docs/secrets.md) and [dashboard/README.md](dashboard/README.md).

**No key in a committed file**, nor anywhere inside a repository, ignored or
not. What is private to the workstation lives in `~/.config/sitesolide/`: the
configuration, `secrets/` for the credentials the workstation itself presents to
production, and `terraform/` for Terraform's values and state, which
`bin/terraform.sh` hands to it.

`.claude/settings.json` denies Claude Code both reading and writing any `*.env`,
any `*.tfvars`, and the two private folders of `~/.config/sitesolide/`,
read tool and shell commands included. Do not work around it, and do not ask the
author to paste a value into the conversation: a secret that has been read is a
secret to change.

**An agent never unlocks the dashboard**, does not ask for its password, and
neither sets nor removes a portal door. A value shown on screen is a value that
has been read, therefore one to change, and a door that flips reloads Caddy in
front of every site.

## Nothing in this repository names a machine

This is the rule that makes the repository publishable, and it is easy to break
without noticing.

The server, the zone, the contact address and the account that owns the served
files come from `~/.config/sitesolide/config.json`, written by `sitesolide
init`. **None of them has a fallback value.** The CLI and the scripts stop and
point at `init` rather than guessing: a default here would aim at its author's
machine, and a `deploy` run without configuration would land on it.

Concretely, when writing code here:

- read a setting through `bin/cli/config.ts`, or through `bin/config.sh` in a
  shell script, never a literal;
- a generated Caddy fragment writes `{$SITESOLIDE_ZONE}`, which Caddy
  substitutes, never a domain;
- a committed manifest writes `{slug}`, `{zone}` and `{contact}` in its
  environment variables;
- a test that needs a zone uses `test-zone.invalid`, which resolves nowhere;
- a project's unit and Caddy block are generated from its manifest at deploy
  time and live on the machine alone: no copy of them is kept anywhere else.

## Bun, and the deprecation check

The whole repository runs on Bun, with no Node and no third-party bundler.
Before writing Bun code, read the page that covers it from
<https://bun.com/llms.txt> rather than trusting memory, and prefer a runtime
primitive (`Bun.file`, `Bun.serve` and its `routes` object, `bun:sqlite`,
`Bun.password`, `Bun.$`) to a dependency or a Node equivalent.

**The trap**: the official documentation still uses deprecated APIs, `db.exec`
first among them. `tsc --noEmit` says nothing about those, a deprecation is a
suggestion diagnostic that only the language service produces. The judge of last
resort is `bin/deprecations.ts`, which `bin/test.sh` runs and `bun run check`
does not.

## Everything in this repository is in English

**Absolutely everything.** Not a word of French goes into this repository, and
that rule has no exception.

| What | Language |
|---|---|
| Identifiers: functions, variables, types, constants, properties | English |
| Comments, of every kind, in every file type | English |
| Documentation, READMEs, this file | English |
| File, directory, systemd unit and system account names | English |
| Package scripts, CLI commands and their flags | English |
| Messages printed to a terminal, and error messages | English |
| Commit messages | English |
| Test names in `describe` and `test` | English |
| Text in the dashboard's interface | English |

**The author writes to you in French. That changes nothing.** A conversation in
French is a conversation, not a specification: you answer in French, and you
write English into the files. Never take a French word from the conversation and
put it into the code, not as an identifier, not in a comment, not in a commit
message.

**Including what a visitor reads.** The portal's sign-in page and the preview
door page ship in English, because anyone can install this software and the
pages have to be readable when they do. Whoever runs an installation may
translate them into the language of their own visitors; that is their copy, not
this repository.

**What is still French is what the served machine carries**, and only that:
`sitesolide_boucle`, `sauvegardes`, `domaines.map`, `hotes.json`,
`instantane.json`, `verrou.html`, `precedents`, `verrous.caddy`,
`secretaire.sock`, `sitesolide-loopback-secours`, `/srv/garde`, and the SQL
columns of the deployed databases. Those names are not text in this repository,
they are the names of things that exist on the VM right now: a unit and an
account systemd will not rename by itself, a file Caddy imports by path, a
column a running service reads. Translating one here renames nothing over
there; it only makes the repository disagree with the machine, and the
disagreement shows up as a site that no longer answers. Each of them is renamed
by a step of [docs/migration.md](docs/migration.md), written first, applied,
and only then followed by the code.

The same holds for the HTTP surface a deployed fragment or a served page
already speaks: the routes `/interne/domaine-autorise`, `/verifier`, `/sante`,
`/_portal/connexion`, `/_portal/deconnexion` and `/admin/invites/:id`, the
header `X-Portal-Hote` and the value `X-Portal: connexion`, and the portal's
form fields `retour` and `motdepasse`. `/verifier` is the target of the
`forward_auth` written into every fragment in service: renaming it cuts every
protected site until all of them have been deployed again.

Three of these bite harder than the rest. `verrous.caddy` is imported by a
glob: a second file under a new name would sit beside the one in service, and
every locked site would carry two stanzas. The Caddy snippet `(commun)` is
imported by name from every fragment on the machine, so a rename fails the
validation of the whole configuration, for every site at once.
`sitesolide-loopback-secours` is the unit a run disarms by name after the
previous run armed it; renamed, the old timer stays armed and drops the table
two minutes later.

The Caddyfile's own matchers are not in that group, and were translated: they
are defined and used inside a file that deploys whole.

The configuration was in that group until the socle was translated: the keys of
`~/.config/sitesolide/config.json` and the environment variables the shell
scripts share with the CLI are English now, the latter carrying a `SITESOLIDE_`
prefix. `bin/cli/config.ts` still reads the four old keys and says they are
outdated, which is what a rename costs when it happens before publication
rather than after.

A handful of accented strings in the tests are deliberate and stay: they are
what proves that search ignores accents, that a body cap counts bytes rather
than characters, that a slug is URL-encoded correctly. Removing the accent would
void the test. They are data, not prose.

If you find French anywhere else, translate it as you pass, in the same commit
as the work you came to do.

## Writing

Commit messages: a short title naming the subject, then a body explaining the
reason for the change rather than its content, which the diff already shows.

Never use an em dash, in code, in documentation, or in answers.

Commit directly on `main`, with no branch and no pull request: one author,
deployment from a workstation, and what runs in production has to be what `main`
contains.
