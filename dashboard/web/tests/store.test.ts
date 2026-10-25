import { describe, expect, test } from "bun:test"
import {
  GENERATE_DEFAULT_BYTES,
  GENERATE_FORMATS,
  GENERATE_MAX_BYTES,
  GENERATE_MIN_BYTES,
  credentialName,
  encodeGenerated,
} from "../../borrowed/store"
import {
  CREDENTIAL_PREFIX,
  GENERATE_DEFAULT_SIZE,
  GENERATE_FORMATS_OFFERED,
  GENERATE_SIZES,
  changeSummary,
  credentialPath,
  encodeBase64,
  generatedLength,
  generatedSummary,
  isEmptyFile,
  missingLabel,
  restoreSummary,
  storeFileOffer,
  storeFileState,
  storeFileSummary,
  storeMissing,
  storePending,
  storeVariableOffer,
  withStore,
  UNDECLARED,
  UNDECLARED_HINT,
} from "../src/lib/store"
import {
  PENDING_LABEL,
  fileProblems,
  operationOutcome,
  operationParts,
  operationFile,
  pendingFiles,
  pendingPhrase,
  pendingVariables,
  projectProblems,
  secretsBySite,
  sortProjects,
} from "../src/lib/secrets"
import type { StoreMay } from "../src/lib/types"
import { logEntry, secretFile, secretProject, secretService, storeFile, storeVariable, storeView } from "./factory"

const NOW = 1_800_000_000_000
const HOUR = 3600_000

/** What `may` the steward hands each viewer of a store (spec 6.3): the page offers by it, never by who it thinks is signed in. */
const OWNER: StoreMay = { write: true, reveal: true, restore: true }
const ADMIN: StoreMay = { write: true, reveal: false, restore: true }
const DEVELOPER: StoreMay = { write: true, reveal: false, restore: false }
const READER: StoreMay = { write: false, reveal: false, restore: false }

describe("a project as it arrives", () => {
  test("an older steward's project, with no store, or a store the page cannot read, reads as one with none", () => {
    const { store: _, ...bare } = secretProject()
    expect(withStore(bare as never).store).toBeNull()
    expect(withStore(secretProject({ store: null })).store).toBeNull()
    expect(withStore(secretProject({ store: { slug: "cms" } as never })).store).toBeNull()
    // A steward from before this page may still list legacy files: the store reads all the same.
    const older = { ...storeView(), legacy: [] } as never
    expect(withStore(secretProject({ store: older })).store).toBe(older)
  })

  test("a store the steward sends is kept as it is", () => {
    const store = storeView()
    expect(withStore(secretProject({ store })).store).toBe(store)
  })

  test("sortProjects makes sure of every store, and sorts by slug", () => {
    const { store: _, ...bare } = secretProject({ slug: "zeta" })
    const sorted = sortProjects([bare as never, secretProject({ slug: "alpha", store: storeView({ slug: "alpha" }) })])
    expect(sorted.map((project) => [project.slug, project.store === null])).toEqual([
      ["alpha", false],
      ["zeta", true],
    ])
  })
})

describe("the path a service reads a file at", () => {
  test("$CREDENTIALS_DIRECTORY/files_<name>, the very name the unit generator's credential gets", () => {
    expect(credentialPath("gcp.json")).toBe("$CREDENTIALS_DIRECTORY/files_gcp.json")
    expect(credentialPath("tls.key")).toBe(`$CREDENTIALS_DIRECTORY/${credentialName("tls.key")}`)
    expect(`${CREDENTIAL_PREFIX}x`).toBe(credentialName("x"))
  })
})

describe("a variable's row", () => {
  test("a name sitesolide.json does not declare is a muted tag, its tooltip saying where", () => {
    expect(UNDECLARED).toBe("Not declared")
    expect(UNDECLARED_HINT).toStartWith("Not in sitesolide.json")
  })

  /** I8: only the owner reads a value back. Admin and Developer write, and see no reveal. */
  test("reveal is the owner's alone, and only on what the store holds", () => {
    const held = storeVariable({ source: "store" })
    expect(storeVariableOffer(storeView({ may: OWNER }), held).reveal).toBe(true)
    for (const may of [ADMIN, DEVELOPER, READER]) expect(storeVariableOffer(storeView({ may }), held).reveal).toBe(false)
    expect(storeVariableOffer(storeView({ may: OWNER }), storeVariable({ source: "none" })).reveal).toBe(false)
  })

  test("set and generate to whoever may write; remove only what the store holds; nothing on a store the server does not manage", () => {
    const held = storeVariable({ source: "store" })
    const unset = storeVariable({ source: "none" })
    for (const may of [OWNER, ADMIN, DEVELOPER]) {
      expect(storeVariableOffer(storeView({ may }), held)).toMatchObject({ set: true, generate: true, remove: true })
      expect(storeVariableOffer(storeView({ may }), unset)).toMatchObject({ set: true, generate: true, remove: false })
    }
    expect(storeVariableOffer(storeView({ may: READER }), held)).toEqual({ set: false, generate: false, replaces: true, remove: false, reveal: false })
    const unmanaged = storeView({ may: OWNER, state: "unmanaged" })
    expect(storeVariableOffer(unmanaged, held)).toMatchObject({ set: false, generate: false, remove: false })
  })

  test("generating over a value the store holds replaces it", () => {
    const store = storeView()
    expect(storeVariableOffer(store, storeVariable({ source: "store" })).replaces).toBe(true)
    expect(storeVariableOffer(store, storeVariable({ source: "none" })).replaces).toBe(false)
  })
})

