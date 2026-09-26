#!/usr/bin/env bash
#
# The loopback rule: on the VM, only Caddy and root open a connection to the
# ports of the services, 3000 to 3099, and to Caddy's administration API,
# 2019. One exception: the dashboard towards the portal, for the guest
# accesses.
#
#   bin/deploy-loopback.sh observe   counts and logs what would be refused, refusing nothing
#   bin/deploy-loopback.sh state     what has been counted, and the journal's last lines
#   bin/deploy-loopback.sh close     refuses the others, verifies, and withdraws itself at the slightest gap
#   ADMIN_MODE=observe bin/deploy-loopback.sh close   closes the services, only observes the administration API
#   bin/deploy-loopback.sh remove    removes the rule and its unit
#
# Why: a site behind the portal no longer verifies anything itself, it trusts
# Caddy. Without this rule, any service of the machine would reach its port
# without going through Caddy. Worse, it would reach Caddy's administration
# API, which authenticates nobody: a configuration without forward_auth opens
# every site of the portal there, a stop cuts the whole machine. See
# bin/cli/loopback.ts.
#
# What the gesture touches, and nothing else: the nftables table inet
# sitesolide_boucle, which neither ufw nor Caddy touch; /etc/sitesolide-loopback.nft;
# and the sitesolide-loopback.service unit, which reloads it at boot.
# /etc/sitesolide-loopback-projects.nft, the ports each project with several
# services may open towards its own, is written by sitesolide deploy and only
# replayed here: laying the table empties that set.
#
# THE SAFETY NET. Before closing, a systemd timer is armed to remove the table
# two minutes later. It is only disarmed once these are verified: Caddy towards
# each listening port, the refusal of any other account, the rule of the
# administration API loaded in the kernel with Caddy alone reaching it, and each
# site over HTTPS.
# Should this script die on the way or the ssh connection drop, the rule
# withdraws on its own.
#
# Tested first inside a Linux kernel on the workstation:
#   LOOPBACK_TEST=1 bun test bin/tests/cli-loopback.test.ts
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/bin/config.sh"
sitesolide_require_config
FILE=/etc/sitesolide-loopback.nft
PROJECTS=/etc/sitesolide-loopback-projects.nft
UNIT=/etc/systemd/system/sitesolide-loopback.service
TABLE=sitesolide_boucle
# The transient unit of the safety net keeps the name the machine knows: a run
# of this script disarms the timer a previous run armed by stopping it by name,
# and a rename here would leave an armed one behind, to fire two minutes later.
SAFETY_UNIT=sitesolide-loopback-secours
MODE="${1:-}"

case "$MODE" in
  observe|close|state|remove) ;;
  *) sed -n '8,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac

# The administration API may follow a mode other than the ports of the services,
# and follows by default the one of the whole rule. Switching the whole rule to
# observe in order to observe the API would reopen the services, already
# closed, for the time of the observation: ADMIN_MODE=observe observes it alone.
# Refused rather than ignored: the variable was called MODE_ADMIN until the
# repository went English, and a run still setting that name would silently get
# the whole rule's mode instead, closing the API where it was asked to watch it.
if [ -n "${MODE_ADMIN:-}" ]; then
  echo "MODE_ADMIN has been renamed ADMIN_MODE" >&2
  exit 2
fi
ADMIN_MODE="${ADMIN_MODE:-$MODE}"
if [ "$MODE" = observe ] || [ "$MODE" = close ]; then
  case "$ADMIN_MODE" in
    observe|close) ;;
    *) echo "ADMIN_MODE must be observe or close" >&2; exit 2 ;;
  esac
fi

# nft lives in /usr/sbin, outside the PATH of an ordinary account: it is looked
# up in root's, which is the one that will launch it.
NFT="$(ssh "$SITESOLIDE_SERVER" 'sudo sh -c "command -v nft" || true')"
[ -n "$NFT" ] || { echo "nft not found on the VM" >&2; exit 1; }

if [ "$MODE" = state ]; then
  ssh "$SITESOLIDE_SERVER" "sudo $NFT list table inet $TABLE 2>/dev/null || echo 'no rule set'
    echo
    echo '=== kernel journal, last 24 hours'
    sudo journalctl -k --since '-24h' --no-pager 2>/dev/null | grep 'sitesolide-loopback: ' | tail -20 || true"
  exit 0
fi

if [ "$MODE" = remove ]; then
  ssh "$SITESOLIDE_SERVER" "sudo systemctl disable --now sitesolide-loopback 2>/dev/null || true
    sudo $NFT delete table inet $TABLE 2>/dev/null || true
    sudo rm -f $FILE $UNIT
    sudo systemctl daemon-reload"
  echo "rule removed"
  exit 0
