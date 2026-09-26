#!/usr/bin/env bash
#
# Regenerates the table of client domains on the VM.
#
#   bin/generate-domains.sh
#
# To be run after any deployment that changes the `domain` of a manifest: it is
# that file, deposited at the project's root on the VM, that this table reads.
# "sitesolide domain --activate" runs it itself, that is the ordinary way of
# switching over, described in README.md; this script stays here for the global
# gesture. The table governs both the routing by Caddy and the authorisation by
# the `ask` endpoint: as long as it is not regenerated, the client's domain gets
# no certificate.
#
# The script holds the lock it shares with the dashboard's gatekeeper and the
# other gestures of the workstation, /run/sitesolide-gatekeeper/caddy.lock, from
# the reading of the manifests to the reload: it validates and reloads Caddy,
# and must not do so in the middle of a gatekeeper transaction, nor produce the
# table from manifests another gesture is in the process of changing. Released
# by the exit trap on every path. Launched by `sitesolide domain` or `remove`,
# which already hold it, it receives their line in CADDY_LOCK_HELD, checks it,
# and neither takes nor releases anything. See bin/cli/caddy-lock.ts.
#
# NEVER `caddy stop` nor `caddy start`: only systemctl reload applies a
# configuration. See the Production section of CLAUDE.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/bin/config.sh"
sitesolide_require_config

# The table goes through a file of our own on the workstation, and not through a
# shared /tmp/domaines.map that two runs would overwrite one another.
TABLE="$(mktemp)"
CADDY_LOCK=""
on_exit() {
  rm -f "$TABLE"
  if [ -n "$CADDY_LOCK" ]; then
    SITESOLIDE_SERVER="$SITESOLIDE_SERVER" bun "$REPO_ROOT/bin/portal-guard.ts" --lock release "$CADDY_LOCK" || true
    CADDY_LOCK=""
  fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -n "${CADDY_LOCK_HELD:-}" ]; then
  echo "-> Caddy lock: held by the caller ($CADDY_LOCK_HELD)"
  SITESOLIDE_SERVER="$SITESOLIDE_SERVER" bun "$REPO_ROOT/bin/portal-guard.ts" --lock verify "$CADDY_LOCK_HELD" || exit 1
else
  echo "-> Caddy lock"
  CADDY_LOCK="$(SITESOLIDE_SERVER="$SITESOLIDE_SERVER" bun "$REPO_ROOT/bin/portal-guard.ts" --lock take generate-domains $$)" || exit 1
fi

echo "-> generating from the sitesolide.json files"
ssh "$SITESOLIDE_SERVER" "/usr/local/bin/bun run /srv/api/current/scripts/generate-domains.ts" > "$TABLE"
rsync -a "$TABLE" "$SITESOLIDE_SERVER:/tmp/domaines.map"

echo "-> table produced"
sed 's/^/   /' "$TABLE"

# The table is installed before the validation: Caddy must see it in its final
# place to resolve the import of the `map` block. On failure, the old one is put
# back and Caddy has never been reloaded.
ssh "$SITESOLIDE_SERVER" '
  set -e
  sudo cp /etc/caddy/domaines.map /tmp/domaines.map.before 2>/dev/null || true
  sudo install -m 644 -o root -g root /tmp/domaines.map /etc/caddy/domaines.map
  if ! sudo bash -c "set -a; . /etc/caddy/cloudflare.env; set +a; caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile" >/dev/null 2>&1; then
    [ -f /tmp/domaines.map.before ] && sudo install -m 644 -o root -g root /tmp/domaines.map.before /etc/caddy/domaines.map
    echo "invalid configuration, previous table restored" >&2
    exit 1
  fi
  sudo systemctl reload caddy
'

echo "-> Caddy reloaded"
# Caddy is reloaded: the check that follows changes nothing, and has no reason
# to keep the gatekeeper waiting.
if [ -n "$CADDY_LOCK" ]; then
  SITESOLIDE_SERVER="$SITESOLIDE_SERVER" bun "$REPO_ROOT/bin/portal-guard.ts" --lock release "$CADDY_LOCK" || true
  CADDY_LOCK=""
fi
# sudo: the loopback rule only lets Caddy and root reach ports 3000 to 3099.
# Without it, this check failed after a successful reload and announced a
# failure that was not one. Measured on 15 September 2026, while removing three
# sites.
ssh "$SITESOLIDE_SERVER" "sudo curl -fsS http://127.0.0.1:3001/health && echo"
