#!/usr/bin/env bash
#
# Installs or updates the steward, the root daemon that keeps /etc/sitesolide
# for the dashboard and commands the gatekeeper. See dashboard/README.md.
#
#   bin/deploy-steward.sh
#
# Unlike the collector, its code does not travel with the dashboard: a root
# daemon that writes secrets only changes by this deliberate gesture. The script
# builds a single file on the workstation, installs it as root:root under
# /usr/local/lib/sitesolide/, sets the unit and restarts the steward alone. It
# touches neither Caddy, nor the dashboard, nor any site.
#
# THE REGISTER OF SECRETS IS EMBEDDED HERE. secrets/destinations.conf is copied
# by `bun run borrow` then inlined into steward.js by `bun build`: a new path
# outside the manifest (a key, a sub-folder of secrets) is only handled after
# this script, never by a mere deposit of a file on the machine.
#
# To be run AFTER the dashboard's first `sitesolide deploy`: the socket is
# opened to the site-dashboard group, which only exists from then on.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/bin/config.sh"
sitesolide_require_config
UNIT="sitesolide-steward"
UNIT_SOURCE="$REPO_ROOT/infra/steward/$UNIT.service"
TARGET_JS="/usr/local/lib/sitesolide/steward.js"
SOCKET_FOLDER="/run/$UNIT"
SOCKET="$SOCKET_FOLDER/secretaire.sock"

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
# The borrowings first: they are not versioned, and the bundle embeds them.
(cd "$REPO_ROOT/dashboard" && bun run borrow > /dev/null)
(cd "$REPO_ROOT/dashboard" && bun build steward.ts --target=bun --outfile "$LOCAL/steward.js" > /dev/null)
[ -s "$LOCAL/steward.js" ] || { echo "!! bun build produced nothing" >&2; exit 1; }
FINGERPRINT="$(shasum -a 256 < "$LOCAL/steward.js" | cut -d' ' -f1)"
echo "   steward.js, fingerprint ${FINGERPRINT:0:12}"

echo "-> preliminary check"
# Without the group, the steward would refuse to start and Restart=always
# would make it loop: better to stop here while saying what to do.
if ! ssh -n "$SITESOLIDE_SERVER" "getent group site-dashboard > /dev/null && id -u site-dashboard > /dev/null"; then
  echo "!! the site-dashboard account does not exist on the machine" >&2
  echo "   run first: cd dashboard && sitesolide deploy" >&2
  exit 1
fi
# ReadWritePaths on a missing folder makes the unit fail with 226/NAMESPACE.
if ! ssh -n "$SITESOLIDE_SERVER" "sudo test -d /etc/sitesolide && test -x /usr/local/bin/bun && test -x /usr/bin/systemctl"; then
  echo "!! /etc/sitesolide, /usr/local/bin/bun or /usr/bin/systemctl missing from the machine" >&2
  exit 1
fi

# The unit gives neither CAP_DAC_OVERRIDE nor CAP_FOWNER: root only writes into
# /etc/sitesolide because it owns it, with the write permission.
secrets_folder="$(ssh -n "$SITESOLIDE_SERVER" "sudo stat -c '%U %A' /etc/sitesolide")"
case "$secrets_folder" in
  "root d"?w*) ;;
  *)
    echo "!! /etc/sitesolide is '$secrets_folder', expected root and writable by it" >&2
    echo "   to run yourself, after checking: sudo chown root:root /etc/sitesolide && sudo chmod 755 /etc/sitesolide" >&2
    exit 1
    ;;
esac

# The password's hash opens every secret of the perimeter: the steward
# refuses to unlock if it is not root's alone, without a single bit for the
# group nor for the others. The script corrects nothing itself: changing the
# permissions of a secret is a gesture to be made knowingly.
dashboard_env="$(ssh -n "$SITESOLIDE_SERVER" "sudo stat -c '%u %a %F' /etc/sitesolide/dashboard.env 2>/dev/null || echo missing")"
case "$dashboard_env" in
  "0 600 regular file" | "0 400 regular file") ;;
  *)
    echo "!! /etc/sitesolide/dashboard.env is '$dashboard_env', expected 0 600 regular file (root:root 0600)" >&2
    echo "   the steward would refuse any unlock. To run yourself:" >&2
    echo "   ssh $SITESOLIDE_SERVER 'sudo chown root:root /etc/sitesolide/dashboard.env && sudo chmod 600 /etc/sitesolide/dashboard.env'" >&2
    exit 1
    ;;
esac

echo "-> sending"
# A folder whose name is drawn by mktemp rather than predictable: what comes out
# of it is installed as root.
REMOTE="$(ssh -n "$SITESOLIDE_SERVER" "mktemp -d")"
rsync -a "$LOCAL/steward.js" "$UNIT_SOURCE" "$SITESOLIDE_SERVER:$REMOTE/"

