/**
 * The contract of access: who may do what on a project. Shapes and constants
 * only, like the other protocol files: the page imports nothing from here but
 * types.
 *
 * ## The model
 *
 * Per project, two settings and one list:
 *
 * - **General access**, who may open the site at all: `public`, anyone;
 *   `restricted`, the people with access, the portal in front; `code`, anyone
 *   with the preview code. It is what the manifest's `portal` flag and the
 *   preview lock already say: the machine carries it, not this registry.
 * - **People with access**, entries of `{ who, role }`: `who` an email or a
 *   whole domain, `@acme.com`; `role` one rung of the ladder
 *   (borrowed/access.ts): `visitor` (Can open), `viewer`, `developer`,
 *   `admin`.
 *
 * Rules, few and strict, judged by the steward alone (rules.ts):
 *
 * - a domain is `visitor` only;
 * - a person inside the company's domains (`OIDC_ALLOWED_DOMAINS`) signs in
 *   with their company account and may hold any role;
 * - a person outside them, or anyone when no company sign-in is set up, is
 *   `visitor` only, and opens the site with a password drawn for them, shown
 *   once, until an expiry chosen when it is given: password access;
 * - an admin grants at most their own role, on their project alone; the owner
 *   grants anything;
 * - removing someone, or lowering them, holds from their next request.
 *
 * Machine-wide, beside the projects: the right to create projects, which the
 * owner grants per person; who creates a project becomes its `admin`.
 *
 * ## Who keeps it
 *
 * The steward, root, in `/var/lib/sitesolide-steward/access.json`, 0600,
 * written atomically, the one registry. After every change it writes the
 * projection the portal reads (borrowed/access.ts), and the dashboard reads
 * a person's roles from it at every request.
 *
 * ## The steward's routes
 *
 * On the owner's socket, which only root opens, for `sitesolide share` and
 * `sitesolide people` over the owner's SSH, no unlock:
 *
 *   GET    /access?slug=<slug>                                   -> AccessResponse
 *   PUT    /access/entry   { slug, who, role, expiresInS? }       -> EntryResponse, the password once when one is drawn
 *   DELETE /access/entry   { slug, who }                         -> EntryResponse
 *   GET    /people                                               -> PeopleResponse
 *   PUT    /people/person  { email, create }                     -> PersonResponse
 *   DELETE /people/person  { email }                             -> PersonResponse
 *
 * On the dashboard's socket, the same for the owner's session, `token` the
 * live unlock where the change needs it (a role above `visitor`, the create
 * right); and for a person's session, an admin of the project:
 *
 *   POST   /access/person/list   { session, slug }                                   -> AccessResponse
 *   PUT    /access/person/entry  { session, token?, slug, who, role, expiresInS? }  -> EntryResponse
 *   DELETE /access/person/entry  { session, slug, who }                             -> EntryResponse
 *
 * A token's (src/control/steward.ts), `visitor` entries alone:
 *
 *   POST   /control/access/list   { bearer, slug }
 *   PUT    /control/access        { bearer, slug, who, role }
 *   DELETE /control/access        { bearer, slug, who }
 *
 * Every refusal is `{ error, message }`, the message in English, shown as it
 * stands.
 */
import type { Role } from "../../borrowed/access";

export type { Role } from "../../borrowed/access";

/** The registry's file, in the steward's state folder. */
export const REGISTRY_NAME = "access.json";

/** The registry before it: the dashboard's people and their roles, kept read-only once carried over. */
export const LEGACY_REGISTRY_NAME = "members.json";

/** The portal's database, where sharing and password access lived before the registry. */
export const PORTAL_DATABASE = "portal.db";

/** Entries on one project: a few hundred people, a few domains. */
export const MAX_ENTRIES = 600;

/** People who sign in to the dashboard, a role above `visitor` or the create right: a team, not a directory. */
export const MAX_DASHBOARD_PEOPLE = 200;

/**
 * How long a password access lasts, chosen when it is given. The portal's
 * guest durations, the same four, so that nothing is offered that was not.
 */
export const PASSWORD_DURATIONS_S = [24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600, null] as const;

/** When none is chosen. */
export const DEFAULT_PASSWORD_DURATION_S = 7 * 24 * 3600;

/** Who acts for the dashboard's password, in every audit. */
export const OWNER = "owner";

export type GeneralAccess = "public" | "restricted" | "code";

