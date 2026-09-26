import { join, normalize } from "node:path";

/**
 * Cache duration by kind of resource: HTML must stay fresh, media must not. A
 * single policy, valid everywhere: the local server must behave like Caddy
 * online, otherwise a cache defect is only discovered after a release. These
 * rules are those of the `(commun)` snippet of infra/caddy/Caddyfile, and
 * tests/cache-caddy.test.ts fails if the two diverge.
 *
 * The dashboard's responses never go through here: `src/responses.ts` returns
 * them as `no-store`, a page kept behind the portal not having to be read again
 * without it.
 *
 * A single file of `public/` really counts, `a.js`, which every measured site
 * loads on every page. It falls under the `no-cache` rule below, so the browser
 * keeps it and only asks whether it has changed, to which the answer is a 304
 * in a few hundred bytes. That is what is needed here: a script frozen for an
 * hour would take an hour to correct itself on every site at once.
 */
export function cacheControl(pathname: string): string {
  if (pathname.endsWith(".html") || pathname === "/") {
    return "public, max-age=0, must-revalidate";
  }
  // A name that carries a content fingerprint, styles.4f3a9c2b.css, designates
  // one single content for ever: freezing it for a year cannot make it stale.
  // A site's own build may fingerprint its assets this way at deployment
  // time, never on the workstation, hence a rule that stays without effect in
  // development.
  if (FINGERPRINTED.test(pathname)) {
    return "public, max-age=31536000, immutable";
  }
  if (/\.(jpg|jpeg|png|webp|avif|svg|ico|woff2?)$/.test(pathname)) {
    return "public, max-age=31536000, immutable";
  }
  // no-cache does not mean without cache: the browser keeps the file and only
  // asks whether it has changed. One round trip per file, against a stale style
  // made impossible.
  return "no-cache";
}

/**
 * The pattern of a fingerprinted file: eight hexadecimal characters between the
 * name and the extension. It also stands as a contract with the build that
 * fingerprints a site's assets, and with the `@fingerprinted` matcher of the
 * Caddyfile, which recognises them online.
 */
export const FINGERPRINTED = /\.[0-9a-f]{8}\.(css|js|mjs)$/;

/**
 * Resolves a public URL into a disk path, refusing everything that leaves
 * `public/` (`..`, absolute paths, encoded sequences).
 */
export function resolveAsset(pathname: string, root: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes(String.fromCharCode(0))) return null;

  const relative = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  const resolved = join(root, relative);
  return resolved.startsWith(root) ? resolved : null;
}
