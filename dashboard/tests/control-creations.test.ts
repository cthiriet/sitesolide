import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccessRoutes, createAccessStore } from "../src/access/steward";
import { createAccessSystem } from "../src/access/system";
import { EMPTY_REGISTRY, encodeRegistry, putEntry, removePerson, setCreate, type Registry } from "../src/access/registry";
import { createMemberRoutes, type JournalRefusal } from "../src/people/steward";
import { createMembersSystem } from "../src/people/system";
import { createControlSteward, installerUnit, type ControlHandler } from "../src/control/steward";
import { createControlSystem } from "../src/control/system";
import { CREATION_MAX_AGE_MS } from "../src/control/creations";
import { MAX_UNCARRIED_NAMES } from "../src/control/tokens";
import { INSTALLER_TEMPLATE, type InstallerResult } from "../src/control/protocol";

/**
 * What a person's token creates, settled on the real stores wired as
 * dashboard/steward.ts wires them, on a throwaway tree, every part reading
 * one clock the test moves: the access store and routes, the people routes,
 * the control routes. The reviews' proofs, kept as tests: a creation makes
 * its person Admin only of a project of its own that nobody has access to,
 * its own installer ended, never of one the owner laid over it or gave
 * access to meanwhile, whatever the result left, the token, the clock or
 * the order of the queues; and undone creations never pile names up in the
 * token registry until nothing can be written to it. And the sweep that
 * keeps the tokens of someone with no role from coming back to life.
 */

const ZONE = "test-zone.invalid";
const DAVE = "dave@acme.test";
const ERIN = "erin@acme.test";
const CAROL = "carol@acme.test";
const HOUR = 3_600_000;

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function registryWith(entries: [string, string, "visitor" | "viewer" | "developer" | "admin"][], creators: string[]): Registry {
  let registry: Registry = { ...EMPTY_REGISTRY, migration: { at: 1, from: [], setAside: [] } };
  for (const [slug, who, role] of entries) {
    const put = putEntry(registry, slug, who, role, "owner", 1);
    if ("refusal" in put) throw new Error(put.refusal);
    registry = put.registry;
  }
  for (const email of creators) {
    const set = setCreate(registry, email, true, "owner", 1);
    if ("refusal" in set) throw new Error(set.refusal);
    registry = set.registry;
  }
  return registry;
}

type Wired = Awaited<ReturnType<typeof wire>>;

