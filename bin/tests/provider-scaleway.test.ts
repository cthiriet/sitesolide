import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REMOTE_HINTS } from "../cli/hints";
import { ProviderError, type CreateRequest, type Provider, type ProviderContext, type PublicKey, type Report, type Workstation } from "../cli/providers/provider";
import {
  BOOT_VOLUME_BYTES,
  DEFAULT_API,
  discover,
  failureFrom,
  fingerprintPrefix,
  INCOMPLETE,
  isKeyFor,
  keyOfTags,
  networkOf,
  neverStarted,
  SCALEWAY,
  SECURITY_GROUP_RULES,
  WAITS,
  ZONES,
  type ScalewayServer,
} from "../cli/providers/scaleway";
import type { Failure } from "../cli/remote";
import { createFakeScaleway, FAKE_PROJECT, FAKE_SECRET, LOCAL_IMAGES, OTHER_PROJECT, type FakeScaleway } from "./fake-scaleway";
import { REPO } from "./e2e/run";

/**
 * bin/cli/providers/scaleway.ts, through SCALEWAY.open, against the local fake
 * of Scaleway's APIs (fake-scaleway.ts): the real ones are never called. The
 * command around it, bin/cli/machine.ts, is covered with every other provider
 * by cli-machine-providers.test.ts.
 *
 * Whatever the path, the secret key must never appear in what the provider
 * says: every report line and every refusal of this file is added to
 * `printed`, read at the end, and every request to `fake.requests`.
 */

/** Generated for these tests with ssh-keygen; the private half was deleted at once. */
const KEY: PublicKey = {
  algorithm: "ssh-ed25519",
  blob: "AAAAC3NzaC1lZDI1NTE5AAAAICezpiOyiQWMYqOeL4S4OgE0T7Fq2bLHWUJ1afO4cczN",
  comment: "ada@workstation.test-zone.invalid",
  fingerprint: "a4:46:30:d5:fd:7e:1a:77:e5:ad:8d:21:4f:9a:3e:9e",
};
const LINE = `${KEY.algorithm} ${KEY.blob} ${KEY.comment}`;

/** Another key, for the project's other machines: any ed25519 blob of the right shape. */
function otherKey(seed: number): string {
  const name = Buffer.from("ssh-ed25519");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(name.length);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(32);
  return `ssh-ed25519 ${Buffer.concat([head, name, size, Buffer.alloc(32, seed)]).toString("base64")} other-${seed}`;
}

let fake: FakeScaleway;
/** Everything the provider said in this file, read by the last test. */
const printed: string[] = [];

beforeAll(() => {
  fake = createFakeScaleway();
});
afterAll(() => fake.stop());
beforeEach(() => fake.reset());

function fakeClock() {
  let now = Date.parse("2026-10-21T10:00:00Z");
  return { now: () => now, sleep: async (milliseconds: number) => void (now += milliseconds) };
}

function open(extra: Partial<ProviderContext> = {}): { provider: Provider; clock: ReturnType<typeof fakeClock> } {
  const clock = fakeClock();
  const provider = SCALEWAY.open({
    credentials: { SCW_SECRET_KEY: FAKE_SECRET, SCW_DEFAULT_PROJECT_ID: FAKE_PROJECT },
    environment: { SITESOLIDE_SCALEWAY_API: fake.url },
    fetcher: (input, init) => fetch(input, init),
    clock,
    secret: () => {},
    ...extra,
  });
  return { provider, clock };
}

function order(overrides: Partial<CreateRequest> = {}): CreateRequest {
  return { name: "web", ...SCALEWAY.defaults({}), backups: false, key: KEY, ...overrides };
}

const say: Report = (line) => void printed.push(line);

async function create(provider: Provider, overrides: Partial<CreateRequest> = {}) {
  const lines: string[] = [];
  const outcome = await provider.create(order(overrides), (line) => {
    lines.push(line);
    printed.push(line);
  });
  return { outcome, lines };
}

/** The refusal a call ends with; it must be a ProviderError whose code hints.ts knows. */
async function refusal(promise: Promise<unknown>): Promise<Failure> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    printed.push(error.failure.message, ...(error.failure.details ?? []));
    expect(Object.hasOwn(REMOTE_HINTS, error.failure.error)).toBe(true);
    return error.failure;
  }
  throw new Error("expected a refusal");
}

const shape = (path: string) => path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":id");

/** The requests that changed something, as `METHOD /path`. */
function writes(): string[] {
  return fake.requests.filter((request) => request.method !== "GET").map((request) => `${request.method} ${shape(request.path)}`);
}

function bodyOf(method: string, pattern: RegExp): Record<string, unknown> {
  const found = fake.requests.find((request) => request.method === method && pattern.test(request.path));
  if (found === undefined) throw new Error(`no ${method} ${pattern}`);
  return found.body as Record<string, unknown>;
}

const OURS = (name: string) => ["managed-by:sitesolide", `sitesolide-machine:${name}`];

// --- the entry --------------------------------------------------------------------------------

describe("the entry", () => {
  test("names its credentials, its defaults and its page", () => {
    expect(SCALEWAY).toMatchObject({ name: "scaleway", title: "Scaleway", apiVariable: "SITESOLIDE_SCALEWAY_API", backups: false, docs: "docs/providers/scaleway.md" });
    expect(existsSync(join(REPO, SCALEWAY.docs))).toBe(true);
    expect(SCALEWAY.credentials.map((field) => [field.variable, field.secret])).toEqual([
      ["SCW_SECRET_KEY", true],
      ["SCW_DEFAULT_PROJECT_ID", false],
    ]);
    for (const field of SCALEWAY.credentials) {
      expect(field.shape.test(FAKE_SECRET)).toBe(true);
      expect(field.shape.test("SCWXXXXXXXXXXXXXXXXX")).toBe(false);
    }
    expect(SCALEWAY.defaults({})).toEqual({ type: "DEV1-S", location: "fr-par-1", image: "debian-13" });
    expect(SCALEWAY.credentialHelp.join(" ")).toContain("InstancesFullAccess, BlockStorageFullAccess and SSHKeysFullAccess");
  });

  test("Scaleway's address by default; another only over https, or http on the loopback", async () => {
    const seen: string[] = [];
    const recording = async (input: string) => {
      seen.push(input);
      return Response.json({ servers: {} }, { headers: { "X-Total-Count": "0" } });
    };
    const { provider } = open({ environment: {}, fetcher: recording });
    await provider.types("fr-par-1");
    expect(seen[0]).toStartWith(`${DEFAULT_API}/instance/v1/zones/fr-par-1/products/servers?`);
    for (const refused of ["http://api.test-zone.invalid", "https://user:secret@api.test-zone.invalid", "https://api.test-zone.invalid/?x=1"]) {
      expect(() => open({ environment: { SITESOLIDE_SCALEWAY_API: refused } })).toThrow(ProviderError);
    }
  });

  test("credentials of the wrong shape are refused before anything leaves, without being repeated", () => {
    try {
      open({ credentials: { SCW_SECRET_KEY: "not-a-key", SCW_DEFAULT_PROJECT_ID: FAKE_PROJECT } });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).failure.error).toBe("no-provider-token");
      expect(JSON.stringify((error as ProviderError).failure)).not.toContain("not-a-key");
    }
    expect(fake.requests).toEqual([]);
  });
});

