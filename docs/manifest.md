# The manifest

`sitesolide.json`, at the root of a project, is the only configuration file a
project has. It is committed in your repository and dropped as-is at the root of
the project on the machine, where the domain table and the lock generator read
it back.

An unknown key is refused, never ignored. A typo on `portal` or `lock` would
deploy an open site its author believes is closed.

## The smallest ones

A static site:

```json
{ "slug": "blog", "publicDir": "public" }
```

An app:

```json
{
  "slug": "api",
  "port": 3030,
  "start": "/usr/local/bin/bun run server.ts",
  "publicDir": "public"
}
```

`start` is what decides: a project that declares one is an app and gets a
systemd unit and a Caddy block; a project without one is a folder Caddy serves
directly, and costs nothing at rest.

The language does not matter. `start` is whatever runs your server, as long as
it listens on `port`: `/usr/bin/node server.js`, the `uvicorn` of a virtualenv
under `/srv/sites/<slug>/app/.venv`, a Go binary built on your workstation.

## Every key

### `slug` (required)

The project's name, and the only one it has. It becomes a DNS label
(`<slug>.<zone>`), a directory (`/srv/sites/<slug>`), a system account
(`site-<slug>`) and, for an app, a systemd unit.

Lowercase letters, digits and hyphens, not starting or ending with a hyphen, 63
characters at most. `landing` is refused: it is reserved for the project that
serves the bare domain.

So are the names of the services the machine runs, `caddy`, `ssh`, `cron`,
`nftables` and the others `isSystemName` lists in `bin/cli/manifest.ts`, every
`systemd-*` and `sitesolide-*`, and `www`, which the landing serves. A unit laid
in `/etc/systemd/system` under such a name would replace the system's own, which
lives in `/lib/systemd/system`. For the names no list foresees, `deploy` asks
systemd itself before writing anything, and stops when it already knows a unit of
that name that deploy did not write and that does not serve
`/srv/sites/<slug>`. `--force` does not lift that refusal.

### `description`

One line, shown by `systemctl status` and in the dashboard. Without it, the unit
says `Project <slug>`. No control character, and no backslash at the end, which
systemd would read as a line continuation; a `%` is written as `%%`, so systemd
shows it as it is.

### `source`

Where the code lives, when it is not beside the manifest: a path relative to the
folder holding `sitesolide.json`.

```json
{ "slug": "mini-lab", "source": "../../mini-lab", "services": { ... } }
```

For a repository that should carry nothing about its deployment, an open-source
project for instance: the manifest stays in your sites repository, and
`sitesolide deploy` runs from there. The build, the exclusions, `publicDir` and
the upload all start from `source`; general access changed from the dashboard
is still written back into the manifest, where it lives. Never absolute, which would name
the workstation that wrote it.

From your sites repository, the one `sites` names in `config.json`, `source` may
lead anywhere. A manifest found anywhere else, a repository you just cloned, may
only point inside the repository that holds it, links resolved: a `source` of
`../../.ssh` would otherwise have its build run there and the folder uploaded.

### `publicDir`

The directory whose contents Caddy serves directly, relative to the project.
`public`, `dist`, `build/public`, whatever your build produces. A project with
no `start` must have one; there would be nothing to serve otherwise.

These files never wake the service, which is why a static site costs no memory.

### `build`

A command run on your workstation before anything is sent. Typically
`bun run build`, `npm run build`, a Tailwind compilation.

It runs locally on purpose: the machine has no toolchain, no `node_modules` and
no compiler, and does not need any.

`deploy --dry-run` shows it and does not run it: it is the folder's own code, and
a dry run is what an agent tries first on a folder it may have just cloned.
`--dry-run --build` runs it too, to check what it produces.

### `install`

A command run on the machine after the code arrives, typically
`bun install --production`. Only for dependencies that cannot be built
elsewhere; anything platform-independent belongs in `build`.