async function wire(registry: Registry, sites: string[]) {
  const root = mkdtempSync(join(tmpdir(), "control-creations-"));
  folders.push(root);
  for (const folder of ["state", "units", "installer", "portal-key", "secrets", "sites", ...sites.map((slug) => `sites/${slug}`)]) mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, "units", INSTALLER_TEMPLATE), "[Service]\n");
  writeFileSync(join(root, "secrets", "portal.env"), "OIDC_ISSUER=https://id.example\nOIDC_CLIENT_ID=x\nOIDC_CLIENT_SECRET=y\nOIDC_ALLOWED_DOMAINS=acme.test\n");
  writeFileSync(join(root, "state", "access.json"), encodeRegistry(registry), { mode: 0o600 });

  const clock = { now: Date.now() };
  /** While set, `systemctl is-active` waits for it: a deployment then holds the tokens' queue. */
  let held: Promise<void> | null = null;
  const holdActive = () => {
    let release = () => {};
    held = new Promise<void>((resolve) => {
      release = () => {
        held = null;
        resolve();
      };
    });
    return release;
  };
  /** The installer units `systemctl is-active` says are running. */
  const active = new Set<string>();
  const now = () => clock.now;
  const journal: JournalRefusal[] = [];
  const accessSystem = {
    ...createAccessSystem({ stateFolder: join(root, "state"), portalKeyFolder: join(root, "portal-key"), groupsFile: "/etc/group", portalGroup: "", portalDataFolder: join(root, "none") }, false),
    now,
  };
  const store = createAccessStore({ system: accessSystem, zone: ZONE, hostOf: (slug) => `${slug}.${ZONE}`, journal: async () => {} });
  const membersSystem = {
    ...createMembersSystem({ stateFolder: join(root, "state"), sitesDir: join(root, "sites"), secretsFolder: join(root, "secrets"), portalKeyFolder: join(root, "portal-key"), groupsFile: "/etc/group", portalGroup: "" }),
    now,
  };
  const readBody = async (req: Request) => (await req.json()) as Record<string, unknown>;
  const exists = (slug: string) => existsSync(join(root, "sites", slug));
  let control: ControlHandler | null = null;
  const members = createMemberRoutes({
    system: membersSystem,
    access: store,
    zone: ZONE,
    readBody,
    journal: async (event) => void journal.push(event),
    restart: async () => new Response(null),
    revokeTokens: (email, actor) => control!.revokeMember(email, actor),
  });
  const access = createAccessRoutes({
    store,
    zone: ZONE,
    hostOf: (slug) => `${slug}.${ZONE}`,
    projectExists: exists,
    signIn: () => membersSystem.readPortalSettings(),
    general: async () => null,
    portalReading: async () => ({ reading: "steward", writtenAt: 1 }),
    isUnlocked: async () => false,
    readBody,
    journal: async () => {},
    journalRefusal: async () => {},
    authorize: members.authorize,
    leave: members.leave,
  });
  const real = createControlSystem({ stateFolder: join(root, "state"), sitesDir: join(root, "sites"), unitsFolder: join(root, "units"), installerFolder: join(root, "installer"), systemctl: "/bin/false", journalctl: "/bin/false" });
  control = createControlSteward(
    {
      ...real,
      now,
      async systemctl(args) {
        if (args[0] === "is-active") {
          if (held !== null) await held;
          return active.has(args[1]!) ? { code: 0, output: "active\n" } : { code: 3, output: "inactive\n" };
        }
        return { code: 0, output: "" };
      },
    },
    {
      zone: ZONE,
      isUnlocked: async (token) => token === "owner-unlock",
      uidRoot: null,
      members: {
        authorize: members.authorize,
        unlockedUntil: members.unlockedUntil,
        rights: members.rights,
        rightless: members.rightless,
        recordCreation: members.recordCreation,
        journal: members.journal,
        journalRefusal: members.journalRefusal,
      },
      access: access.forToken,
      forgetAccess: access.forgetProject,
    },
  );
  await store.ensure();
  expect(await control.migrateTokens()).toBe(true);

  const handler = control;
  const post = (path: string, body: unknown) => handler(new Request(`http://steward${path}`, { method: "POST", body: JSON.stringify(body) }));
  const mint = async (holder: string, create: boolean, slugs: string[] = []) => {
    const made = await post("/tokens/create", { token: "owner-unlock", label: holder, holder, expiresAt: null, scope: { slugs, create, outbound: false, domain: false, public: false } });
    if (made.status !== 201) throw new Error(await made.text());
    return (await made.json()) as { token: { id: string }; secret: string };
  };
  const deploy = (secret: string, deployment: string, slug: string) => post("/control/deploy", { bearer: secret, deployment, slug, manifest: JSON.stringify({ slug }) });
  const preflight = (secret: string, slug: string) => post("/control/preflight", { bearer: secret, slug });
  /** What the installer was last asked for this slug. */
  const request = (slug: string) => JSON.parse(readFileSync(join(root, "state", "installs", `${slug}.json`), "utf8")) as { deployment: string; creating: boolean };
  /** The installer's result as it leaves it; `laid`: the project's directory made, as it makes it once it gets that far. */
  const result = (deployment: string, slug: string, state: InstallerResult["state"], laid: boolean) => {
    if (laid) mkdirSync(join(root, "sites", slug), { recursive: true });
    const at = clock.now;
    const written: InstallerResult = {
      deployment,
      slug,
      state,
      startedAt: at,
      updatedAt: at,
      finishedAt: state === "running" ? null : at,
      log: [],
      error: state === "failed" ? { code: "invalid-manifest", message: "refused" } : null,
      url: null,
      allocated: [],
    };
    writeFileSync(join(root, "installer", `${deployment}.json`), JSON.stringify(written), { mode: 0o600 });
  };
  const forget = (slug: string) => handler.owner(new Request("http://steward/tokens/project", { method: "DELETE", body: JSON.stringify({ slug }) }));
  const ownerGrant = (slug: string, who: string, role: string) =>
    access.owner["/access/entry"]!.PUT!(new Request("http://steward/access/entry", { method: "PUT", body: JSON.stringify({ slug, who, role }) }));
  const entries = async (slug: string) => {
    const read = await store.read();
    if (read instanceof Response) throw new Error("the registry does not read");
    return (read.projects[slug] ?? []).map((entry) => `${entry.who}:${entry.role}`);
  };
  const team = () => JSON.parse(readFileSync(join(root, "state", "team.json"), "utf8")) as { owners: Record<string, string>; tokens: { id: string; revokedAt: number | null }[] };
  const creations = () => {
    const file = join(root, "state", "creations.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { creations: { deployment: string; slug: string; email: string; token: string; at: number }[] }).creations : [];
  };
  return { root, clock, holdActive, active, journal, store, access, members, control: handler, post, mint, deploy, preflight, request, result, forget, ownerGrant, entries, team, creations };
}

