import { describe, expect, test } from "bun:test";
import {
  EMPTY_PROJECTION,
  PROJECTION_VERSION,
  ROLES,
  atLeast,
  emailRole,
  encodeProjection,
  grantActor,
  grantExpiration,
  grantOpens,
  higher,
  isAccessId,
  isRole,
  passwordIndex,
  rank,
  readProjection,
  type Projection,
} from "../src/access";
import { grant, projection, site } from "./access-file";

const HOST = "kanban.test-zone.invalid";
const OTHER = "roster.test-zone.invalid";
const ADMINS = ["owner@acme.test"];
const NOW = 1_800_000_000_000;

/** A projection with every kind of piece in it, each well formed. */
const FULL: Projection = projection({
  [HOST]: site("kanban", {
    people: { "alice@acme.test": "developer", "zoe@elsewhere.test": "visitor" },
    domains: ["acme.test"],
    passwords: [grant(), grant({ id: "PaSsWoRdAcCeSs02", who: "Bob from the agency", hash: "b".repeat(64), expiresAt: NOW + 3_600_000 })],
  }),
  [OTHER]: site("roster", { people: { "carol@acme.test": "admin" } }),
});

/** FULL as JSON, with one piece of the kanban site replaced. */
function withSite(change: Record<string, unknown>): string {
  const object = JSON.parse(encodeProjection(FULL));
  object.sites[HOST] = { ...object.sites[HOST], ...change };
  return JSON.stringify(object);
}

function withGrant(change: Record<string, unknown>): string {
  return withSite({ passwords: [{ ...grant(), ...change }] });
}

function refused(text: string): void {
  const read = readProjection(text);
  expect({ text: text.slice(0, 200), unreadable: "unreadable" in read }).toEqual({ text: text.slice(0, 200), unreadable: true });
}

describe("the ladder of roles", () => {
  test("goes from visitor to admin, each rung above the last", () => {
    expect(ROLES).toEqual(["visitor", "viewer", "developer", "admin"]);
    expect(ROLES.map(rank)).toEqual([0, 1, 2, 3]);
  });

  test("a role reaches the rungs below it, never those above, and no role reaches anything", () => {
    expect(atLeast("developer", "viewer")).toBe(true);
    expect(atLeast("developer", "developer")).toBe(true);
    expect(atLeast("viewer", "developer")).toBe(false);
    expect(atLeast(null, "visitor")).toBe(false);
  });

  test("the higher of two roles, either one possibly missing", () => {
    expect(higher("visitor", "viewer")).toBe("viewer");
    expect(higher("admin", "visitor")).toBe("admin");
    expect(higher(null, "visitor")).toBe("visitor");
    expect(higher("developer", null)).toBe("developer");
    expect(higher(null, null)).toBeNull();
  });

  test("only the four rungs are roles: the words of before are not", () => {
    for (const role of ROLES) expect(isRole(role)).toBe(true);
    for (const word of ["member", "guest", "owner", "Admin", "", null, 3]) expect(isRole(word)).toBe(false);
  });
});

test("an access identifier is 16 base64url characters, nothing else", () => {
  expect(isAccessId("PaSsWoRdAcCeSs_-")).toBe(true);
  for (const id of ["", "PaSsWoRdAcCeSs0", "PaSsWoRdAcCeSs011", "PaSsWoRdAcCeSs+/", null, 16]) expect(isAccessId(id)).toBe(false);
});

