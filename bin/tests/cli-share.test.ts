import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accessMessage,
  accessWarnings,
  describeAccess,
  describePeople,
  entryText,
  OWNER_SOCKET,
  ownerReadCommand,
  ownerWriteCommand,
  people,
  personText,
  readCurlAnswer,
  readPeopleArguments,
  readShareArguments,
  roleName,
  readWho,
  share,
  leftText,
  sshAccess,
  sshPeople,
  type AccessState,
  type AccessTransport,
  type EntryAnswer,
  type EntryView,
  type Execution,
  type PeopleState,
  type PeopleTransport,
  type PersonView,
  type Reading,
  type Role,
  type RunOnMachine,
} from "../cli/access";
import type { Manifest } from "../cli/manifest";
import type { Failure, Output } from "../cli/remote";
import { FAKE_NOW, FAKE_PASSWORD } from "./e2e/fake-ssh";
import { createFakeVm, type FakeVm } from "./e2e/fake-vm";
import { CLI, TEST_EMAIL, TEST_ZONE } from "./e2e/run";

/**
 * `sitesolide share` and `sitesolide people`, every way they run: the real
 * bin/sitesolide.ts in a child process, through a local fake of the
 * dashboard's control API with a token, and over the owner's SSH in
 * front of the fake machine, whose ssh answers the steward's owner socket
 * from a registry the test lays and refuses every write the test does not
 * accept. Then the commands over fake transports, the SSH transports over a
 * fake machine, and the decisions, without running anything.
 */

const TOKEN = `sst_${"S".repeat(43)}`;
const HOST = `kanban.${TEST_ZONE}`;
const URL_ = `https://${HOST}/`;
const DASHBOARD = `https://dashboard.${TEST_ZONE}`;
const SEND = `Open ${URL_} and sign in with your Google account.`;
const ALSO = "   The owner also opens it.";
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

/** An entry as the steward shows it; password access when `expiresAt` is given. */
function entry(who: string, role: Role = "visitor", expiresAt?: number | null): EntryView {
  return {
    who,
    kind: expiresAt !== undefined ? "password" : who.startsWith("@") ? "domain" : "person",
    role,
    by: "owner",
    createdAt: FAKE_NOW,
    updatedAt: FAKE_NOW,
    password: expiresAt === undefined ? null : { expiresAt, expired: expiresAt !== null && expiresAt < FAKE_NOW },
  };
}

afterEach(() => {
  for (const path of toClean.splice(0)) rmSync(path, { recursive: true, force: true });
});

// --- the fake API ----------------------------------------------------------------------

const api = {
  entries: [] as EntryView[],
  general: "restricted" as "public" | "restricted" | "code",
  allowedDomains: ["acme.test"],
  configured: true,
  /** A refusal every request gets, as the dashboard words it. */
  refuse: null as { status: number; error: string; message: string; details?: string[] } | null,
  received: [] as { method: string; path: string; authorization: string | null; body: unknown }[],
};

let server: ReturnType<typeof Bun.serve>;
let base: string;
let vm: FakeVm;

/** The project's access as the control API hands it to a token: never the admin emails. */
function apiState(): AccessState {
  return {
    slug: "kanban",
    host: HOST,
    url: URL_,
    general: { access: api.general, modifiable: true, reason: null },
    entries: api.entries,
    signIn: { configured: api.configured, allowedDomains: api.allowedDomains, providerName: "Google" },
    portal: { reading: "steward", writtenAt: FAKE_NOW },
  };
}

beforeAll(() => {
  vm = createFakeVm();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "PUT" || req.method === "DELETE" ? ((await req.json()) as { who: string; role?: Role }) : null;
      api.received.push({ method: req.method, path: url.pathname, authorization: req.headers.get("authorization"), body });
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: "unauthenticated", message: "missing or unknown token" }, { status: 401 });
      if (api.refuse !== null) return Response.json(api.refuse, { status: api.refuse.status });
      if (url.pathname !== "/api/v1/projects/kanban/access") return Response.json({ error: "not-found", message: "no project for this token" }, { status: 404 });
      if (body === null) return Response.json({ access: apiState() });
      const existing = api.entries.find((one) => one.who === body.who) ?? null;
      if (req.method === "DELETE") {
        if (existing === null) return Response.json({ error: "not-found", message: `${body.who} has no access to kanban` }, { status: 404 });
        api.entries = api.entries.filter((one) => one.who !== body.who);
        return Response.json({ entry: existing, change: "remove", access: apiState() });
      }
      if (body.role !== "visitor") {
        return Response.json({ error: "out-of-scope", message: `a token gives people Can open alone: ${body.role} is given from the dashboard, or by the owner over SSH` }, { status: 403 });
      }
      if (existing !== null) return Response.json({ entry: existing, change: "none", access: apiState() });
      const given = { ...entry(body.who), by: "token:aaaaaaaaaaaa" };
      api.entries = [...api.entries, given];
      return Response.json({ entry: given, change: "add", access: apiState() }, { status: 201 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  vm.cleanup();
});

