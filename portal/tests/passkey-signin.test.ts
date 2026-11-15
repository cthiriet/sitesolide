import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveKey, issuePasskeyToken, readToken } from "../src/gate";
import { handoffStore } from "../src/handoff";
import { encodePasskeyProjection, passkeyRef, type PasskeyProjection } from "../src/passkeys";
import {
  CEREMONY_SCRIPT,
  ceremonyHeaders,
  createPasskeyReader,
  createPasskeySignIn,
  issuePasskeyFlow,
  passkeyPlace,
  readPasskeyFlow,
  VERIFICATIONS_PER_CLIENT,
} from "../src/passkey-signin";
import { createRoutes } from "../src/routes";
import { b64url, fromB64url, verifyRegistration } from "../src/webauthn";
import { SoftAuthenticator } from "./authenticator";
import { memoryAudit } from "./memory";

const ZONE = "test-zone.invalid";
const PORTAL = `https://portal.${ZONE}`;
const HOST = `kanban.${ZONE}`;
const DOMAIN = "kanban.example.invalid";
const KEY = deriveKey(new Uint8Array(32).fill(5), "$argon2id$sample")!;
const DURATION = 30 * 24 * 3600;
const START = 1_800_000_000_000;

/** A projection file on disk, written as the steward would. */
function projectionFile(credentials: PasskeyProjection["credentials"], rpId = ZONE): { file: string; write: (list: PasskeyProjection["credentials"]) => void; done: () => void } {
  const folder = mkdtempSync(join(tmpdir(), "portal-passkeys-"));
  const file = join(folder, "passkeys.json");
  let n = 0;
  const write = (list: PasskeyProjection["credentials"]) => writeFileSync(file, encodePasskeyProjection({ version: 1, writtenAt: START + n++, rpId, credentials: list }));
  write(credentials);
  return { file, write, done: () => rmSync(folder, { recursive: true, force: true }) };
}

/** A passkey registered for the zone, as the steward keeps its public half. */
async function registered(): Promise<{ key: SoftAuthenticator; projected: PasskeyProjection["credentials"][number] }> {
  const key = await SoftAuthenticator.create(-7);
  const challenge = b64url(new Uint8Array(32).fill(1));
  const made = await key.register({ challenge, origin: `https://dashboard.${ZONE}`, rpId: ZONE });
  const verified = await verifyRegistration(
    { clientDataJSON: fromB64url(made.response.clientDataJSON)!, attestationObject: fromB64url(made.response.attestationObject)! },
    { challenge, origin: `https://dashboard.${ZONE}`, rpId: ZONE },
  );
  return { key, projected: { id: verified.id, publicKey: b64url(verified.publicKey), alg: verified.alg } };
}

function bench(file: string, clock = () => START) {
  const audit = memoryAudit();
  const passkeys = createPasskeyReader({ file, log: () => undefined });
  const handoffs = handoffStore();
  const signIn = createPasskeySignIn({ key: KEY, online: true, place: { origin: PORTAL, rpId: ZONE }, passkeys, handoffs, audit, cookieDurationS: DURATION }, clock);
  const routes = createRoutes(
    {
      key: KEY,
      verifyPassword: async () => false,
      online: true,
      cookieDurationS: DURATION,
      access: { roleOf: () => null, passwordByHash: () => null, passwordById: () => null, state: () => ({ reading: "steward", writtenAt: 0 }) },
      audit,
      passkeys: { offered: signIn.offered, known: (ref) => passkeys.byRef(ref) !== null },
    },
    clock,
  );
  return { audit, signIn, routes, passkeys };
}

const cookieOf = (response: Response, name: string): string | null => {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const [key, value] = pair!.split("=");
    if (key === name) return value ?? "";
  }
  return null;
};

/** The whole road: begin on the site, the ceremony on the portal's host, the code back on the site. */
async function signInThrough(b: ReturnType<typeof bench>, key: SoftAuthenticator, host = HOST, announced = host) {
  const begin = b.signIn.begin(new Request(`https://${host}/_portal/passkey?retour=/board`, { headers: { "X-Portal-Hote": announced } }));
  expect(begin.status).toBe(303);
  const location = new URL(begin.headers.get("location")!);
  expect(location.origin).toBe(PORTAL);
  const flow = location.searchParams.get("flow")!;
  const binding = cookieOf(begin, "__Host-portal-passkey")!;

  const page = b.signIn.page(new Request(location.href));
  expect(page.status).toBe(200);
  const options = await b.signIn.options(new Request(`${PORTAL}/passkey/options`, { method: "POST", headers: { Origin: PORTAL }, body: JSON.stringify({ flow }) }));
  expect(options.status).toBe(200);
  const asked = (await options.json()) as { challengeId: string; publicKey: { challenge: string; rpId: string; userVerification: string; allowCredentials: unknown[] } };
  const credential = await key.sign({ challenge: asked.publicKey.challenge, origin: PORTAL, rpId: asked.publicKey.rpId });
  const verified = await b.signIn.verify(new Request(`${PORTAL}/passkey/verify`, { method: "POST", headers: { Origin: PORTAL }, body: JSON.stringify({ flow, challengeId: asked.challengeId, credential }) }));
  return { asked, verified, binding, flow };
}

