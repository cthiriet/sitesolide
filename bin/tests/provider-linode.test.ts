import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  apiBase,
  cliConfigToken,
  discover,
  failureFrom,
  FIREWALL_RULES,
  imageFor,
  LINODE,
  LINODE_DEFAULTS,
  nameProblem,
  WAITS,
} from "../cli/providers/linode";
import { ProviderError, type CreateRequest, type Machine, type Provider, type Workstation } from "../cli/providers/provider";
import { createFake, createFakeLinode, FAKE_TOKEN, type FakeLinode } from "./fake-linode";

/**
 * The Akamai (Linode) provider, opened directly against a local fake of the
 * Linode API v4 (fake-linode.ts): the real one is never called. The clock does
 * not wait, every fetch is checked for what it carries, and everything the
 * provider reports or throws is kept, so that the last tests can say that
 * the token never appears in it.
 */

const REPO = join(import.meta.dir, "..", "..");

/** Generated for these tests with ssh-keygen; the private half was deleted at once. */
const KEY = {
  algorithm: "ssh-ed25519",
  blob: "AAAAC3NzaC1lZDI1NTE5AAAAICezpiOyiQWMYqOeL4S4OgE0T7Fq2bLHWUJ1afO4cczN",
  comment: "ada@workstation.test-zone.invalid",
  fingerprint: "a4:46:30:d5:fd:7e:1a:77:e5:ad:8d:21:4f:9a:3e:9e",
};

let fake: FakeLinode;
/** Every line reported and every refusal thrown, read by the last tests. */
const printed: string[] = [];
/** The secrets the provider handed to `context.secret`: none, it obtains none along the way. */
const handed: string[] = [];
/** What every fetch asked, for the tests of what leaves. */
const fetches: { url: string; init: RequestInit | undefined }[] = [];

beforeAll(() => {
  fake = createFakeLinode();
});

afterAll(() => {
  fake.stop();
});

beforeEach(() => {
  fake.reset();
  fetches.length = 0;
});

function fakeClock() {
  let now = Date.parse("2026-10-21T10:00:00Z");
  return { now: () => now, sleep: async (milliseconds: number) => void (now += milliseconds), elapsed: () => now - Date.parse("2026-10-21T10:00:00Z") };
}

function open(options: { token?: string; clock?: ReturnType<typeof fakeClock> } = {}): Provider {
  return LINODE.open({
    credentials: { LINODE_TOKEN: options.token ?? FAKE_TOKEN },
    environment: { SITESOLIDE_LINODE_API: fake.url },
    fetcher: (input, init) => {
      fetches.push({ url: input, init });
      return fetch(input, init);
    },
    clock: options.clock ?? fakeClock(),
    secret: (value) => void handed.push(value),
  });
}

function request(extra: Partial<CreateRequest> = {}): CreateRequest {
  return { name: "web", type: LINODE_DEFAULTS.type, location: LINODE_DEFAULTS.location, image: LINODE_DEFAULTS.image, backups: false, key: KEY, ...extra };
}

/** The lines a step reported, kept for the last tests too. */
function recorder(): { lines: string[]; report: (line: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    report: (line) => {
      lines.push(line);
      printed.push(line);
    },
  };
}

/** The refusal a promise ends with, kept for the last tests. */
async function refusal(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    printed.push(JSON.stringify(error.failure), error.message);
    return error;
  }
  throw new Error("expected a refusal");
}

/** The requests that changed something, as `METHOD /path`. */
function writes(): string[] {
  return fake.requests.filter((entry) => entry.method !== "GET").map((entry) => `${entry.method} ${entry.path}`);
}

function body(method: string, path: string): Record<string, unknown> {
  const found = fake.requests.find((entry) => entry.method === method && entry.path === path);
  expect(found).toBeDefined();
  return found!.body as Record<string, unknown>;
}

const MANAGED = ["managed-by:sitesolide", "sitesolide-machine:web"];

// --- the entry ---------------------------------------------------------------------------------

