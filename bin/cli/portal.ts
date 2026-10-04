/**
 * The portal as the CLI sees it: the lines a protected site's fragment
 * receives, and the port they aim at.
 *
 * Pure: returns text, touches nothing. The service itself lives in `portal/`,
 * and its README says what surprises people.
 */
import { isProtected, type Manifest } from "./manifest";

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

/**
 * The headers the portal's 200 carries to say who is in, which Caddy copies
 * onto the request the site receives. `portal/src/gate.ts` carries the same
 * names, and `bin/tests/cli-portal.test.ts` checks that the two agree.
 */
export const IDENTITY_HEADERS = ["X-Sitesolide-User", "X-Sitesolide-User-Name", "X-Sitesolide-Role"] as const;

/**
 * What the visitor sends under this prefix never reaches the site: the whole
 * family is taken off, the names a later version adds included, before the
 * portal's own are copied on.
 */
export const IDENTITY_PREFIX = "X-Sitesolide-";

/**
 * The stanzas this generator writes, the current one first.
 *
 * - `identity`: the visitor's `X-Sitesolide-*` taken off every request, then
 *   the portal's copied on after its 200;
 * - `cookie`: the stanza from before identities, which still runs on the
 *   blocks deployed before them. It opens and closes exactly like the current
 *   one; the site simply learns nothing of who came in, and a header the
 *   visitor sent under one of those names reaches it untouched.
 *
 * A block in service written by the earlier generation is the generator's own,
 * one release behind, never a hand edit: `deploy` and the gatekeeper replace it
 * with the current one without asking for `--force`. See `isEarlierGeneration`
 * in fragment.ts.
 */
export const PORTAL_GENERATIONS = ["identity", "cookie"] as const;

export type PortalGeneration = (typeof PORTAL_GENERATIONS)[number];

/**
 * The stanza for a protected site's preview block, or nothing.
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
 *   the only source of the host the portal believes;
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
export function portalStanza(manifest: Manifest, generation: PortalGeneration = "identity"): string[] {
  if (!isProtected(manifest)) return [];

  const upstream = `127.0.0.1:${PORTAL_PORT}`;
  const open = ["/_portal/*", ...(manifest.portalExempt ?? [])].join(" ");
  const guard = [
    `forward_auth @portal_guard ${upstream} {`,
    "\turi /verifier",
    "\theader_up X-Portal-Hote {host}",
    "\tlb_try_duration 5s",
    ...(generation === "identity" ? [`\tcopy_headers ${IDENTITY_HEADERS.join(" ")}`] : []),
    "}",
  ];
  const check =
    generation === "identity"
      ? [
          "\t# Who is in: the visitor's own X-Sitesolide-* headers are taken off every",
          "\t# request, then the portal's are copied on after its 200. Inside a route,",
          "\t# because Caddy otherwise sorts request_header after forward_auth and",
          "\t# would take off the portal's instead. See bin/cli/portal.ts.",
          "\troute {",
          `\t\trequest_header -${IDENTITY_PREFIX}*`,
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
    `\t@portal_ambiguous expression ${AMBIGUOUS_EXPRESSION}`,
    '\trespond @portal_ambiguous "400: ambiguous path" 400',
    "",
    `\treverse_proxy /_portal/* ${upstream} {`,
    "\t\theader_up X-Portal-Hote {host}",
    "\t}",
    `\t@portal_guard not path ${open}`,
    ...check,
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
    fragment.includes(`request_header -${IDENTITY_PREFIX}*`) &&
    fragment.includes(`copy_headers ${IDENTITY_HEADERS.join(" ")}`)
  );
}
