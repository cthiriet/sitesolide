#!/usr/bin/env bash
#
# Deploys the Caddy configuration to the VM.
#
#   bin/deploy-caddy.sh                    the Caddyfile: deposits, validates,
#                                          reloads, verifies
#   bin/deploy-caddy.sh <slug>.caddy ...   the Caddyfile and those blocks
#   bin/deploy-caddy.sh --dry-run [...]    shows what would change, touches nothing
#
# The Caddyfile imports /etc/caddy/sites/*.caddy, one block per project, and
# the pair is validated together on the machine, with the blocks already in
# service there. A block leaves only when it is given: `sitesolide deploy`
# passes the one it has just generated for its project, and nothing else. The
# blocks of the other projects are the machine's, and a deployment of one site
# never rewrites another's.
#
# WHAT IS NOT DEPOSITED HERE: /etc/caddy/locks/*.caddy, produced by bin/lock.sh
# from the codes that live on the VM, and /etc/caddy/domaines.map, produced by
# bin/generate-domains.sh. Overwriting them from the workstation would reopen
# locked previews.
#
# WHAT STOPS THE SCRIPT BEFORE ANY WRITE: a block given whose door contradicts
# the manifest the VM carries for its site. The portal of a deployed site is set
# from the dashboard, and the VM is the source of truth: the script refuses to
# contradict it and points to `sitesolide deploy`, which reads the door there.
#
# WHAT KEEPS IT ALONE ON CADDY: the lock it shares with the dashboard's
# gatekeeper, /run/sitesolide-gatekeeper/caddy.lock, taken before the guard and
# released at the very end, verification and restore included, on every path.
# Without it, a portal set from the dashboard between the guard and the deposit,
# or during the verification, was overwritten by the deposit or by the rsync
# --delete of the restore, and the site served in the clear without anything
# saying so. Launched by a gesture that already holds the lock, `sitesolide
# deploy`, `remove` or bin/lock.sh, the script receives its line in
# CADDY_LOCK_HELD: it checks on the VM that the holder really is that one, and
# neither takes nor releases anything. In a dry run, it takes nothing, writing
# nothing. See bin/cli/caddy-lock.ts.
#
# WHAT IS NEVER USED: caddy stop and caddy start. They address the
# administration API 127.0.0.1:2019, hence production, whatever the --config
# passed as an argument, and have already cut the three sites. See the
# Production section of CLAUDE.md. Only systemctl reload applies a
# configuration, and it does so without an outage.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/bin/config.sh"
sitesolide_require_config
DRY_RUN=""
BLOCKS=()
for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY_RUN="yes" ;;
    *.caddy)
      [ -f "$argument" ] || { echo "not found: $argument" >&2; exit 1; }
      [[ "$(basename "$argument")" =~ ^[a-z0-9][a-z0-9-]*\.caddy$ ]] || { echo "unexpected block name: $argument" >&2; exit 1; }
      BLOCKS+=("$argument")
      ;;
    *) echo "usage: bin/deploy-caddy.sh [--dry-run] [<slug>.caddy ...]" >&2; exit 2 ;;
  esac
done

# A fragment to remove from the VM, named by `sitesolide remove`. This script
# never deletes an orphan by itself, and the block of a removed project
# therefore stayed loaded, its service stopped behind it. Measured on 15
# September 2026 while removing a project. The removal goes through the same
# transaction as the rest: backup, validation, reload, verification, restore at
# the slightest failure, the backup still containing the fragment.
SITESOLIDE_REMOVE="${SITESOLIDE_REMOVE:-}"
if [ -n "$SITESOLIDE_REMOVE" ] && ! [[ "$SITESOLIDE_REMOVE" =~ ^[a-z0-9][a-z0-9-]*\.caddy$ ]]; then
  echo "unexpected SITESOLIDE_REMOVE: $SITESOLIDE_REMOVE" >&2
  exit 1
fi

CADDYFILE="$REPO_ROOT/infra/caddy/Caddyfile"
[ -f "$CADDYFILE" ] || { echo "not found: $CADDYFILE" >&2; exit 1; }

echo "-> to deposit"
echo "   infra/caddy/Caddyfile"
for block in ${BLOCKS[@]+"${BLOCKS[@]}"}; do echo "   $(basename "$block")"; done

