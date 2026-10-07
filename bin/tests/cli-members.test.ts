import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addedRoles,
  describeMembers,
  invitationLine,
  membersReadCommand,
  membersWriteCommand,
  readMembersArguments,
  removedRoles,
  rolesText,
} from "../cli/members";
import { createFakeVm, type FakeVm } from "./e2e/fake-vm";
import { CLI, TEST_EMAIL, TEST_ZONE } from "./e2e/run";

/**
 * `sitesolide members`, as the owner runs it: the real bin/sitesolide.ts in a
 * child process, in front of the fake machine, whose ssh answers the steward's
 * owner socket from a registry the test lays and refuses every write the test
 * does not accept. With a team token, it is refused before anything is sent.
 * The decisions themselves are tried at the end, without running anything.
 */

const DASHBOARD = `https://dashboard.${TEST_ZONE}`;
const toClean: string[] = [];

function folder(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  toClean.push(path);
  return path;
}

afterEach(() => {
  for (const path of toClean.splice(0)) rmSync(path, { recursive: true, force: true });
});

type Event = Record<string, any>;
const events = (output: string): Event[] =>
  output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Event);

describe("members as the owner, over SSH to the steward's owner socket", () => {
  let machine: FakeVm;
  beforeEach(() => {
    machine = createFakeVm();
  });
  afterEach(() => machine.cleanup());

  async function owner(arguments_: string[]) {
    const proc = Bun.spawn(["bun", CLI, ...arguments_], {
      cwd: folder("members-"),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, SITESOLIDE_ZONE: TEST_ZONE, SITESOLIDE_EMAIL: TEST_EMAIL, ...machine.env },
    });
    const [output, error] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, output, error };
  }

  test("lists who signs in, on what, and the line to send, reading nothing else", async () => {
    machine.setMembers({ members: [{ email: "alice@acme.test", roles: { blog: "developer", shop: "viewer" }, invitedBy: "owner", createdAt: 1, updatedAt: 1 }] });
    const result = await owner(["members"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain(`-> members of ${DASHBOARD}, over SSH, as the owner`);
    expect(result.output).toContain("alice@acme.test  blog: developer, shop: viewer");
    expect(result.output).toContain(`send: Open ${DASHBOARD} and sign in with your Google work account.`);
    expect(machine.logs()).toEqual(["MEMBERS GET", "SHARING GET"]);
  });

  test("invites with a role per project, the body on standard input, and says what to send", async () => {
    machine.acceptWrites();
    const result = await owner(["members", "add", "Alice@ACME.test", "--project", "blog", "--role", "developer", "--project", "shop", "--role", "viewer", "--json"]);
    expect(result.code).toBe(0);
    expect(machine.logs().filter((line) => line.startsWith("MEMBERS PUT"))).toEqual([
      'MEMBERS PUT {"email":"alice@acme.test","roles":{"blog":"developer","shop":"viewer"}}',
    ]);
    // Never in the command line.
    expect(machine.logs().some((line) => line.startsWith("ACCEPTED") && line.includes("alice"))).toBe(false);
    expect(events(result.output).at(-1)).toMatchObject({
      type: "result",
      command: "members",
      change: "invite",
      email: "alice@acme.test",
      roles: { blog: "developer", shop: "viewer" },
      message: `Open ${DASHBOARD} and sign in with your Google work account.`,
    });
  });

  test("add on a member sets the roles named and keeps the others; remove --project takes some off", async () => {
    machine.acceptWrites();
    machine.setMembers({ members: [{ email: "alice@acme.test", roles: { blog: "viewer", shop: "viewer" }, invitedBy: "owner", createdAt: 1, updatedAt: 1 }] });
    expect((await owner(["members", "add", "alice@acme.test", "--project", "blog", "--role", "admin"])).code).toBe(0);
    expect(machine.members().members[0]!.roles).toEqual({ blog: "admin", shop: "viewer" });
    const removed = await owner(["members", "remove", "alice@acme.test", "--project", "shop", "--project", "gone"]);
    expect(removed.code).toBe(0);
    expect(removed.output).toContain("gone: not among their projects");
    expect(machine.members().members[0]!.roles).toEqual({ blog: "admin" });
  });

  test("remove takes the member off, and someone who is not one is said so", async () => {
    machine.acceptWrites();
    machine.setMembers({ members: [{ email: "alice@acme.test", roles: { blog: "viewer" }, invitedBy: "owner", createdAt: 1, updatedAt: 1 }] });
    const removed = await owner(["members", "remove", "alice@acme.test"]);
    expect(removed.code).toBe(0);
    expect(removed.output).toContain("alice@acme.test removed: signed out of the dashboard");
    expect(machine.logs()).toContain('MEMBERS DELETE {"email":"alice@acme.test"}');
    expect(machine.members().members).toEqual([]);
    const again = await owner(["members", "remove", "alice@acme.test", "--json"]);
    expect(again.code).toBe(1);
    expect(events(again.output).at(-1)).toMatchObject({ type: "error", message: "alice@acme.test is not a member: nothing was changed" });
  });

  test("the steward's refusal comes back as it stands, an address outside the portal's domains first", async () => {
    machine.acceptWrites();
    const result = await owner(["members", "add", "eve@elsewhere.test", "--project", "blog", "--role", "viewer", "--json"]);
    expect(result.code).toBe(1);
    expect(events(result.output).at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("the portal admits only acme.test") });
  });

  test("a change is a write: refused by a machine that accepts none, nothing changed", async () => {
    const result = await owner(["members", "add", "alice@acme.test", "--project", "blog", "--role", "viewer", "--json"]);
    expect(result.code).toBe(1);
    expect(events(result.output).at(-1)).toMatchObject({ type: "error", message: "cannot reach the server over SSH: nothing was changed" });
    expect(machine.members().members).toEqual([]);
  });

  test("a steward from before members, and one with no owner's socket, point to the upgrade", async () => {
    machine.setMembers({ state: "old" });
    const old = events((await owner(["members", "--json"])).output).at(-1)!;
    expect(old).toMatchObject({ type: "error", message: expect.stringContaining("run sitesolide upgrade") });
    machine.setMembers({ state: "down" });
    const down = events((await owner(["members", "--json"])).output).at(-1)!;
    expect(down).toMatchObject({ type: "error", message: expect.stringContaining("no owner's socket") });
    expect(down.details[0]).toContain("curl: (7)");
  });

  test("arguments that make no request are refused before anything is sent", async () => {
    for (const arguments_ of [
      ["members", "add", "alice@acme.test"],
      ["members", "add", "alice@acme.test", "--project", "blog"],
      ["members", "add", "alice@acme.test", "--role", "viewer"],
      ["members", "add", "alice@acme.test", "--project", "blog", "--role", "owner"],
      ["members", "invite", "alice@acme.test"],
      ["members", "remove"],
    ]) {
      const result = await owner([...arguments_, "--json"]);
      expect([arguments_.join(" "), result.code]).toEqual([arguments_.join(" "), 1]);
    }
    expect(machine.logs()).toEqual([]);
  });
});

