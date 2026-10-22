import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REMOTE_HINTS } from "../cli/hints";
import { ProviderError, realClock, type CreateRequest, type Machine, type Provider, type PublicKey, type Workstation } from "../cli/providers/provider";
import {
  apiKeyOfConfig,
  discover,
  failureFrom,
  fingerprintOf,
  FIREWALL_RULES,
  firewallDescription,
  imageFor,
  isKeyNameFor,
  ownsFirewall,
  priceAt,
  sameRule,
  VULTR,
  WAITS,
  type VultrPlan,
} from "../cli/providers/vultr";
import { REPO } from "./e2e/run";
import { createFake, createFakeVultr, DEBIAN_13_ID, FAKE_KEY, PLANS, SYSTEMS, type FakeFirewall, type FakeInstance, type FakeVultr } from "./fake-vultr";

/**
 * The Vultr provider, through `VULTR.open(...)`, against a local fake of the
 * Vultr API v2 (fake-vultr.ts): the real one is never called. The clock does
 * not wait: each sleep moves it forward.
 *
 * The API key must never appear in a URL, a request's body, a line the
 * provider reports or a refusal: every one of them is added to `printed`,
 * read by the last tests.
 */

/** Generated with ssh-keygen for bin/tests/cli-machine.test.ts; the private half was deleted at once. */
const ED25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICezpiOyiQWMYqOeL4S4OgE0T7Fq2bLHWUJ1afO4cczN ada@workstation.test-zone.invalid";
const KEY: PublicKey = {
  algorithm: "ssh-ed25519",
  blob: "AAAAC3NzaC1lZDI1NTE5AAAAICezpiOyiQWMYqOeL4S4OgE0T7Fq2bLHWUJ1afO4cczN",
  comment: "ada@workstation.test-zone.invalid",
  fingerprint: "a4:46:30:d5:fd:7e:1a:77:e5:ad:8d:21:4f:9a:3e:9e",
};
/** A key no test uploads: the same key under another comment proves the comment does not count. */
const SAME_KEY_OTHER_COMMENT = `${KEY.algorithm} ${KEY.blob} laptop`;

/** Another key, for the account's other machines: any ed25519 blob of the right shape. */
function otherKey(seed: number): string {
  const name = Buffer.from("ssh-ed25519");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(name.length);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(32);
  return `ssh-ed25519 ${Buffer.concat([head, name, size, Buffer.alloc(32, seed)]).toString("base64")} other-${seed}`;
}

let fake: FakeVultr;
/** Every line reported and every refusal of this file, read by the last tests. */
const printed: string[] = [];

beforeAll(() => {
  fake = createFakeVultr();
});

afterAll(() => {
  fake.stop();
});

beforeEach(() => {
  fake.reset();
});

function fakeClock() {
  let now = Date.parse("2026-10-05T10:00:00Z");
  const clock = {
    slept: 0,
    sleeps: 0,
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
      clock.slept += milliseconds;
      clock.sleeps++;
    },
  };
  return clock;
}

type Opened = { provider: Provider; lines: string[]; secrets: string[]; clock: ReturnType<typeof fakeClock>; report: (line: string) => void };

function open(options: { key?: string; api?: string; fetcher?: (input: string, init?: RequestInit) => Promise<Response> } = {}): Opened {
  const lines: string[] = [];
  const secrets: string[] = [];
  const clock = fakeClock();
  const provider = VULTR.open({
    credentials: { VULTR_API_KEY: options.key ?? FAKE_KEY },
    environment: { SITESOLIDE_VULTR_API: options.api ?? fake.url },
    fetcher: options.fetcher ?? ((input, init) => fetch(input, init)),
    clock,
    secret: (value) => secrets.push(value),
  });
  const report = (line: string) => {
    lines.push(line);
    printed.push(line);
  };
  return { provider, lines, secrets, clock, report };
}

function request(extra: Partial<CreateRequest> = {}): CreateRequest {
  return { name: "web", type: "vc2-1c-2gb", location: "fra", image: "debian-13", backups: false, key: KEY, ...extra };
}

/** The refusal a call ends with; a call that does not refuse fails the test. */
async function refusal(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    printed.push(JSON.stringify(error.failure), error.message);
    expect(REMOTE_HINTS[error.failure.error]).toBeDefined();
    return error;
  }
  throw new Error("expected a refusal");
}

/** The requests that changed something, as `METHOD /path`. */
function writes(): string[] {
  return fake.requests.filter((received) => received.method !== "GET").map((received) => `${received.method} ${received.path}`);
}

function bodyOf(method: string, path: string): unknown {
  return fake.requests.find((received) => received.method === method && received.path === path)?.body;
}

const MANAGED = (name: string) => ["managed-by:sitesolide", `sitesolide-machine:${name}`];

/** The rules of FIREWALL_RULES as the API answers them, ICMP's port written `port`. */
function withRules(firewall: FakeFirewall, icmpPort = ""): FakeFirewall {
  for (const rule of FIREWALL_RULES) {
    firewall.rules.push({
      id: firewall.nextRule++,
      type: rule.ip_type,
      ip_type: rule.ip_type,
      action: "accept",
      protocol: rule.protocol,
      port: rule.port ?? icmpPort,
      subnet: rule.subnet,
      subnet_size: 0,
      source: "",
      notes: rule.notes,
    });
  }
  return firewall;
}

/** An instance sitesolide made earlier, with its group, rules complete, and its key, as the API holds them. */
function managedMachine(name: string, extra: Partial<FakeInstance> = {}) {
  const firewall = withRules(fake.addFirewall({ description: firewallDescription(name) }));
  const key = fake.addKey({ name: `sitesolide-${name}`, ssh_key: otherKey(name.length) });
  const instance = fake.addInstance({ label: name, tags: [...MANAGED(name), `sitesolide-key:${key.id}`], firewall_group_id: firewall.id, ...extra });
  return { firewall, key, instance };
}

async function machineNamed(provider: Provider, name: string): Promise<Machine> {
  const found = await provider.find(name);
  expect(found).not.toBeNull();
  return found!;
}

// --- create --------------------------------------------------------------------------------