# --- what would change ---------------------------------------------------------

# A connection that fails must not pass for a difference. Without this check,
# compare() reads no remote fingerprint, concludes that everything must be
# deposited, and the script announces imaginary changes before failing further
# on at the first write. Measured on 19 August 2026, ssh agent unreachable.
if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "$SITESOLIDE_SERVER" true 2>/dev/null; then
  echo "!! $SITESOLIDE_SERVER unreachable: ssh key loaded?" >&2
  exit 1
fi

# --- the lock shared with the gatekeeper ---------------------------------------

# Taken before the guard, which reads the doors, and released by the exit trap:
# the gatekeeper can no longer change a door between the read and the deposit,
# nor during the verification and the restore, which put back a backup taken
# here. INT and TERM go through exit so that the EXIT trap releases the lock on
# an interruption too; the exit code stays the one of the path followed.
#
# The holder line is only kept once the take is confirmed: releasing somebody
# else's lock is exactly what the release refuses to do.
CADDY_LOCK=""
release_caddy_lock() {
  [ -n "$CADDY_LOCK" ] || return 0
  SITESOLIDE_SERVER="$SITESOLIDE_SERVER" bun "$REPO_ROOT/bin/portal-guard.ts" --lock release "$CADDY_LOCK" || true
  CADDY_LOCK=""
}
trap release_caddy_lock EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -z "$DRY_RUN" ]; then
  if [ -n "${CADDY_LOCK_HELD:-}" ]; then
    echo "-> Caddy lock: held by the caller ($CADDY_LOCK_HELD)"
    SITESOLIDE_SERVER="$SITESOLIDE_SERVER" bun "$REPO_ROOT/bin/portal-guard.ts" --lock verify "$CADDY_LOCK_HELD" || exit 1
  else
    echo "-> Caddy lock"
    CADDY_LOCK="$(SITESOLIDE_SERVER="$SITESOLIDE_SERVER" bun "$REPO_ROOT/bin/portal-guard.ts" --lock take deploy-caddy $$)" || exit 1
  fi
fi

# --- the portal set from the dashboard -----------------------------------------

# The dashboard sets and removes a site's portal on the VM: it rewrites the
# deposited manifest and the block in service. A block generated elsewhere and
# deposited here without looking would silently remove a door set from the
# dashboard, and the site would be served in the clear, or would set back one
# that the dashboard has removed.
#
# The VM is the source of truth. Each block given is confronted with the
# deposited manifest of its site, all read over a single connection, and any
# contradiction stops the script here, before the slightest write and even
# before the comparison of the fingerprints. An unreadable read stops it too.
# The gesture that reconciles is `sitesolide deploy` in the site's folder: it
# reads the VM's door and generates the block from it. With no block given,
# only the Caddyfile leaves, and there is nothing to confront.
# See bin/portal-guard.ts and bin/cli/portal-vm.ts.
if [ "${#BLOCKS[@]}" -gt 0 ]; then
  echo "-> portal: the blocks given confronted with the deposited manifests"
  SITESOLIDE_SERVER="$SITESOLIDE_SERVER" SITESOLIDE_REMOVE="$SITESOLIDE_REMOVE" bun "$REPO_ROOT/bin/portal-guard.ts" "${BLOCKS[@]}" >/dev/null || exit 1
fi

echo "-> differences with the VM"
DIFFERENCES=""
compare() {
  local local_file="$1" remote="$2"
  local a b
  a="$(shasum -a 256 "$local_file" | cut -d' ' -f1)"
  b="$(ssh "$SITESOLIDE_SERVER" "sudo shasum -a 256 $remote 2>/dev/null" | cut -d' ' -f1 || true)"
  if [ "$a" = "$b" ]; then
    echo "   unchanged  $remote"
  else
    echo "   TO DEPOSIT $remote"
    DIFFERENCES="yes"
  fi
}
compare "$CADDYFILE" /etc/caddy/Caddyfile
for block in ${BLOCKS[@]+"${BLOCKS[@]}"}; do compare "$block" "/etc/caddy/sites/$(basename "$block")"; done
if [ -n "$SITESOLIDE_REMOVE" ]; then
  if ssh "$SITESOLIDE_SERVER" "sudo test -e /etc/caddy/sites/$SITESOLIDE_REMOVE"; then
    echo "   TO REMOVE  /etc/caddy/sites/$SITESOLIDE_REMOVE"
    DIFFERENCES="yes"
  else
    echo "   already gone /etc/caddy/sites/$SITESOLIDE_REMOVE"
  fi
