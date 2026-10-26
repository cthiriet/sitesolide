/**
 * The calls to the service. `same-origin` everywhere: the session cookie is
 * SameSite=Strict, and nothing here addresses another host.
 */
import type {
  FileRequest,
  PasswordRequest,
  SetRequest,
  ProjectRequest,
  VariableRequest,
  Reading,
  DashboardUnlockResponse,
  FileResponse,
  LogResponse,
  PasswordResponse,
  RestartResponse,
  DashboardResponse,
  ValueResponse,
  WithoutToken,
  Scope,
  TeamPageResponse,
  CreatedTokenResponse,
  TokenView,
  BackupsResponse,
  RestoreResponse,
  SessionResponse,
  AccessPageResponse,
  EntryResponse,
  GeneralAccess,
  GeneralResponse,
  PeoplePageResponse,
  PersonResponse,
  GenerateFormat,
  StoreChangeResponse,
  StoreRestoreResponse,
  StoreRevealResponse,
} from "./types"

/** `status` is 0 when no answer arrived: network down, service stopped. */
export type ProbeResponse<T> = { status: number; body: T | null }

export async function callApi<T>(path: string, options?: RequestInit): Promise<ProbeResponse<T>> {
  let response: Response
  try {
    response = await fetch(path, { credentials: "same-origin", ...options })
  } catch {
    // fetch rejects instead of returning a status when nothing answers. The
    // rejection becomes a status 0, which every caller handles like the others:
    // an exception let through would freeze a button "in progress" forever.
    return { status: 0, body: null }
  }
  try {
    return { status: response.status, body: (await response.json()) as T }
  } catch {
    return { status: response.status, body: null }
  }
}

/** A write: its method, and its body sent as JSON when it has one. */
export function send<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) {
  return callApi<T>(path, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  })
}

export function readSession() {
  return callApi<SessionResponse>("/api/session")
}

export function signIn(password: string) {
  return send<{ error?: string; wait?: number }>("POST", "/api/signin", { password })
}

export function signOut() {
  return send<unknown>("POST", "/api/signout")
}

export function readState() {
  return callApi<Reading>("/api/state")
}

type Failure = { error?: string; message?: string }

// --- Access -------------------------------------------------------------------
//
// The routes of `src/access/routes.ts`: a project's general access and people
// with access, and the machine's People. The steward judges every change.

export function readAccess(slug: string) {
  return callApi<AccessPageResponse & Failure>(`/api/access?slug=${encodeURIComponent(slug)}`)
}

/** Someone given access, or their role changed; for password access, the password comes back once. */
export function putAccess(slug: string, who: string, role: string, expiresInS?: number | null) {
  return send<EntryResponse & Failure>("PUT", "/api/access/entry", { slug, who, role, ...(expiresInS === undefined ? {} : { expiresInS }) })
}

export function removeAccess(slug: string, who: string) {
  return send<EntryResponse & Failure>("DELETE", "/api/access/entry", { slug, who })
}

/**
 * A site's general access, one of the three, or a new code when `renew`;
 * making a site public or opening it with a code retypes its slug. The
 * gatekeeper validates Caddy, reloads it and checks the site, up to
 * `MAX_PORTAL_MS` in the protocol: the page adds no timeout of its own.
 */
export function setGeneralAccess(slug: string, access: GeneralAccess, confirmation: string, renew = false) {
  return send<GeneralResponse & SecretsRefusal>("PUT", "/api/access/general", { slug, access, ...(renew ? { renew } : {}), confirmation })
}

export function readPeople() {
  return callApi<PeoplePageResponse & Failure>("/api/people")
}

export function setCreate(email: string, create: boolean) {
  return send<PersonResponse & Failure>("PUT", "/api/people/person", { email, create })
}

export function removePerson(email: string) {
  return send<PersonResponse & Failure>("DELETE", "/api/people/person", { email })
}

// --- The secrets ---------------------------------------------------------------
//
// The routes of `src/secrets/protocol.ts`, one per function. A value always
// travels in a body, never in the URL, which would end up in a log. The
// steward's token never comes through here: the service keeps it, attached to
// the session.

/**
 * What a secrets route returns when it refuses: the protocol's `Failure`, or the
 * service's own `{ error }` (no session, origin refused). Everything is
 * optional, the page only trusts what it has checked.
 */
export type SecretsRefusal = { error?: string; message?: string; wait?: number }

function sendSecrets<T>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) {
  return send<T & SecretsRefusal>(method, `/api/secrets${path}`, body)
}

export function readSecrets() {
  return callApi<DashboardResponse & SecretsRefusal>("/api/secrets")
}

/** The steward's last operations on a project's secrets: names and dates, never a value. The Server page dates its settings by them. */
export function readSecretsLog(slug: string) {
  return callApi<LogResponse & SecretsRefusal>(`/api/secrets/log?slug=${encodeURIComponent(slug)}`)
}

export function unlockSecrets(password: string) {
  return sendSecrets<DashboardUnlockResponse>("POST", "/unlock", { password })
}

/** 204 on success, so with no body. */
export function lockSecrets() {
  return sendSecrets<unknown>("POST", "/lock")
}

// The bodies are rebuilt key by key: the steward refuses any unknown field,
// and an object from the page sometimes carries more than the contract.

export function readSecretValue({ slug, file, variable }: WithoutToken<VariableRequest>) {
  return sendSecrets<ValueResponse>("POST", "/value", { slug, file, variable })
}