describe("the entry", () => {
  test("names the provider, its credential, its defaults and its page", () => {
    expect(LINODE.name).toBe("linode");
    expect(LINODE.title).toBe("Akamai (Linode)");
    expect(LINODE.apiVariable).toBe("SITESOLIDE_LINODE_API");
    expect(LINODE.backups).toBe(true);
    expect(LINODE.defaults({})).toEqual({ type: "g6-standard-1", location: "fr-par", image: "debian-13" });
    expect(LINODE.credentials.map((field) => [field.variable, field.secret])).toEqual([["LINODE_TOKEN", true]]);
    expect(existsSync(join(REPO, LINODE.docs))).toBe(true);
    expect(LINODE.credentialHelp.join("\n")).toContain("Read/Write on Linodes and on Firewalls");
  });

  test("the token's shape takes a personal access token and nothing pasted around it", () => {
    const shape = LINODE.credentials[0]!.shape;
    expect(shape.test(FAKE_TOKEN)).toBe(true);
    for (const wrong of ["", "short", `Bearer ${FAKE_TOKEN}`, `${FAKE_TOKEN}\n`, `"${FAKE_TOKEN}"`, `LINODE_TOKEN=${FAKE_TOKEN}`]) expect(shape.test(wrong)).toBe(false);
  });

  test("the API's address takes https, or http on the loopback only, and nothing but an address", () => {
    expect(apiBase({})).toBe("https://api.linode.com/v4");
    expect(apiBase({ SITESOLIDE_LINODE_API: "http://127.0.0.1:8080/v4/" })).toBe("http://127.0.0.1:8080/v4");
    for (const wrong of ["http://api.test-zone.invalid/v4", "https://api.test-zone.invalid/v4?token=x", "https://user:pass@api.test-zone.invalid/v4", "not an address"]) {
      expect(() => apiBase({ SITESOLIDE_LINODE_API: wrong })).toThrow(ProviderError);
    }
  });

  test("debian-13 is Akamai's Debian 13 image, and Akamai's own ids pass through", () => {
    expect(imageFor("debian-13")).toBe("linode/debian13");
    expect(imageFor("linode/ubuntu24.04")).toBe("linode/ubuntu24.04");
  });

  test("a name Akamai would refuse is told before anything leaves", () => {
    expect(nameProblem("web")).toBeNull();
    expect(nameProblem("prod-paris-2")).toBeNull();
    expect(nameProblem("ab")).toContain("shorter than 3");
    expect(nameProblem("1web")).toContain("start with a letter");
    expect(nameProblem("a--b")).toContain("two dashes");
    expect(nameProblem("a".repeat(21))).toBeNull();
    expect(nameProblem("a".repeat(22))).toContain("32 at most");
  });

  test("the fake is a FakeProvider: its environment opens the provider", () => {
    const other = createFake();
    try {
      expect(other.environment.LINODE_TOKEN).toBe(FAKE_TOKEN);
      expect(other.environment.SITESOLIDE_LINODE_API).toStartWith("http://127.0.0.1:");
      expect(other.secrets).toEqual([FAKE_TOKEN]);
    } finally {
      other.stop();
    }
  });
});

// --- create --------------------------------------------------------------------------------------