const creates = (bench: Wired) => bench.journal.filter((event) => event.operation === "project.create" && event.result === "ok");

/** A refusal's status and message. */
const refusal = async (response: Response) => ({ status: response.status, message: ((await response.json()) as { message: string }).message });

/** Past the grace after which a `running` result whose installer is no longer active was left by an installer stopped half way. */
const STALE = 60_000;

/** The state the dashboard is shown for a deployment, which settles the creations once it is final. */
const shown = async (bench: Wired, deployment: string) =>
  ((await (await bench.control(new Request(`http://steward/control/deployment?id=${deployment}`))).json()) as { result: { state: string } }).result.state;

describe("a creation's own project, nobody given access to it, makes its creator Admin", () => {
  test("succeeded: Admin, journaled once", async () => {
    const bench = await wire(registryWith([], [DAVE]), []);
    const dave = await bench.mint(DAVE, true);
    const D = "aaaaaaaaaaaaaaaaaaaaaaab";
    expect((await bench.deploy(dave.secret, D, "shop")).status).toBe(202);
    bench.result(D, "shop", "succeeded", true);
    expect(await shown(bench, D)).toBe("succeeded");
    await bench.control.settleCreations();
    expect(await bench.entries("shop")).toEqual([`${DAVE}:admin`]);
    expect(creates(bench)).toHaveLength(1);
    expect(bench.creations()).toEqual([]);
  });

  test("failed after laying it, a secret missing: Admin, and the token deploys it again as its Admin's", async () => {
    const bench = await wire(registryWith([], [DAVE]), []);
    const dave = await bench.mint(DAVE, true);
    const D = "aaaaaaaaaaaaaaaaaaaaaaac";
    expect((await bench.deploy(dave.secret, D, "shop")).status).toBe(202);
    bench.result(D, "shop", "failed", true);
    await bench.control.settleCreations();
    expect(await bench.entries("shop")).toEqual([`${DAVE}:admin`]);
    expect(await (await bench.preflight(dave.secret, "shop")).json()).toEqual({ creating: false });
    const again = await bench.deploy(dave.secret, "aaaaaaaaaaaaaaaaaaaaaaad", "shop");
    expect(await again.json()).toEqual({ deployment: "aaaaaaaaaaaaaaaaaaaaaaad", slug: "shop", creating: false });
  });

  test("its installer stopped half way, its own result left running: shown interrupted, Admin, and deployed again as its Admin's", async () => {
    const bench = await wire(registryWith([], [DAVE]), []);
    const dave = await bench.mint(DAVE, true);
    const D = "111111111111111111111111";
    expect((await bench.deploy(dave.secret, D, "shop")).status).toBe(202);
    // Laid, then killed by a reboot, a timeout or the OOM killer.
    bench.result(D, "shop", "running", true);
    // Within the grace it may still be writing: nothing settled.
    await bench.control.settleCreations();
    expect(bench.creations()).toHaveLength(1);
    expect(await bench.entries("shop")).toEqual([]);
    bench.clock.now += STALE;
    expect(await shown(bench, D)).toBe("failed");
    expect(await bench.entries("shop")).toEqual([`${DAVE}:admin`]);
    expect(creates(bench)).toHaveLength(1);
    expect(bench.creations()).toEqual([]);
    expect(await (await bench.preflight(dave.secret, "shop")).json()).toEqual({ creating: false });
    const again = await bench.deploy(dave.secret, "222222222222222222222222", "shop");
    expect(await again.json()).toEqual({ deployment: "222222222222222222222222", slug: "shop", creating: false });
    expect(bench.request("shop")).toMatchObject({ deployment: "222222222222222222222222", creating: false });
  });

  test("its installer stopped by a reboot after laying it, no result left on /run: Admin once past the grace with its unit not active", async () => {
    const bench = await wire(registryWith([], [DAVE]), []);
    const dave = await bench.mint(DAVE, true);
    const D = "333333333333333333333333";
    expect((await bench.deploy(dave.secret, D, "shop")).status).toBe(202);
    mkdirSync(join(bench.root, "sites", "shop"), { recursive: true });
    // Within the grace its installer may not have written yet, and past it
    // one still active may still write: nothing settled either way.
    await bench.control.settleCreations();
    expect(bench.creations()).toHaveLength(1);
    bench.clock.now += STALE;
    bench.active.add(installerUnit("shop"));
    await bench.control.settleCreations();
    expect(bench.creations()).toHaveLength(1);
    expect(await bench.entries("shop")).toEqual([]);
    // The machine rebooted: the unit is not active, and no result will come.
    bench.active.clear();
    await bench.control.settleCreations();
    expect(await bench.entries("shop")).toEqual([`${DAVE}:admin`]);
    expect(creates(bench)).toHaveLength(1);
    expect(bench.creations()).toEqual([]);
    const again = await bench.deploy(dave.secret, "444444444444444444444444", "shop");
    expect(await again.json()).toEqual({ deployment: "444444444444444444444444", slug: "shop", creating: false });
  });
});

