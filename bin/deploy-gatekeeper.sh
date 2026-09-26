#!/usr/bin/env bash
#
# Installs or updates the gatekeeper, the root component that sets or removes a
# site's portal for the dashboard. See dashboard/gatekeeper.ts.
#
#   bin/deploy-gatekeeper.sh
#
# Like the steward, its code does not travel with the dashboard: a root
# component that rewrites a Caddy block and reloads Caddy only changes by this
# deliberate gesture. The script builds a single file on the workstation,
# installs it as root:root under /usr/local/lib/sitesolide/, sets the two unit
# templates (sitesolide-gatekeeper-on@ and -off@, one per gesture), removes the
# single template from before and reloads systemd.
#
# IT LAUNCHES NO TRANSACTION. No `systemctl start` of the gatekeeper, no reload
# of Caddy: the first transaction will come from the steward, on demand. The
# checks below do nothing but read.
#
# IT DOES NOT INSTALL UNDER A TRANSACTION. The script holds the lock the
# gatekeeper takes at each transaction, /run/sitesolide-gatekeeper/caddy.lock,
# from the check of the transactions in progress to the end of the installation:
# no transaction can start between that check and the replacement of the code or
# of the templates. The check of the units in progress stays, for a gatekeeper
# from before that would not know this lock. Released by the exit trap on every
# path; CADDY_LOCK_HELD passes the ownership on, as for the other scripts. See
# bin/cli/caddy-lock.ts.
#
# NEVER `caddy stop` nor `caddy start` here: those commands address the
# administration API of the instance in service, whatever the --config, and have
# already cut production. See the Production section of CLAUDE.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/bin/config.sh"
sitesolide_require_config
UNITS=("sitesolide-gatekeeper-on@.service" "sitesolide-gatekeeper-off@.service")
# The single template from before wrote into the whole of /srv/sites: it must
# not stay launchable next to the two new ones.
PREVIOUS_TEMPLATE="sitesolide-gatekeeper@.service"
TARGET_JS="/usr/local/lib/sitesolide/gatekeeper.js"
UNITS_FOLDER="/etc/systemd/system"

fail() {
  echo "!! $1" >&2
  shift
  for line in "$@"; do echo "   $line" >&2; done
  exit 1
}

for unit in "${UNITS[@]}"; do
  [ -f "$REPO_ROOT/infra/gatekeeper/$unit" ] || fail "unit not found: $REPO_ROOT/infra/gatekeeper/$unit"
done

