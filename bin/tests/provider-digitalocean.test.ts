import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { REMOTE_HINTS } from "../cli/hints";
import {
  DEFAULTS,
  DIGITALOCEAN,
  DigitalOceanError,
  discover,
  failureFrom,
  INBOUND_RULES,
  ipv6Block,
  labelsOfTags,
  OUTBOUND_RULES,
  refusesTheOffer,
  TOKEN_SHAPE,
  WAITS,
} from "../cli/providers/digitalocean";
import { ProviderError, type CreateRequest, type Machine, type ProviderContext, type PublicKey, type Workstation } from "../cli/providers/provider";
import { createFake, createFakeDigitalOcean, FAKE_TOKEN, LINK_ORIGIN, type FakeDigitalOcean, type FakeDroplet } from "./fake-digitalocean";

/**
 * The DigitalOcean provider, through `DIGITALOCEAN.open(...)`, against a local
 * fake of its API (fake-digitalocean.ts): the real one is never called, and
 * the clock never waits.
 *
 * Whatever the path, the token must never appear in a URL, a line reported or
 * a refusal: every line and every refusal of this file is kept in `printed`,
 * read by the last test.
 */

/** Generated for these tests with ssh-keygen; the private half was deleted at once (as in cli-machine.test.ts). */
const ED25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICezpiOyiQWMYqOeL4S4OgE0T7Fq2bLHWUJ1afO4cczN ada@workstation.test-zone.invalid";
const KEY: PublicKey = {
  algorithm: "ssh-ed25519",
  blob: "AAAAC3NzaC1lZDI1NTE5AAAAICezpiOyiQWMYqOeL4S4OgE0T7Fq2bLHWUJ1afO4cczN",
  comment: "ada@workstation.test-zone.invalid",
  fingerprint: "a4:46:30:d5:fd:7e:1a:77:e5:ad:8d:21:4f:9a:3e:9e",
};

/** Another key, for the account's other machines: any ed25519 blob of the right shape. */
function otherKey(seed: number): string {
  const name = Buffer.from("ssh-ed25519");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(name.length);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(32);
  return `ssh-ed25519 ${Buffer.concat([head, name, size, Buffer.alloc(32, seed)]).toString("base64")} other-${seed}`;
}

let fake: FakeDigitalOcean;
/** Every line reported and every refusal of this file, read by the last test. */
const printed: string[] = [];
/** Every address the provider fetched, read by the last test. */
const fetched: string[] = [];

beforeAll(() => {
  fake = createFakeDigitalOcean();
});

afterAll(() => fake.stop());

beforeEach(() => fake.reset());

function fakeClock() {
  let now = Date.parse("2026-10-21T10:00:00Z");
  const clock = { slept: 0, now: () => now, sleep: async (milliseconds: number) => void ((now += milliseconds), (clock.slept += milliseconds)) };
  return clock;
}

function open(extra: Partial<ProviderContext> = {}) {
  const clock = fakeClock();
  const provider = DIGITALOCEAN.open({
    credentials: { DIGITALOCEAN_TOKEN: FAKE_TOKEN },
    environment: { SITESOLIDE_DIGITALOCEAN_API: fake.url },
    fetcher: (input, init) => {
      fetched.push(input);
      return fetch(input, init);
    },
    clock,
    secret: () => {},
    ...extra,
  });
  return { provider, clock };
}

function request(overrides: Partial<CreateRequest> = {}): CreateRequest {
  return { name: "web", type: DEFAULTS.type, location: DEFAULTS.location, image: DEFAULTS.image, backups: false, key: KEY, ...overrides };
}

function reporter() {
  const lines: string[] = [];
  return {
    lines,
    report: (line: string) => {
      lines.push(line);
      printed.push(line);
    },
  };
}

/** The refusal a promise ends on, kept for the last test. */
async function refusal(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    const failure = (error as ProviderError).failure;
    printed.push(failure.message, ...(failure.details ?? []));
    expect(Object.hasOwn(REMOTE_HINTS, failure.error)).toBe(true);
    return error as ProviderError;
  }
  throw new Error("expected a refusal");
}

/** A path with its ids replaced, numbers and firewall uuids alike. */
function shape(path: string): string {
  return path.replace(/\/(?:[0-9]+|[0-9a-f]{8}-[0-9a-f-]{20,})(?=\/|$)/g, "/:id");
}

/** The requests that changed something, as `METHOD /path`. */
function writes(): string[] {
  return fake.requests.filter((received) => received.method !== "GET").map((received) => `${received.method} ${shape(received.path)}`);
}

function bodyOf(method: string, path: string): Record<string, unknown> {
  return fake.requests.find((received) => received.method === method && received.path === path)!.body as Record<string, unknown>;
}

const MANAGED = ["managed-by:sitesolide", "sitesolide-machine:web"];

/** A machine an earlier run created: the droplet `web` and its firewall. */
function earlierRun(input: Partial<FakeDroplet> = {}): FakeDroplet {
  fake.addFirewall({ name: "sitesolide-web", tags: ["sitesolide-machine:web"] });
  return fake.addDroplet({ name: "web", tags: MANAGED, ...input });
}

// --- the entry ---------------------------------------------------------------------------------

