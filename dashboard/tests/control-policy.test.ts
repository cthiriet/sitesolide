import { describe, expect, test } from "bun:test";
import type { Manifest } from "../borrowed/manifest";
import { allocatePorts, decideDoor, decideManifest, decideSlug, leftoversReason, memoryBytes, reservedReason, scopeRefusals, takenPorts } from "../src/control/policy";
import type { Identity, Scope } from "../src/control/protocol";

const ZONE = "test-zone.invalid";
const NONE: Scope = { slugs: [], create: false, outbound: false, domain: false, public: false };

function identity(scope: Partial<Scope> = {}, owned: string[] = []): Identity {
  return { id: "aaaaaaaaaaaa", label: "Ada", email: "ada@test-zone.invalid", expiresAt: null, scope: { ...NONE, ...scope }, owned, member: null };
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

  test("a manifest naming one is refused reserved before its door or its scope is judged", () => {
    // `dashboard` is public on the machine: judged on its door first, a
    // private token was told "this site is public on the machine", a 422.
    for (const slug of ["dashboard", "portal", "api", "analytics", "landing", "www", ZONE]) {
      for (const onMachine of [false, true, null]) {
        expect(decideManifest(app({ slug }), NONE, onMachine, ZONE)).toMatchObject({ kind: "refused", error: "reserved" });
        expect(decideManifest(site({ slug, secrets: ["API_KEY"] }), NONE, onMachine, ZONE)).toMatchObject({ kind: "refused", error: "reserved" });
      }
    }
    const refused = decideManifest(app({ slug: "dashboard" }), NONE, false, ZONE);
    expect(refused.kind === "refused" && refused.error === "reserved" && refused.message).toContain("pick another slug");
  });

  test("a name that begins like the platform's is an ordinary slug: a project reads its own store, never a flat file named after it", () => {
    const everything = (slug: string) => identity({ slugs: [slug], create: true, public: true });
    for (const slug of ["dashboard-backup", "dashboard-monitor", "portal-x", "api-gateway", "dashboards", "apiary"]) {
      expect(decideSlug(everything(slug), slug, { exists: false, owner: null, zone: ZONE })).toEqual({ kind: "allowed", creating: true });
      expect(decideSlug(everything(slug), slug, { exists: true, owner: null, zone: ZONE })).toEqual({ kind: "allowed", creating: false });
    }
  });
});