describe("what is missing", () => {
  test("the declared names with no value, then the declared files not on the server, in the steward's order", () => {
    const store = storeView({
      missing: ["STRIPE_WEBHOOK_SECRET", "ADMIN_TOKEN"],
      files: [storeFile({ name: "tls.key", state: "missing" }), storeFile({ name: "gcp.json" })],
    })
    expect(storeMissing(store)).toEqual({ runtime: ["STRIPE_WEBHOOK_SECRET", "ADMIN_TOKEN"], files: ["tls.key"] })
    expect(missingLabel(store)).toBe("3 not set")
    expect(missingLabel(storeView())).toBeNull()
  })

  /** The steward lists an empty file as missing, its reason `empty`: a declared one is lacking, an undeclared one nobody reads is not. */
  test("a declared file the server holds empty is missing; an undeclared one is not counted", () => {
    const store = storeView({
      files: [
        storeFile({ name: "tls.key", state: "missing", reason: "empty", bytes: 0 }),
        storeFile({ name: "notes.txt", state: "missing", reason: "empty", declared: false, bytes: 0 }),
      ],
    })
    expect(storeMissing(store).files).toEqual(["tls.key"])
  })
})

describe("a file of the store", () => {
  test("upload to whoever may write, remove what is there, nothing on an unmanaged file or store", () => {
    expect(storeFileOffer(storeView({ may: DEVELOPER }), storeFile({ state: "set" }))).toEqual({ upload: true, remove: true })
    expect(storeFileOffer(storeView({ may: DEVELOPER }), storeFile({ state: "missing" }))).toEqual({ upload: true, remove: false })
    expect(storeFileOffer(storeView(), storeFile({ state: "unmanaged" }))).toEqual({ upload: false, remove: false })
    expect(storeFileOffer(storeView({ state: "unmanaged" }), storeFile())).toEqual({ upload: false, remove: false })
    expect(storeFileOffer(storeView({ may: READER }), storeFile())).toEqual({ upload: false, remove: false })
  })

  test("its state in a word and a tone, none when set; declared and missing or empty, the warning the verdict counts", () => {
    expect(storeFileState({ state: "set", reason: null, declared: true })).toBeNull()
    expect(storeFileState({ state: "missing", reason: null, declared: true })).toEqual({ text: "Missing", tone: "attention" })
    expect(storeFileState({ state: "missing", reason: "empty", declared: true })).toEqual({ text: "Empty", tone: "attention" })
    expect(storeFileState({ state: "missing", reason: "empty", declared: false })).toEqual({ text: "Empty", tone: "attention" })
    expect(storeFileState({ state: "unmanaged", reason: "a link", declared: true })).toEqual({ text: "Unmanaged", tone: "attention" })
    expect(isEmptyFile({ state: "missing", reason: "empty" })).toBe(true)
    expect(isEmptyFile({ state: "missing", reason: null })).toBe(false)
  })

  test("an empty file on the server can be removed like any file there", () => {
    expect(storeFileOffer(storeView(), storeFile({ state: "missing", reason: "empty" }))).toEqual({ upload: true, remove: true })
  })

  test("its size only when the steward gave it, which it does to the owner alone", () => {
    expect(storeFileSummary({ bytes: 2_300, modifiedAt: NOW - 3 * HOUR }, NOW)).toBe("2.2 KB, changed 3h ago")
    expect(storeFileSummary({ bytes: null, modifiedAt: NOW - 3 * HOUR }, NOW)).toBe("changed 3h ago")
    expect(storeFileSummary({ bytes: 0, modifiedAt: null }, NOW)).toBe("Empty")
    expect(storeFileSummary({ bytes: null, modifiedAt: null }, NOW)).toBe("")
  })

  test("any bytes go in base64, whatever their size, as Buffer would encode them", () => {
    const random = crypto.getRandomValues(new Uint8Array(70_000))
    expect(encodeBase64(random)).toBe(Buffer.from(random).toString("base64"))
    expect(encodeBase64(new Uint8Array([0, 255, 254, 10]))).toBe(Buffer.from([0, 255, 254, 10]).toString("base64"))
    expect(encodeBase64(new Uint8Array())).toBe("")
  })
})

