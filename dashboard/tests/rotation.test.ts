import { describe, expect, test } from "bun:test";
import { DATA_DIR } from "../src/config";
import { applyRotation, closeSession, readSession, openSession } from "../src/database";
import { isRotationDetected } from "../src/sessions";

// The redirection from tests/setup.ts, checked rather than assumed: this test
// opens the service's real database, and without it would close real sessions.
test("DATA_DIR is redirected to the test directory", () => {
  expect(DATA_DIR).toContain(".test-data");
});

describe("decision", () => {
  test("an unchanged hash closes nothing", () => {
    expect(isRotationDetected("abc", "abc")).toBe(false);
  });

  test("a different hash closes the sessions", () => {
    expect(isRotationDetected("abc", "def")).toBe(true);
  });

  test("on first startup there is nothing to purge", () => {
    expect(isRotationDetected(null, "abc")).toBe(false);
  });

  /**
   * An empty hash is not a new password, it is a secret that never
   * arrived. Purging would make the user pay for a configuration failure, when
   * nobody can get in any more anyway.
   */
  test("a missing secret does not pass for a rotation", () => {
    expect(isRotationDetected("abc", "")).toBe(false);
    expect(isRotationDetected(null, "")).toBe(false);
  });
});

describe("applied to the database", () => {
  const PREMIER = "$argon2id$the-first";
  const SECOND = "$argon2id$the-second";

  test("a changed password closes the sessions opened under the old one", async () => {
    await applyRotation(PREMIER);
    const token = await openSession(1000);
    expect(await readSession(token)).not.toBeNull();

    // A restart with no change must close nothing.
    expect(await applyRotation(PREMIER)).toBe(0);
    expect(await readSession(token)).not.toBeNull();

    expect(await applyRotation(SECOND)).toBe(1);
    expect(await readSession(token)).toBeNull();
  });

  test("a missing secret leaves the sessions in place", async () => {
    await applyRotation(SECOND);
    const token = await openSession(1000);
    expect(await applyRotation("")).toBe(0);
    expect(await readSession(token)).not.toBeNull();
    closeSession((await readSession(token))!.hash);
  });
});
