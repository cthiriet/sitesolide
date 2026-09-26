/** What a refused sign-in means, and the copy shortcut to announce. Pure. */
import { duration } from "./format"

export type SignInRefusal = { message: string; waitS: number }

/**
 * One single message for a wrong password: the server says no more, and that is
 * deliberate. The 429 carries a wait, which the page counts down.
 *
 * The 429 message stays fixed, the countdown living in the button: an error
 * message announced by a screen reader would be read out every second.
 */
export function signInRefusal(status: number, body: { error?: string; wait?: number } | null): SignInRefusal {
  if (status === 429) {
    return { message: "Too many attempts.", waitS: Math.max(1, Math.ceil(body?.wait ?? 1)) }
  }
  if (status === 0) return { message: "Can't reach the dashboard. Check your connection.", waitS: 0 }
  if (body?.error === "origin-refused") return { message: "Origin not allowed.", waitS: 0 }
  if (status === 401) return { message: "Wrong password.", waitS: 0 }
  return { message: `Sign-in failed (${status}).`, waitS: 0 }
}

/**
 * The button's label during the wait. The failure counter is global, not
 * specific to this browser: the wait applies to everyone.
 */
export function waitMessage(restantS: number): string {
  return `Try again in ${duration(Math.max(0, restantS) * 1000)}`
}

/** The shortcut to announce when the automatic copy failed. */
export function copyShortcut(agent: string): string {
  return /Mac|iPhone|iPad/.test(agent) ? "Cmd+C" : "Ctrl+C"
}
