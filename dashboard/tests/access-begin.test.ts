import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjection } from "../borrowed/access";
import { encodeRegistry, readRegistry, type Registry } from "../src/access/registry";
import { BEGIN_RETRY_MS, BEGINNING, createAccessStore, type AccessEvent } from "../src/access/steward";
import { createAccessSystem, type AccessSystem } from "../src/access/system";

/**
 * A machine without an access registry begins it empty at the steward's
 * start, written with its projection, in the background, never in a
 * request's way; a registry already there is read as it stands, the record
 * of its making from the stores before it, in 0.4.0, kept. The stores before
 * it, `members.json` and the portal's database, are read by nothing.
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
  const system = createAccessSystem({ stateFolder: paths.state, portalKeyFolder: paths.key, groupsFile: "/etc/group", portalGroup: "" });
  return createAccessStore({
    system: options.system === undefined ? system : options.system(system),
    zone: ZONE,
    hostOf: (slug) => `${slug}.${ZONE}`,
    journal: async (event) => void options.events?.push(event),
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
    expect(registry).toEqual({ version: 1, projects: {}, creators: [], migration: null });
    expect(statSync(join(paths.state, "access.json")).mode & 0o777).toBe(0o600);
    expect(readProjection(readFileSync(join(paths.key, "access.json"), "utf8"))).toMatchObject({ sites: {} });
    expect(events).toEqual([]);
  });

  test("the stores from before the registry are read by nothing: a members.json left there carries nobody over", async () => {
    const paths = tree();
    writeFileSync(join(paths.state, "members.json"), JSON.stringify({ members: [{ email: "ann@acme.test", roles: { blog: "admin" }, invitedBy: "owner", createdAt: 1, updatedAt: 1 }] }));
    const access = store(paths);
    await access.ensure();
    expect(await access.read()).toMatchObject({ projects: {}, creators: [], migration: null });
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
    expect(await access.read()).toMatchObject({ projects: {}, migration: null });
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

describe("a registry made from the stores before it, in 0.4.0", () => {
  const made: Registry = {
    version: 1,
    projects: { blog: [{ who: "ann@acme.test", role: "admin", by: "migration", createdAt: NOW - 10, updatedAt: NOW - 5 }] },
    creators: [],
    migration: { at: NOW - 10, from: ["members.json", "portal.db"], setAside: [{ source: "sharing", slug: null, who: "old.elsewhere.test", reason: "a host this zone gives no project" }] },
  };

  test("is read as it stands, and a change writes its record back, nothing it set aside lost", async () => {
    const paths = tree();
    writeFileSync(join(paths.state, "access.json"), encodeRegistry(made), { mode: 0o600 });
    const access = store(paths);
    expect(await access.ensure()).toBe(true);
    expect(await access.read()).toEqual(made);
    await access.change(async (registry) => ({ registry: { ...registry, creators: [{ email: "ann@acme.test", by: "owner", at: NOW }] }, value: null }));
    const written = readRegistry(readFileSync(join(paths.state, "access.json"), "utf8"));
    expect(written).toMatchObject({ migration: made.migration, projects: made.projects, creators: [{ email: "ann@acme.test" }] });
  });
});
