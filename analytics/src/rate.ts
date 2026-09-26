/**
 * The rate limit of ingestion.
 *
 * **Nothing authenticates a page view, and nothing can**: the script runs in
 * the visitor's browser, a key placed there would be readable by them. This
 * counter is therefore the only thing separating a measurement from a number
 * someone inflates by hand, and it is worth what it is worth: it bounds what
 * one browser can write, not what a network of machines could.
 *
 * It counts per visitor fingerprint, which already carries the address and the
 * host: two visitors of one same site therefore do not get in each other's way,
 * and the same visitor cannot multiply themselves by changing page.
 *
 * In memory, and with no regret: a restarted service starts again from an empty
 * counter, which costs at worst one minute with the ceiling lifted. Writing it
 * to the database would mean one more write per page view to guard against it.
 */

/** The counting window. One minute: the ceiling reads per minute. */
export const WINDOW_MS = 60_000;

/**
 * Fingerprints tracked before forgetting the oldest ones.
 *
 * Without this ceiling, the table would grow with the number of distinct
 * visitors and would never come down again: it is the classic memory leak of a
 * rate counter. Ten thousand fingerprints fit in less than one megabyte, and a
 * site on the machine does not see that many in one minute.
 */
export const MAX_TRACKED = 10_000;

type Counter = { start: number; views: number };

const counters = new Map<string, Counter>();

/**
 * Counts a page view and says whether it passes.
 *
 * Forgetting is done here rather than by a timer: a timer would run even
 * without a visit, and the purge only makes sense at the moment of writing.
 */
export function accept(fingerprint: string, now: number, cap: number): boolean {
  const counter = counters.get(fingerprint);

  if (counter === undefined || now - counter.start >= WINDOW_MS) {
    if (counters.size >= MAX_TRACKED) forget(now);
    counters.set(fingerprint, { start: now, views: 1 });
    return true;
  }

  counter.views += 1;
  return counter.views <= cap;
}

/**
 * Erases the closed windows, and failing that the oldest entry.
 *
 * The second case only happens if ten thousand distinct fingerprints show up
 * within the same minute: iteration over a `Map` follows insertion order, so
 * the first one returned is the oldest.
 */
function forget(now: number): void {
  for (const [fingerprint, counter] of counters) {
    if (now - counter.start >= WINDOW_MS) counters.delete(fingerprint);
  }

  if (counters.size >= MAX_TRACKED) {
    const first = counters.keys().next();
    if (!first.done) counters.delete(first.value);
  }
}

/** How many fingerprints are tracked. Read back by the tests. */
export function tracked(): number {
  return counters.size;
}

/** Empties the table. Exists only for the tests, which must start from zero. */
export function forgetAll(): void {
  counters.clear();
}
