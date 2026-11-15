import { describe, expect, test } from "bun:test";
import { ownerReadCommand, ownerWriteCommand, type Execution, type RunOnMachine } from "../cli/access";
import { passkeys, readPasskeyArguments, sshPasskeys, type PasskeyTransport } from "../cli/passkeys";
import type { Failure, Output } from "../cli/remote";

/**
 * `sitesolide passkey`: the arguments, what is said, and root's curl on the
 * owner socket, over a fake machine. Nothing runs.
 */
const DASHBOARD = "https://dashboard.test-zone.invalid";
const ID = "A".repeat(43);
const SECRET = "s".repeat(43);
const ADDED = Date.UTC(2026, 9, 1, 8, 0);

function recorder() {
  const said: string[] = [];
  const failures: Failure[] = [];
  const results: { command: string; fields: Record<string, unknown> }[] = [];
  const output: Output = {
    say: (line) => said.push(line),
    journal: (line) => said.push(line),
    failed: (failure) => failures.push(failure),
    succeeded: (command, fields) => results.push({ command, fields }),
  };
  return { said, failures, results, output };
}

function fakeMachine(answer: (command: string, input: string | undefined) => Execution) {
  const ran: { command: string; input: string | undefined }[] = [];
  const run: RunOnMachine = async (command, input) => {
    ran.push({ command, input });
    return answer(command, input);
  };
  return { ran, run };
}

const curl = (status: number, body: unknown): Execution => ({ code: 0, output: `${JSON.stringify(body)}\n${status}\n`, error: "" });

const one = (name: string, lastUsedAt: number | null = null) => ({ id: ID, name, createdAt: ADDED, lastUsedAt, signCount: 0, transports: [] });

describe("sitesolide passkey's arguments", () => {
  test("list, link and remove, and nothing else", () => {
    expect(readPasskeyArguments(["passkey"])).toEqual({ action: "list" });
    expect(readPasskeyArguments(["passkey", "list", "--json"])).toEqual({ action: "list" });
    expect(readPasskeyArguments(["passkey", "link"])).toEqual({ action: "link" });
    expect(readPasskeyArguments(["passkey", "remove", ID])).toEqual({ action: "remove", id: ID });
    expect(readPasskeyArguments(["passkey", "link", "again"])).toMatchObject({ error: "usage" });
    expect(readPasskeyArguments(["passkey", "remove"])).toMatchObject({ error: "usage" });
    expect(readPasskeyArguments(["passkey", "add"])).toMatchObject({ error: "usage" });
    expect(readPasskeyArguments(["passkey", "--force"])).toMatchObject({ error: "usage" });
    expect(readPasskeyArguments(["passkey", "remove", "not an id"])).toMatchObject({ error: "invalid" });
  });
});

describe("sitesolide passkey, over a fake transport", () => {
  const transport = (fields: Partial<PasskeyTransport> = {}): PasskeyTransport => ({
    list: async () => ({ ok: true, value: { passkeys: [one("Phone")], readable: true } }),
    link: async () => ({ ok: true, value: { link: SECRET, expiresAt: ADDED + 15 * 60_000 } }),
    remove: async () => ({ ok: true, value: { passkeys: [], readable: true } }),
    ...fields,
  });

  test("the link is the dashboard's address with the secret in its fragment, its expiry said", async () => {
    const out = recorder();
    expect(await passkeys(["passkey", "link"], DASHBOARD, transport(), out.output)).toBe(0);
    expect(out.said).toContain(`   ${DASHBOARD}/#passkey=${SECRET}`);
    expect(out.said).toContain("   valid until 2026-10-01 08:15 UTC, once; a new link replaces this one");
    expect(out.results).toEqual([{ command: "passkey", fields: { action: "link", url: `${DASHBOARD}/#passkey=${SECRET}`, expiresAt: ADDED + 15 * 60_000 } }]);
  });

  test("the list names each passkey and asks for a second when there is one", async () => {
    const out = recorder();
    expect(await passkeys(["passkey"], DASHBOARD, transport(), out.output)).toBe(0);
    expect(out.said[1]).toBe(`   Phone  added 2026-10-01 08:00 UTC, never used  id ${ID}`);
    expect(out.said.some((line) => line.includes("register a second"))).toBe(true);
  });

  test("removing the last one says the password signs in again", async () => {
    const out = recorder();
    expect(await passkeys(["passkey", "remove", ID], DASHBOARD, transport(), out.output)).toBe(0);
    expect(out.said).toContain("   no passkey: the dashboard's password signs in");
    expect(out.results[0]!.fields).toMatchObject({ action: "remove", changed: true });
  });

  test("a refusal is the command's failure, and bad arguments send nothing", async () => {
    let called = false;
    const failure = { error: "steward-outdated", message: "old" };
    const out = recorder();
    expect(await passkeys(["passkey"], DASHBOARD, transport({ list: async () => ((called = true), { ok: false, failure }) }), out.output)).toBe(1);
    expect(called).toBe(true);
    expect(out.failures).toEqual([failure]);
    called = false;
    const bad = recorder();
    expect(await passkeys(["passkey", "remove", "x"], DASHBOARD, transport({ remove: async () => ((called = true), { ok: true, value: { passkeys: [], readable: true } }) }), bad.output)).toBe(1);
    expect(called).toBe(false);
  });
});

describe("sshPasskeys, over a fake machine", () => {
  test("root's curl on the owner socket, every body on standard input", async () => {
    const { ran, run } = fakeMachine((command) =>
      command === ownerReadCommand("/passkeys")
        ? curl(200, { passkeys: [one("Phone", ADDED)], readable: true })
        : command === ownerWriteCommand("POST", "/passkeys/link")
          ? curl(200, { link: SECRET, expiresAt: ADDED })
          : curl(200, { passkeys: [], readable: true }),
    );
    const ssh = sshPasskeys(run);
    expect(await ssh.list()).toEqual({ ok: true, value: { passkeys: [{ id: ID, name: "Phone", createdAt: ADDED, lastUsedAt: ADDED }], readable: true } });
    expect(await ssh.link()).toEqual({ ok: true, value: { link: SECRET, expiresAt: ADDED } });
    expect(await ssh.remove(ID)).toEqual({ ok: true, value: { passkeys: [], readable: true } });
    expect(ran).toEqual([
      { command: ownerReadCommand("/passkeys"), input: undefined },
      { command: ownerWriteCommand("POST", "/passkeys/link"), input: "{}" },
      { command: ownerWriteCommand("DELETE", "/passkeys/credential"), input: JSON.stringify({ id: ID }) },
    ]);
  });

  test("a steward from before passkeys says to upgrade; a link out of shape is not printed", async () => {
    const old = fakeMachine(() => curl(404, { error: "not-found", message: "no such route" }));
    expect(await sshPasskeys(old.run).list()).toEqual({ ok: false, failure: { error: "steward-outdated", message: "the steward on the server does not keep passkeys yet: run sitesolide upgrade first" } });
    const odd = fakeMachine(() => curl(200, { link: "short", expiresAt: ADDED }));
    expect(await sshPasskeys(odd.run).link()).toMatchObject({ ok: false, failure: { error: "failure" } });
    const refused = fakeMachine(() => curl(404, { error: "not-found", message: "no such passkey" }));
    expect(await sshPasskeys(refused.run).remove(ID)).toEqual({ ok: false, failure: { error: "not-found", message: "no such passkey: nothing was changed" } });
  });
});