// --- the pieces -------------------------------------------------------------------------------

describe("what the answers mean", () => {
  test("the /64 of a machine's IPv6 address, as DNS and the firewall name it", () => {
    expect(networkOf("2001:bc8:710:7074:dc00:ff:fed1:458b", "64")).toBe("2001:bc8:710:7074::/64");
    expect(networkOf("2001:0db8:000b:004d:dc00:ff:fe0c:d0e", "64")).toBe("2001:db8:b:4d::/64");
    expect(networkOf("2001:db8::1", "64")).toBe("2001:db8:0:0::/64");
    expect(networkOf("2001:db8::1", "128")).toBeNull();
    expect(networkOf("203.0.113.10", "64")).toBeNull();
  });

  test("a stopped server untouched since its order was never started; one stopped since was", () => {
    const base: ScalewayServer = { id: "1", name: "web", commercial_type: "DEV1-S", zone: "fr-par-1", state: "stopped", tags: [], allowed_actions: ["poweron", "backup"] };
    const at = "2026-10-21T10:00:00.000000+00:00";
    expect(neverStarted({ ...base, state: "stopped", creation_date: at, modification_date: at })).toBe(true);
    expect(neverStarted({ ...base, state: "stopped", creation_date: at, modification_date: "2026-10-21T10:00:02.000000+00:00" })).toBe(false);
    expect(neverStarted({ ...base, state: "running", creation_date: at, modification_date: at })).toBe(false);
    expect(neverStarted({ ...base, state: "stopped", creation_date: null, modification_date: null })).toBe(false);
  });

  test("the names create gives the keys it uploads: the plain one, or the plain one and that key's own fingerprint", () => {
    expect(fingerprintPrefix(LINE)).toBe("a44630d5");
    expect(isKeyFor({ name: "sitesolide-web", public_key: otherKey(1) }, "web")).toBe(true);
    expect(isKeyFor({ name: "sitesolide-web-a44630d5", public_key: LINE }, "web")).toBe(true);
    // Eight hex digits of another key's fingerprint, or another machine's plain name, are not this machine's.
    expect(isKeyFor({ name: "sitesolide-web-a44630d5", public_key: otherKey(1) }, "web")).toBe(false);
    expect(isKeyFor({ name: "sitesolide-web-20261021", public_key: otherKey(1) }, "web")).toBe(false);
    expect(isKeyFor({ name: "sitesolide-web2", public_key: LINE }, "web")).toBe(false);
    expect(isKeyFor({ name: "laptop", public_key: LINE }, "web")).toBe(false);
  });

  test("the key a server's tag names", () => {
    expect(keyOfTags(["managed-by:sitesolide", "sitesolide-machine:web", "sitesolide-key:k1"])).toBe("k1");
    expect(keyOfTags(["managed-by:sitesolide"])).toBeNull();
    expect(keyOfTags(["sitesolide-key:"])).toBeNull();
  });
});

describe("the API's errors", () => {
  const said = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) => failureFrom(status, body, new Headers(headers), "create the server web").failure;

  test("each error gets its code, which hints.ts knows, the error's type before the status", () => {
    const cases: [number, Record<string, unknown>, string][] = [
      [401, { message: "authentication is denied", method: "api_key", reason: "invalid_argument", type: "denied_authentication" }, "provider-unauthenticated"],
      [403, { message: "insufficient permissions", type: "permissions_denied", details: [{ resource: "instance_server", action: "write" }] }, "provider-forbidden"],
      [403, { message: "quota(s) exceeded for this resource", type: "quotas_exceeded", details: [{ resource: "instances_dev1_s", quota: 2, current: 2 }] }, "provider-limit"],
      [400, { message: "Quota exceeded for this resource", type: "invalid_request_error", resource: "compute_dev1_s" }, "provider-limit"],
      [503, { message: "No more stock", type: "out_of_stock", resource: "DEV1-S" }, "provider-unavailable"],
      [404, { message: "resource is not found", type: "not_found", resource: "instance_server", resource_id: "x" }, "provider-not-found"],
      [404, { message: '"x" not found', type: "unknown_resource" }, "provider-not-found"],
      [409, { message: "resource is in a transient state", type: "transient_state", resource: "instance_server", current_state: "starting" }, "provider-busy"],
      [403, { message: "resource is locked", type: "locked", resource: "instance_server" }, "provider-invalid"],
      [412, { message: "precondition is not respected", type: "precondition_failed", precondition: "resource_still_in_use", help_message: "the volume must be detached" }, "provider-invalid"],
      [400, { message: "unknown zone in path" }, "provider-invalid"],
      [429, { message: "rate limit exceeded", type: "too_many_requests" }, "provider-rate-limited"],
      [500, { message: "Internal error", type: "internal_server_error" }, "provider-failure"],
    ];
    for (const [status, body, ours] of cases) {
      const failure = said(status, body);
      expect({ status, type: body.type, ours: failure.error }).toEqual({ status, type: body.type, ours });
      expect(Object.hasOwn(REMOTE_HINTS, failure.error)).toBe(true);
    }
  });

  test("a 401 says the secret key was refused, in a way that never repeats it", () => {
    const failure = said(401, { message: "authentication is denied", type: "denied_authentication" });
    expect(failure.message).toBe("Scaleway refused the secret key (401 denied_authentication): it is unknown, revoked, expired, or was copied wrong");
  });

  test("the refused arguments, quotas and permissions are listed, in each of the API's shapes", () => {
    expect(said(400, { message: "invalid argument(s)", type: "invalid_arguments", details: [{ argument_name: "commercial_type", reason: "constraint", help_message: "unknown commercial type" }] }).details).toEqual([
      "commercial_type: constraint, unknown commercial type",
    ]);
    expect(said(400, { message: "Validation Error", type: "invalid_request_error", fields: { name: ["required key not provided"] } }).details).toEqual(["name: required key not provided"]);
    expect(said(403, { message: "quota(s) exceeded", type: "quotas_exceeded", details: [{ resource: "instances_dev1_s", quota: 2, current: 2 }] }).details?.[0]).toBe("instances_dev1_s: 2 used of 2");
    expect(said(403, { message: "insufficient permissions", type: "permissions_denied", details: [{ resource: "volume", action: "write" }] }).details).toEqual([
      "volume: write not allowed",
      "the key's policy needs InstancesFullAccess, BlockStorageFullAccess and SSHKeysFullAccess on the project",
    ]);
  });

  test("a 429 names the limit by its number, as Scaleway writes it with a policy after", () => {
    expect(said(429, { type: "too_many_requests" }, { "X-RateLimit-Limit": "50, 50;w=1" }).details).toEqual(["the limit is 50 requests a second"]);
    expect(said(429, { type: "too_many_requests" }, { "X-RateLimit-Limit": "w=1" }).details).toEqual(["the limit is about 50 requests a second"]);
  });

  test("a 429 says how long to wait: Retry-After, else the limit's reset", () => {
    expect(said(429, { type: "too_many_requests" }, { "Retry-After": "7" }).wait).toBe(7);
    expect(said(429, { type: "too_many_requests" }, { "X-RateLimit-Limit": "50, 50;w=1", "X-RateLimit-Reset": "1" }).wait).toBe(1);
    expect(said(429, {}).wait).toBe(60);
  });
});

