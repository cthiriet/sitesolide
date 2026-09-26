import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicPath, servePublic } from "../src/public";

/**
 * The fallback in `bun run dev`, which serves public/ for want of Caddy. It has
 * to serve the page the way file_server does, a directory through its index
 * included, and serve nothing else: not in production, not outside public/,
 * however the traversal is spelled.
 */

const FOLDER = mkdtempSync(join(tmpdir(), "sample-public-"));
const ROOT = join(FOLDER, "public");
mkdirSync(join(ROOT, "sites"), { recursive: true });
mkdirSync(join(ROOT, "_assets"), { recursive: true });
writeFileSync(join(ROOT, "index.html"), "overview");
writeFileSync(join(ROOT, "sites", "index.html"), "sites");
writeFileSync(join(ROOT, "_assets", "page.js"), "script");
writeFileSync(join(ROOT, "a b.txt"), "space");
// A neighbour of public/, as server.ts and data/ really are.
writeFileSync(join(FOLDER, "secret.txt"), "must never get out");

afterAll(() => rmSync(FOLDER, { recursive: true, force: true }));

const serve = (path: string, production = false) =>
  servePublic(new Request(`http://localhost:3022${path}`), { root: ROOT, production });

async function body(path: string): Promise<{ status: number; text: string; location: string | null }> {
  const response = await serve(path);
  return { status: response.status, text: await response.text(), location: response.headers.get("Location") };
}

describe("what the fallback serves", () => {
  test("the root and a file", async () => {
    expect(await body("/")).toMatchObject({ status: 200, text: "overview" });
    expect(await body("/index.html")).toMatchObject({ status: 200, text: "overview" });
    expect(await body("/_assets/page.js")).toMatchObject({ status: 200, text: "script" });
  });

  test("a directory is served through its index, query included", async () => {
    expect(await body("/sites/")).toMatchObject({ status: 200, text: "sites" });
    expect(await body("/sites/?site=cms")).toMatchObject({ status: 200, text: "sites" });
  });

  /** Like file_server: `/sites` redirects to `/sites/`, keeping `?site=`. */
  test("a directory without its trailing slash redirects, and keeps the query", async () => {
    expect(await body("/sites")).toMatchObject({ status: 308, location: "/sites/" });
    expect(await body("/sites?site=cms")).toMatchObject({ status: 308, location: "/sites/?site=cms" });
  });

  test("a redirect never leaves for another host", async () => {
    const response = await serve("//sites");
    expect(response.status).toBe(308);
    expect(response.headers.get("Location")).toBe("/sites/");
  });

  test("an encoded name is decoded, as with Caddy", async () => {
    expect(await body("/a%20b.txt")).toMatchObject({ status: 200, text: "space" });
  });

  test("what does not exist yields 404", async () => {
    expect((await body("/unknown")).status).toBe(404);
    expect((await body("/unknown/")).status).toBe(404);
    expect((await body("/_assets/")).status).toBe(404);
  });
});

describe("what the fallback refuses", () => {
  test("nothing in production, not even a file that exists", async () => {
    for (const path of ["/", "/index.html", "/sites/", "/sites", "/_assets/page.js"]) {
      const response = await serve(path, true);
      expect([path, response.status]).toEqual([path, 404]);
    }
  });

  /**
   * `new URL` already resolves `..` and `%2e%2e`; `%2f` and `%5c` get past the
   * parsing without forming a segment, and only become a traversal again once
   * decoded.
   */
  test("no traversal out of public/, however it is spelled", async () => {
    const traversals = [
      "/../secret.txt",
      "/%2e%2e/secret.txt",
      "/..%2fsecret.txt",
      "/..%2Fsecret.txt",
      "/%2e%2e%2fsecret.txt",
      "/sites/..%2f..%2fsecret.txt",
      "/sites/%2e%2e%2f%2e%2e%2fsecret.txt",
      "/..%5csecret.txt",
      "/%2fsecret.txt/..%2f..%2fsecret.txt",
    ];
    for (const path of traversals) {
      const { status, text } = await body(path);
      expect([path, status]).toEqual([path, 404]);
      expect(text).not.toContain("never");
    }
  });

  test("an invalid encoding or a null byte name nothing", async () => {
    expect((await body("/%E0%A4%A")).status).toBe(404);
    expect((await body("/index.html%00.js")).status).toBe(404);
  });
});

describe("the path guard", () => {
  test("a path under the root resolves under it", () => {
    expect(publicPath(ROOT, "/")).toBe(ROOT);
    expect(publicPath(ROOT, "/sites/")).toBe(join(ROOT, "sites"));
    expect(publicPath(ROOT, "sites/index.html")).toBe(join(ROOT, "sites", "index.html"));
    expect(publicPath(ROOT, "/sites/../index.html")).toBe(join(ROOT, "index.html"));
  });

  test("a raw traversal, without going through a URL, is refused", () => {
    expect(publicPath(ROOT, "/../secret.txt")).toBeNull();
    expect(publicPath(ROOT, "../secret.txt")).toBeNull();
    expect(publicPath(ROOT, "/sites/../../secret.txt")).toBeNull();
    expect(publicPath(ROOT, "/..%2f..%2fetc/passwd")).toBeNull();
  });

  /** A neighbouring directory whose name starts like the root is not under it. */
  test("public-neighbour is not under public", () => {
    expect(publicPath(ROOT, "/../public-neighbour/x")).toBeNull();
  });
});
