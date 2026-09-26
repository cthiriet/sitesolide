/**
 * What changing a password decides inside the page: what it says depending on
 * the service that reads it, what it checks of the input before sending, what
 * goes to the steward and what "Copy password" copies. Pure.
 *
 * The page judges neither the strength nor the length of a password: the
 * steward does, and its refusal is shown under the field. The page only checks
 * what it alone can see, that the two entries are identical.
 */

/** `dashboard`: this dashboard's password. `portal`: the one for personal sites. */
export type PasswordKind = "dashboard" | "portal" | "other"

export function passwordKind(slug: string): PasswordKind {
  if (slug === "dashboard") return "dashboard"
  if (slug === "portal") return "portal"
  return "other"
}

export type PasswordTexts = {
  title: string
  /** What changes, and when: the form's warning. */
  warning: string
  /** What is left to do once the password has been changed. */
  nextStep: string
  /** The title of the drawn password screen. */
  generatedTitle: string
}

export function passwordTexts(slug: string, variable: string): PasswordTexts {
  switch (passwordKind(slug)) {
    case "dashboard":
      return {
        title: "Change the dashboard password",
        warning:
          "Unlocking secrets asks for the new password right away. Signing in to the dashboard keeps the old one until the dashboard restarts, and that restart signs everyone out.",
        nextStep: "Restart the dashboard to sign in with the new password. The restart signs everyone out, you included.",
        generatedTitle: "New dashboard password",
      }
    case "portal":
      return {
        title: "Change the portal password",
        warning: "Every personal site asks for the new password once the portal restarts.",
        nextStep: "Restart the portal to apply it: every personal site then asks for the new password.",
        generatedTitle: "New portal password",
      }
    case "other":
      return {
        title: `Change ${variable}`,
        warning: `${slug} keeps the old password until it restarts.`,
        nextStep: `Restart ${slug} to apply it.`,
        generatedTitle: `New password for ${slug}`,
      }
  }
}

/** `draw`: the steward draws it and returns it once. `choose`: typed twice here. */
export type PasswordMode = "draw" | "choose"

export type PasswordEntry = {
  dashboard: string
  mode: PasswordMode
  newPassword: string
  confirmation: string
}

export type PasswordErrors = Partial<Record<"dashboard" | "newPassword" | "confirmation", string>>

/** What is missing before sending. Nothing about password strength, which the steward judges. */
export function checkEntry(entry: PasswordEntry): PasswordErrors {
  const errors: PasswordErrors = {}
  if (entry.dashboard === "") errors.dashboard = "Enter your dashboard password."
  if (entry.mode === "choose") {
    if (entry.newPassword === "") errors.newPassword = "Enter the new password."
    else if (entry.confirmation !== entry.newPassword) errors.confirmation = "The two passwords don't match."
  }
  return errors
}

/** The first faulty field, in form order, where focus goes. */
export function firstFaultyField(errors: PasswordErrors): keyof PasswordErrors | null {
  return (["dashboard", "newPassword", "confirmation"] as const).find((field) => errors[field] !== undefined) ?? null
}

/** What goes to the steward: null so that it draws the password itself. */
export function passwordToSend(entry: Pick<PasswordEntry, "mode" | "newPassword">): string | null {
  return entry.mode === "draw" ? null : entry.newPassword
}

/**
 * What "Copy password" puts on the clipboard: the password as it is, with no
 * space and no line break, ready to paste into a manager. One stray blank would
 * be a different password.
 */
export function generatedPasswordText(password: string): string {
  return password
}

/** What the shared region says: never the password. */
export function passwordAnnouncement(generated: boolean): string {
  return generated ? "Password changed. Copy it now: it won't be shown again." : "Password changed."
}