// --- create -------------------------------------------------------------------------------------

describe("create", () => {
  test("an empty project: everything read first, then key, security group, addresses, server, volume tag, power-on", async () => {
    for (const seed of [1, 2, 3]) fake.addKey({ name: `laptop-${seed}`, public_key: otherKey(seed) });
    const { provider } = open();
    const { outcome } = await create(provider);

    expect(writes()).toEqual([
      "POST /iam/v1alpha1/ssh-keys",
      "POST /instance/v1/zones/fr-par-1/security_groups",
      "PUT /instance/v1/zones/fr-par-1/security_groups/:id/rules",
      "POST /instance/v1/zones/fr-par-1/ips",
      "POST /instance/v1/zones/fr-par-1/ips",
      "POST /instance/v1/zones/fr-par-1/servers",
      "PATCH /block/v1alpha1/zones/fr-par-1/volumes/:id",
      "POST /instance/v1/zones/fr-par-1/servers/:id/action",
    ]);
    const first = fake.requests.findIndex((request) => request.method !== "GET");
    const reads = fake.requests.slice(0, first).map((request) => shape(request.path));
    // Every zone searched for the name, then the catalogue, the stock, the image, the group, the addresses, the keys.
    for (const { zone } of ZONES) expect(reads).toContain(`/instance/v1/zones/${zone}/servers`);
    for (const path of [
      "/instance/v1/zones/fr-par-1/products/servers",
      "/instance/v1/zones/fr-par-1/products/servers/availability",
      "/marketplace/v2/local-images",
      "/instance/v1/zones/fr-par-1/security_groups",
      "/instance/v1/zones/fr-par-1/ips",
      "/iam/v1alpha1/ssh-keys",
    ]) {
      expect(reads).toContain(path);
    }
    const image = new URLSearchParams(fake.requests.find((request) => request.path === "/marketplace/v2/local-images")!.search);
    expect(Object.fromEntries(["image_label", "zone", "type", "arch"].map((key) => [key, image.get(key)]))).toEqual({ image_label: "debian_trixie", zone: "fr-par-1", type: "instance_sbs", arch: "x86_64" });

    expect(bodyOf("POST", /ssh-keys$/)).toEqual({ name: "sitesolide-web", public_key: LINE, project_id: FAKE_PROJECT });
    expect(bodyOf("POST", /security_groups$/)).toEqual({
      name: "sitesolide-web",
      description: "sitesolide: inbound ssh, http, https and ping, the rest dropped",
      project: FAKE_PROJECT,
      tags: OURS("web"),
      stateful: true,
      inbound_default_policy: "drop",
      outbound_default_policy: "accept",
    });
    expect(bodyOf("PUT", /rules$/)).toEqual({ rules: SECURITY_GROUP_RULES });
    expect(SECURITY_GROUP_RULES.map((rule) => `${rule.ip_range} ${rule.protocol} ${rule.dest_port_from ?? "-"}`)).toEqual([
      "0.0.0.0/0 TCP 22",
      "0.0.0.0/0 TCP 80",
      "0.0.0.0/0 TCP 443",
      "0.0.0.0/0 ICMP -",
      "::/0 TCP 22",
      "::/0 TCP 80",
      "::/0 TCP 443",
      "::/0 ICMP -",
    ]);
    expect(SECURITY_GROUP_RULES.every((rule) => rule.action === "accept" && rule.direction === "inbound")).toBe(true);
    const reservations = fake.requests.filter((request) => request.method === "POST" && request.path.endsWith("/ips")).map((request) => request.body);
    expect(reservations).toEqual([
      { project: FAKE_PROJECT, type: "routed_ipv4", tags: OURS("web") },
      { project: FAKE_PROJECT, type: "routed_ipv6", tags: OURS("web") },
    ]);
    const [ipv4, ipv6] = fake.ips;
    const group = fake.groups[0]!;
    expect(bodyOf("POST", /\/servers$/)).toEqual({
      name: "web",
      commercial_type: "DEV1-S",
      image: LOCAL_IMAGES.find((candidate) => candidate.zone === "fr-par-1" && candidate.arch === "x86_64")!.id,
      volumes: { "0": { volume_type: "sbs_volume", size: BOOT_VOLUME_BYTES } },
      dynamic_ip_required: false,
      public_ips: [ipv4!.id, ipv6!.id],
      project: FAKE_PROJECT,
      tags: [...OURS("web"), `sitesolide-key:${fake.keys.find((key) => key.name === "sitesolide-web")!.id}`],
      security_group: group.id,
    });
    expect(bodyOf("PATCH", /volumes/)).toEqual({ tags: OURS("web") });
    expect(bodyOf("POST", /action$/)).toEqual({ action: "poweron" });

    const server = fake.servers[0]!;
    expect(fake.volumes.map((volume) => ({ size: volume.size, tags: volume.tags }))).toEqual([{ size: BOOT_VOLUME_BYTES, tags: OURS("web") }]);
    expect(outcome.created).toBe(true);
    expect(outcome.machine).toMatchObject({
      provider: "scaleway",
      id: server.id,
      name: "web",
      type: "DEV1-S",
      location: "fr-par-1",
      status: "running",
      ipv4: ipv4!.address,
      backups: false,
      managed: true,
      labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" },
      login: "root",
      monthlyPrice: { net: "6.5525", currency: "EUR" },
    });
    expect(outcome.machine.ipv6).toStartWith(ipv6!.prefix!.replace("::/64", ":"));
    expect(outcome.machine.ipv6Network).toBe(ipv6!.prefix);
    expect(outcome.resources.map((resource) => [resource.kind, resource.name, resource.reused])).toEqual([
      ["ssh key", "sitesolide-web", false],
      ["security group", "sitesolide-web", false],
      ["ipv4", ipv4!.address!, false],
      ["ipv6", ipv6!.prefix!, false],
      ["server", "web", false],
    ]);
  });

  test("the steps say what they do, the price included", async () => {
    const { provider } = open();
    const { lines } = await create(provider);
    expect(lines).toContain("-> DEV1-S at fr-par-1, what Scaleway sells there");
    expect(lines).toContain("   2 vCPU, 2 GB RAM, x86_64, 6.55 EUR a month before VAT, plus the storage and the IPv4 address");
    expect(lines).toContain(`   sitesolide-web, uploaded (${KEY.fingerprint})`);
    expect(lines).toContain("   40 GB of Block Storage, tagged managed-by:sitesolide");
    expect(lines).toContain("   state: running (booting kernel)");
  });

  test("a second run finds the machine and writes nothing", async () => {
    const { provider } = open();
    await create(provider);
    const before = writes();
    const again = await create(open().provider);
    expect(again.outcome.created).toBe(false);
    expect(again.outcome.resources).toEqual([{ kind: "server", name: "web", id: fake.servers[0]!.id, reused: true }]);
    expect(again.outcome.machine.status).toBe("running");
    expect(writes()).toEqual(before);
    expect(again.lines).toContain("   already created by sitesolide: DEV1-S at fr-par-1, running");
  });

  test("a key the project holds under another name is reused, and a taken name gets the fingerprint", async () => {
    fake.addKey({ name: "laptop", public_key: `${KEY.algorithm} ${KEY.blob} another comment` });
    const reused = await create(open().provider);
    expect(writes().filter((write) => write.includes("ssh-keys"))).toEqual([]);
    expect(reused.outcome.resources[0]).toMatchObject({ kind: "ssh key", name: "laptop", reused: true });

    fake.reset();
    fake.addKey({ name: "sitesolide-web", public_key: otherKey(7) });
    await create(open().provider);
    expect(bodyOf("POST", /ssh-keys$/)).toMatchObject({ name: "sitesolide-web-a44630d5" });
  });

  test("an arm type gets the arm image of its zone", async () => {
    await create(open().provider, { type: "BASIC2-A2C-4G" });
    expect(bodyOf("POST", /\/servers$/).image).toBe(LOCAL_IMAGES.find((candidate) => candidate.zone === "fr-par-1" && candidate.arch === "arm64")!.id);
  });

  test("a run interrupted after the order is finished by the next: the volume tagged, the server started", async () => {
    fake.fail("PATCH", /\/volumes\//, 403, { message: "insufficient permissions", type: "permissions_denied", details: [{ resource: "volume", action: "write" }] });
    const failure = await refusal(open().provider.create(order(), say));
    expect(failure.error).toBe("provider-forbidden");
    expect(fake.servers[0]).toMatchObject({ name: "web", state: "stopped" });

    const again = await create(open().provider);
    expect(again.outcome).toMatchObject({ created: false, machine: { status: "running" } });
    expect(again.lines).toContain("   never started: the run that ordered it stopped before");
    expect(fake.volumes[0]!.tags).toEqual(OURS("web"));
  });

  test("a server sitesolide created and its owner stopped is left as it is", async () => {
    fake.addServer({ name: "web", tags: OURS("web"), state: "stopped", state_detail: "" });
    const failure = await refusal(open().provider.create(order(), say));
    expect(failure.error).toBe("machine-off");
    expect(writes()).toEqual([]);
  });

  test("no stock to start it: the server stays, stopped, and the next run starts it", async () => {
    fake.settings.refuseStart = true;
    const failure = await refusal(open().provider.create(order(), say));
    expect(failure.error).toBe("type-unavailable");
    expect(failure.message).toStartWith("Scaleway created web but has no DEV1-S to start it on at fr-par-1 right now (503 out_of_stock)");
    expect(failure.details?.at(-1)).toContain("sitesolide machine destroy web");
    expect(fake.servers[0]!.state).toBe("stopped");

    const again = await create(open().provider);
    expect(again.outcome.machine.status).toBe("running");
  });

  test("the wait for the server is bounded, and costs no real time", async () => {
    fake.settings.stuck = true;
    const { provider, clock } = open();
    const started = clock.now();
    const failure = await refusal(provider.create(order(), say));
    expect(failure.error).toBe("machine-timeout");
    expect(failure.message).toBe(`web is still not running after ${WAITS.runningMs / 60_000} minutes`);
    const waited = clock.now() - started;
    expect(waited).toBeGreaterThanOrEqual(WAITS.runningMs);
    expect(waited).toBeLessThan(WAITS.runningMs + 2 * WAITS.pollMs);
    const polls = fake.requests.filter((request) => request.method === "GET" && /\/servers\/[0-9a-f-]{36}$/.test(request.path)).length;
    expect(polls).toBeLessThanOrEqual(WAITS.runningMs / WAITS.pollMs + 2);
  });
});

describe("create refuses before anything is written", () => {
  test("a server of that name sitesolide did not create, in any zone", async () => {
    fake.addServer({ name: "web", zone: "nl-ams-1" });
    const failure = await refusal(open().provider.create(order(), say));
    expect(failure.error).toBe("machine-exists");
    expect(failure.details?.at(-1)).toBe("it lacks the tag managed-by:sitesolide: nothing was created, nothing was changed");
    expect(writes()).toEqual([]);
  });

  test("a namesake that only starts with the name is not one", async () => {
    fake.addServer({ name: "web2" });
    const { outcome } = await create(open().provider);
    expect(outcome.created).toBe(true);
  });

  test("two servers of that name, even both sitesolide's", async () => {
    fake.addServer({ name: "web", tags: OURS("web") });
    fake.addServer({ name: "web", tags: OURS("web"), zone: "nl-ams-1" });
    const failure = await refusal(open().provider.create(order(), say));
    expect(failure).toMatchObject({ error: "machine-exists", message: "2 servers are named web in the project: sitesolide does not choose between them" });
    expect(writes()).toEqual([]);
  });

  test("a security group of that name sitesolide did not create", async () => {
    fake.addGroup({ name: "sitesolide-web" });
    const failure = await refusal(open().provider.create(order(), say));
    expect(failure.error).toBe("firewall-taken");
    expect(writes()).toEqual([]);
  });

  test("a type the zone does not sell, or no longer sells, with the cheapest it does", async () => {
    const missing = await refusal(open().provider.create(order({ location: "nl-ams-3" }), say));
    expect(missing).toMatchObject({ error: "invalid-server-type", message: "DEV1-S is not a type Scaleway sells at nl-ams-3" });
    expect(missing.details?.[0]).toBe("the cheapest types Scaleway has in stock at nl-ams-3:");
    expect(missing.details?.[1]).toBe("PLAY2-PICO     1 vCPU, 2 GB RAM, x86_64, 10.42 EUR a month before VAT");
    const ended = await refusal(open().provider.create(order({ type: "START1-S" }), say));
    expect(ended).toMatchObject({ error: "invalid-server-type", message: "START1-S has reached its end of service at Scaleway" });
    expect(ended.details?.join("\n")).not.toContain("START1-S");
    expect(ended.details?.join("\n")).not.toContain("L4-1-24G");
    expect(writes()).toEqual([]);
  });

  test("a type out of stock there", async () => {
    const failure = await refusal(open().provider.create(order({ type: "PLAY2-PICO", location: "fr-par-2" }), say));
    expect(failure).toMatchObject({ error: "type-unavailable", message: "Scaleway lists PLAY2-PICO as out of stock at fr-par-2" });
    expect(failure.details).toContain("nothing had been created yet");
    expect(writes()).toEqual([]);
  });

  test("a scarce type is ordered all the same, after a warning", async () => {
    const { lines } = await create(open().provider, { type: "PLAY2-PICO" });
    expect(lines).toContain("!! Scaleway lists PLAY2-PICO as scarce at fr-par-1; trying anyway");
  });

  test("a zone sitesolide does not order in, before anything is asked", async () => {
    const failure = await refusal(open().provider.create(order({ location: "de-fra-1" }), say));
    expect(failure.error).toBe("invalid-location");
    expect(failure.details).toContain("fr-par-1  Paris 1, FR");
    expect(fake.requests).toEqual([]);
  });

  test("an image the Marketplace does not have for that type", async () => {
    const failure = await refusal(open().provider.create(order({ image: "macos" }), say));
    expect(failure).toMatchObject({ error: "provider-invalid", message: "Scaleway's Marketplace has no image macos for DEV1-S (x86_64) at fr-par-1" });
    expect(writes()).toEqual([]);
  });

  test("the workstation's key, disabled in the project", async () => {
    fake.addKey({ name: "laptop", public_key: LINE, disabled: true });
    const failure = await refusal(open().provider.create(order(), say));
    expect(failure).toMatchObject({ error: "provider-invalid", message: "the SSH key laptop is in the project but disabled: the machine would not accept it" });
    expect(writes()).toEqual([]);
  });

  test("--backups, which Scaleway has no schedule for", async () => {
    const failure = await refusal(open().provider.create(order({ backups: true }), say));
    expect(failure.error).toBe("provider-invalid");
    expect(fake.requests).toEqual([]);
  });
});

describe("a refused order", () => {
  test("is undone: what this run created is deleted, last first, and the refusal says so", async () => {
    fake.fail("POST", /\/servers$/, 503, { message: "No more stock for this server type", type: "out_of_stock", resource: "DEV1-S" });
    const failure = await refusal(open().provider.create(order(), say));
    expect(failure.error).toBe("type-unavailable");
    expect(failure.message).toBe("Scaleway would not create DEV1-S at fr-par-1 (503 out_of_stock): No more stock for this server type");
    expect(failure.details).toContain("or try another --location");
    expect(failure.details?.slice(-4)).toEqual([
      expect.stringMatching(/^deleted the IPv6 prefix 2001:db8:[0-9a-f:]+::\/64 this run had created$/),
      expect.stringMatching(/^deleted the IPv4 address 203\.0\.113\.\d+ this run had created$/),
      "deleted the security group sitesolide-web this run had created",
      "deleted the SSH key sitesolide-web this run had created",
    ]);
    expect(writes().slice(-4)).toEqual([
      "DELETE /instance/v1/zones/fr-par-1/ips/:id",
      "DELETE /instance/v1/zones/fr-par-1/ips/:id",
      "DELETE /instance/v1/zones/fr-par-1/security_groups/:id",
      "DELETE /iam/v1alpha1/ssh-keys/:id",
    ]);
    expect({ keys: fake.keys.length, ips: fake.ips.length, groups: fake.groups.length, servers: fake.servers.length }).toEqual({ keys: 0, ips: 0, groups: 0, servers: 0 });
  });

  test("leaves what an earlier run made, or the project held", async () => {
    fake.addKey({ name: "laptop", public_key: LINE });
    const earlier = fake.reserveIp({ tags: OURS("web") });
    fake.fail("POST", /\/servers$/, 403, { message: "quota(s) exceeded for this resource", type: "quotas_exceeded", details: [{ resource: "instances_dev1_s", quota: 1, current: 1 }] });
    const failure = await refusal(open().provider.create(order(), say));
    expect(failure.error).toBe("provider-limit");
    expect(failure.details).toContain("instances_dev1_s: 1 used of 1");
    expect(fake.keys.map((key) => key.name)).toEqual(["laptop"]);
    expect(fake.ips.map((ip) => ip.id)).toEqual([earlier.id]);
    expect(fake.groups).toEqual([]);
    // The next run reuses the address the earlier one reserved.
    const { outcome } = await create(open().provider);
    expect(outcome.resources.find((resource) => resource.kind === "ipv4")).toMatchObject({ id: earlier.id, reused: true });
  });

  test("a deletion that fails leaves the resource for the next run, and says so", async () => {
    fake.fail("POST", /\/servers$/, 400, { message: "Validation Error", type: "invalid_request_error", fields: { placement_group: ["not found"] } });
    fake.fail("DELETE", /\/ips\//, 500, { message: "Internal error", type: "internal_server_error" });
    const failure = await refusal(open().provider.create(order(), say));
    expect(failure.error).toBe("provider-invalid");
    expect(failure.details?.find((line) => line.startsWith("left the"))).toMatch(/^left the IPv6 prefix .*: the next run finds it and reuses it$/);
    expect(fake.ips.map((ip) => ip.type)).toEqual(["routed_ipv6"]);
  });
});

// --- list and find ------------------------------------------------------------------------------

describe("list and find", () => {
  test("list shows the project's servers tagged by sitesolide, in every zone, every page", async () => {
    for (const name of ["a", "b", "c"]) fake.addServer({ name, tags: OURS(name) });
    fake.addServer({ name: "d", tags: OURS("d"), zone: "nl-ams-1" });
    fake.addServer({ name: "theirs" });
    fake.addServer({ name: "elsewhere", tags: OURS("elsewhere"), project: OTHER_PROJECT });
    const machines = await open().provider.list();
    expect(machines.map((machine) => [machine.name, machine.location, machine.managed])).toEqual([
      ["a", "fr-par-1", true],
      ["b", "fr-par-1", true],
      ["c", "fr-par-1", true],
      ["d", "nl-ams-1", true],
    ]);
    expect(machines[0]!.monthlyPrice).toEqual({ net: "6.5525", gross: "6.5525", currency: "EUR" });
    const pages = fake.requests.filter((request) => request.path === "/instance/v1/zones/fr-par-1/servers").map((request) => new URLSearchParams(request.search));
    expect(pages.map((search) => search.get("page"))).toEqual(["1", "2"]);
    expect(pages[0]!.get("tags")).toBe("managed-by:sitesolide");
    expect(pages[0]!.get("project")).toBe(FAKE_PROJECT);
  });

  test("find returns the machine of that name, sitesolide's or not", async () => {
    fake.addServer({ name: "theirs", zone: "pl-waw-1" });
    expect(await open().provider.find("theirs")).toMatchObject({ name: "theirs", location: "pl-waw-1", managed: false });
    expect(await open().provider.find("nobody")).toBeNull();
  });
});

// --- destroy ------------------------------------------------------------------------------------

describe("destroy", () => {
  async function made(): Promise<{ provider: Provider; machine: Awaited<ReturnType<Provider["create"]>>["machine"] }> {
    const { outcome } = await create(open().provider);
    fake.requests.length = 0;
    return { provider: open().provider, machine: outcome.machine };
  }

  test("deletes the server, then its tagged volume, addresses and security group; keeps the key and what is not sitesolide's", async () => {
    const { provider, machine } = await made();
    const server = fake.servers[0]!;
    // What the owner added since, from the console.
    const theirs = fake.reserveIp();
    fake.attach(theirs, server);
    const data = fake.addVolume({ name: "data" });
    data.server = server.id;
    data.status = "in_use";
    server.volumes.push(data.id);
    fake.addKey({ name: "laptop", public_key: otherKey(3) });

    const lines: string[] = [];
    const outcome = await provider.destroy(machine, { deleteKey: false }, (line) => {
      lines.push(line);
      printed.push(line);
    });
    expect(writes()).toEqual([
      "POST /instance/v1/zones/fr-par-1/servers/:id/action",
      "DELETE /instance/v1/zones/fr-par-1/servers/:id",
      "DELETE /block/v1alpha1/zones/fr-par-1/volumes/:id",
      "DELETE /instance/v1/zones/fr-par-1/ips/:id",
      "DELETE /instance/v1/zones/fr-par-1/ips/:id",
      "DELETE /instance/v1/zones/fr-par-1/security_groups/:id",
    ]);
    expect(bodyOf("POST", /action$/)).toEqual({ action: "poweroff" });
    expect(outcome.removed).toEqual([
      `server web (${machine.ipv4}, ${machine.ipv6})`,
      "block volume Debian 13 (Trixie)_sbs_volume_0 (40 GB)",
      expect.stringMatching(/^IPv4 address 203\.0\.113\.\d+$/),
      expect.stringMatching(/^IPv6 prefix 2001:db8:/),
      "security group sitesolide-web at fr-par-1",
    ]);
    expect(outcome.kept).toEqual([
      "block volume data (20 GB): it lacks the tag managed-by:sitesolide; it is billed until it is deleted from the console",
      `flexible IP ${theirs.address}: sitesolide did not reserve it; it is billed until it is released from the console`,
      "SSH key sitesolide-web: every Instance of the project receives it at boot, and other machines may be created with it; --delete-key deletes it",
    ]);
    expect(fake.servers).toEqual([]);
    expect(fake.volumes.map((volume) => volume.name)).toEqual(["data"]);
    expect(fake.ips.map((ip) => ip.id)).toEqual([theirs.id]);
    expect(fake.groups).toEqual([]);
    expect(fake.keys.map((key) => key.name).sort()).toEqual(["laptop", "sitesolide-web"]);
    expect(lines).toContain("   powering off");
  });

  test("--delete-key deletes the key uploaded for that machine, and only that one", async () => {
    fake.addKey({ name: "laptop", public_key: otherKey(3) });
    fake.addKey({ name: "sitesolide-db", public_key: otherKey(4) });
    const { provider, machine } = await made();
    const outcome = await provider.destroy(machine, { deleteKey: true }, say);
    expect(outcome.removed.at(-1)).toBe("SSH key sitesolide-web");
    expect(fake.keys.map((key) => key.name).sort()).toEqual(["laptop", "sitesolide-db"]);
  });

  test("a key the project already held is never deleted, --delete-key or not", async () => {
    fake.addKey({ name: "laptop", public_key: LINE });
    const { provider, machine } = await made();
    const lines: string[] = [];
    await provider.destroy(machine, { deleteKey: true }, (line) => lines.push(line));
    expect(fake.keys.map((key) => key.name)).toEqual(["laptop"]);
    expect(lines).toContain("   none was uploaded for web: the key it used was already in the project");
  });

  test("a security group another server uses is kept", async () => {
    const { provider, machine } = await made();
    const other = fake.addServer({ name: "db", tags: OURS("db") });
    other.security_group = fake.groups[0]!.id;
    const outcome = await provider.destroy(machine, { deleteKey: false }, say);
    expect(outcome.kept).toContain("security group sitesolide-web at fr-par-1: still applied to db");
    expect(fake.groups.length).toBe(1);
  });

  test("a server that is not tagged by sitesolide is refused, and nothing is deleted", async () => {
    const theirs = fake.addServer({ name: "web" });
    const machine = (await open().provider.find("web"))!;
    expect(machine.id).toBe(theirs.id);
    const failure = await refusal(open().provider.destroy(machine, { deleteKey: true }, say));
    expect(failure.error).toBe("machine-not-managed");
    expect(writes()).toEqual([]);
  });

  test("the wait for the server to stop is bounded", async () => {
    const { provider, machine } = await made();
    fake.settings.transitionReads = 10_000;
    const failure = await refusal(provider.destroy(machine, { deleteKey: false }, say));
    expect(failure).toMatchObject({ error: "machine-timeout", message: `web is still not stopped after ${WAITS.stoppedMs / 60_000} minutes` });
    expect(writes()).toEqual(["POST /instance/v1/zones/fr-par-1/servers/:id/action"]);
  });
});

// --- the uploaded key -------------------------------------------------------------------------------

/** A PublicKey as bin/cli/machine.ts reads one, with the MD5 fingerprint ssh-keygen prints. */
function publicKey(line: string): PublicKey {
  const [algorithm = "", blob = "", comment = ""] = line.split(" ");
  const fingerprint = new Bun.CryptoHasher("md5").update(Buffer.from(blob, "base64")).digest("hex").match(/../g)!.join(":");
  return { algorithm, blob, comment, fingerprint };
}

describe("the key --delete-key deletes", () => {
  test("is the one the server's tag names, never one of another machine whose name starts the same", async () => {
    // web-20261021's key is named sitesolide-web-20261021: a name web's own could have borne.
    const other = await create(open().provider, { name: "web-20261021", key: publicKey(otherKey(9)) });
    const { outcome } = await create(open().provider);
    expect(fake.servers.find((server) => server.name === "web")!.tags).toContain(`sitesolide-key:${fake.keys.find((key) => key.name === "sitesolide-web")!.id}`);
    const gone = await open().provider.destroy(outcome.machine, { deleteKey: true }, say);
    expect(gone.removed).toContain("SSH key sitesolide-web");
    expect(fake.keys.map((key) => key.name)).toEqual(["sitesolide-web-20261021"]);
    expect(other.outcome.resources[0]).toMatchObject({ name: "sitesolide-web-20261021", reused: false });
  });

  test("a reused key is not named on the server, and so never deleted", async () => {
    fake.addKey({ name: "sitesolide-web", public_key: LINE });
    const { outcome } = await create(open().provider);
    expect(fake.servers[0]!.tags).toEqual(OURS("web"));
    await open().provider.destroy(outcome.machine, { deleteKey: true }, say);
    expect(fake.keys.map((key) => key.name)).toEqual(["sitesolide-web"]);
  });

  test("a key renamed since its upload is kept, --delete-key or not", async () => {
    const { outcome } = await create(open().provider);
    fake.keys[0]!.name = "sitesolide-web-00000000";
    const gone = await open().provider.destroy(outcome.machine, { deleteKey: true }, say);
    expect(gone.kept).toContain("SSH key sitesolide-web-00000000: renamed since it was uploaded for web, so it is never deleted from here");
    expect(fake.keys.length).toBe(1);
  });
});

// --- an order whose outcome is unknown ---------------------------------------------------------------

describe("an order whose outcome is unknown", () => {
  test("a failure on Scaleway's side undoes nothing, says so, and the next run reuses what this one made", async () => {
    fake.fail("POST", /\/servers$/, 500, { message: "Internal error", type: "internal_server_error" });
    const failure = await refusal(open().provider.create(order(), say));
    expect(failure.error).toBe("provider-failure");
    expect(failure.details).toContain("whether Scaleway created web is unknown: nothing was undone");
    expect(failure.details).toContain("the SSH key sitesolide-web this run created stays");
    expect(failure.details?.at(-1)).toBe("the same command finds web if it was created and starts it, or reuses what is left; sitesolide machine destroy web removes it all");
    expect(writes().filter((write) => write.startsWith("DELETE"))).toEqual([]);
    expect({ keys: fake.keys.length, groups: fake.groups.length, ips: fake.ips.length, servers: fake.servers.length }).toEqual({ keys: 1, groups: 1, ips: 2, servers: 0 });

    const again = await create(open().provider);
    expect(again.outcome.created).toBe(true);
    expect(again.outcome.resources.map((resource) => [resource.kind, resource.reused])).toEqual([
      ["ssh key", true],
      ["security group", true],
      ["ipv4", true],
      ["ipv6", true],
      ["server", false],
    ]);
    expect(fake.ips.length).toBe(2);
  });

  test("an answer lost after Scaleway created the server undoes nothing: the next run starts it with its key and addresses", async () => {
    const cut = (input: string, init?: RequestInit) =>
      fetch(input, init).then((response) => {
        if (init?.method === "POST" && input.endsWith("/servers")) throw new Error("the connection was closed");
        return response;
      });
    const failure = await refusal(open({ fetcher: cut }).provider.create(order(), say));
    expect(failure.error).toBe("provider-unreachable");
    expect(writes().filter((write) => write.startsWith("DELETE"))).toEqual([]);
    expect(fake.servers[0]).toMatchObject({ state: "stopped", ips: fake.ips.map((ip) => ip.id) });

    const again = await create(open().provider);
    expect(again.outcome).toMatchObject({ created: false, machine: { status: "running", ipv4: fake.ips[0]!.address } });
    expect(again.lines).toContain("   never started: the run that ordered it stopped before");
  });

  test("the fake deletes an attached flexible IP, as Scaleway documents, leaving its server without it", async () => {
    const server = fake.addServer({ name: "theirs" });
    const ip = fake.ips.find((candidate) => candidate.server === server.id)!;
    const response = await fetch(`${fake.url}/instance/v1/zones/fr-par-1/ips/${ip.id}`, { method: "DELETE", headers: { "X-Auth-Token": FAKE_SECRET } });
    expect(response.status).toBe(204);
    expect(server.ips).toEqual([]);
    expect(fake.ips).toEqual([]);
  });
});

// --- what earlier runs left -------------------------------------------------------------------------

describe("what an earlier run left without a server", () => {
  /** An earlier run's addresses in nl-ams-1, its group in fr-par-2, and a volume whose server went, in pl-waw-1. */
  function leftBehind() {
    const ipv4 = fake.reserveIp({ zone: "nl-ams-1", tags: OURS("web") });
    const ipv6 = fake.reserveIp({ zone: "nl-ams-1", type: "routed_ipv6", tags: OURS("web") });
    const group = fake.addGroup({ name: "sitesolide-web", zone: "fr-par-2", tags: OURS("web") });
    const volume = fake.addVolume({ zone: "pl-waw-1", name: "Debian 13 (Trixie)_sbs_volume_0", tags: OURS("web") });
    return { ipv4, ipv6, group, volume };
  }

  test("a refused order names what it reuses and keeps, billed, and how it goes", async () => {
    const earlier = fake.reserveIp({ tags: OURS("web") });
    fake.fail("POST", /\/servers$/, 400, { message: "Validation Error", type: "invalid_request_error", fields: { placement_group: ["not found"] } });
    const failure = await refusal(open().provider.create(order(), say));
    expect(failure.details).toContain(`kept the IPv4 address ${earlier.address} an earlier run reserved: it is billed until the next create reuses it, or sitesolide machine destroy web releases it`);
    expect(fake.ips.map((ip) => ip.id)).toEqual([earlier.id]);
  });

  test("so does a refusal before anything is written", async () => {
    const earlier = fake.reserveIp({ zone: "nl-ams-3", tags: OURS("web") });
    const failure = await refusal(open().provider.create(order({ location: "nl-ams-3" }), say));
    expect(failure.error).toBe("invalid-server-type");
    expect(failure.details?.at(-1)).toContain(`kept the IPv4 address ${earlier.address} an earlier run reserved`);
  });

  test("find and list show it as an incomplete machine of sitesolide's, whichever zone holds it", async () => {
    const { ipv4, ipv6 } = leftBehind();
    fake.addServer({ name: "db", tags: OURS("db") });
    const found = await open().provider.find("web");
    expect(found).toEqual({
      provider: "scaleway",
      id: "",
      name: "web",
      type: "none",
      location: "nl-ams-1",
      status: INCOMPLETE,
      ipv4: ipv4.address,
      ipv6: null,
      ipv6Network: ipv6.prefix,
      monthlyPrice: null,
      backups: false,
      managed: true,
      labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" },
      login: "root",
    });
    expect((await open().provider.list()).map((machine) => [machine.name, machine.status])).toEqual([
      ["db", "running"],
      ["web", INCOMPLETE],
    ]);
    expect(writes()).toEqual([]);
  });

  test("destroy removes it all, in every zone, without a server step, and keeps every key", async () => {
    const { volume } = leftBehind();
    fake.addKey({ name: "sitesolide-web", public_key: LINE });
    const machine = (await open().provider.find("web"))!;
    const lines: string[] = [];
    const outcome = await open().provider.destroy(machine, { deleteKey: true }, (line) => lines.push(line));
    expect(writes()).toEqual([
      "DELETE /block/v1alpha1/zones/pl-waw-1/volumes/:id",
      "DELETE /instance/v1/zones/nl-ams-1/ips/:id",
      "DELETE /instance/v1/zones/nl-ams-1/ips/:id",
      "DELETE /instance/v1/zones/fr-par-2/security_groups/:id",
    ]);
    expect(outcome.removed).toEqual([
      `block volume ${volume.name} (20 GB)`,
      expect.stringMatching(/^IPv4 address 203\.0\.113\.\d+$/),
      expect.stringMatching(/^IPv6 prefix 2001:db8:/),
      "security group sitesolide-web at fr-par-2",
    ]);
    expect(lines).toContain("   no server says which key was uploaded for it: none is deleted");
    expect(fake.keys.length).toBe(1);
    expect(await open().provider.find("web")).toBeNull();
    expect(await open().provider.list()).toEqual([]);
  });

  test("destroy of an incomplete machine stops when a server of that name appeared since", async () => {
    leftBehind();
    const machine = (await open().provider.find("web"))!;
    fake.addServer({ name: "web", tags: OURS("web") });
    const failure = await refusal(open().provider.destroy(machine, { deleteKey: false }, say));
    expect(failure.error).toBe("provider-busy");
    expect(writes()).toEqual([]);
  });

  test("destroy of a whole machine also removes what an earlier run left in another zone", async () => {
    const { outcome } = await create(open().provider);
    const stray = fake.reserveIp({ zone: "nl-ams-1", tags: OURS("web") });
    const gone = await open().provider.destroy(outcome.machine, { deleteKey: false }, say);
    expect(gone.removed).toContain(`IPv4 address ${stray.address}`);
    expect(fake.ips).toEqual([]);
  });

  test("an address attached to a server since is not a leftover: destroy could not remove it", async () => {
    const ip = fake.reserveIp({ tags: OURS("web") });
    fake.attach(ip, fake.addServer({ name: "theirs" }));
    expect(await open().provider.find("web")).toBeNull();
    expect((await open().provider.list()).map((machine) => machine.name)).toEqual([]);
  });

  test("create reuses the addresses an incomplete machine holds in its zone", async () => {
    const earlier = fake.reserveIp({ tags: OURS("web") });
    const { outcome } = await create(open().provider);
    expect(outcome.machine.ipv4).toBe(earlier.address);
  });
});

// --- the wizard ------------------------------------------------------------------------------------

describe("the wizard's lists", () => {
  test("the zones, the default first, each with its city and country", async () => {
    const locations = await open().provider.locations();
    expect(locations[0]).toEqual({ value: "fr-par-1", label: "Paris 1, FR" });
    expect(locations.map((choice) => choice.value).sort()).toEqual(ZONES.map((entry) => entry.zone).sort());
    expect(fake.requests).toEqual([]);
  });

  test("the types of a zone: the default first, then the cheapest, none ended, too small, with a GPU or a Windows licence", async () => {
    const types = await open().provider.types("fr-par-1");
    expect(types.map((choice) => choice.value)).toEqual(["DEV1-S", "PLAY2-PICO", "DEV1-M", "BASIC2-A2C-4G", "PLAY2-NANO", "BASIC3-X2C-4G", "POP2-2C-8G"]);
    expect(types[0]).toEqual({ value: "DEV1-S", label: "DEV1-S", hint: "2 vCPU, 2 GB RAM, x86_64, 6.55 EUR a month before VAT" });
    expect(types[1]!.hint).toBe("1 vCPU, 2 GB RAM, x86_64, 10.42 EUR a month before VAT, scarce");
    expect(types[3]!.hint).toContain("arm64");
    expect(types.length).toBeLessThanOrEqual(12);
    // A type out of stock is left out; the default too, where it is not sold.
    expect((await open().provider.types("fr-par-2")).map((choice) => choice.value)).toEqual(["DEV1-S", "PLAY2-NANO", "POP2-2C-8G"]);
    expect((await open().provider.types("nl-ams-3")).map((choice) => choice.value)).toEqual(["PLAY2-PICO", "POP2-2C-8G"]);
    expect(writes()).toEqual([]);
  });

  test("a zone it does not know is refused", async () => {
    expect((await refusal(open().provider.types("de-fra-1"))).error).toBe("invalid-location");
  });

  test("every page of the catalogue is read", async () => {
    await open().provider.types("fr-par-1");
    const pages = fake.requests.filter((request) => request.path === "/instance/v1/zones/fr-par-1/products/servers").map((request) => new URLSearchParams(request.search).get("page"));
    expect(pages).toEqual(["1", "2", "3", "4", "5", "6"]);
  });
});

// --- discover --------------------------------------------------------------------------------------

describe("discover", () => {
  function workstation(answers: Record<string, { code: number; stdout: string }>): Workstation & { ran: string[][] } {
    const ran: string[][] = [];
    return {
      ran,
      environment: {},
      readFile: () => null,
      async run(argv) {
        ran.push(argv);
        const answer = answers[argv.join(" ")] ?? { code: 127, stdout: "" };
        return { ...answer, stderr: "" };
      },
    };
  }

  test("the scw CLI's secret key and project, from `scw config get`", async () => {
    const station = workstation({
      "scw config get secret-key": { code: 0, stdout: `${FAKE_SECRET}\n` },
      "scw config get default-project-id": { code: 0, stdout: `${FAKE_PROJECT}\n` },
    });
    const found = await discover(station);
    expect(found).toEqual({ source: "the scw CLI's configuration", credentials: { SCW_SECRET_KEY: FAKE_SECRET, SCW_DEFAULT_PROJECT_ID: FAKE_PROJECT } });
    expect(station.ran).toEqual([
      ["scw", "config", "get", "secret-key"],
      ["scw", "config", "get", "default-project-id"],
    ]);
    expect(found!.source).not.toContain(FAKE_SECRET);
    expect(SCALEWAY.discover).toBe(discover);
  });

  test("the secret key alone, when the CLI has no project: the environment's then fills it", async () => {
    const found = await discover(workstation({ "scw config get secret-key": { code: 0, stdout: FAKE_SECRET }, "scw config get default-project-id": { code: 0, stdout: "-\n" } }));
    expect(found?.credentials).toEqual({ SCW_SECRET_KEY: FAKE_SECRET });
  });

  test("nothing without the CLI, or when it holds no key", async () => {
    expect(await discover(workstation({}))).toBeNull();
    expect(await discover(workstation({ "scw config get secret-key": { code: 1, stdout: "" } }))).toBeNull();
    expect(await discover(workstation({ "scw config get secret-key": { code: 0, stdout: "-\n" } }))).toBeNull();
  });
});

// --- the credentials -------------------------------------------------------------------------------

describe("the secret key", () => {
  test("travels in the X-Auth-Token header and nowhere else, and follows no redirect", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const { provider } = open({
      fetcher: (input, init) => {
        seen.push({ url: input, init });
        return fetch(input, init);
      },
    });
    const { outcome } = await create(provider);
    await provider.list();
    await provider.destroy(outcome.machine, { deleteKey: true }, say);
    expect(seen.length).toBeGreaterThan(20);
    for (const { url, init } of seen) {
      expect(url).not.toContain(FAKE_SECRET);
      expect(String(init?.body ?? "")).not.toContain(FAKE_SECRET);
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect((init?.headers as Record<string, string>)["X-Auth-Token"]).toBe(FAKE_SECRET);
    }
    for (const request of fake.requests) expect(`${request.path}${request.search}`).not.toContain(FAKE_SECRET);
  });

  test("an API that cannot be reached is said without it", async () => {
    const failure = await refusal(
      open({
        fetcher: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }).provider.list(),
    );
    expect(failure.error).toBe("provider-unreachable");
    expect(failure.message).not.toContain(FAKE_SECRET);
  });

  test("an answer that is not Scaleway's API is said as such", async () => {
    const failure = await refusal(open({ fetcher: async () => new Response("<html>login</html>", { status: 200 }) }).provider.list());
    expect(failure.error).toBe("provider-unreadable");
  });

  test("never appears in anything the provider said in this file", () => {
    expect(printed.length).toBeGreaterThan(50);
    expect(printed.filter((line) => line.includes(FAKE_SECRET))).toEqual([]);
  });
});