describe("the owner's project and grants are never a creation's", () => {
  /** Dave's creation of shop, D, its installer leaving `left`; then the owner's own shop laid over it by hand, no sitesolide remove, and Erin made its Admin. */
  async function overlaid(left: "nothing" | "running" | "failed", creators: string[] = [DAVE]) {
    const bench = await wire(registryWith([], creators), []);
    const dave = await bench.mint(DAVE, true);
    const D = "eeeeeeeeeeeeeeeeeeeeeeee";
    expect((await bench.deploy(dave.secret, D, "shop")).status).toBe(202);
    // Killed before it wrote anything, /run wiped by a reboot; stuck at
    // running after laying the tree; or refused before laying anything.
    if (left === "running") bench.result(D, "shop", "running", true);
    if (left === "failed") bench.result(D, "shop", "failed", false);
    mkdirSync(join(bench.root, "sites", "shop"), { recursive: true });
    expect((await bench.ownerGrant("shop", ERIN, "admin")).status).toBe(201);
    const untouched = async () => {
      expect(await bench.entries("shop")).toEqual([`${ERIN}:admin`]);
      expect(creates(bench)).toEqual([]);
      expect(await bench.members.rights(DAVE)).toEqual({ email: DAVE, roles: {}, create: true });
      expect(bench.request("shop").deployment).toBe(D);
    };
    return { bench, dave, untouched };
  }

  for (const left of ["nothing", "running", "failed"] as const) {
    test(`laid over a creation whose installer left ${left === "nothing" ? "no result" : `a ${left} result`}: Erin alone, Dave refused shop, within the day and after`, async () => {
      const { bench, dave, untouched } = await overlaid(left);
      bench.clock.now += HOUR;
      await bench.control.settleCreations();
      await untouched();
      expect(await refusal(await bench.preflight(dave.secret, "shop"))).toEqual({ status: 403, message: `${DAVE} holds no role on shop` });
      expect(await refusal(await bench.deploy(dave.secret, "abcabcabcabcabcabcabcabc", "shop"))).toEqual({ status: 403, message: `${DAVE} holds no role on shop` });
      // An ended creation is dropped at once, one a reboot left with no result too.
      expect(bench.creations()).toEqual([]);
      bench.clock.now += CREATION_MAX_AGE_MS;
      await bench.control.settleCreations();
      await untouched();
      expect(bench.creations()).toEqual([]);
    });
  }

  test("the owner removes it and deploys their own under that name: a day later, the timer leaves their people alone", async () => {
    const bench = await wire(registryWith([["blog", ERIN, "viewer"]], [DAVE]), ["blog"]);
    const dave = await bench.mint(DAVE, true);
    const D = "dddddddddddddddddddddddd";
    expect((await bench.deploy(dave.secret, D, "shop")).status).toBe(202);
    bench.result(D, "shop", "running", true);
    await bench.control.settleCreations();
    expect(bench.creations()).toHaveLength(1);
    // The owner removes shop: its name freed, and the creation dropped with it.
    rmSync(join(bench.root, "sites", "shop"), { recursive: true });
    const freed = await bench.forget("shop");
    expect(await freed.json()).toEqual({ slug: "shop", forgotten: dave.token.id, access: 0 });
    expect(bench.creations()).toEqual([]);
    // Then deploys their own shop over SSH, and makes Erin its Admin.
    mkdirSync(join(bench.root, "sites", "shop"));
    expect((await bench.ownerGrant("shop", ERIN, "admin")).status).toBe(201);
    bench.clock.now += CREATION_MAX_AGE_MS;
    await bench.control.settleCreations();
    expect(await bench.entries("shop")).toEqual([`${ERIN}:admin`]);
    expect(await bench.members.rights(ERIN)).toEqual({ email: ERIN, roles: { blog: "viewer", shop: "admin" }, create: false });
    expect(creates(bench)).toEqual([]);
  });

  test("access given while Dave's installer still runs, to Erin and to Dave himself: the creation records nothing, and says so", async () => {
    const bench = await wire(registryWith([], [DAVE]), []);
    const dave = await bench.mint(DAVE, true);
    const D = "dadadadadadadadadadadada";
    expect((await bench.deploy(dave.secret, D, "shop")).status).toBe(202);
    bench.result(D, "shop", "running", true);
    expect((await bench.ownerGrant("shop", ERIN, "admin")).status).toBe(201);
    expect((await bench.ownerGrant("shop", DAVE, "viewer")).status).toBe(201);
    bench.result(D, "shop", "succeeded", true);
    expect(await shown(bench, D)).toBe("succeeded");
    expect((await bench.entries("shop")).sort()).toEqual([`${DAVE}:viewer`, `${ERIN}:admin`]);
    expect(creates(bench)).toEqual([]);
    expect(bench.creations()).toEqual([]);
    expect(bench.journal.filter((event) => event.operation === "project.create")).toEqual([
      expect.objectContaining({ result: "rejects", actor: DAVE, slug: "shop", detail: expect.stringContaining("shop already has people with access") }),
    ]);
  });

  test("neither another person's token nor another of Dave's deploys it, and nothing settles for them", async () => {
    const { bench, untouched } = await overlaid("running", [DAVE, CAROL]);
    const carol = await bench.mint(CAROL, true);
    const second = await bench.mint(DAVE, true);
    bench.clock.now += HOUR;
    expect(await refusal(await bench.deploy(carol.secret, "c0c0c0c0c0c0c0c0c0c0c0c0", "shop"))).toEqual({ status: 403, message: `${CAROL} holds no role on shop` });
    expect(await refusal(await bench.deploy(second.secret, "c1c1c1c1c1c1c1c1c1c1c1c1", "shop"))).toEqual({ status: 403, message: `${DAVE} holds no role on shop` });
    await bench.control.settleCreations();
    await untouched();
    expect(bench.creations()).toEqual([]);
  });

  test("a finished creation whose name is no longer its token's records nothing", async () => {
    const bench = await wire(registryWith([], [DAVE]), []);
    const dave = await bench.mint(DAVE, true);
    const D = "ffffffffffffffffffffffff";
    expect((await bench.deploy(dave.secret, D, "shop")).status).toBe(202);
    // The registry of tokens edited by hand, or restored: the name is nobody's.
    const team = bench.team();
    delete team.owners.shop;
    writeFileSync(join(bench.root, "state", "team.json"), JSON.stringify(team), { mode: 0o600 });
    bench.result(D, "shop", "succeeded", true);
    await bench.control.settleCreations();
    expect(await bench.entries("shop")).toEqual([]);
    expect(bench.creations()).toEqual([]);
    expect(creates(bench)).toEqual([]);
  });

  test("the create right taken back before the installer ends: nobody made Admin, of Dave's own project either", async () => {
    const bench = await wire(registryWith([], [DAVE]), []);
    const dave = await bench.mint(DAVE, true);
    const D = "acacacacacacacacacacacac";
    expect((await bench.deploy(dave.secret, D, "shop")).status).toBe(202);
    bench.result(D, "shop", "running", true);
    const read = await bench.store.read();
    if (read instanceof Response) throw new Error("the registry does not read");
    const taken = setCreate(read, DAVE, false, "owner", bench.clock.now);
    if ("refusal" in taken) throw new Error(taken.refusal);
    writeFileSync(join(bench.root, "state", "access.json"), encodeRegistry(taken.registry), { mode: 0o600 });
    bench.clock.now += STALE;
    expect(await shown(bench, D)).toBe("failed");
    expect(await bench.entries("shop")).toEqual([]);
    expect(creates(bench)).toEqual([]);
    expect(bench.creations()).toEqual([]);
  });

  test("not settled within a day, Dave's own project included: dropped, nobody made Admin, the project the owner's to give", async () => {
    const bench = await wire(registryWith([], [DAVE]), []);
    const dave = await bench.mint(DAVE, true);
    const D = "bdbdbdbdbdbdbdbdbdbdbdbd";
    expect((await bench.deploy(dave.secret, D, "shop")).status).toBe(202);
    bench.result(D, "shop", "succeeded", true);
    // The steward down for a day: its first settle comes too late.
    bench.clock.now += CREATION_MAX_AGE_MS;
    expect(await shown(bench, D)).toBe("succeeded");
    expect(await bench.entries("shop")).toEqual([]);
    expect(creates(bench)).toEqual([]);
    expect(bench.creations()).toEqual([]);
    expect(bench.team().owners).toEqual({ shop: dave.token.id });
    expect(await refusal(await bench.preflight(dave.secret, "shop"))).toEqual({ status: 403, message: `${DAVE} holds no role on shop` });
    // The owner gives it by hand.
    expect((await bench.ownerGrant("shop", DAVE, "admin")).status).toBe(201);
    expect(await (await bench.preflight(dave.secret, "shop")).json()).toEqual({ creating: false });
  });
});

