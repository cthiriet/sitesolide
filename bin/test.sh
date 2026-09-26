#!/usr/bin/env bash
#
# Runs the tests, the typing and the deprecation check of the platform's
# services, api/, dashboard/, portal/ and analytics/, and of every project of
# the neighbouring repository if there is one.
#
#   bin/test.sh
#
# Each site is self-contained: its tests run in its own folder, with its own
# dependencies. This script only walks through them, and stops at the first
# failing site.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$REPO_ROOT/bin/config.sh"
FAILURES=0

# A repository of projects, if there is one: this script tests each of its
# folders on top of the platform, because the workstation carries both and a
# test that only runs in the other window never runs. Its absence is not an
# error, the platform having to stay testable on its own.
if [ -d "${SITESOLIDE_SITES_REPO:-}" ]; then
  SITES=("${SITESOLIDE_SITES_REPO:-}"/*/)
else
  echo "no sites repository declared: only the platform is tested"
  SITES=()
fi

for site in "$REPO_ROOT/api" "$REPO_ROOT/dashboard" "$REPO_ROOT/portal" "$REPO_ROOT/analytics" ${SITES[@]+"${SITES[@]}"}; do
  [ -f "$site/package.json" ] || continue
  name="$(basename "$site")"

  echo
  echo "=== $name"
  # A fresh clone carries no node_modules: every folder here keeps its own
  # development dependencies. Installing what is missing rather than failing on
  # an unresolved import is what lets this be the first command someone runs.
  [ -d "$site/node_modules" ] || (cd "$site" && bun install --silent)
  # The deprecation check runs on its own, outside "bun run check": tsc --noEmit
  # does not see them, they only come up from the language service.
  if ! (cd "$site" && bun run check); then
    FAILURES=$((FAILURES + 1))
  elif ! bun "$REPO_ROOT/bin/deprecations.ts" "$site"; then
    FAILURES=$((FAILURES + 1))
  fi
done

# The tools of the sites repository, in its bin/, with their tests. They live
# over there because they belong to the sites themselves, not to the platform.
if [ -d "${SITESOLIDE_SITES_REPO:-}/bin" ]; then
  echo
  echo "=== tools of the sites repository"
  if ! (cd "${SITESOLIDE_SITES_REPO:-}" && bun test bin/); then
    FAILURES=$((FAILURES + 1))
  fi
fi

echo
echo "=== tools of the repository"
# The tools of bin/ are attached to no site, and their typing used to belong to
# nobody: no tsconfig.json reached them, so `tsc` never read cli/, tests/ nor
# sitesolide.ts, and the errors there slept unseen. Eight of them were calls to
# decideSecret left one argument short after the signature had gained one.
#
# bin/ therefore carries its own tsconfig.json and the two development
# dependencies that let it be read, like every other folder here, and is checked
# the same way: `bun run check` runs its tests then its typing, and the
# deprecation check comes after, for the reason given above.
[ -d "$REPO_ROOT/bin/node_modules" ] || (cd "$REPO_ROOT/bin" && bun install --silent)
if ! (cd "$REPO_ROOT/bin" && bun run check); then
  FAILURES=$((FAILURES + 1))
elif ! bun "$REPO_ROOT/bin/deprecations.ts" "$REPO_ROOT/bin"; then
  FAILURES=$((FAILURES + 1))
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES site(s) failed"
  exit 1
fi
echo "all tests pass"
