import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accessWarnings,
  describeAccess,
  entryText,
  OWNER_SOCKET,
  ownerReadCommand,
  ownerWriteCommand,
  readCurlAnswer,
  readShareArguments,
  readWho,
  share,
  sshAccess,
  type AccessState,
  type AccessTransport,
  type EntryAnswer,
  type EntryView,
  type Execution,
  type Reading,
  type RunOnMachine,
} from "../cli/access";
import type { Manifest } from "../cli/manifest";
import type { Failure, Output } from "../cli/remote";
import { FAKE_NOW, FAKE_PASSWORD } from "./e2e/fake-ssh";
import { createFakeVm, type FakeVm } from "./e2e/fake-vm";
import { CLI, TEST_EMAIL, TEST_ZONE } from "./e2e/run";

/**
 * `sitesolide share`, every way it runs: the real bin/sitesolide.ts in a
 * child process, over the owner's SSH in front of the fake machine, whose ssh
 * answers the steward's owner socket from a registry the test lays and
 * refuses every write the test does not accept; with a token, refused before
 * anything leaves. Then the command over a fake transport, the SSH transport
 * over a fake machine, and the decisions, without running anything.
 */

const TOKEN = `sst_${"S".repeat(43)}`;
const HOST = `kanban.${TEST_ZONE}`;
const URL_ = `https://${HOST}/`;
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

/** A guest as the steward shows them. */
function entry(who: string, expiresAt: number | null = FAKE_NOW + 7 * 24 * 3_600_000): EntryView {
  return { who, by: "owner", createdAt: FAKE_NOW, updatedAt: FAKE_NOW, expiresAt, expired: expiresAt !== null && expiresAt < FAKE_NOW };
}

afterEach(() => {
  for (const path of toClean.splice(0)) rmSync(path, { recursive: true, force: true });
});

// --- with a token ------------------------------------------------------------------------

describe("share with a token", () => {
  test("needs the owner's SSH access, and says so before anything is sent", async () => {
    const vm = createFakeVm();
    try {
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SITESOLIDE_")));
      const proc = Bun.spawn(["bun", CLI, "share", "alice@acme.test", "--json"], {
        cwd: project(),
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        env: { ...inherited, PATH: vm.env.PATH!, FAKE_VM: vm.env.FAKE_VM!, HOME: folder("share-home-"), SITESOLIDE_API: "http://127.0.0.1:9", SITESOLIDE_TOKEN: TOKEN },
      });
      const output = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(1);
      expect(events(output).at(-1)).toMatchObject({ type: "error", message: "sitesolide share needs the owner's SSH access to the machine" });
    } finally {
      vm.cleanup();
    }
  });
});

// --- the owner, over SSH ----------------------------------------------------------------

