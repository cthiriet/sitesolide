/**
 * What a site's secrets decide inside the page, and only that: the time left on
 * an unlock, what a verdict, a service, a file or a log line say, what is
 * offered for a file according to what the steward says of it, the meaning of a
 * refused answer, the displayed progress of a restart, and the drawing of a
 * token. Pure.
 *
 * No validation rule here, no variable name, no scope, no value: the steward
 * judges them on send, and the page shows its refusal as is. A rule copied into
 * the browser would protect nothing and would end up diverging from the one
 * that counts.
 */
import { duration } from "./format"
import { serviceWord } from "./sites"
import { missingLabel, storeMissing, storePending, withStore } from "./store"
import type { Tone } from "./tones"
import type {
  ErrorCode,
  LogEntry,
  FileView,
  Operation,
  ProjectView,
  ServiceView,
  VerdictKind,
  RestartVerdict,
} from "./types"

/** A revealed value masks itself again after this delay. */
export const REVEAL_MS = 30_000

/** The log shows the last twenty operations. */
export const LOG_MAX = 20

/** A generated token: 32 bytes, that is 256 bits, 43 characters in base64url. */
export const TOKEN_BYTES = 32

/** Like "Can't reach the dashboard." and "Can't reach the portal.": what did not answer, in a person's words. */
export const UNREACHABLE = "Can't reach the server's secrets."

export const BUSY = "The server is busy. Try again in a moment."

