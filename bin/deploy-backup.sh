#!/usr/bin/env bash
#
# The backup component: hourly snapshots of every project's data folder, and
# the restore the dashboard asks for. See dashboard/src/backup/README.md.
#
#   bin/deploy-backup.sh install   restic, its repository and key, the code and the three units; starts nothing
#   bin/deploy-backup.sh enable    a first run by hand, its status read back, then the hourly timer
#   bin/deploy-backup.sh state     the timer, the last run, the room the snapshots take
#   bin/deploy-backup.sh check     a run now that also prunes and checks the repositories, its status read back
#   bin/deploy-backup.sh --fingerprint   what install would lay, nothing sent
#
# Like the steward and the gatekeeper, its code does not travel with the
# dashboard: a root component that reads every project's data only changes by
# this deliberate gesture. `install` installs restic from Debian's archive if
# it is missing and refuses one older than 0.18.0, builds dashboard/backup.ts
# into one file, installs it as root:root under /usr/local/lib/sitesolide/,
# places sitesolide-backup.service, its timer and the sitesolide-restore@
# template, draws the repository's key once (/var/backups/sitesolide-restic.key,
# 0600, never shown), initialises the repository
# (/var/backups/sitesolide-restic, 0700) when restic says there is none,
# creates /var/backups/sitesolide and /var/lib/sitesolide-backup, and reloads
# systemd. It enables nothing and starts nothing: until `enable`, the machine
# takes no snapshot, and a restore from the dashboard has nothing to restore.
# On a machine that has archives of the format before restic, the next run
# imports them into the repository (dashboard/src/backup/legacy.ts).
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
REPOSITORY="/var/backups/sitesolide-restic"
KEY="/var/backups/sitesolide-restic.key"
# The oldest restic this component was measured with: Debian 13's.
RESTIC_MINIMUM="0.18.0"
# restic as root, the repository's key in a file, no cache: nothing it says names the key.
RESTIC="sudo env RESTIC_REPOSITORY=$REPOSITORY RESTIC_PASSWORD_FILE=$KEY /usr/bin/restic --no-cache"
MODE="${1:-}"

case "$MODE" in
  install|enable|state|check|--fingerprint) ;;
  *) sed -n '6,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac

fail() {
  echo "!! $1" >&2
  shift
  for line in "$@"; do echo "   $line" >&2; done
  echo "   journal: ssh $SITESOLIDE_SERVER 'sudo journalctl -u sitesolide-backup -n 50'" >&2
  exit 1
}

