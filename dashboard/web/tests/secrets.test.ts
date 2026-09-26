import { describe, expect, test } from "bun:test"
import {
  MAX_UPLOAD_BYTES,
  UNREACHABLE,
  LOG_MAX,
  PENDING_LABEL,
  BUSY,
  RESTART_SCALE_MS,
  RESTART_USUAL_MS,
  RESTART_SLOW_MS,
  restartProgress,
  withSecrets,
  clockOffset,
  splitReason,
  latestOperations,
  filePath,
  cutsTheDashboard,
  unlockStatus,
  systemdState,
  pendingFiles,
  restorableFiles,
  generateToken,
  operationOutcome,
  refusalOf,
  operationPlace,
  readService,
  readLocalText,
  readVerdict,
  fileOffer,
  variableOffer,
  siteOperations,
  operationParts,
  fileProblems,
  projectProblems,
  hideCountdown,
  fileSummary,
  succeeded,
  secretsBySite,
  remainingLabel,
  sortProjects,
} from "../src/lib/secrets"
import { serviceState } from "../src/lib/sites"
import { logEntry, secretFile, secretProject, service, secretService } from "./factory"

const SECONDE = 1000
const MINUTE = 60 * SECONDE
const NOW = 1_800_000_000_000

describe("unlocking", () => {
  test("with no expiry, the page is locked, and that is not an expiration", () => {
    expect(unlockStatus(null, NOW)).toEqual({ open: false, expired: false, label: "Locked" })
  })

  test("the time left is counted in whole minutes", () => {
    expect(unlockStatus(NOW + 10 * MINUTE, NOW)).toMatchObject({
      open: true,
      label: "Unlocked, 10 min left",
    })
    expect(unlockStatus(NOW + 10 * MINUTE - 1, NOW)).toMatchObject({ restant: "9 min left" })
    expect(unlockStatus(NOW + MINUTE, NOW)).toMatchObject({ restant: "1 min left" })
  })

  test("under a minute, never a zero that would read as locked", () => {
    expect(remainingLabel(MINUTE - 1)).toBe("< 1 min left")
    expect(unlockStatus(NOW + 1, NOW)).toMatchObject({ open: true, restant: "< 1 min left" })
  })

  /** The steward refuses the token at the exact instant of its expiry: so does the page. */
  test("expired to the millisecond", () => {
    expect(unlockStatus(NOW, NOW)).toEqual({ open: false, expired: true, label: "Locked" })
    expect(unlockStatus(NOW - 1, NOW)).toMatchObject({ open: false, expired: true })
    expect(unlockStatus(NOW + 1, NOW).open).toBe(true)
  })

  test("the expiry is read on the server's clock", () => {
    // The workstation is five minutes slow: five are left, not ten.
    const offset = 5 * MINUTE
    expect(unlockStatus(NOW + 10 * MINUTE, NOW - offset, offset)).toMatchObject({
      restant: "10 min left",
    })
    expect(unlockStatus(NOW + 10 * MINUTE, NOW, offset)).toMatchObject({ restant: "5 min left" })
    // The workstation is twelve minutes fast: without correction, every unlock would look already over.
    expect(unlockStatus(NOW + 10 * MINUTE, NOW + 12 * MINUTE, -12 * MINUTE).open).toBe(true)
  })

  test("the offset comes from the age measured by the server and the time of reception", () => {
    // Generated at T, 20 s old according to the server, received at T + 20 s - 3 min by a slow workstation.
    const receivedAt = NOW + 20 * SECONDE - 3 * MINUTE
    expect(clockOffset(NOW, 20 * SECONDE, receivedAt)).toBe(3 * MINUTE)
    expect(clockOffset(NOW, 20 * SECONDE, NOW + 20 * SECONDE)).toBe(0)
  })
})

