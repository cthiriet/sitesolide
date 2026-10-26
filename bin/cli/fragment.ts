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
 *   2. `import /etc/caddy/locks/*.caddy` in that same block, and in the block
 *      of the site's own domain beside `vars sitesolide_site <slug>`: without
 *      it the gatekeeper's check of a code fails and nothing changes, and the
 *      domain would serve without a code what the preview closes;
 *   3. **no `handle`**: all the `handle` of one block form an exclusive group,
 *      the lock's would win, and the visitor holding the right code would get a
 *      200 with an empty body. The one pair written is the gate of a site's
 *      own domain, around everything else its block does, the lock's import
 *      included: inside the first, the lock's handles form a group of their
 *      own, as at the top of the preview's block. See `gate`;
 *   4. no `tls-zone` on a customer domain, whose certificate goes through
 *      `on_demand`: the server's Cloudflare token only covers the served zone.
 *
 * Pure: returns text, touches nothing. Depositing on the VM belongs to
 * bin/deploy-caddy.sh, which backs up, validates and restores.
 */
import { sameDirectives, usefulDirectives } from "./comparison";
import {
  domainHosts,
  hasServices,
  isApp,
  isProtected,
  isValidDomain,
  isValidHeaderName,
  isValidHeaderValue,
  isValidRoute,
  isValidServiceName,
  isValidSlug,
  NEVER_SENT,
  servicesOf,
  type Manifest,
} from "./manifest";
import { announcedFor, openStanza, portalHostStanza, portalStanza, PORTAL_GENERATIONS, type PortalGeneration } from "./portal";
import { projectPaths } from "./unit";

export const IMPORT_LOCKS = "import /etc/caddy/locks/*.caddy";

/** The preview locks the gatekeeper writes, under the name the machine carries (CLAUDE.md). */
export const LOCKS_FRAGMENT = "/etc/caddy/locks/verrous.caddy";

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
  return routes.length > 0 ? `path ${routes.map(writableRoute).join(" ")}` : "not file";
}

/**
 * The text this generator writes from a manifest is Caddy syntax, and since
 * the control API a team token writes the manifest. validate() refuses what
 * would break out of a line or name a placeholder, at every entry: the CLI,
 * the dashboard, the steward, the installer. These guards are the second
 * barrier, for a manifest that reached a generator without it: they throw
 * rather than write, so that nothing is deposited, and they refuse only what
 * validate() refuses, so that no valid manifest ever meets them.
 */
function writableRoute(route: string): string {
  if (!isValidRoute(route)) throw new Error(`routes: ${JSON.stringify(route)} is not a path validate() accepts, it is never written into a Caddy block`);
  return route;
}

function writableHeader(name: string, value: unknown): string {
  if (!isValidHeaderName(name) || !isValidHeaderValue(value)) {
    throw new Error(`headers: ${JSON.stringify(name)} is not a header validate() accepts, it is never written into a Caddy block`);
  }
  return `\theader ${name} "${value}"`;
}

/** Does the manifest carry its own `X-Robots-Tag`? */
export function declaresRobots(manifest: Manifest): boolean {
  return Object.keys(manifest.headers ?? {}).some((name) => name.toLowerCase() === "x-robots-tag");
}

/**
 * The generations of a block's file server, the current one first:
 *
 * - `hidden`: `.git` and the `.env` files answer 404 at any depth, what an
 *   earlier deployment left in `public/` included (NEVER_SENT in manifest.ts).
 *   `hide` takes file names, matched against every component of the path on
 *   disk, so `.git` hides `.git/config` too;
 * - `plain`: the bare `file_server` of the blocks deployed before.
 *
 * A block of the earlier generation is the generator's own, one release
 * behind, never a hand edit: deploy, the gatekeeper and the installer replace
 * it without `--force`, as for the portal's generations. See
 * isEarlierGeneration.
 */
export const FILE_GENERATIONS = ["hidden", "plain"] as const;

export type FileGeneration = (typeof FILE_GENERATIONS)[number];

