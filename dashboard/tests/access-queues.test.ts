import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccessRoutes, createAccessStore } from "../src/access/steward";
import { createAccessSystem } from "../src/access/system";
import { EMPTY_REGISTRY, encodeRegistry, putEntry, setCreate, type Registry } from "../src/access/registry";
import { createMemberRoutes } from "../src/people/steward";
import { createMembersSystem } from "../src/people/system";
import { createControlSteward, type ControlHandler } from "../src/control/steward";
import { createControlSystem } from "../src/control/system";
import { INSTALLER_TEMPLATE, type InstallerResult } from "../src/control/protocol";

/**
 * The steward's queues wired together as dashboard/steward.ts and
 * src/secrets/steward.ts wire them: the real access store and routes, the
 * real people routes, the real control routes, on a throwaway tree, with
 * `systemctl is-active` taking a moment, as it does on a busy machine. Each
 * queue waits only on the ones below it (src/people/steward.ts); these runs
 * put two of them in each other's way, and every request must still answer.
 */

const ZONE = "test-zone.invalid";
const DAVE = "dave@acme.test";
const CAROL = "carol@acme.test";
const ERIN = "erin@acme.test";

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

async function wire(registry: Registry, sites: string[]) {
  const root = mkdtempSync(join(tmpdir(), "access-queues-"));
  folders.push(root);
  for (const folder of ["state", "units", "installer", "portal-key", "secrets", ...sites.map((slug) => `sites/${slug}`)]) mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, "units", INSTALLER_TEMPLATE), "[Service]\n");
  writeFileSync(join(root, "secrets", "portal.env"), "OIDC_ISSUER=https://id.example\nOIDC_CLIENT_ID=x\nOIDC_CLIENT_SECRET=y\nOIDC_ALLOWED_DOMAINS=acme.test\n");
  writeFileSync(join(root, "state", "access.json"), encodeRegistry(registry), { mode: 0o600 });

  const accessSystem = createAccessSystem({ stateFolder: join(root, "state"), portalKeyFolder: join(root, "portal-key"), groupsFile: "/etc/group", portalGroup: "", portalDataFolder: join(root, "none") }, false);
  const store = createAccessStore({ system: accessSystem, zone: ZONE, hostOf: (slug) => `${slug}.${ZONE}`, journal: async () => {} });
  const membersSystem = createMembersSystem({ stateFolder: join(root, "state"), sitesDir: join(root, "sites"), secretsFolder: join(root, "secrets"), portalKeyFolder: join(root, "portal-key"), groupsFile: "/etc/group", portalGroup: "" });
  const readBody = async (req: Request) => (await req.json()) as Record<string, unknown>;
  let control: ControlHandler | null = null;
  const members = createMemberRoutes({
    system: membersSystem,
    access: store,
    zone: ZONE,
    readBody,
    journal: async () => {},
    restart: async () => new Response(null),
    revokeTokens: (email, actor) => control!.revokeMember(email, actor),
  });
  const access = createAccessRoutes({
    store,
    zone: ZONE,
    hostOf: (slug) => `${slug}.${ZONE}`,
    projectExists: (slug) => sites.includes(slug),
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
      async systemctl(args) {
        if (args[0] === "is-active") {
          await Bun.sleep(300);
          return { code: 3, output: "inactive\n" };
        }
        return { code: 0, output: "" };
      },
    },
    {
      zone: ZONE,
      isUnlocked: async (token) => token === "owner-unlock",
      uidRoot: null,
      members: { authorize: members.authorize, unlockedUntil: members.unlockedUntil, rights: members.rights, recordCreation: members.recordCreation, leave: members.leave, journal: members.journal, journalRefusal: members.journalRefusal },
      access: access.forToken,
      forgetAccess: access.forgetProject,
    },
  );
  await store.ensure();
  expect(await control.migrateTokens()).toBe(true);

  const post = (path: string, body: unknown) => control!(new Request(`http://steward${path}`, { method: "POST", body: JSON.stringify(body) }));
  const mint = async (holder: string, create: boolean, slugs: string[] = []) => {
    const made = await post("/tokens/create", { token: "owner-unlock", label: holder, holder, expiresAt: null, scope: { slugs, create, outbound: false, domain: false, public: false } });
    if (made.status !== 201) throw new Error(await made.text());
    return (await made.json()) as { token: { id: string }; secret: string };
  };
  const pending = (creations: { deployment: string; slug: string; email: string; token: string }[]) =>
    writeFileSync(join(root, "state", "creations.json"), JSON.stringify({ creations: creations.map((one) => ({ ...one, at: Date.now() - 1000 })) }));
  const succeeded = (deployment: string, slug: string) => {
    const result: InstallerResult = { deployment, slug, state: "succeeded", startedAt: Date.now(), updatedAt: Date.now(), finishedAt: Date.now(), log: [], error: null, url: null, allocated: [] };
    writeFileSync(join(root, "installer", `${deployment}.json`), JSON.stringify(result), { mode: 0o600 });
  };
  return { root, store, access, control, post, mint, pending, succeeded };
}