describe("create, on an empty account", () => {
  test("the key, the firewall group and its eight rules, then the instance: nothing else is written", async () => {
    const { provider, report } = open();
    const outcome = await provider.create(request(), report);
    const key = fake.keys[0]!;
    const firewall = fake.firewalls[0]!;
    const instance = fake.instances[0]!;

    expect(writes()).toEqual(["POST /ssh-keys", "POST /firewalls", ...FIREWALL_RULES.map(() => `POST /firewalls/${firewall.id}/rules`), "POST /instances"]);
    expect(bodyOf("POST", "/ssh-keys")).toEqual({ name: "sitesolide-web", ssh_key: ED25519 });
    expect(bodyOf("POST", "/firewalls")).toEqual({ description: "managed-by:sitesolide sitesolide-machine:web" });
    expect(bodyOf("POST", "/instances")).toEqual({
      region: "fra",
      plan: "vc2-1c-2gb",
      os_id: DEBIAN_13_ID,
      label: "web",
      hostname: "web",
      tags: ["managed-by:sitesolide", "sitesolide-machine:web", `sitesolide-key:${key.id}`],
      sshkey_id: [key.id],
      firewall_group_id: firewall.id,
      enable_ipv6: true,
      backups: "disabled",
    });
    expect(outcome.created).toBe(true);
    expect(outcome.resources).toEqual([
      { kind: "ssh key", name: "sitesolide-web", id: key.id, reused: false },
      { kind: "firewall group", name: "managed-by:sitesolide sitesolide-machine:web", id: firewall.id, reused: false },
      { kind: "instance", name: "web", id: instance.id, reused: false },
    ]);
    expect(outcome.machine).toEqual({
      provider: "vultr",
      id: instance.id,
      name: "web",
      type: "vc2-1c-2gb",
      location: "fra",
      status: "installingbooting",
      ipv4: instance.main_ip,
      ipv6: instance.v6_main_ip,
      ipv6Network: `${instance.v6_network}/64`,
      monthlyPrice: { net: "10.00", gross: "10.00", currency: "USD" },
      backups: false,
      managed: true,
      labels: { "managed-by": "sitesolide", "sitesolide-machine": "web", "sitesolide-key": key.id },
      login: "root",
    });
    expect(outcome.machine.ipv4).toMatch(/^203\.0\.113\.[0-9]+$/);
  });

  test("the rules: tcp 22, 80 and 443 and icmp, from every IPv4 and IPv6 address", () => {
    const shape = FIREWALL_RULES.map((rule) => `${rule.ip_type} ${rule.protocol} ${rule.port ?? "-"} ${rule.subnet}/${rule.subnet_size}`);
    expect(shape).toEqual([
      "v4 tcp 22 0.0.0.0/0",
      "v4 tcp 80 0.0.0.0/0",
      "v4 tcp 443 0.0.0.0/0",
      "v4 icmp - 0.0.0.0/0",
      "v6 tcp 22 ::/0",
      "v6 tcp 80 ::/0",
      "v6 tcp 443 ::/0",
      "v6 icmp - ::/0",
    ]);
  });

  test("the steps say what they do, and the root password Vultr answers with is scrubbed, never reported", async () => {
    const { provider, lines, secrets, report } = open();
    await provider.create(request(), report);
    expect(lines.filter((line) => line.startsWith("-> "))).toEqual([
      "-> an instance labelled web in the account",
      "-> vc2-1c-2gb at fra, what Vultr sells there",
      "-> SSH key",
      "-> firewall group for web",
      "-> instance web: vc2-1c-2gb at fra, Debian 13 x64 (trixie)",
      "-> web running",
    ]);
    expect(lines).toContain("   1 vCPU, 2 GB RAM, 55 GB disk, 10.00 USD a month before VAT");
    expect(lines).toContain(`   debian-13: Debian 13 x64 (trixie), os_id ${DEBIAN_13_ID}`);
    expect(lines).toContain(`   sitesolide-web, uploaded (${KEY.fingerprint})`);
    expect(lines).toContain("   status: installingbooting");
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).toStartWith("v5{");
    for (const line of lines) expect(line).not.toContain(secrets[0]!);
    // Nor the link to the instance's web console.
    expect(lines.join("\n")).not.toContain("novnc");
  });

  test("the pages of every list are followed to the end, 500 asked at a time", async () => {
    const { provider, report } = open();
    await provider.create(request(), report);
    const plans = fake.requests.filter((received) => received.path === "/plans");
    expect(plans.length).toBeGreaterThan(3);
    expect(plans[0]!.search).toBe("?type=all&per_page=500");
    expect(plans.slice(1).every((received) => /[?&]cursor=/.test(received.search))).toBe(true);
    // The default plan is the third of the list: the first page alone would not find it.
    expect(fake.instances[0]!.plan).toBe("vc2-1c-2gb");
  });

  test("a second run finds the machine and writes nothing", async () => {
    const first = open();
    await first.provider.create(request(), first.report);
    fake.requests.length = 0;
    const second = open();
    const outcome = await second.provider.create(request(), second.report);
    expect(writes()).toEqual([]);
    expect(outcome.created).toBe(false);
    expect(outcome.resources).toEqual([
      { kind: "instance", name: "web", id: fake.instances[0]!.id, reused: true },
      { kind: "firewall group", name: "managed-by:sitesolide sitesolide-machine:web", id: fake.firewalls[0]!.id, reused: true },
    ]);
    expect(second.lines).toContain("   already created by sitesolide: vc2-1c-2gb at fra, installingbooting");
    expect(second.lines).toContain(`   ${fake.firewalls[0]!.id}, attached`);
    expect(fake.instances).toHaveLength(1);
  });

  test("another type asked of an existing machine is said, and nothing changes", async () => {
    managedMachine("web");
    const { provider, lines, report } = open();
    const outcome = await provider.create(request({ type: "vc2-1c-2gb", location: "ams" }), report);
    expect(outcome.created).toBe(false);
    expect(lines).toContain("!! it is vc2-2c-4gb at fra: --type and --location only apply to a machine being created");
    expect(writes()).toEqual([]);
  });

  test("a key the account holds under any name, on any page, is reused and not claimed", async () => {
    for (let seed = 1; seed <= 5; seed++) fake.addKey({ name: `key-${seed}`, ssh_key: otherKey(seed) });
    const laptop = fake.addKey({ name: "laptop", ssh_key: SAME_KEY_OTHER_COMMENT });
    const { provider, lines, report } = open();
    await provider.create(request(), report);
    expect(writes()).not.toContain("POST /ssh-keys");
    expect(lines).toContain(`   laptop, already in the account (${KEY.fingerprint}), reused`);
    const body = bodyOf("POST", "/instances") as { sshkey_id: string[]; tags: string[] };
    expect(body.sshkey_id).toEqual([laptop.id]);
    // Not uploaded for this machine: no tag names it, and destroy never deletes it.
    expect(body.tags).toEqual(MANAGED("web"));
  });

  test("the key an earlier run uploaded for that name is reused, and still named on the instance", async () => {
    const earlier = fake.addKey({ name: "sitesolide-web", ssh_key: ED25519 });
    const { provider, report } = open();
    await provider.create(request(), report);
    expect(writes()).not.toContain("POST /ssh-keys");
    expect((bodyOf("POST", "/instances") as { tags: string[] }).tags).toContain(`sitesolide-key:${earlier.id}`);
  });

  test("a name another key already has gets the fingerprint's first eight digits", async () => {
    fake.addKey({ name: "sitesolide-web", ssh_key: otherKey(9) });
    const { provider, report } = open();
    await provider.create(request(), report);
    expect(bodyOf("POST", "/ssh-keys")).toEqual({ name: "sitesolide-web-a44630d5", ssh_key: ED25519 });
  });

  test("the group an interrupted run made is reused, and only its missing rules are added", async () => {
    const firewall = fake.addFirewall({ description: firewallDescription("web") });
    for (const rule of FIREWALL_RULES.slice(0, 3)) {
      firewall.rules.push({ id: firewall.nextRule++, type: rule.ip_type, ip_type: rule.ip_type, action: "accept", protocol: rule.protocol, port: rule.port ?? "", subnet: rule.subnet, subnet_size: 0, source: "", notes: rule.notes });
    }
    // Somebody else's group, whatever it is called, is not a candidate.
    fake.addFirewall({ description: "web" });
    const { provider, lines, report } = open();
    await provider.create(request(), report);
    expect(writes().filter((write) => write.startsWith("POST /firewalls"))).toEqual(FIREWALL_RULES.slice(3).map(() => `POST /firewalls/${firewall.id}/rules`));
    expect(lines).toContain(`   ${firewall.id}, already created by sitesolide, reused`);
    expect(lines).toContain("   5 missing rules added");
    expect((bodyOf("POST", "/instances") as { firewall_group_id: string }).firewall_group_id).toBe(firewall.id);
  });

  test("--backups orders Vultr's backups with the instance and says their schedule", async () => {
    const { provider, lines, report } = open();
    const outcome = await provider.create(request({ backups: true }), report);
    expect((bodyOf("POST", "/instances") as { backups: string }).backups).toBe("enabled");
    expect(writes()).not.toContain(`PATCH /instances/${fake.instances[0]!.id}`);
    expect(outcome.machine.backups).toBe(true);
    expect(lines).toContain("   enabled, daily at 03:00 UTC, the next on 2026-10-06 03:00:00 UTC");
  });

  test("--backups on a machine created without them enables them, once", async () => {
    const { instance } = managedMachine("web");
    const first = open();
    const outcome = await first.provider.create(request({ backups: true }), first.report);
    expect(writes()).toEqual([`PATCH /instances/${instance.id}`]);
    expect(bodyOf("PATCH", `/instances/${instance.id}`)).toEqual({ backups: "enabled" });
    expect(outcome.machine.backups).toBe(true);
    fake.requests.length = 0;
    const second = open();
    await second.provider.create(request({ backups: true }), second.report);
    expect(writes()).toEqual([]);
    expect(second.lines).toContain("   already enabled");
  });
});

