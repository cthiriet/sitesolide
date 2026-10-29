import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createFakeHetzner, FAKE_ROOT_PASSWORD, FAKE_TOKEN, type FakeHetzner } from "../fakes/hetzner";
import { firewallName, firewallRules, HETZNER, holdsRules, USER_DATA_BYTES } from "../src/hetzner";
import {
  describeInbound,
  FAILURE_CODES,
  ownerNamed,
  ProviderError,
  WEB_SERVER,
  type CreateRequest,
  type Failure,
  type Inbound,
  type Owner,
  type Provider,
  type ProviderContext,
  type PublicKey,
} from "../src/provider";

/**
 * src/hetzner.ts, through HETZNER.open, against the local fake of the API
 * (fakes/hetzner.ts): the real one is never called. sitesolide's command
 * around it, with a key and WEB_SERVER, is covered by its own
 * bin/tests/cli-machine.test.ts; this file covers what another owner asks,
 * devbox above all: no key, its own rules, a user-data.
 *
 * Whatever the path, neither the token nor the root password Hetzner answers
 * for a keyless server may appear in what the provider says: every report
 * line and every refusal of this file is added to `printed`, read at the end.
 */

/** Generated for these tests with ssh-keygen; the private half was deleted at once. */
const KEY: PublicKey = {
  algorithm: "ssh-ed25519",
  blob: "AAAAC3NzaC1lZDI1NTE5AAAAICezpiOyiQWMYqOeL4S4OgE0T7Fq2bLHWUJ1afO4cczN",
  comment: "ada@workstation.test-zone.invalid",
  fingerprint: "a4:46:30:d5:fd:7e:1a:77:e5:ad:8d:21:4f:9a:3e:9e",
};

const DEVBOX = ownerNamed("devbox");
const SITESOLIDE = ownerNamed("sitesolide");

/** SSH from two networks of the documentation ranges, ping from everywhere: what devbox asks. */
const SSH_ONLY: Inbound[] = [
  { protocol: "tcp", port: 22, sources: ["198.51.100.0/24", "2001:db8:ffff::/48"], description: "ssh" },
  { protocol: "icmp", sources: ["0.0.0.0/0", "::/0"], description: "ping" },
];

const USER_DATA = "#cloud-config\nusers:\n  - name: dev\n    ssh_authorized_keys:\n      - ssh-ed25519 AAAA dev\n";

let fake: FakeHetzner;
/** Everything the provider said in this file, read by the last test. */
const printed: string[] = [];

beforeAll(() => {
  fake = createFakeHetzner();
});
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

/** A clock that does not wait: a sleep moves it on. */
function fakeClock() {
  let now = Date.parse("2026-10-29T10:00:00Z");
  return { now: () => now, sleep: async (milliseconds: number) => void (now += milliseconds) };
}

function open(owner: Owner, extra: Partial<ProviderContext> = {}): Provider {
  return HETZNER.open({
    owner,
    credentials: { HCLOUD_TOKEN: FAKE_TOKEN },
    environment: { SITESOLIDE_HETZNER_API: fake.url },
    fetcher: (input, init) => fetch(input, init),
    clock: fakeClock(),
    secret: () => {},
    ...extra,
  });
}

/** What devbox orders: no key, SSH alone from its networks, the user-data. */
function devboxOrder(overrides: Partial<CreateRequest> = {}): CreateRequest {
  return { name: "web", type: "cx23", location: "fsn1", image: "ubuntu-24.04", backups: false, key: null, inbound: SSH_ONLY, userData: USER_DATA, ...overrides };
}

/** What sitesolide orders: its key, a web server's rules, no user-data. */
function sitesolideOrder(overrides: Partial<CreateRequest> = {}): CreateRequest {
  return { name: "web", ...HETZNER.defaults({}), backups: false, key: KEY, inbound: WEB_SERVER, ...overrides };
}

async function create(provider: Provider, request: CreateRequest) {
  const lines: string[] = [];
  const outcome = await provider.create(request, (line) => {
    lines.push(line);
    printed.push(line);
  });
  return { outcome, lines };
}

