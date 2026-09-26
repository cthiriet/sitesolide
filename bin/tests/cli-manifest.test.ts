import { describe, expect, test } from "bun:test";
import {
  isInternalPath,
  isApp,
  missingExclusions,
  readManifest,
  setDomainActive,
  setPortal,
  setLock,
  isValidSlug,
  validate,
  type Manifest,
} from "../cli/manifest";
import { isValidDomain as isValidDomainApi, isValidSlug as isValidSlugApi } from "../../api/src/table";

/** The tests' zone: a reserved TLD, which resolves nowhere. */
const ZONE = "test-zone.invalid";

/** The minimal manifest of a showcase, base of the variants below. */
const STATIC: Manifest = { slug: "notes", publicDir: "dist" };
const APP: Manifest = { slug: "budget", port: 3022, start: "bun run server.ts" };

describe("slug", () => {
  test("accepts a DNS label", () => {
    expect(isValidSlug("my-api")).toBe(true);
    expect(isValidSlug("a")).toBe(true);
  });

  test("refuses what cannot be a subdomain", () => {
    for (const slug of ["My-Api", "-api", "api-", "my.api", "my_api", "", "a".repeat(64)]) {
      expect(isValidSlug(slug)).toBe(false);
    }
  });

  test("every slug accepted here is accepted by api/src/table.ts", () => {
    // The CLI is stricter, never more permissive: a slug it accepted and that
    // the service refused would give a folder that is never routed.
    for (const slug of ["my-api", "budget", "notes2", "a"]) {
      expect(isValidSlug(slug)).toBe(true);
      expect(isValidSlugApi(slug)).toBe(true);
    }
  });
});

describe("declared paths", () => {
  test("refuses a climb out of the deployed repository", () => {
    // publicDir is used as the source of an rsync: a climb would send any
    // folder of the workstation to the VM.
    for (const path of ["../secrets", "a/../../b", "/etc", "", "C:/x"]) {
      expect(isInternalPath(path)).toBe(false);
    }
    expect(isInternalPath("dist")).toBe(true);
    expect(isInternalPath("build/public")).toBe(true);
  });

  test("the manifest refuses a publicDir that climbs up", () => {
    expect(validate({ slug: "notes", publicDir: "../../etc" })).toContainEqual(
      expect.stringContaining("publicDir"),
    );
  });
});

describe("validation", () => {
  test("a minimal manifest passes", () => {
    expect(validate(STATIC)).toEqual([]);
    expect(validate(APP)).toEqual([]);
  });

  test("refuses the landing slug", () => {
    // Without this refusal the deployment SUCCEEDS: it publishes a duplicate
    // of the landing on landing.<zone>, which the wildcard block serves right
    // away.
    expect(validate({ ...STATIC, slug: "landing" })).toContainEqual(
      expect.stringContaining("reserved for the site on the bare domain"),
    );
  });

  test("demands a port as soon as a start is declared", () => {
    expect(validate({ slug: "budget", start: "bun run server.ts" })).toContainEqual(
      expect.stringContaining("port"),
    );
    expect(validate({ ...APP, port: 80 })).toContainEqual(expect.stringContaining("1024"));
  });

  test("refuses a port without a start", () => {
    expect(validate({ ...STATIC, port: 3041 })).toContainEqual(expect.stringContaining("port"));
  });

  test("demands publicDir when nothing starts", () => {
    expect(validate({ slug: "empty" })).toContainEqual(expect.stringContaining("publicDir"));
  });

  test("refuses a memory that systemd would read in bytes", () => {
    expect(validate({ ...APP, memory: "256" })).toContainEqual(
      expect.stringContaining("memory"),
    );
    expect(validate({ ...APP, memory: "256M" })).toEqual([]);
    expect(validate({ ...APP, memory: "1G" })).toEqual([]);
  });

  test("refuses an unknown network", () => {
    expect(validate({ ...APP, network: "public" as never })).toContainEqual(
      expect.stringContaining("network"),
    );
  });

  test("refuses a route that does not start with /", () => {
    expect(validate({ ...APP, routes: ["api/*"] })).toContainEqual(
      expect.stringContaining("routes"),
    );
  });

  test("refuses routes without a service to wake up", () => {
    expect(validate({ ...STATIC, routes: ["/api/*"] })).toContainEqual(
      expect.stringContaining("routes"),
    );
  });

  test("refuses a secret that would be a path", () => {
    for (const secret of ["../ses.env", "sub/folder.env", "/etc/passwd"]) {
      expect(validate({ ...APP, secrets: [secret] })).toContainEqual(
        expect.stringContaining("secrets"),
      );
    }
    expect(validate({ ...APP, secrets: ["my-api.env"] })).toEqual([]);
  });

  test("refuses a domain of the zone, already covered by the wildcard", () => {
    // The `ask` endpoint already refuses them: a manifest that declares them
    // would obtain no certificate, and the manifest must say so right away.
    for (const name of [ZONE, `notes.${ZONE}`]) {
      expect(validate({ ...STATIC, domain: { name: name } }, ZONE)).toContainEqual(
        expect.stringContaining("wildcard"),
      );
    }
  });

  test("with no zone declared, no domain is refused on that ground", () => {
    // Refusing in the name of an invented zone would be worse than refusing
    // nothing: the rule only holds for the zone the machine really serves.
    expect(validate({ ...STATIC, domain: { name: `notes.${ZONE}` } }, "")).toEqual([]);
  });

  test("every domain accepted here is accepted by api/src/table.ts", () => {
    const name = "sample-agency.example";
    expect(validate({ ...STATIC, domain: { name: name } })).toEqual([]);
    expect(isValidDomainApi(name)).toBe(true);
  });
});

