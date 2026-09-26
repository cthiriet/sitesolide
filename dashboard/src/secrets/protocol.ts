/**
 * The contract between the three pieces of the sites' management: the steward,
 * which holds /etc/sitesolide under root's identity and commands the
 * gatekeeper, the dashboard's service, which relays it with no privilege at
 * all, and the page, which imports nothing from here but types.
 *
 * This file carries only shapes and constants, no rule at all: the decision
 * belongs to the steward, and a rule written here would end up copied into the
 * page, where it would protect nothing. `import type` only on the web side, so
 * that nothing of the server enters the browser's bundle.
 *
 * A value travels in a body, never in a URL: a URL ends up in a log, a body
 * does not.
 */

/** The steward's Unix socket. The directory is 0750 root:site-dashboard. */
export const DEFAULT_SOCKET = "/run/sitesolide-steward/secretaire.sock";

/** Fixed duration of an unlocking, which use does not extend. */
export const UNLOCK_DURATION_MS = 10 * 60 * 1000;

/**
 * What `systemctl restart` has the right to take before the steward stops
 * waiting for it. A Bun service comes back up in one or two seconds: beyond
 * thirty, something is wrong, and the readings that follow will say so.
 */
export const RESTART_TIMEOUT_MS = 30_000;

/**
 * The longest answer to `/restart`: the restart, the eight seconds of
 * observation, a last `systemctl show` that can take five seconds, and some
 * margin. The relay waits as long, and the dashboard's server keeps the
 * connection open at least as long. Both sides read this number here, failing
 * which the relay would give up a restart that the steward is still carrying
 * through to its end.
 */
export const MAX_RESTART_MS = 50_000;

/**
 * The longest answer to `/portal`: the gatekeeper validates Caddy's whole
 * configuration, reloads it, checks that the site answers as it must, and
 * restores the previous state at the slightest failure. Same reason as above:
 * the relay and the dashboard's server wait as long.
 */
export const MAX_PORTAL_MS = 90_000;

// --- What the steward describes ----------------------------------------------

/**
 * `managed`: the steward knows how to re-read it and rewrite it.
 * `incomplete`: declared by the manifest or the registry, missing from
 * /etc/sitesolide.
 * `unmanaged`: present but unreadable for it (unknown shape, unexpected
 * owner or mode, symbolic link). Listed, never rewritten, `reason` says why.
 */
export type FileState = "managed" | "absent" | "unmanaged";

/**
 * `variables`: an environment file that systemd reads through
 * `EnvironmentFile=`, managed variable by variable.
 * `content`: a file the service opens itself and reads as it stands (a private
 * key, a token pushed elsewhere), managed as one block.
 */
export type FileKind = "variables" | "content";

export type FileView = {
  /**
   * The path under /etc/sitesolide, `cms.env`, `landing-mail.env`, or
   * `<slug>-secrets/<name>` for a file kept in a subdirectory. It is also what
   * the requests name `file`.
   */
  name: string;
  kind: FileKind;
  state: FileState;
  /** In English, for the page. null except for `unmanaged`. */
  reason: string | null;
  /** Owner and mode the steward demands, `site-cms:site-cms 0600`. */
  expected: string;
  /**
   * False for a write-only file: it is replaced, it is never read back, neither
   * by `/value` nor by `/content`. That is the case of a private key whose
   * mode closes it to other accounts. The steward decides it, not the page.
   */
  readable: boolean;
  /** The names of the variables, in the file's order. Empty except for a `managed` `variables` file. */
  variables: string[];
  /**
   * The variables that change only through `/password`, never through
   * `/variable`, never read back nor restored: every `PASSWORD_HASH` the file
   * carries. The page offers "Change password" there in the value's place.
   */
  passwords: string[];
  /**
   * Size in bytes of a `content` file that is `managed` and `readable`, null
   * otherwise: the size of a private key would already say what kind it is.
   */
  bytes: number | null;
  /** Modification date in milliseconds, null if the file is missing. */
  modifiedAt: number | null;
  /**
   * A previous version is kept and can be restored. Always false for a file
   * that carries a password hash: restoring would make the old password valid
   * again, perhaps the one that leaked.
   */
  previous: boolean;
  /** The file changed after the service's last startup. */
  restartPending: boolean;
};

