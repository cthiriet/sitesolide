/**
 * What systemd says about a unit, and the verdict of a restart.
 *
 * Pure: the readings arrive timestamped, the verdict comes out of it. The
 * steward only launches `systemctl restart` then takes a `systemctl show`
 * reading every half-second; what must be concluded from it is decided here, on
 * sequences written by hand in the tests.
 */
import type { ServiceView, Verdict } from "./protocol";

/** What `systemctl show` must return for a verdict. */
export const SHOW_PROPERTIES = ["LoadState", "ActiveState", "SubState", "NRestarts", "ActiveEnterTimestamp"];

/**
 * `--timestamp=us+utc` returns `Wed 2026-09-16 21:14:12.162297 UTC`, to the
 * microsecond and always in UTC, the day of the week in English whatever the
 * machine's language (form measured, the bench results,
 * measurement 3). `--timestamp=unix` gave only the second, and the bench showed
 * what that cost (measurement 4): a set made 70 ms after a restart, within the
 * same second, was not reported, although the service did not have the value.
 */
export function showArguments(unit: string): string[] {
  return ["show", unit, "--timestamp=us+utc", ...SHOW_PROPERTIES.flatMap((property) => ["-p", property])];
}

export type Show = {
  /** `LoadState`, null if it was not asked for. `not-found` for a missing unit. */
  loading: string | null;
  state: string;
  subState: string;
  /** null when systemd does not say it: not knowing is not zero. */
  restarts: number | null;
  /** `ActiveEnterTimestamp` in microseconds. null if never started or unreadable. */
  startedUs: number | null;
  /** The same date in whole milliseconds, for the page. */
  startedAt: number | null;
};

export type ServiceReading = Show & { a: number };

const US_UTC_SHAPE = /^\S+ (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{6}) UTC$/;

/**
 * A `us+utc` timestamp in microseconds since the epoch, or null. Empty for a
 * unit that has never started; any other form, the earlier `@seconds`
 * included, returns null rather than a guessed date. Never an exception.
 *
 * 1.8e15 microseconds fit in a number without loss: the limit of exact integers
 * is 9e15.
 */
export function readUsTimestamp(raw: string): number | null {
  const chunks = US_UTC_SHAPE.exec(raw.trim());
  if (chunks === null) return null;
  const [year, month, day, hour, minute, second, micro] = chunks.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  // Date.UTC accepts 31 February and carries it over into March: the re-reading refuses it.
  const coherent =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second;
  if (!coherent || ms <= 0) return null;
  return ms * 1000 + micro;
}

export function readShow(output: string): Show {
  const properties = new Map<string, string>();
  for (const line of output.split("\n")) {
    const equal = line.indexOf("=");
    if (equal > 0) properties.set(line.slice(0, equal), line.slice(equal + 1).trim());
  }

  const counter = properties.get("NRestarts");
  const restarts = counter !== undefined && /^[0-9]+$/.test(counter) ? Number(counter) : null;
  const startedUs = readUsTimestamp(properties.get("ActiveEnterTimestamp") ?? "");

  return {
    loading: properties.get("LoadState") ?? null,
    state: properties.get("ActiveState") || "unknown",
    subState: properties.get("SubState") || "unknown",
    restarts,
    startedUs,
    startedAt: startedUs === null ? null : Math.floor(startedUs / 1000),
  };
}

/** null when systemd does not know the unit: a missing service is not a fallen service. */
export function serviceView(unit: string, show: Show | null): ServiceView | null {
  if (show === null) return null;
  if (show.loading !== null && show.loading !== "loaded") return null;
  return { unit, state: show.state, subState: show.subState, startedAt: show.startedAt };
}

/** The end of the window over which the counter must stay still. */
export const STABLE_WINDOW_MS = 3000;

const isRunning = (reading: ServiceReading): boolean => reading.state === "active" && reading.subState === "running";

/**
 * The verdict of a series of readings taken after the restart.
 *
 * - `looping` as soon as a reading shows `auto-restart`, or the counter climbs:
 *   a service that dies on a malformed key comes back up on `Restart=always`,
 *   and a reading taken while it is running would show it `active`.
 * - `active` if the last reading is `active/running`, the window covers at
 *   least three seconds, and over those last three seconds every reading is
 *   running with the same counter.
 * - `failure` otherwise: fallen, stopped, never started, or observed too little.
 *
 * Measured in the laboratory (the bench results,
 * measurement 3): `systemctl restart` returns 0 in a few milliseconds even when
 * the service dies at once or its binary is missing, and a service that dies
 * after three seconds looks healthy three seconds out of five. The return code
 * says nothing: only `auto-restart` and the climb of the counter give away a
 * loop.
 *
 * **`NRestarts` starts again from 0 at every requested restart.** The readings
 * are taken after the restart, so that reset to zero falls before the first
 * one. A counter that goes backwards DURING the observation is a reset by a
 * third party (`reset-failed`, another restart). It does not count as a
 * restart, the slope starts again from the new value, and if it falls within
 * the end of the window that window is not stable: the verdict cannot be
 * `active` on a unit that somebody else has just touched.
 */
export function verdict(readings: ServiceReading[], stableWindowMs: number = STABLE_WINDOW_MS): Verdict {
  const ordered = [...readings].sort((a, b) => a.a - b.a);
  const last = ordered[ordered.length - 1];
  if (last === undefined) return { kind: "failure", state: "unknown", subState: "unknown", restarts: 0 };

  let restarts = 0;
  let previous: number | null = null;
  for (const reading of ordered) {
    if (reading.restarts === null) continue;
    if (previous !== null && reading.restarts > previous) restarts += reading.restarts - previous;
    previous = reading.restarts;
  }

  const render = (kind: Verdict["kind"]): Verdict => ({
    kind,
    state: last.state,
    subState: last.subState,
    restarts,
  });

  if (restarts > 0 || ordered.some((reading) => reading.subState === "auto-restart")) return render("looping");
  if (!isRunning(last)) return render("failure");

  const windowStart = last.a - stableWindowMs;
  if (ordered[0]!.a > windowStart) return render("failure");

  const finish = ordered.filter((reading) => reading.a >= windowStart);
  const stable = finish.every((reading) => isRunning(reading) && reading.restarts === last.restarts);
  return render(stable ? "active" : "failure");
}

/**
 * The file changed after the service's last startup: strictly after, to the
 * microsecond. `modifiedMs` is the modification date with its fraction
 * (`mtimeMs`), brought back to the whole microsecond as systemd truncates its
 * own; an equality returns false.
 *
 * Both directions hold: a set made just after a restart, even within the same
 * second, is reported; a successful "save and restart" is not, the write
 * preceding the restart.
 *
 * A missing date returns false: without a file, nothing is waiting; without a
 * known startup, the next one will read the file as it stands.
 */
export function restartPending(modifiedMs: number | null, startedUs: number | null): boolean {
  if (modifiedMs === null || startedUs === null) return false;
  if (!Number.isFinite(modifiedMs) || !Number.isFinite(startedUs)) return false;
  return Math.floor(modifiedMs * 1000) > startedUs;
}
