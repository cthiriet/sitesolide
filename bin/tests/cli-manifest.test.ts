import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { knownManifests } from "./manifests";
import {
  isInternalPath,
  isApp,
  domainHosts,
  missingExclusions,
  readManifest,
  setDomainActive,
  setPortal,
  setLock,
  isValidSlug,
  validate,
  buildEnvOf,
  FILE_NAME_SHAPE,
  FRAMEWORK_PUBLIC_PREFIXES,
  hasStore,
  isFrameworkPublic,
  isValidFileName,
  MAX_DECLARED_FILES,
  NOT_A_PLACEHOLDER,
  RESERVED_ENV,
  secretsOf,
  STORELESS_SLUGS,
  FIRST_BLOCK,
  inLaterBlock,
  isServicePort,
  portRangeText,
  SERVICE_PORT_RANGES,
  servicePortsProse,
  type Manifest,
} from "../cli/manifest";
import { RESERVED_ENV as VARIABLES_RESERVED_ENV } from "../cli/variables";
import { CONNECTORS_PORT, EGRESS_PROXY_PORT } from "../cli/egress";
import { CADDY_ADMIN_PORT } from "../cli/loopback";
import { TUNNEL_METRICS } from "../cli/tunnel";
import { domainForms, isValidDomain as isValidDomainApi, isValidSlug as isValidSlugApi } from "../../api/src/table";

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

  test("refuses the name the machine's own state is backed up under", () => {
    // Its snapshots would mix with those of the secrets, which no page restores.
    expect(validate({ ...APP, slug: "machine" })).toEqual([expect.stringContaining("reserved for the backups of the machine's own state")]);
    expect(validate({ ...APP, slug: "machines" })).toEqual([]);
  });

  test("refuses the name of a service the machine runs, which deploy would replace", () => {
    // caddy.service lives in /lib/systemd/system: deploy, seeing no file in
    // /etc, would lay one there, and the next restart would take every site
    // down. www is the landing's, which serves www.<zone>.
    for (const slug of ["caddy", "ssh", "sshd", "dbus", "cron", "nftables", "networking", "www", "systemd-journald", "systemd-x", "sitesolide-steward", "sitesolide-anything"]) {
      expect({ slug, errors: validate({ ...APP, slug }) }).toEqual({ slug, errors: [expect.stringContaining("a name the machine already uses")] });
    }
    // A name that merely starts like one is a project like any other.
    for (const slug of ["caddy-notes", "my-ssh", "crontab-ui", "systemd", "sitesolide", "wwwx", "public-notes"]) {
      expect(validate({ ...APP, slug })).toEqual([]);
    }
  });

  test("refuses public, whose folder a host with an empty first label would serve whole", () => {
    // `Host: .<zone>` matches the wildcard block with an empty slug label:
    // its root, /srv/sites//public, cleans to /srv/sites/public, which would
    // be the root folder of a project named public, its manifest and code
    // served past any lock.
    expect(validate({ ...APP, slug: "public" })).toEqual([expect.stringContaining("a name the machine already uses")]);
  });

  test("demands a port as soon as a start is declared", () => {
    expect(validate({ slug: "budget", start: "bun run server.ts" })).toContainEqual(
      expect.stringContaining("port"),
    );
    expect(validate({ ...APP, port: 80 })).toContainEqual(expect.stringContaining("inside 3000 to 3099 or 21000 to 29999"));
  });

  test("holds an app's port to the blocks the loopback rule closes, as a service's", () => {
    // Outside them, every project of the machine reaches the app directly,
    // past its portal or its code: the rule judges who connects to the
    // blocks alone. Between them included: 3100 to 20999 is nobody's.
    for (const port of [2999, 3100, 3128, 4000, 8080, 19999, 20000, 20240, 20999, 30000, 32768, 65535]) {
      expect(validate({ ...APP, port })).toEqual([expect.stringContaining("port: inside 3000 to 3099 or 21000 to 29999")]);
    }
    for (const port of [3000, 3099, 21000, 25000, 29999]) expect(validate({ ...APP, port })).toEqual([]);
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

  test("refuses a secret that would be a path or a file: a secret is a variable's name", () => {
    for (const secret of ["../ses.env", "sub/folder.env", "/etc/passwd", "my-api.env"]) {
      expect(validate({ ...APP, secrets: [secret] })).toContainEqual(
        expect.stringContaining("secrets"),
      );
    }
    expect(validate({ ...APP, secrets: ["MY_API_KEY"] })).toEqual([]);
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

  test("an alias in the served zone is refused: it would take another site's preview", () => {
    for (const alias of [ZONE, `notes.${ZONE}`, `www.notes.${ZONE}`]) {
      expect(validate({ ...STATIC, domain: { name: "sample-agency.example", aliases: [alias] } }, ZONE)).toContainEqual(expect.stringContaining(`"${alias}" is in the ${ZONE} zone`));
    }
    expect(validate({ ...STATIC, domain: { name: "sample-agency.example", aliases: ["www.sample-agency.example"] } }, ZONE)).toEqual([]);
  });

  test("every domain accepted here is accepted by api/src/table.ts", () => {
    const name = "sample-agency.example";
    expect(validate({ ...STATIC, domain: { name: name } })).toEqual([]);
    expect(isValidDomainApi(name)).toBe(true);
  });

  test("a domain's names are the forms the table certifies and routes, its own first", () => {
    // A name the table carries and no block claims would fall into the
    // nameless block of static files.
    const domain = { name: "sample-agency.example", aliases: ["sample-agency.test", "shop.sample-agency.example", "www.sample-agency.example"] };
    const table = [domain.name, ...domain.aliases].flatMap(domainForms);
    expect(domainHosts(domain)).toEqual([...new Set(table)]);
    expect(domainHosts(domain)[0]).toBe("sample-agency.example");
    expect(domainHosts({ name: "shop.sample-agency.example" })).toEqual(["shop.sample-agency.example"]);
  });
});

describe("reading", () => {
  test("an unreadable JSON gives back an error, never an exception", () => {
    const { manifest, errors } = readManifest("{ not json");
    expect(manifest).toBeUndefined();
    expect(errors[0]).toContain("unreadable");
  });

  test("an unreadable JSON never quotes the file back: it may be a link to a secret", () => {
    // Bun's parser names the word it stopped at.
    const [error] = readManifest(`sst_${"S".repeat(43)}\n`).errors;
    expect(error).toStartWith("sitesolide.json is unreadable: ");
    expect(error).not.toContain("sst_");
    // What was expected, a punctuation mark, is still said.
    expect(readManifest('{"slug": "x"').errors[0]).toContain("'}'");
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

  test("refuses what looks like a secret, and points to secrets", () => {
    // This file is versioned: what hides is named under `secrets` and set on
    // the server. The check bears on the name first, since everybody
    // recognises a key named API_KEY.
    for (const key of ["API_KEY", "STRIPE_SECRET", "AWS_SESSION_TOKEN", "DB_PASSWORD", "STRIPE_KEY"]) {
      expect(validate({ ...APP, env: { [key]: "x" } })).toEqual([
        `env: ${key} looks like a secret: list its name under "secrets" and set its value on the server, never in a committed file`,
      ]);
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
  test("refused on a static site, which has no Caddy block to carry them, rather than ignored", () => {
    expect(validate({ ...STATIC, headers: { "X-Frame-Options": "DENY" } })).toEqual([
      expect.stringContaining("headers: only an app has a Caddy block of its own"),
    ]);
    expect(validate({ ...APP, headers: { "X-Frame-Options": "DENY" } })).toEqual([]);
  });

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

  test("refuses a Caddy placeholder, which Caddy would fill with its own secrets", () => {
    // Since the control API, whoever holds a team token writes this. Caddy
    // substitutes {$NAME} while reading the configuration and {env.NAME} at
    // each request: either one served the Cloudflare token to anyone.
    for (const value of [
      "{$CLOUDFLARE_API_TOKEN}",
      "{env.CLOUDFLARE_API_TOKEN}",
      "x {http.request.header.Cookie} y",
      "$CLOUDFLARE_API_TOKEN",
      "{",
      "}",
    ]) {
      expect(validate({ ...APP, headers: { "X-Leak": value } })).toContainEqual(expect.stringContaining("placeholders"));
    }
  });

  test("refuses what would end the quoted value and write directives", () => {
    for (const value of ['a" \n\trespond "owned', 'a"', "a\\", "`a`", "a\tb", "a\u007fb", "café", "a\u0000b"]) {
      expect(validate({ ...APP, headers: { "X-Test": value } })).toContainEqual(expect.stringContaining("headers"));
    }
  });

  test("keeps what real headers use: quotes of a CSP, semicolons, colons, slashes, commas", () => {
    const headers = {
      "Content-Security-Policy": "default-src 'self'; script-src 'self' https://cdn.example.com 'sha256-AbC+/9=='; img-src data: blob: *; frame-ancestors 'none'",
      "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
      Link: "</style.css>; rel=preload; as=style",
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
      "Cache-Control": "public, max-age=60, stale-while-revalidate=30",
      "X-Note": "100% #1 & more ~ | ^ [ok] ! ? @ = +",
      "X-Empty": "",
    };
    expect(validate({ ...APP, headers })).toEqual([]);
  });

  test("a header name is letters, digits and dashes: no operator Caddy would read", () => {
    for (const name of ["+X-Test", "-Server", "?Cache-Control", ">X", "X{$A}", "X Test", "X:Test", "X_Test", "1X", ""]) {
      expect(validate({ ...APP, headers: { [name]: "x" } })).toContainEqual(expect.stringContaining("header name"));
    }
    expect(validate({ ...APP, headers: { "X-Frame-Options": "DENY" } })).toEqual([]);
  });

  test("an object, and nothing else", () => {
    for (const headers of ["X-Test: a", ["X-Test"], null]) {
      expect(validate({ ...APP, headers } as unknown as Manifest)).toContainEqual(expect.stringContaining("an object naming each header"));
    }
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

  test("refuses a control character, and a backslash that would continue the line", () => {
    for (const description of ["a\tb", "a\rb", "a\u0085b", "notes\\", "notes\\  "]) {
      expect(validate({ ...APP, description })).toContainEqual(expect.stringContaining("description"));
    }
    expect(validate({ ...APP, description: "Bob's notes, 100% local (beta): a \\ b" })).toEqual([]);
  });
});

describe("what reaches a Caddy block or a unit", () => {
  // Until the control API, only the machine's owner wrote manifests. A team
  // token writes them now, and every string below lands in a generated Caddy
  // block or systemd unit: these are the refusals that keep it a string.

  test("a top-level route is a path, as a service's: no line break, quote, brace or space", () => {
    for (const route of ['/x\n\theader Leak "{$CLOUDFLARE_API_TOKEN}"', "/x{env.CLOUDFLARE_API_TOKEN}", "/a b", '/a"', "/a}", "/_portal/x", "api"]) {
      expect(validate({ ...APP, publicDir: "public", routes: [route] })).toContainEqual(expect.stringContaining("routes"));
    }
    expect(validate({ ...APP, publicDir: "public", routes: "/api/*" } as unknown as Manifest)).toContainEqual(
      expect.stringContaining("a list of paths"),
    );
    expect(validate({ ...APP, publicDir: "public", routes: ["/", "/api/*", "/rapports/*", "/%7Euser"] })).toEqual([]);
  });

  test("a start never runs as root: no prefix systemd reads as an instruction", () => {
    // `+` and `!` run ExecStart with full privileges whatever User= says.
    for (const start of [
      "+/bin/sh -c id",
      "!/bin/sh -c id",
      "!!/bin/sh -c id",
      "@/bin/sh sh -c id",
      "-/bin/sh -c id",
      ":/bin/sh -c id",
      "|/bin/sh -c id",
      " +/bin/sh -c id",
      "/usr/local/bin/bun run server.ts ; +/bin/sh -c id",
      '"/opt/my app/run"',
    ]) {
      expect(validate({ ...APP, start })).toContainEqual(expect.stringContaining("run as root"));
      const services = { web: { start, port: 3040 } };
      expect(validate({ slug: "budget", services })).toContainEqual(expect.stringContaining("services.web.start"));
    }
  });

  test("a start holds on one line, and never ends with a continuation", () => {
    for (const start of ["/bin/app\nUser=root", "/bin/app\tx", "/bin/app\\", "/bin/app \\ "]) {
      expect(validate({ ...APP, start })).toContainEqual(expect.stringContaining("start"));
    }
  });

  test("a start keeps what systemd's command line means: quotes, $VAR, a % escaped by the generator", () => {
    for (const start of [
      "/usr/local/bin/bun run server.ts --port $PORT",
      "/bin/sh -c 'cd sub; exec /usr/local/bin/bun run a.ts'",
      "bun run server.ts",
      ".venv/bin/python -m uvicorn app:api",
      "/bin/date +%s",
    ]) {
      expect(validate({ ...APP, start })).toEqual([]);
    }
  });

  test("an env value is one word for systemd: no space, quote or backslash", () => {
    // `Environment=A=x DATA_DIR=/elsewhere` sets DATA_DIR, past the rule on
    // names that refuses it.
    for (const value of ["x DATA_DIR=/srv/sites/other/data", 'a"b', "a'b", "a\\b", "a\tb", "a b"]) {
      expect(validate({ ...APP, env: { NODE_ENV: value } })).toContainEqual(expect.stringContaining("NODE_ENV"));
      const services = { web: { start: "/bin/app", port: 3040, env: { NODE_ENV: value } } };
      expect(validate({ slug: "budget", services })).toContainEqual(expect.stringContaining("services.web.env"));
    }
    for (const value of ["https://{slug}.{zone}", "fake,hetzner,vultr", "100%", "$HOME", "a=b", "/srv/sites/{slug}/data/x.db"]) {
      expect(validate({ ...APP, env: { NODE_ENV: value } })).toEqual([]);
    }
  });

  test("a secret is a variable's name: nothing that adds a directive or expands", () => {
    for (const secret of ["BUDGET\nExecStartPre=+/bin/sh -c id", "A B", "%h", ".env", "-BUDGET", "BUDGET\\"]) {
      expect(validate({ ...APP, secrets: [secret] })).toContainEqual(expect.stringContaining("secrets"));
    }
    expect(validate({ ...APP, secrets: "BUDGET" } as unknown as Manifest)).toContainEqual(expect.stringContaining("a list of variable names"));
    expect(validate({ ...APP, secrets: ["BUDGET", "Budget_2"] })).toEqual([]);
  });

  test("a domain that is no object is refused, never thrown", () => {
    for (const domain of [null, "example.com", ["example.com"]]) {
      expect(validate({ ...APP, domain } as unknown as Manifest)).toContainEqual(expect.stringContaining("domain"));
    }
    expect(validate({ ...APP, domain: { name: "example.com", aliases: 5 } } as unknown as Manifest)).toContainEqual(
      expect.stringContaining("domain.aliases"),
    );
  });

  test("every manifest of the repository and of the sites repository still passes", () => {
    const repo = join(import.meta.dir, "..", "..");
    const folders = ["portal", "dashboard", "analytics", "examples/bun-app", "examples/static-site", "examples/background"];
    const projects = join(repo, "bin", "tests", "e2e", "projects");
    folders.push(...readdirSync(projects).map((name) => join("bin", "tests", "e2e", "projects", name)));
    for (const folder of folders) {
      const { errors } = readManifest(readFileSync(join(repo, folder, "sitesolide.json"), "utf8"));
      expect({ folder, errors }).toEqual({ folder, errors: [] });
    }
    for (const manifest of knownManifests()) expect({ slug: manifest.slug, errors: validate(manifest) }).toEqual({ slug: manifest.slug, errors: [] });
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
      [{ ...PROTECTED, slug: "portal" }, "itself"],
    ] as const) {
      expect(validate(manifest)).toContainEqual(expect.stringContaining(expected));
    }
  });

  test("a site behind the portal may serve its own domain: it is guarded there too", () => {
    expect(validate({ ...PROTECTED, domain: { name: "example.test", active: true } })).toEqual([]);
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

/**
 * What a planted secret value is: had a refusal quoted it back, it would have
 * reached a terminal, an agent's context or a log.
 */
const PLANTED = "sk_live_planted_value_never_quoted";

/** The refusals of a manifest, checked to quote none of the planted values. */
function refusals(manifest: unknown, planted: readonly string[] = [PLANTED]): string[] {
  const errors = validate(manifest as Manifest, ZONE);
  for (const error of errors) {
    for (const value of planted) expect({ error, quotes: error.includes(value) }).toEqual({ error, quotes: false });
  }
  return errors;
}

const SERVICES: Manifest = { slug: "engine", services: { api: { start: "/srv/sites/engine/app/api", port: 3040 } } };
const BUILT: Manifest = { slug: "blog", build: "bun run build", publicDir: "dist" };

describe("secrets, the forms", () => {
  test("none: absent, an empty list, an empty object", () => {
    for (const secrets of [undefined, [], {}]) {
      expect(secretsOf({ ...APP, secrets } as Manifest)).toEqual({ form: "none", runtime: [], files: [], build: [] });
    }
  });

  test("the short form lists runtime variables", () => {
    expect(secretsOf({ ...APP, secrets: ["ADMIN_TOKEN", "STRIPE_SECRET_KEY"] })).toEqual({
      form: "names",
      runtime: ["ADMIN_TOKEN", "STRIPE_SECRET_KEY"],
      files: [],
      build: [],
    });
  });

  test("the long form, each list optional", () => {
    const secrets = { runtime: ["POSTGRES_PASSWORD"], files: ["gcp.json", "tls.key"], build: ["CMS_TOKEN"] };
    expect(secretsOf({ ...APP, secrets })).toEqual({ form: "names", ...secrets });
    expect(secretsOf({ ...APP, secrets: { files: ["gcp.json"] } })).toEqual({ form: "names", runtime: [], files: ["gcp.json"], build: [] });
  });

  test("a list is names whatever it holds: a file's name in it is read as one, and validate refuses it", () => {
    expect(secretsOf({ ...APP, secrets: ["crm.env", "API_KEY"] })).toEqual({ form: "names", runtime: ["crm.env", "API_KEY"], files: [], build: [] });
  });

  test("malformed input never throws, and keeps what parses", () => {
    const empty = { runtime: [], files: [], build: [] };
    for (const secrets of ["budget.env", 3, null, true, [3, null], [[]]]) {
      expect(secretsOf({ ...APP, secrets } as unknown as Manifest)).toEqual({ form: "none", ...empty });
    }
    expect(secretsOf({ ...APP, secrets: ["A", 3] } as unknown as Manifest)).toEqual({ form: "names", ...empty, runtime: ["A"] });
    expect(secretsOf({ ...APP, secrets: { runtime: "A", files: [1, "x.pem"], other: ["B"] } } as unknown as Manifest)).toEqual({
      form: "names",
      ...empty,
      files: ["x.pem"],
    });
  });

  test("an app has a store, but a static site and the two storeless projects", () => {
    expect(hasStore(APP)).toBe(true);
    expect(hasStore(SERVICES)).toBe(true);
    expect(hasStore({ ...APP, slug: "analytics" })).toBe(true);
    expect(hasStore(STATIC)).toBe(false);
    expect(STORELESS_SLUGS).toEqual(["dashboard", "portal"]);
    for (const slug of STORELESS_SLUGS) expect(hasStore({ ...APP, slug })).toBe(false);
    for (const slug of ["../x", "", "Shop", 3]) expect(hasStore({ ...APP, slug } as unknown as Manifest)).toBe(false);
  });

  test("a store file's name: no leading dot, no slash, no .., 64 characters at most", () => {
    expect(FILE_NAME_SHAPE.source).toBe("^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$");
    for (const name of ["gcp.json", "tls.key", "a", "A-b_c.d", "x".repeat(64)]) expect(isValidFileName(name)).toBe(true);
    for (const name of ["", ".hidden", "-x", "_x", "sub/x", "a..b", "..", "x".repeat(65), "a b", "a%b", "é.pem", 3, null]) {
      expect({ name, valid: isValidFileName(name) }).toEqual({ name, valid: false });
    }
  });
});

describe("secrets, validation", () => {
  test("V1: a list of strings, or an object of three lists of strings", () => {
    const shape = 'secrets: a list of variable names, such as ["API_KEY"], or { "runtime": [...], "files": [...], "build": [...] }';
    for (const secrets of ["budget.env", 3, null, [PLANTED, 3], { runtime: [PLANTED], extra: [PLANTED] }, { runtime: PLANTED }, { files: [3] }]) {
      expect(refusals({ ...APP, secrets })).toEqual([shape]);
    }
    expect(refusals({ ...APP, secrets: { runtime: ["API_KEY"], files: ["gcp.json"] } })).toEqual([]);
  });

  test("V2: a file's name is no variable's: refused as any other entry that is not one, and never quoted", () => {
    expect(refusals({ ...APP, secrets: ["budget.env", "API_KEY"] }, ["budget.env"])).toEqual([
      "secrets: entry 1 is not a variable name: letters, digits and underscores, not starting with a digit, 128 characters at most",
    ]);
    expect(refusals({ ...APP, secrets: ["API_KEY", "budget-stripe.env", "nis2-stats.env"] })).toHaveLength(2);
  });

  test("V4: runtime names have a variable's shape, and are never quoted when they have not", () => {
    for (const name of ["1ABC", "A-B", "-----BEGIN PRIVATE KEY-----", "A".repeat(129), ""]) {
      expect(refusals({ ...APP, secrets: [name] }, [name || PLANTED])).toEqual([
        "secrets: entry 1 is not a variable name: letters, digits and underscores, not starting with a digit, 128 characters at most",
      ]);
    }
    for (const name of [PLANTED, "whsec_abc", "AKIAIOSFODNN7EXAMPLE", "pk_live_abc", "xoxb_abc"]) {
      expect(refusals({ ...APP, secrets: { runtime: ["API_KEY", name] } }, [name])).toEqual([
        "secrets.runtime: entry 2 starts like a secret key, not a variable name: a value never goes in sitesolide.json",
      ]);
    }
    expect(refusals({ ...APP, secrets: ["API_KEY", "a", "A".repeat(128)] })).toEqual([]);
  });

  test("V4: unique, not reserved, not the password hash, not set by env", () => {
    expect(refusals({ ...APP, secrets: ["API_KEY", "API_KEY"] })).toEqual(["secrets: API_KEY is listed twice"]);
    expect(refusals({ ...APP, secrets: ["PATH"] })).toEqual(["secrets: PATH changes how the runtime behaves, not what the site does, and cannot be set here"]);
    expect(refusals({ ...APP, secrets: ["NODE_OPTIONS", "http_proxy", "CREDENTIALS_DIRECTORY"] })).toHaveLength(3);
    for (const name of RESERVED_ENV) {
      expect(refusals({ ...APP, secrets: [name] })).toEqual([`secrets: ${name} is set by the deployment, a secret would move the service elsewhere`]);
    }
    expect(refusals({ ...APP, secrets: ["PASSWORD_HASH"] })).toEqual([
      "secrets: PASSWORD_HASH is changed with Change password, in the dashboard's and the portal's files alone",
    ]);
    expect(refusals({ ...APP, env: { API_URL: "https://x.test" }, secrets: ["API_URL"] })).toEqual(["secrets: API_URL is also set in env; a name lives in one place"]);
    const services = { api: { start: "/bin/api", port: 3040, env: { API_URL: "https://x.test" } } };
    expect(refusals({ slug: "engine", services, secrets: { runtime: ["API_URL"] } })).toEqual([
      "secrets.runtime: API_URL is also set in env; a name lives in one place",
    ]);
  });

  test("V4: no BACKUP_ name beside a backup command, any name beside none", () => {
    const backup = { folder: "pg", command: "/bin/sh /srv/sites/budget/app/backup.sh" };
    expect(refusals({ ...APP, backup, secrets: ["BACKUP_KEY"] })).toEqual([
      "secrets: BACKUP_KEY is a name of the backup component, which sets BACKUP_DIR for the backup command: no BACKUP_ variable beside one",
    ]);
    const services = { db: { start: "/usr/bin/postgres", internal: true, backup } };
    expect(refusals({ slug: "engine", services, publicDir: "public", secrets: ["BACKUP_KEY"] })).toHaveLength(1);
    expect(refusals({ ...APP, secrets: ["BACKUP_KEY"] })).toEqual([]);
  });

  test("V5: file names are a store file's, unique, 32 at most, and never quoted when they are not one", () => {
    for (const name of [".hidden", "sub/x", "a..b", "x".repeat(65), `${PLANTED} x`]) {
      expect(refusals({ ...APP, secrets: { files: [name] } }, [name, PLANTED])).toEqual([
        "secrets.files: entry 1 is not a file name: a letter or a digit first, then letters, digits, dots, dashes and underscores, 64 characters at most, no ..",
      ]);
    }
    expect(refusals({ ...APP, secrets: { files: ["gcp.json", "gcp.json"] } })).toEqual(["secrets.files: gcp.json is listed twice"]);
    const many = Array.from({ length: MAX_DECLARED_FILES + 1 }, (_, rank) => `f${rank}.pem`);
    expect(refusals({ ...APP, secrets: { files: many } })).toEqual([`secrets.files: ${MAX_DECLARED_FILES} files at most, systemd loads a bounded amount for each unit`]);
    expect(refusals({ ...APP, secrets: { files: many.slice(0, MAX_DECLARED_FILES) } })).toEqual([]);
  });

  test("V6: a static site has no runtime secret nor file; its build's go under secrets.build", () => {
    const refusal = "secrets: without start, no service reads a runtime secret; a value the build needs goes under secrets.build";
    for (const secrets of [["CMS_TOKEN"], { runtime: ["CMS_TOKEN"] }, { files: ["gcp.json"] }, { runtime: ["CMS_TOKEN"], build: ["CMS_TOKEN"] }]) {
      expect(refusals({ ...BUILT, secrets })).toEqual([refusal]);
    }
    expect(refusals({ ...BUILT, secrets: { build: ["CMS_TOKEN"] } })).toEqual([]);
    expect(refusals({ ...STATIC, secrets: ["notes.env"] })).toEqual([refusal]);
  });

  test("V7: build names, taken from whoever deploys: not sitesolide's, not inherited, not in env, only with a build", () => {
    expect(refusals({ ...BUILT, secrets: { build: ["SITESOLIDE_TOKEN"] } })).toEqual([
      "secrets.build: SITESOLIDE_TOKEN is sitesolide's own: a build never receives a SITESOLIDE_ variable",
    ]);
    for (const name of ["PATH", "HOME", "LC_ALL", "XDG_CONFIG_HOME"]) {
      expect(refusals({ ...BUILT, secrets: { build: [name] } })).toEqual([`secrets.build: ${name} reaches every build from whoever deploys already: it needs no declaring`]);
    }
    expect(refusals({ ...BUILT, secrets: { build: ["CMS_TOKEN", "CMS_TOKEN"] } })).toEqual(["secrets.build: CMS_TOKEN is listed twice"]);
    expect(refusals({ ...BUILT, env: { CMS_URL: "https://cms.test" }, secrets: { build: ["CMS_URL"] } })).toEqual([
      "secrets.build: CMS_URL is also set in env; a name lives in one place",
    ]);
    expect(refusals({ ...BUILT, secrets: { build: ["a-b", PLANTED] } })).toEqual([
      "secrets.build: entry 1 is not a variable name: letters, digits and underscores, not starting with a digit, 128 characters at most",
      "secrets.build: entry 2 starts like a secret key, not a variable name: a value never goes in sitesolide.json",
    ]);
    expect(refusals({ ...APP, secrets: { build: ["CMS_TOKEN"] } })).toEqual(["secrets.build: without build, nothing reads them"]);
    expect(refusals({ ...APP, build: "bun run build", secrets: { runtime: ["CMS_TOKEN"], build: ["CMS_TOKEN", "NPM_TOKEN"] } })).toEqual([]);
  });

  test("V8: the dashboard and the portal declare no secret: their units read their own file", () => {
    for (const slug of STORELESS_SLUGS) {
      const app = { ...APP, slug };
      const refusal = `secrets: ${slug} keeps its password hash in ${slug}.env, which its unit reads: it declares no secret`;
      expect(refusals({ ...app, secrets: ["API_KEY"] })).toEqual([refusal]);
      expect(refusals({ ...app, secrets: { files: ["x.pem"] } })).toEqual([refusal]);
      // Its own file named as before is refused alike: the unit names it, the manifest does not.
      expect(refusals({ ...app, secrets: [`${slug}.env`] })).toEqual([refusal]);
      expect(refusals(app)).toEqual([]);
    }
  });

  test("V9: a framework's public name may sit in env, whatever its suffix", () => {
    expect(FRAMEWORK_PUBLIC_PREFIXES).toEqual(["NEXT_PUBLIC_", "NUXT_PUBLIC_", "EXPO_PUBLIC_", "REACT_APP_", "VITE_", "PUBLIC_", "GATSBY_"]);
    for (const name of ["NEXT_PUBLIC_STRIPE_KEY", "VITE_STRIPE_KEY", "PUBLIC_MAPS_TOKEN", "REACT_APP_API_KEY"]) {
      expect(isFrameworkPublic(name)).toBe(true);
      expect(refusals({ ...APP, env: { [name]: "pk_live_51Hx" } })).toEqual([]);
    }
    expect(isFrameworkPublic("STRIPE_KEY")).toBe(false);
    expect(refusals({ ...APP, env: { STRIPE_KEY: "x" } })).toHaveLength(1);
  });

  test("V9: a value that starts like a secret key is refused under any name, and never quoted", () => {
    for (const value of ["sk_live_x", "whsec_x", "sk-proj-x", "AKIAx", "ghp_x", "glpat-x", "SG.x", PLANTED]) {
      expect(refusals({ ...APP, env: { REGION: value } }, [value])).toEqual([
        "env: the value of REGION starts like a secret key; a secret goes in secrets, never in a committed file",
      ]);
      const services = { api: { start: "/bin/api", port: 3040, env: { NEXT_PUBLIC_X: value } } };
      expect(refusals({ slug: "engine", services }, [value])).toEqual([
        "services.api.env: the value of NEXT_PUBLIC_X starts like a secret key; a secret goes in secrets, never in a committed file",
      ]);
    }
    for (const value of ["pk_live_x", "pk_test_x", "production", "SK_LIVE", "eu-west-3"]) {
      expect(refusals({ ...APP, env: { REGION: value } })).toEqual([]);
    }
  });

  test("V9: a static site may declare env when it builds, not otherwise", () => {
    expect(refusals({ ...BUILT, env: { PUBLIC_SITE_URL: "https://{slug}.{zone}" } })).toEqual([]);
    expect(refusals({ ...STATIC, env: { NODE_ENV: "production" } })).toEqual(["env: without start or build, nothing reads these variables"]);
  });

  test("V10: {credentials} is not a placeholder, in env, a start or a backup command", () => {
    expect(NOT_A_PLACEHOLDER).toBe("{credentials}");
    const reading = "{credentials} is not replaced; a service reads its files at $CREDENTIALS_DIRECTORY/files_<name>";
    expect(refusals({ ...APP, env: { GCP_KEY_FILE: "{credentials}/files_gcp.json" } })).toEqual([`env: ${reading}`]);
    expect(refusals({ ...APP, start: "/bin/app --key {credentials}/files_tls.key" })).toEqual([`start: ${reading}`]);
    const backup = { folder: "pg", command: "/bin/sh /srv/sites/budget/app/backup.sh {credentials}" };
    expect(refusals({ ...APP, backup })).toEqual([`backup.command: ${reading}`]);
    const services = {
      api: { start: "/bin/api --tls {credentials}/files_tls.key", port: 3040, env: { CERT: "{credentials}" } },
      db: { start: "/usr/bin/postgres", internal: true, backup: { ...backup, command: "/bin/dump {credentials}" } },
    };
    expect(refusals({ slug: "engine", services })).toEqual([
      `services.api.start: ${reading}`,
      `services.api.env: ${reading}`,
      `services.db.backup.command: ${reading}`,
    ]);
    // The variable systemd sets is the way, on a command line as in code.
    expect(refusals({ ...APP, start: "/bin/app --key ${CREDENTIALS_DIRECTORY}/files_tls.key" })).toEqual([]);
  });

  test("the forms of the specification pass as written", () => {
    expect(
      refusals({
        slug: "shop",
        start: "/usr/local/bin/bun run server.ts",
        port: 3040,
        env: { NODE_ENV: "production", VITE_STRIPE_KEY: "pk_live_51Hx", PUBLIC_URL: "https://{slug}.{zone}" },
        secrets: ["ADMIN_TOKEN", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
      }),
    ).toEqual([]);
    expect(
      refusals({
        slug: "engine",
        services: {
          api: { start: "/srv/sites/engine/app/.venv/bin/uvicorn main:app --port 3040", port: 3040 },
          postgres: { start: "/usr/lib/postgresql/17/bin/postgres -D /srv/sites/engine/data/pg", internal: true, backup: { folder: "pg", command: "/bin/sh /srv/sites/engine/app/backup.sh" } },
        },
        build: "uv sync",
        secrets: { runtime: ["POSTGRES_PASSWORD", "HCLOUD_TOKEN"], files: ["gcp.json", "tls.key"], build: ["CMS_TOKEN"] },
      }),
    ).toEqual([]);
    expect(refusals({ ...BUILT, env: { PUBLIC_SITE_URL: "https://{slug}.{zone}" }, secrets: { build: ["CMS_TOKEN"] } })).toEqual([]);
    expect(refusals({ ...APP, slug: "dashboard" })).toEqual([]);
  });

  test("RESERVED_ENV lives in variables.ts, re-exported here", () => {
    expect(RESERVED_ENV).toBe(VARIABLES_RESERVED_ENV);
    expect(RESERVED_ENV).toEqual(["PORT", "DATA_DIR", "PUBLIC_DIR"]);
  });
});

describe("the build's env", () => {
  test("the project's env, raw, without its SITESOLIDE_ names and without a service's", () => {
    const manifest: Manifest = {
      slug: "dashboard",
      services: { web: { start: "/bin/web", port: 3040, env: { SERVICE_ONLY: "x" } } },
      build: "bun run build",
      env: { NODE_ENV: "production", PUBLIC_URL: "https://{slug}.{zone}", SITESOLIDE_ZONE: "{zone}" },
    };
    expect(buildEnvOf(manifest)).toEqual([
      ["NODE_ENV", "production"],
      ["PUBLIC_URL", "https://{slug}.{zone}"],
    ]);
    expect(buildEnvOf(STATIC)).toEqual([]);
  });

  test("tolerant of what validate refuses", () => {
    for (const env of [null, "x", ["A=b"], 3]) expect(buildEnvOf({ ...APP, env } as unknown as Manifest)).toEqual([]);
    expect(buildEnvOf({ ...APP, env: { A: "b", B: 3 } } as unknown as Manifest)).toEqual([["A", "b"]]);
  });
});

describe("the services' blocks", () => {
  test("two, the first the one every machine in service has, in order and apart", () => {
    expect(SERVICE_PORT_RANGES).toEqual([
      { first: 3000, last: 3099 },
      { first: 21000, last: 29999 },
    ]);
    expect(FIRST_BLOCK).toBe(SERVICE_PORT_RANGES[0]!);
    for (const [index, range] of SERVICE_PORT_RANGES.entries()) {
      expect(range.first).toBeLessThanOrEqual(range.last);
      if (index > 0) expect(range.first).toBeGreaterThan(SERVICE_PORT_RANGES[index - 1]!.last + 1);
    }
    expect(SERVICE_PORT_RANGES.map(portRangeText)).toEqual(["3000-3099", "21000-29999"]);
    expect(servicePortsProse()).toBe("3000 to 3099 or 21000 to 29999");
  });

  test("a port of either block is a service's, one of the second block a late one", () => {
    for (const port of [3000, 3050, 3099, 21000, 25000, 29999]) expect(isServicePort(port)).toBe(true);
    for (const port of [2019, 2999, 3100, 3128, 3129, 19999, 20999, 30000, 3000.5, Number.NaN]) expect(isServicePort(port)).toBe(false);
    expect([3000, 3099].map(inLaterBlock)).toEqual([false, false]);
    expect([21000, 29999].map(inLaterBlock)).toEqual([true, true]);
    expect([3100, 30000].map(inLaterBlock)).toEqual([false, false]);
  });

  test("the ports with rules of their own stay outside: Caddy's admin API, the egress proxy, the tunnel's metrics", () => {
    // Inside a block, the API would be reachable by whoever the block lets
    // through, and the proxy unreachable by the projects that need it.
    for (const port of [CADDY_ADMIN_PORT, EGRESS_PROXY_PORT, CONNECTORS_PORT]) expect(isServicePort(port)).toBe(false);
    // The monitor reads the connector's metrics as its own account, which a
    // block would refuse it; cloudflared takes 20241 to 20245 by default.
    const metrics = Number(TUNNEL_METRICS.split(":")[1]);
    for (let port = 20240; port <= 20245; port++) expect(isServicePort(port)).toBe(false);
    expect(isServicePort(metrics)).toBe(false);
  });

  test("below Linux's ephemeral ports, which an outgoing connection takes as its source", () => {
    for (const range of SERVICE_PORT_RANGES) expect(range.last).toBeLessThan(32768);
  });

  test("a service's port of the second block is accepted, one between the blocks refused", () => {
    const lab = (port: number): Manifest => ({ slug: "lab", services: { web: { start: "/x", port }, api: { start: "/y", port: 3051, routes: ["/v1/*"] } } });
    expect(validate(lab(21000))).toEqual([]);
    expect(validate(lab(29999))).toEqual([]);
    for (const port of [3100, 3128, 19999, 30000]) {
      expect(validate(lab(port))).toEqual([expect.stringContaining("services.web.port: inside 3000 to 3099 or 21000 to 29999")]);
    }
  });
});