export type ServiceView = {
  unit: string;
  /** systemd's `ActiveState`: active, activating, failed... */
  state: string;
  /** `SubState`: running, auto-restart, dead... */
  subState: string;
  /** `ActiveEnterTimestamp` in milliseconds, null if never started. */
  startedAt: number | null;
};

/**
 * A site's portal, as the machine carries it.
 *
 * `requested`: the manifest dropped on the VM carries `"portal": true`.
 * `installed`: the Caddy block in service carries the portal guard.
 * `modifiable`: the gatekeeper agrees to change it; otherwise `reason` says why
 * (the portal itself, the dashboard, which would not close itself behind a door
 * it could no longer reopen, the landing with no manifest).
 */
export type PortalView = {
  requested: boolean;
  installed: boolean;
  modifiable: boolean;
  reason: string | null;
};

export type ProjectView = {
  /**
   * The directory under /srv/sites, the one the sites page names:
   * the zone's name for the landing, whose files nevertheless carry the
   * `landing` prefix. Every deployed site is listed, static or app, whether it
   * has secrets or not: an empty `files` says it has none.
   */
  slug: string;
  /** null for a static site, or when systemd could say nothing of the unit. */
  service: ServiceView | null;
  files: FileView[];
  portal: PortalView;
};

export type Operation =
  | "unlock"
  | "lock"
  | "read"
  | "set"
  | "remove"
  | "create"
  | "restore"
  | "replace"
  | "password"
  | "portal"
  | "restart";

export type OperationResult = "ok" | "rejects" | "failure";

/** One line of the log. Never a value, nor the hash of a value. */
export type LogEntry = {
  a: number;
  operation: Operation;
  result: OperationResult;
  slug: string | null;
  file: string | null;
  variable: string | null;
  /** The verdict of a restart, the short reason for a refusal. Never a value. */
  detail: string | null;
};

/**
 * `active`: the unit is active and its restart counter has not moved over the
 * end of the observation window.
 * `looping`: it comes back in auto-restart, or its counter climbs.
 * `failure`: it fell, or never reached `active`.
 * `scheduled`: the restart of the dashboard itself. The relay that would carry
 * the verdict is precisely what restarts: the steward answers first, launches
 * the restart just after, and the verdict reaches the log.
 */
export type VerdictKind = "active" | "looping" | "failure" | "scheduled";

export type Verdict = {
  kind: VerdictKind;
  state: string;
  subState: string;
  /** Restarts counted by systemd during the observation. */
  restarts: number;
};

// --- The errors --------------------------------------------------------------

/**
 * `locked`: token missing, wrong or expired (401 at the steward, 423 at the
 * dashboard). `refused`: wrong password (401). `too-many-attempts` (429, with
 * `wait` in seconds). `invalid` (400). `out-of-scope` (403).
 * `not-found` (404). `unmanaged` and `already-present` (409). `failure` (500,
 * or 503 when the steward is busy: too many requests in flight or too many
 * writes waiting, the request can be made again a moment later).
 *
 * `message` is in English and is displayed as it stands under the field
 * concerned: the page does not copy the rules, it shows the steward's refusal.
 */
export type ErrorCode =
  | "locked"
  | "refused"
  | "too-many-attempts"
  | "invalid"
  | "out-of-scope"
  | "not-found"
  | "unmanaged"
  | "already-present"
  | "failure";

export type Failure = { error: ErrorCode; message: string; wait?: number };

