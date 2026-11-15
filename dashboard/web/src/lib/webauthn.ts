/**
 * The owner's passkeys, on the page's side: the options the steward issued
 * turned into what `navigator.credentials` takes, and what it answers turned
 * back into JSON the steward reads. The page verifies nothing: the steward
 * does (dashboard/src/passkeys/steward.ts).
 *
 * Every binary field travels as base64url, the steward's encoding.
 */
import { callApi, changePassword, send } from "./api"
import type { PasswordResponse } from "./types"

/** Does this browser offer passkeys at all? */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && typeof navigator.credentials?.get === "function"
}

export function fromB64url(text: string): ArrayBuffer {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export function toB64url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")
}

type Descriptor = { type: "public-key"; id: string; transports?: string[] }
type Options = Record<string, unknown>

const descriptors = (list: unknown): PublicKeyCredentialDescriptor[] =>
  (Array.isArray(list) ? (list as Descriptor[]) : []).map((one) => ({
    type: "public-key",
    id: fromB64url(one.id),
    ...(one.transports === undefined ? {} : { transports: one.transports as AuthenticatorTransport[] }),
  }))

/** A sign-in's or an unlock's options, as `navigator.credentials.get` takes them. */
export function requestOptions(options: Options): PublicKeyCredentialRequestOptions {
  return {
    challenge: fromB64url(options.challenge as string),
    rpId: options.rpId as string,
    timeout: options.timeout as number,
    userVerification: "required",
    allowCredentials: descriptors(options.allowCredentials),
  }
}

/** A registration's options, as `navigator.credentials.create` takes them. */
export function creationOptions(options: Options): PublicKeyCredentialCreationOptions {
  const user = options.user as { id: string; name: string; displayName: string }
  return {
    challenge: fromB64url(options.challenge as string),
    rp: options.rp as PublicKeyCredentialRpEntity,
    user: { id: fromB64url(user.id), name: user.name, displayName: user.displayName },
    pubKeyCredParams: options.pubKeyCredParams as PublicKeyCredentialParameters[],
    timeout: options.timeout as number,
    attestation: "none",
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    excludeCredentials: descriptors(options.excludeCredentials),
  }
}

/** What `get` answered, as the steward reads it. */
export function assertionJson(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAssertionResponse
  return {
    id: credential.id,
    rawId: toB64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toB64url(response.clientDataJSON),
      authenticatorData: toB64url(response.authenticatorData),
      signature: toB64url(response.signature),
      userHandle: response.userHandle === null ? null : toB64url(response.userHandle),
    },
  }
}

/** What `create` answered, as the steward reads it. */
export function registrationJson(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAttestationResponse
  return {
    id: credential.id,
    rawId: toB64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toB64url(response.clientDataJSON),
      attestationObject: toB64url(response.attestationObject),
      transports: typeof response.getTransports === "function" ? response.getTransports() : [],
    },
  }
}

export type CeremonyFailure = { error: string; message?: string; wait?: number }
type Asked = { challengeId: string; publicKey: Options }

/** What a refused ceremony says, in words. The browser's own cancellation is not an error to dwell on. */
export function ceremonyMessage(status: number, body: CeremonyFailure | null): string {
  if (status === -1) return "The passkey prompt was closed. Try again when ready."
  if (status === 0) return "Can't reach the dashboard. Check your connection."
  if (status === 429) return `Too many attempts. Try again in ${Math.max(1, Math.ceil(body?.wait ?? 1))} s.`
  if (status === 423 || body?.error === "locked") return "Unlock first."
  return body?.message ?? "This passkey can't be used here."
}

export type Ceremony<T> = { ok: true; status: number; body: T } | { ok: false; status: number; body: CeremonyFailure | null }

/**
 * Asks the steward for a challenge, has the browser sign it, and posts the
 * result. Status -1: the person closed the prompt, or the browser refused.
 */
async function ceremony<T>(
  challenge: Record<string, unknown>,
  run: (publicKey: Options) => Promise<Credential | null>,
  serialise: (credential: PublicKeyCredential) => Record<string, unknown>,
  post: (challengeId: string, credential: Record<string, unknown>) => Promise<{ status: number; body: (T & Partial<CeremonyFailure>) | null }>,
): Promise<Ceremony<T>> {
  const asked = await send<Asked & CeremonyFailure>("POST", "/api/passkeys/challenge", challenge)
  if (asked.status !== 200 || asked.body === null) return { ok: false, status: asked.status, body: asked.body }
  let credential: Credential | null
  try {
    credential = await run(asked.body.publicKey)
  } catch {
    return { ok: false, status: -1, body: null }
  }
  if (credential === null) return { ok: false, status: -1, body: null }
  const answered = await post(asked.body.challengeId, serialise(credential as PublicKeyCredential))
  if (answered.status === 200 && answered.body !== null) return { ok: true, status: 200, body: answered.body as T }
  return { ok: false, status: answered.status, body: (answered.body as CeremonyFailure | null) ?? null }
}

const get = (publicKey: Options) => navigator.credentials.get({ publicKey: requestOptions(publicKey) })
const create = (publicKey: Options) => navigator.credentials.create({ publicKey: creationOptions(publicKey) })

/** Signs the owner in: the session's cookie comes back with the answer. */
export function signInWithPasskey() {
  return ceremony<{ open: boolean }>({ purpose: "signin" }, get, assertionJson, (challengeId, credential) => send("POST", "/api/passkeys/signin", { challengeId, credential }))
}

/** Unlocks the owner's session for ten minutes. */
export function unlockWithPasskey() {
  return ceremony<{ until: number }>({ purpose: "unlock" }, get, assertionJson, (challengeId, credential) => send("POST", "/api/secrets/unlock", { challengeId, credential }))
}

/**
 * Changes a password, the owner confirming with a fresh assertion of their
 * passkey rather than the dashboard password, which the steward refuses once
 * a passkey exists. The answer is the password change's own.
 */
export function changePasswordWithPasskey(names: { slug: string; file: string; variable: string }, newPassword: string | null) {
  return ceremony<PasswordResponse>({ purpose: "unlock" }, get, assertionJson, (challengeId, credential) =>
    changePassword({ ...names, challengeId, credential, newPassword }),
  )
}

export type RegisteredPasskey ={ passkey: PasskeyView; viaLink: boolean; count: number }

/** A new passkey, from the unlocked dashboard, or with root's link, which signs the owner in. */
export function registerPasskey(name: string, link: string | null = null) {
  const auth = link === null ? {} : { link }
  return ceremony<RegisteredPasskey>({ purpose: "register", ...auth }, create, registrationJson, (challengeId, credential) =>
    send("POST", "/api/passkeys/register", { challengeId, credential, name, ...auth }),
  )
}

export type PasskeyView = { id: string; name: string; createdAt: number; lastUsedAt: number | null }
export type PasskeysResponse = { passkeys: PasskeyView[]; readable: boolean }

export function readPasskeys() {
  return callApi<PasskeysResponse & Partial<CeremonyFailure>>("/api/passkeys")
}

export function removePasskey(id: string) {
  return send<PasskeysResponse & Partial<CeremonyFailure>>("DELETE", "/api/passkeys/credential", { id })
}

/** The fragment root's link carries: `#passkey=<link>`, which never reaches a server. */
export function linkFromHash(hash: string): string | null {
  const match = /^#passkey=([A-Za-z0-9_-]{16,128})$/.exec(hash)
  return match === null ? null : match[1]!
}
