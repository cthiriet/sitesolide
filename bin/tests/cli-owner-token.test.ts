import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerLogin, ownerTokenLabel } from "../cli/owner-token";
import { keepToken, readRemote, type Failure, type Fetch, type Output } from "../cli/remote";

/**
 * `sitesolide login --owner`: the owner's token for every project, minted
 * by the steward's owner socket over SSH, kept in the vault, never shown.
 */

const ZONE = "test-zone.invalid";
const API = `https://dashboard.${ZONE}`;
const SECRET = `sst_${"S".repeat(43)}`;
const OLD = `sst_${"O".repeat(43)}`;
const EVERY = { slugs: [], create: true, outbound: true, domain: true, public: true, secrets: true, all: true };
const VIEW = { id: "aaaaaaaaaaaa", label: "Owner, laptop", email: "owner", expiresAt: null, scope: EVERY };

const toClean: string[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function home(): string {
  const path = mkdtempSync(join(tmpdir(), "owner-token-"));
  toClean.push(path);
  return path;
}

function recording() {
  const lines: string[] = [];
  const failures: Failure[] = [];
  const results: Record<string, unknown>[] = [];
  const output: Output = {
    say: (line) => lines.push(line),
    journal: (line) => lines.push(line),
    failed: (failure) => failures.push(failure),
    succeeded: (_command, fields) => results.push(fields),
  };
  return { lines, failures, results, output };
}

/** The steward over SSH: what curl prints, the body then the status. */
function steward(status = 201, body: unknown = { token: { ...VIEW, owned: [] }, secret: SECRET }) {
  const calls: { command: string; input?: string }[] = [];
  return {
    calls,
    run: async (command: string, input?: string) => {
      calls.push({ command, input });
      return { code: 0, output: `${JSON.stringify(body)}\n${status}\n`, error: "" };
    },
  };
}

const whoami =
  (identity: object | null): Fetch =>
  async () =>
    identity === null ? Response.json({ error: "unauthenticated", message: "unknown token" }, { status: 401 }) : Response.json({ identity });

describe("sitesolide login --owner", () => {
  test("mints over the owner's socket, keeps the token in the vault 0600 bound to the dashboard, and never says it", async () => {
    const h = home();
    const machine = steward();
    const { lines, results, output } = recording();
    const code = await ownerLogin(["login", "--owner"], { environment: {}, home: h, output, run: machine.run, zone: ZONE });
    expect(code).toBe(0);
    expect(machine.calls).toHaveLength(1);
    expect(machine.calls[0]!.command).toContain("POST");
    expect(machine.calls[0]!.command).toContain("http://steward/tokens/owner");
    expect(machine.calls[0]!.command).not.toContain(SECRET);
    expect(JSON.parse(machine.calls[0]!.input!)).toMatchObject({ expiresAt: null });
    const kept = readRemote({}, h);
    expect(kept).toEqual({ api: API, token: SECRET });
    const path = join(h, ".config", "sitesolide", "secrets", "team-token");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8").trim()).toBe(SECRET);
    expect(JSON.stringify([lines, results])).not.toContain(SECRET);
    expect(results[0]).toMatchObject({ api: API, minted: true });
  });

  test("a token for every project the dashboard accepts is kept; one it refuses is replaced; --replace mints anyway", async () => {
    const h = home();
    keepToken({}, h, API, OLD);
    const machine = steward();
    const kept = recording();
    expect(await ownerLogin(["login", "--owner"], { environment: {}, home: h, output: kept.output, run: machine.run, zone: ZONE, fetcher: whoami({ ...VIEW, owned: [] }) })).toBe(0);
    expect(machine.calls).toHaveLength(0);
    expect(kept.results[0]).toMatchObject({ minted: false });
    expect(readRemote({}, h)).toEqual({ api: API, token: OLD });

    expect(await ownerLogin(["login", "--owner"], { environment: {}, home: h, output: recording().output, run: machine.run, zone: ZONE, fetcher: whoami(null) })).toBe(0);
    expect(machine.calls).toHaveLength(1);
    expect(readRemote({}, h)).toEqual({ api: API, token: SECRET });

    keepToken({}, h, API, OLD);
    expect(await ownerLogin(["login", "--owner", "--replace"], { environment: {}, home: h, output: recording().output, run: machine.run, zone: ZONE, fetcher: whoami({ ...VIEW, owned: [] }) })).toBe(0);
    expect(machine.calls).toHaveLength(2);
  });

  test("a steward from before the route, or an unknown option: nothing is kept", async () => {
    const h = home();
    const outdated = recording();
    expect(await ownerLogin(["login", "--owner"], { environment: {}, home: h, output: outdated.output, run: steward(404, { error: "not-found", message: "no such route" }).run, zone: ZONE })).toBe(1);
    expect(outdated.failures[0]!.message).toContain("sitesolide upgrade");
    expect("missing" in readRemote({}, h)).toBe(true);
    const unknown = recording();
    expect(await ownerLogin(["login", "--owner", "--token-stdin"], { environment: {}, home: h, output: unknown.output, run: steward().run, zone: ZONE })).toBe(1);
    expect(unknown.failures[0]!.error).toBe("unknown-option");
  });

  test("the label names the workstation, in the characters a label takes", () => {
    expect(ownerTokenLabel("laptop.local")).toBe("Owner, laptop.local");
    expect(ownerTokenLabel("\u0007")).toBe("Owner's workstation");
  });
});
