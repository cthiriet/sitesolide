#!/usr/bin/env bash
#
# State of the preview codes, measured on the VM, without touching anything.
#
#   bin/lock.sh state [slug]     what each site wants, installs and serves
#
# A preview subdomain is publicly reachable: the noindex keeps it out of Google,
# it closes it to nobody. A site whose general access is Anyone with the code
# answers a door page to whoever has no code, a six-character one the client
# receives once in a link and which his browser then keeps in a cookie.
#
# SETTING, REPLACING AND REMOVING A CODE IS NOT DONE HERE. One path changes a
# site's general access on the machine: the gatekeeper, launched by the steward,
# for the dashboard's Access section and for `sitesolide lock` and `unlock`
# alike. It draws the code on the machine, writes the manifest, the codes file
# and the locks' fragment in one transaction, validates, reloads Caddy with
# systemctl, checks the site over HTTPS and restores on any failure. See
# dashboard/src/gatekeeper/ and `lockPreview` in bin/sitesolide.ts.
#
# What this script reads, and only reads: the manifest deposited on the VM,
# which says what is wanted; the fragment Caddy imports, verrous.caddy, which
# says what is installed; and the site over HTTPS, which says what a visitor
# gets.
#
# WARNING: neither "caddy stop" nor "caddy start" here, ever. Those commands
# address the administration API of the instance in service, whatever the
# --config given, and stop production. See the Production section of CLAUDE.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/bin/config.sh"
sitesolide_require_config
# The repository that carries the projects' code, if there is one:
# SITESOLIDE_SITES_REPO, set by bin/config.sh from the configuration. An
# installation that has none leaves it empty, and the state then reads the
# current project's folder.

# The folder of locks is the one the Caddyfile imports by glob. The fragment
# keeps the name the machine carries, verrous.caddy.
LOCKS_DIR="${LOCKS_DIR:-/etc/caddy/locks}"
SITES_DIR="${SITES_DIR:-/srv/sites}"

