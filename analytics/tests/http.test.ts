import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cacheControl, resolveAsset } from "../src/http";

const PUBLIC = "/srv/sites/library/public";

describe("resolveAsset", () => {
  test("resolves an ordinary file", () => {
    expect(resolveAsset("/index.html", PUBLIC)).toBe(`${PUBLIC}/index.html`);
    expect(resolveAsset("/styles.css", PUBLIC)).toBe(`${PUBLIC}/styles.css`);
  });

  test("refuses to leave the public directory", () => {
    // The service runs next to its secret and its database, which carries
    // everything the other machines have entrusted to it.
    for (const path of [
      "/../src/config.ts",
      "/../../library/data/library.db",
      "/../../../etc/sitesolide/library.env",
      "/../../../../etc/passwd",
    ]) {
      const resolved = resolveAsset(path, PUBLIC);
      if (resolved !== null) expect(resolved.startsWith(`${PUBLIC}/`)).toBe(true);
    }
  });

  test("refuses a percent-encoded climb up", () => {
    // %2e%2e%2f means ../: deciding before decoding is of no use.
    for (const path of ["/%2e%2e/src/config.ts", "/%2e%2e%2fsrc%2fconfig.ts"]) {
      const resolved = resolveAsset(path, PUBLIC);
      if (resolved !== null) expect(resolved.startsWith(`${PUBLIC}/`)).toBe(true);
    }
  });

  test("refuses a null byte and an invalid encoding", () => {
    expect(resolveAsset(`/file${String.fromCharCode(0)}.js`, PUBLIC)).toBeNull();
    expect(resolveAsset("/%zz", PUBLIC)).toBeNull();
  });

  test("is not caught by a neighbouring directory with the same prefix", () => {
    // It starts with the root without being inside it: a naive prefix accepts
    // it.
    const resolved = resolveAsset("/../public-private/secret.txt", PUBLIC);
    if (resolved !== null) expect(resolved.startsWith(`${PUBLIC}/`)).toBe(true);
  });
});

describe("cacheControl", () => {
  test("keeps the HTML fresh", () => {
    expect(cacheControl("/")).toBe("public, max-age=0, must-revalidate");
  });

  test("freezes media and fonts", () => {
    expect(cacheControl("/logo.svg")).toBe("public, max-age=31536000, immutable");
  });

  test("makes the stylesheet revalidate, as it keeps its name", () => {
    // `sitesolide deploy` does not fingerprint: this site's files arrive on the
    // VM under the name they have here and change content without changing
    // name. A cache of any duration at all would serve the old page.
    expect(cacheControl("/styles.css")).toBe("no-cache");
  });
});

describe("isolation of the tests", () => {
  /** setup.ts has already diverged from config.ts on another tool of the repo. */
  const preparer = readFileSync(join(import.meta.dir, "setup.ts"), "utf8");

  test("the tests never run on the real database", () => {
    expect(process.env.DATA_DIR ?? "").toEndWith(".test-data");
  });

  test("the time zone is set, and does not come from the machine", () => {
    // It cuts the days up, and so the visits and the salts: left to the
    // machine's, a test would pass here and fail elsewhere.
    expect(preparer).toContain("TIME_ZONE");
    expect(process.env.TIME_ZONE).toBe("Europe/Paris");
  });

  test("this service has no secret to divert", () => {
    // Nothing authenticates ingestion, and the dashboard is guarded by the
    // portal: no key enters src/config.ts. The day one did, this test would
    // fail, and setup.ts would have to learn to erase it, as the setup of a
    // service holding a key does for its own.
    const config = readFileSync(join(import.meta.dir, "..", "src", "config.ts"), "utf8");
    const lues = [...config.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]!);
    expect(lues.filter((name) => /KEY|JETON|SECRET|PASSWORD/.test(name))).toEqual([]);
  });
});
