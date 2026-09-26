#!/usr/bin/env bun
/**
 * Copies into `borrowed/` the modules the portal shares with the dashboard,
 * because an import reaching above `portal/` does not survive deployment: the
 * rsync only carries that folder. Same mechanism, and same reason, as
 * dashboard/scripts/borrow.ts.
 *
 * Copying rather than rewriting: the rate limiting and the password draw are
 * tested over there, and a second writing would end up diverging.
 *
 * Launched by the manifest's `build`, so before the rsync, and by `verify`
 * before the tests. The copies are not versioned.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const DESTINATION = join(import.meta.dir, "..", "borrowed");
const BORROWED = ["dashboard/src/auth.ts", "dashboard/src/password.ts"];

mkdirSync(DESTINATION, { recursive: true });

for (const source of BORROWED) {
  let content: string;
  try {
    content = readFileSync(join(ROOT, source), "utf8");
  } catch {
    console.error(`borrowed module not found: ${source}`);
    process.exit(1);
  }
  const header = `// Copy of ${source}, made by portal/scripts/borrow.ts. Do not edit.\n\n`;
  writeFileSync(join(DESTINATION, source.split("/").pop()!), header + content);
}

console.log(`${BORROWED.length} modules borrowed into borrowed/`);
