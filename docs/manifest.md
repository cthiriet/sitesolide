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

The loopback port the service listens on, required as soon as `start` is
declared, between 3000 and 3099. Caddy reverse-proxies to it.

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
`secrets`, `network`, `exclude` and the directories stay the project's, shared
by every service.

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
to call an API, a mail provider, a payment processor, needs `outbound`.

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

**For a deployed project the machine is the source of truth.** The door is set
in the dashboard's *Access* section; `sitesolide deploy` reads what the machine
carries and rewrites the local manifest, which you then commit. Every command
refuses to contradict it: a repository that reopened a site the dashboard closed
would be the worst possible failure.