describe("meaning of a refused answer", () => {
  test("every 2xx is a success, nothing else", () => {
    expect([200, 201, 204].map(succeeded)).toEqual([true, true, true])
    expect([0, 199, 300, 401, 423, 502].map(succeeded)).toEqual([false, false, false, false, false, false])
  })

  test("nothing answered, or the service did not reach the steward", () => {
    expect(refusalOf(0, null)).toEqual({ kind: "unreachable", message: UNREACHABLE })
    expect(refusalOf(502, { error: "failure", message: "the steward is unreachable" })).toEqual({
      kind: "unreachable",
      message: UNREACHABLE,
    })
  })

  /** The steward's reason repeats the status in lowercase: the page says what to do. */
  test("503: the steward is busy, the request can be made again", () => {
    expect(refusalOf(503, { error: "failure", message: "the steward is busy, try again in a moment" })).toEqual({
      kind: "busy",
      message: BUSY,
    })
    expect(refusalOf(503, null)).toEqual({ kind: "busy", message: BUSY })
  })

  test("423 locks, whatever the body", () => {
    expect(refusalOf(423, { error: "locked", message: "Locked." })).toEqual({ kind: "locked" })
    expect(refusalOf(423, null)).toEqual({ kind: "locked" })
  })

  /** The same status says two things: only the second leaves the dialog open. */
  test("a 401 is a lost session, except for a refused password", () => {
    expect(refusalOf(401, { error: "no-session" })).toEqual({ kind: "session" })
    expect(refusalOf(401, null)).toEqual({ kind: "session" })
    expect(refusalOf(401, { error: "refused", message: "Wrong password." })).toEqual({
      kind: "rejects",
      message: "Wrong password.",
      waitS: 0,
    })
    expect(refusalOf(401, { error: "refused" })).toMatchObject({ message: "Wrong password." })
  })

  test("the steward's message is shown as it is", () => {
    const message = "Variable names use letters, digits and underscores."
    expect(refusalOf(400, { error: "invalid", message })).toEqual({ kind: "rejects", message, waitS: 0 })
    expect(refusalOf(409, { error: "unmanaged", message: "Unmanaged file." })).toMatchObject({
      message: "Unmanaged file.",
    })
  })

  test("too many attempts carries the wait, rounded up and never zero", () => {
    expect(refusalOf(429, { error: "too-many-attempts", message: "Too many attempts.", wait: 4.2 })).toEqual({
      kind: "rejects",
      message: "Too many attempts.",
      waitS: 5,
    })
    expect(refusalOf(429, { error: "too-many-attempts", wait: 0 })).toMatchObject({
      message: "Too many attempts.",
      waitS: 1,
    })
    expect(refusalOf(429, { wait: "soon" })).toMatchObject({ waitS: 1 })
  })

  test("with no message, a refused origin is stated, and an unknown code stays readable", () => {
    expect(refusalOf(403, { error: "origin-refused" })).toMatchObject({ message: "Origin not allowed." })
    expect(refusalOf(418, { error: "teapot" })).toMatchObject({ message: "Refused (418: teapot)." })
    expect(refusalOf(500, "not json")).toMatchObject({ message: "Refused (500)." })
    expect(refusalOf(500, { message: "   " })).toMatchObject({ message: "Refused (500)." })
  })
})

describe("projects", () => {
  test("by slug, without touching the list received", () => {
    const receivedTimes = [secretProject({ slug: "roster" }), secretProject({ slug: "calendar" }), secretProject({ slug: "cms" })]
    expect(sortProjects(receivedTimes).map((project) => project.slug)).toEqual(["calendar", "cms", "roster"])
    expect(receivedTimes.map((project) => project.slug)).toEqual(["roster", "calendar", "cms"])
  })

  test("a file counts its variables, unless it is unmanaged", () => {
    expect(fileSummary(secretFile({ variables: ["A", "B"] }))).toBe("2 variables")
    expect(fileSummary(secretFile())).toBe("1 variable")
    expect(fileSummary(secretFile({ variables: [] }))).toBe("No variables yet")
    expect(fileSummary(secretFile({ state: "absent", variables: [] }))).toBeNull()
    expect(fileSummary(secretFile({ state: "unmanaged", variables: [] }))).toBeNull()
  })

  test("a file read in one go states its size, never a variable count", () => {
    const key = secretFile({ name: "builder-ssh", kind: "content", variables: [], bytes: 411, readable: false })
    expect(fileSummary(key)).toBe("411 B")
    expect(fileSummary({ ...key, bytes: 3 * 1024 })).toBe("3.0 KB")
    expect(fileSummary({ ...key, bytes: 0 })).toBe("Empty")
    expect(fileSummary({ ...key, bytes: null })).toBeNull()
    expect(fileSummary({ ...key, state: "absent", bytes: null })).toBeNull()
  })

  test("a file filed in a subfolder is cut between folder and name", () => {
    expect(filePath("builder-secrets/registry")).toEqual({ folder: "builder-secrets/", base: "registry" })
    expect(filePath("a/b/c")).toEqual({ folder: "a/b/", base: "c" })
    expect(filePath("cms.env")).toEqual({ folder: null, base: "cms.env" })
    expect(filePath("/cms.env")).toEqual({ folder: null, base: "/cms.env" })
    expect(filePath("dossier/")).toEqual({ folder: null, base: "dossier/" })
  })
})