export const PENDING_LABEL = "Restart pending"

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`
}

// --- The unlock ----------------------------------------------------------------

/**
 * How far the server's clock runs ahead of the browser's, in milliseconds.
 *
 * `until` is a server date, and a workstation a few minutes fast would
 * otherwise display "Locked" for a whole unlock. The snapshot gives the
 * measurement with no extra request: the service computed its `age` on its own
 * clock, the steward's, and the page knows when it received it.
 */
export function clockOffset(generated: number, age: number, receivedAt: number): number {
  return generated + age - receivedAt
}

export type UnlockStatus =
  | { open: false; expired: boolean; label: string }
  | { open: true; remainingMs: number; remainingText: string; label: string }

/** "9 min left", and "< 1 min left" rather than a zero that would read as locked. */
export function remainingLabel(remainingMs: number): string {
  if (remainingMs < 60_000) return "< 1 min left"
  return `${Math.floor(remainingMs / 60_000)} min left`
}

/**
 * The header's state. Expires at the very millisecond the steward stops
 * accepting the token: an unlock that ends now is over. `expired` tells the end
 * of an unlock apart from a lock that was never opened.
 */
export function unlockStatus(until: number | null, now: number, offset = 0): UnlockStatus {
  if (until === null) return { open: false, expired: false, label: "Locked" }
  const remainingMs = until - (now + offset)
  if (remainingMs <= 0) return { open: false, expired: true, label: "Locked" }
  const remainingText = remainingLabel(remainingMs)
  return { open: true, remainingMs, remainingText, label: `Changes unlocked, ${remainingText}` }
}

/** What a revealed value says about its remasking: "Hides in 24s", never "in 0s". */
export function hideCountdown(remainingMs: number): string {
  return `Hides in ${Math.max(1, Math.ceil(remainingMs / 1000))}s`
}

// --- The refused answers -------------------------------------------------------

/**
 * The meaning of an answer that is not a success:
 *
 * - `session`: the dashboard session has gone, the sign-in comes over the top;
 * - `locked`: the token is missing or has expired, the page locks and asks
 *   for the password, without replaying the action;
 * - `unreachable`: nothing answered, or the service did not reach the steward;
 * - `busy`: the steward has too much to do, the request can be made again;
 * - `refusal`: the steward has judged, its `message` is shown as is.
 *
 * A 401 carries two meanings: a missing session, or a refused unlock password.
 * Only the code `refused` tells the second apart.
 */
export type Refusal =
  | { kind: "session" }
  | { kind: "locked" }
  | { kind: "unreachable"; message: string }
  | { kind: "busy"; message: string }
  | { kind: "rejects"; message: string; waitS: number }

/** A success: 200 for a read, 204 for a lock, 201 if the service prefers it. */
export function succeeded(status: number): boolean {
  return status >= 200 && status < 300
}

function field(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined
}

export function refusalOf(status: number, body: unknown): Refusal {
  if (status === 0 || status === 502) return { kind: "unreachable", message: UNREACHABLE }
  // The steward's reason is lowercase and repeats what the status already
  // says: the page writes its own, which says what to do.
  if (status === 503) return { kind: "busy", message: BUSY }
  const error = field(body, "error")
  if (status === 423 || error === "locked") return { kind: "locked" }
  if (status === 401 && error !== "refused") return { kind: "session" }

  const wait = field(body, "wait")
  const waitS =
    status === 429 || error === "too-many-attempts"
      ? Math.max(1, Math.ceil(typeof wait === "number" && Number.isFinite(wait) ? wait : 1))
      : 0

  const message = field(body, "message")
  if (typeof message === "string" && message.trim() !== "") return { kind: "rejects", message, waitS }
  if (error === "origin-refused") return { kind: "rejects", message: "Origin not allowed.", waitS }
  if (error === "refused") return { kind: "rejects", message: "Wrong password.", waitS }
  if (waitS > 0) return { kind: "rejects", message: "Too many attempts.", waitS }
  const code = typeof error === "string" && error !== "" ? `: ${error}` : ""
  return { kind: "rejects", message: `Refused (${status}${code}).`, waitS }
}

// --- The projects, the services, the files -------------------------------------

/**
 * By slug, in alphabetical order, like the sites table, each with its store
 * made sure of (`withStore`). A copy: the original does not move.
 */
export function sortProjects(projects: readonly ProjectView[]): ProjectView[] {
  return projects.map(withStore).sort((a, b) => a.slug.localeCompare(b.slug, "en"))
}

/** "failed", or "activating (auto-restart)" when the substate says something else. */
export function systemdState(state: string, subState: string): string {
  return subState === "" || subState === state ? state : `${state} (${subState})`
}

/**
 * `text` is the page's word (Running, Restarting, Down), `systemd` what
 * systemd reports, to be shown beside it when it says more than the word,
 * `detail` how long an active service has been running.
 */
export type ServiceReading = { tone: Tone; text: string; systemd: string | null; detail: string | null }

/**
 * A project's service, with the words and tones of the sites list, through
 * `serviceWord`: a service cannot be "Starting" in amber here and in red on its
 * row. `serverNow` is the server's time, `startedAt` being one of its
 * dates.
 */
export function readService(service: ServiceView | null, serverNow: number): ServiceReading {
  if (service === null) return { tone: "neutral", text: "Unknown", systemd: null, detail: "systemd said nothing about this unit." }
  const { tone, label } = serviceWord(service.state, service.subState)
  // The systemd detail only shows if it says more than the word: "active (running)" says nothing more than Running.
  const raw = service.state === "active" && service.subState === "running" ? null : systemdState(service.state, service.subState)
  if (service.state === "active") {
    const since = service.startedAt === null ? null : `up ${duration(serverNow - service.startedAt)}`
    return { tone, text: label, systemd: raw, detail: since }
  }
  return { tone, text: label, systemd: raw, detail: null }
}

/** "2 variables", "No variables yet"; nothing for a file the steward does not read, whose contents nobody knows. */
export function fileSummary(file: FileView): string | null {
  if (file.state !== "managed") return null
  return file.variables.length === 0 ? "No variables yet" : plural(file.variables.length, "variable")
}

/**
 * What the page offers for a file, from what the steward says of it and nothing
 * else: its state and the previous version. Offering an action is not
 * authorising it: the steward judges on send.
 */
export type FileOffer = {
  /** Expected and missing: create it empty. */
  create: boolean
  /** A previous version is kept, on a file the steward rewrites. */
  restore: boolean
  /** A managed file: add a variable. */
  add: boolean
}

export function fileOffer(file: FileView): FileOffer {
  return {
    create: file.state === "absent",
    restore: file.previous && file.state !== "unmanaged",
    add: file.state === "managed",
  }
}

/**
 * What a variable offers. `password`: no value, no reveal, no change, only
 * *Change password*. `read-write`: everything.
 */
export type VariableOffer = "password" | "read-write"

export function variableOffer(file: Pick<FileView, "passwords">, variable: string): VariableOffer {
  return file.passwords.includes(variable) ? "password" : "read-write"
}

/**
 * The files whose previous version can come back, the most recently modified
 * first: after a failed restart, that is the suspect. An unmanaged file is
 * never rewritten, so it is not offered.
 */
export function restorableFiles(project: ProjectView): FileView[] {
  return project.files
    .filter((file) => file.previous && file.state !== "unmanaged")
    .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))
}

/**
 * The files changed since the last startup, which the next one will apply:
 * the platform's own files, then the store's files, by name.
 */
export function pendingFiles(project: ProjectView): string[] {
  const platform = project.files.filter((file) => file.restartPending).map((file) => file.name)
  const store = project.store === null ? [] : storePending(project.store, project.service?.startedAt ?? null).files
  return [...platform, ...store]
}

/** The store's variables changed since the last startup: said beside the files, since they have no file name of their own. */
export function pendingVariables(project: ProjectView): boolean {
  return project.store !== null && storePending(project.store, project.service?.startedAt ?? null).variables
}

/** "The variables on the server and gcp.json", "portal.env": what a restart applies, in one phrase. */
export function pendingPhrase(files: readonly string[], variables: boolean): string {
  const pieces = [...(variables ? ["the variables on the server"] : []), ...files]
  if (pieces.length <= 1) return pieces.join("")
  return `${pieces.slice(0, -1).join(", ")} and ${pieces[pieces.length - 1]}`
}

// --- What is wrong in a project ------------------------------------------------

export type Problem =
  | { key: "service"; tone: Tone; label: string; systemd: string | null }
  | { key: "absent"; tone: Tone; label: string; file: string }
  | { key: "unmanaged"; tone: Tone; label: string; file: string }
  /** Declared in the manifest, with no value on the server: the store's names and files. */
  | { key: "missing"; tone: Tone; label: string; names: string[]; files: string[] }
  /** The store's folder or its env file is not as the steward writes them: it refuses every write. */
  | { key: "store-unmanaged"; tone: Tone; label: string }
  /** An installed unit does not read the store yet: what is set there does not reach the service. */
  | { key: "store-unread"; tone: Tone; label: string }
  | { key: "pending"; tone: Tone; label: string; files: string[]; variables: boolean }

const TONE_RANK: Record<Tone, number> = { error: 0, attention: 1, neutral: 2, ok: 3 }

/**
 * What makes a project worth looking at, the most serious first: its service if
 * it is not running, what it declares and lacks (its store's names and files,
 * once for the store, then each platform file), the unmanaged ones, a unit that
 * does not read its store yet, and the restart pending, stated once for the
 * whole project since it is the service that restarts. At equal severity, the
 * order of this list.
 */
export function projectProblems(project: ProjectView, serverNow: number): Problem[] {
  const problems: Problem[] = []
  const service = readService(project.service, serverNow)
  if (service.tone === "error" || service.tone === "attention") {
    problems.push({ key: "service", tone: service.tone, label: service.text, systemd: service.systemd })
  }
  const store = project.store
  const missing = store === null ? null : missingLabel(store)
  if (store !== null && missing !== null) {
    const { variables, files } = storeMissing(store)
    problems.push({ key: "missing", tone: "error", label: missing, names: variables, files })
  }
  for (const file of project.files) {
    if (file.state === "absent") problems.push({ key: "absent", tone: "error", label: "Missing", file: file.name })
  }
  if (store !== null && store.state === "unmanaged") problems.push({ key: "store-unmanaged", tone: "attention", label: "Unmanaged" })
  for (const file of project.files) {
    if (file.state === "unmanaged") {
      problems.push({ key: "unmanaged", tone: "attention", label: "Unmanaged", file: file.name })
    }
  }
  if (store !== null) {
    for (const file of store.files) {
      if (file.state === "unmanaged") problems.push({ key: "unmanaged", tone: "attention", label: "Unmanaged", file: file.name })
    }
  }
  if (store !== null && store.unitReadsStore === false) {
    problems.push({ key: "store-unread", tone: "attention", label: "Store not read yet" })
  }
  const pending = pendingFiles(project)
  const variables = pendingVariables(project)
  if (pending.length > 0 || variables) {
    problems.push({ key: "pending", tone: "attention", label: PENDING_LABEL, files: pending, variables })
  }
  // `sort` is stable: at equal severity, the order above.
  return problems.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone])
}

/**
 * What a project's files ask for, without its service, which the site's
 * Overview already shows: the Secrets section's indicator.
 */
export function fileProblems(project: ProjectView, serverNow: number): Problem[] {
  return projectProblems(project, serverNow).filter((problem) => problem.key !== "service")
}

/**
 * The reason a file is unmanaged, and the command it quotes when it quotes one:
 * the steward writes it after a colon, "owned by uid 0, not site-portal: sudo
 * chown site-portal /etc/sitesolide/portal.env". The page shows it separately, so it
 * can be copied, and leaves the reason whole if it does not have that shape:
 * nothing is invented.
 */
export function splitReason(reason: string): { text: string; command: string | null } {
  const clean = reason.trim()
  const marked = clean.lastIndexOf(": sudo ")
  const text = marked === -1 ? clean : clean.slice(0, marked).trim()
  const command = marked === -1 ? null : clean.slice(marked + 2).trim()
  const majuscule = text.charAt(0).toUpperCase() + text.slice(1)
  const phrase = majuscule === "" || /[.!?]$/.test(majuscule) ? majuscule : `${majuscule}.`
  return { text: phrase, command: command === "" ? null : command }
}

// --- The restart -----------------------------------------------------------------

/** What a restart usually takes, verdict included. */
export const RESTART_USUAL_MS = 10_000

/** The waiting track's scale: the longest a restart can take, rounded. */
export const RESTART_SCALE_MS = 60_000

/** Beyond this, the page says it is taking longer than usual. */
export const RESTART_SLOW_MS = 20_000

export type Progress = { part: number; usual: number; elapsed: string; slow: boolean }

/**
 * How far along the wait for a verdict is, on a one minute track where the
 * usual duration is engraved: the time actually elapsed, never an invented
 * progress, which the page does not know.
 */
export function restartProgress(elapsedMs: number): Progress {
  const borne = Math.max(0, elapsedMs)
  return {
    part: Math.min(1, borne / RESTART_SCALE_MS),
    usual: RESTART_USUAL_MS / RESTART_SCALE_MS,
    elapsed: `${Math.floor(borne / 1000)}s`,
    slow: borne >= RESTART_SLOW_MS,
  }
}

// --- A restart's verdict -------------------------------------------------------

export type VerdictReading = { tone: Tone; word: string; title: string; detail: string; restore: boolean }

/**
 * The verdict in plain words. `restore` says whether the page offers to put
 * back the previous version: never on its own initiative, the previous version
 * possibly being the key that leaked.
 */
export function readVerdict(verdict: RestartVerdict, slug: string): VerdictReading {
  const state = systemdState(verdict.state, verdict.subState)
  switch (verdict.kind) {
    case "active":
      return {
        tone: "ok",
        word: "Running",
        title: `${slug} is running`,
        detail: `It restarted and stayed up. systemd reports ${state}.`,
        restore: false,
      }
    case "looping": {
      const falls =
        verdict.restarts > 0
          ? `systemd restarted it ${plural(verdict.restarts, "time")} in a few seconds`
          : "It went down and systemd is restarting it"
      return {
        tone: "error",
        word: "Crash loop",
        title: `${slug} keeps crashing`,
        detail: `${falls}, and reports ${state}. A value it reads at startup may be wrong.`,
        restore: true,
      }
    }
    case "failure":
      return {
        tone: "error",
        word: "Failed",
        title: `${slug} did not start`,
        detail: `systemd reports ${state}. Check its logs with journalctl on the server.`,
        restore: true,
      }
    case "scheduled":
      // The relay that would carry the verdict is what restarts: the steward
      // answers first, and the verdict reaches the log.
      return {
        tone: "attention",
        word: "Restarting",
        title: `${slug} is restarting`,
        detail:
          "It restarts right after this answer, and the page loses its connection for a few seconds. It reconnects on its own; unlock again afterwards.",
        restore: false,
      }
  }
}

/** The verdict of a restart that cuts the dashboard itself: the page has to wait it out, then reconnect. */
export function cutsTheDashboard(verdict: Pick<RestartVerdict, "kind">): boolean {
  return verdict.kind === "scheduled"
}

// --- The log -------------------------------------------------------------------

/**
 * The latest operations, the most recent first. The steward already returns
 * them in that order; the sort keeps the page right should that change, and at
 * equal dates the received order is preserved.
 */
export function latestOperations(entries: readonly LogEntry[], max = LOG_MAX): LogEntry[] {
  return [...entries].sort((a, b) => b.a - a.a).slice(0, Math.max(0, max))
}

/**
 * A site's log. The steward already filters by `?slug=`; an entry naming
 * another site is still not displayed, should an older relay return everything.
 * An entry with no site, an unlock, stays: the steward returned it for this
 * site.
 */
export function siteOperations(entries: readonly LogEntry[], slug: string): LogEntry[] {
  return entries.filter((entry) => entry.slug === null || entry.slug === slug)
}

const OPERATION_NAMES: Record<Operation, string> = {
  unlock: "Unlock changes",
  lock: "Lock changes",
  read: "Read",
  list: "List secrets",
  set: "Set",
  remove: "Remove",
  create: "Create",
  restore: "Restore",
  replace: "Replace",
  password: "Change password",
  portal: "Change general access",
  code: "New code",
  restart: "Restart",
  "access.add": "Give access",
  "access.change": "Change role",
  "access.remove": "Take access away",
  "access.migrate": "Carry access over",
  "people.create": "Create projects",
  "dashboard.signin": "Sign in",
  "dashboard.signin_failed": "Sign-in refused",
  "dashboard.signout": "Sign out",
  "member.invite": "Give a role",
  "member.role": "Change roles",
  "member.remove": "Remove from the dashboard",
  "member.signin": "Sign in",
  "member.signin_failed": "Sign-in refused",
  "member.signout": "Sign out",
  sharing: "Change who can open it",
  "guest.create": "Give password access",
  "guest.revoke": "Remove password access",
  "backup.restore": "Restore backup",
  "token.create": "Create token",
  "token.revoke": "Revoke token",
  "project.create": "Create project",
  "project.remove": "Remove project",
  generate: "Generate",
  // Written by the steward before projects kept their secrets in their store
  // alone, and still read from the journals that carry them.
  migrate: "Merge into the store",
  retire: "Retire",
}

/**
 * The verb and its object: a variable or a file, written as in a terminal, or a
 * project. The object is null when the steward did not record it, and is not
 * invented.
 */
export type OperationParts = { verb: string; object: string | null; kind: "variable" | "file" | "project" | null }

/** A change of general access, by the direction the steward writes first in its detail: "on, ok", "off, failure", "code, ok". */
function generalVerb(detail: string | null): string {
  const direction = detail?.split(",")[0]?.trim()
  return direction === "on" ? "Restrict" : direction === "off" ? "Make public" : direction === "code" ? "Use a code" : OPERATION_NAMES.portal
}

/**
 * The journal's place for a project's store: `store` for its variables,
 * `store/<name>` for one of its files. Never a platform file's name, which is
 * flat.
 */
export const STORE_PLACE = "store"

/** A file of the store, by its name alone: `store/gcp.json` is `gcp.json`; anything else is null. */
export function storeFileOf(place: string | null): string | null {
  if (place === null || !place.startsWith(`${STORE_PLACE}/`)) return null
  const name = place.slice(STORE_PLACE.length + 1)
  return name === "" ? null : name
}

export function operationParts(entry: LogEntry): OperationParts {
  const operation = entry.operation
  const name = Object.hasOwn(OPERATION_NAMES, operation) ? OPERATION_NAMES[operation] : operation
  const verb = operation === "portal" ? generalVerb(entry.detail) : name
  switch (operation) {
    case "remove": {
      // A file of the store removed carries its place, and no variable.
      const file = entry.variable === null ? storeFileOf(entry.file) : null
      if (file !== null) return { verb, object: file, kind: "file" }
      return { verb, object: entry.variable, kind: entry.variable === null ? null : "variable" }
    }
    case "read":
    case "set":
    case "password":
    case "generate":
      return { verb, object: entry.variable, kind: entry.variable === null ? null : "variable" }
    case "create":
    case "restore":
    case "replace":
    case "retire": {
      // The store made, or its variables restored, read as the store itself.
      const file = storeFileOf(entry.file) ?? entry.file
      return { verb, object: file, kind: file === null ? null : "file" }
    }
    case "restart":
    case "portal":
    case "code":
    case "migrate":
      return { verb, object: entry.slug, kind: entry.slug === null ? null : "project" }
    default:
      return { verb, object: null, kind: null }
  }
}

/** Where the operation applied, without repeating what the label already names. */
export function operationPlace(entry: LogEntry): { project: string | null; file: string | null } {
  const clean = (value: string | null) => (value === null || value === "" ? null : value)
  switch (entry.operation) {
    case "read":
    case "set":
    case "remove":
    case "password":
    case "generate":
      // `store`, or `store/<name>` for a file of it removed: the place, the
      // label naming the file already.
      return { project: clean(entry.slug), file: storeFileOf(entry.file) !== null ? STORE_PLACE : clean(entry.file) }
    case "list":
    case "create":
    case "restore":
    case "replace":
    case "retire":
      return { project: clean(entry.slug), file: null }
    case "migrate":
      return { project: clean(entry.slug), file: STORE_PLACE }
    default:
      return { project: null, file: null }
  }
}

const VERDICTS: Record<VerdictKind, string> = {
  active: "running",
  looping: "crash loop",
  failure: "failed to start",
  scheduled: "restarting",
}

const CODES: Record<ErrorCode, string> = {
  locked: "locked",
  refused: "wrong password",
  "too-many-attempts": "too many attempts",
  invalid: "invalid",
  "out-of-scope": "out of scope",
  "not-found": "not found",
  unmanaged: "unmanaged",
  "already-present": "already exists",
  failure: "failed",
}

/**
 * Through `Object.hasOwn`: a detail reading "constructor" must not find the
 * prototype. A verdict is only read on a restart: `failure` on a portal action is
 * the error code, not a service that failed to start.
 */
function translate(detail: string, operation: Operation): string {
  if (operation === "restart" && Object.hasOwn(VERDICTS, detail)) return VERDICTS[detail as VerdictKind]
  if (Object.hasOwn(CODES, detail)) return CODES[detail as ErrorCode]
  return detail
}

export type OperationOutcome = { tone: Tone; text: string | null }

/**
 * How an operation turned out: nothing for an ordinary success, a restart's
 * verdict, or the refusal and its reason. An unknown detail is shown as is
 * rather than vanishing.
 */
export function operationOutcome(entry: LogEntry): OperationOutcome {
  // A change of general access, or a new code: its verb already says which way; only how it ended is left to say.
  if (entry.operation === "portal" || entry.operation === "code") {
    if (entry.result === "ok") return { tone: "ok", text: null }
    return entry.result === "rejects" ? { tone: "attention", text: "Refused" } : { tone: "error", text: "Failed" }
  }
  const detail = entry.detail
  const read = detail === null ? null : translate(detail, entry.operation)
  if (entry.result === "ok") {
    // A merge says how many names it brought, and from which files: "2 merged from a.env, b.env".
    if (entry.operation === "migrate" && read !== null && read !== "") return { tone: "ok", text: read.charAt(0).toUpperCase() + read.slice(1) }
    if (entry.operation !== "restart" || read === null || read === "") return { tone: "ok", text: null }
    // Alone in its column, the verdict takes its capital, like the dialog's word.
    const text = read.charAt(0).toUpperCase() + read.slice(1)
    // The steward writes the verdict first, then the systemd state:
    // "active, active/running, 0 restarts". The first word decides.
    const verdict = detail?.split(",")[0]?.trim()
    const tone: Tone = verdict === "active" ? "ok" : verdict === "scheduled" ? "attention" : "error"
    return { tone, text }
  }
  const refusal = entry.result === "rejects" ? "Refused" : "Failed"
  return { tone: entry.result === "rejects" ? "attention" : "error", text: read === null ? refusal : `${refusal}: ${read}` }
}

// --- The sites table -----------------------------------------------------------

export type SiteSecretsPanel = { variables: string[]; restartPending: boolean }

/**
 * What the sites table learns from the page: the names of the variables, the
 * platform files' and the store's, which the search knows, and the restart
 * pending, which shows on the row. Never a value, which the page does not have
 * anyway.
 */
export function secretsBySite(projects: readonly ProjectView[] | null): Map<string, SiteSecretsPanel> {
  const bySite = new Map<string, SiteSecretsPanel>()
  for (const project of projects ?? []) {
    const store = project.store
    const names = [...project.files.flatMap((file) => file.variables), ...(store?.variables.map((variable) => variable.name) ?? [])]
    bySite.set(project.slug, {
      variables: [...new Set(names)],
      restartPending: project.files.some((file) => file.restartPending) || (store?.restartPending ?? false),
    })
  }
  return bySite
}

/** The sites, each with its secrets when the page knows them. With nothing to add, the same list. */
export function withSecrets<T extends { slug: string }>(
  sites: T[],
  bySite: ReadonlyMap<string, SiteSecretsPanel>,
): Array<T & Partial<SiteSecretsPanel>> {
  if (bySite.size === 0) return sites
  return sites.map((site) => {
    const secrets = bySite.get(site.slug)
    return secrets === undefined ? site : { ...site, ...secrets }
  })
}

// --- The generated token -------------------------------------------------------

/** Fills the array with random bytes and returns it. `crypto.getRandomValues` by default. */
export type RandomBytes = (bytes: Uint8Array<ArrayBuffer>) => Uint8Array

const RANDOM: RandomBytes = (bytes) => crypto.getRandomValues(bytes)

/**
 * A token for a secret the site issues itself: 32 random bytes in base64url,
 * with no padding. The array passed to `random` is the one that gets encoded: a
 * source that fills it in place is enough, such as `crypto.getRandomValues`.
 */
export function generateToken(random: RandomBytes = RANDOM): string {
  const bytes = new Uint8Array(TOKEN_BYTES)
  random(bytes)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// --- A file read in the browser ------------------------------------------------

/**
 * Beyond this, the page does not read a dropped file: a secret fits in a few
 * kilobytes, and a file of several megabytes dropped by mistake would freeze
 * the tab. This is not the steward's size rule, which judges the contents on
 * send.
 */
export const MAX_UPLOAD_BYTES = 1024 * 1024