describe("where the ceremony runs", () => {
  test("the portal's own origin, the zone as relying party, from its address", () => {
    expect(passkeyPlace(PORTAL)).toEqual({ origin: PORTAL, rpId: ZONE });
    expect(passkeyPlace(`https://signin.${ZONE}`)).toBeNull();
    expect(passkeyPlace(`https://signin.${ZONE}`, ZONE)).toEqual({ origin: `https://signin.${ZONE}`, rpId: ZONE });
    // A relying party the page's host does not fall under is refused, as a browser would.
    expect(passkeyPlace(PORTAL, "example.invalid")).toBeNull();
    expect(passkeyPlace("")).toBeNull();
    expect(passkeyPlace(`http://portal.${ZONE}`)).toBeNull();
  });

  test("the ceremony page allows its one script by hash, its requests to its own host, and no form", () => {
    const csp = ceremonyHeaders()["Content-Security-Policy"]!;
    const hash = new Bun.CryptoHasher("sha256").update(CEREMONY_SCRIPT).digest("base64");
    expect(csp).toContain(`script-src 'sha256-${hash}'`);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(CEREMONY_SCRIPT).not.toContain("</script");
    expect(CEREMONY_SCRIPT).toContain('userVerification: "required"');
  });
});

describe("a passkey sign-in, site to portal and back", () => {
  test("lets the owner in on that host alone, with a cookie naming the passkey", async () => {
    const { key, projected } = await registered();
    const projection = projectionFile([projected]);
    try {
      const b = bench(projection.file);
      const { asked, verified, binding } = await signInThrough(b, key);
      expect(asked.publicKey).toMatchObject({ rpId: ZONE, userVerification: "required", allowCredentials: [] });
      expect(verified.status).toBe(200);
      const { location } = (await verified.json()) as { location: string };
      expect(location.startsWith(`https://${HOST}/_portal/passkey/complete?code=`)).toBe(true);

      const complete = b.signIn.complete(new Request(location, { headers: { "X-Portal-Hote": HOST, Cookie: `__Host-portal-passkey=${binding}` } }));
      expect(complete.status).toBe(303);
      expect(complete.headers.get("location")).toBe("/board");
      const cookie = cookieOf(complete, "__Host-portal")!;
      expect(readToken(cookie, KEY, HOST, START / 1000, DURATION)).toEqual({ guest: null, passkey: passkeyRef(projected.id) });
      // Host-bound: worth nothing on another site.
      expect(readToken(cookie, KEY, `roster.${ZONE}`, START / 1000, DURATION)).toBeNull();
      expect(b.audit.events.at(-1)).toMatchObject({ actor: "owner", action: "portal.signin", target: HOST, detail: { method: "passkey" } });

      // The gate lets the cookie through as the owner, admin.
      const gate = b.routes.verify(new Request("http://127.0.0.1/verifier", { headers: { "X-Portal-Hote": HOST, Cookie: `__Host-portal=${cookie}` } }));
      expect(gate.status).toBe(200);
      expect(gate.headers.get("X-Sitesolide-Role")).toBe("admin");

      // The passkey removed: the cookie closes at the next request.
      projection.write([]);
      const after = b.routes.verify(new Request("http://127.0.0.1/verifier", { headers: { "X-Portal-Hote": HOST, Cookie: `__Host-portal=${cookie}` } }));
      expect(after.status).toBe(401);
    } finally {
      projection.done();
    }
  });

  test("a site on its own domain takes the same road, the ceremony still on the portal's host", async () => {
    const { key, projected } = await registered();
    const projection = projectionFile([projected]);
    try {
      const b = bench(projection.file);
      const { verified, binding } = await signInThrough(b, key, DOMAIN, `${DOMAIN} ${HOST}`);
      const { location } = (await verified.json()) as { location: string };
      expect(location.startsWith(`https://${DOMAIN}/_portal/passkey/complete?code=`)).toBe(true);
      const complete = b.signIn.complete(new Request(location, { headers: { "X-Portal-Hote": `${DOMAIN} ${HOST}`, Cookie: `__Host-portal-passkey=${binding}` } }));
      expect(complete.status).toBe(303);
      expect(readToken(cookieOf(complete, "__Host-portal")!, KEY, DOMAIN, START / 1000, DURATION)?.passkey).toBe(passkeyRef(projected.id));
    } finally {
      projection.done();
    }
  });

  test("the code is the browser's that began, on the host it was minted for, once", async () => {
    const { key, projected } = await registered();
    const projection = projectionFile([projected]);
    try {
      const b = bench(projection.file);
      const first = await signInThrough(b, key);
      const { location } = (await first.verified.json()) as { location: string };
      // Another browser, without the binding: refused, and the code burnt.
      expect(b.signIn.complete(new Request(location, { headers: { "X-Portal-Hote": HOST } })).status).toBe(400);
      expect(b.signIn.complete(new Request(location, { headers: { "X-Portal-Hote": HOST, Cookie: `__Host-portal-passkey=${first.binding}` } })).status).toBe(400);

      const second = await signInThrough(b, key);
      const again = ((await second.verified.json()) as { location: string }).location;
      const elsewhere = b.signIn.complete(new Request(again.replace(HOST, `roster.${ZONE}`), { headers: { "X-Portal-Hote": `roster.${ZONE}`, Cookie: `__Host-portal-passkey=${second.binding}` } }));
      expect(elsewhere.status).toBe(400);
    } finally {
      projection.done();
    }
  });

  test("refuses an assertion made on another origin: a hosted site cannot run the ceremony for the portal", async () => {
    const { key, projected } = await registered();
    const projection = projectionFile([projected]);
    try {
      const b = bench(projection.file);
      const flow = issuePasskeyFlow(KEY, { host: HOST, returnTo: "/", binding: "b".repeat(43) }, START / 1000);
      const options = await b.signIn.options(new Request(`${PORTAL}/passkey/options`, { method: "POST", headers: { Origin: PORTAL }, body: JSON.stringify({ flow }) }));
      const asked = (await options.json()) as { challengeId: string; publicKey: { challenge: string } };
      // The owner tricked into a prompt on a compromised site under the zone: the browser writes that site's origin.
      const credential = await key.sign({ challenge: asked.publicKey.challenge, origin: `https://${HOST}`, rpId: ZONE });
      const verified = await b.signIn.verify(new Request(`${PORTAL}/passkey/verify`, { method: "POST", headers: { Origin: PORTAL }, body: JSON.stringify({ flow, challengeId: asked.challengeId, credential }) }));
      expect(verified.status).toBe(401);
      expect(b.audit.events.at(-1)).toMatchObject({ action: "portal.signin_failed", detail: { method: "passkey", reason: "the origin is not this service's" } });
    } finally {
      projection.done();
    }
  });

  test("refuses another Origin, an unknown passkey, a user not verified, a spent challenge and a forged flow", async () => {
    const { key, projected } = await registered();
    const stranger = await SoftAuthenticator.create(-7);
    const projection = projectionFile([projected]);
    try {
      const b = bench(projection.file);
      const flow = issuePasskeyFlow(KEY, { host: HOST, returnTo: "/", binding: "c".repeat(43) }, START / 1000);
      const post = (path: string, body: unknown, origin = PORTAL) =>
        path.endsWith("options") ? b.signIn.options(new Request(`${PORTAL}${path}`, { method: "POST", headers: { Origin: origin }, body: JSON.stringify(body) })) : b.signIn.verify(new Request(`${PORTAL}${path}`, { method: "POST", headers: { Origin: origin }, body: JSON.stringify(body) }));
      expect((await post("/passkey/options", { flow }, `https://${HOST}`)).status).toBe(403);
      expect((await post("/passkey/options", { flow: "forged.flow" })).status).toBe(400);

      const ask = async () => (await (await post("/passkey/options", { flow })).json()) as { challengeId: string; publicKey: { challenge: string } };
      let asked = await ask();
      const unknown = await stranger.sign({ challenge: asked.publicKey.challenge, origin: PORTAL, rpId: ZONE });
      expect((await post("/passkey/verify", { flow, challengeId: asked.challengeId, credential: unknown })).status).toBe(401);
      expect(b.audit.events.at(-1)?.detail).toMatchObject({ reason: "unknown-passkey" });

      asked = await ask();
      const unverified = await key.sign({ challenge: asked.publicKey.challenge, origin: PORTAL, rpId: ZONE, flags: { uv: false } });
      expect((await post("/passkey/verify", { flow, challengeId: asked.challengeId, credential: unverified })).status).toBe(401);
      expect(b.audit.events.at(-1)?.detail).toMatchObject({ reason: "the user was not verified" });

      // The challenge went with the failed attempt.
      const good = await key.sign({ challenge: asked.publicKey.challenge, origin: PORTAL, rpId: ZONE });
      expect((await post("/passkey/verify", { flow, challengeId: asked.challengeId, credential: good })).status).toBe(401);
      expect(b.audit.events.at(-1)?.detail).toMatchObject({ reason: "no-challenge" });

      // A challenge asked for one flow does not serve another.
      asked = await ask();
      const other = issuePasskeyFlow(KEY, { host: HOST, returnTo: "/", binding: "d".repeat(43) }, START / 1000);
      const signed = await key.sign({ challenge: asked.publicKey.challenge, origin: PORTAL, rpId: ZONE });
      expect((await post("/passkey/verify", { flow: other, challengeId: asked.challengeId, credential: signed })).status).toBe(401);
    } finally {
      projection.done();
    }
  });

  test("a projection for another relying party, or none, offers nothing", async () => {
    const { projected } = await registered();
    const projection = projectionFile([projected], "elsewhere.invalid");
    try {
      const b = bench(projection.file);
      expect(b.signIn.offered()).toBe(false);
      const begin = b.signIn.begin(new Request(`https://${HOST}/_portal/passkey`, { headers: { "X-Portal-Hote": HOST } }));
      expect(begin.status).toBe(404);
      projection.write([]);
      expect(b.signIn.offered()).toBe(false);
    } finally {
      projection.done();
    }
    const missing = bench("/nonexistent/passkeys.json");
    expect(missing.signIn.offered()).toBe(false);
  });

  test("the sign-in page offers the passkey once one is projected", async () => {
    const { projected } = await registered();
    const projection = projectionFile([projected]);
    try {
      const b = bench(projection.file);
      const door = await b.routes.verify(new Request("http://127.0.0.1/verifier", { headers: { "X-Portal-Hote": HOST } })).text();
      expect(door).toContain('href="/_portal/passkey?retour=%2F"');
      expect(door).toContain("Sign in with a passkey");
      projection.write([]);
      const without = await b.routes.verify(new Request("http://127.0.0.1/verifier", { headers: { "X-Portal-Hote": HOST } })).text();
      expect(without).not.toContain("passkey");
    } finally {
      projection.done();
    }
  });

  test("verifications are bounded per minute and per client: a stranger's flood leaves the owner's address free", async () => {
    const projection = projectionFile([]);
    try {
      let now = START;
      const b = bench(projection.file, () => now);
      const flow = issuePasskeyFlow(KEY, { host: HOST, returnTo: "/", binding: "e".repeat(43) }, START / 1000);
      const verify = (from: string) =>
        b.signIn.verify(new Request(`${PORTAL}/passkey/verify`, { method: "POST", headers: { Origin: PORTAL, "X-Forwarded-For": from }, body: JSON.stringify({ flow }) }));
      for (let i = 0; i < VERIFICATIONS_PER_CLIENT; i += 1) expect((await verify("203.0.113.66")).status).toBe(401);
      expect((await verify("203.0.113.66")).status).toBe(429);
      expect((await verify("198.51.100.7")).status).toBe(401);
      now += 60_000;
      expect((await verify("203.0.113.66")).status).toBe(401);
    } finally {
      projection.done();
    }
  });
});

