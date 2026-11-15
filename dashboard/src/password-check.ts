/**
 * The owner's password at sign-in, verified by the steward against the hash
 * as `/etc/sitesolide/dashboard.env` holds it now, not as it stood when this
 * process started: a password changed in the Secrets section stops signing
 * in at once, with no restart.
 *
 * A steward from before this route answers 404 for it: the hash this
 * process was started with verifies then, so that upgrading the dashboard
 * ahead of its steward locks nobody out. Any other failure of the steward
 * (down, restarting, busy) verifies nothing, and the client is not counted
 * a failure for it.
 */
import { isPasswordValid } from "./auth";
import { callSteward } from "./secrets/client";
import type { PasswordVerdict } from "./routes";

export type PasswordCall = (submitted: string) => Promise<Response>;

/** As long as an unlock may wait in the steward's queue of verifications. */
export function stewardPasswordCall(socket: string, timeoutMs: number): PasswordCall {
  return (submitted) => callSteward(socket, "POST", "/signin", { password: submitted }, timeoutMs);
}

export function createPasswordVerifier(call: PasswordCall, fallbackHash: string): (submitted: string) => Promise<PasswordVerdict> {
  return async (submitted) => {
    let response: Response;
    try {
      response = await call(submitted);
    } catch {
      return "unavailable";
    }
    if (response.status === 204) return "valid";
    let error: unknown = null;
    try {
      error = ((await response.json()) as { error?: unknown } | null)?.error ?? null;
    } catch {
      error = null;
    }
    if (response.status === 401 && error === "refused") return "refused";
    if (response.status === 403 && error === "out-of-scope") return "passkey-only";
    // The route unknown to the steward: one from before it.
    if (response.status === 404) return (await isPasswordValid(submitted, fallbackHash)) ? "valid" : "refused";
    // A request the steward found malformed is still a wrong password.
    if (response.status === 400) return "refused";
    return "unavailable";
  };
}
