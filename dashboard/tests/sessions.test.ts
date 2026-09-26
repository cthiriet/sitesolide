import { describe, expect, test } from "bun:test";
import {
  TOKEN_BYTES,
  clearCookie,
  tokenHash,
  generateToken,
  readCookie,
  cookieName,
  isAcceptableOrigin,
  setCookie,
  isSessionAlive,
} from "../src/sessions";

describe("token", () => {
  test("the token is base64url, with no character to escape in a cookie", () => {
    const token = generateToken(() => new Uint8Array(TOKEN_BYTES).fill(255));
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("a source that is too short throws rather than yield a weak token", () => {
    expect(() => generateToken(() => new Uint8Array(8))).toThrow(/too short/);
  });

  test("the hash is stable and does not give the token back", async () => {
    const hash = await tokenHash("abc");
    expect(hash).toBe(await tokenHash("abc"));
    expect(hash).not.toBe(await tokenHash("abd"));
    expect(hash).toHaveLength(64);
  });
});

describe("cookie", () => {
  test("the __Host- prefix is set only online, where it can be honoured", () => {
    expect(cookieName(true)).toBe("__Host-session");
    expect(cookieName(false)).toBe("session");
  });

  test("the attributes carry HttpOnly, Strict and Secure when online", () => {
    const header = setCookie("TOKEN", true, 7 * 24 * 3600 * 1000);
    expect(header).toContain("__Host-session=TOKEN");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Secure");
    expect(header).toContain("Max-Age=604800");
  });

  test("offline, no Secure: the browser would store nothing", () => {
    expect(setCookie("TOKEN", false, 1000)).not.toContain("Secure");
  });

  test("clearing expires the same cookie", () => {
    expect(clearCookie(true)).toContain("Max-Age=0");
    expect(clearCookie(true)).toContain("__Host-session=");
  });
});

describe("reading the cookie", () => {
  test("a neighbouring name does not open the session", () => {
    expect(readCookie("trap__Host-session=STOLEN", true)).toBeNull();
    expect(readCookie("__Host-sessionish=STOLEN", true)).toBeNull();
  });

  test("the right cookie is found among others", () => {
    expect(readCookie("a=1; __Host-session=BON; b=2", true)).toBe("BON");
  });

  test("absence and emptiness yield null", () => {
    expect(readCookie(null, true)).toBeNull();
    expect(readCookie("__Host-session=", true)).toBeNull();
  });
});

describe("origin and lifetime", () => {
  test("a missing origin is refused", () => {
    expect(isAcceptableOrigin(null, "https://dashboard.test-zone.invalid")).toBe(false);
  });

  test("only the exact origin passes", () => {
    const expected = "https://dashboard.test-zone.invalid";
    expect(isAcceptableOrigin(expected, expected)).toBe(true);
    expect(isAcceptableOrigin("https://dashboard.test-zone.invalid.pirate.test", expected)).toBe(false);
    expect(isAcceptableOrigin("http://dashboard.test-zone.invalid", expected)).toBe(false);
  });

  test("a session expires at the lifetime, not after", () => {
    const session = { hash: "e", createdAt: 1000, seenAt: 1000 };
    expect(isSessionAlive(session, 100, 1099)).toBe(true);
    expect(isSessionAlive(session, 100, 1100)).toBe(false);
  });
});
