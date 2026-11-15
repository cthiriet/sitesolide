import { describe, expect, test } from "bun:test";
import { cleanDomain, cleanEmail } from "../src/email";

describe("an email", () => {
  test("is kept in lowercase, edges trimmed", () => {
    expect(cleanEmail("  Alice.Martin@Acme.TEST ")).toBe("alice.martin@acme.test");
    expect(cleanEmail("a+tag@sub.acme.test")).toBe("a+tag@sub.acme.test");
  });

  test("refuses what would make two strings look like the same person", () => {
    for (const bad of [
      "alice",
      "@acme.test",
      "alice@",
      "alice@acme",
      "alice@@acme.test",
      "al ice@acme.test",
      '"alice"@acme.test',
      "alice@acme.test,bob@acme.test",
      "alice\n@acme.test",
      ".alice@acme.test",
      "al..ice@acme.test",
      "alice@-acme.test",
      "alice@acme..test",
      `${"a".repeat(65)}@acme.test`,
      `a@${"b".repeat(250)}.test`,
    ]) {
      expect({ bad, clean: cleanEmail(bad) }).toEqual({ bad, clean: null });
    }
    expect(cleanEmail(42)).toBeNull();
    expect(cleanEmail(undefined)).toBeNull();
  });

  test("an accented address is refused: the comparison has to be exact, and a lookalike is not", () => {
    expect(cleanEmail("zoë@acme.test")).toBeNull();
    expect(cleanEmail("alice@acmé.test")).toBeNull();
  });

  test("nothing outside ASCII reaches the lowercasing, where it would become another person's address", () => {
    // The Kelvin sign lowercases to the letter k, and trim() takes off a
    // no-break space: judged after them, both collapsed onto kim@acme.test.
    expect("Kim@acme.test".toLowerCase()).toBe("kim@acme.test");
    expect(cleanEmail("Kim@acme.test")).toBeNull();
    expect(cleanEmail("kim@acme.Kim")).toBeNull();
    expect(cleanEmail(" kim@acme.test ")).toBeNull();
    expect(cleanEmail(" kim@acme.test")).toBeNull();
    expect(cleanEmail("\tkim@acme.test")).toBeNull();
    expect(cleanDomain("acme.Kim")).toBeNull();
    expect(cleanDomain(" acme.test")).toBeNull();
  });
});

describe("a domain", () => {
  test("takes at least two labels, in lowercase, forgiving a leading @", () => {
    expect(cleanDomain("Acme.TEST")).toBe("acme.test");
    expect(cleanDomain("@acme.test")).toBe("acme.test");
    expect(cleanDomain("test")).toBeNull();
    expect(cleanDomain("*.acme.test")).toBeNull();
    expect(cleanDomain("acme.test/")).toBeNull();
    expect(cleanDomain("")).toBeNull();
  });
});
