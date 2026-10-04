import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MonitorStatus } from "../src/status";
import { freePort } from "./fixtures";

/**
 * The single file bin/deploy-monitor.sh builds and installs, run as the timer
 * would run it, on a test tree. It proves the bundle carries what it imports
 * from outside monitor/, the CLI's slug rule, and that the entry point reads
 * its environment, refuses to guess a zone, and writes its status.
 *
 * The probe port is one nobody listens on and the zone resolves nowhere: the
 * run reaches nothing.
 */

const D = mkdtempSync(join(tmpdir(), "monitor-build-"));
const BUNDLE = join(D, "monitor.js");
afterAll(() => rmSync(D, { recursive: true, force: true }));

async function launch(env: Record<string, string>): Promise<{ code: number; output: string; error: string }> {
  // The Bun running the tests, by its path: the PATH given is the unit's, which has none.
  const child = Bun.spawn([process.execPath, BUNDLE], { env: { PATH: "/usr/bin:/bin", ...env }, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output, error };
}

describe("the built monitor", () => {
  test("bun build makes one file of it", async () => {
    const build = await Bun.build({ entrypoints: [join(import.meta.dir, "..", "monitor.ts")], target: "bun" });
    expect(build.success).toBe(true);
    expect(build.outputs).toHaveLength(1);
    await Bun.write(BUNDLE, build.outputs[0]!);
    expect(readFileSync(BUNDLE, "utf8")).toContain("isValidSlug");
  });

  test("with no zone it stops and says why", async () => {
    const result = await launch({});
    expect(result.code).toBe(1);
    expect(result.error).toContain("SITESOLIDE_ZONE is missing");
  });

  test("on a test tree it runs, half blind, and writes its status", async () => {
    const sites = join(D, "srv", "sites");
    const state = join(D, "state");
    mkdirSync(join(sites, "cms"), { recursive: true });
    mkdirSync(state, { recursive: true });
    const result = await launch({
      SITESOLIDE_ZONE: "test-zone.invalid",
      SITES_DIR: sites,
      STATE_DIRECTORY: state,
      DOMAINS_FILE: join(D, "missing.map"),
      BACKUP_STATUS_FILE: join(D, "missing.json"),
      DISK_PATHS: D,
      PROBE_PORT: String(freePort()),
    });
    expect(result.error).toBe("");
    expect(result.code).toBe(0);
    expect(result.output).toContain("heartbeat unconfigured, webhook unconfigured");
    expect(existsSync(join(state, "state.json"))).toBe(true);
    const status = JSON.parse(readFileSync(join(state, "status.json"), "utf8")) as MonitorStatus;
    expect(status).toMatchObject({ version: 1, zone: "test-zone.invalid", heartbeat: "unconfigured", webhook: "unconfigured" });
    // First run: what fails is only failing yet, nothing is down.
    expect(status.down).toEqual([]);
  });
});