describe("the restart a change waits for", () => {
  const started = NOW - 2 * HOUR

  test("nothing pending, nothing said", () => {
    expect(storePending(storeView(), started)).toEqual({ variables: false, files: [] })
  })

  test("the variables, when no file explains the pending restart", () => {
    expect(storePending(storeView({ restartPending: true, modifiedAt: NOW - HOUR }), started)).toEqual({ variables: true, files: [] })
  })

  test("a file by name, and the variables too only when they changed after the start", () => {
    const files = [storeFile({ name: "gcp.json", restartPending: true })]
    expect(storePending(storeView({ restartPending: true, files, modifiedAt: NOW - 3 * HOUR }), started)).toEqual({ variables: false, files: ["gcp.json"] })
    expect(storePending(storeView({ restartPending: true, files, modifiedAt: NOW - HOUR }), started)).toEqual({ variables: true, files: ["gcp.json"] })
  })

  test("a project's pending changes: the store's files, and its variables", () => {
    const project = secretProject({
      slug: "cms",
      service: secretService({ startedAt: started }),
      files: [],
      store: storeView({ restartPending: true, modifiedAt: NOW - HOUR, files: [storeFile({ name: "tls.key", restartPending: true })] }),
    })
    expect(pendingFiles(project)).toEqual(["tls.key"])
    expect(pendingVariables(project)).toBe(true)
    expect(pendingPhrase(["gcp.json", "tls.key"], true)).toBe("the variables on the server, gcp.json and tls.key")
    expect(pendingPhrase([], true)).toBe("the variables on the server")
    expect(pendingPhrase(["portal.env"], false)).toBe("portal.env")
    expect(pendingPhrase([], false)).toBe("")
  })
})

describe("what is wrong in a project with a store", () => {
  test("declared and not set is the warning the server counts it as, not an error", () => {
    const project = secretProject({
      slug: "cms",
      service: secretService({ startedAt: NOW - HOUR }),
      files: [],
      store: storeView({ missing: ["ADMIN_TOKEN"], files: [storeFile({ name: "tls.key", state: "missing" })] }),
    })
    expect(projectProblems(project, NOW)).toEqual([
      { key: "missing", tone: "attention", label: "2 not set", names: ["ADMIN_TOKEN"], files: ["tls.key"] },
    ])
  })

  test("an unmanaged store, an unmanaged file of it, a unit that does not read the store, and the variables pending", () => {
    const project = secretProject({
      service: secretService({ startedAt: NOW - 2 * HOUR }),
      files: [],
      store: storeView({
        state: "unmanaged",
        unitReadsStore: false,
        restartPending: true,
        modifiedAt: NOW - HOUR,
        files: [storeFile({ name: "gcp.json", state: "unmanaged" })],
      }),
    })
    expect(fileProblems(project, NOW).map((problem) => [problem.key, problem.label])).toEqual([
      ["store-unmanaged", "Unmanaged"],
      ["unmanaged", "Unmanaged"],
      ["store-unread", "Store not read yet"],
      ["pending", PENDING_LABEL],
    ])
  })

  test("a store that does not know yet whether its unit reads it is not a problem", () => {
    const project = secretProject({ service: secretService({ startedAt: NOW - HOUR }), files: [], store: storeView({ unitReadsStore: null }) })
    expect(projectProblems(project, NOW)).toEqual([])
  })
})

describe("the sites table", () => {
  test("knows the store's variable names, and its pending restart; never a value", () => {
    const project = secretProject({
      slug: "cms",
      files: [],
      store: storeView({ variables: [storeVariable({ name: "CMS_TOKEN" }), storeVariable({ name: "ADMIN_TOKEN" })], restartPending: true }),
    })
    expect(secretsBySite([project]).get("cms")).toEqual({ variables: ["CMS_TOKEN", "ADMIN_TOKEN"], restartPending: true })
  })

  test("knows a platform file's variable names too, once each", () => {
    const portal = secretProject({ files: [secretFile({ variables: ["OIDC_CLIENT_SECRET", "OIDC_CLIENT_SECRET"] })] })
    expect(secretsBySite([portal]).get("portal")).toEqual({ variables: ["OIDC_CLIENT_SECRET"], restartPending: false })
  })
})