/**
 * The generations of the blocks of a site's own domain, the current one first:
 *
 * - `gated`: the blocks of `closable`, each serving only while the domain
 *   table carries the domain for this site, and answering a 404 otherwise:
 *   a domain switched off stops answering at once, whatever certificate
 *   Caddy still holds for it. See `gate`;
 * - `closable`: the domain closes with the preview, the portal's guard or the
 *   preview locks in its block too, and every other name the table carries
 *   for it, its aliases and its `www`, sends there;
 * - `open`: the blocks deployed before, the domain's own name alone, always
 *   open, its other names left to the nameless block of static files.
 *
 * A fragment without a domain is the same in all three.
 */
export const DOMAIN_GENERATIONS = ["gated", "closable", "open"] as const;

export type DomainGeneration = (typeof DOMAIN_GENERATIONS)[number];

/**
 * The generations of a block's proxies, the current one first:
 *
 * - `visitor`: every `reverse_proxy` to the project's services hands them the
 *   visitor's address as `X-Forwarded-For`, Caddy's `{client_ip}`. On a
 *   machine served directly, that is the peer's address, the very value Caddy
 *   wrote before; on one served through a Cloudflare Tunnel, whose peer is
 *   always cloudflared on the loopback, it is the address the edge read,
 *   which infra/tunnel/tunnel.caddy trusts. Either way the header holds one
 *   value, the visitor's;
 * - `peer`: the blocks deployed before, which let Caddy write its peer's
 *   address, the loopback behind a tunnel.
 */
export const FORWARD_GENERATIONS = ["visitor", "peer"] as const;

export type ForwardGeneration = (typeof FORWARD_GENERATIONS)[number];

/** The variable that tells the preview locks whose site a block serves, see api/src/locks.ts. */
export const SITE_VARIABLE = "sitesolide_site";

function fileServer(files: FileGeneration): string[] {
  return files === "hidden" ? ["\tfile_server {", `\t\thide ${NEVER_SENT.join(" ")}`, "\t}"] : ["\tfile_server"];
}

/** A proxy to one of the project's services, `@dynamic 127.0.0.1:3000` for instance: see FORWARD_GENERATIONS. */
function proxy(target: string, forwarded: ForwardGeneration): string[] {
  return forwarded === "visitor" ? [`\treverse_proxy ${target} {`, "\t\theader_up X-Forwarded-For {client_ip}", "\t}"] : [`\treverse_proxy ${target}`];
}

/** The routes snippet, shared by the preview and the customer domain. */
export function generateRoutes(manifest: Manifest, files: FileGeneration = "hidden", forwarded: ForwardGeneration = "visitor"): string {
  const paths = projectPaths(manifest.slug);
  const lines = [`(${manifest.slug}-routes) {`, "\timport commun", ""];

  // The site's own headers, placed in the snippet and therefore valid on all of
  // its blocks. Without them, a generator replacing a hand-written fragment
  // would silently cut off what that fragment allowed: a site that uses the
  // microphone declares Permissions-Policy there, precisely so that a
  // hardening pass does not cut its audio off.
  //
  // Between double quotes, never escaped: isValidHeaderValue leaves nothing
  // there that Caddy would read as syntax or as a placeholder.
  const headers = Object.entries(manifest.headers ?? {});
  if (headers.length > 0) {
    for (const [name, value] of headers) lines.push(writableHeader(name, value));
    lines.push("");
  }

  if (hasServices(manifest)) {
    lines.push(...servicesRoutes(manifest, files, forwarded));
  } else if (manifest.publicDir === undefined) {
    lines.push(
      "\t# No static file at all: the whole site is rendered by the service.",
      ...proxy(`127.0.0.1:${manifest.port}`, forwarded),
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
      ...proxy(`@dynamic 127.0.0.1:${manifest.port}`, forwarded),
      "",
      "\t# The rest is served straight by Caddy, without waking the service.",
      ...fileServer(files),
    );
  }

  lines.push("}");
  return lines.join("\n");
}

