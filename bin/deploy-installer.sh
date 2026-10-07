#!/usr/bin/env bash
#
# Installs or updates the installer, the root one-shot that deploys one project
# for a team token. See dashboard/installer.ts and dashboard/README.md, "The
# control API".
#
#   bin/deploy-installer.sh
#   bin/deploy-installer.sh --fingerprint   what it would install, nothing sent
#
# Like the steward and the gatekeeper, its code does not travel with the
# dashboard: a root component that creates accounts, writes units and reloads
# Caddy only changes by this deliberate gesture. The script builds a single
# file on the workstation, installs it as root:root under
# /usr/local/lib/sitesolide/, sets the unit template and its environment file,
# and reloads systemd.
#
# IT STARTS NOTHING. No `systemctl start` of the installer, no reload of Caddy:
# the first deployment will come from the steward, on a token's request. The
# checks below do nothing but read.
#
# THE ORDER OF THE ROLLOUT: `sitesolide deploy` of the dashboard, then
# bin/deploy-steward.sh, then this script. Until the steward is updated, the
# dashboard's API answers `not-available`; until this script has run, the
# steward does.
#
# NEVER `caddy stop` nor `caddy start` here: see the Production section of
# CLAUDE.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/bin/config.sh"
sitesolide_require_config
UNIT="sitesolide-installer@.service"
UNIT_SOURCE="$REPO_ROOT/infra/installer/$UNIT"
TARGET_JS="/usr/local/lib/sitesolide/installer.js"
UNITS_FOLDER="/etc/systemd/system"
ENV_FILE="/etc/sitesolide-installer.env"

fail() {
  echo "!! $1" >&2
  shift
  for line in "$@"; do echo "   $line" >&2; done
  exit 1
}

FINGERPRINT_ONLY=""
case "${1:-}" in
  "") ;;
  --fingerprint) FINGERPRINT_ONLY=yes ;;
  *) echo "usage: bin/deploy-installer.sh [--fingerprint]" >&2; exit 2 ;;
esac

