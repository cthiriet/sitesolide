import { describe, expect, test } from "bun:test";
import { decideBlock, generateFragment, ZONE_HOST, IMPORT_LOCKS, matcher } from "../cli/fragment";
import type { Manifest } from "../cli/manifest";
import { PORTAL_PORT, portalStanza } from "../cli/portal";

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
    for (const line of portalStanza(PROTECTED)) {
      if (line.trimStart().startsWith("#")) continue;
      expect(line).not.toMatch(/\b(handle|route)\b/);
    }
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
});

