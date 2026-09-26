import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GUEST_DURATION_S,
  GUEST_DURATIONS,
  isValidDuration,
  guestExpiration,
  isValidId,
  guestOpens,
  LABEL_MAX,
  cleanLabel,
  type Guest,
} from "../src/guests";

const HOST = "forum.test-zone.invalid";
const NOW = 1_800_000_000_000;

function guest(rest: Partial<Guest> = {}): Guest {
  return { id: "AbCdEfGhIjKlMn_-", host: HOST, label: "Alice", createdAt: NOW, expiresAt: null, seenAt: null, ...rest };
}

describe("the duration", () => {
  test("only the offered durations get through, no deadline included", () => {
    for (const choice of GUEST_DURATIONS) expect(isValidDuration(choice.seconds)).toBe(true);
    expect(GUEST_DURATIONS.some((choice) => choice.seconds === DEFAULT_GUEST_DURATION_S)).toBe(true);
  });

  test("an absent duration is not \"no deadline\"", () => {
    for (const duration of [undefined, 0, 1, -86400, 3600, "604800", Number.NaN, {}]) {
      expect(isValidDuration(duration)).toBe(false);
    }
  });
});

describe("the label", () => {
  test("cleaned of its edge spaces", () => {
    expect(cleanLabel("  Alice, accountant  ")).toBe("Alice, accountant");
    expect(cleanLabel("é".repeat(LABEL_MAX))).toBe("é".repeat(LABEL_MAX));
  });

  test("refused empty, too long, or carrying a control character", () => {
    for (const label of ["", "   ", "a".repeat(LABEL_MAX + 1), "a\nb", "a\x00", "a\x7f", null, 42]) {
      expect(cleanLabel(label)).toBeNull();
    }
  });
});

test("the identifier: 16 base64url characters, nothing else", () => {
  expect(isValidId("AbCdEfGhIjKlMn_-")).toBe(true);
  for (const id of ["", "AbCdEfGhIjKlMn_", "AbCdEfGhIjKlMn_-x", "AbCdEfGhIjKlMn+/", "AbCd.fGhIjKlMn_-", null]) {
    expect(isValidId(id)).toBe(false);
  }
});

describe("what an access opens", () => {
  test("its host, and it alone", () => {
    expect(guestOpens(guest(), HOST, NOW)).toBe(true);
    expect(guestOpens(guest(), "cms.test-zone.invalid", NOW)).toBe(false);
  });

  test("a deleted access opens nothing", () => {
    expect(guestOpens(null, HOST, NOW)).toBe(false);
  });

  test("up to its deadline, not beyond", () => {
    const expired = guest({ expiresAt: NOW + 1000 });
    expect(guestOpens(expired, HOST, NOW + 999)).toBe(true);
    expect(guestOpens(expired, HOST, NOW + 1000)).toBe(false);
  });

  test("with no deadline, as long as it is not revoked", () => {
    expect(guestOpens(guest(), HOST, NOW + 10 * 365 * 24 * 3600 * 1000)).toBe(true);
  });
});

describe("the expiration of a guest cookie", () => {
  const nowS = NOW / 1000;
  const durationS = 30 * 24 * 3600;

  test("that of any cookie when the access lasts longer, or forever", () => {
    expect(guestExpiration(guest(), nowS, durationS)).toBe(nowS + durationS);
    expect(guestExpiration(guest({ expiresAt: NOW + 60 * 24 * 3600 * 1000 }), nowS, durationS)).toBe(
      nowS + durationS,
    );
  });

  test("never beyond the deadline of the access", () => {
    expect(guestExpiration(guest({ expiresAt: NOW + 24 * 3600 * 1000 }), nowS, durationS)).toBe(
      nowS + 24 * 3600,
    );
  });
});
