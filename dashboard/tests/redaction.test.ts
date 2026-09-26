import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

/**
 * CLAUDE.md forbids the em dash, "neither in the code, nor in the
 * documentation, nor in the replies". Eight of them had slipped in, one visible
 * on screen between a domain and its state, and a writing rule that no check
 * verifies always ends up slackening.
 *
 * The em dash and the en dash are refused. The middle dot, on the other hand,
 * is allowed: it separates two pieces of information without passing itself off
 * as sentence punctuation, and it is what replaces the em dash in the dashboard.
 */
// Written by their code point, otherwise this file would be the only one in the
// project to contain what it forbids, and would flag itself.
const FORBIDDEN = [String.fromCodePoint(0x2014), String.fromCodePoint(0x2013)];

const PROJECT = resolve(import.meta.dir, "..");

/**
 * Generated directories have no author: `borrowed/` is copied from api/ and
 * bin/, `public/` comes out of the Astro build. `web/src/components/ui/` is
 * written by shadcn, which an `add --overwrite` rewrites without asking us:
 * policing it here would make the tests fail on text nobody here wrote.
 */
const IGNORES = new Set(["node_modules", "borrowed", "public", "dist", ".astro", ".test-data", "ui"]);

const EXTENSIONS = new Set([".ts", ".tsx", ".astro", ".md", ".css", ".json", ".sh", ".toml"]);

function walk(folder: string, found: string[] = []): string[] {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (IGNORES.has(entry.name)) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) walk(path, found);
    else if (EXTENSIONS.has(extname(entry.name))) found.push(path);
  }
  return found;
}

test("no em dash in what we write", () => {
  const offenders: string[] = [];

  for (const file of walk(PROJECT)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, rank) => {
      if (FORBIDDEN.some((character) => line.includes(character))) {
        offenders.push(`${relative(PROJECT, file)}:${rank + 1}`);
      }
    });
  }

  expect(offenders).toEqual([]);
});