/** The answer's status, or a word saying it never came: what a stuck queue looks like. */
async function within<T>(promise: Promise<T>, ms = 3000): Promise<T | "still waiting"> {
  return Promise.race([promise, Bun.sleep(ms).then(() => "still waiting" as const)]);
}

const status = (promise: Promise<Response>) => promise.then((response) => response.status);

describe("the steward's queues, wired together", () => {
  test("a deployment creating a project, someone's last role removed and a creation settled, all at once: each answers", async () => {
    const bench = await wire(registryWith([["blog", CAROL, "developer"], ["blog", DAVE, "admin"]], [DAVE]), ["blog", "made"]);
    const dave = await bench.mint(DAVE, true);
    const carol = await bench.mint(CAROL, false, ["blog"]);
    bench.pending([{ deployment: "aaaaaaaaaaaaaaaaaaaaaaaa", slug: "made", email: DAVE, token: dave.token.id }]);
    bench.succeeded("aaaaaaaaaaaaaaaaaaaaaaaa", "made");

    // The tokens' queue, waiting on is-active, then on the creations' turn.
    const deploy = status(bench.post("/control/deploy", { bearer: dave.secret, deployment: "bbbbbbbbbbbbbbbbbbbbbbbb", slug: "fresh", manifest: JSON.stringify({ slug: "fresh" }) }));
    await Bun.sleep(20);
    // The registry's queue, then Carol leaving, then her tokens.
    const removal = status(bench.access.owner["/access/entry"]!.DELETE!(new Request("http://steward/access/entry", { method: "DELETE", body: JSON.stringify({ slug: "blog", who: CAROL }) })));
    await Bun.sleep(50);
    // The creations' turn, then the registry's queue.
    const settled = bench.control.settleCreations().then(() => "settled");

    expect(await within(deploy)).toBe(202);
    expect(await within(removal)).toBe(200);
    expect(await within(settled)).toBe("settled");
    // Nothing is left stuck behind them.
    const later = status(bench.access.owner["/access/entry"]!.PUT!(new Request("http://steward/access/entry", { method: "PUT", body: JSON.stringify({ slug: "blog", who: ERIN, role: "visitor" }) })));
    expect(await within(later)).toBe(201);
    expect(await within(status(bench.post("/tokens/revoke", { id: dave.token.id })))).toBe(200);

    // Carol's token went with her; Dave is Admin of what he made.
    const authenticated = await bench.post("/control/authenticate", { bearer: carol.secret });
    expect(authenticated.status).toBe(401);
    const registry = await bench.store.read();
    if (registry instanceof Response) throw new Error("the registry does not read");
    expect(registry.projects.made).toEqual([expect.objectContaining({ who: DAVE, role: "admin" })]);
  });

  test("a creation that drops someone's last role while a deployment waits on the creations: the leaver's tokens go once the turn is over", async () => {
    // Erin's last role is on a project of that name removed by hand: the new project starts from nobody.
    const bench = await wire(registryWith([["made", ERIN, "developer"], ["blog", DAVE, "admin"]], [DAVE]), ["blog", "made"]);
    const dave = await bench.mint(DAVE, true);
    const erin = await bench.mint(ERIN, false, ["made"]);
    bench.pending([{ deployment: "cccccccccccccccccccccccc", slug: "made", email: DAVE, token: dave.token.id }]);
    bench.succeeded("cccccccccccccccccccccccc", "made");

    // The tokens' queue first, held by is-active, then wanting the creations' turn.
    const deploy = status(bench.post("/control/deploy", { bearer: dave.secret, deployment: "dddddddddddddddddddddddd", slug: "other", manifest: JSON.stringify({ slug: "other" }) }));
    await Bun.sleep(20);
    // The creations' turn records "made", which drops Erin: her tokens want the tokens' queue.
    const settled = bench.control.settleCreations().then(() => "settled");

    expect(await within(deploy)).toBe(202);
    expect(await within(settled)).toBe("settled");
    expect((await bench.post("/control/authenticate", { bearer: erin.secret })).status).toBe(401);
    const tokens = (await (await bench.control(new Request("http://steward/tokens/list"))).json()) as { tokens: { id: string; revokedAt: number | null }[] };
    expect(tokens.tokens.find((one) => one.id === erin.token.id)?.revokedAt).not.toBeNull();
  });

  test("given a role back before the control routes revoke, they keep their tokens: judged again in the tokens' queue", async () => {
    const bench = await wire(registryWith([["blog", CAROL, "developer"]], []), ["blog"]);
    const carol = await bench.mint(CAROL, false, ["blog"]);
    // She leaves, and someone gives her a role back before the revocation runs.
    expect(await bench.control.revokeMember(CAROL, "owner")).toEqual([]);
    expect((await bench.post("/control/authenticate", { bearer: carol.secret })).status).toBe(200);
  });
});
