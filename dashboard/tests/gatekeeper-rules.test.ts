import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest, type Manifest } from "../borrowed/manifest";
import { portalModifiable, actionRefusal } from "../src/gatekeeper/rules";

/**
 * What the gatekeeper agrees to change. The refusals count as much as the
 * approvals: closing the dashboard behind the portal means losing the one tool
 * that would say the portal is down.
 */
const REPO = join(import.meta.dir, "..", "..");
const SITES = process.env.SITESOLIDE_SITES_REPO ?? join(REPO, "..", "sitesolide-sites");

function manifestOf(path: string): Manifest {
  const { manifest, errors } = readManifest(readFileSync(path, "utf8"));
  expect(errors).toEqual([]);
  return manifest!;
}

const staticSite: Manifest = { slug: "vineyard", publicDir: "public" };
const appSite: Manifest = {
  slug: "tool",
  publicDir: "public",
  start: "/usr/local/bin/bun run server.ts",
  port: 3030,
};

describe("portalModifiable", () => {
  test("the portal itself does not go behind its own door", () => {
    const manifest = manifestOf(join(REPO, "portal", "sitesolide.json"));
    const verdict = portalModifiable("portal", manifest);
    expect(verdict.modifiable).toBe(false);
    expect(verdict.reason).toContain("portal");
  });

  test("the dashboard stays reachable if the portal falls", () => {
    const manifest = manifestOf(join(REPO, "dashboard", "sitesolide.json"));
    const verdict = portalModifiable("dashboard", manifest);
    expect(verdict.modifiable).toBe(false);
    expect(verdict.reason).toContain("dashboard");
  });

  test("the slug alone is enough to refuse, even with no manifest", () => {
    expect(portalModifiable("portal", null).modifiable).toBe(false);
    expect(portalModifiable("dashboard", null).modifiable).toBe(false);
  });

  test("the landing, with no manifest, is refused", () => {
    const verdict = portalModifiable("test-zone.invalid", null);
    expect(verdict).toEqual({ modifiable: false, reason: expect.stringContaining("sitesolide.json") });
  });

  test("a manifest that fails validation is refused, with the first error", () => {
    const verdict = portalModifiable("tool", { ...appSite, portal: false });
    expect(verdict.modifiable).toBe(false);
    expect(verdict.reason).toContain("portal: true, or absent");
  });

  test("a manifest naming another slug is refused", () => {
    const verdict = portalModifiable("other", appSite);
    expect(verdict.modifiable).toBe(false);
    expect(verdict.reason).toContain("another slug");
  });

  test("an app site, open or closed, can be changed", () => {
    expect(portalModifiable("tool", appSite)).toEqual({ modifiable: true, reason: null });
    expect(portalModifiable("tool", { ...appSite, portal: true })).toEqual({
      modifiable: true,
      reason: null,
    });
  });

  test("a static site cannot take the door, and says so", () => {
    expect(portalModifiable("vineyard", staticSite)).toEqual({
      modifiable: false,
      reason: "a static site cannot sit behind the portal yet",
    });
  });

  test("a site under a preview lock, or on its own domain: what would have to change", () => {
    expect(portalModifiable("tool", { ...appSite, lock: true })).toEqual({
      modifiable: false,
      reason: "remove the preview lock first: bin/lock.sh disable",
    });
    expect(portalModifiable("tool", { ...appSite, domain: { name: "example.test", active: true } })).toEqual({
      modifiable: false,
      reason: "not on a customer domain, only under the served zone",
    });
  });

  test("the action judged is the one the page offers: removing a door in place is allowed", () => {
    const guarded: Manifest = { ...appSite, portal: true, portalExempt: ["/webhooks/*"] };
    expect(portalModifiable("tool", guarded)).toEqual({ modifiable: true, reason: null });
    expect(actionRefusal(guarded, false)).toBeNull();
    expect(actionRefusal(staticSite, false)).toBeNull();
    expect(actionRefusal(staticSite, true)).toBe("a static site cannot sit behind the portal yet");
  });

  test.skipIf(!existsSync(SITES))("the manifests from the sites repository", () => {
    // Walked rather than listed: a hard-coded inventory would publish which
    // sites this machine serves, and would go stale at the next one deployed.
    // What is checked here is that no real manifest is refused for being
    // invalid, the only verdict that would mean the repository, not the rule,
    // is wrong. A static site refused the door is the rule working.
    let seen = 0;
    for (const entry of readdirSync(SITES, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(SITES, entry.name, "sitesolide.json");
      if (!existsSync(path)) continue;
      seen += 1;
      const { reason } = portalModifiable(entry.name, manifestOf(path));
      expect({ slug: entry.name, invalid: reason?.startsWith("sitesolide.json is invalid") ?? false }) //
        .toEqual({ slug: entry.name, invalid: false });
    }
    // Without this, a wrong path would turn the test green having read nothing.
    expect(seen).toBeGreaterThan(0);
  });

  test("a removed portal keeps its exemptions, and stays changeable", () => {
    // The manifest the gatekeeper drops after a removal: portalExempt stays,
    // so that the door put back reopens the webhook.
    const removed: Manifest = { ...appSite, portalExempt: ["/webhooks/*"] };
    expect(portalModifiable("tool", removed)).toEqual({ modifiable: true, reason: null });
  });

  test("a malformed exemption stays refused, door in place or not", () => {
    expect(portalModifiable("tool", { ...appSite, portal: true, portalExempt: ["/"] }).modifiable).toBe(false);
    expect(portalModifiable("tool", { ...appSite, portalExempt: ["/"] }).modifiable).toBe(false);
  });
});
