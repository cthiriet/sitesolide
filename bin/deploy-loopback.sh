#!/usr/bin/env bash
#
# The loopback rule: on the VM, only Caddy and root open a connection to the
# ports of the services, both blocks, 3000 to 3099 and 21000 to 29999
# (SERVICE_PORT_RANGES in bin/cli/manifest.ts), and to Caddy's administration
# API, 2019. One exception: the dashboard towards the portal, for the guest
# accesses. Behind a Cloudflare Tunnel, only the tunnel's connector opens one
# from ::1 to Caddy's 443, where Caddy believes the visitor's address.
#
#   bin/deploy-loopback.sh observe   counts and logs what would be refused, refusing nothing
#   bin/deploy-loopback.sh state     what has been counted, and the journal's last lines
#   bin/deploy-loopback.sh close     refuses the others, verifies, and withdraws itself at the slightest gap
#   ADMIN_MODE=observe bin/deploy-loopback.sh close   closes the services, only observes the administration API
#   bin/deploy-loopback.sh remove    removes the rule, its unit and its reserved ports
#
# Why: a site behind the portal no longer verifies anything itself, it trusts
# Caddy. Without this rule, any service of the machine would reach its port
# without going through Caddy. Worse, it would reach Caddy's administration
# API, which authenticates nobody: a configuration without forward_auth opens
# every site of the portal there, a stop cuts the whole machine. Behind a
# tunnel, any service would give Caddy any visitor's address. See
# bin/cli/loopback.ts.
#
# What the gesture touches, and nothing else: the nftables table inet
# sitesolide_boucle, which neither ufw nor Caddy touch; /etc/sitesolide-loopback.nft;
# the sitesolide-loopback.service unit, which reloads it at boot; and
# /etc/sysctl.d/90-sitesolide-service-ports.conf with the live
# net.ipv4.ip_local_reserved_ports it sets, the services' ports kept out of
# the ports the kernel hands out by itself (PORT_RESERVATION_FILE in
# bin/cli/loopback.ts), what another file reserved carried over.
# /etc/sitesolide-loopback-projects.nft, the ports each project with several
# services may open towards its own, is written by sitesolide deploy and only
# replayed here: laying the table empties that set.
#
# THE MACHINE FIRST. The rule reserves the second block only once nothing
# else may listen there: every unit that runs as a project's account denies
# it, as systemd has the unit loaded; the backup component and the installer,
# which run a project's programs outside its units, carry this release's bind
# lines; and the kernel never hands one of its ports out by itself. The rule
# judges who connects, never who listens, and a unit generated before the
# second block may bind any of its ports, where Caddy would send another
# project's visitors. Until then nothing is laid, observe included:
# `sitesolide upgrade` brings the components, `sitesolide refresh --all`
# writes the units, and this script names what it still finds, then lays the
# reserved ports itself. A deployment refuses a port of the second block until
# the rule laid here refuses the others there, which a rule in observe does
# not (secondBlockRefusal in bin/cli/services.ts).
#
# THE SAFETY NET. Before closing, a systemd timer is armed to remove the table
# two minutes later. It is only disarmed once these are verified: Caddy towards
# each listening port, the refusal of any other account, the rule of the
# administration API loaded in the kernel with Caddy alone reaching it, behind
# a tunnel the connector alone reaching Caddy from ::1, and each site over
# HTTPS, through the tunnel when there is one.
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
RESERVATION=/etc/sysctl.d/90-sitesolide-service-ports.conf
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
  # The reserved ports stay in the kernel until the next boot: harmless, and
  # what another file reserved stays reserved.
  ssh "$SITESOLIDE_SERVER" "sudo systemctl disable --now sitesolide-loopback 2>/dev/null || true
    sudo $NFT delete table inet $TABLE 2>/dev/null || true
    sudo rm -f $FILE $UNIT $RESERVATION
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
# String(), never the number itself: console.log colours a number when the
# terminal forces colour (FORCE_COLOR), and the port came back wrapped in
# escape codes, which made every probe below ask a URL curl cannot read.
PORTAL_PORT="$(cd "$REPO_ROOT" && bun -e 'import { PORTAL_PORT } from "./bin/cli/portal"; console.log(String(PORTAL_PORT))')"

