import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeProbe } from "../src/checks";
import { answeredOff } from "../src/machine";

describe("a site its owner turned off", () => {
  test("its 503 is no failure, another 503 still is", () => {
    expect(judgeProbe("blog.test-zone.invalid", "blog", { status: 503, off: "blog" }).verdict).toBe("ok");
    // Another project's answer, which an app could forge in its name.
    expect(judgeProbe("crm.test-zone.invalid", "crm", { status: 503, off: "blog" }).verdict).toBe("fail");
    expect(judgeProbe("blog.test-zone.invalid", "blog", { status: 503 }).verdict).toBe("fail");
  });

  const sites = mkdtempSync(join(tmpdir(), "monitor-off-"));
  afterAll(() => rmSync(sites, { recursive: true, force: true }));
  const lay = (slug: string, manifest: object) => {
    mkdirSync(join(sites, slug), { recursive: true });
    writeFileSync(join(sites, slug, "sitesolide.json"), JSON.stringify(manifest));
  };
  lay("blog", { slug: "blog", disabled: true });
  lay("crm", { slug: "crm", port: 3010, start: "/usr/local/bin/bun run server.ts" });

  test("is told off by its 503 and its manifest marked off on the machine", () => {
    expect(answeredOff(sites, 503, "blog")).toBe(true);
  });

  test("an app that sends the header itself is not taken for one", () => {
    // Its own failure, header and all: the status is not the 503 of the block.
    expect(answeredOff(sites, 500, "crm")).toBe(false);
    // Even its own 503: its manifest is not marked off.
    expect(answeredOff(sites, 503, "crm")).toBe(false);
    // Naming another project turned off, or a path.
    expect(answeredOff(sites, 500, "blog")).toBe(false);
    expect(answeredOff(sites, 503, "../blog")).toBe(false);
    expect(answeredOff(sites, 503, "absent")).toBe(false);
    expect(answeredOff(sites, 503, null)).toBe(false);
  });
});
