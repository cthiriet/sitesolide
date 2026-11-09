import { describe, expect, test } from "bun:test"
import { renameFormError, renameRefusal, suggestedSlug } from "../src/lib/rename"

describe("the rename dialog", () => {
  test("sends the name as typed, trimmed and lowercased", () => {
    expect(suggestedSlug("  Cybersolide ")).toBe("cybersolide")
  })

  test("says what is wrong with a name before asking the server", () => {
    expect(renameFormError("oldsite", "")).toBe("Type the new name.")
    expect(renameFormError("oldsite", "oldsite")).toContain("already has that name")
    expect(renameFormError("oldsite", "cyber_solide")).toContain("Lowercase letters")
    expect(renameFormError("oldsite", "-cyber")).toContain("Lowercase letters")
    expect(renameFormError("oldsite", "a".repeat(64))).toContain("63")
    expect(renameFormError("oldsite", "cybersolide")).toBeNull()
  })

  test("keeps the server's words, a slug at their start included", () => {
    expect(renameRefusal(400, { error: "invalid", message: "docs is already the name of a project on this machine" })).toBe("docs is already the name of a project on this machine")
    expect(renameRefusal(0, null)).toContain("did not answer")
  })
})