# Behind a Cloudflare Tunnel, the connector's uid, the one account that may
# speak from ::1, where Caddy believes the visitor's address in
# Cf-Connecting-Ip. The machine is behind one when Caddy's options for it are
# laid, which is what makes Caddy believe the header: then they must be the
# kit's, trusting ::1 alone, and the connector must run as its own account,
# or the rule would cut every site from the Internet. Either one missing,
# nothing is laid. The names are bin/cli/tunnel.ts's: CADDY_TUNNEL_FILE,
# TUNNEL_KIT_FILES.caddy, TUNNEL_ACCOUNT and TUNNEL_UNIT.
TUNNEL_CADDY=/etc/caddy/global.d/tunnel.caddy
TUNNEL_ACCOUNT=sitesolide-tunnel
TUNNEL_UID=""
if ssh -n "$SITESOLIDE_SERVER" "test -f $TUNNEL_CADDY"; then
  if ! ssh -n "$SITESOLIDE_SERVER" "cat $TUNNEL_CADDY" | cmp -s - "$REPO_ROOT/infra/tunnel/tunnel.caddy"; then
    echo "$TUNNEL_CADDY is not this kit's: bring the tunnel up to date first, sitesolide upgrade" >&2
    exit 1
  fi
  # SYSTEMD_NSS_DYNAMIC_BYPASS=1: the static account alone, never the dynamic
  # one of the same name a unit from before it would run as.
  TUNNEL_UID="$(ssh -n "$SITESOLIDE_SERVER" "SYSTEMD_NSS_DYNAMIC_BYPASS=1 id -u $TUNNEL_ACCOUNT" 2>/dev/null || true)"
  running="$(ssh -n "$SITESOLIDE_SERVER" 'pid=$(systemctl show -p MainPID --value sitesolide-tunnel); [ "$pid" = 0 ] || stat -c %u /proc/$pid' || true)"
  if [ -z "$TUNNEL_UID" ] || [ "$running" != "$TUNNEL_UID" ]; then
    echo "the tunnel's connector does not run as $TUNNEL_ACCOUNT${running:+ (uid $running)}: bring the tunnel up to date first, sitesolide upgrade" >&2
    exit 1
  fi
fi
# The machine before the rule: see THE MACHINE FIRST above. One read, as
# root, changing nothing; the command and its reading are
# bin/cli/services.ts's, tested there.
STATE_COMMAND="$(cd "$REPO_ROOT" && bun -e 'import { secondBlockStateCommand } from "./bin/cli/services"; console.log(secondBlockStateCommand())')"
STATE_ANSWER="$(ssh -n "$SITESOLIDE_SERVER" "$STATE_COMMAND" || true)"
# The manifests the machine carries: a socket on a port of the second block
# that none declares, or that another account holds, is a stray.
MANIFESTS_COMMAND="$(cd "$REPO_ROOT" && bun -e 'import { readManifestsCommand } from "./bin/cli/portal-vm"; console.log(readManifestsCommand("*"))')"
MANIFESTS_ANSWER="$(ssh -n "$SITESOLIDE_SERVER" "$MANIFESTS_COMMAND" || true)"
UNREADY="$(cd "$REPO_ROOT" && ANSWER="$STATE_ANSWER" MANIFESTS="$MANIFESTS_ANSWER" bun -e '
  import { readDepositedManifests } from "./bin/cli/portal-vm";
  import { BIND_COMPONENTS, readSecondBlockState, strayListeners, unguardedUnits } from "./bin/cli/services";
  const state = readSecondBlockState(process.env.ANSWER ?? "");
  const deposited = readDepositedManifests(process.env.MANIFESTS ?? "");
  if (state === null || deposited.kind !== "read") process.exit(1);
  const lines = [
    ...unguardedUnits(state).map((unit) => `unit ${unit}`),
    ...BIND_COMPONENTS.filter((name) => state.components[name] === "outdated").map((name) => `component ${name}`),
    ...strayListeners(state.listeners, deposited.manifests).map((listener) => `listener ${listener.port} ${listener.account ?? `uid ${listener.uid}`}`),
  ];
  if (lines.length > 0) console.log(lines.join("\n"));
')" || { echo "the VM did not read: its units, a systemctl that failed or answered for fewer units than it has, its components, its listening sockets, its manifests or its reserved ports; nothing is set" >&2; exit 1; }
if printf '%s\n' "$UNREADY" | grep -q '^component '; then
  echo "these components were built before the second block of the services' ports, and run a project's programs where they may listen there:" >&2
  printf '%s\n' "$UNREADY" | sed -n 's/^component /   /p' >&2
  echo "bring them up to date first: sitesolide upgrade. Then run this script again. Nothing is set." >&2
  exit 1