async function destroy(provider: Provider, name: string, deleteKey = false) {
  const lines: string[] = [];
  const machine = await provider.find(name);
  if (machine === null) throw new Error(`no machine ${name}`);
  const outcome = await provider.destroy(machine, { deleteKey }, (line) => {
    lines.push(line);
    printed.push(line);
  });
  return { outcome, lines };
}

/** The refusal a call ends with: a ProviderError whose code is in FAILURE_CODES. */
async function refusal(promise: Promise<unknown>): Promise<Failure> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    printed.push(error.failure.message, ...(error.failure.details ?? []));
    expect(FAILURE_CODES.has(error.failure.error)).toBe(true);
    return error.failure;
  }
  throw new Error("expected a refusal");
}

/** The requests that changed something, as `METHOD /path`, ids as `:id`. */
function writes(): string[] {
  return fake.requests.filter((request) => request.method !== "GET").map((request) => `${request.method} ${request.path.replace(/[0-9]+/g, ":id")}`);
}

function bodyOf(method: string, path: string): Record<string, unknown> {
  const found = fake.requests.find((request) => request.method === method && request.path === path);
  if (found === undefined) throw new Error(`no ${method} ${path}`);
  return found.body as Record<string, unknown>;
}

const labels = (owner: Owner, name: string) => ({ "managed-by": owner.name, [`${owner.name}-machine`]: name });

// --- the pieces -------------------------------------------------------------------------------

describe("the firewall's rules", () => {
  test("the request's rules in Hetzner's shape: a port as a string, none for ICMP", () => {
    expect(firewallRules(SSH_ONLY)).toEqual([
      { direction: "in", protocol: "tcp", port: "22", source_ips: ["198.51.100.0/24", "2001:db8:ffff::/48"], description: "ssh" },
      { direction: "in", protocol: "icmp", source_ips: ["0.0.0.0/0", "::/0"], description: "ping" },
    ]);
    expect(firewallRules(WEB_SERVER).map((rule) => `${rule.protocol} ${rule.port ?? "-"}`)).toEqual(["tcp 22", "tcp 80", "tcp 443", "icmp -"]);
  });

  test("what a firewall holds compares by what it opens, as the API answers it, in any order", () => {
    const wanted = firewallRules(SSH_ONLY);
    const answered = [
      { direction: "in" as const, protocol: "icmp", port: null, source_ips: ["::/0", "0.0.0.0/0"], destination_ips: [], description: null },
      { direction: "in" as const, protocol: "tcp", port: "22", source_ips: ["2001:db8:ffff::/48", "198.51.100.0/24"], destination_ips: [], description: "another word" },
    ];
    expect(holdsRules(answered, wanted)).toBe(true);
    expect(holdsRules(answered.slice(0, 1), wanted)).toBe(false);
    expect(holdsRules([...answered, { direction: "in", protocol: "tcp", port: "80", source_ips: ["0.0.0.0/0"] }], wanted)).toBe(false);
    expect(holdsRules([{ ...answered[1]!, source_ips: ["0.0.0.0/0"] }, answered[0]!], wanted)).toBe(false);
    expect(holdsRules(undefined, wanted)).toBe(false);
  });

  test("its name is the owner's", () => {
    expect(firewallName(DEVBOX, "web")).toBe("devbox-web");
    expect(firewallName(SITESOLIDE, "web")).toBe("sitesolide-web");
  });
});

// --- create, list, destroy for devbox ----------------------------------------------------------

