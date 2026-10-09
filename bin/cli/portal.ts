/**
 * The portal as the CLI sees it: the lines a protected site's fragment
 * receives, and the port they aim at.
 *
 * Pure: returns text, touches nothing. The service itself lives in `portal/`,
 * and its README says what surprises people.
 */
import { isProtected, isValidExemption, PORTAL_SLUG, type Manifest } from "./manifest";

/**
 * The portal's local port, written out in full in every protected site's
 * fragment. `portal/src/config.ts` carries the same one, and
 * `bin/tests/cli-portal.test.ts` checks that the two do not diverge.
 */
export const PORTAL_PORT = 3026;

/**
 * What makes a path ambiguous, read on the raw URI: an encoded separator or
 * dot, a double slash, a `.` or `..` segment. The query string, after the `?`,
 * is not looked at: a `return=%2Flist` is legitimate there.
 *
 * `{http.request.uri}` gives the path as it was received, encoding included,
 * where the `path` matcher compares the decoded and cleaned path. That gap is
 * exactly what this rule closes.
 */
export const AMBIGUOUS_EXPRESSION =
  '`{http.request.uri}.matches("^[^?]*(%2[eEfF]|%5[cC]|//|/[.][.]?(/|[?]|$))")`';

/** The two lines that answer 400 to such a path, before anything serves it. */
const AMBIGUOUS_GUARD = [
  `\t@portal_ambiguous expression ${AMBIGUOUS_EXPRESSION}`,
  '\trespond @portal_ambiguous "400: ambiguous path" 400',
];

/**
 * The headers the portal's 200 carries to say who is in, which Caddy copies
 * onto the request the site receives. `portal/src/gate.ts` carries the same
 * names, and `bin/tests/cli-portal.test.ts` checks that the two agree.
 */
export const IDENTITY_HEADERS = ["X-Sitesolide-User", "X-Sitesolide-User-Name", "X-Sitesolide-Role"] as const;

/** The family the portal's headers belong to, the names a later version adds included. */
export const IDENTITY_PREFIX = "X-Sitesolide-";

/**
 * What `request_header` takes off before anything reaches an app, one line
 * each: every name that an app could read as one of the portal's headers.
 *
 * Not the dash form alone. A CGI-style server, PHP's, Rack's, WSGI's, turns
 * `X_Sitesolide_User` and `X-Sitesolide-User` into the same
 * `HTTP_X_SITESOLIDE_USER`, so a visitor's underscore form would pass for
 * the portal's. Caddy 2.11.4 drops a header whose name carries an underscore
 * the moment it arrives, but the repository pins no Caddy version, and a
 * release that kept them would open every site at once.
 *
 * Two patterns cover every spelling. Go canonicalises a name on arrival: its
 * first letter and every letter after a dash in upper case, the rest in lower
 * case, an underscore separating nothing. `x_SITESOLIDE_role` arrives as
 * `X_sitesolide_role`, `x-sitesolide_user` as `X-Sitesolide_user`: every
 * name an app could merge with the portal's starts with `X-Sitesolide` or
 * `X_sitesolide`, whatever follows. Written in that canonical case, they
 * match whether Caddy compares the case, as older releases did, or not, as
 * 2.11 does. bin/tests/cli-portal-identity-caddy.test.ts measures it, the
 * underscore forms put on inside Caddy since they cannot arrive.
 */
export const IDENTITY_STRIP = ["X-Sitesolide*", "X_sitesolide*"] as const;

/** The strip as a block writes it, at the given indentation. */
function stripLines(indent: string): string[] {
  return IDENTITY_STRIP.map((pattern) => `${indent}request_header -${pattern}`);
}

/**
 * The stanzas this generator writes, the current one first.
 *
 * - `identity`: the visitor's `X-Sitesolide-*` taken off every request of every
 *   block, then, behind the portal, the portal's copied on after its 200;
 * - `cookie`: the blocks from before identities, which still run on the
 *   machine. A protected one opens and closes exactly like the current one;
 *   the site simply learns nothing of who came in. Protected or not, a header
 *   the visitor sent under one of those names reaches the app untouched.
 *
 * A block in service written by the earlier generation is the generator's own,
 * one release behind, never a hand edit: `deploy` and the gatekeeper replace it
 * with the current one without asking for `--force`. See `isEarlierGeneration`
 * in fragment.ts.
 */
export const PORTAL_GENERATIONS = ["identity", "cookie"] as const;

export type PortalGeneration = (typeof PORTAL_GENERATIONS)[number];

/**
 * What a preview block announces to the portal: the host the visitor asked
 * for, which is the site's own address.
 */
