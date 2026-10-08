/**
 * The contract of the people who sign in to the dashboard: those the access
 * registry (src/access/) gives a role above Can open on a project, or the
 * right to create projects. They sign in with the portal's identity provider.
 * Shapes and constants only, like the other protocol files: the page imports
 * nothing from here but types.
 *
 * ## Who decides what
 *
 * - **The portal** is the one authority on who someone is: it runs the
 *   sign-in and signs an assertion (portal/src/assertion.ts).
 * - **The steward** is the one authority on what they may do: it keeps the
 *   registry, checks the assertion with a public key of its own, opens the
 *   session, and judges every write a person asks for against the registry
 *   it reads at that moment. The actor of its journal is the email it
 *   verified, never one a request names.
 * - **The dashboard** carries the assertion and the session, filters what it
 *   shows (it already holds that data), and decides nothing a person could
 *   use to do more.
 *
 * ## The steward's routes
 *
 * On the dashboard's socket, `secretaire.sock`, for site-dashboard:
 *
 *   GET    /members/key                         -> KeyResponse
 *   POST   /members/signin   { assertion }      -> SignInResponse
 *   POST   /members/whoami   { session }        -> WhoamiResponse
 *   POST   /members/signout  { session }        -> 204
 *   POST   /members/restart  { session, slug }  -> RestartResponse (src/secrets/protocol.ts)
 *   POST   /members/unlock   { session, assertion }                 -> MemberUnlockResponse   a forced sign-in's assertion
 *   POST   /members/lock     { session, token }                     -> 204
 *
 * And a person's work on their projects, judged by role (src/people/powers.ts)
 * in src/people/actions.ts: `/members/secrets/*`, `/members/portal`,
 * `/members/backups/restore`, each carrying the session, and the person's
 * unlock token where the power needs it. Their people with access are the
 * access routes' (src/access/steward.ts), under `/access/person/`.
 *
 * A person's own tokens are the control routes', src/control/steward.ts,
 * under `/team/member/`, which ask these routes for the person's session,
 * unlock and rights (src/people/tokens.ts).
 *
 * Every refusal is `{ error, message }`, the message in English, shown as it
 * stands.
 */
import type { Role as AccessRole } from "../access/protocol";

/** The ladder: Can open (`visitor`), Viewer, Developer, Admin. */
export type Role = AccessRole;

/** The roles the dashboard shows a project for: Can open shows nothing there. */
export type DashboardRole = "viewer" | "developer" | "admin";

/** Who acts for the dashboard's password, in every audit. */
export const OWNER_ACTOR = "owner";

/**
 * A member session: half a day. A person closed at the identity provider is
 * out within that, and within a day of last proving themselves there, the
 * portal's own session lasting twelve hours more at most for a dashboard
 * sign-in (portal/src/handoff.ts, `DASHBOARD_REAUTH_S`).
 */
export const MEMBER_SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

/** An assertion whose sign-in at the provider is older than this opens no session. */
export const MAX_AUTH_AGE_S = 24 * 60 * 60;

/**
 * A member's unlock: the forced sign-in at the provider behind it is five
 * minutes old at most. The portal checks it against the provider's own
 * `auth_time` (portal/src/oidc.ts), the steward against the assertion's.
 */
export const REAUTH_MAX_AGE_S = 5 * 60;

/** Live sessions per member: a phone, a laptop, a few tabs signed in again. The oldest goes past it. */
export const MAX_SESSIONS_PER_MEMBER = 10;

/** Live sessions on the machine, everyone together. */
export const MAX_SESSIONS = 1000;

/** The dashboard's own socket, and the owner's, which only root opens. */
export const OWNER_SOCKET = "/run/sitesolide-steward-owner/owner.sock";

/** The folder where the steward lays the portal's private key, and the file. */
export const PORTAL_KEY_FOLDER = "/etc/sitesolide-portal";
export const PORTAL_KEY_NAME = "assertion.key";

/** The public half, in the steward's own state folder. */
export const PUBLIC_KEY_NAME = "assertion.pub";

/** What a member may see and do on one project: see src/people/powers.ts. */
export type Roles = Record<string, DashboardRole>;

export type PublicKeyView = { kty: "OKP"; crv: "Ed25519"; x: string; kid: string };

export type KeyResponse = { publicKey: PublicKeyView };

/** Who a member session belongs to, as the steward reads its registry now. */
export type MemberIdentity = { kind: "member"; email: string; name: string | null; roles: Roles; create: boolean };

export type SignInResponse = { session: string; expiresAt: number; identity: MemberIdentity };

export type WhoamiResponse = { identity: MemberIdentity; expiresAt: number };

/** A member's unlock token: the dashboard keeps it, attached to their session, and never hands it to the browser. */
export type MemberUnlockResponse = { token: string; expiresAt: number };

/**
 * The steward's refusals for members, beside those of src/secrets/protocol.ts:
 * `signed-out` (401), the session is unknown, expired, or its member was
 * removed; `not-a-member` (403), the verified email is in no registry;
 * `invalid-assertion` (401), the assertion fails its checks; `not-ready`
 * (503), the key pair is not in place yet.
 */
export type MemberErrorCode = "signed-out" | "not-a-member" | "invalid-assertion" | "not-ready";

export type MemberFailure = { error: string; message: string };

// --- The dashboard's routes, for the page ----------------------------------------

/** Who `/api/session` says is signed in. Never a token. */
export type IdentityView = { kind: "owner" } | { kind: "person"; email: string; name: string | null; roles: Roles; create: boolean; expiresAt: number };

/** Whether the sign-in page offers the portal's provider, and under which name. */
export type SsoOffer = { offered: boolean; providerName: string | null };

export type SessionResponse = { open: boolean; configured: boolean; identity: IdentityView | null; sso: SsoOffer };
