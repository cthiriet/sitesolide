import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateFragment, SITE_VARIABLE, ZONE_HOST } from "../../bin/cli/fragment";
import { domainHosts, type Manifest } from "../../bin/cli/manifest";
import { knownManifests } from "../../bin/tests/manifests";

/**
 * The locks fragment only has an effect if Caddy imports it, in every block
 * that serves a site that may open with a code: the previews, and the sites'
 * own domains, which say whose site they serve. This test therefore re-reads
 * the repository's configuration: a deleted import line, one moved into the
 * wrong block or turned into a named import, would open every preview, or
 * leave a domain open behind its closed preview, without anything flagging
 * it, generation carrying on producing a correct fragment.
 */

const ROOT = join(import.meta.dir, "..", "..");
const IMPORT_LOCKS = "import /etc/caddy/locks/*.caddy";

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/**
 * Extracts the body of the block whose header is given, by counting braces.
 * Comment lines are set aside before the count: they happily quote braces, and
 * they take no part in the structure.
 */
function block(text: string, header: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trimStart().startsWith(header));
  if (start === -1) throw new Error(`block not found: ${header}`);

  const body: string[] = [];
  let depth = 0;

  for (const line of lines.slice(start)) {
    const code = line.trimStart().startsWith("#") ? "" : line;
    depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
    body.push(line);
    if (depth === 0 && body.length > 1) break;
  }

  return body.join("\n");
}

describe("infra/caddy/Caddyfile", () => {
  const caddyfile = read("infra/caddy/Caddyfile");

  test("imports the locks from the previews block", () => {
    expect(block(caddyfile, "*.{$SITESOLIDE_ZONE} {")).toInclude(IMPORT_LOCKS);
  });

  test("the import is a glob, never a named file", () => {
    // A named import of an absent file makes the entire adaptation fail, so
    // every site on the machine; a glob with no match is only a warning. The
    // folder is empty as long as no site is locked, which is the normal state.
    for (const line of caddyfile.split("\n")) {
      if (!line.includes("/etc/caddy/locks")) continue;
      expect(line.trim()).toBe(IMPORT_LOCKS);
    }
    expect(caddyfile).toInclude("/etc/caddy/locks/*.caddy");
  });

  test("has no block of the bare domain: the project that declares the zone serves it", () => {
    // A block of the zone's own address here would take it from the app that
    // declares the zone, and two blocks of one address fail the whole
    // configuration. Nothing proxies to the landing's old service either.
    const addresses = caddyfile.split("\n").filter((line) => !line.startsWith("\t") && !line.startsWith("#") && line.endsWith("{"));
    expect(addresses.filter((line) => line.startsWith(ZONE_HOST) || line.startsWith(`www.${ZONE_HOST}`))).toEqual([]);
    expect(caddyfile).not.toInclude("127.0.0.1:3000");
  });

  test("the zone's www only sends to the bare domain, ahead of the locks and the file server", () => {
    // redir comes before handle and file_server in Caddy's order: whatever a
    // lock or a public/ holds, www serves none of it.
    const wildcard = block(caddyfile, "*.{$SITESOLIDE_ZONE} {");
    expect(wildcard).toInclude(`\t@www host www.${ZONE_HOST}\n`);
    expect(wildcard).toInclude(`\tredir @www https://${ZONE_HOST}{uri} permanent\n`);
  });

  test("the bare domain keeps the HSTS of its old block, and a client's domain gets none", () => {
    const domains = block(caddyfile, "https:// {");
    expect(domains).toInclude(`\t@bare host ${ZONE_HOST}\n\theader @bare Strict-Transport-Security "max-age=31536000"\n`);
    expect(domains.split("\n").filter((line) => line.includes("Strict-Transport-Security"))).toHaveLength(1);
  });

  test("the static sites' domains close with their previews, each by the site its table names", () => {
    // Without the variable, no stanza recognises the domain and it serves
    // without a code what its preview closes. It is set from the table: a
    // domain the table does not carry is "__unknown", which no stanza names.
    const domains = block(caddyfile, "https:// {");
    expect(domains).toInclude(`\tvars ${SITE_VARIABLE} {folder}\n`);
    expect(domains).toInclude(`\t${IMPORT_LOCKS}\n`);
    expect(domains).toInclude('default "__unknown"');
  });

  test("the nameless block never serves an app's folder: an app's names are its own block's", () => {
    // A name the table still carries for an app and its block does not claim
    // would serve its public/ here, past its portal. An app is a folder with
    // a block; the refusal comes before the file server, which Caddy sorts
    // after respond.
    const domains = block(caddyfile, "https:// {");
    expect(domains).toInclude("\t@app file {\n\t\troot /etc/caddy/sites\n\t\ttry_files {folder}.caddy\n\t}\n\trespond @app 404\n");
  });
});

