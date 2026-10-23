/**
 * What a project's store says inside the page, and only that: the badge of a
 * variable's source, what is missing, what each row offers according to the
 * steward's `may`, the path a service reads a file at, the choices of a
 * generated value, the restart a change waits for, and the words of an answer.
 * Pure.
 *
 * No rule of the store here, no name, no size, no scope: the steward judges a
 * request on send, and the page shows its refusal as it words it, as for the
 * files of before (lib/secrets.ts). A value never comes through this module:
 * the listing carries names and states only, and a revealed value lives in the
 * row that shows it.
 */
import { ago, size } from "./format"
import type { Tone } from "./tones"
import type {
  ArrivingProjectView,
  GenerateFormat,
  LegacyFileView,
  ProjectView,
  StoreChangeResponse,
  StoreFileView,
  StoreMigrateResponse,
  StoreRestoreResponse,
  StoreRetireResponse,
  StoreVariableView,
  StoreView,
} from "./types"

// --- The project as it arrives ----------------------------------------------------

function isStoreView(value: unknown): value is StoreView {
  if (typeof value !== "object" || value === null) return false
  const store = value as Partial<StoreView>
  return (
    Array.isArray(store.variables) &&
    Array.isArray(store.missing) &&
    Array.isArray(store.files) &&
    Array.isArray(store.legacy) &&
    Array.isArray(store.build) &&
    Array.isArray(store.public) &&
    typeof store.may === "object" &&
    store.may !== null
  )
}

/**
 * A project with its store, or with none: a steward from before stores sends
 * no `store`, and a project shown with none reads its files as it did then,
 * which is what that steward still serves. Never throws.
 */
export function withStore(project: ArrivingProjectView): ProjectView {
  return { ...project, store: isStoreView(project.store) ? project.store : null }
}

// --- Files: the path a service reads ----------------------------------------------

/**
 * The prefix systemd gives every file of the folder it loads with
 * `LoadCredential=files:<folder>` (bin/cli/store.ts, `credentialName`). It
 * cannot be removed: it is part of what an app reads.
 */
export const CREDENTIAL_PREFIX = "files_"

/** Where every service of the project finds a file of its store. */
export function credentialPath(name: string): string {
  return `$CREDENTIALS_DIRECTORY/${CREDENTIAL_PREFIX}${name}`
}

// --- A variable -------------------------------------------------------------------

export type SourceBadge = { text: string; tone: Tone }

/**
 * Where the value in force comes from: the store (*Server*), a legacy file the
 * service reads (*Legacy file nis2-ses.env*), or nowhere yet (*Not set*), which
 * only a declared name can be.
 */