// --- refusals ------------------------------------------------------------------------------

describe("what refuses, refuses before anything is written", () => {
  test("an instance of that label sitesolide did not create", async () => {
    fake.addInstance({ label: "web", tags: ["prod"] });
    const { provider, report } = open();
    const error = await refusal(provider.create(request(), report));
    expect(error.failure.error).toBe("machine-exists");
    expect(error.failure.message).toBe("an instance labelled web exists in the account, and sitesolide did not create it");
    expect(error.failure.details).toContain("it lacks the tag managed-by:sitesolide: nothing was created, nothing was changed");
    expect(writes()).toEqual([]);
  });

  test("a region Vultr does not have", async () => {
    const { provider, report } = open();
    const error = await refusal(provider.create(request({ location: "fsn1" }), report));
    expect(error.failure).toMatchObject({ error: "invalid-location", message: "fsn1 is not a Vultr region" });
    expect(error.failure.details).toContain("fra   Frankfurt, DE");
    expect(writes()).toEqual([]);
  });

  test("a plan Vultr does not sell, with the cheapest it has in stock there", async () => {
    const { provider, report } = open();
    const error = await refusal(provider.create(request({ type: "cx23" }), report));
    expect(error.failure.error).toBe("invalid-server-type");
    expect(error.failure.message).toBe("cx23 is not a Vultr plan");
    expect(error.failure.details).toEqual([
      "the cheapest plans Vultr has in stock at fra:",
      "vc2-1c-2gb       1 vCPU, 2 GB RAM, 55 GB disk, 10.00 USD a month before VAT",
      "vhf-1c-2gb       1 vCPU, 2 GB RAM, 64 GB disk, 12.00 USD a month before VAT",
      "vhp-1c-2gb-amd   1 vCPU, 2 GB RAM, 50 GB disk, 12.00 USD a month before VAT",
      "vc2-2c-4gb       2 vCPU, 4 GB RAM, 80 GB disk, 20.00 USD a month before VAT",
      "vhp-2c-4gb-amd   2 vCPU, 4 GB RAM, 100 GB disk, 24.00 USD a month before VAT",
      "vc2-4c-8gb       4 vCPU, 8 GB RAM, 160 GB disk, 40.00 USD a month before VAT",
    ]);
    expect(writes()).toEqual([]);
  });

  test("a plan not sold in that region", async () => {
    const { provider, report } = open();
    const error = await refusal(provider.create(request({ type: "vhf-1c-2gb", location: "cdg" }), report));
    expect(error.failure).toMatchObject({ error: "invalid-server-type", message: "vhf-1c-2gb is not sold at cdg" });
    expect(writes()).toEqual([]);
  });

  test("a plan sold there but out of stock right now", async () => {
    const { provider, report } = open();
    const error = await refusal(provider.create(request({ type: "vc2-2c-4gb", location: "cdg" }), report));
    expect(error.failure).toMatchObject({ error: "type-unavailable", message: "Vultr has no vc2-2c-4gb in stock at cdg right now" });
    expect(error.failure.details!.join("\n")).not.toContain("vc2-2c-4gb ");
    expect(error.failure.details).toContain("nothing had been created yet");
    expect(writes()).toEqual([]);
  });

  test("an image Vultr does not have, with the Debian ones it does", async () => {
    const { provider, report } = open();
    const error = await refusal(provider.create(request({ image: "debian-99" }), report));
    expect(error.failure).toMatchObject({ error: "provider-invalid", message: "no Vultr image matches debian-99" });
    expect(error.failure.details).toEqual([
      "--image takes debian-<release>, or an os_id Vultr lists; sitesolide setup is verified on Debian 13 only",
      "477    Debian 11 x64 (bullseye)",
      "2136   Debian 12 x64 (bookworm)",
      `${DEBIAN_13_ID}   Debian 13 x64 (trixie)`,
    ]);
    expect(writes()).toEqual([]);
  });

  test("debian-13 is Debian 13 x64, never arm64; a number is an os_id", () => {
    expect(imageFor("debian-13", SYSTEMS)?.id).toBe(DEBIAN_13_ID);
    expect(imageFor("debian-12", SYSTEMS)?.name).toBe("Debian 12 x64 (bookworm)");
    expect(imageFor("2136", SYSTEMS)?.id).toBe(2136);
    expect(imageFor("ubuntu-22", SYSTEMS)).toBeNull();
    expect(imageFor("debian-1", SYSTEMS)).toBeNull();
  });
});

