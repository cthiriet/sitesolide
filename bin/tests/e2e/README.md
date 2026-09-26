# End-to-end tests for the CLI

They check that a project **living outside this repository** deploys as well as
one inside it: that is the whole reason `bin/sitesolide.ts` exists, and nothing
else covers it. The tests in `bin/tests/cli-*.test.ts` check the functions that
decide; these run the CLI for real, from a directory that has nothing to do with
the platform.

```bash
bun test bin/tests/e2e/deployment.test.ts    # everything, without touching a machine
E2E_VM=1 bun test bin/tests/e2e/vm.test.ts   # a real deployment, static
E2E_VM=1 E2E_VM_APP=1 bun test bin/tests/e2e/vm.test.ts
```

`bin/test.sh` runs the first file with the rest. The second never runs on its
own: there is no staging environment and no second machine.

## What only a machine can tell you

`vm.test.ts` carries tests that dry-run mode cannot replace: an app never placed
on the machine, deployed by the single `deploy` command, and that same
deployment run again, which must place and reload nothing. Then a project with a
secret: `deploy` finds it present and pushes nothing, the machine being the
source of truth. Dry-run reads nothing on the machine, so nothing would say whether the
unit or the secret were really missing.

## What protects production

The ordinary tests pass `--dry-run`, which prints the commands instead of
running them, **and** receive a `SITESOLIDE_SERVER` that does not resolve. The second
barrier is not decorative: it makes a code path that forgot dry-run fail loudly,
instead of letting it talk to the machine that serves the sites.

## The fake machine

Even in dry-run, `deploy` reads the deployed manifest on the machine: the portal
door of a deployed site is set from the dashboard, and the machine is the source
of truth. A dry-run test therefore gets a fake machine (`fake-vm.ts`): a
directory standing in for `/srv/sites` and `/etc/caddy/sites`, and a `PATH` in
which `ssh` and `rsync` are fakes. The fake ssh (`fake-ssh.ts`) answers only the
test host and only the reads it recognises word for word; it refuses everything
else, and logs every request into a journal the tests read back. Both barriers
still hold: a forgotten write is refused, and it would be aimed at a name that
does not resolve.

`portal-vm.test.ts` uses it to run `deploy`, including outside dry-run up to the
first refused write, which is how the block in service is compared for real,
and `bin/deploy-caddy.sh` from a temporary test repository, with the blocks the
test generates handed to it as a deployment would.

The lock the CLI and the scripts share with the dashboard's gatekeeper,
`/run/sitesolide-gatekeeper/caddy.lock`, is not faked either: its scripts run
against the fake machine's tree, and `caddy-lock.test.ts` checks that it is
taken before the read that decides and released on every path. To get that far,
a test can make writes succeed (`acceptWrites`, logged without running
anything), suspend a chosen command long enough to send a signal (`pause`), or
make the gatekeeper act on the first write (`onFirstAccepted`). The CLI's zone
then points at a `.invalid` name, so that the final verification reaches nobody.

## The projects

| Directory | What it covers |
|---|---|
| `projects/simple-site` | a folder of files, no build, no service |
| `projects/static-docs` | a build on the workstation, of which only `dist/` is sent |
| `projects/bun-mixed` | Caddy serves `public/`, the service gets the rest |
| `projects/own-domain` | a site waiting to switch to its own domain |
| `projects/fastapi-app` | Python, no static page, everything goes to the service |
| `projects/api-with-secret` | a declared secret, checked on the machine and never pushed, and outbound network |
| `projects/portal-mixed` | a project behind the portal, with an exempted path |

## The rejections

`rejects/` holds projects that **must** fail, and they matter as much as the
others: a CLI that deploys what it should refuse breaks production, where a CLI
that refuses wrongly costs a minute.

| Directory | What has to be refused |
|---|---|
| `landing-slug` | the landing project, reserved for the site on the bare domain, which `deploy` does not handle |
| `port-missing` | a service with no port, which Caddy could not reach |
| `path-escapes` | a `publicDir` of `../..`, which would send anything at all |
| `public-empty` | an empty directory, whose `rsync --delete` would erase the site |
| `deps-not-excluded` | a `node_modules` from the workstation, poured onto a Linux machine |

Two of these directories are produced by the test itself, the empty `public/`
and the fake `node_modules`: committed, the repository's `.gitignore` would
swallow them and the tests would pass without checking anything.

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
  sudo rm -rf /srv/sites/$slug
  sudo userdel site-$slug 2>/dev/null || true
done
sudo systemctl reload caddy
'
```

The next `bin/deploy-caddy.sh` reports on its own the blocks left on the machine
whose site is gone.
