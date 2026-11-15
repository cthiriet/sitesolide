#!/usr/bin/env bash
#
# Installs or updates the collector, the root timer that snapshots the machine
# for the dashboard: its code built into one file, its unit and its timer.
#
#   bin/deploy-collector.sh
#   bin/deploy-collector.sh --fingerprint   what it would install, nothing sent
#
# Like the steward and the monitor, its code does not travel with the
# dashboard: dashboard/collector.ts and what it imports are built on the
# workstation and installed root:root under /usr/local/lib/sitesolide/, so
# neither the dashboard's account nor a deployment of the dashboard can
# rewrite what root runs every minute. A change to collector.ts, to a module
# it imports or to infra/collector/ only counts on the machine after this
# script, which `sitesolide upgrade` runs when the fingerprints differ.
#
# To be run AFTER the dashboard's first `sitesolide deploy`: the snapshot is
# written into the dashboard's data folder and handed to its account, and the
# unit's ReadWritePaths fails without that folder.
#
# In order: build, check the machine, install, verify the files, ONE run by
# hand, and only then enable the timer. A first run that fails stops here with
# its journal, and no timer repeats it every minute.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/bin/config.sh"
sitesolide_require_config
UNIT="sitesolide-collector"
SOURCE="$REPO_ROOT/infra/collector"
TARGET_JS="/usr/local/lib/sitesolide/collector.js"
DATA_DIR="/srv/sites/dashboard/data"
STATE="$DATA_DIR/state.json"

fail() {
  echo "!! $1" >&2
  shift
  for line in "$@"; do echo "   $line" >&2; done
  echo "   journal: ssh $SITESOLIDE_SERVER 'sudo journalctl -u $UNIT -n 50'" >&2
  exit 1
}

FINGERPRINT_ONLY=""
case "${1:-}" in
  "") ;;
  --fingerprint) FINGERPRINT_ONLY=yes ;;
  *) echo "usage: bin/deploy-collector.sh [--fingerprint]" >&2; exit 2 ;;
esac

for file in "$SOURCE/$UNIT.service" "$SOURCE/$UNIT.timer"; do
  [ -f "$file" ] || { echo "not found: $file" >&2; exit 1; }
done

echo "-> local build"
LOCAL="$(mktemp -d)"
trap 'rm -rf "$LOCAL"' EXIT
# The borrowings first: they are not versioned, and the bundle embeds the
# CLI's manifest reader and unit names.
sitesolide_borrow dashboard
(cd "$REPO_ROOT/dashboard" && bun build collector.ts --target=bun --outfile "$LOCAL/collector.js" > /dev/null)
[ -s "$LOCAL/collector.js" ] || { echo "!! bun build produced nothing" >&2; exit 1; }
FINGERPRINT="$(shasum -a 256 < "$LOCAL/collector.js" | cut -d' ' -f1)"
echo "   collector.js, fingerprint ${FINGERPRINT:0:12}"

# --fingerprint: builds, prints what it would install as sha256sum prints it,
# the local fingerprint then the path on the machine, and stops there, before
# any connection. `sitesolide upgrade` compares those lines with the machine.
if [ -n "$FINGERPRINT_ONLY" ]; then
  echo "$FINGERPRINT  $TARGET_JS"
  sitesolide_fingerprint "$SOURCE/$UNIT.service" "/etc/systemd/system/$UNIT.service"
  sitesolide_fingerprint "$SOURCE/$UNIT.timer" "/etc/systemd/system/$UNIT.timer"
  exit 0
fi

echo "-> preliminary check"
# The zone file has no dash in the unit, and the data folder is its
# ReadWritePaths: either missing, every start would fail.
if ! ssh -n "$SITESOLIDE_SERVER" "test -x /usr/local/bin/bun && test -x /usr/bin/systemctl && test -f /etc/caddy/sitesolide.env"; then
  fail "/usr/local/bin/bun, /usr/bin/systemctl or /etc/caddy/sitesolide.env missing from the machine" \
    "/etc/caddy/sitesolide.env is placed by bin/deploy-caddy.sh"
