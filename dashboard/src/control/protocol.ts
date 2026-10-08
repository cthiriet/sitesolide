/**
 * The contract of the control API: deploying without root SSH, with a personal
 * token over HTTPS.
 *
 * Four pieces speak it, and each one holds a different part of the trust:
 *
 *   - the CLI or an agent, which holds a token and nothing else;
 *   - the dashboard (site-dashboard, no privilege), which serves `/api/v1/`,
 *     stages the upload in its own data directory and relays to the steward;
 *   - the steward (root daemon), which holds the token registry, judges every
 *     token and every slug, and starts the installer;
 *   - the installer (root one-shot, one project per start), which extracts the
 *     archive as the project's own account, re-validates the manifest and runs
 *     the deployment on the machine.
 *
 * **The registry lives with the steward, not with the dashboard.** The
 * dashboard is assumed compromised everywhere else in this repository
 * (src/secrets/steward.ts says so in its header): a registry it could write
 * would let a compromised dashboard deploy code into any project, at any time,
 * without the owner's password. Held by root, a token is judged where the
 * decision is enforced, and a compromised dashboard can only use the tokens it
 * sees pass, within their scope.
 *
 * This file carries only shapes and constants, no rule: the rules are in
 * tokens.ts and policy.ts, pure, and run by the steward and the installer. The
 * page imports nothing from here but types.
 */
import type { EntryView, GeneralView } from "../access/protocol";

// --- Tokens --------------------------------------------------------------------

/**
 * What a token may do, beyond deploying the projects it created. Everything is
 * off by default: a token created with an empty scope deploys nothing at all.
 *
 * `public` governs the door: without it, every project the token deploys sits
 * behind the portal, and a manifest that asks otherwise is refused.
 */
export type Scope = {
  /** Existing slugs it may deploy, beyond the ones it created. */
  slugs: string[];
  /** May create projects the machine does not carry yet. */
  create: boolean;
  /**
   * May deploy a manifest with `"network": "outbound"`, or with `egress`, the
   * hosts it reaches through the egress proxy. `connectors` needs no flag: the
   * owner grants each one on the machine.
   */
  outbound: boolean;
  /** May deploy a manifest that declares a `domain`. */
  domain: boolean;
  /** May deploy a site that is not behind the portal, or exempts paths from it. */
  public: boolean;
};

/**
 * What the page and the API show of a token. Never its hash, never its value.
 *
 * **Every token belongs to a person**: `member`, a person of People, or null
 * for the owner's own, the owner's agents'. A person's token never does more
 * than that person's roles, read at every use, and dies with them, whoever
 * made it; `by` says who did: the owner, for themselves or for a person, or
 * the person themselves.
 */
export type TokenView = {
  /** Short and random, the token's name in the audit: `token:<id>`. */
  id: string;
  label: string;
  /**
   * The person's email for a person's token. For the owner's own, `owner`;
   * a token from before every token belonged to someone keeps the address
   * it was made for, as a label.
   */
  email: string;
  createdAt: number;
  /** null: no expiry. */
  expiresAt: number | null;
  revokedAt: number | null;
  /** Rounded to the hour: the registry is not rewritten on every request. */
  lastUsedAt: number | null;
  scope: Scope;
  /** The projects it created, recorded at the start of their first deployment. */
  owned: string[];
  /**
   * The person it belongs to, null for the owner's own. Never stronger than
   * that person: the steward narrows it to their roles at every use
   * (src/people/tokens.ts), and revokes it when they leave.
   */
  member: string | null;
  /** Who made it: `owner`, or the person's own email when they minted it themselves. */
  by: string;
};

/** The owner's own token, the owner's agents': whose it is when the owner makes one for themselves. */
export const OWNER_HOLDER = "owner";

/**
 * What a request authenticated by a token knows of its holder. For a
 * person's token, its scope and projects as the steward narrowed them to
 * their roles at that moment, not as they were minted.
 */
export type Identity = {
  id: string;
  label: string;
  email: string;
  expiresAt: number | null;
  scope: Scope;
  owned: string[];
  member: string | null;
};

/** The token's value: `sst_` then 43 characters of base64url, 256 bits. */
export const TOKEN_PREFIX = "sst_";

export const LABEL_MAX = 64;
export const EMAIL_MAX = 254;
/** A registry is a team, not a user base. */
export const MAX_TOKENS = 200;
/** Five years: beyond that, "no expiry" says it better. */
export const MAX_EXPIRY_MS = 5 * 365 * 24 * 60 * 60 * 1000;