describe("what is offered for a file", () => {
  const variables = (partial = {}) => secretFile(partial)
  const content = (partial = {}) => secretFile({ kind: "content", variables: [], bytes: 100, ...partial })

  test("a managed variables file: add, and restore if it keeps a version", () => {
    expect(fileOffer(variables())).toEqual({
      create: false,
      restore: false,
      add: true,
      replace: false,
      reveal: false,
      writeOnly: false,
    })
    expect(fileOffer(variables({ previous: true })).restore).toBe(true)
  })

  test("a file read in one go: replace, and reveal only if it is readable", () => {
    expect(fileOffer(content({ readable: true }))).toMatchObject({ replace: true, reveal: true, add: false, writeOnly: false })
    expect(fileOffer(content({ readable: false }))).toMatchObject({ replace: true, reveal: false, writeOnly: true })
  })

  test("absent: only create it, of either kind", () => {
    for (const file of [variables({ state: "absent" }), content({ state: "absent", readable: false })]) {
      expect(fileOffer(file)).toMatchObject({ create: true, add: false, replace: false, reveal: false })
    }
    expect(fileOffer(content({ state: "absent", readable: false })).writeOnly).toBe(true)
  })

  test("unmanaged: nothing, not even restore, and write-only is not stated", () => {
    expect(fileOffer(content({ state: "unmanaged", previous: true, readable: false }))).toEqual({
      create: false,
      restore: false,
      add: false,
      replace: false,
      reveal: false,
      writeOnly: false,
    })
  })

  test("a password variable only offers Change password, readable or not", () => {
    const dashboard = variables({ variables: ["PASSWORD_HASH", "COOKIE"], passwords: ["PASSWORD_HASH"] })
    expect(variableOffer(dashboard, "PASSWORD_HASH")).toBe("password")
    expect(variableOffer(dashboard, "COOKIE")).toBe("read-write")
    expect(variableOffer({ ...dashboard, readable: false }, "PASSWORD_HASH")).toBe("password")
    expect(variableOffer({ ...dashboard, readable: false }, "COOKIE")).toBe("write")
  })
})

