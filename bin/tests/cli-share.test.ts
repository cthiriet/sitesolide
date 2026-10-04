import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFragment } from "../cli/fragment";
import type { Manifest } from "../cli/manifest";
import {
  describeSharing,
  nextPolicy,
  readCurlAnswer,
  readShareArguments,
  sharingWriteCommand,
  type Policy,
  type ShareRequest,
  type SharingState,
} from "../cli/sharing";
import { createFakeVm, type FakeVm } from "./e2e/fake-vm";
import { CLI, TEST_EMAIL, TEST_ZONE } from "./e2e/run";

/**
 * `sitesolide share`, both ways it runs: the real bin/sitesolide.ts in a child
 * process, through a local fake of the dashboard's control API with a team
 * token, and over the owner's SSH in front of the fake machine, whose ssh
 * answers the reads it recognises, the portal's sharing among them, and
 * refuses every write the test does not accept. The decisions themselves are
 * tried at the end, without running anything.
 */

const TOKEN = `sst_${"S".repeat(43)}`;
const HOST = `kanban.${TEST_ZONE}`;
const toClean: string[] = [];

function folder(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  toClean.push(path);
  return path;
}

const APP: Manifest = { slug: "kanban", port: 3045, publicDir: "public", start: "/usr/local/bin/bun run server.ts", portal: true };

function project(manifest: Manifest = APP): string {
  const root = folder("share-project-");
  writeFileSync(join(root, "sitesolide.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return root;
}

type Event = Record<string, any>;
const events = (output: string): Event[] =>
  output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Event);

// --- the fake API ----------------------------------------------------------------------

const api = {
  policy: { mode: "admins", people: [], domains: [] } as Policy,
  allowedDomains: ["acme.test"],
  configured: true,
  /** A refusal the next request gets, as the dashboard words it. */
  refuse: null as { status: number; error: string; message: string; details?: string[] } | null,
  received: [] as { method: string; path: string; authorization: string | null; body: unknown }[],
};

let server: ReturnType<typeof Bun.serve>;
let base: string;
let vm: FakeVm;

function sharing(): SharingState {
  return {
    slug: "kanban",
    host: HOST,
    url: `https://${HOST}/`,
    policy: api.policy,
    updatedAt: 1_791_000_000_000,
    sso: { configured: api.configured, providerName: "Google" },
    allowedDomains: api.allowedDomains,
  };
}

beforeAll(() => {
  vm = createFakeVm();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "PUT" ? ((await req.json()) as unknown) : null;
      api.received.push({ method: req.method, path: url.pathname, authorization: req.headers.get("authorization"), body });
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: "unauthenticated", message: "missing or unknown token" }, { status: 401 });
      if (api.refuse !== null) return Response.json(api.refuse, { status: api.refuse.status });
      if (url.pathname !== "/api/v1/projects/kanban/sharing") return Response.json({ error: "not-found", message: "no project for this token" }, { status: 404 });
      if (req.method === "PUT") api.policy = body as Policy;
      return Response.json({ sharing: sharing() });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  vm.cleanup();
});

beforeEach(() => {
  api.policy = { mode: "admins", people: [], domains: [] };
  api.allowedDomains = ["acme.test"];
  api.configured = true;
  api.refuse = null;
  api.received.length = 0;
});

afterEach(() => {
  for (const path of toClean.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** The CLI as a team member runs it: no server, a HOME of its own, the token in the environment. */
async function remote(cwd: string, arguments_: string[]) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SITESOLIDE_")));
  const proc = Bun.spawn(["bun", CLI, ...arguments_], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...inherited, PATH: vm.env.PATH!, FAKE_VM: vm.env.FAKE_VM!, HOME: folder("share-home-"), SITESOLIDE_API: base, SITESOLIDE_TOKEN: TOKEN },
  });
  const [output, error] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, output, error };
}

const puts = () => api.received.filter((entry) => entry.method === "PUT").map((entry) => entry.body);

