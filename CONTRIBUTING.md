# Contributing

## How the repository is laid out

| Path | What it holds |
|---|---|
| `bin/` | The CLI and the deployment scripts. Runs from any directory, on any project. |
| `infra/` | Terraform for the machine, the Caddy configuration, and the systemd units of the services that serve the others. |
| `api/` | The shared service, deliberately tiny: the `ask` endpoint for on-demand TLS, and preview locks. |
| `dashboard/` | The dashboard, the steward that writes secrets as root, and the gatekeeper that touches Caddy. |
| `portal/` | The shared password for personal projects, and their guest access. |
| `analytics/` | Audience measurement: ingestion only, the numbers are read in the dashboard. |
| `docs/` | Install guide, concepts, manifest reference, commands, secrets. |
| `examples/` | Two projects to deploy as they are: a static site and a Bun app. |

The README's screenshots come from the dashboard's page bench, in its showcase
mode, with fictitious sites:

```bash
cd dashboard && bun run build
BENCH_SHOWCASE=1 bun scripts/page-bench.ts   # http://localhost:4322, password: demo
```

## Running the tests

Bun runs them. Each directory carries its own development dependencies, so a
fresh clone starts with `bun install` in the one you are working in:

```bash
bun install      # in the directory you are about to touch
```

Then:

```bash
bin/test.sh      # every service, plus the tools in bin/
bun test         # the current directory only
bun run check    # tests, then type checking
```

`bin/test.sh` adds one check `check` does not: `bin/deprecations.ts` reports
deprecated APIs. `tsc --noEmit` says nothing about those, a deprecation is a
suggestion diagnostic that only the language service produces, the one your
editor consults.

The tests need no machine. Everything that would talk to a server is faked: a
directory that stands in for `/srv/sites`, an `ssh` that only answers commands
it recognises and refuses everything else, and a hostname that resolves nowhere.
Two barriers, on purpose, a forgotten write is refused, and it would have been
aimed at a name that does not exist.

## What has to be tested

What decides, what validates, what refuses:

- input that came from a visitor, including the cases that are rejected
- path resolution, where a `..` must never escape the directory
- authorisation rules, the `ask` endpoint for on-demand TLS above all
- the cache policy, which must stay identical to the Caddyfile's

Static HTML and Tailwind layout are not tested.

## Writing testable code

A pure function needs no server. Decisions live in `src/`, and `server.ts` only
wires them onto routes. Anything that depends on time or on the disk takes its
clock or its path as a parameter rather than reading it itself.

## Never write to real data

`src/config.ts` freezes `DATA_DIR` at first import. Setting the variable inside
a test file is too late if another file already loaded the configuration, and
the tests would then write into the live database. The redirection belongs in
`tests/setup.ts`, preloaded by `bunfig.toml`, and the tests concerned check at
the top of the file that it happened.

## Bun

The whole repository runs on Bun, with no Node and no third-party bundler.
Before writing Bun code, read the page that covers it from
<https://bun.com/llms.txt> rather than trusting memory: the APIs move, and
yesterday's good practice is often replaced by a built-in primitive.

Prefer a native Bun API to a dependency or a Node equivalent, `Bun.file`,
`Bun.serve` and its `routes` object, `bun:sqlite`, `Bun.password`, `Bun.$`.

**The trap**: the official documentation still uses deprecated APIs, `db.exec`
first among them. `bin/deprecations.ts` is the judge of last resort.

## SQLite

SQLite's defaults come from a time when caution beat throughput, and **they do
not survive the connection closing**: a `PRAGMA` set once applies to that
connection only. Every database in this repository is opened through an
`openDatabase` function that applies them, never a bare `new Database`.

| Setting | Value | What it changes |
|---|---|---|
| `busy_timeout` | `10000` | wait ten seconds for a lock rather than returning `SQLITE_BUSY` |
| `journal_mode` | `WAL` | readers no longer block writers |
| `journal_size_limit` | `67108864` | truncates the `-wal` after checkpoint, 64 MB ceiling |
| `synchronous` | `NORMAL` | no `fsync` per commit, safe under WAL |
| `foreign_keys` | `ON` | without it, declared foreign keys are never checked |
| `temp_store` | `MEMORY` | temporary sorts and indexes in memory |
| `cache_size` | `-16000` | 16 MB cache ceiling, against 2 MB by default |

**Order matters: `busy_timeout` first.** The connection has to know how to wait
for a lock before the journal mode changes, or it fails on the spot if another
connection switches to WAL at that instant.

`synchronous = NORMAL` is the one setting that trades something away: a service
or kernel crash corrupts nothing, but a power cut can lose the last committed
transactions. That is the right trade for a contact form, not for accounting
data.

Each service checks in `tests/database.test.ts` that its connection really
carries these settings, by reading every `PRAGMA` back. Without that net, a
lost setting only shows up the day the database slows down.

## CSS

Tailwind CSS v4, configured from the stylesheet. **Do not create a
`tailwind.config.js`**, it no longer applies.

```css
@import "tailwindcss";

@theme {
  --color-ink: #0e1726;
  --font-sans: "Archivo", "Helvetica Neue", Arial, sans-serif;
}
```

Hand-written CSS is allowed only for what utilities cannot express, and only
inside `src/styles.css`: `@theme` tokens, `@utility` for a repeated pattern,
`@layer base` for bare elements, and `@keyframes`.

## Commits

Directly on `main`, no branches: a single author deploying from a workstation,
and what runs in production has to be what `main` contains.

A short title naming the subject, then a body explaining the reason for the
change rather than its content, which the diff already shows.

## Production has no safety net

One VM serves everything. There is no staging, no second machine, no automatic
recovery. What breaks production breaks every site at once.

**`caddy stop` and `caddy start` are forbidden on that machine.** They post to
the admin API on `127.0.0.1:2019`, that is to say to the running instance,
whatever `--config` you pass. A `caddy stop --config /tmp/test.caddy` stops
production. It happened once: 23 minutes of downtime, and the journal showed
nothing wrong, since from Caddy's point of view the shutdown was orderly.

| What you want | The command |
|---|---|
| Apply a configuration | `sudo systemctl reload caddy` |
| Start, restart, stop | `sudo systemctl <verb> caddy` |
| Stop a test instance | `pkill -f` on its command line |
| Check a configuration | `bin/deploy-caddy.sh`, which loads the environment the way systemd does |

Nothing is tried out on the machine that serves the sites. A configuration, a
port, an image: all of it is checked on the workstation first.