/**
 * The routes of a project declaring `services`: each public service receives
 * its own paths, and the one without routes everything else.
 *
 * **No line depends on the written order**, which the comparison of blocks
 * does not see (bin/cli/comparison.ts). Two services never claim the same path,
 * validate() refuses routes that could overlap. The service taking the rest
 * carries either no matcher, which Caddy sorts after every matched
 * `reverse_proxy`, or, next to a `publicDir`, a matcher that excludes the
 * other services' paths by itself. Still no `handle`: see the header.
 *
 * An internal service has no line here: Caddy never reaches it, only the
 * project's other services do, over the loopback.
 */
function servicesRoutes(manifest: Manifest, files: FileGeneration, forwarded: ForwardGeneration): string[] {
  const paths = projectPaths(manifest.slug);
  const exposed = servicesOf(manifest).filter((service) => !service.internal);
  const routed = exposed.filter((service) => service.routes !== undefined);
  const rest = exposed.find((service) => service.routes === undefined);
  const lines: string[] = [];

  if (manifest.publicDir !== undefined) lines.push(`\troot * ${paths.publicDir}`, "");

  for (const service of routed) {
    lines.push(
      `\t# Service ${service.name}: the paths sitesolide.json declares for it.`,
      `\t@service-${service.name} path ${service.routes!.map(writableRoute).join(" ")}`,
      ...proxy(`@service-${service.name} 127.0.0.1:${service.port}`, forwarded),
      "",
    );
  }

  if (rest !== undefined && manifest.publicDir === undefined) {
    lines.push(
      `\t# Service ${rest.name}: every other path. Without a matcher, Caddy sorts`,
      "\t# it after the routed services.",
      ...proxy(`127.0.0.1:${rest.port}`, forwarded),
    );
  } else if (rest !== undefined) {
    const claimed = routed.flatMap((service) => service.routes!);
    lines.push(
      `\t# Service ${rest.name}: whatever is neither a file of public/ nor a path`,
      "\t# of another service.",
      `\t@service-${rest.name} {`,
      "\t\tnot file",
      ...(claimed.length > 0 ? [`\t\tnot path ${claimed.map(writableRoute).join(" ")}`] : []),
      "\t}",
      ...proxy(`@service-${rest.name} 127.0.0.1:${rest.port}`, forwarded),
    );
  }

  if (manifest.publicDir !== undefined) {
    lines.push("", "\t# The rest is served straight by Caddy, without waking a service.", ...fileServer(files));
  } else if (exposed.length === 0) {
    // Without this line every path would get an empty 200, a page that looks
    // served and is not. The address still answers, and a 200: every probe
    // of the machine, deploy-caddy.sh's and the gatekeeper's, asks it to.
    lines.push(
      "\t# No public service and no publicDir: the project runs in the background",
      "\t# and serves no page, which its address says.",
      `\trespond "${HEADLESS_ANSWER}" 200`,
    );
  }
  return lines;
}

/** What the address of a project that serves no page answers, see isHeadless. */
export const HEADLESS_ANSWER = "This project runs in the background and serves no page.";

/**
 * The zone, as a fragment writes it: a variable Caddy substitutes while reading
 * the configuration, never a domain name in the clear. `/etc/caddy/
 * sitesolide.env` carries it, deposited by bin/deploy-caddy.sh from the
 * workstation's configuration.
 */
export const ZONE_HOST = "{$SITESOLIDE_ZONE}";

/** Above the block of the site's own domain, in either of its generations. */
const OWN_DOMAIN_COMMENT = [
  "# The project's own domain. The certificate is obtained on the first",
  "# request, once the ask endpoint agrees: the domain must appear in",
  "# sitesolide.json and the table must have been regenerated. No tls-zone",
  "# here, the server's Cloudflare token only covers the served zone.",
];

/** How every block of the site's own names obtains its certificate. */
const ON_DEMAND_TLS = ["\ttls {", "\t\ton_demand", "\t}"];

/** The domain table, under the name the machine carries (CLAUDE.md), as the Caddyfile imports it too. */
export const DOMAIN_TABLE = "/etc/caddy/domaines.map";

