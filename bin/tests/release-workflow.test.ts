import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The release workflow, read as data: what holds a token that writes
 * releases, and what runs code from npm, must never be the same job.
 */

const TEXT = readFileSync(join(import.meta.dir, "..", "..", ".github", "workflows", "release.yml"), "utf8");

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Job = { permissions?: Record<string, string>; needs?: string; if?: string; steps: Step[] };
const workflow = Bun.YAML.parse(TEXT) as { permissions: Record<string, string>; jobs: Record<string, Job> };

describe("the release workflow", () => {
  test("grants nothing by default, and only the job that publishes may write", () => {
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs).sort()).toEqual(["build", "publish"]);
    expect(workflow.jobs.build!.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.publish!.permissions).toEqual({ contents: "write", "id-token": "write", attestations: "write" });
    expect(workflow.jobs.publish!.needs).toBe("build");
  });

  test("the tests and the build, which run npm's code, are the read-only job's alone", () => {
    const runs = (job: Job) => job.steps.map((step) => step.run ?? "").join("\n");
    expect(runs(workflow.jobs.build!)).toContain("bin/test.sh");
    expect(runs(workflow.jobs.build!)).toContain("bin/build.ts");
    const publish = runs(workflow.jobs.publish!);
    expect(publish).not.toMatch(/\bbun\b|bin\/|npm|checkout/);
    expect(workflow.jobs.publish!.steps.some((step) => step.uses?.startsWith("actions/checkout"))).toBe(false);
  });

  test("every action is pinned to a full commit", () => {
    const uses = Object.values(workflow.jobs).flatMap((job) => job.steps.map((step) => step.uses).filter((value): value is string => value !== undefined));
    expect(uses.length).toBeGreaterThan(4);
    for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  test("attests what it publishes, and never overwrites a release's files", () => {
    const publish = workflow.jobs.publish!.steps;
    expect(publish.some((step) => step.uses?.startsWith("actions/attest-build-provenance@"))).toBe(true);
    expect(TEXT).not.toContain("--clobber");
    expect(publish.map((step) => step.run ?? "").join("\n")).toContain("nothing is overwritten");
  });
});