describe("a settle racing the owner", () => {
  test("held on systemctl while the owner removes shop: no deadlock, nobody made Admin, the name nobody's", async () => {
    const bench = await wire(registryWith([], [DAVE]), []);
    const dave = await bench.mint(DAVE, true);
    const D = "101010101010101010101010";
    expect((await bench.deploy(dave.secret, D, "shop")).status).toBe(202);
    bench.result(D, "shop", "running", true);
    bench.clock.now += STALE;
    // The settle asks systemd whether the installer still runs, in the creations' turn.
    const release = bench.holdActive();
    const settling = bench.control.settleCreations();
    await Bun.sleep(20);
    rmSync(join(bench.root, "sites", "shop"), { recursive: true });
    const removal = bench.forget("shop");
    await Bun.sleep(20);
    release();
    await settling;
    expect(await (await removal).json()).toEqual({ slug: "shop", forgotten: dave.token.id, access: 0 });
    expect(await bench.entries("shop")).toEqual([]);
    expect(bench.team().owners).toEqual({});
    expect(bench.creations()).toEqual([]);
    expect(creates(bench)).toEqual([]);
  });

  test("held on systemctl while the owner gives Erin access to the project Dave's installer laid: the grant stands, the creation records nothing", async () => {
    const bench = await wire(registryWith([], [DAVE]), []);
    const dave = await bench.mint(DAVE, true);
    const D = "202020202020202020202020";
    expect((await bench.deploy(dave.secret, D, "shop")).status).toBe(202);
    bench.result(D, "shop", "running", true);
    bench.clock.now += STALE;
    const release = bench.holdActive();
    const settling = bench.control.settleCreations();
    await Bun.sleep(20);
    expect((await bench.ownerGrant("shop", ERIN, "admin")).status).toBe(201);
    release();
    await settling;
    expect(await bench.entries("shop")).toEqual([`${ERIN}:admin`]);
    expect(creates(bench)).toEqual([]);
    expect(bench.creations()).toEqual([]);
    expect(bench.team().owners).toEqual({ shop: dave.token.id });
  });

  test("the timer and the dashboard's reads settle at once: one Admin, journaled once", async () => {
    const bench = await wire(registryWith([], [DAVE]), []);
    const dave = await bench.mint(DAVE, true);
    const D = "303030303030303030303030";
    expect((await bench.deploy(dave.secret, D, "shop")).status).toBe(202);
    bench.result(D, "shop", "succeeded", true);
    await Promise.all([bench.control.settleCreations(), shown(bench, D), bench.control.settleCreations(), shown(bench, D)]);
    expect(await bench.entries("shop")).toEqual([`${DAVE}:admin`]);
    expect(creates(bench)).toHaveLength(1);
    expect(bench.creations()).toEqual([]);
  });
});

