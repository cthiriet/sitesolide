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
 * Runs from a checkout, with the network; the kit leaves it out.
 */
import { join } from "node:path";
import { BUN, BUN_RELEASES, type BunBuild } from "./cli/pins";

const REPOSITORY = join(import.meta.dir, "..");
const PINS = join(REPOSITORY, "bin", "cli", "pins.ts");
const WORKFLOW = join(REPOSITORY, ".github", "workflows", "release.yml");

async function get(url: string): Promise<Response> {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "sitesolide-update-pins" } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response;
}

async function latestRelease(repository: string): Promise<string> {
  const release = (await (await get(`https://api.github.com/repos/${repository}/releases/latest`)).json()) as { tag_name: string };
  return release.tag_name;
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

async function report(): Promise<void> {
  console.log(`bun  pinned ${BUN.version}  newest ${(await latestRelease("oven-sh/bun")).replace(/^bun-v/, "")}`);
  console.log("\nbun: bun bin/update-pins.ts bun <version>");
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
