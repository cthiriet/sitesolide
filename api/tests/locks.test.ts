import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODE_ALPHABET,
  isValidCode,
  buildFragment,
  generateCode,
  previewHost,
  CODE_LENGTH,
  cookieName,
  isValidLockSlug,
  stanza,
} from "../src/locks";

/** Deterministic randomness source: the byte sequence is imposed by the test. */
function bytes(...values: number[]) {
  return (n: number) => Uint8Array.from({ length: n }, (_, i) => values[i % values.length]!);
}

describe("generateCode", () => {
  test("renders six characters, all taken from the alphabet", () => {
    const code = generateCode();
    expect(code).toHaveLength(CODE_LENGTH);
    for (const char of code) expect(CODE_ALPHABET).toInclude(char);
  });

  test("the alphabet sets aside the characters confused when spoken", () => {
    // The code gets dictated over the phone: O against 0, I against 1.
    for (const confusable of ["O", "I", "0", "1"]) expect(CODE_ALPHABET).not.toInclude(confusable);
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length);
  });

  test("brings every byte back into the alphabet, high values included", () => {
    // 0 -> A, 1 -> B, 31 -> 9, then the values beyond 31 go back through the
    // modulo: 32 -> A, 255 -> 9, 224 -> A.
    expect(generateCode(bytes(0, 1, 31, 32, 255, 224))).toBe("AB9A9A");
  });

  test("a large draw favors no character: 256 is a multiple of 32", () => {
    // The draw takes a byte and applies a modulo. If the size of the alphabet
    // did not divide 256, the first characters would come out more often and
    // the code would lose part of its entropy without anything flagging it.
    expect(256 % CODE_ALPHABET.length).toBe(0);

    const counts = new Map<string, number>();
    const draws = 20_000;
    for (let i = 0; i < draws; i++) {
      for (const char of generateCode()) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
      }
    }

    expect(counts.size).toBe(CODE_ALPHABET.length);
    const expected = (draws * CODE_LENGTH) / CODE_ALPHABET.length;
    for (const count of counts.values()) {
      // Wide margin: the test hunts a systematic bias, not randomness.
      expect(count).toBeGreaterThan(expected * 0.85);
      expect(count).toBeLessThan(expected * 1.15);
    }
  });

  test("refuses a randomness source that is too short rather than shortening the code", () => {
    expect(() => generateCode(() => new Uint8Array(3))).toThrow(/too short/);
  });
});

describe("isValidCode", () => {
  test("accepts a generated code", () => {
    expect(isValidCode(generateCode())).toBe(true);
  });

  test("refuses what is not exactly six characters of the alphabet", () => {
    for (const refuse of [
      "A7B2K", // too short
      "A7B2K99", // too long
      "a7b2k9", // lowercase
      "A7B2K0", // zero, outside the alphabet
      "A7B2KI", // I, outside the alphabet
      "A7B2 9", // space
      "A7B2K9\n", // line break, which would break the Set-Cookie
      "",
      undefined,
      null,
      123456,
    ]) {
      expect(isValidCode(refuse)).toBe(false);
    }
  });
});

describe("cookieName", () => {
  test("a slug with a dash gives a cookie name usable as is", () => {
    // The dash is a valid HTTP token character, and the placeholder
    // {http.request.cookie.lock_sample-wheels} was checked at runtime.
    expect(cookieName("sample-wheels")).toBe("lock_sample-wheels");
    expect(cookieName("agency")).toBe("lock_agency");
  });

  test("sets aside what has no place in a cookie name", () => {
    // The dot would cut the placeholder read by Caddy, the space and the
    // semicolon would break the Set-Cookie header.
    expect(cookieName("a.b")).toBe("lock_a_b");
    expect(cookieName("a b;c")).toBe("lock_a_b_c");
  });
});

describe("isValidLockSlug", () => {
  test("refuses what would escape the door pages folder or break a matcher", () => {
    expect(isValidLockSlug("sample-wheels")).toBe(true);
    expect(isValidLockSlug("agency")).toBe(true);
    expect(isValidLockSlug("..")).toBe(false);
    expect(isValidLockSlug("../etc")).toBe(false);
    expect(isValidLockSlug("Agency")).toBe(false);
    expect(isValidLockSlug("a.b")).toBe(false);
    expect(isValidLockSlug("-debut")).toBe(false);
    expect(isValidLockSlug("")).toBe(false);
  });
});