/** The placeholder the gate reads the table into: the site the table says serves the domain. */
const DOMAIN_PLACEHOLDER = "sitesolide_domain";

/**
 * What a site's own domain answers once switched off, see `gate`: a 404 with
 * this header, `inactive <zone>`, the zone the one Caddy substitutes from
 * /etc/caddy/sitesolide.env, as for every address under it (ZONE_HOST).
 *
 * The zone is what tells installations apart: `sitesolide domain --activate`
 * reads the header behind a tunnel, and lets a name through only when what
 * the edge relays equals what this machine answers on its own loopback (see
 * tunnelRouteProblem in bin/cli/tunnel.ts). Before its activation the
 * machine always answers its own 404 there, so `inactive` alone would take a
 * record still pointing at another installation, where the domain is
 * switched off too, for this one. The header shows the zone hosting the site
 * only on a domain switched off, and the site's preview address under that
 * zone is public anyway.
 */
export const INACTIVE_HEADER = "X-Sitesolide-Domain";
export const INACTIVE_VALUE = "inactive";
export const INACTIVE_ANSWER = "This domain is switched off.";

/** Whether a value of INACTIVE_HEADER says the domain is switched off, whichever installation wrote it. */
export function isSwitchedOff(value: string | null | undefined): boolean {
  return typeof value === "string" && (value === INACTIVE_VALUE || value.startsWith(`${INACTIVE_VALUE} `));
}

/**
 * The lines of a block of the site's own names, `served`, behind the domain
 * table: they run while the table carries the domain for this site, and a
 * 404 answers otherwise.
 *
 * `sitesolide domain --deactivate` takes the domain out of the table, which
 * the ask endpoint reads too: no certificate is obtained or renewed for it
 * from then on. A certificate Caddy already held, in its cache or its
 * storage, kept a block without this gate serving the site until it expired:
 * measured, a domain switched off answered its app with a 200. The table
 * decides instead, read at every load as the nameless block of static sites
 * reads it, and generate-domains.sh reloads Caddy after every switch: the
 * block in service is not written again either way.
 *
 * The table is asked for the domain's own name, never `{host}`: `map`
 * compares exactly, the table is in lower case, and a host in capitals
 * reaches this block all the same. Every name of the domain switches with it,
 * on one `active` in the manifest.
 *
 * Two `handle`s, exclusive, around everything else the block does: Caddy
 * sorts `redir`, `forward_auth` and the lock's `handle` before `respond`, so
 * a bare `respond` for a domain switched off would come after them. Inside the
 * first, the lock's own handles form a group of their own beside the routes,
 * as at the top of the preview's block (rule 3 of the header).
 * bin/tests/cli-domain-caddy.test.ts measures both states in a real Caddy.
 */
function gate(name: string, slug: string, served: string[]): string[] {
  return [
    "\t# Served while the domain table carries this domain for this site, a 404",
    "\t# once it no longer does: switched off, a certificate Caddy still holds",
    "\t# would otherwise keep the site answering here. See gate in",
    "\t# bin/cli/fragment.ts.",
    `\tmap ${name} {${DOMAIN_PLACEHOLDER}} {`,
    '\t\tdefault "__unknown"',
    `\t\timport ${DOMAIN_TABLE}`,
    "\t}",
    `\t@domain_active vars {${DOMAIN_PLACEHOLDER}} ${slug}`,
    "\thandle @domain_active {",
    ...served.map((line) => (line === "" ? "" : `\t${line}`)),
    "\t}",
    "",
    "\t# Switched off: nothing of the site, and a header that says so on which",
    "\t# installation, see INACTIVE_HEADER in bin/cli/fragment.ts. Never cached,",
    "\t# the same address serving the site again once switched on.",
    "\thandle {",
    `\t\theader ${INACTIVE_HEADER} "${INACTIVE_VALUE} ${ZONE_HOST}"`,
    '\t\theader Cache-Control "no-store"',
    `\t\trespond "${INACTIVE_ANSWER}" 404`,
    "\t}",
  ];
}

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
 *
 * `generation` and `files` exist to recognise the blocks an earlier release
 * wrote, see `isEarlierGeneration`; everything that deposits a block takes the
 * defaults.
 */