describe("create", () => {
  test("on an empty account: the firewall, then the Linode on Linode interfaces, the firewall on its public interface", async () => {
    const { lines, report } = recorder();
    const outcome = await open().create(request(), report);

    expect(writes()).toEqual(["POST /networking/firewalls", "POST /linode/instances"]);
    const firewall = body("POST", "/networking/firewalls");
    expect(firewall).toEqual({ label: "sitesolide-web", tags: MANAGED, rules: FIREWALL_RULES });
    expect(FIREWALL_RULES.inbound_policy).toBe("DROP");
    expect(FIREWALL_RULES.inbound.map((rule) => [rule.protocol, "ports" in rule ? rule.ports : null])).toEqual([
      ["TCP", "22"],
      ["TCP", "80"],
      ["TCP", "443"],
      ["ICMP", null],
    ]);
    for (const rule of FIREWALL_RULES.inbound) expect(rule.addresses).toEqual({ ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] });

    const firewallId = fake.firewalls[0]!.id;
    const order = body("POST", "/linode/instances");
    expect(order).toMatchObject({
      label: "web",
      region: "fr-par",
      type: "g6-standard-1",
      image: "linode/debian13",
      authorized_keys: [`${KEY.algorithm} ${KEY.blob} ${KEY.comment}`],
      tags: MANAGED,
      booted: true,
      backups_enabled: false,
      interface_generation: "linode",
      network_helper: true,
      interfaces: [{ firewall_id: firewallId, default_route: { ipv4: true, ipv6: true }, public: { ipv4: { addresses: [{ address: "auto", primary: true }] } } }],
    });
    expect(order.firewall_id).toBeUndefined();
    expect(order.user_data).toBeUndefined();
    expect(order.metadata).toBeUndefined();
    // The key is the only way in: no root password, so no password login
    // open before setup closes them.
    expect(order.root_pass).toBeUndefined();
    expect(order.authorized_users).toBeUndefined();
    expect(fake.instances[0]!.root_pass).toBe(false);
    expect(fake.instances[0]!.network_helper).toBe(true);
    expect(lines).toContain("   root: your key only, no password");

    const instance = fake.instances[0]!;
    expect(fake.firewalls[0]!.entities).toEqual([expect.objectContaining({ type: "linode_interface", parent_entity: expect.objectContaining({ id: instance.id }) })]);
    expect(outcome.created).toBe(true);
    expect(outcome.resources).toEqual([
      { kind: "firewall", name: "sitesolide-web", id: String(firewallId), reused: false },
      { kind: "linode", name: "web", id: String(instance.id), reused: false },
    ]);
    const ipv6 = instance.ipv6!.split("/")[0]!;
    expect(outcome.machine).toEqual({
      provider: "linode",
      id: String(instance.id),
      name: "web",
      type: "g6-standard-1",
      location: "fr-par",
      status: "running",
      ipv4: instance.ipv4[0]!,
      ipv6,
      ipv6Network: null,
      monthlyPrice: { net: "12.00", gross: "12.00", currency: "USD" },
      backups: false,
      managed: true,
      labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" },
      login: "root",
    } satisfies Machine);
    expect(lines).toContain("-> g6-standard-1 at fr-par, what Akamai sells there");
    expect(lines).toContain("   1 vCPU, 2 GB RAM, 50 GB disk, 12.00 USD a month before VAT");
    expect(lines.filter((line) => line.startsWith("   status: "))).toEqual(["   status: booting", "   status: running"]);
  });

  test("in a region without Linode interfaces: the legacy profile, the firewall on the Linode", async () => {
    await open().create(request({ location: "us-east" }), recorder().report);
    const order = body("POST", "/linode/instances");
    expect(order.firewall_id).toBe(fake.firewalls[0]!.id);
    expect(order.interface_generation).toBe("legacy_config");
    // Network Helper's setting is for Linode interfaces only.
    expect(order.network_helper).toBeUndefined();
    expect(order.root_pass).toBeUndefined();
    expect(order.interfaces).toBeUndefined();
    expect(fake.instances[0]!.interface_generation).toBe("legacy_config");
    expect(fake.firewalls[0]!.entities).toEqual([expect.objectContaining({ type: "linode", id: fake.instances[0]!.id })]);
  });

  test("a second run finds the machine and writes nothing", async () => {
    const provider = open();
    await provider.create(request(), recorder().report);
    fake.requests.length = 0;
    const { lines, report } = recorder();
    const again = await provider.create(request({ type: "g6-standard-2" }), report);
    expect(writes()).toEqual([]);
    expect(again.created).toBe(false);
    expect(again.resources).toEqual([{ kind: "linode", name: "web", id: String(fake.instances[0]!.id), reused: true }]);
    expect(lines).toContain("!! it is g6-standard-1 at fr-par: --type and --location only apply to a machine being created");
    expect(fake.instances).toHaveLength(1);
    expect(fake.firewalls).toHaveLength(1);
  });

  test("a firewall an interrupted run left is reused, not created twice", async () => {
    const left = fake.addFirewall({ label: "sitesolide-web", tags: MANAGED });
    const outcome = await open().create(request(), recorder().report);
    expect(writes()).toEqual(["POST /linode/instances"]);
    expect(outcome.resources[0]).toEqual({ kind: "firewall", name: "sitesolide-web", id: String(left.id), reused: true });
  });

  test("backups: ordered with the Linode, or enabled on the one a first run made", async () => {
    await open().create(request({ backups: true }), recorder().report);
    expect(body("POST", "/linode/instances").backups_enabled).toBe(true);
    expect(fake.instances[0]!.backups).toBe(true);

    fake.reset();
    fake.addInstance({ label: "web", tags: MANAGED, type: "g6-standard-1" });
    const outcome = await open().create(request({ backups: true }), recorder().report);
    expect(writes()).toEqual([`POST /linode/instances/${fake.instances[0]!.id}/backups/enable`]);
    expect(outcome.machine.backups).toBe(true);
  });

  test("an existing machine that is powered off is said so, never powered on", async () => {
    fake.addInstance({ label: "web", tags: MANAGED, status: "offline" });
    const error = await refusal(open().create(request(), recorder().report));
    expect(error.failure.error).toBe("machine-off");
    expect(writes()).toEqual([]);
  });
});

