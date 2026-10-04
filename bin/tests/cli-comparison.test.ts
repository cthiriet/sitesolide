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

describe("inside a route, order counts", () => {
  // The one Caddy directive that keeps the written order, and the generator
  // writes one: the visitor's identity headers come off before forward_auth
  // copies the portal's on. The same lines in another order are another block.
  const BLOCK = `sample.{$SITESOLIDE_ZONE} {
\troute {
\t\trequest_header -X-Sitesolide*
\t\tforward_auth @portal_guard 127.0.0.1:3026 {
\t\t\turi /verifier
\t\t}
\t}
\timport sample-routes
}
`;

  test("the routes snippet moved inside the route, ahead of forward_auth, is a divergence", () => {
    // A hand edit that serves the site before the portal is asked: every line
    // is still there, which a comparison by set of lines judged identical.
    const moved = BLOCK.replace("\timport sample-routes\n", "").replace(
      "\troute {\n",
      "\troute {\n\t\timport sample-routes\n",
    );
    expect(usefulDirectives(moved).sort()).toEqual(usefulDirectives(BLOCK).sort());
    expect(sameDirectives(moved, BLOCK)).toBe(false);
  });

  test("two lines of the route swapped, too", () => {
    const swapped = BLOCK.replace(
      "\t\trequest_header -X-Sitesolide*\n\t\tforward_auth @portal_guard 127.0.0.1:3026 {\n\t\t\turi /verifier\n\t\t}\n",
      "\t\tforward_auth @portal_guard 127.0.0.1:3026 {\n\t\t\turi /verifier\n\t\t}\n\t\trequest_header -X-Sitesolide*\n",
    );
    expect(sameDirectives(swapped, BLOCK)).toBe(false);
  });

  test("outside the route, order still does not count, nor do comments inside it", () => {
    const moved = BLOCK.replace("\timport sample-routes\n", "").replace("sample.{$SITESOLIDE_ZONE} {\n", "sample.{$SITESOLIDE_ZONE} {\n\timport sample-routes\n");
    expect(sameDirectives(moved, BLOCK)).toBe(true);
    expect(sameDirectives(BLOCK.replace("\troute {\n", "\troute {\n\t\t# why\n"), BLOCK)).toBe(true);
  });

  test("a route that differs is named whole, on one line", () => {
    const divergence = compareDirectives(BLOCK.replace("-X-Sitesolide*", "-X-Other*"), BLOCK);
    expect(divergence).toEqual({
      lost: ["route { request_header -X-Other*; forward_auth @portal_guard 127.0.0.1:3026 { uri /verifier } }"],
      added: ["route { request_header -X-Sitesolide*; forward_auth @portal_guard 127.0.0.1:3026 { uri /verifier } }"],
    });
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
