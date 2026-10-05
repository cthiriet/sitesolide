#!/bin/sh
#
# Installs sitesolide: one executable for this machine's system and processor,
# from the project's GitHub releases.
#
#   curl -fsSL https://github.com/cthiriet/sitesolide/releases/latest/download/install.sh | sh
#
#   SITESOLIDE_VERSION=v0.3.0       a given release rather than the latest
#   SITESOLIDE_INSTALL_DIR=<dir>    where it goes, ~/.local/bin by default
#   SITESOLIDE_DOWNLOAD_URL=<url>   the folder holding a release's files, for a
#                                   mirror or a test; overrides the version
#
# The binary is checked against the release's SHA256SUMS before it lands, and
# replaces an earlier one with a single rename, so that a sitesolide running
# meanwhile never meets half a file. Nothing here asks for root: the default
# folder is the user's own, and one that needs sudo is the reader's to pick
# and prepare.
#
# POSIX sh, and only what every Mac and every Linux carries: uname, curl,
# mktemp, awk, and shasum or sha256sum. Bun is not needed, the binary embeds
# it.
set -eu

RELEASES="https://github.com/cthiriet/sitesolide/releases"

fail() {
  echo "sitesolide install: $*" >&2
  exit 1
}

# The release file this machine runs, sitesolide-<os>-<arch>, as bin/build.ts
# names them.
platform() {
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "no binary for $os: sitesolide ships for macOS and Linux" ;;
  esac
  case "$arch" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) fail "no binary for the $arch processor: sitesolide ships for arm64 and x86_64" ;;
  esac
  # A shell translated by Rosetta says x86_64 on an Apple Silicon Mac: the
  # native binary is the one that belongs there.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi
  # The Linux binaries are linked against glibc: on a musl system, Alpine for
  # one, they would fail with a bare "not found". Better said here.
  if [ "$os" = linux ] && ls /lib/ld-musl-* > /dev/null 2>&1; then
    fail "this Linux uses musl libc, and sitesolide ships for glibc only"
  fi
  echo "sitesolide-$os-$arch"
}

sha256() {
  if command -v shasum > /dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  elif command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  else
    fail "neither shasum nor sha256sum is installed: the download cannot be checked"
  fi
}

command -v curl > /dev/null 2>&1 || fail "curl is needed to download the release"

version="${SITESOLIDE_VERSION:-latest}"
case "$version" in
  "" | *[!A-Za-z0-9._-]*) fail "SITESOLIDE_VERSION: $version is not a release tag such as v0.3.0" ;;
esac
if [ -n "${SITESOLIDE_DOWNLOAD_URL:-}" ]; then
  base="${SITESOLIDE_DOWNLOAD_URL%/}"
elif [ "$version" = latest ]; then
  base="$RELEASES/latest/download"
else
  base="$RELEASES/download/$version"
fi
directory="${SITESOLIDE_INSTALL_DIR:-${HOME:?HOME is not set}/.local/bin}"

asset="$(platform)"

work="$(mktemp -d 2> /dev/null || mktemp -d -t sitesolide)"
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "downloading $asset from $base"
curl -fsSL --retry 3 -o "$work/SHA256SUMS" "$base/SHA256SUMS" || fail "cannot download $base/SHA256SUMS"
curl -fSL --retry 3 --progress-bar -o "$work/$asset" "$base/$asset" || fail "cannot download $base/$asset"

expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$work/SHA256SUMS")"
[ -n "$expected" ] || fail "SHA256SUMS lists no $asset"
actual="$(sha256 "$work/$asset")"
[ "$actual" = "$expected" ] || fail "$asset does not match SHA256SUMS (expected $expected, got $actual): nothing was installed"

mkdir -p "$directory" 2> /dev/null || fail "cannot create $directory: pick another folder with SITESOLIDE_INSTALL_DIR"
[ -w "$directory" ] || fail "$directory is not writable: pick another folder with SITESOLIDE_INSTALL_DIR; this script never uses sudo"
# Copied beside the target first, then renamed: within one folder the rename
# is atomic.
staged="$directory/.sitesolide.$$"
if ! { cp "$work/$asset" "$staged" && chmod 755 "$staged" && mv -f "$staged" "$directory/sitesolide"; }; then
  rm -f "$staged"
  fail "cannot write $directory/sitesolide"
fi

installed="$("$directory/sitesolide" --version 2>&1)" || fail "$directory/sitesolide was installed but does not run: $installed"
echo "installed: $directory/sitesolide ($installed)"

case ":${PATH:-}:" in
  *":$directory:"*) ;;
  *)
    echo "" >&2
    echo "$directory is not on your PATH. Add it, in ~/.zshrc, ~/.bashrc or ~/.profile:" >&2
    echo "  export PATH=\"$directory:\$PATH\"" >&2
    ;;
esac
