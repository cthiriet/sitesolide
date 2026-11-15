import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest } from "../cli/manifest";
import { needsPort, setPort } from "../cli/ports";
import { PLATFORM_PORTS } from "../cli/services";

/**
 * Which manifests get a port, and how the one the dashboard chose is written
 * back into sitesolide.json. The choice itself is the control API's, tried in
 * dashboard/tests/control-policy.test.ts.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..");

const app = (slug: string, port: number) => ({ slug, start: "/usr/local/bin/bun run server.ts", port });

describe("which manifests get a port", () => {
  test("an app with a single start and no port", () => {
    expect(needsPort({ slug: "shop", start: "/usr/local/bin/bun run server.ts" })).toBe(true);
  });

  test("not a static site, not an app that has one, not a project of several services", () => {
    expect(needsPort({ slug: "blog", publicDir: "public" })).toBe(false);
    expect(needsPort(app("shop", 3040))).toBe(false);
    // Its services call each other on ports their env names: a port picked
    // here would not be the one written there.
    expect(needsPort({ slug: "lab", services: { web: { start: "x", port: undefined as unknown as number } } })).toBe(false);
  });
});

describe("the port written back", () => {
  test("right after start, the rest as it was, key order included", () => {
    const raw = '{\n  "slug": "shop",\n  "publicDir": "public",\n  "start": "/usr/local/bin/bun run server.ts",\n  "exclude": ["node_modules"]\n}\n';
    const written = setPort(raw, 3042);
    expect(Object.keys(JSON.parse(written))).toEqual(["slug", "publicDir", "start", "port", "exclude"]);
    expect(written).toEndWith("}\n");
    const { manifest, errors } = readManifest(written);
    expect(errors).toEqual([]);
    expect(manifest?.port).toBe(3042);
  });

  test("replaces a port already there rather than writing it twice", () => {
    const written = setPort(JSON.stringify(app("shop", 3040)), 3041);
    expect(JSON.parse(written).port).toBe(3041);
    expect(written.match(/"port"/g)).toHaveLength(1);
  });
});

test("the platform's ports are the ones its manifests declare", () => {
  // A drift here would give a project the dashboard's port, and refuse the
  // dashboard's next deployment.
  const manifests = ["dashboard", "portal"].map((name) => {
    const { manifest } = readManifest(readFileSync(join(REPO_ROOT, name, "sitesolide.json"), "utf8"));
    if (manifest === undefined || manifest.port === undefined) throw new Error(`${name}/sitesolide.json declares no port`);
    return { slug: manifest.slug, port: manifest.port };
  });
  expect(manifests.map((manifest) => manifest.port).sort()).toEqual([...PLATFORM_PORTS.keys()].sort());
  // Each port belongs to the slug that deploys there: the dashboard knows the
  // platform's own projects by that pair, and keeps them off its Sites page.
  for (const { slug, port } of manifests) expect(PLATFORM_PORTS.get(port)).toBe(slug);
});
