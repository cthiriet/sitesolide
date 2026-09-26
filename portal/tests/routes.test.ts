import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DATA_DIR } from "../src/config";
import type { Guest } from "../src/guests";
import { deriveKey, issueToken, guestHash } from "../src/gate";
import { createRoutes, type Options } from "../src/routes";
import { memoryStore } from "./memory";

// The diversion of DATA_DIR is checked rather than assumed: without it, a test
// would write the portal's key where the service looks for it.
test("DATA_DIR is diverted towards .attempts", () => {
  expect(DATA_DIR).toBe(join(import.meta.dir, "..", ".attempts"));
});

const HOST = "kanban.test-zone.invalid";
const OTHER = "roster.test-zone.invalid";
const ORIGIN = `https://${HOST}`;
const PASSWORD = "Xith-G4r4-nRJs-uDMV-KhsD-mzuK";
const GUEST_PASSWORD = "Ab3d-Ef4h-Jk5m-Np6q";
const KEY = deriveKey(new Uint8Array(32).fill(3), "$argon2id$sample")!;
const DURATION = 30 * 24 * 3600;
const START = 1_800_000_000_000;

let hash = "";
beforeAll(async () => {
  // Minimal settings: the test bears on the decision, not on argon2's cost.
  hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id", memoryCost: 8, timeCost: 1 });
});

function routes(options: Partial<Options> = {}, clock = () => START) {
  return createRoutes(
    {
      key: KEY,
      verifyPassword: (submitted) => Bun.password.verify(submitted, hash),
      online: true,
      cookieDurationS: DURATION,
      guests: memoryStore(),
      ...options,
    },
    clock,
  );
}

function verification(headers: Record<string, string>): Request {
  return new Request("http://127.0.0.1:3026/verifier", { headers });
}

function signIn(fields: Record<string, string>, headers: Record<string, string> = {}): Request {
  const body = new URLSearchParams(fields);
  return new Request("http://127.0.0.1:3026/_portal/connexion", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Portal-Hote": HOST,
      Origin: ORIGIN,
      ...headers,
    },
    body,
  });
}

function cookieOf(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
}

