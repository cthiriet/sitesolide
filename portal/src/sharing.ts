/**
 * Who may open a site with their work account: the shape of an email and of
 * a domain, and the sign-in settings the portal reads from its environment.
 * Who may open which site is the steward's registry, which the portal reads
 * through its projection (src/projection.ts).
 *
 * Pure and with no import at all: the dashboard borrows this
 * file, its page included, so that the page refuses an address with the exact
 * rule the portal applies, and the steward borrows the names of the settings
 * it lets the dashboard write into `portal.env`.
 */

/** RFC 5321's path limit, which no real address reaches. */
export const EMAIL_MAX = 254;

const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_PATTERN = new RegExp(`^${LABEL}(\\.${LABEL})+$`);

/**
 * Printable ASCII and the space, judged on the text as it came, before any
 * lowercasing or trimming. Both reach beyond ASCII: `"K".toLowerCase()`,
 * the Kelvin sign, is the letter `k`, and `trim()` takes off a no-break space.
 * Judged after them, `Kim@acme.test` or an address wrapped in no-break
 * spaces would collapse onto `kim@acme.test`, another person's.
 */
const RAW_TEXT = /^[\x20-\x7e]*$/;

/**
 * A domain in lowercase, or `null`. At least two labels: `com` alone would
 * share a site with half the internet. A leading `@` is forgiven, people
 * often type the domain the way it follows their own address.
 */
export function cleanDomain(value: unknown): string | null {
  if (typeof value !== "string" || !RAW_TEXT.test(value)) return null;
  const cleaned = value.trim().toLowerCase().replace(/^@/, "");
  if (cleaned.length === 0 || cleaned.length > 253) return null;
  return DOMAIN_PATTERN.test(cleaned) ? cleaned : null;
}

/**
 * An email in lowercase, or `null`.
 *
 * Deliberately narrower than RFC 5322: no quoted local part, no comment, no
 * space, no comma, no control character. Those are legal and nobody's work
 * address, and every one of them is a way to make two strings look like the
 * same person. The comparison that follows is exact, on the lowercase form:
 * the identity provider hands over the address it verified, and the policy
 * names the one the owner typed.
 *
 * Nothing outside ASCII is let into the lowercasing: see `RAW_TEXT`. The
 * spaces at the edges of a typed address are still forgiven; an address the
 * identity provider sends must carry none at all, see `identityFromClaims`.
 */
export function cleanEmail(value: unknown): string | null {
  if (typeof value !== "string" || !RAW_TEXT.test(value)) return null;
  const cleaned = value.trim().toLowerCase();
  if (cleaned.length === 0 || cleaned.length > EMAIL_MAX) return null;
  const at = cleaned.lastIndexOf("@");
  if (at <= 0 || at !== cleaned.indexOf("@")) return null;
  const local = cleaned.slice(0, at);
  if (local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return cleanDomain(cleaned.slice(at + 1)) === cleaned.slice(at + 1) ? cleaned : null;
}

/** The domain of an address already cleaned by `cleanEmail`. */
export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

// --- The sign-in settings --------------------------------------------------------

/**
 * The variables of `portal.env` that configure signing in with an identity
 * provider, beside `PASSWORD_HASH`. The steward lets the dashboard set these
 * and refuses any other name there: one more variable in that file would
 * change how the portal runs rather than add a setting, `DATA_DIR` or `PORT`
 * for instance.
 */
export const IDENTITY_VARIABLES = [
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_ALLOWED_DOMAINS",
  "OIDC_ADMIN_EMAILS",
  "OIDC_PROVIDER_NAME",
] as const;

/**
 * A list as an environment variable carries it: separated by commas, spaces or
 * line breaks, each entry cleaned, the invalid ones dropped. Dropped rather
 * than fatal: a typo in one admin address must not lock every admin out, and
 * the portal says at startup which entries it ignored.
 */
export function readList(text: string, clean: (value: unknown) => string | null): { values: string[]; ignored: string[] } {
  const values = new Set<string>();
  const ignored: string[] = [];
  for (const entry of text.split(/[\s,]+/)) {
    if (entry === "") continue;
    const one = clean(entry);
    if (one === null) ignored.push(entry);
    else values.add(one);
  }
  return { values: [...values].sort(), ignored };
}

/**
 * May this verified email open a session at all? Admins always may. With
 * allowed domains, the email's domain must be one of them; without, anyone the
 * identity provider vouches for may sign in, and still only gets into the
 * sites shared with them.
 */
export function maySignIn(email: string, allowedDomains: readonly string[], admins: readonly string[]): boolean {
  if (admins.includes(email)) return true;
  return allowedDomains.length === 0 || allowedDomains.includes(domainOf(email));
}