describe("share as the owner, over SSH to the steward's owner socket", () => {
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
    machine.setAccess(kanban([entry("alice@acme.test", null), entry("bob@elsewhere.test")]));
    const read = await owner(project(), ["share"]);
    expect(read.code).toBe(0);
    expect(read.output.split("\n").filter((line) => line !== "")).toEqual([
      `-> access to kanban, ${URL_}, over SSH, as the owner`,
      "   general access: Restricted: visitors are asked to sign in.",
      "   guests:",
      "     alice@acme.test     password access with no expiry",
      "     bob@elsewhere.test  password access until 2026-10-10 04:00 UTC",
      ALSO,
    ]);
    expect(machine.logs()).toEqual(["ACCESS GET kanban"]);
  });

  test("password access, the body on standard input, the password shown once; asked again, nothing drawn", async () => {
    machine.acceptWrites();
    const result = await owner(project(), ["share", "Eve@Elsewhere.test", "--expires", "24h"]);
    expect(result.code).toBe(0);
    expect(machine.logs()).toEqual(["ACCESS GET kanban", 'ACCESS PUT {"slug":"kanban","who":"eve@elsewhere.test","expiresInS":86400}', "ACCESS GET kanban"]);
    expect(result.output).toContain("-> eve@elsewhere.test: password access until 2026-10-04 04:00 UTC on kanban");
    expect(result.output).toContain(`   password for eve@elsewhere.test: ${FAKE_PASSWORD}`);
    expect(result.output).toContain(`   shown once: send it to them yourself, with ${URL_}; the machine keeps only its hash`);
    expect(result.output.split(FAKE_PASSWORD).length).toBe(2);

    const forever = await owner(project(), ["share", "zoe@elsewhere.test", "--expires", "never", "--json"]);
    expect(machine.logs()).toContain('ACCESS PUT {"slug":"kanban","who":"zoe@elsewhere.test","expiresInS":null}');
    expect(events(forever.output).at(-1)).toMatchObject({ type: "result", command: "share", changed: true, changes: [{ who: "zoe@elsewhere.test", change: "add", password: FAKE_PASSWORD }] });
    expect(events(forever.output)).toContainEqual({ type: "step", message: "zoe@elsewhere.test: password access with no expiry on kanban" });

    const again = await owner(project(), ["share", "zoe@elsewhere.test"]);
    expect(again.output).toContain("   nothing to change: zoe@elsewhere.test already has password access with no expiry; remove them first to draw a new password");
    expect(again.output).not.toContain(FAKE_PASSWORD);
  });

  test("--remove takes one or several off, from their next request", async () => {
    machine.acceptWrites();
    machine.setAccess(kanban([entry("alice@acme.test"), entry("bob@acme.test")]));
    const result = await owner(project(), ["share", "--remove", "alice@acme.test", "bob@acme.test"]);
    expect(result.code).toBe(0);
    expect(machine.logs().filter((line) => line.startsWith("ACCESS DELETE"))).toEqual([
      'ACCESS DELETE {"slug":"kanban","who":"alice@acme.test"}',
      'ACCESS DELETE {"slug":"kanban","who":"bob@acme.test"}',
    ]);
    expect(result.output).toContain("-> bob@acme.test no longer has access to kanban: refused from their next request");
    expect(result.output).toContain("   guests: nobody yet");
    expect(machine.access().projects.kanban!.entries).toEqual([]);
  });

  test("the steward's refusals come back with their code, and a partial change says what was already done", async () => {
    machine.acceptWrites();
    const absent = await owner(project(), ["share", "--remove", "nobody@acme.test", "--json"]);
    expect(absent.code).toBe(1);
    const refused = events(absent.output).at(-1)!;
    expect(refused).toMatchObject({ type: "error", message: "nobody@acme.test has no access to kanban: nothing was changed" });
    expect(refused.hint).toBeString();

    machine.setAccess(kanban([entry("carol@acme.test")]));
    const partial = await owner(project(), ["share", "--remove", "carol@acme.test", "dan@acme.test", "--json"]);
    expect(partial.code).toBe(1);
    const list = events(partial.output);
    expect(list).toContainEqual({ type: "step", message: "carol@acme.test no longer has access to kanban: refused from their next request" });
    expect(list).toContainEqual({ type: "info", message: "already done: carol@acme.test" });
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
    machine.setAccess({ state: "old" });
    const old = events((await owner(project(), ["share", "--json"])).output).at(-1)!;
    expect(old).toMatchObject({ type: "error", message: "the steward on the server does not keep guests yet: run sitesolide upgrade first" });
    expect(old.hint).toContain("sitesolide upgrade");
    machine.setAccess({ state: "down" });
    const down = events((await owner(project(), ["share", "--json"])).output).at(-1)!;
    expect(down).toMatchObject({ type: "error", message: "the steward on the server has no owner's socket: run sitesolide upgrade first, which brings the steward up to date" });
    expect(down.details[0]).toContain("curl: (7)");
    expect(down.details[1]).toBe(`the socket: ${OWNER_SOCKET}`);
  });

  test("a portal that cannot read the projection is warned of", async () => {
    machine.setAccess({ portal: { reading: "unreadable", writtenAt: null } });
    const list = events((await owner(project(), ["share", "--json"])).output);
    expect(list.filter((event) => event.type === "warning").map((event) => event.message)).toEqual([
      "the portal cannot read who may open a site: only the owner opens one; tell the owner of the machine (journalctl -u portal)",
    ]);
    expect(list.at(-1)).toMatchObject({ type: "result", command: "share" });
  });

  test("arguments that make no request are refused before anything is sent, people among them", async () => {
    const root = project();
    for (const [arguments_, message] of [
      [["share", "--role", "developer", "a@acme.test"], "--role is gone: a guest opens the site with a password and nothing more, and general access is chosen in the dashboard's Access section"],
      [["share", "--domain", "acme.test"], "--domain is gone: a guest opens the site with a password and nothing more, and general access is chosen in the dashboard's Access section"],
      [["share", "--public"], "--public: not an option of sitesolide share: nothing was changed"],
      [["share", "@acme.test"], "@acme.test: a whole domain is given access no more, name its people one by one; nothing was changed"],
      [["share", "acme.test"], "acme.test is not an email address: nothing was changed"],
      [["share", "--remove", "a@acme.test", "--expires", "7d"], "--remove takes access away: it takes no --expires"],
    ] as const) {
      const result = await owner(root, [...arguments_, "--json"]);
      const error = events(result.output).at(-1)!;
      expect({ arguments_, code: result.code, message: error.message }).toEqual({ arguments_, code: 1, message });
      expect(error.hint).toBeString();
    }
    expect(machine.logs()).toEqual([]);
    const people = await owner(root, ["people", "--json"]);
    expect(people.code).toBe(1);
    expect(machine.logs()).toEqual([]);
  });
});