describe("a creation stays its own token's", () => {
  test("the owner removes shop while Dave's installer still runs, which lays it again: nobody made Admin, and Dave is refused it", async () => {
    const bench = await wire(registryWith([], [DAVE]), []);
    const dave = await bench.mint(DAVE, true);
    const D = "777777777777777777777777";
    expect((await bench.deploy(dave.secret, D, "shop")).status).toBe(202);
    expect((await bench.forget("shop")).status).toBe(200);
    expect(bench.creations()).toEqual([]);
    bench.result(D, "shop", "succeeded", true);
    await bench.control.settleCreations();
    expect(await bench.entries("shop")).toEqual([]);
    expect(bench.team().owners).toEqual({});
    expect(await refusal(await bench.preflight(dave.secret, "shop"))).toEqual({ status: 403, message: `${DAVE} holds no role on shop` });
    expect(await refusal(await bench.deploy(dave.secret, "888888888888888888888888", "shop"))).toEqual({ status: 403, message: `${DAVE} holds no role on shop` });
    expect(creates(bench)).toEqual([]);
  });

  test("neither someone else's token nor another of the same person's deploys it while it runs", async () => {
    const bench = await wire(registryWith([], [DAVE, ERIN]), []);
    const dave = await bench.mint(DAVE, true);
    const D = "999999999999999999999999";
    expect((await bench.deploy(dave.secret, D, "shop")).status).toBe(202);
    bench.result(D, "shop", "running", true);
    const erin = await bench.mint(ERIN, true);
    expect(await refusal(await bench.deploy(erin.secret, "aaaaaaaaaaaaaaaaaaaaaaaa", "shop"))).toEqual({ status: 403, message: `${ERIN} holds no role on shop` });
    const second = await bench.mint(DAVE, true);
    expect(await refusal(await bench.deploy(second.secret, "bbbbbbbbbbbbbbbbbbbbbbbb", "shop"))).toEqual({ status: 403, message: `${DAVE} holds no role on shop` });
    expect(bench.creations()).toEqual([expect.objectContaining({ deployment: D, token: dave.token.id })]);
    expect(bench.team().owners).toEqual({ shop: dave.token.id });
  });
});