describe("an order Vultr refuses", () => {
  test("a plan sold out since it was read: what this run made is deleted, and the refusal says so", async () => {
    fake.fail("POST", /^\/instances$/, 400, "Plan is not available in the selected region.");
    const { provider, report } = open();
    const error = await refusal(provider.create(request(), report));
    expect(error.failure.error).toBe("type-unavailable");
    expect(error.failure.message).toBe("Vultr would not create vc2-1c-2gb at fra (400): Plan is not available in the selected region.");
    const firewallId = (fake.requests.find((received) => received.method === "POST" && received.path.startsWith("/firewalls/"))!.path.split("/")[2])!;
    const keyId = (fake.requests.find((received) => received.method === "POST" && received.path === "/instances")!.body as { sshkey_id: string[] }).sshkey_id[0]!;
    expect(writes().slice(-3)).toEqual(["POST /instances", `DELETE /firewalls/${firewallId}`, `DELETE /ssh-keys/${keyId}`]);
    expect(error.failure.details).toContain(`deleted the firewall group ${firewallId} this run had created`);
    expect(error.failure.details).toContain("deleted the SSH key sitesolide-web this run had created");
    expect(error.failure.details).toContain("or try another --location");
    expect(error.failure.details!.join("\n")).toContain("vhp-1c-2gb-amd");
    expect(fake.keys).toEqual([]);
    expect(fake.firewalls).toEqual([]);
  });

  test("what an earlier run made, or the account held, is not undone", async () => {
    fake.addKey({ name: "laptop", ssh_key: ED25519 });
    const firewall = fake.addFirewall({ description: firewallDescription("web") });
    fake.fail("POST", /^\/instances$/, 400, "Invalid hostname.");
    const { provider, report } = open();
    const error = await refusal(provider.create(request(), report));
    expect(error.failure.error).toBe("provider-invalid");
    expect(error.failure.details).toContain("nothing had been created yet");
    expect(writes().filter((write) => write.startsWith("DELETE"))).toEqual([]);
    expect(fake.keys).toHaveLength(1);
    expect(fake.firewalls).toEqual([firewall]);
  });

  test("a deletion that fails during the undo leaves the resource for the next run", async () => {
    fake.fail("POST", /^\/instances$/, 400, "Invalid hostname.");
    fake.fail("DELETE", /^\/firewalls\/[^/]+$/, 500, "Internal server error.");
    const { provider, report } = open();
    const error = await refusal(provider.create(request(), report));
    expect(error.failure.error).toBe("provider-invalid");
    expect(error.failure.message).toBe("Vultr refused to create the instance web (400): Invalid hostname.");
    expect(error.failure.details).toContain(`left the firewall group ${fake.firewalls[0]!.id}: the next run finds it and reuses it`);
    expect(error.failure.details).toContain("deleted the SSH key sitesolide-web this run had created");
    // The next run reuses the group, rules included, and writes no rule again.
    fake.requests.length = 0;
    const next = open();
    await next.provider.create(request(), next.report);
    expect(writes()).toEqual(["POST /ssh-keys", "POST /instances"]);
  });

  test("a limit of the account is said as one, and undone the same", async () => {
    fake.fail("POST", /^\/instances$/, 400, "You have reached the maximum number of instances for your account.");
    const { provider, report } = open();
    const error = await refusal(provider.create(request(), report));
    expect(error.failure.error).toBe("provider-limit");
    expect(error.failure.details![0]).toContain("support ticket");
    expect(fake.keys).toEqual([]);
    expect(fake.firewalls).toEqual([]);
  });
});

// --- waits ---------------------------------------------------------------------------------