// --- the command, over a fake transport ---------------------------------------------------

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
    portal: { reading: "steward", writtenAt: FAKE_NOW },
    ...fields,
  };
}

/** A transport that answers from `before`, then `after`, and gives what `answers` names, a new guest by default. */
function fakeTransport(before: AccessState, answers: Record<string, Reading<EntryAnswer>> = {}, after: Reading<AccessState> = { ok: true, value: before }) {
  const calls: string[] = [];
  let reads = 0;
  const transport: AccessTransport = {
    via: "over a fake",
    async list(slug) {
      calls.push(`list ${slug}`);
      return reads++ === 0 ? { ok: true, value: before } : after;
    },
    async give(slug, who, expiresInS) {
      calls.push(`give ${slug} ${who} ${expiresInS}`);
      return answers[who] ?? { ok: true, value: { entry: entry(who), change: "add", password: "drawn-once" } };
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
    const failure = { error: "steward-outdated", message: "the steward on the server does not keep guests yet: run sitesolide upgrade first" };
    const transport: AccessTransport = { ...fakeTransport(state()).transport, list: async () => ({ ok: false, failure }) };
    const out = recorder();
    expect(await share(["share"], "kanban", transport, out.output)).toBe(1);
    expect(out.failures).toEqual([failure]);
    expect(out.said).toEqual([]);
  });

  test("the list: the first line names the way it went, then the access, and the result", async () => {
    const { calls, transport } = fakeTransport(state({ entries: [entry("alice@acme.test", null)] }));
    const out = recorder();
    expect(await share(["share", "--json"], "kanban", transport, out.output)).toBe(0);
    expect(calls).toEqual(["list kanban"]);
    expect(out.said).toEqual([`-> access to kanban, ${URL_}, over a fake`, "   general access: Restricted: visitors are asked to sign in.", "   guests:", "     alice@acme.test  password access with no expiry", ALSO]);
    expect(out.results).toEqual([{ command: "share", fields: { slug: "kanban", url: URL_, general: "restricted", entries: [entry("alice@acme.test", null)], changed: false } }]);
  });

  test("each one asked is given in turn with the expiry, then the access is read again", async () => {
    const after = state({ entries: [entry("a@acme.test"), entry("b@acme.test")] });
    const { calls, transport } = fakeTransport(state(), {}, { ok: true, value: after });
    const out = recorder();
    expect(await share(["share", "a@acme.test", "b@acme.test", "--expires", "30d"], "kanban", transport, out.output)).toBe(0);
    expect(calls).toEqual(["list kanban", "give kanban a@acme.test 2592000", "give kanban b@acme.test 2592000", "list kanban"]);
    expect(out.results[0]!.fields).toMatchObject({ entries: after.entries, changed: true });
    expect(out.results[0]!.fields.changes).toEqual([
      { who: "a@acme.test", change: "add", password: "drawn-once" },
      { who: "b@acme.test", change: "add", password: "drawn-once" },
    ]);
  });

  test("a portal that cannot read the registry's projection is warned of right after the first line", async () => {
    const out = recorder();
    await share(["share"], "kanban", fakeTransport(state({ portal: { reading: "unreadable", writtenAt: null } })).transport, out.output);
    expect(out.said[1]).toStartWith("!! the portal cannot read who may open a site");
    const quiet = recorder();
    await share(["share"], "kanban", fakeTransport(state({ portal: { reading: "unknown", writtenAt: null } })).transport, quiet.output);
    expect(quiet.said.some((line) => line.startsWith("!!"))).toBe(false);
  });

  test("a refusal for one stops before the next, and says what was already done", async () => {
    const refusal = { error: "log-full", message: "the access log is full: nothing was changed" };
    const { calls, transport } = fakeTransport(state(), { "b@acme.test": { ok: false, failure: refusal } });
    const out = recorder();
    expect(await share(["share", "a@acme.test", "b@acme.test", "c@acme.test"], "kanban", transport, out.output)).toBe(1);
    expect(calls).toEqual(["list kanban", "give kanban a@acme.test undefined", "give kanban b@acme.test undefined"]);
    expect(out.said.slice(-1)).toEqual(["   already done: a@acme.test"]);
    expect(out.failures).toEqual([refusal]);
    expect(out.results).toEqual([]);
  });

  test("a read that fails after the changes falls back to the access read before", async () => {
    const before = state({ entries: [entry("a@acme.test")] });
    const { transport } = fakeTransport(before, {}, { ok: false, failure: { error: "failure", message: "gone" } });
    const out = recorder();
    expect(await share(["share", "--remove", "a@acme.test"], "kanban", transport, out.output)).toBe(0);
    expect(out.results[0]!.fields.entries).toEqual(before.entries);
  });
});

