import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest, SERVICE_PORTS, validate } from "../cli/manifest";
import { choosePort, needsPort, PLATFORM_PORTS, setPort } from "../cli/ports";
import { RESERVED_PORTS } from "../cli/services";

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

  test("even a port outside the range, chosen by hand before: moving it would leave the unit behind", () => {
    expect(choosePort("legacy", machine({ legacy: app("legacy", 8080) }))).toEqual({ kind: "kept", port: 8080 });
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

  test("a full range says so, rather than leaving it", () => {
    const taken: Record<string, object> = {};
    for (let port = SERVICE_PORTS.first; port <= SERVICE_PORTS.last; port++) taken[`p${port}`] = app(`p${port}`, port);
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
  const declared = ["dashboard", "portal", "analytics"].map((name) => {
    const { manifest } = readManifest(readFileSync(join(REPO_ROOT, name, "sitesolide.json"), "utf8"));
    return manifest?.port;
  });
  expect(declared.sort()).toEqual([...PLATFORM_PORTS.keys()].sort());
});
