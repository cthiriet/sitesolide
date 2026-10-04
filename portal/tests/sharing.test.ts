import { describe, expect, test } from "bun:test";
import {
  DEFAULT_POLICY,
  IDENTITY_VARIABLES,
  PEOPLE_MAX,
  cleanDomain,
  cleanEmail,
  domainOf,
  identityRole,
  maySignIn,
  readList,
  readPolicy,
  type Policy,
} from "../src/sharing";

const ADMINS = ["owner@acme.test"];

function policy(rest: Partial<Policy>): Policy {
  return { ...DEFAULT_POLICY, ...rest };
}

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

describe("reading a policy from the dashboard", () => {
  test("cleans, sorts and deduplicates both lists", () => {
    expect(
      readPolicy({ mode: "domain", people: ["Bob@acme.test", "alice@acme.test", "bob@ACME.test"], domains: ["@Acme.test"] }),
    ).toEqual({ policy: { mode: "domain", people: ["alice@acme.test", "bob@acme.test"], domains: ["acme.test"] } });
  });

  test("absent lists are empty ones", () => {
    expect(readPolicy({ mode: "admins" })).toEqual({ policy: DEFAULT_POLICY });
  });

  test("one bad entry refuses the whole change, rather than saving the rest", () => {
    expect(readPolicy({ mode: "people", people: ["alice@acme.test", "nobody"] })).toEqual({ error: "invalid-people" });
    expect(readPolicy({ mode: "domain", domains: ["acme.test", "com"] })).toEqual({ error: "invalid-domains" });
  });

  test("an unknown mode, public included, is refused: public is the portal turned off", () => {
    expect(readPolicy({ mode: "public" })).toEqual({ error: "invalid-mode" });
    expect(readPolicy({ mode: "everyone" })).toEqual({ error: "invalid-mode" });
    expect(readPolicy(null)).toEqual({ error: "invalid-policy" });
    expect(readPolicy([])).toEqual({ error: "invalid-policy" });
  });

  test("beyond the bound, a list is refused", () => {
    const many = Array.from({ length: PEOPLE_MAX + 1 }, (_, i) => `p${i}@acme.test`);
    expect(readPolicy({ mode: "people", people: many })).toEqual({ error: "invalid-people" });
    expect(readPolicy({ mode: "people", people: "alice@acme.test" })).toEqual({ error: "invalid-people" });
  });
});

describe("who a policy lets in", () => {
  test("admins: only the admin emails, as before sharing existed", () => {
    const only = policy({ mode: "admins", people: ["alice@acme.test"], domains: ["acme.test"] });
    expect(identityRole("owner@acme.test", only, ADMINS)).toBe("admin");
    expect(identityRole("alice@acme.test", only, ADMINS)).toBeNull();
    expect(identityRole("bob@acme.test", only, ADMINS)).toBeNull();
  });

  test("people: the listed emails as members, the admins as admins", () => {
    const listed = policy({ mode: "people", people: ["alice@acme.test"], domains: ["acme.test"] });
    expect(identityRole("alice@acme.test", listed, ADMINS)).toBe("member");
    expect(identityRole("bob@acme.test", listed, ADMINS)).toBeNull();
    expect(identityRole("owner@acme.test", listed, ADMINS)).toBe("admin");
  });

  test("domain: everyone at the domain, and the listed people from elsewhere", () => {
    const wide = policy({ mode: "domain", people: ["contractor@elsewhere.test"], domains: ["acme.test"] });
    expect(identityRole("bob@acme.test", wide, ADMINS)).toBe("member");
    expect(identityRole("contractor@elsewhere.test", wide, ADMINS)).toBe("member");
    expect(identityRole("eve@elsewhere.test", wide, ADMINS)).toBeNull();
  });

  test("a subdomain is not the domain, nor a domain that ends the same way", () => {
    const wide = policy({ mode: "domain", domains: ["acme.test"] });
    expect(identityRole("bob@sub.acme.test", wide, ADMINS)).toBeNull();
    expect(identityRole("bob@notacme.test", wide, ADMINS)).toBeNull();
  });

  test("the admins pass whatever the policy says, even with nobody listed", () => {
    for (const mode of ["admins", "people", "domain"] as const) {
      expect(identityRole("owner@acme.test", policy({ mode }), ADMINS)).toBe("admin");
    }
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
