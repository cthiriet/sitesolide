#!/usr/bin/env bash
#
# Installs the timer that collects the machine's state for the dashboard.
#
#   bin/deploy-collector.sh
#
# Two files only, the unit and its timer. The collecting script itself,
# dashboard/collector.ts, travels with the dashboard's code: it is updated by an
# ordinary `sitesolide deploy` from dashboard/, and this script therefore does
# not have to run again at every change.
#
# To be run AFTER the dashboard's first `sitesolide deploy`: the unit carries a
# ConditionPathExists on the script, and its data folder must exist for
# ReadWritePaths to hold.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/bin/config.sh"
sitesolide_require_config
SOURCE="$REPO_ROOT/infra/collector"
WORK="/tmp/collector-$$"

echo "-> preliminary check"
# Without the script, the timer would run empty in silence: the unit's condition
# would make it pass for a success at every wake-up.
if ! ssh "$SITESOLIDE_SERVER" "test -f /srv/sites/dashboard/app/collector.ts"; then
  echo "!! /srv/sites/dashboard/app/collector.ts missing" >&2
  echo "   run first: cd dashboard && sitesolide deploy" >&2
  exit 1
fi

echo "-> sending"
ssh "$SITESOLIDE_SERVER" "mkdir -p $WORK"
rsync -a "$SOURCE/sitesolide-collector.service" "$SOURCE/sitesolide-collector.timer" "$SITESOLIDE_SERVER:$WORK/"

echo "-> installation"
ssh "$SITESOLIDE_SERVER" "
  set -e
  sudo install -m 644 -o root -g root $WORK/sitesolide-collector.service /etc/systemd/system/sitesolide-collector.service
  sudo install -m 644 -o root -g root $WORK/sitesolide-collector.timer /etc/systemd/system/sitesolide-collector.timer
  rm -rf $WORK
  sudo systemctl daemon-reload
  sudo systemctl enable --now sitesolide-collector.timer
"

echo "-> first reading"
# The timer only fires on the following minute. An immediate collection avoids
# the dashboard announcing a stale snapshot just after its installation, which
# would read as a breakdown.
ssh "$SITESOLIDE_SERVER" "sudo systemctl start sitesolide-collector.service"

echo "-> state"
ssh "$SITESOLIDE_SERVER" "systemctl is-active sitesolide-collector.timer && sudo ls -l /srv/sites/dashboard/data/state.json"
