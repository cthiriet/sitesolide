import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateFragment } from "../borrowed/fragment";
import { isProtected, readManifest, type Manifest } from "../borrowed/manifest";
import { fragmentIsProtected, fragmentPassesIdentity } from "../borrowed/portal";
import { buildFragment, installedCode } from "../borrowed/locks";
import { portalState, planGeneral, type Deployed, type Generator, type Plan } from "../src/gatekeeper/plan";

/**
 * The plan decides everything the gatekeeper will do, before touching anything.
 * The refusals are the tests that count: a block retouched by hand and
 * rewritten in silence, or a manifest that asks for the door with no block to
 * carry it, would leave a site in a state its owner knows nothing about.
 */
const DEPOT = join(import.meta.dir, "..", "..");
const SITES = process.env.SITESOLIDE_SITES_REPO ?? join(DEPOT, "..", "sitesolide-sites");

/** The manifest from the sites repository, or a built equivalent if it is missing. */
function rawOf(slug: string, fallback: Manifest): string {
  const path = join(SITES, slug, "sitesolide.json");
  return existsSync(path) ? readFileSync(path, "utf8") : `${JSON.stringify(fallback, null, 2)}\n`;
}

const CMS = rawOf("cms", {
  slug: "cms",
  port: 3048,
  publicDir: "public",
  start: "/usr/local/bin/bun run server.ts",
  routes: ["/", "/pages/*", "/hooks/*"],
  portal: true,
  portalExempt: ["/hooks/*"],
});
const LIBRARY = rawOf("library", {
  slug: "library",
  port: 3044,
  publicDir: "public",
  start: "/usr/local/bin/bun run server.ts",
  routes: ["/api/*"],
});
const KANBAN = rawOf("kanban", {
  slug: "kanban",
  port: 3045,
  publicDir: "public",
  start: "/usr/local/bin/bun run server.ts",
  routes: ["/api/*", "/"],
  portal: true,
});
const VINEYARD = rawOf("vineyard", { slug: "vineyard", publicDir: "public" });

function parsed(raw: string): Manifest {
  const { manifest } = readManifest(raw);
  return manifest!;
}

/** The block in service as `sitesolide deploy` laid it down. */
function blockOf(raw: string): string | null {
  return generateFragment(parsed(raw));
}

const ZONE = "test-zone.invalid";

/**
 * Restricting or making public as the gatekeeper did before the code: no
 * code, no stanza, nobody else locked.
 */
function planPortal(slug: string, active: boolean, deployed: Pick<Deployed, "manifest" | "block">, generate?: Generator): Plan {
  return planGeneral(slug, active ? "on" : "off", { ...deployed, codes: null, fragment: null, sites: [] }, { zone: ZONE, ...(generate === undefined ? {} : { generate }) });
}

function change(plan: Plan): Extract<Plan, { kind: "change" }> {
  if (plan.kind !== "change") throw new Error(`plan ${plan.kind}: ${"message" in plan ? plan.message : ""}`);
  return plan;
}

describe("planPortal, on a block deployed before the identity headers", () => {
  const earlier = (raw: string) => generateFragment(parsed(raw), "cookie");

  test("removing the portal from cms: accepted, the earlier block being the generator's own", () => {
    const plan = change(planPortal("cms", false, { manifest: CMS, block: earlier(CMS) }));
    expect(fragmentIsProtected((plan.block as { text: string }).text)).toBe(false);
  });

  test("an earlier block edited by hand is still refused", () => {
    const edited = `${earlier(CMS)}\n\theader X-Extra yes`;
    expect(planPortal("cms", false, { manifest: CMS, block: edited }).kind).toBe("rejects");
  });

  test("setting the portal writes the current block, which hands the site who is in", () => {
    const plan = change(planPortal("library", true, { manifest: LIBRARY, block: blockOf(LIBRARY) }));
    expect(fragmentPassesIdentity((plan.block as { text: string }).text)).toBe(true);
  });

  test("setting the portal on an open site whose block predates the strip: accepted, not a hand edit", () => {
    // Every open block on the machine today was written before open blocks
    // took the visitor's identity headers off.
    const plan = change(planPortal("library", true, { manifest: LIBRARY, block: earlier(LIBRARY) }));
    expect(fragmentPassesIdentity((plan.block as { text: string }).text)).toBe(true);
  });

  test("removing the portal writes a block that still takes the visitor's identity headers off", () => {
    // Public now, the site must not hand its app the X-Sitesolide-Role: admin
    // a stranger sends: the strip moves out of the route, to the block itself.
    for (const block of [blockOf(CMS), earlier(CMS)]) {
      const text = (change(planPortal("cms", false, { manifest: CMS, block })).block as { text: string }).text;
      const preview = text.slice(text.indexOf("cms.{$SITESOLIDE_ZONE} {"));
      expect(preview).not.toInclude("route {");
      expect(preview).toInclude("\n\trequest_header -X-Sitesolide*\n\trequest_header -X_sitesolide*\n");
    }
  });
});