describe("stanza", () => {
  const rendered = stanza("sample-wheels", "sample-wheels.test-zone.invalid", "A7B2K9");

  test("opens with the header line that bin/lock.sh counts and searches for", () => {
    // bin/lock.sh counts the stanzas with grep -c '^# Preview lock:' and finds
    // a given site with grep -q "^# Preview lock: $name$". A header changed
    // without those two greps following would make "bin/lock.sh state" announce
    // every locked site as open, without a word.
    expect(rendered).toStartWith("# Preview lock: sample-wheels\n");
  });

  test("carries the code in the three places that decide", () => {
    expect(rendered).toInclude("query key=A7B2K9");
    expect(rendered).toInclude('lock_sample-wheels=A7B2K9; Path=/');
    expect(rendered).toInclude('{http.request.cookie.lock_sample-wheels} == "A7B2K9"');
  });

  test("suffixes the three matchers with the slug", () => {
    // Named matchers share a single namespace for the whole block, imports
    // included: two stanzas with the same name would make the entire
    // adaptation fail, therefore all of production.
    for (const matcher of ["@lock_host_", "@lock_key_", "@lock_open_"]) {
      expect(rendered).toInclude(`${matcher}sample-wheels`);
    }
  });

  test("uses handle, never route", () => {
    // Measured: with route, the right cookie branch is crossed then the
    // request falls back into the guard branch, and the legitimate visitor
    // gets a 401. Only handle is exclusive.
    expect(rendered).not.toInclude("route ");
    expect(rendered.match(/\bhandle\b/g)).toHaveLength(4);
  });

  test("leaves the right cookie handle empty", () => {
    // That emptiness is the mechanism: the request leaves the group with no
    // response written and reaches the file_server of the calling block, the
    // one of the real site. Placing a file_server or a respond there would
    // break the cohabitation.
    expect(rendered).toInclude('@lock_open_sample-wheels expression {http.request.cookie.lock_sample-wheels} == "A7B2K9"\n\thandle @lock_open_sample-wheels {\n\t}');
  });

  test("serves the door page with a 401, never a 200", () => {
    // Without the status subblock, file_server answers 200 and the door page
    // becomes indexable.
    expect(rendered).toInclude("file_server {\n\t\t\tstatus 401\n\t\t}");
    expect(rendered).toInclude("root * /srv/garde/sample-wheels");
    expect(rendered).toInclude("rewrite * /index.html");
  });

  test("overwrites the door page cache instead of completing it", () => {
    // The (commun) snippet sets its policy according to the REQUESTED path,
    // and header is sorted before handle: without an overwrite, the door page
    // served on /favicon.ico went back out as "immutable" for a year. The ?
    // prefix would set a default value, so it would change nothing: it must
    // not be there.
    expect(rendered).toInclude('header Cache-Control "no-store"');
    expect(rendered).not.toInclude("?Cache-Control");
    // On the guard, and on the redirect that sets the cookie.
    expect(rendered.match(/header Cache-Control "no-store"/g)).toHaveLength(2);
  });

  test("declaredNames that the response depends on the cookie, for the whole host", () => {
    // A shared cache ignoring it would serve to everyone what an authorized
    // visitor brought back. The header is set in the host handle, before the
    // three branches, so it also covers the real site while it is closed.
    expect(rendered).toInclude("handle @lock_host_sample-wheels {\n\t# The response depends on a cookie");
    expect(rendered).toInclude("header Vary Cookie");
  });

  test("redirects with the explicit matcher Caddy expects", () => {
    // "redir / 303" is a silent trap: the first token is read as a path
    // matcher and 303 becomes the destination URL.
    expect(rendered).toInclude("redir * / 303");
  });

  test("sets Secure by default, and knows how to drop it for an HTTP lab", () => {
    // On plain HTTP, a Secure cookie is not even recorded by the client: the
    // lock would never open.
    expect(rendered).toInclude("; Secure; HttpOnly; SameSite=Lax");
    expect(stanza("agency", "agency.test-zone.invalid", "A7B2K9", { secure: false })).toInclude(
      "; HttpOnly; SameSite=Lax",
    );
    expect(stanza("agency", "agency.test-zone.invalid", "A7B2K9", { secure: false })).not.toInclude("Secure");
  });

  test("follows the guard folder it is given", () => {
    expect(stanza("agency", "agency.test-zone.invalid", "A7B2K9", { doorPagesDir: "/var/garde" })).toInclude(
      "root * /var/garde/agency",
    );
  });
});