usage() {
  sed -n '3,5p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# What the manifest deposited on the VM says of the lock and of the final
# domain: "lock", "domain.name" and "domain.active", in that order, one value
# per line. A column separator would be a trap here, the shell's "read" merging
# consecutive tabs and shifting everything as soon as a domain is missing.
#
# The machine's manifest and not the repository's: the dashboard changes a
# site's general access on the machine, and the repository only catches up at
# the next `sitesolide deploy`. A site never deployed reads as open.
#
# The reading goes through readManifest and not through a home-made JSON.parse:
# a manifest the CLI refuses stops the table rather than removing its line.
manifest_fields() {
  local slug="$1"
  ssh "$SITESOLIDE_SERVER" "sudo cat $SITES_DIR/$slug/sitesolide.json 2>/dev/null || true" \
    | (cd "$REPO_ROOT" && SLUG="$slug" bun -e '
    import { readManifest } from "./bin/cli/manifest";

    const raw = (await Bun.stdin.text()).trim();
    let manifest;
    if (raw !== "") {
      const read = readManifest(raw);
      if (read.manifest === undefined) {
        process.stderr.write(`${process.env.SLUG}: the manifest on the server: ${read.errors.join(", ")}\n`);
        process.exit(1);
      }
      manifest = read.manifest;
    }
    const fields = [
      manifest?.lock === true,
      manifest?.domain?.name ?? "",
      manifest?.domain?.active === true,
    ];
    process.stdout.write(`${fields.join("\n")}\n`);
  ')
}

http_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://${1:-$HOST}/"
}

# The cookie goes through the configuration read on standard input, never
# through an argument: curl -K - accepts the same options as on the command line
# without exposing them in the process list.
http_code_with_cookie() {
  local host="$2" name="$3"
  curl -s -o /dev/null -w '%{http_code}' --max-time 15 -K - <<EOF
url = "https://$host/"
header = "Cookie: lock_$name=$1"
EOF
}

SUBCOMMAND="${1:-}"
FILTER="${2:-}"

case "$SUBCOMMAND" in
  state)
    # Columns that may diverge, and that is the whole point: the manifest says
    # what is wanted, the fragment what is installed, the HTTP codes what the
    # visitor really gets.
    #
    # WITH CODE is measured with the code read IN the fragment in service, and
    # not with the one the operator believes he holds. An INSTALLED column at
    # "yes" only says that a stanza is present: a fragment carrying a stale code
    # shows a perfectly reassuring 401 while the link already sent to the client
    # no longer opens anything.
    #
    # FINAL DOMAIN recalls that the code only closes the preview. An active final
    # domain serves the same site without a code: the line measures it too,
    # otherwise a 401 on the preview would let one believe the site closed.
    printf '%-22s %-7s %-9s %-10s %-10s %s\n' \
      "SITE" "WANTED" "INSTALLED" "NO CODE" "WITH CODE" "FINAL DOMAIN"
    FRAGMENT="$(ssh "$SITESOLIDE_SERVER" "sudo cat $LOCKS_DIR/verrous.caddy 2>/dev/null || true")"

    # The sites to measure: the one "sitesolide lock --status" names, whose
    # folder may live outside the sites repository and not carry its slug, or
    # every folder of the sites repository.
    NAMES=()
    if [ -n "${SITESOLIDE_PROJECT_DIR:-}" ]; then
      [ -n "$FILTER" ] || usage
      NAMES=("$FILTER")
    else
      for folder in "${SITESOLIDE_SITES_REPO:-}"/*/; do
        name="$(basename "$folder")"
        [ -z "$FILTER" ] || [ "$FILTER" = "$name" ] || continue
        NAMES+=("$name")
      done
    fi

    for name in "${NAMES[@]}"; do
      # The landing has neither a preview nor a manifest. Without this skip, the
      # table shows for it a line WANTED=false, FINAL DOMAIN=- and a 404 on
      # landing.$SITESOLIDE_ZONE: a state table that lies is exactly what this
      # subcommand exists to avoid.
      [ "$name" = landing ] && continue
      # The name goes into a command run on the machine: a slug, or nothing.
      [[ "$name" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || continue

      HOST="$name.$SITESOLIDE_ZONE"
      # An unreadable manifest stops the table rather than removing its line: a
      # mute WANTED column on a locked site would read as an open site.
      fields="$(manifest_fields "$name")"
      { read -r wanted; read -r domain; read -r active; } <<<"$fields"
      installed=no
      with_code="-"
      if printf '%s\n' "$FRAGMENT" | grep -q "^# Preview lock: $name\$"; then
        installed=yes
        installed_code="$(printf '%s\n' "$FRAGMENT" | grep -o "@lock_key_$name query key=[A-Z0-9]*" | head -1 | sed 's/.*key=//')"
        # The host AND the site's name are passed explicitly: the cookie is
        # named after the site, and a table of every site has no single one.
        [ -z "$installed_code" ] || with_code="$(http_code_with_cookie "$installed_code" "$HOST" "$name")"
      fi

      if [ -z "$domain" ]; then
        column="-"
      elif [ "$active" = "true" ]; then
        column="$domain $(http_code "$domain") (active, outside the lock)"
      else
        column="$domain (inactive)"
      fi

      printf '%-22s %-7s %-9s %-10s %-10s %s\n' \
        "$name" "$wanted" "$installed" "$(http_code)" "$with_code" "$column"
    done
    ;;

  enable | code | disable)
    cat >&2 <<EOF
bin/lock.sh $SUBCOMMAND is gone: a site's preview code is set, replaced and
removed through the gatekeeper, from the site's Access section in the
dashboard, or from the project's folder:

  sitesolide lock              Anyone with the code, and the code
  sitesolide lock --new-code   a new code, the old one no longer opens
  sitesolide unlock            Public again
EOF
    exit 2
    ;;

  *)
    usage
    ;;
esac