describe("undone creations give their names back", () => {
  const slugOf = (n: number) => `${"x".repeat(56)}-${String(n).padStart(6, "0")}`;
  const idOf = (n: number) => n.toString(16).padStart(24, "0");

  test("attempts at the hourly bound, each refused by the installer with nothing laid: the registry of tokens does not grow", async () => {
    const bench = await wire(registryWith([], [DAVE]), []);
    const dave = await bench.mint(DAVE, true);
    let n = 0;
    let accepted = 0;
    for (let hour = 0; hour < 3; hour++) {
      for (let i = 0; i < 120; i++, n++) {
        const response = await bench.deploy(dave.secret, idOf(n), slugOf(n));
        if (response.status !== 202) continue;
        accepted++;
        bench.result(idOf(n), slugOf(n), "failed", false);
        // The dashboard's tracker reads each result within seconds.
        if (i % 10 === 9) await bench.control.settleCreations();
      }
      await bench.control.settleCreations();
      bench.clock.now += HOUR + 1;
    }
    expect(accepted).toBe(3 * 120);
    expect(bench.team().owners).toEqual({});
    expect(bench.creations()).toEqual([]);
    expect(statSync(join(bench.root, "state", "team.json")).size).toBeLessThan(4096);
    expect(creates(bench)).toEqual([]);
  });

  test("a token holds a bounded number of names the machine does not carry: past it, nothing new until some settle", async () => {
    const bench = await wire(registryWith([], [DAVE]), []);
    const dave = await bench.mint(DAVE, true);
    for (let n = 0; n < MAX_UNCARRIED_NAMES; n++) expect((await bench.deploy(dave.secret, idOf(n), slugOf(n))).status).toBe(202);
    const refused = await bench.deploy(dave.secret, idOf(99), slugOf(99));
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { message: string }).message).toContain(`already holds ${MAX_UNCARRIED_NAMES} names of projects the machine does not carry`);
    // A name it holds already is deployed again all the same.
    bench.result(idOf(0), slugOf(0), "failed", false);
    expect((await bench.deploy(dave.secret, idOf(100), slugOf(1))).status).toBe(202);
    // One laid on the machine counts no more; the undone ones settle and come back.
    bench.result(idOf(100), slugOf(1), "succeeded", true);
    for (let n = 2; n < MAX_UNCARRIED_NAMES; n++) bench.result(idOf(n), slugOf(n), "failed", false);
    await bench.control.settleCreations();
    expect(bench.team().owners).toEqual({ [slugOf(1)]: dave.token.id });
    expect((await bench.deploy(dave.secret, idOf(101), slugOf(101))).status).toBe(202);
  });

  test("the owner's own token is bounded too, and the owner frees a name with sitesolide remove", async () => {
    const bench = await wire(registryWith([], []), []);
    const ci = await bench.mint("owner", true);
    for (let n = 0; n < MAX_UNCARRIED_NAMES; n++) expect((await bench.deploy(ci.secret, idOf(n), slugOf(n))).status).toBe(202);
    const refused = await bench.deploy(ci.secret, idOf(99), slugOf(99));
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { message: string }).message).toContain("sitesolide remove --confirm <name>");
    expect((await bench.forget(slugOf(0))).status).toBe(200);
    expect((await bench.deploy(ci.secret, idOf(99), slugOf(99))).status).toBe(202);
  });

  test("a name laid on the machine since keeps its owner: only names still not carried come back", async () => {
    const bench = await wire(registryWith([], [DAVE]), []);
    const dave = await bench.mint(DAVE, true);
    expect((await bench.deploy(dave.secret, idOf(1), "shop")).status).toBe(202);
    expect((await bench.deploy(dave.secret, idOf(2), "cafe")).status).toBe(202);
    bench.result(idOf(1), "shop", "failed", false);
    bench.result(idOf(2), "cafe", "failed", false);
    // The tokens' queue held by a deployment waiting on systemctl while the
    // creations settle, both undone: cafe is laid before the names come back.
    const release = bench.holdActive();
    const deploying = bench.deploy(dave.secret, idOf(3), "bar");
    await Bun.sleep(20);
    const settled = bench.control.settleCreations();
    await Bun.sleep(50);
    expect(bench.creations()).toEqual([]);
    mkdirSync(join(bench.root, "sites", "cafe"));
    release();
    expect((await deploying).status).toBe(202);
    await settled;
    expect(bench.team().owners).toEqual({ cafe: dave.token.id, bar: dave.token.id });
  });

  test("a name created again before it comes back keeps its token: the new creation makes its person Admin", async () => {
    const bench = await wire(registryWith([], [DAVE]), []);
    const dave = await bench.mint(DAVE, true);
    expect((await bench.deploy(dave.secret, idOf(1), "shop")).status).toBe(202);
    bench.result(idOf(1), "shop", "failed", false);
    // Dave deploys shop again, held on systemctl in the tokens' queue; the
    // first creation is undone meanwhile, its name to come back behind him.
    const release = bench.holdActive();
    const deploying = bench.deploy(dave.secret, idOf(2), "shop");
    await Bun.sleep(20);
    const settled = bench.control.settleCreations();
    await Bun.sleep(20);
    release();
    expect((await deploying).status).toBe(202);
    await settled;
    expect(bench.team().owners).toEqual({ shop: dave.token.id });
    expect(bench.creations()).toEqual([expect.objectContaining({ deployment: idOf(2), slug: "shop" })]);
    bench.result(idOf(2), "shop", "succeeded", true);
    await bench.control.settleCreations();
    expect(await bench.entries("shop")).toEqual([`${DAVE}:admin`]);
    expect(creates(bench)).toHaveLength(1);
  });
});

