import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database";
import { createControlStore } from "../src/control/store";
import type { IdentityResolver, Resolved } from "../src/people/identity";
import { createMemberRelay, MEMBER_LOCKED } from "../src/people/relay";
import { createTokens } from "../src/secrets/tokens";

/**
 * A person's writes to a project's store, as the dashboard relays them: the
 * origin, the session and the shape checked here, the person's session and
 * unlock added, the steward's `/people/store/*` routes asked, which judge by
 * role. A value set and a file's content never come back; reading a value
 * back, merging and retiring the old files have no route here at all.
 */

const PUBLIC_URL = "https://dashboard.test-zone.invalid";
const SESSION_HASH = "ada-session-hash";
const SESSION = "ada-session-token-0f3a";
const UNLOCK = "ada-unlock-token-77d2";
const ADA = "ada@acme.test";

type Act = { method: string; path: string; body: Record<string, unknown>; long: boolean | undefined };

function mount(options: { signedIn?: boolean; unlocked?: boolean; answer?: (act: Act) => Response } = {}) {
  const root = mkdtempSync(join(tmpdir(), "people-relay-"));
  const acts: Act[] = [];
  const resolved: Resolved =
    options.signedIn === false
      ? null
      : {
          session: { hash: SESSION_HASH, createdAt: 0, seenAt: 0, identity: ADA },
          token: SESSION,
          identity: { kind: "person", email: ADA, name: null, roles: { shop: "developer" }, create: false, expiresAt: Date.now() + 60_000 },
        };
  const resolve = Object.assign((async () => resolved) as IdentityResolver, { forget: () => undefined });
  const tokens = createTokens();
  if (options.unlocked !== false) tokens.set(SESSION_HASH, { token: UNLOCK, expiresAt: Date.now() + 60_000 });
  const unreachable = async () => Response.json({ error: "failure", message: "not in this test" }, { status: 500 });
  const relay = createMemberRelay({
    publicUrl: PUBLIC_URL,
    resolve,
    closeSession: () => undefined,
    steward: {
      act: async (method, path, body, long) => {
        const act = { method, path, body: body as Record<string, unknown>, long };
        acts.push(act);
        return options.answer?.(act) ?? Response.json({ store: { slug: "shop" }, created: false, set: [], generated: [], removed: [], absent: [], files: { set: [], removed: [] } });
      },
      lock: async () => new Response(null, { status: 204 }),
    },
    tokens,
    secrets: { readLog: unreachable },
    backups: { readBackups: unreachable, readBackupAudit: unreachable },
    control: createControlStore(openDatabase(join(root, "dashboard.db"))),
  });
  return { relay, acts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function requested(body: unknown, origin: string | null = PUBLIC_URL, method = "POST"): Request {
  return new Request(`${PUBLIC_URL}/api/secrets/store`, {
    method,
    headers: { "Content-Type": "application/json", ...(origin === null ? {} : { Origin: origin }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ROUTES = [
  { route: "setStoreVariable", method: "PUT", path: "/people/store/variable", body: { slug: "shop", name: "API_KEY", value: "a-value-set-by-ada-31c" } },
  { route: "removeStoreVariables", method: "DELETE", path: "/people/store/variable", body: { slug: "shop", names: ["API_KEY"] } },
  { route: "generateStoreVariable", method: "POST", path: "/people/store/generate", body: { slug: "shop", name: "SESSION_KEY", format: "hex", bytes: 32, replace: false } },
  { route: "setStoreFile", method: "PUT", path: "/people/store/file", body: { slug: "shop", name: "gcp.json", content: Buffer.from('{"k":"file-content-of-ada-55"}').toString("base64") } },
  { route: "removeStoreFile", method: "DELETE", path: "/people/store/file", body: { slug: "shop", name: "gcp.json" } },
  { route: "restoreStore", method: "POST", path: "/people/store/restore", body: { slug: "shop", dryRun: true } },
] as const;

describe("a person's writes to a store, relayed", () => {
  test("each to its people route, with their session and unlock, the fields it takes alone, waiting the long delay", async () => {
    const { relay, acts, cleanup } = mount();
    try {
      for (const { route, method, path, body } of ROUTES) {
        const response = await relay[route](requested({ ...body, token: "from-the-page", session: "from-the-page", intruder: 1 }, PUBLIC_URL, method));
        expect({ route, status: response.status }).toEqual({ route, status: 200 });
        expect(acts.at(-1)).toEqual({ method, path, body: { ...body, session: SESSION, token: UNLOCK }, long: true });
      }
    } finally {
      cleanup();
    }
  });

  test("no route reads a value back, nor merges or retires the old files: those are the owner's", () => {
    const { relay, cleanup } = mount();
    try {
      for (const name of ["revealStoreValue", "migrateStore", "retireStore", "readStore"]) expect(Object.hasOwn(relay, name)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("the origin first, then the session, then the unlock: nothing goes off before", async () => {
    for (const [options, origin, status, body] of [
      [{}, "https://pirate.test", 403, { error: "origin-refused" }],
      [{}, null, 403, { error: "origin-refused" }],
      [{ signedIn: false }, PUBLIC_URL, 401, { error: "no-session" }],
      [{ unlocked: false }, PUBLIC_URL, 423, { error: "locked", message: MEMBER_LOCKED }],
    ] as const) {
      const { relay, acts, cleanup } = mount(options);
      try {
        for (const { route, method, body: sent } of ROUTES) {
          const response = await relay[route](requested(sent, origin, method));
          expect({ route, status: response.status, body: await response.json() }).toEqual({ route, status, body });
        }
        expect(acts).toEqual([]);
      } finally {
        cleanup();
      }
    }
  });

  test("a value set or a file's content that the steward's answer copies back does not come out", async () => {
    for (const { route, method, body } of ROUTES.filter((one) => one.route === "setStoreVariable" || one.route === "setStoreFile")) {
      const echoed = route === "setStoreVariable" ? (body as { value: string }).value : '{"k":"file-content-of-ada-55"}';
      const { relay, cleanup } = mount({ answer: () => Response.json({ error: "invalid", message: `refused: ${echoed}` }, { status: 400 }) });
      try {
        const response = await relay[route](requested(body, PUBLIC_URL, method));
        const text = await response.text();
        expect({ route, status: response.status }).toEqual({ route, status: 502 });
        expect(text).not.toContain(echoed);
        expect(text).not.toContain(UNLOCK);
        expect(text).not.toContain(SESSION);
      } finally {
        cleanup();
      }
    }
  });

  test("a field of another type, or a list that is none: 400, nothing goes off", async () => {
    const { relay, acts, cleanup } = mount();
    try {
      for (const [route, method, body] of [
        ["setStoreVariable", "PUT", { slug: "shop", name: "A", value: 42 }],
        ["removeStoreVariables", "DELETE", { slug: "shop", names: "A" }],
        ["generateStoreVariable", "POST", { slug: "shop", name: "A", bytes: "32" }],
        ["setStoreFile", "PUT", { slug: "shop", name: "x.json" }],
        ["restoreStore", "POST", { slug: "shop", dryRun: "yes" }],
      ] as const) {
        expect((await relay[route](requested(body, PUBLIC_URL, method))).status).toBe(400);
      }
      expect(acts).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
