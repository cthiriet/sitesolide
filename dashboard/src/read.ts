/**
 * The snapshot, re-read from the file the collector drops.
 *
 * The file holds the RAW reading, not the finished snapshot: it is
 * `buildSnapshot` that interprets it, here, in the unprivileged
 * service. The split is deliberate. The privileged component must stay as
 * stupid as possible, and a display rule that changes is then fixed by an
 * ordinary `sitesolide deploy`, without touching what runs as root.
 */
import { buildAudience, type Audience } from "./audience";
import { STALE_AFTER_MS, buildSnapshot, type Raw, type Snapshot } from "./state";

export type Reading =
  | { present: false; reason: string }
  | {
      present: true;
      snapshot: Snapshot;
      age: number;
      stale: boolean;
      /**
       * The audience measurement, copied into the same reading by the
       * collector.
       *
       * It travels with the state of the machine rather than through a route
       * of its own: it is the same file, read once, and the page therefore has
       * no second call to make to display one more tab. Its age is its own,
       * the service that produces it being able to stop without the collector
       * stopping.
       */
      audience: Audience;
    };

/**
 * Analyses what the file held. A file that is missing, truncated or too old is
 * said so, it is not guessed: the worst possible result would be a dashboard
 * presenting as the current state a photograph taken three days ago.
 */
export function analyse(content: string | null, now: number): Reading {
  if (content === null) {
    return {
      present: false,
      reason: "No snapshot: the collector has never run, see bin/deploy-collector.sh",
    };
  }

  let raw: Raw;
  try {
    raw = JSON.parse(content) as Raw;
  } catch (err) {
    return { present: false, reason: `Unreadable snapshot: ${(err as Error).message}` };
  }

  if (typeof raw !== "object" || raw === null || !Array.isArray(raw.folders)) {
    return { present: false, reason: "Malformed snapshot: no folders collected" };
  }

  const generated = typeof raw.generated === "number" ? raw.generated : 0;
  const age = now - generated;

  return {
    present: true,
    snapshot: buildSnapshot(raw),
    audience: buildAudience(raw, now),
    age,
    // The timer passes every minute. Three minutes without a new collection
    // means that the timer no longer runs, and that is precisely what a
    // dashboard must not keep quiet about.
    stale: age > STALE_AFTER_MS,
  };
}

/** Reads the file. Its absence is not an error, it is a state to display. */
export async function read(path: string, now: number): Promise<Reading> {
  const file = Bun.file(path);
  if (!(await file.exists())) return analyse(null, now);
  return analyse(await file.text(), now);
}
