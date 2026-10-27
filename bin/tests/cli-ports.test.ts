import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIRST_BLOCK, readManifest, SERVICE_PORT_RANGES, validate } from "../cli/manifest";
import { choosePort, needsPort, setPort } from "../cli/ports";
import { PLATFORM_PORTS, RESERVED_PORTS } from "../cli/services";

/**
 * The port `deploy` gives an app whose manifest declares none, decided from
 * the manifests the machine carries, by folder, as readDepositedManifests
 * hands them over.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..");

function machine(manifests: Record<string, object | string>): Map<string, string> {
  return new Map(Object.entries(manifests).map(([slug, value]) => [slug, typeof value === "string" ? value : JSON.stringify(value)]));
}

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

describe("the port chosen", () => {
  test("on an empty machine, the lowest of the range the reserved ports leave", () => {
    const choice = choosePort("shop", machine({}));
    expect(choice).toEqual({ kind: "free", port: 3002 });
    if (choice.kind !== "full") expect(RESERVED_PORTS.has(choice.port)).toBe(false);
  });

  test("never a port another project declares, a service of a project included", () => {
    const choice = choosePort(
      "shop",
      machine({
        blog: app("blog", 3002),
        lab: { slug: "lab", services: { web: { start: "x", port: 3003 }, api: { start: "y", port: 3004, routes: ["/v1/*"] } } },
      }),
    );
    expect(choice).toEqual({ kind: "free", port: 3005 });
  });

  test("never the port of a platform service, deployed or not yet", () => {
    /** A machine whose projects hold every port from 3002 up to `last`. */
    const upTo = (last: number): Map<string, string> => {
      const taken: Record<string, object> = {};
      for (let port = 3002; port <= last; port++) if (!PLATFORM_PORTS.has(port)) taken[`p${port}`] = app(`p${port}`, port);
      return machine(taken);
    };
    // The dashboard's 3022, the portal's, analytics' 3029: skipped, none of
    // them deployed on these machines.
    expect(choosePort("shop", upTo(3021))).toEqual({ kind: "free", port: 3023 });
    expect(choosePort("shop", upTo(3025))).toEqual({ kind: "free", port: 3027 });
    expect(choosePort("shop", upTo(3028))).toEqual({ kind: "free", port: 3030 });
  });

  test("a project the machine already carries keeps its port: its unit listens there", () => {
    // A fresh clone of a repository whose chosen port was never committed.
    expect(choosePort("shop", machine({ shop: app("shop", 3057), blog: app("blog", 3002) }))).toEqual({ kind: "kept", port: 3057 });
  });

  test("not a port outside the blocks, which every other project reaches: it moves to a free one", () => {
    expect(validate(app("legacy", 8080) as never)).toContainEqual(expect.stringContaining("port: inside 3000 to 3099 or 21000 to 29999"));
    expect(choosePort("legacy", machine({ legacy: app("legacy", 8080) }))).toEqual({ kind: "free", port: 3002 });
    // Between the blocks too: nothing closes 3100 to 20999.
    expect(choosePort("legacy", machine({ legacy: app("legacy", 3100) }))).toEqual({ kind: "free", port: 3002 });
  });

  test("a project the machine gives a port of the second block keeps it", () => {
    expect(choosePort("shop", machine({ shop: app("shop", 21007), blog: app("blog", 3002) }))).toEqual({ kind: "kept", port: 21007 });
  });

  test("a project that used to run several services is given a port of its own", () => {
    const lab = { slug: "lab", services: { web: { start: "x", port: 3002 } } };
    expect(choosePort("lab", machine({ lab }))).toEqual({ kind: "free", port: 3002 });
  });

  test("a deposited manifest that no longer reads still holds the ports it can be read for", () => {
    const stale = { ...app("old", 3002), retired: true };
    expect(validate(stale as never)).not.toEqual([]);
    expect(choosePort("shop", machine({ old: stale }))).toEqual({ kind: "free", port: 3003 });
    expect(choosePort("shop", machine({ broken: "{ not json" }))).toEqual({ kind: "free", port: 3002 });
  });

  test("the first block first, while one of its ports is free, even with the second block's taken", () => {
    const taken: Record<string, object> = { early: app("early", 21000) };
    for (let port = FIRST_BLOCK.first; port < FIRST_BLOCK.last; port++) taken[`p${port}`] = app(`p${port}`, port);
    expect(choosePort("shop", machine(taken))).toEqual({ kind: "free", port: FIRST_BLOCK.last });
  });

  test("a full first block moves on to the lowest free port of the second", () => {
    const taken: Record<string, object> = {};
    for (let port = FIRST_BLOCK.first; port <= FIRST_BLOCK.last; port++) taken[`p${port}`] = app(`p${port}`, port);
    expect(choosePort("shop", machine(taken))).toEqual({ kind: "free", port: 21000 });
    taken.early = app("early", 21000);
    expect(choosePort("shop", machine(taken))).toEqual({ kind: "free", port: 21001 });
  });

  test("every block full says so, rather than leaving them", () => {
    const taken: Record<string, object> = {};
    for (const range of SERVICE_PORT_RANGES) {
      for (let port = range.first; port <= range.last; port++) taken[`p${port}`] = app(`p${port}`, port);
    }
    expect(choosePort("shop", machine(taken))).toEqual({ kind: "full" });
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
  const manifests = ["dashboard", "portal", "analytics"].map((name) => {
    const { manifest } = readManifest(readFileSync(join(REPO_ROOT, name, "sitesolide.json"), "utf8"));
    if (manifest === undefined || manifest.port === undefined) throw new Error(`${name}/sitesolide.json declares no port`);
    return { slug: manifest.slug, port: manifest.port };
  });
  expect(manifests.map((manifest) => manifest.port).sort()).toEqual([...PLATFORM_PORTS.keys()].sort());
  // Each port belongs to the slug that deploys there: the dashboard knows the
  // platform's own projects by that pair, and keeps them off its Sites page.
  for (const { slug, port } of manifests) expect(PLATFORM_PORTS.get(port)).toBe(slug);
});
