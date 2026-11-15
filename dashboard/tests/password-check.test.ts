import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SoftAuthenticator } from "../../portal/tests/authenticator";
import { createPasswordVerifier } from "../src/password-check";
import type { ChallengeResponse } from "../src/passkeys/protocol";
import type { UnlockResponse } from "../src/secrets/protocol";
import { DASHBOARD, json, mount, PASSWORD, ZONE } from "./passkeys-bench";

describe("the steward's /signin", () => {
  test("verifies the password against the hash as the file holds it now", async () => {
    const bench = await mount();
    expect((await bench.call("POST", "/signin", { password: PASSWORD })).status).toBe(204);
    const wrong = await bench.call("POST", "/signin", { password: "not it" });
    expect(wrong.status).toBe(401);
    expect(await json(wrong)).toMatchObject({ error: "refused" });

    // Changed on disk, as Change password writes it: the old password stops
    // signing in with no restart of anything.
    const hash = await Bun.password.hash("the new one", { algorithm: "bcrypt", cost: 4 });
    writeFileSync(join(dirname(bench.state), "secrets", "dashboard.env"), `PASSWORD_HASH=${hash}\n`, { mode: 0o600 });
    expect((await bench.call("POST", "/signin", { password: PASSWORD })).status).toBe(401);
    expect((await bench.call("POST", "/signin", { password: "the new one" })).status).toBe(204);
  });

  test("counts nothing against the unlock, and writes nothing to the journal", async () => {
    const bench = await mount();
    for (let i = 0; i < 10; i++) expect((await bench.call("POST", "/signin", { password: "not it" })).status).toBe(401);
    expect((await bench.call("POST", "/unlock", { password: PASSWORD })).status).toBe(200);
  });

  test("refuses a missing or oversized password", async () => {
    const bench = await mount();
    expect((await bench.call("POST", "/signin", {})).status).toBe(400);
    expect((await bench.call("POST", "/signin", { password: "x".repeat(300) })).status).toBe(400);
  });

  test("refuses the password once the owner holds a passkey", async () => {
    const bench = await mount();
    const { token } = await json<UnlockResponse>(await bench.call("POST", "/unlock", { password: PASSWORD }));
    const asked = await json<ChallengeResponse>(await bench.call("POST", "/passkeys/challenge", { purpose: "register", token }));
    const key = await SoftAuthenticator.create(-7);
    const credential = await key.register({ challenge: asked.publicKey.challenge as string, origin: DASHBOARD, rpId: ZONE });
    expect((await bench.call("POST", "/passkeys/register", { challengeId: asked.challengeId, credential, name: "Laptop", token })).status).toBe(200);

    const refused = await bench.call("POST", "/signin", { password: PASSWORD });
    expect(refused.status).toBe(403);
    expect(await json(refused)).toMatchObject({ error: "out-of-scope" });
  });
});

describe("createPasswordVerifier", () => {
  const answer = (status: number, body?: unknown) => async () => (body === undefined ? new Response(null, { status }) : Response.json(body, { status }));

  test("reads the steward's verdicts", async () => {
    expect(await createPasswordVerifier(answer(204), "")("pw")).toBe("valid");
    expect(await createPasswordVerifier(answer(401, { error: "refused" }), "")("pw")).toBe("refused");
    expect(await createPasswordVerifier(answer(403, { error: "out-of-scope" }), "")("pw")).toBe("passkey-only");
    expect(await createPasswordVerifier(answer(400, { error: "invalid" }), "")("pw")).toBe("refused");
  });

  test("verifies nothing when the steward is down, busy or broken", async () => {
    expect(await createPasswordVerifier(async () => Promise.reject(new Error("ECONNREFUSED")), "")("pw")).toBe("unavailable");
    expect(await createPasswordVerifier(answer(503, { error: "failure" }), "")("pw")).toBe("unavailable");
    expect(await createPasswordVerifier(answer(500, { error: "failure" }), "")("pw")).toBe("unavailable");
    // A 401 that is not a wrong password is not counted as one.
    expect(await createPasswordVerifier(answer(401, { error: "locked" }), "")("pw")).toBe("unavailable");
  });

  test("falls back on the hash it started with, before a steward that has the route", async () => {
    const hash = await Bun.password.hash("pw", { algorithm: "bcrypt", cost: 4 });
    const old = answer(404, { error: "not-found" });
    expect(await createPasswordVerifier(old, hash)("pw")).toBe("valid");
    expect(await createPasswordVerifier(old, hash)("other")).toBe("refused");
    expect(await createPasswordVerifier(old, "")("pw")).toBe("refused");
  });
});
