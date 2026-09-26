import { describe, expect, test } from "bun:test";
import { isValidId } from "../src/guests";
import {
  deriveKey,
  issueToken,
  guestHash,
  generateId,
  doorHeaders,
  isValidHost,
  readCookie,
  readToken,
  cookieName,
  isAcceptableOrigin,
  setCookie,
  isAcceptableRequest,
  returnForRequest,
  safeReturnTo,
} from "../src/gate";

const SEED = new Uint8Array(32).fill(7);
const KEY = deriveKey(SEED, "$argon2id$hash")!;
const HOST = "kanban.test-zone.invalid";
const NOW = 1_800_000_000;
const DURATION = 30 * 24 * 3600;
const GUEST_ID = "AbCdEfGhIjKlMn_-";

describe("the key", () => {
  test("without a hash, no key: nobody gets in", () => {
    expect(deriveKey(SEED, "")).toBeNull();
  });

  test("a draw that is too short is refused", () => {
    expect(deriveKey(new Uint8Array(8), "x")).toBeNull();
  });

  test("changing the password changes the key, therefore invalidates the cookies, the guests' included", () => {
    const other = deriveKey(SEED, "$argon2id$other")!;
    expect(readToken(issueToken(KEY, HOST, NOW + 60), other, HOST, NOW, DURATION)).toBeNull();
    expect(readToken(issueToken(KEY, HOST, NOW + 60, GUEST_ID), other, HOST, NOW, DURATION)).toBeNull();
  });
});

describe("the owner token", () => {
  const validToken = issueToken(KEY, HOST, NOW + 3600);

  test("opens the host that received it, for the owner", () => {
    expect(readToken(validToken, KEY, HOST, NOW, DURATION)).toEqual({ guest: null });
  });

  test("keeps the form from before the guests: no cookie in circulation falls", () => {
    expect(validToken.split(".")).toHaveLength(2);
  });

  test("opens no other host, even replayed by a compromised site", () => {
    expect(readToken(validToken, KEY, "roster.test-zone.invalid", NOW, DURATION)).toBeNull();
  });

  test("expires", () => {
    expect(readToken(validToken, KEY, HOST, NOW + 3600, DURATION)).toBeNull();
  });

  test("an expiration beyond the duration in force is refused", () => {
    const distant = issueToken(KEY, HOST, NOW + DURATION + 1);
    expect(readToken(distant, KEY, HOST, NOW, DURATION)).toBeNull();
  });

  test("an expiration pushed back by hand invalidates the signature", () => {
    const [, signature] = validToken.split(".");
    expect(readToken(`${NOW + 7200}.${signature}`, KEY, HOST, NOW, DURATION)).toBeNull();
  });

  test("unexpected forms are refused without throwing", () => {
    for (const token of [null, "", ".", "..", "abc", "12.", ".sig", "-1.x", "1e9.x", `${NOW + 60}`, "1.2.3.4"]) {
      expect(readToken(token, KEY, HOST, NOW, DURATION)).toBeNull();
    }
  });

  test("without a key, even a well formed token is refused", () => {
    expect(readToken(validToken, null, HOST, NOW, DURATION)).toBeNull();
  });
});

describe("a guest token", () => {
  const validToken = issueToken(KEY, HOST, NOW + 3600, GUEST_ID);

  test("names the access it carries", () => {
    expect(readToken(validToken, KEY, HOST, NOW, DURATION)).toEqual({ guest: GUEST_ID });
  });

  test("stripped of its identifier, it does not become the owner's one", () => {
    const [expiration, , signature] = validToken.split(".");
    expect(readToken(`${expiration}.${signature}`, KEY, HOST, NOW, DURATION)).toBeNull();
  });

  test("and the owner's one does not become a guest's one", () => {
    const [expiration, signature] = issueToken(KEY, HOST, NOW + 3600).split(".");
    expect(readToken(`${expiration}.${GUEST_ID}.${signature}`, KEY, HOST, NOW, DURATION)).toBeNull();
  });

  test("another identifier invalidates the signature", () => {
    const [expiration, , signature] = validToken.split(".");
    const other = `${expiration}.ZZZZZZZZZZZZZZZZ.${signature}`;
    expect(readToken(other, KEY, HOST, NOW, DURATION)).toBeNull();
  });

  test("a malformed identifier is refused before the signature", () => {
    for (const id of ["court", "a.b", "AbCdEfGhIjKlMn!-"]) {
      expect(readToken(`${NOW + 60}.${id}.x`, KEY, HOST, NOW, DURATION)).toBeNull();
    }
  });

  test("opens no other host", () => {
    expect(readToken(validToken, KEY, "roster.test-zone.invalid", NOW, DURATION)).toBeNull();
  });
});

