#!/usr/bin/env bun
/**
 * The pins of what setup downloads to the machine and runs as root.
 *
 *   bun bin/update-pins.ts                 each pinned version, and the newest one upstream
 *   bun bin/update-pins.ts bun <version>   pins Bun at <version>
 *
 * Pinning Bun reads two sources for each build the machine may take, the
 * release's SHASUMS256.txt and the SHA-256 digest GitHub records for the
 * asset, and refuses when they disagree or one is missing. It then rewrites
 * BUN in bin/cli/pins.ts and the version .github/workflows/release.yml builds
 * the binaries with, which bin/tests/cli-pins.test.ts keeps equal. Nothing is
 * committed: read the diff, run bin/test.sh, commit.
 *
 * Caddy, Go and xcaddy are pinned in infra/caddy/build.sh, by hand: there is
 * no hash to record there, Go's checksum database verifies every source the
 * build fetches. This only says what is newer.
 *
 * Runs from a checkout, with the network; the kit leaves it out.
 */
import { join } from "node:path";
import { BUN, BUN_RELEASES, type BunBuild } from "./cli/pins";

const REPOSITORY = join(import.meta.dir, "..");
const PINS = join(REPOSITORY, "bin", "cli", "pins.ts");
const WORKFLOW = join(REPOSITORY, ".github", "workflows", "release.yml");
const CADDY_BUILD = join(REPOSITORY, "infra", "caddy", "build.sh");

async function get(url: string): Promise<Response> {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "sitesolide-update-pins" } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response;
}

async function latestRelease(repository: string): Promise<string> {
  const release = (await (await get(`https://api.github.com/repos/${repository}/releases/latest`)).json()) as { tag_name: string };
  return release.tag_name;
}

async function latestTag(repository: string): Promise<string> {
  const tags = (await (await get(`https://api.github.com/repos/${repository}/tags?per_page=100`)).json()) as { name: string }[];
  const versions = tags.map((tag) => tag.name).filter((name) => /^v\d+\.\d+\.\d+$/.test(name));
  versions.sort((a, b) => Bun.semver.order(b.slice(1), a.slice(1)));
  return versions[0] ?? "none";
}

/** The SHA-256 of each build, from SHASUMS256.txt and from GitHub's digests, which must agree. */
export async function bunSums(version: string): Promise<Record<BunBuild, string>> {
  const tag = `bun-v${version}`;
  const listed = new Map<string, string>();
  for (const line of (await (await get(`${BUN_RELEASES}/${tag}/SHASUMS256.txt`)).text()).split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match) listed.set(match[2]!, match[1]!);
  }
  const release = (await (await get(`https://api.github.com/repos/oven-sh/bun/releases/tags/${tag}`)).json()) as { assets: { name: string; digest?: string | null }[] };
  const recorded = new Map(release.assets.map((asset) => [asset.name, asset.digest?.replace(/^sha256:/, "") ?? null]));
  const sums = {} as Record<BunBuild, string>;
  for (const build of Object.keys(BUN.sha256) as BunBuild[]) {
    const name = `bun-linux-${build}.zip`;
    const fromList = listed.get(name);
    const fromGitHub = recorded.get(name);
    if (!fromList) throw new Error(`SHASUMS256.txt of ${tag} lists no ${name}`);
    if (!fromGitHub) throw new Error(`GitHub records no digest for ${name} of ${tag}`);
    if (fromList !== fromGitHub) throw new Error(`${name} of ${tag}: SHASUMS256.txt says ${fromList}, GitHub ${fromGitHub}; nothing was changed`);
    sums[build] = fromList;
  }
  return sums;
}

