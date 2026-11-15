import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS, commandRefusal } from "../cli/commands";
import { CLI } from "./e2e/run";

/** The CLI in a child process, on a workstation where init never ran. */
async function bare(arguments_: string[]): Promise<{ code: number; output: string; error: string }> {
  const home = mkdtempSync(join(tmpdir(), "sitesolide-commands-"));
  try {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SITESOLIDE_")));
    const proc = Bun.spawn(["bun", CLI, ...arguments_], { cwd: home, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...inherited, HOME: home } });
    const [output, error] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, output, error };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("a command the CLI does not run", () => {
  test("every command of the dispatch is known", () => {
    const source = readFileSync(join(import.meta.dir, "..", "sitesolide.ts"), "utf8");
    const dispatch = source.slice(source.lastIndexOf("switch (command) {"));
    const cases = [...dispatch.matchAll(/^ {4}case "([a-z-]+)":/gm)].map((match) => match[1]!);
    expect(cases.length).toBeGreaterThan(10);
    for (const command of cases) expect({ command, known: COMMANDS.has(command) }).toEqual({ command, known: true });
    expect(commandRefusal("deploy")).toBeNull();
  });

  test("is named first, and a removed one says what replaced it", () => {
    expect(commandRefusal("frobnicate")).toMatchObject({ message: "unknown command: frobnicate", removed: false });
    const people = commandRefusal("people")!;
    expect(people.message).toBe("unknown command: people");
    expect(people.details.join(" ")).toContain("sitesolide share <email>");
  });

  test("before any configuration is read: never missing settings", async () => {
    const people = await bare(["people"]);
    expect(people.code).toBe(1);
    expect(people.error.split("\n")[0]).toBe("!! unknown command: people");
    expect(people.error).toContain("sitesolide share <email>");
    expect(people.error).not.toContain("missing settings");

    const typo = await bare(["deplyo"]);
    expect(typo.code).toBe(1);
    expect(typo.error.split("\n")[0]).toBe("!! unknown command: deplyo");
    expect(typo.error).toContain("usage:");

    const json = await bare(["people", "--json"]);
    expect(JSON.parse(json.output.trim().split("\n").at(-1)!)).toMatchObject({ type: "error", message: "unknown command: people" });
  });

  test("a share flag a release took away gives its pointer before the configuration check", async () => {
    for (const [arguments_, said] of [
      [["share", "--role", "developer", "a@acme.test"], "--role is gone"],
      [["share", "--domain", "acme.test"], "--domain is gone"],
      [["share", "--only-admins"], "--only-admins is gone"],
      [["share", "@acme.test"], "a whole domain is given access no more"],
    ] as const) {
      const result = await bare([...arguments_]);
      expect({ arguments_, code: result.code }).toEqual({ arguments_, code: 1 });
      expect(result.error).toContain(said);
      expect(result.error).not.toContain("missing settings");
    }
  });
});
