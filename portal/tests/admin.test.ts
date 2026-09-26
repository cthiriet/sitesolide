import { describe, expect, test } from "bun:test";
import { createAdmin } from "../src/admin";
import type { Guest } from "../src/guests";
import { guestHash } from "../src/gate";
import { memoryStore } from "./memory";

const NOW = 1_800_000_000_000;
const PASSWORD = "Xith-G4r4-nRJs-uDMV";

function admin() {
  const store = memoryStore();
  let rang = 0;
  const routes = createAdmin(store, () => NOW, {
    drawPassword: () => PASSWORD,
    drawId: () => `AAAAAAAAAAAAAAA${rang++}`,
  });
  return { store, routes };
}

function creation(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:3026/admin/guests", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID = { host: "forum.test-zone.invalid", label: "Alice", durationS: 7 * 24 * 3600 };

describe("creating an access", () => {
  test("returns the password only once, and the database keeps only its hash", async () => {
    const { store, routes } = admin();
    const response = await routes.create(creation(VALID));
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const { guest, password } = (await response.json()) as { guest: Guest; password: string };
    expect(password).toBe(PASSWORD);
    expect(guest).toEqual({
      id: "AAAAAAAAAAAAAAA0",
      host: "forum.test-zone.invalid",
      label: "Alice",
      createdAt: NOW,
      expiresAt: NOW + 7 * 24 * 3600 * 1000,
      seenAt: null,
    });
    expect(store.rows.get(guest.id)?.hash).toBe(guestHash(PASSWORD));
  });

  test("no deadline, when it is asked for in so many words", async () => {
    const { routes } = admin();
    const response = await routes.create(creation({ ...VALID, durationS: null }));
    expect(((await response.json()) as { guest: { expiresAt: unknown } }).guest.expiresAt).toBeNull();
  });

  test("the host is brought back to lowercase, the label cleaned", async () => {
    const { routes } = admin();
    const response = await routes.create(creation({ ...VALID, host: "Forum.Test-Zone.INVALID", label: "  Alice " }));
    expect(await response.json()).toMatchObject({ guest: { host: "forum.test-zone.invalid", label: "Alice" } });
  });

  test("anything not exactly as expected is refused, and nothing is created", async () => {
    const { store, routes } = admin();
    for (const body of [
      "not json",
      null,
      { ...VALID, host: undefined },
      { ...VALID, host: "" },
      { ...VALID, host: "a b.test" },
      { ...VALID, host: "a.test:443" },
      { ...VALID, label: "" },
      { ...VALID, label: "a\nb" },
      { ...VALID, label: "a".repeat(81) },
      { ...VALID, durationS: undefined },
      { ...VALID, durationS: 3600 },
      { ...VALID, durationS: "604800" },
    ]) {
      const response = await routes.create(creation(body));
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
    }
    expect(store.rows.size).toBe(0);
  });
});

describe("listing and revoking", () => {
  test("the list says neither the passwords nor their hashes", async () => {
    const { routes } = admin();
    await routes.create(creation(VALID));
    const response = routes.list(new Request("http://127.0.0.1:3026/admin/guests"));
    const text = await response.text();
    expect(JSON.parse(text).guests).toHaveLength(1);
    expect(text).not.toInclude(PASSWORD);
    expect(text).not.toInclude(guestHash(PASSWORD));
  });

  test("revoking deletes the access, and says so only once", async () => {
    const { store, routes } = admin();
    await routes.create(creation(VALID));
    const request = () => new Request("http://127.0.0.1:3026/admin/invites/AAAAAAAAAAAAAAA0", { method: "DELETE" });
    expect(routes.remove(request(), "AAAAAAAAAAAAAAA0").status).toBe(204);
    expect(store.rows.size).toBe(0);
    expect(routes.remove(request(), "AAAAAAAAAAAAAAA0").status).toBe(404);
  });

  test("a malformed identifier is unknown", () => {
    const { routes } = admin();
    const request = new Request("http://127.0.0.1:3026/admin/invites/x", { method: "DELETE" });
    expect(routes.remove(request, "../../x").status).toBe(404);
  });
});

describe("a request that came through Caddy reaches nothing", () => {
  for (const header of ["X-Forwarded-For", "X-Portal-Hote"]) {
    test(`refused if it carries ${header}`, async () => {
      const { store, routes } = admin();
      const carried = { [header]: "203.0.113.7" };
      expect((await routes.create(creation(VALID, carried))).status).toBe(403);
      expect(routes.list(new Request("http://127.0.0.1:3026/admin/guests", { headers: carried })).status).toBe(403);
      const removal = new Request("http://127.0.0.1:3026/admin/invites/AAAAAAAAAAAAAAA0", {
        method: "DELETE",
        headers: carried,
      });
      expect(routes.remove(removal, "AAAAAAAAAAAAAAA0").status).toBe(403);
      expect(store.rows.size).toBe(0);
    });
  }
});
