import { describe, expect, test } from "bun:test";
import {
  STABLE_WINDOW_MS,
  showArguments,
  readUsTimestamp,
  readShow,
  restartPending,
  serviceView,
  verdict,
  type ServiceReading,
} from "../src/secrets/restart";

describe("reading systemctl show", () => {
  // The form measured in the lab (output/3-steward.json).
  const MEASURE = "Wed 2026-09-16 21:14:12.162297 UTC";
  const MEASURE_US = Date.UTC(2026, 8, 16, 21, 14, 12) * 1000 + 162_297;

  test("a running unit, started to the microsecond", () => {
    const output = `LoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=0\nActiveEnterTimestamp=${MEASURE}\n`;
    expect(readShow(output)).toEqual({
      loading: "loaded",
      state: "active",
      subState: "running",
      restarts: 0,
      startedUs: MEASURE_US,
      startedAt: Math.floor(MEASURE_US / 1000),
    });
    expect(readShow(output).startedAt).toBe(Date.UTC(2026, 8, 16, 21, 14, 12, 162));
  });

  test("never started: empty timestamp", () => {
    const show = readShow("ActiveState=inactive\nSubState=dead\nActiveEnterTimestamp=\n");
    expect([show.startedUs, show.startedAt]).toEqual([null, null]);
  });

  test("an unknown form yields null, never an exception", () => {
    const shapes = [
      // The old format, which --timestamp=unix used to yield: no longer expected.
      "@1789593252",
      "@0",
      // The default format, with no microsecond.
      "Wed 2026-09-16 21:14:12 UTC",
      "Wed 2026-09-16 21:14:12.16229 UTC",
      "Wed 2026-09-16 21:14:12.162297 CEST",
      "Wed 2026-09-16 21:14:12.162297",
      "2026-09-16 21:14:12.162297 UTC",
      "Wed 2026-02-31 21:14:12.162297 UTC",
      "Wed 2026-13-01 21:14:12.162297 UTC",
      "Wed 2026-09-16 25:14:12.162297 UTC",
      "Wed 1970-01-01 00:00:00.000000 UTC",
      "n/a",
      "\u0000",
    ];
    for (const shape of shapes) {
      expect(() => readUsTimestamp(shape)).not.toThrow();
      expect(readUsTimestamp(shape)).toBeNull();
      expect(readShow(`ActiveEnterTimestamp=${shape}\n`).startedAt).toBeNull();
    }
  });

  test("the measured form reads, surrounding whitespace tolerated", () => {
    expect(readUsTimestamp(MEASURE)).toBe(MEASURE_US);
    expect(readUsTimestamp(` ${MEASURE} `)).toBe(MEASURE_US);
    expect(readUsTimestamp("Thu 2026-09-17 08:12:03.123456 UTC")).toBe(Date.UTC(2026, 8, 17, 8, 12, 3) * 1000 + 123_456);
  });

  test("what is missing is unknown, not zero", () => {
    const show = readShow("");
    expect(show).toEqual({
      loading: null,
      state: "unknown",
      subState: "unknown",
      restarts: null,
      startedUs: null,
      startedAt: null,
    });
    expect(readShow("NRestarts=[not set]\n").restarts).toBeNull();
    expect(readShow("NRestarts=\n").restarts).toBeNull();
  });

  test("the arguments ask for the timestamp to the microsecond and the five properties", () => {
    expect(showArguments("cms")).toEqual([
      "show",
      "cms",
      "--timestamp=us+utc",
      "-p",
      "LoadState",
      "-p",
      "ActiveState",
      "-p",
      "SubState",
      "-p",
      "NRestarts",
      "-p",
      "ActiveEnterTimestamp",
    ]);
  });

  test("a unit that cannot be found has no service view", () => {
    expect(serviceView("cms", readShow("LoadState=not-found\nActiveState=inactive\n"))).toBeNull();
    expect(serviceView("cms", null)).toBeNull();
    expect(serviceView("cms", readShow("LoadState=loaded\nActiveState=failed\nSubState=failed\n"))).toEqual({
      unit: "cms",
      state: "failed",
      subState: "failed",
      startedAt: null,
    });
  });
});