describe("what create refuses before any write", () => {
  test("a Linode of that name sitesolide did not create", async () => {
    fake.addInstance({ label: "web", tags: ["production"] });
    const error = await refusal(open().create(request(), recorder().report));
    expect(error.failure.error).toBe("machine-exists");
    expect(error.failure.details?.join("\n")).toContain("nothing was created, nothing was changed");
    expect(writes()).toEqual([]);
  });

  test("a firewall of that label sitesolide did not create, or created for another machine", async () => {
    fake.addFirewall({ label: "sitesolide-web" });
    expect((await refusal(open().create(request(), recorder().report))).failure.error).toBe("firewall-taken");
    fake.reset();
    fake.addFirewall({ label: "sitesolide-web", tags: ["managed-by:sitesolide", "sitesolide-machine:other"] });
    expect((await refusal(open().create(request(), recorder().report))).failure.error).toBe("firewall-taken");
    expect(writes()).toEqual([]);
  });

  test("an unknown region, one without what create needs, one in an outage", async () => {
    const unknown = await refusal(open().create(request({ location: "xx-nowhere" }), recorder().report));
    expect(unknown.failure).toMatchObject({ error: "invalid-location", message: "xx-nowhere is not an Akamai region" });
    expect(unknown.failure.details).toContain("fr-par       Paris, FR");
    expect(unknown.failure.details?.join("\n")).not.toContain("test-edge-1");

    const noBackups = await refusal(open().create(request({ location: "us-southeast", backups: true }), recorder().report));
    expect(noBackups.failure).toMatchObject({ error: "invalid-location", message: "us-southeast does not offer Backups" });

    const outage = await refusal(open().create(request({ location: "ap-south" }), recorder().report));
    expect(outage.failure).toMatchObject({ error: "provider-unavailable", message: "Akamai says ap-south is outage" });
    expect(writes()).toEqual([]);
  });

  test("an unknown type, with the cheapest types of the region instead", async () => {
    const error = await refusal(open().create(request({ type: "g6-standard-99" }), recorder().report));
    expect(error.failure.error).toBe("invalid-server-type");
    expect(error.failure.details?.[1]).toBe("g6-standard-1   1 vCPU, 2 GB RAM, 50 GB disk, 12.00 USD a month before VAT");
    expect(error.failure.details?.join("\n")).not.toContain("g6-nanode-1");
    expect(writes()).toEqual([]);
  });

  test("a type the region lists as unavailable", async () => {
    fake.settings.unavailable = [{ region: "fr-par", plan: "g6-standard-1" }];
    const error = await refusal(open().create(request(), recorder().report));
    expect(error.failure.error).toBe("type-unavailable");
    expect(error.failure.details).toContain("nothing had been created yet");
    expect(error.failure.details?.join("\n")).not.toContain("g6-standard-1 ");
    expect(writes()).toEqual([]);
  });

  test("a name Akamai cannot take: nothing is asked of the API at all", async () => {
    for (const name of ["ab", "1web", "a--b", "a-name-far-too-long-for"]) {
      const error = await refusal(open().create(request({ name }), recorder().report));
      expect(error.failure.error).toBe("provider-invalid");
      expect(error.failure.details).toContain("nothing was created");
    }
    expect(fake.requests).toEqual([]);
  });
});