describe("planPortal, on the manifests from the sites repository", () => {
  test("removing the portal from cms: manifest with no portal, exemptions kept, block with no guard", () => {
    const plan = change(planPortal("cms", false, { manifest: CMS, block: blockOf(CMS) }));
    const newPassword = parsed(plan.manifest!);
    expect(isProtected(newPassword)).toBe(false);
    expect(newPassword.portalExempt).toEqual(parsed(CMS).portalExempt);
    expect(plan.block.kind).toBe("write");
    const text = (plan.block as { text: string }).text;
    expect(fragmentIsProtected(text)).toBe(false);
    // Exactly what the next `sitesolide deploy` would write.
    expect(text).toBe(generateFragment(newPassword)!);
  });

  test("setting the portal on library: block with the guard", () => {
    const plan = change(planPortal("library", true, { manifest: LIBRARY, block: blockOf(LIBRARY) }));
    expect(parsed(plan.manifest!).portal).toBe(true);
    const text = (plan.block as { text: string }).text;
    expect(fragmentIsProtected(text)).toBe(true);
    expect(text).toBe(generateFragment(parsed(plan.manifest!))!);
  });

  test("removing then putting back yields the original manifest and block", () => {
    const retire = change(planPortal("kanban", false, { manifest: KANBAN, block: blockOf(KANBAN) }));
    const block = (retire.block as { text: string }).text;
    const repose = change(planPortal("kanban", true, { manifest: retire.manifest!, block }));
    expect(repose.manifest).toBe(KANBAN.endsWith("\n") ? KANBAN : `${KANBAN}\n`);
    expect((repose.block as { text: string }).text).toBe(blockOf(KANBAN)!);
  });

  test("cms removed then put back finds its exemption again", () => {
    const retire = change(planPortal("cms", false, { manifest: CMS, block: blockOf(CMS) }));
    const repose = change(
      planPortal("cms", true, { manifest: retire.manifest!, block: (retire.block as { text: string }).text }),
    );
    expect((repose.block as { text: string }).text).toContain("@portal_guard not path /_portal/* /hooks/*");
  });

  test("the wanted state already in place: nothing to do", () => {
    expect(planPortal("cms", true, { manifest: CMS, block: blockOf(CMS) }).kind).toBe("nothing");
    expect(planPortal("library", false, { manifest: LIBRARY, block: blockOf(LIBRARY) }).kind).toBe("nothing");
    // Removing a door that is incomplete from a static site is not an error.
    expect(planPortal("vineyard", false, { manifest: VINEYARD, block: null }).kind).toBe("nothing");
  });

  test("a static site does not go behind the portal as long as validate() refuses it", () => {
    const plan = planPortal("vineyard", true, { manifest: VINEYARD, block: null });
    expect(plan).toEqual({ kind: "rejects", message: "a static site cannot be restricted yet" });
  });
});