describe("reading", () => {
  test("an unreadable JSON gives back an error, never an exception", () => {
    const { manifest, errors } = readManifest("{ not json");
    expect(manifest).toBeUndefined();
    expect(errors[0]).toContain("unreadable");
  });

  test("gives back all the errors at once", () => {
    const { errors } = readManifest(JSON.stringify({ slug: "UPPERCASE", port: 80 }));
    expect(errors.length).toBeGreaterThan(1);
  });
});

describe("nature", () => {
  test("start decides, and it alone", () => {
    expect(isApp(STATIC)).toBe(false);
    expect(isApp(APP)).toBe(true);
    expect(isApp({ ...STATIC, install: "bun install" })).toBe(false);
  });
});

describe("exclusions", () => {
  test("reports the workstation's dependencies when present and not excluded", () => {
    // A node_modules from macOS poured onto a Linux machine gives a service
    // that does not start, after having erased the previous one.
    expect(missingExclusions(APP, ["src", "node_modules"])).toEqual(["node_modules"]);
    expect(missingExclusions(APP, ["src", ".venv"])).toEqual([".venv"]);
  });

  test("reports nothing when they are declared", () => {
    const manifest = { ...APP, exclude: ["node_modules", ".venv"] };
    expect(missingExclusions(manifest, ["node_modules", ".venv"])).toEqual([]);
  });

  test("reports nothing when they do not exist on the disk", () => {
    expect(missingExclusions(APP, ["src", "public"])).toEqual([]);
  });
});

/**
 * The preview lock, written by bin/lock.sh into the manifest and nowhere else.
 * These tests stand in for tests of the script itself, which do not run
 * without the VM: what it decides is here.
 */
describe("setLock", () => {
  const OPEN = JSON.stringify(
    { slug: "acme", publicDir: "public", domain: { name: "acme.example", active: false } },
    null,
    2,
  );

  test("adds the field when the preview closes", () => {
    expect(JSON.parse(setLock(OPEN, true)).lock).toBe(true);
  });

  test("removes the field when it reopens, instead of writing it false", () => {
    // `false` and the absence say the same thing to the lock generator: two
    // writings for a single state would end up diverging, and an open manifest
    // does not have to carry the trace of a lifted lock.
    const reopened = JSON.parse(setLock(setLock(OPEN, true), false));
    expect("lock" in reopened).toBe(false);
  });

  test("touches nothing else, and a round trip gives back the original file", () => {
    // The order of the keys matters as much as their value: the file is
    // versioned, and a lock laid down must not read as a rewriting of the
    // manifest.
    expect(setLock(setLock(OPEN, true), false)).toBe(`${OPEN}\n`);
  });

  test("gives back a manifest that the CLI still accepts", () => {
    // The rewritten file is the one that bin/lock.sh deposits on the VM and
    // that the lock generator reads there. A manifest turned invalid under
    // `setLock`'s pen would close the repository without closing the site.
    const { manifest, errors } = readManifest(setLock(OPEN, true));
    expect(errors).toEqual([]);
    expect(manifest?.lock).toBe(true);

    const { manifest: reopened } = readManifest(setLock(OPEN, false));
    expect(reopened?.lock).toBeUndefined();
  });

  test("refuses what is not a manifest", () => {
    // An empty file or a list would otherwise pass silently, and the
    // description deposited afterwards would have neither a domain nor a lock.
    expect(() => setLock("[]", true)).toThrow();
    expect(() => setLock("null", true)).toThrow();
    expect(() => setLock("", true)).toThrow();
  });
});

/**
 * The portal laid down or removed from the dashboard. The gatekeeper rewrites
 * the manifest deposited on the VM with this function, then generates the
 * Caddy block of the result: what it writes decides what is closed.
 */