/** A series of readings every half second over eight seconds, described by a function of time. */
function ordered(describe: (ms: number) => Partial<ServiceReading>): ServiceReading[] {
  const readings: ServiceReading[] = [];
  for (let ms = 0; ms <= 8000; ms += 500) {
    readings.push({
      a: 1_000_000 + ms,
      loading: "loaded",
      state: "active",
      subState: "running",
      restarts: 0,
      startedUs: 1_000_000_000,
      startedAt: 1_000_000,
      ...describe(ms),
    });
  }
  return readings;
}

describe("verdict", () => {
  test("active: running from start to finish, counter unmoved", () => {
    expect(verdict(ordered(() => ({})))).toEqual({ kind: "active", state: "active", subState: "running", restarts: 0 });
  });

  test("active: a slightly slow start that holds afterwards", () => {
    const readings = ordered((ms) => (ms < 1500 ? { state: "activating", subState: "start" } : {}));
    expect(verdict(readings).kind).toBe("active");
  });

  test("looping: auto-restart glimpsed, even if the end looks like running", () => {
    const readings = ordered((ms) => (ms === 1000 ? { state: "activating", subState: "auto-restart" } : {}));
    expect(verdict(readings).kind).toBe("looping");
  });

  test("looping: the counter climbs without any reading landing on auto-restart", () => {
    const readings = ordered((ms) => ({ restarts: Math.floor(ms / 2500) }));
    const render = verdict(readings);
    expect(render.kind).toBe("looping");
    expect(render.restarts).toBe(3);
  });

  test("failure: fallen and stays fallen", () => {
    const readings = ordered((ms) => (ms >= 1000 ? { state: "failed", subState: "failed" } : {}));
    expect(verdict(readings)).toEqual({ kind: "failure", state: "failed", subState: "failed", restarts: 0 });
  });

  test("failure: never active", () => {
    expect(verdict(ordered(() => ({ state: "inactive", subState: "dead" }))).kind).toBe("failure");
    expect(verdict(ordered(() => ({ state: "activating", subState: "start" }))).kind).toBe("failure");
  });

  test("failure: no measurement, or a window shorter than three seconds", () => {
    expect(verdict([]).kind).toBe("failure");
    const short = ordered(() => ({})).filter((reading) => reading.a - 1_000_000 < STABLE_WINDOW_MS);
    expect(verdict(short).kind).toBe("failure");
  });

  test("failure: running at the end, but not over the whole end of the window", () => {
    const readings = ordered((ms) => (ms === 6500 ? { state: "deactivating", subState: "stop-sigterm" } : {}));
    expect(verdict(readings).kind).toBe("failure");
  });

  test("counter going backwards early: reset by a third party, the stable end stays active", () => {
    const readings = ordered((ms) => ({ restarts: ms < 2000 ? 4 : 0 }));
    const render = verdict(readings);
    expect(render.kind).toBe("active");
    expect(render.restarts).toBe(0);
  });

  test("counter going backwards in the end of the window: never active", () => {
    const readings = ordered((ms) => ({ restarts: ms < 7000 ? 2 : 0 }));
    expect(verdict(readings).kind).toBe("failure");
  });

  test("counter going backwards then up again: the climb counts", () => {
    const readings = ordered((ms) => ({ restarts: ms < 2000 ? 5 : ms < 4000 ? 0 : 1 }));
    const render = verdict(readings);
    expect(render.kind).toBe("looping");
    expect(render.restarts).toBe(1);
  });

  test("counter unknown everywhere: stability is judged on the state alone", () => {
    expect(verdict(ordered(() => ({ restarts: null }))).kind).toBe("active");
  });

  test("the order of the readings received does not matter", () => {
    const readings = ordered((ms) => (ms >= 1000 ? { state: "failed", subState: "failed" } : {})).reverse();
    expect(verdict(readings).kind).toBe("failure");
  });
});

/**
 * The series recorded in the lab (the bench results,
 * measurement 3), after a `systemctl restart` that returned 0 every time.
 * Line by line: ms since the restart, state, sub-state, NRestarts.
 */