beforeEach(() => {
  api.entries = [];
  api.general = "restricted";
  api.allowedDomains = ["acme.test"];
  api.configured = true;
  api.refuse = null;
  api.received.length = 0;
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

const writes = () => api.received.filter((one) => one.method !== "GET").map((one) => `${one.method} ${JSON.stringify(one.body)}`);

describe("share with a token, through the API", () => {
  test("no argument: general access and people with access, nothing changed", async () => {
    const result = await remote(project(), ["share"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain(`-> access to kanban, ${URL_}, through ${base}`);
    expect(result.output).toContain("   general access: Restricted: visitors are asked to sign in.");
    expect(result.output).toContain("   people with access: nobody yet");
    // Nobody with an account yet: nothing to send.
    expect(result.output).not.toContain("send:");
    expect(api.received.map((one) => `${one.method} ${one.path}`)).toEqual(["GET /api/v1/projects/kanban/access"]);
    expect(api.received[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("a person and a domain given Can open, one request each, and --json ends with the result", async () => {
    const result = await remote(project(), ["share", "Alice@Acme.test", "@Acme.test", "--json"]);
    expect(result.code).toBe(0);
    expect(api.received.map((one) => one.method)).toEqual(["GET", "PUT", "PUT", "GET"]);
    expect(writes()).toEqual(['PUT {"who":"alice@acme.test","role":"visitor"}', 'PUT {"who":"@acme.test","role":"visitor"}']);
    const list = events(result.output);
    expect(list[0]).toEqual({ type: "step", message: `access to kanban, ${URL_}, through ${base}` });
    expect(list).toContainEqual({ type: "step", message: "alice@acme.test: Can open on kanban" });
    expect(list).toContainEqual({ type: "step", message: "@acme.test: Can open on kanban" });
    expect(list).toContainEqual({ type: "info", message: `send: ${SEND}` });
    expect(list.at(-1)).toMatchObject({
      type: "result",
      ok: true,
      command: "share",
      slug: "kanban",
      url: URL_,
      general: "restricted",
      changed: true,
      changes: [
        { who: "alice@acme.test", change: "add", role: "can-open" },
        { who: "@acme.test", change: "add", role: "can-open" },
      ],
      entries: [{ who: "alice@acme.test", kind: "person", role: "can-open" }, { who: "@acme.test", kind: "domain", role: "can-open" }],
      signIn: { configured: true, allowedDomains: ["acme.test"] },
      message: SEND,
    });
  });

  test("--remove: one or several, a DELETE each, from their next request", async () => {
    api.entries = [entry("alice@acme.test"), entry("@acme.test")];
    const result = await remote(project(), ["share", "--remove", "alice@acme.test", "@acme.test"]);
    expect(result.code).toBe(0);
    expect(writes()).toEqual(['DELETE {"who":"alice@acme.test"}', 'DELETE {"who":"@acme.test"}']);
    expect(result.output).toContain("-> alice@acme.test no longer has access to kanban: refused from their next request");
    expect(result.output).toContain("   people with access: nobody yet");
    expect(result.output).not.toContain("send:");
  });

  test("what changes nothing says so, and sends no line", async () => {
    api.entries = [entry("alice@acme.test")];
    const result = await remote(project(), ["share", "alice@acme.test", "--json"]);
    expect(result.code).toBe(0);
    const list = events(result.output);
    expect(list).toContainEqual({ type: "info", message: "nothing to change: alice@acme.test already has Can open" });
    expect(list.some((event) => String(event.message).startsWith("send:"))).toBe(false);
    expect(list.at(-1)).toMatchObject({ type: "result", command: "share", changed: false, changes: [{ who: "alice@acme.test", change: "none", role: "can-open" }] });
  });

  test("a role above Can open is the dashboard's refusal, carried with its hint", async () => {
    const result = await remote(project(), ["share", "bob@acme.test", "--role", "viewer", "--json"]);
    expect(result.code).toBe(1);
    expect(writes()).toEqual(['PUT {"who":"bob@acme.test","role":"viewer"}']);
    const error = events(result.output).at(-1)!;
    expect(error).toMatchObject({ type: "error", message: "a token gives people Can open alone: viewer is given from the dashboard, or by the owner over SSH" });
    expect(error.hint).toContain("never pick another slug, role or token");
  });

  test("the dashboard's refusals reach the agent with their code's hint", async () => {
    const cases = [
      { status: 403, error: "out-of-scope", message: "@gmail.test: only the owner gives a domain outside the company's (acme.test) access", hint: "never pick another slug, role or token" },
      { status: 404, error: "not-found", message: "no project kanban for this token", hint: "sitesolide status" },
      { status: 503, error: "not-available", message: "this machine does not carry the access registry yet: the owner must run sitesolide upgrade", hint: "the access registry" },
      { status: 500, error: "failure", message: "the steward did not answer", hint: "tell the owner of the machine" },
      { status: 429, error: "too-many-attempts", message: "too many requests", details: ["retry in 30 s"], hint: "never retry in a loop" },
    ];
    for (const refusal of cases) {
      api.refuse = { status: refusal.status, error: refusal.error, message: refusal.message, ...(refusal.details === undefined ? {} : { details: refusal.details }) };
      const result = await remote(project(), ["share", "@gmail.test", "--json"]);
      expect({ error: refusal.error, code: result.code }).toEqual({ error: refusal.error, code: 1 });
      const error = events(result.output).at(-1)!;
      expect(error).toMatchObject({ type: "error", message: refusal.message, details: refusal.details ?? [] });
      expect(error.hint).toContain(refusal.hint);
    }
  });

  test("a dashboard from before these routes: not-available, never a project the token cannot see", async () => {
    api.refuse = { status: 404, error: "not-found", message: "no such route: see docs/team.md for the control API's routes" };
    const error = events((await remote(project(), ["share", "--json"])).output).at(-1)!;
    expect(error).toMatchObject({ type: "error", message: `the dashboard at ${base} does not carry access yet: the owner of the machine runs sitesolide upgrade` });
    expect(error.hint).toContain("tell the owner of the machine");
  });

  test("bad arguments are refused before a request leaves, each with a hint", async () => {
    const root = project();
    for (const [arguments_, message] of [
      [["share", "acme.test"], "acme.test: write a whole domain with its @, like @acme.test; nothing was changed"],
      [["share", "not an address"], "not an address is neither an email address nor a domain like @acme.com: nothing was changed"],
      [["share", "a@acme.test", "--role", "owner"], "owner is not a role: can-open, viewer, developer or admin; nothing was changed"],
      [["share", "a@acme.test", "--expires", "1y"], "1y is not a duration: 24h, 7d, 30d or never; nothing was changed"],
      [["share", "--role", "viewer"], "--role: name who to give access to first"],
      [["share", "--remove", "a@acme.test", "--role", "viewer"], "--remove takes access away: it takes no --role nor --expires"],
      [["share", "--remove"], "--remove: an email address or a @domain must follow"],
      [["share", "--domain", "acme.test"], "--domain: not an option of sitesolide share with a token: nothing was sent"],
      [["share", "--only-admins"], "--only-admins: not an option of sitesolide share with a token: nothing was sent"],
      [["share", "--public"], "--public: not an option of sitesolide share with a token: nothing was sent"],
    ] as const) {
      const result = await remote(root, [...arguments_, "--json"]);
      const error = events(result.output).at(-1)!;
      expect({ arguments_, code: result.code, message: error.message }).toEqual({ arguments_, code: 1, message });
      expect(error.hint).toBeString();
    }
    expect(api.received).toEqual([]);
  });

  test("the usage with a token names share, and a folder without a manifest is refused", async () => {
    const empty = folder("share-empty-");
    const result = await remote(empty, ["share", "--json"]);
    expect(result.code).toBe(1);
    expect(events(result.output).at(-1)!.message).toContain("sitesolide.json not found");
    const usage = await remote(empty, []);
    expect(usage.error).toContain("sitesolide share");
    expect(usage.error).toContain("--remove <email|@domain>...");
  });

  test("people needs the owner's SSH access, and says so before anything is sent", async () => {
    const result = await remote(folder("people-"), ["people", "--json"]);
    expect(result.code).toBe(1);
    expect(events(result.output).at(-1)).toMatchObject({ type: "error", message: "sitesolide people needs the owner's SSH access to the machine" });
    expect(api.received).toEqual([]);
  });
});

// --- the owner, over SSH ----------------------------------------------------------------

describe("share and people as the owner, over SSH to the steward's owner socket", () => {
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

  const kanban = (entries: EntryView[], general: "public" | "restricted" | "code" | null = "restricted") => ({ projects: { kanban: { general, entries } } });

  test("share reads the steward's owner socket, and nothing else", async () => {
    machine.setAccess(kanban([entry("alice@acme.test", "developer"), entry("@acme.test")]));
    const read = await owner(project(), ["share"]);
    expect(read.code).toBe(0);
    expect(read.output.split("\n").filter((line) => line !== "")).toEqual([
      `-> access to kanban, ${URL_}, over SSH, as the owner`,
      "   general access: Restricted: visitors are asked to sign in.",
      "   people with access:",
      "     alice@acme.test  Developer",
      "     @acme.test       Can open",
      ALSO,
    ]);
    expect(machine.logs()).toEqual(["ACCESS GET kanban"]);
  });

  test("gives a role with the body on standard input, changes it, and says when nothing changes", async () => {
    machine.acceptWrites();
    const given = await owner(project(), ["share", "Bob@Acme.test", "--role", "developer", "--json"]);
    expect(given.code).toBe(0);
    expect(machine.logs()).toEqual(["ACCESS GET kanban", 'ACCESS PUT {"slug":"kanban","who":"bob@acme.test","role":"developer"}', "ACCESS GET kanban"]);
    expect(events(given.output).at(-1)).toMatchObject({
      type: "result",
      command: "share",
      changed: true,
      changes: [{ who: "bob@acme.test", change: "add", role: "developer" }],
      entries: [{ who: "bob@acme.test", kind: "person", role: "developer" }],
      message: expect.stringContaining("To deploy, create a token on the Tokens page, then run sitesolide login --url https://dashboard.test-zone.invalid."),
    });
    expect(machine.access().projects.kanban!.entries.map((one) => [one.who, one.role])).toEqual([["bob@acme.test", "developer"]]);

    const lowered = await owner(project(), ["share", "bob@acme.test", "--role", "viewer"]);
    expect(lowered.output).toContain("-> bob@acme.test: Viewer on kanban, from their next request");
    const again = await owner(project(), ["share", "bob@acme.test", "--role", "viewer"]);
    expect(again.output).toContain("   nothing to change: bob@acme.test already has Viewer");
    expect(again.output).not.toContain("send:");
  });

  test("someone outside the company's domains gets password access, the password shown once", async () => {
    machine.acceptWrites();
    const result = await owner(project(), ["share", "eve@elsewhere.test", "--expires", "24h"]);
    expect(result.code).toBe(0);
    expect(machine.logs()).toContain('ACCESS PUT {"slug":"kanban","who":"eve@elsewhere.test","role":"visitor","expiresInS":86400}');
    expect(result.output).toContain("-> eve@elsewhere.test: Can open, password access until 2026-10-04 04:00 UTC on kanban");
    expect(result.output).toContain(`   password for eve@elsewhere.test: ${FAKE_PASSWORD}`);
    expect(result.output).toContain("   shown once: send it to them yourself, with the address; the machine keeps only its hash");
    expect(result.output.split(FAKE_PASSWORD).length).toBe(2);
    // Password access is not sent the line to sign in with an account.
    expect(result.output).not.toContain("send:");

    const forever = await owner(project(), ["share", "zoe@elsewhere.test", "--expires", "never", "--json"]);
    expect(machine.logs()).toContain('ACCESS PUT {"slug":"kanban","who":"zoe@elsewhere.test","role":"visitor","expiresInS":null}');
    expect(events(forever.output).at(-1)).toMatchObject({ type: "result", changes: [{ who: "zoe@elsewhere.test", change: "add", role: "can-open", password: FAKE_PASSWORD }] });
    expect(events(forever.output)).toContainEqual({ type: "step", message: "zoe@elsewhere.test: Can open, password access with no expiry on kanban" });
  });

  test("--remove takes one or several off, from their next request", async () => {
    machine.acceptWrites();
    machine.setAccess(kanban([entry("alice@acme.test"), entry("@acme.test")]));
    const result = await owner(project(), ["share", "--remove", "alice@acme.test", "@acme.test"]);
    expect(result.code).toBe(0);
    expect(machine.logs().filter((line) => line.startsWith("ACCESS DELETE"))).toEqual([
      'ACCESS DELETE {"slug":"kanban","who":"alice@acme.test"}',
      'ACCESS DELETE {"slug":"kanban","who":"@acme.test"}',
    ]);
    expect(result.output).toContain("-> @acme.test no longer has access to kanban: refused from their next request");
    expect(result.output).toContain("   people with access: nobody yet");
    expect(machine.access().projects.kanban!.entries).toEqual([]);
  });

  test("the steward's refusals come back with their code, and a partial change says what was already done", async () => {
    machine.acceptWrites();
    const domain = await owner(project(), ["share", "@acme.test", "--role", "viewer", "--json"]);
    expect(domain.code).toBe(1);
    const refused = events(domain.output).at(-1)!;
    expect(refused).toMatchObject({ type: "error", message: "@acme.test: a domain can only open the site (Can open); give people roles one by one: nothing was changed" });
    expect(refused.hint).toContain("fix what the message names");

    const absent = await owner(project(), ["share", "--remove", "nobody@acme.test", "--json"]);
    expect(events(absent.output).at(-1)).toMatchObject({ type: "error", message: "nobody@acme.test has no access to kanban: nothing was changed" });

    const partial = await owner(project(), ["share", "carol@acme.test", "eve@elsewhere.test", "--role", "developer", "--json"]);
    expect(partial.code).toBe(1);
    const list = events(partial.output);
    expect(list).toContainEqual({ type: "step", message: "carol@acme.test: Developer on kanban" });
    expect(list).toContainEqual({ type: "info", message: "already done: carol@acme.test" });
    expect(list.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("eve@elsewhere.test can only be given Can open, with password access") });
    expect(machine.access().projects.kanban!.entries.map((one) => one.who)).toEqual(["carol@acme.test"]);
  });

  test("a change is a write: refused by a machine that accepts none, nothing changed", async () => {
    const result = await owner(project(), ["share", "alice@acme.test", "--json"]);
    expect(result.code).toBe(1);
    const error = events(result.output).at(-1)!;
    expect(error).toMatchObject({ type: "error", message: "cannot reach the server over SSH: nothing was changed" });
    expect(error.details[0]).toContain("fake ssh: command refused by the simulated server");
    expect(error.hint).toContain("ssh <server> true");
    expect(machine.access().projects.kanban!.entries).toEqual([]);
  });

  test("a steward from before the registry, and one with no owner's socket, point to the upgrade", async () => {
    for (const command of [["share"], ["people"]]) {
      machine.setAccess({ state: "old" });
      const old = events((await owner(project(), [...command, "--json"])).output).at(-1)!;
      expect(old).toMatchObject({ type: "error", message: "the steward on the server does not keep people with access yet: run sitesolide upgrade first" });
      expect(old.hint).toContain("sitesolide upgrade");
      machine.setAccess({ state: "down" });
      const down = events((await owner(project(), [...command, "--json"])).output).at(-1)!;
      expect(down).toMatchObject({ type: "error", message: "the steward on the server has no owner's socket: run sitesolide upgrade first, which brings the steward up to date" });
      expect(down.details[0]).toContain("curl: (7)");
      expect(down.details[1]).toBe(`the socket: ${OWNER_SOCKET}`);
    }
  });

  test("a portal that still reads its own tables, or cannot read the projection, is warned of", async () => {
    machine.setAccess({ portal: { reading: "portal", writtenAt: null } });
    let list = events((await owner(project(), ["share", "--json"])).output);
    expect(list).toContainEqual({ type: "warning", message: "the portal on this machine still decides from its own tables: run sitesolide upgrade, which deploys it", details: [] });
    machine.setAccess({ portal: { reading: "unreadable", writtenAt: null } });
    list = events((await owner(project(), ["share", "--json"])).output);
    expect(list.filter((event) => event.type === "warning").map((event) => event.message)).toEqual([
      "the portal cannot read who may open a site: only the owner's password and the admin emails open one; tell the owner of the machine (journalctl -u portal)",
    ]);
    expect(list.at(-1)).toMatchObject({ type: "result", command: "share" });
  });

  test("people lists everyone, their roles and who may create projects, reading nothing else", async () => {
    machine.setAccess({
      projects: {
        kanban: { general: "restricted", entries: [entry("alice@acme.test", "developer"), entry("eve@elsewhere.test", "visitor", FAKE_NOW + 86_400_000), entry("@acme.test")] },
        blog: { general: "public", entries: [entry("alice@acme.test", "viewer")] },
      },
      creators: ["carol@acme.test"],
    });
    const result = await owner(folder("people-"), ["people"]);
    expect(result.code).toBe(0);
    expect(result.output.split("\n").filter((line) => line !== "")).toEqual([
      `-> people of ${DASHBOARD}, over SSH, as the owner`,
      "   alice@acme.test     blog: Viewer, kanban: Developer",
      "   carol@acme.test     no project; may create projects",
      "   eve@elsewhere.test  kanban: Can open, password access until 2026-10-04 04:00 UTC",
      "   @acme.test          Can open: kanban",
      "   the company's domains: acme.test; anyone else gets password access",
    ]);
    expect(machine.logs()).toEqual(["PEOPLE GET"]);
  });

  test("people --may-create and --no-create, the body on standard input", async () => {
    machine.acceptWrites();
    const granted = await owner(folder("people-"), ["people", "Carol@Acme.test", "--may-create", "--json"]);
    expect(granted.code).toBe(0);
    expect(machine.logs()).toEqual(["PEOPLE GET", 'PEOPLE PUT {"email":"carol@acme.test","create":true}']);
    expect(events(granted.output)).toContainEqual({
      type: "step",
      message: `carol@acme.test may create projects, Admin of each one they create: open ${DASHBOARD} and sign in with their company account`,
    });
    expect(events(granted.output).at(-1)).toEqual({ type: "result", ok: true, command: "people", email: "carol@acme.test", create: true, roles: {}, change: "create", changed: true });
    expect(machine.access().creators).toEqual(["carol@acme.test"]);

    const again = await owner(folder("people-"), ["people", "carol@acme.test", "--may-create"]);
    expect(again.output).toContain("   nothing to change: carol@acme.test may already create projects");
    const taken = await owner(folder("people-"), ["people", "carol@acme.test", "--no-create"]);
    expect(taken.output).toContain("-> carol@acme.test may no longer create projects");
    expect(machine.access().creators).toEqual([]);
  });

  test("arguments that make no request are refused before anything is sent", async () => {
    const root = project();
    for (const [arguments_, message] of [
      [["share", "--domain", "acme.test"], "--domain is gone: write a domain as @acme.com, take people off with --remove, and choose who may open the site from the dashboard's General access"],
      [["share", "--only-admins"], "--only-admins is gone: write a domain as @acme.com, take people off with --remove, and choose who may open the site from the dashboard's General access"],
      [["share", "--public"], "--public: not an option of sitesolide share: nothing was changed"],
      [["share", "acme.test"], "acme.test: write a whole domain with its @, like @acme.test; nothing was changed"],
      [["share", "--remove", "a@acme.test", "--expires", "7d"], "--remove takes access away: it takes no --role nor --expires"],
      [["people", "alice@acme.test"], "sitesolide people alice@acme.test: --may-create or --no-create must follow; their roles are given per project, with sitesolide share"],
      [["people", "--may-create"], "sitesolide people: the email must come before --may-create or --no-create"],
      [["people", "a@acme.test", "b@acme.test", "--may-create"], "one email at a time"],
      [["people", "a@acme.test", "--may-create", "--no-create"], "--may-create or --no-create, once"],
      [["people", "@acme.test", "--may-create"], "@acme.test is not an email address: nothing was changed"],
      [["people", "a@acme.test", "--role", "admin"], "--role: not an option of sitesolide people: nothing was changed"],
    ] as const) {
      const result = await owner(root, [...arguments_, "--json"]);
      const error = events(result.output).at(-1)!;
      expect({ arguments_, code: result.code, message: error.message }).toEqual({ arguments_, code: 1, message });
      expect(error.hint).toBeString();
    }
    expect(machine.logs()).toEqual([]);
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

describe("the share and access tools, through the MCP server", () => {
  test("with a token: share gives Can open to those named, access reads them back, remove takes them off", async () => {
    const root = project();
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SITESOLIDE_")));
    const env = { ...inherited, PATH: vm.env.PATH!, FAKE_VM: vm.env.FAKE_VM!, HOME: folder("share-home-"), SITESOLIDE_API: base, SITESOLIDE_TOKEN: TOKEN };
    const shared = await callTool(root, env, "share", { folder: root, who: ["alice@acme.test", "@acme.test"] });
    expect(shared.result.isError).toBe(false);
    expect(shared.result.structuredContent.result).toMatchObject({
      command: "share",
      changed: true,
      changes: [
        { who: "alice@acme.test", change: "add", role: "can-open" },
        { who: "@acme.test", change: "add", role: "can-open" },
      ],
      message: SEND,
    });
    expect(writes()).toEqual(['PUT {"who":"alice@acme.test","role":"visitor"}', 'PUT {"who":"@acme.test","role":"visitor"}']);

    const read = await callTool(root, env, "access", { folder: root });
    expect(read.result.isError).toBe(false);
    expect(read.result.structuredContent.result).toMatchObject({ command: "share", changed: false, entries: [{ who: "alice@acme.test" }, { who: "@acme.test" }] });
    expect(writes()).toHaveLength(2);

    const removed = await callTool(root, env, "share", { folder: root, remove: ["@acme.test"] });
    expect(removed.result.isError).toBe(false);
    expect(writes().at(-1)).toBe('DELETE {"who":"@acme.test"}');

    // A refusal is a tool error carrying its hint, not a protocol error.
    const refused = await callTool(root, env, "share", { folder: root, who: ["bob@acme.test"], role: "admin" });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.structuredContent.error.hint).toContain("ask the owner of the machine");
  });

  test("as the owner: access reads the steward's owner socket, and writes nothing", async () => {
    const machine = createFakeVm();
    try {
      machine.setAccess({ projects: { kanban: { general: "restricted", entries: [entry("bob@acme.test", "viewer")] } } });
      const root = project();
      const read = await callTool(root, { ...process.env, SITESOLIDE_ZONE: TEST_ZONE, SITESOLIDE_EMAIL: TEST_EMAIL, ...machine.env } as Record<string, string>, "access", { folder: root });
      expect(read.result.isError).toBe(false);
      expect(read.result.structuredContent.result).toMatchObject({ command: "share", general: "restricted", entries: [{ who: "bob@acme.test", role: "viewer" }], changed: false });
      expect(machine.logs()).toEqual(["ACCESS GET kanban"]);
    } finally {
      machine.cleanup();
    }
  });
});

// --- the commands, over fake transports ---------------------------------------------------

/** What a command said, failed with and concluded. */
function recorder() {
  const said: string[] = [];
  const failures: Failure[] = [];
  const results: { command: string; fields: Record<string, any> }[] = [];
  const output: Output = {
    say: (line) => said.push(line),
    journal: (line) => said.push(line),
    failed: (failure) => failures.push(failure),
    succeeded: (command, fields) => results.push({ command, fields }),
  };
  return { said, failures, results, output };
}

function state(fields: Partial<AccessState> = {}): AccessState {
  return {
    slug: "kanban",
    host: HOST,
    url: URL_,
    general: { access: "restricted", modifiable: true, reason: null },
    entries: [],
    signIn: { configured: true, allowedDomains: ["acme.test"], admins: [], providerName: "Google" },
    portal: { reading: "steward", writtenAt: FAKE_NOW },
    ...fields,
  };
}

/** A transport that answers from `before`, then `after`, and gives what `answers` names, Can open by default. */
function fakeTransport(before: AccessState, answers: Record<string, Reading<EntryAnswer>> = {}, after: Reading<AccessState> = { ok: true, value: before }) {
  const calls: string[] = [];
  let reads = 0;
  const transport: AccessTransport = {
    via: "over a fake",
    owner: true,
    dashboard: "https://dashboard.test-zone.invalid",
    async list(slug) {
      calls.push(`list ${slug}`);
      return reads++ === 0 ? { ok: true, value: before } : after;
    },
    async give(slug, who, role, expiresInS) {
      calls.push(`give ${slug} ${who} ${role} ${expiresInS}`);
      return answers[who] ?? { ok: true, value: { entry: entry(who, role), change: "add" } };
    },
    async remove(slug, who) {
      calls.push(`remove ${slug} ${who}`);
      return answers[who] ?? { ok: true, value: { entry: entry(who), change: "remove" } };
    },
  };
  return { calls, transport };
}

describe("share, over a fake transport", () => {
  test("the arguments are judged before anything is read", async () => {
    const { calls, transport } = fakeTransport(state());
    const out = recorder();
    expect(await share(["share", "--only-admins"], "kanban", transport, out.output)).toBe(1);
    expect(out.failures).toMatchObject([{ error: "usage" }]);
    expect(calls).toEqual([]);
  });

  test("a read that fails is the command's failure, said as it came", async () => {
    const failure = { error: "steward-outdated", message: "the steward on the server does not keep people with access yet: run sitesolide upgrade first" };
    const transport: AccessTransport = { ...fakeTransport(state()).transport, list: async () => ({ ok: false, failure }) };
    const out = recorder();
    expect(await share(["share"], "kanban", transport, out.output)).toBe(1);
    expect(out.failures).toEqual([failure]);
    expect(out.said).toEqual([]);
  });

  test("the list: the first line names the way it went, then the access, and the result; nothing to send when nothing changed", async () => {
    const { calls, transport } = fakeTransport(state({ entries: [entry("alice@acme.test", "admin")] }));
    const out = recorder();
    expect(await share(["share", "--json"], "kanban", transport, out.output)).toBe(0);
    expect(calls).toEqual(["list kanban"]);
    expect(out.said).toEqual([
      `-> access to kanban, ${URL_}, over a fake`,
      "   general access: Restricted: visitors are asked to sign in.",
      "   people with access:",
      "     alice@acme.test  Admin",
      ALSO,
    ]);
    expect(out.results).toEqual([
      {
        command: "share",
        fields: {
          slug: "kanban",
          url: URL_,
          general: "restricted",
          entries: [entry("alice@acme.test", "admin")],
          signIn: { configured: true, allowedDomains: ["acme.test"] },
          message: SEND,
          changed: false,
        },
      },
    ]);
  });

  test("each one asked is given in turn with the role and the expiry, then the access is read again", async () => {
    const after = state({ entries: [entry("a@acme.test", "developer"), entry("b@acme.test", "developer")] });
    const { calls, transport } = fakeTransport(state(), {}, { ok: true, value: after });
    const out = recorder();
    expect(await share(["share", "a@acme.test", "b@acme.test", "--role", "developer", "--expires", "30d"], "kanban", transport, out.output)).toBe(0);
    expect(calls).toEqual(["list kanban", "give kanban a@acme.test developer 2592000", "give kanban b@acme.test developer 2592000", "list kanban"]);
    expect(out.said).toContain("     b@acme.test  Developer");
    expect(out.results[0]!.fields).toMatchObject({ entries: after.entries, changed: true });
  });

  test("a password drawn is shown once, carried in the result, and never sends the line to sign in", async () => {
    const answers = { "eve@elsewhere.test": { ok: true as const, value: { entry: entry("eve@elsewhere.test", "visitor", FAKE_NOW + 604_800_000), change: "add" as const, password: "drawn-once" } } };
    const { transport } = fakeTransport(state(), answers);
    const out = recorder();
    expect(await share(["share", "eve@elsewhere.test"], "kanban", transport, out.output)).toBe(0);
    expect(out.said).toContain("-> eve@elsewhere.test: Can open, password access until 2026-10-10 04:00 UTC on kanban");
    expect(out.said.filter((line) => line.includes("drawn-once"))).toEqual(["   password for eve@elsewhere.test: drawn-once"]);
    expect(out.said).toContain("   shown once: send it to them yourself, with the address; the machine keeps only its hash");
    expect(out.said.some((line) => line.includes("send:"))).toBe(false);
    expect(out.results[0]!.fields.changes).toEqual([{ who: "eve@elsewhere.test", change: "add", role: "can-open", password: "drawn-once" }]);
  });

  test("the line to send: for a person given access with an account, never for a domain, nor without sign-in set up", async () => {
    const domain = recorder();
    await share(["share", "@acme.test"], "kanban", fakeTransport(state()).transport, domain.output);
    expect(domain.said.some((line) => line.includes("send:"))).toBe(false);

    const person = recorder();
    await share(["share", "alice@acme.test"], "kanban", fakeTransport(state()).transport, person.output);
    expect(person.said).toContain(`   send: ${SEND}`);

    const unnamed = recorder();
    await share(["share", "alice@acme.test"], "kanban", fakeTransport(state({ signIn: { configured: true, allowedDomains: [], providerName: null } })).transport, unnamed.output);
    expect(unnamed.said).toContain(`   send: Open ${URL_} and sign in with your company account.`);

    const none = recorder();
    await share(["share", "alice@acme.test"], "kanban", fakeTransport(state({ signIn: { configured: false, allowedDomains: [] } })).transport, none.output);
    expect(none.said.some((line) => line.includes("send:"))).toBe(false);
    expect(none.results[0]!.fields.message).toBeNull();
  });

  test("given Viewer, the line to send names the dashboard too; given Developer or Admin, how to deploy as well", async () => {
    const viewer = recorder();
    await share(["share", "alice@acme.test", "--role", "viewer"], "kanban", fakeTransport(state()).transport, viewer.output);
    expect(viewer.said).toContain(`   send: kanban is at ${URL_}, and in the dashboard at https://dashboard.test-zone.invalid. Sign in with your Google account.`);
    const developer = recorder();
    await share(["share", "alice@acme.test", "--role", "developer"], "kanban", fakeTransport(state()).transport, developer.output);
    expect(developer.said).toContain(
      `   send: kanban is at ${URL_}, and in the dashboard at https://dashboard.test-zone.invalid. Sign in with your Google account. To deploy, create a token on the Tokens page, then run sitesolide login --url https://dashboard.test-zone.invalid.`,
    );
    expect(developer.results[0]!.fields.message).toContain("To deploy, create a token on the Tokens page");
  });

  test("a portal that does not read the registry is warned of right after the first line", async () => {
    for (const [reading, start] of [
      ["portal", "!! the portal on this machine still decides from its own tables"],
      ["unreadable", "!! the portal cannot read who may open a site"],
    ] as const) {
      const out = recorder();
      await share(["share"], "kanban", fakeTransport(state({ portal: { reading, writtenAt: null } })).transport, out.output);
      expect(out.said[1]).toStartWith(start);
    }
    const quiet = recorder();
    await share(["share"], "kanban", fakeTransport(state({ portal: { reading: "unknown", writtenAt: null } })).transport, quiet.output);
    expect(quiet.said.some((line) => line.startsWith("!!"))).toBe(false);
  });

  test("a refusal for one stops before the next, and says what was already done", async () => {
    const refusal = { error: "out-of-scope", message: "b@acme.test is Admin on kanban: only someone who may give that role changes it: nothing was changed" };
    const { calls, transport } = fakeTransport(state(), { "b@acme.test": { ok: false, failure: refusal } });
    const out = recorder();
    expect(await share(["share", "a@acme.test", "b@acme.test", "c@acme.test"], "kanban", transport, out.output)).toBe(1);
    expect(calls).toEqual(["list kanban", "give kanban a@acme.test visitor undefined", "give kanban b@acme.test visitor undefined"]);
    expect(out.said.slice(-1)).toEqual(["   already done: a@acme.test"]);
    expect(out.failures).toEqual([refusal]);
    expect(out.results).toEqual([]);

    // Refused at the first: nothing to say was done.
    const first = recorder();
    await share(["share", "b@acme.test"], "kanban", fakeTransport(state(), { "b@acme.test": { ok: false, failure: refusal } }).transport, first.output);
    expect(first.said.some((line) => line.includes("already done"))).toBe(false);
  });

  test("someone a removal or a lowering took out of the dashboard is said after it, with the tokens that went with them", async () => {
    const left = { who: "chloe@acme.test", tokens: [{ label: "alice-ci", madeBy: "them" as const }, { label: "Alice's laptop", madeBy: "owner" as const }] };
    const answers = { "chloe@acme.test": { ok: true as const, value: { entry: entry("chloe@acme.test"), change: "remove" as const, left } } };
    const owner = recorder();
    await share(["share", "--remove", "chloe@acme.test"], "kanban", fakeTransport(state(), answers).transport, owner.output);
    expect(owner.said).toContain("   chloe@acme.test no longer signs in to the dashboard. Also revoked 2 tokens: alice-ci (made by them), Alice's laptop (made by you).");
    expect(owner.results[0]!.fields.changes).toEqual([{ who: "chloe@acme.test", change: "remove", role: null, left }]);
    const token = recorder();
    await share(["share", "--remove", "chloe@acme.test"], "kanban", { ...fakeTransport(state(), answers).transport, owner: false }, token.output);
    expect(token.said).toContain("   chloe@acme.test no longer signs in to the dashboard. Also revoked 2 tokens: alice-ci (made by them), Alice's laptop (made by the owner).");
    expect(leftText({ who: "dan@acme.test", tokens: [] }, true)).toBe("dan@acme.test no longer signs in to the dashboard.");
  });

  test("a read that fails after the changes falls back to the access read before", async () => {
    const before = state({ entries: [entry("old@acme.test")] });
    const { transport } = fakeTransport(before, {}, { ok: false, failure: { error: "ssh-failed", message: "cannot reach the server over SSH: nothing was changed" } });
    const out = recorder();
    expect(await share(["share", "--remove", "old@acme.test"], "kanban", transport, out.output)).toBe(0);
    expect(out.said).toContain("-> old@acme.test no longer has access to kanban: refused from their next request");
    // The roles as the command prints them: can-open for the first rung.
    expect(out.results[0]!.fields).toMatchObject({ entries: before.entries.map((one) => ({ ...one, role: roleName(one.role) })), changed: true, changes: [{ who: "old@acme.test", change: "remove", role: null }] });
  });
});

function person(who: string, fields: Partial<PersonView> = {}): PersonView {
  return { who, roles: {}, create: false, passwords: [], admin: false, ...fields };
}

describe("people, over a fake transport", () => {
  const listed: PeopleState = {
    people: [person("alice@acme.test", { roles: { shop: "developer", blog: "admin" } }), person("root@acme.test", { admin: true })],
    domains: [],
    signIn: { configured: true, allowedDomains: [], admins: ["root@acme.test"] },
  };

  function peopleTransport(change = "create") {
    const calls: string[] = [];
    const transport: PeopleTransport = {
      async list() {
        calls.push("list");
        return { ok: true, value: listed };
      },
      async setCreate(email, create) {
        calls.push(`create ${email} ${create}`);
        return { ok: true, value: { person: person(email, { create, roles: { blog: "viewer" } }), change } };
      },
      async migrateWithoutPortal() {
        calls.push("migrate");
        return { ok: true, value: { people: 3, projects: 2 } };
      },
    };
    return { calls, transport };
  }

  test("carried over without the portal's database, at the owner's word: said, and nothing listed first", async () => {
    const { calls, transport } = peopleTransport();
    const out = recorder();
    expect(await people(["people", "--migrate-without-portal"], DASHBOARD, transport, out.output)).toBe(0);
    expect(calls).toEqual(["migrate"]);
    expect(out.said[0]).toContain("without the portal's database: 3 person(s)");
    expect(out.results).toEqual([{ command: "people", fields: { migrated: true, withoutPortal: true, people: 3, projects: 2, changed: true } }]);
  });

  test("the list, and its result", async () => {
    const { calls, transport } = peopleTransport();
    const out = recorder();
    expect(await people(["people"], DASHBOARD, transport, out.output)).toBe(0);
    expect(calls).toEqual(["list"]);
    expect(out.said).toEqual([
      `-> people of ${DASHBOARD}, over SSH, as the owner`,
      "   alice@acme.test  blog: Admin, shop: Developer",
      "   root@acme.test   no project; every site, as admin: set on the server in OIDC_ADMIN_EMAILS",
    ]);
    expect(out.results).toEqual([{ command: "people", fields: { people: listed.people, domains: [], signIn: listed.signIn, changed: false } }]);
  });

  test("the create right, read first then set, and nothing to change said so", async () => {
    const { calls, transport } = peopleTransport();
    const out = recorder();
    expect(await people(["people", "dan@acme.test", "--no-create"], DASHBOARD, transport, out.output)).toBe(0);
    expect(calls).toEqual(["list", "create dan@acme.test false"]);
    expect(out.said.slice(1)).toEqual(["-> dan@acme.test may no longer create projects", "   dan@acme.test  blog: Viewer"]);
    expect(out.results[0]).toEqual({ command: "people", fields: { email: "dan@acme.test", create: false, roles: { blog: "viewer" }, change: "create", changed: true } });

    const same = recorder();
    await people(["people", "dan@acme.test", "--no-create"], DASHBOARD, peopleTransport("none").transport, same.output);
    expect(same.said).toContain("   nothing to change: dan@acme.test may not create projects");
    expect(same.results[0]!.fields.changed).toBe(false);
  });

  test("a refusal of the arguments reads nothing; a failed change is the command's failure", async () => {
    const { calls, transport } = peopleTransport();
    const out = recorder();
    expect(await people(["people", "dan@acme.test"], DASHBOARD, transport, out.output)).toBe(1);
    expect(calls).toEqual([]);
    const failure = { error: "invalid", message: "dan@acme.test: refused: nothing was changed" };
    const failing = recorder();
    expect(await people(["people", "dan@acme.test", "--may-create"], DASHBOARD, { ...transport, setCreate: async () => ({ ok: false, failure }) }, failing.output)).toBe(1);
    expect(failing.failures).toEqual([failure]);
    expect(failing.results).toEqual([]);
  });
});

// --- the owner's transports, over a fake machine ------------------------------------------

/** A machine that answers each command from `answer`, and records what it was asked. */
function fakeMachine(answer: (command: string, input: string | undefined) => Execution) {
  const ran: { command: string; input: string | undefined }[] = [];
  const run: RunOnMachine = async (command, input) => {
    ran.push({ command, input });
    return answer(command, input);
  };
  return { ran, run };
}

/** curl's output: the body, then the status on a line of its own. */
const curl = (status: number, body: unknown): Execution => ({ code: 0, output: `${typeof body === "string" ? body : JSON.stringify(body)}\n${status}\n`, error: "" });

describe("sshAccess and sshPeople, over a fake machine", () => {
  test("share's reads and changes: root's curl on the owner socket, every body on standard input", async () => {
    const { ran, run } = fakeMachine((command) =>
      command.startsWith("sudo curl -sS --max-time 30 -w") ? curl(200, state()) : curl(200, { slug: "kanban", entry: entry("a@acme.test"), change: "add" }),
    );
    const transport = sshAccess(run);
    expect(transport.via).toBe("over SSH, as the owner");
    expect(await transport.list("kanban")).toEqual({ ok: true, value: state() });
    expect((await transport.give("kanban", "a@acme.test", "viewer", undefined)).ok).toBe(true);
    await transport.give("kanban", "e@elsewhere.test", "visitor", null);
    await transport.give("kanban", "f@elsewhere.test", "visitor", 86_400);
    await transport.remove("kanban", "a@acme.test");
    expect(ran).toEqual([
      { command: ownerReadCommand("/access?slug=kanban"), input: undefined },
      { command: ownerWriteCommand("PUT", "/access/entry"), input: '{"slug":"kanban","who":"a@acme.test","role":"viewer"}' },
      { command: ownerWriteCommand("PUT", "/access/entry"), input: '{"slug":"kanban","who":"e@elsewhere.test","role":"visitor","expiresInS":null}' },
      { command: ownerWriteCommand("PUT", "/access/entry"), input: '{"slug":"kanban","who":"f@elsewhere.test","role":"visitor","expiresInS":86400}' },
      { command: ownerWriteCommand("DELETE", "/access/entry"), input: '{"slug":"kanban","who":"a@acme.test"}' },
    ]);
    // No address ever reaches the command line.
    expect(ran.some((one) => one.command.includes("acme.test") || one.command.includes("elsewhere.test"))).toBe(false);
  });

  test("a slug that is not one never reaches the machine", async () => {
    const { ran, run } = fakeMachine(() => curl(200, state()));
    expect(await sshAccess(run).list("../etc; rm -rf /")).toEqual({ ok: false, failure: { error: "invalid", message: "../etc; rm -rf / is not a project's slug" } });
    expect(ran).toEqual([]);
  });

  test("ssh's 255 is ssh-failed, with ssh's own message, nothing changed", async () => {
    const { run } = fakeMachine(() => ({ code: 255, output: "", error: "ssh: connect to host vm port 22: Connection refused\n" }));
    expect(await sshAccess(run).give("kanban", "a@acme.test", "visitor", undefined)).toEqual({
      ok: false,
      failure: { error: "ssh-failed", message: "cannot reach the server over SSH: nothing was changed", details: ["ssh: connect to host vm port 22: Connection refused"] },
    });
    const silent = fakeMachine(() => ({ code: 255, output: "", error: "" }));
    expect(await sshPeople(silent.run).list()).toMatchObject({ ok: false, failure: { error: "ssh-failed", details: ["no message"] } });
  });

  test("curl's failure is a steward with no owner's socket: steward-outdated, the socket named", async () => {
    const { run } = fakeMachine(() => ({ code: 7, output: "", error: "curl: (7) Couldn't connect to server\n" }));
    expect(await sshAccess(run).list("kanban")).toEqual({
      ok: false,
      failure: {
        error: "steward-outdated",
        message: "the steward on the server has no owner's socket: run sitesolide upgrade first, which brings the steward up to date",
        details: ["curl: (7) Couldn't connect to server", `the socket: ${OWNER_SOCKET}`],
      },
    });
  });

  test("404 no such route is a steward from before the registry; any other 404 is a refusal", async () => {
    const old = fakeMachine(() => curl(404, { error: "not-found", message: "no such route" }));
    expect(await sshPeople(old.run).list()).toEqual({
      ok: false,
      failure: { error: "steward-outdated", message: "the steward on the server does not keep people with access yet: run sitesolide upgrade first" },
    });
    const absent = fakeMachine(() => curl(404, { error: "not-found", message: "a@acme.test has no access to kanban" }));
    expect(await sshAccess(absent.run).remove("kanban", "a@acme.test")).toEqual({
      ok: false,
      failure: { error: "not-found", message: "a@acme.test has no access to kanban: nothing was changed" },
    });
  });

  test("a refusal comes back with its code and the steward's words; one without either is a failure", async () => {
    for (const [status, code] of [
      [400, "invalid"],
      [403, "out-of-scope"],
      [423, "locked"],
    ] as const) {
      const { run } = fakeMachine(() => curl(status, { error: code, message: "the steward says no" }));
      expect(await sshAccess(run).give("kanban", "a@acme.test", "admin", undefined)).toEqual({ ok: false, failure: { error: code, message: "the steward says no: nothing was changed" } });
    }
    const bare = fakeMachine(() => curl(500, {}));
    expect(await sshAccess(bare.run).list("kanban")).toEqual({ ok: false, failure: { error: "failure", message: "refused (500): nothing was changed" } });
  });

  test("an answer that does not read is a failure, never guessed at", async () => {
    const notCurl = fakeMachine(() => ({ code: 0, output: "Welcome to the machine\n", error: "" }));
    expect(await sshAccess(notCurl.run).list("kanban")).toEqual({ ok: false, failure: { error: "failure", message: "the steward answered with something this CLI cannot read: nothing was changed" } });
    const notJson = fakeMachine(() => curl(200, "<html>"));
    expect(await sshAccess(notJson.run).list("kanban")).toEqual({ ok: false, failure: { error: "failure", message: "the steward answered 200 with something this CLI cannot read" } });
    const shapeless = fakeMachine(() => curl(200, { slug: "kanban" }));
    expect(await sshAccess(shapeless.run).list("kanban")).toEqual({ ok: false, failure: { error: "failure", message: "the steward's access list does not read: nothing was changed" } });
    expect(await sshAccess(shapeless.run).give("kanban", "a@acme.test", "visitor", undefined)).toEqual({ ok: false, failure: { error: "failure", message: "the steward's answer does not read: nothing was changed" } });
    expect(await sshPeople(shapeless.run).list()).toEqual({ ok: false, failure: { error: "failure", message: "the steward's list of people does not read: nothing was changed" } });
    expect(await sshPeople(shapeless.run).setCreate("a@acme.test", true)).toEqual({ ok: false, failure: { error: "failure", message: "the steward's answer does not read: nothing was changed" } });
  });

  test("people's read and change", async () => {
    const listed = { people: [person("a@acme.test")], domains: [], signIn: { configured: true, allowedDomains: [], admins: [] } };
    const { ran, run } = fakeMachine((command) => (command === ownerReadCommand("/people") ? curl(200, listed) : curl(200, { person: person("a@acme.test", { create: true }), change: "create" })));
    expect(await sshPeople(run).list()).toEqual({ ok: true, value: listed });
    expect(await sshPeople(run).setCreate("a@acme.test", true)).toEqual({ ok: true, value: { person: person("a@acme.test", { create: true }), change: "create" } });
    expect(ran).toEqual([
      { command: ownerReadCommand("/people"), input: undefined },
      { command: ownerWriteCommand("PUT", "/people/person"), input: '{"email":"a@acme.test","create":true}' },
    ]);
  });
});

// --- the decisions -------------------------------------------------------------------

describe("the pure parts", () => {
  test("share's arguments: the list, one or several to give, lowercased and once each", () => {
    expect(readShareArguments(["share"])).toEqual({ action: "list" });
    expect(readShareArguments(["share", "--json", "--api"])).toEqual({ action: "list" });
    expect(readShareArguments(["share", "B@Acme.test", "@Acme.test", "b@acme.test", "--json"])).toEqual({
      action: "give",
      who: ["b@acme.test", "@acme.test"],
      role: "visitor",
      expiresInS: undefined,
    });
    // Without the command's name too, as the API path hands them.
    expect(readShareArguments(["a@acme.test", "--role", "admin"])).toEqual({ action: "give", who: ["a@acme.test"], role: "admin", expiresInS: undefined });
  });

  test("share's --role and --expires", () => {
    for (const role of ["visitor", "viewer", "developer", "admin"] as const) {
      expect(readShareArguments(["share", "a@acme.test", "--role", role])).toMatchObject({ action: "give", role });
    }
    // The first rung as the command names it, the machine keeping it as visitor.
    expect(readShareArguments(["share", "a@acme.test", "--role", "can-open"])).toMatchObject({ action: "give", role: "visitor" });
    expect(roleName("visitor")).toBe("can-open");
    expect(roleName("developer")).toBe("developer");
    for (const [duration, seconds] of [
      ["24h", 86_400],
      ["7d", 604_800],
      ["30d", 2_592_000],
      ["never", null],
    ] as const) {
      expect(readShareArguments(["share", "--expires", duration, "e@elsewhere.test"])).toEqual({ action: "give", who: ["e@elsewhere.test"], role: "visitor", expiresInS: seconds });
    }
    expect(readShareArguments(["share", "a@acme.test", "--role"])).toMatchObject({ error: "usage", message: "--role: can-open, viewer, developer or admin must follow" });
    expect(readShareArguments(["share", "a@acme.test", "--expires", "--role", "viewer"])).toMatchObject({ error: "usage", message: "--expires: 24h, 7d, 30d or never must follow" });
    expect(readShareArguments(["share", "a@acme.test", "--role", "owner"])).toMatchObject({ error: "invalid" });
    expect(readShareArguments(["share", "a@acme.test", "--expires", "48h"])).toMatchObject({ error: "invalid" });
    expect(readShareArguments(["share", "--expires", "7d"])).toMatchObject({ error: "usage", message: "--expires: name who to give access to first" });
  });

  test("share's --remove: one or several, and nothing else beside it", () => {
    expect(readShareArguments(["share", "--remove", "A@acme.test", "@old.test"])).toEqual({ action: "remove", who: ["a@acme.test", "@old.test"] });
    // A name a password access was carried over under is taken away as it stands, never given.
    expect(readShareArguments(["share", "--remove", "Client Bob"])).toEqual({ action: "remove", who: ["Client Bob"] });
    expect(readShareArguments(["share", "Client Bob"])).toMatchObject({ error: "invalid" });
    expect(readShareArguments(["share", "--remove", "a@acme.test", "--remove", "b@acme.test"])).toEqual({ action: "remove", who: ["a@acme.test", "b@acme.test"] });
    expect(readShareArguments(["share", "--remove"])).toMatchObject({ error: "usage" });
    // Giving and taking away in one command is refused, never read as taking both away.
    expect(readShareArguments(["share", "alice@acme.test", "--remove", "bob@acme.test"])).toMatchObject({ error: "usage", message: expect.stringContaining("one command each") });
    expect(readShareArguments(["share", "--remove", "a@acme.test", "--role", "visitor"])).toMatchObject({ error: "usage" });
    // A name carried over from before the registry, an @ inside it or not, is taken away as it stands; given, never.
    expect(readShareArguments(["share", "--remove", "Bob @ the agency"])).toEqual({ action: "remove", who: ["Bob @ the agency"] });
    expect(readShareArguments(["share", "--remove", "Client Bob (2)"])).toEqual({ action: "remove", who: ["Client Bob (2)"] });
    expect(readShareArguments(["share", "Bob @ the agency"])).toHaveProperty("error");
    expect(readShareArguments(["share", "--remove", "@not a domain"])).toHaveProperty("error");
    expect(readShareArguments(["share", "--remove", "a@acme.test", "--expires", "never"])).toMatchObject({ error: "usage" });
  });

  test("share's refusals: a bare domain, the options that are gone, any other option", () => {
    expect(readShareArguments(["share", "acme.test"])).toEqual({ error: "invalid", message: "acme.test: write a whole domain with its @, like @acme.test; nothing was changed" });
    for (const gone of ["--domain", "--only-admins"]) {
      const refused = readShareArguments(["share", gone, "acme.test"]) as Failure;
      expect(refused.error).toBe("usage");
      expect(refused.message).toStartWith(`${gone} is gone: write a domain as @acme.com`);
    }
    expect(readShareArguments(["share", "--yes"])).toMatchObject({ error: "unknown-option", message: "--yes: not an option of sitesolide share: nothing was changed" });
    expect(readShareArguments(["share", "a@acme.test", "-r"])).toMatchObject({ error: "unknown-option" });
  });

  test("an email or a @domain, lowercased; anything else said what it lacks", () => {
    expect(readWho(" Alice@Acme.TEST ")).toBe("alice@acme.test");
    expect(readWho("@Sub.Acme.test")).toBe("@sub.acme.test");
    expect(readWho("acme.test")).toMatchObject({ error: "invalid", message: expect.stringContaining("like @acme.test") });
    for (const wrong of ["alice", "alice@", "@acme", "@-acme.test", "a b@acme.test", "@acme..test", ""]) {
      expect({ wrong, read: readWho(wrong) }).toMatchObject({ wrong, read: { error: "invalid" } });
    }
  });

  test("people's arguments: the list, or one email and the create right", () => {
    expect(readPeopleArguments(["people"])).toEqual({ action: "list" });
    expect(readPeopleArguments(["people", "--json"])).toEqual({ action: "list" });
    expect(readPeopleArguments(["people", "A@Acme.test", "--may-create"])).toEqual({ action: "create", email: "a@acme.test", create: true });
    expect(readPeopleArguments(["people", "a@acme.test", "--no-create", "--json"])).toEqual({ action: "create", email: "a@acme.test", create: false });
    expect(readPeopleArguments(["people", "a@acme.test"])).toMatchObject({ error: "usage" });
    expect(readPeopleArguments(["people", "--no-create"])).toMatchObject({ error: "usage" });
    expect(readPeopleArguments(["people", "a@acme.test", "--may-create", "--may-create"])).toMatchObject({ error: "usage" });
    expect(readPeopleArguments(["people", "a@acme.test", "b@acme.test", "--may-create"])).toMatchObject({ error: "usage" });
    expect(readPeopleArguments(["people", "@acme.test", "--may-create"])).toMatchObject({ error: "invalid" });
    expect(readPeopleArguments(["people", "a@acme.test", "--project", "blog"])).toMatchObject({ error: "unknown-option" });
    expect(readPeopleArguments(["people", "--migrate-without-portal"])).toEqual({ action: "migrate" });
    expect(readPeopleArguments(["people", "--migrate-without-portal", "--json"])).toEqual({ action: "migrate" });
    expect(readPeopleArguments(["people", "a@acme.test", "--migrate-without-portal"])).toMatchObject({ error: "usage" });
  });

  test("an entry in words: its role, and for password access until when", () => {
    expect(entryText(entry("a@acme.test"))).toBe("Can open");
    expect(entryText(entry("a@acme.test", "developer"))).toBe("Developer");
    expect(entryText(entry("e@elsewhere.test", "visitor", FAKE_NOW + 86_400_000))).toBe("Can open, password access until 2026-10-04 04:00 UTC");
    expect(entryText(entry("e@elsewhere.test", "visitor", FAKE_NOW - 86_400_000))).toBe("Can open, password access expired 2026-10-02 04:00 UTC");
    expect(entryText(entry("e@elsewhere.test", "visitor", null))).toBe("Can open, password access with no expiry");
  });

  test("the access in lines: each general access, a project not deployed, and Can open on a public site", () => {
    expect(describeAccess(state())).toEqual(["   general access: Restricted: visitors are asked to sign in.", "   people with access: nobody yet", ALSO]);
    expect(describeAccess(state({ general: { access: "code", modifiable: false, reason: null } }))[0]).toBe(
      "   general access: Anyone with the code: the preview code opens it.",
    );
    // The admin emails set on the server, named once under the list, as the dashboard says it.
    expect(describeAccess(state({ signIn: { configured: true, allowedDomains: ["acme.test"], admins: ["root@acme.test"] } })).at(-1)).toBe(
      "   Also open it without being listed: the owner, and root@acme.test, set on the server to open every site.",
    );
    expect(describeAccess(state({ general: null }))[0]).toBe("   general access: not deployed: its people with access are kept, its site serves nothing");
    const open = describeAccess(state({ general: { access: "public", modifiable: true, reason: null }, entries: [entry("@acme.test"), entry("a-very-long-address@acme.test", "admin")] }));
    expect(open).toEqual([
      "   general access: Public: anyone can open it.",
      "   people with access:",
      "     @acme.test                     Can open",
      "     a-very-long-address@acme.test  Admin",
      ALSO,
      "   kanban is public, so anyone can open it. Viewer, Developer and Admin still apply; Can open matters once you restrict it.",
    ]);
    // Public with only roles above Can open: nothing to point out.
    expect(describeAccess(state({ general: { access: "public", modifiable: true, reason: null }, entries: [entry("a@acme.test", "viewer")] }))).toHaveLength(4);
  });

  test("the line to send names the provider, or the company's account, and is none without sign-in", () => {
    expect(accessMessage(state())).toBe(SEND);
    expect(accessMessage(state({ signIn: { configured: true, allowedDomains: [], providerName: "your work account" } }))).toBe(`Open ${URL_} and sign in with your company account.`);
    expect(accessMessage(state({ signIn: { configured: true, allowedDomains: [] } }))).toBe(`Open ${URL_} and sign in with your company account.`);
    expect(accessMessage(state({ signIn: { configured: false, allowedDomains: [], providerName: "Google" } }))).toBeNull();
  });

  test("the warnings about the portal", () => {
    expect(accessWarnings(state())).toEqual([]);
    expect(accessWarnings(state({ portal: undefined }))).toEqual([]);
    expect(accessWarnings(state({ portal: { reading: "portal", writtenAt: null } }))[0]).toContain("run sitesolide upgrade");
    expect(accessWarnings(state({ portal: { reading: "unreadable", writtenAt: null } }))[0]).toContain("journalctl -u portal");
  });

  test("a person in words, and everyone in lines", () => {
    expect(personText(person("a@acme.test"))).toBe("no project");
    expect(
      personText(
        person("e@elsewhere.test", {
          roles: { shop: "visitor", blog: "visitor" },
          passwords: [{ slug: "shop", expiresAt: null, expired: false }],
          create: true,
        }),
      ),
    ).toBe("blog: Can open, shop: Can open, password access with no expiry; may create projects");
    expect(personText(person("root@acme.test", { admin: true, roles: { blog: "admin" } }))).toBe("blog: Admin; every site, as admin: set on the server in OIDC_ADMIN_EMAILS");

    const nobody: PeopleState = { people: [], domains: [], signIn: { configured: false, allowedDomains: [], admins: [] } };
    expect(describePeople(nobody)).toEqual([
      "   nobody yet: sitesolide share <email> --role <role>, from a project's folder",
      "!! signing in with a company account is not set up on this machine: only password access opens a site, and nobody signs in to the dashboard but the owner (portal/README.md)",
    ]);
    const some: PeopleState = { people: [person("a@acme.test", { roles: { blog: "viewer" } })], domains: [{ slug: "blog", domain: "@acme.test" }], signIn: { configured: true, allowedDomains: [], admins: [] } };
    expect(describePeople(some)).toEqual(["   a@acme.test  blog: Viewer", "   @acme.test   Can open: blog"]);
    const domains: PeopleState = { ...some, domains: [{ slug: "shop", domain: "@acme.test" }, { slug: "blog", domain: "@acme.test" }, { slug: "blog", domain: "@beta.test" }] };
    expect(describePeople(domains).slice(1)).toEqual(["   @acme.test   Can open: blog, shop", "   @beta.test   Can open: blog"]);
  });

  test("curl's answer: the body, then the status on its own line", () => {
    expect(readCurlAnswer('{"ok":true}\n200\n')).toEqual({ status: 200, body: '{"ok":true}' });
    expect(readCurlAnswer('{"a":1}\n{"b":2}\n404')).toEqual({ status: 404, body: '{"a":1}\n{"b":2}' });
    expect(readCurlAnswer("204\n")).toEqual({ status: 204, body: "" });
    expect(readCurlAnswer("")).toBeNull();
    expect(readCurlAnswer("body\nnot a status\n")).toBeNull();
  });

  /**
   * The arguments curl receives once the machine's shell has split the
   * command: what matters, rather than the text, since ssh hands the command
   * to a shell. `sudo` and `curl` are functions here that print them.
   */
  function curlArguments(command: string): string[] {
    const listed = Bun.spawnSync(["sh", "-c", `sudo() { "$@"; }; curl() { for a in "$@"; do printf '%s\\n' "$a"; done; }; ${command}`], { stdout: "pipe" });
    return listed.stdout.toString().split("\n").slice(0, -1);
  }

  test("the reads, split by a shell: root's curl on the owner socket, the address whole, the status last", () => {
    expect(OWNER_SOCKET).toBe("/run/sitesolide-steward-owner/owner.sock");
    for (const [path, address] of [
      ["/people", "http://steward/people"],
      ["/access?slug=kanban", "http://steward/access?slug=kanban"],
    ] as const) {
      const command = ownerReadCommand(path);
      expect(command).toStartWith("sudo curl -sS --max-time 30 ");
      const arguments_ = curlArguments(command);
      const socket = arguments_.indexOf("--unix-socket");
      expect({ path, socket: arguments_[socket + 1], address: arguments_.at(-1) }).toEqual({ path, socket: OWNER_SOCKET, address });
      expect(arguments_).toContain("\\n%{http_code}\\n");
    }
  });

  test("the changes, split by a shell: the method, the body on standard input, never on the command line", () => {
    for (const [method, path] of [
      ["PUT", "/access/entry"],
      ["DELETE", "/access/entry"],
      ["PUT", "/people/person"],
      ["DELETE", "/people/person"],
    ] as const) {
      const arguments_ = curlArguments(ownerWriteCommand(method, path));
      expect(arguments_.slice(0, 5)).toEqual(["-sS", "--max-time", "30", "-X", method]);
      expect(arguments_).toContain("--data-binary");
      expect(arguments_[arguments_.indexOf("--data-binary") + 1]).toBe("@-");
      expect(arguments_[arguments_.indexOf("--unix-socket") + 1]).toBe(OWNER_SOCKET);
      expect(arguments_.at(-1)).toBe(`http://steward${path}`);
    }
  });
});
