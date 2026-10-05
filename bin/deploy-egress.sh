#!/usr/bin/env bash
#
# Installs or updates the egress proxy, which lets each project reach the hosts
# its sitesolide.json lists under `egress`, and lends it the connectors the
# dashboard granted. See egress/README.md.
#
#   bin/deploy-egress.sh
#
# Like the steward, its code does not travel with any project: the script
# builds a single file on the workstation, installs it as root:root under
# /usr/local/lib/sitesolide/, creates the sitesolide-egress account and the
# connectors' folder if they are missing, sets the unit and restarts the proxy
# alone. It touches neither Caddy, nor the loopback rule, nor any site: a
# project's unit only points at the proxy once that project declares `egress`
# or `connectors` and is deployed again.
#
# The connectors are managed from the dashboard's Connectors page, through the
# steward, which writes /etc/sitesolide-egress: run bin/deploy-steward.sh after
# this script for that page to write.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/bin/config.sh"
sitesolide_require_config
UNIT="sitesolide-egress"
ACCOUNT="sitesolide-egress"
UNIT_SOURCE="$REPO_ROOT/infra/egress/$UNIT.service"
TARGET_JS="/usr/local/lib/sitesolide/egress.js"
CONFIG_DIR="/etc/sitesolide-egress"
PROXY_PORT=3128
CONNECTORS_PORT=3129

fail() {
  echo "!! $1" >&2
  shift
  for line in "$@"; do echo "   $line" >&2; done
  echo "   journal: ssh $SITESOLIDE_SERVER 'sudo journalctl -u $UNIT -n 50'" >&2
  exit 1
}

[ -f "$UNIT_SOURCE" ] || { echo "unit not found: $UNIT_SOURCE" >&2; exit 1; }

echo "-> local build"
LOCAL="$(mktemp -d)"
trap 'rm -rf "$LOCAL"' EXIT
(cd "$REPO_ROOT/egress" && bun build server.ts --target=bun --outfile "$LOCAL/egress.js" > /dev/null)
[ -s "$LOCAL/egress.js" ] || { echo "!! bun build produced nothing" >&2; exit 1; }
FINGERPRINT="$(shasum -a 256 < "$LOCAL/egress.js" | cut -d' ' -f1)"
echo "   egress.js, fingerprint ${FINGERPRINT:0:12}"

echo "-> preliminary check"
if ! ssh -n "$SITESOLIDE_SERVER" "test -x /usr/local/bin/bun && test -d /srv/sites"; then
  echo "!! /usr/local/bin/bun or /srv/sites missing from the machine" >&2
  exit 1
fi
# The two ports must be free, or already the proxy's: anything else listening
# there would receive every restricted project's traffic.
listening="$(ssh -n "$SITESOLIDE_SERVER" "ss -ltnH '( sport = :$PROXY_PORT or sport = :$CONNECTORS_PORT )'" || true)"
if [ -n "$listening" ] && ! ssh -n "$SITESOLIDE_SERVER" "systemctl is-active --quiet $UNIT"; then
  echo "!! something already listens on $PROXY_PORT or $CONNECTORS_PORT, and it is not $UNIT:" >&2
  echo "$listening" >&2
  exit 1
fi

echo "-> sending"
REMOTE="$(ssh -n "$SITESOLIDE_SERVER" "mktemp -d")"
rsync -a "$LOCAL/egress.js" "$UNIT_SOURCE" "$SITESOLIDE_SERVER:$REMOTE/"

echo "-> installation"
# The account has no shell and no home; the folder belongs to root, its group
# reads it, and only the steward, as root, writes the files in it.
ssh -n "$SITESOLIDE_SERVER" "
  set -e
  getent passwd $ACCOUNT > /dev/null || sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin $ACCOUNT
  sudo install -d -m 0750 -o root -g $ACCOUNT $CONFIG_DIR
  sudo install -D -m 0644 -o root -g root $REMOTE/egress.js $TARGET_JS
  sudo install -m 0644 -o root -g root $REMOTE/$UNIT.service /etc/systemd/system/$UNIT.service
  rm -rf $REMOTE
  sudo systemctl daemon-reload
  sudo systemctl enable $UNIT.service
  sudo systemctl reset-failed $UNIT.service 2>/dev/null || true
  sudo systemctl restart $UNIT.service
"

echo "-> verifications"
installed="$(ssh -n "$SITESOLIDE_SERVER" "sudo sha256sum $TARGET_JS" | cut -d' ' -f1)"
[ "$installed" = "$FINGERPRINT" ] || fail "the installed file does not match the local build"

permissions="$(ssh -n "$SITESOLIDE_SERVER" "sudo stat -c '%a %U:%G' $CONFIG_DIR")"
[ "$permissions" = "750 root:$ACCOUNT" ] || fail "$CONFIG_DIR is $permissions, expected 750 root:$ACCOUNT"

ready=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ssh -n "$SITESOLIDE_SERVER" "systemctl is-active --quiet $UNIT && ss -ltnH '( sport = :$PROXY_PORT )' | grep -q 127.0.0.1 && ss -ltnH '( sport = :$CONNECTORS_PORT )' | grep -q 127.0.0.1"; then
    ready="yes"
    break
  fi
  sleep 1
done
[ -n "$ready" ] || fail "$UNIT is not active, or does not listen on 127.0.0.1:$PROXY_PORT and :$CONNECTORS_PORT" \
  "state: $(ssh -n "$SITESOLIDE_SERVER" "systemctl is-active $UNIT" || true)"

# The identification under this very unit, which only the machine can prove:
# the dashboard's account gets 200 on /status, and only because the proxy read
# its uid in /proc/net/tcp and its name in /etc/passwd. Another account gets
# 403. An empty answer means the test did not run, and proves nothing.
if ssh -n "$SITESOLIDE_SERVER" "id -u site-dashboard > /dev/null 2>&1"; then
  code="$(ssh -n "$SITESOLIDE_SERVER" "sudo -u site-dashboard curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:$CONNECTORS_PORT/status" || true)"
  [ "$code" = "200" ] || fail "site-dashboard does not get 200 on /status (got: ${code:-nothing}): the proxy does not see who calls" \
    "check that the unit carries neither PrivateNetwork nor ProcSubset, and that ProtectProc leaves /proc/net readable"
else
  echo "   note: site-dashboard does not exist yet, the identification is checked with nobody alone"
fi
code="$(ssh -n "$SITESOLIDE_SERVER" "sudo -u nobody curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:$CONNECTORS_PORT/status" || true)"
[ "$code" = "403" ] || fail "nobody gets ${code:-nothing} on /status, expected 403"
# And the proxy itself: nobody is not a project, its CONNECT is refused.
code="$(ssh -n "$SITESOLIDE_SERVER" "sudo -u nobody curl -s -o /dev/null -w '%{http_connect}' --max-time 10 -x http://127.0.0.1:$PROXY_PORT https://example.com/" || true)"
[ "$code" = "403" ] || fail "nobody's CONNECT got ${code:-nothing}, expected 403"

echo "   active on 127.0.0.1:$PROXY_PORT and :$CONNECTORS_PORT, callers identified, others refused"
if ! ssh -n "$SITESOLIDE_SERVER" "grep -q '^ReadWritePaths=-$CONFIG_DIR' /etc/systemd/system/sitesolide-steward.service 2>/dev/null"; then
  echo "   note: the steward in service cannot write $CONFIG_DIR yet; run bin/deploy-steward.sh for the Connectors page"
fi
