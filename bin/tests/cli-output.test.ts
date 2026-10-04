import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  eventFor,
  forEachLine,
  formatEvent,
  readJournalEntry,
  readLockState,
  readStatus,
  type OutputEvent,
} from "../cli/output";

/**
 * What `--json` prints, and the readings that turn the machine's tables into
 * data. The tables are produced here by `printf` with the very format strings
 * bin/sitesolide.ts and bin/lock.sh use, read from their source: a column
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
  const format = formatOf("sitesolide.ts", 'echo "=== projects served ==="');

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
