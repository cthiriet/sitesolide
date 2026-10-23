import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherBuildSecrets, missingBuildSecrets, readWorkstationSecrets, resolveBuildSecrets, sourceLine, unreadableWorkstation } from "../cli/build-secrets";

/**
 * A project's build secrets, taken from whoever deploys: the environment
 * first, then the workstation's `<vault>/<slug>.env`, parsed strictly, only
 * the names the manifest declares. Never a value in a message.
 */

const WORK = mkdtempSync(join(tmpdir(), "build-secrets-"));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

const PLANTED = "planted-value-never-quoted";

describe("resolveBuildSecrets", () => {
  test("the environment first, then the workstation file, each said by its source", () => {
    const resolution = resolveBuildSecrets(["CMS_TOKEN", "REGISTRY_TOKEN"], { CMS_TOKEN: "from-env", REGISTRY_TOKEN: undefined }, `CMS_TOKEN=from-file\nREGISTRY_TOKEN='from file'\n`);
    expect(resolution.values).toEqual({ CMS_TOKEN: "from-env", REGISTRY_TOKEN: "from file" });
    expect(resolution.sources).toEqual([
      { name: "CMS_TOKEN", source: "environment" },
      { name: "REGISTRY_TOKEN", source: "workstation" },
    ]);
    expect(resolution.missing).toEqual([]);
    expect(resolution.refusal).toBeNull();
  });

  test("an empty value counts as set, in the environment as in the file", () => {
    expect(resolveBuildSecrets(["A"], { A: "" }, null).values).toEqual({ A: "" });
    expect(resolveBuildSecrets(["A"], {}, "A=\n").values).toEqual({ A: "" });
  });

  test("only the declared names are taken from the file, whatever else it holds", () => {
    const resolution = resolveBuildSecrets(["CMS_TOKEN"], {}, `CMS_TOKEN=x\nAWS_SECRET_ACCESS_KEY=${PLANTED}\n`);
    expect(resolution.values).toEqual({ CMS_TOKEN: "x" });
    expect(JSON.stringify(resolution)).not.toContain(PLANTED);
  });

  test("a name in neither is missing; with no file at all, every name left is", () => {
    expect(resolveBuildSecrets(["A", "B"], { A: "1" }, "C=3\n").missing).toEqual(["B"]);
    expect(resolveBuildSecrets(["A", "B"], {}, null).missing).toEqual(["A", "B"]);
  });

  test("a file that does not parse: its line number and reason, never the line", () => {
    const resolution = resolveBuildSecrets(["CMS_TOKEN"], {}, `# a comment\nCMS_TOKEN = ${PLANTED}\n`);
    expect(resolution.refusal).toBe("line 2: whitespace before `=`");
    expect(resolution.missing).toEqual(["CMS_TOKEN"]);
    expect(JSON.stringify(resolution)).not.toContain(PLANTED);
    const twice = resolveBuildSecrets(["A"], {}, `A=1\nA=${PLANTED}\n`);
    expect(twice.refusal).toBe("line 2: A is set twice");
  });

  test("the file is not read when the environment holds every name: a malformed one stops nothing then", () => {
    expect(resolveBuildSecrets(["A"], { A: "1" }, "not a line\n").refusal).toBeNull();
    expect(resolveBuildSecrets([], {}, "not a line\n")).toEqual({ values: {}, sources: [], missing: [], refusal: null });
  });
});

describe("the workstation file", () => {
  test("read only when a name is left for it, strictly decoded", async () => {
    const path = join(WORK, "blog.env");
    writeFileSync(path, "CMS_TOKEN=from-file\n");
    expect(await gatherBuildSecrets(["CMS_TOKEN"], {}, path)).toMatchObject({ values: { CMS_TOKEN: "from-file" }, missing: [] });
    // Absent: the names are missing, nothing refused.
    expect(await gatherBuildSecrets(["CMS_TOKEN"], {}, join(WORK, "absent.env"))).toMatchObject({ missing: ["CMS_TOKEN"], refusal: null });
    // Not UTF-8: refused, without its bytes.
    const bad = join(WORK, "bad.env");
    writeFileSync(bad, new Uint8Array([0x41, 0x3d, 0xff, 0x0a]));
    expect(await readWorkstationSecrets(bad)).toEqual({ kind: "refused", reason: "it is not valid UTF-8" });
    expect(await gatherBuildSecrets(["A"], {}, bad)).toMatchObject({ missing: ["A"], refusal: "it is not valid UTF-8" });
    // A folder where the file goes: refused too.
    const folder = join(WORK, "folder.env");
    mkdirSync(folder);
    expect((await readWorkstationSecrets(folder)).kind).toBe("refused");
    // Every name in the environment: the file is never opened, even a bad one.
    expect(await gatherBuildSecrets(["A"], { A: "1" }, bad)).toMatchObject({ values: { A: "1" }, refusal: null });
  });
});

describe("what is said", () => {
  test("a source by its name and where it came from, never its value", () => {
    expect(sourceLine("CMS_TOKEN", "environment", "/home/someone/.config/sitesolide/secrets/blog.env")).toBe("build secret CMS_TOKEN from your environment");
    expect(sourceLine("CMS_TOKEN", "workstation", "/home/someone/.config/sitesolide/secrets/blog.env")).toBe("build secret CMS_TOKEN from /home/someone/.config/sitesolide/secrets/blog.env");
  });

  test("the refusals: the names and the remedy, nothing sent", () => {
    expect(missingBuildSecrets(["CMS_TOKEN"], "/v/blog.env")).toEqual({
      message: "build secrets missing: CMS_TOKEN",
      details: ["export it, or add it to /v/blog.env; nothing was sent"],
    });
    expect(missingBuildSecrets(["A", "B"], "/v/blog.env").details[0]).toBe("export them, or add them to /v/blog.env; nothing was sent");
    expect(unreadableWorkstation("/v/blog.env", "line 2: whitespace before `=`").message).toBe("the build secrets file does not read: /v/blog.env, line 2: whitespace before `=`");
  });
});