describe("a generated value", () => {
  test("the sizes offered are the steward's range, the default its default, every format it draws", () => {
    for (const bytes of GENERATE_SIZES) {
      expect(bytes).toBeGreaterThanOrEqual(GENERATE_MIN_BYTES)
      expect(bytes).toBeLessThanOrEqual(GENERATE_MAX_BYTES)
    }
    expect(GENERATE_SIZES).toContain(GENERATE_DEFAULT_SIZE)
    expect(GENERATE_DEFAULT_SIZE).toBe(GENERATE_DEFAULT_BYTES)
    expect(GENERATE_FORMATS_OFFERED.map((offered) => offered.format)).toEqual([...GENERATE_FORMATS])
  })

  test("the length the dialog announces is the length the steward's encoding gives", () => {
    for (const format of GENERATE_FORMATS) {
      for (const bytes of GENERATE_SIZES) {
        expect(generatedLength(format, bytes)).toBe(encodeGenerated(new Uint8Array(bytes), format).length)
      }
    }
    expect(generatedSummary("hex", 32)).toBe("64 characters, 256 bits")
    expect(generatedSummary("base64url", 32)).toBe("43 characters, 256 bits")
  })
})

describe("what an answer says", () => {
  const empty = { set: [], generated: [], removed: [], absent: [], files: { set: [], removed: [] }, created: false }

  test("a change, in names alone", () => {
    expect(changeSummary({ ...empty, set: ["STRIPE_KEY"] }, "shop")).toBe("Set STRIPE_KEY.")
    expect(changeSummary({ ...empty, generated: ["SESSION_SECRET"], created: true }, "shop")).toBe(
      "Generated SESSION_SECRET on the server. The store of shop was created on the server.",
    )
    expect(changeSummary({ ...empty, removed: ["A"], absent: ["B", "C"] }, "shop")).toBe("Removed A. B and C were not in the store.")
    expect(changeSummary({ ...empty, files: { set: ["gcp.json"], removed: [] } }, "shop")).toBe("Uploaded gcp.json.")
    expect(changeSummary({ ...empty, files: { set: [], removed: ["tls.key"] } }, "shop")).toBe("Removed tls.key.")
    expect(changeSummary(empty, "shop")).toBe("Nothing changed.")
  })

  test("a restore's dry run: what comes back and what goes", () => {
    expect(restoreSummary({ appeared: ["OLD"], disappeared: ["NEW"] })).toEqual({ appeared: ["OLD"], disappeared: ["NEW"], empty: false })
    expect(restoreSummary({ appeared: [], disappeared: [] }).empty).toBe(true)
  })
})

describe("the log of a store", () => {
  test("a value generated names its variable in the store; never a value", () => {
    const entry = logEntry({ operation: "generate", file: "store", variable: "SESSION_SECRET" })
    expect(operationParts(entry)).toEqual({ verb: "Generate", object: "SESSION_SECRET", kind: "variable" })
    expect(operationFile(entry)).toBe("store")
  })

  test("a file of the store set, removed, and the store made", () => {
    expect(operationParts(logEntry({ operation: "replace", file: "store/gcp.json", variable: null }))).toEqual({ verb: "Replace", object: "gcp.json", kind: "file" })
    const removed = logEntry({ operation: "remove", file: "store/gcp.json", variable: null })
    expect(operationParts(removed)).toEqual({ verb: "Remove", object: "gcp.json", kind: "file" })
    expect(operationFile(removed)).toBe("store")
    expect(operationParts(logEntry({ operation: "create", file: "store", variable: null }))).toEqual({ verb: "Create", object: "store", kind: "file" })
    // A variable removed from the store stays a variable.
    expect(operationParts(logEntry({ operation: "remove", file: "store", variable: "A" }))).toEqual({ verb: "Remove", object: "A", kind: "variable" })
  })

  test("a merge and a retire, rows written before projects kept their secrets in their store alone, still read", () => {
    const merged = logEntry({ operation: "migrate", file: "store", variable: null, detail: "2 merged from a.env, b.env" })
    expect(operationParts(merged)).toEqual({ verb: "Merge into the store", object: "cms", kind: "project" })
    expect(operationOutcome(merged)).toEqual({ tone: "ok", text: "2 merged from a.env, b.env" })
    expect(operationOutcome({ ...merged, result: "rejects", detail: "invalid" })).toEqual({ tone: "attention", text: "Refused: invalid" })
    const retired = logEntry({ operation: "retire", file: "nis2-ses.env", variable: null })
    expect(operationParts(retired)).toEqual({ verb: "Retire", object: "nis2-ses.env", kind: "file" })
    expect(operationFile(retired)).toBeNull()
  })

  test("an operation the page does not know is shown by its own word, not dropped", () => {
    const entry = logEntry({ operation: "rotate" as never, variable: null, file: null })
    expect(operationParts(entry)).toEqual({ verb: "rotate", object: null, kind: null })
  })
})