echo "-> local build"
LOCAL="$(mktemp -d)"
CADDY_LOCK=""
release_caddy_lock() {
  [ -n "$CADDY_LOCK" ] || return 0
  SITESOLIDE_SERVER="$SITESOLIDE_SERVER" bun "$REPO_ROOT/bin/portal-guard.ts" --lock release "$CADDY_LOCK" || true
  CADDY_LOCK=""
}
on_exit() {
  rm -rf "$LOCAL"
  release_caddy_lock
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# The borrowings first: they are not versioned, and the bundle embeds the CLI's
# block generator. A borrowing that lags behind would write a block the next
# `sitesolide deploy` would contradict.
(cd "$REPO_ROOT/dashboard" && bun run borrow > /dev/null)
(cd "$REPO_ROOT/dashboard" && bun build gatekeeper.ts --target=bun --outfile "$LOCAL/gatekeeper.js" > /dev/null)
[ -s "$LOCAL/gatekeeper.js" ] || fail "bun build produced nothing"
FINGERPRINT="$(shasum -a 256 < "$LOCAL/gatekeeper.js" | cut -d' ' -f1)"
echo "   gatekeeper.js, fingerprint ${FINGERPRINT:0:12}"

echo "-> preliminary check"
# ReadWritePaths or RequiresMountsFor on a missing path make the unit fail with
# 226/NAMESPACE, on the first request and not here: better to see it now. The
# absolute paths of the unit and of the code must exist.
if ! ssh -n "$SITESOLIDE_SERVER" "test -x /usr/local/bin/bun && test -x /usr/bin/systemctl && test -x /usr/bin/caddy && test -d /etc/caddy/sites && test -d /srv/sites && sudo test -f /etc/caddy/cloudflare.env"; then
  fail "a prerequisite is missing on the machine" \
    "expected: /usr/local/bin/bun, /usr/bin/systemctl, /usr/bin/caddy, /etc/caddy/sites, /srv/sites, /etc/caddy/cloudflare.env"
fi

# The lock first: a transaction holding it makes this refuse, and none can start
# any more before the end of the installation.
if [ -n "${CADDY_LOCK_HELD:-}" ]; then
  echo "-> Caddy lock: held by the caller ($CADDY_LOCK_HELD)"
  SITESOLIDE_SERVER="$SITESOLIDE_SERVER" bun "$REPO_ROOT/bin/portal-guard.ts" --lock verify "$CADDY_LOCK_HELD" || exit 1
else
  echo "-> Caddy lock"
  CADDY_LOCK="$(SITESOLIDE_SERVER="$SITESOLIDE_SERVER" bun "$REPO_ROOT/bin/portal-guard.ts" --lock take deploy-gatekeeper $$)" || exit 1
fi

# A transaction in progress is left to finish: removing the template from under
# a running unit would leave it without a file, and nothing is urgent.
in_progress="$(ssh -n "$SITESOLIDE_SERVER" "systemctl list-units --all --plain --no-legend --state=activating 'sitesolide-gatekeeper*' 2>/dev/null" || true)"
if [ -n "$in_progress" ]; then
  fail "a gatekeeper transaction is in progress, try again in a minute" "$in_progress"
fi

echo "-> sending"
# A folder whose name is drawn by mktemp rather than predictable: what comes out
# of it is installed as root.
REMOTE="$(ssh -n "$SITESOLIDE_SERVER" "mktemp -d")"
SOURCES=("$LOCAL/gatekeeper.js")
for unit in "${UNITS[@]}"; do SOURCES+=("$REPO_ROOT/infra/gatekeeper/$unit"); done
rsync -a "${SOURCES[@]}" "$SITESOLIDE_SERVER:$REMOTE/"

echo "-> installation"
ssh -n "$SITESOLIDE_SERVER" "
  set -e
  sudo install -D -m 0644 -o root -g root $REMOTE/gatekeeper.js $TARGET_JS
  for unit in ${UNITS[*]}; do
    sudo install -m 0644 -o root -g root \"$REMOTE/\$unit\" \"$UNITS_FOLDER/\$unit\"
  done
  sudo rm -f '$UNITS_FOLDER/$PREVIOUS_TEMPLATE'
  rm -rf $REMOTE
  sudo systemctl daemon-reload
"
# Installed: the checks that follow do nothing but read.
release_caddy_lock

echo "-> verifications, read only"
installed="$(ssh -n "$SITESOLIDE_SERVER" "sudo sha256sum $TARGET_JS" | cut -d' ' -f1)"
[ "$installed" = "$FINGERPRINT" ] || fail "the installed file does not match the local build"

paths="$TARGET_JS"
for unit in "${UNITS[@]}"; do paths="$paths '$UNITS_FOLDER/$unit'"; done
permissions="$(ssh -n "$SITESOLIDE_SERVER" "sudo stat -c '%a %U:%G' $paths" | sort -u)"
[ "$permissions" = "644 root:root" ] || fail "unexpected permissions on the code or the units: $permissions"

if ssh -n "$SITESOLIDE_SERVER" "test -e '$UNITS_FOLDER/$PREVIOUS_TEMPLATE'"; then
  fail "the template from before is still there: $UNITS_FOLDER/$PREVIOUS_TEMPLATE"
fi

# A template is only checked through an instance: the FILE:NAME syntax names it
# without creating or starting anything (systemd 250 and above; measured on the
# bench with systemd 257 for the template from before).
for unit in "${UNITS[@]}"; do
  instance="${unit/@.service/@verification.service}"
  verification="$(ssh -n "$SITESOLIDE_SERVER" "sudo systemd-analyze verify '$UNITS_FOLDER/$unit:$instance' 2>&1" || true)"
  if [ -n "$verification" ]; then
    fail "systemd-analyze verify reports problems on $unit" "$verification"
  fi
done

echo "   installed, two units verified, template from before removed, no transaction launched"
echo "   first transaction: from the dashboard, by the steward"
