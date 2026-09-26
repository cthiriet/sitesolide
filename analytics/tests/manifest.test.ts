import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PORT } from "../src/config";
import { HEADERS } from "../src/responses";

/**
 * This site's door does not sit in its code but in its manifest: as soon as
 * `portal` is `true`, the platform's portal guards the whole host, except the
 * paths of `portalExempt`, which go to the service without asking anything.
 *
 * This service has a particular reason to look closely at it: **two paths must
 * stay open to the whole internet**, ingestion and the script, otherwise no
 * measured site could reach them; and **all the rest must stay closed**,
 * because the dashboard shows the visits of every customer. An exemption that
 * was too wide would open one along with the other.
 */
const ROOT = join(import.meta.dir, "..");

type Manifest = {
  slug: string;
  port: number;
  routes: string[];
  publicDir?: string;
  env: Record<string, string>;
  exclude: string[];
  secrets?: string[];
  headers?: Record<string, string>;
  network?: string;
  portal?: unknown;
  portalExempt?: string[];
};

const manifest = JSON.parse(readFileSync(join(ROOT, "sitesolide.json"), "utf8")) as Manifest;

/** Caddy's `path` pattern: a trailing star means any continuation at all. */
const covers = (pattern: string, path: string) =>
  pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;

const exempt = (path: string) =>
  (manifest.portalExempt ?? []).some((pattern) => covers(pattern, path));

const routed = (path: string) => manifest.routes.some((pattern) => covers(pattern, path));

describe("the door", () => {
  test("the site is behind the portal", () => {
    // `true` and nothing else: it is the only value the CLI accepts.
    expect(manifest.portal).toBe(true);
  });

  test("ingestion and the script are open, and they alone", () => {
    // Those two must be: a visitor to a customer site has no portal cookie, and
    // never will. Any other pattern, or a wider pattern such as `/*`, would
    // hand the dashboard of every customer's visits to whoever knows the
    // address.
    expect(manifest.portalExempt).toEqual(["/e", "/a.js"]);
  });

  test("the portal guards all the rest", () => {
    // There is no page behind any more, the numbers being read in the
    // dashboard, but a door on a service without a page costs nothing and will
    // matter the day a page comes back to it.
    expect(manifest.portal).toBe(true);
    for (const path of ["/", "/sites", "/site/vineyard"]) {
      expect(exempt(path)).toBe(false);
    }
  });

  test("no exemption covers more than its own path", () => {
    // `/e` exempts `/e`, not `/entrees` nor `/e/../sites`.
    expect(exempt("/entrees")).toBe(false);
    expect(exempt("/e/other")).toBe(false);
    expect(exempt("/a.json")).toBe(false);
  });
});

describe("the routes", () => {
  test("cover ingestion only", () => {
    // It is this service's only route since the dashboard's numbers moved to
    // the dashboard. A path absent from this list never wakes the service:
    // Caddy looks for it in public/ and returns a 404.
    expect(manifest.routes).toEqual(["/e"]);
  });

  test("leave the script to Caddy", () => {
    // It is served without waking Bun: that is the whole point of a static
    // file, and it leaves on every page of every measured site.
    expect(routed("/a.js")).toBe(false);
    expect(manifest.publicDir).toBe("public");
  });
});

describe("the rest of the manifest", () => {
  test("declares the port the service listens on", () => {
    // Two values for a single decision: a gap here makes the whole host answer
    // 502, and nothing in the service's log would say so.
    expect(manifest.port).toBe(PORT);
  });

  test("expects no secret", () => {
    // Nothing authenticates ingestion, and the dashboard is guarded by the
    // portal: this service deploys without any value having to be placed in the
    // dashboard beforehand.
    expect(manifest.secrets ?? []).toEqual([]);
  });

  test("does not leave the machine", () => {
    // It reaches nobody: it receives, it writes, it displays.
    expect(manifest.network).toBe("localhost");
  });

  test("carries the headers the service sets itself", () => {
    // Caddy sets them on the whole host from the manifest; `src/responses.ts`
    // copies them so that the local server behaves the same.
    for (const [name, value] of Object.entries(manifest.headers ?? {})) {
      expect(HEADERS[name]).toBe(value);
    }
  });

  test("takes neither the database nor the tests along at deployment", () => {
    for (const dir of ["node_modules", "data", ".test-data", "tests"]) {
      expect(manifest.exclude).toContain(dir);
    }
  });
});