describe("the waits", () => {
  test("an instance that never comes up times out, bounded, without waiting for real", async () => {
    fake.settings.stuck = true;
    const { provider, clock, report } = open();
    const started = Date.now();
    const error = await refusal(provider.create(request(), report));
    expect(error.failure).toMatchObject({ error: "machine-timeout", message: "web is still not running after 10 minutes" });
    expect(clock.slept).toBeGreaterThanOrEqual(WAITS.readyMs);
    expect(clock.slept).toBeLessThan(WAITS.readyMs + 2 * WAITS.pollMs);
    const polls = fake.requests.filter((received) => received.method === "GET" && /^\/instances\/[^/]+$/.test(received.path)).length;
    expect(polls).toBe(WAITS.readyMs / WAITS.pollMs + 1);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("a failure that says later is shrugged off during the wait, once warned", async () => {
    fake.fail("GET", /^\/instances\/[^/]+$/, 503, "Service unavailable.", { times: 2 });
    const { provider, lines, report } = open();
    const outcome = await provider.create(request(), report);
    expect(outcome.created).toBe(true);
    expect(lines.filter((line) => line.startsWith("!! "))).toEqual(["!! Vultr failed to read the instance web (503): Service unavailable.: still waiting"]);
  });

  test("a failure that says no ends the wait at once", async () => {
    fake.fail("GET", /^\/instances\/[^/]+$/, 404, "Instance not found.");
    const { provider, clock, report } = open();
    const error = await refusal(provider.create(request(), report));
    expect(error.failure.error).toBe("provider-not-found");
    expect(clock.sleeps).toBe(0);
  });

  test("a machine sitesolide created but stopped is said, never started", async () => {
    managedMachine("web", { power_status: "stopped" });
    const { provider, report } = open();
    const error = await refusal(provider.create(request(), report));
    expect(error.failure).toMatchObject({ error: "machine-off", message: "web exists but is stopped" });
    expect(writes()).toEqual([]);
  });

  test("a suspended instance is said, not waited for", async () => {
    managedMachine("web", { status: "suspended" });
    const { provider, clock, report } = open();
    const error = await refusal(provider.create(request(), report));
    expect(error.failure).toMatchObject({ error: "action-failed", message: "Vultr suspended the instance web" });
    expect(clock.sleeps).toBe(0);
  });
});

// --- list and find -------------------------------------------------------------------------

describe("list and find", () => {
  test("list shows the instances sitesolide created, on every page, and nothing else", async () => {
    for (let index = 0; index < 3; index++) fake.addInstance({ label: `other-${index}`, tags: index === 0 ? [] : ["managed-by:someone-else"] });
    managedMachine("web");
    fake.addInstance({ label: "db", plan: "vhp-1c-2gb-amd", tags: MANAGED("db"), features: ["ipv6", "auto_backups"] });
    const { provider } = open();
    const machines = await provider.list();
    expect(machines.map((machine) => [machine.name, machine.type, machine.status, machine.monthlyPrice?.net, machine.backups])).toEqual([
      ["web", "vc2-2c-4gb", "running", "20.00", false],
      ["db", "vhp-1c-2gb-amd", "running", "12.00", true],
    ]);
    expect(machines.every((machine) => machine.managed && machine.login === "root")).toBe(true);
    expect(fake.requests.filter((received) => received.path === "/instances").length).toBe(3);
    expect(writes()).toEqual([]);
  });

  test("find says whose a machine is, and null when the account has none of that label", async () => {
    fake.addInstance({ label: "legacy" });
    managedMachine("web");
    const { provider } = open();
    expect((await provider.find("legacy"))?.managed).toBe(false);
    expect((await provider.find("web"))?.managed).toBe(true);
    expect(await provider.find("absent")).toBeNull();
  });

  test("the limited user scheme logs in as linuxuser", async () => {
    managedMachine("web", { user_scheme: "limited" });
    const { provider } = open();
    expect((await machineNamed(provider, "web")).login).toBe("linuxuser");
  });
});

// --- destroy -------------------------------------------------------------------------------

describe("destroy", () => {
  test("the instance, then its firewall group; the key stays without --delete-key", async () => {
    const made = open();
    await made.provider.create(request(), made.report);
    const instance = fake.instances[0]!;
    const firewall = fake.firewalls[0]!;
    const key = fake.keys[0]!;
    fake.requests.length = 0;
    const { provider, lines, report } = open();
    const machine = await machineNamed(provider, "web");
    const outcome = await provider.destroy(machine, { deleteKey: false }, report);
    expect(writes()).toEqual([`DELETE /instances/${instance.id}`, `DELETE /firewalls/${firewall.id}`]);
    expect(outcome.removed).toEqual([`instance web (${instance.main_ip}, ${instance.v6_main_ip})`, `firewall group ${firewall.id}`]);
    expect(outcome.kept).toEqual(["SSH key sitesolide-web: other machines may be created with it; --delete-key deletes it"]);
    expect(fake.keys).toEqual([key]);
    expect(lines).toContain("   deleted, with its disk");
  });

  test("the backups Vultr keeps a week after the instance are said", async () => {
    managedMachine("web", { features: ["ipv6", "auto_backups"] });
    const { provider, report } = open();
    const outcome = await provider.destroy(await machineNamed(provider, "web"), { deleteKey: false }, report);
    expect(outcome.kept[0]).toBe("the instance's two latest Vultr backups: Vultr purges them seven days after the deletion; convert one to a snapshot in the console to keep it");
  });

  test("--delete-key deletes the key uploaded for that machine, and no other", async () => {
    const laptop = fake.addKey({ name: "laptop", ssh_key: otherKey(3) });
    const made = open();
    await made.provider.create(request(), made.report);
    const uploaded = fake.keys.find((key) => key.name === "sitesolide-web")!;
    const { provider, report } = open();
    const outcome = await provider.destroy(await machineNamed(provider, "web"), { deleteKey: true }, report);
    expect(writes()).toContain(`DELETE /ssh-keys/${uploaded.id}`);
    expect(outcome.removed).toContain("SSH key sitesolide-web");
    expect(fake.keys).toEqual([laptop]);
  });

  test("a key the account already held is never deleted, --delete-key or not", async () => {
    fake.addKey({ name: "laptop", ssh_key: ED25519 });
    const made = open();
    await made.provider.create(request(), made.report);
    const { provider, lines, report } = open();
    await provider.destroy(await machineNamed(provider, "web"), { deleteKey: true }, report);
    expect(writes().filter((write) => write.startsWith("DELETE /ssh-keys"))).toEqual([]);
    expect(lines).toContain("   none was uploaded for web: the key it used was already in the account");
    expect(fake.keys).toHaveLength(1);
  });

  test("a key renamed since it was uploaded is somebody's now, and kept", async () => {
    const { key } = managedMachine("web");
    key.name = "my-laptop";
    const { provider, report } = open();
    const outcome = await provider.destroy(await machineNamed(provider, "web"), { deleteKey: true }, report);
    expect(outcome.kept).toEqual(["SSH key my-laptop: not named as sitesolide names the keys it uploads, so never deleted by it"]);
    expect(fake.keys).toEqual([key]);
  });

  test("a group still applied to another instance is kept, after a bounded wait", async () => {
    const { firewall } = managedMachine("web");
    fake.addInstance({ label: "db", tags: MANAGED("db"), firewall_group_id: firewall.id });
    const { provider, clock, report } = open();
    const outcome = await provider.destroy(await machineNamed(provider, "web"), { deleteKey: false }, report);
    expect(outcome.kept).toContain(`firewall group ${firewall.id}: still applied to 1 instance`);
    expect(writes().filter((write) => write.startsWith("DELETE /firewalls"))).toEqual([]);
    expect(clock.sleeps).toBe(WAITS.firewallTries - 1);
  });

  test("a group that still counts the deleted instance for a moment is deleted once it stops", async () => {
    const { firewall } = managedMachine("web");
    fake.settings.firewallLag = 2;
    const { provider, report } = open();
    const outcome = await provider.destroy(await machineNamed(provider, "web"), { deleteKey: false }, report);
    expect(outcome.removed).toContain(`firewall group ${firewall.id}`);
    expect(fake.firewalls).toEqual([]);
  });

  test("a group sitesolide did not make is never touched, even applied to its instance", async () => {
    const office = fake.addFirewall({ description: "office" });
    const lookalike = fake.addFirewall({ description: "sitesolide-machine:web" });
    const instance = fake.addInstance({ label: "web", tags: MANAGED("web"), firewall_group_id: office.id });
    const { provider, report } = open();
    const outcome = await provider.destroy(await machineNamed(provider, "web"), { deleteKey: true }, report);
    expect(outcome.kept).toEqual([`firewall group ${office.id} (office): sitesolide did not create it`]);
    expect(fake.firewalls).toEqual([office, lookalike]);
    expect(writes()).toEqual([`DELETE /instances/${instance.id}`]);
  });

  test("an instance without the tag is refused, and nothing is deleted", async () => {
    const instance = fake.addInstance({ label: "web" });
    const { provider, report } = open();
    const pretended: Machine = { ...(await machineNamed(provider, "web")), managed: true };
    const error = await refusal(provider.destroy(pretended, { deleteKey: true }, report));
    expect(error.failure.error).toBe("machine-not-managed");
    expect(writes()).toEqual([]);
    expect(fake.instances).toEqual([instance]);
  });

  test("an instance still being created is waited for before it is deleted", async () => {
    managedMachine("web", { status: "pending", server_status: "none", main_ip: "0.0.0.0" });
    const { provider, clock, report } = open();
    const machine = await machineNamed(provider, "web");
    const outcome = await provider.destroy(machine, { deleteKey: false }, report);
    expect(clock.sleeps).toBeGreaterThan(0);
    // Still without its IPv4 when it was found, it is said by the address it had.
    expect(machine.ipv4).toBeNull();
    expect(outcome.removed[0]).toBe(`instance web (${machine.ipv6})`);
    expect(fake.instances).toEqual([]);
  });
});

// --- errors --------------------------------------------------------------------------------

describe("what the API answers, as the CLI says it", () => {
  test("a key Vultr does not know", async () => {
    const wrong = "WRONGVULTRKEY0123456789ABCDEFGHIJKLM";
    const { provider } = open({ key: wrong });
    const error = await refusal(provider.list());
    expect(error.failure.error).toBe("provider-unauthenticated");
    expect(error.failure.message).toBe("Vultr refused the API key (401): Invalid API token.");
    expect(error.failure.details![0]).toContain("also when its access control list does not allow this workstation's address");
    expect(JSON.stringify(error.failure)).not.toContain(wrong);
  });

  test("an address the key's access control list does not allow has a detail of its own", async () => {
    fake.settings.refuseAddress = true;
    const { provider } = open();
    const error = await refusal(provider.list());
    expect(error.failure.error).toBe("provider-unauthenticated");
    expect(error.failure.details).toEqual([
      "the key's access control list does not allow this workstation's address: add it, or its network, to the list",
      "the list is the user's API Access in the organization (Manage Organization, Users), or Account, API for the account's own key",
    ]);
  });

  test("a permission the key's user lacks", async () => {
    fake.fail("POST", /^\/ssh-keys$/, 403, "Unauthorized action.");
    const { provider, report } = open();
    const error = await refusal(provider.create(request(), report));
    expect(error.failure.error).toBe("provider-forbidden");
    expect(error.failure.message).toBe("the API key may not upload the SSH key sitesolide-web (403): Unauthorized action.");
    expect(error.failure.details![0]).toContain("compute instance and SSH key actions and the network firewall actions");
  });

  test("429: a short wait, from Retry-After when the API gives one", async () => {
    fake.fail("GET", /^\/instances$/, 429, "Rate limit exceeded.", { headers: { "Retry-After": "3" } });
    const first = await refusal(open().provider.list());
    expect(first.failure).toMatchObject({ error: "provider-rate-limited", wait: 3 });
    fake.fail("GET", /^\/instances$/, 429, "Rate limit exceeded.");
    const second = await refusal(open().provider.list());
    expect(second.failure.wait).toBe(2);
  });

  test("a failure on Vultr's side, and an answer that is not its API", async () => {
    fake.fail("GET", /^\/instances$/, 500, "Internal server error.");
    expect((await refusal(open().provider.list())).failure).toMatchObject({ error: "provider-failure", message: "Vultr failed to read the instances (500): Internal server error." });
    fake.fail("GET", /^\/instances$/, 200, "", { raw: "<html>captive portal</html>" });
    expect((await refusal(open().provider.list())).failure.error).toBe("provider-unreadable");
    fake.fail("GET", /^\/instances$/, 502, "", { raw: "<html>bad gateway</html>" });
    expect((await refusal(open().provider.list())).failure.error).toBe("provider-failure");
  });

  test("an API that does not answer", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const address = `http://127.0.0.1:${closed.port}/v2`;
    closed.stop(true);
    const error = await refusal(open({ api: address }).provider.list());
    expect(error.failure.error).toBe("provider-unreachable");
  });

  test("the API's address: https, or http on the loopback, and nothing but an address", () => {
    for (const api of ["http://api.test-zone.invalid/v2", "https://user:secret@api.test-zone.invalid/v2", "https://api.test-zone.invalid/v2?x=1", "not an address"]) {
      expect(() => open({ api })).toThrow(ProviderError);
      try {
        open({ api });
      } catch (error) {
        expect((error as ProviderError).failure.error).toBe("provider-endpoint");
      }
    }
    expect(() => open({ api: "https://api.test-zone.invalid/v2" })).not.toThrow();
  });

  test("an error answer without Vultr's shape still says its status", () => {
    const failure = failureFrom(418, "teapot", new Headers(), "read the instances");
    expect(failure.failure).toMatchObject({ error: "provider-invalid", message: "Vultr refused to read the instances (418): answered 418" });
    expect(failureFrom(404, { error: "Not found", status: 404 }, new Headers(), "read the instance web").failure.error).toBe("provider-not-found");
  });
});

// --- credentials ---------------------------------------------------------------------------

describe("the credentials", () => {
  test("the key travels in the Authorization header and nowhere else", async () => {
    const made = open();
    await made.provider.create(request({ backups: true }), made.report);
    const { provider, report } = open();
    await provider.list();
    await provider.locations();
    await provider.types("fra");
    await provider.destroy(await machineNamed(provider, "web"), { deleteKey: true }, report);
    expect(fake.requests.length).toBeGreaterThan(30);
    for (const received of fake.requests) {
      expect(received.authorization).toBe(`Bearer ${FAKE_KEY}`);
      expect(received.url).not.toContain(FAKE_KEY);
      expect(JSON.stringify(received.body)).not.toContain(FAKE_KEY);
    }
  });

  test("the entry: VULTR_API_KEY, a secret of Vultr's shape, and the defaults", () => {
    expect(VULTR.name).toBe("vultr");
    expect(VULTR.apiVariable).toBe("SITESOLIDE_VULTR_API");
    expect(VULTR.credentials).toHaveLength(1);
    const [field] = VULTR.credentials;
    expect(field).toMatchObject({ variable: "VULTR_API_KEY", secret: true });
    expect(field!.shape.test(FAKE_KEY)).toBe(true);
    for (const wrong of [`"${FAKE_KEY}"`, `${FAKE_KEY} `, `Bearer ${FAKE_KEY}`, "short"]) expect(field!.shape.test(wrong)).toBe(false);
    expect(VULTR.defaults({})).toEqual({ type: "vc2-1c-2gb", location: "fra", image: "debian-13" });
    expect(VULTR.backups).toBe(true);
    expect(existsSync(join(REPO, VULTR.docs))).toBe(true);
  });

  test("the fake every provider's tests share carries the key as a secret, and never makes the real clock wait", async () => {
    const shared = createFake();
    try {
      expect(shared.secrets).toEqual([FAKE_KEY]);
      expect(shared.environment.VULTR_API_KEY).toBe(FAKE_KEY);
      expect(shared.environment.SITESOLIDE_VULTR_API).toStartWith("http://127.0.0.1:");
      let slept = 0;
      const provider = VULTR.open({
        credentials: { VULTR_API_KEY: shared.environment.VULTR_API_KEY! },
        environment: shared.environment,
        fetcher: (input, init) => fetch(input, init),
        clock: { now: realClock.now, sleep: async (milliseconds) => void (slept += milliseconds) },
        secret: () => {},
      });
      const outcome = await provider.create(request(), () => {});
      expect((await provider.list()).map((machine) => machine.name)).toEqual(["web"]);
      await provider.destroy(outcome.machine, { deleteKey: true }, () => {});
      expect(await provider.list()).toEqual([]);
      expect(slept).toBe(0);
      expect(shared.requests.length).toBeGreaterThan(10);
      shared.reset();
      expect(shared.requests).toEqual([]);
    } finally {
      shared.stop();
    }
  });
});

describe("discover: the key vultr-cli is configured with", () => {
  function workstation(files: Record<string, string>, environment: Record<string, string> = {}): Workstation & { ran: string[][] } {
    const ran: string[][] = [];
    return {
      ran,
      environment,
      run: async (argv) => {
        ran.push(argv);
        return { code: 127, stdout: "", stderr: "" };
      },
      readFile: (path) => files[path] ?? null,
    };
  }

  test("~/.vultr-cli.yaml, where vultr-cli keeps it when the configuration folder has none", async () => {
    const station = workstation({ "~/.vultr-cli.yaml": `api-key: ${FAKE_KEY}\n` });
    expect(await discover(station)).toEqual({ source: "vultr-cli's configuration, ~/.vultr-cli.yaml", credentials: { VULTR_API_KEY: FAKE_KEY } });
    expect(station.ran).toEqual([]);
  });

  test("the configuration folder first, as vultr-cli reads it: $XDG_CONFIG_HOME, ~/.config, then macOS's", async () => {
    const other = "OTHERVULTRKEY0123456789ABCDEFGHIJKLM";
    const files = { "~/.vultr-cli.yaml": `api-key: ${other}\n`, "~/Library/Application Support/vultr-cli.yaml": `api-key: '${FAKE_KEY}'\n` };
    expect((await discover(workstation(files)))?.source).toBe("vultr-cli's configuration, ~/Library/Application Support/vultr-cli.yaml");
    const xdg = workstation({ ...files, "/home/ada/.cfg/vultr-cli.yaml": `# mine\napi-key: "${FAKE_KEY}"  # the deploy key\n` }, { XDG_CONFIG_HOME: "/home/ada/.cfg" });
    expect(await discover(xdg)).toEqual({ source: "vultr-cli's configuration, /home/ada/.cfg/vultr-cli.yaml", credentials: { VULTR_API_KEY: FAKE_KEY } });
  });

  test("nothing, or nothing shaped like a key, is no discovery", async () => {
    expect(await discover(workstation({}))).toBeNull();
    expect(await discover(workstation({ "~/.vultr-cli.yaml": "api-key:\n" }))).toBeNull();
    expect(await discover(workstation({ "~/.vultr-cli.yaml": "api-key: not a key\n" }))).toBeNull();
    expect(apiKeyOfConfig(`profiles:\n  api-key: ${FAKE_KEY}\n`)).toBeNull();
  });
});

// --- the wizard ----------------------------------------------------------------------------

describe("what the wizard offers", () => {
  test("the regions, Frankfurt first, said for a person", async () => {
    const { provider } = open();
    const choices = await provider.locations();
    expect(choices[0]).toEqual({ value: "fra", label: "Frankfurt, DE", hint: "fra" });
    expect(choices.map((choice) => choice.value)).toEqual(["fra", "ams", "cdg", "ewr", "lhr", "nrt"]);
    expect(writes()).toEqual([]);
  });

  test("the plans in stock there, the default first, then the cheapest; no GPU, nothing under 2 GB, nothing IPv6 only", async () => {
    const { provider } = open();
    const fra = await provider.types("fra");
    expect(fra[0]).toEqual({ value: "vc2-1c-2gb", label: "vc2-1c-2gb  1 vCPU, 2 GB RAM, 55 GB disk", hint: "10.00 USD a month before VAT" });
    expect(fra.map((choice) => choice.value)).toEqual(["vc2-1c-2gb", "vhf-1c-2gb", "vhp-1c-2gb-amd", "vc2-2c-4gb", "vhp-2c-4gb-amd", "vc2-4c-8gb", "voc-g-2c-8gb-50s-amd"]);
    expect(fra.length).toBeLessThanOrEqual(12);
    const cdg = (await provider.types("cdg")).map((choice) => choice.value);
    expect(cdg).not.toContain("vc2-2c-4gb");
    expect(cdg).not.toContain("vhf-1c-2gb");
    expect(writes()).toEqual([]);
  });
});

// --- the pieces ----------------------------------------------------------------------------

describe("the marks Vultr has room for", () => {
  test("a firewall group is sitesolide's for a machine when its description says both tags", () => {
    expect(firewallDescription("web")).toBe("managed-by:sitesolide sitesolide-machine:web");
    expect(ownsFirewall({ id: "1", description: "managed-by:sitesolide sitesolide-machine:web", instance_count: 0 }, "web")).toBe(true);
    expect(ownsFirewall({ id: "1", description: "managed-by:sitesolide sitesolide-machine:web", instance_count: 0 }, "db")).toBe(false);
    expect(ownsFirewall({ id: "1", description: "sitesolide-machine:web", instance_count: 0 }, "web")).toBe(false);
    expect(ownsFirewall({ id: "1", description: "web", instance_count: 0 }, "web")).toBe(false);
  });

  test("a key is sitesolide's for a machine by the names it gives, the suffix being its own fingerprint's", () => {
    expect(fingerprintOf(ED25519)).toBe(KEY.fingerprint);
    expect(fingerprintOf("ssh-ed25519 not*base64")).toBe("");
    expect(isKeyNameFor("sitesolide-web", "web", KEY.fingerprint)).toBe(true);
    expect(isKeyNameFor("sitesolide-web-a44630d5", "web", KEY.fingerprint)).toBe(true);
    expect(isKeyNameFor("sitesolide-web-deadbeef", "web", KEY.fingerprint)).toBe(false);
    expect(isKeyNameFor("sitesolide-web-a44630d5", "web", "")).toBe(false);
    expect(isKeyNameFor("sitesolide-web-db", "web", KEY.fingerprint)).toBe(false);
    expect(isKeyNameFor("sitesolide-webapp", "web", KEY.fingerprint)).toBe(false);
    expect(isKeyNameFor("laptop", "web", KEY.fingerprint)).toBe(false);
  });
});

// --- an order without a clear answer --------------------------------------------------------

describe("an order whose outcome is unknown", () => {
  test("a 5xx after Vultr made the instance: nothing is undone, and the next run finds it behind its group", async () => {
    fake.fail("POST", /^\/instances$/, 502, "Bad gateway.", { after: true });
    const { provider, lines, report } = open();
    const error = await refusal(provider.create(request(), report));
    expect(error.failure.error).toBe("provider-failure");
    expect(error.failure.details).toContain("the order's outcome is unknown: Vultr may have created the instance, so nothing this run created was undone");
    expect(lines).toContain("!! the order's outcome is unknown: nothing this run created is undone");
    expect(writes().filter((write) => write.startsWith("DELETE"))).toEqual([]);
    expect(fake.instances).toHaveLength(1);
    expect(fake.instances[0]!.firewall_group_id).toBe(fake.firewalls[0]!.id);
    fake.requests.length = 0;
    const next = open();
    const outcome = await next.provider.create(request(), next.report);
    expect(outcome.created).toBe(false);
    expect(writes()).toEqual([]);
  });

  test("a 429, an answer lost on the way back, or one without the instance undo nothing either", async () => {
    fake.fail("POST", /^\/instances$/, 429, "Rate limit exceeded.");
    const limited = await refusal(open().provider.create(request(), () => {}));
    expect(limited.failure.error).toBe("provider-rate-limited");
    expect(fake.keys).toHaveLength(1);
    expect(fake.firewalls).toHaveLength(1);

    fake.reset();
    const lost = open({
      fetcher: async (input, init) => {
        const answer = await fetch(input, init);
        if (init?.method === "POST" && new URL(input).pathname.endsWith("/instances")) throw new Error("the connection was reset");
        return answer;
      },
    });
    const reset = await refusal(lost.provider.create(request(), lost.report));
    expect(reset.failure.error).toBe("provider-unreachable");
    expect(writes().filter((write) => write.startsWith("DELETE"))).toEqual([]);
    expect(fake.instances).toHaveLength(1);

    fake.reset();
    fake.fail("POST", /^\/instances$/, 202, "", { after: true, raw: "{}" });
    const empty = await refusal(open().provider.create(request(), () => {}));
    expect(empty.failure.error).toBe("provider-unreadable");
    expect(writes().filter((write) => write.startsWith("DELETE"))).toEqual([]);
  });

  test("Vultr detaches the instances of a group it deletes, as the fake does", async () => {
    const { firewall, instance } = managedMachine("web");
    const answer = await fetch(`${fake.url}/firewalls/${firewall.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${FAKE_KEY}` } });
    expect(answer.status).toBe(204);
    expect(instance.firewall_group_id).toBe("");
  });
});

