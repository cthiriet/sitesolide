/**
 * Who may open a site with their work account: the site's sharing policy, the
 * shape of an email and of a domain, and the sign-in settings the portal reads
 * from its environment.
 *
 * Pure and with no import at all, like `guests.ts`: the dashboard borrows this
 * file, its page included, so that the page refuses an address with the exact
 * rule the portal applies, and the steward borrows the names of the settings
 * it lets the dashboard write into `portal.env`.
 *
 * ## The three modes
 *
 * Cumulative, from the narrowest to the widest:
 *
 * - `admins`, the default and what every site had before sharing existed: the
 *   owner's password, the admin emails, and the password guests;
 * - `people`: the above, plus the listed emails;
 * - `domain`: the above, plus everyone whose verified email belongs to one of
 *   the listed domains, everyone at `acme.com` for instance.
 *
 * "Public" is not a mode: it is the portal turned off, which the site's Access
 * section already does through the gatekeeper, Caddy included. A policy only
 * ever touches the portal's database.
 *
 * Both lists are kept whatever the mode, the way `portalExempt` is kept when
 * the door comes off: going back from `admins` to `people` reopens the site to
 * the same people instead of starting from an empty list.
 */

export const SHARING_MODES = ["admins", "people", "domain"] as const;

export type SharingMode = (typeof SHARING_MODES)[number];

export type Policy = {
  mode: SharingMode;
  /** Lowercase, sorted, without duplicates. */
  people: string[];
  /** Lowercase, sorted, without duplicates, without a leading `@`. */
  domains: string[];
};

/** What a site with no stored policy gets: exactly what it had before sharing existed. */
export const DEFAULT_POLICY: Policy = { mode: "admins", people: [], domains: [] };

/** RFC 5321's path limit, which no real address reaches. */
export const EMAIL_MAX = 254;

/** Beyond this, a site is no longer shared with people one by one: a domain says it better. */
export const PEOPLE_MAX = 500;

export const DOMAINS_MAX = 50;

/**
 * The roles a protected site learns through `X-Sitesolide-Role`: `admin` for
 * the owner's password and the admin emails, `member` for whoever the policy
 * lets in, `guest` for a password guest.
 */
export type Role = "admin" | "member" | "guest";

const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_PATTERN = new RegExp(`^${LABEL}(\\.${LABEL})+$`);

/**
 * A domain in lowercase, or `null`. At least two labels: `com` alone would
 * share a site with half the internet. A leading `@` is forgiven, people
 * often type the domain the way it follows their own address.
 */
export function cleanDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
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
 */
export function cleanEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
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

export function isSharingMode(value: unknown): value is SharingMode {
  return typeof value === "string" && (SHARING_MODES as readonly string[]).includes(value);
}

export type PolicyReading = { policy: Policy } | { error: string };

function cleanList(values: unknown, clean: (value: unknown) => string | null, max: number, error: string): string[] | string {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > max) return error;
  const cleaned = new Set<string>();
  for (const value of values) {
    const one = clean(value);
    if (one === null) return error;
    cleaned.add(one);
  }
  return [...cleaned].sort();
}

/**
 * A policy as the dashboard sends it, judged. Every entry must be valid: one
 * bad address refuses the whole change rather than saving the rest, the owner
 * would otherwise believe someone was added who was not.
 */
export function readPolicy(body: unknown): PolicyReading {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "invalid-policy" };
  const { mode, people, domains } = body as Record<string, unknown>;
  if (!isSharingMode(mode)) return { error: "invalid-mode" };
  const cleanPeople = cleanList(people, cleanEmail, PEOPLE_MAX, "invalid-people");
  if (typeof cleanPeople === "string") return { error: cleanPeople };
  const cleanDomains = cleanList(domains, cleanDomain, DOMAINS_MAX, "invalid-domains");
  if (typeof cleanDomains === "string") return { error: cleanDomains };
  return { policy: { mode, people: cleanPeople, domains: cleanDomains } };
}

/**
 * What a verified email may do on a site, or `null` if the site is not shared
 * with it. Re-evaluated on every request by the gate: a person removed from
 * the list is refused from the next request on, cookie in hand.
 */
export function identityRole(email: string, policy: Policy, admins: readonly string[]): "admin" | "member" | null {
  if (admins.includes(email)) return "admin";
  if (policy.mode === "admins") return null;
  if (policy.people.includes(email)) return "member";
  if (policy.mode === "domain" && policy.domains.includes(domainOf(email))) return "member";
  return null;
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
