import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CLOCK_SKEW_S,
  FLOW_DURATION_S,
  authorizationUrl,
  candidateKeys,
  claimsRefusal,
  codeChallenge,
  completeSignIn,
  createProvider,
  identityFromClaims,
  isAcceptableUrl,
  readDiscovery,
  readKeys,
  readSettings,
  splitToken,
  verifySignature,
  type Discovery,
  type Settings,
} from "../src/oidc";
import { makeSigner, startProvider, type MockProvider, type Signer } from "./provider";

const ISSUER = "https://idp.test-zone.invalid";
const PUBLIC_URL = "https://portal.test-zone.invalid";
const NOW = 1_800_000_000;

const ENV = {
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: "client-1",
  OIDC_CLIENT_SECRET: "not-a-real-secret",
  OIDC_ALLOWED_DOMAINS: "acme.test",
  OIDC_ADMIN_EMAILS: "Owner@acme.test",
};

describe("the settings", () => {
  test("absent, signing in with a provider is not offered and nothing is said", () => {
    expect(readSettings({}, PUBLIC_URL)).toEqual({ settings: null, problems: [] });
    expect(readSettings({}, "")).toEqual({ settings: null, problems: [] });
  });

  test("complete, they give the callback the provider must know", () => {
    const { settings, problems } = readSettings(ENV, PUBLIC_URL);
    expect(problems).toEqual([]);
    expect(settings).toEqual({
      issuer: ISSUER,
      clientId: "client-1",
      clientSecret: "not-a-real-secret",
      allowedDomains: ["acme.test"],
      admins: ["owner@acme.test"],
      providerName: "your work account",
      redirectUri: "https://portal.test-zone.invalid/oidc/callback",
      portalOrigin: "https://portal.test-zone.invalid",
    });
  });

  test("half there, nothing is offered and the problems are named, never a value", () => {
    const { settings, problems } = readSettings({ OIDC_ISSUER: ISSUER, OIDC_CLIENT_SECRET: "hidden-value" }, PUBLIC_URL);
    expect(settings).toBeNull();
    expect(problems).toEqual(["OIDC_CLIENT_ID is missing"]);
    expect(JSON.stringify(problems)).not.toInclude("hidden-value");
  });

  test("without the portal's own address there is no callback, so nothing is offered", () => {
    expect(readSettings(ENV, "").settings).toBeNull();
    expect(readSettings(ENV, "http://portal.test-zone.invalid").settings).toBeNull();
  });

  test("a plain HTTP issuer is refused, except on the loopback where the tests run theirs", () => {
    expect(readSettings({ ...ENV, OIDC_ISSUER: "http://idp.test-zone.invalid" }, PUBLIC_URL).settings).toBeNull();
    expect(readSettings({ ...ENV, OIDC_ISSUER: "http://127.0.0.1:9" }, "http://127.0.0.1:8").settings).not.toBeNull();
  });

  test("a bad admin address is dropped and named, the others still count", () => {
    const { settings, problems } = readSettings({ ...ENV, OIDC_ADMIN_EMAILS: "owner@acme.test nobody" }, PUBLIC_URL);
    expect(settings?.admins).toEqual(["owner@acme.test"]);
    expect(problems).toEqual(['OIDC_ADMIN_EMAILS: ignored "nobody", not an email']);
  });

  test("the button names the provider when its issuer says who it is, or as configured", () => {
    expect(readSettings({ ...ENV, OIDC_ISSUER: "https://accounts.google.com" }, PUBLIC_URL).settings?.providerName).toBe("Google");
    expect(
      readSettings({ ...ENV, OIDC_ISSUER: "https://login.microsoftonline.com/tenant/v2.0" }, PUBLIC_URL).settings?.providerName,
    ).toBe("Microsoft");
    expect(readSettings({ ...ENV, OIDC_PROVIDER_NAME: "Acme SSO" }, PUBLIC_URL).settings?.providerName).toBe("Acme SSO");
  });

  test("an acceptable address: HTTPS, or HTTP on the loopback, never credentials or a fragment", () => {
    expect(isAcceptableUrl("https://idp.test-zone.invalid/x")).toBe(true);
    expect(isAcceptableUrl("http://localhost:4000")).toBe(true);
    for (const url of ["http://idp.test-zone.invalid", "https://u:p@idp.test-zone.invalid", "https://idp.test-zone.invalid/#x", "ftp://x.test", "", 3]) {
      expect(isAcceptableUrl(url)).toBe(false);
    }
  });
});

const DOCUMENT = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
  response_types_supported: ["code", "id_token"],
  code_challenge_methods_supported: ["plain", "S256"],
  token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
};