function measured(changements: [number, string, string, number][]): ServiceReading[] {
  const readings: ServiceReading[] = [];
  for (let ms = 0; ms <= 8000; ms += 500) {
    const current = changements.filter(([since]) => since <= ms).at(-1)!;
    readings.push({
      a: 1_000_000 + ms,
      loading: "loaded",
      state: current[1],
      subState: current[2],
      restarts: current[3],
      startedUs: 1_000_000_000,
      startedAt: 1_000_000,
    });
  }
  return readings;
}

describe("verdict on the measured series", () => {
  test("other.service, healthy: active", () => {
    expect(verdict(measured([[0, "active", "running", 0]])).kind).toBe("active");
  });

  test("late.service, dies after three seconds: looping, although running at the end", () => {
    const readings = measured([
      [0, "active", "running", 0],
      [3087, "activating", "auto-restart", 0],
      [5126, "active", "running", 1],
    ]);
    expect(readings.at(-1)).toMatchObject({ state: "active", subState: "running" });
    expect(verdict(readings).kind).toBe("looping");
  });

  test("looping.service, dies at once, then failed: looping", () => {
    const readings = measured([
      [0, "activating", "auto-restart", 0],
      [2041, "active", "running", 1],
      [2551, "activating", "auto-restart", 1],
      [4083, "active", "running", 2],
      [4596, "activating", "auto-restart", 2],
      [6127, "failed", "failed", 3],
    ]);
    expect(verdict(readings)).toMatchObject({ kind: "looping", state: "failed", restarts: 3 });
  });

  test("missing.service, missing binary (203/EXEC): looping", () => {
    const readings = measured([
      [0, "activating", "auto-restart", 0],
      [2045, "active", "running", 1],
      [2553, "activating", "auto-restart", 1],
      [4080, "active", "running", 2],
      [4592, "activating", "auto-restart", 2],
      [6124, "active", "running", 3],
      [6635, "activating", "auto-restart", 3],
    ]);
    expect(verdict(readings).kind).toBe("looping");
  });

  test("start-limit-hit: failed from the very first reading, failure", () => {
    expect(verdict(measured([[0, "failed", "failed", 0]])).kind).toBe("failure");
  });
});

describe("restart pending", () => {
  const STARTED_US = Date.UTC(2026, 8, 17, 8, 12, 3) * 1000 + 123_456;
  const STARTED_MS = STARTED_US / 1000;

  test("a write in the same second as the start, just after it: pending (the bench's case)", () => {
    // systemctl restart cms, then PUT /variable 70 ms later.
    expect(restartPending(STARTED_MS + 70, STARTED_US)).toBe(true);
    expect(restartPending(STARTED_MS + 0.001, STARTED_US)).toBe(true);
  });

  test("saving then restarting, within the same second: nothing is pending", () => {
    expect(restartPending(STARTED_MS - 300, STARTED_US)).toBe(false);
    expect(restartPending(STARTED_MS - 0.001, STARTED_US)).toBe(false);
  });

  test("equal to the millisecond, and to the microsecond: strictly after only", () => {
    const ms = Date.UTC(2026, 8, 17, 8, 12, 3, 123);
    expect(restartPending(ms, ms * 1000)).toBe(false);
    expect(restartPending(STARTED_MS, STARTED_US)).toBe(false);
    // The modification date has its fraction: the same millisecond, one microsecond later.
    expect(restartPending(ms + 0.001, ms * 1000)).toBe(true);
  });

  test("modified well before or well after", () => {
    expect(restartPending(STARTED_MS + 86_400_000, STARTED_US)).toBe(true);
    expect(restartPending(STARTED_MS - 86_400_000, STARTED_US)).toBe(false);
  });

  test("dates missing or unusable", () => {
    expect(restartPending(null, STARTED_US)).toBe(false);
    expect(restartPending(STARTED_MS, null)).toBe(false);
    expect(restartPending(null, null)).toBe(false);
    expect(restartPending(Number.NaN, STARTED_US)).toBe(false);
    // An unreadable form from systemd gives null, so nothing is announced.
    expect(restartPending(STARTED_MS + 70, readUsTimestamp("@1789593252"))).toBe(false);
  });
});