describe("reading the steward's projection", () => {
  test("a well formed projection reads back as it was written", () => {
    const text = encodeProjection(FULL);
    expect(text.endsWith("}\n")).toBe(true);
    expect(readProjection(text)).toEqual(FULL);
  });

  test("a projection with no site is nobody, and reads", () => {
    expect(readProjection(encodeProjection(EMPTY_PROJECTION))).toEqual(EMPTY_PROJECTION);
  });

  test("what is not JSON, or not a projection at all, is unreadable", () => {
    for (const text of ["", "{", "null", "[]", "42", '"access"', "{}"]) refused(text);
    expect(readProjection("{")).toEqual({ unreadable: "access.json is not JSON" });
  });

  test("another version is not guessed at", () => {
    for (const version of [0, 2, "1", null]) refused(JSON.stringify({ ...FULL, version }));
    const { version: _, ...unversioned } = FULL;
    refused(JSON.stringify(unversioned));
    expect(PROJECTION_VERSION).toBe(1);
  });

  test("its date must be a date", () => {
    for (const writtenAt of [-1, "1800000000000", null]) refused(JSON.stringify({ ...FULL, writtenAt }));
    refused(JSON.stringify({ version: 1, sites: {} }));
  });

  test("its sites must be an object by host", () => {
    for (const sites of [null, [], "sites", 1]) refused(JSON.stringify({ ...FULL, sites }));
  });

  test("a host that is not one refuses the whole file, rather than reading the rest", () => {
    const good = JSON.parse(encodeProjection(FULL));
    for (const host of ["Kanban.test-zone.invalid", "kanban.test-zone.invalid:443", "a b.test", "-kanban.test", "kanban..test", "kanban.test.", "", "__proto__", `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`]) {
      refused(JSON.stringify({ ...good, sites: { ...good.sites, [host]: good.sites[HOST] } }));
    }
    const read = readProjection(JSON.stringify({ ...good, sites: { ...good.sites, "a b": good.sites[HOST] } }));
    expect(read).toEqual({ unreadable: 'access.json: the site "a b" does not have the expected shape' });
  });

  test("a site with a missing or misshapen part is refused", () => {
    for (const change of [{ slug: undefined }, { slug: "" }, { slug: "Kanban" }, { slug: "-kanban" }, { slug: "k".repeat(64) }, { people: undefined }, { people: [] }, { domains: undefined }, { domains: "acme.test" }, { passwords: undefined }, { passwords: {} }]) {
      refused(withSite(change));
    }
    refused(JSON.stringify({ ...JSON.parse(encodeProjection(FULL)), sites: { [HOST]: null } }));
  });

  test("a person is a clean email with one of the four roles", () => {
    // As JSON, so that `__proto__` is a key of its own, as JSON.parse makes it,
    // and not the prototype an object literal would set.
    for (const people of [
      '{"Alice@acme.test":"viewer"}',
      '{" alice@acme.test":"viewer"}',
      '{"alice":"viewer"}',
      '{"@acme.test":"visitor"}',
      '{"__proto__":"admin"}',
      '{"alice@acme.test":"member"}',
      '{"alice@acme.test":"guest"}',
      '{"alice@acme.test":"owner"}',
      '{"alice@acme.test":null}',
    ]) {
      const text = withSite({ people: JSON.parse(people) });
      expect(text).toInclude(people.slice(1, -1));
      refused(text);
    }
  });

  test("a domain is a bare clean domain: it carries no role, and one written with a role is refused", () => {
    for (const domains of [["@acme.test"], ["Acme.test"], ["test"], ["*.acme.test"], [42], [{ domain: "acme.test", role: "viewer" }], [["acme.test", "visitor"]]]) {
      refused(withSite({ domains }));
    }
  });

  test("a password access carries an identifier, who it was given to, a SHA-256 and an expiry", () => {
    for (const change of [
      { id: "short" },
      { id: "PaSsWoRdAcCeSs+/" },
      { id: undefined },
      { who: "" },
      { who: "Alice\nX-Injected: yes" },
      { who: "Zoë" },
      { who: "a".repeat(121) },
      { who: 42 },
      { hash: "A".repeat(64) },
      { hash: "a".repeat(63) },
      { hash: "g".repeat(64) },
      { hash: undefined },
      { expiresAt: -1 },
      { expiresAt: "never" },
      { expiresAt: undefined },
    ]) {
      refused(withGrant(change));
    }
    refused(withSite({ passwords: [null] }));
    refused(withSite({ passwords: ["a".repeat(64)] }));
  });

  test("an access given under a name, before the registry, is kept as such", () => {
    const read = readProjection(withGrant({ who: "Bob, from the agency (2025)" }));
    expect("unreadable" in read).toBe(false);
    expect((read as Projection).sites[HOST]!.passwords[0]!.who).toBe("Bob, from the agency (2025)");
  });
});

