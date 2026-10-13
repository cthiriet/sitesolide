import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeRuns,
  eventFor,
  forEachLine,
  formatEvent,
  readJournalEntry,
  readLockState,
  readSchedule,
  readStatus,
  runsOf,
  STATUS_SCRIPT,
  type OutputEvent,
} from "../cli/output";

/**
 * What `--json` prints, and the readings that turn the machine's tables into
 * data. The tables are produced here by `printf` with the very format strings
 * bin/cli/output.ts and bin/lock.sh use, read from their source: a column
 * added there is a column these tests read.
 */
const BIN = join(import.meta.dir, "..");

/** The `printf` format of a script, the first one following `marker`. */
function formatOf(file: string, marker: string): string {
  const source = readFileSync(join(BIN, file), "utf8");
  const after = source.slice(source.indexOf(marker));
  const format = /printf ["']([^"']*%-22s[^"']*)["']/.exec(after)?.[1];
  if (format === undefined) throw new Error(`no printf format after ${marker} in ${file}`);
  return format;
}

/** What `printf` prints for these rows, run by the shell as the machine would. */
function printf(format: string, rows: string[][]): string {
  return rows
    .map((row) => {
      const result = Bun.spawnSync(["sh", "-c", 'printf "$0" "$@"', format, ...row]);
      return result.stdout.toString();
    })
    .join("");
}

describe("events", () => {
  test("one line each, whatever the message carries", () => {
    const event: OutputEvent = { type: "file", name: "shop.service", content: "[Unit]\nDescription=Shop\n" };
    const line = formatEvent(event);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual(event);
  });

  test("a human line is read for its kind: step, planned, warning, information", () => {
    expect(eventFor("-> build (bun run build)")).toEqual({ type: "step", message: "build (bun run build)" });
    expect(eventFor("   [dry-run] rsync -a --delete public/ x:/srv/sites/x/public/")).toEqual({
      type: "planned",
      message: "rsync -a --delete public/ x:/srv/sites/x/public/",
    });
    expect(eventFor("   !! cannot read the manifests: the loopback's project set was left as it is")).toEqual({
      type: "warning",
      message: "cannot read the manifests: the loopback's project set was left as it is",
      details: [],
    });
    expect(eventFor("   present  /etc/sitesolide/shop.env")).toEqual({ type: "info", message: "present  /etc/sitesolide/shop.env" });
  });

  test("a blank line only spaced the human output out", () => {
    expect(eventFor("")).toBeNull();
    expect(eventFor("   ")).toBeNull();
  });
});

describe("a stream read line by line", () => {
  test("chunks cut anywhere, inside a line or inside a character, give back the lines", async () => {
    const bytes = new TextEncoder().encode("first line\nsecond, Zürich\r\nlast without a break");
    const chunks = [bytes.slice(0, 3), bytes.slice(3, 21), bytes.slice(21)];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const lines: string[] = [];
    await forEachLine(stream, (line) => lines.push(line));
    // Data, not prose: the accented word proves a character split across
    // two chunks comes back whole.
    expect(lines).toEqual(["first line", "second, Zürich", "last without a break"]);
  });

  test("with a limit, a line too long is never held whole nor handed over, and reading resumes after it", async () => {
    const long = "x".repeat(50);
    const text = `short\n${long}\nafter\n${long}`;
    const bytes = new TextEncoder().encode(text);
    // In chunks of 7 bytes: the long line arrives in pieces, none of them ending it.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    const lines: string[] = [];
    let overflows = 0;
    await forEachLine(stream, (line) => lines.push(line), { length: 20, onOverflow: () => overflows++ });
    expect(lines).toEqual(["short", "after"]);
    expect(overflows).toBe(2);
  });
});