describe("the identifier and the hash of a guest", () => {
  test("the identifier fits in a cookie, and is recognized", () => {
    const id = generateId((n) => new Uint8Array(n).fill(255));
    expect(id).toBe("________________");
    expect(isValidId(id)).toBe(true);
    expect(isValidId(generateId())).toBe(true);
    expect(generateId()).not.toBe(generateId());
  });

  test("the hash is stable, and does not look like the password", () => {
    const hash = guestHash("Xith-G4r4-nRJs-uDMV");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(guestHash("Xith-G4r4-nRJs-uDMV")).toBe(hash);
    expect(guestHash("Xith-G4r4-nRJs-uDMW")).not.toBe(hash);
  });
});

describe("the host announced by Caddy", () => {
  test("accepts a host name", () => {
    for (const host of ["kanban.test-zone.invalid", "sample.localhost", "a"]) expect(isValidHost(host)).toBe(true);
  });

  test("refuses what does not have that shape", () => {
    for (const host of ["", "Kanban.test", "a b", "a.test:443", "a..test", "-a.test", "a.test/", "a|b", "a".repeat(254)]) {
      expect(isValidHost(host)).toBe(false);
    }
  });
});

describe("the cookie", () => {
  test("read by its exact name, never by inclusion", () => {
    expect(readCookie("a=1; portal=ok; b=2", "portal")).toBe("ok");
    expect(readCookie("trapportal=wrong", "portal")).toBeNull();
    expect(readCookie("portal2=wrong", "portal")).toBeNull();
    expect(readCookie("portal=", "portal")).toBeNull();
    expect(readCookie(null, "portal")).toBeNull();
  });

  test("online: __Host-, Secure, HttpOnly, Lax, Path=/ and no Domain", () => {
    const header = setCookie("j", true, 60);
    expect(header.startsWith("__Host-portal=j;")).toBe(true);
    for (const attribute of ["Path=/", "Max-Age=60", "HttpOnly", "SameSite=Lax", "Secure"]) {
      expect(header).toInclude(attribute);
    }
    expect(header).not.toInclude("Domain");
  });

  test("on plain HTTP, without the prefix the browser would refuse", () => {
    expect(cookieName(false)).toBe("portal");
    expect(setCookie("j", false, 60)).not.toInclude("Secure");
  });
});

describe("the origin", () => {
  test("the host's own, on HTTPS", () => {
    expect(isAcceptableOrigin("https://kanban.test-zone.invalid", HOST, true)).toBe(true);
  });

  test("refuses the others, including a client's preview, which is the same site", () => {
    for (const origin of [
      null,
      "null",
      "",
      "https://agency.test-zone.invalid",
      "https://kanban.test-zone.invalid.evil.test",
      "http://kanban.test-zone.invalid",
    ]) {
      expect(isAcceptableOrigin(origin, HOST, true)).toBe(false);
    }
  });

  test("plain HTTP only outside production, for the lab", () => {
    expect(isAcceptableOrigin("http://sample.localhost:8471", "sample.localhost", false)).toBe(true);
  });

  test("only the methods that change a state require the origin", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(isAcceptableRequest(method, null, HOST, true)).toBe(true);
    }
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isAcceptableRequest(method, null, HOST, true)).toBe(false);
      expect(isAcceptableRequest(method, "https://agency.test-zone.invalid", HOST, true)).toBe(false);
      expect(isAcceptableRequest(method, `https://${HOST}`, HOST, true)).toBe(true);
    }
  });
});

describe("the return after login", () => {
  test("a path of the same host gets through", () => {
    expect(safeReturnTo("/list?week=3")).toBe("/list?week=3");
  });

  test("anything that would lead elsewhere brings back to the home page", () => {
    for (const returnTo of [
      "//evil.test",
      "/\\evil.test",
      "https://evil.test",
      "evil",
      "",
      null,
      42,
      "/a\nb",
      "/a\x00",
      "/a\x7f",
      "/" + "a".repeat(2048),
      "/_portal/connexion",
    ]) {
      expect(safeReturnTo(returnTo)).toBe("/");
    }
  });

  test("only a requested page is remembered, a refused POST is not replayed", () => {
    expect(returnForRequest("GET", "/list")).toBe("/list");
    expect(returnForRequest("HEAD", "/list")).toBe("/list");
    expect(returnForRequest("POST", "/api/kanban")).toBe("/");
    expect(returnForRequest("GET", null)).toBe("/");
  });
});

test("the page loads nothing from anywhere but itself, its data: icon included", () => {
  const csp = doorHeaders()["Content-Security-Policy"]!;
  expect(csp).toInclude("default-src 'none'");
  expect(csp).toInclude("img-src data:");
  expect(csp).not.toInclude("script-src");
});
