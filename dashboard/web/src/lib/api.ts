/**
 * The calls to the service. `same-origin` everywhere: the session cookie is
 * SameSite=Strict, and nothing here addresses another host.
 */
import type {
  ContentRequest,
  FileRequest,
  PasswordRequest,
  SetRequest,
  ProjectRequest,
  VariableRequest,
  Reading,
  ContentResponse,
  DashboardUnlockResponse,
  FileResponse,
  LogResponse,
  PasswordResponse,
  PortalResponse,
  RestartResponse,
  DashboardResponse,
  ValueResponse,
  WithoutToken,
  Scope,
  TeamPageResponse,
  CreatedTokenResponse,
  TokenView,
  BackupAuditResponse,
  BackupsResponse,
  RestoreResponse,
  SessionResponse,
  AccessPageResponse,
  EntryResponse,
  PeoplePageResponse,
  PersonResponse,
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

export function readSession() {
  return callApi<SessionResponse>("/api/session")
}

export function signIn(password: string) {
  return callApi<{ error?: string; wait?: number }>("/api/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  })
}

export function signOut() {
  return callApi<unknown>("/api/signout", { method: "POST" })
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
  return callApi<EntryResponse & Failure>("/api/access/entry", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug, who, role, ...(expiresInS === undefined ? {} : { expiresInS }) }),
  })
}

export function removeAccess(slug: string, who: string) {
  return callApi<EntryResponse & Failure>("/api/access/entry", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug, who }),
  })
}

/**
 * Public or restricted; making a site public retypes its slug. The
 * gatekeeper validates Caddy, reloads it and checks the site, up to
 * `MAX_PORTAL_MS` in the protocol: the page adds no timeout of its own.
 */
export function setGeneralAccess(slug: string, access: "public" | "restricted", confirmation: string) {
  return callApi<PortalResponse & SecretsRefusal>("/api/access/general", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug, access, confirmation }),
  })
}

export function readPeople() {
  return callApi<PeoplePageResponse & Failure>("/api/people")
}

export function setCreate(email: string, create: boolean) {
  return callApi<PersonResponse & Failure>("/api/people/person", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, create }),
  })
}

export function removePerson(email: string) {
  return callApi<PersonResponse & Failure>("/api/people/person", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  })
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
  return callApi<T & SecretsRefusal>(`/api/secrets${path}`, {
    method: method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  })
}

export function readSecrets() {
  return callApi<DashboardResponse & SecretsRefusal>("/api/secrets")
}

/** The log of the whole machine, or of one site: the slug is a name, never a value, and may go in the address. */
export function readSecretsLog(slug: string | null = null) {
  const query = slug === null ? "" : `?slug=${encodeURIComponent(slug)}`
  return callApi<LogResponse & SecretsRefusal>(`/api/secrets/log${query}`)
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

/** A file's contents read in one go, only if it is readable: the steward refuses otherwise. */
export function readSecretContent({ slug, file }: WithoutToken<FileRequest>) {
  return sendSecrets<ContentResponse>("POST", "/content", { slug, file })
}

/** The whole contents, in the body: the old one is never read back to replace it. */
export function replaceSecretContent({ slug, file, content }: WithoutToken<ContentRequest>) {
  return sendSecrets<FileResponse>("PUT", "/content", { slug, file, content })
}

/**
 * The dashboard password, retyped, and the new one, or null so that the steward
 * draws it. Both in the body; the answer carries the drawn password, which the
 * page shows once.
 */
export function changePassword({ slug, file, variable, dashboardPassword, newPassword }: WithoutToken<PasswordRequest>) {
  return sendSecrets<PasswordResponse>("POST", "/password", { slug, file, variable, dashboardPassword, newPassword })
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

export function createToken(request: { label: string; email: string; expiresAt: number | null; scope: Scope }) {
  return callApi<CreatedTokenResponse & SecretsRefusal>("/api/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: request.label, email: request.email, expiresAt: request.expiresAt, scope: request.scope }),
  })
}

export function revokeToken(id: string) {
  return callApi<{ token: TokenView } & SecretsRefusal>("/api/tokens/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  })
}

// --- The backups ---------------------------------------------------------------
//
// Read with the session; a restore goes through the steward with the session's
// unlocking, like a secret. The restore answers once started, and the page
// follows it by reading the backups again.

export function readBackups(slug: string) {
  return callApi<BackupsResponse & SecretsRefusal>(`/api/backups?slug=${encodeURIComponent(slug)}`)
}

export function readBackupAudit(slug: string) {
  return callApi<BackupAuditResponse & SecretsRefusal>(`/api/backups/audit?slug=${encodeURIComponent(slug)}`)
}

/** The slug retyped, as the steward demands: the requester is the service's to name, not the page's. */
export function restoreBackup({ slug, snapshot, confirmation }: { slug: string; snapshot: string; confirmation: string }) {
  return callApi<RestoreResponse & SecretsRefusal>("/api/backups/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug, snapshot, confirmation }),
  })
}