describe("a refused order", () => {
  test("deletes the firewall this run created, and lists the types to try", async () => {
    fake.fail("POST", /^\/linode\/instances$/, 400, "We're sorry, this plan is currently unavailable in that region.", { field: "type" });
    const { lines, report } = recorder();
    const error = await refusal(open().create(request(), report));
    expect(error.failure.error).toBe("type-unavailable");
    expect(error.failure.details).toContain("deleted the firewall sitesolide-web this run had created");
    expect(error.failure.details?.join("\n")).toContain("g6-standard-2");
    expect(writes()).toEqual(["POST /networking/firewalls", "POST /linode/instances", `DELETE /networking/firewalls/${fake.requests.find((entry) => entry.method === "DELETE")!.path.split("/").pop()}`]);
    expect(fake.firewalls).toEqual([]);
    expect(lines).toContain("-> undo what this run created");
  });

  test("leaves the firewall an earlier run created", async () => {
    fake.addFirewall({ label: "sitesolide-web", tags: MANAGED });
    fake.fail("POST", /^\/linode\/instances$/, 500, "Internal Server Error");
    const error = await refusal(open().create(request(), recorder().report));
    expect(error.failure.error).toBe("provider-failure");
    expect(error.failure.details).toContain("nothing had been created yet");
    expect(writes()).toEqual(["POST /linode/instances"]);
    expect(fake.firewalls).toHaveLength(1);
  });

  test("keeps the firewall when the Linode was created all the same", async () => {
    fake.settings.createThenFail = true;
    const error = await refusal(open().create(request(), recorder().report));
    expect(error.failure.error).toBe("provider-failure");
    expect(error.failure.details?.join("\n")).toContain("left the firewall sitesolide-web: it protects a Linode now");
    expect(writes()).toEqual(["POST /networking/firewalls", "POST /linode/instances"]);
    expect(fake.firewalls[0]!.entities).toHaveLength(1);
  });

  test("an account that forbids Linode interfaces is said so", async () => {
    fake.settings.interfaces = "legacy_config_only";
    const error = await refusal(open().create(request(), recorder().report));
    expect(error.failure.error).toBe("provider-invalid");
    expect(error.failure.details?.join("\n")).toContain("the account's setting for new Linodes' interfaces");
    expect(error.failure.details).toContain("deleted the firewall sitesolide-web this run had created");
  });

  test("a label Akamai says is taken", async () => {
    fake.fail("POST", /^\/linode\/instances$/, 400, "Label must be unique among your linodes", { field: "label" });
    expect((await refusal(open().create(request(), recorder().report))).failure.error).toBe("provider-name-taken");
  });
});

// --- waits ---------------------------------------------------------------------------------------