# Whether version $1 is at least $2, both as restic prints them (0.18.0).
version_at_least() {
  local IFS=.
  local -a have=($1) want=($2)
  local i
  for i in 0 1 2; do
    [ "${have[i]:-0}" -gt "${want[i]:-0}" ] && return 0
    [ "${have[i]:-0}" -lt "${want[i]:-0}" ] && return 1
  done
  return 0
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
    $RESTIC --no-lock stats --mode raw-data </dev/null 2>/dev/null | grep -E 'Snapshots processed|Total Size' || echo 'no repository yet'
    sudo du -sh $REPOSITORY 2>/dev/null || true
    echo
    sudo find /var/backups/sitesolide -name '*.tar.gz' 2>/dev/null | wc -l | sed 's/\$/ archive(s) of the format before restic, imported by the runs, removed 7 days after/'
    echo
    df -h /var/backups | tail -1
  "
  exit 0
fi

# The daily maintenance, now: the next run prunes and checks both repositories
# whatever the hour of the last maintenance, its verdict in the status file's
# `checks`. The run's own unit, its walls and its lock: a file of its state
# folder asks it, which the run removes.
if [ "$MODE" = check ]; then
  if ! ssh -n "$SITESOLIDE_SERVER" "test -f $TARGET_JS && test -f $UNITS_FOLDER/sitesolide-backup.service"; then
    fail "the component is not installed" "run first: bin/deploy-backup.sh install"
  fi
  in_progress="$(busy)"
  [ -z "$in_progress" ] || fail "a backup run or a restore is in progress, try again in a few minutes" "$in_progress"
  echo "-> a run, with the maintenance now"
  run_code=0
  ssh -n "$SITESOLIDE_SERVER" "sudo install -m 600 -o root -g root /dev/null /var/lib/sitesolide-backup/maintenance-now && sudo systemctl start sitesolide-backup.service" || run_code=$?
  status="$(ssh -n "$SITESOLIDE_SERVER" "sudo cat $STATUS" || true)"
  [ -n "$status" ] || fail "the run left no status in $STATUS"
  echo "$status"
  # The checks' verdicts, read here: the status is JSON, and bun is on the workstation.
  checks="$(printf '%s' "$status" | bun -e 'const c = JSON.parse(await Bun.stdin.text()).checks ?? {}; for (const [name, check] of Object.entries(c)) if (check !== null && typeof check === "object") console.log(`${name}: ${check.ok ? "ok" : `failed, ${check.error}`} at ${check.at}`);')"
  echo "-> the checks"
  echo "$checks"
  [ -n "$checks" ] || fail "the run wrote no check: read the journal"
  ! printf '%s\n' "$checks" | grep -q ': failed' || fail "a repository failed its check: read the journal, then restic check by hand"
  [ "$run_code" -eq 0 ] || fail "the run did not save every project: read the status above"
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
# tells the run whether a data folder is empty without listing it; choom
# makes restic the first process killed if a unit runs out of memory; gzip
# reads the archives of the format before restic for their import.
if ! ssh -n "$SITESOLIDE_SERVER" "test -x /usr/local/bin/bun && test -x /usr/bin/systemctl && test -x /usr/bin/systemd-run && test -x /usr/bin/find && test -x /usr/bin/choom && test -x /usr/bin/gzip && test -d /srv/sites && test -f /etc/caddy/sitesolide.env && systemd-run --help | grep -q -- '--pipe'"; then
  fail "a prerequisite is missing on the machine" \
    "expected: /usr/local/bin/bun, /usr/bin/systemctl, /usr/bin/systemd-run with --pipe, /usr/bin/find, /usr/bin/choom, /usr/bin/gzip, /srv/sites, /etc/caddy/sitesolide.env"
fi
in_progress="$(busy)"
[ -z "$in_progress" ] || fail "a backup run or a restore is in progress, try again in a few minutes" "$in_progress"

echo "-> restic"
# Debian's package, from the archive the machine already trusts: this install
# is the deliberate gesture that adds it. Then its version, refused below the
# one this component was measured with: --stdin-from-command and the exit
# codes 10 and 11 came in 0.17.0, 12 in 0.17.1.
if ! ssh -n "$SITESOLIDE_SERVER" "test -x /usr/bin/restic"; then
  # Once from the lists the machine has, and if they are too old to know it,
  # once more after refreshing them.
  APT="sudo env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600"
  ssh -n "$SITESOLIDE_SERVER" "$APT install -y -q restic </dev/null || { $APT update -q </dev/null && $APT install -y -q restic </dev/null; }" \
    || fail "restic could not be installed from Debian's archive" "try by hand: sudo apt-get update && sudo apt-get install restic"
fi
restic_version="$(ssh -n "$SITESOLIDE_SERVER" "/usr/bin/restic version </dev/null" | awk '{print $2}')"
if ! [[ "$restic_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || ! version_at_least "${BASH_REMATCH[0]}" "$RESTIC_MINIMUM"; then
  fail "restic $restic_version is too old: $RESTIC_MINIMUM or later is required" "Debian 13 ships 0.18; Debian 12's 0.14 is refused"
fi
echo "   restic $restic_version"

echo "-> sending"
# A folder whose name is drawn by mktemp rather than predictable: what comes out
# of it is installed as root.
REMOTE="$(ssh -n "$SITESOLIDE_SERVER" "mktemp -d")"
SOURCES=("$LOCAL/backup.js")
for unit in "${UNITS[@]}"; do SOURCES+=("$REPO_ROOT/infra/backup/$unit"); done
rsync -a "${SOURCES[@]}" "$SITESOLIDE_SERVER:$REMOTE/"

echo "-> installation"
# The key and the repository first: the units, once laid, open the repository
# for writing, and a run started by the timer meanwhile finds it there.
ssh -n "$SITESOLIDE_SERVER" "
  set -e
  # The repository's key: drawn once, written straight to its file, never shown.
  sudo sh -c 'umask 077; test -s $KEY || head -c 48 /dev/urandom | base64 -w0 > $KEY'
  sudo chown root:root $KEY
  sudo chmod 600 $KEY
  # The repository, only when restic says there is none (exit code 10): any
  # other answer is a repository that exists and does not open, never one to
  # replace.
  code=0
  $RESTIC cat config </dev/null >/dev/null 2>&1 || code=\$?
  if [ \$code -eq 10 ]; then
    $RESTIC init --repository-version 2 </dev/null >/dev/null
  elif [ \$code -ne 0 ]; then
    echo '!! the repository $REPOSITORY does not open (restic exit code '\$code'): nothing was changed in it' >&2
    exit 1
  fi
  sudo chmod 700 $REPOSITORY
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
permissions="$(ssh -n "$SITESOLIDE_SERVER" "sudo stat -c '%a %U:%G' $REPOSITORY")"
[ "$permissions" = "700 root:root" ] || fail "$REPOSITORY is $permissions, expected 700 root:root"
permissions="$(ssh -n "$SITESOLIDE_SERVER" "sudo stat -c '%a %U:%G' $KEY")"
[ "$permissions" = "600 root:root" ] || fail "$KEY is $permissions, expected 600 root:root"
ssh -n "$SITESOLIDE_SERVER" "$RESTIC cat config </dev/null >/dev/null 2>&1" || fail "the repository $REPOSITORY does not open with its key"

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
echo "   the next run imports the archives of the format before restic, if there are any"