/** What the machine carries for a project's general access, as the steward reads it. */
export type GeneralView = {
  access: GeneralAccess;
  /** May it be switched between public and restricted from here, and why not. */
  modifiable: boolean;
  reason: string | null;
};

export type EntryKind = "person" | "domain" | "password";

/** One entry of People with access, as it is shown: never a password, its hash or its identifier. */
export type EntryView = {
  who: string;
  kind: EntryKind;
  role: Role;
  /** `owner`, the email of the admin who gave it, `token:<id>`, or `migration`. */
  by: string;
  createdAt: number;
  updatedAt: number;
  /** For password access: until when, and whether that time has passed. */
  password: { expiresAt: number | null; expired: boolean } | null;
};

/** What the portal's settings say of signing in, read by the steward in portal.env. */
export type SignInSettings = {
  configured: boolean;
  /** `OIDC_ALLOWED_DOMAINS`: the company's domains; empty, anyone the provider vouches for. */
  allowedDomains: string[];
  /** `OIDC_ADMIN_EMAILS`: they open every restricted site, as `admin`. */
  admins: string[];
  /** The provider's name, for the line to send; null when portal.env names none. */
  providerName: string | null;
};

export type AccessResponse = {
  slug: string;
  host: string;
  url: string;
  /** Null when the project is not deployed: its entries are kept, its site serves nothing. */
  general: GeneralView | null;
  entries: EntryView[];
  signIn: SignInSettings;
  /**
   * What the portal on the machine reads who may open a site from: `steward`,
   * this registry's projection; `portal`, its own tables still, a portal
   * from before the registry, which the next `sitesolide upgrade` deploys;
   * `unreadable`, the projection does not read and the portal opens nothing
   * from it; `unknown`, it could not be asked.
   */
  portal: { reading: "steward" | "portal" | "unreadable" | "unknown"; writtenAt: number | null };
};

export type EntryChange = "add" | "role" | "none" | "remove";

export type EntryResponse = {
  slug: string;
  entry: EntryView;
  change: EntryChange;
  /** Drawn for password access, shown this once: the registry keeps its hash alone. */
  password?: string;
};

/** Everyone across projects, for the owner. */
export type PersonView = {
  /** An email, or a name a password access was given under before the registry. */
  who: string;
  roles: Record<string, Role>;
  /** May they create projects. */
  create: boolean;
  /** Their password access, per project. */
  passwords: { slug: string; expiresAt: number | null; expired: boolean }[];
  /** One of `OIDC_ADMIN_EMAILS`: opens every restricted site. */
  admin: boolean;
};

export type PeopleResponse = {
  people: PersonView[];
  domains: { slug: string; domain: string }[];
  signIn: SignInSettings;
};

export type PersonResponse = { person: PersonView; change: "create" | "none" | "remove" };

// --- The dashboard's routes, for the page ------------------------------------------
//
//   GET    /api/access?slug=<slug>                               -> AccessPageResponse   the owner, or the project's Admin
//   PUT    /api/access/entry    { slug, who, role, expiresInS? } -> EntryResponse        423 when it needs the unlock
//   DELETE /api/access/entry    { slug, who }                    -> EntryResponse        never an unlock
//   PUT    /api/access/general  { slug, access, confirmation }   -> the steward's PortalResponse; `public` retypes the slug
//   GET    /api/people                                           -> PeoplePageResponse   the owner's
//   PUT    /api/people/person   { email, create }                -> PersonResponse       the create right; 423 to give it locked
//   DELETE /api/people/person   { email }                        -> PersonResponse       off every project, signed out

/** Who asks, as the page needs to know it. */
export type AccessViewer = { kind: "owner" } | { kind: "person"; email: string; role: Role | null };

export type AccessPageResponse = AccessResponse & {
  /** The preview code and the address to send with it, when general access is `code`: the snapshot's. */
  code: { code: string; url: string } | null;
  you: AccessViewer;
  /** The roles the one signed in may give here, from the lowest. */
  grantable: Role[];
  /** End of this session's unlock, null when locked: giving a role above Can open asks for it. */
  until: number | null;
  /** The dashboard's address and the provider's name, for the line to send someone given a role. */
  dashboardUrl: string;
  providerName: string | null;
};

export type PeoplePageResponse = PeopleResponse & {
  /** False when the steward predates the access registry, and why. */
  available: boolean;
  reason: string | null;
  /** The projects a role may be given on: the deployed ones, the platform's own left out. */
  projects: string[];
  until: number | null;
  dashboardUrl: string;
  providerName: string | null;
};
