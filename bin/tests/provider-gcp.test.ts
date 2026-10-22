import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMOTE_HINTS } from "../cli/hints";
import { machine } from "../cli/machine";
import { eventOutput } from "../cli/remote";
import {
  addressNameOf,
  bootDiskType,
  discover,
  failureFrom,
  firewallRules,
  GCP,
  markOf,
  offeredTypes,
  operationFailure,
  ownAddress,
  ownRule,
  readKeyFile,
  sshKeysEntry,
  WAITS,
  type GcpAddress,
  type GcpFirewall,
  type GcpMachineType,
  type GcpOperation,
} from "../cli/providers/gcp";
import { ProviderError, type CreateRequest, type Provider, type PublicKey, type Workstation } from "../cli/providers/provider";
import { createFakeGcp, FAKE_EMAIL, FAKE_EXCHANGED, FAKE_PROJECT, FAKE_TOKEN, MACHINE_TYPES, type FakeGcp } from "./fake-gcp";

/**
 * The gcp provider, opened directly against a local fake of Compute Engine
 * and of Google's token endpoint (fake-gcp.ts): the real ones are never
 * called. The clock does not wait.
 *
 * Whatever the path, a credential must never appear in an address, a line
 * reported or a refusal: every line and every refusal of this file is kept
 * in `printed`, every value handed to `context.secret` in `scrubbed`, and the
 * last test reads them all.
 */

/** Generated for these tests with ssh-keygen; the private half was deleted at once. */
const KEY: PublicKey = {
  algorithm: "ssh-ed25519",
  blob: "AAAAC3NzaC1lZDI1NTE5AAAAICezpiOyiQWMYqOeL4S4OgE0T7Fq2bLHWUJ1afO4cczN",
  comment: "ada@workstation.test-zone.invalid",
  fingerprint: "a4:46:30:d5:fd:7e:1a:77:e5:ad:8d:21:4f:9a:3e:9e",
};

/** The codes this provider adds, proposed for bin/cli/hints.ts. */
const PROPOSED = new Set(["provider-api-disabled", "no-default-network"]);

let fake: FakeGcp;
const printed: string[] = [];
const scrubbed: string[] = [];
/** Every address a provider of this file fetched, the token endpoint's included. */
const urls: string[] = [];

beforeAll(() => {
  fake = createFakeGcp();
});

afterAll(() => {
  fake.stop();
});

beforeEach(() => {
  fake.reset();
});

function fakeClock() {
  let now = Date.parse("2026-10-21T10:00:00Z");
  return { now: () => now, sleep: async (milliseconds: number) => void (now += milliseconds) };
}

const TOKEN_CREDENTIALS = { GOOGLE_CLOUD_PROJECT: FAKE_PROJECT, GOOGLE_OAUTH_ACCESS_TOKEN: FAKE_TOKEN };

function open(credentials: Record<string, string> = TOKEN_CREDENTIALS, clock = fakeClock(), environment: Record<string, string> = {}): Provider {
  return GCP.open({
    credentials,
    environment: { SITESOLIDE_GCP_API: fake.url, SITESOLIDE_GCP_OAUTH: fake.oauthUrl, ...environment },
    fetcher: (input, init) => {
      urls.push(input);
      return fetch(input, init);
    },
    clock,
    secret: (value) => void scrubbed.push(value),
  });
}

const lines: string[] = [];
function report(line: string): void {
  lines.push(line);
  printed.push(line);
}

beforeEach(() => {
  lines.length = 0;
});

function request(extra: Partial<CreateRequest> = {}): CreateRequest {
  return { name: "web", type: "e2-small", location: "europe-west4-a", image: "debian-13", backups: false, key: KEY, ...extra };
}

/** The requests that changed something, as `METHOD /path`, the project's prefix left out. */
function writes(): string[] {
  return fake.requests.filter((item) => item.method !== "GET" && item.path !== "/token").map((item) => `${item.method} ${item.path.replace(`/projects/${FAKE_PROJECT}`, "")}`);
}

function bodyOf(method: string, path: RegExp, index = 0): Record<string, unknown> {
  const found = fake.requests.filter((item) => item.method === method && path.test(item.path));
  return found[index]!.body as Record<string, unknown>;
}

/** The refusal a promise ends with, kept for the last test. */
async function refusal(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    printed.push(error.failure.message, ...(error.failure.details ?? []));
    return error;
  }
  throw new Error("expected a refusal");
}

function refusalSync(attempt: () => unknown): ProviderError {
  try {
    attempt();
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    printed.push(error.failure.message, ...(error.failure.details ?? []));
    return error;
  }
  throw new Error("expected a refusal");
}

/** A rule as sitesolide creates it, for a test that needs it there already. */
function ourRule(name: string, which: 0 | 1) {
  const rule = firewallRules(name, `https://www.googleapis.com/compute/v1/projects/${FAKE_PROJECT}/global/networks/default`)[which]!;
  return fake.addFirewall({ ...rule, id: String(9_000 + which) });
}

// --- create -----------------------------------------------------------------------------------

