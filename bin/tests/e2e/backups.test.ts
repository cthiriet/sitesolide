import { afterAll, describe, expect, test } from "bun:test";
import { snapshotName } from "../../cli/backups";
import { createFakeVm } from "./fake-vm";
import { run } from "./run";

/**
 * `sitesolide backups`, the real CLI against the simulated machine. The fake
 * ssh answers nothing it does not know: here it accepts the command, logs it,
 * and prints what the component would, so that the test reads exactly what was
 * sent and nothing else could be.
 */
const vms: ReturnType<typeof createFakeVm>[] = [];
afterAll(() => {
  for (const vm of vms) vm.cleanup();
});

const AT = Date.UTC(2026, 9, 4, 13, 0, 0);
const LIST = "sudo /usr/local/bin/bun /usr/local/lib/sitesolide/backup.js list sample-bun";

describe("sitesolide backups", () => {
  test("lists the project's snapshots with one read-only command", async () => {
    const vm = createFakeVm();
    vms.push(vm);
    vm.acceptWrites();
    vm.answer(
      LIST,
      JSON.stringify({
        folder: "sample-bun",
        snapshots: [{ name: snapshotName("sample-bun", AT, "scheduled"), takenAt: AT, kind: "scheduled", bytes: 4096, local: true, offsite: true }],
        lastRun: { startedAt: "2026-10-04T13:00:01.000Z", finishedAt: "2026-10-04T13:00:04.000Z", ok: true, snapshot: snapshotName("sample-bun", AT, "scheduled"), error: null },
      }),
    );
    const result = await run("projects/bun-mixed", ["backups"], { vm });
    expect(result.code).toBe(0);
    expect(result.output).toContain("=== backups of sample-bun ===");
    expect(result.output).toContain("2026-10-04 13:00 UTC  scheduled     4.0 KB    server, offsite");
    expect(result.output).toContain("last run: 2026-10-04 13:00 UTC, ok");
    expect(result.output).toContain("restore from the Backups section of https://dashboard.test-zone.invalid");
    // One command, the listing, and nothing else: no write, no rsync.
    const sent = vm.logs().filter((line) => line !== "");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(LIST);
  });

  test("says when the component is not installed, and exits in error", async () => {
    const vm = createFakeVm();
    vms.push(vm);
    vm.acceptWrites();
    vm.answer(LIST, "NOT-INSTALLED\n");
    const result = await run("projects/bun-mixed", ["backups"], { vm });
    expect(result.code).toBe(1);
    expect(result.error).toContain("backups are not installed on the server");
  });

  test("an answer it cannot read is said so, never taken for an empty list", async () => {
    const vm = createFakeVm();
    vms.push(vm);
    const result = await run("projects/bun-mixed", ["backups"], { vm });
    expect(result.code).toBe(1);
    expect(result.error).toContain("could not be read");
    expect(result.output).not.toContain("no snapshot yet");
  });
});