describe("a machine found already created is behind its firewall group", () => {
  test("none attached: one is made, with its rules, and attached", async () => {
    fake.addInstance({ label: "web", tags: MANAGED("web") });
    const { provider, lines, report } = open();
    const outcome = await provider.create(request(), report);
    const firewall = fake.firewalls[0]!;
    const instance = fake.instances[0]!;
    expect(writes()).toEqual(["POST /firewalls", ...FIREWALL_RULES.map(() => `POST /firewalls/${firewall.id}/rules`), `PATCH /instances/${instance.id}`]);
    expect(bodyOf("PATCH", `/instances/${instance.id}`)).toEqual({ firewall_group_id: firewall.id });
    expect(instance.firewall_group_id).toBe(firewall.id);
    expect(lines).toContain("!! web has no firewall group: every port of it is open");
    expect(lines).toContain(`   ${firewall.id}, attached to web`);
    expect(outcome.created).toBe(false);
    expect(outcome.resources.at(-1)).toEqual({ kind: "firewall group", name: firewallDescription("web"), id: firewall.id, reused: false });
  });

  test("the group an earlier run left is reused and attached", async () => {
    const left = withRules(fake.addFirewall({ description: firewallDescription("web") }));
    const instance = fake.addInstance({ label: "web", tags: MANAGED("web") });
    const { provider, report } = open();
    await provider.create(request(), report);
    expect(writes()).toEqual([`PATCH /instances/${instance.id}`]);
    expect(instance.firewall_group_id).toBe(left.id);
  });

  test("its own group's missing rules are added; a group sitesolide did not make stays as it is", async () => {
    const { firewall } = managedMachine("web");
    firewall.rules.splice(0, 2);
    const first = open();
    await first.provider.create(request(), first.report);
    expect(writes()).toEqual([`POST /firewalls/${firewall.id}/rules`, `POST /firewalls/${firewall.id}/rules`]);
    expect(first.lines).toContain(`   ${firewall.id}, attached, 2 missing rules added`);

    fake.reset();
    const office = fake.addFirewall({ description: "office" });
    fake.addInstance({ label: "web", tags: MANAGED("web"), firewall_group_id: office.id });
    const second = open();
    await second.provider.create(request(), second.report);
    expect(writes()).toEqual([]);
    expect(second.lines).toContain(`!! web is behind the firewall group ${office.id}, which sitesolide did not make: left as it is`);
  });
});

