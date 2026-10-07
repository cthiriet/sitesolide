/**
 * The contract of the dashboard's members: people the super admin invites by
 * email, who sign in with the portal's identity provider and hold a role per
 * project. Shapes and constants only, like the other protocol files: the page
 * imports nothing from here but types.
 *
 * ## Who decides what
 *
 * - **The portal** is the one authority on who someone is: it runs the
 *   sign-in and signs an assertion (portal/src/assertion.ts).
 * - **The steward** is the one authority on what they may do: it keeps the
 *   registry, checks the assertion with a public key of its own, opens the
 *   member session, and judges every write a member asks for against the
 *   registry it reads at that moment. The actor of its journal is the email
 *   it verified, never one a request names.
 * - **The dashboard** carries the assertion and the session, filters what it
 *   shows (it already holds that data), and decides nothing a member could
 *   use to do more.
 *
 * ## The steward's routes
 *
 * On the dashboard's socket, `secretaire.sock`, for site-dashboard:
 *
 *   GET    /members                             -> MembersResponse
 *   GET    /members/key                         -> KeyResponse
 *   PUT    /members/member   PutMemberRequest   -> PutMemberResponse   the live unlock token
 *   DELETE /members/member   { email }          -> MemberResponse      no unlock, like revoking a token
 *   POST   /members/signin   { assertion }      -> SignInResponse
 *   POST   /members/whoami   { session }        -> WhoamiResponse
 *   POST   /members/signout  { session }        -> 204
 *   POST   /members/restart  { session, slug }  -> RestartResponse (src/secrets/protocol.ts)
 *   POST   /members/unlock   { session, assertion }                 -> MemberUnlockResponse   a forced sign-in's assertion
 *   POST   /members/lock     { session, token }                     -> 204
 *   PUT    /members/project/member { session, token, slug, email, role } -> ProjectMemberResponse   a Project admin, unlocked
 *   DELETE /members/project/member { session, slug, email }               -> ProjectMemberResponse   a Project admin, no unlock
 *
 * And a member's work on their projects, judged by role (src/members/powers.ts)
 * in src/members/actions.ts: `/members/secrets/*`, `/members/portal`,
 * `/members/sharing`, `/members/guests`, `/members/backups/restore`, each
 * carrying the session, and the member's unlock token where the power needs it.
 *
 * On the owner's socket, `/run/sitesolide-steward-owner/owner.sock`, which
 * only root opens, for `sitesolide members` over the owner's SSH:
 *
 *   GET    /members                             -> MembersResponse
 *   PUT    /members/member   { email, roles }   -> PutMemberResponse
 *   DELETE /members/member   { email }          -> MemberResponse
 *
 * Every refusal is `{ error, message }`, the message in English, shown as it
 * stands.
 */
/** The roles a member holds on a project, from the narrowest. */
export const ROLES = ["viewer", "developer", "admin"] as const;

export type Role = (typeof ROLES)[number];

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

/** Members on one machine: a team, not a directory. */
export const MAX_MEMBERS = 200;

/** Projects one member holds a role on. */
export const MAX_ROLES = 100;

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

/** What a member may see and do on one project: see src/members/powers.ts. */
export type Roles = Record<string, Role>;

export type MemberView = {
  email: string;
  roles: Roles;
  /** `owner`, or the email the owner linked: who invited them. */
  invitedBy: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * What the portal's settings say of signing in, read by the steward in
 * portal.env: whether a provider is configured, and the domains it admits.
 * An invited address outside those domains is refused, as the portal would
 * refuse it at sign-in.
 */
export type SignInSettings = { configured: boolean; allowedDomains: string[] };

export type MembersResponse = { members: MemberView[]; signIn: SignInSettings };

export type PutMemberRequest = { token?: string; email: string; roles: Roles };

/** `change`: `invite` for a new member, `role` for a change, `none` when nothing changed. */
export type PutMemberResponse = { member: MemberView; change: "invite" | "role" | "none" };

export type MemberResponse = { member: MemberView };

export type PublicKeyView = { kty: "OKP"; crv: "Ed25519"; x: string; kid: string };

export type KeyResponse = { publicKey: PublicKeyView };

/** Who a member session belongs to, as the steward reads its registry now. */
export type MemberIdentity = { kind: "member"; email: string; name: string | null; roles: Roles };

export type SignInResponse = { session: string; expiresAt: number; identity: MemberIdentity };

export type WhoamiResponse = { identity: MemberIdentity; expiresAt: number };

/** A member's unlock token: the dashboard keeps it, attached to their session, and never hands it to the browser. */
export type MemberUnlockResponse = { token: string; expiresAt: number };

/**
 * A Project admin's change on their project: the member as they may see
 * them, their role on that project alone. `remove`: their last role gone,
 * they are no member any more.
 */
export type ProjectMemberResponse = { member: MemberView; change: "invite" | "role" | "none" | "remove" };

/** A project's members, for its Project admins: their role there, nothing of their other projects. */
export type ProjectMembersResponse = {
  slug: string;
  members: { email: string; role: Role; invitedBy: string; updatedAt: number }[];
  signIn: SignInSettings;
  dashboardUrl: string;
  providerName: string | null;
  /** End of this session's unlock, null if locked. */
  until: number | null;
};

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
export type IdentityView = { kind: "owner" } | { kind: "member"; email: string; name: string | null; roles: Roles; expiresAt: number };

/** Whether the sign-in page offers the portal's provider, and under which name. */
export type SsoOffer = { offered: boolean; providerName: string | null };

export type SessionResponse = { open: boolean; configured: boolean; identity: IdentityView | null; sso: SsoOffer };

/** The Members page: the registry, what the portal admits, and what the invitation to send says. */
export type MembersPageResponse = {
  available: boolean;
  /** Why not, when the steward predates members. */
  reason: string | null;
  members: MemberView[];
  signIn: SignInSettings;
  /** The address to send: the dashboard's own. */
  dashboardUrl: string;
  providerName: string | null;
  /** The projects a role may be given on: the deployed ones, the platform's own left out. */
  projects: string[];
  /** End of this session's unlock, null if locked. */
  until: number | null;
};
