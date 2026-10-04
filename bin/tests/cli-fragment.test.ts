import { describe, expect, test } from "bun:test";
import { decideBlock, generateFragment, isEarlierGeneration, ZONE_HOST, IMPORT_LOCKS, matcher } from "../cli/fragment";
import { validate, type Manifest } from "../cli/manifest";
import { fragmentPassesIdentity, PORTAL_GENERATIONS, PORTAL_PORT, portalStanza } from "../cli/portal";

const MIXED: Manifest = {
  slug: "budget",
  port: 3022,
  publicDir: "public",
  start: "bun run server.ts",
};
const API: Manifest = { slug: "my-api", port: 3041, start: "uvicorn app:api" };
const SHOWCASE: Manifest = { slug: "notes", publicDir: "dist" };

/**
 * Same block extraction as api/tests/caddyfile.test.ts: comments readily quote
 * braces and take no part in the structure.
 */
function block(text: string, header: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.trimStart().startsWith(header));
  if (first === -1) throw new Error(`block not found: ${header}`);

  const body: string[] = [];
  let depth = 0;
  for (const line of lines.slice(first)) {
    const code = line.trimStart().startsWith("#") ? "" : line;
    depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
    body.push(line);
    if (depth === 0 && body.length > 1) break;
  }
  return body.join("\n");
}

describe("the three shapes", () => {
  test("a static showcase has no fragment", () => {
    // The zone's wildcard block already serves it; writing it a fragment would
    // add one more file to validate without changing anything.
    expect(generateFragment(SHOWCASE)).toBeNull();
    expect(generateFragment({ ...SHOWCASE, domain: { name: "x.test", active: true } })).toBeNull();
  });

  test("an API without files goes entirely to the service", () => {
    const routes = block(generateFragment(API) ?? "", "(my-api-routes) {");
    expect(routes).toInclude("reverse_proxy 127.0.0.1:3041");
    expect(routes).not.toInclude("file_server");
    expect(routes).not.toInclude("root *");
  });

  test("a mixed project serves the files and proxies the rest", () => {
    const routes = block(generateFragment(MIXED) ?? "", "(budget-routes) {");
    expect(routes).toInclude("root * /srv/sites/budget/public");
    expect(routes).toInclude("@dynamic not file");
    expect(routes).toInclude("reverse_proxy @dynamic 127.0.0.1:3022");
    expect(routes).toInclude("file_server");
  });
});

describe("the matcher", () => {
  test("by default, everything that is not a file", () => {
    expect(matcher(MIXED)).toBe("not file");
  });

  test("a declared whitelist wins", () => {
    // It is not a configuration to fill in: it is a security choice, for a
    // service whose very home page depends on a session.
    expect(matcher({ ...MIXED, routes: ["/api/*", "/login"] })).toBe(
      "path /api/* /login",
    );
  });

  test("no matcher without a public folder", () => {
    expect(matcher(API)).toBeNull();
  });
});

describe("the four non negotiable rules", () => {
  test("no handle anywhere", () => {
    // All the handles of a same block form an exclusive group: the lock's one
    // would win, and the visitor holding the right code would receive a 200
    // with an empty body. Measured in the laboratory.
    for (const manifest of [MIXED, API]) {
      const fragment = generateFragment(manifest) ?? "";
      for (const line of fragment.split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        expect(line).not.toInclude("handle");
      }
    }
  });

  test("the preview block imports tls-zone", () => {
    // Without it, this block obtains its own certificate instead of sharing
    // the wildcard, and nothing says so.
    const preview = block(generateFragment(MIXED) ?? "", `budget.${ZONE_HOST} {`);
    expect(preview).toInclude("import tls-zone");
  });

  test("the preview block imports the locks, by glob", () => {
    const preview = block(generateFragment(MIXED) ?? "", `budget.${ZONE_HOST} {`);
    expect(preview).toInclude(IMPORT_LOCKS);
    for (const line of (generateFragment(MIXED) ?? "").split("\n")) {
      if (!line.includes("/etc/caddy/locks")) continue;
      expect(line.trim()).toBe(IMPORT_LOCKS);
    }
  });

  test("no other block imports the locks", () => {
    // A lock laid on the final domain would close the site in production.
    const manifest = { ...MIXED, domain: { name: "sample-agency.example", active: true } };
    const fragment = generateFragment(manifest) ?? "";
    const preview = block(fragment, `budget.${ZONE_HOST} {`);
    expect(fragment.split(preview).join("")).not.toInclude("/etc/caddy/locks");
  });

  test("the site's own domain does not import tls-zone", () => {
    // The server's Cloudflare token only covers the served zone: this domain
    // goes through on_demand.
    const manifest = { ...MIXED, domain: { name: "sample-agency.example", active: true } };
    const domain = block(generateFragment(manifest) ?? "", "sample-agency.example {");
    expect(domain).not.toInclude("tls-zone");
    expect(domain).toInclude("on_demand");
  });
});

