import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TOOLS } from "../mcp";
import { REMOTE_USAGE } from "../cli/remote";

/**
 * What an agent reads before it acts: the skill, llms.txt, and the usage the
 * documentation quotes. An agent believes them to the letter, so they are held
 * to what the code does.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..");
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8");

describe("the skill", () => {
  const text = read("skills/sitesolide/SKILL.md");
  const front = Bun.YAML.parse(text.split("---")[1]!) as Record<string, string>;

  test("its frontmatter is what Claude Code reads: a name and a description it can trigger on", () => {
    expect(front.name).toBe("sitesolide");
    expect(front.description).toContain("deploy");
    // Claude Code truncates the two together past this length.
    expect(`${front.description} ${front.when_to_use ?? ""}`.length).toBeLessThanOrEqual(1536);
  });

  test("it names the tools the MCP server serves, and sends secrets to the dashboard", () => {
    for (const tool of TOOLS) expect(text).toContain(`\`${tool.name}\``);
    expect(text).toContain("dashboard");
    expect(text).toContain("caddy stop");
  });
});

describe("llms.txt", () => {
  const text = read("llms.txt");

  test("the llmstxt.org shape: a title, then a summary in a blockquote", () => {
    const lines = text.split("\n").filter((line) => line.trim() !== "");
    expect(lines[0]).toBe("# sitesolide");
    expect(lines[1]).toStartWith("> ");
  });

  test("every link leads to a file of the repository", () => {
    const links = [...text.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!);
    expect(links.length).toBeGreaterThan(5);
    for (const link of links) expect({ link, exists: existsSync(join(REPO_ROOT, link)) }).toEqual({ link, exists: true });
  });
});

describe("the documented usage", () => {
  test("docs/commands.md quotes every line the CLI prints for its usage", () => {
    const source = read("bin/sitesolide.ts");
    const usage = source.slice(source.indexOf('"usage:",'), source.indexOf('].join("\\n")', source.indexOf('"usage:",')));
    const lines = [...usage.matchAll(/^\s*"((?:\\.|[^"\\])*)",?$/gm)].map((match) => match[1]!.replace(/\\"/g, '"').replace(/^ {2}/, ""));
    expect(lines.length).toBeGreaterThan(25);
    const documented = read("docs/commands.md");
    for (const line of lines.filter((candidate) => candidate !== "usage:" && candidate !== "")) {
      expect({ line, documented: documented.includes(line) }).toEqual({ line, documented: true });
    }
  });

  test("docs/commands.md quotes every line the CLI prints for its usage with a team token", () => {
    const documented = read("docs/commands.md");
    const lines = REMOTE_USAGE.filter((line) => line !== "" && !line.startsWith("usage")).map((line) => line.replace(/^ {2}/, ""));
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) expect({ line, documented: documented.includes(line) }).toEqual({ line, documented: true });
  });

  test("the documents an agent is pointed at exist", () => {
    for (const path of ["docs/agents.md", "docs/manifest.md", "docs/commands.md"]) expect(existsSync(join(REPO_ROOT, path))).toBe(true);
    expect(dirname(join(REPO_ROOT, "skills/sitesolide/SKILL.md"))).toEndWith("skills/sitesolide");
  });
});
