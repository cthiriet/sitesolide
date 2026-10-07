#!/usr/bin/env bun
/**
 * Copies into `borrowed/` the modules the portal shares with the dashboard,
 * because an import reaching above `portal/` does not survive deployment: the
 * rsync only carries that folder. Same mechanism, and same reason, as
 * dashboard/scripts/borrow.ts.
 *
 * Copying rather than rewriting: the rate limiting is tested over there, and
 * a second writing would end up diverging. So is the
 * egress proxy's reading of the kernel's socket tables, by which the portal
 * tells root's calls to its admin routes from the dashboard's (src/peer.ts).
 *
 * Flat, like the dashboard's: a module's `./` imports land beside it. One
 * import climbs out of its folder, the egress proxy's `../../bin/cli/manifest`,
 * and is pointed at the copy beside it, `REPOINTED` below.
 *
 * Launched by the manifest's `build`, so before the rsync, and by `verify`
 * before the tests. The copies are not versioned.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const DESTINATION = join(import.meta.dir, "..", "borrowed");
const BORROWED = [
  "dashboard/src/auth.ts",
  // Who is at the other end of a loopback connection, from /proc/net/tcp, and
  // what it imports: an address's canonical form, a slug's shape.
  "egress/src/proc-net.ts",
  "egress/src/addresses.ts",
  "bin/cli/manifest.ts",
  "bin/cli/egress.ts",
];

/** The imports that climb out of their folder, and the copy beside them they are pointed at. */
const REPOINTED: Readonly<Record<string, string>> = { '"../../bin/cli/manifest"': '"./manifest"' };

mkdirSync(DESTINATION, { recursive: true });

for (const source of BORROWED) {
  let content: string;
  try {
    content = readFileSync(join(ROOT, source), "utf8");
  } catch {
    console.error(`borrowed module not found: ${source}`);
    process.exit(1);
  }
  for (const [from, to] of Object.entries(REPOINTED)) content = content.replaceAll(`from ${from}`, `from ${to}`);
  const header = `// Copy of ${source}, made by portal/scripts/borrow.ts. Do not edit.\n\n`;
  writeFileSync(join(DESTINATION, source.split("/").pop()!), header + content);
}

console.log(`${BORROWED.length} modules borrowed into borrowed/`);