describe("service", () => {
  test("an active service says since when, on the server's clock", () => {
    expect(readService(secretService({ startedAt: NOW - 3 * 3600_000 }), NOW)).toEqual({
      tone: "ok",
      text: "Running",
      systemd: null,
      detail: "up 3h",
    })
    expect(readService(secretService({ subState: "exited", startedAt: null }), NOW)).toEqual({
      tone: "ok",
      text: "Running",
      systemd: "active (exited)",
      detail: null,
    })
  })

  test("a unit waiting to start again is in a loop, not starting up", () => {
    expect(readService(secretService({ state: "activating", subState: "auto-restart" }), NOW)).toEqual({
      tone: "error",
      text: "Restarting",
      systemd: "activating (auto-restart)",
      detail: null,
    })
    expect(readService(secretService({ state: "activating", subState: "start" }), NOW)).toMatchObject({
      tone: "error",
      text: "Starting",
      systemd: "activating (start)",
    })
    expect(readService(secretService({ state: "deactivating", subState: "stop" }), NOW)).toMatchObject({
      tone: "error",
      text: "Stopping",
      systemd: "deactivating (stop)",
    })
  })

  test("down, stopped, or unknown to systemd", () => {
    expect(readService(secretService({ state: "failed", subState: "failed" }), NOW)).toMatchObject({
      tone: "error",
      text: "Down",
      systemd: "failed",
    })
    expect(readService(secretService({ state: "inactive", subState: "dead" }), NOW)).toMatchObject({
      tone: "error",
      text: "Down",
      systemd: "inactive (dead)",
    })
    expect(readService(null, NOW)).toMatchObject({ tone: "neutral", text: "Unknown" })
  })

  /** The Sites page and the Secrets page name the same unit with the same word, at the same tone. */
  test("the words and the tones are the Sites page's", () => {
    const states: [string, string][] = [
      ["active", "running"],
      ["active", "exited"],
      ["activating", "start"],
      ["activating", "auto-restart"],
      ["deactivating", "stop"],
      ["failed", "failed"],
      ["inactive", "dead"],
      ["reloading", "reload"],
    ]
    for (const [state, subState] of states) {
      const secrets = readService(secretService({ state, subState }), NOW)
      const sites = serviceState({ type: "app", service: service({ active: state, subState: subState }) })
      expect({ tone: secrets.tone, label: secrets.text }).toEqual(sites)
    }
  })

  test("the substate is not repeated when it says the same as the state", () => {
    expect(systemdState("failed", "failed")).toBe("failed")
    expect(systemdState("failed", "")).toBe("failed")
    expect(systemdState("inactive", "dead")).toBe("inactive (dead)")
  })
})

describe("restoring", () => {
  test("only the files that have a previous version, the most recently modified first", () => {
    const project = secretProject({
      files: [
        secretFile({ name: "older.env", previous: true, modifiedAt: NOW - MINUTE }),
        secretFile({ name: "plain.env", previous: false, modifiedAt: NOW }),
        secretFile({ name: "recent.env", previous: true, modifiedAt: NOW }),
      ],
    })
    expect(restorableFiles(project).map((file) => file.name)).toEqual(["recent.env", "older.env"])
  })

  test("an unmanaged file is never offered", () => {
    const project = secretProject({ files: [secretFile({ state: "unmanaged", previous: true })] })
    expect(restorableFiles(project)).toEqual([])
  })
})

describe("a restart's verdict", () => {
  test("running: nothing to restore", () => {
    expect(readVerdict({ kind: "active", state: "active", subState: "running", restarts: 0 }, "cms")).toEqual({
      tone: "ok",
      word: "Running",
      title: "cms is running",
      detail: "It restarted and stayed up. systemd reports active (running).",
      restore: false,
    })
  })

  test("crash loop: the restarts are counted, and the restore is offered", () => {
    const read = readVerdict({ kind: "looping", state: "activating", subState: "auto-restart", restarts: 3 }, "cms")
    expect(read).toMatchObject({ tone: "error", word: "Crash loop", title: "cms keeps crashing", restore: true })
    expect(read.detail).toContain("3 times")
    expect(read.detail).toContain("activating (auto-restart)")
    expect(
      readVerdict({ kind: "looping", state: "activating", subState: "auto-restart", restarts: 1 }, "cms").detail,
    ).toContain("1 time in")
    expect(
      readVerdict({ kind: "looping", state: "activating", subState: "auto-restart", restarts: 0 }, "cms").detail,
    ).toStartWith("It went down")
  })

  test("scheduled: the dashboard restarts after answering, nothing to restore", () => {
    const verdict = { kind: "scheduled", state: "active", subState: "running", restarts: 0 } as const
    expect(readVerdict(verdict, "dashboard")).toMatchObject({
      tone: "attention",
      word: "Restarting",
      title: "dashboard is restarting",
      restore: false,
    })
    expect(readVerdict(verdict, "dashboard").detail).toContain("unlock again")
    expect(cutsTheDashboard(verdict)).toBe(true)
    expect(cutsTheDashboard({ kind: "active" })).toBe(false)
  })

  test("failure: the restore is offered too", () => {
    expect(readVerdict({ kind: "failure", state: "failed", subState: "failed", restarts: 0 }, "cms")).toMatchObject({
      tone: "error",
      word: "Failed",
      title: "cms did not start",
      restore: true,
    })
  })
})

