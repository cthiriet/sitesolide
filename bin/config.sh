# The workstation's settings, for the scripts of bin/. To be sourced, never run:
#
#   REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
#   . "$REPO_ROOT/bin/config.sh"
#
# Sets SITESOLIDE_SERVER, SITESOLIDE_ZONE, SITESOLIDE_EMAIL, SITESOLIDE_CONTACT,
# SITESOLIDE_VAULT and, if there is one, SITESOLIDE_SITES_REPO. Those carry a prefix because whoever installs this
# software has an environment of their own, where a name as short as ZONE or
# CONTACT would meet something else.
#
# Two more have none, because nobody declares them and they never leave the
# scripts of bin/: DEPLOY_USER, the account that connects and therefore owns the
# served files, derived from SITESOLIDE_SERVER; and SLUG_LABEL, the Caddy
# placeholder that carries the slug in the wildcard block.
#
# A variable already set in the environment wins, as in the CLI: a test against
# another machine is set up the same way everywhere.
#
# NO DEFAULT DESIGNATES A MACHINE. A ready-made SITESOLIDE_SERVER here would aim
# at the one of the file's author, and a script launched without configuration
# would deposit at his place. The three settings that name a machine,
# SITESOLIDE_SERVER, SITESOLIDE_ZONE and SITESOLIDE_EMAIL, therefore have no
# fallback value. A script that needs one calls `sitesolide_require_config`,
# which stops and points to `sitesolide init`; bin/test.sh aims at no machine
# and does not call it.
#
# The reading is done by bin/cli/settings.ts, the very one the CLI uses: a
# second reading written in shell would have neither the tilde expansion nor the
# precedence of the environment, and would end up diverging without anything
# saying so. See bin/tests/cli-config.test.ts.

if [ -z "${REPO_ROOT:-}" ]; then
  echo "bin/config.sh: REPO_ROOT must be set before sourcing this file" >&2
  exit 1
fi

# In a kit a compiled binary unpacked, REPO_ROOT is that kit, and `bun` is the
# binary itself: .bin/ holds the two shims that play it, first on the PATH so
# that a script started by hand from the kit needs no Bun either, and
# .kit.json names the release, which bin/deploy-api.sh names its releases
# after, a kit being no git checkout. The CLI sets both already; a checkout of
# the repository has neither file, and keeps the bun of its PATH. See
# bin/cli/kit.ts.
if [ -x "$REPO_ROOT/.bin/bun" ]; then
  case ":$PATH:" in
    *":$REPO_ROOT/.bin:"*) ;;
    *) PATH="$REPO_ROOT/.bin:$PATH" ;;
  esac
  if [ -z "${SITESOLIDE_KIT_VERSION:-}" ] && [ -f "$REPO_ROOT/.kit.json" ]; then
    SITESOLIDE_KIT_VERSION="$(sed -n 's/^{"version":"\([0-9A-Za-z.-]*\)".*/\1/p' "$REPO_ROOT/.kit.json")"
    export SITESOLIDE_KIT_VERSION
  fi
fi

eval "$(bun "$REPO_ROOT/bin/cli/settings.ts")"

# The copies a component's bundles import, <component>/borrowed/, made by its
# `borrow` script from the modules it shares with the rest of the repository.
# A checkout makes them before each bundle. A kit carries them made at release
# time by bin/build.ts, and is read-only: making them again there would fail,
# and could only rewrite what is already there.
sitesolide_borrow() {
  [ -f "$REPO_ROOT/.kit.json" ] && return 0
  (cd "$REPO_ROOT/$1" && bun run borrow > /dev/null)
}

# One line of what a deploy script would install, as sha256sum prints it: the
# fingerprint of the local file, two spaces, its path on the machine. What
# `--fingerprint` prints, and nothing else reads the machine for it: `sitesolide
# upgrade` compares those lines with the installed files, read only, and runs
# the script only for a component whose files differ. See bin/cli/upgrade.ts.
sitesolide_fingerprint() {
  printf '%s  %s\n' "$(shasum -a 256 < "$1" | cut -d' ' -f1)" "$2"
}

sitesolide_require_config() {
  local missing=()
  [ -n "${SITESOLIDE_SERVER:-}" ] || missing+=("server")
  [ -n "${SITESOLIDE_ZONE:-}" ] || missing+=("zone")
  [ -n "${SITESOLIDE_EMAIL:-}" ] || missing+=("email")
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "incomplete configuration: ${missing[*]}" >&2
    echo "run: sitesolide init" >&2
    echo "it writes ~/.config/sitesolide/config.json, which says which machine to serve" >&2
    exit 1
  fi
}