describe("the waits", () => {
  test("are bounded, on the injected clock", async () => {
    fake.settings.bootPolls = 1_000_000;
    const clock = fakeClock();
    const started = Date.now();
    const error = await refusal(open({ clock }).create(request(), recorder().report));
    expect(error.failure).toMatchObject({ error: "machine-timeout", message: "web is still not running after 10 minutes" });
    expect(clock.elapsed()).toBe(WAITS.runningMs);
    const polls = fake.requests.filter((entry) => entry.method === "GET" && /^\/linode\/instances\/[0-9]+$/.test(entry.path)).length;
    expect(polls).toBe(WAITS.runningMs / WAITS.pollMs + 1);
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  test("shrug off a rate limit until the deadline, once warned", async () => {
    fake.fail("GET", /^\/linode\/instances\/[0-9]+$/, 429, "Too Many Requests", { headers: { "Retry-After": "5" }, times: 2 });
    const { lines, report } = recorder();
    const outcome = await open().create(request(), report);
    expect(outcome.machine.status).toBe("running");
    expect(lines.filter((line) => line.startsWith("!! "))).toEqual(["!! Akamai's rate limit is reached, nothing more can be asked of it for now (429): still waiting"]);
  });
});

// --- list ---------------------------------------------------------------------------------------

describe("list", () => {
  test("only the Linodes sitesolide created, across every page", async () => {
    fake.addInstance({ label: "web", tags: MANAGED, type: "g6-standard-1" });
    fake.addInstance({ label: "mail", tags: ["production"] });
    fake.addInstance({ label: "db", tags: ["managed-by:sitesolide", "sitesolide-machine:db"], region: "br-gru", type: "g6-standard-1" });
    fake.addInstance({ label: "named", tags: ["sitesolide-machine:named"] });
    fake.addInstance({ label: "bare" });
    const machines = await open().list();
    expect(machines.map((machine) => machine.name)).toEqual(["web", "db"]);
    expect(machines.every((machine) => machine.managed && machine.login === "root")).toBe(true);
    // Sao Paulo's own price, not the default.
    expect(machines[1]!.monthlyPrice).toEqual({ net: "16.80", gross: "16.80", currency: "USD" });
    const pages = fake.requests.filter((entry) => entry.path === "/linode/instances").map((entry) => new URLSearchParams(entry.search).get("page"));
    expect(pages).toEqual(["1", "2", "3"]);
    expect(new URLSearchParams(fake.requests[0]!.search).get("page_size")).toBe("500");
  });

  test("find says what holds a name, ours or not", async () => {
    expect(await open().find("web")).toBeNull();
    fake.addInstance({ label: "web", tags: ["production"] });
    const found = await open().find("web");
    expect(found).toMatchObject({ name: "web", managed: false, labels: { production: "" } });
    const lookup = fake.requests.find((entry) => entry.path === "/linode/instances")!;
    expect(lookup.headers["x-filter"]).toBe(JSON.stringify({ label: "web" }));
  });
});

// --- destroy ------------------------------------------------------------------------------------

describe("destroy", () => {
  test("the Linode, then its firewall", async () => {
    const provider = open();
    const { machine } = await provider.create(request({ backups: true }), recorder().report);
    fake.requests.length = 0;
    const { lines, report } = recorder();
    const outcome = await provider.destroy(machine, { deleteKey: true }, report);
    expect(writes()).toEqual([`DELETE /linode/instances/${machine.id}`, `DELETE /networking/firewalls/${fake.requests.find((entry) => entry.path.startsWith("/networking/firewalls/"))!.path.split("/").pop()}`]);
    expect(outcome).toEqual({ removed: [`Linode web (${machine.ipv4}, ${machine.ipv6}), with its backups`, "firewall sitesolide-web"], kept: [] });
    expect(fake.instances).toEqual([]);
    expect(fake.firewalls).toEqual([]);
    expect(lines).toContain("   none in the account: the key went onto the Linode's disk, and went with it");
  });

  test("says the volumes it leaves attached to nothing, and never deletes them", async () => {
    const provider = open();
    const { machine } = await provider.create(request(), recorder().report);
    const data = fake.addVolume({ label: "data", size: 40, linode_id: Number(machine.id) });
    const other = fake.addVolume({ label: "elsewhere", size: 10 });
    fake.requests.length = 0;
    const { lines, report } = recorder();
    const outcome = await provider.destroy(machine, { deleteKey: false }, report);
    expect(outcome.kept).toEqual(["volume data (40 GB): detached from web, and billed until it is deleted from Cloud Manager"]);
    expect(lines).toContain("!! volume data (40 GB) is only detached: it stays billed until it is deleted from Cloud Manager");
    // Read before the Linode went, while it still listed them.
    const order = fake.requests.map((entry) => `${entry.method} ${entry.path}`);
    expect(order.indexOf(`GET /linode/instances/${machine.id}/volumes`)).toBeLessThan(order.indexOf(`DELETE /linode/instances/${machine.id}`));
    expect(writes().some((entry) => entry.includes("volume"))).toBe(false);
    expect(fake.volumes).toEqual([{ ...data, linode_id: null }, other]);
  });

  test("on the legacy profile too", async () => {
    const provider = open();
    const { machine } = await provider.create(request({ location: "us-east" }), recorder().report);
    const outcome = await provider.destroy(machine, { deleteKey: false }, recorder().report);
    expect(outcome.removed).toEqual([`Linode web (${machine.ipv4}, ${machine.ipv6})`, "firewall sitesolide-web"]);
    expect(fake.firewalls).toEqual([]);
  });

  test("keeps a firewall that protects something else", async () => {
    const provider = open();
    const { machine } = await provider.create(request(), recorder().report);
    fake.addInstance({ label: "other", tags: ["production"] }, fake.firewalls[0]!.id);
    const outcome = await provider.destroy(machine, { deleteKey: false }, recorder().report);
    expect(outcome.removed).toEqual([`Linode web (${machine.ipv4}, ${machine.ipv6})`]);
    expect(outcome.kept).toEqual([expect.stringContaining("firewall sitesolide-web: still protects linode_interface")]);
    expect(fake.firewalls).toHaveLength(1);
  });

  test("never deletes a firewall sitesolide did not create for it", async () => {
    const theirs = fake.addFirewall({ label: "sitesolide-web" });
    const instance = fake.addInstance({ label: "web", tags: MANAGED });
    const machine = (await open().find("web"))!;
    const outcome = await open().destroy(machine, { deleteKey: false }, recorder().report);
    expect(writes()).toEqual([`DELETE /linode/instances/${instance.id}`]);
    expect(outcome.kept).toEqual(["firewall sitesolide-web: sitesolide did not create it for web"]);
    expect(fake.firewalls).toEqual([theirs]);
  });

  test("never deletes a Linode without sitesolide's tag, whatever it is handed", async () => {
    const instance = fake.addInstance({ label: "web", tags: ["production"] });
    const machine = (await open().find("web"))!;
    const error = await refusal(open().destroy({ ...machine, managed: true }, { deleteKey: false }, recorder().report));
    expect(error.failure.error).toBe("machine-not-managed");
    expect(writes()).toEqual([]);
    expect(fake.instances).toEqual([instance]);
  });
});

// --- the errors ---------------------------------------------------------------------------------

describe("the errors", () => {
  test("are mapped onto the codes the hints know", () => {
    const headers = new Headers();
    const at = (status: number, reason: string, field?: string, extra = headers) => failureFrom(status, { errors: [{ reason, ...(field === undefined ? {} : { field }) }] }, extra, "create the Linode web", 0).failure;
    expect(at(401, "Invalid Token").error).toBe("provider-unauthenticated");
    expect(at(401, "Your OAuth token is not authorized to use this endpoint.").error).toBe("provider-forbidden");
    expect(at(403, "Unauthorized").error).toBe("provider-forbidden");
    expect(at(404, "Not found").error).toBe("provider-not-found");
    expect(at(400, "Account Limit reached. Please open a support ticket.").error).toBe("provider-limit");
    expect(at(400, "Label must be unique among your linodes", "label").error).toBe("provider-name-taken");
    expect(at(400, "region is not valid", "region")).toMatchObject({ error: "provider-invalid", details: ["region: region is not valid"] });
    expect(at(500, "Internal Server Error").error).toBe("provider-failure");
    expect(at(429, "Too Many Requests", undefined, new Headers({ "Retry-After": "12" }))).toMatchObject({ error: "provider-rate-limited", wait: 12 });
    expect(at(429, "Too Many Requests", undefined, new Headers({ "X-RateLimit-Reset": "30", "X-RateLimit-Limit": "200" }))).toMatchObject({ wait: 30, details: ["the limit of 200 requests resets in 30 s"] });
  });

  test("through the fake: a wrong token, an answer that is not the API, an address that does not answer", async () => {
    expect((await refusal(open({ token: "0".repeat(64) }).list())).failure.error).toBe("provider-unauthenticated");
    fake.fail("GET", /^\/linode\/instances$/, 404, "", { body: "<html>not here</html>" });
    expect((await refusal(open().list())).failure.error).toBe("provider-unreadable");
    const closed = LINODE.open({
      credentials: { LINODE_TOKEN: FAKE_TOKEN },
      environment: { SITESOLIDE_LINODE_API: "http://127.0.0.1:9/v4" },
      fetcher: fetch,
      clock: fakeClock(),
      secret: () => {},
    });
    expect((await refusal(closed.list())).failure.error).toBe("provider-unreachable");
  });
});

// --- the wizard ---------------------------------------------------------------------------------

describe("the wizard's lists", () => {
  test("locations: the default first, only the regions create can use, said for a person", async () => {
    const choices = await open().locations();
    expect(choices[0]).toEqual({ value: "fr-par", label: "Paris, FR", hint: "fr-par" });
    const values = choices.map((choice) => choice.value);
    expect(values).toContain("de-fra-2");
    expect(values).toContain("us-east");
    expect(values).not.toContain("ap-south");
    expect(values).not.toContain("test-edge-1");
    expect(writes()).toEqual([]);
  });

  test("types: the default first, then the cheapest shared types with 2 GB or more", async () => {
    const choices = await open().types("fr-par");
    expect(choices[0]).toEqual({ value: "g6-standard-1", label: "g6-standard-1  1 vCPU, 2 GB RAM, 50 GB disk", hint: "12.00 USD a month before VAT" });
    expect(choices.map((choice) => choice.value)).toEqual(["g6-standard-1", "g6-standard-2", "g6-standard-4", "g6-standard-6", "g6-standard-8"]);
    expect(choices.length).toBeLessThanOrEqual(12);
    expect(writes()).toEqual([]);
  });

  test("types: a region's own prices, and nothing it cannot sell", async () => {
    expect((await open().types("br-gru"))[0]!.hint).toBe("16.80 USD a month before VAT");
    fake.settings.unavailable = [{ region: "nl-ams", plan: "g6-standard-2" }];
    expect((await open().types("nl-ams")).map((choice) => choice.value)).not.toContain("g6-standard-2");
  });
});

// --- discover -----------------------------------------------------------------------------------

function workstation(environment: Record<string, string>, files: Record<string, string>): Workstation & { read: string[] } {
  const read: string[] = [];
  return {
    environment,
    read,
    run: async () => ({ code: 127, stdout: "", stderr: "not installed" }),
    readFile: (path) => {
      read.push(path);
      return files[path] ?? null;
    },
  };
}

const CLI_TOKEN = "c11c11c11c11c11c11c11c11c11c11c11c11c11c11c11c11c11c11c11c11c11c";

describe("discover", () => {
  test("LINODE_CLI_TOKEN first, as linode-cli reads it", async () => {
    const station = workstation({ LINODE_CLI_TOKEN: CLI_TOKEN }, {});
    expect(await discover(station)).toEqual({ source: "LINODE_CLI_TOKEN, linode-cli's variable", credentials: { LINODE_TOKEN: CLI_TOKEN } });
    expect(station.read).toEqual([]);
    expect(await discover(workstation({ LINODE_CLI_TOKEN: "not a token" }, {}))).toBeNull();
  });

  test("then linode-cli's configuration: the default user's token", async () => {
    const config = `[DEFAULT]\ndefault-user = ada\n\n[bob]\ntoken = ${"b".repeat(64)}\n\n[ada]\ntoken = ${CLI_TOKEN}\nregion = fr-par\n`;
    const found = await discover(workstation({}, { "~/.config/linode-cli": config }));
    expect(found).toEqual({ source: "linode-cli's configuration, ~/.config/linode-cli", credentials: { LINODE_TOKEN: CLI_TOKEN } });
  });

  test("the older ~/.linode-cli wins, as it does for linode-cli; XDG_CONFIG_HOME and LINODE_CLI_CONFIG move the file", async () => {
    const config = `[ada]\ntoken = ${CLI_TOKEN}\n`;
    const legacy = workstation({}, { "~/.linode-cli": config, "~/.config/linode-cli": `[bob]\ntoken = ${"b".repeat(64)}\n` });
    expect((await discover(legacy))?.credentials.LINODE_TOKEN).toBe(CLI_TOKEN);
    expect(legacy.read).toEqual(["~/.linode-cli"]);
    expect((await discover(workstation({ XDG_CONFIG_HOME: "/xdg" }, { "/xdg/linode-cli": config })))?.source).toBe("linode-cli's configuration, /xdg/linode-cli");
    const custom = workstation({ LINODE_CLI_CONFIG: "/etc/linode.ini" }, { "/etc/linode.ini": config, "~/.linode-cli": `[bob]\ntoken = ${"b".repeat(64)}\n` });
    expect((await discover(custom))?.credentials.LINODE_TOKEN).toBe(CLI_TOKEN);
    expect(custom.read).toEqual(["/etc/linode.ini"]);
  });

  test("nothing, or nothing usable, is null", async () => {
    expect(await discover(workstation({}, {}))).toBeNull();
    expect(await discover(workstation({}, { "~/.config/linode-cli": "[ada]\ntoken = Bearer xyz\n" }))).toBeNull();
    expect(cliConfigToken(`[ada]\ntoken = ${CLI_TOKEN}\n[bob]\ntoken = ${"b".repeat(64)}\n`)).toBeNull();
    expect(cliConfigToken(`# a comment\n[ada]\nTOKEN: ${CLI_TOKEN}\n`)).toBe(CLI_TOKEN);
  });
});

// --- what leaves, and what is printed ---------------------------------------------------------

describe("the credentials", () => {
  test("travel in the Authorization header only, over calls that follow no redirect and give up in time", async () => {
    const provider = open();
    const { machine } = await provider.create(request(), recorder().report);
    await provider.list();
    await provider.destroy(machine, { deleteKey: false }, recorder().report);
    expect(fetches.length).toBeGreaterThan(5);
    for (const { url, init } of fetches) {
      expect(url).not.toContain(FAKE_TOKEN);
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(String(init?.body ?? "")).not.toContain(FAKE_TOKEN);
    }
    for (const entry of fake.requests) expect(`${entry.path}${entry.search}`).not.toContain(FAKE_TOKEN);
  });

  test("and never appear in a reported line or a refusal", () => {
    expect(printed.length).toBeGreaterThan(50);
    expect(handed).toEqual([]);
    const all = printed.join("\n");
    expect(all).not.toContain(FAKE_TOKEN);
    expect(all).not.toContain(CLI_TOKEN);
  });
});