describe("a machine devbox orders: no key, its own rules, a user-data", () => {
  test("no key is looked up, uploaded or named; the firewall holds the request's rules; the user-data goes as it is", async () => {
    const { outcome, lines } = await create(open(DEVBOX), devboxOrder());

    expect(fake.requests.filter((request) => request.path.startsWith("/ssh_keys"))).toEqual([]);
    expect(writes()).toEqual(["POST /firewalls", "POST /servers"]);

    const firewall = fake.firewalls[0]!;
    expect(bodyOf("POST", "/firewalls")).toEqual({ name: "devbox-web", labels: labels(DEVBOX, "web"), rules: firewallRules(SSH_ONLY) });
    const order = bodyOf("POST", "/servers");
    expect(order).toEqual({
      name: "web",
      server_type: "cx23",
      location: "fsn1",
      image: "ubuntu-24.04",
      firewalls: [{ firewall: firewall.id }],
      public_net: { enable_ipv4: true, enable_ipv6: true },
      labels: labels(DEVBOX, "web"),
      user_data: USER_DATA,
      start_after_create: true,
    });
    expect("ssh_keys" in order).toBe(false);

    expect(lines).toContain("-> firewall devbox-web");
    expect(lines).toContain(`   created: ${describeInbound(SSH_ONLY)}`);
    expect(lines).not.toContain("-> SSH key");
    expect(outcome).toMatchObject({
      created: true,
      machine: { provider: "hetzner", name: "web", status: "running", ipv4: "203.0.113.10", ipv6: "2001:db8:10::1", managed: true, labels: labels(DEVBOX, "web") },
    });
    expect(outcome.resources.map((resource) => [resource.kind, resource.name, resource.reused])).toEqual([
      ["firewall", "devbox-web", false],
      ["server", "web", false],
    ]);
  });

  test("a second run finds the machine and changes nothing", async () => {
    await create(open(DEVBOX), devboxOrder());
    fake.requests.length = 0;
    const { outcome, lines } = await create(open(DEVBOX), devboxOrder());
    expect(outcome.created).toBe(false);
    expect(lines).toContain("   already created by devbox: cx23 at fsn1, running");
    expect(writes()).toEqual([]);
  });

  test("with a key, it is uploaded under the owner's name and labels, and the order names it", async () => {
    await create(open(DEVBOX), devboxOrder({ key: KEY, userData: undefined }));
    const key = fake.keys[0]!;
    expect(key).toMatchObject({ name: "devbox-web", fingerprint: KEY.fingerprint, labels: labels(DEVBOX, "web") });
    const order = bodyOf("POST", "/servers");
    expect(order.ssh_keys).toEqual([key.id]);
    expect("user_data" in order).toBe(false);
  });

  test("list shows it; destroy deletes the server and its firewall, and finds no key to keep", async () => {
    await create(open(DEVBOX), devboxOrder());
    const provider = open(DEVBOX);
    expect((await provider.list()).map((machine) => [machine.name, machine.managed])).toEqual([["web", true]]);
    const listed = fake.requests.findLast((request) => request.method === "GET" && request.path === "/servers")!;
    expect(new URLSearchParams(listed.search).get("label_selector")).toBe("managed-by=devbox");

    fake.requests.length = 0;
    const { outcome, lines } = await destroy(provider, "web", true);
    expect(outcome.removed).toEqual(["server web (203.0.113.10, 2001:db8:10::1)", "firewall devbox-web"]);
    expect(outcome.kept).toEqual([]);
    expect(lines).toContain("   none was uploaded for web: it was ordered with a key already in the project, or none");
    expect(writes()).toEqual(["DELETE /servers/:id", "DELETE /firewalls/:id"]);
    expect(fake.servers).toEqual([]);
    expect(fake.firewalls).toEqual([]);
  });

  test("a firewall a stopped run left with other rules is reused, its rules set to the request's", async () => {
    const left = fake.addFirewall({ name: "devbox-web", labels: labels(DEVBOX, "web"), rules: firewallRules(WEB_SERVER) });
    const { outcome, lines } = await create(open(DEVBOX), devboxOrder());
    expect(writes()).toEqual(["POST /firewalls/:id/actions/set_rules", "POST /servers"]);
    expect(bodyOf("POST", `/firewalls/${left.id}/actions/set_rules`)).toEqual({ rules: firewallRules(SSH_ONLY) });
    expect(fake.firewalls).toHaveLength(1);
    expect(fake.firewalls[0]!.rules).toEqual(firewallRules(SSH_ONLY));
    expect(lines).toContain(`   rules set to the request's: ${describeInbound(SSH_ONLY)}`);
    expect(outcome.resources[0]).toMatchObject({ kind: "firewall", name: "devbox-web", reused: true });

    // Holding them already, it is left as it is.
    fake.reset();
    fake.addFirewall({ name: "devbox-web", labels: labels(DEVBOX, "web"), rules: firewallRules(SSH_ONLY) });
    await create(open(DEVBOX), devboxOrder());
    expect(writes()).toEqual(["POST /servers"]);
  });

  test("an order Hetzner refuses undoes the firewall this run made, and there is no key to undo", async () => {
    fake.fail("POST", /^\/servers$/, 412, "resource_unavailable", "server type cx23 is not available in location fsn1");
    const failure = await refusal(open(DEVBOX).create(devboxOrder(), (line) => void printed.push(line)));
    expect(failure.error).toBe("type-unavailable");
    expect(failure.details?.at(-1)).toBe("deleted the firewall devbox-web this run had created");
    expect(writes()).toEqual(["POST /firewalls", "POST /servers", "DELETE /firewalls/:id"]);
    expect(fake.firewalls).toEqual([]);
  });
});