fi

# The blocks in service whose site the machine no longer carries. They are not
# deleted, the folder also holding manual backups, but they are named: a block
# left behind its site is exactly what made a subdomain return 502 on 19 August
# 2026, without anything reporting it before the final verification. The
# machine says which sites exist, no list kept on the workstation does.
ORPHANS="$(ssh "$SITESOLIDE_SERVER" 'for block in /etc/caddy/sites/*.caddy; do [ -e "$block" ] || continue; slug=$(basename "$block" .caddy); [ -d "/srv/sites/$slug" ] || echo "$slug.caddy"; done' | grep -vx "$SITESOLIDE_REMOVE" || true)"
if [ -n "$ORPHANS" ]; then
  echo "-> blocks in service whose site the machine no longer carries"
  printf '%s\n' "$ORPHANS" | sed 's|^|   ORPHAN /etc/caddy/sites/|'
  echo "   remove them by hand if they no longer serve: their block stays loaded"
fi

if [ -z "$DIFFERENCES" ]; then
  echo "-> nothing to do, the VM already carries this configuration"
  exit 0
fi

if [ -n "$DRY_RUN" ]; then
  echo "-> dry run, nothing was touched"
  exit 0
fi

# --- deposit, validation, reload -----------------------------------------------

# THE GUARD THAT AVOIDS A TOTAL OUTAGE.
#
# The Caddyfile and the fragments no longer write the zone but
# {$SITESOLIDE_ZONE}, which Caddy substitutes BY READING ITS OWN ENVIRONMENT.
# The validation below sources /etc/caddy/sitesolide.env by hand and would
# therefore pass without proving anything, whereas `systemctl reload` addresses
# the process in service: if its unit does not load that file, it would load a
# configuration whose addresses are all empty, and EVERY site of the machine
# would fall.
#
# A reload never reads the unit again. The file is therefore set once, by hand,
# with a restart:
#
#   sudo cp infra/caddy/caddy.service.d/override.conf \
#     /etc/systemd/system/caddy.service.d/override.conf
#   sudo systemctl daemon-reload && sudo systemctl restart caddy
echo "-> does Caddy's unit load the zone variables?"
LOADED="$(ssh "$SITESOLIDE_SERVER" "systemctl show caddy --property=EnvironmentFiles --value" || true)"
if ! grep -q "/etc/caddy/sitesolide.env" <<<"$LOADED"; then
  cat >&2 <<EOF
!! STOP: the caddy.service unit does not load /etc/caddy/sitesolide.env.
   The Caddyfile reads \$SITESOLIDE_ZONE; without that file in the process
   environment, the reload would set a configuration with empty addresses and
   every site would fall. A reload never reads the unit again.

   On the VM, once:
     sudo mkdir -p /etc/systemd/system/caddy.service.d
     sudo cp override.conf /etc/systemd/system/caddy.service.d/override.conf
     sudo systemctl daemon-reload && sudo systemctl restart caddy

   The override is in infra/caddy/caddy.service.d/override.conf.
   EnvironmentFiles seen: ${LOADED:-none}
EOF
  exit 1
fi

# One backup per run, timestamped, kept on the VM. It serves the automatic
# recovery further down, and the one made by hand the next day.
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/var/backups/caddy/$TIMESTAMP"

echo "-> backup to $BACKUP"
ssh "$SITESOLIDE_SERVER" "sudo mkdir -p $BACKUP/sites \
  && sudo cp /etc/caddy/Caddyfile $BACKUP/ \
  && sudo cp /etc/caddy/sitesolide.env $BACKUP/ 2>/dev/null \
  ; sudo cp -r /etc/caddy/sites/. $BACKUP/sites/ 2>/dev/null || true"

echo "-> deposit"
WORK="$(ssh "$SITESOLIDE_SERVER" 'mktemp -d /tmp/caddy.XXXXXXXX')"
rsync -a "$CADDYFILE" "$SITESOLIDE_SERVER:$WORK/Caddyfile"
for block in ${BLOCKS[@]+"${BLOCKS[@]}"}; do rsync -a "$block" "$SITESOLIDE_SERVER:$WORK/$(basename "$block")"; done