export function sourceBadge(variable: Pick<StoreVariableView, "source" | "file">): SourceBadge {
  switch (variable.source) {
    case "store":
      return { text: "Server", tone: "neutral" }
    case "legacy":
      return { text: variable.file === null ? "Legacy file" : `Legacy file ${variable.file}`, tone: "neutral" }
    case "none":
      return { text: "Not set", tone: "error" }
  }
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join("")
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

/** "Overrides a.env and b.env": legacy files that hold the name too, and lose to the value in force. */
export function overridesText(variable: Pick<StoreVariableView, "shadows">): string | null {
  return variable.shadows.length === 0 ? null : `Overrides ${list(variable.shadows)}`
}

export function declaredText(declared: boolean): string {
  return declared ? "Declared" : "Not declared"
}

/**
 * What a variable's row offers, from the steward's `may` and the variable's
 * source, never from who the page thinks is signed in. Offering is not
 * authorising: the steward judges on send.
 *
 * - `set`, `generate`: whoever may write, on a store the steward manages;
 * - `replaces`: a value is in force already, the store's or a legacy file's,
 *   so generating replaces it, and the dialog says the old one stops working
 *   at the next restart;
 * - `remove`: only what the store holds; a legacy file's value is removed in
 *   its file, below;
 * - `reveal`: the owner alone, on what the store holds.
 */
export type StoreVariableOffer = { set: boolean; generate: boolean; replaces: boolean; remove: boolean; reveal: boolean }

export function storeVariableOffer(store: Pick<StoreView, "may" | "state">, variable: Pick<StoreVariableView, "source">): StoreVariableOffer {
  const write = store.may.write && store.state !== "unmanaged"
  return {
    set: write,
    generate: write,
    replaces: variable.source !== "none",
    remove: write && variable.source === "store",
    reveal: store.may.reveal && variable.source === "store",
  }
}

// --- What is missing --------------------------------------------------------------

/**
 * The declared names with no value anywhere, and the declared files not on
 * the server, in the steward's order. A legacy-form manifest declares no
 * name: nothing is missing then.
 */
export function storeMissing(store: Pick<StoreView, "missing" | "files">): { variables: string[]; files: string[] } {
  return {
    variables: [...store.missing],
    files: store.files.filter((file) => file.state === "missing").map((file) => file.name),
  }
}

/** "2 not set", for the sidebar and the Overview; null when nothing is missing. */
export function missingLabel(store: Pick<StoreView, "missing" | "files">): string | null {
  const { variables, files } = storeMissing(store)
  const count = variables.length + files.length
  return count === 0 ? null : `${count} not set`
}

// --- The Overview -----------------------------------------------------------------

export type OverviewRow = { label: string; detail: string; state: SourceBadge | null }

function count(number: number, word: string): string {
  return `${number} ${word}${number === 1 ? "" : "s"}`
}

/**
 * A store in a few rows, for a site's Overview: its variables counted by
 * whether they hold a value, its files by name, the legacy files left. Names
 * of files only, never of variables: the inventory belongs to the Secrets
 * section. Nothing at all for a store with nothing in it and nothing declared.
 */
export function storeOverview(store: StoreView): OverviewRow[] {
  const rows: OverviewRow[] = []
  const { variables: missingNames, files: missingFiles } = storeMissing(store)
  const set = store.variables.filter((variable) => variable.source !== "none").length
  if (store.variables.length > 0) {
    const pieces = [set > 0 ? `${set} set` : null, missingNames.length > 0 ? `${missingNames.length} not set` : null].filter(
      (piece): piece is string => piece !== null,
    )
    rows.push({
      label: count(store.variables.length, "variable"),
      detail: missingNames.length === 0 ? "All set, on the server" : pieces.join(", "),
      state: missingNames.length > 0 ? { text: "Missing", tone: "error" } : null,
    })
  }
  if (store.files.length > 0) {
    rows.push({
      label: count(store.files.length, "file"),
      detail: store.files.map((file) => file.name).join(", "),
      state: missingFiles.length > 0 ? { text: "Missing", tone: "error" } : store.files.some((file) => file.state === "unmanaged") ? { text: "Unmanaged", tone: "attention" } : null,
    })
  }
  if (store.state === "unmanaged") rows.push({ label: "The store", detail: "The server refuses every change to it", state: { text: "Unmanaged", tone: "attention" } })
  return rows
}

// --- A file -----------------------------------------------------------------------

export type StoreFileOffer = { upload: boolean; remove: boolean }

/** *Upload* where there is none, *Replace* over one; *Remove* what is there. Never on an unmanaged file. */
export function storeFileOffer(store: Pick<StoreView, "may" | "state">, file: Pick<StoreFileView, "state">): StoreFileOffer {
  const write = store.may.write && store.state !== "unmanaged" && file.state !== "unmanaged"
  return { upload: write, remove: write && file.state === "set" }
}

export function storeFileState(file: Pick<StoreFileView, "state">): SourceBadge {
  switch (file.state) {
    case "set":
      return { text: "Set", tone: "neutral" }
    case "missing":
      return { text: "Missing", tone: "error" }
    case "unmanaged":
      return { text: "Unmanaged", tone: "attention" }
  }
}

/**
 * "2.1 kB, changed 3h ago": its size only when the steward gave it, which it
 * does to the owner alone, and an empty file said as such.
 */
export function storeFileSummary(file: Pick<StoreFileView, "bytes" | "modifiedAt">, serverNow: number): string {
  const pieces: string[] = []
  if (file.bytes !== null) pieces.push(file.bytes === 0 ? "Empty" : size(file.bytes))
  if (file.modifiedAt !== null) pieces.push(`changed ${ago(serverNow - file.modifiedAt)}`)
  return pieces.join(", ")
}

/**
 * The bytes of a file chosen in the browser, in base64 for the body: the store
 * holds any bytes, a key or a certificate, not text alone. Chunked, so that a
 * large file does not overflow the arguments of `fromCharCode`.
 */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let start = 0; start < bytes.length; start += chunk) {
    binary += String.fromCharCode(...bytes.subarray(start, start + chunk))
  }
  return btoa(binary)
}

// --- Legacy files -----------------------------------------------------------------