It runs in `app/` as the project's own account, `site-<slug>`, in a transient
unit with the walls of its service: the network but not the loopback, nothing
of `/srv` but `app/`, nothing of `/etc/sitesolide`, a throwaway `HOME`, 1G of
memory and fifteen minutes at most. That holds for a deployment over SSH as for
one through a token. A package manager runs lifecycle scripts, the
package's own and those of the dependencies it trusts, and they run there too,
never with the rights of the account that deploys. A step that writes outside
`app/`, needs root, or relies on a tool installed into `HOME` fails: it belongs
in `build`, or the tool on the machine.

### `start`

What systemd runs. An absolute path: the unit has a minimal `PATH` and nothing
to search.

```json
"start": "/usr/local/bin/bun run server.ts"
```

It is written into the unit's `ExecStart=`, and must start with the program
itself: a letter, a digit, `/`, `.` or `_` first. systemd reads a leading `+`,
`!`, `@`, `-`, `:` or `|` as an instruction, `+` and `!` as "run as root", and
these are refused, as a line break or a trailing backslash is. Quotes and
`$PORT` keep their systemd meaning; a `%` is written as `%%`, so it reaches the
program as it is.

**The site's root has to answer.** `deploy` ends by requesting
`https://<slug>.<zone>/`, and only a 200 counts, or the 401 of a locked
preview or of the portal. A 404 at `/` most often means nothing is served at
all, so it fails the deployment, even for an app whose other paths work: one
that answers only `/api/*`, say. For an app, the Caddy step then puts the
previous configuration back, over SSH as through a token, and its block
stays out; a static site's files stay in place, and the failure is reported.
Serve something at `/` that answers 200. An app without `routes` receives `/`
itself, even beside a `publicDir` holding an `index.html`, and must answer it;
with `routes`, or for a static site, `/` comes from `publicDir`, which then
needs its `index.html`. A redirect does not count either: `/` itself must
answer.

### `port`

The loopback port the service listens on, between 3000 and 3099. Caddy
reverse-proxies to it, and the unit hands it to the service as `PORT`.

Leave it out and `deploy` picks one: the lowest the machine's other projects
leave free, or the one the machine already gives this project. It writes it
into `sitesolide.json` and says so; commit it, so that every later deployment
keeps it. Only a project with a single `start` gets one this way; the other
commands refuse a manifest without a port until `deploy` has written it.

A port another project declares on the machine is refused, measured before the
build and again under the Caddy lock, just before the manifest is deposited, so
that two deployments running side by side cannot both take it. So are 3000 and
3001, the landing's and the shared service's, and the platform's own, 3022 for
the dashboard, 3026 for the portal and 3029 for analytics, whether they are
deployed yet or not.

