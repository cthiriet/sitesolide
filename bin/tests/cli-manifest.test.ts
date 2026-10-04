import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { knownManifests } from "./manifests";
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

  test("refuses the name of a service the machine runs, which deploy would replace", () => {
    // caddy.service lives in /lib/systemd/system: deploy, seeing no file in
    // /etc, would lay one there, and the next restart would take every site
    // down. www is the landing's, which serves www.<zone>.
    for (const slug of ["caddy", "ssh", "sshd", "dbus", "cron", "nftables", "networking", "www", "systemd-journald", "systemd-x", "sitesolide-steward", "sitesolide-anything"]) {
      expect({ slug, errors: validate({ ...APP, slug }) }).toEqual({ slug, errors: [expect.stringContaining("a name the machine already uses")] });
    }
    // A name that merely starts like one is a project like any other.
    for (const slug of ["caddy-notes", "my-ssh", "crontab-ui", "systemd", "sitesolide", "wwwx"]) {
      expect(validate({ ...APP, slug })).toEqual([]);
    }
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

  test("a secret is a plain file name: nothing that adds a directive or expands", () => {
    for (const secret of ["budget.env\nExecStartPre=+/bin/sh -c id", "a b.env", "%h.env", ".env", "-budget.env", "budget.env\\"]) {
      expect(validate({ ...APP, secrets: [secret] })).toContainEqual(expect.stringContaining("secrets"));
    }
    expect(validate({ ...APP, secrets: "budget.env" } as unknown as Manifest)).toContainEqual(expect.stringContaining("a list of file names"));
    expect(validate({ ...APP, secrets: ["budget.env", "Budget_2.env"] })).toEqual([]);
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
    const folders = ["portal", "dashboard", "analytics", "examples/bun-app", "examples/static-site"];
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
