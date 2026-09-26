import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A unit that starts a service must hand it every setting that service refuses
 * to start without.
 *
 * Nothing said so until now, and two units were short of one. The collector
 * read the zone as `SITESOLIDE_ZONE ?? "<the author's zone>"` and its unit
 * passed no variable at all, so that literal was not a fallback but the value
 * production ran on. The gatekeeper's two units never carried the zone either, and the
 * gatekeeper throws without it. Neither shows up in a test that runs the code
 * with an environment of its own making: only the unit file says what the
 * machine will really hand over.
 *
 * Read from the source rather than declared here: a list to keep up to date is
 * a list that goes stale, and this one would go stale exactly when a new
 * setting is added, which is when it is needed.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..");

/** Each unit, and the entry point its ExecStart runs once deployed. */
const UNITS: ReadonlyArray<readonly [unit: string, entryPoint: string]> = [
  ["infra/gatekeeper/sitesolide-gatekeeper-on@.service", "dashboard/src/gatekeeper/main.ts"],
  ["infra/gatekeeper/sitesolide-gatekeeper-off@.service", "dashboard/src/gatekeeper/main.ts"],
  ["infra/collector/sitesolide-collector.service", "dashboard/collector.ts"],
  ["infra/steward/sitesolide-steward.service", "dashboard/steward.ts"],
  ["api/deploy/sitesolide-api.service", "api/src/config.ts"],
];

/**
 * The variables a source reads with no usable default: `env.X` bare, or with a
 * `?? ""` that the next line turns into a refusal. A default that names a
 * path or a port is the opposite case, the unit has nothing to say about it.
 */
function requiredVariables(source: string): Set<string> {
  const required = new Set<string>();
  for (const line of source.split("\n")) {
    for (const match of line.matchAll(/(?:process\.)?env\.([A-Z][A-Z0-9_]*)/g)) {
      const name = match[1]!;
      const after = line.slice(match.index + match[0].length);
      const fallback = after.match(/^\s*\?\?\s*(.+?)(?:[,;)]|$)/);
      if (fallback !== null && !/^(""|''|`\s*`)$/.test(fallback[1]!.trim())) continue;
      // Tested against undefined or the empty string, then given a value of
      // its own: optional, the unit has nothing to hand over.
      if (/===\s*(undefined|""|'')/.test(line) && /\?/.test(line)) continue;
      // No `??` at all, or one falling back on the empty string that the next
      // line turns into a refusal: the value has to come from outside.
      required.add(name);
    }
  }
  return required;
}

/** What the unit hands over: its own `Environment=`, plus any `EnvironmentFile=`. */
function providedVariables(unit: string): { names: Set<string>; files: string[] } {
  const names = new Set<string>();
  const files: string[] = [];
  for (const line of unit.split("\n")) {
    const direct = line.match(/^Environment=([A-Z][A-Z0-9_]*)=/);
    if (direct !== null) names.add(direct[1]!);
    const file = line.match(/^EnvironmentFile=-?(.+)$/);
    if (file !== null) files.push(file[1]!.trim());
  }
  return { names, files };
}

/**
 * The settings `/etc/caddy/sitesolide.env` carries. It is written on the
 * machine, not committed, so its content is read from the script that writes
 * it: that script is the only thing that decides what is in there.
 */
function zoneEnvFileVariables(): Set<string> {
  const script = readFileSync(join(REPO_ROOT, "bin", "deploy-caddy.sh"), "utf8");
  const names = new Set<string>();
  for (const match of script.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) names.add(match[1]!);
  // The heredoc that lands in the file writes them interpolated, so pick up
  // the assignments made to the shell too.
  for (const match of script.matchAll(/\b(SITESOLIDE_[A-Z0-9_]+)=/g)) names.add(match[1]!);
  return names;
}

describe("a unit hands over what its service demands", () => {
  const zoneEnvFile = zoneEnvFileVariables();

  for (const [unitPath, entryPath] of UNITS) {
    test(`${unitPath} starts ${entryPath}`, () => {
      const unitFile = join(REPO_ROOT, unitPath);
      const entryFile = join(REPO_ROOT, entryPath);
      expect(existsSync(unitFile)).toBe(true);
      expect(existsSync(entryFile)).toBe(true);

      const required = requiredVariables(readFileSync(entryFile, "utf8"));
      const { names, files } = providedVariables(readFileSync(unitFile, "utf8"));

      const missing = [...required].filter((name) => {
        if (names.has(name)) return false;
        // A variable of the zone file counts as handed over as soon as the
        // unit loads that file.
        if (files.includes("/etc/caddy/sitesolide.env") && zoneEnvFile.has(name)) return false;
        return true;
      });

      expect({ unit: unitPath, missing }).toEqual({ unit: unitPath, missing: [] });
    });
  }

  test("the table names every unit of the repository", async () => {
    // Added a unit and not its line here, and the check above would simply not
    // run on it, which is the failure mode this whole file exists against.
    const listed = new Set(UNITS.map(([unit]) => unit));
    const found: string[] = [];
    for await (const path of new Bun.Glob("**/*.service").scan({ cwd: REPO_ROOT })) {
      if (path.includes("node_modules") || path.startsWith(".claude/")) continue;
      found.push(path);
    }
    // The loopback unit runs nft with a file, no service of ours and no
    // setting to hand over.
    const exempt = new Set(["infra/loopback/sitesolide-loopback.service"]);
    expect(found.filter((path) => !listed.has(path) && !exempt.has(path))).toEqual([]);
    expect(found.length).toBeGreaterThan(0);
  });
});

test("the steward receives the zone, which names the landing's directory", () => {
  // Read in dashboard/src/config.ts rather than in steward.ts, so the table
  // above does not see it: without it, the landing's folder is no site to the
  // steward, and its files never showed in the dashboard.
  const unit = readFileSync(join(REPO_ROOT, "infra", "steward", "sitesolide-steward.service"), "utf8");
  expect(providedVariables(unit).files).toContain("/etc/caddy/sitesolide.env");
  const config = readFileSync(join(REPO_ROOT, "dashboard", "src", "config.ts"), "utf8");
  expect(config).toContain("process.env.SITESOLIDE_ZONE");
});