describe("buildFragment", () => {
  const locked = { slug: "agency", host: "agency.test-zone.invalid", lock: true, code: "A7B2K9" };

  test("writes no stanza for an unlocked site", () => {
    const fragment = buildFragment([
      { slug: "open", host: "open.test-zone.invalid", lock: false },
      { slug: "silent", host: "silent.test-zone.invalid" },
      // A value that looks true without being true does not lock either.
      { slug: "almost", host: "almost.test-zone.invalid", lock: "true" },
    ]);
    expect(fragment).not.toInclude("handle");
    expect(fragment).not.toInclude("open.test-zone.invalid");
  });

  test("interrupts everything when a code is in force without a lock asked for", () => {
    // The other direction of the same rule, and the most insidious path: the
    // manifest is versioned, the code is not. A sitesolide.json returned to
    // its original form then redeployed erases the intent while leaving the
    // code, and the next regeneration would reopen the site silently. It
    // fails.
    for (const lock of [false, undefined, "true", 1]) {
      expect(() =>
        buildFragment([{ slug: "agency", host: "agency.test-zone.invalid", lock, code: "A7B2K9" }]),
      ).toThrow(/no longer asks for a lock/);
    }
  });

  test("an invalid code on an open site stays without effect", () => {
    // Only a usable code signals a lost intent. A leftover that could not open
    // any site anyway does not stop generation.
    expect(
      buildFragment([{ slug: "open", host: "open.test-zone.invalid", lock: false, code: "a7b2k9" }]),
    ).not.toInclude("handle");
  });

  test("interrupts everything when a lock is asked for without a valid code", () => {
    // The worst outcome would be a site believing itself closed while it is
    // open: the generator exits with an error, and the install script stops
    // before touching the configuration in service.
    for (const code of [undefined, "", "too-long", "a7b2k9", "A7B2K0"]) {
      expect(() => buildFragment([{ ...locked, code }])).toThrow(/without a valid code/);
    }
  });

  test("refuses a slug that would break a matcher or escape the guard folder", () => {
    expect(() => buildFragment([{ ...locked, slug: "../etc" }])).toThrow(/slug unusable/);
  });

  test("refuses a host that is not a domain name", () => {
    expect(() => buildFragment([{ ...locked, host: "not a host" }])).toThrow(/invalid preview host/);
  });

  test("refuses two sites that would come down to the same cookie", () => {
    // Without this guard, one site's code would open the other one's site.
    expect(() =>
      buildFragment([
        { slug: "a-b", host: "a-b.test-zone.invalid", lock: true, code: "A7B2K9" },
        { slug: "a-b", host: "other.test-zone.invalid", lock: true, code: "K9A7B2" },
      ]),
    ).toThrow(/same cookie/);
  });

  test("refuses two locks on the same host", () => {
    expect(() =>
      buildFragment([
        { slug: "one", host: "same.test-zone.invalid", lock: true, code: "A7B2K9" },
        { slug: "two", host: "same.test-zone.invalid", lock: true, code: "K9A7B2" },
      ]),
    ).toThrow(/same host/);
  });

  test("carries the code of the locked site and of it alone", () => {
    const fragment = buildFragment([
      locked,
      // Deliberately invalid code: a usable code on an open site now stops
      // generation, test above.
      { slug: "open", host: "open.test-zone.invalid", lock: false, code: "zzzzzz" },
    ]);
    expect(fragment).toInclude("query key=A7B2K9");
    expect(fragment).not.toInclude("zzzzzz");
    expect(fragment).not.toInclude("open.test-zone.invalid");
  });

  test("sorts the stanzas by slug, so that two generations coincide", () => {
    const sites = [
      { slug: "bravo", host: "bravo.test-zone.invalid", lock: true, code: "A7B2K9" },
      { slug: "alpha", host: "alpha.test-zone.invalid", lock: true, code: "K9A7B2" },
    ];
    expect(buildFragment(sites)).toBe(buildFragment([...sites].reverse()));
    expect(buildFragment(sites).indexOf("alpha")).toBeLessThan(buildFragment(sites).indexOf("bravo"));
  });

  test("a fragment without a lock stays a valid Caddy file", () => {
    // Caddy imports this file: empty of stanzas, it must contain nothing but
    // comments, never a half written directive.
    const fragment = buildFragment([]);
    expect(fragment.trimEnd().split("\n").every((line) => line.startsWith("#"))).toBe(true);
    expect(fragment).toEndWith("\n");
    expect(fragment).toInclude("do not edit by hand");
  });
});

