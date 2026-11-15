/**
 * What the steward's passkey routes take and answer, shared by the steward,
 * the dashboard's relay and `sitesolide passkey`.
 *
 * On the dashboard's socket, which only site-dashboard opens:
 *
 *   POST   /passkeys/challenge   ChallengeRequest   -> ChallengeResponse
 *   POST   /passkeys/signin      SignInRequest      -> SignInResponse
 *   POST   /passkeys/register    RegisterRequest    -> RegisterResponse
 *   GET    /passkeys                                -> PasskeysResponse
 *   DELETE /passkeys/credential  { token, id }      -> PasskeysResponse
 *   POST   /unlock               { challengeId, credential } -> UnlockResponse
 *
 * On the owner's socket, which only root opens, for `sitesolide passkey`
 * over the owner's SSH:
 *
 *   POST   /passkeys/link        {}                 -> LinkResponse
 *   GET    /passkeys                                -> PasskeysResponse
 *   DELETE /passkeys/credential  { id }             -> PasskeysResponse
 */
import type { PasskeyView } from "./registry";

export type { PasskeyView };

/** What a challenge is for: each is taken back by its own route alone. */
export type Purpose = "signin" | "unlock" | "register";

/**
 * `client`: who asks, as the dashboard read it from the address Caddy saw
 * (src/auth.ts, `clientKey`), for the bounds per client. `token`: the live
 * unlock, to register a passkey from the unlocked dashboard. `link`: the
 * one-time registration link root minted, the way in with no passkey yet.
 */
export type ChallengeRequest = { purpose: Purpose; client?: string; token?: string; link?: string };

/** The options `navigator.credentials` takes, base64url for every binary field. */
export type ChallengeResponse = { challengeId: string; publicKey: Record<string, unknown> };

export type SignInRequest = { challengeId: string; credential: unknown; client?: string };
export type SignInResponse = { id: string; name: string };

export type RegisterRequest = { challengeId: string; credential: unknown; name: string; client?: string; token?: string; link?: string };
/** `viaLink`: registered with root's link, which opens the owner's session as a sign-in would. */
export type RegisterResponse = { passkey: PasskeyView; viaLink: boolean; count: number };

/** `readable` false: a registry is there and cannot be read, and nothing signs in until it is repaired. */
export type PasskeysResponse = { passkeys: PasskeyView[]; readable: boolean };

export type LinkResponse = { link: string; expiresAt: number };

/** How long root's registration link lives, and it is used once. */
export const LINK_DURATION_MS = 15 * 60 * 1000;

/** The fragment the dashboard's page reads a registration link from: never sent to a server in a URL. */
export const LINK_FRAGMENT = "passkey";
