/**
 * An identity provider for the tests: a real HTTP server on a random port,
 * which serves a discovery document, a key set and a token endpoint, and signs
 * its ID tokens with a key drawn at startup. Its authorization endpoint signs
 * in at once whoever the test chose, the way a provider does for a person
 * already signed in there.
 *
 * It checks what a real provider checks, the client's secret, the redirect
 * address, the PKCE verifier against the challenge, a code used once, so that
 * a portal skipping one of them fails here. And it misbehaves on demand,
 * through `next`: another key, another audience, an expired token, a nonce of
 * its own, an address it did not verify.
 *
 * Asked for `max_age`, it says when the person signed in, `auth_time`, as the
 * specification requires: now, since it signs them in at once. A test makes
 * it lie with `next.claims`, or keep quiet with `next.without`.
 */
import type { Server } from "bun";

export type Algorithm = "RS256" | "ES256";

export type Signer = {
  alg: Algorithm;
  kid: string;
  publicJwk: JsonWebKey;
  sign: (claims: Record<string, unknown>, header?: Record<string, unknown>) => Promise<string>;
};

type JsonWebKey = Record<string, unknown>;

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export async function makeSigner(alg: Algorithm, kid: string): Promise<Signer> {
  const params =
    alg === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }
      : { name: "ECDSA", namedCurve: "P-256" };
  const pair = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const signParams = alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };
  return {
    alg,
    kid,
    publicJwk: { ...publicJwk, kid, alg, use: "sig" },
    async sign(claims, header = {}) {
      const signed = `${b64({ alg, kid, typ: "JWT", ...header })}.${b64(claims)}`;
      const signature = await crypto.subtle.sign(signParams, pair.privateKey, new TextEncoder().encode(signed));
      return `${signed}.${Buffer.from(signature).toString("base64url")}`;
    },
  };
}

/** Who signs in at the provider, and how the provider misbehaves this once. */
export type Next = {
  email?: string;
  name?: string | null;
  /** Merged over the claims the provider would send. */
  claims?: Record<string, unknown>;
  /** Removed from those claims. */
  without?: string[];
  /** Signs with this key instead of the published one. */
  signer?: Signer;
  /** Merged over the token's header. */
  header?: Record<string, unknown>;
  /** The authorization endpoint answers with this error instead of a code. */
  error?: string;
};

export type MockProvider = {
  url: string;
  clientId: string;
  clientSecret: string;
  /** Every published key; the first signs. */
  signers: Signer[];
  next: Next;
  /** What the token endpoint received, for the tests that check the client's manners. */
  tokenRequests: { auth: string | null; body: URLSearchParams }[];
  stop: () => void;
};

export async function startProvider(
  options: { alg?: Algorithm; tokenAuth?: string[] } = {},
): Promise<MockProvider> {
  const signer = await makeSigner(options.alg ?? "RS256", "key-1");
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; maxAge: string | null; next: Next }>();
  const tokenRequests: MockProvider["tokenRequests"] = [];
  let server: Server<undefined> | null = null;

  const provider: MockProvider = {
    url: "",
    clientId: "portal-test-client",
    clientSecret: "test-secret-only:for+tests",
    signers: [signer],
    next: {},
    tokenRequests,
    stop: () => server?.stop(true),
  };

  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      "/.well-known/openid-configuration": () =>
        Response.json({
          issuer: provider.url,
          authorization_endpoint: `${provider.url}/authorize`,
          token_endpoint: `${provider.url}/token`,
          jwks_uri: `${provider.url}/jwks`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: options.tokenAuth ?? ["client_secret_basic", "client_secret_post"],
        }),

      "/jwks": () => Response.json({ keys: provider.signers.map((one) => one.publicJwk) }),

      "/authorize": (req) => {
        const params = new URL(req.url).searchParams;
        const redirectUri = params.get("redirect_uri") ?? "";
        if (params.get("client_id") !== provider.clientId) return new Response("unknown client", { status: 400 });
        if (params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256") {
          return new Response("unsupported request", { status: 400 });
        }
        const back = new URL(redirectUri);
        back.searchParams.set("state", params.get("state") ?? "");
        back.searchParams.set("iss", provider.url);
        const next = provider.next;
        provider.next = {};
        if (next.error !== undefined) {
          back.searchParams.set("error", next.error);
        } else {
          const code = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
          codes.set(code, {
            nonce: params.get("nonce") ?? "",
            challenge: params.get("code_challenge") ?? "",
            redirectUri,
            maxAge: params.get("max_age"),
            next,
          });
          back.searchParams.set("code", code);
        }
        return new Response(null, { status: 302, headers: { Location: back.toString() } });
      },

      "/token": {
        POST: async (req) => {
          const body = new URLSearchParams(await req.text());
          const auth = req.headers.get("authorization");
          tokenRequests.push({ auth, body });

          let id: string | null = null;
          let secret: string | null = null;
          if (auth !== null && auth.startsWith("Basic ")) {
            const [rawId, rawSecret] = Buffer.from(auth.slice(6), "base64").toString().split(":");
            id = decodeURIComponent(rawId ?? "");
            secret = decodeURIComponent(rawSecret ?? "");
          } else {
            id = body.get("client_id");
            secret = body.get("client_secret");
          }
          if (id !== provider.clientId || secret !== provider.clientSecret) {
            return Response.json({ error: "invalid_client" }, { status: 401 });
          }

          const code = body.get("code") ?? "";
          const grant = codes.get(code);
          codes.delete(code);
          if (body.get("grant_type") !== "authorization_code" || grant === undefined) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          if (body.get("redirect_uri") !== grant.redirectUri) return Response.json({ error: "invalid_grant" }, { status: 400 });
          const challenge = new Bun.CryptoHasher("sha256").update(body.get("code_verifier") ?? "").digest("base64url");
          if (challenge !== grant.challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });

          const now = Math.floor(Date.now() / 1000);
          const next = grant.next;
          const claims: Record<string, unknown> = {
            iss: provider.url,
            aud: provider.clientId,
            sub: "subject-123",
            email: next.email ?? "alice@acme.test",
            email_verified: true,
            name: next.name === undefined ? "Alice Martin" : next.name,
            nonce: grant.nonce,
            iat: now,
            exp: now + 300,
            ...(grant.maxAge === null ? {} : { auth_time: now }),
            ...next.claims,
          };
          for (const name of next.without ?? []) delete claims[name];
          const idToken = await (next.signer ?? provider.signers[0]!).sign(claims, next.header);
          return Response.json({ access_token: "opaque", token_type: "Bearer", id_token: idToken });
        },
      },
    },
    fetch: () => new Response("not found", { status: 404 }),
  });

  provider.url = `http://127.0.0.1:${server.port}`;
  return provider;
}
