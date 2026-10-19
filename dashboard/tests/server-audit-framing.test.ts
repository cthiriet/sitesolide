import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateRoutes } from "../borrowed/fragment";
import { validate, type Manifest } from "../borrowed/manifest";

/**
 * The dashboard's page, framed by another site of the zone.
 *
 * Every project is served at `<slug>.<zone>`, the dashboard among them, and
 * the browser holds every subdomain of the zone to be the same site. The
 * session cookie is SameSite=Strict, which keeps it from a page of another
 * site, never from one of the zone: a page an Admin's token deployed in the
 * open, or any compromised app, frames `dashboard.<zone>` with the owner's or
 * an Admin's session in it, and every click made in the frame comes from the
 * dashboard's own origin, so the Origin check lets it through. Laid under a
 * decoy, those clicks remove people, revoke tokens, restart services, and,
 * within the ten minutes after an unlock, raise a role or give the right to
 * create projects. Only the page itself can refuse to be framed: Caddy serves
 * it from the manifest's publicDir, with the manifest's headers.
 */

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "sitesolide.json"), "utf8")) as Manifest;

function header(name: string): string | null {
  const found = Object.entries(manifest.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found === undefined ? null : found[1];
}

describe("the dashboard's page refuses to be framed", () => {
  test("its manifest declares frame-ancestors 'none', and X-Frame-Options for older browsers", () => {
    expect(header("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(header("X-Frame-Options")).toBe("DENY");
  });

  test("the manifest stays valid, and its block carries the headers on every path", () => {
    expect(validate(manifest, "test-zone.invalid")).toEqual([]);
    const routes = generateRoutes(manifest);
    expect(routes).toContain(`header Content-Security-Policy "frame-ancestors 'none'"`);
    expect(routes).toContain(`header X-Frame-Options "DENY"`);
  });
});