describe("planPortal refuses a block that is not the manifest's own", () => {
  test("a directive added by hand", () => {
    const retouched = blockOf(LIBRARY)!.replace("\timport tls-zone", "\timport tls-zone\n\trespond /secret 403");
    const plan = planPortal("library", true, { manifest: LIBRARY, block: retouched });
    expect(plan.kind).toBe("rejects");
    expect((plan as { message: string }).message).toContain("differs from what sitesolide.json generates");
  });

  test("a directive removed by hand", () => {
    const retouched = blockOf(CMS)!.replace("\t\tlb_try_duration 5s\n", "");
    expect(planPortal("cms", false, { manifest: CMS, block: retouched }).kind).toBe("rejects");
  });

  test("a changed comment is not a retouch", () => {
    const commented = blockOf(LIBRARY)!.replace("# Caddy block for project", "# Comment rewritten, block for project");
    expect(planPortal("library", true, { manifest: LIBRARY, block: commented }).kind).toBe("change");
  });

  test("an app site's block is missing", () => {
    const plan = planPortal("library", true, { manifest: LIBRARY, block: null });
    expect(plan).toEqual({ kind: "rejects", message: expect.stringContaining("is missing") });
  });

  test("a block laid by hand for a static site", () => {
    const plan = planPortal("vineyard", true, { manifest: VINEYARD, block: "vineyard.test-zone.invalid {\n\trespond 200\n}\n" });
    expect(plan).toEqual({ kind: "rejects", message: expect.stringContaining("generates no block") });
  });
});

describe("planPortal refuses what the rules refuse", () => {
  test("the dashboard, the portal, the landing with no manifest", () => {
    const dashboard = readFileSync(join(DEPOT, "dashboard", "sitesolide.json"), "utf8");
    const portal = readFileSync(join(DEPOT, "portal", "sitesolide.json"), "utf8");
    expect(planPortal("dashboard", true, { manifest: dashboard, block: blockOf(dashboard) }).kind).toBe("rejects");
    expect(planPortal("portal", true, { manifest: portal, block: blockOf(portal) }).kind).toBe("rejects");
    expect(planPortal("test-zone.invalid", true, { manifest: null, block: null }).kind).toBe("rejects");
  });

  test("an unreadable manifest", () => {
    expect(planPortal("library", true, { manifest: "{ not json", block: blockOf(LIBRARY) }).kind).toBe("rejects");
    expect(planPortal("library", true, { manifest: "[]", block: blockOf(LIBRARY) }).kind).toBe("rejects");
  });

  test("a site on its own domain: the guard goes on the domain's block too", () => {
    // With no headers: an X-Robots-Tag would count for the customer's domain too, which validate() refuses.
    const domain = `${JSON.stringify({ ...parsed(LIBRARY), headers: undefined, domain: { name: "example.test", active: true } }, null, 2)}\n`;
    const plan = change(planPortal("library", true, { manifest: domain, block: blockOf(domain) }));
    expect(plan.portalChanged).toBe(true);
    const block = (plan.block as { text: string }).text;
    expect(block.split("forward_auth @portal_guard").length - 1).toBe(2);
    expect(block).toInclude('header_up X-Portal-Hote "{host} library.{$SITESOLIDE_ZONE}"');
  });
});

describe("planPortal and a generator yet to come", () => {
  test("a site that loses its door and no longer needs a block: the block is removed", () => {
    // The day a static site can go behind the portal, its block will exist
    // only for the door. Simulated by a generator that yields a block only to
    // a protected site.
    const protectedOnly = (m: Manifest) => (isProtected(m) ? generateFragment(m) : null);
    const plan = change(planPortal("cms", false, { manifest: CMS, block: blockOf(CMS) }, protectedOnly));
    expect(plan.block).toEqual({ kind: "remove" });
  });

  test("a generator that forgot the guard: refusal, never a site open but announced closed", () => {
    const withoutGuard = (m: Manifest) => generateFragment({ ...m, portal: undefined, portalExempt: undefined });
    const plan = planPortal("library", true, { manifest: LIBRARY, block: blockOf(LIBRARY) }, withoutGuard);
    expect(plan).toEqual({ kind: "rejects", message: expect.stringContaining("would not carry the portal guard") });
  });
});

