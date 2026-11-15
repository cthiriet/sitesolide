#!/bin/sh
#
# Builds Caddy with a DNS provider's module, from pinned versions alone, on
# the machine that will run it, as root:
#
#   sh build.sh <module package> <module id> <output>
#   sh build.sh github.com/caddy-dns/cloudflare dns.providers.cloudflare /var/tmp/caddy.new
#
# `sitesolide setup` runs it to install /usr/bin/caddy, and upgrading Caddy by
# hand runs it to make the binary that replaces it (docs/upgrading.md):
#
#   ssh <server> 'sudo sh -s github.com/caddy-dns/cloudflare dns.providers.cloudflare /var/tmp/caddy.new' < infra/caddy/build.sh
#
# WHY HERE, AND NOT FROM CADDY'S BUILD SERVICE. `caddy add-package` and the
# download API of caddyserver.com hand back a binary built by a remote service,
# which nothing can check: that binary then sees every TLS connection in the
# clear and Cloudflare's token in its environment. Built here, every byte
# comes from a pinned version that Go verifies: Debian's golang-go, through
# apt's signatures; the toolchain GO_TOOLCHAIN names, xcaddy, Caddy and the
# module, each fetched from Go's proxy and checked against Go's checksum
# database, sum.golang.org, a public append-only log. A tampered version
# would fail that check, and nothing here turns it off.
#
# BUMPING A VERSION. Read the release notes, change the line below, commit it,
# then build with it: `bun bin/update-pins.ts` says which versions are newer than the
# pinned ones. GO_TOOLCHAIN has to satisfy the `go` line of Caddy's go.mod at
# CADDY_VERSION, the build fails otherwise.
#
# Go and everything it fetched are removed afterwards, the build failed or not:
# the machine keeps no compiler.
set -eu

CADDY_VERSION=v2.11.9
GO_TOOLCHAIN=go1.26.11
XCADDY_VERSION=v0.4.7

[ "$#" -eq 3 ] || { echo "usage: build.sh <module package> <module id> <output>" >&2; exit 2; }
module=$1
id=$2
output=$3

# One pinned version per DNS provider's module, which bin/tests/cli-pins.test.ts
# keeps in step with the providers of bin/cli/dns/.
case "$module" in
  github.com/caddy-dns/cloudflare) module_version=v0.2.4 ;;
  *) echo "build.sh: no pinned version for the module $module" >&2; exit 2 ;;
esac

APT="env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600"

# On disk: Debian 13's /tmp is a tmpfs of half the memory, which Go's module cache alone fills.
work=$(mktemp -d /var/tmp/sitesolide-caddy.XXXXXX)
had_go=no
dpkg-query -W -f='${Status}' golang-go 2>/dev/null | grep -q 'ok installed' && had_go=yes
cleanup() {
  status=$?
  rm -rf "$work"
  [ "$had_go" = yes ] || $APT purge -y -q --autoremove golang-go </dev/null >/dev/null 2>&1 || true
  exit $status
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[ "$had_go" = yes ] || $APT install -y -q --no-install-recommends golang-go </dev/null

echo "building Caddy $CADDY_VERSION with $module $module_version, Go $GO_TOOLCHAIN, xcaddy $XCADDY_VERSION: a few minutes"
(
  # Whatever the environment said, the proxy and the checksum database are
  # Go's own and nothing is exempt from them.
  unset GOFLAGS GOPRIVATE GONOPROXY GONOSUMDB GONOSUMCHECK GOINSECURE GOENV
  export HOME="$work" TMPDIR="$work" GOPATH="$work/go" GOCACHE="$work/cache" GOMODCACHE="$work/go/pkg/mod" CGO_ENABLED=0
  export GOTOOLCHAIN="$GO_TOOLCHAIN" GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org
  go install "github.com/caddyserver/xcaddy/cmd/xcaddy@$XCADDY_VERSION"
  "$GOPATH/bin/xcaddy" build "$CADDY_VERSION" --with "$module@$module_version" --output "$work/caddy"
) </dev/null

# What was built is what was asked for: the version, the module at its
# version, and the module registered.
"$work/caddy" version | grep -q "^$CADDY_VERSION " || { echo "build.sh: the binary is not Caddy $CADDY_VERSION" >&2; exit 1; }
"$work/caddy" build-info | grep -q "^dep[[:space:]]$module[[:space:]]$module_version[[:space:]]" || { echo "build.sh: the binary does not carry $module $module_version" >&2; exit 1; }
"$work/caddy" list-modules | grep -q "^$id\$" || { echo "build.sh: the binary does not list $id" >&2; exit 1; }

install -m 0755 "$work/caddy" "$output"
echo "built: $output ($("$output" version | cut -d' ' -f1), sha256 $(sha256sum "$output" | cut -d' ' -f1))"
