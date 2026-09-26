import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectsRepo } from "../cli/config";
import { generateFragment } from "../cli/fragment";
import { isApp, readManifest, type Manifest } from "../cli/manifest";
import { generateUnit } from "../cli/unit";

/**
 * The sites of the neighbouring repository, each described by a manifest the
 * CLI accepts.
 *
 * What runs is not compared here. It used to be, against copies of every unit
 * and block kept on the workstation; those copies are gone, the machine being
 * the only place where what runs is written. The comparison happens at each
 * deployment, against the machine: a unit that differs is reported and left
 * alone until --force, a block that differs stops the deployment before
 * anything leaves. See prepareService and checkRemoteBlock in bin/sitesolide.ts.
 *
 * These tests are skipped, never falsely green, when the sites' repository is
 * not there: the platform must remain testable on its own.
 */

const SITES = projectsRepo();
const SITES_PRESENT = SITES !== null && existsSync(SITES);

/**
 * The folders that no manifest describes, and that expect none.
 *
 * The landing is one of them: `validate()` refuses this slug, its server folder
 * carries the name of the zone and not `landing`, and it has no subdomain to
 * check. The CLI does not deploy it.
 *
 * The exception is named here rather than guessed: any other folder without a
 * manifest makes the test below fail. A projects repository that has no
 * landing makes nothing fail, the test bearing only on the folders present.
 */
const WITHOUT_MANIFEST = ["landing"];

const FOLDERS = SITES_PRESENT
  ? readdirSync(SITES, { withFileTypes: true })
      // A folder is a site only if it carries a package.json. A sites
      // repository may also hold `bin/`, notes or `.git`, which are not
      // deployed and therefore do not have to carry a manifest.
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          existsSync(join(SITES as string, entry.name, "package.json")),
      )
      .map((entry) => entry.name)
      .sort()
  : [];

const WITH_MANIFEST = FOLDERS.filter((slug) => !WITHOUT_MANIFEST.includes(slug));

function manifestOf(slug: string): Manifest {
  const { manifest, errors } = readManifest(
    readFileSync(join(SITES as string, slug, "sitesolide.json"), "utf8"),
  );
  if (manifest === undefined) throw new Error(`${slug} : ${errors.join(", ")}`);
  return manifest;
}

test.skipIf(!SITES_PRESENT)("no folder of the sites repository is forgotten", () => {
  // Without this test, the next site added would have no manifest and nobody
  // would notice before trying to deploy it.
  for (const slug of WITH_MANIFEST) {
    expect(existsSync(join(SITES as string, slug, "sitesolide.json"))).toBe(true);
  }
  expect(WITH_MANIFEST.length).toBeGreaterThan(0);
});

test.skipIf(!SITES_PRESENT)("the folders without a manifest are the ones named here", () => {
  // The reverse of the previous one: an exception that stopped being one,
  // because the CLI finally welcomes the landing, must make this test fail
  // rather than leave a site out of the list without anything saying so.
  //
  // The test bears on the folders present: a repository that has no landing
  // has nothing to declare, and this list therefore demands the existence of
  // nothing.
  for (const slug of FOLDERS.filter((name) => WITHOUT_MANIFEST.includes(name))) {
    expect(existsSync(join(SITES as string, slug, "sitesolide.json"))).toBe(false);
  }
});

describe.each(WITH_MANIFEST)("sites/%s/sitesolide.json", (slug) => {
  const raw = readFileSync(join(SITES as string, slug, "sitesolide.json"), "utf8");
  const { manifest, errors } = readManifest(raw);

  test("is accepted without reservation", () => {
    expect(errors).toEqual([]);
    expect(manifest).toBeDefined();
  });

  test("carries the slug of its folder", () => {
    // The slug decides the subdomain and the served folder: a discrepancy
    // would deploy the site at an address other than its own.
    expect(manifest?.slug).toBe(slug);
  });

  test("leaves no site.json beside it", () => {
    // A site has only one configuration file. A `site.json` back here would
    // carry a domain or a lock that nobody reads any more, and api/src/table.ts
    // would refuse to regenerate the table as long as it lingers on the VM.
    expect(existsSync(join(SITES as string, slug, "site.json"))).toBe(false);
  });
});

describe.skipIf(!SITES_PRESENT)("what a deployment would install", () => {
  const APPS = WITH_MANIFEST.filter((slug) => isApp(manifestOf(slug)));

  test("at least one application site is covered", () => {
    // Otherwise a path mistake would make the test below always green.
    expect(APPS.length).toBeGreaterThan(0);
  });

  test.each(APPS)("%s: a unit and a block are generated", (slug) => {
    // Generated at deploy time and nowhere else: a manifest the generator
    // cannot turn into a unit and a block would only fail on the machine.
    const manifest = manifestOf(slug);
    expect(generateUnit(manifest)).toContain(`ExecStart=${manifest.start}`);
    expect(generateFragment(manifest)).toContain(`${slug}.{$SITESOLIDE_ZONE}`);
  });
});