export function setVariable({ slug, file, variable, value }: WithoutToken<SetRequest>) {
  return sendSecrets<FileResponse>("PUT", "/variable", { slug, file, variable, value })
}

export function removeVariable({ slug, file, variable }: WithoutToken<VariableRequest>) {
  return sendSecrets<FileResponse>("DELETE", "/variable", { slug, file, variable })
}

export function createSecretFile({ slug, file }: WithoutToken<FileRequest>) {
  return sendSecrets<FileResponse>("POST", "/file", { slug, file })
}

export function restoreSecretFile({ slug, file }: WithoutToken<FileRequest>) {
  return sendSecrets<FileResponse>("POST", "/restore", { slug, file })
}

/**
 * The dashboard password, retyped, and the new one, or null so that the steward
 * draws it. Both in the body; the answer carries the drawn password, which the
 * page shows once.
 */
export function changePassword({ slug, file, variable, dashboardPassword, newPassword }: WithoutToken<PasswordRequest>) {
  return sendSecrets<PasswordResponse>("POST", "/password", { slug, file, variable, dashboardPassword, newPassword })
}

// --- A project's store ------------------------------------------------------------
//
// The routes `/api/secrets/store/*`, relayed to the steward with the owner's
// token or a person's unlock. A value and a file's content travel in the body
// alone. None of these answers carries a value, but the reveal's, which only
// the owner's unlocked dashboard receives: a person has no such route.

/** Sets one variable in the store, created on the way if the project had none. */
export function setStoreVariable({ slug, name, value }: { slug: string; name: string; value: string }) {
  return sendSecrets<StoreChangeResponse>("PUT", "/store/variable", { slug, name, value })
}

export function removeStoreVariables({ slug, names }: { slug: string; names: string[] }) {
  return sendSecrets<StoreChangeResponse>("DELETE", "/store/variable", { slug, names: [...names] })
}

/** Draws a value on the server. The answer names it in `generated`, never with its value. */
export function generateStoreVariable({
  slug,
  name,
  format,
  bytes,
  replace,
}: {
  slug: string
  name: string
  format?: GenerateFormat
  bytes?: number
  replace?: boolean
}) {
  return sendSecrets<StoreChangeResponse>("POST", "/store/generate", {
    slug,
    name,
    ...(format === undefined ? {} : { format }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(replace === true ? { replace: true } : {}),
  })
}

/** `content`: the file's bytes in base64, read in the browser. */
export function setStoreFile({ slug, name, content }: { slug: string; name: string; content: string }) {
  return sendSecrets<StoreChangeResponse>("PUT", "/store/file", { slug, name, content })
}

export function removeStoreFile({ slug, name }: { slug: string; name: string }) {
  return sendSecrets<StoreChangeResponse>("DELETE", "/store/file", { slug, name })
}

/** With `dryRun`, what would appear and disappear, for the confirmation; without, the swap. */
export function restoreStore({ slug, dryRun }: { slug: string; dryRun: boolean }) {
  return sendSecrets<StoreRestoreResponse>("POST", "/store/restore", { slug, ...(dryRun ? { dryRun: true } : {}) })
}

/** The owner's alone: a person's dashboard has no such route, and the steward refuses anyone else. */
export function revealStoreValue({ slug, name }: { slug: string; name: string }) {
  return sendSecrets<StoreRevealResponse>("POST", "/store/value", { slug, name })
}

/**
 * The steward watches the unit before returning its verdict: about nine seconds
 * as a rule, up to `MAX_RESTART_MS` in the protocol. The page adds no
 * timeout of its own, which would abandon a restart still under way.
 */
export function restartService({ slug }: WithoutToken<ProjectRequest>) {
  return sendSecrets<RestartResponse>("POST", "/restart", { slug })
}

// --- The tokens ----------------------------------------------------------------
//
// The routes of `src/control/team.ts`. Creating a token needs the same unlock
// as the secrets, which the service holds: a 423 asks for the password. The
// token's value comes back once, in the creation's answer, and nowhere else.

export function readTokens() {
  return callApi<TeamPageResponse & SecretsRefusal>("/api/tokens")
}

/** `holder`: whose token the owner makes, `owner` or a person's email; a person's own carries none, it is theirs. */
export function createToken(request: { label: string; holder?: string; expiresAt: number | null; scope: Scope }) {
  return send<CreatedTokenResponse & SecretsRefusal>("POST", "/api/tokens", {
    label: request.label,
    ...(request.holder === undefined ? {} : { holder: request.holder }),
    expiresAt: request.expiresAt,
    scope: request.scope,
  })
}

export function revokeToken(id: string) {
  return send<{ token: TokenView } & SecretsRefusal>("POST", "/api/tokens/revoke", { id })
}

// --- The backups ---------------------------------------------------------------
//
// Read with the session; a restore goes through the steward with the session's
// unlocking, like a secret. The restore answers once started, and the page
// follows it by reading the backups again.

export function readBackups(slug: string) {
  return callApi<BackupsResponse & SecretsRefusal>(`/api/backups?slug=${encodeURIComponent(slug)}`)
}

/** The slug retyped, as the steward demands: the requester is the service's to name, not the page's. */
export function restoreBackup({ slug, snapshot, confirmation }: { slug: string; snapshot: string; confirmation: string }) {
  return send<RestoreResponse & SecretsRefusal>("POST", "/api/backups/restore", { slug, snapshot, confirmation })
}
