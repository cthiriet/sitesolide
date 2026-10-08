#!/usr/bin/env bun
/**
 * Writes the door page of the previews from the template it shares with the
 * portal's login.
 *
 *   bun portal/scripts/lock-page.ts [path]
 *
 * It is not versioned: its footer carries the address to ask a code from,
 * `SITESOLIDE_CONTACT` from the configuration, which belongs to nobody else.
 * On the machine, the gatekeeper writes it from the same template when a
 * site opens with a code; this script is for looking at it.
 */
import { join } from "node:path";
import { CONTACT } from "../src/config";
import { doorPage } from "../src/page";

const TARGET = process.argv[2] ?? join(import.meta.dir, "..", "..", "infra", "locks", "verrou.html");

await Bun.write(TARGET, doorPage(CONTACT));
console.log(`door page written: ${TARGET}`);