describe("revealed value", () => {
  test("the remasking is counted in whole seconds, never zero", () => {
    expect(hideCountdown(30 * SECONDE)).toBe("Hides in 30s")
    expect(hideCountdown(24 * SECONDE + 1)).toBe("Hides in 25s")
    expect(hideCountdown(1)).toBe("Hides in 1s")
    expect(hideCountdown(0)).toBe("Hides in 1s")
    expect(hideCountdown(-500)).toBe("Hides in 1s")
  })
})

describe("what is wrong in a project", () => {
  const panne = secretService({ state: "activating", subState: "auto-restart" })

  test("a healthy project has nothing, and is summed up by its service", () => {
    const project = secretProject({ service: secretService({ startedAt: NOW - 3600_000 }) })
    expect(projectProblems(project, NOW)).toEqual([])
    expect(projectProblems(secretProject({ service: null }), NOW)).toEqual([])
  })

  test("errors first, then warnings, in the order service, missing, unmanaged, pending", () => {
    const project = secretProject({
      service: panne,
      files: [
        secretFile({ name: "cms.env", restartPending: true }),
        secretFile({ name: "cms-smtp.env", state: "unmanaged", variables: [] }),
        secretFile({ name: "cms-api.env", state: "absent", variables: [], modifiedAt: null }),
      ],
    })
    expect(projectProblems(project, NOW)).toEqual([
      { key: "service", tone: "error", label: "Restarting", systemd: "activating (auto-restart)" },
      { key: "absent", tone: "error", label: "Missing", file: "cms-api.env" },
      { key: "unmanaged", tone: "attention", label: "Unmanaged", file: "cms-smtp.env" },
      { key: "pending", tone: "attention", label: PENDING_LABEL, files: ["cms.env"] },
    ])
    expect(fileProblems(project, NOW).map((problem) => problem.key)).toEqual(["absent", "unmanaged", "pending"])
  })

  /** As on its row in Sites and in the server's discrepancies: a service that is not running is an error. */
  test("a service starting up is an error, an unknown service is not a problem", () => {
    const starting = secretProject({ service: secretService({ state: "activating", subState: "start" }) })
    expect(projectProblems(starting, NOW)).toEqual([
      { key: "service", tone: "error", label: "Starting", systemd: "activating (start)" },
    ])
    expect(projectProblems(secretProject({ service: null }), NOW)).toEqual([])
  })

  /** The restart holds for the whole service: one single pending item, naming every file. */
  test("the pending restart is stated once for the project", () => {
    const project = secretProject({
      files: [
        secretFile({ name: "cms.env", restartPending: true }),
        secretFile({ name: "cms-smtp.env", restartPending: false }),
        secretFile({ name: "cms-api.env", restartPending: true }),
      ],
    })
    expect(pendingFiles(project)).toEqual(["cms.env", "cms-api.env"])
    expect(projectProblems(project, NOW)).toHaveLength(1)
  })

  test("a missing file comes before a pending restart", () => {
    const project = secretProject({
      files: [
        secretFile({ restartPending: true }),
        secretFile({ name: "cms-smtp.env", state: "absent", variables: [] }),
      ],
    })
    expect(fileProblems(project, NOW).map((problem) => problem.label)).toEqual(["Missing", PENDING_LABEL])
  })
})

describe("reason for an unmanaged file", () => {
  test("the command quoted after the colon is set apart", () => {
    expect(splitReason("owned by uid 0, not site-cms: sudo chown site-cms /etc/sitesolide/cms.env")).toEqual({
      text: "Owned by uid 0, not site-cms.",
      command: "sudo chown site-cms /etc/sitesolide/cms.env",
    })
    expect(splitReason("mode 644 opens it beyond its owner: sudo chmod 600 /etc/sitesolide/cms.env")).toEqual({
      text: "Mode 644 opens it beyond its owner.",
      command: "sudo chmod 600 /etc/sitesolide/cms.env",
    })
  })

  test("with no command, the reason stays whole, with its capital and its full stop", () => {
    expect(splitReason("symbolic link")).toEqual({ text: "Symbolic link.", command: null })
    const phrase = "Line 2 starts with export, which systemd reads but the steward doesn't rewrite."
    expect(splitReason(phrase)).toEqual({ text: phrase, command: null })
    expect(splitReason("")).toEqual({ text: "", command: null })
  })

  test("an ordinary colon is not a command", () => {
    expect(splitReason("line 3: unterminated double quote")).toEqual({
      text: "Line 3: unterminated double quote.",
      command: null,
    })
    expect(splitReason("owned by root: sudo ")).toEqual({ text: "Owned by root: sudo.", command: null })
  })
})