/** pins.ts with BUN's version and sums replaced, everything else as it was. */
export function rewritePins(text: string, version: string, sums: Record<BunBuild, string>): string {
  let next = text.replace(/(export const BUN = \{\n {2}version: )"[^"]*"/, `$1${JSON.stringify(version)}`);
  for (const [build, sum] of Object.entries(sums)) {
    const key = /^[a-z0-9]+$/.test(build) ? build : JSON.stringify(build);
    next = next.replace(new RegExp(`(\\n {4}${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: )"[0-9a-f]{64}"`), `$1"${sum}"`);
  }
  return next;
}

/** release.yml with the Bun it builds with replaced. */
export function rewriteWorkflow(text: string, version: string): string {
  return text.replace(/(bun-version: )\S+/g, `$1${version}`).replace(/# Bun \d+\.\d+\.\d+, exactly/g, `# Bun ${version}, exactly`);
}

/** The pinned values of infra/caddy/build.sh. */
export function caddyPins(text: string): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const match of text.matchAll(/^(CADDY_VERSION|GO_TOOLCHAIN|XCADDY_VERSION)=(\S+)$/gm)) pins[match[1]!] = match[2]!;
  for (const match of text.matchAll(/^\s+(github\.com\/caddy-dns\/[a-z0-9-]+)\) module_version=(\S+) ;;$/gm)) pins[match[1]!] = match[2]!;
  return pins;
}

async function report(): Promise<void> {
  const caddy = caddyPins(await Bun.file(CADDY_BUILD).text());
  const latestCaddy = await latestRelease("caddyserver/caddy");
  const goLine = /^go (\S+)$/m.exec(await (await get(`https://raw.githubusercontent.com/caddyserver/caddy/${latestCaddy}/go.mod`)).text())?.[1] ?? "?";
  const goReleases = (await (await get("https://go.dev/dl/?mode=json")).json()) as { version: string }[];
  const rows: [string, string, string][] = [
    ["bun", BUN.version, (await latestRelease("oven-sh/bun")).replace(/^bun-v/, "")],
    ["caddy", caddy.CADDY_VERSION ?? "?", `${latestCaddy} (its go.mod asks go ${goLine})`],
    ["go toolchain", caddy.GO_TOOLCHAIN ?? "?", goReleases.map((release) => release.version).join(", ")],
    ["xcaddy", caddy.XCADDY_VERSION ?? "?", await latestRelease("caddyserver/xcaddy")],
  ];
  for (const [name, version] of Object.entries(caddy)) {
    if (name.startsWith("github.com/")) rows.push([name, version, await latestTag(name.replace(/^github\.com\//, ""))]);
  }
  const width = Math.max(...rows.map((row) => row[0].length));
  console.log(`${"".padEnd(width)}  pinned      newest`);
  for (const [name, pinned, newest] of rows) console.log(`${name.padEnd(width)}  ${pinned.padEnd(10)}  ${newest}`);
  console.log("\nbun: bun bin/update-pins.ts bun <version>; Caddy, Go and xcaddy: infra/caddy/build.sh, then docs/upgrading.md");
}

async function pinBun(version: string): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${version} is not a Bun version such as 1.3.11`);
  const sums = await bunSums(version);
  const pins = await Bun.file(PINS).text();
  const nextPins = rewritePins(pins, version, sums);
  const workflow = await Bun.file(WORKFLOW).text();
  const nextWorkflow = rewriteWorkflow(workflow, version);
  if (!nextPins.includes(`version: "${version}"`) || Object.values(sums).some((sum) => !nextPins.includes(sum))) {
    throw new Error("bin/cli/pins.ts no longer has the shape this rewrites: change it by hand");
  }
  if (!nextWorkflow.includes(`bun-version: ${version}`)) throw new Error("release.yml names no bun-version: change it by hand");
  await Bun.write(PINS, nextPins);
  await Bun.write(WORKFLOW, nextWorkflow);
  for (const [build, sum] of Object.entries(sums)) console.log(`bun-linux-${build}.zip  ${sum}`);
  console.log(`\nBun pinned at ${version} in bin/cli/pins.ts and release.yml: read the diff, run bin/test.sh, commit.`);
}

if (import.meta.main) {
  const [command, version] = process.argv.slice(2);
  try {
    if (command === undefined) await report();
    else if (command === "bun" && version !== undefined) await pinBun(version);
    else {
      console.error("usage: bun bin/update-pins.ts [bun <version>]");
      process.exit(2);
    }
  } catch (error) {
    console.error(`update-pins: ${(error as Error).message}`);
    process.exit(1);
  }
}