# The variables Caddy substitutes in the Caddyfile BEFORE reading it: the zone,
# the contact address of the authority, and the placeholder that carries the
# slug in the wildcard block. They come from the workstation's configuration,
# never from the repository, which names no machine. systemd provides them to
# the service through EnvironmentFile, like the Cloudflare token, and the
# validation below loads them the same way. See
# infra/caddy/caddy.service.d/override.conf. Written by the remote shell,
# without a local temporary: setting a second EXIT trap here to clean up a
# mktemp would replace the one that releases the Caddy lock, and the lock would
# stay taken.
ssh "$SITESOLIDE_SERVER" "cat > $WORK/sitesolide.env" <<ENVFILE
# Generated by bin/deploy-caddy.sh from ~/.config/sitesolide/config.json.
# Do not edit by hand: the next deposit overwrites it.
#
# The three names Caddy substitutes in its file, before it reads it. The prefix
# keeps a name as short as a zone or a contact address out of the way of the
# environment of whoever installs this software.
#
# SITESOLIDE_ZONE is read twice over: Caddy substitutes it, and the services
# that load this file read it as an ordinary variable, the shared service
# first, whose ask endpoint refuses on demand any name of the zone the wildcard
# already covers. One line is enough, the value being the same.
SITESOLIDE_ZONE=$SITESOLIDE_ZONE
SITESOLIDE_ACME_EMAIL=$SITESOLIDE_EMAIL
SITESOLIDE_SLUG=$SLUG_LABEL
SITESOLIDE_CONTACT=${SITESOLIDE_CONTACT:-}
ENVFILE