// --- Deployments ---------------------------------------------------------------

/**
 * `awaiting-bundle`: created, the archive has not arrived yet.
 * `running`: the installer was started.
 * `succeeded`, `failed`: final.
 * `expired`: the archive never arrived within `UPLOAD_WINDOW_MS`.
 */
export type DeploymentState = "awaiting-bundle" | "running" | "succeeded" | "failed" | "expired";

/** The state the installer itself writes: it only knows these three. */
export type InstallerState = "running" | "succeeded" | "failed";

/** A deployment identifier: 24 lowercase hexadecimal characters, 96 bits. */
export const DEPLOYMENT_ID_SHAPE = /^[0-9a-f]{24}$/;

/** What the installer leaves in `/run/sitesolide-installer/<deployment>.json`. */
export type InstallerResult = {
  deployment: string;
  slug: string;
  state: InstallerState;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  /** One line per step and per remark, in English. Bounded, never a secret. */
  log: string[];
  /** Why it failed: a stable code, and a message that says what to do. */
  error: { code: string; message: string } | null;
  /** The address of the deployed site. */
  url: string | null;
  /** Ports the installer chose for services whose manifest named none. */
  allocated: { service: string | null; port: number }[];
};

/**
 * What the steward writes for the installer, in its own state directory, before
 * starting it. The scope is a copy taken at that instant: the installer applies
 * it to the manifest it extracts, and a token revoked a second later does not
 * change a deployment already decided.
 */
export type InstallRequest = {
  deployment: string;
  slug: string;
  requestedAt: number;
  /**
   * `member`: the person whose token it is, null for the owner's own. The
   * installer narrows the scope again to that person's roles as the registry
   * reads when it starts.
   */
  token: { id: string; email: string; member: string | null };
  scope: Scope;
  creating: boolean;
  /** The manifest's text as the client sent it. The installer re-validates it. */
  manifest: string;
};

/** The installer's unit template, one instance per project. */
export const INSTALLER_PREFIX = "sitesolide-installer";
export const INSTALLER_TEMPLATE = `${INSTALLER_PREFIX}@.service`;

/** Where the installer writes its results, 0700 root. */
export const INSTALLER_RUN_FOLDER = "/run/sitesolide-installer";

/**
 * Where the dashboard stages the archives, under its own data directory, the
 * only place it writes. The installer reads them there, with root's rights but
 * through checks that make the dashboard's own files the only ones it accepts.
 */
export const SPOOL_NAME = "control";
export const BUNDLE_NAME = "bundle.tar.gz";

// --- Limits --------------------------------------------------------------------

/** A manifest is a few hundred bytes; sixty-four kibibytes is generous. */
export const MAX_MANIFEST_BYTES = 64 * 1024;
/** The compressed archive, counted while it streams to disk. */
export const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
/** What the archive may weigh once extracted. */
export const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;
/** Entries in the archive, files and directories together. */
export const MAX_ENTRIES = 20_000;
/** A path inside the archive, in bytes. */
export const MAX_PATH_BYTES = 1024;
/** The archive must arrive within this window after the deployment is created. */
export const UPLOAD_WINDOW_MS = 15 * 60 * 1000;
/**
 * Deployments running at the same time on the machine, every token together.
 * Counted when an archive arrives, never when a deployment is opened: one
 * waiting for its archive runs nothing.
 */
export const MAX_RUNNING = 3;
/**
 * Deployments one token may hold waiting for their archive; a new one replaces
 * its oldest. As many as the machine runs, so that an agent deploying a few
 * projects at once is not cut short, and a token never holds more.
 */
export const MAX_AWAITING_PER_TOKEN = 3;
/** Lines of log the installer keeps, and the length of one. */
export const MAX_LOG_LINES = 2_000;
export const MAX_LOG_LINE = 1_000;
/** A request older than this is a replay, not a deployment: the installer refuses it. */
export const REQUEST_MAX_AGE_MS = 10 * 60 * 1000;
/** The memory one service of a token's project may ask for, and how many services. */
export const MAX_TOKEN_MEMORY_BYTES = 1024 * 1024 * 1024;
export const MAX_TOKEN_SERVICES = 6;
/** Journal lines one request may read. */
export const MAX_JOURNAL_LINES = 500;

// --- Errors --------------------------------------------------------------------