describe("the entry", () => {
  test("names the provider, its token, its page and its defaults", () => {
    expect(DIGITALOCEAN).toMatchObject({ name: "digitalocean", title: "DigitalOcean", docs: "docs/providers/digitalocean.md", backups: true, apiVariable: "SITESOLIDE_DIGITALOCEAN_API" });
    expect(DIGITALOCEAN.credentials).toEqual([{ variable: "DIGITALOCEAN_TOKEN", label: "API token", secret: true, shape: TOKEN_SHAPE }]);
    expect(DIGITALOCEAN.defaults({})).toEqual({ type: "s-1vcpu-2gb", location: "fra1", image: "debian-13" });
    expect(DIGITALOCEAN.credentialHelp.join(" ")).toContain("Custom Scopes");
  });

  test("a token is a personal access token, an OAuth token, or a token of before 2021", () => {
    for (const token of [FAKE_TOKEN, `doo_v1_${"a".repeat(64)}`, "f".repeat(64)]) expect(TOKEN_SHAPE.test(token)).toBe(true);
    for (const token of ["", "dop_v1_short", `dop_v1_${"g".repeat(64)}`, `Bearer ${FAKE_TOKEN}`, `${FAKE_TOKEN}\n`]) expect(TOKEN_SHAPE.test(token)).toBe(false);
  });

  test("the API's address is DigitalOcean's, or another over https or http on the loopback only", async () => {
    for (const refused of ["http://api.test-zone.invalid/v2", "https://user:secret@api.test-zone.invalid/v2", "https://api.test-zone.invalid/v2?x=1"]) {
      const error = await refusal(Promise.resolve().then(() => open({ environment: { SITESOLIDE_DIGITALOCEAN_API: refused } })));
      expect(error.failure.error).toBe("provider-endpoint");
    }
    expect(fake.requests).toEqual([]);
  });

  test("without a token, nothing leaves", async () => {
    const error = await refusal(Promise.resolve().then(() => open({ credentials: {} })));
    expect(error.failure.error).toBe("no-provider-token");
    expect(fake.requests).toEqual([]);
  });

  test("the fake offers what every provider's fake offers", () => {
    const generic = createFake();
    try {
      expect(generic.environment).toMatchObject({ DIGITALOCEAN_TOKEN: FAKE_TOKEN });
      expect(generic.environment.SITESOLIDE_DIGITALOCEAN_API).toStartWith("http://127.0.0.1:");
      expect(generic.secrets).toEqual([FAKE_TOKEN]);
    } finally {
      generic.stop();
    }
  });
});

// --- discover ---------------------------------------------------------------------------------

describe("discover", () => {
  function workstation(environment: Record<string, string | undefined>, answer: { code: number; stdout: string; stderr?: string }) {
    const ran: string[][] = [];
    const station: Workstation = {
      environment,
      run: async (argv) => {
        ran.push(argv);
        return { stderr: "", ...answer };
      },
      readFile: () => null,
    };
    return { station, ran };
  }

  test("DIGITALOCEAN_ACCESS_TOKEN, which doctl reads, comes first", async () => {
    const { station, ran } = workstation({ DIGITALOCEAN_ACCESS_TOKEN: ` ${FAKE_TOKEN} ` }, { code: 0, stdout: "" });
    const found = await discover(station);
    expect(found).toEqual({ source: "DIGITALOCEAN_ACCESS_TOKEN, which doctl reads", credentials: { DIGITALOCEAN_TOKEN: FAKE_TOKEN } });
    expect(ran).toEqual([]);
    expect(DIGITALOCEAN.discover).toBe(discover);
  });

  test("else the token doctl prints for its current context", async () => {
    const { station, ran } = workstation({}, { code: 0, stdout: `${FAKE_TOKEN}\n` });
    expect(await discover(station)).toEqual({ source: "the doctl CLI, signed in", credentials: { DIGITALOCEAN_TOKEN: FAKE_TOKEN } });
    expect(ran).toEqual([["doctl", "auth", "token"]]);
  });

  test("nothing when doctl is not installed, signed out, failing, or prints no token", async () => {
    for (const answer of [
      { code: 127, stdout: "" },
      { code: 0, stdout: "\n" },
      { code: 1, stdout: FAKE_TOKEN },
      { code: 0, stdout: "Error: unable to read the configuration\n" },
    ]) {
      expect(await discover(workstation({}, answer).station)).toBeNull();
    }
    // A variable that holds no token is passed over, for doctl's answer.
    const { station, ran } = workstation({ DIGITALOCEAN_ACCESS_TOKEN: "not-a-token" }, { code: 0, stdout: "" });
    expect(await discover(station)).toBeNull();
    expect(ran).toEqual([["doctl", "auth", "token"]]);
  });
});

// --- create ------------------------------------------------------------------------------------