ssh "$SITESOLIDE_SERVER" "
  set -e
  sudo install -m 644 -o root -g root $WORK/Caddyfile /etc/caddy/Caddyfile
  sudo install -m 644 -o root -g root $WORK/sitesolide.env /etc/caddy/sitesolide.env
  sudo mkdir -p /etc/caddy/sites
  for f in $WORK/*.caddy; do
    [ -e \"\$f\" ] || continue
    sudo install -m 644 -o root -g root \"\$f\" /etc/caddy/sites/\$(basename \"\$f\")
  done
  ${SITESOLIDE_REMOVE:+sudo rm -f /etc/caddy/sites/$SITESOLIDE_REMOVE}
"

# The validation loads the Cloudflare token and the zone's variables from the
# same files as systemd.
# Without it, the DNS module refuses a perfectly healthy configuration by
# announcing an empty token: the message makes one believe in a breakdown that
# does not exist, and it has already wasted time in the middle of an outage.
echo "-> validation, with the token as systemd provides it"
# Puts the previous configuration back and reloads it. Called at every failure,
# and it must succeed even when everything else has failed: no `set -e` must be
# able to interrupt it, hence the `|| true` and the absence of a pipe.
restore() {
  echo "!! restoring $BACKUP" >&2
  if ssh "$SITESOLIDE_SERVER" "
    set -e
    sudo cp $BACKUP/Caddyfile /etc/caddy/Caddyfile
    [ -f $BACKUP/sitesolide.env ] && sudo cp $BACKUP/sitesolide.env /etc/caddy/sitesolide.env || true

    # --delete, and not a cp over the top. A cp puts the old files back but
    # leaves those the deposit had just added: the restore announced itself
    # satisfied while leaving in service a fragment nobody had validated.
    # Measured on 19 August 2026, where a block pointing at a service never
    # deployed survived the failure and returned 502 on its address.
    #
    # The guard is not decorative: an empty backup, for want of a folder on the
    # first run, would empty /etc/caddy/sites with --delete.
    if [ -n \"\$(ls -A $BACKUP/sites 2>/dev/null)\" ]; then
      sudo rsync -a --delete $BACKUP/sites/ /etc/caddy/sites/
    fi

    sudo systemctl reload caddy
  "; then
    echo "!! previous configuration in service" >&2
  else
    echo "!! THE RESTORE FAILED. Intervene by hand:" >&2
    echo "   ssh $SITESOLIDE_SERVER 'sudo cp $BACKUP/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy'" >&2
  fi
  ssh "$SITESOLIDE_SERVER" "sudo rm -rf $WORK" >/dev/null 2>&1 || true
}

# The output is kept in order to show it in case of a refusal. It is NOT taken
# again by a second call piped to tail: with `set -o pipefail`, that pipe
# returned the non-zero code of caddy validate, `set -e` killed the script on
# the spot, and the restore below never took place. The broken configuration
# then stayed on the disk while Caddy was still serving the old one from its
# memory, until the first restart. Measured in real conditions.
VALIDATION="$(ssh "$SITESOLIDE_SERVER" "sudo bash -c 'set -a; . /etc/caddy/cloudflare.env; . /etc/caddy/sitesolide.env; set +a; caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile' 2>&1" || true)"
if ! grep -q "Valid configuration" <<<"$VALIDATION"; then
  echo "!! configuration refused by caddy validate" >&2
  grep -iE "^Error|error:" <<<"$VALIDATION" | tail -3 >&2 || tail -3 <<<"$VALIDATION" >&2
  restore
  exit 1
fi

echo "-> reload"
if ! ssh "$SITESOLIDE_SERVER" "sudo systemctl reload caddy"; then
  echo "!! reload refused" >&2
  restore
  exit 1
fi

ssh "$SITESOLIDE_SERVER" "sudo rm -rf $WORK" >/dev/null 2>&1 || true

# --- verification --------------------------------------------------------------

# A "systemctl is-active" is not enough: Caddy can run while serving a
# configuration that no longer answers on a domain. The sites are queried.
echo "-> verification"
ADDRESSES=("https://$SITESOLIDE_ZONE/" "https://www.$SITESOLIDE_ZONE/")

# The addresses queried are those of the projects REALLY served, read on the VM
# and not inferred from the repository. A folder of sites/ never deployed has no
# folder over there: querying it would make a perfectly healthy deployment fail,
# the wildcard returning 404 on a missing folder, and restore() would cancel
# everything.
#
# Measured on 19 August 2026 with a project present in the repository for days
# and never put online. The list drawn from the repository could not know it.
#
# This source also holds for the projects deployed from another repository,
# which bin/sitesolide.ts installs without adding anything under sites/.
while IFS= read -r slug; do
  [ -n "$slug" ] || continue

  # The landing serves the bare domain: it is already covered above by its two
  # addresses, and its server folder carries the domain's name. Without this
  # skip, https://<zone>.<zone>/ would be queried.
  [ "$slug" = "$SITESOLIDE_ZONE" ] && continue

  ADDRESSES+=("https://$slug.$SITESOLIDE_ZONE/")
done < <(ssh "$SITESOLIDE_SERVER" '
  # A folder is not enough: the project must SERVE something, a public/ that is
  # not empty or an active service. A project deployed halfway, whose directory
  # tree exists but where nothing answers, would return 404 and would make a
  # perfectly healthy Caddy deployment fail.
  #
  # That case came up on 19 August 2026: a project refused in the middle of its
  # deployment, for want of a secret, already had its folder. The reload of
  # Caddy had nothing to do with it.
  for folder in /srv/sites/*/; do
    slug=$(basename "$folder")
    if [ -n "$(ls -A "$folder/public" 2>/dev/null)" ] || systemctl is-active --quiet "$slug"; then
      echo "$slug"
    fi
  done')

FAILURES=0
for address in "${ADDRESSES[@]}"; do
  code="$(curl -sS -o /dev/null --max-time 15 -w '%{http_code}' "$address" 2>/dev/null || echo 000)"
  case "$code" in
    # 401 is the intended behaviour of a locked preview, see bin/lock.sh, and of
    # a site behind the portal, see portal/README.md.
    200) printf "   %-44s %s\n" "$address" "$code" ;;
    401) printf "   %-44s %s (closed: lock or portal)\n" "$address" "$code" ;;
    *)   printf "   %-44s %s  FAILED\n" "$address" "$code"; FAILURES=$((FAILURES + 1)) ;;
  esac
done

if [ "$FAILURES" -gt 0 ]; then
  echo "!! $FAILURES address(es) no longer answer" >&2
  restore
  exit 1
fi

echo "-> in service. Previous backup: $BACKUP"
# The lock is released by the exit trap, here as on every other path.
