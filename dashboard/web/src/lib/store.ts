/**
 * What a project's store says inside the page, and only that: the badge of a
 * variable's source, what is missing, what each row offers according to the
 * steward's `may`, the path a service reads a file at, the choices of a
 * generated value, the restart a change waits for, and the words of an answer.
 * Pure.
 *
 * No rule of the store here, no name, no size, no scope: the steward judges a
 * request on send, and the page shows its refusal as it words it, as for the
 * platform's own files (lib/secrets.ts). A value never comes through this module:
 * the listing carries names and states only, and a revealed value lives in the
 * row that shows it.
 */
import { MISSING_SECRET_SEVERITY, storeMissing } from "../../../borrowed/store-protocol"
import { ago, size } from "./format"
import { severityTone, type Tone } from "./tones"
import type { GenerateFormat, ProjectView, StoreChangeResponse, StoreFileView, StoreRestoreResponse, StoreVariableView, StoreView } from "./types"

// --- The project as it arrives ----------------------------------------------------

function isStoreView(value: unknown): value is StoreView {
  if (typeof value !== "object" || value === null) return false
  const store = value as Partial<StoreView>
  return (
    Array.isArray(store.variables) &&
    Array.isArray(store.missing) &&
    Array.isArray(store.files) &&
    Array.isArray(store.build) &&
    Array.isArray(store.public) &&
    typeof store.may === "object" &&
    store.may !== null
  )
}

/**
 * A project with its store, or with none. The steward sends `store` for
 * every project, null for a static site, the dashboard, the portal and a
 * store it could not read; the page holds it to that shape all the same,
 * since `sitesolide upgrade` brings the steward first but a dashboard
 * deployed alone may still face an older one, whose projects carry no
 * `store`: they are shown with none. Never throws.
 */
export function withStore(project: ProjectView): ProjectView {
  return isStoreView(project.store) ? project : { ...project, store: null }
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

export type Badge = { text: string; tone: Tone }

function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join("")
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

/**
 * Said beside a name the store holds that sitesolide.json does not declare,
 * a muted tag; nothing beside one it does. Its tooltip says where.
 */
export const UNDECLARED = "Not declared"
export const UNDECLARED_HINT = "Not in sitesolide.json: nothing names it, though the store still hands it to the services"

/**
 * What a variable's row offers, from the steward's `may` and the variable's
 * source, never from who the page thinks is signed in. Offering is not
 * authorising: the steward judges on send.
 *
 * - `set`, `generate`: whoever may write, on a store the steward manages;
 * - `replaces`: the store holds a value already, so generating replaces it,
 *   and the dialog says the old one stops working at the next restart;
 * - `remove`: only what the store holds;
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
 * The declared names with no value in the store, `runtime`, and the declared
 * files the server lacks, absent or empty, in the steward's order: the rule
 * the server counts them by among the snapshot's discrepancies and the CLI
 * warns by (bin/cli/store-protocol.ts), so that this section, the verdict
 * and the Sites row agree.
 */
export { storeMissing }

/** What a declared name the store lacks is, in a row's gutter and its word: the warning the verdict counts. */
export { MISSING_SECRET_SEVERITY }
export const MISSING_TONE: Tone = severityTone(MISSING_SECRET_SEVERITY)

/** "2 not set", for the sidebar and the Overview; null when nothing is missing. */
export function missingLabel(store: Pick<StoreView, "missing" | "files">): string | null {
  const { runtime, files } = storeMissing(store)
  const count = runtime.length + files.length
  return count === 0 ? null : `${count} not set`
}

// --- A file -----------------------------------------------------------------------

export type StoreFileOffer = { upload: boolean; remove: boolean }

/**
 * A file the steward lists `missing` may still be on the server, empty: its
 * reason says `empty`. It reads as missing, since a service finds nothing in
 * it, and it can be removed like any file there.
 */
export function isEmptyFile(file: Pick<StoreFileView, "state" | "reason">): boolean {
  return file.state === "missing" && file.reason === "empty"
}

/** *Upload* where there is none, *Replace* over one; *Remove* what is there, an empty file too. Never on an unmanaged file. */
export function storeFileOffer(store: Pick<StoreView, "may" | "state">, file: Pick<StoreFileView, "state" | "reason">): StoreFileOffer {
  const write = store.may.write && store.state !== "unmanaged" && file.state !== "unmanaged"
  return { upload: write, remove: write && (file.state === "set" || isEmptyFile(file)) }
}

/** What a file's row flags: nothing for a file that is set, its state otherwise. */
export function storeFileState(file: Pick<StoreFileView, "state" | "reason" | "declared">): Badge | null {
  switch (file.state) {
    case "set":
      return null
    case "missing":
      // Declared, the verdict counts it as a warning; undeclared, nobody reads it, even empty.
      return { text: isEmptyFile(file) ? "Empty" : "Missing", tone: file.declared ? MISSING_TONE : "attention" }
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
