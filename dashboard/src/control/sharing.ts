/**
 * Sharing a project through the control API: who may open it with their work
 * account, changed by a token that may deploy it, the way the dashboard's
 * Sharing section changes it for the owner. The routes are in api.ts; the
 * rules are here, pure.
 *
 * **The same relay as the Sharing section.** The dashboard asks the portal's
 * admin API with the client of src/sharing.ts, on the same route, and the
 * portal judges the policy and records the change in its own audit. One thing
 * differs: the actor the portal records is `token:<id>`, never `owner`. No new
 * network path either: the dashboard is the one service the loopback rule
 * already lets reach the portal.
 *
 * **What a token may do is narrower than what the owner may**, because the
 * person holding it is not the one who decided who the company's colleagues
 * are:
 *
 * - only on a project it may deploy, its own or one granted to it: any other
 *   slug reads as unknown, as for its logs;
 * - only on a site whose block in service carries the portal, as in the
 *   Sharing section: elsewhere a policy would close nothing;
 * - people, at any address: sharing with someone is what the route is for,
 *   and that person still has to sign in with an account the portal admits;
 * - a whole domain only among the domains the portal already admits at sign
 *   in, `OIDC_ALLOWED_DOMAINS`, which the owner chose as the company's own.
 *   Without that list, anyone the provider vouches for may sign in, and a
 *   token may open a site to no domain at all: `gmail.com` would be half the
 *   internet;
 * - never public: public is not a mode, it is the portal turned off, which
 *   stays the owner's, from the site's Access section.
 *
 * Narrowing is always allowed: removing someone, removing a domain, going back
 * to the admins alone.
 */
import { cleanDomain, cleanEmail, DOMAINS_MAX, PEOPLE_MAX, readPolicy, type Policy } from "../../borrowed/sharing";
import type { ProjectSharing } from "./protocol";

/** What a token sends: the policy's three keys, and nothing else, an `actor` least of all. */
export const SHARING_KEYS = ["mode", "people", "domains"] as const;

/** 500 addresses of 254 characters and 50 domains fit with room to spare. */
export const MAX_SHARING_BYTES = 256 * 1024;

export type SharingRefusal = { code: "invalid" | "out-of-scope"; message: string; details: string[] };

export type TokenPolicyReading = { policy: Policy } | { refusal: SharingRefusal };

const SHAPE = 'send { "mode": "admins" | "people" | "domain", "people": [emails], "domains": [domains] }';

/** The entries of a list the portal would refuse, named, so that the caller fixes the right one. */
function badEntries(values: unknown, clean: (value: unknown) => string | null, max: number, what: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) return [`${what}: a list`];
  if (values.length > max) return [`${what}: ${max} at most, ${values.length} given`];
  return values.filter((value) => clean(value) === null).map((value) => `${what}: ${JSON.stringify(value).slice(0, 80)} is not accepted`);
}

/**
 * A token's policy, judged before the portal is asked: with the portal's own
 * rule (borrowed/sharing.ts), each refused entry named. `public` is answered
 * apart, saying whose decision it is, rather than as an unknown mode.
 */
export function readTokenPolicy(body: Record<string, unknown>): TokenPolicyReading {
  const unexpected = Object.keys(body).filter((key) => !(SHARING_KEYS as readonly string[]).includes(key));
  if (unexpected.length > 0) {
    return { refusal: { code: "invalid", message: `unexpected field: ${unexpected.join(", ")}`, details: [SHAPE] } };
  }
  if (body.mode === "public") {
    return {
      refusal: {
        code: "out-of-scope",
        message: "public is not a sharing mode: making a site public turns its portal off, which only the owner of the machine does, from the site's Access section in the dashboard",
        details: ["share it with people by email, or with everyone at a domain the portal admits"],
      },
    };
  }
  const reading = readPolicy(body);
  if (!("error" in reading)) return { policy: reading.policy };
  const details =
    reading.error === "invalid-mode"
      ? ["mode: admins, people or domain"]
      : [...badEntries(body.people, cleanEmail, PEOPLE_MAX, "people"), ...badEntries(body.domains, cleanDomain, DOMAINS_MAX, "domains")];
  return { refusal: { code: "invalid", message: "this sharing policy is refused: fix every point in details, nothing was changed", details: details.length > 0 ? details : [SHAPE] } };
}