fi
if printf '%s\n' "$UNREADY" | grep -q '^listener '; then
  # Named down to the process and its unit: a run started under an earlier
  # unit, a scheduled one up to 24 hours long, holds its socket through any
  # reload, and would take the visitors of the next project given the port.
  echo "something already listens on a port of the second block that no project on the machine declares, or that another account holds:" >&2
  printf '%s\n' "$UNREADY" | sed -n 's/^listener /   port /p' >&2
  for port in $(printf '%s\n' "$UNREADY" | sed -n 's/^listener \([0-9]*\) .*/\1/p'); do
    ssh -n "$SITESOLIDE_SERVER" "sudo ss -ltnHp 'sport = :$port'; for pid in \$(sudo ss -ltnHp 'sport = :$port' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do ps -o pid=,unit=,args= -p \$pid; done" 2>/dev/null | sed 's/^/      /' >&2 || true
  done
  echo "stop it first, its unit or the process, or wait for a scheduled run to end. Then run this script again. Nothing is set." >&2
  exit 1
fi
if printf '%s\n' "$UNREADY" | grep -q '^unit '; then
  echo "these units run as a project's account and may listen on the services' ports, the second block's among them, as systemd has them loaded:" >&2
  printf '%s\n' "$UNREADY" | sed -n 's/^unit /   /p' >&2
  echo "write them again first: sitesolide refresh --all, from a workstation with this release; one it keeps" >&2
  echo "as edited by hand takes sitesolide deploy --force in its project's folder, or the missing" >&2
  echo "SocketBindDeny= lines added by hand, then systemctl daemon-reload and a restart of the unit." >&2
  echo "Then run this script again. Nothing is set." >&2
  exit 1
fi
# The reserved ports the kernel carries, every block added and the rest kept:
# writing the key replaces the whole list.
LIVE_RESERVED="$(ssh -n "$SITESOLIDE_SERVER" 'cat /proc/sys/net/ipv4/ip_local_reserved_ports' || true)"

ADMIN_PORT="$(cd "$REPO_ROOT" && bun -e 'import { CADDY_ADMIN_PORT } from "./bin/cli/loopback"; console.log(String(CADDY_ADMIN_PORT))')"
# The listening sockets of every block, as ss filters them.
LISTENING_FILTER="$(cd "$REPO_ROOT" && bun -e 'import { listeningFilter } from "./bin/cli/loopback"; console.log(listeningFilter())')"
WORK="$(mktemp -d)"
WORK_VM=""
on_exit() {
  rm -rf "$WORK"
  [ -z "$WORK_VM" ] || ssh "$SITESOLIDE_SERVER" "sudo rm -rf $WORK_VM" >/dev/null 2>&1 || true
}
trap on_exit EXIT