describe("portalState", () => {
  test("asked for and installed, read as the dashboard reads them", () => {
    expect(portalState({ manifest: CMS, block: blockOf(CMS) })).toEqual({ requested: true, installed: true });
    expect(portalState({ manifest: LIBRARY, block: blockOf(LIBRARY) })).toEqual({ requested: false, installed: false });
    expect(portalState({ manifest: CMS, block: blockOf(LIBRARY) })).toEqual({ requested: true, installed: false });
    expect(portalState({ manifest: null, block: null })).toEqual({ requested: false, installed: false });
    expect(portalState({ manifest: "{", block: null })).toEqual({ requested: false, installed: false });
  });
});

/**
 * Anyone with the code, planned: the manifest's `lock`, the codes file and the
 * fragment the generator writes from every site, all in the same plan as the
 * portal, never one without the other.
 */
describe("planGeneral and the preview locks", () => {
  const LOCKED = `${JSON.stringify({ ...parsed(LIBRARY), lock: true }, null, 2)}\n`;
  const draw = () => "K7M2PQ";
  const locks = (sites: Record<string, string>) =>
    buildFragment(Object.entries(sites).map(([slug, code]) => ({ slug, host: `${slug}.${ZONE}`, lock: true, code })));
  const plan = (action: "on" | "off" | "code" | "renew", deployed: Partial<Deployed> & Pick<Deployed, "manifest">, drawn = draw) =>
    planGeneral("library", action, { block: blockOf(deployed.manifest!), codes: null, fragment: null, sites: [{ slug: "library", lock: undefined }], ...deployed }, { zone: ZONE, draw: drawn });

  test("Public to the code: lock in the manifest, the code drawn, the fragment with its stanza, the block as it was", () => {
    const planned = change(plan("code", { manifest: LIBRARY }));
    expect(parsed(planned.manifest!).lock).toBe(true);
    expect(planned.block).toEqual({ kind: "none" });
    expect(planned.code).toBe("K7M2PQ");
    expect(JSON.parse(planned.locks!.codes!)).toEqual({ library: "K7M2PQ" });
    expect(installedCode(planned.locks!.fragment!, "library")).toBe("K7M2PQ");
    expect(planned.locks!.fragment).toBe(locks({ library: "K7M2PQ" }));
    expect(planned.previous).toBeNull();
  });

  test("Restricted to the code: the portal off and the lock on, in the same manifest, block and locks", () => {
    const planned = change(planGeneral("cms", "code", { manifest: CMS, block: blockOf(CMS), codes: null, fragment: null, sites: [] }, { zone: ZONE, draw }));
    const manifest = parsed(planned.manifest!);
    expect(isProtected(manifest)).toBe(false);
    expect(manifest.lock).toBe(true);
    expect(fragmentIsProtected((planned.block as { text: string }).text)).toBe(false);
    expect(installedCode(planned.locks!.fragment!, "cms")).toBe("K7M2PQ");
  });

  test("the code back to Restricted, or to Public: the lock, the code and the stanza go, the other sites' stay", () => {
    const deployed = { manifest: LOCKED, codes: '{"library":"K7M2PQ","other":"W4XN8R"}', fragment: locks({ library: "K7M2PQ", other: "W4XN8R" }), sites: [{ slug: "library", lock: true }, { slug: "other", lock: true }] };
    for (const action of ["on", "off"] as const) {
      const planned = change(plan(action, deployed));
      expect(parsed(planned.manifest!).lock).toBeUndefined();
      expect(isProtected(parsed(planned.manifest!))).toBe(action === "on");
      expect(JSON.parse(planned.locks!.codes!)).toEqual({ other: "W4XN8R" });
      expect(installedCode(planned.locks!.fragment!, "library")).toBeNull();
      expect(installedCode(planned.locks!.fragment!, "other")).toBe("W4XN8R");
      expect(planned.leaving).toBe(true);
    }
  });

  test("a new code: another code, the stanza's old one to probe, the manifest untouched", () => {
    const deployed = { manifest: LOCKED, codes: '{"library":"K7M2PQ"}', fragment: locks({ library: "K7M2PQ" }), sites: [{ slug: "library", lock: true }] };
    const planned = change(plan("renew", deployed, () => "W4XN8R"));
    expect(planned.manifest).toBeNull();
    expect(planned.code).toBe("W4XN8R");
    expect(planned.previous).toBe("K7M2PQ");
    expect(JSON.parse(planned.locks!.codes!)).toEqual({ library: "W4XN8R" });
  });

  test("already open with its code: nothing, the code said back for whoever asked", () => {
    const deployed = { manifest: LOCKED, codes: '{"library":"K7M2PQ"}', fragment: locks({ library: "K7M2PQ" }), sites: [{ slug: "library", lock: true }] };
    expect(plan("code", deployed)).toEqual({ kind: "nothing", message: "already open with a code", target: "code", code: "K7M2PQ" });
  });

  test("the manifest asks for a code the codes file lacks: a code drawn, the disagreement mended", () => {
    const planned = change(plan("code", { manifest: LOCKED, sites: [{ slug: "library", lock: true }] }));
    expect(planned.manifest).toBeNull();
    expect(installedCode(planned.locks!.fragment!, "library")).toBe("K7M2PQ");
  });

  test("a stale code without a lock: Public takes it away, though the manifest already says Public", () => {
    const planned = change(plan("off", { manifest: LIBRARY, codes: '{"library":"K7M2PQ"}', fragment: locks({ library: "K7M2PQ" }) }));
    expect(planned.manifest).toBeNull();
    expect(JSON.parse(planned.locks!.codes!)).toEqual({});
    expect(installedCode(planned.locks!.fragment!, "library")).toBeNull();
  });

  test("a site on its own domain takes a code: its block already closes the domain, and is left as it is", () => {
    const domain = `${JSON.stringify({ ...parsed(LIBRARY), headers: undefined, domain: { name: "example.test", active: true } }, null, 2)}\n`;
    const planned = change(plan("code", { manifest: domain }));
    expect(planned.block).toEqual({ kind: "none" });
    expect(planned.portalChanged).toBe(false);
    expect(installedCode(planned.locks!.fragment!, "library")).toBe("K7M2PQ");
  });

  test("a block an earlier release wrote is replaced by the current one, the portal unchanged", () => {
    const domain = `${JSON.stringify({ ...parsed(LIBRARY), headers: undefined, domain: { name: "example.test", active: true } }, null, 2)}\n`;
    const earlier = generateFragment(readManifest(domain).manifest!, "identity", "hidden", "open")!;
    const planned = change(plan("code", { manifest: domain, block: earlier }));
    expect(planned.block).toEqual({ kind: "write", text: blockOf(domain)! });
    expect(planned.portalChanged).toBe(false);
  });

  test("refused: a new code for a site without one, the codes unreadable, another site's lock broken", () => {
    expect(plan("renew", { manifest: LIBRARY })).toEqual({ kind: "rejects", message: "library does not open with a code: choose Anyone with the code first" });
    expect(plan("code", { manifest: LIBRARY, codes: "[]" })).toMatchObject({ kind: "rejects", message: expect.stringContaining("the codes file on the server does not read") });
    expect(plan("code", { manifest: LIBRARY, codes: { error: "a symbolic link" } })).toMatchObject({ kind: "rejects", message: expect.stringContaining("a symbolic link") });
    expect(plan("code", { manifest: LIBRARY, sites: [{ slug: "library", lock: undefined }, { slug: "other", lock: true }] })).toEqual({
      kind: "rejects",
      message: "the preview locks cannot be generated: other: lock requested without a valid code",
    });
    expect(plan("code", { manifest: LIBRARY, sites: { error: "other: sitesolide.json unreadable" } })).toMatchObject({ kind: "rejects", message: expect.stringContaining("unreadable") });
  });

  test("restricting a site with nothing to do with the locks neither reads nor writes them", () => {
    const planned = change(plan("on", { manifest: LIBRARY, codes: { error: "unreadable" }, sites: { error: "unreadable" } }));
    expect(planned.locks).toBeNull();
    expect(planned.leaving).toBe(false);
  });

  test("a draw that keeps giving the code in force is refused rather than a new code that is the old one", () => {
    const deployed = { manifest: LOCKED, codes: '{"library":"K7M2PQ"}', fragment: locks({ library: "K7M2PQ" }), sites: [{ slug: "library", lock: true }] };
    expect(plan("renew", deployed, draw)).toMatchObject({ kind: "rejects", message: expect.stringContaining("no new valid code") });
  });
});