/**
 * Stable codes, for a program to branch on; `message` is for a human or an
 * agent, in English, and says what to do next.
 *
 *   unauthenticated     401  no token, unknown, expired or revoked
 *   too-many-attempts   429  too many failed authentications from this address; `wait` in seconds
 *   out-of-scope        403  the token may not do this
 *   reserved            403  the slug belongs to the platform
 *   invalid             400  the request itself is malformed
 *   invalid-manifest    422  the manifest is refused; `details` lists every reason
 *   not-found           404  no such deployment or project, for this token
 *   busy                409  a deployment of this project is already running, or too many are
 *   too-large           413  the archive or the manifest is over its limit
 *   expired             410  the archive arrived after the upload window
 *   not-available       503  the machine does not carry the control API or the access registry yet
 *   failure             500/502  something broke on the machine; the message says where to look
 *
 * And one the public API never returns: `locked`, the steward's answer to a
 * token creation without a live unlock, which the Tokens page turns into its
 * unlock prompt, as the Secrets page does.
 */
export type ControlErrorCode =
  | "locked"
  | "unauthenticated"
  | "too-many-attempts"
  | "out-of-scope"
  | "reserved"
  | "invalid"
  | "invalid-manifest"
  | "not-found"
  | "busy"
  | "too-large"
  | "expired"
  | "no-portal"
  | "not-available"
  | "failure";

export type ControlFailure = { error: ControlErrorCode; message: string; details?: string[]; wait?: number };

export const CONTROL_STATUSES: Record<ControlErrorCode, number> = {
  locked: 401,
  unauthenticated: 401,
  "too-many-attempts": 429,
  "out-of-scope": 403,
  reserved: 403,
  invalid: 400,
  "invalid-manifest": 422,
  "not-found": 404,
  busy: 409,
  "too-large": 413,
  expired: 410,
  "no-portal": 409,
  "not-available": 503,
  failure: 500,
};

// --- The steward's control routes, on its socket -------------------------------
//
//   GET    /tokens/list                            -> TeamResponse
//   POST   /tokens/create   CreateTokenRequest     -> CreatedTokenResponse   (unlocked)
//   POST   /tokens/revoke   { id }                 -> { token: TokenView }
//   POST   /control/authenticate  { bearer }       -> { identity: Identity }
//   POST   /control/preflight     { bearer, slug } -> { creating: boolean }
//   POST   /control/deploy        DeployRequest    -> { deployment, slug, creating }   202
//   GET    /control/deployment?id=<id>             -> { result: InstallerResult }
//   POST   /control/logs          LogsRequest      -> LogsResponse
//   POST   /control/access/list   { bearer, slug }            -> AccessResponse (src/access/protocol.ts)
//   PUT    /control/access        { bearer, slug, who, role } -> EntryResponse     Can open alone
//   DELETE /control/access        { bearer, slug, who }       -> EntryResponse
//
// A person's own tokens, judged by their session, their unlock to create, and
// their roles (src/people/tokens.ts):
//
//   POST   /tokens/person/list    { session }                                     -> MemberTeamResponse
//   POST   /tokens/person/create  { session, token, label, expiresAt, scope }     -> CreatedTokenResponse   (their unlock)
//   POST   /tokens/person/revoke  { session, id }                                 -> { token: TokenView }   their own alone
//
// And on the owner's socket, which only root opens:
//
//   DELETE /tokens/project        { slug }    a project removed: its token ownership and its people with access forgotten
//
// The paths under `/team/` answer too, for one release: a dashboard or a CLI
// from before the rename still calls them. Any error returns
// `ControlFailure`. An older steward answers 404 `no such route` to all of
// them: the dashboard turns that into `not-available`.

export type TeamResponse = { tokens: TokenView[] };
/**
 * A person's tokens, those the owner made for them included, and what they
 * may mint them for: their roles, and the create right. `until`: the end of
 * their session's unlock, null if locked.
 */