describe("the SSH key's name", () => {
  test("a suffix that is not the key's own fingerprint does not make it sitesolide's", async () => {
    const theirs = fake.addKey({ name: "sitesolide-web-deadbeef", ssh_key: ED25519 });
    const { provider, report } = open();
    await provider.create(request(), report);
    const body = bodyOf("POST", "/instances") as { sshkey_id: string[]; tags: string[] };
    expect(body.sshkey_id).toEqual([theirs.id]);
    expect(body.tags).toEqual(MANAGED("web"));
  });

  test("the one its own fingerprint suffixes is reused and named on the instance", async () => {
    const earlier = fake.addKey({ name: "sitesolide-web-a44630d5", ssh_key: ED25519 });
    const { provider, report } = open();
    await provider.create(request(), report);
    expect((bodyOf("POST", "/instances") as { tags: string[] }).tags).toContain(`sitesolide-key:${earlier.id}`);
  });

  test("destroy deletes a tagged key only when its suffix is its own fingerprint's", async () => {
    const { key } = managedMachine("web");
    key.name = "sitesolide-web-deadbeef";
    const refused = open();
    const kept = await refused.provider.destroy(await machineNamed(refused.provider, "web"), { deleteKey: true }, refused.report);
    expect(kept.kept).toContain("SSH key sitesolide-web-deadbeef: not named as sitesolide names the keys it uploads, so never deleted by it");
    expect(fake.keys).toEqual([key]);

    fake.reset();
    const again = managedMachine("db");
    again.key.name = `sitesolide-db-${fingerprintOf(again.key.ssh_key).replaceAll(":", "").slice(0, 8)}`;
    const { provider, report } = open();
    const outcome = await provider.destroy(await machineNamed(provider, "db"), { deleteKey: true }, report);
    expect(outcome.removed).toContain(`SSH key ${again.key.name}`);
    expect(fake.keys).toEqual([]);
  });
});

