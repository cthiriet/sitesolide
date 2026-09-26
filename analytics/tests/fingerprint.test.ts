import { describe, expect, test } from "bun:test";
import {
  clientAddress,
  computeFingerprint,
  generateSalt,
  FINGERPRINT_LENGTH,
  SALT_BYTES,
} from "../src/fingerprint";

/**
 * This file guards what stands in for the cookie, and so what stands as the
 * promise to the visitors of measured sites. Every test here names the property
 * it protects, because none of them shows when reading the calculation.
 */
describe("computeFingerprint", () => {
  const salt = "salt-of-the-day";
  const agent = "Mozilla/5.0 (iPhone)";

  test("returns the same fingerprint for the same visitor, the same day", () => {
    // Otherwise nothing would be countable: two pages viewed would be two
    // visitors.
    expect(computeFingerprint(salt, "vineyard.test", "203.0.113.9", agent)).toBe(
      computeFingerprint(salt, "vineyard.test", "203.0.113.9", agent),
    );
  });

  test("changes from one site to another, for the same visitor", () => {
    // It is what separates this measurement from an ad network: the same
    // browser is not recognisable from one customer to another.
    expect(computeFingerprint(salt, "vineyard.test", "203.0.113.9", agent)).not.toBe(
      computeFingerprint(salt, "pottery.test", "203.0.113.9", agent),
    );
  });

  test("changes when the salt changes, so from one day to the next", () => {
    // It is what prevents following someone over time, and what makes
    // yesterday's fingerprints unusable once the salt is destroyed.
    expect(computeFingerprint("salt-of-yesterday", "vineyard.test", "203.0.113.9", agent)).not.toBe(
      computeFingerprint(salt, "vineyard.test", "203.0.113.9", agent),
    );
  });

  test("tells apart two visitors nothing would separate without a separator", () => {
    // Without the vertical bar, "vineyard.test" + "1.2.3" + "4|x" and "vineyard.test" +
    // "1.2.34" + "|x" would compose the same string.
    expect(computeFingerprint(salt, "vineyard.test", "1.2.3", "4|x")).not.toBe(
      computeFingerprint(salt, "vineyard.test", "1.2.34", "|x"),
    );
  });

  test("returns a hexadecimal fingerprint of fixed length", () => {
    const fingerprint = computeFingerprint(salt, "vineyard.test", "203.0.113.9", agent);
    expect(fingerprint).toHaveLength(FINGERPRINT_LENGTH);
    expect(fingerprint).toMatch(/^[0-9a-f]+$/);
  });
});

describe("generateSalt", () => {
  test("draws a different salt every time", () => {
    expect(generateSalt()).not.toBe(generateSalt());
  });

  test("refuses a randomness source that is too short", () => {
    // A salt shortened by a failing source would make the fingerprints
    // guessable, silently.
    expect(() => generateSalt(() => new Uint8Array(SALT_BYTES - 1))).toThrow();
  });

  test("uses URL characters only", () => {
    expect(generateSalt()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("clientAddress", () => {
  test("reads the last value, the one Caddy placed", () => {
    // A visitor who sends X-Forwarded-For: 192.0.2.1 has Caddy pass on
    // "192.0.2.1, <their real address>". Reading the first one means reading what
    // they wrote, and letting them take someone else's fingerprint.
    expect(clientAddress("192.0.2.1, 203.0.113.9", "fallback")).toBe("203.0.113.9");
  });

  test("holds a list of a single element, the ordinary case", () => {
    expect(clientAddress("203.0.113.9", "fallback")).toBe("203.0.113.9");
  });

  test("falls back on the peer's address when the header is missing", () => {
    expect(clientAddress(null, "127.0.0.1")).toBe("127.0.0.1");
    expect(clientAddress("", "127.0.0.1")).toBe("127.0.0.1");
    expect(clientAddress("  ,  ", "127.0.0.1")).toBe("127.0.0.1");
  });
});