describe("the flow and the cookie", () => {
  test("a flow is sealed for its own purpose and lapses", () => {
    const flow = issuePasskeyFlow(KEY, { host: HOST, returnTo: "/x", binding: "f".repeat(43) }, 1000);
    expect(readPasskeyFlow(KEY, flow, 1001)).toEqual({ host: HOST, returnTo: "/x", binding: "f".repeat(43) });
    expect(readPasskeyFlow(KEY, flow, 1000 + 601)).toBeNull();
    expect(readPasskeyFlow(deriveKey(new Uint8Array(32).fill(6), "$argon2id$other")!, flow, 1001)).toBeNull();
  });

  test("a passkey's cookie lives the owner's thirty days, and its reference is signed", () => {
    const ref = passkeyRef("credential");
    const token = issuePasskeyToken(KEY, HOST, 1000 + DURATION, ref);
    expect(readToken(token, KEY, HOST, 1000, DURATION, 24 * 3600)).toEqual({ guest: null, passkey: ref });
    const swapped = token.replace(ref, passkeyRef("another"));
    expect(readToken(swapped, KEY, HOST, 1000, DURATION, 24 * 3600)).toBeNull();
    expect(readToken(issuePasskeyToken(KEY, HOST, 1000 + DURATION + 1, ref), KEY, HOST, 1000, DURATION)).toBeNull();
  });
});