export function generateFragment(
  manifest: Manifest,
  generation: PortalGeneration = "identity",
  files: FileGeneration = "hidden",
  domains: DomainGeneration = "gated",
  forwarded: ForwardGeneration = "visitor",
): string | null {
  if (!isApp(manifest)) return null;

  const slug = manifest.slug;
  // The second barrier, as for the routes and the headers below (writableRoute,
  // writableHeader): the slug names this block, its `(<slug>-routes)` snippet
  // and its `<slug>.{zone}` address, and a service name becomes a
  // `@service-<name>` matcher. A newline, a brace or a space in either opens a
  // block of the manifest author's choosing, which could serve or proxy
  // another host. validate() refuses both; refused here too, so that a
  // manifest reaching the generator without it is never written into a block.
  if (!isValidSlug(slug)) {
    throw new Error(`slug: ${JSON.stringify(slug)} is not what validate() accepts, it is never written into a Caddy block`);
  }
  for (const service of servicesOf(manifest)) {
    if (service.name !== null && !isValidServiceName(service.name)) {
      throw new Error(`services: ${JSON.stringify(service.name)} is not a name validate() accepts, it is never written into a Caddy block`);
    }
  }
  const domain = manifest.domain;
  // The same barrier for the domain's names: each one is a block's address,
  // and the domain's own name the source of its gate's `map`, where a
  // placeholder would be read at every request.
  for (const host of domain === undefined ? [] : domainHosts(domain)) {
    if (!isValidDomain(host)) throw new Error(`domain: ${JSON.stringify(host)} is not a name validate() accepts, it is never written into a Caddy block`);
  }
  const lines = [
    `# Caddy block for project ${slug}, generated by bin/sitesolide.ts from its`,
    "# sitesolide.json and deposited into /etc/caddy/sites/. Do not edit by",
    "# hand: the next deployment overwrites it, and a fragment never validated",
    "# holds until the first restart of Caddy.",
    "",
    generateRoutes(manifest, files, forwarded),
    "",
  ];

  if (domain !== undefined && domains === "open") {
    lines.push(
      ...OWN_DOMAIN_COMMENT,
      `${domain.name} {`,
      ...ON_DEMAND_TLS,
      "",
      ...openStanza(generation),
      `\timport ${slug}-routes`,
      "}",
      "",
    );
  } else if (domain !== undefined) {
    // An application site must not land in the nameless block of customer
    // domains: that one only serves static files and would never wake the
    // service up. Neither may any of its names, which is why the others are
    // claimed here too, to send them to the first.
    const [, ...others] = domainHosts(domain);
    const name = domain.name;
    const gated = domains === "gated";
    const site = [
      "\t# The same site as the preview, closed when it is: the preview locks",
      "\t# recognise it by this variable, and a site behind the portal is",
      "\t# guarded here as there, judged on its preview's people. See",
      "\t# api/src/locks.ts and announcedFor in bin/cli/portal.ts.",
      `\tvars ${SITE_VARIABLE} ${slug}`,
      `\t${IMPORT_LOCKS}`,
      "",
      ...portalStanza(manifest, generation, announcedFor(slug, ZONE_HOST)),
      ...(isProtected(manifest) ? [] : openStanza(generation)),
      `\timport ${slug}-routes`,
    ];
    lines.push(...OWN_DOMAIN_COMMENT, `${name} {`, ...ON_DEMAND_TLS, "", ...(gated ? gate(name, slug, site) : site), "}", "");
    if (others.length > 0) {
      const redirect = [`\tredir https://${name}{uri} permanent`];
      lines.push(
        "# The domain's other names, its aliases and its www, send to it: one",
        "# address for the site, so one door, one cookie, and one page for",
        "# search engines. Nothing is served here, open or closed.",
        `${others.join(", ")} {`,
        ...ON_DEMAND_TLS,
        "",
        ...(gated ? gate(name, slug, redirect) : redirect),
        "}",
        "",
      );
    }
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
    "\t# open with a code: the gatekeeper would find it still open, and undo.",
    `\t${IMPORT_LOCKS}`,
    "",
    ...portalStanza(manifest, generation),
    ...portalHostStanza(manifest, generation),
    ...(isProtected(manifest) ? [] : openStanza(generation)),
    `\timport ${slug}-routes`,
    "}",
    "",
  );

  return lines.join("\n");
}