// --- the user-data's size ------------------------------------------------------------------------

describe("the user-data's size", () => {
  test("over 32768 bytes, it is refused before anything leaves, the size and the limit said", async () => {
    const failure = await refusal(open(DEVBOX).create(devboxOrder({ userData: "#".repeat(USER_DATA_BYTES + 1) }), () => {}));
    expect(failure).toEqual({ error: "provider-invalid", message: "the user-data is 32769 bytes, and Hetzner refuses one over 32768", details: ["nothing was created"] });
    expect(fake.requests).toEqual([]);
  });

  test("measured in bytes, not characters: 16385 accented letters are 32770 bytes", async () => {
    const accented = "é".repeat(16385);
    expect(accented.length).toBeLessThan(USER_DATA_BYTES);
    const failure = await refusal(open(DEVBOX).create(devboxOrder({ userData: accented }), () => {}));
    expect(failure.message).toBe("the user-data is 32770 bytes, and Hetzner refuses one over 32768");
    expect(fake.requests).toEqual([]);
  });

  test("exactly 32768 bytes is ordered", async () => {
    const full = "#".repeat(USER_DATA_BYTES);
    await create(open(DEVBOX), devboxOrder({ userData: full }));
    expect(bodyOf("POST", "/servers").user_data).toBe(full);
  });
});

// --- what the provider cannot do -------------------------------------------------------------

describe("what Hetzner cannot be asked here", () => {
  test("a disk, nested virtualization or a login is refused before anything leaves", async () => {
    const asked: [Partial<CreateRequest>, string][] = [
      [{ disk: { gb: 80 } }, "Hetzner cannot be asked the size or type of the disk here"],
      [{ nestedVirtualization: true }, "Hetzner cannot be asked nested virtualization here"],
      [{ ephemeralAddress: true }, "Hetzner cannot be asked an address it does not reserve here"],
      [{ login: "dev" }, "Hetzner cannot be asked the account the key logs into here"],
      [{ inbound: [{ protocol: "icmp", port: 8, sources: ["0.0.0.0/0"] }] }, "Hetzner cannot be asked a icmp rule with a port here"],
      [{ inbound: [{ protocol: "tcp", port: 22, sources: [] }] }, "Hetzner cannot be asked a tcp rule open to no network here"],
    ];
    for (const [overrides, message] of asked) {
      const failure = await refusal(open(DEVBOX).create(devboxOrder(overrides), () => {}));
      expect(failure).toEqual({ error: "provider-unsupported", message, details: ["nothing was created"] });
    }
    expect(fake.requests).toEqual([]);
  });
});

// --- two owners in one project -----------------------------------------------------------------

