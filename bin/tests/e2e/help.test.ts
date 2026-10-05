import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMOTE_USAGE } from "../../cli/remote";
import { run, TEST_ZONE } from "./run";

/**
 * `help` and `--version`, on a workstation where `init` never ran: they are
 * what someone types first, and they used to answer "missing settings".
 * Every run gets an empty HOME, so that no configuration of the machine
 * running the tests is read.
 */

const WORK = mkdtempSync(join(tmpdir(), "help-test-"));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

let counter = 0;
function emptyHome(): string {
  const home = join(WORK, `home-${counter++}`);
  mkdirSync(home, { recursive: true });
  return home;
}

describe("help and version, with no configuration", () => {
  test("--help and help print the list on standard output and succeed", async () => {
    for (const arguments_ of [["--help"], ["help"], ["-h"]]) {
      const r = await run(WORK, arguments_, { env: { HOME: emptyHome() } });
      expect({ arguments_, code: r.code, error: r.error }).toEqual({ arguments_, code: 0, error: "" });
      expect(r.output).toStartWith("usage:\n");
      expect(r.output).toContain("  sitesolide deploy ");
      // The zone, when the environment knows it, names the dashboard.
      expect(r.output).toContain(`https://dashboard.${TEST_ZONE}`);
    }
  });

  test("--help after a command is a question: deploy --help deploys nothing", async () => {
    const r = await run(WORK, ["deploy", "--help"], { env: { HOME: emptyHome() } });
    expect(r.code).toBe(0);
    expect(r.output).toStartWith("usage:\n");
    expect(r.all).not.toContain("->");
    expect(r.all).not.toContain("missing settings");
  });

  test("what follows -- belongs to the command run starts, never to help", async () => {
    const r = await run(WORK, ["run", "--", "printenv", "--help"], { env: { HOME: emptyHome() } });
    expect(r.code).toBe(1);
    expect(r.error).toContain("missing settings: server");
  });

  test("bare, the list goes to standard error, and the exit code says nothing was done", async () => {
    const r = await run(WORK, [], { env: { HOME: emptyHome() } });
    expect(r.code).toBe(1);
    expect(r.output).toBe("");
    expect(r.error).toStartWith("usage:\n");
  });

  test("--version says dev from a checkout", async () => {
    const r = await run(WORK, ["--version"], { env: { HOME: emptyHome() } });
    expect(r).toMatchObject({ code: 0, output: "sitesolide dev\n", error: "" });
  });

  test("under --json, each is one result event", async () => {
    const version = await run(WORK, ["--version", "--json"], { env: { HOME: emptyHome() } });
    expect(JSON.parse(version.output)).toEqual({ type: "result", ok: true, command: "version", version: "dev", bun: Bun.version });
    const help = await run(WORK, ["--help", "--json"], { env: { HOME: emptyHome() } });
    const event = JSON.parse(help.output) as { type: string; command: string; usage: string[] };
    expect(event).toMatchObject({ type: "result", ok: true, command: "help" });
    expect(event.usage[0]).toBe("usage:");
  });

  test("a team member's workstation, a token and no server, gets the commands the token runs", async () => {
    const home = emptyHome();
    mkdirSync(join(home, ".config", "sitesolide"), { recursive: true });
    writeFileSync(join(home, ".config", "sitesolide", "config.json"), JSON.stringify({ api: `https://dashboard.${TEST_ZONE}` }));
    const r = await run(WORK, ["--help"], { env: { HOME: home } });
    expect(r.code).toBe(0);
    expect(r.output).toBe(`${REMOTE_USAGE.join("\n")}\n`);
  });
});