describe("the role an email holds on a site", () => {
  const kanban = FULL.sites[HOST]!;

  test("an admin email is admin everywhere, a site never listed included", () => {
    expect(emailRole(kanban, "owner@acme.test", ADMINS)).toBe("admin");
    expect(emailRole(undefined, "owner@acme.test", ADMINS)).toBe("admin");
    expect(emailRole(site("kanban", { people: { "owner@acme.test": "visitor" } }), "owner@acme.test", ADMINS)).toBe("admin");
  });

  test("a person listed holds their own entry's role", () => {
    expect(emailRole(FULL.sites[OTHER], "carol@acme.test", ADMINS)).toBe("admin");
    expect(emailRole(kanban, "zoe@elsewhere.test", ADMINS)).toBe("visitor");
  });

  test("everyone at a listed domain opens the site as visitor", () => {
    expect(emailRole(kanban, "bob@acme.test", ADMINS)).toBe("visitor");
    expect(emailRole(site("kanban", { domains: ["acme.test"] }), "bob@acme.test", [])).toBe("visitor");
  });

  test("a person both listed and at a listed domain holds the higher of the two", () => {
    expect(emailRole(kanban, "alice@acme.test", ADMINS)).toBe("developer");
    expect(emailRole(site("kanban", { people: { "bob@acme.test": "viewer" }, domains: ["acme.test"] }), "bob@acme.test", [])).toBe("viewer");
  });

  test("anyone else, or any site the projection does not know, opens nothing", () => {
    expect(emailRole(kanban, "eve@elsewhere.test", ADMINS)).toBeNull();
    expect(emailRole(kanban, "bob@sub.acme.test", ADMINS)).toBeNull();
    expect(emailRole(kanban, "bob@notacme.test", ADMINS)).toBeNull();
    expect(emailRole(FULL.sites[OTHER], "alice@acme.test", ADMINS)).toBeNull();
    expect(emailRole(undefined, "alice@acme.test", ADMINS)).toBeNull();
  });

  test("a name the object inherits is nobody's entry", () => {
    expect(emailRole(site("kanban"), "constructor", [])).toBeNull();
    expect(emailRole(site("kanban"), "__proto__", [])).toBeNull();
  });
});

describe("a password access", () => {
  test("opens until its expiry, and not from then on", () => {
    const lapsing = grant({ expiresAt: NOW + 1000 });
    expect(grantOpens(lapsing, NOW + 999)).toBe(true);
    expect(grantOpens(lapsing, NOW + 1000)).toBe(false);
  });

  test("with no expiry, until it is removed", () => {
    expect(grantOpens(grant(), NOW + 10 * 365 * 24 * 3600 * 1000)).toBe(true);
    expect(grantOpens(null, NOW)).toBe(false);
    expect(grantOpens(undefined, NOW)).toBe(false);
  });

  test("is found by its hash, with the host it opens", () => {
    const index = passwordIndex(FULL);
    expect(index.size).toBe(2);
    expect(index.get("a".repeat(64))).toEqual({ host: HOST, grant: grant() });
    expect(index.get("b".repeat(64))?.grant.id).toBe("PaSsWoRdAcCeSs02");
    expect(index.get("c".repeat(64))).toBeUndefined();
    expect(passwordIndex(EMPTY_PROJECTION).size).toBe(0);
  });

  test("its cookie lasts as any cookie, never beyond the access", () => {
    const nowS = NOW / 1000;
    const durationS = 30 * 24 * 3600;
    expect(grantExpiration(grant(), nowS, durationS)).toBe(nowS + durationS);
    expect(grantExpiration(grant({ expiresAt: NOW + 60 * 24 * 3600 * 1000 }), nowS, durationS)).toBe(nowS + durationS);
    expect(grantExpiration(grant({ expiresAt: NOW + 24 * 3600 * 1000 }), nowS, durationS)).toBe(nowS + 24 * 3600);
    // Cut to the second below: the cookie never outlives the access by a fraction.
    expect(grantExpiration(grant({ expiresAt: NOW + 1999 }), nowS, durationS)).toBe(nowS + 1);
  });

  test("signs in under the email it was given to, or under its identifier", () => {
    expect(grantActor(grant({ who: "alice@elsewhere.test" }))).toBe("alice@elsewhere.test");
    expect(grantActor(grant({ who: "Bob from the agency" }))).toBe("password:PaSsWoRdAcCeSs01");
    // Not quite an email: never recorded as one.
    expect(grantActor(grant({ who: "Alice@elsewhere.test" }))).toBe("password:PaSsWoRdAcCeSs01");
    expect(grantActor(grant({ who: "alice@elsewhere" }))).toBe("password:PaSsWoRdAcCeSs01");
  });
});
