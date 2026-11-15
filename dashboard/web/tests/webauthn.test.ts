import { describe, expect, test } from "bun:test"
import { signInRefusal } from "../src/lib/signin"
import { ALREADY_REGISTERED, NO_PASSKEYS, PROMPT_CLOSED, browserRefusal, ceremonyMessage, creationOptions, fromB64url, linkFromHash, ownerPasskeys, requestOptions, toB64url } from "../src/lib/webauthn"

describe("the page's half of a passkey ceremony", () => {
  test("base64url goes both ways, without padding", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255])
    const text = toB64url(bytes)
    expect(text).not.toMatch(/[+/=]/)
    expect(new Uint8Array(fromB64url(text))).toEqual(bytes)
    expect(toB64url(new Uint8Array(0))).toBe("")
  })

  test("the steward's options become what the browser takes, the user always verified", () => {
    const id = toB64url(new Uint8Array([7, 7, 7]))
    const get = requestOptions({ challenge: toB64url(new Uint8Array(32)), rpId: "test-zone.invalid", timeout: 120000, userVerification: "preferred", allowCredentials: [{ type: "public-key", id, transports: ["internal"] }] })
    expect(get.userVerification).toBe("required")
    expect(get.rpId).toBe("test-zone.invalid")
    expect(new Uint8Array(get.allowCredentials![0]!.id as ArrayBuffer)).toEqual(new Uint8Array([7, 7, 7]))

    const create = creationOptions({
      challenge: toB64url(new Uint8Array(32)),
      rp: { id: "test-zone.invalid", name: "sitesolide" },
      user: { id: toB64url(new TextEncoder().encode("sitesolide-owner")), name: "owner", displayName: "Owner" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      timeout: 120000,
      excludeCredentials: [{ type: "public-key", id }],
    })
    expect(create.authenticatorSelection).toEqual({ residentKey: "required", requireResidentKey: true, userVerification: "required" })
    expect(create.attestation).toBe("none")
    expect(create.excludeCredentials).toHaveLength(1)
  })

  test("root's link is read from the fragment alone, and only in its shape", () => {
    expect(linkFromHash("#passkey=abcdefghijklmnopqrstuvwxyz012345")).toBe("abcdefghijklmnopqrstuvwxyz012345")
    expect(linkFromHash("#passkey=short")).toBeNull()
    expect(linkFromHash("#passkey=abcdefghijklmnop&x=1")).toBeNull()
    expect(linkFromHash("")).toBeNull()
  })

  test("the owner holds a passkey by the session's word, the listing counting them", () => {
    const listing = (count: number, readable = true) => ({ passkeys: Array.from({ length: count }, (_, i) => ({ id: `k${i}`, name: "Key", createdAt: 0, lastUsedAt: null })), readable })
    expect(ownerPasskeys({ registered: true }, listing(2))).toEqual({ registered: true, count: 2 })
    // The session's word stands, the steward's remembered flag behind it, even when the listing could not be read.
    expect(ownerPasskeys({ registered: true }, null)).toEqual({ registered: true, count: null })
    expect(ownerPasskeys({ registered: false }, listing(0))).toEqual({ registered: false, count: 0 })
    // A dashboard with no word on passkeys: the listing alone, an unreadable registry counting as passkeys.
    expect(ownerPasskeys(undefined, listing(1))).toEqual({ registered: true, count: 1 })
    expect(ownerPasskeys(undefined, listing(0, false))).toEqual({ registered: true, count: null })
    expect(ownerPasskeys(undefined, listing(0))).toEqual({ registered: false, count: 0 })
    // Nothing known: as before passkeys.
    expect(ownerPasskeys(null, null)).toEqual(NO_PASSKEYS)
    expect(NO_PASSKEYS.registered).toBe(false)
  })

  test("a refusal says what to do", () => {
    expect(ceremonyMessage(-1, null)).toContain("prompt was closed")
    expect(ceremonyMessage(ALREADY_REGISTERED, null)).toBe("This device already holds one of your passkeys.")
  })

  test("the browser's refusal: a device that holds a passkey already is not a prompt closed", () => {
    // excludeCredentials: Chrome refuses to register a second key on the device with InvalidStateError.
    expect(browserRefusal(new DOMException("already registered", "InvalidStateError"))).toBe(ALREADY_REGISTERED)
    expect(browserRefusal(new DOMException("cancelled", "NotAllowedError"))).toBe(PROMPT_CLOSED)
    expect(browserRefusal(new TypeError("bad options"))).toBe(PROMPT_CLOSED)
    expect(browserRefusal("odd")).toBe(PROMPT_CLOSED)
    expect(ceremonyMessage(browserRefusal(new DOMException("", "InvalidStateError")), null)).toContain("already holds")
  })

  test("a refusal of the server says what to do", () => {
    expect(ceremonyMessage(429, { error: "too-many-attempts", wait: 12 })).toBe("Too many attempts. Try again in 12 s.")
    expect(ceremonyMessage(423, null)).toBe("Unlock first.")
    expect(signInRefusal(403, { error: "passkey-only" }).message).toBe("This dashboard signs in with a passkey.")
    expect(signInRefusal(503, { error: "unavailable" }).message).toContain("cannot be verified right now")
  })
})