describe("the status table", () => {
  const format = formatOf("cli/output.ts", 'echo "=== projects served ==="');

  const text = [
    "=== projects served ===",
    printf(format, [
      ["PROJECT", "SIZE", "SERVICE", "MEMORY", "PEAK", "LIMIT"],
      ["blog", "1.2M", "-", "-", "-", "-"],
      ["shop", "48M", "active", "31MB", "40MB", "256MB"],
      ["lab", "", "active", "120MB", "300MB", "512MB"],
      ["  .api", "", "failed", "-", "12MB", "256MB"],
    ]).trimEnd(),
    "",
    "=== ports listening on loopback ===",
    "127.0.0.1:2019",
    "127.0.0.1:3040",
    "",
    "=== memory ===",
    "               total        used        free      shared  buff/cache   available",
    "Mem:            7941        1234        4000          12        2707        6500",
  ].join("\n");

  test("every project, with what its unit says, in megabytes", () => {
    const status = readStatus(text);
    expect(status.projects.map((project) => project.slug)).toEqual(["blog", "shop", "lab"]);
    expect(status.projects[0]).toEqual({ slug: "blog", size: "1.2M", service: null, memoryMB: null, peakMB: null, limitMB: null, services: [] });
    expect(status.projects[1]).toMatchObject({ slug: "shop", size: "48M", service: "active", memoryMB: 31, peakMB: 40, limitMB: 256 });
  });

  test("a size du could not measure leaves a column empty, and the row still reads", () => {
    expect(readStatus(text).projects[2]).toMatchObject({ slug: "lab", size: null, service: "active", memoryMB: 120, limitMB: 512 });
  });

  test("a project's other services hang under it", () => {
    expect(readStatus(text).projects[2]!.services).toEqual([
      { name: "api", unit: "lab.api", service: "failed", memoryMB: null, peakMB: 12, limitMB: 256 },
    ]);
  });

  test("the loopback ports and the machine's memory", () => {
    const status = readStatus(text);
    expect(status.ports).toEqual([2019, 3040]);
    expect(status.memory).toEqual({ total: 7941, used: 1234, free: 4000, shared: 12, "buff/cache": 2707, available: 6500 });
  });

  test("an empty answer, a read the server refused, reads as nothing rather than failing", () => {
    expect(readStatus("")).toEqual({ projects: [], ports: [], memory: null });
  });

  describe("scheduled services", () => {
    /** The line printed under a scheduled service's row, its format read from the source as the table's. */
    const scheduleFormat = /printf "(    schedule [^"]*)"/.exec(readFileSync(join(BIN, "cli", "output.ts"), "utf8"))?.[1];
    if (scheduleFormat === undefined) throw new Error("no schedule line in cli/output.ts");

    const scheduled = [
      "=== projects served ===",
      printf(format, [
        ["PROJECT", "SIZE", "SERVICE", "MEMORY", "PEAK", "LIMIT"],
        ["relay", "3.1M", "active", "40MB", "52MB", "256MB"],
        ["  .digest", "", "waiting", "-", "18MB", "256MB"],
      ]).trimEnd(),
      printf(scheduleFormat, [["*:0/15", "Mon 2026-10-12 14:15:00 UTC (success)", "Mon 2026-10-12 14:30:00 UTC"]]).trimEnd(),
      printf(format, [["  .queue", "", "active", "31MB", "35MB", "128MB"]]).trimEnd(),
      printf(format, [["nightly", "1.0M", "active", "-", "-", "-"], ["  .report", "", "failed", "-", "9MB", "256MB"]]).trimEnd(),
      printf(scheduleFormat, [["Mon..Fri 08:00", "Fri 2026-10-09 08:00:01 UTC (exit-code)", "none"]]).trimEnd(),
      printf(format, [["  .cleanup", "", "waiting", "-", "-", "256MB"]]).trimEnd(),
      printf(scheduleFormat, [["Sun 03:00", "never", "Sun 2026-10-18 03:00:00 UTC"]]).trimEnd(),
      "",
      "=== ports listening on loopback ===",
    ].join("\n");

    test("its schedule, its last run with how it ended, and its next, added to its row", () => {
      const [relay, nightly] = readStatus(scheduled).projects;
      expect(relay!.services).toEqual([
        {
          name: "digest",
          unit: "relay.digest",
          service: "waiting",
          memoryMB: null,
          peakMB: 18,
          limitMB: 256,
          schedule: "*:0/15",
          lastRun: "Mon 2026-10-12 14:15:00 UTC",
          lastResult: "success",
          nextRun: "Mon 2026-10-12 14:30:00 UTC",
        },
        { name: "queue", unit: "relay.queue", service: "active", memoryMB: 31, peakMB: 35, limitMB: 128 },
      ]);
      expect(nightly).toMatchObject({ slug: "nightly", service: "active", memoryMB: null });
      expect(nightly!.services[0]).toMatchObject({ service: "failed", schedule: "Mon..Fri 08:00", lastResult: "exit-code", nextRun: null });
      expect(nightly!.services[1]).toMatchObject({ service: "waiting", schedule: "Sun 03:00", lastRun: null, lastResult: null, nextRun: "Sun 2026-10-18 03:00:00 UTC" });
      // The schedule line is no project.
      expect(readStatus(scheduled).projects.map((project) => project.slug)).toEqual(["relay", "nightly"]);
    });

    test("the script, run against a systemctl that knows a worker and two scheduled services: idle is waiting, not down", () => {
      const root = mkdtempSync(join(tmpdir(), "sitesolide-status-"));
      try {
        const units = join(root, "units");
        for (const folder of [join(root, "sites", "relay"), join(root, "sites", "blog"), units, join(root, "bin")]) mkdirSync(folder, { recursive: true });
        for (const unit of ["relay.digest.service", "relay.queue.service", "relay.cleanup.service"]) writeFileSync(join(units, unit), "[Service]\n");
        writeFileSync(join(units, "relay.digest.timer"), "[Timer]\nOnCalendar=*:0/15\nPersistent=true\n");
        writeFileSync(join(units, "relay.cleanup.timer"), "[Timer]\nOnCalendar=Sun 03:00\n");
        const tool = (name: string, lines: string[]): void => writeFileSync(join(root, "bin", name), ["#!/bin/sh", ...lines, ""].join("\n"), { mode: 0o755 });
        // The digest's timer is armed, the cleanup's is not: nothing would run it.
        tool("systemctl", [
          'if [ "$1" = is-active ]; then',
          '  case "$2" in relay|relay.queue|relay.digest.timer) echo active; exit 0 ;; *) echo inactive; exit 3 ;; esac',
          "fi",
          'case "$2:$4" in',
          "  relay:LoadState|relay.queue:LoadState|relay.digest:LoadState|relay.cleanup:LoadState) echo loaded ;;",
          "  *:LoadState) echo not-found ;;",
          "  relay:MemoryCurrent) echo 41943040 ;;",
          '  *:MemoryCurrent|*:MemoryPeak) echo "[not set]" ;;',
          "  *:MemoryMax) echo 268435456 ;;",
          '  relay.digest:ExecMainStartTimestamp) echo "Mon 2026-10-12 14:15:00 UTC" ;;',
          '  relay.digest.timer:NextElapseUSecRealtime) echo "Mon 2026-10-12 14:30:00 UTC" ;;',
          "  relay.digest:Result) echo success ;;",
          "  relay.cleanup:ExecMainStartTimestamp) echo ;;",
          "  *) echo ;;",
          "esac",
        ]);
        tool("du", ['printf "1.0M\\t%s\\n" "$2"']);
        tool("ss", ['echo "LISTEN 0 512 127.0.0.1:3060 0.0.0.0:*"']);
        tool("free", ['echo "               total        used        free      shared  buff/cache   available"', 'echo "Mem:            7941        1234        4000          12        2707        6500"']);
        const script = STATUS_SCRIPT.replaceAll("/srv/sites", join(root, "sites")).replaceAll("/etc/systemd/system", units);
        const output = Bun.spawnSync(["sh", "-c", script], { env: { PATH: `${join(root, "bin")}:/usr/bin:/bin` } }).stdout.toString();
        const status = readStatus(output);
        expect(status.projects.map((project) => [project.slug, project.service])).toEqual([["blog", null], ["relay", "active"]]);
        const relay = status.projects[1]!;
        expect(relay.memoryMB).toBe(40);
        expect(relay.services).toEqual([
          { name: "cleanup", unit: "relay.cleanup", service: "inactive", memoryMB: null, peakMB: null, limitMB: 256, schedule: "Sun 03:00", lastRun: null, lastResult: null, nextRun: null },
          {
            name: "digest",
            unit: "relay.digest",
            service: "waiting",
            memoryMB: null,
            peakMB: null,
            limitMB: 256,
            schedule: "*:0/15",
            lastRun: "Mon 2026-10-12 14:15:00 UTC",
            lastResult: "success",
            nextRun: "Mon 2026-10-12 14:30:00 UTC",
          },
          { name: "queue", unit: "relay.queue", service: "active", memoryMB: null, peakMB: null, limitMB: 256 },
        ]);
        expect(status.ports).toEqual([3060]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("a row of any other line is not a schedule", () => {
      expect(readSchedule("shop                   48M      active     31MB     40MB     256MB")).toBeNull();
      expect(readSchedule("  .api                          failed     -        12MB     256MB")).toBeNull();
      expect(readSchedule("    schedule hourly; last run never; next run none")).toEqual({ schedule: "hourly", lastRun: null, lastResult: null, nextRun: null });
    });
  });
});

describe("what deploy says a project runs", () => {
  test("a project that only serves is named as it always was", () => {
    expect(describeRuns(false, { servers: 0, workers: 0, scheduled: 0 })).toBe("static");
    expect(describeRuns(true, { servers: 1, workers: 0, scheduled: 0 })).toBe("service");
    expect(describeRuns(true, { servers: 3, workers: 0, scheduled: 0 })).toBe("3 services");
  });

  test("workers and scheduled services are counted on their own", () => {
    expect(describeRuns(true, { servers: 2, workers: 1, scheduled: 1 })).toBe("2 services, 1 worker, 1 scheduled");
    expect(describeRuns(true, { servers: 1, workers: 2, scheduled: 0 })).toBe("1 service, 2 workers");
    expect(describeRuns(true, { servers: 0, workers: 1, scheduled: 3 })).toBe("1 worker, 3 scheduled");
    expect(describeRuns(true, { servers: 0, workers: 0, scheduled: 2 })).toBe("2 scheduled");
  });

  test("the counts, by kind", () => {
    expect(runsOf([{ kind: "server" }, { kind: "scheduled" }, { kind: "worker" }, { kind: "scheduled" }])).toEqual({ servers: 1, workers: 1, scheduled: 2 });
    expect(runsOf([])).toEqual({ servers: 0, workers: 0, scheduled: 0 });
  });
});

describe("the journal", () => {
  test("an entry of journalctl -o json, with its time, unit and priority", () => {
    const line = JSON.stringify({
      __CURSOR: "s=1",
      __REALTIME_TIMESTAMP: "1759600000123456",
      PRIORITY: "3",
      _SYSTEMD_UNIT: "shop.service",
      MESSAGE: "listening on 127.0.0.1:3040",
    });
    expect(readJournalEntry(line)).toEqual({
      type: "log",
      at: new Date(1759600000123).toISOString(),
      unit: "shop.service",
      priority: 3,
      message: "listening on 127.0.0.1:3040",
    });
  });

  test("a message that is not valid UTF-8 arrives as bytes, and is decoded", () => {
    const bytes = [...new TextEncoder().encode("abc"), 0xff];
    expect(readJournalEntry(JSON.stringify({ MESSAGE: bytes })).message).toBe("abc\ufffd");
  });

  test("a line that is not an entry is kept as the message, never dropped", () => {
    expect(readJournalEntry("-- No entries --")).toEqual({ type: "log", at: null, unit: null, priority: null, message: "-- No entries --" });
  });
});

describe("the lock table", () => {
  const format = formatOf("lock.sh", "state)");

  test("the project's row: wanted, installed, and what a visitor gets without and with the code", () => {
    const text = printf(format, [
      ["SITE", "WANTED", "INSTALLED", "NO CODE", "WITH CODE", "FINAL DOMAIN"],
      ["shop", "true", "yes", "401", "200", "shop.example (inactive)"],
    ]);
    expect(readLockState(text, "shop")).toEqual({ wanted: true, installed: true, withoutCode: 401, withCode: 200, domain: "shop.example (inactive)" });
  });

  test("an open preview with no domain", () => {
    const text = printf(format, [["blog", "false", "no", "200", "-", "-"]]);
    expect(readLockState(text, "blog")).toEqual({ wanted: false, installed: false, withoutCode: 200, withCode: null, domain: null });
  });

  test("a table without the project's row, a dry run's, reads as null", () => {
    expect(readLockState("", "shop")).toBeNull();
    expect(readLockState(printf(format, [["other", "false", "no", "200", "-", "-"]]), "shop")).toBeNull();
  });
});
