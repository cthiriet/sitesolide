#!/usr/bin/env bash
#
# The backup component: hourly snapshots of every project's data folder, and
# the restore the dashboard asks for. See dashboard/src/backup/README.md.
#
#   bin/deploy-backup.sh install   builds, installs the code and the three units, starts nothing
#   bin/deploy-backup.sh enable    a first run by hand, its status read back, then the hourly timer
#   bin/deploy-backup.sh state     the timer, the last run, the room the snapshots take
#   bin/deploy-backup.sh --fingerprint   what install would lay, nothing sent
#
# Like the steward and the gatekeeper, its code does not travel with the
# dashboard: a root component that reads every project's data only changes by
# this deliberate gesture. `install` builds dashboard/backup.ts into one file,
# installs it as root:root under /usr/local/lib/sitesolide/, places
# sitesolide-backup.service, its timer and the sitesolide-restore@ template,
# creates /var/backups/sitesolide (0700) and /var/lib/sitesolide-backup, and
# reloads systemd. It enables nothing and starts nothing: until `enable`, the
# machine takes no snapshot, and a restore from the dashboard has nothing to
# restore.
#
# Run `install` BEFORE bin/deploy-steward.sh: the steward's unit makes
# /var/lib/sitesolide-backup writable for it, which only takes effect if the
# folder exists when the steward starts.
#
# NEVER `caddy stop` nor `caddy start`: nothing here touches Caddy.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/bin/config.sh"
sitesolide_require_config
UNITS=("sitesolide-backup.service" "sitesolide-backup.timer" "sitesolide-restore@.service")
TARGET_JS="/usr/local/lib/sitesolide/backup.js"
UNITS_FOLDER="/etc/systemd/system"
STATUS="/var/lib/sitesolide-backup/last-run.json"
MODE="${1:-}"

case "$MODE" in
  install|enable|state|--fingerprint) ;;
  *) sed -n '6,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac

fail() {
  echo "!! $1" >&2
  shift
  for line in "$@"; do echo "   $line" >&2; done
  echo "   journal: ssh $SITESOLIDE_SERVER 'sudo journalctl -u sitesolide-backup -n 50'" >&2
  exit 1
}

# A run or a restore in progress is left to finish: nothing here is urgent.
busy() {
  ssh -n "$SITESOLIDE_SERVER" "systemctl list-units --all --plain --no-legend --state=activating 'sitesolide-backup.service' 'sitesolide-restore@*' 2>/dev/null" || true
}