describe("setPortal", () => {
  const OPEN = JSON.stringify(
    { slug: "tool", port: 3030, publicDir: "public", start: "bun run server.ts", memory: "128M" },
    null,
    2,
  );
  const EXEMPTED = JSON.stringify(
    {
      slug: "roster",
      port: 3043,
      publicDir: "public",
      start: "bun run server.ts",
      portal: true,
      portalExempt: ["/webhooks/*"],
      memory: "256M",
    },
    null,
    2,
  );

  test("lays `portal: true` on an open site, and the CLI accepts it", () => {
    const { manifest, errors } = readManifest(setPortal(OPEN, true));
    expect(errors).toEqual([]);
    expect(manifest?.portal).toBe(true);
  });

  test("removes the field instead of writing it false, which the validation refuses", () => {
    const removedSlug = JSON.parse(setPortal(setPortal(OPEN, true), false));
    expect("portal" in removedSlug).toBe(false);
  });

  test("a round trip gives back the original file", () => {
    expect(setPortal(setPortal(OPEN, true), false)).toBe(`${OPEN}\n`);
  });

  test("idempotent in both directions", () => {
    for (const raw of [OPEN, EXEMPTED]) {
      for (const active of [true, false]) {
        const once = setPortal(raw, active);
        expect(setPortal(once, active)).toBe(once);
      }
    }
    expect(setPortal(EXEMPTED, true)).toBe(`${EXEMPTED}\n`);
  });

  test("keeps portalExempt, and a door laid down again comes back in its place", () => {
    // Removing the exemptions together with the door would silently close the
    // provider's webhook the moment the door was laid down again.
    const removedSlug = setPortal(EXEMPTED, false);
    expect(JSON.parse(removedSlug).portalExempt).toEqual(["/webhooks/*"]);
    expect(setPortal(removedSlug, true)).toBe(`${EXEMPTED}\n`);
  });

  test("touches nothing else", () => {
    const before = JSON.parse(EXEMPTED);
    const after = JSON.parse(setPortal(EXEMPTED, false));
    delete before.portal;
    expect(after).toEqual(before);
    expect(Object.keys(after)).toEqual(Object.keys(before));
  });

  test("refuses what is not a manifest", () => {
    expect(() => setPortal("[]", true)).toThrow();
    expect(() => setPortal("null", false)).toThrow();
    expect(() => setPortal("", true)).toThrow();
  });
});

/**
 * The switch of a site onto its domain, written by `sitesolide domain`. As for
 * the lock, what decides lives here: the command reads the DNS, deposits and
 * regenerates, but it is this function that touches the versioned file.
 */
describe("setDomainActive", () => {
  const INACTIVE = JSON.stringify(
    { slug: "acme", publicDir: "public", domain: { name: "acme.example", active: false }, lock: true },
    null,
    2,
  );

  test("switches the field without touching the rest", () => {
    const active = JSON.parse(setDomainActive(INACTIVE, true));
    expect(active.domain).toEqual({ name: "acme.example", active: true });
    // The preview lock does not follow the domain: a site can serve its domain
    // and keep its preview closed, which bin/lock.sh recalls by refusing to
    // close a site that is already active.
    expect(active.lock).toBe(true);
  });

  test("a round trip gives back the original file", () => {
    expect(setDomainActive(setDomainActive(INACTIVE, true), false)).toBe(`${INACTIVE}\n`);
  });

  test("writes the field even when false, unlike the lock", () => {
    // A `domain` without `active` reads as a forgotten switch; a manifest
    // without `lock` is simply an open site. The two absences do not say the
    // same thing, and neither do the two writings.
    const withoutField = JSON.stringify({ slug: "acme", domain: { name: "acme.example" } }, null, 2);
    expect(JSON.parse(setDomainActive(withoutField, false)).domain.active).toBe(false);
  });

  test("refuses a manifest without a domain", () => {
    // Without a domain there is nothing to switch, and manufacturing the block
    // here would let a name that nobody declared into the table.
    expect(() => setDomainActive('{"slug":"acme"}', true)).toThrow(/no domain/);
    expect(() => setDomainActive("[]", true)).toThrow();
  });

  test("gives back a manifest that the CLI still accepts", () => {
    const { manifest, errors } = readManifest(setDomainActive(INACTIVE, true));
    expect(errors).toEqual([]);
    expect(manifest?.domain?.active).toBe(true);
  });
});