describe("waiting for a restart", () => {
  test("the time elapsed on a one minute track, with the usual duration engraved", () => {
    expect(RESTART_USUAL_MS).toBeLessThan(RESTART_SLOW_MS)
    expect(RESTART_SLOW_MS).toBeLessThan(RESTART_SCALE_MS)
    expect(restartProgress(0)).toEqual({ part: 0, usual: 1 / 6, elapsed: "0s", slow: false })
    expect(restartProgress(RESTART_USUAL_MS)).toMatchObject({ part: 1 / 6, elapsed: "10s", slow: false })
    expect(restartProgress(RESTART_SLOW_MS - 1)).toMatchObject({ elapsed: "19s", slow: false })
    expect(restartProgress(RESTART_SLOW_MS)).toMatchObject({ elapsed: "20s", slow: true })
  })

  test("the track does not overflow, and a clock going backwards does not push it below zero", () => {
    expect(restartProgress(5 * MINUTE)).toMatchObject({ part: 1, elapsed: "300s", slow: true })
    expect(restartProgress(-SECONDE)).toMatchObject({ part: 0, elapsed: "0s" })
  })
})

describe("log", () => {
  test("the twenty most recent, the most recent first", () => {
    const entries = Array.from({ length: 30 }, (_, index) => logEntry({ a: NOW + index }))
    const latest = latestOperations(entries)
    expect(latest).toHaveLength(LOG_MAX)
    expect(latest[0]?.a).toBe(NOW + 29)
    expect(latest.at(-1)?.a).toBe(NOW + 10)
  })

  test("at equal dates, the steward's order, without touching the list received", () => {
    const entries = [logEntry({ variable: "A" }), logEntry({ variable: "B" })]
    expect(latestOperations(entries).map((entry) => entry.variable)).toEqual(["A", "B"])
    expect(latestOperations([], 20)).toEqual([])
  })

  test("every operation names its object, and the location does not repeat it", () => {
    expect(operationParts(logEntry({ operation: "set" }))).toEqual({ verb: "Set", object: "CMS_TOKEN", kind: "variable" })
    expect(operationPlace(logEntry({ operation: "set" }))).toEqual({ project: "cms", file: "cms.env" })
    expect(operationParts(logEntry({ operation: "read" }))).toMatchObject({ verb: "Read", object: "CMS_TOKEN" })
    expect(operationParts(logEntry({ operation: "remove" }))).toMatchObject({ verb: "Remove", object: "CMS_TOKEN" })
    expect(operationParts(logEntry({ operation: "create", variable: null }))).toMatchObject({ verb: "Create", object: "cms.env" })
    expect(operationPlace(logEntry({ operation: "create", variable: null }))).toEqual({ project: "cms", file: null })
    expect(operationParts(logEntry({ operation: "restore", variable: null }))).toMatchObject({ verb: "Restore", object: "cms.env" })
    expect(operationParts(logEntry({ operation: "restart", file: null, variable: null }))).toMatchObject({
      verb: "Restart",
      object: "cms",
    })
    expect(operationPlace(logEntry({ operation: "restart", file: null, variable: null }))).toEqual({
      project: null,
      file: null,
    })
    expect(operationPlace(logEntry({ operation: "set", slug: "", file: "" }))).toEqual({ project: null, file: null })
  })

  test("replacing a file, changing a password, changing the portal", () => {
    const replacement = logEntry({ operation: "replace", file: "builder-ssh", variable: null, slug: "builder" })
    expect(operationParts(replacement)).toEqual({ verb: "Replace", object: "builder-ssh", kind: "file" })
    expect(operationPlace(replacement)).toEqual({ project: "builder", file: null })

    const password = logEntry({ operation: "password", slug: "portal", file: "portal.env", variable: "PASSWORD_HASH" })
    expect(operationParts(password)).toEqual({ verb: "Change password", object: "PASSWORD_HASH", kind: "variable" })
    expect(operationPlace(password)).toEqual({ project: "portal", file: "portal.env" })

    const portal = logEntry({ operation: "portal", slug: "wheels", file: null, variable: null })
    expect(operationParts(portal)).toEqual({ verb: "Portal", object: "wheels", kind: "project" })
    expect(operationPlace(portal)).toEqual({ project: null, file: null })
  })

  test("an unlock has no object", () => {
    const entry = logEntry({ operation: "unlock", slug: null, file: null, variable: null })
    expect(operationPlace(entry)).toEqual({ project: null, file: null })
    expect(operationParts(entry)).toEqual({ verb: "Unlock", object: null, kind: null })
    expect(operationParts({ ...entry, operation: "lock" })).toEqual({ verb: "Lock", object: null, kind: null })
  })

  test("an object the steward does not know is not invented", () => {
    expect(operationParts(logEntry({ operation: "set", variable: null }))).toEqual({
      verb: "Set",
      object: null,
      kind: null,
    })
  })

  test("the object says what it is: a variable, a file, a project", () => {
    expect(operationParts(logEntry({ operation: "read" }))).toEqual({
      verb: "Read",
      object: "CMS_TOKEN",
      kind: "variable",
    })
    expect(operationParts(logEntry({ operation: "restore", variable: null }))).toEqual({
      verb: "Restore",
      object: "cms.env",
      kind: "file",
    })
    expect(operationParts(logEntry({ operation: "restart", file: null, variable: null }))).toEqual({
      verb: "Restart",
      object: "cms",
      kind: "project",
    })
  })

  test("an ordinary success says nothing, a restart states its verdict", () => {
    expect(operationOutcome(logEntry())).toEqual({ tone: "ok", text: null })
    expect(operationOutcome(logEntry({ operation: "restart", detail: "active" }))).toEqual({
      tone: "ok",
      text: "Running",
    })
    expect(operationOutcome(logEntry({ operation: "restart", detail: "looping" }))).toEqual({
      tone: "error",
      text: "Crash loop",
    })
    expect(operationOutcome(logEntry({ operation: "restart", detail: "failure" }))).toEqual({
      tone: "error",
      text: "Failed to start",
    })
    expect(operationOutcome(logEntry({ operation: "restart", detail: "" }))).toEqual({ tone: "ok", text: null })
    expect(operationOutcome(logEntry({ operation: "restart", detail: "scheduled" }))).toEqual({
      tone: "attention",
      text: "Restarting",
    })
  })

  test("a portal action says what the steward recorded, without judging", () => {
    expect(operationOutcome(logEntry({ operation: "portal", detail: "off" }))).toEqual({ tone: "neutral", text: "Off" })
    expect(operationOutcome(logEntry({ operation: "portal", detail: null }))).toEqual({ tone: "ok", text: null })
    // `failure` is here the gatekeeper's error code, not a service's verdict.
    expect(operationOutcome(logEntry({ operation: "portal", result: "failure", detail: "failure" }))).toEqual({
      tone: "error",
      text: "Failed: failed",
    })
  })

  test("a site's log does not show another site, even if the relay returned it", () => {
    const entries = [
      logEntry({ slug: "cms" }),
      logEntry({ slug: "calendar" }),
      logEntry({ operation: "unlock", slug: null, file: null, variable: null }),
    ]
    expect(siteOperations(entries, "cms").map((entry) => entry.slug)).toEqual(["cms", null])
  })

  test("a refusal and a failure state their reason, an unknown reason is shown as it is", () => {
    expect(operationOutcome(logEntry({ operation: "unlock", result: "rejects", detail: "refused" }))).toEqual({
      tone: "attention",
      text: "Refused: wrong password",
    })
    expect(operationOutcome(logEntry({ result: "failure", detail: null }))).toEqual({ tone: "error", text: "Failed" })
    expect(operationOutcome(logEntry({ result: "rejects", detail: "quota" }))).toMatchObject({
      text: "Refused: quota",
    })
    expect(operationOutcome(logEntry({ result: "rejects", detail: "constructor" }))).toMatchObject({
      text: "Refused: constructor",
    })
  })
})

