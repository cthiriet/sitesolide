# End-to-end tests for the CLI

They run the CLI for real, from a directory that has nothing to do with the
platform; the tests in `bin/tests/cli-*.test.ts` check the functions that
decide. A project deploys through the dashboard's API, whose installer is
tried in `dashboard/tests/installer-*.test.ts` and whose client is tried in
`bin/tests/cli-remote.test.ts`. What runs here over SSH is what the owner's
access alone carries: `deploy` of a platform component, the dashboard or the
portal, which setup and upgrade lay from the kit (`deploysOverSsh` in
`bin/cli/remote.ts`), and the owner's commands, lock, domain, secrets,
remove, status, logs.

```bash
bun test bin/tests/e2e/deployment.test.ts    # everything, without touching a machine
E2E_VM=1 bun test bin/tests/e2e/vm.test.ts   # a real deployment, static
E2E_VM=1 E2E_VM_APP=1 bun test bin/tests/e2e/vm.test.ts
```

`bin/test.sh` runs the first file with the rest. The second never runs on its
own: there is no staging environment and no second machine.

## What only a machine can tell you

`vm.test.ts` carries tests that a fake machine cannot replace: an app never
placed on the machine, deployed by the single `deploy` command through the
API, with the token `sitesolide login` keeps, and that same deployment run
again, which must install nothing. Then a project with a runtime secret named
in its manifest: `deploy` lists the store, finds the value set and pushes
nothing, the machine being the source of truth.

## What protects production

The ordinary tests pass `--dry-run`, which prints the commands instead of
running them, **and** receive a `SITESOLIDE_SERVER` that does not resolve. The second
barrier is not decorative: it makes a code path that forgot dry-run fail loudly,
instead of letting it talk to the machine that serves the sites.

## The fake machine

Even in dry-run, `deploy` of a platform component reads the deployed manifest
on the machine, the source of truth, and refuses a door, a former name or a
`disabled` it would contradict. A dry-run test therefore gets a fake machine (`fake-vm.ts`): a
directory standing in for `/srv/sites` and `/etc/caddy/sites`, and a `PATH` in
which `ssh` and `rsync` are fakes. The fake ssh (`fake-ssh.ts`) answers only the
test host and only the reads it recognises word for word; it refuses everything
else, and logs every request into a journal the tests read back. Both barriers
still hold: a forgotten write is refused, and it would be aimed at a name that
does not resolve.

`portal-vm.test.ts` uses it to run `deploy` of a component, including outside
dry-run up to the first refused write, which is how the portal's block in
service is compared for real, and `bin/deploy-caddy.sh` from a temporary test
repository, with the blocks the test generates handed to it as a deployment
would. The component those tests deploy is `projects/component`, shaped as the
dashboard.

The lock the CLI and the scripts share with the dashboard's gatekeeper,
`/run/sitesolide-gatekeeper/caddy.lock`, is not faked either: its scripts run
against the fake machine's tree, and `caddy-lock.test.ts` checks that it is
taken before the read that decides and released on every path. To get that far,
a test can make writes succeed (`acceptWrites`, logged without running
anything), suspend a chosen command long enough to send a signal (`pause`), or
make the gatekeeper act on the first write (`onFirstAccepted`). The CLI's zone
then points at a `.invalid` name, so that the final verification reaches nobody.

One of the reads a deployment makes is answered from what the test lays, and
otherwise as a healthy machine would: how the services stand right after their
restart (`setStandings`), every one active and never restarted by default. The
second reading, ten seconds after the restart, comes after the verify, which a
simulated machine never passes: the decisions it takes are tried in
`bin/tests/cli-services.test.ts`.

The fake machine also carries static accounts. `bin/deploy-monitor.sh` reads
whether the account its unit runs as exists before making it, and the fake ssh
answers from the accounts the test lays (`addAccount`) and from those an
accepted `useradd` made, so that `deploy-monitor.test.ts` sees the account made
once, and a second run make nothing.

## The store of secrets

The steward's owner socket is faked like the access registry: `store.json`
in the VM's folder (`setStore`) holds, per project, the names of the
variables and files its store keeps, never a value. A listing is a reading,
always answered, as this release's steward, one from before the store (a 404
`no such route`) or one with no owner socket. A change is a write: refused
unless the test accepts writes, then applied by name and logged as
`STORE <method> <route> <slug> <names>`; the value or the file came on
standard input and is never recorded, which the tests check. The command
that lays a store's folders is logged as `STORE-PREPARE <slug>` and lays them
in the VM's tree, or answers as for a link in their place
(`refuseStorePrepare`); `refresh.test.ts` checks it comes before the units.
A deployment's store is the installer's.

## Setup

`setup.test.ts` runs `sitesolide setup` in front of the same fake machine:
the refusal of a configuration naming another zone before any connection, a
preflight that refuses another system after one read, and `--dry-run`, every
step checked through `sudo -n sh -s <tag>` and nothing run. Setup sends its
scripts on standard input; the fake ssh reads and drops them without recording
them, one of them carrying the Cloudflare token, and the tests check that the
token appears in no output and no command line. A full install does not run
here, since the fake answers a check the same way every time; that sequence
runs in `bin/tests/cli-setup.test.ts`, against a model of the machine whose
state is what the checks report.

## Upgrade