That range is not arbitrary: a nftables rule reserves it to Caddy and root, so
no service can reach another one. Outside it, a service would be reachable by
every other project on the machine. A project of several processes declares a
port per service, see [`services`](#services).

### `routes`

The paths that go to the service; everything else is served from `publicDir`
without waking it.

```json
"routes": ["/api/*", "/webhook/*"]
```

Each one goes into a Caddy `path` matcher: a path starting with `/`, made of
letters, digits and `._~/*%-`, never under `/_portal`, which the portal owns.

Without this key, everything that is not a file on disk goes to the service.
With it, only these paths do. Use it when most of the site is static and only a
form or a webhook is dynamic. `/` is then served from `publicDir` unless a
route covers it, so `publicDir` needs its `index.html`: a 404 at the root fails
the deployment, see [`start`](#start).

### `services`

Several processes instead of one `start`: a web front, the API it calls, a
worker behind it. Each entry names a service and takes `start` and `port`, like
a single service, and optionally `routes`, `internal`, `memory`, `env` and
`backup`.

```json
"services": {
  "web":    { "start": "/srv/sites/lab/app/.venv/bin/python -m lab.web --port 3050", "port": 3050 },
  "api":    { "start": "/srv/sites/lab/app/.venv/bin/python -m lab.api --port 3051", "port": 3051, "routes": ["/v1/*"] },
  "worker": { "start": "/srv/sites/lab/app/.venv/bin/python -m lab.worker --port 3052", "port": 3052, "internal": true, "memory": "1G" }
}
```

- **Units.** The first service keeps the project's unit, `<slug>.service`; the
  others are `<slug>.<name>.service`, so a name starts with a letter and is
  never a systemd unit type such as `socket` or `timer`. They start with the first one and follow
  it when it stops or restarts, so restarting the project from the dashboard
  restarts all of them.
- **Routes.** A service with `routes` gets those paths. The one without takes
  every other path, or, next to a `publicDir`, every path that is not a file
  there. Two services whose routes could match the same request are refused,
  and without a `publicDir` exactly one public service must take the rest.
- **`internal`.** Caddy never reaches the service; only the project's other
  services do.
- **Ports.** Between 3000 and 3099, one per service. The loopback rule lets each
  project reach its own ports and nobody else's, so a service calls its
  siblings on `127.0.0.1:<port>`, and a neighbour cannot. A rule laid before
  this existed has no room for that: `deploy` refuses before pushing anything,
  and says to lay the current one with `bin/deploy-loopback.sh close`.
- **`memory` and `env`.** A service's own, added to the project's; its `env`
  wins over the project's on a shared name. `PORT` is each service's own.
- **`backup`.** A service that keeps a server database in the data folder,
  PostgreSQL or MongoDB, declares the folder it keeps live and the command
  that saves it consistently: see [A service's backup command](#a-services-backup-command).

`start`, `port` and `routes` are then refused at the top level. `install`,
`secrets`, `network`, `egress`, `connectors`, `exclude` and the directories
stay the project's, shared by every service.

A Python project installs its virtualenv on the machine with `install`. Tell
`uv` to use the system's Python: one it downloads lives under the deployment
account's home, which `ProtectHome` hides from the service, and the virtualenv
would point at nothing.

```json
"install": "/usr/local/bin/uv sync --frozen --no-dev --compile-bytecode --python-preference only-system"
```

### `env`

Environment variables for the service. Never a secret: this file is committed,
and validation refuses names that announce one.

```json
"env": { "NODE_ENV": "production", "PUBLIC_URL": "https://{slug}.{zone}" }
```

Three markers are replaced at deploy time: `{slug}`, `{zone}` and `{contact}`.
They are what let a committed manifest avoid naming your machine.

A value is one word for systemd: no space, quote, backslash or line break.
`Environment=` splits on spaces and unquotes, so `"x DATA_DIR=/elsewhere"`
would set a second variable; such a value is refused rather than half applied.
A `%` is written as `%%` and reaches the service as it is.

### `headers`

HTTP headers added by Caddy for this project.

```json
"headers": { "X-Robots-Tag": "noindex, nofollow" }
```

A project under the zone carries `noindex` by default until it moves to its own
domain, so that a preview never competes with the real site in search results.

Each value is written between double quotes in the project's Caddy block, so
it is printable ASCII without `"`, `\`, `{`, `}`, `$` or a backtick: Caddy
reads those as syntax, and `{$NAME}` or `{env.NAME}` as its own environment,
which would serve its secrets to every visitor. What real headers use stays
allowed: the single quotes, semicolons, colons, slashes and spaces of a
`Content-Security-Policy`, the parentheses of a `Permissions-Policy`, the angle
brackets of a `Link`. A name is letters, digits and dashes, starting with a
letter.

```json
"headers": { "Content-Security-Policy": "default-src 'self'; img-src 'self' data:" }
```

### `exclude`

Directories the upload leaves behind, on top of `.git` and the manifest.

```json
"exclude": ["node_modules", "data", "tests"]
```

`.git` and every file whose name starts with `.env` never leave, at any depth,
from the code nor from `publicDir`, whatever this list says: a history's
`.git/config` may carry a token, and a `.env` holds secrets by convention. The
deploy also removes them from the machine's `public/` when an earlier
deployment left them there, and Caddy answers 404 for those names in every
folder it serves.

`node_modules` matters: dependencies built on macOS, poured onto a Linux
machine, give a service that does not start, after erasing the one that worked.
The deploy refuses to run if it finds one on disk that you have not excluded.

### `memory`

The memory ceiling, as systemd's `MemoryMax` takes it: `256M`, `1G`. Defaults to
256M. A bare number would be read as bytes, so it is refused.

### `network`

- `localhost` (default): the service can only reach the loopback. Outbound
  connections and DNS are blocked.
- `outbound`: the service can reach the network.

The blocking also cuts DNS, whose resolvers are external. A service that needs
to call an API, a mail provider, a payment processor, needs `outbound`, or,
better, [`egress`](#egress) with the hosts it calls.

### `egress`

The hosts the service may reach, and no others.

```json
"egress": ["api.anthropic.com", "*.slack.com", "db.example.com:8443"]
```

The unit keeps the default network, the loopback alone, and points the
service's HTTP clients at the egress proxy (`HTTPS_PROXY`, `HTTP_PROXY`, in
both cases, and `NO_PROXY` for the loopback), which lets these hosts through
and refuses the rest with a sentence naming the host. Bun's `fetch`, curl, Go
and Python read those variables by themselves; Node's built-in `fetch` does
not, see [egress/README.md](../egress/README.md#which-clients-go-through-it).

- **Host names, never addresses.** Lowercase or not, with or without the final
  dot, international names in either form: they are compared in their ASCII
  form.
- **`*.example.com`** matches every subdomain, never `example.com` itself,
  which is listed on its own when wanted. A wildcard needs two labels after it.
  Over a domain where anyone gets a subdomain, `*.github.io`, it opens
  everything hosted there.
- **Ports**: 443 and 80 without one; any other is written in the entry, and
  then that port alone.
- **Every address a host resolves to is checked** by the proxy: one that points
  inside the machine or a private network, or at the cloud's metadata service,
  is refused.

Refused next to `"network": "outbound"`, which already reaches everything, and
on a static site, where nothing runs. The deployment refuses a project that
declares it, before pushing anything, while the egress proxy is not installed
on the machine. A change to the list applies at the service's next connection.
`HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`, in both spellings, then belong to
the deployment, and `env` may not set them.

### `connectors`

Credentials the machine lends the service without handing them over.

```json
"connectors": ["slack"]
```

An administrator defines `slack` on the dashboard's Connectors page, its base
address and the header that carries the credential, and grants it to the
project. The service calls

```
$SITESOLIDE_CONNECTORS/slack/chat.postMessage
```

in plain HTTP on the loopback, `http://127.0.0.1:3129/connectors/slack/...`,
and the egress proxy forwards it over HTTPS with the header set. The
credential appears in neither the repository, nor the unit, nor the service's
environment.

**Both are needed**: this key, which says the app asks, and the grant, which
says the administrator agrees. Either alone is refused. Names are lowercase
letters, digits and dashes, starting with a letter, and never `constructor`,
which every JavaScript object already carries. Works with either
`network`; refused on a static site. `SITESOLIDE_CONNECTORS` belongs to the
deployment.

### `secrets`

The environment files the service reads, from `/etc/sitesolide`.

```json
"secrets": ["api.env"]
```

Plain file names, no path: letters, digits, `.`, `_` and `-`, starting with a
letter or a digit. systemd reads them as root before dropping
privileges, so the service receives the variables without ever being able to
read the files. A project that declares none has the whole directory made
inaccessible, which hides even the file names.

Their values live on the machine and are managed from the dashboard. The
repository declares that a secret is expected, never what it contains.

### `domain`

The project's own domain, once it has one.

```json
"domain": { "name": "example.com", "aliases": ["www.example.com"], "active": true }
```

`active` is written by `sitesolide domain --activate`, not by hand: that command
also rebuilds the domain table, and without that step the certificate would
never be authorised. A domain under the served zone is refused, the wildcard
already covers it.

### `lock`

Not written by hand. It says the preview is closed behind a code, its general
access *Anyone with the code*, and the machine is its source of truth, as for
`portal`: the site's *Access* section in the dashboard, or `sitesolide lock`
in its folder, sets it on the machine with the code, and the next `sitesolide
deploy` writes it here, to commit. The code itself lives on the machine and
never enters the repository. `lock` and `portal` never go together.

### `portal` and `portalExempt`

```json
"portal": true,
"portalExempt": ["/webhook/*"]
```

`portal` makes the project's general access Restricted: Caddy asks the portal
before every request. `portalExempt` lists the paths that stay open to anyone,
guarded by the app alone: signed webhooks, mostly, which carry their own proof
and have no cookie.

**Who gets in** is not in the manifest: the owner's password, the admin emails,
and the project's people with access, given from the dashboard's *Access*
section or with `sitesolide share` ([commands.md](commands.md#access-to-a-project)),
each signing in with their company account or with password access. **The
service learns who came in** from three request headers the generated block
sets on every request that went through the portal:

| Header | Value |
|---|---|
| `X-Sitesolide-User` | the verified email, lowercase; absent for the owner's password and for password access |
| `X-Sitesolide-User-Name` | the display name, percent-encoded UTF-8; absent when unknown |
| `X-Sitesolide-Role` | `admin` for the owner's password and the admin emails; the person's role otherwise, `visitor` (Can open), `viewer`, `developer` or `admin`; `visitor` for password access. Before the access registry it read `member` or `guest`: an app that compared it with either must be updated |

The block takes any `X-Sitesolide-*` header the visitor sends off every request
first, exempted paths included, and their underscore spellings, so a protected
service can trust them. A public service gets none: its
block, and its customer domain's, take them off too, so it is never handed a
stranger's `X-Sitesolide-Role: admin`. A site deployed before these headers
existed, protected or not, keeps working, takes nothing off, and gains them at
its next `sitesolide deploy`. Reading them in a Bun service:
[portal/README.md](../portal/README.md#who-came-in-the-identity-headers).

**For a deployed project the machine is the source of truth.** General access
is set in the dashboard's *Access* section; `sitesolide deploy` reads what the
machine carries and rewrites the local manifest, which you then commit. Every command
refuses to contradict it: a repository that reopened a site the dashboard closed
would be the worst possible failure.

### `backup`

```json
"backup": false
```

Every app's `data/` folder is snapshotted by the machine every hour, once the
backup component is installed (see
[dashboard/src/backup/README.md](../dashboard/src/backup/README.md)), and can be
restored from the dashboard's *Backups* section. `false` keeps it out: a folder
that only holds a cache, or a copy of something kept elsewhere, need not take
room on the backups disk every hour.

`false` is the only value that keeps the data out: absent already means backed
up, and `true` would be a second way of writing it. A static site has no data
folder, so the key is refused there. The other value is an object, a
service's backup command, below.

### A service's backup command

The hourly snapshot copies every file of `data/` as it is, and every SQLite
database consistently. A server database is neither: PostgreSQL, MongoDB and
their kin write their files continuously, and a copy taken file by file while
they run reports success and restores a cluster that does not start, or starts
corrupt. A service that keeps one in the data declares how it is saved:

```json
"postgres": {
  "start": "/bin/sh /srv/sites/shop/app/postgres.sh",
  "port": 3081,
  "internal": true,
  "backup": { "folder": "postgres", "command": "/bin/sh /srv/sites/shop/app/postgres-backup.sh" }
}
```

- **`folder`**, relative to `data/`: the folder this service keeps live. The
  snapshot never archives its files. A name or a path of names, `postgres` or
  `db/main`, with no `..`, no `.` and no empty part; never the data folder
  itself, so a cluster lives in a folder of its own, not straight in
  `DATA_DIR`. Two services cannot declare the same folder, nor one inside the
  other.
- **`command`**, run just before the copy. **Its contract: leave in
  `$BACKUP_DIR`, an empty folder, a consistent copy that the service can start
  from as `folder`.** Exit 0 and a non-empty `$BACKUP_DIR` are required.
  The archive then holds that copy under `data/<folder>`, and a restore puts
  it back in place of the live folder, 0700 and the project's, as it was made.

The command follows the rules of `start`: it starts with the program, an
absolute path, never a prefix systemd reads as root, and `$NAME` is expanded
from its environment, by systemd, into the command line. A secret is
therefore read by the program from its environment, as the script below
does, never written as `$NAME` in the command, where its value would show in
the list of processes. It is one program and its arguments, quotes keeping
spaces in a word: no lone `;`, no escape but `\\`, `\"`, `\'`, `\s`, `\n` and
`\t`. Anything more belongs in a script, as in the recipe below.

It runs as the project's account, `site-<slug>`, in the walls of its service:
the same `app/` and `public/` read-only and `data/` writable, the same working
directory, `app/`, and its service's environment, `PORT`, `DATA_DIR`,
`PUBLIC_DIR` and `env` with its placeholders replaced, plus `BACKUP_DIR`,
which `env` may not set beside a backup command. Its secrets arrive as its
service's do, read by systemd from `/etc/sitesolide`, the folder itself hidden
from it. It reaches the loopback alone, whatever `network` says: enough to
talk to its service on its port, which the machine's loopback rule lets a
project's account do for its own ports and nobody else's; never the egress
proxy's variables. It shares the project's time in the run with the copy,
its share of a 25-minute window, 20 minutes at most, has its service's
`memory` and 128 MiB more for the program that runs it, and is stopped when
the disk comes down to the backup component's reserve. `$BACKUP_DIR` is on
disk, never in memory, under `/var/cache/sitesolide-backup/`. Its removal is
tried once the snapshot is over, for a few seconds; what it leaves, the next
run removes before the command runs again, whatever modes the command left.

The command may print what it likes: its last lines go to the journal, and
only how it exits decides. A server whose snapshot is written by the server
itself, through its own API, cannot write into `$BACKUP_DIR`, which the
service, read-only outside its data, does not reach: it writes into its data
folder, and the command copies the result into `$BACKUP_DIR`, then removes
it. A copy, not a rename, the two folders being different mounts.

A command that fails, runs past its time or leaves nothing fails that
project's snapshot, and says so in the dashboard and in the status file the
monitor reads; what it printed goes to the backup component's journal,
`journalctl -u sitesolide-backup`, never to the status file. The snapshot a
restore takes of the data it replaces runs no command: the services are
stopped, and the live folder is saved as its files.

A running PostgreSQL or MongoDB found in the data that no service declares
fails the snapshot, rather than archiving files that may not restore, and the
status says to declare this key. Any other server needs it just the same; the
backup component only knows how to recognise those two.

**In the form with one `start`**, the project's own `backup` takes the object,
as `start` and `port` are its single service's own:
`"backup": { "folder": "index", "command": "/srv/sites/search/app/snapshot" }`.
Under `services`, the top level keeps `false` alone, which refuses every
service's command.

A project that declares a backup command reaches its own ports through the
machine's loopback rule, like a project of several services: `deploy`
refuses it on a machine whose rule predates the project set, and says to lay
it again with `bin/deploy-loopback.sh close`. It also warns when the
machine's backup component predates backup commands, which it would then
ignore, the live folder still copied as files: `sitesolide upgrade` brings
it up to date.

#### PostgreSQL

Tested end to end by `dashboard/scripts/postgres-backup-proof.sh`, on Debian 13
and PostgreSQL 17: a snapshot taken while rows are written, restored by the
backup component, and PostgreSQL started on it with every row committed
before the backup, `pg_amcheck` finding no corruption. Its own cluster,
reached on the loopback, saved by `pg_basebackup`, whose plain copy with its
WAL PostgreSQL starts on as it is.

On the machine, once, as root: PostgreSQL's binaries without the shared
cluster Debian would create and start on port 5432 for everyone.

```bash
sudo apt install postgresql-common
sudo sed -i 's/^#\? *create_main_cluster.*/create_main_cluster = false/' /etc/postgresql-common/createcluster.conf
sudo apt install postgresql-17
pg_lsclusters    # lists none
```

The manifest:

```json
"services": {
  "web": { "start": "/usr/local/bin/bun run server.ts", "port": 3080 },
  "postgres": {
    "start": "/bin/sh /srv/sites/shop/app/postgres.sh",
    "port": 3081,
    "internal": true,
    "memory": "512M",
    "backup": { "folder": "postgres", "command": "/bin/sh /srv/sites/shop/app/postgres-backup.sh" }
  }
},
"secrets": ["shop.env"]
```

`shop.env`, from the dashboard's *Secrets*, holds `POSTGRES_PASSWORD`. The
web service reaches the database at `127.0.0.1:3081`.

`postgres.sh`, the service: the cluster in `data/postgres`, made at the first
start, TCP on the loopback only, no unix socket and no shared memory segment,
which the service's private `/dev` does not have.

```sh
#!/bin/sh
set -eu
PG_MAJOR=17
BIN="/usr/lib/postgresql/$PG_MAJOR/bin"
if [ ! -x "$BIN/postgres" ]; then
  echo "PostgreSQL $PG_MAJOR is not installed on this machine (apt install postgresql-$PG_MAJOR)" >&2
  exit 1
fi
PGDATA="$DATA_DIR/postgres"
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  umask 077
  pwfile="$DATA_DIR/.initdb-pw"
  printf '%s' "$POSTGRES_PASSWORD" > "$pwfile"
  "$BIN/initdb" -D "$PGDATA" -U app --pwfile="$pwfile" -A scram-sha-256 -E UTF8 --no-locale
  rm -f "$pwfile"
  echo "CREATE DATABASE app;" | "$BIN/postgres" --single -D "$PGDATA" -c dynamic_shared_memory_type=mmap postgres > /dev/null
fi
if [ "$(cat "$PGDATA/PG_VERSION")" != "$PG_MAJOR" ]; then
  echo "The cluster in $PGDATA is PostgreSQL $(cat "$PGDATA/PG_VERSION"), not $PG_MAJOR: upgrade it with pg_upgrade first" >&2
  exit 1
fi
exec "$BIN/postgres" -D "$PGDATA" \
  -c listen_addresses=127.0.0.1 -c port="$PORT" -c unix_socket_directories='' \
  -c dynamic_shared_memory_type=mmap -c shared_buffers=128MB -c max_connections=40
```

`postgres-backup.sh`, its backup command: the superuser that `initdb` made has
the replication right, and the `pg_hba.conf` it wrote lets it in from
`127.0.0.1` with its password.

```sh
#!/bin/sh
set -eu
export PGPASSWORD="$POSTGRES_PASSWORD"
exec /usr/lib/postgresql/17/bin/pg_basebackup -h 127.0.0.1 -p "$PORT" -U app --no-password \
  -D "$BACKUP_DIR" -X stream -c fast
```

`-X stream` puts the WAL written during the copy into it, which is what makes
it start; `-c fast` asks for the checkpoint at once rather than waiting for
the next. The cluster keeps no tablespace outside its folder: the copy leaves
links out. Restored, PostgreSQL replays the copy's WAL at its first start and
says `consistent recovery state reached` in its journal.

#### Other databases

The contract above is generic: any server whose own tool leaves a copy it can
start from fits it, MongoDB with its own dump or snapshot tool, a search
engine with its snapshot command. Only the PostgreSQL recipe has been tested
here; write and test a command for any other, a restore included, before
trusting it.