describe("decideManifest", () => {
  test("every refusal of the scope and the door at once, or the door to apply", () => {
    expect(decideManifest(app(), NONE, null, ZONE)).toEqual({ kind: "allowed", portal: true });
    expect(decideManifest(app(), { ...NONE, public: true }, null, ZONE)).toEqual({ kind: "allowed", portal: false });
    const refused = decideManifest(app({ network: "outbound" }), NONE, false, ZONE);
    expect(refused).toMatchObject({ kind: "refused", error: "invalid-manifest" });
    const details = refused.kind === "refused" && refused.error === "invalid-manifest" ? refused.details : [];
    expect(details).toHaveLength(2);
    expect(details[0]).toContain("network");
    expect(details[1]).toContain("public on the machine");
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

describe("leftoversReason", () => {
  test("nothing left: no reason; each kind counted, with its own remedy and the owner's SSH deploy", () => {
    expect(leftoversReason("shop", { snapshots: 0, grants: 0, store: false })).toBeNull();
    expect(leftoversReason("shop", { snapshots: 3, grants: 0, store: false })).toBe(
      "the machine still keeps 3 backup snapshots of a project once named shop, which a project created under that name would be handed: no token creates it. " +
        "Pick another slug, or ask the owner of the machine, who may deploy shop themselves over SSH, or forget the snapshots first",
    );
    expect(leftoversReason("shop", { snapshots: 0, grants: 2, store: false })).toBe(
      "the machine still keeps 2 connector grants of a project once named shop, which a project created under that name would be handed: no token creates it. " +
        "Pick another slug, or ask the owner of the machine, who may deploy shop themselves over SSH, or withdraw the grants on the dashboard's Connectors page first",
    );
  });

  test("a store of secrets left under the name: its values would reach whatever code a token deploys there", () => {
    expect(leftoversReason("shop", { snapshots: 0, grants: 0, store: true })).toBe(
      "the machine still keeps a secrets store of a project once named shop, which a project created under that name would be handed: no token creates it. " +
        "Pick another slug, or ask the owner of the machine, who may deploy shop themselves over SSH, or remove the store with sitesolide remove --confirm shop first",
    );
    expect(leftoversReason("shop", { snapshots: 1, grants: 1, store: true })).toBe(
      "the machine still keeps 1 backup snapshot, 1 connector grant and a secrets store of a project once named shop, which a project created under that name would be handed: no token creates it. " +
        "Pick another slug, or ask the owner of the machine, who may deploy shop themselves over SSH, or withdraw the grant on the dashboard's Connectors page, remove the store with sitesolide remove --confirm shop and forget the snapshot first",
    );
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

  test("egress reaches outside hosts, and needs outbound like network does; connectors need the owner's grant alone", () => {
    // A token denied outbound used to list any host and reach it through the
    // egress proxy.
    const egress = app({ egress: ["attacker.example.com"] });
    expect(scopeRefusals(egress, NONE, "shop")).toEqual([expect.stringContaining("egress")]);
    expect(scopeRefusals(egress, { ...NONE, public: true, domain: true, create: true }, "shop")[0]).toContain("outbound");
    expect(scopeRefusals(egress, { ...NONE, outbound: true }, "shop")).toEqual([]);
    expect(scopeRefusals(app({ connectors: ["slack"] }), NONE, "shop")).toEqual([]);
  });

  test("a manifest's secrets are its store's names: the scope has nothing to judge in them", () => {
    for (const secrets of [["API_KEY", "SESSION_KEY"], { runtime: ["API_KEY"], files: ["tls.key"], build: ["NPM_TOKEN"] }]) {
      expect(scopeRefusals(app({ secrets }), NONE, "shop")).toEqual([]);
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

  test("a member's token deploys an existing project behind the door it has, and opens none", () => {
    // In the open on the machine: its Project admin or the owner chose so, the deployment changes nothing of it.
    expect(decideDoor(app(), NONE, false, true)).toEqual({ portal: false });
    expect(decideDoor(site(), NONE, false, true)).toEqual({ portal: false });
    expect(decideDoor(app(), NONE, true, true)).toEqual({ portal: true });
    // A new project still goes behind the portal without the public permission.
    expect(decideDoor(app(), NONE, null, true)).toEqual({ portal: true });
    expect(decideDoor(site(), NONE, null, true)).toHaveProperty("refusal");
    // Exempting paths opens them: still the public permission's.
    expect(decideManifest(app({ portal: true, portalExempt: ["/hook"] }), NONE, true, ZONE, true)).toMatchObject({ kind: "refused" });
    expect(decideManifest(app(), NONE, false, ZONE, true)).toEqual({ kind: "allowed", portal: false });
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

  test("taken: the landing's, the shared service's, the platform's, and every other project's", () => {
    // The dashboard's, the portal's and analytics' ports, deployed or not: a
    // token's project there would refuse their first deployment, and the
    // loopback rule lets the dashboard reach the portal's.
    expect([...takenPorts(deposited, "shop")].sort()).toEqual([3000, 3001, 3002, 3003, 3004, 3022, 3026, 3029]);
    expect(takenPorts(new Map(), "portal").has(3026)).toBe(false);
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

  test("public services without ports, each its own, next to the ones named", () => {
    const object = { slug: "new", publicDir: "p", services: { web: { start: "x" }, api: { start: "y", port: 3005, routes: ["/api/*"] }, admin: { start: "w", routes: ["/admin/*"] } } };
    const result = allocatePorts(object, takenPorts(deposited, "new"), null);
    expect("allocated" in result && result.allocated).toEqual([
      { service: "web", port: 3006 },
      { service: "admin", port: 3007 },
    ]);
  });

  test("a worker and a scheduled service listen on nothing: never a port, the manifest's entries as written", () => {
    const jobs = { start: "z", internal: true };
    const sync = { start: "s", schedule: "hourly" };
    const object = { slug: "new", publicDir: "p", services: { web: { start: "x" }, jobs, sync } };
    const result = allocatePorts(object, takenPorts(deposited, "new"), null);
    expect(result).toEqual({ object: { ...object, services: { web: { start: "x", port: 3005 }, jobs, sync } }, allocated: [{ service: "web", port: 3005 }] });
    // An internal service the machine already gave a port to, from an
    // installer that gave one to any service that named none, keeps it: its
    // program listens on the PORT it was told, and losing it would cut it from
    // its siblings. A scheduled service never gets one back.
    const previous = { slug: "new", publicDir: "p", services: { web: { start: "x", port: 3020 }, jobs: { ...jobs, port: 3021 }, sync: { start: "s", port: 3022 } } } as Manifest;
    expect(allocatePorts(object, takenPorts(deposited, "new"), previous)).toMatchObject({
      allocated: [
        { service: "web", port: 3020 },
        { service: "jobs", port: 3021 },
      ],
    });
    // Nothing to choose at all: returned as it is.
    const background = { slug: "new", services: { jobs, sync } };
    expect(allocatePorts(background, new Set(), null)).toEqual({ object: background, allocated: [] });
  });

  test("a manifest that names its ports, or a static site, is returned as it is", () => {
    const named = { slug: "new", start: "x", port: 3050 };
    expect(allocatePorts(named, new Set(), null)).toEqual({ object: named, allocated: [] });
    expect(allocatePorts({ slug: "new", publicDir: "p" }, new Set(), null)).toEqual({ object: { slug: "new", publicDir: "p" }, allocated: [] });
  });

  test("a full first block moves on to the second, the lowest port first", () => {
    const first = new Set(Array.from({ length: 100 }, (_, i) => 3000 + i));
    expect(allocatePorts({ slug: "new", start: "x" }, first, null)).toEqual({ object: { slug: "new", start: "x", port: 21000 }, allocated: [{ service: null, port: 21000 }] });
    // A port of the first block freed is taken again before the second's.
    first.delete(3042);
    expect(allocatePorts({ slug: "new", start: "x" }, first, null)).toMatchObject({ allocated: [{ service: null, port: 3042 }] });
    // A port the machine already gave it in the second block is kept.
    const previous = { slug: "new", start: "x", port: 21007 } as Manifest;
    expect(allocatePorts({ slug: "new", start: "x" }, new Set(), previous)).toMatchObject({ allocated: [{ service: null, port: 21007 }] });
  });

  test("every block full is refused, with the blocks named", () => {
    const full = new Set([...Array.from({ length: 100 }, (_, i) => 3000 + i), ...Array.from({ length: 9000 }, (_, i) => 21000 + i)]);
    const result = allocatePorts({ slug: "new", start: "x" }, full, null);
    expect("refusal" in result && result.refusal).toContain("3000 to 3099 or 21000 to 29999");
  });
});
