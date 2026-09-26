import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { knownManifests } from "./manifests";
import { generateFragment } from "../cli/fragment";
import { readManifest, type Manifest } from "../cli/manifest";
import { fragmentIsProtected, PORTAL_PORT } from "../cli/portal";

/**
 * The portal's port is written in three places: its manifest, which decides
 * the unit; its configuration, which reads it as a fallback; and the CLI,
 * which writes it into the fragment of every protected site. Let them
 * diverge, and every protected site would answer 502.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..");

test("the portal's manifest and the CLI announce the same port", () => {
  const { manifest, errors } = readManifest(readFileSync(join(REPO_ROOT, "portal", "sitesolide.json"), "utf8"));
  expect(errors).toEqual([]);
  expect(manifest?.port).toBe(PORTAL_PORT);
});

test("the portal's configuration has the same default port", () => {
  const config = readFileSync(join(REPO_ROOT, "portal", "src", "config.ts"), "utf8");
  expect(config).toInclude(`process.env.PORT ?? ${PORTAL_PORT}`);
});

test("the portal only exposes /sante on its own host", () => {
  // /verifier and /_portal/* are only reachable through Caddy, from a
  // protected site, with an X-Portal-Hote that Caddy sets. On the portal's
  // subdomain, the visitor would choose that header.
  const { manifest } = readManifest(readFileSync(join(REPO_ROOT, "portal", "sitesolide.json"), "utf8"));
  expect(manifest?.routes).toEqual(["/sante"]);
});

test("no fragment relays anything to the portal beyond its door, its login and /sante", () => {
  // The portal's /admin/* routes, where the dashboard creates and revokes
  // guest accesses, have no guard other than the loopback rule: a fragment
  // that relayed them would open them to the web. See portal/src/admin.ts.
  const upstream = `127.0.0.1:${PORTAL_PORT}`;
  const door = [`reverse_proxy /_portal/* ${upstream} {`, `forward_auth @portal_guard ${upstream} {`];

  const isProtected: Manifest = { slug: "budget", port: 3030, start: "bun run server.ts", portal: true, portalExempt: ["/admin/*"] };
  const fragments: [string, string][] = [["generated", generateFragment(isProtected)!]];
  for (const manifest of knownManifests()) {
    const fragment = generateFragment(manifest);
    if (fragment !== null) fragments.push([`${manifest.slug}.caddy`, fragment]);
  }

  for (const [name, text] of fragments) {
    const allowed = name === "portal.caddy" ? [...door, `reverse_proxy @dynamic ${upstream}`] : door;
    for (const line of text.split("\n").filter((l) => l.includes(upstream)).map((l) => l.trim())) {
      expect({ name, line, allowed: allowed.includes(line) }).toEqual({ name, line, allowed: true });
    }
  }

  // On its own host, @dynamic is only /sante, and forward_auth never asks for
  // anything but /verifier.
  const portal = knownManifests().find((manifest) => manifest.slug === "portal");
  expect(portal).toBeDefined();
  expect(generateFragment(portal as Manifest)).toInclude("@dynamic path /sante\n");
  expect(generateFragment(isProtected)).toInclude("\t\turi /verifier\n");
});

test("the door is recognised in the generated fragment, and its absence too", () => {
  const isProtected: Manifest = { slug: "budget", port: 3030, start: "bun run server.ts", portal: true };
  expect(fragmentIsProtected(generateFragment(isProtected) ?? "")).toBe(true);
  expect(fragmentIsProtected(generateFragment({ ...isProtected, portal: undefined }) ?? "")).toBe(false);
});
