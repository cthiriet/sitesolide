import { describe, expect, test } from "bun:test";
import type { Manifest } from "../borrowed/manifest";
import { allocatePorts, decideDoor, decideSlug, leavesPorts, memoryBytes, reservedReason, scopeRefusals, takenPorts } from "../src/control/policy";
import type { Identity, Scope } from "../src/control/protocol";

const ZONE = "test-zone.invalid";
const NONE: Scope = { slugs: [], create: false, outbound: false, domain: false, public: false };

function identity(scope: Partial<Scope> = {}, owned: string[] = []): Identity {
  return { id: "aaaaaaaaaaaa", label: "Ada", email: "ada@test-zone.invalid", expiresAt: null, scope: { ...NONE, ...scope }, owned };
}

const app = (extra: Partial<Manifest> = {}): Manifest => ({ slug: "shop", start: "/usr/local/bin/bun run server.ts", port: 3040, ...extra });
const site = (extra: Partial<Manifest> = {}): Manifest => ({ slug: "shop", publicDir: "public", ...extra });

describe("reserved slugs", () => {
  test("the platform's projects and the landing's directory, whatever the scope", () => {
    for (const slug of ["dashboard", "portal", "api", "analytics", "landing", "www"]) {
      expect(reservedReason(slug, ZONE)).toContain("reserved");
      const everything = identity({ slugs: [slug], create: true, public: true });
      expect(decideSlug(everything, slug, { exists: true, owner: null, zone: ZONE })).toMatchObject({ kind: "refused", error: "reserved" });
    }
    // The landing's directory carries the zone's name: reserved, and not even a slug.
    expect(reservedReason(ZONE, ZONE)).toContain("reserved");
    expect(decideSlug(identity({ create: true }), ZONE, { exists: true, owner: null, zone: ZONE })).toMatchObject({ kind: "refused" });
    expect(reservedReason("shop", ZONE)).toBeNull();
  });
});

describe("decideSlug", () => {
  const machine = (exists: boolean, owner: string | null = null) => ({ exists, owner, zone: ZONE });

  test("an empty scope deploys nothing, not even a new project", () => {
    expect(decideSlug(identity(), "shop", machine(false))).toMatchObject({ kind: "refused", error: "out-of-scope" });
    expect(decideSlug(identity(), "shop", machine(true))).toMatchObject({ kind: "refused", error: "out-of-scope" });
  });

  test("create: a new slug, and that alone", () => {
    expect(decideSlug(identity({ create: true }), "shop", machine(false))).toEqual({ kind: "allowed", creating: true });
    const refusal = decideSlug(identity({ create: true }), "shop", machine(true));
    expect(refusal).toMatchObject({ kind: "refused", error: "out-of-scope" });
    expect(refusal.kind === "refused" && refusal.message).toContain("already exists");
  });

  test("a granted slug, existing or not", () => {
    expect(decideSlug(identity({ slugs: ["shop"] }), "shop", machine(true))).toEqual({ kind: "allowed", creating: false });
    expect(decideSlug(identity({ slugs: ["shop"] }), "shop", machine(false))).toEqual({ kind: "allowed", creating: true });
  });

  test("its own project, even half deployed, and never another token's", () => {
    expect(decideSlug(identity(), "shop", machine(true, "aaaaaaaaaaaa"))).toEqual({ kind: "allowed", creating: false });
    expect(decideSlug(identity(), "shop", machine(false, "aaaaaaaaaaaa"))).toEqual({ kind: "allowed", creating: true });
    const other = decideSlug(identity({ create: true }), "shop", machine(false, "bbbbbbbbbbbb"));
    expect(other).toMatchObject({ kind: "refused", error: "out-of-scope" });
    expect(other.kind === "refused" && other.message).toContain("another token");
    // Unless the owner granted it explicitly.
    expect(decideSlug(identity({ slugs: ["shop"] }), "shop", machine(true, "bbbbbbbbbbbb"))).toEqual({ kind: "allowed", creating: false });
  });

  test("a slug that is not one is invalid before anything else", () => {
    for (const slug of ["", "Shop", "../etc", "a.b", 42, null]) {
      expect(decideSlug(identity({ create: true }), slug, machine(false))).toMatchObject({ kind: "refused", error: "invalid" });
    }
  });
});