describe("members with a team token", () => {
  test("needs the owner's SSH access, and says so before anything is sent", async () => {
    const home = folder("members-home-");
    const proc = Bun.spawn(["bun", CLI, "members", "--json"], {
      cwd: home,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", HOME: home, SITESOLIDE_API: "https://dashboard.test-zone.invalid", SITESOLIDE_TOKEN: `sst_${"A".repeat(43)}` },
    });
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(1);
    expect(events(output).at(-1)).toMatchObject({ type: "error", message: "sitesolide members needs the owner's SSH access to the machine" });
  });
});

describe("the decisions", () => {
  test("each --project takes the --role that follows it", () => {
    expect(readMembersArguments(["members"])).toEqual({ action: "list" });
    expect(readMembersArguments(["members", "add", "A@acme.test", "--project", "blog", "--role", "developer", "--project", "shop", "--role", "admin"])).toEqual({
      action: "add",
      email: "a@acme.test",
      roles: { blog: "developer", shop: "admin" },
    });
    expect(readMembersArguments(["members", "remove", "a@acme.test", "--project", "blog"])).toEqual({ action: "remove", email: "a@acme.test", projects: ["blog"] });
    expect(readMembersArguments(["members", "add", "a@acme.test", "--project", "blog", "--project", "shop", "--role", "viewer"])).toMatchObject({
      error: "usage",
      message: "--project blog: give its --role before the next --project",
    });
    expect(readMembersArguments(["members", "add", "a@acme.test", "--project", "../x", "--role", "viewer"])).toMatchObject({ error: "invalid" });
    expect(readMembersArguments(["members", "remove", "a@acme.test", "--role", "viewer"])).toMatchObject({ error: "usage" });
  });

  test("roles merged and taken off, in words", () => {
    expect(addedRoles({ blog: "viewer", shop: "viewer" }, { blog: "admin" })).toEqual({ blog: "admin", shop: "viewer" });
    expect(removedRoles({ blog: "admin", shop: "viewer" }, ["shop", "gone"])).toEqual({ roles: { blog: "admin" }, absent: ["gone"] });
    expect(rolesText({ shop: "viewer", blog: "admin" })).toBe("blog: project admin, shop: viewer");
    expect(invitationLine(DASHBOARD, null)).toBe(`Open ${DASHBOARD} and sign in with your work account.`);
    expect(describeMembers({ members: [], signIn: { configured: false, allowedDomains: [] } }, "x").at(-1)).toContain("not set up");
  });

  test("the commands speak to the owner socket, the bodies never on the command line", () => {
    expect(membersReadCommand()).toBe("sudo curl -sS --max-time 10 -w '\\n%{http_code}\\n' --unix-socket /run/sitesolide-steward-owner/owner.sock http://steward/members");
    expect(membersWriteCommand("PUT")).toContain("--data-binary @-");
    expect(membersWriteCommand("DELETE")).toContain("-X DELETE");
  });
});
