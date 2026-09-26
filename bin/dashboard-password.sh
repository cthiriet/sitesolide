#!/usr/bin/env bash
#
# Draws the dashboard's password, shows it once, and puts its hash on the
# machine, in /etc/sitesolide/dashboard.env, root's, 0600.
#
#   bin/dashboard-password.sh             on a machine that has none yet
#   bin/dashboard-password.sh --replace   when the one in place is lost
#
# The one secret the dashboard cannot create for itself is the password that
# opens it; every other secret is created from its Secrets section. The hash
# goes straight from this workstation's memory to the machine, nothing is
# written on the way, and the password shows once, on this terminal: store it
# in a password manager before closing it.
#
# A password that still works is changed from the dashboard, Change password.
# This script refuses to replace one unless --replace says it was lost.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/bin/config.sh"
sitesolide_require_config

TARGET=/etc/sitesolide/dashboard.env
REPLACE=""
case "${1:-}" in
  "") ;;
  --replace) REPLACE=1 ;;
  *) echo "usage: bin/dashboard-password.sh [--replace]" >&2; exit 2 ;;
esac

if ssh "$SITESOLIDE_SERVER" "sudo test -e $TARGET" && [ -z "$REPLACE" ]; then
  echo "!! $TARGET is already in place: change the password from the dashboard" >&2
  echo "   if it is lost: bin/dashboard-password.sh --replace" >&2
  exit 1
fi

# The password goes to this terminal on standard error, the hash alone comes
# out on standard output.
HASH="$(cd "$REPO_ROOT/dashboard" && bun scripts/fingerprint.ts)"
[ -n "$HASH" ] || { echo "!! no hash was produced, nothing was sent" >&2; exit 1; }

printf 'PASSWORD_HASH=%s\n' "$HASH" |
  ssh "$SITESOLIDE_SERVER" "sudo install -d -m 755 -o root -g root /etc/sitesolide \
    && sudo install -m 600 -o root -g root /dev/stdin $TARGET"
echo "-> $TARGET in place, root:root 0600"

# The dashboard reads its hash at startup: restarted if it runs, left alone if
# it is not deployed yet.
ssh "$SITESOLIDE_SERVER" "sudo systemctl try-restart dashboard.service"
echo "-> dashboard restarted if it was running"
