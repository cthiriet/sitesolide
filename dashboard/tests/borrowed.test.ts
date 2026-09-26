import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * What the deployment's rsync carries up: this directory, and nothing above it.
 *
 * An import that reaches higher works on the workstation, where api/ and bin/
 * are neighbours, and makes the service fail to start on the VM, after an
 * otherwise successful deployment. It happened on 30 August 2026: the service
 * and the collector looped on "Cannot find module '../../bin/cli/manifest'".
 * What is shared now goes through `borrowed/`, which scripts/borrow.ts fills
 * before every build.
 */
const PROJECT = resolve(import.meta.dir, "..");

/**
 * The files that go up to the VM: the server, the collector, the steward, and
 * src/ with its subdirectories. The walk descends: src/secrets/ escaped this
 * check for as long as it only read the first level.
 *
 * The steward and the gatekeeper are each built into a single file by
 * bin/deploy-steward.sh and bin/deploy-gatekeeper.sh,
 * where a distant import would be bundled without a sound. It is checked all
 * the same: its copy in app/ has to stay launchable by hand, and the rule is
 * simpler with no exception.
 */
function deployedFiles(): string[] {
  const sources = readdirSync(join(PROJECT, "src"), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(PROJECT, "src", name));
  return [
    join(PROJECT, "server.ts"),
    join(PROJECT, "collector.ts"),
    join(PROJECT, "steward.ts"),
    join(PROJECT, "gatekeeper.ts"),
    ...sources,
  ];
}

describe("nothing imports above the project", () => {
  test("every relative import stays inside dashboard/", () => {
    const offenders: string[] = [];

    for (const file of deployedFiles()) {
      const content = readFileSync(file, "utf8");
      for (const [, target] of content.matchAll(/from\s+"(\.[^"]*)"/g)) {
        const resolved = resolve(dirname(file), target!);
        if (relative(PROJECT, resolved).startsWith("..")) {
          offenders.push(`${relative(PROJECT, file)} → ${target}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the borrowings are there, so the build ran", () => {
    for (const name of ["manifest.ts", "locks.ts", "config.ts", "table.ts", "guests.ts"]) {
      expect(readFileSync(join(PROJECT, "borrowed", name), "utf8")).toContain("borrow.ts");
    }
  });
});