describe("share with a team token, through the API", () => {
  test("no argument: the policy and the line to send, nothing changed", async () => {
    const result = await remote(project(), ["share"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain(`-> sharing of kanban, https://${HOST}/, through ${base}`);
    expect(result.output).toContain("who gets in: the admins alone");
    // Nobody beyond the admins yet: nothing to send.
    expect(result.output).not.toContain("send:");
    expect(api.received.map((entry) => `${entry.method} ${entry.path}`)).toEqual(["GET /api/v1/projects/kanban/sharing"]);
    expect(api.received[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("people added: the site switches from the admins alone to them, and --json ends with the result", async () => {
    const result = await remote(project(), ["share", "Alice@Acme.test", "bob@acme.test", "--json"]);
    expect(result.code).toBe(0);
    expect(puts()).toEqual([{ mode: "people", people: ["alice@acme.test", "bob@acme.test"], domains: [] }]);
    const list = events(result.output);
    expect(list[0]).toEqual({ type: "step", message: `sharing of kanban, https://${HOST}/, through ${base}` });
    expect(list.at(-1)).toMatchObject({
      type: "result",
      ok: true,
      command: "share",
      slug: "kanban",
      url: `https://${HOST}/`,
      changed: true,
      policy: { mode: "people", people: ["alice@acme.test", "bob@acme.test"], domains: [] },
      previous: { mode: "admins", people: [], domains: [] },
      inEffect: { people: ["alice@acme.test", "bob@acme.test"], domains: [] },
      message: `Open https://${HOST}/ and sign in with your Google work account.`,
    });
  });

  test("--domain: everyone at the domain, the people kept", async () => {
    api.policy = { mode: "people", people: ["alice@acme.test"], domains: [] };
    const result = await remote(project(), ["share", "--domain", "acme.test"]);
    expect(result.code).toBe(0);
    expect(puts()).toEqual([{ mode: "domain", people: ["alice@acme.test"], domains: ["acme.test"] }]);
    expect(result.output).toContain("domains: acme.test");
  });

  test("--remove: a person, then a domain, the mode narrowed to what still applies", async () => {
    api.policy = { mode: "domain", people: ["alice@acme.test", "bob@acme.test"], domains: ["acme.test"] };
    expect((await remote(project(), ["share", "--remove", "alice@acme.test"])).code).toBe(0);
    expect((await remote(project(), ["share", "--remove", "acme.test"])).code).toBe(0);
    expect((await remote(project(), ["share", "--remove", "bob@acme.test"])).code).toBe(0);
    expect(puts()).toEqual([
      { mode: "domain", people: ["bob@acme.test"], domains: ["acme.test"] },
      { mode: "people", people: ["bob@acme.test"], domains: [] },
      { mode: "admins", people: [], domains: [] },
    ]);
  });

  test("--only-admins: back to the admins, the lists kept for later as the dashboard keeps them", async () => {
    api.policy = { mode: "people", people: ["alice@acme.test"], domains: [] };
    const result = await remote(project(), ["share", "--only-admins"]);
    expect(result.code).toBe(0);
    expect(puts()).toEqual([{ mode: "admins", people: ["alice@acme.test"], domains: [] }]);
    expect(result.output).toContain("kept for later, not in effect: alice@acme.test");
  });

  test("someone kept from an earlier sharing who gets in again is said, never let in silently", async () => {
    api.policy = { mode: "admins", people: ["old@acme.test"], domains: [] };
    const list = events((await remote(project(), ["share", "new@acme.test", "--json"])).output);
    expect(list).toContainEqual({ type: "warning", message: "let in again, kept from an earlier sharing: old@acme.test; take them off with --remove", details: [] });
    expect(puts()).toEqual([{ mode: "people", people: ["new@acme.test", "old@acme.test"], domains: [] }]);
  });

  test("what changes nothing sends nothing", async () => {
    api.policy = { mode: "people", people: ["alice@acme.test"], domains: [] };
    const result = await remote(project(), ["share", "alice@acme.test", "--json"]);
    expect(result.code).toBe(0);
    expect(events(result.output).at(-1)).toMatchObject({ type: "result", command: "share", changed: false });
    expect(puts()).toEqual([]);
  });

  test("a person outside the domains the portal admits, and sign-in not set up, are warned of", async () => {
    let list = events((await remote(project(), ["share", "eve@elsewhere.test", "--json"])).output);
    expect(list.filter((event) => event.type === "warning").map((event) => event.message)).toEqual([
      "eve@elsewhere.test cannot sign in: the portal admits only acme.test, unless they are admins",
    ]);
    api.configured = false;
    api.allowedDomains = [];
    list = events((await remote(project(), ["share", "--json"])).output);
    expect(list.some((event) => event.type === "warning" && String(event.message).includes("not set up"))).toBe(true);
    expect(list.at(-1)).toMatchObject({ type: "result", message: null });
  });

  test("the dashboard's refusals reach the agent with their code's hint: a domain out of scope, no portal, an old portal", async () => {
    const cases = [
      { status: 403, error: "out-of-scope", message: "your token may open a site only to the domains the portal admits at sign-in: acme.test", details: ["gmail.test: not among the domains the portal admits at sign-in"], hint: "never pick another slug or another token" },
      { status: 409, error: "no-portal", message: "kanban is not behind the portal", hint: "Access section" },
      { status: 503, error: "not-available", message: "the portal on this machine does not know sharing yet", hint: "a portal that knows sharing" },
      { status: 404, error: "not-found", message: "no project kanban for this token", hint: "sitesolide status" },
    ];
    for (const refusal of cases) {
      api.refuse = { status: refusal.status, error: refusal.error, message: refusal.message, ...(refusal.details === undefined ? {} : { details: refusal.details }) };
      const result = await remote(project(), ["share", "--domain", "gmail.test", "--json"]);
      expect({ error: refusal.error, code: result.code }).toEqual({ error: refusal.error, code: 1 });
      const error = events(result.output).at(-1)!;
      expect(error).toMatchObject({ type: "error", message: refusal.message, details: refusal.details ?? [] });
      expect(error.hint).toContain(refusal.hint);
    }
  });

  test("a dashboard from before these routes: not-available, never a project the token cannot see", async () => {
    api.refuse = { status: 404, error: "not-found", message: "no such route: see docs/team.md for the control API's routes" };
    const error = events((await remote(project(), ["share", "--json"])).output).at(-1)!;
    expect(error).toMatchObject({ type: "error", message: expect.stringContaining("does not carry sharing yet") });
    expect(error.hint).toContain("tell the owner of the machine");
  });

  test("bad arguments are refused before a request leaves, each with a hint", async () => {
    const root = project();
    for (const [arguments_, message] of [
      [["share", "acme.test"], "acme.test is not an email address: to share with everyone at a domain, use --domain acme.test; nothing was changed"],
      [["share", "not an address"], "not an address is not an email address the portal accepts: nothing was changed"],
      [["share", "--domain", "com"], "com is not a domain the portal accepts, like acme.com: nothing was changed"],
      [["share", "--domain"], "--domain: a domain, like acme.com must follow"],
      [["share", "--only-admins", "alice@acme.test"], "--only-admins takes the site back to the admins alone: it cannot be combined with people or --domain"],
      [["share", "--public"], "--public: not an option of sitesolide share with a team token: nothing was sent"],
    ] as const) {
      const result = await remote(root, [...arguments_, "--json"]);
      const error = events(result.output).at(-1)!;
      expect({ arguments_, code: result.code, message: error.message }).toEqual({ arguments_, code: 1, message });
      expect(error.hint).toBeString();
    }
    expect(api.received).toEqual([]);
  });

  test("the usage with a team token names share, and a folder without a manifest is refused", async () => {
    const empty = folder("share-empty-");
    const result = await remote(empty, ["share", "--json"]);
    expect(result.code).toBe(1);
    expect(events(result.output).at(-1)!.message).toContain("sitesolide.json not found");
    const usage = await remote(empty, []);
    expect(usage.error).toContain("sitesolide share");
  });
});

// --- the owner, over SSH ----------------------------------------------------------------

describe("share as the owner, over SSH to the portal on the loopback", () => {
  let machine: FakeVm;
  beforeEach(() => {
    machine = createFakeVm();
  });
  afterEach(() => machine.cleanup());

  async function owner(cwd: string, arguments_: string[]) {
    const proc = Bun.spawn(["bun", CLI, ...arguments_], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, SITESOLIDE_ZONE: TEST_ZONE, SITESOLIDE_EMAIL: TEST_EMAIL, ...machine.env },
    });
    const [output, error] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, output, error };
  }

  /** kanban deployed behind the portal: its manifest and its block, as deploy leaves them. */
  function deployed(manifest: Manifest = APP): void {
    machine.writeManifest(manifest.slug, `${JSON.stringify(manifest, null, 2)}\n`);
    machine.writeBlock(manifest.slug, generateFragment(manifest)!);
  }

  test("reads the door on the machine, then the portal, and changes only what was asked", async () => {
    deployed();
    machine.setPortal({ sso: { configured: true, providerName: "Google", portalUrl: null, admins: [], allowedDomains: [] } });
    const read = await owner(project(), ["share"]);
    expect(read.code).toBe(0);
    expect(read.output).toContain(`-> sharing of kanban, https://${HOST}/, over SSH, as the owner`);
    expect(machine.logs()).toEqual(["READ kanban", "BLOCK kanban", "SHARING GET"]);

    machine.acceptWrites();
    const changed = await owner(project(), ["share", "alice@acme.test", "--domain", "partner.test", "--json"]);
    expect(changed.code).toBe(0);
    // The body went on standard input, never into the command line.
    expect(machine.logs().filter((line) => line.startsWith("SHARING PUT"))).toEqual([
      `SHARING PUT ${HOST} {"mode":"domain","people":["alice@acme.test"],"domains":["partner.test"]}`,
    ]);
    expect(machine.logs().some((line) => line.startsWith("ACCEPTED") && line.includes("alice"))).toBe(false);
    expect(events(changed.output).at(-1)).toMatchObject({ type: "result", command: "share", changed: true, policy: { mode: "domain", domains: ["partner.test"] } });
    expect(machine.portal().sites).toEqual([{ host: HOST, policy: { mode: "domain", people: ["alice@acme.test"], domains: ["partner.test"] }, updatedAt: 1_791_000_000_000 }]);

    // --remove and --only-admins, the same way.
    expect((await owner(project(), ["share", "--remove", "partner.test"])).code).toBe(0);
    expect((await owner(project(), ["share", "--only-admins"])).code).toBe(0);
    expect(machine.portal().sites[0]!.policy).toEqual({ mode: "admins", people: ["alice@acme.test"], domains: [] });
  });

  test("the change is a write: refused by a machine that accepts none, nothing changed", async () => {
    deployed();
    const result = await owner(project(), ["share", "alice@acme.test", "--json"]);
    expect(result.code).toBe(1);
    expect(events(result.output).at(-1)).toMatchObject({ type: "error", message: "cannot ask the portal on the server over SSH: nothing was changed" });
    expect(machine.portal().sites).toEqual([]);
  });

  test("a site not deployed, public, or whose block lags behind its manifest: no-portal, and the portal is not asked", async () => {
    const cases: [string, () => void][] = [
      ["is not deployed on the server", () => {}],
      ["is not behind the portal", () => deployed({ ...APP, portal: undefined })],
      ["its block in service does not carry it", () => {
        machine.writeManifest("kanban", JSON.stringify(APP));
        machine.writeBlock("kanban", generateFragment({ ...APP, portal: undefined })!);
      }],
    ];
    for (const [message, lay] of cases) {
      machine.cleanup();
      machine = createFakeVm();
      lay();
      const result = await owner(project(), ["share", "--json"]);
      const error = events(result.output).at(-1)!;
      expect({ message, code: result.code, found: String(error.message).includes(message) }).toEqual({ message, code: 1, found: true });
      expect(error.hint).toContain("Access section");
      expect(machine.logs()).not.toContain("SHARING GET");
    }
  });

  test("a portal from before sharing, and a portal that does not answer", async () => {
    deployed();
    machine.setPortal({ state: "old" });
    const old = events((await owner(project(), ["share", "--json"])).output).at(-1)!;
    expect(old).toMatchObject({ type: "error", message: expect.stringContaining("cd portal && sitesolide deploy --force") });
    machine.setPortal({ state: "down" });
    const down = events((await owner(project(), ["share", "--json"])).output).at(-1)!;
    expect(down).toMatchObject({ type: "error", message: "the portal does not answer on the server: nothing was changed" });
    expect(down.details[0]).toContain("curl: (7)");
    expect(down.hint).toContain("never restart it yourself");
  });

  test("the owner may open a site to any domain: the token's limit is the dashboard's, not the portal's", async () => {
    deployed();
    machine.acceptWrites();
    machine.setPortal({ sso: { configured: true, providerName: null, portalUrl: null, admins: [], allowedDomains: ["acme.test"] } });
    const result = await owner(project(), ["share", "--domain", "partner.test"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("send: Open https://kanban.test-zone.invalid/ and sign in with your work account.");
  });
});

// --- the MCP tools ---------------------------------------------------------------------

/** `sitesolide mcp` spawned as a client spawns it, one tool called, its answer. */
async function callTool(cwd: string, env: Record<string, string>, name: string, args: object): Promise<Record<string, any>> {
  const proc = Bun.spawn(["bun", CLI, "mcp"], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`);
  proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } })}\n`);
  proc.stdin.flush();
  const reader = proc.stdout.getReader();
  let text = "";
  for (;;) {
    const answer = text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, any>)
      .find((message) => message.id === 2);
    if (answer !== undefined) {
      proc.stdin.end();
      await proc.exited;
      return answer;
    }
    const { value, done } = await reader.read();
    if (done) throw new Error(`the server ended without answering: ${text}`);
    text += new TextDecoder().decode(value);
  }
}

describe("the share and sharing tools, through the MCP server", () => {
  test("with a team token: share adds the people named, sharing reads them back", async () => {
    const root = project();
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SITESOLIDE_")));
    const env = { ...inherited, PATH: vm.env.PATH!, FAKE_VM: vm.env.FAKE_VM!, HOME: folder("share-home-"), SITESOLIDE_API: base, SITESOLIDE_TOKEN: TOKEN };
    const shared = await callTool(root, env, "share", { folder: root, people: ["alice@acme.test"], domain: "acme.test" });
    expect(shared.result.isError).toBe(false);
    expect(shared.result.structuredContent.result).toMatchObject({
      command: "share",
      changed: true,
      policy: { mode: "domain", people: ["alice@acme.test"], domains: ["acme.test"] },
      message: `Open https://${HOST}/ and sign in with your Google work account.`,
    });
    expect(puts()).toEqual([{ mode: "domain", people: ["alice@acme.test"], domains: ["acme.test"] }]);

    const read = await callTool(root, env, "sharing", { folder: root });
    expect(read.result.isError).toBe(false);
    expect(read.result.structuredContent.result).toMatchObject({ command: "share", changed: false, inEffect: { people: ["alice@acme.test"], domains: ["acme.test"] } });
    expect(puts()).toHaveLength(1);

    // A refusal is a tool error carrying its hint, not a protocol error.
    api.refuse = { status: 403, error: "out-of-scope", message: "your token may open a site only to the domains the portal admits at sign-in: acme.test" };
    const refused = await callTool(root, env, "share", { folder: root, domain: "gmail.test" });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.structuredContent.error.hint).toContain("ask the owner of the machine");
  });

  test("as the owner: sharing reads the machine and the portal, and writes nothing", async () => {
    const machine = createFakeVm();
    try {
      machine.writeManifest("kanban", JSON.stringify(APP));
      machine.writeBlock("kanban", generateFragment(APP)!);
      machine.setPortal({ sites: [{ host: HOST, policy: { mode: "people", people: ["bob@acme.test"], domains: [] }, updatedAt: 1 }] });
      const root = project();
      const read = await callTool(root, { ...process.env, SITESOLIDE_ZONE: TEST_ZONE, SITESOLIDE_EMAIL: TEST_EMAIL, ...machine.env } as Record<string, string>, "sharing", { folder: root });
      expect(read.result.isError).toBe(false);
      expect(read.result.structuredContent.result).toMatchObject({ command: "share", policy: { mode: "people", people: ["bob@acme.test"] }, updatedAt: 1 });
      expect(machine.logs()).toEqual(["READ kanban", "BLOCK kanban", "SHARING GET"]);
    } finally {
      machine.cleanup();
    }
  });
});

// --- the decisions -------------------------------------------------------------------

describe("the pure parts", () => {
  const request = (fields: Partial<ShareRequest>): ShareRequest => ({ people: [], domains: [], remove: { people: [], domains: [] }, onlyAdmins: false, ...fields });
  const policy = (mode: Policy["mode"], people: string[] = [], domains: string[] = []): Policy => ({ mode, people, domains });

  test("the arguments: people, --domain and --remove repeatable, a removal told apart by its @", () => {
    expect(readShareArguments(["share", "b@acme.test", "A@acme.test", "--domain", "@Acme.test", "--remove", "c@acme.test", "--remove", "old.test", "--json"])).toEqual({
      people: ["b@acme.test", "a@acme.test"],
      domains: ["acme.test"],
      remove: { people: ["c@acme.test"], domains: ["old.test"] },
      onlyAdmins: false,
    });
    expect(readShareArguments(["share", "--only-admins", "--remove", "a@acme.test"])).toMatchObject({ onlyAdmins: true });
    expect(readShareArguments(["share", "--yes"])).toMatchObject({ error: "unknown-option" });
    expect(readShareArguments(["share", "--remove", "--only-admins"])).toMatchObject({ error: "usage" });
  });

  test("the next policy: switching modes, narrowing what no longer applies, saying who comes back", () => {
    expect(nextPolicy(policy("admins"), request({ people: ["a@acme.test"] }))).toMatchObject({ policy: policy("people", ["a@acme.test"]), reopened: [] });
    expect(nextPolicy(policy("admins", [], ["kept.test"]), request({ domains: ["acme.test"] }))).toMatchObject({
      policy: policy("domain", [], ["acme.test", "kept.test"]),
      reopened: ["kept.test"],
    });
    expect(nextPolicy(policy("domain", ["a@acme.test"], ["acme.test"]), request({ remove: { people: [], domains: ["acme.test"] } })).policy).toEqual(policy("people", ["a@acme.test"]));
    expect(nextPolicy(policy("people", ["a@acme.test"]), request({ remove: { people: ["a@acme.test", "z@acme.test"], domains: [] } }))).toMatchObject({
      policy: policy("admins"),
      absent: ["z@acme.test"],
    });
    expect(nextPolicy(policy("domain", [], ["acme.test"]), request({ onlyAdmins: true })).policy).toEqual(policy("admins", [], ["acme.test"]));
    const many = request({ people: Array.from({ length: 501 }, (_, i) => `p${i}@acme.test`) });
    expect(nextPolicy(policy("admins"), many).tooMany).toContain("500 at most");
  });

  test("what is shown: who gets in, what is kept, and the line to send only once sign-in is set up", () => {
    const state: SharingState = {
      slug: "kanban",
      host: HOST,
      url: `https://${HOST}/`,
      policy: policy("people", ["a@acme.test"], ["kept.test"]),
      updatedAt: null,
      sso: { configured: true, providerName: "Microsoft" },
      allowedDomains: [],
    };
    expect(describeSharing(state)).toEqual([
      "   who gets in: the people listed, and the admins",
      "   people: a@acme.test",
      "   kept for later, not in effect: kept.test",
      "   the admins: the owner's password, the admin emails, and guests with a password",
      `   send: Open https://${HOST}/ and sign in with your Microsoft work account.`,
    ]);
    expect(describeSharing({ ...state, sso: { configured: false, providerName: null } }).some((line) => line.includes("send:"))).toBe(false);
  });

  test("curl's answer, and a host that never reaches a shell", () => {
    expect(readCurlAnswer('{"ok":true}\n200\n')).toEqual({ status: 200, body: '{"ok":true}' });
    expect(readCurlAnswer("404: unknown route\n404\n")).toEqual({ status: 404, body: "404: unknown route" });
    expect(readCurlAnswer("")).toBeNull();
    expect(() => sharingWriteCommand("kanban.zone; rm -rf /")).toThrow();
    expect(sharingWriteCommand(HOST)).toEndWith(`--data-binary @- -w '\\n%{http_code}\\n' http://127.0.0.1:3026/admin/sharing/${HOST}`);
  });
});