describe("create", () => {
  test("an empty account: the reads, then key, tag, firewall and droplet, then the waits, in that order", async () => {
    for (const seed of [1, 2, 3]) fake.addKey({ name: `laptop-${seed}`, public_key: otherKey(seed) });
    const { provider } = open();
    const { lines, report } = reporter();
    const outcome = await provider.create(request(), report);

    const page = (search: string) => new URLSearchParams(search).get("page");
    expect(fake.requests.map((received) => `${received.method} ${shape(received.path)}${page(received.search) === null ? "" : `?page=${page(received.search)}`}`)).toEqual([
      "GET /droplets?page=1",
      "GET /regions?page=1",
      "GET /regions?page=2",
      "GET /regions?page=3",
      "GET /sizes?page=1",
      "GET /sizes?page=2",
      "GET /sizes?page=3",
      "GET /sizes?page=4",
      "GET /sizes?page=5",
      "GET /sizes?page=6",
      "GET /images/debian-13-x64",
      "GET /firewalls?page=1",
      "GET /account/keys?page=1",
      "GET /account/keys?page=2",
      "POST /account/keys",
      "GET /tags/sitesolide-machine:web",
      "POST /tags",
      "POST /firewalls",
      "POST /droplets",
      // the create action, two polls
      "GET /actions/:id",
      "GET /actions/:id",
      "GET /droplets/:id",
      // the firewall, waiting, then applied
      "GET /firewalls/:id",
      "GET /firewalls/:id",
    ]);
    for (const received of fake.requests) {
      expect(received.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(received.url).not.toContain(FAKE_TOKEN);
    }
    const search = new URLSearchParams(fake.requests[0]!.search);
    expect({ name: search.get("name"), perPage: search.get("per_page") }).toEqual({ name: "web", perPage: "200" });

    const key = fake.keys.find((candidate) => candidate.name.startsWith("sitesolide-"))!;
    expect(key).toMatchObject({ name: "sitesolide-web", fingerprint: KEY.fingerprint, public_key: ED25519 });
    expect(bodyOf("POST", "/tags")).toEqual({ name: "sitesolide-machine:web" });
    expect(bodyOf("POST", "/firewalls")).toEqual({
      name: "sitesolide-web",
      inbound_rules: [
        { protocol: "tcp", ports: "22", sources: { addresses: ["0.0.0.0/0", "::/0"] } },
        { protocol: "tcp", ports: "80", sources: { addresses: ["0.0.0.0/0", "::/0"] } },
        { protocol: "tcp", ports: "443", sources: { addresses: ["0.0.0.0/0", "::/0"] } },
        { protocol: "icmp", sources: { addresses: ["0.0.0.0/0", "::/0"] } },
      ],
      outbound_rules: [
        { protocol: "tcp", ports: "all", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
        { protocol: "udp", ports: "all", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
        { protocol: "icmp", destinations: { addresses: ["0.0.0.0/0", "::/0"] } },
      ],
      tags: ["sitesolide-machine:web"],
    });
    expect(bodyOf("POST", "/firewalls").inbound_rules).toEqual(INBOUND_RULES);
    expect(bodyOf("POST", "/firewalls").outbound_rules).toEqual(OUTBOUND_RULES);
    const order = bodyOf("POST", "/droplets");
    expect(order).toEqual({
      name: "web",
      region: "fra1",
      size: "s-1vcpu-2gb",
      image: "debian-13-x64",
      ssh_keys: [key.id],
      backups: false,
      ipv6: true,
      monitoring: false,
      tags: [...MANAGED, `sitesolide-key:${key.id}`],
    });
    expect("user_data" in order).toBe(false);

    const droplet = fake.droplets[0]!;
    expect(outcome.created).toBe(true);
    expect(outcome.machine).toEqual({
      provider: "digitalocean",
      id: String(droplet.id),
      name: "web",
      type: "s-1vcpu-2gb",
      location: "fra1",
      status: "active",
      ipv4: droplet.ipv4,
      ipv6: droplet.ipv6,
      ipv6Network: ipv6Block(droplet.ipv6),
      monthlyPrice: { net: "12", gross: "12", currency: "USD" },
      backups: false,
      managed: true,
      labels: { "managed-by": "sitesolide", "sitesolide-machine": "web", "sitesolide-key": String(key.id) },
      login: "root",
    });
    expect(outcome.machine.ipv4).toStartWith("203.0.113.");
    expect(outcome.resources).toEqual([
      { kind: "ssh key", name: "sitesolide-web", id: String(key.id), reused: false },
      { kind: "tag", name: "sitesolide-machine:web", id: "sitesolide-machine:web", reused: false },
      { kind: "firewall", name: "sitesolide-web", id: fake.firewalls[0]!.id, reused: false },
      { kind: "droplet", name: "web", id: String(droplet.id), reused: false },
    ]);
    expect(lines).toContain("   1 vCPU, 2 GB RAM, 50 GB disk, Basic, 12.00 USD a month before VAT");
    expect(lines).toContain("   create: done");
    expect(lines).toContain("   firewall sitesolide-web: applied");
    expect(lines.filter((line) => line.startsWith("!! "))).toEqual([]);
  });

  test("a second run finds the droplet and writes nothing", async () => {
    await open().provider.create(request(), reporter().report);
    fake.requests.length = 0;
    const { lines, report } = reporter();
    const again = await open().provider.create(request(), report);
    expect(writes()).toEqual([]);
    expect(again.created).toBe(false);
    expect(again.resources).toEqual([{ kind: "droplet", name: "web", id: String(fake.droplets[0]!.id), reused: true }]);
    expect(lines).toContain("   already created by sitesolide: s-1vcpu-2gb at fra1, active");
    // Asked for elsewhere, it says it stays where it is.
    const moved = reporter();
    await open().provider.create(request({ location: "ams3", type: "s-2vcpu-4gb" }), moved.report);
    expect(writes()).toEqual([]);
    expect(moved.lines).toContain("!! it is s-1vcpu-2gb at fra1: --type and --location only apply to a machine being created");
  });

  test("a key the account holds is reused under its own name, and the droplet does not name it", async () => {
    const own = fake.addKey({ name: "my laptop", public_key: ED25519 });
    const outcome = await open().provider.create(request(), reporter().report);
    expect(writes()).toEqual(["POST /tags", "POST /firewalls", "POST /droplets"]);
    expect(bodyOf("POST", "/droplets")).toMatchObject({ ssh_keys: [own.id], tags: MANAGED });
    expect(outcome.resources[0]).toEqual({ kind: "ssh key", name: "my laptop", id: String(own.id), reused: true });
  });

  test("a key a run uploaded before being interrupted is reused, and the droplet still names it", async () => {
    const earlier = fake.addKey({ name: "sitesolide-web", public_key: ED25519 });
    fake.tags.add("sitesolide-machine:web");
    await open().provider.create(request(), reporter().report);
    expect(writes()).toEqual(["POST /firewalls", "POST /droplets"]);
    expect(bodyOf("POST", "/droplets").tags).toEqual([...MANAGED, `sitesolide-key:${earlier.id}`]);
  });

  test("a name another key holds gets the fingerprint after it", async () => {
    fake.addKey({ name: "sitesolide-web", public_key: otherKey(7) });
    await open().provider.create(request(), reporter().report);
    expect(bodyOf("POST", "/account/keys")).toEqual({ name: "sitesolide-web-a44630d5", public_key: ED25519 });
  });

  test("--backups orders them daily; on a droplet that has none, they are enabled", async () => {
    const outcome = await open().provider.create(request({ backups: true }), reporter().report);
    expect(bodyOf("POST", "/droplets")).toMatchObject({ backups: true, backup_policy: { plan: "daily" } });
    expect(outcome.machine.backups).toBe(true);

    fake.reset();
    const earlier = earlierRun();
    fake.requests.length = 0;
    const { lines, report } = reporter();
    const again = await open().provider.create(request({ backups: true }), report);
    expect(writes()).toEqual([`POST /droplets/:id/actions`]);
    expect(bodyOf("POST", `/droplets/${earlier.id}/actions`)).toEqual({ type: "enable_backups", backup_policy: { plan: "daily" } });
    expect(again.machine.backups).toBe(true);
    expect(lines).toContain("   enable_backups: done");
  });

  test("a droplet whose firewall is gone gets it again; a firewall of that name not sitesolide's is left, and said", async () => {
    fake.addDroplet({ name: "web", tags: MANAGED });
    const { lines, report } = reporter();
    await open().provider.create(request(), report);
    expect(writes()).toEqual(["POST /firewalls"]);
    expect(lines).toContain("!! the firewall sitesolide-web is gone: it is created again");
    expect(lines).toContain("   firewall sitesolide-web: applied");
    expect(fake.firewalls[0]).toMatchObject({ name: "sitesolide-web", tags: ["sitesolide-machine:web"] });

    fake.reset();
    fake.addDroplet({ name: "web", tags: MANAGED });
    fake.addFirewall({ name: "sitesolide-web", tags: ["prod"] });
    const other = reporter();
    const outcome = await open().provider.create(request(), other.report);
    expect(outcome.created).toBe(false);
    expect(writes()).toEqual([]);
    expect(other.lines).toContain(
      "!! a firewall named sitesolide-web exists in the account, and sitesolide did not create it, and none of sitesolide's applies to web: it is left as it is, the control panel shows it under Networking, Firewalls",
    );
  });

  test("a region without IPv6 gets a droplet without it, said", async () => {
    // sgp1 in the fake lists neither ipv6 nor backups.
    const { lines, report } = reporter();
    await open().provider.create(request({ location: "sgp1" }), report);
    expect(bodyOf("POST", "/droplets").ipv6).toBe(false);
    expect(lines).toContain("!! DigitalOcean routes no IPv6 at sgp1: the droplet gets an IPv4 address only");
  });
});

describe("create refuses before any write", () => {
  test("a droplet of that name sitesolide did not create, whatever its case", async () => {
    for (const name of ["web", "Web"]) {
      fake.reset();
      fake.addDroplet({ name, tags: ["prod"] });
      const error = await refusal(open().provider.create(request(), reporter().report));
      expect(error.failure).toMatchObject({ error: "machine-exists", message: `a droplet named ${name} exists in the account, and sitesolide did not create it` });
      expect(error.failure.details?.[1]).toBe("it lacks the tag managed-by:sitesolide: nothing was created, nothing was changed");
      expect(writes()).toEqual([]);
    }
  });

  test("a droplet of that name beside sitesolide's is left alone, and said", async () => {
    fake.addDroplet({ name: "web", tags: ["prod"] });
    const ours = earlierRun();
    const { lines, report } = reporter();
    const outcome = await open().provider.create(request(), report);
    expect(outcome.machine.id).toBe(String(ours.id));
    expect(lines).toContain("!! 1 other droplet of that name, left as they are");
    expect(writes()).toEqual([]);
    expect((await open().provider.find("web"))?.id).toBe(String(ours.id));
  });

  test("a firewall of that name sitesolide did not create", async () => {
    fake.addFirewall({ name: "sitesolide-web", tags: ["prod"] });
    const error = await refusal(open().provider.create(request(), reporter().report));
    expect(error.failure).toMatchObject({ error: "firewall-taken", message: "a firewall named sitesolide-web exists in the account, and sitesolide did not create it" });
    expect(writes()).toEqual([]);
  });

  test("a region DigitalOcean does not have, or no longer opens", async () => {
    const unknown = await refusal(open().provider.create(request({ location: "par1" }), reporter().report));
    expect(unknown.failure).toMatchObject({ error: "invalid-location", message: "par1 is not a DigitalOcean region" });
    expect(unknown.failure.details).toContain("fra1  Frankfurt 1, DE");
    expect(unknown.failure.details?.some((line) => line.startsWith("nyc2"))).toBe(false);
    const closed = await refusal(open().provider.create(request({ location: "nyc2" }), reporter().report));
    expect(closed.failure.message).toBe("DigitalOcean no longer creates droplets at nyc2");
    expect(writes()).toEqual([]);
  });

  test("a size not sold there, no longer sold, or unknown, with the cheapest sold there", async () => {
    const elsewhere = await refusal(open().provider.create(request({ type: "s-1vcpu-2gb-amd" }), reporter().report));
    expect(elsewhere.failure).toMatchObject({ error: "invalid-server-type", message: "s-1vcpu-2gb-amd is not sold at fra1" });
    expect(elsewhere.failure.details?.[0]).toBe("the cheapest sizes DigitalOcean sells at fra1:");
    expect(elsewhere.failure.details?.[1]).toBe("s-1vcpu-2gb        1 vCPU, 2 GB RAM, 50 GB disk, Basic, 12.00 USD a month before VAT");
    expect((await refusal(open().provider.create(request({ type: "2gb" }), reporter().report))).failure.message).toBe("2gb is no longer sold");
    expect((await refusal(open().provider.create(request({ type: "cx23" }), reporter().report))).failure.message).toBe("cx23 is not a DigitalOcean size");
    expect(writes()).toEqual([]);
  });

  test("an image DigitalOcean does not have, or not there", async () => {
    const unknown = await refusal(open().provider.create(request({ image: "arch-x64" }), reporter().report));
    expect(unknown.failure).toMatchObject({ error: "provider-invalid", message: "arch-x64 is not a DigitalOcean image" });
    const elsewhere = await refusal(open().provider.create(request({ image: "ubuntu-24-04-x64" }), reporter().report));
    expect(elsewhere.failure.message).toBe("the image ubuntu-24-04-x64 is not available at fra1");
    expect(writes()).toEqual([]);
    // An image's id is ordered as a number.
    await open().provider.create(request({ image: "199888143" }), reporter().report);
    expect(bodyOf("POST", "/droplets").image).toBe(199888143);
  });

  test("backups where DigitalOcean takes none", async () => {
    const error = await refusal(open().provider.create(request({ location: "sgp1", backups: true }), reporter().report));
    expect(error.failure).toMatchObject({ error: "provider-unavailable", message: "DigitalOcean takes no backups at sgp1" });
    expect(writes()).toEqual([]);
  });
});

describe("a refused order", () => {
  test("undoes what this run created, and says what to try instead", async () => {
    fake.fail("POST", /^\/droplets$/, 422, "unprocessable_entity", "Size is not available in this region.");
    const { lines, report } = reporter();
    const error = await refusal(open().provider.create(request(), report));
    expect(error.failure.error).toBe("type-unavailable");
    expect(error.failure.message).toBe("DigitalOcean would not create s-1vcpu-2gb at fra1 (422 unprocessable_entity): Size is not available in this region.");
    expect(error.failure.details).toContain("or try another --location");
    expect(error.failure.details?.slice(-3)).toEqual([
      "deleted the firewall sitesolide-web this run had created",
      "deleted the tag sitesolide-machine:web this run had created",
      "deleted the SSH key sitesolide-web this run had created",
    ]);
    expect(writes()).toEqual(["POST /account/keys", "POST /tags", "POST /firewalls", "POST /droplets", "DELETE /firewalls/:id", "DELETE /tags/sitesolide-machine:web", "DELETE /account/keys/:id"]);
    expect({ keys: fake.keys.length, tags: [...fake.tags], firewalls: fake.firewalls.length, droplets: fake.droplets.length }).toEqual({ keys: 0, tags: [], firewalls: 0, droplets: 0 });
    expect(lines).toContain("-> undo what this run created");
  });

  test("leaves what an earlier run made or the account held", async () => {
    fake.addKey({ name: "my laptop", public_key: ED25519 });
    fake.tags.add("sitesolide-machine:web");
    fake.addFirewall({ name: "sitesolide-web", tags: ["sitesolide-machine:web"] });
    fake.fail("POST", /^\/droplets$/, 422, "unprocessable_entity", "creating this/these droplet(s) will exceed your droplet limit");
    const error = await refusal(open().provider.create(request(), reporter().report));
    expect(error.failure.error).toBe("provider-limit");
    expect(error.failure.details).toContain("nothing had been created yet");
    expect(writes()).toEqual(["POST /droplets"]);
    expect({ keys: fake.keys.length, firewalls: fake.firewalls.length, tag: fake.tags.has("sitesolide-machine:web") }).toEqual({ keys: 1, firewalls: 1, tag: true });
  });

  test("undoes nothing when DigitalOcean may have created the droplet all the same", async () => {
    fake.fail("POST", /^\/droplets$/, 500, "server_error", "Unexpected server-side error");
    const error = await refusal(open().provider.create(request(), reporter().report));
    expect(error.failure.error).toBe("provider-failure");
    expect(error.failure.details?.at(-1)).toContain("nothing was undone");
    expect(writes()).toEqual(["POST /account/keys", "POST /tags", "POST /firewalls", "POST /droplets"]);
    expect(fake.firewalls.length).toBe(1);
  });

  test("an answer cut short leaves the outcome unknown: nothing is undone, and the next run finds the droplet with its firewall", async () => {
    fake.cutShort("POST", /^\/droplets$/);
    const error = await refusal(open().provider.create(request(), reporter().report));
    expect(error.failure.error).toBe("provider-unreadable");
    expect(error.failure.details?.at(-1)).toStartWith("whether DigitalOcean created the droplet is unknown: nothing was undone");
    expect(writes()).toEqual(["POST /account/keys", "POST /tags", "POST /firewalls", "POST /droplets"]);
    expect({ droplets: fake.droplets.length, firewalls: fake.firewalls.length, keys: fake.keys.length }).toEqual({ droplets: 1, firewalls: 1, keys: 1 });

    fake.requests.length = 0;
    const again = await open().provider.create(request(), reporter().report);
    expect(again).toMatchObject({ created: false, machine: { status: "active", managed: true } });
    expect(writes()).toEqual([]);
    expect(fake.firewalls[0]).toMatchObject({ name: "sitesolide-web", tags: ["sitesolide-machine:web"] });
  });

  test("a 429, or an accepted order without its droplet, undoes nothing either", async () => {
    fake.fail("POST", /^\/droplets$/, 429, "too_many_requests", "API Rate limit exceeded.", { headers: { "retry-after": "29" } });
    const limited = await refusal(open().provider.create(request(), reporter().report));
    expect(limited.failure).toMatchObject({ error: "provider-rate-limited", wait: 29 });
    expect(limited.failure.details?.at(-1)).toContain("nothing was undone");
    expect(writes().some((line) => line.startsWith("DELETE"))).toBe(false);

    fake.reset();
    fake.fail("POST", /^\/droplets$/, 202, "", "", { body: { links: { actions: [] } } });
    const empty = await refusal(open().provider.create(request(), reporter().report));
    expect(empty.failure.error).toBe("provider-unreadable");
    expect(empty.failure.details?.at(-1)).toContain("nothing was undone");
    expect(writes().some((line) => line.startsWith("DELETE"))).toBe(false);
  });

  test("a deletion that fails during the undo leaves the resource for the next run", async () => {
    fake.fail("POST", /^\/droplets$/, 422, "unprocessable_entity", "Name is invalid");
    fake.fail("DELETE", /^\/firewalls\//, 500, "server_error", "Unexpected server-side error");
    const error = await refusal(open().provider.create(request(), reporter().report));
    expect(error.failure.error).toBe("provider-invalid");
    expect(error.failure.details).toContain("left the firewall sitesolide-web: the next run finds it and reuses it");
    expect(fake.firewalls.length).toBe(1);
  });
});

describe("the waits", () => {
  test("are bounded, and the clock is the test's", async () => {
    fake.settings.actionPolls = 1_000_000;
    const { provider, clock } = open();
    const error = await refusal(provider.create(request(), reporter().report));
    expect(error.failure).toMatchObject({ error: "machine-timeout", message: "DigitalOcean's create still runs after 10 minutes" });
    expect(clock.slept).toBe(WAITS.actionMs);
    const polls = fake.requests.filter((received) => received.path.startsWith("/actions/")).length;
    expect(polls).toBe(WAITS.actionMs / WAITS.pollMs + 1);
  });

  test("an action that fails says so", async () => {
    fake.settings.failAction = "create";
    const error = await refusal(open().provider.create(request(), reporter().report));
    expect(error.failure).toMatchObject({ error: "action-failed", message: "DigitalOcean's create failed" });
  });

  test("a failure that says later is shrugged off once, with a warning", async () => {
    fake.fail("GET", /^\/actions\//, 429, "too_many_requests", "API Rate limit exceeded.", { headers: { "retry-after": "29" } });
    const { lines, report } = reporter();
    const outcome = await open().provider.create(request(), report);
    expect(outcome.created).toBe(true);
    expect(lines.filter((line) => line.startsWith("!! "))).toEqual(["!! DigitalOcean's rate limit is reached, nothing more can be asked of it for now (429 too_many_requests): still waiting"]);
  });

  test("a powered-off droplet of an earlier run is said, never powered on", async () => {
    earlierRun({ status: "off" });
    const error = await refusal(open().provider.create(request(), reporter().report));
    expect(error.failure).toMatchObject({ error: "machine-off", message: "web exists but is powered off" });
    expect(writes()).toEqual([]);
  });
});

// --- list and find ----------------------------------------------------------------------------------

describe("list", () => {
  test("only the droplets carrying managed-by:sitesolide, every page of them", async () => {
    for (const name of ["a", "b", "c"]) fake.addDroplet({ name, tags: ["managed-by:sitesolide", `sitesolide-machine:${name}`] });
    fake.addDroplet({ name: "mine", tags: ["prod"] });
    fake.addDroplet({ name: "sneaky", tags: ["managed-by:someone-else"] });
    const machines = await open().provider.list();
    expect(machines.map((machine) => machine.name)).toEqual(["a", "b", "c"]);
    expect(machines.every((machine) => machine.managed && machine.login === "root")).toBe(true);
    const first = fake.requests[0]!;
    expect(new URLSearchParams(first.search).get("tag_name")).toBe("managed-by:sitesolide");
    expect(fake.requests.map((received) => new URLSearchParams(received.search).get("page"))).toEqual(["1", "2"]);
  });

  test("find answers a droplet sitesolide did not create, unmanaged, and null when there is none", async () => {
    fake.addDroplet({ name: "mine", tags: ["prod"] });
    expect(await open().provider.find("mine")).toMatchObject({ name: "mine", managed: false });
    expect(await open().provider.find("nothing")).toBeNull();
  });
});

// --- destroy ---------------------------------------------------------------------------------------

describe("destroy", () => {
  async function created(overrides: Partial<CreateRequest> = {}): Promise<Machine> {
    const outcome = await open().provider.create(request(overrides), reporter().report);
    fake.requests.length = 0;
    return outcome.machine;
  }

  test("deletes the droplet, its firewall and its tags, and keeps the key", async () => {
    const machine = await created();
    const key = fake.keys[0]!;
    const { lines, report } = reporter();
    const outcome = await open().provider.destroy(machine, { deleteKey: false }, report);
    expect(writes()).toEqual(["DELETE /droplets/:id", "DELETE /firewalls/:id", "DELETE /tags/sitesolide-machine:web", `DELETE /tags/sitesolide-key:${key.id}`]);
    expect(outcome.removed).toEqual([`droplet web (${machine.ipv4}, ${machine.ipv6})`, "firewall sitesolide-web", "tag sitesolide-machine:web", `tag sitesolide-key:${key.id}`]);
    expect(outcome.kept).toEqual(["SSH key sitesolide-web: other machines may be created with it; --delete-key deletes it"]);
    expect({ droplets: fake.droplets.length, firewalls: fake.firewalls.length, keys: fake.keys.length }).toEqual({ droplets: 0, firewalls: 0, keys: 1 });
    // The tag every machine carries stays for the others.
    expect([...fake.tags]).toEqual(["managed-by:sitesolide"]);
    expect(lines).toContain("   sitesolide-web: kept, other machines may be created with it");
  });

  test("--delete-key deletes the key uploaded for it, and only that one", async () => {
    fake.addKey({ name: "my other laptop", public_key: otherKey(3) });
    const machine = await created();
    const outcome = await open().provider.destroy(machine, { deleteKey: true }, reporter().report);
    expect(outcome.removed).toContain("SSH key sitesolide-web");
    expect(fake.keys.map((key) => key.name)).toEqual(["my other laptop"]);
  });

  test("--delete-key never deletes a key the account held before", async () => {
    fake.addKey({ name: "sitesolide-web-but-mine", public_key: ED25519 });
    const machine = await created();
    const { lines, report } = reporter();
    const outcome = await open().provider.destroy(machine, { deleteKey: true }, report);
    expect(writes()).not.toContain("DELETE /account/keys/:id");
    expect(fake.keys.length).toBe(1);
    expect(outcome.removed.some((line) => line.startsWith("SSH key"))).toBe(false);
    expect(lines).toContain("   none was uploaded for web: the key it used was already in the account");
  });

  test("keeps a firewall still applied elsewhere, and the tag it names", async () => {
    const machine = await created();
    fake.addDroplet({ name: "web-copy", tags: ["sitesolide-machine:web"] });
    const outcome = await open().provider.destroy(machine, { deleteKey: false }, reporter().report);
    expect(outcome.kept).toContain("firewall sitesolide-web: still applied to droplet web-copy");
    expect(outcome.kept.some((line) => line.startsWith("tag sitesolide-machine:web:"))).toBe(true);
    expect(writes()).not.toContain("DELETE /firewalls/:id");
    expect(writes()).not.toContain("DELETE /tags/sitesolide-machine:web");
  });

  test("never touches a firewall of that name sitesolide did not create", async () => {
    const ours = fake.addDroplet({ name: "web", tags: MANAGED });
    fake.addFirewall({ name: "sitesolide-web", tags: ["prod"] });
    const machine = (await open().provider.find("web"))!;
    expect(machine.id).toBe(String(ours.id));
    fake.requests.length = 0;
    const { lines, report } = reporter();
    await open().provider.destroy(machine, { deleteKey: true }, report);
    // The machine's tag goes once nothing carries it: that firewall does not name it.
    expect(writes()).toEqual(["DELETE /droplets/:id", "DELETE /tags/sitesolide-machine:web"]);
    expect(fake.firewalls.length).toBe(1);
    expect(lines).toContain("   none created by sitesolide under that name");
  });

  test("refuses a droplet that does not carry managed-by:sitesolide, whatever it was given", async () => {
    const theirs = fake.addDroplet({ name: "web", tags: ["prod"] });
    const machine = (await open().provider.find("web"))!;
    const error = await refusal(open().provider.destroy({ ...machine, managed: true, id: String(theirs.id) }, { deleteKey: true }, reporter().report));
    expect(error.failure.error).toBe("machine-not-managed");
    expect(writes()).toEqual([]);
    expect(fake.droplets.length).toBe(1);
  });

  test("says which volumes and reserved IPs outlive the droplet, billed, and never deletes them", async () => {
    const machine = await created();
    const droplet = fake.droplets[0]!;
    droplet.volume_ids = ["506f78a4-e098-11e5-ad9f-000f53306ae1"];
    fake.addReservedIp({ ip: "198.51.100.7", region: "fra1", droplet: droplet.id });
    fake.addReservedIp({ ip: "2001:db8:ffff::1", region: "fra1", droplet: droplet.id });
    fake.addReservedIp({ ip: "198.51.100.8", region: "fra1", droplet: null });
    const { lines, report } = reporter();
    const outcome = await open().provider.destroy(machine, { deleteKey: false }, report);
    expect(outcome.kept.slice(0, 3)).toEqual([
      "volume 506f78a4-e098-11e5-ad9f-000f53306ae1: detached from web and kept with its data, billed until it is deleted from the control panel, Volumes",
      "reserved IP 198.51.100.7: unassigned from web and kept, billed while it is unassigned, until it is released from the control panel, Networking, Reserved IPs",
      "reserved IP 2001:db8:ffff::1: unassigned from web and kept, billed while it is unassigned, until it is released from the control panel, Networking, Reserved IPs",
    ]);
    expect(outcome.kept.some((line) => line.includes("198.51.100.8"))).toBe(false);
    expect(lines).toContain("!! reserved IP 198.51.100.7: unassigned, kept, and still billed");
    expect(writes().filter((line) => !line.startsWith("DELETE /droplets/") && !line.startsWith("DELETE /firewalls/") && !line.startsWith("DELETE /tags/"))).toEqual([]);
    expect(fake.reservedIps.map((address) => address.droplet)).toEqual([null, null, null]);
    // Read before the droplet went, both lists.
    const order = fake.requests.map((received) => `${received.method} ${shape(received.path)}`);
    expect(order.indexOf("GET /reserved_ips")).toBeLessThan(order.indexOf("DELETE /droplets/:id"));
    expect(order.indexOf("GET /reserved_ipv6")).toBeLessThan(order.indexOf("DELETE /droplets/:id"));
  });

  test("a token that may not read the reserved IPs is said, and the rest goes on", async () => {
    const machine = await created();
    fake.fail("GET", /^\/reserved_ips$/, 403, "forbidden", "You do not have access for the attempted action.");
    const { lines, report } = reporter();
    const outcome = await open().provider.destroy(machine, { deleteKey: false }, report);
    expect(lines).toContain("!! could not read the reserved IPs (403): one assigned to web would stay, unassigned and billed (the token needs reserved_ip:read)");
    expect(outcome.removed[0]).toStartWith("droplet web");
  });

  test("says that the backups outlive the droplet", async () => {
    const machine = await created({ backups: true });
    const outcome = await open().provider.destroy(machine, { deleteKey: false }, reporter().report);
    expect(outcome.kept[0]).toStartWith("backups of web: DigitalOcean keeps them until their retention ends, seven days for daily ones");
  });

  test("a droplet that takes long to go is said, and the rest goes on", async () => {
    const machine = await created();
    fake.settings.gonePolls = 1_000_000;
    const { lines, report } = reporter();
    const outcome = await open().provider.destroy(machine, { deleteKey: false }, report);
    expect(lines).toContain(`!! DigitalOcean still shows the droplet web after ${WAITS.goneMs / 60_000} minutes: it goes on its own, the console shows when`);
    expect(outcome.removed).toContain("firewall sitesolide-web");
  });
});

// --- the API's answers ---------------------------------------------------------------------------

describe("the API's errors", () => {
  const now = Date.parse("2026-10-21T10:00:00Z");
  const said = (status: number, id: string, message = `the API says ${id}`, headers: Record<string, string> = {}) =>
    failureFrom(status, { id, message, request_id: "4d9d8375-3c56-4925-a3e7-eb137fed17e9" }, new Headers(headers), "create the droplet web", now).failure;

  test("each status gets its own code, which hints.ts knows", () => {
    const cases: [number, string, string, string][] = [
      [400, "bad_request", "error parsing request body", "provider-invalid"],
      [401, "unauthorized", "Unable to authenticate you", "provider-unauthenticated"],
      [403, "forbidden", "You do not have access for the attempted action.", "provider-forbidden"],
      [403, "forbidden", "You have reached your droplet limit", "provider-limit"],
      [404, "not_found", "The resource you were accessing could not be found.", "provider-not-found"],
      [409, "conflict", "The request could not be completed due to a conflict.", "provider-busy"],
      [422, "unprocessable_entity", "Droplet already has a pending event.", "provider-busy"],
      [422, "unprocessable_entity", "SSH Key is already in use on your account", "provider-name-taken"],
      [422, "unprocessable_entity", "creating this/these droplet(s) will exceed your droplet limit", "provider-limit"],
      [422, "unprocessable_entity", "Size is not available in this region.", "provider-invalid"],
      [429, "too_many_requests", "API Rate limit exceeded.", "provider-rate-limited"],
      [500, "server_error", "Unexpected server-side error", "provider-failure"],
      [503, "service_unavailable", "Service Unavailable", "provider-failure"],
    ];
    for (const [status, id, message, ours] of cases) {
      const failure = said(status, id, message);
      expect({ status, message, ours: failure.error }).toEqual({ status, message, ours });
      expect(Object.hasOwn(REMOTE_HINTS, failure.error)).toBe(true);
      expect(failure.details).toContain("DigitalOcean's request id, for its support: 4d9d8375-3c56-4925-a3e7-eb137fed17e9");
    }
  });

  test("a 401 says the token was refused, in a way that never repeats it", () => {
    const failure = said(401, "unauthorized");
    expect(failure.message).toBe("DigitalOcean refused the token (401 unauthorized): it is unknown, revoked, expired, or was copied wrong");
    expect(failure.details?.join(" ")).toContain("Generate New Token");
  });

  test("a 429 waits what Retry-After says, else until the oldest request expires, a minute at most", () => {
    expect(said(429, "too_many_requests", "API Rate limit exceeded.", { "retry-after": "29", "ratelimit-reset": String(now / 1000 + 900) }).wait).toBe(29);
    const hourly = said(429, "too_many_requests", "API Rate limit exceeded.", { "ratelimit-limit": "5000", "ratelimit-remaining": "0", "ratelimit-reset": String(now / 1000 + 900) });
    expect(hourly.wait).toBe(60);
    expect(hourly.details).toContain("the oldest request counted expires in 900 s");
    expect(said(429, "too_many_requests", "API Rate limit exceeded.", { "ratelimit-reset": String(now / 1000 + 4) }).wait).toBe(4);
  });

  test("the tags' own error format is read too", () => {
    const failure = failureFrom(400, { error: 'Error validating resource tag: "tag-name contains invalid characters"', messages: null, root_causes: [] }, new Headers(), "create the tag x", now).failure;
    expect(failure).toMatchObject({ error: "provider-invalid", message: 'DigitalOcean refused to create the tag x (400): Error validating resource tag: "tag-name contains invalid characters"' });
  });

  test("an order refused for its size or region is the offer, anything else is not", () => {
    const refused = (message: string) => failureFrom(422, { id: "unprocessable_entity", message }, new Headers(), "create the droplet web", now);
    expect(refusesTheOffer(refused("Size is not available in this region."))).toBe(true);
    expect(refusesTheOffer(refused("Region is currently unavailable"))).toBe(true);
    expect(refusesTheOffer(refused("Name is invalid"))).toBe(false);
    expect(refusesTheOffer(failureFrom(500, { id: "server_error", message: "region down" }, new Headers(), "x", now))).toBe(false);
    expect(refused("x")).toBeInstanceOf(DigitalOceanError);
  });

  test("an answer that is not the API's is said so, a refused token too, through the provider", async () => {
    const unreadable = await refusal(open({ fetcher: async () => new Response("<html>login</html>", { status: 200 }) }).provider.list());
    expect(unreadable.failure.error).toBe("provider-unreadable");
    const unreachable = await refusal(open({ fetcher: async () => Promise.reject(new TypeError("Unable to connect")) }).provider.list());
    expect(unreachable.failure.error).toBe("provider-unreachable");
    const wrong = await refusal(open({ credentials: { DIGITALOCEAN_TOKEN: `dop_v1_${"9".repeat(64)}` } }).provider.list());
    expect(wrong.failure.error).toBe("provider-unauthenticated");
  });
});

describe("pagination", () => {
  test("reads the page number of the next link and asks the API's own address for it", async () => {
    for (let seed = 1; seed <= 5; seed++) fake.addDroplet({ name: `m${seed}`, tags: ["managed-by:sitesolide", `sitesolide-machine:m${seed}`] });
    const before = fetched.length;
    expect((await open().provider.list()).length).toBe(5);
    const asked = fetched.slice(before);
    expect(asked.length).toBe(3);
    expect(asked.every((address) => address.startsWith(fake.url))).toBe(true);
    expect(asked.some((address) => address.startsWith(LINK_ORIGIN))).toBe(false);
  });

  test("a next link that names no further page is refused, rather than taken for the end", async () => {
    fake.fail("GET", /^\/regions$/, 200, "", "", { body: { regions: [], links: { pages: { next: `${LINK_ORIGIN}/v2/regions?page=1` } }, meta: { total: 9 } } });
    const error = await refusal(open().provider.locations());
    expect(error.failure.error).toBe("provider-unreadable");
  });
});

// --- the wizard ---------------------------------------------------------------------------------

describe("what the wizard offers", () => {
  test("the regions that take droplets, the default first, with their country", async () => {
    const locations = await open().provider.locations();
    expect(locations[0]).toEqual({ value: "fra1", label: "Frankfurt 1, DE" });
    expect(locations.map((location) => location.value)).toEqual(["fra1", "ams3", "lon1", "nyc3", "sgp1"]);
    expect(locations.find((location) => location.value === "ams3")?.label).toBe("Amsterdam 3, NL");
    expect(writes()).toEqual([]);
  });

  test("the sizes sold there with 2 GB at least, the default first, then the cheapest", async () => {
    const types = await open().provider.types("fra1");
    expect(types[0]).toEqual({ value: "s-1vcpu-2gb", label: "s-1vcpu-2gb", hint: "1 vCPU, 2 GB RAM, 50 GB disk, Basic, 12.00 USD a month before VAT" });
    expect(types.map((type) => type.value)).toEqual(["s-1vcpu-2gb", "s-2vcpu-2gb", "s-2vcpu-4gb", "c-2", "s-4vcpu-8gb", "g-2vcpu-8gb"]);
    expect((await open().provider.types("nyc3")).map((type) => type.value)).toContain("s-1vcpu-2gb-amd");
    expect((await open().provider.types("nyc3")).map((type) => type.value)).not.toContain("gpu-h100x1-80gb");
    expect(writes()).toEqual([]);
  });
});

describe("what the answers mean", () => {
  test("an IPv6 address belongs to the /124 DigitalOcean routes to the droplet", () => {
    expect(ipv6Block("2001:db8:4b::4d8:a001")).toBe("2001:db8:4b::4d8:a000/124");
    expect(ipv6Block("2604:a880:0:1010::18a:a00f")).toBe("2604:a880:0:1010::18a:a000/124");
    expect(ipv6Block("2a03:b0c0:3:d0:0:0:1:5001")).toBe("2a03:b0c0:3:d0::1:5000/124");
    expect(ipv6Block("2001:db8::")).toBe("2001:db8::/124");
    expect(ipv6Block(null)).toBeNull();
    expect(ipv6Block("203.0.113.10")).toBeNull();
    expect(ipv6Block("2001:db8::1::2")).toBeNull();
  });

  test("tags read as labels", () => {
    expect(labelsOfTags(["managed-by:sitesolide", "sitesolide-machine:web", "prod"])).toEqual({ "managed-by": "sitesolide", "sitesolide-machine": "web", prod: "" });
    expect(labelsOfTags(null)).toEqual({});
  });
});

// --- last ------------------------------------------------------------------------------------------

describe("the token", () => {
  test("travels in the Authorization header alone, never in an address, a line or a refusal", () => {
    expect(fake.requests.length).toBe(0);
    expect(fetched.length).toBeGreaterThan(50);
    for (const address of fetched) expect(address).not.toContain(FAKE_TOKEN);
    for (const line of printed) expect(line).not.toContain(FAKE_TOKEN);
    expect(printed.length).toBeGreaterThan(100);
  });
});
