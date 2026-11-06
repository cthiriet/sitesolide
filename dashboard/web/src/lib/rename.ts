/**
 * What the rename dialog decides before asking the server: the name as it
 * will be sent, and what is wrong with it in words. The server judges again,
 * with the machine in hand (bin/cli/rename.ts). Pure.
 */

/** The slug a typed name becomes: trimmed and lowercased, nothing else changed, so that what is sent is what was shown. */
export function suggestedSlug(entry: string): string {
  return entry.trim().toLowerCase()
}

const SLUG = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/** Why this name cannot be sent, null when it can. */
export function renameFormError(from: string, to: string): string | null {
  if (to === "") return "Type the new name."
  if (to === from) return `${from} already has that name.`
  if (to.length > 63) return "63 characters at most."
  if (!SLUG.test(to)) return "Lowercase letters, digits and dashes, not starting or ending with a dash."
  return null
}

/** The server's refusal, in words. */
export function renameRefusal(status: number, body: { error?: unknown; message?: unknown } | null): string {
  if (status === 0) return "The server did not answer. The rename may still finish: reload the page in a minute to see the site's name."
  if (status === 503 || body?.error === "not-available") return typeof body?.message === "string" ? body.message : "This server cannot rename a project yet: run sitesolide upgrade."
  // As the server words it: it often starts with a slug, which a capital would change.
  if (typeof body?.message === "string" && body.message !== "") return body.message
  return `The server refused the rename (${status}).`
}
