/**
 * The calls to the service. `same-origin` everywhere: the session cookie is
 * SameSite=Strict, and nothing here addresses another host.
 */
import type { Guest } from "./guests"
import type { Policy, SharingList } from "./sharing"
import type {
  ContentRequest,
  FileRequest,
  PasswordRequest,
  PortalRequest,
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
  MembersPageResponse,
  MemberView,
  ProjectMembersResponse,
  Role,
  Roles,
  SessionResponse,
  AccessPageResponse,
  EntryResponse,
  EntryView,
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

/** Public or restricted; making a site public retypes its slug. */
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

// --- The pages written before the access registry ----------------------------------
//
// Guests, Sharing, Members and a project's Members read and change access the
// way they always did, through these functions, which speak to the access
// routes above: the next step replaces the pages themselves.

/** The projects whose general access is restricted, with their address, from the snapshot. */
async function restrictedSites(): Promise<{ slug: string; host: string }[] | number> {
  const { status, body } = await readState()
  if (status !== 200 || body === null) return status
  if (!body.present) return []
  return body.snapshot.sites.filter((site) => site.portal.wanted && site.portal.installed).map((site) => ({ slug: site.slug, host: site.address }))
}

/** Every restricted project's access the session may read: the others, 403, are not its. */
async function restrictedAccess(): Promise<{ slug: string; host: string; access: AccessPageResponse }[] | number> {
  const sites = await restrictedSites()
  if (typeof sites === "number") return sites
  const read = await Promise.all(sites.map(async (site) => ({ ...site, answer: await readAccess(site.slug) })))
  const unauthorized = read.find((one) => one.answer.status === 401)
  if (unauthorized !== undefined) return 401
  return read.filter((one) => one.answer.status === 200 && one.answer.body !== null).map((one) => ({ slug: one.slug, host: one.host, access: one.answer.body! }))
}

/** A password access stands for a guest: its id carries the project and who it was given to. */
function guestOf(slug: string, host: string, entry: EntryView): Guest {
  return { id: `${slug}:${entry.who}`, host, label: entry.who, createdAt: entry.createdAt, expiresAt: entry.password?.expiresAt ?? null, seenAt: null }
}

export async function readGuests(): Promise<ProbeResponse<{ guests: Guest[] } & Failure>> {
  const all = await restrictedAccess()
  if (typeof all === "number") return { status: all, body: null }
  const guests = all.flatMap(({ slug, host, access }) => access.entries.filter((entry) => entry.kind === "password").map((entry) => guestOf(slug, host, entry)))
  return { status: 200, body: { guests: guests.sort((a, b) => b.createdAt - a.createdAt) } }
}

/** The label is who it is given to: an email outside the company's domains. */
export async function createGuest(host: string, label: string, durationS: number | null): Promise<ProbeResponse<{ guest: Guest; password: string } & Failure>> {
  const sites = await restrictedSites()
  if (typeof sites === "number") return { status: sites, body: null }
  const site = sites.find((one) => one.host === host)
  if (site === undefined) return { status: 400, body: { error: "no-portal" } as { guest: Guest; password: string } & Failure }
  // Someone at the company's domains signs in with their account: no password, and the Guests page is not where they are added.
  const current = await readAccess(site.slug)
  const email = label.trim().toLowerCase()
  const domain = email.slice(email.lastIndexOf("@") + 1)
  if (current.body !== null && current.body.signIn.configured && email.includes("@") && (current.body.signIn.allowedDomains.length === 0 || current.body.signIn.allowedDomains.includes(domain))) {
    return { status: 400, body: { error: "invalid", message: `${email} signs in with their company account: give them access from Sharing, no password needed` } as { guest: Guest; password: string } & Failure }
  }
  const { status, body } = await putAccess(site.slug, label, "visitor", durationS)
  if (status !== 201 || body === null || body.password === undefined) return { status: status === 201 ? 400 : status, body: body as unknown as { guest: Guest; password: string } & Failure }
  return { status: 201, body: { guest: guestOf(site.slug, host, body.entry), password: body.password } }
}

/** 204 on success, so with no body. */
export async function revokeGuest(id: string): Promise<ProbeResponse<Failure>> {
  const cut = id.indexOf(":")
  if (cut === -1) return { status: 404, body: { error: "unknown-access" } }
  const { status, body } = await removeAccess(id.slice(0, cut), id.slice(cut + 1))
  return { status: status === 200 ? 204 : status, body }
}

/** Who may open a site, as the Sharing page reads a policy: the people and domains who can open it. */
function policyOf(access: AccessPageResponse): { policy: Policy; updatedAt: number } {
  const people = access.entries.filter((entry) => entry.kind === "person").map((entry) => entry.who).sort()
  const domains = access.entries.filter((entry) => entry.kind === "domain").map((entry) => entry.who.slice(1)).sort()
  const mode = domains.length > 0 ? "domain" : people.length > 0 ? "people" : "admins"
  return { policy: { mode, people, domains }, updatedAt: Math.max(0, ...access.entries.map((entry) => entry.updatedAt)) }
}

export async function readSharing(): Promise<ProbeResponse<SharingList & Failure>> {
  const all = await restrictedAccess()
  if (typeof all === "number") return { status: all, body: null }
  const first = all[0]?.access ?? null
  const signIn = first?.signIn ?? { configured: false, allowedDomains: [], admins: [], providerName: null }
  return {
    status: 200,
    body: {
      sso: { configured: signIn.configured, providerName: signIn.providerName, portalUrl: null, admins: signIn.admins, allowedDomains: signIn.allowedDomains },
      sites: all.map(({ host, access }) => ({ host, ...policyOf(access) })),
    },
  }
}

/**
 * A policy, as the Sharing page sends it whole, turned into the changes it
 * means: the people and domains it no longer lets in taken off, those it adds
 * given Can open. Someone with a role above Can open is never taken off here.
 */
export async function replaceSharing(host: string, { mode, people, domains }: Policy): Promise<ProbeResponse<{ host: string; policy: Policy; updatedAt: number } & Failure>> {
  const sites = await restrictedSites()
  if (typeof sites === "number") return { status: sites, body: null }
  const site = sites.find((one) => one.host === host)
  if (site === undefined) return { status: 400, body: { error: "no-portal" } as { host: string; policy: Policy; updatedAt: number } & Failure }
  const current = await readAccess(site.slug)
  if (current.status !== 200 || current.body === null) return { status: current.status, body: current.body as never }
  const wantedPeople = new Set(mode === "admins" ? [] : people)
  const wantedDomains = new Set(mode === "domain" ? domains.map((domain) => `@${domain}`) : [])
  for (const entry of current.body.entries) {
    const gone = (entry.kind === "person" && entry.role === "visitor" && !wantedPeople.has(entry.who)) || (entry.kind === "domain" && !wantedDomains.has(entry.who))
    if (!gone) continue
    const removed = await removeAccess(site.slug, entry.who)
    if (removed.status !== 200) return { status: removed.status, body: removed.body as never }
  }
  const present = new Set(current.body.entries.map((entry) => entry.who))
  for (const who of [...wantedPeople, ...wantedDomains]) {
    if (present.has(who)) continue
    const given = await putAccess(site.slug, who, "visitor")
    if (given.status !== 200 && given.status !== 201) return { status: given.status, body: given.body as never }
  }
  const after = await readAccess(site.slug)
  if (after.status !== 200 || after.body === null) return { status: after.status, body: after.body as never }
  return { status: 200, body: { host, ...policyOf(after.body) } }
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
 * The gatekeeper validates Caddy, reloads it and checks the site, up to
 * `MAX_PORTAL_MS` in the protocol: the page adds no timeout of its own.
 */
export function togglePortal({ slug, active, confirmation }: WithoutToken<PortalRequest>) {
  return sendSecrets<PortalResponse>("POST", "/portal", { slug, active, confirmation })
}

/**
 * The steward watches the unit before returning its verdict: about nine seconds
 * as a rule, up to `MAX_RESTART_MS` in the protocol. The page adds no
 * timeout of its own, which would abandon a restart still under way.
 */
export function restartService({ slug }: WithoutToken<ProjectRequest>) {
  return sendSecrets<RestartResponse>("POST", "/restart", { slug })
}

// --- The team ------------------------------------------------------------------
//
// The routes of `src/control/team.ts`. Creating a token needs the same unlock
// as the secrets, which the service holds: a 423 asks for the password. The
// token's value comes back once, in the creation's answer, and nowhere else.

export function readTeam() {
  return callApi<TeamPageResponse & SecretsRefusal>("/api/team")
}

export function createTeamToken(request: { label: string; email: string; expiresAt: number | null; scope: Scope }) {
  return callApi<CreatedTokenResponse & SecretsRefusal>("/api/team/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: request.label, email: request.email, expiresAt: request.expiresAt, scope: request.scope }),
  })
}

export function revokeTeamToken(id: string) {
  return callApi<{ token: TokenView } & SecretsRefusal>("/api/team/revoke", {
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

// --- The people ---------------------------------------------------------------------
//
// The People page as the Members page read it, from `/api/people`: someone
// with a role above Can open, or the right to create projects.

const DASHBOARD_ROLES: readonly string[] = ["viewer", "developer", "admin"]

function dashboardRoles(roles: Record<string, string>): Roles {
  const kept: Roles = {}
  for (const [slug, role] of Object.entries(roles)) if (DASHBOARD_ROLES.includes(role)) kept[slug] = role as Role
  return kept
}

export async function readMembers(): Promise<ProbeResponse<MembersPageResponse & SecretsRefusal>> {
  const { status, body } = await readPeople()
  if (status !== 200 || body === null) return { status, body: body as never }
  const members: MemberView[] = body.people
    .map((person) => ({ email: person.who, roles: dashboardRoles(person.roles), create: person.create, invitedBy: "owner", createdAt: 0, updatedAt: 0 }))
    .filter((member) => member.create || Object.keys(member.roles).length > 0)
  return {
    status: 200,
    body: {
      available: body.available,
      reason: body.reason,
      members,
      signIn: { configured: body.signIn.configured, allowedDomains: body.signIn.allowedDomains },
      dashboardUrl: body.dashboardUrl,
      providerName: body.providerName,
      projects: body.projects,
      until: body.until,
    },
  }
}

/** The roles named set, those no longer named taken off, then the create right. */
export async function putMember(email: string, roles: Roles, create: boolean): Promise<ProbeResponse<{ member: MemberView; change: "invite" | "role" | "none" } & SecretsRefusal>> {
  const before = await readMembers()
  const current = before.body?.members.find((member) => member.email === email) ?? null
  let changed = false
  for (const [slug, role] of Object.entries(roles)) {
    if (current?.roles[slug] === role) continue
    const given = await putAccess(slug, email, role)
    if (given.status !== 200 && given.status !== 201) return { status: given.status, body: given.body as never }
    changed = true
  }
  for (const slug of Object.keys(current?.roles ?? {})) {
    if (Object.hasOwn(roles, slug)) continue
    const removed = await removeAccess(slug, email)
    if (removed.status !== 200) return { status: removed.status, body: removed.body as never }
    changed = true
  }
  if ((current?.create ?? false) !== create) {
    const set = await setCreate(email, create)
    if (set.status !== 200) return { status: set.status, body: set.body as never }
    changed = true
  }
  const member: MemberView = { email, roles, create, invitedBy: "owner", createdAt: 0, updatedAt: Date.now() }
  return { status: current === null ? 201 : 200, body: { member, change: current === null ? "invite" : changed ? "role" : "none" } }
}

export async function removeMember(email: string): Promise<ProbeResponse<{ member: MemberView } & SecretsRefusal>> {
  const { status, body } = await removePerson(email)
  if (status !== 200 || body === null) return { status, body: body as never }
  return { status, body: { member: { email, roles: dashboardRoles(body.person.roles), create: body.person.create, invitedBy: "owner", createdAt: 0, updatedAt: 0 } } }
}

/** A member's restart: the steward observes the unit before its verdict, as for the Secrets section's. */
export function restartAsMember(slug: string) {
  return callApi<RestartResponse & SecretsRefusal>("/api/members/restart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug }),
  })
}

// --- A project's people, for its Admins -----------------------------------------
//
// A project's Members section, from `/api/access`: who holds a role above
// Can open there. Giving a role needs the person's own unlock; taking one
// away does not. The steward judges each change.

export async function readProjectMembers(slug: string): Promise<ProbeResponse<ProjectMembersResponse & SecretsRefusal>> {
  const { status, body } = await readAccess(slug)
  if (status !== 200 || body === null) return { status, body: body as never }
  return {
    status: 200,
    body: {
      slug,
      members: body.entries
        .filter((entry) => entry.kind === "person" && entry.role !== "visitor")
        .map((entry) => ({ email: entry.who, role: entry.role as Role, invitedBy: entry.by, updatedAt: entry.updatedAt })),
      signIn: { configured: body.signIn.configured, allowedDomains: body.signIn.allowedDomains },
      dashboardUrl: body.dashboardUrl,
      providerName: body.providerName,
      until: body.until,
    },
  }
}

export async function putProjectMember(slug: string, email: string, role: Role): Promise<ProbeResponse<{ member: MemberView; change: "invite" | "role" | "none" } & SecretsRefusal>> {
  const { status, body } = await putAccess(slug, email, role)
  if ((status !== 200 && status !== 201) || body === null) return { status, body: body as never }
  const change = body.change === "add" ? "invite" : body.change === "role" ? "role" : "none"
  return { status, body: { member: { email, roles: { [slug]: role }, create: false, invitedBy: body.entry.by, createdAt: body.entry.createdAt, updatedAt: body.entry.updatedAt }, change } }
}

export async function removeProjectMember(slug: string, email: string): Promise<ProbeResponse<{ member: MemberView; change: "role" | "remove" } & SecretsRefusal>> {
  const { status, body } = await removeAccess(slug, email)
  if (status !== 200 || body === null) return { status, body: body as never }
  return { status, body: { member: { email, roles: {}, create: false, invitedBy: body.entry.by, createdAt: body.entry.createdAt, updatedAt: body.entry.updatedAt }, change: "role" } }
}
