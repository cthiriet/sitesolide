import { describe, expect, test } from "bun:test";
import { isAccessId } from "../src/access";
import {
  deriveKey,
  issueToken,
  guestHash,
  doorHeaders,
  isValidHost,
  readAnnounced,
  readCookie,
  readToken,
  cookieName,
  isAcceptableOrigin,
  setCookie,
  isAcceptableRequest,
  returnForRequest,
  safeReturnTo,
  issueIdentityToken,
  cleanName,
  identityHeaders,
  purposeKey,
  seal,
  unseal,
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

describe("the identifier and the hash of a password access", () => {
  test("the identifier a cookie carries is 16 characters of base64url, and nothing else", () => {
    expect(isAccessId("________________")).toBe(true);
    for (const id of ["_______________", "_________________", "_______________=", "AAAAAAAAAAAAAAA.", 42, null]) expect(isAccessId(id)).toBe(false);
  });

  test("a cookie naming an identifier of another shape is refused", () => {
    const [expiration, , signature] = issueToken(KEY, HOST, NOW + 3600, GUEST_ID).split(".");
    expect(readToken(`${expiration}.short.${signature}`, KEY, HOST, NOW, DURATION)).toBeNull();
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

describe("an identity token", () => {
  const ALICE = { email: "alice@acme.test", name: "Alice Martin" };
  const IDENTITY_DURATION = 24 * 3600;
  const validToken = issueIdentityToken(KEY, HOST, NOW + 3600, ALICE);

  test("carries the verified email and the name, and nothing of a guest", () => {
    expect(readToken(validToken, KEY, HOST, NOW, DURATION, IDENTITY_DURATION)).toEqual({ guest: null, identity: ALICE });
    expect(validToken.split(".")).toHaveLength(4);
  });

  test("a person without a name stays a person", () => {
    const token = issueIdentityToken(KEY, HOST, NOW + 60, { email: "bob@acme.test", name: null });
    expect(readToken(token, KEY, HOST, NOW, DURATION)?.identity).toEqual({ email: "bob@acme.test", name: null });
  });

  test("opens no other host, and falls with the password", () => {
    expect(readToken(validToken, KEY, "roster.test-zone.invalid", NOW, DURATION)).toBeNull();
    expect(readToken(validToken, deriveKey(SEED, "$argon2id$other")!, HOST, NOW, DURATION)).toBeNull();
  });

  test("expires, and never lives beyond the identity duration, even when signed for longer", () => {
    expect(readToken(validToken, KEY, HOST, NOW + 3600, DURATION, IDENTITY_DURATION)).toBeNull();
    const distant = issueIdentityToken(KEY, HOST, NOW + IDENTITY_DURATION + 1, ALICE);
    expect(readToken(distant, KEY, HOST, NOW, DURATION, IDENTITY_DURATION)).toBeNull();
    expect(readToken(distant, KEY, HOST, NOW, DURATION)).not.toBeNull();
  });

  test("another email in the payload invalidates the signature", () => {
    const [expiration, mark, , signature] = validToken.split(".");
    const forged = Buffer.from(JSON.stringify({ e: "ceo@acme.test", n: "CEO" })).toString("base64url");
    expect(readToken(`${expiration}.${mark}.${forged}.${signature}`, KEY, HOST, NOW, DURATION)).toBeNull();
  });

  test("does not turn into an owner's or a guest's token by dropping pieces, nor the reverse", () => {
    const [expiration, , payload, signature] = validToken.split(".");
    expect(readToken(`${expiration}.${signature}`, KEY, HOST, NOW, DURATION)).toBeNull();
    expect(readToken(`${expiration}.${payload}.${signature}`, KEY, HOST, NOW, DURATION)).toBeNull();
    const [ownerExpiration, ownerSignature] = issueToken(KEY, HOST, NOW + 3600).split(".");
    expect(readToken(`${ownerExpiration}.id.${payload}.${ownerSignature}`, KEY, HOST, NOW, DURATION)).toBeNull();
    const [guestExpiration, guest, guestSignature] = issueToken(KEY, HOST, NOW + 3600, GUEST_ID).split(".");
    expect(readToken(`${guestExpiration}.id.${guest}.${guestSignature}`, KEY, HOST, NOW, DURATION)).toBeNull();
  });

  test("a fourth piece needs the identity mark", () => {
    const [expiration, , payload, signature] = validToken.split(".");
    expect(readToken(`${expiration}.xx.${payload}.${signature}`, KEY, HOST, NOW, DURATION)).toBeNull();
  });

  test("a signed payload that is not an identity is refused all the same", () => {
    // Only the portal signs, but what it reads back it judges again.
    for (const identity of [
      { email: "not an email", name: null },
      { email: "Alice@acme.test", name: null },
      { email: "alice@acme.test", name: "two\nlines" },
    ]) {
      const token = issueIdentityToken(KEY, HOST, NOW + 60, identity);
      expect(readToken(token, KEY, HOST, NOW, DURATION)).toBeNull();
    }
  });
});

describe("a display name", () => {
  test("loses its control characters and its edges, and is cut", () => {
    expect(cleanName("  Alice\r\nX-Sitesolide-Role: admin ")).toBe("Alice  X-Sitesolide-Role: admin");
    expect(cleanName("a".repeat(500))).toHaveLength(200);
    expect(cleanName("   ")).toBeNull();
    expect(cleanName(42)).toBeNull();
  });

  test("is cut on characters, never inside one, and leaves no lone surrogate", () => {
    // 199 letters then an emoji, two UTF-16 units: slice(0, 200) kept half of
    // it, and encodeURIComponent threw on every request of that person.
    const name = cleanName(`${"a".repeat(199)}😀😀`)!;
    expect(name).toBe(`${"a".repeat(199)}😀`);
    expect(name.isWellFormed()).toBe(true);
    expect(Array.from(cleanName("😀".repeat(300))!)).toHaveLength(200);
    // A lone surrogate the provider sent itself becomes U+FFFD.
    expect(cleanName("Zo\ud800e")).toBe("Zo�e");
  });
});

describe("the identity headers", () => {
  test("the owner and a password access are a role and nobody", () => {
    expect(identityHeaders("admin", null)).toEqual({ "X-Sitesolide-Role": "admin" });
    expect(identityHeaders("visitor", null)).toEqual({ "X-Sitesolide-Role": "visitor" });
  });

  test("a person carries their role, the email as is and the name percent-encoded", () => {
    const headers = identityHeaders("developer", { email: "zoe@acme.test", name: "Zoë 李" });
    expect(headers).toEqual({
      "X-Sitesolide-Role": "developer",
      "X-Sitesolide-User": "zoe@acme.test",
      "X-Sitesolide-User-Name": "Zo%C3%AB%20%E6%9D%8E",
    });
    expect(decodeURIComponent(headers["X-Sitesolide-User-Name"]!)).toBe("Zoë 李");
  });

  test("no name, no name header rather than an empty one", () => {
    expect(identityHeaders("admin", { email: "owner@acme.test", name: null })).toEqual({
      "X-Sitesolide-Role": "admin",
      "X-Sitesolide-User": "owner@acme.test",
    });
  });

  test("a name the encoding cannot take does not throw, it is carried well formed", () => {
    // Whatever slipped past cleanName, /verifier must answer, not fail.
    const headers = identityHeaders("viewer", { email: "a@acme.test", name: "a\ud83d" });
    expect(headers["X-Sitesolide-User-Name"]).toBe("a%EF%BF%BD");
  });

  test("an identity cookie carrying a lone surrogate opens nothing, and does not throw", () => {
    // Minted before names were cut on characters: refused, the person signs
    // in again and gets a name that encodes.
    const token = issueIdentityToken(KEY, HOST, NOW + 60, { email: "zoe@acme.test", name: `${"a".repeat(199)}\ud83d` });
    expect(readToken(token, KEY, HOST, NOW, DURATION)).toBeNull();
  });

  test("every value fits in a header", () => {
    const headers = identityHeaders("visitor", { email: "a@acme.test", name: cleanName("Ünïcødé ✓ ") });
    expect(() => new Headers(headers)).not.toThrow();
  });
});

describe("sealed tokens", () => {
  const FLOW_KEY = purposeKey(KEY, "flow");

  test("read back what was sealed, with the same key only", () => {
    const token = seal(FLOW_KEY, { h: HOST, n: 1 });
    expect(unseal(FLOW_KEY, token)).toEqual({ h: HOST, n: 1 });
    expect(unseal(purposeKey(KEY, "session"), token)).toBeNull();
    expect(unseal(KEY, token)).toBeNull();
  });

  test("a purpose key never equals the cookie key, nor another purpose's", () => {
    expect(Buffer.from(FLOW_KEY).equals(Buffer.from(KEY))).toBe(false);
    expect(Buffer.from(FLOW_KEY).equals(Buffer.from(purposeKey(KEY, "session")))).toBe(false);
  });

  test("a changed payload, or anything malformed, is refused without throwing", () => {
    const [, signature] = seal(FLOW_KEY, { h: HOST }).split(".");
    const other = Buffer.from(JSON.stringify({ h: "evil.test" })).toString("base64url");
    expect(unseal(FLOW_KEY, `${other}.${signature}`)).toBeNull();
    for (const token of [null, "", ".", "a.b.c", "!!.x", seal(FLOW_KEY, [1, 2])]) {
      expect(unseal(FLOW_KEY, token)).toBeNull();
    }
  });

  test("the flow's own cookies follow the __Host- rule", () => {
    expect(cookieName(true, "-sso")).toBe("__Host-portal-sso");
    expect(cookieName(false, "-sso")).toBe("portal-sso");
    expect(setCookie("v", true, 60, "-sso").startsWith("__Host-portal-sso=v;")).toBe(true);
  });
});

describe("readAnnounced", () => {
  test("a preview's host is both the host and the site", () => {
    expect(readAnnounced("kanban.test-zone.invalid")).toEqual({ host: "kanban.test-zone.invalid", site: "kanban.test-zone.invalid" });
  });

  test("a domain's block announces its host, then the site's address", () => {
    expect(readAnnounced("Kanban.Example kanban.test-zone.invalid")).toEqual({ host: "kanban.example", site: "kanban.test-zone.invalid" });
  });

  test("anything else is nothing", () => {
    for (const header of [null, "", " ", "a.example b.example c.example", "a.example  b.example", "a.example ", " a.example", "a.example\tb.example", "a_b.example", "a.example b.example:443"]) {
      expect(readAnnounced(header)).toBeNull();
    }
  });
});