// --- the owner's transport, over a fake machine ------------------------------------------

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

describe("sshAccess, over a fake machine", () => {
  test("reads and changes: root's curl on the owner socket, every body on standard input", async () => {
    const { ran, run } = fakeMachine((command) =>
      command.startsWith("sudo curl -sS --max-time 30 -w") ? curl(200, state()) : curl(200, { slug: "kanban", entry: entry("a@acme.test"), change: "add" }),
    );
    const transport = sshAccess(run);
    expect(transport.via).toBe("over SSH, as the owner");
    expect(await transport.list("kanban")).toEqual({ ok: true, value: state() });
    expect((await transport.give("kanban", "a@acme.test", undefined)).ok).toBe(true);
    await transport.give("kanban", "e@elsewhere.test", null);
    await transport.give("kanban", "f@elsewhere.test", 86_400);
    await transport.remove("kanban", "a@acme.test");
    expect(ran).toEqual([
      { command: ownerReadCommand("/access?slug=kanban"), input: undefined },
      { command: ownerWriteCommand("PUT", "/access/entry"), input: '{"slug":"kanban","who":"a@acme.test"}' },
      { command: ownerWriteCommand("PUT", "/access/entry"), input: '{"slug":"kanban","who":"e@elsewhere.test","expiresInS":null}' },
      { command: ownerWriteCommand("PUT", "/access/entry"), input: '{"slug":"kanban","who":"f@elsewhere.test","expiresInS":86400}' },
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
    expect(await sshAccess(run).give("kanban", "a@acme.test", undefined)).toEqual({
      ok: false,
      failure: { error: "ssh-failed", message: "cannot reach the server over SSH: nothing was changed", details: ["ssh: connect to host vm port 22: Connection refused"] },
    });
    const silent = fakeMachine(() => ({ code: 255, output: "", error: "" }));
    expect(await sshAccess(silent.run).list("kanban")).toMatchObject({ ok: false, failure: { error: "ssh-failed", details: ["no message"] } });
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
    expect(await sshAccess(old.run).list("kanban")).toEqual({
      ok: false,
      failure: { error: "steward-outdated", message: "the steward on the server does not keep guests yet: run sitesolide upgrade first" },
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
      [507, "log-full"],
    ] as const) {
      const { run } = fakeMachine(() => curl(status, { error: code, message: "the steward says no" }));
      expect(await sshAccess(run).give("kanban", "a@acme.test", undefined)).toEqual({ ok: false, failure: { error: code, message: "the steward says no: nothing was changed" } });
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
    expect(await sshAccess(shapeless.run).give("kanban", "a@acme.test", undefined)).toEqual({ ok: false, failure: { error: "failure", message: "the steward's answer does not read: nothing was changed" } });
  });
});

describe("the pure parts", () => {
  test("share's arguments: the list, one or several to give, lowercased and once each", () => {
    expect(readShareArguments(["share"])).toEqual({ action: "list" });
    expect(readShareArguments(["share", "--json"])).toEqual({ action: "list" });
    expect(readShareArguments(["share", "A@Acme.test", "b@acme.test", "a@acme.test"])).toEqual({ action: "give", who: ["a@acme.test", "b@acme.test"], expiresInS: undefined });
  });

  test("share's --expires", () => {
    expect(readShareArguments(["share", "a@acme.test", "--expires", "24h"])).toMatchObject({ expiresInS: 86400 });
    expect(readShareArguments(["share", "a@acme.test", "--expires", "never"])).toMatchObject({ expiresInS: null });
    expect(readShareArguments(["share", "a@acme.test", "--expires", "1y"])).toMatchObject({ error: "invalid" });
    expect(readShareArguments(["share", "a@acme.test", "--expires"])).toMatchObject({ error: "usage" });
    expect(readShareArguments(["share", "--expires", "7d"])).toMatchObject({ error: "usage", message: "--expires: name who to give access to first" });
  });

  test("share's --remove: one or several, a name of before as it stands, and nothing else beside it", () => {
    expect(readShareArguments(["share", "--remove", "a@acme.test", "Client Bob"])).toEqual({ action: "remove", who: ["a@acme.test", "Client Bob"] });
    expect(readShareArguments(["share", "--remove"])).toMatchObject({ error: "usage" });
    expect(readShareArguments(["share", "a@acme.test", "--remove", "b@acme.test"])).toMatchObject({ error: "usage" });
    expect(readShareArguments(["share", "Client Bob"])).toMatchObject({ error: "invalid" });
    expect(readShareArguments(["share", "--remove", "@acme.test"])).toMatchObject({ error: "invalid" });
  });

  test("share's refusals: the options that are gone, any other option", () => {
    for (const option of ["--role", "--domain", "--only-admins", "--api"]) expect(readShareArguments(["share", option, "x"])).toMatchObject({ error: "usage", message: expect.stringContaining(`${option} is gone`) });
    expect(readShareArguments(["share", "--public"])).toMatchObject({ error: "unknown-option" });
  });

  test("an email, lowercased; a domain or anything else said what it lacks", () => {
    expect(readWho(" A@Acme.Test ")).toBe("a@acme.test");
    expect(readWho("@acme.test")).toMatchObject({ error: "invalid", message: expect.stringContaining("a whole domain is given access no more") });
    expect(readWho("acme.test")).toMatchObject({ error: "invalid", message: "acme.test is not an email address: nothing was changed" });
  });

  test("a guest in words: until when, expired, or no expiry", () => {
    expect(entryText(entry("a@acme.test", null))).toBe("password access with no expiry");
    expect(entryText(entry("a@acme.test", FAKE_NOW + 604_800_000))).toBe("password access until 2026-10-10 04:00 UTC");
    expect(entryText(entry("a@acme.test", FAKE_NOW - 1))).toBe("password access expired 2026-10-03 03:59 UTC");
  });

  test("the access in lines: each general access, a project not deployed, and guests on a public site", () => {
    expect(describeAccess(state({ general: { access: "code", modifiable: true, reason: null } }))[0]).toBe("   general access: Anyone with the code: the preview code opens it.");
    expect(describeAccess(state({ general: null }))[0]).toBe("   general access: not deployed: its guests are kept, its site serves nothing");
    const open = describeAccess(state({ general: { access: "public", modifiable: true, reason: null }, entries: [entry("a@acme.test")] }));
    expect(open.at(-1)).toBe("   kanban is public, so anyone can open it: its guests matter once you restrict it.");
    expect(describeAccess(state({ general: { access: "public", modifiable: true, reason: null } })).at(-1)).toBe(ALSO);
  });

  test("the warnings about the portal", () => {
    expect(accessWarnings(state({ portal: { reading: "unreadable", writtenAt: null } }))).toHaveLength(1);
    expect(accessWarnings(state())).toEqual([]);
    expect(accessWarnings(state({ portal: undefined }))).toEqual([]);
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
      ["/passkeys", "http://steward/passkeys"],
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