/** How a legacy file stands, in words, without its variables: read, a leftover, and, to the owner, covered. */
export function legacyLabels(legacy: Pick<LegacyFileView, "read" | "leftover" | "covered" | "state">): string[] {
  const labels: string[] = []
  if (legacy.state === "absent") labels.push("not on the server")
  if (legacy.leftover) labels.push("no longer declared")
  else labels.push(legacy.read ? "read by the service" : "not read by the service")
  if (legacy.covered === true) labels.push("covered by the store")
  if (legacy.covered === false) labels.push("not covered by the store")
  return labels
}

/** The same in one sentence: "Read by the service, covered by the store". */
export function legacyLine(legacy: Pick<LegacyFileView, "read" | "leftover" | "covered" | "state">): string {
  const line = legacyLabels(legacy).join(", ")
  return line.charAt(0).toUpperCase() + line.slice(1)
}

/**
 * *Retire*, the owner's alone: enabled once the steward says the store covers
 * the file. Otherwise why not, in the page's words, until the steward's own
 * reason comes back from an attempt. The steward checks every condition again.
 */
export type LegacyOffer = { retire: boolean; reason: string | null }

export function legacyOffer(store: Pick<StoreView, "may" | "unitReadsStore">, legacy: Pick<LegacyFileView, "state" | "covered" | "reason">): LegacyOffer | null {
  if (!store.may.migrate) return null
  if (legacy.state === "absent") return { retire: false, reason: "Not on the server: nothing to retire." }
  if (legacy.state === "unmanaged") return { retire: false, reason: legacy.reason ?? "The server does not manage this file." }
  if (store.unitReadsStore === false) return { retire: false, reason: "Its service does not read the store yet: deploy or refresh it first." }
  if (legacy.covered !== true) return { retire: false, reason: "A variable of this file is not in the store with the same value: merge into the store first." }
  return { retire: true, reason: null }
}

/** *Merge into the store*, the owner's alone, while a legacy file is left. The steward's dry run says what it would do. */
export function mayMerge(store: Pick<StoreView, "may" | "legacy">): boolean {
  return store.may.migrate && store.legacy.some((legacy) => !legacy.leftover)
}

// --- The restart a change waits for -----------------------------------------------

/**
 * What changed in the store since the project's main service last started:
 * its files by name, and its variables, which the listing dates as one. The
 * steward's `restartPending` covers both; the variables count when no file
 * explains it, or when they changed after the start too.
 */
export function storePending(store: Pick<StoreView, "restartPending" | "modifiedAt" | "files">, startedAt: number | null): { variables: boolean; files: string[] } {
  const files = store.files.filter((file) => file.restartPending).map((file) => file.name)
  if (!store.restartPending) return { variables: false, files }
  const variables =
    files.length === 0 || (store.modifiedAt !== null && startedAt !== null && store.modifiedAt > startedAt)
  return { variables, files }
}

// --- Generate ---------------------------------------------------------------------

/** The sizes the dialog offers, in bytes of randomness; the steward accepts 16 to 64. */
export const GENERATE_SIZES: readonly number[] = [16, 24, 32, 48, 64]
export const GENERATE_DEFAULT_SIZE = 32
export const GENERATE_FORMATS_OFFERED: readonly { format: GenerateFormat; title: string; description: string }[] = [
  { format: "hex", title: "Hexadecimal", description: "0 to 9 and a to f: what most libraries expect of a key" },
  { format: "base64url", title: "Base64url", description: "letters, digits, - and _, without padding: shorter" },
]

/** How many characters the drawn value has: two per byte in hexadecimal, four per three bytes in base64url without padding. */
export function generatedLength(format: GenerateFormat, bytes: number): number {
  return format === "hex" ? bytes * 2 : Math.ceil((bytes * 4) / 3)
}

/** "64 characters, 256 bits": what the dialog says of a choice. */
export function generatedSummary(format: GenerateFormat, bytes: number): string {
  return `${generatedLength(format, bytes)} characters, ${bytes * 8} bits`
}

// --- What an answer says ----------------------------------------------------------

/**
 * One sentence for a change the steward made, to announce and to show:
 * names only. `restart` adds what the service does next.
 */