describe("/verifier", () => {
  test("without X-Portal-Hote, 401: nothing opens by default", () => {
    const token = issueToken(KEY, HOST, 1_800_000_000 + 60);
    const response = routes().verify(verification({ Cookie: `__Host-portal=${token}` }));
    expect(response.status).toBe(401);
  });

  test("without a cookie, a 401 whose body is the login page", async () => {
    const response = routes().verify(
      verification({ "X-Portal-Hote": HOST, "X-Forwarded-Method": "GET", "X-Forwarded-Uri": "/list" }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("x-portal")).toBe("connexion");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const page = await response.text();
    expect(page).toInclude('name="retour" value="/list"');
    expect(page).toInclude("This site is private.");
  });

  test("a good cookie lets through", () => {
    const token = issueToken(KEY, HOST, 1_800_000_000 + 60);
    const response = routes().verify(verification({ "X-Portal-Hote": HOST, Cookie: `__Host-portal=${token}` }));
    expect(response.status).toBe(200);
  });

  test("the cookie of another host does not get through", () => {
    const token = issueToken(KEY, OTHER, 1_800_000_000 + 60);
    const response = routes().verify(verification({ "X-Portal-Hote": HOST, Cookie: `__Host-portal=${token}` }));
    expect(response.status).toBe(401);
  });

  test("without a hash, even a well signed cookie does not get through", () => {
    const token = issueToken(KEY, HOST, 1_800_000_000 + 60);
    const response = routes({ key: null }).verify(
      verification({ "X-Portal-Hote": HOST, Cookie: `__Host-portal=${token}` }),
    );
    expect(response.status).toBe(401);
  });

  test("a POST carrying a good cookie but coming from elsewhere is refused", () => {
    const token = issueToken(KEY, HOST, 1_800_000_000 + 60);
    const base = { "X-Portal-Hote": HOST, Cookie: `__Host-portal=${token}`, "X-Forwarded-Method": "POST" };
    expect(routes().verify(verification({ ...base, Origin: "https://agency.test-zone.invalid" })).status).toBe(403);
    expect(routes().verify(verification(base)).status).toBe(403);
    expect(routes().verify(verification({ ...base, Origin: ORIGIN })).status).toBe(200);
  });

  test("a well signed guest token with no access behind it does not get through", () => {
    const token = issueToken(KEY, HOST, 1_800_000_000 + 60, "AAAAAAAAAAAAAAAA");
    const response = routes().verify(verification({ "X-Portal-Hote": HOST, Cookie: `__Host-portal=${token}` }));
    expect(response.status).toBe(401);
  });
});

describe("/_portal/connexion", () => {
  test("the right password sets the cookie and sends back to the requested page", async () => {
    const r = routes();
    const response = await r.signIn(signIn({ motdepasse: PASSWORD, retour: "/list" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/list");

    // The cookie that was set does open the host, and it alone.
    const cookie = cookieOf(response);
    expect(cookie.startsWith("__Host-portal=")).toBe(true);
    expect(r.verify(verification({ "X-Portal-Hote": HOST, Cookie: cookie })).status).toBe(200);
    expect(r.verify(verification({ "X-Portal-Hote": OTHER, Cookie: cookie })).status).toBe(401);
  });

  test("a return that leads elsewhere brings back to the home page", async () => {
    const response = await routes().signIn(signIn({ motdepasse: PASSWORD, retour: "//evil.test" }));
    expect(response.headers.get("location")).toBe("/");
  });

  test("a wrong password renders the page, with a 401, without a cookie", async () => {
    const response = await routes().signIn(signIn({ motdepasse: "wrong", retour: "/list" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toInclude("Password refused");
  });

  test("a foreign origin is refused before the counter moves", async () => {
    const r = routes();
    for (let i = 0; i < 10; i++) {
      const response = await r.signIn(signIn({ motdepasse: "wrong" }, { Origin: "https://evil.test" }));
      expect(response.status).toBe(403);
    }
    // Ten origin refusals have not closed the gate to the real user.
    expect((await r.signIn(signIn({ motdepasse: PASSWORD }))).status).toBe(303);
  });

  test("after three failures, the rate limiting refuses even the right password", async () => {
    let now = START;
    const r = routes({}, () => now);
    for (let i = 0; i < 4; i++) await r.signIn(signIn({ motdepasse: "wrong" }));

    const throttled = await r.signIn(signIn({ motdepasse: PASSWORD }));
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("5");

    now += 5_000;
    expect((await r.signIn(signIn({ motdepasse: PASSWORD }))).status).toBe(303);
  });

  test("the rate limiting of one site does not slow the others down", async () => {
    const r = routes();
    for (let i = 0; i < 4; i++) await r.signIn(signIn({ motdepasse: "wrong" }));
    expect((await r.signIn(signIn({ motdepasse: PASSWORD }))).status).toBe(429);

    const elsewhere = signIn({ motdepasse: PASSWORD }, { "X-Portal-Hote": OTHER, Origin: `https://${OTHER}` });
    expect((await r.signIn(elsewhere)).status).toBe(303);
  });

  test("without a hash, the right password is refused like any other", async () => {
    const response = await routes({ key: null }).signIn(signIn({ motdepasse: PASSWORD }));
    expect(response.status).toBe(401);
  });

  test("a body without a password, or an oversized password, is refused", async () => {
    expect((await routes().signIn(signIn({ retour: "/" }))).status).toBe(400);
    expect((await routes().signIn(signIn({ motdepasse: "x".repeat(257) }))).status).toBe(400);
  });

  test("without X-Portal-Hote, nothing is checked", async () => {
    const request = signIn({ motdepasse: PASSWORD }, { "X-Portal-Hote": "" });
    expect((await routes().signIn(request)).status).toBe(400);
  });
});

describe("a guest access", () => {
  function withGuest(rest: Partial<Guest> = {}, clock = () => START) {
    const guests = memoryStore();
    const guest: Guest = {
      id: "InViTeInViTe0001",
      host: HOST,
      label: "Alice",
      createdAt: START,
      expiresAt: null,
      seenAt: null,
      ...rest,
    };
    guests.create(guest, guestHash(GUEST_PASSWORD));
    return { guests, r: routes({ guests }, clock) };
  }

  function visit(r: ReturnType<typeof routes>, cookie: string, host = HOST) {
    return r.verify(verification({ "X-Portal-Hote": host, Cookie: cookie }));
  }

  test("its password opens its site, and it alone", async () => {
    const { r } = withGuest();
    const response = await r.signIn(signIn({ motdepasse: GUEST_PASSWORD, retour: "/list" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/list");

    const cookie = cookieOf(response);
    expect(cookie.split(".")).toHaveLength(3);
    expect(visit(r, cookie).status).toBe(200);
    expect(visit(r, cookie, OTHER).status).toBe(401);
  });

  test("on another site, its password is worth nothing and counts as a failure", async () => {
    const { r } = withGuest({ host: OTHER });
    const response = await r.signIn(signIn({ motdepasse: GUEST_PASSWORD }));
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("revoking closes the gate from the next request on, cookie in hand", async () => {
    const { guests, r } = withGuest();
    const cookie = cookieOf(await r.signIn(signIn({ motdepasse: GUEST_PASSWORD })));
    expect(visit(r, cookie).status).toBe(200);

    guests.remove("InViTeInViTe0001");
    const refused = visit(r, cookie);
    expect(refused.status).toBe(401);
    expect(await refused.text()).toInclude("This access is no longer valid.");
    expect((await r.signIn(signIn({ motdepasse: GUEST_PASSWORD }))).status).toBe(401);
  });

  test("at the deadline, the cookie falls with the access, and the password too", async () => {
    let now = START;
    const { r } = withGuest({ expiresAt: START + 3_600_000 }, () => now);
    const response = await r.signIn(signIn({ motdepasse: GUEST_PASSWORD }));
    // The browser forgets it at the deadline, without waiting thirty days.
    expect(response.headers.get("set-cookie")).toInclude("Max-Age=3600;");

    const cookie = cookieOf(response);
    now = START + 3_599_000;
    expect(visit(r, cookie).status).toBe(200);
    now = START + 3_600_000;
    expect(visit(r, cookie).status).toBe(401);
    expect((await r.signIn(signIn({ motdepasse: GUEST_PASSWORD }))).status).toBe(401);
  });

  test("without the owner's hash, a guest does not get in either", async () => {
    const guests = memoryStore();
    guests.create(
      { id: "InViTeInViTe0001", host: HOST, label: "Alice", createdAt: START, expiresAt: null, seenAt: null },
      guestHash(GUEST_PASSWORD),
    );
    const response = await routes({ key: null, guests }).signIn(signIn({ motdepasse: GUEST_PASSWORD }));
    expect(response.status).toBe(401);
  });

  test("its last visit is noted, at most once a minute", async () => {
    let now = START;
    const { guests, r } = withGuest({}, () => now);
    const cookie = cookieOf(await r.signIn(signIn({ motdepasse: GUEST_PASSWORD })));

    visit(r, cookie);
    expect(guests.byId("InViTeInViTe0001")?.seenAt).toBe(START);
    now = START + 30_000;
    visit(r, cookie);
    expect(guests.byId("InViTeInViTe0001")?.seenAt).toBe(START);
    now = START + 61_000;
    visit(r, cookie);
    expect(guests.byId("InViTeInViTe0001")?.seenAt).toBe(START + 61_000);
  });

  test("a POST coming from elsewhere is refused to the guest as to the owner", async () => {
    const { r } = withGuest();
    const cookie = cookieOf(await r.signIn(signIn({ motdepasse: GUEST_PASSWORD })));
    const request = verification({
      "X-Portal-Hote": HOST,
      Cookie: cookie,
      "X-Forwarded-Method": "POST",
      Origin: "https://agency.test-zone.invalid",
    });
    expect(r.verify(request).status).toBe(403);
  });
});

describe("/_portal/deconnexion", () => {
  test("erases the cookie and sends back to the home page", () => {
    const request = new Request("http://127.0.0.1:3026/_portal/deconnexion", {
      method: "POST",
      headers: { "X-Portal-Hote": HOST, Origin: ORIGIN },
    });
    const response = routes().signOut(request);
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toInclude("Max-Age=0");
  });

  test("refuses a foreign origin", () => {
    const request = new Request("http://127.0.0.1:3026/_portal/deconnexion", {
      method: "POST",
      headers: { "X-Portal-Hote": HOST, Origin: "https://evil.test" },
    });
    expect(routes().signOut(request).status).toBe(403);
  });
});

test("/sante says whether a hash is in place, without saying anything more about it", async () => {
  expect(await routes().health().json()).toEqual({ ok: true, configure: true });
  expect(await routes({ key: null }).health().json()).toEqual({ ok: true, configure: false });
});
