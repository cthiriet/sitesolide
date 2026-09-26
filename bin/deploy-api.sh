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
RELEASE="$(date +%Y-%m-%d-%H%M%S)-$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
TARGET="/srv/api/releases/$RELEASE"

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
ssh "$SITESOLIDE_SERVER" "sudo systemctl restart sitesolide-api && systemctl is-active sitesolide-api"

echo "-> verification"
# As root: the loopback rule lets only Caddy and root reach the ports of the
# services, so a probe from the deployment account is refused every time.
ssh "$SITESOLIDE_SERVER" "sleep 1 && sudo curl -fsS http://127.0.0.1:3001/health && echo"

# The last five releases are enough to roll back without letting the disk fill
# up.
ssh "$SITESOLIDE_SERVER" "cd /srv/api/releases && ls -1t | tail -n +6 | xargs -r rm -rf"