[ -f "$UNIT_SOURCE" ] || fail "unit not found: $UNIT_SOURCE"
# The account that owns the served trees, the one the SSH path deploys as: the
# installer hands every tree it places to it, so that an owner deploying the
# same project over SSH afterwards finds files it can replace.
[ -n "${DEPLOY_USER:-}" ] || fail "no deployment account: SITESOLIDE_SERVER must be user@host"
[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail "unexpected deployment account: $DEPLOY_USER"

echo "-> local build"
LOCAL="$(mktemp -d)"
trap 'rm -rf "$LOCAL"' EXIT
# The borrowings first: the bundle embeds the CLI's generators and decisions,
# and a borrowing that lags behind would deploy differently from SSH.
sitesolide_borrow dashboard
(cd "$REPO_ROOT/dashboard" && bun build installer.ts --target=bun --outfile "$LOCAL/installer.js" > /dev/null)
[ -s "$LOCAL/installer.js" ] || fail "bun build produced nothing"
FINGERPRINT="$(shasum -a 256 < "$LOCAL/installer.js" | cut -d' ' -f1)"
echo "   installer.js, fingerprint ${FINGERPRINT:0:12}"
printf 'DEPLOY_ACCOUNT=%s\n' "$DEPLOY_USER" > "$LOCAL/sitesolide-installer.env"

# --fingerprint: builds, prints what it would install as sha256sum prints it,
# the local fingerprint then the path on the machine, and stops there, before
# any connection. `sitesolide upgrade` compares those lines with the machine.
if [ -n "$FINGERPRINT_ONLY" ]; then
  echo "$FINGERPRINT  $TARGET_JS"
  sitesolide_fingerprint "$UNIT_SOURCE" "$UNITS_FOLDER/$UNIT"
  sitesolide_fingerprint "$LOCAL/sitesolide-installer.env" "$ENV_FILE"
  exit 0
fi

echo "-> preliminary check"
# The absolute paths the unit and the code use must exist: a missing one fails
# the first deployment, not this script, otherwise.
if ! ssh -n "$SITESOLIDE_SERVER" "test -x /usr/local/bin/bun && test -x /usr/bin/systemctl && test -x /usr/bin/systemd-run && test -x /usr/sbin/useradd && test -x /usr/bin/caddy && test -d /etc/caddy/sites && test -d /srv/sites && test -f /etc/caddy/sitesolide.env"; then
  fail "a prerequisite is missing on the machine" \
    "expected: /usr/local/bin/bun, /usr/bin/systemctl, /usr/bin/systemd-run, /usr/sbin/useradd, /usr/bin/caddy, /etc/caddy/sites, /srv/sites, /etc/caddy/sitesolide.env"
fi
if ! ssh -n "$SITESOLIDE_SERVER" "id -u '$DEPLOY_USER' > /dev/null && id -u site-dashboard > /dev/null"; then
  fail "the deployment account $DEPLOY_USER or site-dashboard does not exist on the machine" \
    "deploy the dashboard first: cd dashboard && sitesolide deploy"
fi
if ! ssh -n "$SITESOLIDE_SERVER" "test -x /usr/sbin/nft"; then
  echo "   note: /usr/sbin/nft missing, a project with several services cannot be deployed by token"
fi
if ! ssh -n "$SITESOLIDE_SERVER" "test -f $UNITS_FOLDER/sitesolide-steward.service"; then
  echo "   note: the steward is not installed, nothing will start the installer (bin/deploy-steward.sh)"
fi

# A deployment in progress is left to finish: replacing the template under a
# running unit leaves it without a file, and nothing is urgent.
in_progress="$(ssh -n "$SITESOLIDE_SERVER" "systemctl list-units --all --plain --no-legend --state=activating 'sitesolide-installer@*' 2>/dev/null" || true)"
if [ -n "$in_progress" ]; then
  fail "a deployment is in progress, try again in a few minutes" "$in_progress"
fi

echo "-> sending"
# A folder whose name is drawn by mktemp rather than predictable: what comes out
# of it is installed as root.
REMOTE="$(ssh -n "$SITESOLIDE_SERVER" "mktemp -d")"
rsync -a "$LOCAL/installer.js" "$LOCAL/sitesolide-installer.env" "$UNIT_SOURCE" "$SITESOLIDE_SERVER:$REMOTE/"

echo "-> installation"
ssh -n "$SITESOLIDE_SERVER" "
  set -e
  sudo install -D -m 0644 -o root -g root $REMOTE/installer.js $TARGET_JS
  sudo install -m 0644 -o root -g root '$REMOTE/$UNIT' '$UNITS_FOLDER/$UNIT'
  sudo install -m 0644 -o root -g root $REMOTE/sitesolide-installer.env $ENV_FILE
  rm -rf $REMOTE
  sudo systemctl daemon-reload
"

echo "-> verifications, read only"
installed="$(ssh -n "$SITESOLIDE_SERVER" "sudo sha256sum $TARGET_JS" | cut -d' ' -f1)"
[ "$installed" = "$FINGERPRINT" ] || fail "the installed file does not match the local build"

permissions="$(ssh -n "$SITESOLIDE_SERVER" "sudo stat -c '%a %U:%G' $TARGET_JS '$UNITS_FOLDER/$UNIT' $ENV_FILE" | sort -u)"
[ "$permissions" = "644 root:root" ] || fail "unexpected permissions on the code, the unit or its environment: $permissions"

# A template is only checked through an instance: the FILE:NAME syntax names it
# without creating or starting anything (systemd 250 and above).
verification="$(ssh -n "$SITESOLIDE_SERVER" "sudo systemd-analyze verify '$UNITS_FOLDER/$UNIT:sitesolide-installer@verification.service' 2>&1" || true)"
if [ -n "$verification" ]; then
  fail "systemd-analyze verify reports problems on $UNIT" "$verification"
fi

echo "   installed, template verified, DEPLOY_ACCOUNT=$DEPLOY_USER, nothing started"
