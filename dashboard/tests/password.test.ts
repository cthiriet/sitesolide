import { describe, expect, test } from "bun:test";
import {
  ALPHABET,
  GROUPS,
  GROUP_LENGTH,
  SEPARATOR,
  entropyBits,
  generatePassword,
} from "../src/password";

/** A source that returns exactly the bytes wanted, to replay a draw. */
function source(bytes: number[]): (wanted: number) => Uint8Array {
  return (wanted) => Uint8Array.from(bytes.slice(0, wanted));
}

describe("alphabet", () => {
  test("no character can be confused with another", () => {
    for (const character of "IlOo01") {
      expect(ALPHABET).not.toContain(character);
    }
  });

  test("no character appears in it twice", () => {
    expect(new Set(ALPHABET).size).toBe(ALPHABET.length);
  });
});

describe("the draw", () => {
  test("the shape is the one announced, dashes included", () => {
    const password = generatePassword();
    const groups = password.split(SEPARATOR);
    expect(groups).toHaveLength(GROUPS);
    for (const group of groups) {
      expect(group).toHaveLength(GROUP_LENGTH);
      for (const character of group) expect(ALPHABET).toContain(character);
    }
  });

  test("two draws differ", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });

  test("a fixed byte sequence yields an exact password", () => {
    const bytes = Array.from({ length: 32 }, (_, rank) => rank);
    expect(generatePassword(source(bytes))).toBe("ABCD-EFGH-JKLM-NPQR-STUV-WXYZ");
  });

  /**
   * 56 does not divide 256: a modulo would make the first characters come up
   * more often than the last. Bytes beyond 224 are therefore discarded, and
   * this test proves it by forcing bytes that a modulo would have accepted,
   * returning "h".
   */
  test("bytes past the last whole multiple are discarded", () => {
    const bytes = [...Array<number>(8).fill(255), ...Array.from({ length: 24 }, (_, rank) => rank)];
    expect(generatePassword(source(bytes))).toBe("ABCD-EFGH-JKLM-NPQR-STUV-WXYZ");
  });

  test("a source that is too short throws rather than yield a weak password", () => {
    expect(() => generatePassword(source([1, 2, 3]))).toThrow(/too short/);
  });

  test("a source yielding only rejected bytes throws instead of looping", () => {
    expect(() => generatePassword(() => new Uint8Array(64).fill(255))).toThrow(/discarded/);
  });

  test("the password is worth more than a hundred bits", () => {
    expect(entropyBits()).toBeGreaterThan(100);
  });
});

describe("a shorter draw, for the portal's guests", () => {
  test("four groups of four, same alphabet", () => {
    const bytes = Array.from({ length: 24 }, (_, rank) => rank);
    expect(generatePassword(source(bytes), 4)).toBe("ABCD-EFGH-JKLM-NPQR");
    expect(generatePassword(undefined, 4).split(SEPARATOR)).toHaveLength(4);
  });

  test("still worth more than ninety bits", () => {
    expect(entropyBits(4)).toBeGreaterThan(90);
  });

  test("below four groups, the draw is refused", () => {
    for (const groups of [0, 1, 3, 4.5, Number.NaN]) {
      expect(() => generatePassword(undefined, groups)).toThrow(/group count/);
    }
  });
});