describe("scopeRefusals", () => {
  test("nothing to say about a plain private app", () => {
    expect(scopeRefusals(app(), NONE, "shop")).toEqual([]);
  });

  test("outbound, a domain, exempted paths, each behind its own flag", () => {
    expect(scopeRefusals(app({ network: "outbound" }), NONE, "shop")[0]).toContain("network");
    expect(scopeRefusals(app({ network: "outbound" }), { ...NONE, outbound: true }, "shop")).toEqual([]);
    expect(scopeRefusals(app({ domain: { name: "shop.example" } }), NONE, "shop")[0]).toContain("domain");
    expect(scopeRefusals(app({ domain: { name: "shop.example" } }), { ...NONE, domain: true }, "shop")).toEqual([]);
    expect(scopeRefusals(app({ portal: true, portalExempt: ["/hook"] }), NONE, "shop")[0]).toContain("portalExempt");
    expect(scopeRefusals(app({ portal: true, portalExempt: ["/hook"] }), { ...NONE, public: true }, "shop")).toEqual([]);
  });

  test("the secret file named after its slug, and no other: the unit would hand it over as root", () => {
    expect(scopeRefusals(app({ secrets: ["shop.env"] }), NONE, "shop")).toEqual([]);
    for (const name of ["dashboard.env", "portal.env", "shop-mail.env", "shop2.env", "cms.env"]) {
      expect(scopeRefusals(app({ secrets: [name] }), { ...NONE, public: true, outbound: true }, "shop")[0]).toContain("secrets");
    }
  });

  test("the preview lock is the owner's, a slug mix-up is named, memory and services are capped", () => {
    expect(scopeRefusals(app({ lock: true }), NONE, "shop")[0]).toContain("lock");
    expect(scopeRefusals(app(), NONE, "cms")[0]).toContain("slug");
    expect(scopeRefusals(app({ memory: "2G" }), NONE, "shop")[0]).toContain("1G");
    expect(scopeRefusals(app({ memory: "1G" }), NONE, "shop")).toEqual([]);
    const services = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`s${i}`, { start: "x", port: 3040 + i }]));
    expect(scopeRefusals({ slug: "shop", publicDir: "public", services } as Manifest, NONE, "shop")[0]).toContain("services");
    expect(memoryBytes("512M")).toBe(512 * 1024 * 1024);
  });
});

describe("decideDoor", () => {
  test("a new project goes behind the portal by default", () => {
    expect(decideDoor(app(), NONE, null)).toEqual({ portal: true });
  });

  test("a token that may go public follows the manifest", () => {
    const open = { ...NONE, public: true };
    expect(decideDoor(app(), open, null)).toEqual({ portal: false });
    expect(decideDoor(app({ portal: true }), open, null)).toEqual({ portal: true });
  });

  test("the machine's door wins over the manifest, as for sitesolide deploy", () => {
    expect(decideDoor(app(), { ...NONE, public: true }, true)).toEqual({ portal: true });
    expect(decideDoor(app({ portal: true }), { ...NONE, public: true }, false)).toEqual({ portal: false });
  });

  test("a public site on the machine is refused to a private token", () => {
    expect(decideDoor(app(), NONE, false)).toHaveProperty("refusal");
  });

  test("a static site cannot sit behind the portal, so a private token cannot deploy one", () => {
    const refusal = decideDoor(site(), NONE, null);
    expect("refusal" in refusal && refusal.refusal).toContain("static");
    expect(decideDoor(site(), { ...NONE, public: true }, null)).toEqual({ portal: false });
  });
});

describe("ports", () => {
  const deposited = new Map([
    ["cms", JSON.stringify({ slug: "cms", start: "x", port: 3002 })],
    ["lab", JSON.stringify({ slug: "lab", publicDir: "p", services: { web: { start: "x", port: 3003 }, api: { start: "y", port: 3004, routes: ["/api/*"] } } })],
    ["shop", JSON.stringify({ slug: "shop", start: "x", port: 3010 })],
    ["broken", "{"],
  ]);

  test("taken: the landing's, the shared service's, and every other project's", () => {
    expect([...takenPorts(deposited, "shop")].sort()).toEqual([3000, 3001, 3002, 3003, 3004]);
  });

  test("a single service without a port gets the lowest free one", () => {
    const result = allocatePorts({ slug: "new", start: "x" }, takenPorts(deposited, "new"), null);
    expect(result).toEqual({ object: { slug: "new", start: "x", port: 3005 }, allocated: [{ service: null, port: 3005 }] });
  });

  test("a redeployment keeps the port it had, when still free", () => {
    const previous = { slug: "shop", start: "x", port: 3010 } as Manifest;
    const result = allocatePorts({ slug: "shop", start: "x" }, takenPorts(deposited, "shop"), previous);
    expect("allocated" in result && result.allocated).toEqual([{ service: null, port: 3010 }]);
  });

  test("services without ports, each its own, next to the ones named", () => {
    const object = { slug: "new", publicDir: "p", services: { web: { start: "x" }, api: { start: "y", port: 3005, routes: ["/api/*"] }, jobs: { start: "z", internal: true } } };
    const result = allocatePorts(object, takenPorts(deposited, "new"), null);
    expect("allocated" in result && result.allocated).toEqual([
      { service: "web", port: 3006 },
      { service: "jobs", port: 3007 },
    ]);
  });

  test("a manifest that names its ports, or a static site, is returned as it is", () => {
    const named = { slug: "new", start: "x", port: 3050 };
    expect(allocatePorts(named, new Set(), null)).toEqual({ object: named, allocated: [] });
    expect(allocatePorts({ slug: "new", publicDir: "p" }, new Set(), null)).toEqual({ object: { slug: "new", publicDir: "p" }, allocated: [] });
    expect(leavesPorts(named)).toBe(false);
    expect(leavesPorts({ slug: "new", start: "x" })).toBe(true);
  });

  test("a full range is refused, with the range named", () => {
    const full = new Set(Array.from({ length: 100 }, (_, i) => 3000 + i));
    const result = allocatePorts({ slug: "new", start: "x" }, full, null);
    expect("refusal" in result && result.refusal).toContain("3000 and 3099");
  });
});
