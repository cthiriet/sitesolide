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

### `description`

One line, shown by `systemctl status` and in the dashboard. Without it, the unit
says `Project <slug>`.

### `source`

Where the code lives, when it is not beside the manifest: a path relative to the
folder holding `sitesolide.json`.

```json
{ "slug": "mini-lab", "source": "../../mini-lab", "services": { ... } }
```

For a repository that should carry nothing about its deployment, an open-source
project for instance: the manifest stays in your sites repository, and
`sitesolide deploy` runs from there. The build, the exclusions, `publicDir` and
the upload all start from `source`; a door changed from the dashboard is still
written back into the manifest, where it lives. Never absolute, which would name
the workstation that wrote it.

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

### `install`

A command run on the machine after the code arrives, typically
`bun install --production`. Only for dependencies that cannot be built
elsewhere; anything platform-independent belongs in `build`.

### `start`

What systemd runs. An absolute path: the unit has a minimal `PATH` and nothing
to search.

```json
"start": "/usr/local/bin/bun run server.ts"
```

### `port`

The loopback port the service listens on, between 3000 and 3099. Caddy
reverse-proxies to it, and the unit hands it to the service as `PORT`.

Leave it out and `deploy` picks one: the lowest the machine's other projects
leave free, or the one the machine already gives this project. It writes it
into `sitesolide.json` and says so; commit it, so that every later deployment
keeps it. Only a project with a single `start` gets one this way; the other
commands refuse a manifest without a port until `deploy` has written it.

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

Without this key, everything that is not a file on disk goes to the service.
With it, only these paths do. Use it when most of the site is static and only a
form or a webhook is dynamic.

### `services`

Several processes instead of one `start`: a web front, the API it calls, a
worker behind it. Each entry names a service and takes `start` and `port`, like
a single service, and optionally `routes`, `internal`, `memory` and `env`.

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

### `headers`

HTTP headers added by Caddy for this project.

```json
"headers": { "X-Robots-Tag": "noindex, nofollow" }
```

A project under the zone carries `noindex` by default until it moves to its own
domain, so that a preview never competes with the real site in search results.

### `exclude`

Directories the upload leaves behind, on top of `.git` and the manifest.

```json
"exclude": ["node_modules", "data", "tests"]
```

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
`HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` then belong to the deployment, and
`env` may not set them.

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
letters, digits and dashes, starting with a letter. Works with either
`network`; refused on a static site. `SITESOLIDE_CONNECTORS` belongs to the
deployment.

### `secrets`

The environment files the service reads, from `/etc/sitesolide`.

```json
"secrets": ["api.env"]
```

Plain file names, no path. systemd reads them as root before dropping
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

Written by `sitesolide lock`, not by hand. It says the preview is closed behind
a code; the code itself lives on the machine and never enters the repository.

### `portal` and `portalExempt`

```json
"portal": true,
"portalExempt": ["/webhook/*"]
```

`portal` puts the project behind the shared portal, which Caddy consults before
every request. `portalExempt` lists the paths that go straight through, signed
webhooks, mostly, which carry their own proof and have no cookie.

**Who gets in** is not in the manifest: the owner's password and guest access,
and, once the portal knows an identity provider, the people the site is shared
with from the dashboard's *Sharing* section. **The service learns who came in**
from three request headers the generated block sets on every request that went
through the portal:

| Header | Value |
|---|---|
| `X-Sitesolide-User` | the verified email, lowercase; absent for the owner's password and a guest |
| `X-Sitesolide-User-Name` | the display name, percent-encoded UTF-8; absent when unknown |
| `X-Sitesolide-Role` | `admin`, `member` or `guest` |

The block takes any `X-Sitesolide-*` header the visitor sends off every request
first, exempted paths included, so a protected service can trust them. A
service that is not behind the portal must not: it receives whatever the visitor
sends. A protected site deployed before these headers existed keeps working, and
gains them at its next `sitesolide deploy`. Reading them in a Bun service:
[portal/README.md](../portal/README.md#who-came-in-the-identity-headers).

**For a deployed project the machine is the source of truth.** The door is set
in the dashboard's *Access* section; `sitesolide deploy` reads what the machine
carries and rewrites the local manifest, which you then commit. Every command
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

`false` is the only value: absent already means backed up, and `true` would be
a second way of writing it. A static site has no data folder, so the key is
refused there.