describe("the tokens of someone with no role are swept", () => {
  test("taken out of a registry restored by hand, their tokens alive still: revoked, journaled, and dead when they come back", async () => {
    const bench = await wire(registryWith([["blog", CAROL, "developer"]], []), ["blog"]);
    const carol = await bench.mint(CAROL, false, ["blog"]);
    expect((await bench.post("/control/authenticate", { bearer: carol.secret })).status).toBe(200);
    // The registry put back by hand from a copy without her: no leave ran.
    const read = await bench.store.read();
    if (read instanceof Response) throw new Error("the registry does not read");
    writeFileSync(join(bench.root, "state", "access.json"), encodeRegistry(removePerson(read, CAROL).registry), { mode: 0o600 });

    const revoked = await bench.control.sweepTokens();
    expect(revoked.map((token) => token.id)).toEqual([carol.token.id]);
    expect(bench.journal.filter((event) => event.operation === "token.revoke")).toEqual([
      { operation: "token.revoke", result: "ok", actor: "system", member: CAROL, detail: `${carol.token.id}: ${CAROL} has no role on this dashboard` },
    ]);
    // Given a role again, the old token stays dead.
    expect((await bench.ownerGrant("blog", CAROL, "developer")).status).toBe(201);
    const again = await bench.post("/control/authenticate", { bearer: carol.secret });
    expect(again.status).toBe(401);
    expect(((await again.json()) as { message: string }).message).toContain("revoked");
    // Swept again: nothing left to revoke, nothing journaled.
    expect(await bench.control.sweepTokens()).toEqual([]);
    expect(bench.journal.filter((event) => event.operation === "token.revoke")).toHaveLength(1);
  });

  test("someone with a role keeps theirs, the owner's own are never touched, and a registry that does not read revokes nothing", async () => {
    const bench = await wire(registryWith([["blog", CAROL, "developer"]], []), ["blog"]);
    const carol = await bench.mint(CAROL, false, ["blog"]);
    const ci = await bench.mint("owner", false, ["blog"]);
    expect(await bench.control.sweepTokens()).toEqual([]);
    writeFileSync(join(bench.root, "state", "access.json"), "not json", { mode: 0o600 });
    expect(await bench.control.sweepTokens()).toEqual([]);
    expect(bench.team().tokens.map((token) => [token.id, token.revokedAt])).toEqual(
      expect.arrayContaining([
        [carol.token.id, null],
        [ci.token.id, null],
      ]),
    );
  });
});