describe("secrets in the sites table", () => {
  test("the variables of every file, and the pending restart if a single file is pending", () => {
    const bySite = secretsBySite([
      secretProject({
        slug: "cms",
        files: [
          secretFile({ variables: ["CMS_TOKEN"] }),
          secretFile({ name: "cms-smtp.env", variables: ["SMTP_PASSWORD"], restartPending: true }),
        ],
      }),
      secretProject({ slug: "calendar", files: [secretFile({ name: "calendar.env", variables: ["MAIL_KEY"] })] }),
    ])
    expect(bySite.get("cms")).toEqual({ variables: ["CMS_TOKEN", "SMTP_PASSWORD"], restartPending: true })
    expect(bySite.get("calendar")).toEqual({ variables: ["MAIL_KEY"], restartPending: false })
  })

  test("before the first load, nothing", () => {
    expect(secretsBySite(null).size).toBe(0)
  })

  test("every site receives its own, the others stay as they are", () => {
    const sites = [{ slug: "cms" }, { slug: "wheels" }]
    const bySite = secretsBySite([secretProject({ slug: "cms" })])
    const enriched = withSecrets(sites, bySite)
    expect(enriched[0]).toEqual({ slug: "cms", variables: ["CMS_TOKEN"], restartPending: false })
    expect(enriched[1]).toBe(sites[1]!)
    expect(withSecrets(sites, new Map())).toBe(sites)
  })
})

