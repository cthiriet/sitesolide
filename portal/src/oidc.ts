/**
 * Signing in with the company's identity provider, over OpenID Connect: the
 * settings, the provider's discovery document and keys, the code exchange, and
 * the verification of the ID token it hands back.
 *
 * Generic on purpose: Google Workspace, Microsoft Entra, Okta and Keycloak all
 * publish a discovery document, and nothing here names one of them except the
 * label of the button. No dependency either: WebCrypto verifies the RS256 and
 * ES256 signatures they use, and a JWT is three base64url pieces.
 *
 * Everything that decides is pure and takes its time as a parameter: the
 * claims, the discovery document, the keys. Only `createProvider` talks to the
 * network, through a `fetch` it is handed, and the tests hand it the real one
 * pointed at a provider they run themselves.
 *
 * ## What the ID token must prove
 *
 * - a signature by one of the provider's keys, with an asymmetric algorithm:
 *   never `none`, never an HMAC, whose key would be the client secret;
 * - `iss` exactly the configured issuer, `aud` this client, and `azp` this
 *   client when it is there or when the audience names several;
 * - `exp` not passed, `iat` neither in the future nor older than a sign-in can
 *   last, with a minute of tolerance either way for clocks;
 * - `nonce` the one this browser's flow drew, which ties the token to it;
 * - an email the provider says it verified. Microsoft Entra does not send
 *   `email_verified`: it sends `xms_edov`, true when the domain of the address
 *   is one its tenant proved it owns, once the claim is added to the token,
 *   and it is read from Microsoft's issuer alone. Without either, the address
 *   is whatever the account's holder typed, and proves nothing;
 * - with Google and allowed domains, an account of those domains' Workspace,
 *   named by `hd`: see `isHostedAccount`.
 */
// Types only: the verification itself goes through the global WebCrypto.
import type { webcrypto } from "node:crypto";
import { cleanEmail, maySignIn, readList, cleanDomain } from "./sharing";
import { cleanName, type Identity } from "./gate";

/** Clocks disagree: a token from a provider one minute ahead is still good. */
export const CLOCK_SKEW_S = 60;

/** How long a sign-in at the provider may take, from start to callback. */
export const FLOW_DURATION_S = 10 * 60;

/** The provider answers in under a second; beyond this, it will not. */
const TIMEOUT_MS = 10_000;

/** A discovery document or a key set is re-read at most this often. */
const CACHE_MS = 60 * 60 * 1000;

/** An unknown key identifier makes the key set be read again, but not more than once a minute. */
const KEYS_RETRY_MS = 60 * 1000;

/** Any bigger, it is not a discovery document, a key set or a token response. */
const MAX_BODY_BYTES = 256 * 1024;

export type Settings = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Empty: anyone the provider vouches for may sign in, and gets into what is shared with them. */
  allowedDomains: string[];
  /** Always let in, on every protected site. */
  admins: string[];
  /** What the button says after "Sign in with". */
  providerName: string;
  /** `<PUBLIC_URL>/oidc/callback`, the one address registered at the provider. */
  redirectUri: string;
  /** The portal's own origin, where the flow starts and ends. */
  portalOrigin: string;
};

export type SettingsReading = { settings: Settings | null; problems: string[] };

/** Google's issuer, `https://accounts.google.com`, by its host. */
const GOOGLE_HOST = "accounts.google.com";

/** Microsoft Entra's, `https://login.microsoftonline.com/<tenant>/v2.0`, by its host. */
const MICROSOFT_HOST = "login.microsoftonline.com";

/** The providers whose issuer says who they are, for the button's label. */
const KNOWN_PROVIDERS: Record<string, string> = {
  [GOOGLE_HOST]: "Google",
  [MICROSOFT_HOST]: "Microsoft",
};

/** Is this issuer, already judged an https address, served by that host? */
function issuedBy(issuer: string, host: string): boolean {
  try {
    return new URL(issuer).hostname === host;
  } catch {
    return false;
  }
}

/** RFC 6761 reserves `localhost` and every name under it for the loopback. */
function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost" || hostname.endsWith(".localhost");
}

/**
 * An address the portal may talk to or send a browser to: HTTPS, or plain HTTP
 * on the loopback alone, where the tests run their provider. Never a user and
 * password in it, never a fragment.
 */
