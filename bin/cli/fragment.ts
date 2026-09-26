/**
 * Generates the Caddy fragment of an application project, deposited to
 * `/etc/caddy/sites/<slug>.caddy` and loaded by the import at the end of the
 * Caddyfile.
 *
 * Four rules are non-negotiable there, each one paid for by a bug or checked by
 * api/tests/caddyfile.test.ts:
 *
 *   1. `import tls-zone` in the preview block, failing which that block gets
 *      its own certificate instead of sharing the wildcard, silently;
 *   2. `import /etc/caddy/locks/*.caddy` in that same block, and in it alone:
 *      without it `bin/lock.sh enable` fails and the preview stays open; put
 *      on a final domain, it would close the customer's site;
 *   3. **no `handle`**: all the `handle` of one block form an exclusive group,
 *      the lock's would win, and the visitor holding the right code would get a
 *      200 with an empty body;
 *   4. no `tls-zone` on a customer domain, whose certificate goes through
 *      `on_demand`: the server's Cloudflare token only covers the served zone.
 *
 * Pure: returns text, touches nothing. Depositing on the VM belongs to
 * bin/deploy-caddy.sh, which backs up, validates and restores.
 */
import { sameDirectives } from "./comparison";
import { isApp, isProtected, type Manifest } from "./manifest";
import { portalStanza } from "./portal";
import { projectPaths } from "./unit";

export const IMPORT_LOCKS = "import /etc/caddy/locks/*.caddy";

/**
 * The matcher that decides what wakes the service up.
 *
 * By default, everything that does not match a file in `public/`. The allow
 * list is not a configuration to fill in: it is a security choice, for a
 * service whose very home page depends on a session. Without it, an
 * `index.html` placed in `public/` would be served in the clear and would
 * short-circuit authentication.
 */
export function matcher(manifest: Manifest): string | null {
  if (manifest.publicDir === undefined) return null;
  const routes = manifest.routes ?? [];
  return routes.length > 0 ? `path ${routes.join(" ")}` : "not file";
}

/** The routes snippet, shared by the preview and the customer domain. */
/** Does the manifest carry its own `X-Robots-Tag`? */
export function declaresRobots(manifest: Manifest): boolean {
  return Object.keys(manifest.headers ?? {}).some((name) => name.toLowerCase() === "x-robots-tag");
}