describe("generated token", () => {
  const impose = (nextStep: number[]) => (bytes: Uint8Array) => {
    bytes.set(nextStep)
    return bytes
  }
  const ALPHABET = /^[A-Za-z0-9_-]+$/

  test("32 bytes in base64url, with no padding", () => {
    const token = generateToken(impose(Array.from({ length: 32 }, (_, index) => index)))
    expect(token).toBe("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
    expect(token).toHaveLength(43)
    expect(token).not.toContain("=")
  })

  /** The bytes that would give `+` and `/` in ordinary base64. */
  test("the alphabet is the URL one", () => {
    const token = generateToken(impose(Array.from({ length: 32 }, (_, index) => (index % 2 === 0 ? 0xfb : 0xff))))
    expect(token).toBe("-__7__v_-__7__v_-__7__v_-__7__v_-__7__v_-_8")
    expect(token).toMatch(ALPHABET)
    expect(generateToken(impose(Array.from({ length: 32 }, () => 0xff)))).toBe(
      "__________________________________________8",
    )
  })

  test("the requested source receives an array of 32 bytes", () => {
    let received = 0
    generateToken((bytes) => {
      received = bytes.length
      return bytes
    })
    expect(received).toBe(32)
  })

  test("by default, the browser's randomness: two draws differ", () => {
    const a = generateToken()
    const b = generateToken()
    expect(a).toHaveLength(43)
    expect(a).toMatch(ALPHABET)
    expect(a).not.toBe(b)
  })
})

describe("file read in the browser", () => {
  const bytes = (text: string) => new TextEncoder().encode(text)

  test("a UTF-8 text is read as it is, line breaks included", () => {
    expect(readLocalText(bytes("-----BEGIN KEY-----\nabc\n"))).toEqual({ text: "-----BEGIN KEY-----\nabc\n" })
    expect(readLocalText(bytes("clé é"))).toEqual({ text: "clé é" })
    expect(readLocalText(new Uint8Array())).toEqual({ text: "" })
  })

  test("a byte that is not UTF-8 rejects the file, with no replacement character", () => {
    const read = readLocalText(new Uint8Array([0x61, 0xff, 0x62]))
    expect("error" in read).toBe(true)
  })

  test("beyond one megabyte, the file is not read", () => {
    expect("error" in readLocalText(new Uint8Array(MAX_UPLOAD_BYTES + 1))).toBe(true)
    expect(readLocalText(new Uint8Array(MAX_UPLOAD_BYTES).fill(0x61))).toMatchObject({ text: expect.any(String) })
  })
})