echo "-> installation"
ssh -n "$SITESOLIDE_SERVER" "
  set -e
  sudo install -D -m 0644 -o root -g root $REMOTE/steward.js $TARGET_JS
  sudo install -m 0644 -o root -g root $REMOTE/$UNIT.service /etc/systemd/system/$UNIT.service
  rm -rf $REMOTE
  sudo systemctl daemon-reload
  sudo systemctl enable $UNIT.service
  sudo systemctl restart $UNIT.service
"

echo "-> verifications"
installed="$(ssh -n "$SITESOLIDE_SERVER" "sudo sha256sum $TARGET_JS" | cut -d' ' -f1)"
[ "$installed" = "$FINGERPRINT" ] || fail "the installed file does not match the local build"

# The socket appears after Bun starts: a few seconds at most.
ready=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ssh -n "$SITESOLIDE_SERVER" "systemctl is-active --quiet $UNIT && sudo test -S $SOCKET"; then
    ready="yes"
    break
  fi
  sleep 1
done
[ -n "$ready" ] || fail "$UNIT is not active, or its socket does not exist" \
  "state: $(ssh -n "$SITESOLIDE_SERVER" "systemctl is-active $UNIT" || true)"

permissions="$(ssh -n "$SITESOLIDE_SERVER" "sudo stat -c '%a %U:%G' $SOCKET_FOLDER")"
[ "$permissions" = "750 root:site-dashboard" ] || fail "$SOCKET_FOLDER is $permissions, expected 750 root:site-dashboard"

permissions="$(ssh -n "$SITESOLIDE_SERVER" "sudo stat -c '%a %U:%G' $SOCKET")"
[ "$permissions" = "660 root:site-dashboard" ] || fail "$SOCKET is $permissions, expected 660 root:site-dashboard"

# The dashboard reaches the steward: 200 on the only route that asks nothing.
code="$(ssh -n "$SITESOLIDE_SERVER" "sudo -u site-dashboard curl -s -o /dev/null -w '%{http_code}' --max-time 10 --unix-socket $SOCKET http://steward/projects" || true)"
[ "$code" = "200" ] || fail "site-dashboard does not get 200 on /projects (got: ${code:-nothing})"

# And the list carries every deployed site, not only those of an old exclusion:
# each site is an object with a `"slug":` there, and no file carries one. A
# single site would mean a broken perimeter, or /srv/sites unreadable.
sites="$(ssh -n "$SITESOLIDE_SERVER" "sudo -u site-dashboard curl -s --max-time 10 --unix-socket $SOCKET http://steward/projects" | grep -o '"slug":' | wc -l | tr -d ' ' || true)"
[ "${sites:-0}" -gt 1 ] || fail "/projects only lists ${sites:-0} site under site-dashboard, expected all those of /srv/sites"
echo "   $sites sites listed by the steward"

# The gatekeeper is another unit, deposited by bin/deploy-gatekeeper.sh: two
# templates, one per gesture, which the steward launches through
# `systemctl start sitesolide-gatekeeper-<on|off>@<slug>.service`. Their absence
# prevents nothing else: the page will say that the portal does not change.
for template in sitesolide-gatekeeper-on@.service sitesolide-gatekeeper-off@.service; do
  if ! ssh -n "$SITESOLIDE_SERVER" "test -f /etc/systemd/system/$template"; then
    echo "   note: $template missing, setting or removing a portal will fail (bin/deploy-gatekeeper.sh)"
  fi
done

# And nobody else. `nobody` is neither in the group nor the owner: the connect()
# must fail before any HTTP answer, which curl writes as 000. An empty output
# means that the test did not run, and proves nothing.
code="$(ssh -n "$SITESOLIDE_SERVER" "sudo -u nobody curl -s -o /dev/null -w '%{http_code}' --max-time 10 --unix-socket $SOCKET http://steward/projects" || true)"
[ -n "$code" ] || fail "the test under nobody could not run, the socket's closure is not proven"
[ "$code" = "000" ] || fail "nobody reaches the socket (code $code): it must be closed to any account other than site-dashboard"

# curl returns the same code 7 for a missing socket and for a refused socket,
# measured on the bench: `stat` tells the two apart. The expected refusal is on
# the folder, which nobody cannot traverse.
seen="$(ssh -n "$SITESOLIDE_SERVER" "sudo -u nobody stat $SOCKET 2>&1" || true)"
case "$seen" in
  *"Permission denied"*) ;;
  *) fail "nobody is not refused by the folder's permissions: stat says '$seen'" ;;
esac

echo "   active, socket 660 root:site-dashboard, open to the dashboard and closed to the others"
