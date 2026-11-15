import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUN, BUN_CURRENT, bunInstallScript } from "../cli/pins";
import { CLOUDFLARE } from "../cli/dns/cloudflare";
import { dnsEntry } from "../cli/dns/registry";
import { CADDY_BUILD } from "../cli/setup";
import { caddyPins, rewritePins, rewriteWorkflow } from "../update-pins";

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

describe("Caddy's build", () => {
  const build = read(CADDY_BUILD);

  test("parses, and pins Caddy, Go's toolchain and xcaddy to exact versions", () => {
    expect(Bun.spawnSync(["sh", "-n", join(REPO_ROOT, CADDY_BUILD)]).exitCode).toBe(0);
    const pins = caddyPins(build);
    expect(pins.CADDY_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(pins.GO_TOOLCHAIN).toMatch(/^go\d+\.\d+\.\d+$/);
    expect(pins.XCADDY_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  test("pins a version of the module of every DNS provider setup offers", () => {
    const pins = caddyPins(build);
    // Every provider dnsEntry takes: Cloudflare alone, today.
    for (const provider of [CLOUDFLARE]) {
      expect(dnsEntry(provider.name)).toBe(provider);
      const module = provider.caddy.package;
      expect({ module, pinned: pins[module] }).toEqual({ module, pinned: expect.stringMatching(/^v\d+\.\d+\.\d+$/) });
    }
  });

  test("never turns Go's checksum database off, nor asks Caddy's build service", () => {
    const commands = build.split("\n").filter((line) => !line.trimStart().startsWith("#"));
    expect(commands.join("\n")).toContain("GOSUMDB=sum.golang.org");
    expect(commands.join("\n")).toContain("GOPROXY=https://proxy.golang.org");
    expect(commands.filter((line) => /GOSUMDB=off|GONOSUMDB=|GOFLAGS=.*-insecure|GOINSECURE=|add-package|caddyserver\.com|,direct/.test(line))).toEqual([]);
  });

  test("refuses a module it has no pinned version for, and a wrong call, before anything is installed", () => {
    const unknown = Bun.spawnSync(["sh", join(REPO_ROOT, CADDY_BUILD), "github.com/caddy-dns/elsewhere", "dns.providers.elsewhere", "/nonexistent/caddy"], { stderr: "pipe" });
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr.toString()).toContain("no pinned version for the module github.com/caddy-dns/elsewhere");
    const wrong = Bun.spawnSync(["sh", join(REPO_ROOT, CADDY_BUILD)], { stderr: "pipe" });
    expect(wrong.exitCode).toBe(2);
    expect(wrong.stderr.toString()).toContain("usage: build.sh");
  });
});