if [ "$MODE" = state ]; then
  ssh -n "$SITESOLIDE_SERVER" "
    systemctl list-timers --all --no-pager sitesolide-backup.timer || true
    echo
    sudo cat $STATUS 2>/dev/null || echo 'no run yet: $STATUS is missing'
    echo
    sudo du -sh /var/backups/sitesolide/* 2>/dev/null || echo 'no snapshot yet'
    echo
    df -h /var/backups | tail -1
  "
  exit 0
fi

if [ "$MODE" = enable ]; then
  if ! ssh -n "$SITESOLIDE_SERVER" "test -f $TARGET_JS && test -f $UNITS_FOLDER/sitesolide-backup.timer"; then
    fail "the component is not installed" "run first: bin/deploy-backup.sh install"
  fi
  in_progress="$(busy)"
  [ -z "$in_progress" ] || fail "a backup run or a restore is in progress, try again in a few minutes" "$in_progress"

  echo "-> first run, by hand: every project's data folder, then the status"
  # A oneshot: start waits for its end. It may take minutes on a first run, and
  # its exit code says whether every project was saved; the status says which.
  run_code=0
  ssh -n "$SITESOLIDE_SERVER" "sudo systemctl start sitesolide-backup.service" || run_code=$?
  status="$(ssh -n "$SITESOLIDE_SERVER" "sudo cat $STATUS" || true)"
  [ -n "$status" ] || fail "the run left no status in $STATUS"
  echo "$status"
  if [ "$run_code" -ne 0 ]; then
    fail "the first run did not save every project: read the errors above, fix them, then run enable again" \
      "the timer stays disabled until a run succeeds"
  fi

  echo "-> the hourly timer"
  ssh -n "$SITESOLIDE_SERVER" "sudo systemctl enable --now sitesolide-backup.timer"
  ssh -n "$SITESOLIDE_SERVER" "systemctl is-active sitesolide-backup.timer" > /dev/null || fail "sitesolide-backup.timer is not active"
  echo "   enabled: the next run comes within the hour"
  exit 0
fi

for unit in "${UNITS[@]}"; do
  [ -f "$REPO_ROOT/infra/backup/$unit" ] || fail "unit not found: $REPO_ROOT/infra/backup/$unit"
done

echo "-> local build"
LOCAL="$(mktemp -d)"
trap 'rm -rf "$LOCAL"' EXIT
# The borrowings first: they are not versioned, and the bundle embeds them.
sitesolide_borrow dashboard
(cd "$REPO_ROOT/dashboard" && bun build backup.ts --target=bun --outfile "$LOCAL/backup.js" > /dev/null)
[ -s "$LOCAL/backup.js" ] || fail "bun build produced nothing"
FINGERPRINT="$(shasum -a 256 < "$LOCAL/backup.js" | cut -d' ' -f1)"
echo "   backup.js, fingerprint ${FINGERPRINT:0:12}"

# --fingerprint: builds, prints what it would install as sha256sum prints it,
# the local fingerprint then the path on the machine, and stops there, before
# any connection. `sitesolide upgrade` compares those lines with the machine.
if [ "$MODE" = --fingerprint ]; then
  echo "$FINGERPRINT  $TARGET_JS"
  for unit in "${UNITS[@]}"; do sitesolide_fingerprint "$REPO_ROOT/infra/backup/$unit" "$UNITS_FOLDER/$unit"; done
  exit 0
fi

echo "-> preliminary check"
# Absolute paths of the units, and systemd-run with --pipe (systemd 235 and
# above): without it, a copy could not hand its archive back. /usr/bin/find
# tells the run whether a data folder is empty without listing it.
if ! ssh -n "$SITESOLIDE_SERVER" "test -x /usr/local/bin/bun && test -x /usr/bin/systemctl && test -x /usr/bin/systemd-run && test -x /usr/bin/find && test -d /srv/sites && test -f /etc/caddy/sitesolide.env && systemd-run --help | grep -q -- '--pipe'"; then
  fail "a prerequisite is missing on the machine" \
    "expected: /usr/local/bin/bun, /usr/bin/systemctl, /usr/bin/systemd-run with --pipe, /usr/bin/find, /srv/sites, /etc/caddy/sitesolide.env"
fi
in_progress="$(busy)"
[ -z "$in_progress" ] || fail "a backup run or a restore is in progress, try again in a few minutes" "$in_progress"

echo "-> sending"
# A folder whose name is drawn by mktemp rather than predictable: what comes out
# of it is installed as root.
REMOTE="$(ssh -n "$SITESOLIDE_SERVER" "mktemp -d")"
SOURCES=("$LOCAL/backup.js")
for unit in "${UNITS[@]}"; do SOURCES+=("$REPO_ROOT/infra/backup/$unit"); done
rsync -a "${SOURCES[@]}" "$SITESOLIDE_SERVER:$REMOTE/"

echo "-> installation"
ssh -n "$SITESOLIDE_SERVER" "
  set -e
  sudo install -D -m 0644 -o root -g root $REMOTE/backup.js $TARGET_JS
  for unit in ${UNITS[*]}; do
    sudo install -m 0644 -o root -g root \"$REMOTE/\$unit\" \"$UNITS_FOLDER/\$unit\"
  done
  sudo install -d -m 0700 -o root -g root /var/backups/sitesolide
  sudo install -d -m 0755 -o root -g root /var/lib/sitesolide-backup
  rm -rf $REMOTE
  sudo systemctl daemon-reload
"

echo "-> verifications, read only"
installed="$(ssh -n "$SITESOLIDE_SERVER" "sudo sha256sum $TARGET_JS" | cut -d' ' -f1)"
[ "$installed" = "$FINGERPRINT" ] || fail "the installed file does not match the local build"

paths="$TARGET_JS"
for unit in "${UNITS[@]}"; do paths="$paths '$UNITS_FOLDER/$unit'"; done
permissions="$(ssh -n "$SITESOLIDE_SERVER" "sudo stat -c '%a %U:%G' $paths" | sort -u)"
[ "$permissions" = "644 root:root" ] || fail "unexpected permissions on the code or the units: $permissions"
permissions="$(ssh -n "$SITESOLIDE_SERVER" "sudo stat -c '%a %U:%G' /var/backups/sitesolide")"
[ "$permissions" = "700 root:root" ] || fail "/var/backups/sitesolide is $permissions, expected 700 root:root"

# A template is only checked through an instance: the FILE:NAME syntax names
# it without creating or starting anything.
verification="$(ssh -n "$SITESOLIDE_SERVER" "sudo systemd-analyze verify '$UNITS_FOLDER/sitesolide-backup.service' '$UNITS_FOLDER/sitesolide-backup.timer' '$UNITS_FOLDER/sitesolide-restore@.service:sitesolide-restore@verification.service' 2>&1" || true)"
[ -z "$verification" ] || fail "systemd-analyze verify reports problems" "$verification"

if [ "$(ssh -n "$SITESOLIDE_SERVER" "systemctl is-enabled sitesolide-backup.timer 2>/dev/null" || true)" = "enabled" ]; then
  echo "   installed and verified; the timer was already enabled, the next run uses this code"
else
  echo "   installed and verified, nothing started, no snapshot taken"
  echo "   next: bin/deploy-steward.sh, then bin/deploy-backup.sh enable"
fi