describe("two owners in one project", () => {
  test("devbox neither lists, adopts nor destroys sitesolide's machine", async () => {
    await create(open(SITESOLIDE), sitesolideOrder());
    const devbox = open(DEVBOX);
    fake.requests.length = 0;

    expect(await devbox.list()).toEqual([]);
    const found = await devbox.find("web");
    expect(found).toMatchObject({ name: "web", managed: false });

    const taken = await refusal(devbox.create(devboxOrder(), () => {}));
    expect(taken.error).toBe("machine-exists");
    expect(taken.message).toBe("a server named web exists in the project, and devbox did not create it");
    expect(taken.details?.at(-1)).toBe("it lacks the label managed-by=devbox: nothing was created, nothing was changed");

    const kept = await refusal(devbox.destroy(found!, { deleteKey: true }, () => {}));
    expect(kept).toEqual({ error: "machine-not-managed", message: "the server web lacks the label managed-by=devbox: devbox did not create it", details: ["nothing was deleted"] });
    expect(writes()).toEqual([]);
    expect(fake.servers).toHaveLength(1);
    expect(fake.firewalls.map((firewall) => firewall.name)).toEqual(["sitesolide-web"]);
    expect(fake.keys.map((key) => key.name)).toEqual(["sitesolide-web"]);
  });

  test("sitesolide neither lists nor destroys devbox's machine", async () => {
    await create(open(DEVBOX), devboxOrder());
    const sitesolide = open(SITESOLIDE);
    fake.requests.length = 0;
    expect(await sitesolide.list()).toEqual([]);
    const found = await sitesolide.find("web");
    expect(found).toMatchObject({ managed: false });
    expect((await refusal(sitesolide.destroy(found!, { deleteKey: true }, () => {}))).error).toBe("machine-not-managed");
    expect((await refusal(sitesolide.create(sitesolideOrder(), () => {}))).error).toBe("machine-exists");
    expect(writes()).toEqual([]);
    expect(fake.servers).toHaveLength(1);
  });

  test("a destroy sweeps only its owner's firewall and key, though another owner's were made for a machine of that name", async () => {
    // What sitesolide kept of a machine `api` it destroyed while its firewall still served another server.
    const theirs = labels(SITESOLIDE, "api");
    fake.addFirewall({ name: "sitesolide-api", labels: theirs });
    fake.addFirewall({ name: "api", labels: theirs });
    fake.addKey({ name: "sitesolide-api", public_key: `${KEY.algorithm} ${KEY.blob}`, labels: theirs });

    await create(open(DEVBOX), devboxOrder({ name: "api" }));
    const { outcome } = await destroy(open(DEVBOX), "api", true);
    expect(outcome.removed).toEqual(["server api (203.0.113.10, 2001:db8:10::1)", "firewall devbox-api"]);
    expect(fake.firewalls.map((firewall) => firewall.name).sort()).toEqual(["api", "sitesolide-api"]);
    expect(fake.keys.map((key) => key.name)).toEqual(["sitesolide-api"]);
  });

  test("a firewall of the owner's name another owner made is refused before anything is created", async () => {
    fake.addFirewall({ name: "devbox-web", labels: labels(SITESOLIDE, "web") });
    const failure = await refusal(open(DEVBOX).create(devboxOrder(), () => {}));
    expect(failure).toEqual({
      error: "firewall-taken",
      message: "a firewall named devbox-web exists in the project, and devbox did not create it",
      details: ["it lacks the label managed-by=devbox: it is never adopted nor changed"],
    });
    expect(writes()).toEqual([]);
  });

  test("a firewall made before it took the owner's name, named after the machine alone, goes with the machine", async () => {
    const older = fake.addFirewall({ name: "web", labels: labels(SITESOLIDE, "web") });
    fake.addServer({ name: "web", labels: labels(SITESOLIDE, "web"), firewalls: [older.id] });
    const { outcome } = await destroy(open(SITESOLIDE), "web");
    expect(outcome.removed).toEqual(["server web (203.0.113.50, 2001:db8:50::1)", "firewall web"]);
    expect(fake.firewalls).toEqual([]);
  });
});

// --- secrets -------------------------------------------------------------------------------------

describe("the token and the root password", () => {
  test("the token travels in the Authorization header alone; the root password of a keyless server is never read back", async () => {
    await create(open(DEVBOX), devboxOrder());
    expect(fake.requests.length).toBeGreaterThan(5);
    for (const request of fake.requests) {
      expect(request.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(request.url).not.toContain(FAKE_TOKEN);
      expect(JSON.stringify(request.body ?? null)).not.toContain(FAKE_TOKEN);
    }
  });

  test("an unknown token is refused without being repeated", async () => {
    const failure = await refusal(open(DEVBOX, { credentials: { HCLOUD_TOKEN: "an-unknown-token-0000000000000000" } }).list());
    expect(failure.error).toBe("provider-unauthenticated");
    expect(JSON.stringify(failure)).not.toContain("an-unknown-token");
  });

  test("never appear in anything the provider said in this file", () => {
    expect(printed.length).toBeGreaterThan(50);
    expect(printed.filter((line) => line.includes(FAKE_TOKEN) || line.includes(FAKE_ROOT_PASSWORD))).toEqual([]);
  });
});