(cd "$REPO_ROOT" && CADDY_UID="$CADDY_UID" DASHBOARD_UID="$DASHBOARD_UID" MODE="$MODE" ADMIN_MODE="$ADMIN_MODE" TUNNEL_UID="$TUNNEL_UID" bun -e '
  import { loopbackRule } from "./bin/cli/loopback";
  process.stdout.write(loopbackRule(
    Number(process.env.CADDY_UID),
    process.env.MODE as "observe" | "close",
    Number(process.env.DASHBOARD_UID),
    process.env.ADMIN_MODE as "observe" | "close",
    process.env.TUNNEL_UID === "" ? null : Number(process.env.TUNNEL_UID),
  ));
') > "$WORK/loopback.nft"
(cd "$REPO_ROOT" && LIVE="$LIVE_RESERVED" bun -e '
  import { portReservationFile, reservedPortsValue } from "./bin/cli/loopback";
  const value = reservedPortsValue(process.env.LIVE ?? "");
  if (value === null) process.exit(1);
  process.stdout.write(portReservationFile(value));
') > "$WORK/service-ports.conf" || { echo "the VM's reserved ports did not read, nothing is set" >&2; exit 1; }
# The services' two lines, the same way: every block in the set, in the rule's
# own mode.
SERVICES_PATTERNS="$(cd "$REPO_ROOT" && CADDY_UID="$CADDY_UID" MODE="$MODE" bun -e '
  import { servicesPatterns } from "./bin/cli/loopback";
  console.log(servicesPatterns(Number(process.env.CADDY_UID), process.env.MODE as "observe" | "close").join("\n"));
')"
[ "$(printf '%s\n' "$SERVICES_PATTERNS" | grep -c .)" = 2 ] || { echo "services patterns unreadable, nothing is set" >&2; exit 1; }
# The two lines of the administration API as nft list table will return them, in
# their order: what the verification will look for. Two, or nothing is set: an
# empty pattern would recognise any line at all.
ADMIN_PATTERNS="$(cd "$REPO_ROOT" && CADDY_UID="$CADDY_UID" MODE="$ADMIN_MODE" bun -e '
  import { adminPatterns } from "./bin/cli/loopback";
  console.log(adminPatterns(Number(process.env.CADDY_UID), process.env.MODE as "observe" | "close").join("\n"));
')"
[ "$(printf '%s\n' "$ADMIN_PATTERNS" | grep -c .)" = 2 ] || { echo "administration API patterns unreadable, nothing is set" >&2; exit 1; }
# The tunnel's two lines, the same way, on a machine behind one.
TUNNEL_PATTERNS=""
if [ -n "$TUNNEL_UID" ]; then
  TUNNEL_PATTERNS="$(cd "$REPO_ROOT" && TUNNEL_UID="$TUNNEL_UID" MODE="$MODE" bun -e '
    import { tunnelPatterns } from "./bin/cli/loopback";
    console.log(tunnelPatterns(Number(process.env.TUNNEL_UID), process.env.MODE as "observe" | "close").join("\n"));
  ')"
  [ "$(printf '%s\n' "$TUNNEL_PATTERNS" | grep -c .)" = 2 ] || { echo "tunnel patterns unreadable, nothing is set" >&2; exit 1; }
fi
sed "s|@NFT@|$NFT|g" "$REPO_ROOT/infra/loopback/sitesolide-loopback.service" > "$WORK/sitesolide-loopback.service"

echo "-> rule ($MODE, administration API $ADMIN_MODE), Caddy uid $CADDY_UID, dashboard uid $DASHBOARD_UID${TUNNEL_UID:+, connector uid $TUNNEL_UID}"
WORK_VM="$(ssh "$SITESOLIDE_SERVER" 'mktemp -d /tmp/loopback.XXXXXXXX')"
rsync -a "$WORK/loopback.nft" "$WORK/sitesolide-loopback.service" "$WORK/service-ports.conf" "$SITESOLIDE_SERVER:$WORK_VM/"

# nft -c reads again without applying anything: a refused rule stops here.
ssh "$SITESOLIDE_SERVER" "sudo $NFT -c -f $WORK_VM/loopback.nft" || {
  echo "rule refused by nft -c, nothing is set" >&2
  exit 1
}

# The services' ports kept out of the kernel's own choice, before the rule:
# SocketBindDeny= never sees a port the kernel hands out by itself, a bind to
# port 0 or a listen without bind. Laid for good, read back from the kernel,
# and nothing else is laid while the kernel may still hand one out.
echo "-> the services' ports, reserved from the kernel's own choice"
ssh "$SITESOLIDE_SERVER" "sudo install -m 644 -o root -g root $WORK_VM/service-ports.conf $RESERVATION && sudo sysctl -q -p $RESERVATION" ||
  echo "   !! the reservation could not be applied: the kernel's range decides below" >&2
PORTS_ANSWER="$(ssh -n "$SITESOLIDE_SERVER" 'cat /proc/sys/net/ipv4/ip_local_port_range /proc/sys/net/ipv4/ip_local_reserved_ports' || true)"
if ! (cd "$REPO_ROOT" && ANSWER="$PORTS_ANSWER" bun -e '
  import { autobindReachesBlocks } from "./bin/cli/loopback";
  const [range = "", reserved = ""] = (process.env.ANSWER ?? "").split("\n");
  process.exit(autobindReachesBlocks(range, reserved) === false ? 0 : 1);
'); then
  echo "the kernel may still hand a port of the services' blocks to a process that asks for none, nothing is set:" >&2
  printf '%s\n' "$PORTS_ANSWER" | sed 's/^/   /' >&2
  exit 1
fi
printf '   %s\n' "$(printf '%s\n' "$PORTS_ANSWER" | tail -1)"

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
# untested without a word. $3, the address, 127.0.0.1 unless given.
connects() {
  ssh -n "$SITESOLIDE_SERVER" "sudo -u '$1' timeout 5 bash -c 'exec 3<>/dev/tcp/${3:-127.0.0.1}/$2' >/dev/null 2>&1 && echo open || echo closed"
}

echo "-> Caddy towards each listening port, then any account"
PORTS="$(ssh "$SITESOLIDE_SERVER" "ss -ltnH '( $LISTENING_FILTER )' | awk '{print \$4}' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un")"
[ -n "$PORTS" ] || { echo "   no port listening in the blocks: failed read?" >&2; FAILURES=1; }
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

# What the kernel has loaded, and not the file that was sent: the lines below
# are looked for there.
LOADED="$(ssh "$SITESOLIDE_SERVER" "sudo $NFT list table inet $TABLE" || true)"

echo "-> the services' ports, every block"
# Caddy and root let through, then the others refused, or counted in
# observe: a deployment opens the second block only on the refusal.
verdict="ok"
previous=0
while IFS= read -r pattern; do
  rank="$(printf '%s\n' "$LOADED" | grep -nE -e "$pattern" | head -1 | cut -d: -f1 || true)"
  if [ -z "$rank" ] || [ "$rank" -le "$previous" ]; then
    verdict="FAILED: a block of the services' ports is missing from the loaded rule, or out of order"
    FAILURES=$((FAILURES + 1))
    break
  fi
  previous="$rank"
done <<< "$SERVICES_PATTERNS"
printf "   rule loaded  %s\n" "$verdict"

echo "-> Caddy's administration API, port $ADMIN_PORT"
# Set: its two lines, the acceptance before the refusal. The patterns come
# from bin/cli/loopback.ts, tested against the output of nft list.
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

if [ -n "$TUNNEL_UID" ]; then
  echo "-> behind the tunnel: Caddy's 443 from ::1, the connector's alone"
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
  done <<< "$TUNNEL_PATTERNS"
  printf "   rule loaded  %s\n" "$verdict"
  # A TCP connection again: the connector's account from ::1; nobody and root
  # refused there; and 127.0.0.1, the monitor's and the gatekeeper's, where
  # Caddy believes no header, open to all as before.
  connector="$(connects "$TUNNEL_ACCOUNT" 443 ::1)"
  other="$(connects nobody 443 ::1)"
  root="$(connects root 443 ::1)"
  plain="$(connects nobody 443 127.0.0.1)"
  verdict="ok"
  if [ "$connector" != open ]; then verdict="FAILED: the connector no longer reaches Caddy, every site is cut"; FAILURES=$((FAILURES + 1)); fi
  if [ "$MODE" = close ] && { [ "$other" != closed ] || [ "$root" != closed ]; }; then
    verdict="FAILED: another account speaks from ::1"; FAILURES=$((FAILURES + 1))
  fi
  if [ "$plain" != open ]; then verdict="FAILED: 127.0.0.1:443 refused, the probes fail"; FAILURES=$((FAILURES + 1)); fi
  printf "   ::1: connector %s, other %s, root %s (expected for the last two %s); 127.0.0.1: other %s  %s\n" \
    "$connector" "$other" "$root" "$([ "$MODE" = close ] && echo closed || echo '(free)')" "$plain" "$verdict"
fi

echo "-> each site, over HTTPS"
# The bare domain is the landing's, queried like any project only when it
# serves something: a fresh machine has no landing yet, and its 404 there,
# by design, undid the rule on every first install, as in bin/deploy-caddy.sh.
ADDRESSES=()
while IFS= read -r slug; do
  [ -n "$slug" ] || continue
  if [ "$slug" = "$SITESOLIDE_ZONE" ]; then
    ADDRESSES+=("https://$SITESOLIDE_ZONE/")
  else
    ADDRESSES+=("https://$slug.$SITESOLIDE_ZONE/")
  fi
done < <(ssh "$SITESOLIDE_SERVER" '
  for folder in /srv/sites/*/; do
    [ -d "$folder" ] || continue
    slug=$(basename "$folder")
    if [ -n "$(ls -A "$folder/public" 2>/dev/null)" ] || systemctl is-active --quiet "$slug"; then
      echo "$slug"
    fi
  done')
for address in ${ADDRESSES[@]+"${ADDRESSES[@]}"}; do
  # curl already writes 000 when nothing answers; an `|| echo 000` doubled it.
  # A test installation's staging certificates are accepted unverified, as
  # bin/deploy-caddy.sh's probe does.
  if [ "${SITESOLIDE_ACME:-}" = staging ]; then
    code="$(curl -sS -k -o /dev/null --max-time 15 -w '%{http_code}' "$address" 2>/dev/null || true)"
  else
    code="$(curl -sS -o /dev/null --max-time 15 -w '%{http_code}' "$address" 2>/dev/null || true)"
  fi
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
if [ "$MODE" = observe ]; then
  echo "   the second block of the services' ports stays shut to deployments until the rule is laid with close"
fi
