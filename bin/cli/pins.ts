/**
 * What setup downloads to the machine and runs as root, pinned: Bun at one
 * version and the SHA-256 of each build it may install, and the fingerprint of
 * each apt repository's signing key. Caddy is pinned beside its build, in
 * infra/caddy/build.sh, which a person also runs by hand.
 *
 * A download is checked against these values before anything runs it
 * or apt trusts it, and a mismatch stops the step: a compromised CDN, release
 * or mirror then fails setup rather than landing as root on the machine that
 * serves every site.
 *
 * BUMPING BUN. `bun bin/update-pins.ts bun <version>` reads the release's
 * SHASUMS256.txt and the digests GitHub records for its assets, refuses when
 * the two disagree, and rewrites BUN below and the version the release
 * workflow builds with, which a test keeps equal: the binary embeds the same
 * runtime the machine runs. Review the diff, run bin/test.sh, commit.
 */

import { dirname } from "node:path";
import { APT, shellQuote } from "./harden";

export const BUN = {
  version: "1.3.14",
  /**
   * bun-linux-<build>.zip of the release. x64-baseline is for an x86-64
   * processor without AVX2, as Bun's own installer picks it.
   */
  sha256: {
    x64: "951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f",
    "x64-baseline": "a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7",
    aarch64: "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b",
  },
} as const;

export type BunBuild = keyof typeof BUN.sha256;

export const BUN_RELEASES = "https://github.com/oven-sh/bun/releases/download";

/** Where Bun lands on the machine, the runtime of every component and project. */
export const BUN_PATH = "/usr/local/bin/bun";

/**
 * Installs the pinned Bun at BUN_PATH, and bunx beside it as Bun's installer
 * does: the build this processor takes, its zip checked against its pin
 * before it is opened, and the binary asked its version before it is laid.
 * The file is replaced by a rename, so a Bun starting meanwhile never meets
 * half of one.
 */
export function bunInstallScript(): string {
  const pins = Object.entries(BUN.sha256)
    .map(([build, sum]) => `  ${build}) expected=${sum} ;;`)
    .join("\n");
  return `bun_work=$(mktemp -d)
trap 'rm -rf "$bun_work"' EXIT
case "$(uname -m)" in
  x86_64 | amd64)
    if grep -qw avx2 /proc/cpuinfo; then build=x64; else build=x64-baseline; fi ;;
  aarch64 | arm64) build=aarch64 ;;
  *) echo "bun: no pinned build for the $(uname -m) processor" >&2; exit 1 ;;
esac
case "$build" in
${pins}
esac
curl -fsSL --proto '=https' --retry 3 -o "$bun_work/bun.zip" "${BUN_RELEASES}/bun-v${BUN.version}/bun-linux-$build.zip"
actual=$(sha256sum "$bun_work/bun.zip" | cut -d' ' -f1)
if [ "$actual" != "$expected" ]; then
  echo "bun: bun-linux-$build.zip of ${BUN.version} does not match its pin (expected $expected, got $actual): nothing was installed" >&2
  exit 1
fi
unzip -q -d "$bun_work" "$bun_work/bun.zip"
[ "$("$bun_work/bun-linux-$build/bun" --version)" = ${BUN.version} ] || { echo "bun: the binary does not say ${BUN.version}" >&2; exit 1; }
install -m 0755 -o root -g root "$bun_work/bun-linux-$build/bun" ${BUN_PATH}.new
mv -f ${BUN_PATH}.new ${BUN_PATH}
ln -sfn bun /usr/local/bin/bunx
rm -rf "$bun_work"
trap - EXIT
echo "bun: ${BUN_PATH} $(${BUN_PATH} --version), bun-linux-$build.zip sha256 $actual"`;
}

/** Whether the machine runs the pinned Bun: setup installs it when not. */
export const BUN_CURRENT = `[ "$(${BUN_PATH} --version 2>/dev/null)" = ${BUN.version} ]`;

/**
 * The apt repositories setup adds, each with its signing key's primary
 * fingerprint. A vendor that rotates its key makes the step fail with both
 * fingerprints said: check the new one on the vendor's own documentation,
 * then change it here.
 */
export const APT_KEYS = {
  /** https://caddyserver.com/docs/install#debian-ubuntu-raspbian */
  caddy: {
    url: "https://dl.cloudsmith.io/public/caddy/stable/gpg.key",
    fingerprint: "65760C51EDEA2017CEA2CA15155B6D79CA56EA34",
    keyring: "/usr/share/keyrings/caddy-stable-archive-keyring.gpg",
  },
  /** https://pkg.cloudflare.com/index.html */
  cloudflared: {
    url: "https://pkg.cloudflare.com/cloudflare-main.gpg",
    fingerprint: "CC94B39C77AE7342A68B89628A682D308D4E5E73",
    keyring: "/usr/share/keyrings/cloudflare-main.gpg",
  },
  /** https://pkgs.tailscale.com/stable/#debian-trixie: one key signs every Debian release's repository. */
  tailscale: {
    url: "https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg",
    fingerprint: "2596A99EAAB33821893C0A79458CA832957F5868",
    keyring: "/usr/share/keyrings/tailscale-archive-keyring.gpg",
  },
} as const;

/**
 * Downloads a repository's key and lays it as an apt keyring only when the
 * file holds exactly one primary key, the pinned one; what is laid is that
 * key exported again by gpg, nothing else the file may have carried. A
 * throwaway GNUPGHOME, so root's own keyring is never touched.
 */
export function aptKeyScript(key: { url: string; fingerprint: string; keyring: string }): string {
  return `command -v gpg >/dev/null 2>&1 || ${APT} install -y -q gpg </dev/null
key_home=$(mktemp -d)
curl -fsSL --proto '=https' --retry 3 -o "$key_home/download" ${shellQuote(key.url)}
found=$(GNUPGHOME="$key_home" gpg --batch --show-keys --with-colons "$key_home/download" 2>/dev/null | awk -F: '$1 == "pub" { primary = 1; next } $1 == "fpr" && primary { print $10; primary = 0 }')
if [ "$found" != ${key.fingerprint} ]; then
  rm -rf "$key_home"
  echo "apt key: ${key.url} holds $(echo $found) rather than the pinned ${key.fingerprint} alone: nothing was laid" >&2
  exit 1
fi
GNUPGHOME="$key_home" gpg --batch --quiet --import "$key_home/download" 2>/dev/null
install -d -m 0755 ${dirname(key.keyring)}
GNUPGHOME="$key_home" gpg --batch --export ${key.fingerprint} > ${key.keyring}.new
chmod 0644 ${key.keyring}.new
mv -f ${key.keyring}.new ${key.keyring}
rm -rf "$key_home"`;
}