/**
 * The same two constraints hold for any application project, not only for the
 * one that existed the day the lock was written. The next one will be
 * generated by `bin/sitesolide.ts`: a test naming it would not have covered
 * it, and its owner would have discovered the hole in production.
 */
/**
 * The blocks a deployment installs, generated as it generates them, from every
 * manifest the workstation knows: the platform's own and the neighbouring
 * sites' repository. No copy of a deployed block is kept anywhere to re-read,
 * and a fresh install still has the platform's own manifests to check.
 */
/**
 * An app on its own domain with an alias, beside the known manifests: a fresh
 * clone, with no sites repository, still checks a domain's blocks.
 */
const ON_DOMAIN: Manifest = {
  slug: "sample-shop",
  port: 3060,
  publicDir: "public",
  start: "bun run server.ts",
  domain: { name: "sample-shop.example", aliases: ["boutique.sample-shop.example"], active: true },
};

const APPS: [string, string, boolean, string[]][] = [...knownManifests(), ON_DOMAIN]
  .map((manifest): [string, string | null, boolean, string[]] => [
    manifest.slug,
    generateFragment(manifest),
    manifest.publicDir !== undefined,
    manifest.domain === undefined ? [] : domainHosts(manifest.domain),
  ])
  .filter((entry): entry is [string, string, boolean, string[]] => entry[1] !== null);

test("no generated block escapes the tests below", () => {
  // Failing which a path mistake would make the loop empty, therefore always
  // green, and the constraints would no longer be checked anywhere.
  expect(APPS.length).toBeGreaterThan(0);
});

/**
 * The header of the preview block, as this fragment writes it.
 *
 * `<slug>.{$SITESOLIDE_ZONE} {`: a block never names the zone.
 */
function previewHeader(file: string, slug: string): string {
  // Exactly, never a prefix: a site's own domain may start with its slug
  // too, shop.example.com for shop.
  const header = file.split("\n").find((line) => line.trimEnd() === `${slug}.${ZONE_HOST} {`);
  if (header === undefined) throw new Error(`preview block not found for ${slug}`);
  return header.trimEnd();
}

describe.each(APPS)("generated block: %s", (slug, file, servesFiles, names) => {
  const PREVIEW = previewHeader(file, slug);
  const [domain, ...others] = names;

  test("imports the locks in the preview block", () => {
    // This block is more specific than the zone's wildcard and goes ahead of
    // it: without this import, the application site would be the only one
    // unable to lock itself, and bin/lock.sh enable would fail on its 401
    // check.
    expect(block(file, PREVIEW)).toInclude(IMPORT_LOCKS);
  });

  test("imports the locks in the domain's block, which says whose site it serves, and nowhere else", () => {
    // The domain closes with the preview: the stanza recognises it by the
    // variable, never by its name. Its other names only redirect, and no
    // stanza could match there anyway.
    let elsewhere = file.split(block(file, PREVIEW)).join("");
    if (domain !== undefined) {
      const own = block(file, `${domain} {`);
      expect(own).toInclude(`\tvars ${SITE_VARIABLE} ${slug}\n`);
      expect(own).toInclude(`\t${IMPORT_LOCKS}\n`);
      elsewhere = elsewhere.split(own).join("");
    }
    expect(elsewhere).not.toInclude("/etc/caddy/locks");
  });

  test.skipIf(others.length === 0)("every other name of the domain sends to it", () => {
    // A name the table carries and no block claims falls into the nameless
    // block of static files: public/ served without the service, or its door.
    const aliases = block(file, `${others.join(", ")} {`);
    expect(aliases).toInclude(`\tredir https://${domain}{uri} permanent\n`);
    expect(aliases).not.toInclude("reverse_proxy");
    expect(aliases).not.toInclude("file_server");
  });

  test("the site routes use no handle", () => {
    // Measured in the lab: all the handles of a single block form one
    // exclusive group. The lock's handle won, its right cookie branch left the
    // group with no response written, and the site's handles were already set
    // aside: the visitor holding the right code received a 200 with an empty
    // body. reverse_proxy and file_server, for their part, form no group.
    const routes = block(file, `(${slug}-routes) {`);
    for (const line of routes.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      expect(line).not.toInclude("handle");
    }
    // A project that serves files does it without a handle either; one with no
    // publicDir, an API or a project of several services, has none to serve.
    if (servesFiles) expect(routes).toInclude("file_server");
    else expect(routes).not.toInclude("file_server");
  });
});