export type MemberTeamResponse = { tokens: TokenView[]; rights: { roles: Record<string, "viewer" | "developer" | "admin">; create: boolean }; until: number | null };
export type CreateMemberTokenRequest = { session: string; token: string; label: string; expiresAt: number | null; scope: Scope };
export type CreateTokenRequest = {
  /** The unlock token of src/secrets: creating a token demands the dashboard unlocked. */
  token: string;
  label: string;
  /**
   * Whose token: `owner`, the owner's own, its scope free; or the email of a
   * person of People, minted as their own would be, within their roles.
   */
  holder: string;
  expiresAt: number | null;
  scope: Scope;
};
export type CreatedTokenResponse = { token: TokenView; secret: string };
export type DeployRequest = { bearer: string; deployment: string; slug: string; manifest: string };
export type DeployResponse = { deployment: string; slug: string; creating: boolean };
export type LogsRequest = { bearer: string; slug: string; lines: number; cursor: string | null };
export type LogsResponse = { lines: string[]; cursor: string | null };

// --- The Tokens page's routes, under /api/tokens, behind the session --------------
//
//   GET    /api/tokens                             -> TeamPageResponse
//   POST   /api/tokens        { label, holder, expiresAt, scope }  -> CreatedTokenResponse   (unlocked)
//   POST   /api/tokens/revoke { id }               -> { token: TokenView }

/** One line of the dashboard's audit, in the shape every component shares. */
export type AuditEntry = {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
};

/** A deployment as the Tokens page lists it. */
export type TeamDeployment = {
  id: string;
  tokenId: string;
  email: string;
  slug: string;
  state: DeploymentState;
  creating: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  message: string | null;
};

export type TeamPageResponse = {
  /** False when the steward does not carry the control routes yet; `reason` says what to run. */
  available: boolean;
  reason: string | null;
  /**
   * Null for the owner, who sees every token. A member sees their own alone,
   * and mints them within these rights: their roles, and the create right.
   */
  member: { email: string; roles: Record<string, "viewer" | "developer" | "admin">; create: boolean } | null;
  tokens: TokenView[];
  /** End of this session's unlock, null if locked. */
  until: number | null;
  deployments: TeamDeployment[];
  audit: AuditEntry[];
};

// --- The dashboard's public API, under /api/v1, with `Authorization: Bearer` ---
//
//   GET    /api/v1/whoami                          -> { identity }
//   POST   /api/v1/deployments   { manifest }      -> 201 { deployment: DeploymentView }
//   PUT    /api/v1/deployments/:id/bundle   tar.gz -> 202 { deployment: DeploymentView }
//   GET    /api/v1/deployments/:id[?after=<n>]     -> { deployment: DeploymentView }
//   GET    /api/v1/projects                        -> { projects: ProjectStatus[] }
//   GET    /api/v1/projects/:slug                  -> { project: ProjectStatus }
//   GET    /api/v1/projects/:slug/logs[?lines=<n>&cursor=<c>] -> LogsResponse
//   GET    /api/v1/projects/:slug/access           -> { access: ProjectAccess }
//   PUT    /api/v1/projects/:slug/access    { who, role }  -> { entry, change, access: ProjectAccess }
//   DELETE /api/v1/projects/:slug/access    { who }        -> { entry, change, access: ProjectAccess }

export type DeploymentView = {
  id: string;
  slug: string;
  state: DeploymentState;
  creating: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Where to send the archive while the state is `awaiting-bundle`. */
  uploadUrl: string | null;
  /** The log lines from index `after` on, and the index of the next one. */
  log: string[];
  next: number;
  error: { code: string; message: string } | null;
  url: string | null;
  allocated: { service: string | null; port: number }[];
};

export type ProjectStatus = {
  slug: string;
  /** Why this token sees it: it created it, or the owner granted it. */
  access: "owned" | "granted";
  /** False for a slug granted but not deployed yet. */
  deployed: boolean;
  type: "static" | "app" | null;
  url: string | null;
  /** Who may open the site at all: public, restricted to its people with access, or anyone with the preview code; null when not deployed. */
  general: "public" | "restricted" | "code" | null;
  portal: { wanted: boolean; installed: boolean } | null;
  services: { name: string | null; unit: string; port: number | null; state: string; subState: string; restarts: number | null; since: number | null; memory: number | null }[];
  deployedAt: number | null;
  /** Age of the machine's snapshot these figures come from, in milliseconds. */
  snapshotAge: number | null;
};

/**
 * A project's general access and people with access, as a token reads them:
 * never the admin emails, which a token has no use for, nor anything of the
 * provider but whether it is set up and the company's domains, the only ones
 * a token may give access to.
 */
export type ProjectAccess = {
  slug: string;
  host: string;
  url: string;
  general: GeneralView | null;
  entries: EntryView[];
  signIn: { configured: boolean; allowedDomains: string[]; providerName: string | null };
};
