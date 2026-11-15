/**
 * What setup downloads to the machine and runs as root, pinned: Bun at one
 * version and the SHA-256 of each build it may install.
 *
 * A download is checked against these values before anything runs it,
 * and a mismatch stops the step: a compromised CDN, release
 * or mirror then fails setup rather than landing as root on the machine that
 * serves every site.
 *
 * BUMPING BUN. `bun bin/update-pins.ts bun <version>` reads the release's
 * SHASUMS256.txt and the digests GitHub records for its assets, refuses when
 * the two disagree, and rewrites BUN below and the version the release
 * workflow builds with, which a test keeps equal: the binary embeds the same
 * runtime the machine runs. Review the diff, run bin/test.sh, commit.
 */

export const BUN = {
  version: "1.3.11",
  /**
   * bun-linux-<build>.zip of the release. x64-baseline is for an x86-64
   * processor without AVX2, as Bun's own installer picks it.
   */
  sha256: {
    x64: "8611ba935af886f05a6f38740a15160326c15e5d5d07adef966130b4493607ed",
    "x64-baseline": "abe346f63414547cdf6b35b7a649a490c728b93d006226156923918a84c0e59b",
    aarch64: "d13944da12a53ecc74bf6a720bd1d04c4555c038dfe422365356a7be47691fdf",
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