// --- The steward's routes, on its socket -------------------------------------
//
//   GET    /projects              -> ProjectsResponse
//   GET    /log[?slug=<s>]   -> LogResponse, the last 50, of the site if named
//   POST   /unlock  UnlockRequest -> UnlockResponse
//   POST   /lock    WithToken             -> 204
//   POST   /value         VariableRequest       -> ValueResponse
//   PUT    /variable       SetRequest           -> FileResponse
//   DELETE /variable       VariableRequest       -> FileResponse
//   POST   /file        FileRequest        -> FileResponse
//   POST   /restore      FileRequest        -> FileResponse
//   POST   /content        FileRequest        -> ContentResponse      (readable only)
//   PUT    /content        ContentRequest        -> FileResponse
//   POST   /password     PasswordRequest     -> PasswordResponse
//   POST   /portal        PortalRequest        -> PortalResponse
//   POST   /restart     ProjectRequest         -> RestartResponse
//
// Any error returns `Failure`.

export type WithToken = { token: string };
export type UnlockRequest = { password: string };
export type ProjectRequest = WithToken & { slug: string };
export type FileRequest = ProjectRequest & { file: string };
export type VariableRequest = FileRequest & { variable: string };
export type SetRequest = VariableRequest & { value: string };
export type ContentRequest = FileRequest & { content: string };

/**
 * Changing a password demands retyping the dashboard's own, checked by the
 * steward at that very moment: a stolen unlocking token is not enough.
 * `newPassword` null: the steward draws it itself and returns it only once.
 */
export type PasswordRequest = VariableRequest & { dashboardPassword: string; newPassword: string | null };

/**
 * `confirmation`: the slug, retyped. Required to take the portal away, which
 * makes the site public; ignored to put it up.
 */
export type PortalRequest = ProjectRequest & { active: boolean; confirmation: string };

export type ProjectsResponse = { projects: ProjectView[] };
export type LogResponse = { entries: LogEntry[] };
export type UnlockResponse = { token: string; expiresAt: number };
export type ValueResponse = { value: string };
export type FileResponse = { file: FileView };
export type ContentResponse = { content: string };
/** `password`: the one the steward drew, null if the request carried one. */
export type PasswordResponse = { file: FileView; password: string | null };
/** `detail`: what the gatekeeper did and checked, in English, for the page. */
export type PortalResponse = { portal: PortalView; detail: string };
export type RestartResponse = { verdict: Verdict };

// --- The dashboard's routes, under /api/secrets ------------------------------
//
// The same ones, without the token: the dashboard keeps it in memory, attached
// to the session, and never sends it to the browser.
//
//   GET    /api/secrets                -> DashboardResponse
//   GET    /api/secrets/log[?slug=<s>] -> LogResponse
//   POST   /api/secrets/unlock  { password } -> { until }
//   POST   /api/secrets/lock    -> 204
//   POST   /api/secrets/value         { slug, file, variable } -> ValueResponse
//   PUT    /api/secrets/variable       { slug, file, variable, value } -> FileResponse
//   DELETE /api/secrets/variable       { slug, file, variable } -> FileResponse
//   POST   /api/secrets/file        { slug, file } -> FileResponse
//   POST   /api/secrets/restore      { slug, file } -> FileResponse
//   POST   /api/secrets/content        { slug, file } -> ContentResponse
//   PUT    /api/secrets/content        { slug, file, content } -> FileResponse
//   POST   /api/secrets/password     { slug, file, variable, dashboardPassword, newPassword } -> PasswordResponse
//   POST   /api/secrets/portal        { slug, active, confirmation } -> PortalResponse
//   POST   /api/secrets/restart     { slug } -> RestartResponse
//
// A session is required everywhere (401), Origin checked on everything that is
// not a GET (403). Locked: 423 and `Failure`. Steward unreachable: 502 and
// `Failure` with code `failure`.

export type WithoutToken<T> = Omit<T, "token">;

export type DashboardResponse = {
  projects: ProjectView[];
  /** End of this session's unlocking, null if locked. */
  until: number | null;
};

export type DashboardUnlockResponse = { until: number };
