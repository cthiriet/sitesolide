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
 * The stanza for a protected site's preview block, or nothing.
 *
 * Measured in a local Caddy laboratory, and checked by
 * `bin/tests/cli-portal-caddy.test.ts` against the text generated here:
 *
 * - `forward_auth` sorts before everything else in the block, the lock's
 *   `handle` included, and before the site's `reverse_proxy` and
 *   `file_server`: nothing is served without the portal's agreement, not even
 *   a file from public/;
 * - `reverse_proxy /_portal/*`, a single path matcher, comes before the site's
 *   `reverse_proxy @dynamic`: sign-in reaches the portal;
 * - `header_up` overwrites an `X-Portal-Hote` forged by the visitor, and it is
 *   the only source of the host the portal believes;
 * - portal stopped, Caddy answers 502 and serves nothing: the door fails
 *   closed.
 *
 * `lb_try_duration` makes a request wait out a portal restart, rather than
 * answering 502 to the second.
 */
export function portalStanza(manifest: Manifest): string[] {
  if (!isProtected(manifest)) return [];

  const upstream = `127.0.0.1:${PORTAL_PORT}`;
  const open = ["/_portal/*", ...(manifest.portalExempt ?? [])].join(" ");
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
    `\tforward_auth @portal_guard ${upstream} {`,
    "\t\turi /verifier",
    "\t\theader_up X-Portal-Hote {host}",
    "\t\tlb_try_duration 5s",
    "\t}",
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
