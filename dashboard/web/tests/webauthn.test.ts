import { describe, expect, test } from "bun:test"
import { signInRefusal } from "../src/lib/signin"
import { ceremonyMessage, creationOptions, fromB64url, linkFromHash, requestOptions, toB64url } from "../src/lib/webauthn"

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

  test("a refusal says what to do", () => {
    expect(ceremonyMessage(-1, null)).toContain("prompt was closed")
    expect(ceremonyMessage(429, { error: "too-many-attempts", wait: 12 })).toBe("Too many attempts. Try again in 12 s.")
    expect(ceremonyMessage(423, null)).toBe("Unlock first.")
    expect(signInRefusal(403, { error: "passkey-only" }).message).toBe("This dashboard signs in with a passkey.")
    expect(signInRefusal(503, { error: "unavailable" }).message).toContain("cannot be verified right now")
  })
})