describe("create", () => {
  test("on an empty project: the two rules, the address, its labels, then the instance, in that order", async () => {
    const outcome = await open().create(request(), report);
    expect(writes()).toEqual([
      "POST /global/firewalls",
      "POST /global/firewalls",
      "POST /regions/europe-west4/addresses",
      "POST /regions/europe-west4/addresses/sitesolide-web/setLabels",
      "POST /zones/europe-west4-a/instances",
    ]);
    expect(outcome.created).toBe(true);
    expect(outcome.machine).toMatchObject({
      provider: "gcp",
      name: "web",
      type: "e2-small",
      location: "europe-west4-a",
      status: "running",
      ipv4: "203.0.113.10",
      ipv6: null,
      ipv6Network: null,
      monthlyPrice: null,
      backups: false,
      managed: true,
      labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" },
      login: "sitesolide",
    });
    expect(outcome.resources.map((resource) => `${resource.kind} ${resource.name} ${resource.reused}`)).toEqual([
      "firewall rule sitesolide-web false",
      "firewall rule sitesolide-web-deny false",
      "address sitesolide-web false",
      "instance web false",
    ]);

    const network = `https://www.googleapis.com/compute/v1/projects/${FAKE_PROJECT}/global/networks/default`;
    expect(bodyOf("POST", /\/global\/firewalls$/, 0)).toEqual({
      name: "sitesolide-web",
      description: "managed-by=sitesolide sitesolide-machine=web: inbound tcp 22, 80, 443 and icmp, from everywhere",
      priority: 1000,
      network,
      direction: "INGRESS",
      sourceRanges: ["0.0.0.0/0"],
      targetTags: ["sitesolide-web"],
      allowed: [{ IPProtocol: "tcp", ports: ["22", "80", "443"] }, { IPProtocol: "icmp" }],
    });
    expect(bodyOf("POST", /\/global\/firewalls$/, 1)).toMatchObject({ name: "sitesolide-web-deny", priority: 1001, targetTags: ["sitesolide-web"], sourceRanges: ["0.0.0.0/0"], denied: [{ IPProtocol: "all" }] });
    expect(bodyOf("POST", /\/addresses$/)).toMatchObject({ name: "sitesolide-web", addressType: "EXTERNAL", networkTier: "PREMIUM", labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" } });
    expect(bodyOf("POST", /\/setLabels$/)).toMatchObject({ labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" } });

    const instance = bodyOf("POST", /\/instances$/);
    expect(instance).toMatchObject({
      name: "web",
      machineType: "zones/europe-west4-a/machineTypes/e2-small",
      labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" },
      tags: { items: ["sitesolide-web"] },
      metadata: {
        items: [
          { key: "ssh-keys", value: `sitesolide:ssh-ed25519 ${KEY.blob} ada@workstation.test-zone.invalid` },
          { key: "enable-oslogin", value: "FALSE" },
          { key: "block-project-ssh-keys", value: "TRUE" },
        ],
      },
      disks: [
        {
          boot: true,
          autoDelete: true,
          type: "PERSISTENT",
          initializeParams: { sourceImage: "projects/debian-cloud/global/images/family/debian-13", diskSizeGb: "20", diskType: "zones/europe-west4-a/diskTypes/pd-balanced" },
        },
      ],
      networkInterfaces: [{ network, subnetwork: `https://www.googleapis.com/compute/v1/projects/${FAKE_PROJECT}/regions/europe-west4/subnetworks/default`, accessConfigs: [{ type: "ONE_TO_ONE_NAT", natIP: "203.0.113.10", networkTier: "PREMIUM" }] }],
    });
    // No service account: the machine holds no Google credentials.
    expect(instance.serviceAccounts).toBeUndefined();

    // The default network's own rules are left as they were.
    expect(fake.firewalls.map((rule) => rule.name).sort()).toEqual(["default-allow-icmp", "default-allow-internal", "default-allow-rdp", "default-allow-ssh", "sitesolide-web", "sitesolide-web-deny"]);
    expect(fake.addresses).toMatchObject([{ name: "sitesolide-web", status: "IN_USE", labels: { "managed-by": "sitesolide" } }]);
    expect(lines).toContain("   created: inbound tcp 22, 80, 443 and icmp, from everywhere");
    expect(lines).toContain("   reserved: 203.0.113.10");
    expect(lines.at(-1)).toBe("   status: running");
  });

  test("labels an address takes at insert need no setLabels", async () => {
    fake.settings.labelsAtInsert = true;
    await open().create(request(), report);
    expect(writes()).not.toContain("POST /regions/europe-west4/addresses/sitesolide-web/setLabels");
    expect(fake.addresses[0]!.labels).toEqual({ "managed-by": "sitesolide", "sitesolide-machine": "web" });
  });

  test("a second run finds the machine and writes nothing", async () => {
    await open().create(request(), report);
    fake.requests.length = 0;
    const again = await open().create(request({ type: "e2-medium" }), report);
    expect(writes()).toEqual([]);
    expect(again.created).toBe(false);
    expect(again.resources).toEqual([{ kind: "instance", name: "web", id: again.machine.id, reused: true }]);
    expect(lines).toContain("!! it is e2-small at europe-west4-a: --type and --location only apply to a machine being created");
  });

  test("what an interrupted run made is reused, the address it could not label included", async () => {
    ourRule("web", 0);
    ourRule("web", 1);
    fake.addAddress({ name: "sitesolide-web", region: "europe-west4", description: `${markOf("web")}: the machine's public IPv4` });
    const outcome = await open().create(request(), report);
    expect(writes()).toEqual(["POST /regions/europe-west4/addresses/sitesolide-web/setLabels", "POST /zones/europe-west4-a/instances"]);
    expect(outcome.resources.map((resource) => resource.reused)).toEqual([true, true, true, false]);
  });

  test("an Arm type boots the arm64 image, and the series without Persistent Disk get Hyperdisk", async () => {
    await open().create(request({ name: "arm", type: "c4a-standard-1" }), report);
    expect(bodyOf("POST", /\/instances$/)).toMatchObject({
      disks: [{ initializeParams: { sourceImage: "projects/debian-cloud/global/images/family/debian-13-arm64", diskType: "zones/europe-west4-a/diskTypes/hyperdisk-balanced" } }],
    });
    await open().create(request({ name: "fourth", type: "n4-standard-2" }), report);
    expect(bodyOf("POST", /\/instances$/, 1)).toMatchObject({
      disks: [{ initializeParams: { sourceImage: "projects/debian-cloud/global/images/family/debian-13", diskType: "zones/europe-west4-a/diskTypes/hyperdisk-balanced" } }],
    });
    expect(["e2-small", "n2d-standard-2", "c3-standard-4"].map(bootDiskType)).toEqual(["pd-balanced", "pd-balanced", "pd-balanced"]);
  });

  test("an image of Google's given by its path is checked, then ordered as given", async () => {
    await open().create(request({ image: "projects/debian-cloud/global/images/family/debian-12" }), report);
    expect(bodyOf("POST", /\/instances$/)).toMatchObject({ disks: [{ initializeParams: { sourceImage: "projects/debian-cloud/global/images/family/debian-12" } }] });
  });

  test("a default network in custom mode: the region's subnet is named, and a region without one is refused", async () => {
    fake.settings.network = "custom";
    await open().create(request({ location: "us-central1-a" }), report);
    expect(bodyOf("POST", /\/instances$/)).toMatchObject({ networkInterfaces: [{ subnetwork: `https://www.googleapis.com/compute/v1/projects/${FAKE_PROJECT}/regions/us-central1/subnetworks/default` }] });
    fake.requests.length = 0;
    const refused = await refusal(open().create(request({ name: "db" }), report));
    expect(refused.failure).toMatchObject({ error: "no-default-network", message: `the default network of ${FAKE_PROJECT} has no subnet in europe-west4` });
    expect(writes()).toEqual([]);
  });
});

// --- refusals ---------------------------------------------------------------------------------

describe("what refuses a create, before anything is written", () => {
  test("nameProblem says why Google Cloud would not take a name, one reason each", () => {
    expect(GCP.nameProblem?.("web")).toBeNull();
    expect(GCP.nameProblem?.("a".repeat(47))).toBeNull();
    expect(GCP.nameProblem?.("1web")).toBe("a name there starts with a letter");
    expect(GCP.nameProblem?.("a".repeat(48))).toBe("47 characters at most: sitesolide derives sitesolide-<name>-deny from it, and Google takes 63");
  });

  test("the command refuses such a name before anything leaves", async () => {
    const home = mkdtempSync(join(tmpdir(), "machine-gcp-"));
    try {
      mkdirSync(join(home, ".ssh"));
      writeFileSync(join(home, ".ssh", "id_ed25519.pub"), `ssh-ed25519 ${KEY.blob} ${KEY.comment}\n`);
      const out: string[] = [];
      const code = await machine(["machine", "create", "--provider", "gcp", "--name", "1web", "--json"], {
        environment: fake.environment,
        home,
        output: eventOutput((line) => out.push(line)),
        clock: fakeClock(),
        workstation: { environment: {}, run: async () => ({ code: 127, stdout: "", stderr: "" }), readFile: () => null },
        interactive: false,
      });
      printed.push(...out);
      expect(code).toBe(1);
      expect(JSON.parse(out.at(-1)!)).toMatchObject({ type: "error", message: "Google Cloud would not take the name 1web: a name there starts with a letter", hint: REMOTE_HINTS["machine-name"]! });
      expect(fake.requests).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a name Google Cloud cannot hold, before any request", async () => {
    for (const name of ["1web", "a".repeat(48)]) {
      const refused = await refusal(open().create(request({ name }), report));
      expect(refused.failure.error).toBe("provider-invalid");
    }
    expect(fake.requests).toEqual([]);
  });

  test("an instance of that name sitesolide did not create, in any zone", async () => {
    fake.addInstance({ name: "web", zone: "us-central1-b", machineType: "n2-standard-2" });
    const refused = await refusal(open().create(request(), report));
    expect(refused.failure.error).toBe("machine-exists");
    expect(refused.failure.details).toEqual(["n2-standard-2 at us-central1-b, running, 198.51.100.10", "it lacks the label managed-by=sitesolide: nothing was created, nothing was changed"]);
    expect(writes()).toEqual([]);
  });

  test("a firewall rule of one of the two names that is not sitesolide's", async () => {
    fake.addFirewall({ name: "sitesolide-web", description: "opened by hand" });
    expect((await refusal(open().create(request(), report))).failure.error).toBe("firewall-taken");
    fake.reset();
    // sitesolide's mark, but a target beyond the machine's tag.
    fake.addFirewall({ ...firewallRules("web", "global/networks/default")[1]!, targetTags: ["sitesolide-web", "db"] });
    expect((await refusal(open().create(request(), report))).failure.error).toBe("firewall-taken");
    expect(writes()).toEqual([]);
  });

  test("an address of that name sitesolide did not reserve, or one of its own already in use", async () => {
    fake.addAddress({ name: "sitesolide-web", region: "europe-west4" });
    expect((await refusal(open().create(request(), report))).failure.error).toBe("provider-name-taken");
    fake.reset();
    const address = fake.addAddress({ name: "sitesolide-web", region: "europe-west4", labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" } });
    fake.addInstance({ name: "other", natIP: address.address, labels: {} });
    const refused = await refusal(open().create(request(), report));
    expect(refused.failure.error).toBe("provider-name-taken");
    expect(refused.failure.details?.[0]).toBe(`used by projects/${FAKE_PROJECT}/zones/europe-west4-a/instances/other`);
    expect(writes()).toEqual([]);
  });

  test("a zone that does not exist lists one zone a region; a zone that is down says so", async () => {
    const unknown = await refusal(open().create(request({ location: "europe-west99-a" }), report));
    expect(unknown.failure.error).toBe("invalid-location");
    expect(unknown.failure.details?.[1]).toBe("europe-west4-a  Eemshaven, NL, europe-west4, zones a, b, c");
    expect(unknown.failure.details).toContain("europe-west9-a  Paris, FR, europe-west9, zones a, b");
    expect((await refusal(open().create(request({ location: "Not a zone" }), report))).failure.error).toBe("invalid-location");
    expect((await refusal(open().create(request({ location: "europe-west9-c" }), report))).failure.error).toBe("provider-unavailable");
    expect(writes()).toEqual([]);
  });

  test("a type the zone does not sell lists the ones worth trying there", async () => {
    const refused = await refusal(open().create(request({ type: "c4-standard-2", location: "europe-west3-a" }), report));
    expect(refused.failure.message).toBe("c4-standard-2 is not a machine type of the zone europe-west3-a");
    expect(refused.failure.details?.[0]).toBe("the types worth trying at europe-west3-a:");
    expect(refused.failure.details?.[1]).toBe("e2-small        2 vCPU (shared core), 2 GB memory");
    expect(writes()).toEqual([]);
  });

  test("an image that is not one, or that Google does not have", async () => {
    expect((await refusal(open().create(request({ image: "ubuntu" }), report))).failure.error).toBe("provider-invalid");
    const missing = await refusal(open().create(request({ image: "projects/debian-cloud/global/images/family/debian-7" }), report));
    expect(missing.failure).toMatchObject({ error: "provider-invalid", message: "Google Cloud has no image projects/debian-cloud/global/images/family/debian-7" });
    expect(writes()).toEqual([]);
  });

  test("a project without a default network", async () => {
    fake.settings.network = "none";
    const refused = await refusal(open().create(request(), report));
    expect(refused.failure.error).toBe("no-default-network");
    expect(refused.failure.details?.join(" ")).toContain("gcloud compute networks create default --subnet-mode=auto");
    expect(writes()).toEqual([]);
  });

  test("a project whose Compute Engine API is off says how to turn it on", async () => {
    fake.fail("GET", /aggregated\/instances/, 403, "accessNotConfigured", `Compute Engine API has not been used in project 123456789012 before or it is disabled.`, {
      body: { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", domain: "googleapis.com" }] },
    });
    const refused = await refusal(open().create(request(), report));
    expect(refused.failure.error).toBe("provider-api-disabled");
    expect(refused.failure.message).toBe(`the Compute Engine API is not enabled in the project ${FAKE_PROJECT} (403 accessNotConfigured)`);
    expect(refused.failure.details?.[0]).toContain("APIs & Services, Library, Compute Engine API, Enable");
    expect(writes()).toEqual([]);
  });

  test("--backups, which Google Cloud does not implement here", async () => {
    expect((await refusal(open().create(request({ backups: true }), report))).failure.error).toBe("provider-invalid");
    expect(fake.requests).toEqual([]);
  });
});

// --- a refused order ----------------------------------------------------------------------------

describe("an order Google refuses", () => {
  test("no room in the zone: what this run created is deleted again, and other zones and types are suggested", async () => {
    fake.settings.failOperation = { operationType: "insert", target: /\/instances\/web$/, code: "ZONE_RESOURCE_POOL_EXHAUSTED", message: "The zone 'projects/sitesolide-test/zones/europe-west4-a' does not have enough resources available to fulfill the request." };
    const refused = await refusal(open().create(request(), report));
    expect(refused.failure.error).toBe("type-unavailable");
    expect(refused.failure.details).toContain("the other zones of europe-west4, as --location: europe-west4-b, europe-west4-c");
    expect(refused.failure.details).toContain("other types of europe-west4-a, as --type:");
    expect(refused.failure.details?.slice(-3)).toEqual([
      "deleted the address sitesolide-web this run had created",
      "deleted the firewall rule sitesolide-web-deny this run had created",
      "deleted the firewall rule sitesolide-web this run had created",
    ]);
    expect(writes().slice(-3)).toEqual(["DELETE /regions/europe-west4/addresses/sitesolide-web", "DELETE /global/firewalls/sitesolide-web-deny", "DELETE /global/firewalls/sitesolide-web"]);
    expect(fake.instances).toEqual([]);
    expect(fake.addresses).toEqual([]);
    expect(fake.firewalls.map((rule) => rule.name)).not.toContain("sitesolide-web");
  });

  test("an order refused on the spot is undone too, and what an earlier run made stays", async () => {
    ourRule("web", 0);
    ourRule("web", 1);
    fake.fail("POST", /\/instances$/, 400, "invalid", "Invalid value for field 'resource.machineType'.");
    const refused = await refusal(open().create(request(), report));
    expect(refused.failure.error).toBe("provider-invalid");
    expect(refused.failure.details).toEqual([
      "deleted the address sitesolide-web this run had created",
      "the firewall rules sitesolide-web and sitesolide-web-deny an earlier run created are still there",
      "the same create reuses them; to give the machine up, `sitesolide machine destroy web --provider gcp` removes them",
    ]);
    expect(fake.firewalls.map((rule) => rule.name)).toContain("sitesolide-web-deny");
  });

  test("a quota the order exceeds", async () => {
    fake.settings.failOperation = { operationType: "insert", target: /\/instances\/web$/, code: "QUOTA_EXCEEDED", message: "Quota 'IN_USE_ADDRESSES' exceeded. Limit: 4.0 in region europe-west4." };
    const refused = await refusal(open().create(request(), report));
    expect(refused.failure.error).toBe("provider-limit");
    expect(refused.failure.details?.at(-1)).toBe("deleted the firewall rule sitesolide-web this run had created");
  });

  test("an order whose outcome is unknown undoes nothing", async () => {
    fake.fail("POST", /\/instances$/, 503, "backendError", "Backend Error");
    const refused = await refusal(open().create(request(), report));
    expect(refused.failure.error).toBe("provider-failure");
    expect(refused.failure.details?.slice(-2)).toEqual([
      "the order may still go through: nothing was undone, and the next run picks up what exists",
      "to give the machine up instead, `sitesolide machine destroy web --provider gcp` removes what exists",
    ]);
    expect(writes().filter((write) => write.startsWith("DELETE"))).toEqual([]);
  });

  test("an order still running after ten minutes stops waiting, and undoes nothing", async () => {
    const clock = fakeClock();
    const started = clock.now();
    const provider = open(TOKEN_CREDENTIALS, clock);
    fake.settings.operationPolls = 2;
    // Every operation finishes, the instance's never does.
    const original = fake.settings;
    const pending = provider.create(request(), (line) => {
      report(line);
      if (line.startsWith("   ordered")) original.operationPolls = Number.POSITIVE_INFINITY;
    });
    const refused = await refusal(pending);
    expect(refused.failure.error).toBe("machine-timeout");
    expect(clock.now() - started).toBeGreaterThanOrEqual(WAITS.operationMs);
    expect(clock.now() - started).toBeLessThan(WAITS.operationMs + 60_000);
    expect(writes().filter((write) => write.startsWith("DELETE"))).toEqual([]);
  });
});

// --- leftovers --------------------------------------------------------------------------------

describe("what an earlier run left without an instance", () => {
  /** Run 1: the order's outcome is unknown, so its address and rules stay. */
  async function unknownOrder(): Promise<void> {
    fake.fail("POST", /\/instances$/, 503, "backendError", "Backend Error");
    await refusal(open().create(request(), report));
    expect(fake.instances).toEqual([]);
    expect(fake.addresses).toHaveLength(1);
  }

  const LEFT = [
    "the address sitesolide-web (203.0.113.10, europe-west4) an earlier run reserved is still there, billed by the hour while it is",
    "the firewall rules sitesolide-web and sitesolide-web-deny an earlier run created are still there",
    "the same create reuses them; to give the machine up, `sitesolide machine destroy web --provider gcp` removes them",
  ];

  test("a refused order after it names the billed address and the rules, and how they go", async () => {
    await unknownOrder();
    fake.requests.length = 0;
    fake.settings.failOperation = { operationType: "insert", target: /\/instances\/web$/, code: "ZONE_RESOURCE_POOL_EXHAUSTED", message: "The zone does not have enough resources available to fulfill the request." };
    const refused = await refusal(open().create(request(), report));
    expect(refused.failure.error).toBe("type-unavailable");
    expect(refused.failure.details?.slice(-4)).toEqual(["this run had created nothing yet", ...LEFT]);
    expect(lines).toContain("   an earlier run left the address sitesolide-web (203.0.113.10, europe-west4), the firewall rule sitesolide-web, the firewall rule sitesolide-web-deny: reused where they fit");
    expect(writes()).toEqual(["POST /zones/europe-west4-a/instances"]);
  });

  test("so does a refusal before anything is written, and an address in another region is warned of", async () => {
    await unknownOrder();
    const refused = await refusal(open().create(request({ type: "c4-standard-2", location: "europe-west3-a" }), report));
    expect(refused.failure.error).toBe("invalid-server-type");
    expect(refused.failure.details?.slice(-3)).toEqual(LEFT);
    expect(lines).toContain("!! the address sitesolide-web in europe-west4 is not in europe-west3, where the machine goes: it stays billed until the machine is destroyed");
  });

  test("find and list show it as an incomplete machine of sitesolide's; destroy removes what is left", async () => {
    await unknownOrder();
    const found = await open().find("web");
    expect(found).toMatchObject({ name: "web", type: "none", location: "europe-west4", status: "incomplete", ipv4: "203.0.113.10", managed: true, login: "sitesolide" });
    fake.settings.pageSize = 1;
    expect((await open().list()).map((machine) => `${machine.name} ${machine.status}`)).toEqual(["web incomplete"]);
    fake.requests.length = 0;
    const outcome = await open().destroy(found!, { deleteKey: false }, report);
    expect(writes()).toEqual(["DELETE /regions/europe-west4/addresses/sitesolide-web", "DELETE /global/firewalls/sitesolide-web", "DELETE /global/firewalls/sitesolide-web-deny"]);
    expect(outcome).toEqual({ removed: ["address sitesolide-web (203.0.113.10, europe-west4)", "firewall rule sitesolide-web", "firewall rule sitesolide-web-deny"], kept: [] });
    expect(await open().find("web")).toBeNull();
    expect(await open().list()).toEqual([]);
  });

  test("a create reuses what is left, and the machine is whole again", async () => {
    await unknownOrder();
    fake.requests.length = 0;
    const outcome = await open().create(request(), report);
    expect(writes()).toEqual(["POST /zones/europe-west4-a/instances"]);
    expect(outcome.machine).toMatchObject({ status: "running", ipv4: "203.0.113.10" });
    expect((await open().list()).map((machine) => machine.status)).toEqual(["running"]);
  });

  test("a destroy interrupted after the instance went is finished by running it again", async () => {
    const { machine: created } = await open().create(request(), report);
    // The first destroy got as far as the instance.
    fake.instances.length = 0;
    for (const address of fake.addresses) Object.assign(address, { status: "RESERVED", users: [] });
    expect(await open().find("web")).toMatchObject({ status: "incomplete", ipv4: created.ipv4 });
    const outcome = await open().destroy((await open().find("web"))!, { deleteKey: false }, report);
    expect(outcome.removed).toHaveLength(3);
    expect(lines).toContain("   none: an earlier run never created it, or a destroy deleted it; what was made for it goes below");
    expect(await open().find("web")).toBeNull();
  });

  test("a machine of another's name is never taken for leftovers, and an instance that appeared stops the destroy", async () => {
    fake.addAddress({ name: "sitesolide-web", region: "europe-west4" });
    fake.addFirewall({ name: "sitesolide-web", description: "opened by hand" });
    expect(await open().find("web")).toBeNull();
    expect(await open().list()).toEqual([]);

    fake.reset();
    await unknownOrder();
    const found = (await open().find("web"))!;
    fake.addInstance({ name: "web", labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" } });
    fake.requests.length = 0;
    expect((await refusal(open().destroy(found, { deleteKey: false }, report))).failure.error).toBe("provider-busy");
    expect(writes()).toEqual([]);
  });
});

// --- waits ------------------------------------------------------------------------------------

describe("waits", () => {
  test("an instance that never runs stops the wait at its bound", async () => {
    fake.settings.stagingReads = Number.POSITIVE_INFINITY;
    const clock = fakeClock();
    const started = clock.now();
    const refused = await refusal(open(TOKEN_CREDENTIALS, clock).create(request(), report));
    expect(refused.failure).toMatchObject({ error: "machine-timeout", details: ["last status: staging"] });
    expect(clock.now() - started).toBeLessThan(WAITS.runningMs + WAITS.operationMs);
  });

  test("a machine of sitesolide's that is stopped is not started", async () => {
    fake.addInstance({ name: "web", status: "TERMINATED", labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" } });
    const refused = await refusal(open().create(request(), report));
    expect(refused.failure).toMatchObject({ error: "machine-off", message: "web exists but is terminated" });
    expect(writes()).toEqual([]);
  });

  test("a failure that says later is waited out, once warned", async () => {
    fake.fail("GET", /\/operations\//, 503, "backendError", "Backend Error", { times: 2 });
    await open().create(request(), report);
    expect(lines.filter((line) => line.includes("still waiting"))).toHaveLength(1);
  });
});

// --- list and find ------------------------------------------------------------------------------

describe("list and find", () => {
  test("only the machines sitesolide created, from every page and every zone", async () => {
    fake.settings.pageSize = 1;
    const labels = (name: string) => ({ "managed-by": "sitesolide", "sitesolide-machine": name });
    fake.addInstance({ name: "web", zone: "europe-west4-a", labels: labels("web") });
    fake.addInstance({ name: "hand-made", zone: "europe-west4-b" });
    fake.addInstance({ name: "db", zone: "us-central1-f", labels: labels("db") });
    fake.addInstance({ name: "other", zone: "europe-west1-b", labels: { team: "data" } });
    const machines = await open().list();
    expect(machines.map((machine) => `${machine.name} ${machine.location}`).sort()).toEqual(["db us-central1-f", "web europe-west4-a"]);
    expect(machines.every((machine) => machine.managed && machine.login === "sitesolide")).toBe(true);
  });

  test("find prefers sitesolide's machine when a zone of another holds the same name", async () => {
    fake.addInstance({ name: "web", zone: "europe-west1-b" });
    fake.addInstance({ name: "web", zone: "europe-west4-a", labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" } });
    expect(await open().find("web")).toMatchObject({ location: "europe-west4-a", managed: true });
    expect(await open().find("db")).toBeNull();
    const searches = fake.requests.filter((item) => item.path.endsWith("/aggregated/instances")).map((item) => decodeURIComponent(item.search));
    expect(searches[0]).toStartWith("?filter=name = web&maxResults=500");
  });
});

// --- destroy ----------------------------------------------------------------------------------

describe("destroy", () => {
  test("the instance, then its address, then its two rules; the default network's rules stay", async () => {
    const { machine } = await open().create(request(), report);
    fake.requests.length = 0;
    const outcome = await open().destroy(machine, { deleteKey: true }, report);
    expect(writes()).toEqual([
      "DELETE /zones/europe-west4-a/instances/web",
      "DELETE /regions/europe-west4/addresses/sitesolide-web",
      "DELETE /global/firewalls/sitesolide-web",
      "DELETE /global/firewalls/sitesolide-web-deny",
    ]);
    expect(outcome).toEqual({
      removed: [
        "instance web (203.0.113.10), with its boot disk",
        "address sitesolide-web (203.0.113.10, europe-west4)",
        "firewall rule sitesolide-web",
        "firewall rule sitesolide-web-deny",
      ],
      kept: [],
    });
    expect(fake.instances).toEqual([]);
    expect(fake.addresses).toEqual([]);
    expect(fake.firewalls.map((rule) => rule.name).sort()).toEqual(["default-allow-icmp", "default-allow-internal", "default-allow-rdp", "default-allow-ssh"]);
    expect(lines).toContain("   nothing else to delete: Google Cloud keeps no copy of it");
  });

  test("an instance sitesolide did not create is never deleted, nor one replaced since it was read", async () => {
    fake.addInstance({ name: "web" });
    const machine = (await open().find("web"))!;
    expect((await refusal(open().destroy(machine, { deleteKey: false }, report))).failure.error).toBe("machine-not-managed");
    fake.reset();
    fake.addInstance({ name: "web", labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" } });
    const read = (await open().find("web"))!;
    expect((await refusal(open().destroy({ ...read, id: "1" }, { deleteKey: false }, report))).failure.error).toBe("provider-not-found");
    expect(writes()).toEqual([]);
  });

  test("a rule another instance still carries the tag of, and a rule that is not sitesolide's, are kept", async () => {
    const { machine } = await open().create(request(), report);
    fake.addInstance({ name: "twin", tags: ["sitesolide-web"] });
    const deny = fake.firewalls.find((rule) => rule.name === "sitesolide-web-deny")!;
    deny.description = "changed by hand";
    const outcome = await open().destroy(machine, { deleteKey: false }, report);
    expect(outcome.kept).toEqual([
      "firewall rule sitesolide-web-deny: sitesolide did not create it, it is left as it is",
      "firewall rule sitesolide-web: still applies to twin (europe-west4-a), which carries the tag sitesolide-web",
    ]);
    expect(fake.firewalls.map((rule) => rule.name)).toContain("sitesolide-web");
  });

  test("an address Google still counts as in use is asked again, then kept and said", async () => {
    const { machine } = await open().create(request(), report);
    fake.fail("DELETE", /\/addresses\//, 400, "resourceInUseByAnotherResource", "The address resource is already being used", { times: 2 });
    const released = await open().destroy(machine, { deleteKey: false }, report);
    expect(released.removed).toContain("address sitesolide-web (203.0.113.10, europe-west4)");

    fake.reset();
    const second = await open().create(request(), report);
    fake.fail("DELETE", /\/addresses\//, 400, "resourceInUseByAnotherResource", "The address resource is already being used", { times: WAITS.addressTries });
    const kept = await open().destroy(second.machine, { deleteKey: false }, report);
    expect(kept.kept).toEqual(["address sitesolide-web (203.0.113.10, europe-west4): Google still says it is in use; release it from the console, or it stays billed"]);
  });

  test("every disk that goes with the instance is named, and one that stays is said", async () => {
    const { machine: created } = await open().create(request(), report);
    fake.instances[0]!.extraDisks = [{ name: "data-1", autoDelete: true }, { name: "scratch", autoDelete: false }];
    const outcome = await open().destroy(created, { deleteKey: false }, report);
    expect(outcome.removed.slice(0, 2)).toEqual(["instance web (203.0.113.10), with its boot disk", "disk data-1, attached to web and set to go with it"]);
    expect(outcome.kept).toEqual(["disk scratch: it was not set to go with the instance, and is billed until it is deleted from the console"]);
  });

  test("an address an interrupted run reserved in another region goes too; a disk that stays is said", async () => {
    const { machine } = await open().create(request(), report);
    fake.addAddress({ name: "sitesolide-web", region: "europe-west3", labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" } });
    fake.addAddress({ name: "sitesolide-web", region: "europe-west1" });
    fake.instances[0]!.disk.autoDelete = false;
    const outcome = await open().destroy(machine, { deleteKey: false }, report);
    expect(outcome.removed.filter((line) => line.startsWith("address"))).toHaveLength(2);
    expect(fake.addresses.map((address) => address.region)).toEqual(["europe-west1"]);
    expect(outcome.kept).toEqual(["disk web: it was not set to go with the instance, and is billed until it is deleted from the console"]);
  });
});

// --- the API's errors ---------------------------------------------------------------------------

describe("the API's errors", () => {
  const said = (status: number, reason: string, headers: Record<string, string> = {}) =>
    failureFrom(status, { error: { code: status, message: `the API says ${reason}`, errors: [{ reason, domain: "global", message: "" }] } }, new Headers(headers), "create the instance web", FAKE_PROJECT).failure;

  test("each status and reason gets its own code, which hints.ts knows or this provider proposes", () => {
    const cases: [number, string, string][] = [
      [401, "authError", "provider-unauthenticated"],
      [403, "accessNotConfigured", "provider-api-disabled"],
      [403, "forbidden", "provider-forbidden"],
      [403, "insufficientPermissions", "provider-forbidden"],
      [403, "quotaExceeded", "provider-limit"],
      [403, "rateLimitExceeded", "provider-rate-limited"],
      [429, "rateLimitExceeded", "provider-rate-limited"],
      [429, "", "provider-rate-limited"],
      [404, "notFound", "provider-not-found"],
      [409, "alreadyExists", "provider-name-taken"],
      [409, "conflict", "provider-busy"],
      [412, "conditionNotMet", "provider-busy"],
      [400, "resourceInUseByAnotherResource", "provider-busy"],
      [400, "invalid", "provider-invalid"],
      [500, "backendError", "provider-failure"],
      [503, "backendError", "provider-failure"],
    ];
    for (const [status, reason, ours] of cases) {
      const failure = said(status, reason);
      expect({ status, reason, ours: failure.error }).toEqual({ status, reason, ours });
      expect(Object.hasOwn(REMOTE_HINTS, failure.error) || PROPOSED.has(failure.error)).toBe(true);
    }
    expect(said(429, "", { "Retry-After": "7" }).wait).toBe(7);
  });

  test("an operation's errors are read by their codes", () => {
    const failed = (code: string): GcpOperation => ({ name: "operation-1", operationType: "insert", status: "DONE", error: { errors: [{ code, message: `said ${code}` }] } });
    expect(operationFailure(failed("ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS"), "create the instance web").failure.error).toBe("type-unavailable");
    expect(operationFailure(failed("QUOTA_EXCEEDED"), "create the instance web").failure.error).toBe("provider-limit");
    expect(operationFailure(failed("RESOURCE_NOT_READY"), "create the instance web").failure).toMatchObject({ error: "action-failed", message: "Google Cloud could not create the instance web (RESOURCE_NOT_READY): said RESOURCE_NOT_READY" });
  });

  test("an answer that is not Google's API, and one that says later in HTML", async () => {
    const answering = (response: Response) =>
      GCP.open({ credentials: TOKEN_CREDENTIALS, environment: { SITESOLIDE_GCP_API: fake.url }, fetcher: async () => response, clock: fakeClock(), secret: () => {} });
    expect((await refusal(answering(new Response("<html>login</html>", { status: 200 })).list())).failure.error).toBe("provider-unreadable");
    expect((await refusal(answering(new Response("<html>bad gateway</html>", { status: 502 })).list())).failure.error).toBe("provider-failure");
    expect((await refusal(answering(Response.json({ items: [] })).list())).failure.error).toBe("provider-unreadable");
  });

  test("the API's address: Google's by default, another only over https or http on the loopback", () => {
    for (const refused of ["http://compute.test-zone.invalid/v1", "https://user:secret@compute.test-zone.invalid/v1", "https://compute.test-zone.invalid/v1?key=1"]) {
      expect(refusalSync(() => GCP.open({ credentials: TOKEN_CREDENTIALS, environment: { SITESOLIDE_GCP_API: refused }, fetcher: fetch, clock: fakeClock(), secret: () => {} })).failure.error).toBe("provider-endpoint");
      expect(refusalSync(() => GCP.open({ credentials: TOKEN_CREDENTIALS, environment: { SITESOLIDE_GCP_OAUTH: refused }, fetcher: fetch, clock: fakeClock(), secret: () => {} })).failure.error).toBe("provider-endpoint");
    }
    const seen: string[] = [];
    const provider = GCP.open({ credentials: TOKEN_CREDENTIALS, environment: {}, fetcher: async (input) => (seen.push(input), Response.json({})), clock: fakeClock(), secret: () => {} });
    return provider.list().then(() => expect(seen[0]).toStartWith(`https://compute.googleapis.com/compute/v1/projects/${FAKE_PROJECT}/aggregated/instances?`));
  });
});

// --- credentials ----------------------------------------------------------------------------

describe("credentials", () => {
  test("a project and either a token or a key are required", () => {
    expect(refusalSync(() => open({ GOOGLE_OAUTH_ACCESS_TOKEN: FAKE_TOKEN })).failure.error).toBe("no-provider-token");
    expect(refusalSync(() => open({ GOOGLE_CLOUD_PROJECT: FAKE_PROJECT })).failure.error).toBe("no-provider-token");
    expect(refusalSync(() => open({ GOOGLE_CLOUD_PROJECT: FAKE_PROJECT, SITESOLIDE_GCP_CLIENT_EMAIL: FAKE_EMAIL })).failure.error).toBe("no-provider-token");
  });

  test("the fields' shapes", () => {
    const shape = (variable: string) => GCP.credentials.find((field) => field.variable === variable)!.shape;
    expect(shape("GOOGLE_CLOUD_PROJECT").test(FAKE_PROJECT)).toBe(true);
    expect(shape("GOOGLE_CLOUD_PROJECT").test("example.com:legacy-project")).toBe(true);
    expect(shape("GOOGLE_CLOUD_PROJECT").test("1project")).toBe(false);
    expect(shape("GOOGLE_OAUTH_ACCESS_TOKEN").test(`ya29.${"a".repeat(2040)}`)).toBe(true);
    expect(shape("GOOGLE_OAUTH_ACCESS_TOKEN").test("ya29.has a space")).toBe(false);
    expect(shape("SITESOLIDE_GCP_CLIENT_EMAIL").test(FAKE_EMAIL)).toBe(true);
    expect(GCP.credentials.filter((field) => field.secret).map((field) => field.variable)).toEqual(["GOOGLE_OAUTH_ACCESS_TOKEN", "SITESOLIDE_GCP_PRIVATE_KEY"]);
  });

  test("a service account's key is exchanged for a token, which is then the only credential sent, and scrubbed", async () => {
    const account = await fake.serviceAccount();
    const credentials = { GOOGLE_CLOUD_PROJECT: FAKE_PROJECT, SITESOLIDE_GCP_CLIENT_EMAIL: account.email, SITESOLIDE_GCP_PRIVATE_KEY: account.privateKey };
    const clock = fakeClock();
    const started = Math.floor(clock.now() / 1000);
    const before = scrubbed.length;
    const provider = open(credentials, clock);
    await provider.create(request(), report);
    const exchange = fake.requests.filter((item) => item.path === "/token");
    expect(exchange).toHaveLength(1);
    const assertion = (exchange[0]!.body as Record<string, string>).assertion!;
    const claims = JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString()) as Record<string, unknown>;
    expect(claims).toEqual({ iss: FAKE_EMAIL, scope: "https://www.googleapis.com/auth/compute", aud: fake.oauthUrl, iat: started, exp: started + 3600 });
    expect(scrubbed.slice(before)).toEqual([assertion, FAKE_EXCHANGED]);
    const api = fake.requests.filter((item) => item.path !== "/token");
    expect(api.every((item) => item.headers.authorization === `Bearer ${FAKE_EXCHANGED}`)).toBe(true);

    // An hour later, a new token: the first is not kept past its life.
    await clock.sleep(3_600_000);
    await provider.list();
    expect(fake.requests.filter((item) => item.path === "/token")).toHaveLength(2);
  });

  test("a key whose newlines are written \\n, as in the JSON, works the same", async () => {
    const account = await fake.serviceAccount();
    const oneLine = account.privateKey.replaceAll("\n", "\\n");
    expect(GCP.credentials.find((field) => field.variable === "SITESOLIDE_GCP_PRIVATE_KEY")!.shape.test(oneLine)).toBe(true);
    await open({ GOOGLE_CLOUD_PROJECT: FAKE_PROJECT, SITESOLIDE_GCP_CLIENT_EMAIL: account.email, SITESOLIDE_GCP_PRIVATE_KEY: oneLine }).list();
    expect(fake.requests[0]!.path).toBe("/token");
  });

  test("a key Google does not know, and one that is not a key, are refused as credentials", async () => {
    await fake.serviceAccount();
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const stranger = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64")}\n-----END PRIVATE KEY-----\n`;
    scrubbed.push(stranger);
    const unknown = await refusal(open({ GOOGLE_CLOUD_PROJECT: FAKE_PROJECT, SITESOLIDE_GCP_CLIENT_EMAIL: FAKE_EMAIL, SITESOLIDE_GCP_PRIVATE_KEY: stranger }).list());
    expect(unknown.failure).toMatchObject({ error: "provider-unauthenticated", message: "Google refused the service account's key (400 invalid_grant): Invalid JWT Signature." });
    fake.requests.length = 0;
    const broken = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
    const garbled = await refusal(open({ GOOGLE_CLOUD_PROJECT: FAKE_PROJECT, SITESOLIDE_GCP_CLIENT_EMAIL: FAKE_EMAIL, SITESOLIDE_GCP_PRIVATE_KEY: broken }).list());
    expect(garbled.failure.error).toBe("provider-unauthenticated");
    expect(fake.requests).toEqual([]);
  });
});

// --- discover -------------------------------------------------------------------------------

type Ran = { code: number; stdout: string; stderr: string };

function workstation(environment: Record<string, string>, files: Record<string, string> = {}, commands: Record<string, Ran> = {}): Workstation & { ran: string[] } {
  const ran: string[] = [];
  return {
    environment,
    ran,
    async run(argv) {
      ran.push(argv.join(" "));
      return commands[argv.join(" ")] ?? { code: 127, stdout: "", stderr: `${argv[0]}: command not found` };
    },
    readFile(path) {
      return files[path] ?? null;
    },
  };
}

const SIGNED_IN: Record<string, Ran> = {
  "gcloud auth print-access-token": { code: 0, stdout: `${FAKE_TOKEN}\n`, stderr: "" },
  "gcloud config get-value project": { code: 0, stdout: "gcloud-project\n", stderr: "Your active configuration is: [default]\n" },
};

describe("discover", () => {
  test("a service account key file GOOGLE_APPLICATION_CREDENTIALS names comes first, and runs nothing", async () => {
    const account = await fake.serviceAccount();
    const station = workstation({ GOOGLE_APPLICATION_CREDENTIALS: "~/keys/sitesolide.json" }, { "~/keys/sitesolide.json": account.keyFile }, SIGNED_IN);
    const found = await discover(station);
    expect(found).toEqual({
      source: "the service account key file GOOGLE_APPLICATION_CREDENTIALS names",
      credentials: { GOOGLE_CLOUD_PROJECT: FAKE_PROJECT, SITESOLIDE_GCP_CLIENT_EMAIL: FAKE_EMAIL, SITESOLIDE_GCP_PRIVATE_KEY: account.privateKey },
    });
    expect(station.ran).toEqual([]);
    // The environment's project wins over the file's.
    const named = await discover(workstation({ GOOGLE_APPLICATION_CREDENTIALS: "k.json", GOOGLE_CLOUD_PROJECT: "named-project" }, { "k.json": account.keyFile }));
    expect(named?.credentials.GOOGLE_CLOUD_PROJECT).toBe("named-project");
  });

  test("an authorized_user file is not a service account's: gcloud is asked instead", async () => {
    const file = JSON.stringify({ type: "authorized_user", client_id: "x", client_secret: "y", refresh_token: "z" });
    expect(readKeyFile(file)).toBeNull();
    const found = await discover(workstation({ GOOGLE_APPLICATION_CREDENTIALS: "adc.json" }, { "adc.json": file }, SIGNED_IN));
    expect(found).toEqual({ source: "the gcloud CLI, signed in", credentials: { GOOGLE_CLOUD_PROJECT: "gcloud-project", GOOGLE_OAUTH_ACCESS_TOKEN: FAKE_TOKEN } });
  });

  test("gcloud signed in: its token, and the project CLOUDSDK_CORE_PROJECT names before its configuration", async () => {
    const station = workstation({ CLOUDSDK_CORE_PROJECT: "core-project" }, {}, SIGNED_IN);
    expect(await discover(station)).toEqual({ source: "the gcloud CLI, signed in", credentials: { GOOGLE_CLOUD_PROJECT: "core-project", GOOGLE_OAUTH_ACCESS_TOKEN: FAKE_TOKEN } });
    expect(station.ran).toEqual(["gcloud auth print-access-token"]);
  });

  test("no gcloud, gcloud signed out, or an answer that is not a token: nothing", async () => {
    expect(await discover(workstation({}))).toBeNull();
    expect(await discover(workstation({}, {}, { "gcloud auth print-access-token": { code: 1, stdout: "", stderr: "ERROR: (gcloud.auth.print-access-token) You do not currently have an active account selected." } }))).toBeNull();
    expect(await discover(workstation({}, {}, { "gcloud auth print-access-token": { code: 0, stdout: "WARNING: this is not a token\n", stderr: "" } }))).toBeNull();
    expect(await discover(workstation({ GOOGLE_APPLICATION_CREDENTIALS: "missing.json" }))).toBeNull();
  });
});

// --- the wizard's lists ---------------------------------------------------------------------

describe("locations and types", () => {
  test("one zone a region, the default first, with its city; zones down, deprecated or for AI left out", async () => {
    const locations = await open().locations();
    expect(locations[0]).toEqual({ value: "europe-west4-a", label: "Eemshaven, NL", hint: "europe-west4, zones a, b, c" });
    expect(locations.map((choice) => choice.value)).toEqual(["europe-west4-a", "europe-west1-b", "europe-west3-a", "europe-west9-a", "us-central1-a", "us-west4-a"]);
    expect(locations.find((choice) => choice.value === "europe-west9-a")?.hint).toBe("europe-west9, zones a, b");
    expect(locations.find((choice) => choice.value === "us-central1-a")?.label).toBe("Council Bluffs, Iowa, US");
    expect(writes()).toEqual([]);
  });

  test("the types worth offering: the default first, x86, 2 GB at least, not deprecated, twelve at most", async () => {
    const types = await open().types("europe-west4-a");
    expect(types[0]).toEqual({ value: "e2-small", label: "e2-small", hint: "2 vCPU (shared core), 2 GB memory" });
    expect(types.map((choice) => choice.value)).toEqual(["e2-small", "e2-medium", "e2-standard-2", "e2-standard-4", "e2-standard-8", "n4-standard-2", "n4-standard-4", "n4d-standard-2", "c4-standard-2", "n2-standard-2", "n2d-standard-2"]);
    expect((await open().types("europe-west3-a")).map((choice) => choice.value)).not.toContain("c4-standard-2");
    const many = Array.from({ length: 30 }, (_, index) => ({ ...MACHINE_TYPES[3]!, name: `e2-standard-${index % 2 === 0 ? 2 : 4}` }) as GcpMachineType);
    expect(offeredTypes(many)).toHaveLength(12);
    expect(await open().types("not a zone")).toEqual([]);
  });

  test("the defaults: e2-small in the Netherlands, Debian 13; gcloud's default zone when it has one", () => {
    expect(GCP.defaults({})).toEqual({ type: "e2-small", location: "europe-west4-a", image: "debian-13" });
    expect(GCP.defaults({ CLOUDSDK_COMPUTE_ZONE: "europe-west9-b" }).location).toBe("europe-west9-b");
    expect(GCP.defaults({ CLOUDSDK_COMPUTE_ZONE: "nowhere" }).location).toBe("europe-west4-a");
    expect(GCP).toMatchObject({ name: "gcp", backups: false, apiVariable: "SITESOLIDE_GCP_API", docs: "docs/providers/gcp.md" });
  });
});

// --- marks -----------------------------------------------------------------------------------

describe("what counts as sitesolide's", () => {
  test("a rule: its name, its mark and the machine's tag alone", () => {
    const [allow, deny] = firewallRules("web", "global/networks/default");
    const as = (rule: object) => ({ id: "1", ...rule }) as GcpFirewall;
    expect(ownRule(as(allow!), "web")).toBe(true);
    expect(ownRule(as(deny!), "web")).toBe(true);
    expect(ownRule(as(allow!), "db")).toBe(false);
    expect(ownRule(as({ ...allow, description: "managed-by=sitesolide sitesolide-machine=webby: x" }), "web")).toBe(false);
    expect(ownRule(as({ ...allow, targetTags: [] }), "web")).toBe(false);
    expect(ownRule(as({ ...allow, targetServiceAccounts: ["x@test-zone.invalid"] }), "web")).toBe(false);
  });

  test("an address: its labels, or its name and mark while it has no labels", () => {
    const as = (address: Partial<GcpAddress>) => ({ id: "1", name: addressNameOf("web"), ...address }) as GcpAddress;
    expect(ownAddress(as({ labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" } }), "web")).toBe(true);
    expect(ownAddress(as({ labels: { "managed-by": "sitesolide", "sitesolide-machine": "db" } }), "web")).toBe(false);
    expect(ownAddress(as({ description: `${markOf("web")}: x` }), "web")).toBe(true);
    expect(ownAddress(as({ description: `${markOf("web")}: x`, labels: { team: "data" } }), "web")).toBe(false);
    expect(ownAddress(as({}), "web")).toBe(false);
  });

  test("the ssh-keys entry, a comment Google would read as an expiry left out", () => {
    expect(sshKeysEntry(KEY)).toBe(`sitesolide:ssh-ed25519 ${KEY.blob} ada@workstation.test-zone.invalid`);
    expect(sshKeysEntry({ ...KEY, comment: 'google-ssh {"userName":"x","expireOn":"2020-01-01T00:00:00+0000"}' })).toBe(`sitesolide:ssh-ed25519 ${KEY.blob}`);
  });
});

// --- last: what was printed -------------------------------------------------------------------

describe("credentials never leave where they belong", () => {
  test("in no address, no line reported and no refusal", async () => {
    const credentials = [...fake.secrets, ...scrubbed].filter((value) => value.length > 0);
    expect(credentials.length).toBeGreaterThanOrEqual(3);
    expect(urls.length).toBeGreaterThan(100);
    for (const url of urls) {
      for (const value of credentials) expect(url.includes(value)).toBe(false);
    }
    const text = printed.join("\n");
    for (const value of credentials) expect(text.includes(value)).toBe(false);
    expect(text).not.toContain("ya29.");
    expect(text).not.toContain("BEGIN PRIVATE KEY");
  });
});