export function isAcceptableUrl(text: unknown): text is string {
  if (typeof text !== "string" || text.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") return false;
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
}

/**
 * The settings, from the portal's environment. Absent, signing in with a
 * provider is simply not offered and the portal behaves as it always has;
 * half there, the same, and `problems` says what is missing, which the portal
 * prints at startup.
 */
export function readSettings(env: Record<string, string | undefined>, publicUrl: string): SettingsReading {
  const value = (name: string) => (env[name] ?? "").trim();
  const issuer = value("OIDC_ISSUER");
  const clientId = value("OIDC_CLIENT_ID");
  const clientSecret = value("OIDC_CLIENT_SECRET");
  if (issuer === "" && clientId === "" && clientSecret === "") return { settings: null, problems: [] };

  const missing: string[] = [];
  if (issuer === "") missing.push("OIDC_ISSUER is missing");
  else if (!isAcceptableUrl(issuer)) missing.push("OIDC_ISSUER must be an https address");
  if (clientId === "") missing.push("OIDC_CLIENT_ID is missing");
  if (clientSecret === "") missing.push("OIDC_CLIENT_SECRET is missing");
  if (!isAcceptableUrl(publicUrl)) missing.push("PUBLIC_URL, the portal's own address, is missing or not https");

  const domains = readList(value("OIDC_ALLOWED_DOMAINS"), cleanDomain);
  const admins = readList(value("OIDC_ADMIN_EMAILS"), cleanEmail);
  const problems = [
    ...missing,
    ...domains.ignored.map((entry) => `OIDC_ALLOWED_DOMAINS: ignored ${JSON.stringify(entry)}, not a domain`),
    ...admins.ignored.map((entry) => `OIDC_ADMIN_EMAILS: ignored ${JSON.stringify(entry)}, not an email`),
  ];
  if (missing.length > 0) return { settings: null, problems };

  const origin = new URL(publicUrl).origin;
  const named = cleanName(value("OIDC_PROVIDER_NAME"));
  return {
    settings: {
      issuer,
      clientId,
      clientSecret,
      allowedDomains: domains.values,
      admins: admins.values,
      providerName: named?.slice(0, 40) ?? KNOWN_PROVIDERS[new URL(issuer).hostname] ?? "your work account",
      redirectUri: `${origin}/oidc/callback`,
      portalOrigin: origin,
    },
    problems,
  };
}

// --- The discovery document ------------------------------------------------------

export type Discovery = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** How the client secret goes to the token endpoint. */
  tokenAuth: "basic" | "post";
};

/**
 * The discovery document, judged. Its `issuer` must be the configured one to
 * the character, as the specification requires: a document served under one
 * name for another provider is how a mix-up starts. Microsoft's multi-tenant
 * `common` endpoint fails here, its issuer being a template: a tenant's own
 * issuer is the one to configure.
 */
export function readDiscovery(document: unknown, issuer: string): Discovery | string {
  if (typeof document !== "object" || document === null) return "the discovery document is not a JSON object";
  const fields = document as Record<string, unknown>;
  if (fields.issuer !== issuer) return `the discovery document names another issuer: ${String(fields.issuer).slice(0, 100)}`;
  for (const name of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    if (!isAcceptableUrl(fields[name])) return `the discovery document has no usable ${name}`;
  }
  const methods = fields.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) return "the provider does not support PKCE with S256";
  const types = fields.response_types_supported;
  if (Array.isArray(types) && !types.includes("code")) return "the provider does not support the authorization code flow";

  // client_secret_basic is the specification's default when the list is
  // absent, and every provider named in the README accepts it.
  const auth = fields.token_endpoint_auth_methods_supported;
  let tokenAuth: Discovery["tokenAuth"] = "basic";
  if (Array.isArray(auth) && !auth.includes("client_secret_basic")) {
    if (!auth.includes("client_secret_post")) return "the provider accepts neither client_secret_basic nor client_secret_post";
    tokenAuth = "post";
  }

  return {
    issuer,
    authorizationEndpoint: fields.authorization_endpoint as string,
    tokenEndpoint: fields.token_endpoint as string,
    jwksUri: fields.jwks_uri as string,
    tokenAuth,
  };
}

// --- PKCE and the authorization request ----------------------------------------