describe("environment variables", () => {
  test("accepted when they have nothing to hide", () => {
    expect(validate({ ...APP, env: { NODE_ENV: "production" } })).toEqual([]);
  });

  test("refuses the ones the deployment lays down itself", () => {
    // A value from the manifest would make the service write somewhere other
    // than in its own folder.
    for (const key of ["PORT", "DATA_DIR", "PUBLIC_DIR"]) {
      expect(validate({ ...APP, env: { [key]: "x" } })).toContainEqual(
        expect.stringContaining(key),
      );
    }
  });

  test("refuses what looks like a secret", () => {
    // This file is versioned: what hides lives on the VM, managed from the
    // dashboard. The check bears on the name, since nobody can recognise a
    // secret by its shape and everybody recognises a key named API_KEY.
    for (const key of ["API_KEY", "STRIPE_SECRET", "AWS_SESSION_TOKEN", "DB_PASSWORD"]) {
      expect(validate({ ...APP, env: { [key]: "x" } })).toContainEqual(
        expect.stringContaining("managed from the dashboard"),
      );
    }
  });

  test("refuses a name that is not one", () => {
    expect(validate({ ...APP, env: { "my-var": "x" } })).toContainEqual(
      expect.stringContaining("env"),
    );
  });

  test("refuses variables without a service to read them", () => {
    expect(validate({ ...STATIC, env: { NODE_ENV: "production" } })).toContainEqual(
      expect.stringContaining("env"),
    );
  });
});

describe("the site's headers", () => {
  test("accepted", () => {
    expect(
      validate({ ...APP, headers: { "Permissions-Policy": "microphone=(self)" } }),
    ).toEqual([]);
  });

  test("refuses a value that would inject a line", () => {
    expect(validate({ ...APP, headers: { "X-Test": "a\nb" } })).toContainEqual(
      expect.stringContaining("line break"),
    );
  });

  test("refuses a noindex on a project that has a domain", () => {
    // The headers are laid in the routes snippet, hence on every block: a
    // noindex would take the client's domain out of Google.
    const manifest = {
      ...APP,
      domain: { name: "sample-agency.example", active: true },
      headers: { "X-Robots-Tag": "noindex" },
    };
    expect(validate(manifest)).toContainEqual(expect.stringContaining("indexed"));
  });

  test("allows it without a domain, where it only holds for the preview", () => {
    expect(
      validate({ ...APP, headers: { "X-Robots-Tag": "noindex, nofollow, noarchive" } }),
    ).toEqual([]);
  });
});

describe("description", () => {
  test("refuses a multiline description", () => {
    expect(validate({ ...APP, description: "a\nb" })).toContainEqual(
      expect.stringContaining("description"),
    );
  });
});

describe("portal", () => {
  const PROTECTED: Manifest = { ...APP, portal: true };

  test("a protected application site passes, with or without an exemption", () => {
    expect(validate(PROTECTED)).toEqual([]);
    expect(validate({ ...PROTECTED, portalExempt: ["/webhooks/*", "/callbacks/state"] })).toEqual([]);
  });

  test("portal is written true or is not written at all", () => {
    expect(validate({ ...APP, portal: false })).toContainEqual(expect.stringContaining("portal"));
  });

  test("refuses the combinations that would not hold", () => {
    for (const [manifest, expected] of [
      [{ ...STATIC, portal: true }, "start"],
      [{ ...PROTECTED, lock: true }, "lock"],
      [{ ...PROTECTED, domain: { name: "example.test" } }, "domain"],
      [{ ...PROTECTED, slug: "portal" }, "itself"],
    ] as const) {
      expect(validate(manifest)).toContainEqual(expect.stringContaining(expected));
    }
  });

  test("exemptions without a portal are kept in reserve, and judged all the same", () => {
    // The shape left by a portal removed from the dashboard: without a door,
    // they do nothing, and the door laid down again reopens the same paths.
    expect(validate({ ...APP, portalExempt: ["/webhooks/*"] })).toEqual([]);
    for (const path of ["/", "/_portal/connexion", "/../x"]) {
      expect(validate({ ...APP, portalExempt: [path] })).toContainEqual(expect.stringContaining("portalExempt"));
    }
    expect(validate({ ...APP, portalExempt: "/webhooks/*" } as unknown as Manifest)).toContainEqual(
      expect.stringContaining("a list of paths"),
    );
  });

  test("refuses an exemption that would open everything or break the matcher", () => {
    for (const path of ["/", "/*", "*", "webhooks/*", "/_portal/connexion", "/a b", '/a"', "/{x}", "/../x", ""]) {
      expect(validate({ ...PROTECTED, portalExempt: [path] })).toContainEqual(expect.stringContaining("portalExempt"));
    }
  });

  test("an unknown key is refused: a typo would open the site", () => {
    const errors = validate({ ...APP, portall: true } as unknown as Manifest);
    expect(errors).toContainEqual(expect.stringContaining("portall"));
  });
});