/** The domains a policy opens the site to: its list, in domain mode only. */
function openedDomains(policy: Policy): readonly string[] {
  return policy.mode === "domain" ? policy.domains : [];
}

/**
 * Why a token may not go from `before` to `after`, one line per domain, or
 * nothing. A domain the token adds to the list, or opens by switching to
 * domain mode, must be one the portal admits at sign-in. A domain already
 * open is not the token's doing, and keeping it is not widening; nor is one
 * kept in the list while another mode is in effect, as long as it stays shut.
 */
export function domainRefusals(before: Policy, after: Policy, allowed: readonly string[]): string[] {
  const open = openedDomains(before);
  const refusals: string[] = [];
  for (const domain of after.domains) {
    if (allowed.includes(domain)) continue;
    if (!before.domains.includes(domain)) {
      refusals.push(`${domain}: not among the domains the portal admits at sign-in`);
    } else if (after.mode === "domain" && !open.includes(domain)) {
      refusals.push(`${domain}: kept in the list from an earlier sharing, and domain mode would open it; remove it from the list, or ask the owner of the machine`);
    }
  }
  return refusals;
}

/** What the refusal of a domain says, with the domains the token may use. */
export function domainMessage(allowed: readonly string[]): string {
  if (allowed.length === 0) {
    return "your token may open a site to no domain: the portal lets anyone its provider vouches for sign in (OIDC_ALLOWED_DOMAINS is empty), so share with people by email, or ask the owner of the machine";
  }
  return `your token may open a site only to the domains the portal admits at sign-in: ${allowed.join(", ")}`;
}

/** The portal's answer to `GET /admin/sharing`, as far as this route reads it. */
export type PortalSharing = {
  sso: { configured: boolean; providerName: string | null; allowedDomains: string[] };
  sites: { host: string; policy: Policy; updatedAt: number }[];
};

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPolicy(value: unknown): value is Policy {
  if (typeof value !== "object" || value === null) return false;
  const policy = value as Record<string, unknown>;
  return (policy.mode === "admins" || policy.mode === "people" || policy.mode === "domain") && isStringList(policy.people) && isStringList(policy.domains);
}

/** The portal's list, or null when it is not what this release of the portal answers. */
export function readPortalSharing(body: unknown): PortalSharing | null {
  if (typeof body !== "object" || body === null) return null;
  const { sso, sites } = body as Record<string, unknown>;
  if (typeof sso !== "object" || sso === null || !Array.isArray(sites)) return null;
  const view = sso as Record<string, unknown>;
  if (typeof view.configured !== "boolean" || !isStringList(view.allowedDomains)) return null;
  const read: PortalSharing["sites"] = [];
  for (const site of sites as unknown[]) {
    if (typeof site !== "object" || site === null) return null;
    const { host, policy, updatedAt } = site as Record<string, unknown>;
    if (typeof host !== "string" || !isPolicy(policy) || typeof updatedAt !== "number") return null;
    read.push({ host, policy, updatedAt });
  }
  return {
    sso: { configured: view.configured, providerName: typeof view.providerName === "string" ? view.providerName : null, allowedDomains: view.allowedDomains },
    sites: read,
  };
}

/** The portal's answer to `PUT /admin/sharing/:host`: the policy as it saved it, and when. */
export function readSavedPolicy(body: unknown): { policy: Policy; updatedAt: number } | null {
  if (typeof body !== "object" || body === null) return null;
  const { policy, updatedAt } = body as Record<string, unknown>;
  return isPolicy(policy) && typeof updatedAt === "number" ? { policy, updatedAt } : null;
}

/** The policy of one host, the admins alone when it was never set. */
export function policyOf(list: PortalSharing, host: string): { policy: Policy; updatedAt: number | null } {
  const found = list.sites.find((site) => site.host === host);
  return found === undefined ? { policy: { mode: "admins", people: [], domains: [] }, updatedAt: null } : { policy: found.policy, updatedAt: found.updatedAt };
}

/** What the API answers about a project's sharing. */
export function projectSharing(slug: string, host: string, list: PortalSharing, current: { policy: Policy; updatedAt: number | null }): ProjectSharing {
  return {
    slug,
    host,
    url: `https://${host}/`,
    policy: current.policy,
    updatedAt: current.updatedAt,
    sso: { configured: list.sso.configured, providerName: list.sso.providerName },
    allowedDomains: list.sso.allowedDomains,
  };
}