export const ANNOUNCED_HOST = "{host}";

/**
 * What the block of a site's own domain announces: the host the visitor asked
 * for, then the site's address under the zone, `<slug>.{$SITESOLIDE_ZONE}`,
 * which Caddy substitutes while reading the configuration.
 *
 * The portal signs its cookies, checks origins and sends people back with the
 * first, the host the browser is on, and finds who may open the site with the
 * second: the steward's projection files a site's people under its address,
 * and a domain is not one, nor written anywhere the portal reads. The block
 * knows whose domain it serves, it is generated from that site's manifest,
 * and says so on every request.
 *
 * In the one header every protected block overwrites, never in a second one:
 * a block deployed before this one existed would pass a visitor's second
 * header through untouched, and a person allowed on one site would have the
 * portal judge them against it on any other. A block matches its host
 * exactly, so `{host}` holds no space a visitor could add a second name with.
 */
export function announcedFor(slug: string, zoneHost: string): string {
  return `"{host} ${slug}.${zoneHost}"`;
}

/**
 * The stanza for a protected site's block, its preview's or its own
 * domain's, or nothing.
 *
 * Measured in a local Caddy laboratory, and checked by
 * `bin/tests/cli-portal-caddy.test.ts` against the text generated here:
 *
 * - `forward_auth` comes before the site's `reverse_proxy` and `file_server`:
 *   nothing is served without the portal's agreement, not even a file from
 *   public/;
 * - `reverse_proxy /_portal/*`, a single path matcher, comes before the site's
 *   `reverse_proxy @dynamic`: sign-in reaches the portal;
 * - `header_up` overwrites an `X-Portal-Hote` forged by the visitor, and it is
 *   the only source of the host the portal believes, and of the site it
 *   judges (see `announcedFor`);
 * - portal stopped, Caddy answers 502 and serves nothing: the door fails
 *   closed.
 *
 * `lb_try_duration` makes a request wait out a portal restart, rather than
 * answering 502 to the second.
 *
 * ## Why the identity headers take a `route`
 *
 * The visitor's own `X-Sitesolide-*` must be gone before `forward_auth`
 * copies the portal's: Caddy copies a header only when the portal's answer
 * carries it, and the owner's password names nobody, so a visitor holding it
 * could otherwise send `X-Sitesolide-User: ceo@...` and have it reach the
 * site. Left to itself, Caddy sorts `request_header` AFTER `forward_auth`, and
 * would take off the portal's headers instead of the visitor's: measured,
 * every site then learns nobody. A `route` keeps its written order, and is the
 * only directive that does.
 *
 * The `route` sorts after `handle`, where `forward_auth` alone sorted before:
 * the lock's `handle` now runs first. That changes nothing, a lock answers for
 * its own host alone and `validate()` never lets a protected site be locked,
 * and even then a lock either answers itself or lets the request fall through
 * to the portal. Everything that serves, `respond`, `reverse_proxy` and
 * `file_server`, still sorts after the `route`. The exempted paths go through
 * it too: they are taken off the visitor's headers and skip the portal.
 */
export function portalStanza(manifest: Manifest, generation: PortalGeneration = "identity", announced = ANNOUNCED_HOST): string[] {
  if (!isProtected(manifest)) return [];

  const upstream = `127.0.0.1:${PORTAL_PORT}`;
  // The second barrier behind validate(), as for the routes in fragment.ts:
  // an exemption that would break the matcher is never written.
  for (const path of manifest.portalExempt ?? []) {
    if (!isValidExemption(path)) throw new Error(`portalExempt: ${JSON.stringify(path)} is not a path validate() accepts, it is never written into a Caddy block`);
  }
  const open = ["/_portal/*", ...(manifest.portalExempt ?? [])].join(" ");
  const guard = [
    `forward_auth @portal_guard ${upstream} {`,
    "\turi /verifier",
    `\theader_up X-Portal-Hote ${announced}`,
    "\tlb_try_duration 5s",
    ...(generation === "identity" ? [`\tcopy_headers ${IDENTITY_HEADERS.join(" ")}`] : []),
    "}",
  ];
  const check =
    generation === "identity"
      ? [
          "\t# Who is in: the visitor's own X-Sitesolide-* headers, and their",
          "\t# underscore spellings, are taken off every request, then the portal's",
          "\t# are copied on after its 200. Inside a route, because Caddy otherwise",
          "\t# sorts request_header after forward_auth and would take off the",
          "\t# portal's instead. See bin/cli/portal.ts.",
          "\troute {",
          ...stripLines("\t\t"),
          ...guard.map((line) => `\t\t${line}`),
          "\t}",
        ]
      : guard.map((line) => `\t${line}`);
  return [
    "\t# Shared portal: before every request, Caddy asks the portal whether the",
    "\t# visitor has a valid cookie; if not the portal answers 401 with its",
    "\t# sign-in page. /_portal/* goes to the portal itself, and the exempted",
    "\t# paths go to the site without asking. See portal/README.md.",
    "\t#",
    "\t# A path Caddy and the service would read differently is refused: Caddy",
    "\t# decodes %2f and cleans .. before comparing against the exemptions, the",
    "\t# service routes on the raw path. /api/x%2f..%2f..%2fhook/y would",
    "\t# otherwise look exempt to Caddy and reach /api/x/... in the service,",
    "\t# with no cookie. No browser sends such paths.",
    ...AMBIGUOUS_GUARD,
    "",
    `\treverse_proxy /_portal/* ${upstream} {`,
    `\t\theader_up X-Portal-Hote ${announced}`,
    "\t}",
    `\t@portal_guard not path ${open}`,
    ...check,
    "",
  ];
}