function randomText(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

/** What one flow draws: the state, the nonce and the PKCE verifier, 128 bits and more each. */
export type FlowSecrets = { state: string; nonce: string; verifier: string };

export function drawFlowSecrets(): FlowSecrets {
  return { state: randomText(16), nonce: randomText(16), verifier: randomText(32) };
}

/** The S256 challenge of a verifier: the base64url SHA-256 of its text. */
export function codeChallenge(verifier: string): string {
  return new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
}

export function isFlowText(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{22,64}$/.test(value);
}

/**
 * Where the browser goes to sign in. `select_account` when the person asked to
 * use another account: the provider would otherwise hand back the one already
 * signed in, without asking.
 *
 * `reauth`: a member unlocking their secrets in the dashboard, who must prove
 * themselves again now. `max_age=0` asks every provider to sign them in
 * afresh and, by the OpenID Connect specification, to say when in the ID
 * token's `auth_time`, which the callback reads back: a provider that ignores
 * the request hands back an old `auth_time`, and the unlock is refused rather
 * than believed. `prompt=login` says the same in the words most providers
 * know; Google documents no such prompt, and gets `max_age` alone.
 */
export function authorizationUrl(discovery: Discovery, settings: Settings, secrets: FlowSecrets, chooseAccount: boolean, reauth = false): string {
  const url = new URL(discovery.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("redirect_uri", settings.redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", secrets.state);
  url.searchParams.set("nonce", secrets.nonce);
  url.searchParams.set("code_challenge", codeChallenge(secrets.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  const google = issuedBy(settings.issuer, GOOGLE_HOST);
  const prompts = [...(chooseAccount ? ["select_account"] : []), ...(reauth && !google ? ["login"] : [])];
  if (prompts.length > 0) url.searchParams.set("prompt", prompts.join(" "));
  if (reauth) url.searchParams.set("max_age", "0");
  return url.toString();
}

/**
 * A forced sign-in tolerates this much between the provider's clock and the
 * portal's: the two are different machines.
 */
export const REAUTH_SKEW_S = 60;

/** How old a forced sign-in may be when it comes back: the steward wants five minutes at most. */
export const REAUTH_MAX_AGE_S = 300;

/**
 * Did the provider sign the person in during this flow? Its own `auth_time`,
 * not the portal's clock: null, older than the flow, or older than five
 * minutes, and the forced sign-in did not happen.
 */
export function freshReauth(authTime: number | null, flowStartedAt: number, nowS: number): boolean {
  if (authTime === null) return false;
  if (authTime < flowStartedAt - REAUTH_SKEW_S) return false;
  if (authTime > nowS + REAUTH_SKEW_S) return false;
  return nowS - authTime <= REAUTH_MAX_AGE_S;
}

// --- The ID token ----------------------------------------------------------------

/** A public key from the provider's key set, reduced to what verifies. */
export type Jwk = { kid: string | null; kty: "RSA" | "EC"; alg: string | null; n?: string; e?: string; crv?: string; x?: string; y?: string };

type Algorithm = {
  kty: "RSA" | "EC";
  crv?: string;
  /** Raw signature length, for the curves: WebCrypto wants r and s side by side, as a JWS carries them. */
  length?: number;
  importParams: webcrypto.RsaHashedImportParams | webcrypto.EcKeyImportParams;
  verifyParams: webcrypto.AlgorithmIdentifier | webcrypto.RsaPssParams | webcrypto.EcdsaParams;
};

/** The asymmetric algorithms providers sign with. Anything else is refused, `none` and HS256 first. */
const ALGORITHMS: Record<string, Algorithm> = {
  RS256: { kty: "RSA", importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verifyParams: { name: "RSASSA-PKCS1-v1_5" } },
  RS384: { kty: "RSA", importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" }, verifyParams: { name: "RSASSA-PKCS1-v1_5" } },
  RS512: { kty: "RSA", importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" }, verifyParams: { name: "RSASSA-PKCS1-v1_5" } },
  PS256: { kty: "RSA", importParams: { name: "RSA-PSS", hash: "SHA-256" }, verifyParams: { name: "RSA-PSS", saltLength: 32 } },
  PS384: { kty: "RSA", importParams: { name: "RSA-PSS", hash: "SHA-384" }, verifyParams: { name: "RSA-PSS", saltLength: 48 } },
  PS512: { kty: "RSA", importParams: { name: "RSA-PSS", hash: "SHA-512" }, verifyParams: { name: "RSA-PSS", saltLength: 64 } },
  ES256: {
    kty: "EC",
    crv: "P-256",
    length: 64,
    importParams: { name: "ECDSA", namedCurve: "P-256" },
    verifyParams: { name: "ECDSA", hash: "SHA-256" },
  },
  ES384: {
    kty: "EC",
    crv: "P-384",
    length: 96,
    importParams: { name: "ECDSA", namedCurve: "P-384" },
    verifyParams: { name: "ECDSA", hash: "SHA-384" },
  },
};

/** An RSA modulus shorter than this is refused: 2048 bits, what every provider uses. */
const RSA_MIN_BYTES = 256;

const B64URL = /^[A-Za-z0-9_-]+$/;

/** The signing keys of a key set; an encryption key or a malformed one is left out. */
export function readKeys(document: unknown): Jwk[] {
  if (typeof document !== "object" || document === null) return [];
  const keys = (document as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return [];
  const usable: Jwk[] = [];
  for (const raw of keys.slice(0, 50)) {
    if (typeof raw !== "object" || raw === null) continue;
    const key = raw as Record<string, unknown>;
    if (key.use !== undefined && key.use !== "sig") continue;
    const kid = typeof key.kid === "string" ? key.kid : null;
    const alg = typeof key.alg === "string" ? key.alg : null;
    const text = (name: string) => (typeof key[name] === "string" && B64URL.test(key[name] as string) ? (key[name] as string) : null);
    if (key.kty === "RSA") {
      const n = text("n");
      const e = text("e");
      if (n === null || e === null || Buffer.from(n, "base64url").length < RSA_MIN_BYTES) continue;
      usable.push({ kid, kty: "RSA", alg, n, e });
    } else if (key.kty === "EC") {
      const x = text("x");
      const y = text("y");
      if (x === null || y === null || (key.crv !== "P-256" && key.crv !== "P-384")) continue;
      usable.push({ kid, kty: "EC", alg, crv: key.crv, x, y });
    }
  }
  return usable;
}

export type TokenParts = { header: Record<string, unknown>; claims: Record<string, unknown>; signed: Uint8Array; signature: Uint8Array };

function decodeObject(piece: string): Record<string, unknown> | null {
  if (!B64URL.test(piece)) return null;
  try {
    const value = JSON.parse(Buffer.from(piece, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The three pieces of a compact JWS, or null. Nothing in them is trusted yet. */
export function splitToken(token: unknown): TokenParts | null {
  if (typeof token !== "string" || token.length > 16 * 1024) return null;
  const pieces = token.split(".");
  if (pieces.length !== 3) return null;
  const header = decodeObject(pieces[0]!);
  const claims = decodeObject(pieces[1]!);
  if (header === null || claims === null || !B64URL.test(pieces[2]!)) return null;
  return {
    header,
    claims,
    signed: new TextEncoder().encode(`${pieces[0]}.${pieces[1]}`),
    signature: new Uint8Array(Buffer.from(pieces[2]!, "base64url")),
  };
}

/** The keys that could have signed this header: same identifier when it names one, same type, same curve. */
export function candidateKeys(header: Record<string, unknown>, keys: readonly Jwk[]): Jwk[] {
  const algorithm = typeof header.alg === "string" ? ALGORITHMS[header.alg] : undefined;
  if (algorithm === undefined) return [];
  const kid = typeof header.kid === "string" ? header.kid : null;
  return keys.filter(
    (key) =>
      key.kty === algorithm.kty &&
      (algorithm.crv === undefined || key.crv === algorithm.crv) &&
      (key.alg === null || key.alg === header.alg) &&
      (kid === null || key.kid === kid),
  );
}

/** Does one of these keys verify the signature? A key WebCrypto refuses to import counts as not verifying. */
export async function verifySignature(parts: TokenParts, keys: readonly Jwk[]): Promise<boolean> {
  const algorithm = typeof parts.header.alg === "string" ? ALGORITHMS[parts.header.alg] : undefined;
  if (algorithm === undefined) return false;
  if (algorithm.length !== undefined && parts.signature.length !== algorithm.length) return false;
  for (const key of candidateKeys(parts.header, keys)) {
    const jwk: webcrypto.JsonWebKey =
      key.kty === "RSA" ? { kty: "RSA", n: key.n, e: key.e, ext: true } : { kty: "EC", crv: key.crv, x: key.x, y: key.y, ext: true };
    try {
      const imported = await crypto.subtle.importKey("jwk", jwk, algorithm.importParams, false, ["verify"]);
      if (await crypto.subtle.verify(algorithm.verifyParams, imported, parts.signature, parts.signed)) return true;
    } catch {
      // A malformed key is one that verifies nothing.
    }
  }
  return false;
}

export type Expectations = { issuer: string; clientId: string; nonce: string; nowS: number };

/**
 * The claims, judged, or the reason they fail. The signature is checked
 * before, by `verifySignature`: these fields mean nothing on an unsigned token.
 */
export function claimsRefusal(claims: Record<string, unknown>, expected: Expectations): string | null {
  if (claims.iss !== expected.issuer) return "wrong-issuer";

  const audiences = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
  if (!audiences.includes(expected.clientId)) return "wrong-audience";
  if ((audiences.length > 1 || claims.azp !== undefined) && claims.azp !== expected.clientId) return "wrong-audience";

  const { exp, iat, nbf } = claims;
  if (typeof exp !== "number" || exp + CLOCK_SKEW_S <= expected.nowS) return "expired";
  if (typeof iat !== "number" || iat - CLOCK_SKEW_S > expected.nowS) return "issued-in-future";
  if (iat + FLOW_DURATION_S + CLOCK_SKEW_S < expected.nowS) return "expired";
  if (nbf !== undefined && (typeof nbf !== "number" || nbf - CLOCK_SKEW_S > expected.nowS)) return "not-yet-valid";

  if (typeof claims.nonce !== "string" || claims.nonce !== expected.nonce) return "wrong-nonce";
  if (typeof claims.sub !== "string" || claims.sub === "") return "no-subject";
  return null;
}

/** `true` as a boolean or as the string some providers send. */
function isTrue(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * The verified identity in the claims, or the reason there is none.
 *
 * The address must come exactly as an address: no space anywhere, not even at
 * its edges, which `cleanEmail` forgives a person typing one. What the
 * provider verified is that string, and another string, however close, is not
 * what it vouched for.
 *
 * `xms_edov` counts only from Microsoft Entra, the one provider that defines
 * it: from any other issuer, it is a claim like any other, which an
 * administrator of that provider might let a user set, and proves nothing.
 */
export function identityFromClaims(claims: Record<string, unknown>, issuer: string): Identity | string {
  if (claims.email === undefined || claims.email === null) return "no-email";
  if (typeof claims.email !== "string" || !/^[\x21-\x7e]+$/.test(claims.email)) return "unusable-email";
  const email = cleanEmail(claims.email);
  if (email === null) return "unusable-email";
  const verified = isTrue(claims.email_verified) || (issuedBy(issuer, MICROSOFT_HOST) && isTrue(claims.xms_edov));
  if (!verified) return "unverified-email";
  const given = [claims.given_name, claims.family_name].filter((part) => typeof part === "string").join(" ");
  return { email, name: cleanName(claims.name) ?? cleanName(given) };
}

// --- The provider, over the network ----------------------------------------------

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type Provider = {
  discovery: () => Promise<Discovery>;
  /** The key set, read again when `refresh` and the last reading is old enough. */
  keys: (refresh: boolean) => Promise<Jwk[]>;
  /** The ID token for this code, or an exception that says why not. */
  exchange: (code: string, verifier: string) => Promise<string>;
};

export class ProviderError extends Error {}

async function readJson(response: Response, what: string): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) throw new ProviderError(`${what}: answer too large`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`${what}: answer is not JSON`);
  }
}

/**
 * The provider behind `settings.issuer`. The discovery document and the keys
 * are kept an hour: a provider rotates its keys with weeks of overlap, and an
 * identifier it has just introduced makes the set be read again.
 *
 * Never a redirect followed: every address comes from the configuration or
 * from the discovery document it vouches for.
 */
export function createProvider(settings: Settings, fetcher: Fetcher = fetch, clock: () => number = Date.now): Provider {
  let discovered: { value: Discovery; at: number } | null = null;
  let keySet: { value: Jwk[]; at: number } | null = null;

  async function get(url: string, what: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new ProviderError(`${what}: unreachable`);
    }
    if (!response.ok) throw new ProviderError(`${what}: status ${response.status}`);
    return readJson(response, what);
  }

  async function discovery(): Promise<Discovery> {
    const now = clock();
    if (discovered !== null && now - discovered.at < CACHE_MS) return discovered.value;
    const url = `${settings.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const read = readDiscovery(await get(url, "discovery"), settings.issuer);
    if (typeof read === "string") throw new ProviderError(read);
    discovered = { value: read, at: now };
    return read;
  }

  async function keys(refresh: boolean): Promise<Jwk[]> {
    const now = clock();
    const fresh = keySet !== null && now - keySet.at < CACHE_MS;
    const retryable = keySet === null || now - keySet.at >= KEYS_RETRY_MS;
    if (keySet !== null && fresh && !(refresh && retryable)) return keySet.value;
    const document = await get((await discovery()).jwksUri, "keys");
    keySet = { value: readKeys(document), at: now };
    return keySet.value;
  }

  async function exchange(code: string, verifier: string): Promise<string> {
    const found = await discovery();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: settings.redirectUri,
      code_verifier: verifier,
      client_id: settings.clientId,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    if (found.tokenAuth === "post") {
      body.set("client_secret", settings.clientSecret);
    } else {
      // RFC 6749 form-encodes both before joining them: a secret carrying a
      // colon or a plus would otherwise be read differently by the provider.
      const pair = `${encodeURIComponent(settings.clientId)}:${encodeURIComponent(settings.clientSecret)}`;
      headers.Authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
    }

    let response: Response;
    try {
      response = await fetcher(found.tokenEndpoint, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ProviderError("token: unreachable");
    }
    const answer = await readJson(response, "token");
    if (!response.ok) {
      const error = (answer as { error?: unknown } | null)?.error;
      throw new ProviderError(`token: ${typeof error === "string" ? error.slice(0, 60) : `status ${response.status}`}`);
    }
    const idToken = (answer as { id_token?: unknown } | null)?.id_token;
    if (typeof idToken !== "string") throw new ProviderError("token: no id_token in the answer");
    return idToken;
  }

  return { discovery, keys, exchange };
}

/** `authTime`: the ID token's `auth_time`, when the provider sent one; null otherwise. */
export type SignInResult = { identity: Identity; authTime: number | null } | { refusal: string; email: string | null };

/**
 * The whole verification of a callback: the code exchanged, the token's
 * signature, its claims, the email, and whether that email may sign in.
 * `refusal` is a short code for the log and the page, never a token or a
 * secret.
 */
export async function completeSignIn(
  provider: Provider,
  settings: Settings,
  flow: { code: string; verifier: string; nonce: string },
  nowS: number,
): Promise<SignInResult> {
  let idToken: string;
  try {
    idToken = await provider.exchange(flow.code, flow.verifier);
  } catch (err) {
    return { refusal: err instanceof ProviderError ? "token-exchange" : "provider-unreachable", email: null };
  }

  const parts = splitToken(idToken);
  if (parts === null) return { refusal: "malformed-token", email: null };

  let keys: Jwk[];
  try {
    keys = await provider.keys(false);
    if (candidateKeys(parts.header, keys).length === 0) keys = await provider.keys(true);
  } catch {
    return { refusal: "provider-unreachable", email: null };
  }
  if (!(await verifySignature(parts, keys))) return { refusal: "bad-signature", email: null };

  const refusal = claimsRefusal(parts.claims, { issuer: settings.issuer, clientId: settings.clientId, nonce: flow.nonce, nowS });
  if (refusal !== null) return { refusal, email: null };

  const identity = identityFromClaims(parts.claims, settings.issuer);
  if (typeof identity === "string") return { refusal: identity, email: cleanEmail(parts.claims.email) };
  if (!maySignIn(identity.email, settings.allowedDomains, settings.admins)) {
    return { refusal: "domain-not-allowed", email: identity.email };
  }
  if (!isHostedAccount(parts.claims, settings, identity.email)) {
    return { refusal: "unmanaged-account", email: identity.email };
  }
  const authTime = parts.claims.auth_time;
  return { identity, authTime: typeof authTime === "number" && Number.isSafeInteger(authTime) && authTime >= 0 ? authTime : null };
}

/**
 * With Google and allowed domains, is this account one of those domains' own,
 * managed by their Google Workspace?
 *
 * Google says `email_verified` of any account whose address was once proved,
 * a personal Google account opened with a work address included, and that
 * account outlives the mailbox: someone who left keeps a Google account that
 * still carries `alice@acme.com`, verified. Google is the authority for an
 * address only when the account belongs to a Workspace, which it names in
 * `hd`, the hosted domain. Allowed domains mean "our organization's
 * accounts", so the account's `hd` must be one of them.
 *
 * Only then: an admin email is let in by name, from wherever it comes, and
 * without allowed domains anyone Google vouches for may sign in by design,
 * which is why the README asks for an Internal client with Google. Other
 * providers have no such claim, and vouch for their own directory.
 */
export function isHostedAccount(claims: Record<string, unknown>, settings: Settings, email: string): boolean {
  if (!issuedBy(settings.issuer, GOOGLE_HOST)) return true;
  if (settings.allowedDomains.length === 0 || settings.admins.includes(email)) return true;
  const hd = typeof claims.hd === "string" ? cleanDomain(claims.hd) : null;
  return hd !== null && settings.allowedDomains.includes(hd);
}
