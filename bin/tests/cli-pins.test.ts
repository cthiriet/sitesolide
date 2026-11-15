import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUN, BUN_CURRENT, bunInstallScript } from "../cli/pins";
import { rewritePins, rewriteWorkflow } from "../update-pins";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const read = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A folder holding a `curl` that writes `body` wherever -o says, and records its arguments. */
function fakeCurl(body: string): { bin: string; log: string } {
  const folder = mkdtempSync(join(tmpdir(), "sitesolide-pins-"));
  folders.push(folder);
  const log = join(folder, "curl.log");
  writeFileSync(
    join(folder, "curl"),
    `#!/bin/sh
echo "$@" >> ${JSON.stringify(log)}
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then printf %s ${JSON.stringify(body)} > "$2"; shift; fi
  shift
done
`,
  );
  chmodSync(join(folder, "curl"), 0o755);
  return { bin: folder, log };
}

describe("Bun's pin", () => {
  test("a version, and one SHA-256 per build the machine may take", () => {
    expect(BUN.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(BUN.sha256).sort()).toEqual(["aarch64", "x64", "x64-baseline"]);
    for (const sum of Object.values(BUN.sha256)) expect(sum).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the release workflow builds the binaries with the Bun the machine runs", () => {
    const versions = [...read(".github/workflows/release.yml").matchAll(/bun-version: (\S+)/g)].map((match) => match[1]);
    expect(versions.length).toBeGreaterThan(0);
    expect(new Set(versions)).toEqual(new Set([BUN.version]));
  });

  test("the install script parses, downloads the pinned release and checks it before opening it", () => {
    const script = bunInstallScript();
    expect(Bun.spawnSync(["sh", "-n"], { stdin: new TextEncoder().encode(script) }).exitCode).toBe(0);
    expect(script).toContain(`https://github.com/oven-sh/bun/releases/download/bun-v${BUN.version}/bun-linux-$build.zip`);
    for (const sum of Object.values(BUN.sha256)) expect(script).toContain(sum);
    expect(script.indexOf("sha256sum")).toBeLessThan(script.indexOf("unzip"));
    expect(script).not.toContain("| bash");
    expect(BUN_CURRENT).toContain(`= ${BUN.version} ]`);
  });

  test.skipIf(Bun.which("sha256sum") === null)("a download that does not match its pin is refused, and nothing is installed", () => {
    const curl = fakeCurl("not the release");
    const run = Bun.spawnSync(["sh", "-c", `set -e\n${bunInstallScript()}`], {
      env: { PATH: `${curl.bin}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain(`of ${BUN.version} does not match its pin`);
    expect(run.stderr.toString()).toContain("nothing was installed");
    expect(readFileSync(curl.log, "utf8")).toContain(`bun-v${BUN.version}/bun-linux-`);
  });

  test("update-pins rewrites the version and the sums, and nothing else", () => {
    const pins = read("bin/cli/pins.ts");
    const sums = { x64: "1".repeat(64), "x64-baseline": "2".repeat(64), aarch64: "3".repeat(64) };
    const next = rewritePins(pins, "9.8.7", sums);
    expect(next).toContain('version: "9.8.7"');
    expect(next).toContain(`x64: "${"1".repeat(64)}"`);
    expect(next).toContain(`"x64-baseline": "${"2".repeat(64)}"`);
    expect(next).toContain(`aarch64: "${"3".repeat(64)}"`);
    for (const sum of Object.values(BUN.sha256)) expect(next).not.toContain(sum);
    expect(next.split("\n").length).toBe(pins.split("\n").length);
    const workflow = rewriteWorkflow(read(".github/workflows/release.yml"), "9.8.7");
    expect(workflow).toContain("bun-version: 9.8.7");
    expect(workflow).not.toContain(`bun-version: ${BUN.version}`);
  });
});