fi
if ! ssh -n "$SITESOLIDE_SERVER" "sudo test -d $DATA_DIR"; then
  fail "$DATA_DIR missing" "run first: cd dashboard && sitesolide deploy"
fi

echo "-> sending"
# A folder whose name is drawn by mktemp rather than predictable: what comes out
# of it is installed as root.
REMOTE="$(ssh -n "$SITESOLIDE_SERVER" "mktemp -d")"
rsync -a "$LOCAL/collector.js" "$SOURCE/$UNIT.service" "$SOURCE/$UNIT.timer" "$SITESOLIDE_SERVER:$REMOTE/"

echo "-> installation"
# The code before the unit that names it: a timer firing in between still
# runs the unit in place, whichever code it names.
ssh -n "$SITESOLIDE_SERVER" "
  set -e
  sudo install -D -m 0644 -o root -g root $REMOTE/collector.js $TARGET_JS
  sudo install -m 0644 -o root -g root $REMOTE/$UNIT.service /etc/systemd/system/$UNIT.service
  sudo install -m 0644 -o root -g root $REMOTE/$UNIT.timer /etc/systemd/system/$UNIT.timer
  rm -rf $REMOTE
  sudo systemctl daemon-reload
"

echo "-> verifications"
installed="$(ssh -n "$SITESOLIDE_SERVER" "sha256sum $TARGET_JS" | cut -d' ' -f1)"
[ "$installed" = "$FINGERPRINT" ] || fail "the installed file does not match the local build"

permissions="$(ssh -n "$SITESOLIDE_SERVER" "stat -c '%a %U:%G' $TARGET_JS /etc/systemd/system/$UNIT.service /etc/systemd/system/$UNIT.timer" | sort -u)"
[ "$permissions" = "644 root:root" ] || fail "unexpected permissions on the code or the units: $permissions"

verification="$(ssh -n "$SITESOLIDE_SERVER" "sudo systemd-analyze verify /etc/systemd/system/$UNIT.service /etc/systemd/system/$UNIT.timer 2>&1" || true)"
[ -z "$verification" ] || fail "systemd-analyze verify reports problems" "$verification"

echo "-> first run"
# By hand, once, before any timer: a oneshot's start returns when the run is
# over, with its verdict. It also spares the dashboard announcing a stale
# snapshot just after the installation, which would read as a breakdown.
before="$(ssh -n "$SITESOLIDE_SERVER" "sudo stat -c %Y $STATE 2>/dev/null || echo 0")"
ssh -n "$SITESOLIDE_SERVER" "sudo systemctl start $UNIT.service" || fail "the first run failed"
result="$(ssh -n "$SITESOLIDE_SERVER" "systemctl show $UNIT.service -p Result --value")"
[ "$result" = "success" ] || fail "the first run ended with Result=${result:-nothing}"
after="$(ssh -n "$SITESOLIDE_SERVER" "sudo stat -c '%Y %U %a' $STATE 2>/dev/null || echo missing")"
case "$after" in
  missing) fail "the first run left no $STATE" ;;
  *" site-dashboard 600") ;;
  *) fail "$STATE is '$after' after the first run, expected site-dashboard's in 0600" ;;
esac
[ "${after%% *}" -ge "$before" ] || fail "the first run did not rewrite $STATE"
# The run's summary, not the journal's last line: systemd writes its own
# about the run, "Deactivated successfully" and "Finished", after it.
summary="$(ssh -n "$SITESOLIDE_SERVER" "sudo journalctl -u $UNIT.service -n 20 -o cat --no-pager" | grep -E '^[0-9]+ folders collected' | tail -n 1 || true)"
echo "   ${summary:-no summary in the journal: sudo journalctl -u $UNIT.service -n 20 says why}"

echo "-> timer"
ssh -n "$SITESOLIDE_SERVER" "sudo systemctl enable --now $UNIT.timer"
state="$(ssh -n "$SITESOLIDE_SERVER" "systemctl is-active $UNIT.timer" || true)"
[ "$state" = "active" ] || fail "$UNIT.timer is ${state:-unknown}, expected active"

echo "   installed, one run passed, timer active: a snapshot every minute from now on"