/**
 * The strip for a block that does not go through the portal: a site with its
 * door off, or never on, and every customer domain. Without it, a site whose
 * portal was turned off would hand its app whatever `X-Sitesolide-Role: admin`
 * a stranger sends, and an app written to trust the headers behind the portal
 * would believe it.
 *
 * At the block's level, where its position does not matter: such a block
 * carries no `forward_auth` to sort after. Never in the `(<slug>-routes)`
 * snippet nor in `(commun)`, which protected blocks import too: there, it would
 * only hold as long as their `forward_auth` stays inside its `route`, which
 * sorts after `request_header`. Measured, a `forward_auth` outside a route,
 * the earlier generation's or one written by hand, sorts before it, and the
 * strip then takes off the portal's own headers.
 *
 * Nothing in the earlier generation: those blocks took nothing off, and are
 * recognised as the generator's own, see `PORTAL_GENERATIONS`.
 */
export function openStanza(generation: PortalGeneration = "identity"): string[] {
  if (generation !== "identity") return [];
  return [
    "\t# Not behind the portal: nobody signed in, and the X-Sitesolide-* headers",
    "\t# a visitor sends, in any spelling, are taken off before the app reads",
    "\t# them. See openStanza in bin/cli/portal.ts.",
    ...stripLines("\t"),
    "",
  ];
}

/**
 * What the portal's own block adds, `portal.<zone>`, which no portal guards.
 *
 * Its manifest's `routes` are an allow list, `/sante` and the provider's
 * steps, and they are the only thing standing between the web and the
 * dashboard's `/admin/*` routes on the same port. Caddy compares them on the
 * decoded, cleaned path, and the service routes on the raw one:
 * `/admin/sharing/..%2f..%2fsante` looked like `/sante` to Caddy and reached
 * the admin route, stopped only by its `X-Forwarded-For` check. The same 400
 * as a protected block's, for the same reason.
 */
export function portalHostStanza(manifest: Manifest, generation: PortalGeneration = "identity"): string[] {
  if (manifest.slug !== PORTAL_SLUG || isProtected(manifest) || generation !== "identity") return [];
  return [
    "\t# The portal's own host: its routes are an allow list, and a path Caddy",
    "\t# and the service would read differently is refused. Caddy decodes %2f",
    "\t# and cleans .. before comparing, the service routes on the raw path:",
    "\t# /admin/sharing/..%2f..%2fsante would otherwise pass for /sante and",
    "\t# reach the admin routes. See portalHostStanza in bin/cli/portal.ts.",
    ...AMBIGUOUS_GUARD,
    "",
  ];
}

/**
 * Does the running fragment carry the door?
 *
 * The dashboard uses this to compare the manifest's intent with what Caddy
 * really applies. The discrepancy matters: a site that asks for the portal and whose
 * block does not carry it is served in the clear, and its owner believes it
 * closed.
 */
export function fragmentIsProtected(fragment: string): boolean {
  return fragment.includes(`forward_auth @portal_guard 127.0.0.1:${PORTAL_PORT}`);
}

/**
 * Does the running fragment hand the site the portal's identity headers, the
 * visitor's taken off first? A protected block from before identities does
 * not: the site behind it must not trust an `X-Sitesolide-*` header until it
 * has been deployed again.
 */
export function fragmentPassesIdentity(fragment: string): boolean {
  return (
    fragmentIsProtected(fragment) &&
    stripLines("").every((line) => fragment.includes(line)) &&
    fragment.includes(`copy_headers ${IDENTITY_HEADERS.join(" ")}`)
  );
}