`upgrade.test.ts` runs `sitesolide upgrade` in front of the same fake machine:
a refusal with no configuration or an unknown option before any connection,
a machine without sitesolide refused after one read, and `--dry-run`, the
survey and each installed component's check sent through `sudo -n sh -s
upgrade:<component>:check`, answered from what the test lays, nothing run.
Its components measured from files alone, the Caddyfile and the shared
service's tree, need no build. The whole sequence, runs and failures included,
is `bin/tests/cli-upgrade.test.ts`'s, against the model machine of
`setup-fakes.ts`. The same file runs `deploy --dry-run --compare` in the
component's folder, as upgrade does: the deployment's two rsyncs in a dry run,
of the code and of `public/`, the only commands the fake accepts that are not
a recognised read, the deposited manifest, the units and the block read back.

## Refresh

`refresh.test.ts` runs `sitesolide refresh` in front of the same fake
machine, the manifests and the units laid in its tree: a unit of the previous
generation written, systemd reloaded and the service restarted, and nothing
else sent; a current unit, one edited by hand, a manifest that does not read,
none of them touching anything; `--all` in order, stopping at the first
project that fails; `--dry-run`; `--json`; a token refused. Its units are kept:
with `keepUnits`, an accepted write of a unit lays the text that came on
standard input in the tree, as the machine would, so that a second run reads
it back and finds it current. Every other accepted write still runs nothing.
A refresh that restarts a service goes on to the HTTPS check, which a zone
that resolves nowhere fails, as a deployment's does; the decisions, and the
summary a run that gets past it ends with, are `bin/tests/cli-refresh.test.ts`'s.

## Agents

`agents.test.ts` drives the CLI as an agent does: `--json`, whose standard
output must hold nothing but events and end with one `result` or one `error`,
a component's deployment and the reading commands; a folder without a
manifest, through `detect`. The folders it copies are the fixtures of
`bin/tests/infer/`, which `cli-infer.test.ts` reads too. What `deploy` infers
and the port the machine chooses, written back into `sitesolide.json`, are the
API's, tried in `bin/tests/cli-remote.test.ts`.

## The binary

`binary.test.ts` builds the binary this machine runs with `bin/build.ts`, then
runs it as a workstation without Bun would: a fresh HOME and cache, a PATH
with the system's tools and the fake ssh alone. It checks that the binary
names no path of the repository, that two builds of the same tree give the
same bytes, that `--version` and `--help` need nothing, that a command running
a script unpacks the kit once, read-only, and that the script finds `bun` in
it, and that the dashboard deploys from the kit as built at release time, from a
writable copy that leaves the kit untouched. `help.test.ts` holds `help` and
`--version` to the same promise from a checkout. See `bin/cli/kit.ts`.

## The projects

| Directory | What it covers |
|---|---|
| `projects/component` | a platform component shaped as the dashboard, the one project `deploy` lays over SSH |
| `projects/simple-site` | a folder of files, no build, no service |
| `projects/static-docs` | a build on the workstation, of which only `dist/` is sent |
| `projects/bun-mixed` | Caddy serves `public/`, the service gets the rest |
| `projects/own-domain` | a site waiting to switch to its own domain |
| `projects/fastapi-app` | Python, no static page, everything goes to the service |
| `projects/api-with-secret` | one runtime secret named in the manifest, `"secrets": ["API_KEY"]`, read from the project's store and never pushed, and outbound network |
| `projects/multi-service` | several services: a front, an API under `/v1`, an internal worker, whose units `cli-unit.test.ts` fingerprints |
| `projects/store-app` | secrets named in the manifest, two runtime variables and a file, kept in the project's store, which `sitesolide secrets` lists and sets over SSH |
| `projects/nightly` | every service scheduled, the main unit an anchor that runs nothing, whose timers `remove` takes down first |

What a deployment must refuse, a `publicDir` that escapes the folder, an empty
one, a `node_modules` from the workstation, a `source` pointing nowhere, is
tried on copies of `projects/component` that `deployment.test.ts` changes, and
for a project in front of the installer. The empty `public/` and the fake
`node_modules` are made by the test itself: committed, the repository's
`.gitignore` would swallow them and the tests would pass without checking
anything.

A manifest that no longer matches what runs is not a fixture any more: the
comparison is made against the machine, see `decideBlock` in
`bin/tests/cli-fragment.test.ts` and the block tests of `portal-vm.test.ts`.

## Cleaning up after a real test

In this order, **the Caddy fragments before the services**, or Caddy proxies to
a port where nothing listens any more and the address answers 502 instead of
falling back to the wildcard:

```bash
ssh you@your-machine '
for slug in sample-bun sample-api sample-secret; do
  sudo systemctl disable --now $slug 2>/dev/null || true
  sudo rm -f /etc/systemd/system/$slug.service
done
sudo systemctl daemon-reload
sudo rm -f /etc/caddy/sites/sample-*.caddy
for slug in sample-static sample-docs sample-bun sample-api sample-secret; do
  sudo rm -rf /srv/sites/$slug /etc/sitesolide/projects/$slug /var/lib/sitesolide-steward/precedents/projects/$slug
  sudo userdel site-$slug 2>/dev/null || true
done
sudo systemctl reload caddy
'
```

The next `bin/deploy-caddy.sh` reports on its own the blocks left on the machine
whose site is gone.
