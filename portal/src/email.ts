/**
 * The shape of an email, which names who a password access was given to.
 *
 * Pure and with no import at all: the dashboard borrows this file, its page
 * included, so that the page refuses an address with the exact rule the
 * steward and the portal apply.
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
 * same person. The comparison that follows is exact, on the lowercase form.
 *
 * Nothing outside ASCII is let into the lowercasing: see `RAW_TEXT`. The
 * spaces at the edges of a typed address are still forgiven.
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
