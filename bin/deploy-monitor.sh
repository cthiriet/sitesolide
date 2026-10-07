#!/usr/bin/env bash
#
# Installs or updates the monitor: its code built into one file, its unit and
# its timer. See monitor/README.md.
#
#   bin/deploy-monitor.sh
#   bin/deploy-monitor.sh --fingerprint   what it would install, nothing sent
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
# In order: build, check the machine, make the account and hand it its state,
# install, verify the files, ONE run by hand, and only then enable the timer. A
# first run that fails stops here with its journal, and no timer repeats it
# every minute.
#
# The alerting is not set here. It lives in /etc/sitesolide/dashboard-monitor.env,
# root:root 0600, filled from the dashboard: see monitor/README.md, "Alerting".
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/bin/config.sh"
sitesolide_require_config
UNIT="sitesolide-monitor"
# The account the unit names in User= and Group=, and its group.
ACCOUNT="sitesolide-monitor"
SOURCE="$REPO_ROOT/infra/monitor"
TARGET_JS="/usr/local/lib/sitesolide/monitor.js"
ALERTING="/etc/sitesolide/dashboard-monitor.env"
STATE_DIR="/var/lib/sitesolide-monitor"
STATUS="$STATE_DIR/status.json"

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
  *) echo "usage: bin/deploy-monitor.sh [--fingerprint]" >&2; exit 2 ;;
esac

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
# The zone file has no dash in the unit: missing, the unit would fail at every
# start. It is the one bin/deploy-caddy.sh places for Caddy.
if ! ssh -n "$SITESOLIDE_SERVER" "test -x /usr/local/bin/bun && test -x /usr/bin/systemctl && test -f /etc/caddy/sitesolide.env"; then
  echo "!! /usr/local/bin/bun, /usr/bin/systemctl or /etc/caddy/sitesolide.env missing from the machine" >&2
  echo "   /etc/caddy/sitesolide.env is placed by bin/deploy-caddy.sh" >&2
  exit 1
fi

# The alerting file, when there is one, is root's alone: PID 1 reads it before
# it drops to the monitor's account, and the steward manages it under that rule.
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

echo "-> account"
# The unit runs as a static system account rather than DynamicUser=yes, whose
# dynamic uid dbus-daemon cannot resolve (the unit says why). Nothing makes it
# on a fresh machine, and systemd would fail every start with 217/USER: it is
# made here when missing, before the unit that names it is installed, and
# nothing changes on a machine that has it. Its own group, which the unit
# names, no home and no login shell.
#
# SYSTEMD_NSS_DYNAMIC_BYPASS=1, the very setting that blinds dbus-daemon, keeps
# both the reading and useradd to the static accounts: while the DynamicUser
# unit runs a pass, its dynamic account bears this same name, and without it
# getent would report that account as existing and useradd would refuse to
# make it.
account="$(ssh -n "$SITESOLIDE_SERVER" "SYSTEMD_NSS_DYNAMIC_BYPASS=1 getent passwd $ACCOUNT || echo missing")"
if [ "$account" = "missing" ]; then
  ssh -n "$SITESOLIDE_SERVER" "sudo env SYSTEMD_NSS_DYNAMIC_BYPASS=1 useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin $ACCOUNT"
  echo "   $ACCOUNT created"
else
  echo "   $ACCOUNT exists, uid $(echo "$account" | cut -d: -f3)"
fi

echo "-> state"
# A machine that ran the DynamicUser unit keeps the state in
# /var/lib/private/sitesolide-monitor, behind a link. systemd moves it back up
# at the new unit's first start, but under systemd 257 the DynamicUser unit
# left it to the nobody user, and systemd does not chown such a directory: it
# ID-maps it into the namespace, and on the host it stays nobody's, open to
# whatever else runs as nobody once no 0700 directory of root's stands in
# front of it. So it is handed to the account here, through the link, before
# the new unit is in place, and systemd finds it already the account's. Owned
# by anyone else, an older systemd's dynamic uid included, it is handed over
# the same way. chown -R follows no link below the directory it is given.
state="$(ssh -n "$SITESOLIDE_SERVER" "sudo stat -L -c '%U:%G' $STATE_DIR 2>/dev/null || echo missing")"
case "$state" in
  missing)
    echo "   no state yet: the first run makes $STATE_DIR, the account's"
    ;;
  "$ACCOUNT:$ACCOUNT")
    echo "   $STATE_DIR is the account's"
    ;;
  *)
    ssh -n "$SITESOLIDE_SERVER" "sudo chown -R $ACCOUNT:$ACCOUNT $STATE_DIR/"
    echo "   $STATE_DIR was $state, handed to $ACCOUNT with the state it holds"
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
# A plain directory of the account's, no longer a link into /var/lib/private:
# what the collector compares status.json's owner to, and what nothing else
# on the machine can write.
layout="$(ssh -n "$SITESOLIDE_SERVER" "sudo stat -c '%F %U:%G' $STATE_DIR" || true)"
[ "$layout" = "directory $ACCOUNT:$ACCOUNT" ] || fail "$STATE_DIR is '${layout:-nothing}', expected a directory of $ACCOUNT:$ACCOUNT"
echo "   $(ssh -n "$SITESOLIDE_SERVER" "sudo journalctl -u $UNIT.service -n 1 -o cat --no-pager" || true)"

echo "-> timer"
ssh -n "$SITESOLIDE_SERVER" "sudo systemctl enable --now $UNIT.timer"
state="$(ssh -n "$SITESOLIDE_SERVER" "systemctl is-active $UNIT.timer" || true)"
[ "$state" = "active" ] || fail "$UNIT.timer is ${state:-unknown}, expected active"

echo "   installed, one run passed, timer active: a run every minute from now on"
echo "   the dashboard shows what is down within the minute the collector next passes"
