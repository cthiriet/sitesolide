/**
 * Does the owner hold a passkey? The dashboard asks the steward, which keeps
 * the registry, and remembers the last answer in its own database for when
 * the steward does not answer: a password refused because a passkey exists
 * must not come back the moment the steward is down or restarting.
 *
 * A registry the steward cannot read counts as holding passkeys: the
 * password comes back only once root has removed the last one.
 */
import type { PasskeyOffer } from "../people/protocol";
import type { PasskeyStewardClient } from "./client";

export type PasskeyState = {
  offer: () => Promise<PasskeyOffer>;
  /** Does the password still sign the owner in? */
  passwordSignIn: () => Promise<boolean>;
  /** Forgets the cached answer: a passkey was just added or removed. */
  changed: () => void;
};

export type PasskeyStateDependencies = {
  steward: Pick<PasskeyStewardClient, "list">;
  passwordConfigured: boolean;
  /** The last answer kept in the database, null when none was ever seen. */
  readRemembered: () => boolean | null;
  remember: (registered: boolean) => void;
  clock?: () => number;
};

/** The steward is asked at most this often: /api/session runs at every page load. */
export const CACHE_MS = 5_000;

export function createPasskeyState(dependencies: PasskeyStateDependencies): PasskeyState {
  const clock = dependencies.clock ?? Date.now;
  let cached: { at: number; registered: boolean } | null = null;

  async function registered(): Promise<boolean> {
    const now = clock();
    if (cached !== null && now - cached.at < CACHE_MS) return cached.registered;
    let answer: boolean | null = null;
    try {
      const response = await dependencies.steward.list();
      if (response.ok) {
        const body = (await response.json()) as { passkeys?: unknown; readable?: unknown };
        if (Array.isArray(body.passkeys) && typeof body.readable === "boolean") answer = !body.readable || body.passkeys.length > 0;
      }
    } catch {
      answer = null;
    }
    if (answer === null) {
      // Unreachable or unreadable: the last answer seen, and no cache, so
      // that the steward is asked again at the next request.
      return dependencies.readRemembered() ?? false;
    }
    if (dependencies.readRemembered() !== answer) dependencies.remember(answer);
    cached = { at: now, registered: answer };
    return answer;
  }

  return {
    async offer() {
      const held = await registered();
      return { registered: held, passwordSignIn: dependencies.passwordConfigured && !held };
    },
    passwordSignIn: async () => !(await registered()),
    changed() {
      cached = null;
    },
  };
}
