import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOLDER_NAME,
  lockCommand,
  decideTake,
  utcTime,
  readTakeAnswer,
  readHolder,
  STALE_MS,
  takeLock,
  releaseLock,
  takeScript,
  releaseScript,
  takeoverScript,
  checkScript,
  checkOwnership,
  type Remote,
} from "../cli/caddy-lock";

/**
 * The lock that the CLI, the scripts and the dashboard's gatekeeper share
 * before touching Caddy. A mistake here lets two gestures rewrite the same
 * configuration together, and that is how a site closed from the dashboard
 * went back to being served in the clear.
 *
 * The remote scripts really run, under `sh`, on a tree on the workstation that
 * stands in for /run/sitesolide-gatekeeper. The tests that run the CLI and the
 * scripts on a simulated VM live in e2e/caddy-lock.test.ts.
 */

const ROOTS: string[] = [];
afterEach(() => {
  for (const root of ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fresh root, whose /run/sitesolide-gatekeeper folder does not exist yet. */
function root(): string {
  const folder = mkdtempSync(join(tmpdir(), "caddy-lock-"));
  ROOTS.push(folder);
  return join(folder, "run", "sitesolide-gatekeeper");
}

/**
 * An `mv` that does its job, then writes `holder` into the folder set
 * aside: somebody else took the lock over just before the rename. It is the
 * only way to make the race that the rename protects fall for sure.
 */
function racingMv(holder: string): Record<string, string> {
  const bin = mkdtempSync(join(tmpdir(), "lock-mv-"));
  ROOTS.push(bin);
  // `.aside.` and `holder` are what bin/cli/caddy-lock.ts writes on the
  // machine: they are matched here, never chosen here.
  writeFileSync(
    join(bin, "mv"),
    `#!/bin/sh\n/bin/mv "$@" || exit 1\ncase "$2" in *.aside.*) printf '%s\\n' '${holder}' > "$2/holder";; esac\n`,
  );
  chmodSync(join(bin, "mv"), 0o755);
  return { PATH: `${bin}:${process.env.PATH ?? ""}` };
}

/** The script run as it is, without sudo: it is the one being put to the test. */
const withoutSudo = (script: string): string => script;

function local(logs: string[] = [], env: Record<string, string> = {}): Remote {
  return async (script) => {
    logs.push(script.split(";")[0]!);
    const execution = Bun.spawnSync(["sh", "-c", script], { env: { ...process.env, ...env } });
    return {
      code: execution.exitCode ?? 1,
      output: execution.stdout.toString(),
      error: execution.stderr.toString(),
    };
  };
}

function putLock(r: string, holder: string | null, ageMs = 0): void {
  const folder = join(r, "caddy.lock");
  mkdirSync(folder, { recursive: true });
  if (holder !== null) writeFileSync(join(folder, HOLDER_NAME), `${holder}\n`);
  const when = new Date(Date.now() - ageMs);
  utimesSync(folder, when, when);
}

function holder(r: string): string | null {
  const file = join(r, "caddy.lock", HOLDER_NAME);
  return existsSync(join(r, "caddy.lock")) ? (existsSync(file) ? readFileSync(file, "utf8").trim() : "") : null;
}

const TWENTY_MINUTES = 20 * 60 * 1000;

describe("the holder's line", () => {
  test("a name, a pid and milliseconds, nothing else", () => {
    expect(readHolder("gatekeeper 4242 1790000000000")).toEqual({ who: "gatekeeper", pid: 4242, since: 1790000000000 });
    expect(readHolder("deploy-caddy 1 2\n")).toEqual({ who: "deploy-caddy", pid: 1, since: 2 });
    // A name the workstation does not write is read all the same: it will be
    // named.
    expect(readHolder("collector 3 4")?.who).toBe("collector");
    for (const invalid of [
      "",
      "Root 1 2",
      "1abc 1 2",
      `${"a".repeat(33)} 1 2`,
      "deploy 1",
      "deploy  1 2",
      "deploy 1 2 3",
      "deploy -1 2",
      "deploy 1 2; rm -rf /",
      'deploy 1 2"',
      "deploy 1 $(reboot)",
      "deploy 1 9999999999999999",
    ]) {
      expect(readHolder(invalid)).toBeNull();
    }
  });

  test("the time is read in UTC, to the second", () => {
    expect(utcTime(Date.UTC(2026, 8, 17, 14, 3, 7, 900))).toBe("14:03:07 UTC");
  });
});

describe("the remote commands", () => {
  test("each one goes whole to sudo, without a single quote, and names itself first", () => {
    const line = "deploy 12 1790000000000";
    for (const [action, script] of [
      ["take", takeScript("deploy", 12)],
      ["retake", takeoverScript("deploy", 12, "gatekeeper 4 1")],
      ["retake", takeoverScript("deploy", 12, null)],
      ["release", releaseScript(line)],
      ["verify", checkScript(line)],
    ] as const) {
      const command = lockCommand(script);
      expect(command.startsWith(`sudo sh -c ': caddy-lock ${action} `)).toBe(true);
      expect(command.slice("sudo sh -c '".length, -1)).not.toContain("'");
      expect(script).toContain("/run/sitesolide-gatekeeper");
      expect(script).toContain("caddy.lock");
    }
  });

  test("no unchecked value enters a script", () => {
    expect(() => takeScript("root" as never, 1)).toThrow();
    // The workstation never writes in the gatekeeper's name.
    expect(() => takeScript("gatekeeper" as never, 1)).toThrow();
    expect(() => takeScript("deploy", 1.5)).toThrow();
    expect(() => takeScript("deploy", -1)).toThrow();
    expect(() => releaseScript("deploy 1 2; rm -rf /")).toThrow();
    expect(() => checkScript("deploy 1 $(reboot)")).toThrow();
    expect(() => takeoverScript("deploy", 1, "gatekeeper 1 2\"")).toThrow();
    expect(() => takeScript("deploy", 1, "/run/a b")).toThrow();
    expect(() => lockCommand("echo 'x'")).toThrow();
  });

  test("taking over an unreadable holder never copies its contents", () => {
    expect(takeoverScript("deploy", 1, null)).toContain("retake deploy 1 -;");
  });
});

describe("taking", () => {
  test("a free lock is taken, parent folder included, with the machine's time", async () => {
    const r = root();
    const before = Date.now();
    const acquisition = await takeLock("deploy-caddy", 321, local(), r, withoutSudo);
    expect(acquisition.kind).toBe("taken");
    if (acquisition.kind !== "taken") return;
    expect(acquisition.announcements).toEqual([]);
    expect(holder(r)).toBe(acquisition.line);
    const wasRead = readHolder(acquisition.line)!;
    expect(wasRead.who).toBe("deploy-caddy");
    expect(wasRead.pid).toBe(321);
    // `date +%s` followed by three zeros: accurate to the second.
    expect(wasRead.since).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(wasRead.since).toBeLessThanOrEqual(Date.now());
  });

  test("held by the gatekeeper, it is refused naming the dashboard and the time it was taken, and left in place", async () => {
    const r = root();
    const since = Date.now() - 60_000;
    putLock(r, `gatekeeper 4242 ${since}`);
    const logs: string[] = [];
    const acquisition = await takeLock("deploy", 1, local(logs), r, withoutSudo);
    expect(acquisition).toMatchObject({
      kind: "rejects",
      message: `a portal change from the dashboard is in progress (since ${utcTime(since)}): try again in a moment`,
    });
    expect(holder(r)).toBe(`gatekeeper 4242 ${since}`);
    expect(logs).toEqual([": caddy-lock take deploy 1"]);
  });

  test("held by another gesture of the workstation, or by an unknown holder, it is refused naming it", async () => {
    for (const who of ["lock", "collector"]) {
      const r = root();
      const since = Date.now() - 5_000;
      putLock(r, `${who} 7 ${since}`);
      expect(await takeLock("deploy", 1, local(), r, withoutSudo)).toMatchObject({
        kind: "rejects",
        message: `Caddy is being changed by ${who} since ${utcTime(since)}; try again in a moment`,
      });
    }
  });

  test("held for more than fifteen minutes, it is taken over, and the takeover says so", async () => {
    const r = root();
    const since = Date.now() - TWENTY_MINUTES;
    putLock(r, `lock 77 ${since}`, TWENTY_MINUTES);
    const logs: string[] = [];
    const acquisition = await takeLock("deploy", 9, local(logs), r, withoutSudo);
    expect(acquisition.kind).toBe("taken");
    if (acquisition.kind !== "taken") return;
    expect(acquisition.announcements).toEqual([
      `stale Caddy lock taken over: held by lock since ${utcTime(since)}, more than 15 minutes ago`,
    ]);
    expect(holder(r)).toBe(acquisition.line);
    expect(logs).toEqual([": caddy-lock take deploy 9", `: caddy-lock retake deploy 9 lock 77 ${since}`]);
  });

  test("a stale lock taken over by somebody else between the reading and the takeover stays with that one", async () => {
    const r = root();
    putLock(r, `lock 77 ${Date.now() - TWENTY_MINUTES}`, TWENTY_MINUTES);
    const fresh = `gatekeeper 4242 ${Date.now()}`;
    const base = local();
    let calls = 0;
    // The gatekeeper takes the lock over just after our reading.
    const remote: Remote = async (script) => {
      const response = await base(script);
      if (calls++ === 0) {
        rmSync(join(r, "caddy.lock"), { recursive: true });
        putLock(r, fresh);
      }
      return response;
    };
    const acquisition = await takeLock("deploy", 9, remote, r, withoutSudo);
    expect(acquisition).toMatchObject({ kind: "rejects", message: expect.stringContaining("a portal change from the dashboard is in progress") });
    expect(holder(r)).toBe(fresh);
  });

  test("a lock taken over by somebody else just before the rename is put back in place, never erased", async () => {
    const r = root();
    const isStale = `lock 77 ${Date.now() - TWENTY_MINUTES}`;
    putLock(r, isStale, TWENTY_MINUTES);
    const fresh = `gatekeeper 4242 ${Date.now()}`;
    const acquisition = await takeLock("deploy", 9, local([], racingMv(fresh)), r, withoutSudo);
    expect(acquisition).toMatchObject({ kind: "rejects", message: expect.stringContaining("a portal change from the dashboard") });
    expect(holder(r)).toBe(fresh);
    expect(readdirSync(r)).toEqual(["caddy.lock"]);
  });

  test("the takeover leaves nothing aside", async () => {
    const r = root();
    putLock(r, `lock 77 ${Date.now() - TWENTY_MINUTES}`, TWENTY_MINUTES);
    const acquisition = await takeLock("deploy", 9, local(), r, withoutSudo);
    expect(acquisition.kind).toBe("taken");
    expect(readdirSync(r)).toEqual(["caddy.lock"]);
  });

  test("a holder not yet written, in a recent folder, is held", async () => {
    const r = root();
    putLock(r, null);
    const acquisition = await takeLock("deploy", 1, local(), r, withoutSudo);
    expect(acquisition).toMatchObject({
      kind: "rejects",
      message: "Caddy is being changed by an unidentified holder; try again in a moment",
    });
    expect(holder(r)).toBe("");
  });

  test("an unreadable holder in a folder twenty minutes old is taken over", async () => {
    const r = root();
    putLock(r, "not a holder line", TWENTY_MINUTES);
    const acquisition = await takeLock("lock", 5, local(), r, withoutSudo);
    expect(acquisition).toMatchObject({ kind: "taken", announcements: [expect.stringContaining("unidentified holder")] });
    expect(readHolder(holder(r)!)?.who).toBe("lock");
  });

  test("a command that fails or an unexpected answer is never a take", async () => {
    const failing: Remote = async () => ({ code: 255, output: "", error: "ssh: connect to host: timed out\n" });
    expect(await takeLock("deploy", 1, failing)).toMatchObject({
      kind: "rejects",
      message: "cannot take the Caddy lock: ssh: connect to host: timed out",
    });
    for (const output of ["", "TAKEN\n", "TAKEN root 1 2\n", "HELD 12\nRECENT\n", "HELD abc\nRECENT\nEND\n", "hello\n"]) {
      const remote: Remote = async () => ({ code: 0, output, error: "" });
      expect((await takeLock("deploy", 1, remote)).kind).toBe("rejects");
    }
  });
});

describe("decideTake", () => {
  const held = (content: string, now: number, stale = false) => ({ kind: "held" as const, now, stale, content });

  test("exactly fifteen minutes is not enough, one millisecond more is", () => {
    expect(decideTake(held("gatekeeper 1 1000", 1000 + STALE_MS)).kind).toBe("rejects");
    expect(decideTake(held("gatekeeper 1 1000", 1001 + STALE_MS)).kind).toBe("stale");
  });

  test("a readable holder is judged by its own time, not by the folder's age", () => {
    expect(decideTake(held("gatekeeper 1 1000", 2000, true)).kind).toBe("rejects");
  });

  test("an unreadable holder is judged by the folder's age", () => {
    expect(decideTake(held("", 9e12, false)).kind).toBe("rejects");
    expect(decideTake(held("", 0, true))).toMatchObject({ kind: "stale", previous: null });
  });

  test("the answer of a take is read strictly", () => {
    expect(readTakeAnswer({ code: 0, output: "TAKEN deploy 1 2\n", error: "" }).kind).toBe("taken");
    expect(readTakeAnswer({ code: 0, output: "TAKEN deploy 1 2\nTAKEN deploy 1 3\n", error: "" }).kind).toBe("unreadable");
    expect(readTakeAnswer({ code: 0, output: "HELD 5000\nSTALE\ngatekeeper 1 2\n\nEND\n", error: "" })).toEqual({
      kind: "held",
      now: 5000,
      stale: true,
      content: "gatekeeper 1 2",
    });
  });
});

describe("giving back", () => {
  test("the lock held is removed, folder included", async () => {
    const r = root();
    const acquisition = await takeLock("deploy", 1, local(), r, withoutSudo);
    if (acquisition.kind !== "taken") throw new Error("not taken");
    expect(await releaseLock(acquisition.line, local(), r, withoutSudo)).toEqual({ kind: "released" });
    expect(existsSync(join(r, "caddy.lock"))).toBe(false);
  });

  test("a lock taken over by somebody else is not removed, and the warning names its holder", async () => {
    const r = root();
    const since = Date.now();
    putLock(r, `gatekeeper 4242 ${since}`);
    const release = await releaseLock("deploy 1 1000", local(), r, withoutSudo);
    expect(release).toMatchObject({
      kind: "warning",
      details: [`held now by gatekeeper since ${utcTime(since)}`],
    });
    expect(holder(r)).toBe(`gatekeeper 4242 ${since}`);
  });

  test("a lock taken over by somebody else just before the rename of the handover is put back in place", async () => {
    const r = root();
    const acquisition = await takeLock("deploy", 1, local(), r, withoutSudo);
    if (acquisition.kind !== "taken") throw new Error("not taken");
    const fresh = `gatekeeper 4242 ${Date.now()}`;
    const release = await releaseLock(acquisition.line, local([], racingMv(fresh)), r, withoutSudo);
    expect(release.kind).toBe("warning");
    expect(holder(r)).toBe(fresh);
    expect(readdirSync(r)).toEqual(["caddy.lock"]);
  });

  test("a lock already absent is given back", async () => {
    expect(await releaseLock("deploy 1 1000", local(), root(), withoutSudo)).toEqual({ kind: "released" });
  });

  test("a handover that fails says so, with the gesture to do by hand", async () => {
    const failing: Remote = async () => ({ code: 255, output: "", error: "connection closed\n" });
    const release = await releaseLock("deploy 1 1000", failing);
    expect(release.kind).toBe("warning");
    if (release.kind !== "warning") return;
    expect(release.message).toContain("may still be held");
    expect(release.details.join("\n")).toContain("sudo rm -rf /run/sitesolide-gatekeeper/caddy.lock");
  });
});

describe("the ownership handed over", () => {
  test("confirmed by the exact holder, and nothing is written", async () => {
    const r = root();
    putLock(r, "deploy 12 1000");
    expect(await checkOwnership("deploy 12 1000", local(), r, withoutSudo)).toEqual({ kind: "owned" });
    expect(holder(r)).toBe("deploy 12 1000");
  });

  test("refused if somebody else holds the lock, or if nobody holds it", async () => {
    const r = root();
    putLock(r, "gatekeeper 4 1000");
    expect(await checkOwnership("deploy 12 1000", local(), r, withoutSudo)).toMatchObject({
      kind: "rejects",
      details: ["expected deploy 12 1000", `a portal change from the dashboard is in progress (since ${utcTime(1000)}): try again in a moment`],
    });
    expect(await checkOwnership("deploy 12 1000", local(), root(), withoutSudo)).toMatchObject({
      kind: "rejects",
      details: ["expected deploy 12 1000", "the lock is not held at all"],
    });
  });

  test("a value that is not a holder line from the workstation is refused without running anything", async () => {
    const logs: string[] = [];
    for (const value of ["deploy 1 2; reboot", "gatekeeper 1 2", ""]) {
      expect((await checkOwnership(value, local(logs))).kind).toBe("rejects");
    }
    expect(logs).toEqual([]);
  });
});
