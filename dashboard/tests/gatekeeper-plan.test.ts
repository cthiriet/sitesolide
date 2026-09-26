import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateFragment } from "../borrowed/fragment";
import { isProtected, readManifest, type Manifest } from "../borrowed/manifest";
import { fragmentIsProtected } from "../borrowed/portal";
import { portalState, planPortal, type Plan } from "../src/gatekeeper/plan";

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

function change(plan: Plan): Extract<Plan, { kind: "change" }> {
  if (plan.kind !== "change") throw new Error(`plan ${plan.kind}: ${"message" in plan ? plan.message : ""}`);
  return plan;
}

describe("planPortal, on the manifests from the sites repository", () => {
  test("removing the portal from cms: manifest with no portal, exemptions kept, block with no guard", () => {
    const plan = change(planPortal("cms", false, { manifest: CMS, block: blockOf(CMS) }));
    const newPassword = parsed(plan.manifest);
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
    expect(parsed(plan.manifest).portal).toBe(true);
    const text = (plan.block as { text: string }).text;
    expect(fragmentIsProtected(text)).toBe(true);
    expect(text).toBe(generateFragment(parsed(plan.manifest))!);
  });

  test("removing then putting back yields the original manifest and block", () => {
    const retire = change(planPortal("kanban", false, { manifest: KANBAN, block: blockOf(KANBAN) }));
    const block = (retire.block as { text: string }).text;
    const repose = change(planPortal("kanban", true, { manifest: retire.manifest, block }));
    expect(repose.manifest).toBe(KANBAN.endsWith("\n") ? KANBAN : `${KANBAN}\n`);
    expect((repose.block as { text: string }).text).toBe(blockOf(KANBAN)!);
  });

  test("cms removed then put back finds its exemption again", () => {
    const retire = change(planPortal("cms", false, { manifest: CMS, block: blockOf(CMS) }));
    const repose = change(
      planPortal("cms", true, { manifest: retire.manifest, block: (retire.block as { text: string }).text }),
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
    expect(plan).toEqual({ kind: "rejects", message: "a static site cannot sit behind the portal yet" });
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

  test("a site on its own domain, or under a preview lock", () => {
    // With no headers: an X-Robots-Tag would count for the customer's domain too, which validate() refuses.
    const domain = `${JSON.stringify({ ...parsed(LIBRARY), headers: undefined, domain: { name: "example.test", active: true } }, null, 2)}\n`;
    expect(planPortal("library", true, { manifest: domain, block: blockOf(domain) })).toEqual({
      kind: "rejects",
      message: "not on a customer domain, only under the served zone",
    });
    const lock = `${JSON.stringify({ ...parsed(LIBRARY), lock: true }, null, 2)}\n`;
    expect(planPortal("library", true, { manifest: lock, block: blockOf(lock) })).toEqual({
      kind: "rejects",
      message: "remove the preview lock first: bin/lock.sh disable",
    });
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
