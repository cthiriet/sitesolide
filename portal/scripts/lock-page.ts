#!/usr/bin/env bun
/**
 * Writes the door page of the previews from the template it shares with the
 * portal's login.
 *
 *   bun portal/scripts/lock-page.ts [path]
 *
 * It is not versioned: its footer carries the address to ask a code from,
 * `SITESOLIDE_CONTACT` from the configuration, which belongs to nobody else.
 * `bin/lock.sh` produces it in a temporary folder just before dropping it, and
 * a site that wants its own places its own `verrou.html`.
 */
import { join } from "node:path";
import { doorPage } from "../src/page";

const TARGET = process.argv[2] ?? join(import.meta.dir, "..", "..", "infra", "locks", "verrou.html");

await Bun.write(TARGET, doorPage());
console.log(`door page written: ${TARGET}`);