describe("previewHost", () => {
  test("follows the naming convention of previews", () => {
    expect(previewHost("agency", "test-zone.invalid")).toBe("agency.test-zone.invalid");
    expect(previewHost("agency", "example.test")).toBe("agency.example.test");
  });
});

/**
 * The generator itself, launched the way `bin/lock.sh` launches it. What
 * `buildFragment` decides is tested above, without a disk; what follows
 * bears on reading the files, the only place where the switch to the manifest
 * could get lost.
 */
describe("generate-locks.ts", () => {
  const temporary: string[] = [];

  afterEach(() => {
    while (temporary.length > 0) rmSync(temporary.pop()!, { recursive: true, force: true });
  });

  /** A disposable /srv/sites tree, one folder per site. */
  function sitesRoot(files: Record<string, Record<string, string>>): string {
    const root = mkdtempSync(join(tmpdir(), "sitesolide-verrous-"));
    temporary.push(root);
    for (const [slug, contents] of Object.entries(files)) {
      mkdirSync(join(root, slug), { recursive: true });
      for (const [name, content] of Object.entries(contents)) {
        writeFileSync(join(root, slug, name), content);
      }
    }
    return root;
  }

  async function generate(sitesDir: string, codes: Record<string, string>) {
    const codesFile = join(mkdtempSync(join(tmpdir(), "sitesolide-codes-")), "codes.json");
    temporary.push(join(codesFile, ".."));
    writeFileSync(codesFile, JSON.stringify(codes));

    const child = Bun.spawn(
      ["bun", join(import.meta.dir, "..", "scripts", "generate-locks.ts")],
      {
        env: {
          ...process.env,
          SITES_DIR: sitesDir,
          CODES_FILE: codesFile,
          SITESOLIDE_ZONE: "test-zone.invalid",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, stderrText] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code: await child.exited, output, stderrText };
  }

  test("closes a site whose manifest carries lock", async () => {
    const root = sitesRoot({
      agency: { "sitesolide.json": '{"slug":"agency","lock":true}' },
    });
    const r = await generate(root, { agency: "A7B2K9" });
    expect(r.code).toBe(0);
    expect(r.output).toContain("agency.test-zone.invalid");
    expect(r.output).toContain("A7B2K9");
  });

  test("leaves a manifest without lock open", async () => {
    const root = sitesRoot({
      agency: { "sitesolide.json": '{"slug":"agency"}' },
    });
    const r = await generate(root, {});
    expect(r.code).toBe(0);
    expect(r.output).not.toContain("agency.test-zone.invalid");
  });

  test("stops on a site.json left over from before the switch", async () => {
    // The descriptor could ask for a lock nobody reads any more. Without this
    // stop, the next regeneration would reopen the site silently, and its
    // owner would believe it closed.
    const root = sitesRoot({
      agency: { "site.json": '{"domain":"acme.example","actif":false,"lock":true}' },
    });
    const r = await generate(root, { agency: "A7B2K9" });
    expect(r.code).not.toBe(0);
    expect(r.stderrText).toContain("sitesolide deploy");
  });
});