describe("what outlives the instance", () => {
  test("its block storage and reserved IPs are said, kept, and never deleted", async () => {
    const { instance } = managedMachine("web");
    fake.addBlock({ label: "data", size_gb: 40, region: "fra", attached_to_instance: instance.id });
    fake.addBlock({ label: "elsewhere", attached_to_instance: "another-instance" });
    fake.addReservedIp({ subnet: "198.51.100.7", subnet_size: 32, label: "front", instance_id: instance.id });
    fake.addReservedIp({ ip_type: "v6", subnet: "2001:db8:99::", subnet_size: 64, instance_id: instance.id });
    const { provider, lines, report } = open();
    const outcome = await provider.destroy(await machineNamed(provider, "web"), { deleteKey: false }, report);
    expect(outcome.kept.slice(0, 3)).toEqual([
      "block storage data (40 GB at fra): detached from web, billed until it is deleted from the console",
      "reserved IP 198.51.100.7 (front): detached from web, billed until it is deleted from the console",
      "reserved IP 2001:db8:99::/64: detached from web, billed until it is deleted from the console",
    ]);
    expect(lines).toContain("!! block storage data (40 GB at fra): detached from web, billed until it is deleted from the console");
    expect(writes().filter((write) => /blocks|reserved-ips/.test(write))).toEqual([]);
    expect(fake.blocks).toHaveLength(2);
    expect(fake.reservedIps).toHaveLength(2);
  });

  test("a list the key may not read is said, and the destroy goes on", async () => {
    managedMachine("web");
    fake.fail("GET", /^\/blocks$/, 403, "Unauthorized action.");
    const { provider, lines, report } = open();
    const outcome = await provider.destroy(await machineNamed(provider, "web"), { deleteKey: false }, report);
    expect(lines.some((line) => line.startsWith("!! could not check for block storage attached to web (the API key may not read the block storage (403)"))).toBe(true);
    expect(outcome.removed[0]).toStartWith("instance web");
    expect(fake.instances).toEqual([]);
  });
});

describe("prices, the region's", () => {
  test("location_cost wins where Vultr gives one, monthly_cost elsewhere", () => {
    const plan = PLANS.find((candidate) => candidate.id === "vc2-1c-2gb") as VultrPlan;
    expect(priceAt(plan, "fra")).toBe(10);
    expect(priceAt(plan, "nrt")).toBe(15);
    expect(priceAt({ ...plan, location_cost: { nrt: { monthly_cost: "15" } } }, "nrt")).toBe(10);
  });

  test("create, list, the wizard and a refusal all show and sort by the region's price", async () => {
    const { provider, lines, report } = open();
    const outcome = await provider.create(request({ location: "nrt" }), report);
    expect(lines).toContain("   1 vCPU, 2 GB RAM, 55 GB disk, 15.00 USD a month before VAT");
    expect(outcome.machine.monthlyPrice?.net).toBe("15.00");
    expect((await provider.list())[0]!.monthlyPrice?.net).toBe("15.00");
    const nrt = await provider.types("nrt");
    expect(nrt.map((choice) => choice.value)).toEqual(["vc2-1c-2gb", "vhp-1c-2gb-amd", "vhp-2c-4gb-amd", "vc2-2c-4gb", "vc2-4c-8gb"]);
    expect(nrt[0]!.hint).toBe("15.00 USD a month before VAT");
    const error = await refusal(provider.create(request({ name: "db", type: "cx23", location: "nrt" }), report));
    expect(error.failure.details!.slice(1, 3)).toEqual([
      "vhp-1c-2gb-amd   1 vCPU, 2 GB RAM, 50 GB disk, 12.00 USD a month before VAT",
      "vc2-1c-2gb       1 vCPU, 2 GB RAM, 55 GB disk, 15.00 USD a month before VAT",
    ]);
  });
});

describe("the rules a group already has", () => {
  test("ICMP answered with port 0, an empty port or none is the same rule, and a re-run adds nothing", async () => {
    const firewall = withRules(fake.addFirewall({ description: firewallDescription("web") }), "0");
    const { provider, report } = open();
    await provider.create(request(), report);
    expect(writes().filter((write) => write.startsWith("POST /firewalls"))).toEqual([]);
    expect(firewall.rules).toHaveLength(FIREWALL_RULES.length);
    const icmp = FIREWALL_RULES.find((rule) => rule.protocol === "icmp")!;
    for (const port of [undefined, "", "0"]) expect(sameRule({ id: 1, ip_type: "v4", protocol: "ICMP", port, subnet: "0.0.0.0", subnet_size: 0 }, icmp)).toBe(true);
    const ssh = FIREWALL_RULES[0]!;
    expect(sameRule({ id: 1, ip_type: "v4", protocol: "tcp", port: "0", subnet: "0.0.0.0", subnet_size: 0 }, ssh)).toBe(false);
  });
});

describe("what was printed", () => {
  test("never the API key", () => {
    expect(printed.length).toBeGreaterThan(50);
    for (const line of printed) expect(line).not.toContain(FAKE_KEY);
  });
});
