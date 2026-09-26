import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FINGERPRINTED, cacheControl } from "../src/http";

/**
 * In production, Caddy serves `public/` without going through `server.ts`: it
 * is therefore Caddy that decides, and the local server must say the same thing
 * as it does. The two have already diverged once, and the Tailwind stylesheet
 * stayed invisible online after a deployment, for want of a `Cache-Control` on
 * .css files.
 */
/** The Caddyfile lives in this repository, this service having joined it. */
const REPO_ROOT = join(import.meta.dir, "..", "..");

const CADDYFILE = readFileSync(join(REPO_ROOT, "infra", "caddy", "Caddyfile"), "utf8");

/**
 * Returns the Cache-Control value associated with the matcher named in the
 * Caddyfile. The `?` is part of the directive: it sets a default value instead
 * of overwriting the one a Bun service has already set.
 */
function directive(matcher: string): string | null {
  const row = CADDYFILE.split("\n").find((l) => l.trim().startsWith(`header @${matcher} ?Cache-Control`));
  return row?.match(/"([^"]+)"/)?.[1] ?? null;
}

/** Returns the named `path_regexp` matcher expression, as written in Caddy. */
function expression(matcher: string): string | null {
  const row = CADDYFILE.split("\n").find((l) => l.trim().startsWith(`@${matcher} path_regexp`));
  return row?.trim().split(/\s+/).slice(2).join(" ") ?? null;
}

/**
 * Returns the extensions covered by a Caddyfile matcher, whether it fits on one
 * line (`@x path *.css`) or in a block, where the `path` line is indented under
 * `@x {`. @revalidated took that second form the day a `not` had to be added to
 * it.
 */
function extensions(matcher: string): string[] {
  const rows = CADDYFILE.split("\n");
  const start = rows.findIndex((l) => l.trim().startsWith(`@${matcher} `));
  if (start === -1) return [];

  // An opening brace makes us look for the `path` line inside the block.
  const row = rows[start]!.trim().endsWith("{")
    ? rows.slice(start + 1).find((l) => l.trim().startsWith("path "))
    : rows[start];

  return [...(row?.matchAll(/\*(\.\w+)/g) ?? [])].map((m) => m[1]!);
}

describe("the local server applies Caddy's cache policy", () => {
  test("files regenerated at every deployment are revalidated", () => {
    // Without an explicit rule, the browser applies a heuristic based on
    // Last-Modified and may serve the old stylesheet after a release.
    expect(extensions("revalidated")).toEqual([".css", ".js"]);
    expect(directive("revalidated")).toBe(cacheControl("/styles.css"));
  });

  test("media and fonts are frozen", () => {
    for (const extension of extensions("immutable")) {
      expect(cacheControl(`/file${extension}`)).toBe("public, max-age=31536000, immutable");
    }
    expect(directive("immutable")).toBe(cacheControl("/photo.jpg"));
  });

  test("a fingerprinted file is frozen for a year, on both sides", () => {
    // It is what authorises the whole arrangement: without this rule, the HTML
    // would arrive fresh on top of a stylesheet an hour old, and the page would
    // draw itself by halves for a visitor returning after a deployment.
    expect(cacheControl("/styles.4f3a9c2b.css")).toBe("public, max-age=31536000, immutable");
    expect(cacheControl("/main.aabbccdd.js")).toBe("public, max-age=31536000, immutable");
    expect(directive("fingerprinted")).toBe(cacheControl("/styles.4f3a9c2b.css"));
  });

  test("the fingerprint pattern is the same in Caddy and in the service", () => {
    // Two writings of the same pattern, in two languages: the only way for a
    // gap not to show is not to look for it. A fingerprinted file Caddy no
    // longer recognised would go back to one hour, and the arrangement would
    // fall without anything saying so.
    expect(expression("fingerprinted")).toBe(FINGERPRINTED.source);
  });

  test("a file without a fingerprint is revalidated on every visit", () => {
    // no-cache and not a duration: the browser keeps the file and only asks
    // whether it has changed, to which Caddy answers 304 when nothing has
    // moved. It is what makes a stale style impossible on the sites that do not
    // fingerprint, without asking them for the slightest machinery.
    expect(cacheControl("/styles.css")).toBe("no-cache");
    expect(cacheControl("/main.js")).toBe("no-cache");
    expect(directive("revalidated")).toBe(cacheControl("/styles.css"));
  });

  test("the one-hour rule explicitly excludes fingerprinted files", () => {
    // Without that `not`, both `header ?` applied to the same response and it
    // was the hour that won over the year, whatever their order in the file.
    // The site went through a release with its stylesheet on a short cache
    // before anyone saw it. Two disjoint matchers do not raise the question.
    const rows = CADDYFILE.split("\n");
    const start = rows.findIndex((l) => l.trim().startsWith("@revalidated "));
    const block = rows.slice(start, start + 5).join("\n");
    expect(block).toContain(`not path_regexp ${FINGERPRINTED.source}`);
  });

  test("a hexadecimal run too short or too long is not a fingerprint", () => {
    // The pattern must be strict: a version name written by hand, such as
    // main.v2.js, must on no account end up frozen for a year.
    expect(cacheControl("/styles.4f3a9c.css")).toBe("no-cache");
    expect(cacheControl("/styles.4f3a9c2b1d.css")).toBe("no-cache");
    expect(cacheControl("/main.v2.js")).toBe("no-cache");
  });

  test("the HTML stays fresh", () => {
    expect(directive("html")).toBe(cacheControl("/index.html"));
  });

  test("Caddy sets a default value, it never overwrites a service's own", () => {
    // Without the `?`, @immutable also applied to proxied responses: a visitor's
    // photo went back out as `public, immutable` for a year, on top of the
    // `private, max-age=3600` that its service gave it.
    for (const matcher of ["immutable", "html", "revalidated"]) {
      expect(directive(matcher)).not.toBeNull();
    }
  });
});