export function generateRoutes(manifest: Manifest): string {
  const paths = projectPaths(manifest.slug);
  const lines = [`(${manifest.slug}-routes) {`, "\timport commun", ""];

  // The site's own headers, placed in the snippet and therefore valid on all of
  // its blocks. Without them, a generator replacing a hand-written fragment
  // would silently cut off what that fragment allowed: a site that uses the
  // microphone declares Permissions-Policy there, precisely so that a
  // hardening pass does not cut its audio off.
  const headers = Object.entries(manifest.headers ?? {});
  if (headers.length > 0) {
    for (const [name, value] of headers) lines.push(`\theader ${name} "${value}"`);
    lines.push("");
  }

  if (manifest.publicDir === undefined) {
    lines.push(
      "\t# No static file at all: the whole site is rendered by the service.",
      `\treverse_proxy 127.0.0.1:${manifest.port}`,
    );
  } else {
    const rule = matcher(manifest);
    lines.push(
      `\troot * ${paths.publicDir}`,
      "",
      manifest.routes === undefined
        ? "\t# Whatever is not a file of public/ goes to the service. A matcher\n\t# laid on reverse_proxy, never a handle: see the header."
        : isProtected(manifest)
          ? "\t# Whitelist declared in sitesolide.json. The door is not here: the\n\t# portal holds it for the whole block, see the preview block."
          : "\t# Whitelist declared in sitesolide.json: the service carries an\n\t# authentication, and its home must not be served in the clear.",
      `\t@dynamic ${rule}`,
      `\treverse_proxy @dynamic 127.0.0.1:${manifest.port}`,
      "",
      "\t# The rest is served straight by Caddy, without waking the service.",
      "\tfile_server",
    );
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * The zone, as a fragment writes it: a variable Caddy substitutes while reading
 * the configuration, never a domain name in the clear. `/etc/caddy/
 * sitesolide.env` carries it, deposited by bin/deploy-caddy.sh from the
 * workstation's configuration.
 */
export const ZONE_HOST = "{$SITESOLIDE_ZONE}";

/**
 * The complete fragment, or `null` when the project does not need one: a static
 * showcase site is already served by the zone's wildcard block and, if it has a
 * customer domain, by the nameless block that reads `domaines.map`. Writing a
 * fragment for it would add a file to validate without changing anything.
 *
 * **The fragment does not name the zone**, it writes `{$SITESOLIDE_ZONE}`,
 * which Caddy substitutes while reading the configuration. A zone written in
 * the clear here would force the dashboard's gatekeeper to know it in order to
 * rewrite the same block, and a deposited fragment would stop being valid the
 * day the zone changed.
 */
export function generateFragment(manifest: Manifest): string | null {
  if (!isApp(manifest)) return null;

  const slug = manifest.slug;
  const domain = manifest.domain;
  const lines = [
    `# Caddy block for project ${slug}, generated by bin/sitesolide.ts from its`,
    "# sitesolide.json and deposited into /etc/caddy/sites/. Do not edit by",
    "# hand: the next deployment overwrites it, and a fragment never validated",
    "# holds until the first restart of Caddy.",
    "",
    generateRoutes(manifest),
    "",
  ];

  if (domain !== undefined) {
    // An application site must not land in the nameless block of customer
    // domains: that one only serves static files and would never wake the
    // service up.
    lines.push(
      "# The project's own domain. The certificate is obtained on the first",
      "# request, once the ask endpoint agrees: the domain must appear in",
      "# sitesolide.json and the table must have been regenerated. No tls-zone",
      "# here, the server's Cloudflare token only covers the served zone.",
      `${domain.name} {`,
      "\ttls {",
      "\t\ton_demand",
      "\t}",
      "",
      `\timport ${slug}-routes`,
      "}",
      "",
    );
  }

  lines.push(
    "# Address under the zone. This block is more specific than its wildcard",
    "# and comes before it, so it inherits neither its TLS policy nor its",
    "# noindex: both are written again here.",
    `${slug}.${ZONE_HOST} {`,
    "\t# Same TLS policy as the wildcard block, failing which this project",
    "\t# would get a certificate of its own instead of sharing the wildcard.",
    "\timport tls-zone",
    "",
    ...(declaresRobots(manifest)
      ? ["\t# X-Robots-Tag comes from the manifest headers, laid in the snippet."]
      : ['\theader X-Robots-Tag "noindex, nofollow"']),
    "",
    "\t# Without this import, this project would be the only one unable to",
    "\t# lock itself, and bin/lock.sh enable would fail on its check.",
    `\t${IMPORT_LOCKS}`,
    "",
    ...portalStanza(manifest),
    `\timport ${slug}-routes`,
    "}",
    "",
  );

  return lines.join("\n");
}

/** What `deploy` does with its block, given the one in service. */
export type BlockDecision = "deposit" | "follows-door" | "forced" | "diverged";

/**
 * The block this deployment generates, against the one the machine serves.
 *
 * - none in service, or the same directives: `deposit`, the ordinary case;
 * - different by the door alone, when the machine carries that door
 *   (`doorConfirmed`): `follows-door`, the dashboard changed it and this
 *   deployment catches up;
 * - different otherwise: `diverged`, a decision made by hand on the machine
 *   that the generator knows nothing of, unless `replace` says to overwrite it,
 *   `forced`.
 *
 * Comments and order do not count: see comparison.ts.
 */
export function decideBlock(state: {
  manifest: Manifest;
  inService: string | null;
  replace: boolean;
  doorConfirmed: boolean;
}): BlockDecision {
  const generated = generateFragment(state.manifest);
  if (generated === null || state.inService === null) return "deposit";
  if (sameDirectives(state.inService, generated)) return "deposit";
  if (state.doorConfirmed) {
    const otherDoor = generateFragment({
      ...state.manifest,
      portal: isProtected(state.manifest) ? undefined : true,
    });
    if (otherDoor !== null && sameDirectives(state.inService, otherDoor)) return "follows-door";
  }
  return state.replace ? "forced" : "diverged";
}
