import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorsView } from "../src/connectors/protocol";
import { createConnectorStore, type StoreConfig } from "../src/connectors/store";
import { createSteward } from "../src/secrets/steward";
import { createSystem, type System } from "../src/secrets/system";

/**
 * The steward's connector routes on a throwaway tree: real files, real atomic
 * writes, the same unlock as the secrets. The value is made for the test and
 * must never come out of a response.
 */
const PASSWORD = "Conn-Test-Pass-4242-Kq9X";
const VALUE = "Bearer conn-test-value-0123456789abcdef";
const OTHER_VALUE = "Bearer rotated-test-value-9876543210";

const UID = process.getuid!();
/** The group of a file created under tmpdir: the directory's on macOS, the process's on Linux. */
const TEST_GID = (() => {
  const folder = mkdtempSync(join(tmpdir(), "gid-"));
  writeFileSync(join(folder, "f"), "");
  const gid = statSync(join(folder, "f")).gid;
  rmSync(folder, { recursive: true, force: true });
  return gid;
})();

const toClean: string[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
});

type Options = { owners?: StoreConfig["owners"]; installed?: boolean; withStore?: boolean };

async function mount(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "connectors-"));
  toClean.push(root);
  const folders = Object.fromEntries(["sites", "secrets", "units", "state", "caddy", "gatekeeper"].map((name) => [name, join(root, name)]));
  for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true });
  const egress = join(root, "egress");
  if (options.installed !== false) mkdirSync(egress, { mode: 0o750 });
  if (options.installed !== false) chmodSync(egress, 0o750);

  const project = (slug: string, content: Record<string, unknown>) => {
    mkdirSync(join(folders.sites!, slug), { recursive: true });
    writeFileSync(join(folders.sites!, slug, "sitesolide.json"), JSON.stringify({ slug, start: "/x", port: 3048, ...content }));
  };
  project("shop", { connectors: ["chat"] });
  project("blog", { connectors: ["chat", "code"] });
  project("notes", {});

  const hash = await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 4 });
  writeFileSync(join(folders.secrets!, "dashboard.env"), `PASSWORD_HASH=${hash}\n`, { mode: 0o600 });
  writeFileSync(join(root, "passwd"), "root:x:0:0:root:/root:/bin/sh\n");

  const system: System = {
    ...createSystem({
      sitesDir: folders.sites!,
      secretsFolder: folders.secrets!,
      unitsFolder: folders.units!,
      stateFolder: folders.state!,
      hashFile: join(folders.secrets!, "dashboard.env"),
      accountsFile: join(root, "passwd"),
      caddyFolder: folders.caddy!,
      gatekeeperFolder: folders.gatekeeper!,
      codesFile: join(folders.gatekeeper!, "..", "locks-codes.json"),
      locksFragment: join(folders.gatekeeper!, "..", "verrous.caddy"),
      systemctl: "/path/that/does/not/exist",
    }),
    systemctl: async () => ({ code: 1, output: "" }),
  };
  const store = createConnectorStore({ folder: egress, owners: options.owners ?? null });
  const handler = createSteward(system, {
    secretsFolder: folders.secrets!,
    checkAccounts: false,
    ...(options.withStore === false ? {} : { connectors: store }),
  });
  const responses: string[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await handler(
      new Request(`http://steward${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    responses.push(text);
    return { status: response.status, body: text === "" ? null : (JSON.parse(text) as Record<string, unknown>) };
  };
  const unlock = async () => (await call("POST", "/unlock", { password: PASSWORD })).body!.token as string;
  return { root, egress, call, unlock, responses, store };
}

const chat = (token: string, value: string | null = VALUE) => ({
  token,
  name: "chat",
  baseUrl: "https://chat.test-zone.invalid/api",
  header: "Authorization",
  value,
});

describe("listing", () => {
  test("without unlocking: the connectors without their values, who asks for what, the sites", async () => {
    const bench = await mount();
    const token = await bench.unlock();
    await bench.call("PUT", "/connector", chat(token));
    const { status, body } = await bench.call("GET", "/connectors");
    expect(status).toBe(200);
    const view = body as unknown as ConnectorsView;
    expect(view.installed).toBe(true);
    expect(view.state).toBe("managed");
    expect(view.connectors.map((connector) => connector.name)).toEqual(["chat"]);
    expect(view.connectors[0]).not.toHaveProperty("value");
    expect(view.requests).toEqual([
      { slug: "blog", connectors: ["chat", "code"] },
      { slug: "shop", connectors: ["chat"] },
    ]);
    expect(view.sites).toEqual(["blog", "notes", "shop"]);
  });

  test("without the proxy's folder: not installed, and nothing written", async () => {
    const bench = await mount({ installed: false });
    const view = (await bench.call("GET", "/connectors")).body as unknown as ConnectorsView;
    expect(view.installed).toBe(false);
    expect(view.reason).toContain("sitesolide setup");
    const token = await bench.unlock();
    const refused = await bench.call("PUT", "/connector", chat(token));
    expect(refused.status).toBe(404);
    expect(existsSync(bench.egress)).toBe(false);
  });

  test("a steward mounted without a store has no such routes, as one that predates them", async () => {
    const bench = await mount({ withStore: false });
    expect((await bench.call("GET", "/connectors")).body).toEqual({ error: "not-found", message: "no such route" });
  });
});

describe("writing a connector", () => {
  test("refused without unlocking, like a secret", async () => {
    const bench = await mount();
    expect((await bench.call("PUT", "/connector", chat("not-a-token"))).status).toBe(401);
    expect(existsSync(join(bench.egress, "connectors.json"))).toBe(false);
  });

  test("created, its value in the file alone, the file 0640", async () => {
    const bench = await mount();
    const token = await bench.unlock();
    const { status, body } = await bench.call("PUT", "/connector", chat(token));
    expect(status).toBe(200);
    expect((body as unknown as ConnectorsView).connectors[0]).toMatchObject({ name: "chat", header: "Authorization", updatedBy: "owner" });
    const file = join(bench.egress, "connectors.json");
    expect(readFileSync(file, "utf8")).toContain(VALUE);
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  test("a change without a value keeps it; with one, replaces it", async () => {
    const bench = await mount();
    const token = await bench.unlock();
    await bench.call("PUT", "/connector", chat(token));
    await bench.call("PUT", "/connector", { ...chat(token, null), baseUrl: "https://chat.test-zone.invalid/v2" });
    const file = join(bench.egress, "connectors.json");
    expect(readFileSync(file, "utf8")).toContain(VALUE);
    expect(readFileSync(file, "utf8")).toContain("https://chat.test-zone.invalid/v2");
    await bench.call("PUT", "/connector", chat(token, OTHER_VALUE));
    expect(readFileSync(file, "utf8")).not.toContain(VALUE);
    expect(readFileSync(file, "utf8")).toContain(OTHER_VALUE);
  });

  test("refusals say what is wrong, never quoting the value", async () => {
    const bench = await mount();
    const token = await bench.unlock();
    const refusals = [
      await bench.call("PUT", "/connector", chat(token, null)),
      await bench.call("PUT", "/connector", { ...chat(token), baseUrl: "http://chat.test-zone.invalid" }),
      await bench.call("PUT", "/connector", { ...chat(token), header: "Host" }),
      await bench.call("PUT", "/connector", { ...chat(token), value: `${VALUE}\nX-Injected: 1` }),
      await bench.call("PUT", "/connector", { ...chat(token), name: "Chat" }),
      await bench.call("PUT", "/connector", { ...chat(token), value: 42 }),
      await bench.call("PUT", "/connector", { ...chat(token), extra: true }),
    ];
    for (const refusal of refusals) expect(refusal.status).toBe(400);
    expect(refusals[0]!.body!.message).toBe("value: required to create a connector");
  });

  test("a name every object inherits is refused, and leaves the files writable", async () => {
    const bench = await mount();
    const token = await bench.unlock();
    await bench.call("PUT", "/connector", chat(token));
    const file = join(bench.egress, "connectors.json");
    const before = readFileSync(file, "utf8");
    for (const name of ["constructor", "__proto__", "toString"]) {
      // With a value and without: the second used to find `constructor` on
      // every object, take it for an existing connector, and write a record
      // with no value, a file the proxy and the steward then refused whole.
      for (const value of [VALUE, null]) {
        const refused = await bench.call("PUT", "/connector", { ...chat(token, value), name });
        expect({ name, value, status: refused.status }).toEqual({ name, value, status: 400 });
      }
      expect((await bench.call("PUT", "/grant", { token, slug: "shop", connector: name, granted: true })).status).toBe(400);
      expect((await bench.call("DELETE", "/connector", { token, name, confirmation: name })).status).toBe(404);
    }
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(existsSync(join(bench.egress, "grants.json"))).toBe(false);
    // Still managed: the next write goes through.
    expect(((await bench.call("GET", "/connectors")).body as unknown as ConnectorsView).state).toBe("managed");
    expect((await bench.call("PUT", "/grant", { token, slug: "shop", connector: "chat", granted: true })).status).toBe(200);
  });

  test("a removal needs the name retyped, and takes its grants with it", async () => {
    const bench = await mount();
    const token = await bench.unlock();
    await bench.call("PUT", "/connector", chat(token));
    await bench.call("PUT", "/grant", { token, slug: "shop", connector: "chat", granted: true });
    expect((await bench.call("DELETE", "/connector", { token, name: "chat", confirmation: "chta" })).status).toBe(400);
    const removed = await bench.call("DELETE", "/connector", { token, name: "chat", confirmation: "chat" });
    expect(removed.status).toBe(200);
    expect((removed.body as unknown as ConnectorsView).connectors).toEqual([]);
    expect((removed.body as unknown as ConnectorsView).grants).toEqual([]);
    expect(readFileSync(join(bench.egress, "connectors.json"), "utf8")).not.toContain(VALUE);
    expect((await bench.call("DELETE", "/connector", { token, name: "chat", confirmation: "chat" })).status).toBe(404);
  });
});

describe("grants", () => {
  test("granted to a deployed site, withdrawn, and the file written only on a change", async () => {
    const bench = await mount();
    const token = await bench.unlock();
    await bench.call("PUT", "/connector", chat(token));
    const granted = await bench.call("PUT", "/grant", { token, slug: "shop", connector: "chat", granted: true });
    expect((granted.body as unknown as ConnectorsView).grants).toEqual([
      expect.objectContaining({ slug: "shop", connector: "chat", by: "owner" }),
    ]);
    const before = statSync(join(bench.egress, "grants.json")).mtimeMs;
    await Bun.sleep(5);
    await bench.call("PUT", "/grant", { token, slug: "shop", connector: "chat", granted: true });
    expect(statSync(join(bench.egress, "grants.json")).mtimeMs).toBe(before);
    const withdrawn = await bench.call("PUT", "/grant", { token, slug: "shop", connector: "chat", granted: false });
    expect((withdrawn.body as unknown as ConnectorsView).grants).toEqual([]);
  });

  test("never to a site that is not deployed, nor of a connector that does not exist", async () => {
    const bench = await mount();
    const token = await bench.unlock();
    await bench.call("PUT", "/connector", chat(token));
    expect((await bench.call("PUT", "/grant", { token, slug: "ghost", connector: "chat", granted: true })).status).toBe(403);
    expect((await bench.call("PUT", "/grant", { token, slug: "shop", connector: "code", granted: true })).status).toBe(400);
    expect((await bench.call("PUT", "/grant", { token, slug: "shop", connector: "chat", granted: "yes" })).status).toBe(400);
  });

  test("a grant whose site is gone can still be withdrawn", async () => {
    const bench = await mount();
    const token = await bench.unlock();
    await bench.call("PUT", "/connector", chat(token));
    await bench.call("PUT", "/grant", { token, slug: "shop", connector: "chat", granted: true });
    rmSync(join(bench.root, "sites", "shop"), { recursive: true });
    const view = (await bench.call("GET", "/connectors")).body as unknown as ConnectorsView;
    expect(view.sites).not.toContain("shop");
    expect(view.grants.map((grant) => grant.slug)).toEqual(["shop"]);
    expect((await bench.call("PUT", "/grant", { token, slug: "shop", connector: "chat", granted: false })).status).toBe(200);
  });
});

describe("the files' owner and mode", () => {
  const owners = { rootUid: UID, gid: () => TEST_GID };

  test("written to root and the proxy's group, 0640", async () => {
    const bench = await mount({ owners });
    const token = await bench.unlock();
    await bench.call("PUT", "/connector", chat(token));
    const stat = statSync(join(bench.egress, "connectors.json"));
    expect([stat.uid, stat.gid, stat.mode & 0o7777]).toEqual([UID, TEST_GID, 0o640]);
  });

  test("a file in another form is listed as unmanaged, and never rewritten", async () => {
    const bench = await mount({ owners });
    writeFileSync(join(bench.egress, "connectors.json"), "{}", { mode: 0o644 });
    chmodSync(join(bench.egress, "connectors.json"), 0o644);
    const view = (await bench.call("GET", "/connectors")).body as unknown as ConnectorsView;
    expect(view.state).toBe("unmanaged");
    expect(view.reason).toContain("connectors.json is 0644, expected 0640");
    const token = await bench.unlock();
    expect((await bench.call("PUT", "/connector", chat(token))).status).toBe(409);
    expect(readFileSync(join(bench.egress, "connectors.json"), "utf8")).toBe("{}");
  });

  test("a link in the file's place is not followed", async () => {
    const bench = await mount({ owners });
    writeFileSync(join(bench.root, "elsewhere.json"), "{}");
    symlinkSync(join(bench.root, "elsewhere.json"), join(bench.egress, "grants.json"));
    const view = (await bench.call("GET", "/connectors")).body as unknown as ConnectorsView;
    expect(view).toMatchObject({ state: "unmanaged", reason: "grants.json is not a plain file" });
  });

  test("a folder others can write is not managed", async () => {
    const bench = await mount({ owners });
    chmodSync(bench.egress, 0o777);
    expect(((await bench.call("GET", "/connectors")).body as unknown as ConnectorsView).state).toBe("unmanaged");
  });

  test("without the proxy's group, the proxy is not installed", async () => {
    const bench = await mount({ owners: { rootUid: UID, gid: () => null } });
    expect(((await bench.call("GET", "/connectors")).body as unknown as ConnectorsView).installed).toBe(false);
  });

  test("the temporary files an abrupt stop leaves are cleaned, and nothing else", async () => {
    const bench = await mount();
    writeFileSync(join(bench.egress, ".connectors.json.0123456789abcdef.tmp"), "x");
    writeFileSync(join(bench.egress, "notes.txt"), "kept");
    expect(bench.store.clean()).toBe(1);
    expect(existsSync(join(bench.egress, "notes.txt"))).toBe(true);
  });
});

test("no response of the steward ever carries a connector's value", async () => {
  const bench = await mount();
  const token = await bench.unlock();
  await bench.call("PUT", "/connector", chat(token));
  await bench.call("PUT", "/connector", chat(token, OTHER_VALUE));
  await bench.call("PUT", "/connector", { ...chat(token, null), header: "X-Api-Key" });
  await bench.call("GET", "/connectors");
  await bench.call("PUT", "/connector", { ...chat(token), header: "Host" });
  await bench.call("GET", "/log");
  for (const text of bench.responses) {
    expect(text).not.toContain(VALUE);
    expect(text).not.toContain(OTHER_VALUE);
  }
});
