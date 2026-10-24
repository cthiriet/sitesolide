/**
 * The attempts of the verification at a site's address, the last look of
 * `deploy` and `refresh` before the stability check: when to ask again, and
 * when to hand the answer over to be judged.
 *
 * Two waits, each bounded, each said once. `patienceMs`, with manual DNS
 * alone: a site that does not answer at all is asked again until then, its
 * first certificate being obtained by the handshake itself; without patience,
 * a site that does not answer fails at once, as it always did. WARM_UP_MS: a
 * 502, 503 or 504 is Caddy saying the app behind it does not answer yet,
 * which an app that warms up before it listens does for a few seconds after
 * its restart, healthy all along. Any other answer is judged at once.
 */
import type { Clock } from "./providers/provider";

/** Between two attempts. */
export const VERIFY_RETRY_MS = 5_000;

/**
 * How long, from the first 502, 503 or 504, the address is asked again. On
 * 2026-10-24 an app that calls its cloud's API before it listens answered 502
 * right after its restart, which failed `refresh` before the stability check,
 * and 200 seconds later.
 */
export const WARM_UP_MS = 30_000;

/** Caddy's answers while the app behind it does not listen yet, or not in time. */
const NOT_READY = new Set([502, 503, 504]);

/** What one attempt reads: the status, and the portal's header. */
export type Answer = { status: number; door: string | null };

/**
 * The answer to judge, `warmedUp` when it is still a 502, 503 or 504 after
 * WARM_UP_MS of asking again; or the last attempt's failure, when nothing
 * answered.
 */
export type Asked = (Answer & { warmedUp: boolean }) | { error: Error };

export async function askAddress(ask: () => Promise<Answer>, patienceMs: number, clock: Clock, say: (line: string) => void): Promise<Asked> {
  const deadline = clock.now() + patienceMs;
  let certificateSaid = false;
  let warmUpDeadline: number | null = null;
  for (;;) {
    let answer: Answer;
    try {
      answer = await ask();
    } catch (err) {
      if (clock.now() + VERIFY_RETRY_MS < deadline) {
        if (!certificateSaid) say(`   no answer yet: the zone is certified on demand, and the site's first certificate is obtained by this handshake; asking again for up to ${patienceMs / 1000} s`);
        certificateSaid = true;
        await clock.sleep(VERIFY_RETRY_MS);
        continue;
      }
      return { error: err as Error };
    }
    if (!NOT_READY.has(answer.status)) return { ...answer, warmedUp: false };
    if (warmUpDeadline === null) {
      say(`   ${answer.status}: the app does not answer Caddy yet, as one still starting does; asking again for up to ${WARM_UP_MS / 1000} s`);
      warmUpDeadline = clock.now() + WARM_UP_MS;
    }
    if (clock.now() + VERIFY_RETRY_MS >= warmUpDeadline) return { ...answer, warmedUp: true };
    await clock.sleep(VERIFY_RETRY_MS);
  }
}
