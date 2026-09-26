import { describe, expect, test } from "bun:test";
import {
  compareDirectives,
  usefulDirectives,
  sameDirectives,
  summariseDivergence,
} from "../cli/comparison";

/**
 * Comparing a deployment file to what the manifest would generate.
 *
 * The stakes are two symmetric mistakes, both expensive: calling a file
 * different when it renders the same service stops a healthy deployment over
 * comments, and calling a file identical when it really differs lets through a
 * port or a memory ceiling nobody asked for.
 */

const UNIT = `# Service for project budget
[Service]
User=site-budget
Environment=PORT=3022
MemoryMax=256M
`;

describe("the lines that decide", () => {
  test("comments and blanks are set aside", () => {
    expect(usefulDirectives(UNIT)).toEqual([
      "[Service]",
      "User=site-budget",
      "Environment=PORT=3022",
      "MemoryMax=256M",
    ]);
  });

  test("indentation does not make a different directive", () => {
    // A Caddy fragment indents its directives inside its block, and the
    // generator does not always indent them the same way.
    expect(usefulDirectives("\troot * /srv/sites/x/public")).toEqual([
      "root * /srv/sites/x/public",
    ]);
  });

  test("an indented comment is still a comment", () => {
    expect(usefulDirectives("   # an explanation\n")).toEqual([]);
  });
});

describe("what counts as identical", () => {
  test("comments do not make a file divergent", () => {
    // This is a real case: a unit and a fragment written by hand, with comments
    // that are the memory of real outages, whose directives are the
    // generator's.
    const commented = UNIT.replace("[Service]", "# a reason\n[Service]");
    expect(sameDirectives(commented, UNIT)).toBe(true);
  });

  test("nor does order", () => {
    // systemd does not read the order of directives in a section, and Caddy
    // sorts its own.
    const reversed = usefulDirectives(UNIT).reverse().join("\n");
    expect(sameDirectives(reversed, UNIT)).toBe(true);
  });

  test("a changed directive, on the other hand, shows", () => {
    expect(sameDirectives(UNIT.replace("3022", "3099"), UNIT)).toBe(false);
  });

  test("a removed directive shows", () => {
    expect(sameDirectives(UNIT.replace("MemoryMax=256M\n", ""), UNIT)).toBe(false);
  });
});

describe("naming what differs", () => {
  test("the file on one side, the manifest on the other", () => {
    const divergence = compareDirectives(UNIT, UNIT.replace("3022", "3099"));
    expect(divergence).toEqual({
      lost: ["Environment=PORT=3022"],
      added: ["Environment=PORT=3099"],
    });
  });

  test("an identical file produces no line", () => {
    expect(compareDirectives(UNIT, UNIT)).toEqual({ lost: [], added: [] });
  });

  test("the summary carries both signs", () => {
    const lines = summariseDivergence(compareDirectives(UNIT, UNIT.replace("3022", "3099")));
    expect(lines).toEqual(["  - Environment=PORT=3022", "  + Environment=PORT=3099"]);
  });

  test("a long divergence is cut, and says so", () => {
    // Drowning the refusal under forty lines would name nothing at all, but
    // hiding the rest would make the disagreement look smaller than it is.
    const generated = Array.from({ length: 10 }, (_, i) => `Environment=V${i}=1`).join("\n");
    const lines = summariseDivergence(compareDirectives("", generated), 4);
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toBe("  + ... and 6 more");
  });
});
