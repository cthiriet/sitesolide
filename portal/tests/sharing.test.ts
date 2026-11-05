import { describe, expect, test } from "bun:test";
import { IDENTITY_VARIABLES, cleanDomain, cleanEmail, domainOf, maySignIn, readList } from "../src/sharing";

const ADMINS = ["owner@acme.test"];

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

  test("its domain is what follows the @", () => {
    expect(domainOf("alice@sub.acme.test")).toBe("sub.acme.test");
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

describe("the sign-in settings", () => {
  test("a list reads commas, spaces and line breaks, and says what it dropped", () => {
    expect(readList("Owner@acme.test, second@acme.test\nnot-an-email", cleanEmail)).toEqual({
      values: ["owner@acme.test", "second@acme.test"],
      ignored: ["not-an-email"],
    });
    expect(readList("", cleanDomain)).toEqual({ values: [], ignored: [] });
  });

  test("allowed domains narrow who may sign in, the admins excepted", () => {
    expect(maySignIn("bob@acme.test", ["acme.test"], ADMINS)).toBe(true);
    expect(maySignIn("eve@elsewhere.test", ["acme.test"], ADMINS)).toBe(false);
    expect(maySignIn("owner@acme.test", ["other.test"], ADMINS)).toBe(true);
  });

  test("without allowed domains, anyone the provider vouches for may sign in", () => {
    expect(maySignIn("eve@elsewhere.test", [], ADMINS)).toBe(true);
  });

  test("the names the steward lets the dashboard write never include what would divert the portal", () => {
    for (const name of IDENTITY_VARIABLES) expect(name).toMatch(/^OIDC_[A-Z_]+$/);
    for (const forbidden of ["PORT", "DATA_DIR", "PUBLIC_URL", "PASSWORD_HASH", "NODE_ENV"]) {
      expect(IDENTITY_VARIABLES as readonly string[]).not.toContain(forbidden);
    }
  });
});
