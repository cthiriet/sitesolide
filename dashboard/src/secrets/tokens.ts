/**
 * The steward's tokens, as the dashboard keeps them: in memory, attached to
 * the hash of the session that unlocked, and nowhere else.
 *
 * The token never goes to the browser, but it is attached to the session: a
 * cookie stolen during an open window is worth reading and writing the scope
 * until it expires, ten minutes at most. Outside the window, it gives only the
 * dashboard, and unlocking still demands the password, checked by the steward.
 *
 * Nothing on disk, on purpose: a restart of the service forgets everything,
 * and one unlocks again. A token written in the database would survive a
 * backup that leaks, and would give in exchange nothing but ten minutes of
 * convenience.
 *
 * No input or output here, the clock is injected: every rule is judged to the
 * millisecond, without waiting.
 */

export type UnlockToken = {
  /** The steward's token, which never leaves the service. */
  token: string;
  /** End of the unlocking in milliseconds, set by the steward. */
  expiresAt: number;
};

export type Tokens = {
  /** Replaces what the session kept: the steward holds only one alive. */
  set: (session: string, unlockToken: UnlockToken) => void;
  /** The session's live unlocking, or null. Expired, it is forgotten. */
  read: (session: string) => UnlockToken | null;
  /** Forgets, and returns what was still alive so that the caller revokes it. */
  forget: (session: string) => UnlockToken | null;
};

/**
 * Alive strictly before `expiresAt`, as a session is alive strictly before its
 * duration (`isSessionAlive`): at the exact instant, the steward already
 * refuses, and the dashboard must not announce a minute it no longer has.
 */
function alive(unlockToken: UnlockToken, now: number): boolean {
  return now < unlockToken.expiresAt;
}

export function createTokens(clock: () => number = Date.now): Tokens {
  const store = new Map<string, UnlockToken>();

  function read(session: string): UnlockToken | null {
    const kept = store.get(session);
    if (kept === undefined) return null;
    if (!alive(kept, clock())) {
      store.delete(session);
      return null;
    }
    // A copy: the caller must not be able to extend an unlocking by modifying
    // what it has read.
    return { ...kept };
  }

  return {
    set(session, unlockToken) {
      store.set(session, { token: unlockToken.token, expiresAt: unlockToken.expiresAt });
    },
    read,
    forget(session) {
      const alive = read(session);
      store.delete(session);
      return alive;
    },
  };
}
