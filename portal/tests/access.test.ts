import { describe, expect, test } from "bun:test";
import {
  EMPTY_PROJECTION,
  PROJECTION_VERSION,
  encodeProjection,
  grantActor,
  grantExpiration,
  grantOpens,
  isAccessId,
  passwordIndex,
  readProjection,
  WHO_MAX,
  type Projection,
} from "../src/access";
import { grant, projection, site } from "./access-file";

const HOST = "kanban.test-zone.invalid";
const OTHER = "roster.test-zone.invalid";
const NOW = 1_800_000_000_000;

/** A projection with every kind of piece in it, each well formed. */
const FULL: Projection = projection({
  [HOST]: site("kanban", {
    passwords: [grant(), grant({ id: "PaSsWoRdAcCeSs02", who: "Bob from the agency", hash: "b".repeat(64), expiresAt: NOW + 3_600_000 })],
  }),
  [OTHER]: site("roster"),
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

  test("each site carries an empty people and domains, which a portal of before requires", () => {
    const object = JSON.parse(encodeProjection(FULL));
    for (const site of Object.values(object.sites) as Record<string, unknown>[]) {
      expect(site.people).toEqual({});
      expect(site.domains).toEqual([]);
    }
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

  test("the people and domains a projection of before carries are ignored, whatever their shape", () => {
    const read = readProjection(withSite({ people: { "alice@acme.test": "developer", junk: 3 }, domains: ["acme.test", 42] }));
    expect(read).toEqual(FULL);
  });

  test("a site with a missing or misshapen part is refused", () => {
    for (const change of [{ slug: undefined }, { slug: "" }, { slug: "Kanban" }, { slug: "-kanban" }, { slug: "k".repeat(64) }, { passwords: undefined }, { passwords: {} }]) {
      refused(withSite(change));
    }
    refused(JSON.stringify({ ...JSON.parse(encodeProjection(FULL)), sites: { [HOST]: null } }));
  });

  test("a password access carries an identifier, who it was given to, a SHA-256 and an expiry", () => {
    for (const change of [
      { id: "short" },
      { id: "PaSsWoRdAcCeSs+/" },
      { id: undefined },
      { who: "" },
      { who: "Alice\nX-Injected: yes" },
      { who: "Zoë" },
      { who: "a".repeat(255) },
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

  test("who it was given to is bounded by an email's own length, 254 characters, the steward's bound too", () => {
    const longest = `${"a".repeat(64)}@${"b".repeat(60)}.${"c".repeat(63)}.${"d".repeat(63)}`.slice(0, 254);
    for (const who of [`${"a".repeat(64)}@${"b".repeat(60)}.example`, longest, "n".repeat(254)]) {
      const read = readProjection(withGrant({ who }));
      expect({ who: who.length, readable: !("unreadable" in read) }).toEqual({ who: who.length, readable: true });
    }
    expect(WHO_MAX).toBe(254);
  });

  test("an access given under a name, before the registry, is kept as such", () => {
    const read = readProjection(withGrant({ who: "Bob, from the agency (2025)" }));
    expect("unreadable" in read).toBe(false);
    expect((read as Projection).sites[HOST]!.passwords[0]!.who).toBe("Bob, from the agency (2025)");
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