/**
 * Is this block what an earlier release of this generator wrote for the
 * manifest? Then it is the generator's own, behind by a release, and never a
 * decision taken by hand: replacing it with the current generation loses
 * nothing. Four cases today, and their combinations: every block deployed
 * before the identity headers, protected or not, see PORTAL_GENERATIONS in
 * portal.ts; the file servers deployed before they hid `.git` and `.env`, see
 * FILE_GENERATIONS; the blocks of a site's own domain before it closed with
 * the preview, and before the domain table switched them off, see
 * DOMAIN_GENERATIONS; and the proxies deployed before they handed on the
 * visitor's address, see FORWARD_GENERATIONS.
 */
export function isEarlierGeneration(block: string, manifest: Manifest): boolean {
  const current = generateFragment(manifest);
  return PORTAL_GENERATIONS.some((generation) =>
    FILE_GENERATIONS.some((files) =>
      DOMAIN_GENERATIONS.some((domains) =>
        FORWARD_GENERATIONS.some((forwarded) => {
          const earlier = generateFragment(manifest, generation, files, domains, forwarded);
          return earlier !== null && earlier !== current && sameDirectives(block, earlier);
        }),
      ),
    ),
  );
}

/** What Caddy serves that decides whether a closed site's own domain closes with it. */
export type Served = { block: string | null; caddyfile: string | null; locks: string | null };

/**
 * Why what Caddy serves would not close a site's own domain with its preview,
 * null when it would. `sitesolide domain --activate` asks it of a closed site,
 * before the table certifies a single name: a domain switched on behind any of
 * these would serve without its door what the preview closes.
 *
 * - an app's block in service must be one this manifest generates, in a
 *   generation that closes the domain: the `open` one leaves it open, and
 *   one that predates a change of the domain's names claims none of the new
 *   ones, which the Caddyfile then refuses to serve;
 * - a static site's domain is served by the Caddyfile's nameless block, which
 *   must say whose site it serves;
 * - a site that opens with a code needs its stanza in the form that closes
 *   every address, the one api/src/locks.ts `stanza` writes now: an earlier
 *   one matches the preview's host alone. The line is read here as
 *   `stanzaClosesEveryAddress` reads it there.
 */
export function domainLeftOpen(manifest: Manifest, served: Served): string | null {
  const generated = generateFragment(manifest);
  // The same block with the proxies of before, which hand the service the
  // peer's address rather than the visitor's, or from before the gate, which
  // decides whether the domain is served at all: nothing of what closes a
  // domain differs, and a site deployed before either closes its domain as
  // well once switched on.
  const closing = DOMAIN_GENERATIONS.filter((domains) => domains !== "open").flatMap((domains) =>
    FORWARD_GENERATIONS.map((forwarded) => generateFragment(manifest, "identity", "hidden", domains, forwarded)),
  );
  const current = (block: string) => closing.some((one) => one !== null && sameDirectives(block, one));
  if (generated !== null && (served.block === null || !current(served.block))) {
    return "the Caddy block in service is not the one this sitesolide.json generates";
  }
  if (generated === null && (served.caddyfile === null || !served.caddyfile.includes(`\tvars ${SITE_VARIABLE} {folder}\n`))) {
    return "the Caddyfile in service predates closing a static site's own domain";
  }
  if (manifest.lock === true) {
    const matcher = `@lock_host_${manifest.slug} expression `;
    const current = (served.locks ?? "").split("\n").some((line) => line.startsWith(matcher) && line.includes(`vars({'${SITE_VARIABLE}': '${manifest.slug}'})`));
    if (!current) return "the code's stanza in service predates closing a site's own domain";
  }
  return null;
}