describe("preview", () => {
  test("carries the noindex, which its specificity makes it lose", () => {
    // This block comes before the zone's wildcard and therefore does not
    // inherit its header.
    const preview = block(generateFragment(MIXED) ?? "", `budget.${ZONE_HOST} {`);
    expect(preview).toInclude("noindex");
  });

  test("the two blocks share the same routes snippet", () => {
    const manifest = { ...MIXED, domain: { name: "sample-agency.example", active: true } };
    const fragment = generateFragment(manifest) ?? "";
    expect(fragment.match(/import budget-routes/g)).toHaveLength(2);
    expect(fragment.match(/\(budget-routes\) \{/g)).toHaveLength(1);
  });
});

describe("headers specific to the site", () => {
  test("laid in the snippet, hence on every block", () => {
    // Without them, a generator replacing a hand written fragment would
    // silently cut what that fragment allowed: a site that uses the
    // microphone declares a Permissions-Policy for it there, without which it
    // stays silent.
    const manifest = {
      ...MIXED,
      headers: { "Permissions-Policy": "microphone=(self), camera=()" },
    };
    const routes = block(generateFragment(manifest) ?? "", "(budget-routes) {");
    expect(routes).toInclude('header Permissions-Policy "microphone=(self), camera=()"');
  });

  test("a declared X-Robots-Tag does not double the preview block's one", () => {
    // Caddy would then add two headers of the same name, and the engine would
    // read both values.
    const manifest = { ...MIXED, headers: { "X-Robots-Tag": "noindex, nofollow, noarchive" } };
    const fragment = generateFragment(manifest) ?? "";
    const written = fragment.split("\n").filter((l) => l.trim().startsWith("header X-Robots-Tag"));
    expect(written).toHaveLength(1);
    expect(written[0]).toInclude("noarchive");
  });

  test("without a declaration, the default noindex stays on the preview alone", () => {
    const fragment = generateFragment(MIXED) ?? "";
    const preview = block(fragment, `budget.${ZONE_HOST} {`);
    expect(preview).toInclude('header X-Robots-Tag "noindex, nofollow"');
  });

  test("a value validate() refuses is never written, even past validate()", () => {
    // The second barrier: a manifest that reached the generator without the
    // validation, the token's placeholder or a quote that ends the value.
    for (const value of ["{$CLOUDFLARE_API_TOKEN}", "{env.CLOUDFLARE_API_TOKEN}", 'x"\n\trespond "owned', "x\\"]) {
      expect(() => generateFragment({ ...MIXED, headers: { "X-Leak": value } })).toThrow("never written into a Caddy block");
    }
    expect(() => generateFragment({ ...MIXED, headers: { "+X-Leak": "x" } })).toThrow("never written into a Caddy block");
  });

  test("whatever validate() accepts, no placeholder can reach a header line", () => {
    // Values drawn from every printable character, the ones Caddy reads as
    // syntax included, with a fixed seed: the validation keeps some, refuses
    // the others, and the generated lines of the ones it keeps carry no brace,
    // no dollar, and no quote but the two around the value.
    let seed = 20261004;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
    const alphabet = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), "{$", "{env.", "\n", "\t", "é"];
    let kept = 0;
    for (let round = 0; round < 2000; round++) {
      const value = Array.from({ length: 1 + Math.floor(next() * 24) }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
      const manifest = { ...MIXED, headers: { "X-Fuzz": value } };
      if (validate(manifest).length > 0) {
        expect(() => generateFragment(manifest)).toThrow();
        continue;
      }
      kept++;
      const line = (generateFragment(manifest) ?? "").split("\n").find((l) => l.startsWith("\theader X-Fuzz "))!;
      const inside = line.slice('\theader X-Fuzz "'.length, -1);
      expect(line.endsWith('"')).toBe(true);
      expect(inside).toBe(value);
      expect(inside).not.toMatch(/[{}$"\\`\n\t]/);
    }
    expect(kept).toBeGreaterThan(100);
  });
});

describe("routes", () => {
  test("a top-level route validate() refuses is never written into the matcher", () => {
    for (const route of ['/x\n\theader Leak "{$CLOUDFLARE_API_TOKEN}"', "/x{env.A}", "/a b"]) {
      expect(() => generateFragment({ ...MIXED, routes: [route] })).toThrow("never written into a Caddy block");
    }
    const services = { web: { start: "/bin/web", port: 3040 }, api: { start: "/bin/api", port: 3041, routes: ["/api/*\n}"] } };
    expect(() => generateFragment({ slug: "budget", publicDir: "public", services })).toThrow("never written into a Caddy block");
  });

  test("an exemption validate() refuses is never written into the portal's matcher", () => {
    expect(() => generateFragment({ ...MIXED, portal: true, portalExempt: ["/hook {$A}"] })).toThrow("never written into a Caddy block");
  });
});

describe("portal", () => {
  const PROTECTED: Manifest = { ...MIXED, portal: true, portalExempt: ["/webhooks/*"] };

  test("a protected site goes through forward_auth in its preview block", () => {
    const preview = block(generateFragment(PROTECTED) ?? "", `budget.${ZONE_HOST} {`);
    expect(preview).toInclude(`forward_auth @portal_guard 127.0.0.1:${PORTAL_PORT} {`);
    expect(preview).toInclude(`reverse_proxy /_portal/* 127.0.0.1:${PORTAL_PORT} {`);
    expect(preview).toInclude("@portal_guard not path /_portal/* /webhooks/*");
    // A path that Caddy and the service would read differently is refused.
    expect(preview).toInclude("@portal_ambiguous expression");
    expect(preview).toInclude('respond @portal_ambiguous "400: ambiguous path" 400');
    // The host the portal believes in comes from Caddy, never from the visitor.
    expect(preview.match(/header_up X-Portal-Hote \{host\}/g)?.length).toBe(2);
  });

  test("the stanza uses no handle, which would form a group with the lock", () => {
    for (const generation of PORTAL_GENERATIONS) {
      for (const line of portalStanza(PROTECTED, generation)) {
        if (line.trimStart().startsWith("#")) continue;
        expect(line).not.toMatch(/\bhandle\b/);
      }
    }
  });

  test("one route, and only to take the visitor's identity headers off before the portal is asked", () => {
    // Order is what this route is for: Caddy keeps it inside, and sorts
    // request_header after forward_auth outside. Anything else slipped into it
    // would run in the order written, which the comparison of blocks does not
    // see: nothing else goes in.
    const stanza = portalStanza(PROTECTED)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    const start = stanza.indexOf("route {");
    expect(stanza.filter((line) => /\broute\b/.test(line))).toEqual(["route {"]);
    expect(stanza.slice(start, start + 3)).toEqual([
      "route {",
      "request_header -X-Sitesolide-*",
      `forward_auth @portal_guard 127.0.0.1:${PORTAL_PORT} {`,
    ]);
    expect(stanza).toContain("copy_headers X-Sitesolide-User X-Sitesolide-User-Name X-Sitesolide-Role");
    expect(stanza.slice(start)).toEqual([
      "route {",
      "request_header -X-Sitesolide-*",
      `forward_auth @portal_guard 127.0.0.1:${PORTAL_PORT} {`,
      "uri /verifier",
      "header_up X-Portal-Hote {host}",
      "lb_try_duration 5s",
      "copy_headers X-Sitesolide-User X-Sitesolide-User-Name X-Sitesolide-Role",
      "}",
      "}",
    ]);
  });

  test("the earlier generation is the stanza from before identities, line for line", () => {
    const earlier = portalStanza(PROTECTED, "cookie")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(earlier.slice(-6)).toEqual([
      "@portal_guard not path /_portal/* /webhooks/*",
      `forward_auth @portal_guard 127.0.0.1:${PORTAL_PORT} {`,
      "uri /verifier",
      "header_up X-Portal-Hote {host}",
      "lb_try_duration 5s",
      "}",
    ]);
    expect(earlier.join("\n")).not.toInclude("X-Sitesolide");
    expect(earlier.join("\n")).not.toMatch(/\broute\b/);
  });

  test("whether a block hands the site who is in: the current one does, the earlier one does not", () => {
    expect(fragmentPassesIdentity(generateFragment(PROTECTED)!)).toBe(true);
    expect(fragmentPassesIdentity(generateFragment(PROTECTED, "cookie")!)).toBe(false);
    expect(fragmentPassesIdentity(generateFragment(MIXED)!)).toBe(false);
  });

  test("an unprotected site does not have the stanza", () => {
    expect(generateFragment(MIXED)).not.toInclude("forward_auth");
    expect(portalStanza(MIXED)).toEqual([]);
  });
});

/**
 * The block a deployment generates, against the one the machine serves.
 *
 * This decision used to be taken against a copy of every block kept on the
 * workstation. It is taken against the machine now, and it has to keep the two
 * protections it gave: a block edited by hand is never overwritten in silence,
 * and a door changed from the dashboard is caught up without --force.
 */
describe("the block against the one in service", () => {
  const OPEN: Manifest = { slug: "budget", port: 3030, start: "bun run server.ts" };
  const CLOSED: Manifest = { ...OPEN, portal: true };
  const block = (manifest: Manifest) => generateFragment(manifest) as string;
  const decide = (manifest: Manifest, inService: string | null, replace = false, doorConfirmed = false) =>
    decideBlock({ manifest, inService, replace, doorConfirmed });

  test("none in service, or the same directives: deposited", () => {
    expect(decide(OPEN, null)).toBe("deposit");
    expect(decide(OPEN, block(OPEN))).toBe("deposit");
    // Comments do not count: a block whose text differs by them alone is the same.
    expect(decide(OPEN, `# a comment\n${block(OPEN)}`)).toBe("deposit");
  });

  test("different by the door alone, the machine carrying that door: it follows the dashboard", () => {
    // The dashboard closed the site: the manifest read on the machine says
    // portal, the block in service is still the open one.
    expect(decide(CLOSED, block(OPEN), false, true)).toBe("follows-door");
    expect(decide(OPEN, block(CLOSED), false, true)).toBe("follows-door");
  });

  test("different by the door, without the machine confirming it: the local door does not win in silence", () => {
    expect(decide(CLOSED, block(OPEN))).toBe("diverged");
  });

  test("different by anything else: refused, even with the door confirmed", () => {
    const edited = block({ ...OPEN, port: 3031 });
    expect(decide(OPEN, edited)).toBe("diverged");
    expect(decide(CLOSED, block({ ...OPEN, port: 3031 }), false, true)).toBe("diverged");
  });

  test("--force replaces what differs", () => {
    expect(decide(OPEN, block({ ...OPEN, port: 3031 }), true)).toBe("forced");
  });

  test("a project without a block has nothing to decide", () => {
    expect(decide({ slug: "brochure", publicDir: "public" }, "anything")).toBe("deposit");
  });

  test("a protected block from before identities is upgraded without --force", () => {
    const earlier = generateFragment(CLOSED, "cookie")!;
    expect(isEarlierGeneration(earlier, CLOSED)).toBe(true);
    expect(decide(CLOSED, earlier)).toBe("upgrades");
    // An open site's block never changed: nothing to upgrade, it is the same.
    expect(isEarlierGeneration(block(OPEN), OPEN)).toBe(false);
    expect(decide(OPEN, generateFragment(OPEN, "cookie"))).toBe("deposit");
  });

  test("the dashboard's door is followed whichever release wrote the block in service", () => {
    // A dashboard not yet upgraded closed the site with the earlier stanza.
    expect(decide(OPEN, generateFragment(CLOSED, "cookie"), false, true)).toBe("follows-door");
    expect(decide(OPEN, generateFragment(CLOSED, "cookie"))).toBe("diverged");
  });

  test("an earlier block edited by hand is still a hand edit", () => {
    const edited = generateFragment({ ...CLOSED, port: 3031 }, "cookie")!;
    expect(isEarlierGeneration(edited, CLOSED)).toBe(false);
    expect(decide(CLOSED, edited)).toBe("diverged");
    expect(decide(CLOSED, `${generateFragment(CLOSED, "cookie")}\n\theader X-Extra yes`)).toBe("diverged");
  });
});

