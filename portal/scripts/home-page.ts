#!/usr/bin/env bun
/**
 * Writes public/index.html, the root of the portal's own host, from the
 * template it shares with the sign-in and the door page.
 *
 *   bun portal/scripts/home-page.ts
 *
 * Committed, unlike the door page: it carries nothing of an installation.
 * tests/page.test.ts fails when the file and the template part.
 */
import { join } from "node:path";
import { homePage } from "../src/page";

const TARGET = join(import.meta.dir, "..", "public", "index.html");

await Bun.write(TARGET, homePage());
console.log(`home page written: ${TARGET}`);
