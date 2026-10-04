#!/usr/bin/env bun
/**
 * Copies into `borrowed/` the modules this project shares with the rest of the
 * repository, because an import that climbs above `dashboard/` does not survive
 * the deployment.
 *
 * The rsync carries only the project's directory to `/srv/sites/dashboard/app`.
 * An `import "../../api/src/locks"` therefore works on the workstation, where
 * the two directories are neighbours, and makes the service fail at startup on
 * the VM, after a deployment that was otherwise perfectly successful. Measured
 * on 30 August 2026: the service looped on Restart=always with a
 * "Cannot find module '../../bin/cli/manifest'", and the collector with it.
 *
 * Copying rather than rewriting: `codeValide` decides what Caddy accepts,
 * `isApp` what the CLI generates. A second writing of those rules would
 * sooner or later display a state the machine denies, and that is precisely
 * what this repository spends its time preventing.
 *
 * Launched by the manifest's `build`, therefore before the rsync, and by
 * `check` before the tests: the copies cannot fall behind, nobody ever
 * editing them by hand. They are not versioned.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const DESTINATION = join(import.meta.dir, "..", "borrowed");

/**
 * Flat, and that is necessary: `verrous.ts` imports `./config` and `./table`,
 * which must therefore land beside it.
 */
const BORROWINGS = [
  "bin/cli/manifest.ts",
  "bin/cli/portal.ts",
  "api/src/locks.ts",
  "api/src/config.ts",
  "api/src/table.ts",
  // The types and the durations of guest access, which the portal applies: the
  // page's menu must offer only what the portal will accept.
  "portal/src/guests.ts",
  // The sharing modes and the rules of an email and a domain, which the portal
  // applies, and the names of its sign-in settings, which the steward lets the
  // dashboard write into portal.env.
  "portal/src/sharing.ts",
  // The generator of the Caddy blocks and what it imports: the gatekeeper puts
  // up or takes away a site's portal by generating the block exactly like
  // `sitesolide deploy`, failing which the next deployment would write a block
  // that says something other than the one in service.
  "bin/cli/fragment.ts",
  "bin/cli/unit.ts",
  "bin/cli/comparison.ts",
  // Imported by the manifest's validation and by the unit generator: what a
  // project may reach, and the connectors it asks for. The steward reads the
  // latter from the manifests to show which project asks for which.
  "bin/cli/egress.ts",
  // The connectors' files and their rules: the steward writes them, the egress
  // proxy reads them, and both run this one copy of what is allowed there.
  "bin/cli/connectors.ts",
  // What the installer decides exactly like `sitesolide deploy`: the ports
  // other projects already declare, the units a manifest no longer names, the
  // loopback's project set, and the door the machine carries. A second
  // writing of those rules would deploy differently from the API and from SSH.
  "bin/cli/services.ts",
  "bin/cli/loopback.ts",
  "bin/cli/portal-vm.ts",
  // The archive format the CLI writes for the control API, and that the
  // installer's tests write too, malicious archives included.
  "bin/cli/bundle.ts",
  // The names of the data snapshots: the backup component writes them, the
  // steward lists them and `sitesolide backups` reads them, all by this rule.
  "bin/cli/backups.ts",
];

/** The header of every copied module. */
const HEADER = (source: string) => {
  const marker = "//";
  return [
    `${marker} Copy of ${source}, made by dashboard/scripts/borrow.ts.`,
    marker,
    `${marker} Do not edit: the next build overwrites it. This file exists because the`,
    `${marker} deployment's rsync carries only dashboard/, and an import climbing`,
    `${marker} above this folder would make the service fail on the VM.`,
    "",
    "",
  ].join("\n");
};

mkdirSync(DESTINATION, { recursive: true });

for (const source of BORROWINGS) {
  let content: string;
  try {
    content = readFileSync(join(ROOT, source), "utf8");
  } catch {
    // A rename in api/ or bin/ must show here, on the workstation, and not on
    // the first request after going live.
    console.error(`borrowing not found: ${source}`);
    process.exit(1);
  }
  writeFileSync(join(DESTINATION, source.split("/").pop()!), HEADER(source) + content);
}

console.log(`${BORROWINGS.length} modules borrowed into borrowed/`);
