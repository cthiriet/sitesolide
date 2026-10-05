#!/usr/bin/env bash
#
# Deploys the shared service to the VM.
#
#   bin/deploy-api.sh
#
# The code leaves into a new release, and only the switch of the `current`
# symbolic link puts it in service: the restart is atomic and rolling back comes
# down to pointing the link at the previous release.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/bin/config.sh"
sitesolide_require_config
SOURCE="$REPO_ROOT/api"
# The release names what its code came from: the version of the binary that
# unpacked this kit, or the commit of the checkout it runs from. A kit is no
# git checkout, and asking git there would answer for whatever repository
# happens to hold the cache, or fail; the test on .git keeps git to the
# checkout that is REPO_ROOT itself.
if [ -n "${SITESOLIDE_KIT_VERSION:-}" ]; then
  REVISION="$SITESOLIDE_KIT_VERSION"
elif [ -e "$REPO_ROOT/.git" ]; then
  REVISION="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
else
  REVISION="unknown"
fi
RELEASE="$(date +%Y-%m-%d-%H%M%S)-$REVISION"
TARGET="/srv/api/releases/$RELEASE"

# On a fresh machine nothing has made the account the unit runs as, and
# cloud-init leaves /srv/api to root while the releases below are written by
# the deployment account: the first run failed on both, with 217/USER and a
# refused mkdir. Both are made here when missing, and nothing changes on a
# machine that already has them.
echo "-> account and directory"
ssh "$SITESOLIDE_SERVER" "id -u sitesolide-api >/dev/null 2>&1 \
  || sudo useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin sitesolide-api; \
  test -w /srv/api || sudo install -d -m 755 -o $DEPLOY_USER -g $DEPLOY_USER /srv/api"

echo "-> release $RELEASE"
ssh "$SITESOLIDE_SERVER" "mkdir -p $TARGET"

rsync -a --delete \
  --exclude node_modules \
  --exclude deploy \
  "$SOURCE/" "$SITESOLIDE_SERVER:$TARGET/"

echo "-> dependencies"
ssh "$SITESOLIDE_SERVER" "cd $TARGET && /usr/local/bin/bun install --production --silent"

echo "-> switch"
# The link is created alongside then moved: `mv -T` on a symbolic link is
# atomic, where an `ln -sf` would leave a fraction of a second without a target.
ssh "$SITESOLIDE_SERVER" "ln -sfn $TARGET /srv/api/current.new && mv -T /srv/api/current.new /srv/api/current"

# The unit travels with the code. It was installed once by hand and never
# again, so a unit that gained EnvironmentFile=/etc/caddy/sitesolide.env stayed
# the old one on the machine, and the new code ran without the zone its ask
# endpoint checks names against.
echo "-> unit"
ssh "$SITESOLIDE_SERVER" "sudo install -m 644 -o root -g root /dev/stdin /etc/systemd/system/sitesolide-api.service && sudo systemctl daemon-reload" \
  <"$SOURCE/deploy/sitesolide-api.service"

echo "-> service restart"
# enable, so that the service comes back after a reboot: installed and
# restarted but never enabled, it answered until the machine restarted and
# then stayed down, and with it every certificate issued on demand.
ssh "$SITESOLIDE_SERVER" "sudo systemctl enable --quiet sitesolide-api && sudo systemctl restart sitesolide-api && systemctl is-active sitesolide-api"

echo "-> verification"
# As root: the loopback rule lets only Caddy and root reach the ports of the
# services, so a probe from the deployment account is refused every time.
ssh "$SITESOLIDE_SERVER" "sleep 1 && sudo curl -fsS http://127.0.0.1:3001/health && echo"

# The last five releases are enough to roll back without letting the disk fill
# up.
ssh "$SITESOLIDE_SERVER" "cd /srv/api/releases && ls -1t | tail -n +6 | xargs -r rm -rf"
