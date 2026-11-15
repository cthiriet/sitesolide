/**
 * The contract of access: who may open a project's site. Shapes and constants
 * only, like the other protocol files: the page imports nothing from here but
 * types.
 *
 * ## The model
 *
 * Per project, one setting and one list:
 *
 * - **General access**, who may open the site at all: `public`, anyone;
 *   `restricted`, the owner and the guests below, the portal in front;
 *   `code`, anyone with the preview code. It is what the manifest's `portal`
 *   flag and the preview lock already say: the machine carries it, not this
 *   registry.
 * - **Guests**, each a password access: an email, the password the steward
 *   draws for them and shows once, and an expiry chosen when it is given.
 *   A guest opens the site and nothing more: no dashboard, no token.
 *
 * Only the owner gives or takes away a guest's access: over SSH, root on the
 * owner's socket, or in the dashboard with the live unlock to give one.
 * Removing someone holds from their next request. A token never gives anyone
 * access.
 *
 * ## Who keeps it
 *
 * The steward, root, in `/var/lib/sitesolide-steward/access.json`, 0600,
 * written atomically, the one registry. After every change it writes the
 * projection the portal reads (borrowed/access.ts).
 *
 * ## The steward's routes
 *
 * On the owner's socket, which only root opens, for `sitesolide share` over
 * the owner's SSH, no unlock:
 *
 *   GET    /access?slug=<slug>                     -> AccessResponse
 *   PUT    /access/entry   { slug, who, expiresInS? } -> EntryResponse, the password once when one is drawn
 *   DELETE /access/entry   { slug, who }            -> EntryResponse
 *   POST   /general        { slug, access, renew? } -> GeneralResponse, for `sitesolide lock` and `unlock`
 *
 * On the dashboard's socket, the same for the owner's session, `token` the
 * live unlock, which giving access needs.
 *
 * General access, through the gatekeeper (src/secrets/steward.ts): the
 * owner's `POST /general { token?, slug, access, renew?, confirmation }`,
 * `access` one of `public`, `restricted` or `code`, `renew` a new code. All
 * but `restricted` take the unlock, and `public` and `code` the slug retyped.
 *
 * Every refusal is `{ error, message }`, the message in English, shown as it
 * stands.
 */

/** The registry's file, in the steward's state folder. */
export const REGISTRY_NAME = "access.json";

/** What the registry's file is read with: a few hundred entries per project are never near it. */
export const REGISTRY_MAX_BYTES = 8 * 1024 * 1024;

/** Guests on one project: a few hundred at most. */
export const MAX_ENTRIES = 600;

/**
 * How long a password access lasts, chosen when it is given: the same four
 * durations the portal offered before the registry, so that nothing is
 * offered that was not.
 */
export const PASSWORD_DURATIONS_S = [24 * 3600, 7 * 24 * 3600, 30 * 24 * 3600, null] as const;

/** When none is chosen. */
export const DEFAULT_PASSWORD_DURATION_S = 7 * 24 * 3600;

/** Who acts for the dashboard's password, in every audit. */
export const OWNER = "owner";

/** The owner's socket, which only root opens. */
export const OWNER_SOCKET = "/run/sitesolide-steward-owner/owner.sock";

/** The folder where the steward lays what the portal reads: the access projection, the passkeys' projection. */
export const PORTAL_FOLDER = "/etc/sitesolide-portal";

export type GeneralAccess = "public" | "restricted" | "code";

/** The three, in the order they are shown. */
export const GENERAL_ACCESSES: readonly GeneralAccess[] = ["public", "restricted", "code"];

/** What the machine carries for a project's general access, as the steward reads it. */
export type GeneralView = {
  access: GeneralAccess;
  /** May it change from here to at least one of the other two, and why not. */
  modifiable: boolean;
  reason: string | null;
  /**
   * Each of the three, null when the site may take it from here, otherwise
   * why not: a static site cannot be restricted, a site on its own domain
   * takes no code, a gatekeeper in flight stops all three. Absent from a
   * steward that predates the code being chosen here.
   */
  choices?: Record<GeneralAccess, string | null>;
};

/**
 * The steward's answer to a change of general access, `POST /general`: the
 * portal read back, the general access, the gatekeeper's verdict, and the
 * code in force when the site opens with one. Never written to a journal.
 */
export type GeneralResponse = {
  portal: { requested: boolean; installed: boolean; modifiable: boolean; reason: string | null };
  general: GeneralView;
  detail: string;
  code: { code: string; url: string | null } | null;
};

/** A guest, as it is shown: never their password, its hash or its identifier. */
export type EntryView = {
  /** An email, or a name a password access was given under before the registry. */
  who: string;
  /** `owner`, or who gave it before the owner alone did: an email, `token:<id>`, `migration`. */
  by: string;
  createdAt: number;
  updatedAt: number;
  /** Until when, null for no expiry, and whether that time has passed. */
  expiresAt: number | null;
  expired: boolean;
};

export type AccessResponse = {
  slug: string;
  host: string;
  url: string;
  /** Null when the project is not deployed: its guests are kept, its site serves nothing. */
  general: GeneralView | null;
  entries: EntryView[];
  /**
   * What the portal on the machine reads who may open a site from: `steward`,
   * this registry's projection; `unreadable`, the projection does not read
   * and the portal opens nothing from it; `unknown`, it could not be asked.
   */
  portal: { reading: "steward" | "unreadable" | "unknown"; writtenAt: number | null };
};

export type EntryChange = "add" | "none" | "remove";

export type EntryResponse = {
  slug: string;
  entry: EntryView;
  change: EntryChange;
  /** Drawn for a new guest, shown this once: the registry keeps its hash alone. */
  password?: string;
};

// --- The dashboard's routes, for the page ------------------------------------------
//
//   GET    /api/access?slug=<slug>                               -> AccessPageResponse
//   PUT    /api/access/entry    { slug, who, expiresInS? }       -> EntryResponse        423 when locked
//   DELETE /api/access/entry    { slug, who }                    -> EntryResponse        never an unlock
//   PUT    /api/access/general  { slug, access, renew?, confirmation } -> GeneralResponse; `public` and `code` retype the slug, all but `restricted` need the unlock

export type AccessPageResponse = AccessResponse & {
  /** The preview code and the address to send with it, when general access is `code`: the snapshot's. */
  code: { code: string; url: string } | null;
  /** End of this session's unlock, null when locked: giving access asks for it. */
  until: number | null;
};
