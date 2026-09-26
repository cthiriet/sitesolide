import { describe, expect, test } from "bun:test";
import { STALE_AFTER_MS, type Raw } from "../src/state";
import { analyse } from "../src/read";

const NOW = 1_756_400_000_000;

function rawJson(remaining: Partial<Raw> = {}): string {
  return JSON.stringify({
    generated: NOW,
    zone: "test-zone.invalid",
    folders: [],
    codes: "{}",
    domains: null,
    ports: [],
    blocks: {},
    machine: null,
    previous: null,
    ...remaining,
  });
}

describe("snapshot analysis", () => {
  test("a missing file says what to run", () => {
    const reading = analyse(null, NOW);
    expect(reading.present).toBe(false);
    if (!reading.present) expect(reading.reason).toContain("deploy-collector.sh");
  });

  test("a truncated file says so instead of throwing", () => {
    const reading = analyse('{"folders": [', NOW);
    expect(reading.present).toBe(false);
  });

  test("valid JSON with no reading is refused", () => {
    expect(analyse('{"generated": 1}', NOW).present).toBe(false);
  });

  test("a fresh snapshot is not stale", () => {
    const reading = analyse(rawJson(), NOW + 1000);
    expect(reading.present).toBe(true);
    if (reading.present) {
      expect(reading.age).toBe(1000);
      expect(reading.stale).toBe(false);
    }
  });

  test("past expiry, the dashboard says so rather than lying", () => {
    const reading = analyse(rawJson(), NOW + STALE_AFTER_MS + 1);
    expect(reading.present).toBe(true);
    if (reading.present) expect(reading.stale).toBe(true);
  });
});