export function changeSummary(answer: Pick<StoreChangeResponse, "set" | "generated" | "removed" | "absent" | "files" | "created">, slug: string): string {
  const pieces: string[] = []
  if (answer.set.length > 0) pieces.push(`Set ${list(answer.set)}`)
  if (answer.generated.length > 0) pieces.push(`Generated ${list(answer.generated)} on the server`)
  if (answer.removed.length > 0) pieces.push(`Removed ${list(answer.removed)}`)
  if (answer.absent.length > 0) pieces.push(`${list(answer.absent)} ${answer.absent.length === 1 ? "was" : "were"} not in the store`)
  if (answer.files.set.length > 0) pieces.push(`Uploaded ${list(answer.files.set)}`)
  if (answer.files.removed.length > 0) pieces.push(`Removed ${list(answer.files.removed)}`)
  const done = pieces.length === 0 ? "Nothing changed" : pieces.join(". ")
  const created = answer.created ? ` The store of ${slug} was created on the server.` : ""
  return `${done}.${created}`
}

/** The names a restore would bring back and take away, and whether it would change anything. */
export function restoreSummary(answer: Pick<StoreRestoreResponse, "appeared" | "disappeared">): { appeared: string[]; disappeared: string[]; empty: boolean } {
  return {
    appeared: [...answer.appeared],
    disappeared: [...answer.disappeared],
    empty: answer.appeared.length === 0 && answer.disappeared.length === 0,
  }
}

export type MigrationLine = { label: string; names: string[] }

/**
 * A merge of legacy files into the store, dry or done, in names and files
 * only: the steward never says a value, and neither does the page.
 * `conflicts` worded as the CLI words them; `merge` says whether the dry run
 * leaves something to write.
 */
export type MigrationReading = { lines: MigrationLine[]; conflicts: string[]; skipped: string[]; merge: boolean; nothing: boolean }

export function readMigration(answer: Pick<StoreMigrateResponse, "merged" | "already" | "overridden" | "conflicts" | "skipped" | "sources" | "written">, dryRun: boolean): MigrationReading {
  const lines: MigrationLine[] = []
  if (answer.sources.length > 0) lines.push({ label: "From", names: [...answer.sources] })
  if (answer.merged.length > 0) lines.push({ label: dryRun ? "Would merge" : "Merged", names: [...answer.merged] })
  if (answer.already.length > 0) lines.push({ label: "Already in the store, same value", names: [...answer.already] })
  if (answer.overridden.length > 0) lines.push({ label: "The store keeps its own value", names: [...answer.overridden] })
  const conflicts = answer.conflicts.map((conflict) => `${conflict.name}: in ${list(conflict.files)}, with different values`)
  const skipped = answer.skipped.map((skip) => `${skip.file}: ${skip.reason}`)
  return {
    lines,
    conflicts,
    skipped,
    merge: dryRun && conflicts.length === 0 && answer.merged.length > 0,
    nothing: conflicts.length === 0 && answer.merged.length === 0,
  }
}

/**
 * A merge's answer, whatever its status: a refusal for a conflict may carry
 * the conflicts alone. Any list missing reads as empty; nothing to read, null.
 */
export function migrationFrom(body: unknown, dryRun: boolean): MigrationReading | null {
  if (typeof body !== "object" || body === null) return null
  const answer = body as Partial<Record<keyof StoreMigrateResponse, unknown>>
  if (!Array.isArray(answer.merged) && !Array.isArray(answer.conflicts)) return null
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])
  const conflicts = Array.isArray(answer.conflicts)
    ? answer.conflicts.flatMap((conflict) =>
        typeof conflict === "object" && conflict !== null && typeof (conflict as { name?: unknown }).name === "string"
          ? [{ name: (conflict as { name: string }).name, files: strings((conflict as { files?: unknown }).files) }]
          : [],
      )
    : []
  const skipped = Array.isArray(answer.skipped)
    ? answer.skipped.flatMap((skip) =>
        typeof skip === "object" && skip !== null && typeof (skip as { file?: unknown }).file === "string"
          ? [{ file: (skip as { file: string }).file, reason: String((skip as { reason?: unknown }).reason ?? "") }]
          : [],
      )
    : []
  return readMigration(
    {
      sources: strings(answer.sources),
      merged: strings(answer.merged),
      already: strings(answer.already),
      overridden: strings(answer.overridden),
      conflicts,
      skipped,
      written: answer.written === true,
    },
    dryRun,
  )
}

/** What a retire did: the files deleted, and those kept with the steward's reason. */
export function readRetire(answer: Pick<StoreRetireResponse, "retired" | "kept">): { retired: string[]; kept: string[] } {
  return { retired: [...answer.retired], kept: answer.kept.map((keep) => `${keep.file}: ${keep.reason}`) }
}