fi

# Caddy's uid, read and not assumed. loopbackRule refuses what is not a positive
# integer: a failed read would close Caddy itself, hence every site.
CADDY_UID="$(ssh "$SITESOLIDE_SERVER" 'id -u caddy')"
# The dashboard's, for the rule's only exception: its access to the portal,
# where it creates and revokes the guest accesses. Missing, id fails and the
# script stops before having set anything.
DASHBOARD_UID="$(ssh "$SITESOLIDE_SERVER" 'id -u site-dashboard')"
PORTAL_PORT="$(cd "$REPO_ROOT" && bun -e 'import { PORTAL_PORT } from "./bin/cli/portal"; console.log(PORTAL_PORT)')"
ADMIN_PORT="$(cd "$REPO_ROOT" && bun -e 'import { CADDY_ADMIN_PORT } from "./bin/cli/loopback"; console.log(CADDY_ADMIN_PORT)')"
WORK="$(mktemp -d)"
WORK_VM=""
on_exit() {
  rm -rf "$WORK"
  [ -z "$WORK_VM" ] || ssh "$SITESOLIDE_SERVER" "sudo rm -rf $WORK_VM" >/dev/null 2>&1 || true
}
trap on_exit EXIT

(cd "$REPO_ROOT" && CADDY_UID="$CADDY_UID" DASHBOARD_UID="$DASHBOARD_UID" MODE="$MODE" ADMIN_MODE="$ADMIN_MODE" bun -e '
  import { loopbackRule } from "./bin/cli/loopback";
  process.stdout.write(loopbackRule(
    Number(process.env.CADDY_UID),
    process.env.MODE as "observe" | "close",
    Number(process.env.DASHBOARD_UID),
    process.env.ADMIN_MODE as "observe" | "close",
  ));
') > "$WORK/loopback.nft"
# The two lines of the administration API as nft list table will return them, in
# their order: what the verification will look for. Two, or nothing is set: an
# empty pattern would recognise any line at all.
ADMIN_PATTERNS="$(cd "$REPO_ROOT" && CADDY_UID="$CADDY_UID" MODE="$ADMIN_MODE" bun -e '
  import { adminPatterns } from "./bin/cli/loopback";
  console.log(adminPatterns(Number(process.env.CADDY_UID), process.env.MODE as "observe" | "close").join("\n"));
')"
[ "$(printf '%s\n' "$ADMIN_PATTERNS" | grep -c .)" = 2 ] || { echo "administration API patterns unreadable, nothing is set" >&2; exit 1; }
sed "s|@NFT@|$NFT|g" "$REPO_ROOT/infra/loopback/sitesolide-loopback.service" > "$WORK/sitesolide-loopback.service"

echo "-> rule ($MODE, administration API $ADMIN_MODE), Caddy uid $CADDY_UID, dashboard uid $DASHBOARD_UID"
WORK_VM="$(ssh "$SITESOLIDE_SERVER" 'mktemp -d /tmp/loopback.XXXXXXXX')"
rsync -a "$WORK/loopback.nft" "$WORK/sitesolide-loopback.service" "$SITESOLIDE_SERVER:$WORK_VM/"

# nft -c reads again without applying anything: a refused rule stops here.
ssh "$SITESOLIDE_SERVER" "sudo $NFT -c -f $WORK_VM/loopback.nft" || {
  echo "rule refused by nft -c, nothing is set" >&2
  exit 1
}

# The rule in service before this gesture, to come back to it. Missing, rolling
# back consists in removing the table.
ssh "$SITESOLIDE_SERVER" "if sudo test -f $FILE; then sudo cp $FILE $WORK_VM/before.nft; fi"

restore() {
  ssh "$SITESOLIDE_SERVER" "
    if sudo test -f $WORK_VM/before.nft; then
      sudo install -m 644 -o root -g root $WORK_VM/before.nft $FILE && sudo $NFT -f $FILE
      ! sudo test -f $PROJECTS || sudo $NFT -f $PROJECTS 2>/dev/null || true
    else
      sudo $NFT delete table inet $TABLE 2>/dev/null || true
      sudo rm -f $FILE
    fi
    sudo systemctl stop $SAFETY_UNIT.timer $SAFETY_UNIT.service 2>/dev/null || true"
}

if [ "$MODE" = close ] || [ "$ADMIN_MODE" = close ]; then
  echo "-> safety net: automatic removal in two minutes, unless the verification succeeds"
  ssh "$SITESOLIDE_SERVER" "sudo systemctl stop $SAFETY_UNIT.timer $SAFETY_UNIT.service 2>/dev/null || true
    sudo systemd-run --quiet --unit=$SAFETY_UNIT --on-active=120 $NFT delete table inet $TABLE"
fi

ssh "$SITESOLIDE_SERVER" "sudo install -m 644 -o root -g root $WORK_VM/loopback.nft $FILE && sudo $NFT -f $FILE"
# The projects' set, emptied by the line above. A refusal here counts as a
# discrepancy: the verification below would otherwise pass while every project
# with several services had lost its calls.
if ssh "$SITESOLIDE_SERVER" "! sudo test -f $PROJECTS || sudo $NFT -f $PROJECTS"; then
  PROJECTS_LOADED=1
else
  PROJECTS_LOADED=0
fi
echo "-> rule applied"

# --- verification ------------------------------------------------------------

FAILURES=0
if [ "$PROJECTS_LOADED" = 0 ]; then
  echo "   FAILED: $PROJECTS refused, the projects with several services lose their calls" >&2
  FAILURES=1
fi

# A TCP connection, and not an HTTP request: the rule is about connections, and
# an internal service of a project may speak something other than HTTP, which
# curl would report as 000, the very code of a refusal. $1 is an account, or
# '#<uid>'. ssh -n: called inside a while loop reading a here-string, ssh would
# otherwise swallow the rest of it, and every pair after the first would go
# untested without a word.
connects() {
  ssh -n "$SITESOLIDE_SERVER" "sudo -u '$1' timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/$2' >/dev/null 2>&1 && echo open || echo closed"
}

echo "-> Caddy towards each listening port, then any account"
PORTS="$(ssh "$SITESOLIDE_SERVER" "ss -ltnH '( sport >= :3000 and sport <= :3099 )' | awk '{print \$4}' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un")"
[ -n "$PORTS" ] || { echo "   no port listening in the range: failed read?" >&2; FAILURES=1; }
for port in $PORTS; do
  caddy="$(connects caddy "$port")"
  other="$(connects nobody "$port")"
  expected_other="closed"
  [ "$MODE" = close ] || expected_other="(free)"
  verdict="ok"
  if [ "$caddy" != open ]; then verdict="FAILED: Caddy refused"; FAILURES=$((FAILURES + 1)); fi
  if [ "$MODE" = close ] && [ "$other" != closed ]; then verdict="FAILED: another account gets through"; FAILURES=$((FAILURES + 1)); fi
  printf "   %-6s caddy %s, other %s (expected %s)  %s\n" "$port" "$caddy" "$other" "$expected_other" "$verdict"
done

echo "-> each project with several services towards its own ports"
# Read in what the kernel has loaded, as for the admin API below: the pairs
# port . uid, on one line or several.
PAIRS="$(ssh "$SITESOLIDE_SERVER" "sudo $NFT list set inet $TABLE project_ports 2>/dev/null" | grep -oE '[0-9]+ \. [0-9]+' || true)"
[ -n "$PAIRS" ] || echo "   none"
while read -r port _ uid; do
  [ -n "$port" ] || continue
  # A port declared by a project whose service is not listening cannot answer
  # either way: only the ports in use are tried.
  if ! printf '%s\n' "$PORTS" | grep -qx "$port"; then
    printf "   %-6s uid %s, nothing listening\n" "$port" "$uid"
    continue
  fi
  own="$(connects "#$uid" "$port")"
  verdict="ok"
  if [ "$own" != open ]; then verdict="FAILED: the project no longer reaches its own port"; FAILURES=$((FAILURES + 1)); fi
  printf "   %-6s uid %s %s  %s\n" "$port" "$uid" "$own" "$verdict"
done <<< "$PAIRS"

echo "-> the dashboard towards the portal, and towards it alone"
to_portal="$(ssh "$SITESOLIDE_SERVER" "sudo -u site-dashboard curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:$PORTAL_PORT/sante || true")"
to_landing="$(ssh "$SITESOLIDE_SERVER" "sudo -u site-dashboard curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/ || true")"
verdict="ok"
if [ "$to_portal" != "200" ]; then verdict="FAILED: the dashboard does not reach the portal"; FAILURES=$((FAILURES + 1)); fi
if [ "$MODE" = close ] && [ "$to_landing" != "000" ]; then verdict="FAILED: the dashboard reaches another port"; FAILURES=$((FAILURES + 1)); fi
printf "   portal %s, landing %s  %s\n" "$to_portal" "$to_landing" "$verdict"

echo "-> Caddy's administration API, port $ADMIN_PORT"
# Set: its two lines, the acceptance before the refusal, read in what the kernel
# has loaded and not in the file that was sent. The patterns come from
# bin/cli/loopback.ts, tested against the output of nft list.
LOADED="$(ssh "$SITESOLIDE_SERVER" "sudo $NFT list table inet $TABLE" || true)"
verdict="ok"
previous=0
while IFS= read -r pattern; do
  rank="$(printf '%s\n' "$LOADED" | grep -nE -e "$pattern" | head -1 | cut -d: -f1 || true)"
  if [ -z "$rank" ] || [ "$rank" -le "$previous" ]; then
    verdict="FAILED: rule missing or out of order"
    FAILURES=$((FAILURES + 1))
    break
  fi
  previous="$rank"
done <<< "$ADMIN_PATTERNS"
printf "   rule loaded  %s\n" "$verdict"
# Reachable by Caddy, without which systemctl reload caddy would fail: its
# ExecReload goes through it under the caddy account. Refused to any other
# account and to the dashboard when ADMIN_MODE is close. /config/ reads without
# changing anything, and the answer goes to /dev/null: only the code is kept.
url_admin="http://127.0.0.1:$ADMIN_PORT/config/"
admin_caddy="$(ssh "$SITESOLIDE_SERVER" "sudo -u caddy curl -s -o /dev/null -w '%{http_code}' --max-time 5 $url_admin || true")"
admin_other="$(ssh "$SITESOLIDE_SERVER" "sudo -u nobody curl -s -o /dev/null -w '%{http_code}' --max-time 5 $url_admin || true")"
admin_dashboard="$(ssh "$SITESOLIDE_SERVER" "sudo -u site-dashboard curl -s -o /dev/null -w '%{http_code}' --max-time 5 $url_admin || true")"
expected_admin="000"
[ "$ADMIN_MODE" = close ] || expected_admin="(free)"
verdict="ok"
if [ "$admin_caddy" = "000" ]; then verdict="FAILED: Caddy no longer reaches its API, systemctl reload caddy would fail"; FAILURES=$((FAILURES + 1)); fi
if [ "$ADMIN_MODE" = close ] && { [ "$admin_other" != "000" ] || [ "$admin_dashboard" != "000" ]; }; then
  verdict="FAILED: another account reaches the API"; FAILURES=$((FAILURES + 1))
fi
printf "   caddy %s, other %s, dashboard %s (expected for the last two %s)  %s\n" \
  "$admin_caddy" "$admin_other" "$admin_dashboard" "$expected_admin" "$verdict"

echo "-> each site, over HTTPS"
ADDRESSES=("https://$SITESOLIDE_ZONE/")
while IFS= read -r slug; do
  [ -n "$slug" ] && [ "$slug" != "$SITESOLIDE_ZONE" ] && ADDRESSES+=("https://$slug.$SITESOLIDE_ZONE/")
done < <(ssh "$SITESOLIDE_SERVER" '
  for folder in /srv/sites/*/; do
    slug=$(basename "$folder")
    if [ -n "$(ls -A "$folder/public" 2>/dev/null)" ] || systemctl is-active --quiet "$slug"; then
      echo "$slug"
    fi
  done')
for address in "${ADDRESSES[@]}"; do
  code="$(curl -sS -o /dev/null --max-time 15 -w '%{http_code}' "$address" 2>/dev/null || echo 000)"
  case "$code" in
    200|401) printf "   %-44s %s\n" "$address" "$code" ;;
    *) printf "   %-44s %s  FAILED\n" "$address" "$code"; FAILURES=$((FAILURES + 1)) ;;
  esac
done

if [ "$FAILURES" -gt 0 ]; then
  echo "!! $FAILURES discrepancy(ies): previous rule restored" >&2
  restore
  exit 1
fi

# --- lasting commissioning ---------------------------------------------------

ssh "$SITESOLIDE_SERVER" "sudo systemctl stop $SAFETY_UNIT.timer $SAFETY_UNIT.service 2>/dev/null || true
  sudo install -m 644 -o root -g root $WORK_VM/sitesolide-loopback.service $UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable --now sitesolide-loopback >/dev/null 2>&1
  systemctl is-active sitesolide-loopback >/dev/null"
echo "-> safety net disarmed, rule reloaded at every boot"
if [ "$MODE" = observe ] || [ "$ADMIN_MODE" = observe ]; then
  echo "   observe: read again in a few hours with bin/deploy-loopback.sh state"
  echo "   the tests above are already counted there: nobody (uid 65534) and site-dashboard"
fi