describe("the discovery document", () => {
  test("gives the endpoints, and client_secret_basic when it is offered", () => {
    expect(readDiscovery(DOCUMENT, ISSUER)).toEqual({
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/token`,
      jwksUri: `${ISSUER}/jwks`,
      tokenAuth: "basic",
    });
    expect((readDiscovery({ ...DOCUMENT, token_endpoint_auth_methods_supported: ["client_secret_post"] }, ISSUER) as Discovery).tokenAuth).toBe("post");
  });

  test("must name the configured issuer to the character", () => {
    expect(readDiscovery({ ...DOCUMENT, issuer: `${ISSUER}/` }, ISSUER)).toBeString();
    expect(readDiscovery({ ...DOCUMENT, issuer: "https://login.microsoftonline.com/{tenantid}/v2.0" }, ISSUER)).toBeString();
  });

  test("refuses endpoints in clear text and providers without PKCE S256 or a usable secret method", () => {
    expect(readDiscovery({ ...DOCUMENT, token_endpoint: "http://idp.test-zone.invalid/token" }, ISSUER)).toBeString();
    expect(readDiscovery({ ...DOCUMENT, code_challenge_methods_supported: ["plain"] }, ISSUER)).toBeString();
    expect(readDiscovery({ ...DOCUMENT, response_types_supported: ["id_token"] }, ISSUER)).toBeString();
    expect(readDiscovery({ ...DOCUMENT, token_endpoint_auth_methods_supported: ["private_key_jwt"] }, ISSUER)).toBeString();
    expect(readDiscovery(null, ISSUER)).toBeString();
  });

  test("a provider that lists no challenge method is trusted with S256, as Entra is", () => {
    const { code_challenge_methods_supported: _, ...entra } = DOCUMENT;
    expect(readDiscovery(entra, ISSUER)).not.toBeString();
  });
});

describe("the authorization request", () => {
  const settings = readSettings(ENV, PUBLIC_URL).settings!;
  const discovery = readDiscovery(DOCUMENT, ISSUER) as Discovery;
  const secrets = { state: "s".repeat(22), nonce: "n".repeat(22), verifier: "v".repeat(43) };

  test("asks for a code with PKCE S256, the state, the nonce and the one callback", () => {
    const url = new URL(authorizationUrl(discovery, settings, secrets, false));
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: "https://portal.test-zone.invalid/oidc/callback",
      scope: "openid email profile",
      state: secrets.state,
      nonce: secrets.nonce,
      code_challenge: codeChallenge(secrets.verifier),
      code_challenge_method: "S256",
    });
  });

  test("asks which account only when the person wants another one", () => {
    expect(new URL(authorizationUrl(discovery, settings, secrets, true)).searchParams.get("prompt")).toBe("select_account");
  });

  test("the challenge is RFC 7636's own example", () => {
    expect(codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("the ID token's signature", () => {
  let rsa: Signer;
  let ec: Signer;
  let stranger: Signer;

  beforeAll(async () => {
    rsa = await makeSigner("RS256", "rsa-1");
    ec = await makeSigner("ES256", "ec-1");
    stranger = await makeSigner("RS256", "rsa-1");
  });

  test("RS256 and ES256 verify against the published keys", async () => {
    const keys = readKeys({ keys: [rsa.publicJwk, ec.publicJwk] });
    for (const signer of [rsa, ec]) {
      const parts = splitToken(await signer.sign({ sub: "x" }))!;
      expect(await verifySignature(parts, keys)).toBe(true);
    }
  });

  test("a key that is not published verifies nothing, even under a known identifier", async () => {
    const keys = readKeys({ keys: [rsa.publicJwk] });
    expect(await verifySignature(splitToken(await stranger.sign({ sub: "x" }))!, keys)).toBe(false);
  });

  test("a claim changed after signing breaks the signature", async () => {
    const keys = readKeys({ keys: [rsa.publicJwk] });
    const [header, , signature] = (await rsa.sign({ email: "alice@acme.test" })).split(".");
    const forged = Buffer.from(JSON.stringify({ email: "ceo@acme.test" })).toString("base64url");
    expect(await verifySignature(splitToken(`${header}.${forged}.${signature}`)!, keys)).toBe(false);
  });

  test("none and HS256 are refused, whatever the signature says", async () => {
    const keys = readKeys({ keys: [rsa.publicJwk] });
    for (const alg of ["none", "HS256"]) {
      const parts = splitToken(await rsa.sign({ sub: "x" }, { alg }))!;
      expect(await verifySignature(parts, keys)).toBe(false);
      expect(candidateKeys(parts.header, keys)).toEqual([]);
    }
  });

  test("an RSA key does not verify an ES256 header, nor a P-256 key an RS256 one", async () => {
    const keys = readKeys({ keys: [{ ...rsa.publicJwk, kid: "same" }, { ...ec.publicJwk, kid: "same" }] });
    expect(candidateKeys({ alg: "ES256", kid: "same" }, keys).map((key) => key.kty)).toEqual(["EC"]);
    expect(candidateKeys({ alg: "RS256", kid: "same" }, keys).map((key) => key.kty)).toEqual(["RSA"]);
  });

  test("the key set keeps signing keys only, of a decent size", () => {
    const keys = readKeys({
      keys: [
        rsa.publicJwk,
        { ...rsa.publicJwk, use: "enc", kid: "enc" },
        { kty: "RSA", kid: "short", n: "AQAB", e: "AQAB" },
        { kty: "oct", k: "c2VjcmV0" },
        { ...ec.publicJwk, crv: "P-521", kid: "p521" },
      ],
    });
    expect(keys.map((key) => key.kid)).toEqual(["rsa-1"]);
    expect(readKeys(null)).toEqual([]);
    expect(readKeys({ keys: "x" })).toEqual([]);
  });

  test("a malformed token is refused before anything else", () => {
    for (const token of [null, "", "a.b", "a.b.c.d", "!!.e30.x", `e30.${"x".repeat(20_000)}.x`]) {
      expect(splitToken(token)).toBeNull();
    }
  });
});

describe("the ID token's claims", () => {
  const expected = { issuer: ISSUER, clientId: "client-1", nonce: "nonce-123456789012345678", nowS: NOW };
  const good = {
    iss: ISSUER,
    aud: "client-1",
    sub: "subject",
    nonce: expected.nonce,
    iat: NOW - 5,
    exp: NOW + 300,
  };

  test("a good token passes", () => {
    expect(claimsRefusal(good, expected)).toBeNull();
    expect(claimsRefusal({ ...good, aud: ["client-1"] }, expected)).toBeNull();
    expect(claimsRefusal({ ...good, aud: ["client-1", "other"], azp: "client-1" }, expected)).toBeNull();
  });

  test("another issuer, another audience, another authorized party", () => {
    expect(claimsRefusal({ ...good, iss: `${ISSUER}/` }, expected)).toBe("wrong-issuer");
    expect(claimsRefusal({ ...good, aud: "other" }, expected)).toBe("wrong-audience");
    expect(claimsRefusal({ ...good, aud: ["client-1", "other"] }, expected)).toBe("wrong-audience");
    expect(claimsRefusal({ ...good, azp: "other" }, expected)).toBe("wrong-audience");
    expect(claimsRefusal({ ...good, aud: undefined }, expected)).toBe("wrong-audience");
  });

  test("expired, with a minute of tolerance for clocks and not one second more", () => {
    expect(claimsRefusal({ ...good, exp: NOW - CLOCK_SKEW_S + 1 }, expected)).toBeNull();
    expect(claimsRefusal({ ...good, exp: NOW - CLOCK_SKEW_S }, expected)).toBe("expired");
    expect(claimsRefusal({ ...good, exp: undefined }, expected)).toBe("expired");
  });

  test("issued in the future, or longer ago than a sign-in lasts", () => {
    expect(claimsRefusal({ ...good, iat: NOW + CLOCK_SKEW_S }, expected)).toBeNull();
    expect(claimsRefusal({ ...good, iat: NOW + CLOCK_SKEW_S + 1 }, expected)).toBe("issued-in-future");
    expect(claimsRefusal({ ...good, iat: NOW - FLOW_DURATION_S - CLOCK_SKEW_S - 1 }, expected)).toBe("expired");
    expect(claimsRefusal({ ...good, iat: "now" }, expected)).toBe("issued-in-future");
    expect(claimsRefusal({ ...good, nbf: NOW + 3600 }, expected)).toBe("not-yet-valid");
  });

  test("the nonce must be this flow's, and a subject must be there", () => {
    expect(claimsRefusal({ ...good, nonce: "another-nonce-1234567890" }, expected)).toBe("wrong-nonce");
    expect(claimsRefusal({ ...good, nonce: undefined }, expected)).toBe("wrong-nonce");
    expect(claimsRefusal({ ...good, sub: "" }, expected)).toBe("no-subject");
  });

  test("an email the provider verified, the Entra way included", () => {
    expect(identityFromClaims({ email: "Alice@Acme.test", email_verified: true, name: "Alice" })).toEqual({
      email: "alice@acme.test",
      name: "Alice",
    });
    expect(identityFromClaims({ email: "alice@acme.test", email_verified: "true" })).toEqual({ email: "alice@acme.test", name: null });
    expect(identityFromClaims({ email: "alice@acme.test", xms_edov: true, given_name: "Alice", family_name: "Martin" })).toEqual({
      email: "alice@acme.test",
      name: "Alice Martin",
    });
  });

  test("no email, or one nobody verified, is no identity", () => {
    expect(identityFromClaims({ email_verified: true })).toBe("no-email");
    expect(identityFromClaims({ email: "alice@acme.test" })).toBe("unverified-email");
    expect(identityFromClaims({ email: "alice@acme.test", email_verified: false })).toBe("unverified-email");
    expect(identityFromClaims({ email: "alice@acme.test", email_verified: "false", xms_edov: false })).toBe("unverified-email");
  });
});

describe("the provider, over HTTP", () => {
  let provider: MockProvider;
  let settings: Settings;

  beforeAll(async () => {
    provider = await startProvider({ alg: "ES256" });
    settings = readSettings(
      {
        OIDC_ISSUER: provider.url,
        OIDC_CLIENT_ID: provider.clientId,
        OIDC_CLIENT_SECRET: provider.clientSecret,
        OIDC_ALLOWED_DOMAINS: "acme.test",
      },
      "http://127.0.0.1:8",
    ).settings!;
  });

  afterAll(() => provider.stop());

  /** A code as the provider's authorization endpoint hands it out, for this verifier and nonce. */
  async function code(verifier: string, nonce: string): Promise<string> {
    const url = new URL(`${provider.url}/authorize`);
    url.search = new URLSearchParams({
      client_id: provider.clientId,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: codeChallenge(verifier),
      redirect_uri: settings.redirectUri,
      state: "s".repeat(22),
      nonce,
    }).toString();
    const response = await fetch(url, { redirect: "manual" });
    return new URL(response.headers.get("location")!).searchParams.get("code")!;
  }

  const verifier = "v".repeat(43);
  const nonce = "n".repeat(22);

  test("exchanges a code for a verified identity, the secret sent in a Basic header", async () => {
    const result = await completeSignIn(createProvider(settings), settings, { code: await code(verifier, nonce), verifier, nonce }, Math.floor(Date.now() / 1000));
    expect(result).toEqual({ identity: { email: "alice@acme.test", name: "Alice Martin" } });
    const last = provider.tokenRequests.at(-1)!;
    expect(last.auth).toStartWith("Basic ");
    expect(last.body.get("client_secret")).toBeNull();
    expect(last.body.get("code_verifier")).toBe(verifier);
  });

  test("a code exchanged with another verifier is refused by the provider", async () => {
    const result = await completeSignIn(createProvider(settings), settings, { code: await code(verifier, nonce), verifier: "w".repeat(43), nonce }, Math.floor(Date.now() / 1000));
    expect(result).toEqual({ refusal: "token-exchange", email: null });
  });

  test("a disallowed domain is refused, and named for the audit", async () => {
    provider.next = { email: "eve@elsewhere.test" };
    const result = await completeSignIn(createProvider(settings), settings, { code: await code(verifier, nonce), verifier, nonce }, Math.floor(Date.now() / 1000));
    expect(result).toEqual({ refusal: "domain-not-allowed", email: "eve@elsewhere.test" });
  });

  test("a key the provider has just introduced makes the key set be read again, once a minute at most", async () => {
    let clock = 1_000_000;
    const client = createProvider(settings, fetch, () => clock);
    await completeSignIn(client, settings, { code: await code(verifier, nonce), verifier, nonce }, Math.floor(Date.now() / 1000));
    const rotated = await makeSigner("ES256", "key-2");
    provider.signers = [rotated, ...provider.signers];
    try {
      const tooSoon = await completeSignIn(client, settings, { code: await code(verifier, nonce), verifier, nonce }, Math.floor(Date.now() / 1000));
      expect(tooSoon).toEqual({ refusal: "bad-signature", email: null });
      clock += 61_000;
      const result = await completeSignIn(client, settings, { code: await code(verifier, nonce), verifier, nonce }, Math.floor(Date.now() / 1000));
      expect(result).toEqual({ identity: { email: "alice@acme.test", name: "Alice Martin" } });
    } finally {
      provider.signers = provider.signers.slice(1);
    }
  });

  test("an unreachable provider is said unreachable, not refused", async () => {
    const gone = readSettings({ ...{ OIDC_ISSUER: "http://127.0.0.1:9", OIDC_CLIENT_ID: "x", OIDC_CLIENT_SECRET: "y" } }, "http://127.0.0.1:8").settings!;
    const result = await completeSignIn(createProvider(gone), gone, { code: "c", verifier, nonce }, NOW);
    expect(result).toEqual({ refusal: "token-exchange", email: null });
    await expect(createProvider(gone).discovery()).rejects.toThrow("discovery: unreachable");
  });
});
