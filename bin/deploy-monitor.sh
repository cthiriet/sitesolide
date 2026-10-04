#!/usr/bin/env bash
#
# Installs or updates the monitor: its code built into one file, its unit and
# its timer. See monitor/README.md.
#
#   bin/deploy-monitor.sh
#
# Nothing watches the machine until this script has run once: the monitor is
# opt-in, and placing it changes nothing else. It touches neither Caddy, nor
# the dashboard, nor any site, and restarts nothing but itself.
#
# Like the steward, its code does not travel with the dashboard: it is built on
# the workstation and installed root:root under /usr/local/lib/sitesolide/, so
# the account that runs it cannot rewrite what it runs. A change to monitor/ or
# infra/monitor/ only counts on the machine after this script.
#
# In order: build, check the machine, install, verify the files, ONE run by
# hand, and only then enable the timer. A first run that fails stops here with
# its journal, and no timer repeats it every minute.
#
# The alerting is not set here. It lives in /etc/sitesolide/dashboard-monitor.env,
# root:root 0600, filled from the dashboard: see monitor/README.md, "Alerting".
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/bin/config.sh"
sitesolide_require_config
UNIT="sitesolide-monitor"
SOURCE="$REPO_ROOT/infra/monitor"
TARGET_JS="/usr/local/lib/sitesolide/monitor.js"
ALERTING="/etc/sitesolide/dashboard-monitor.env"
STATUS="/var/lib/sitesolide-monitor/status.json"

fail() {
  echo "!! $1" >&2
  shift
  for line in "$@"; do echo "   $line" >&2; done
  echo "   journal: ssh $SITESOLIDE_SERVER 'sudo journalctl -u $UNIT -n 50'" >&2
  exit 1
}

for file in "$SOURCE/$UNIT.service" "$SOURCE/$UNIT.timer"; do
  [ -f "$file" ] || { echo "not found: $file" >&2; exit 1; }
done

echo "-> local build"
LOCAL="$(mktemp -d)"
trap 'rm -rf "$LOCAL"' EXIT
(cd "$REPO_ROOT/monitor" && bun build monitor.ts --target=bun --outfile "$LOCAL/monitor.js" > /dev/null)
[ -s "$LOCAL/monitor.js" ] || { echo "!! bun build produced nothing" >&2; exit 1; }
FINGERPRINT="$(shasum -a 256 < "$LOCAL/monitor.js" | cut -d' ' -f1)"
echo "   monitor.js, fingerprint ${FINGERPRINT:0:12}"

echo "-> preliminary check"
# The zone file has no dash in the unit: missing, the unit would fail at every
# start. It is the one bin/deploy-caddy.sh places for Caddy.
if ! ssh -n "$SITESOLIDE_SERVER" "test -x /usr/local/bin/bun && test -x /usr/bin/systemctl && test -f /etc/caddy/sitesolide.env"; then
  echo "!! /usr/local/bin/bun, /usr/bin/systemctl or /etc/caddy/sitesolide.env missing from the machine" >&2
  echo "   /etc/caddy/sitesolide.env is placed by bin/deploy-caddy.sh" >&2
  exit 1
fi

# The alerting file, when there is one, is root's alone: PID 1 reads it before
# the monitor's account exists, and the steward manages it under that rule.
# Anything else is corrected by hand, knowing why it differed.
alerting="$(ssh -n "$SITESOLIDE_SERVER" "sudo stat -c '%u %a %F' $ALERTING 2>/dev/null || echo missing")"
case "$alerting" in
  missing)
    echo "   no $ALERTING: the monitor will write to the journal only"
    echo "   to alert, see monitor/README.md, \"Alerting\""
    ;;
  "0 600 regular file")
    echo "   alerting set in $ALERTING"
    ;;
  *)
    echo "!! $ALERTING is '$alerting', expected 0 600 regular file (root:root 0600)" >&2
    echo "   to run yourself, after checking: ssh $SITESOLIDE_SERVER 'sudo chown root:root $ALERTING && sudo chmod 600 $ALERTING'" >&2
    exit 1
    ;;
esac

echo "-> sending"
# A folder whose name is drawn by mktemp rather than predictable: what comes out
# of it is installed as root.
REMOTE="$(ssh -n "$SITESOLIDE_SERVER" "mktemp -d")"
rsync -a "$LOCAL/monitor.js" "$SOURCE/$UNIT.service" "$SOURCE/$UNIT.timer" "$SITESOLIDE_SERVER:$REMOTE/"

echo "-> installation"
ssh -n "$SITESOLIDE_SERVER" "
  set -e
  sudo install -D -m 0644 -o root -g root $REMOTE/monitor.js $TARGET_JS
  sudo install -m 0644 -o root -g root $REMOTE/$UNIT.service /etc/systemd/system/$UNIT.service
  sudo install -m 0644 -o root -g root $REMOTE/$UNIT.timer /etc/systemd/system/$UNIT.timer
  rm -rf $REMOTE
  sudo systemctl daemon-reload
"

echo "-> verifications"
installed="$(ssh -n "$SITESOLIDE_SERVER" "sha256sum $TARGET_JS" | cut -d' ' -f1)"
[ "$installed" = "$FINGERPRINT" ] || fail "the installed file does not match the local build"

verification="$(ssh -n "$SITESOLIDE_SERVER" "sudo systemd-analyze verify /etc/systemd/system/$UNIT.service /etc/systemd/system/$UNIT.timer 2>&1" || true)"
[ -z "$verification" ] || fail "systemd-analyze verify reports problems" "$verification"

echo "-> first run"
# By hand, once, before any timer: a oneshot's start returns when the run is
# over, with its verdict.
ssh -n "$SITESOLIDE_SERVER" "sudo systemctl start $UNIT.service" || fail "the first run failed"
result="$(ssh -n "$SITESOLIDE_SERVER" "systemctl show $UNIT.service -p Result --value")"
[ "$result" = "success" ] || fail "the first run ended with Result=${result:-nothing}"
ssh -n "$SITESOLIDE_SERVER" "sudo test -s $STATUS" || fail "the first run left no $STATUS"
echo "   $(ssh -n "$SITESOLIDE_SERVER" "sudo journalctl -u $UNIT.service -n 1 -o cat --no-pager" || true)"

echo "-> timer"
ssh -n "$SITESOLIDE_SERVER" "sudo systemctl enable --now $UNIT.timer"
state="$(ssh -n "$SITESOLIDE_SERVER" "systemctl is-active $UNIT.timer" || true)"
[ "$state" = "active" ] || fail "$UNIT.timer is ${state:-unknown}, expected active"

echo "   installed, one run passed, timer active: a run every minute from now on"
echo "   the dashboard shows what is down within the minute the collector next passes"