/**
 * Whether the block in service switches the site's own domain off with the
 * table: every block of its names behind the gate (see `gate`). Read, never
 * assumed: neither `upgrade` nor `refresh` writes an app's block, and an app
 * deployed before the gate keeps one that serves its domain whatever the
 * table says, for as long as Caddy holds its certificate. `sitesolide domain`
 * says so rather than refuse: the switch still stops the certificate's
 * renewal, and the next deployment writes the gate.
 */
export function gatesDomain(block: string | null, manifest: Manifest): boolean {
  const domain = manifest.domain;
  if (block === null || domain === undefined) return false;
  const [, ...others] = domainHosts(domain);
  const gateLines = [
    `map ${domain.name} {${DOMAIN_PLACEHOLDER}} {`,
    `import ${DOMAIN_TABLE}`,
    `@domain_active vars {${DOMAIN_PLACEHOLDER}} ${manifest.slug}`,
    "handle @domain_active {",
    "handle {",
  ];
  const addresses = [domain.name, ...(others.length > 0 ? [others.join(", ")] : [])];
  return addresses.every((address) => {
    const lines = siteBlock(block, `${address} {`);
    return lines !== null && gateLines.every((line) => lines.includes(line));
  });
}

/** The lines that decide of the site block `opening` starts in a Caddy text, braces counted; null when none does. */
function siteBlock(text: string, opening: string): string[] | null {
  const lines = usefulDirectives(text);
  const start = lines.indexOf(opening);
  if (start === -1) return null;
  const body: string[] = [];
  let depth = 0;
  for (const line of lines.slice(start)) {
    body.push(line);
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth <= 0) break;
  }
  return body;
}

/** What `deploy` does with its block, given the one in service. */
export type BlockDecision = "deposit" | "upgrades" | "manifest-changed" | "follows-door" | "forced" | "diverged";

/**
 * The block this deployment generates, against the one the machine serves.
 *
 * - none in service, or the same directives: `deposit`, the ordinary case;
 * - the same, as an earlier release generated it: `upgrades`, the current
 *   generation replaces it without `--force`;
 * - what the manifest the machine carries generates, `previous`, by this
 *   release or an earlier one: `manifest-changed`, the generator's own block
 *   behind a manifest changed since, replaced without `--force` as the
 *   installer replaces it. Without it, a platform component whose manifest
 *   changed its block, the dashboard's headers, stopped `upgrade`, which never
 *   forces, on every machine;
 * - different by the door alone, when the machine carries that door
 *   (`doorConfirmed`): `follows-door`, the dashboard changed it and this
 *   deployment catches up, whichever release generated it;
 * - different otherwise: `diverged`, a decision made by hand on the machine
 *   that the generator knows nothing of, unless `replace` says to overwrite it,
 *   `forced`.
 *
 * Comments do not count, nor order, except inside a `route`: see comparison.ts.
 */
export function decideBlock(state: {
  manifest: Manifest;
  inService: string | null;
  replace: boolean;
  doorConfirmed: boolean;
  /** The manifest deposited on the machine, null when there is none or it does not read. */
  previous?: Manifest | null;
}): BlockDecision {
  const generated = generateFragment(state.manifest);
  if (generated === null || state.inService === null) return "deposit";
  if (sameDirectives(state.inService, generated)) return "deposit";
  if (isEarlierGeneration(state.inService, state.manifest)) return "upgrades";
  const previous = state.previous ?? null;
  if (previous !== null) {
    const before = generateFragment(previous);
    if (before !== null && (sameDirectives(state.inService, before) || isEarlierGeneration(state.inService, previous))) return "manifest-changed";
  }
  if (state.doorConfirmed) {
    const other = { ...state.manifest, portal: isProtected(state.manifest) ? undefined : true };
    const otherDoor = generateFragment(other);
    if (otherDoor !== null && (sameDirectives(state.inService, otherDoor) || isEarlierGeneration(state.inService, other))) {
      return "follows-door";
    }
  }
  return state.replace ? "forced" : "diverged";
}
