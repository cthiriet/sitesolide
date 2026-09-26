/**
 * The service's responses, all built here.
 *
 * This service has only one audience left: browsers that will never read what
 * they are answered. So it answers them as little as possible. The dashboard's
 * pages lived here until 20 September 2026; they moved to the dashboard, the
 * only place where the numbers of every site are read together, and the content
 * policy that guarded them left with them.
 */

/**
 * Those of the `(commun)` block of the Caddyfile, so that local mimics
 * production, plus the `X-Robots-Tag` of the manifest, which
 * `tests/manifest.test.ts` compares.
 */
export const HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

/**
 * Ingestion's answer: nothing, and as fast as possible.
 *
 * **A 204 with no body, and no origin header.** The browser that sends a page
 * view never reads what it is answered: `sendBeacon` does not hand the response
 * back to the script, and the request leaves as `no-cors`. There is therefore
 * no CORS header to set, and setting none is the right choice: `Access-Control-
 * Allow-Origin: *` would let any page read what this service answers, which is
 * useful to nobody.
 *
 * A refusal answers the same. An error body would be read by nobody, and
 * telling an anonymous page why it is refused means telling it how to stop
 * being refused: the allow list of hosts would be guessed that way, one host at
 * a time.
 */
export function acknowledge(): Response {
  return new Response(null, {
    status: 204,
    headers: { "Cache-Control": "no-store" },
  });
}

/** Plain text, for the refusals that are neither the dashboard nor ingestion. */
export function plainText(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      ...HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
