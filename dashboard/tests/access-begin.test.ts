import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjection } from "../borrowed/access";
import { readRegistry } from "../src/access/registry";
import { BEGIN_RETRY_MS, BEGINNING, createAccessStore, type AccessEvent } from "../src/access/steward";
import { createAccessSystem, type AccessSystem } from "../src/access/system";

/**
 * A machine without an access registry begins it empty at the steward's
 * start, written with its projection, in the background, never in a
 * request's way; a registry already there is read, what company sign-in
 * left in it (people and domains with a role, who could create) left out
 * until its next change. The stores before it, `members.json` and the
 * portal's database, are read by nothing.
 */

const ZONE = "test-zone.invalid";
const NOW = 1_800_000_000_000;

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function tree() {
  const root = mkdtempSync(join(tmpdir(), "access-begin-"));
  folders.push(root);
  const state = join(root, "state");
  const key = join(root, "portal-key");
  for (const folder of [state, key]) mkdirSync(folder, { recursive: true });
  return { root, state, key };
}

function store(paths: ReturnType<typeof tree>, options: { events?: AccessEvent[]; sleep?: (ms: number) => Promise<void>; system?: (system: AccessSystem) => AccessSystem } = {}) {
  const system = createAccessSystem({ stateFolder: paths.state, sitesDir: join(paths.root, "sites"), portalKeyFolder: paths.key, groupsFile: "/etc/group", portalGroup: "" });
  return createAccessStore({
    system: options.system === undefined ? system : options.system(system),
    zone: ZONE,
    hostOf: (slug) => `${slug}.${ZONE}`,
    sleep: options.sleep ?? (async () => {}),
  });
}

describe("a machine without a registry", () => {
  test("begins it empty, root's alone, its projection written for the portal, nothing journaled", async () => {
    const paths = tree();
    const events: AccessEvent[] = [];
    const access = store(paths, { events });
    expect(await access.ensure()).toBe(true);
    const registry = readRegistry(readFileSync(join(paths.state, "access.json"), "utf8"));
    expect(registry).toEqual({ registry: { version: 1, projects: {} }, leftOut: 0 });
    expect(statSync(join(paths.state, "access.json")).mode & 0o777).toBe(0o600);
    expect(readProjection(readFileSync(join(paths.key, "access.json"), "utf8"))).toMatchObject({ sites: {} });
    expect(events).toEqual([]);
  });

  test("the stores from before the registry are read by nothing: a members.json left there carries nobody over", async () => {
    const paths = tree();
    writeFileSync(join(paths.state, "members.json"), JSON.stringify({ members: [{ email: "ann@acme.test", roles: { blog: "admin" }, invitedBy: "owner", createdAt: 1, updatedAt: 1 }] }));
    const access = store(paths);
    await access.ensure();
    expect(await access.read()).toEqual({ version: 1, projects: {} });
  });

  test("never in a request's way: a read or a change before it is begun answers not-ready, and begins it in the background", async () => {
    const paths = tree();
    let release: () => void = () => {};
    let fail = true;
    const access = store(paths, {
      sleep: () => new Promise<void>((resolve) => (release = resolve)),
      // The first attempt fails on the way, as a full disk would.
      system: (system) => ({
        ...system,
        writeRegistry: async (text) => {
          if (fail) throw new Error("ENOSPC");
          await system.writeRegistry(text);
        },
      }),
    });
    const first = await access.read();
    expect(first).toBeInstanceOf(Response);
    expect((first as Response).status).toBe(503);
    expect(await (first as Response).json()).toEqual({ error: "not-ready", message: BEGINNING });
    const refused = await access.change(async (registry) => ({ registry, value: "changed" }));
    expect(((await (refused as Response).json()) as { error: string }).error).toBe("not-ready");
    fail = false;
    while (!existsSync(join(paths.state, "access.json"))) {
      release();
      await Bun.sleep(5);
    }
    await access.start();
    expect(await access.read()).toEqual({ version: 1, projects: {} });
  });

  test("an attempt that fails is tried again, later and later", async () => {
    const paths = tree();
    const waits: number[] = [];
    let failures = 3;
    const access = store(paths, {
      sleep: async (ms) => void waits.push(ms),
      system: (system) => ({
        ...system,
        writeRegistry: async (text) => {
          if (failures-- > 0) throw new Error("EIO");
          await system.writeRegistry(text);
        },
      }),
    });
    await access.start();
    expect(waits).toEqual([BEGIN_RETRY_MS, BEGIN_RETRY_MS * 2, BEGIN_RETRY_MS * 4]);
    expect(existsSync(join(paths.state, "access.json"))).toBe(true);
  });
});

describe("a registry written while people signed in with a company account", () => {
  const guest = { who: "gus@elsewhere.test", role: "visitor", by: "owner", createdAt: NOW - 10, updatedAt: NOW - 10, password: { id: "guest00000000001", hash: "a".repeat(64), expiresAt: null } };
  const before = {
    version: 1,
    projects: {
      blog: [{ who: "ann@acme.test", role: "admin", by: "migration", createdAt: NOW - 10, updatedAt: NOW - 5 }, guest],
      shop: [{ who: "@acme.test", role: "viewer", by: "owner", createdAt: NOW - 10, updatedAt: NOW - 10 }],
    },
    creators: [{ email: "ann@acme.test", by: "owner", at: NOW }],
    migration: { at: NOW - 10, from: ["members.json"], setAside: [] },
  };

  test("is read, its people, domains and creators left out, its guests kept; they go from the file at its next change", async () => {
    const paths = tree();
    const text = `${JSON.stringify(before, null, 2)}\n`;
    writeFileSync(join(paths.state, "access.json"), text, { mode: 0o600 });
    const access = store(paths);
    expect(await access.ensure()).toBe(true);
    const { role: _, ...kept } = guest;
    expect(await access.read()).toEqual({ version: 1, projects: { blog: [kept] } });
    // Reading writes nothing back.
    expect(readFileSync(join(paths.state, "access.json"), "utf8")).toBe(text);
    await access.change(async (registry) => ({ registry: { ...registry, projects: { ...registry.projects } }, value: null }));
    expect(readRegistry(readFileSync(join(paths.state, "access.json"), "utf8"))).toEqual({ registry: { version: 1, projects: { blog: [kept] } }, leftOut: 0 });
    expect(readProjection(readFileSync(join(paths.key, "access.json"), "utf8"))).toMatchObject({ sites: { [`blog.${ZONE}`]: { slug: "blog", passwords: [{ id: "guest00000000001", who: "gus@elsewhere.test" }] } } });
  });
});
