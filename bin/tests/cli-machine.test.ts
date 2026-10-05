import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMOTE_HINTS } from "../cli/hints";
import {
  choosePublicKey,
  DEFAULTS,
  machine,
  MACHINE_USAGE,
  machineTable,
  parseMachineArguments,
  readPublicKey,
  shown,
  tcpProbe,
  type MachineDependencies,
} from "../cli/machine";
import { apiBase, cheapestTypes, failureFrom, hostAddress, offerWarnings, suggestedTypes, typeOffer, WAITS, type HetznerServerType } from "../cli/providers/hetzner";
import type { OutputEvent } from "../cli/output";
import { eventOutput, humanOutput, type Output } from "../cli/remote";
import { createFakeVm, type FakeVm } from "./e2e/fake-vm";
import { CLI, REPO } from "./e2e/run";
import { createFakeHetzner, FAKE_TOKEN, SERVER_TYPES, type FakeHetzner } from "./fake-hetzner";

/**
 * `sitesolide machine`, against a local fake of the Hetzner Cloud API
 * (fake-hetzner.ts): the real one is never called. Most tests run the command
 * in this process, with the fake's address, a clock that does not wait, and
 * port 22 pointed at a local listener; the last ones run the real
 * bin/sitesolide.ts in a child process, with a HOME of its own and the fake
 * machine's `ssh` first on PATH, which logs anything that reaches it.
 *
 * Whatever the path, the token must never appear in what is printed: every
 * run of this file adds its output to `printed`, read at the end.
 */

/** Generated for these tests with ssh-keygen; the private halves were deleted at once. */
const ED25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICezpiOyiQWMYqOeL4S4OgE0T7Fq2bLHWUJ1afO4cczN ada@workstation.test-zone.invalid";
/** What `ssh-keygen -E md5 -lf` printed for it. */
const ED25519_MD5 = "a4:46:30:d5:fd:7e:1a:77:e5:ad:8d:21:4f:9a:3e:9e";
const RSA =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDCdJWi+3KfOZP6ARBvtusfyCxfyZWSBpo1smBB7F0vcG1/HE9YixVmfSLEGo3ooja9G7Y/787HEek0wxExEwdaDMNBcSq/V1wRpZG9zimD7eKfiubJePOuG6P2ISfmJqZmAqd3BsWX7HLsZ7+zMZzKIIlgmHzfA2pX0k4r8FhA10aj4h78gcNk3CyAq7/d/AHkgvIepgtNv7zpPOjPEMbxtJSQN3dc3Sg/5nC4hsEPbWGvQt0uSjoyddTHrWxwcPOPfR7q88YMbJQHZD/k5grqCjN+hvQlylGk06z9rkR4sH9NJsEQiwIUaWUrpysY/DwJiu2EgUJjcImXfoU4ZC55";
const RSA_MD5 = "04:af:9d:90:7f:64:6b:21:05:6d:ff:9b:00:06:7d:df";

/** Another key, for the project's other machines: any ed25519 blob of the right shape. */
function otherKey(seed: number): string {
  const name = Buffer.from("ssh-ed25519");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(name.length);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(32);
  return `ssh-ed25519 ${Buffer.concat([head, name, size, Buffer.alloc(32, seed)]).toString("base64")} other-${seed}`;
}

let fake: FakeHetzner;
let listener: Bun.TCPSocketListener<undefined>;
let home: string;
const toClean: string[] = [];
/** Everything any run of this file printed, read by the last test. */
const printed: string[] = [];

beforeAll(() => {
  fake = createFakeHetzner();
  // Port 22 of every machine the fake creates, for the wait that ends `create`.
  listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
});

afterAll(() => {
  fake.stop();
  listener.stop(true);
  for (const folder of toClean) rmSync(folder, { recursive: true, force: true });
});

beforeEach(() => {
  fake.reset();
  home = mkdtempSync(join(tmpdir(), "machine-home-"));
  toClean.push(home);
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "id_ed25519.pub"), `${ED25519}\n`);
});

function fakeClock() {
  let now = Date.parse("2026-10-05T10:00:00Z");
  return { now: () => now, sleep: async (milliseconds: number) => void (now += milliseconds) };
}

type Run = { code: number; events: OutputEvent[]; last: OutputEvent; text: string };

/** The command in this process, under --json, against the fake. */
async function run(arguments_: string[], extra: Partial<MachineDependencies> = {}): Promise<Run> {
  const lines: string[] = [];
  const code = await machine(["machine", ...arguments_, "--json"], {
    environment: { HCLOUD_TOKEN: FAKE_TOKEN, SITESOLIDE_HETZNER_API: fake.url },
    home,
    output: eventOutput((line) => lines.push(line)),
    clock: fakeClock(),
    sshTarget: () => ({ hostname: "127.0.0.1", port: listener.port }),
    interactive: false,
    ...extra,
  });
  printed.push(...lines);
  const events = lines.map((line) => JSON.parse(line) as OutputEvent);
  return { code, events, last: events.at(-1)!, text: lines.join("\n") };
}

function errorOf(result: Run): Extract<OutputEvent, { type: "error" }> {
  expect(result.code).toBe(1);
  expect(result.last.type).toBe("error");
  return result.last as Extract<OutputEvent, { type: "error" }>;
}

function resultOf(result: Run): Record<string, unknown> {
  expect({ code: result.code, last: result.last.type }).toEqual({ code: 0, last: "result" });
  return result.last as unknown as Record<string, unknown>;
}

/** The requests that changed something, as `METHOD /path`. */
function writes(): string[] {
  return fake.requests.filter((request) => request.method !== "GET").map((request) => `${request.method} ${request.path}`);
}

const CREATE = ["create", "--provider", "hetzner", "--name", "web"];

// --- the pieces ------------------------------------------------------------------------------

describe("the public key", () => {
  test("an ed25519 and an RSA key read as OpenSSH reads them, with the MD5 fingerprint ssh-keygen prints", () => {
    expect(readPublicKey(`${ED25519}\n`)).toEqual({
      algorithm: "ssh-ed25519",
      blob: "AAAAC3NzaC1lZDI1NTE5AAAAICezpiOyiQWMYqOeL4S4OgE0T7Fq2bLHWUJ1afO4cczN",
      comment: "ada@workstation.test-zone.invalid",
      fingerprint: ED25519_MD5,
    });
    expect(readPublicKey(RSA)?.fingerprint).toBe(RSA_MD5);
    expect(readPublicKey(RSA)?.comment).toBe("");
  });

  test("anything else is not a public key", () => {
    expect(readPublicKey("")).toBeNull();
    expect(readPublicKey("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n")).toBeNull();
    expect(readPublicKey("ssh-dss AAAAB3NzaC1kc3M= old")).toBeNull();
    // A blob whose first field names another algorithm than the line does.
    expect(readPublicKey(`ssh-rsa ${ED25519.split(" ")[1]}`)).toBeNull();
    expect(readPublicKey("ssh-ed25519 not*base64")).toBeNull();
  });

  test("the default is the first of id_ed25519, id_ecdsa and id_rsa this workstation has", () => {
    const present = new Set([join(home, ".ssh", "id_rsa.pub"), join(home, ".ssh", "id_ecdsa.pub")]);
    expect(choosePublicKey(undefined, home, (path) => present.has(path))).toBe(join(home, ".ssh", "id_ecdsa.pub"));
    const none = choosePublicKey(undefined, home, () => false);
    expect(none).toMatchObject({ error: "no-ssh-key" });
    expect(JSON.stringify(none)).toContain("ssh-keygen -t ed25519");
  });

  test("--ssh-key takes the .pub, never a private key", () => {
    expect(choosePublicKey("~/.ssh/id_ed25519", home, () => true)).toMatchObject({ error: "no-ssh-key" });
    expect(choosePublicKey("~/keys/deploy.pub", home, () => false)).toMatchObject({ error: "no-ssh-key", message: `no such public key: ${join(home, "keys", "deploy.pub")}` });
    expect(choosePublicKey("~/keys/deploy.pub", home, () => true)).toBe(join(home, "keys", "deploy.pub"));
  });
});

describe("the arguments", () => {
  test("a command is required, and only the three exist", () => {
    expect(parseMachineArguments(["machine"])).toMatchObject({ error: "machine-usage", message: "sitesolide machine needs a command: create, list or destroy" });
    expect(parseMachineArguments(["machine", "--json"])).toMatchObject({ error: "machine-usage" });
    expect(parseMachineArguments(["machine", "start"])).toMatchObject({ error: "machine-usage", message: "unknown machine command: start" });
  });

  test("each command takes its own options, and a destroy its name", () => {
    expect(parseMachineArguments(["machine", "create", "--provider", "hetzner", "--name", "web", "--backups", "--json"])).toEqual({
      action: "create",
      values: { "--provider": "hetzner", "--name": "web" },
      flags: new Set(["--backups"]),
      positionals: [],
    });
    expect(parseMachineArguments(["machine", "destroy", "web", "--provider", "hetzner", "--confirm", "web"])).toMatchObject({ action: "destroy", positionals: ["web"] });
    expect(parseMachineArguments(["machine", "list", "--name", "web"])).toMatchObject({ error: "machine-option", message: "--name: not an option of sitesolide machine list" });
    expect(parseMachineArguments(["machine", "create", "--type"])).toMatchObject({ error: "machine-option", message: "--type needs a value" });
    expect(parseMachineArguments(["machine", "destroy", "web", "db"])).toMatchObject({ error: "machine-option", message: "unexpected argument: db" });
  });

  test("a token passed as an option is refused without being repeated", () => {
    for (const attempt of [["--token", FAKE_TOKEN], [`--token=${FAKE_TOKEN}`]]) {
      const refusal = parseMachineArguments(["machine", "list", "--provider", "hetzner", ...attempt]);
      expect(refusal).toMatchObject({ error: "machine-option", message: "--token: not an option of sitesolide machine list" });
      expect(JSON.stringify(refusal)).not.toContain(FAKE_TOKEN);
      expect(JSON.stringify(refusal)).toContain("--token-stdin");
    }
    expect(shown("a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8")).toBe("(not shown)");
    expect(shown("web")).toBe("web");
  });

  test("the provider is named, and an unknown one is refused with the known ones", async () => {
    const missing = errorOf(await run(["list"]));
    expect(missing.message).toContain("--provider is required");
    expect(missing.details).toEqual(["the providers sitesolide knows: hetzner"]);
    const unknown = errorOf(await run(["list", "--provider", "aws"]));
    expect(unknown.message).toBe("unknown provider: aws");
    expect(unknown.hint).toBe(REMOTE_HINTS["unknown-provider"]!);
    expect(fake.requests).toEqual([]);
  });

  test("a machine's name is a hostname, checked before anything leaves", async () => {
    expect(errorOf(await run(["create", "--provider", "hetzner"])).message).toContain("the machine's name is required");
    expect(errorOf(await run(["create", "--provider", "hetzner", "--name", "Web_1"])).message).toBe("not a machine name: Web_1");
    expect(errorOf(await run(["destroy", "-web", "--provider", "hetzner"])).message).toContain("not an option");
    expect(fake.requests).toEqual([]);
  });
});

describe("the API's address", () => {
  test("Hetzner's by default; another only over https, or http on the loopback", () => {
    expect(apiBase({})).toBe("https://api.hetzner.cloud/v1");
    expect(apiBase({ SITESOLIDE_HETZNER_API: "http://127.0.0.1:4242/v1/" })).toBe("http://127.0.0.1:4242/v1");
    for (const refused of ["http://api.test-zone.invalid/v1", "https://user:secret@api.test-zone.invalid/v1", "https://api.test-zone.invalid/v1?x=1", "not an url"]) {
      expect(() => apiBase({ SITESOLIDE_HETZNER_API: refused })).toThrow();
    }
  });
});

describe("the API's errors", () => {
  const now = Date.parse("2026-10-05T10:00:00Z");
  const said = (status: number, code: string, headers: Record<string, string> = {}, details: unknown = null) =>
    failureFrom(status, { error: { code, message: `the API says ${code}`, details } }, new Headers(headers), "create the server web", now).failure;

  test("each status gets its own code, which hints.ts knows", () => {
    const cases: [number, string, string][] = [
      [401, "unauthorized", "provider-unauthenticated"],
      [403, "forbidden", "provider-forbidden"],
      [403, "resource_limit_exceeded", "provider-limit"],
      [403, "maintenance", "provider-unavailable"],
      [404, "not_found", "provider-not-found"],
      [409, "uniqueness_error", "provider-name-taken"],
      [409, "conflict", "provider-busy"],
      [412, "resource_unavailable", "provider-unavailable"],
      [422, "invalid_input", "provider-invalid"],
      [423, "locked", "provider-busy"],
      [429, "rate_limit_exceeded", "provider-rate-limited"],
      [500, "server_error", "provider-failure"],
      [503, "unavailable", "provider-failure"],
      [504, "timeout", "provider-failure"],
    ];
    for (const [status, code, ours] of cases) {
      const failure = said(status, code);
      expect({ status, code, ours: failure.error }).toEqual({ status, code, ours });
      expect(Object.hasOwn(REMOTE_HINTS, failure.error)).toBe(true);
    }
  });

  test("a 401 says the token was refused, and says it in a way that never repeats it", () => {
    const failure = said(401, "unauthorized");
    expect(failure.message).toBe("Hetzner refused the token (401 unauthorized): it is unknown, revoked, or was copied wrong");
    expect(failure.details?.join(" ")).toContain("Read & Write");
  });

  test("a 422 lists the fields the API refused", () => {
    const failure = said(422, "invalid_input", {}, { fields: [{ name: "image", messages: ["image not found"] }] });
    expect(failure.message).toBe("Hetzner refused to create the server web (422 invalid_input): the API says invalid_input");
    expect(failure.details).toEqual(["image: image not found"]);
  });

  test("a 429 says how long to wait, from Retry-After, else from the reset, a minute at most", () => {
    const reset = String(now / 1000 + 900);
    const fromReset = said(429, "rate_limit_exceeded", { "RateLimit-Limit": "3600", "RateLimit-Remaining": "0", "RateLimit-Reset": reset });
    expect(fromReset.wait).toBe(60);
    expect(fromReset.details).toEqual(["the project may make 3600 requests an hour, given back gradually", "all of them are back in 900 s"]);
    expect(said(429, "rate_limit_exceeded", { "Retry-After": "7", "RateLimit-Reset": reset }).wait).toBe(7);
    expect(said(429, "rate_limit_exceeded", { "RateLimit-Reset": String(now / 1000 + 4) }).wait).toBe(4);
  });
});

describe("what Hetzner sells", () => {
  const now = Date.parse("2026-10-05T10:00:00Z");
  const types = SERVER_TYPES as unknown as HetznerServerType[];
  const type = (name: string) => types.find((candidate) => candidate.name === name)!;

  test("a type is orderable where it is sold and not past its end", () => {
    expect(typeOffer(type("cx23"), "fsn1", now)).toEqual({ orderable: true, reason: "", listedAvailable: true, deprecatedUntil: null });
    expect(typeOffer(type("cpx11"), "fsn1", now)).toMatchObject({ orderable: false, reason: "cpx11 is not sold at fsn1" });
    expect(typeOffer(type("cx22"), "fsn1", now)).toMatchObject({ orderable: false, reason: "cx22 is no longer sold at fsn1" });
    const late = typeOffer(type("cx22"), "fsn1", Date.parse("2025-11-01T00:00:00Z"));
    expect(late).toMatchObject({ orderable: true, deprecatedUntil: "2026-01-01" });
    expect(offerWarnings("cx22", "fsn1", late)).toEqual(["cx22 is deprecated at fsn1, sold until 2026-01-01"]);
  });

  test("a type Hetzner lists as unavailable is still orderable, with a warning: the flag was seen false for a type it then created", () => {
    const offer = typeOffer(type("cx43"), "hel1", now);
    expect(offer).toEqual({ orderable: true, reason: "", listedAvailable: false, deprecatedUntil: null });
    expect(offerWarnings("cx43", "hel1", offer)).toEqual(["Hetzner lists cx43 as unavailable at hel1; trying anyway"]);
  });

  test("an answer without per-location details falls back on where the type has a price", () => {
    const { locations: _, ...older } = type("cx23");
    expect(typeOffer(older as HetznerServerType, "fsn1", now).orderable).toBe(true);
    expect(typeOffer(older as HetznerServerType, "ash", now).orderable).toBe(false);
  });

  test("the cheapest types of a location come first, the deprecated ones left out", () => {
    const lines = cheapestTypes(types, "fsn1", now, "EUR");
    expect(lines.map((line) => line.split(" ")[0])).toEqual(["cx23", "cax11", "cx33", "cx43", "ccx13"]);
    expect(lines[0]).toBe("cx23     2 vCPU, 4 GB RAM, 40 GB disk, x86, 3.49 EUR a month before VAT");
    expect(cheapestTypes(types, "hel1", now, "EUR", { availableOnly: true, except: "cx23" }).map((line) => line.split(" ")[0])).toEqual(["cax11", "cx33", "ccx13"]);
  });

  test("the suggestions are the types listed as available, else the cheapest sold all the same", () => {
    expect(suggestedTypes(types, "hel1", now, null)[0]).toBe("the cheapest types Hetzner lists as available at hel1:");
    const flagged = types.map((candidate) => ({ ...candidate, locations: candidate.locations?.map((entry) => ({ ...entry, available: false })) }));
    const fallback = suggestedTypes(flagged, "fsn1", now, null, "cx23");
    expect(fallback[0]).toBe("Hetzner lists no type as available at fsn1; the cheapest it sells there:");
    expect(fallback[1]).toStartWith("cax11 ");
    expect(suggestedTypes(types, "par1", now, null)).toEqual(["Hetzner sells no other type at par1"]);
  });

  test("the IPv6 address is the network's first, as Hetzner's images configure it", () => {
    expect(hostAddress("2001:db8:10::/64")).toBe("2001:db8:10::1");
    expect(hostAddress(null)).toBeNull();
  });
});

// --- create ------------------------------------------------------------------------------------

describe("machine create", () => {
  test("a fresh project: key uploaded, firewall, server, backups, then the waits, in that order", async () => {
    for (const seed of [1, 2, 3]) fake.addKey({ name: `laptop-${seed}`, public_key: otherKey(seed) });
    const result = resultOf(await run([...CREATE, "--backups"]));

    const page = (search: string) => new URLSearchParams(search).get("page");
    expect(fake.requests.map((request) => `${request.method} ${request.path.replace(/[0-9]+/g, ":id")}${page(request.search) === null ? "" : `?page=${page(request.search)}`}`)).toEqual([
      "GET /servers?page=1",
      "GET /locations?page=1",
      "GET /locations?page=2",
      "GET /server_types?page=1",
      "GET /server_types?page=2",
      "GET /server_types?page=3",
      "GET /server_types?page=4",
      "GET /pricing",
      "GET /firewalls?page=1",
      "GET /ssh_keys?page=1",
      "GET /ssh_keys?page=2",
      "POST /ssh_keys",
      "POST /firewalls",
      "POST /servers",
      // create_server, then start_server, two polls each
      "GET /actions/:id",
      "GET /actions/:id",
      "GET /actions/:id",
      "GET /actions/:id",
      "POST /servers/:id/actions/enable_backup",
      "GET /actions/:id",
      "GET /actions/:id",
      "GET /servers/:id",
    ]);
    expect(new URLSearchParams(fake.requests[0]!.search).get("name")).toBe("web");

    const [key] = fake.keys.filter((candidate) => candidate.name.startsWith("sitesolide-"));
    expect(key).toMatchObject({ name: "sitesolide-web", fingerprint: ED25519_MD5, public_key: ED25519, labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" } });
    const firewall = fake.firewalls[0]!;
    expect(firewall.name).toBe("web");
    expect(firewall.labels).toEqual({ "managed-by": "sitesolide", "sitesolide-machine": "web" });
    expect(firewall.rules).toEqual([
      { direction: "in", protocol: "tcp", port: "22", source_ips: ["0.0.0.0/0", "::/0"], description: "ssh" },
      { direction: "in", protocol: "tcp", port: "80", source_ips: ["0.0.0.0/0", "::/0"], description: "http" },
      { direction: "in", protocol: "tcp", port: "443", source_ips: ["0.0.0.0/0", "::/0"], description: "https" },
      { direction: "in", protocol: "icmp", source_ips: ["0.0.0.0/0", "::/0"], description: "ping" },
    ]);
    const order = fake.requests.find((request) => request.method === "POST" && request.path === "/servers")!.body as Record<string, unknown>;
    expect(order).toEqual({
      name: "web",
      server_type: DEFAULTS.type,
      location: DEFAULTS.location,
      image: DEFAULTS.image,
      ssh_keys: [key!.id],
      firewalls: [{ firewall: firewall.id }],
      public_net: { enable_ipv4: true, enable_ipv6: true },
      labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" },
      start_after_create: true,
    });
    expect("user_data" in order).toBe(false);

    expect(result).toMatchObject({
      command: "machine create",
      provider: "hetzner",
      created: true,
      machine: { name: "web", type: "cx23", location: "fsn1", status: "running", ipv4: "203.0.113.10", ipv6: "2001:db8:10::1", ipv6Network: "2001:db8:10::/64", backups: true, managed: true, monthlyPrice: { net: "3.4900000000", currency: "EUR" } },
      next: "sitesolide setup root@203.0.113.10 --zone <your zone> --email <you>",
    });
    expect(result.resources).toEqual([
      { kind: "ssh key", name: "sitesolide-web", id: String(key!.id), reused: false },
      { kind: "firewall", name: "web", id: String(firewall.id), reused: false },
      { kind: "server", name: "web", id: String(fake.servers[0]!.id), reused: false },
    ]);
    expect(fake.servers[0]!.backup_window).not.toBeNull();
  });

  test("the steps say what they do, and the run ends on the setup command", async () => {
    const { events } = await run(CREATE);
    const said = events.filter((event) => event.type === "step" || event.type === "info").map((event) => (event as { message: string }).message);
    expect(said).toContain("machine web at Hetzner: cx23 at fsn1, debian-13");
    expect(said).toContain(`SSH key ~/.ssh/id_ed25519.pub, ${ED25519_MD5}`);
    expect(said).toContain("create_server: done");
    expect(said).toContain("status: running");
    expect(said).toContain("SSH on 203.0.113.10");
    expect(said.some((line) => /^port 22 answers, after [0-9]+ s$/.test(line))).toBe(true);
    expect(said).toContain("next: sitesolide setup root@203.0.113.10 --zone <your zone> --email <you>");
  });

  test("a second run finds everything and changes nothing", async () => {
    resultOf(await run([...CREATE, "--backups"]));
    const before = fake.requests.length;
    const again = resultOf(await run([...CREATE, "--backups"]));
    expect(again.created).toBe(false);
    expect(fake.requests.slice(before).filter((request) => request.method !== "GET")).toEqual([]);
    expect(fake.servers).toHaveLength(1);
    expect(fake.firewalls).toHaveLength(1);
    expect(fake.keys).toHaveLength(1);
  });

  test("a key already in the project is reused under whatever name it has, found on any page", async () => {
    for (const seed of [1, 2, 3, 4]) fake.addKey({ name: `laptop-${seed}`, public_key: otherKey(seed) });
    fake.addKey({ name: "ada's laptop", public_key: ED25519.replace("ada@workstation.test-zone.invalid", "another comment") });
    const result = resultOf(await run(CREATE));
    expect(writes()).not.toContain("POST /ssh_keys");
    expect(fake.requests.filter((request) => request.path === "/ssh_keys")).toHaveLength(3);
    expect((result.resources as { kind: string; name: string; reused: boolean }[])[0]).toMatchObject({ kind: "ssh key", name: "ada's laptop", reused: true });
  });

  test("an upload never takes the name of another key", async () => {
    fake.addKey({ name: "sitesolide-web", public_key: otherKey(9) });
    resultOf(await run(CREATE));
    expect(fake.keys.map((key) => key.name)).toEqual(["sitesolide-web", `sitesolide-web-${ED25519_MD5.replaceAll(":", "").slice(0, 8)}`]);
  });

  test("a firewall sitesolide created is reused, found on any page", async () => {
    for (const name of ["a", "b", "c", "d"]) fake.addFirewall({ name });
    fake.addFirewall({ name: "web", labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" } });
    resultOf(await run(CREATE));
    expect(writes()).not.toContain("POST /firewalls");
    expect(fake.requests.filter((request) => request.path === "/firewalls")).toHaveLength(3);
  });

  test("a firewall of that name sitesolide did not create stops everything before the server", async () => {
    fake.addFirewall({ name: "web" });
    const refusal = errorOf(await run(CREATE));
    expect(refusal.message).toBe("a firewall named web exists in the project, and sitesolide did not create it");
    expect(refusal.hint).toBe(REMOTE_HINTS["firewall-taken"]!);
    expect(writes()).toEqual([]);
  });

  test("a server of that name sitesolide did not create is refused, with its addresses, before anything is created", async () => {
    fake.addServer({ name: "web", ipv4: "203.0.113.77", ipv6: "2001:db8:77::/64" });
    const refusal = errorOf(await run(CREATE));
    expect(refusal.message).toBe("a server named web exists in the project, and sitesolide did not create it");
    expect(refusal.details[0]).toBe("cx33 at fsn1, running, 203.0.113.77, 2001:db8:77::1");
    expect(refusal.hint).toBe(REMOTE_HINTS["machine-exists"]!);
    expect(writes()).toEqual([]);
  });

  test("a server sitesolide created is reported as created, and waited for", async () => {
    fake.addServer({ name: "web", labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" } });
    const result = await run(CREATE);
    expect(resultOf(result)).toMatchObject({ created: false, machine: { type: "cx33", status: "running" } });
    expect(result.events).toContainEqual({ type: "warning", message: "it is cx33 at fsn1: --type and --location only apply to a machine being created", details: [] });
    expect(writes()).toEqual([]);
  });

  test("a server sitesolide created but powered off is said, never powered on", async () => {
    fake.addServer({ name: "web", labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" }, status: "off" });
    expect(errorOf(await run(CREATE)).message).toBe("web exists but is powered off");
    expect(writes()).toEqual([]);
  });

  test("backups are turned on for a server that has none, and left alone when it has them", async () => {
    const labels = { "managed-by": "sitesolide", "sitesolide-machine": "web" };
    const server = fake.addServer({ name: "web", labels, server_type: "cx23" });
    resultOf(await run([...CREATE, "--backups"]));
    expect(writes()).toEqual([`POST /servers/${server.id}/actions/enable_backup`]);
    fake.requests.length = 0;
    resultOf(await run([...CREATE, "--backups"]));
    expect(writes()).toEqual([]);
  });

  test("an unknown type is refused with the cheapest the location sells, before anything is created", async () => {
    const refusal = errorOf(await run([...CREATE, "--type", "cx99"]));
    expect(refusal.message).toBe("cx99 is not a Hetzner server type");
    expect(refusal.details[0]).toBe("the cheapest types Hetzner lists as available at fsn1:");
    expect(refusal.details[1]).toStartWith("cx23 ");
    expect(refusal.details.join("\n")).not.toContain("cx22");
    expect(refusal.hint).toBe(REMOTE_HINTS["invalid-server-type"]!);
    expect(writes()).toEqual([]);
  });

  test("a type not sold or retired at the location is refused the same way", async () => {
    expect(errorOf(await run([...CREATE, "--type", "cpx11"])).message).toBe("cpx11 is not sold at fsn1");
    expect(errorOf(await run([...CREATE, "--type", "cx22"])).message).toBe("cx22 is no longer sold at fsn1");
    expect(errorOf(await run([...CREATE, "--type", "cx23", "--location", "ash"])).details).toEqual([
      "the cheapest types Hetzner lists as available at ash:",
      "cpx11    2 vCPU, 2 GB RAM, 40 GB disk, x86, 4.99 EUR a month before VAT",
      "ccx13    2 vCPU, 8 GB RAM, 80 GB disk, x86, 12.49 EUR a month before VAT",
    ]);
    expect(writes()).toEqual([]);
  });

  test("a type Hetzner lists as unavailable is ordered all the same, after a warning", async () => {
    const result = await run([...CREATE, "--type", "cx43", "--location", "hel1"]);
    expect(resultOf(result)).toMatchObject({ created: true, machine: { type: "cx43", location: "hel1" } });
    expect(result.events).toContainEqual({ type: "warning", message: "Hetzner lists cx43 as unavailable at hel1; trying anyway", details: [] });
    expect(writes()).toContain("POST /servers");
  });

  test("an order Hetzner refuses for the type lists what to try instead, and undoes what the run created", async () => {
    for (const seed of [1, 2]) fake.addKey({ name: `laptop-${seed}`, public_key: otherKey(seed) });
    fake.fail("POST", /^\/servers$/, 412, "resource_unavailable", "server type cx43 is not available in location hel1");
    const result = await run([...CREATE, "--type", "cx43", "--location", "hel1"]);
    const refusal = errorOf(result);
    expect(refusal.message).toBe("Hetzner would not create cx43 at hel1 (412 resource_unavailable): server type cx43 is not available in location hel1");
    expect(refusal.details).toEqual([
      "the cheapest types Hetzner lists as available at hel1:",
      "cx23     2 vCPU, 4 GB RAM, 40 GB disk, x86, 3.49 EUR a month before VAT",
      "cax11    2 vCPU, 4 GB RAM, 40 GB disk, arm, 3.79 EUR a month before VAT",
      "cx33     4 vCPU, 8 GB RAM, 80 GB disk, x86, 5.49 EUR a month before VAT",
      "ccx13    2 vCPU, 8 GB RAM, 80 GB disk, x86, 12.49 EUR a month before VAT",
      "or try another --location",
      "deleted the firewall web this run had created",
      "deleted the SSH key sitesolide-web this run had created",
    ]);
    expect(refusal.hint).toBe(REMOTE_HINTS["type-unavailable"]!);
    expect(writes().map((write) => write.replace(/[0-9]+/g, ":id"))).toEqual(["POST /ssh_keys", "POST /firewalls", "POST /servers", "DELETE /firewalls/:id", "DELETE /ssh_keys/:id"]);
    expect(fake.firewalls).toEqual([]);
    expect(fake.keys.map((key) => key.name)).toEqual(["laptop-1", "laptop-2"]);
  });

  test("the other refusals of the order count as the type's: a placement, a product unavailable, the type or location named invalid", async () => {
    const cases: [number, string, unknown][] = [
      [422, "placement_error", null],
      [503, "unavailable", null],
      [422, "invalid_input", { fields: [{ name: "server_type", messages: ["server type not available in this location"] }] }],
      [422, "invalid_input", { fields: [{ name: "location", messages: ["unsupported location for server type"] }] }],
    ];
    for (const [status, code, details] of cases) {
      fake.reset();
      fake.fail("POST", /^\/servers$/, status, code, "refused", { details });
      expect({ code, error: errorOf(await run(CREATE)).hint }).toEqual({ code, error: REMOTE_HINTS["type-unavailable"]! });
      expect(fake.firewalls).toEqual([]);
    }
    // An invalid image is the request's fault, not the offer's: no suggestion of types, but nothing left behind either.
    fake.reset();
    fake.fail("POST", /^\/servers$/, 422, "invalid_input", "invalid input in field 'image'", { details: { fields: [{ name: "image", messages: ["image not found"] }] } });
    const image = errorOf(await run(CREATE));
    expect(image.hint).toBe(REMOTE_HINTS["provider-invalid"]!);
    expect(image.details).toEqual(["image: image not found", "deleted the firewall web this run had created", "deleted the SSH key sitesolide-web this run had created"]);
  });

  test("what an earlier run made, or the project held, is never undone", async () => {
    fake.addKey({ name: "laptop", public_key: ED25519 });
    const firewall = fake.addFirewall({ name: "web", labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" } });
    fake.fail("POST", /^\/servers$/, 412, "resource_unavailable", "not available");
    const refusal = errorOf(await run(CREATE));
    expect(refusal.details.at(-1)).toBe("nothing had been created yet");
    expect(writes()).toEqual(["POST /servers"]);
    expect(fake.firewalls.map((candidate) => candidate.id)).toEqual([firewall.id]);
    expect(fake.keys).toHaveLength(1);
  });

  test("a deletion that fails while undoing leaves the resource for the next run to reuse", async () => {
    fake.fail("POST", /^\/servers$/, 412, "resource_unavailable", "not available");
    fake.fail("DELETE", /^\/firewalls\//, 500, "server_error", "internal error");
    const refusal = errorOf(await run(CREATE));
    expect(refusal.details.slice(-2)).toEqual(["left the firewall web: the next run finds it and reuses it", "deleted the SSH key sitesolide-web this run had created"]);
    expect(fake.firewalls).toHaveLength(1);

    // The next run, with a type that can be had, reuses it.
    resultOf(await run([...CREATE, "--type", "cx33"]));
    expect(fake.firewalls).toHaveLength(1);
    expect(writes().filter((write) => write === "POST /firewalls")).toHaveLength(1);
  });

  test("a key upload refused undoes nothing it did not make", async () => {
    fake.fail("POST", /^\/ssh_keys$/, 403, "forbidden", "insufficient permissions");
    const refusal = errorOf(await run(CREATE));
    expect(refusal.hint).toBe(REMOTE_HINTS["provider-forbidden"]!);
    expect(refusal.details.at(-1)).toBe("nothing had been created yet");
  });

  test("an unknown location is refused with the locations", async () => {
    const refusal = errorOf(await run([...CREATE, "--location", "par1"]));
    expect(refusal.message).toBe("par1 is not a Hetzner location");
    expect(refusal.details).toContain("fsn1   Falkenstein, DE");
    expect(writes()).toEqual([]);
  });

  test("no public key on the workstation is refused before the API is asked anything", async () => {
    rmSync(join(home, ".ssh", "id_ed25519.pub"));
    expect(errorOf(await run(CREATE)).message).toBe("no public key in ~/.ssh to install on the machine");
    writeFileSync(join(home, ".ssh", "id_ed25519.pub"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    expect(errorOf(await run(CREATE)).message).toContain("holds a private key");
    expect(fake.requests).toEqual([]);
  });

  test("another key is installed with --ssh-key", async () => {
    writeFileSync(join(home, "deploy.pub"), `${RSA}\n`);
    resultOf(await run([...CREATE, "--ssh-key", "~/deploy.pub"]));
    expect(fake.keys[0]).toMatchObject({ fingerprint: RSA_MD5 });
  });

  test("a wait shrugs off a failure that says later, and stops on one that says no", async () => {
    fake.fail("GET", /^\/actions\//, 503, "unavailable", "service unavailable");
    const tolerated = await run(CREATE);
    resultOf(tolerated);
    expect(tolerated.events).toContainEqual({ type: "warning", message: "Hetzner failed to follow create_server (503 unavailable): service unavailable: still waiting", details: [] });

    fake.reset();
    fake.fail("GET", /^\/actions\//, 403, "forbidden", "insufficient permissions");
    expect(errorOf(await run(CREATE)).message).toBe("the token may not follow create_server (403 forbidden): insufficient permissions");
  });

  test("an action that fails says why", async () => {
    fake.settings.failCommand = "start_server";
    const refusal = errorOf(await run(CREATE));
    expect(refusal.message).toBe("Hetzner's start_server failed: the host could not complete the action");
    expect(refusal.details[0]).toMatch(/^action [0-9]+, action_failed$/);
    expect(refusal.hint).toBe(REMOTE_HINTS["action-failed"]!);
  });

  test("a placement Hetzner refuses is said in its words", async () => {
    fake.fail("POST", /^\/servers$/, 422, "placement_error", "no host available for this server type");
    const refusal = errorOf(await run(CREATE));
    expect(refusal.message).toBe("Hetzner would not create cx23 at fsn1 (422 placement_error): no host available for this server type");
    expect(refusal.hint).toBe(REMOTE_HINTS["type-unavailable"]!);
  });

  test("the waits are bounded", async () => {
    fake.settings.actionPolls = 1_000_000;
    const slow = errorOf(await run(CREATE));
    expect(slow.message).toBe(`Hetzner's create_server still runs after ${WAITS.actionMs / 60_000} minutes`);
    expect(slow.hint).toBe(REMOTE_HINTS["machine-timeout"]!);
  });

  test("port 22 is waited for, bounded, then refused with a hint", async () => {
    let tries = 0;
    const refusal = errorOf(
      await run(CREATE, {
        probe: async () => {
          tries++;
          return false;
        },
      }),
    );
    expect(refusal.message).toBe("port 22 of 203.0.113.10 did not answer within 5 minutes");
    expect(refusal.hint).toBe(REMOTE_HINTS["ssh-timeout"]!);
    expect(tries).toBeGreaterThan(50);

    // The machine is there now: the same command picks it up at the wait.
    let opens = 3;
    const resumed = await run(CREATE, { probe: async () => --opens <= 0 });
    expect(resultOf(resumed).created).toBe(false);
    expect(writes().filter((write) => write === "POST /servers")).toHaveLength(1);
  });

  test("port 22 is tried for real, on the address the machine has", async () => {
    let asked: string[] = [];
    resultOf(await run(CREATE, { sshTarget: (address) => ((asked = [address]), { hostname: "127.0.0.1", port: listener.port }) }));
    expect(asked).toEqual(["203.0.113.10"]);
  });
});

describe("the API's refusals, as the command reports them", () => {
  const cases: [string, RegExp, number, string, string, string][] = [
    ["POST", /^\/ssh_keys$/, 403, "forbidden", "insufficient permissions", "provider-forbidden"],
    ["POST", /^\/servers$/, 403, "resource_limit_exceeded", "server limit exceeded", "provider-limit"],
    ["POST", /^\/servers$/, 409, "uniqueness_error", "server name is already used", "provider-name-taken"],
    ["POST", /^\/servers$/, 412, "resource_unavailable", "server type not available", "type-unavailable"],
    ["POST", /^\/servers$/, 422, "invalid_input", "invalid input in field 'image'", "provider-invalid"],
    ["POST", /^\/servers$/, 423, "locked", "resource is locked", "provider-busy"],
    ["GET", /^\/servers$/, 500, "server_error", "internal error", "provider-failure"],
    ["GET", /^\/locations$/, 504, "timeout", "timed out", "provider-failure"],
  ];
  for (const [method, path, status, code, message, ours] of cases) {
    test(`${status} ${code} on ${method} ${path.source}`, async () => {
      fake.fail(method, path, status, code, message);
      const refusal = errorOf(await run(CREATE));
      expect(refusal.message).toContain(`(${status} ${code}): ${message}`);
      expect(refusal.hint).toBe(REMOTE_HINTS[ours]!);
    });
  }

  test("429: the wait comes from the API's headers", async () => {
    fake.fail("GET", /^\/servers$/, 429, "rate_limit_exceeded", "limit of 3600 requests per hour reached", { headers: { "RateLimit-Limit": "3600", "RateLimit-Remaining": "0", "RateLimit-Reset": "1", "Retry-After": "12" } });
    const refusal = errorOf(await run(CREATE));
    expect(refusal.message).toBe("Hetzner's rate limit is reached, nothing more can be asked of it for now (429 rate_limit_exceeded)");
    expect(refusal.details).toContain("wait 12 s");
    expect(refusal.hint).toBe(REMOTE_HINTS["provider-rate-limited"]!);
  });

  test("401: a token the API does not know", async () => {
    const refusal = errorOf(await run(CREATE, { environment: { HCLOUD_TOKEN: "an-unknown-token-0000000000000000", SITESOLIDE_HETZNER_API: fake.url } }));
    expect(refusal.message).toBe("Hetzner refused the token (401 unauthorized): it is unknown, revoked, or was copied wrong");
    expect(refusal.hint).toBe(REMOTE_HINTS["provider-unauthenticated"]!);
    expect(JSON.stringify(refusal)).not.toContain("an-unknown-token");
  });

  test("an API that does not answer, or answers something else", async () => {
    const closed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = closed.port;
    closed.stop(true);
    expect(errorOf(await run(["list", "--provider", "hetzner"], { environment: { HCLOUD_TOKEN: FAKE_TOKEN, SITESOLIDE_HETZNER_API: `http://127.0.0.1:${port}/v1` } })).hint).toBe(REMOTE_HINTS["provider-unreachable"]!);

    const html = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<html>hello</html>", { headers: { "Content-Type": "text/html" } }) });
    const htmlPort = html.port;
    const unreadable = errorOf(await run(["list", "--provider", "hetzner"], { environment: { HCLOUD_TOKEN: FAKE_TOKEN, SITESOLIDE_HETZNER_API: `http://127.0.0.1:${htmlPort}/v1` } }));
    html.stop(true);
    expect(unreadable.message).toBe(`127.0.0.1:${htmlPort} answered 200 with something that is not Hetzner's API, while trying to read the servers`);
    expect(unreadable.hint).toBe(REMOTE_HINTS["provider-unreadable"]!);
  });

  test("no token at all, or one that cannot be a token", async () => {
    const none = errorOf(await run(["list", "--provider", "hetzner"], { environment: { SITESOLIDE_HETZNER_API: fake.url } }));
    expect(none.message).toBe("no Hetzner token: set HCLOUD_TOKEN, or pipe it to --token-stdin");
    expect(none.details.join(" ")).toContain("Read & Write");
    const empty = errorOf(await run(["list", "--provider", "hetzner", "--token-stdin"], { stdin: async () => "\n" }));
    expect(empty.message).toBe("no Hetzner token on standard input");
    const odd = errorOf(await run(["list", "--provider", "hetzner"], { environment: { HCLOUD_TOKEN: 'quote"in a token', SITESOLIDE_HETZNER_API: fake.url } }));
    expect(odd.message).toBe("what HCLOUD_TOKEN holds is not a Hetzner token: it has characters or a length a token never has");
    expect(fake.requests).toEqual([]);
  });
});

// --- list ---------------------------------------------------------------------------------------

describe("machine list", () => {
  test("the servers sitesolide created, from every page, with their price", async () => {
    for (const name of ["web", "staging", "api", "docs", "shop"]) fake.addServer({ name, labels: { "managed-by": "sitesolide", "sitesolide-machine": name }, backup_window: name === "web" ? "22-02" : null });
    fake.addServer({ name: "database" });
    fake.addServer({ name: "mail", labels: { "managed-by": "someone-else" } });
    const result = resultOf(await run(["list", "--provider", "hetzner"]));
    const machines = result.machines as { name: string; monthlyPrice: unknown; backups: boolean }[];
    expect(machines.map((entry) => entry.name)).toEqual(["web", "staging", "api", "docs", "shop"]);
    expect(machines[0]).toMatchObject({ backups: true, monthlyPrice: { net: "5.4900000000", currency: "EUR" } });
    expect(fake.requests.filter((request) => request.path === "/servers").map((request) => new URLSearchParams(request.search).get("label_selector"))).toEqual([
      "managed-by=sitesolide",
      "managed-by=sitesolide",
      "managed-by=sitesolide",
    ]);
  });

  test("a person reads a table", async () => {
    fake.addServer({ name: "web", labels: { "managed-by": "sitesolide" }, ipv4: "203.0.113.5", ipv6: "2001:db8:5::/64" });
    const said: string[] = [];
    const output: Output = { ...humanOutput, say: (line) => said.push(line) };
    expect(await machine(["machine", "list", "--provider", "hetzner"], { environment: { HCLOUD_TOKEN: FAKE_TOKEN, SITESOLIDE_HETZNER_API: fake.url }, output })).toBe(0);
    printed.push(...said);
    expect(said).toEqual([
      "   NAME  TYPE  LOCATION  STATUS   IPV4         IPV6           MONTHLY",
      "   web   cx33  fsn1      running  203.0.113.5  2001:db8:5::1  5.49 EUR",
    ]);
    expect(machineTable([])).toHaveLength(1);
  });

  test("an empty project says so", async () => {
    const said: string[] = [];
    const output: Output = { ...humanOutput, say: (line) => said.push(line) };
    await machine(["machine", "list", "--provider", "hetzner"], { environment: { HCLOUD_TOKEN: FAKE_TOKEN, SITESOLIDE_HETZNER_API: fake.url }, output });
    expect(said).toEqual(["no machine created by sitesolide in this Hetzner project"]);
  });
});

// --- destroy ------------------------------------------------------------------------------------

describe("machine destroy", () => {
  const OURS = { "managed-by": "sitesolide", "sitesolide-machine": "web" };
  const DESTROY = ["destroy", "web", "--provider", "hetzner"];

  function ourMachine() {
    const firewall = fake.addFirewall({ name: "web", labels: OURS });
    const key = fake.addKey({ name: "sitesolide-web", public_key: ED25519, labels: OURS });
    const server = fake.addServer({ name: "web", labels: OURS, firewalls: [firewall.id], ssh_keys: [key.id], ipv4: "203.0.113.20", ipv6: "2001:db8:20::/64" });
    return { firewall, key, server };
  }

  test("a mistyped confirmation, or none without a terminal, stops before the API is asked anything", async () => {
    ourMachine();
    const mismatch = errorOf(await run([...DESTROY, "--confirm", "wbe"]));
    expect(mismatch.message).toBe("--confirm wbe does not match web: nothing was destroyed");
    const none = errorOf(await run(DESTROY));
    expect(none.message).toBe("destroying web needs its name typed back: --confirm web");
    expect(none.hint).toBe(REMOTE_HINTS["needs-confirm"]!);
    expect(fake.requests).toEqual([]);
  });

  test("a server sitesolide did not create is never destroyed", async () => {
    fake.addServer({ name: "web", ipv4: "203.0.113.30" });
    const refusal = errorOf(await run([...DESTROY, "--confirm", "web"]));
    expect(refusal.message).toBe("web was not created by sitesolide: it is not destroyed from here");
    expect(refusal.details[0]).toContain("203.0.113.30");
    expect(refusal.hint).toBe(REMOTE_HINTS["machine-not-managed"]!);
    expect(writes()).toEqual([]);
    expect(fake.servers).toHaveLength(1);
  });

  test("a name the project does not have", async () => {
    expect(errorOf(await run([...DESTROY, "--confirm", "web"])).message).toBe("no machine named web in this Hetzner project");
  });

  test("the server, then its firewall; the key stays, and DNS is said untouched", async () => {
    const { firewall, key, server } = ourMachine();
    const result = await run([...DESTROY, "--confirm", "web"]);
    const outcome = resultOf(result);
    expect(writes()).toEqual([`DELETE /servers/${server.id}`, `DELETE /firewalls/${firewall.id}`]);
    expect(outcome).toMatchObject({
      command: "machine destroy",
      name: "web",
      removed: ["server web (203.0.113.20, 2001:db8:20::1)", "firewall web"],
      kept: ["SSH key sitesolide-web: other machines may be created with it; --delete-key deletes it"],
    });
    expect(String(outcome.dns)).toBe("DNS records are not touched: delete those that point at 203.0.113.20, 2001:db8:20::1 from your zone yourself");
    expect(fake.servers).toEqual([]);
    expect(fake.firewalls).toEqual([]);
    expect(fake.keys.map((entry) => entry.id)).toEqual([key.id]);
  });

  test("an address Hetzner keeps after the server is said, since it stays billed", async () => {
    const { server } = ourMachine();
    fake.primaryIps.get(server.id * 10 + 1)!.auto_delete = false;
    const result = await run([...DESTROY, "--confirm", "web"]);
    expect(resultOf(result).kept).toContain("primary IP 203.0.113.20: Hetzner kept it after the server, and bills it until it is deleted from the console");
    expect(result.events).toContainEqual({ type: "warning", message: "primary IP 203.0.113.20 outlived the server: delete it from the console, or it stays billed", details: [] });
    expect(fake.primaryIps.size).toBe(1);
  });

  test("--delete-key deletes the key uploaded for this machine, and only that one", async () => {
    const { key } = ourMachine();
    const shared = fake.addKey({ name: "laptop", public_key: otherKey(5) });
    resultOf(await run([...DESTROY, "--confirm", "web", "--delete-key"]));
    expect(writes()).toContain(`DELETE /ssh_keys/${key.id}`);
    expect(fake.keys.map((entry) => entry.id)).toEqual([shared.id]);
  });

  test("a firewall still applied to another server is kept", async () => {
    const { firewall } = ourMachine();
    fake.addServer({ name: "web-2", labels: { "managed-by": "sitesolide", "sitesolide-machine": "web-2" }, firewalls: [firewall.id] });
    const outcome = resultOf(await run([...DESTROY, "--confirm", "web"]));
    expect((outcome.kept as string[])[0]).toMatch(/^firewall web: still applied to server [0-9]+$/);
    expect(writes().filter((write) => write.startsWith("DELETE /firewalls"))).toEqual([]);
    expect(fake.firewalls).toHaveLength(1);
  });

  test("a firewall Hetzner still counts as in use is tried again, then deleted", async () => {
    const { firewall } = ourMachine();
    fake.fail("DELETE", /^\/firewalls\//, 422, "resource_in_use", "firewall is still in use", { times: 2 });
    const outcome = resultOf(await run([...DESTROY, "--confirm", "web"]));
    expect(writes().filter((write) => write === `DELETE /firewalls/${firewall.id}`)).toHaveLength(3);
    expect(outcome.removed).toContain("firewall web");
  });

  test("at a terminal, the name is typed back; a wrong answer destroys nothing", async () => {
    ourMachine();
    const questions: string[] = [];
    const wrong = await run(DESTROY, { interactive: true, prompt: (question) => (questions.push(question), "wbe") });
    // Under --json nothing prompts: the run is refused as without a terminal.
    expect(errorOf(wrong).message).toBe("destroying web needs its name typed back: --confirm web");

    const said: string[] = [];
    const failures: string[] = [];
    const output: Output = { ...humanOutput, say: (line) => said.push(line), failed: (failure) => failures.push(failure.message) };
    const base = { environment: { HCLOUD_TOKEN: FAKE_TOKEN, SITESOLIDE_HETZNER_API: fake.url }, output, clock: fakeClock(), interactive: true };
    expect(await machine(["machine", ...DESTROY], { ...base, prompt: (question) => (questions.push(question), "wbe") })).toBe(1);
    expect(failures).toEqual(["the name typed back does not match web: nothing was destroyed"]);
    expect(fake.servers).toHaveLength(1);
    expect(await machine(["machine", ...DESTROY], { ...base, prompt: () => "web" })).toBe(0);
    expect(questions).toEqual(["Type web to destroy it, with its disk and the provider's backups of it:"]);
    expect(fake.servers).toEqual([]);
    printed.push(...said, ...failures);
  });
});

// --- the probe ------------------------------------------------------------------------------------

describe("the TCP probe", () => {
  test("true when something listens, false when nothing does", async () => {
    expect(await tcpProbe("127.0.0.1", listener.port)).toBe(true);
    const closed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = closed.port;
    closed.stop(true);
    expect(await tcpProbe("127.0.0.1", port)).toBe(false);
  });
});

// --- the real CLI ---------------------------------------------------------------------------------

describe("bin/sitesolide.ts machine", () => {
  let vm: FakeVm;
  let cliHome: string;
  beforeAll(() => {
    vm = createFakeVm();
  });
  afterAll(() => vm.cleanup());
  beforeEach(() => {
    cliHome = mkdtempSync(join(tmpdir(), "machine-cli-home-"));
    toClean.push(cliHome);
  });

  async function cli(arguments_: string[], env: Record<string, string>, stdin?: string) {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SITESOLIDE_") && key !== "HCLOUD_TOKEN"));
    const proc = Bun.spawn(["bun", CLI, ...arguments_], {
      cwd: cliHome,
      stdout: "pipe",
      stderr: "pipe",
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      env: { ...inherited, HOME: cliHome, PATH: vm.env.PATH!, FAKE_VM: vm.env.FAKE_VM!, SITESOLIDE_HETZNER_API: fake.url, ...env },
    });
    const [output, error] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    printed.push(output, error);
    return { code: await proc.exited, output, error };
  }

  test("needs no configuration, and reads the token from the environment", async () => {
    fake.addServer({ name: "web", labels: { "managed-by": "sitesolide" } });
    const { code, output, error } = await cli(["machine", "list", "--provider", "hetzner", "--json"], { HCLOUD_TOKEN: FAKE_TOKEN });
    expect({ code, error }).toEqual({ code: 0, error: "" });
    const last = JSON.parse(output.trim().split("\n").at(-1)!);
    expect(last).toMatchObject({ type: "result", command: "machine list", provider: "hetzner", machines: [{ name: "web" }] });
    expect(vm.logs()).toEqual([]);
  });

  test("or from standard input, and only ever in the Authorization header", async () => {
    const { code } = await cli(["machine", "list", "--provider", "hetzner", "--token-stdin"], {}, `${FAKE_TOKEN}\n`);
    expect(code).toBe(0);
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const request of fake.requests) {
      expect(request.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      expect(request.url).not.toContain(FAKE_TOKEN);
      expect(JSON.stringify(request.body ?? "")).not.toContain(FAKE_TOKEN);
    }
  });

  test("a refused token, a token as an option, an unknown provider: said on stderr, the token never printed", async () => {
    const refused = await cli(["machine", "list", "--provider", "hetzner"], { HCLOUD_TOKEN: "an-unknown-token-0000000000000000" });
    expect(refused.code).toBe(1);
    expect(refused.error).toContain("!! Hetzner refused the token (401 unauthorized)");
    expect(`${refused.output}${refused.error}`).not.toContain("an-unknown-token");

    const asOption = await cli(["machine", "list", "--provider", "hetzner", `--token=${FAKE_TOKEN}`], {});
    expect(asOption.code).toBe(1);
    expect(asOption.error).toContain("--token: not an option of sitesolide machine list");

    const unknown = await cli(["machine", "create", "--provider", "ovh", "--name", "web", "--json"], { HCLOUD_TOKEN: FAKE_TOKEN });
    expect(JSON.parse(unknown.output.trim())).toMatchObject({ type: "error", message: "unknown provider: ovh", hint: REMOTE_HINTS["unknown-provider"]! });
  });

  test("a destroy refused for its label, then done with --confirm, from the real entry point", async () => {
    fake.addServer({ name: "db" });
    const refused = await cli(["machine", "destroy", "db", "--provider", "hetzner", "--confirm", "db"], { HCLOUD_TOKEN: FAKE_TOKEN });
    expect(refused.code).toBe(1);
    expect(refused.error).toContain("db was not created by sitesolide");

    const firewall = fake.addFirewall({ name: "web", labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" } });
    fake.addServer({ name: "web", labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" }, firewalls: [firewall.id] });
    const done = await cli(["machine", "destroy", "web", "--provider", "hetzner", "--confirm", "web"], { HCLOUD_TOKEN: FAKE_TOKEN });
    expect(done.code).toBe(0);
    expect(done.output).toContain("removed: server web");
    expect(done.output).toContain("removed: firewall web");
    expect(done.output).toContain("DNS records are not touched");
    expect(fake.servers.map((server) => server.name)).toEqual(["db"]);
  });

  test("with no command, the usage, without needing a configuration", async () => {
    const { code, error } = await cli(["machine"], {});
    expect(code).toBe(1);
    expect(error).toContain("sitesolide machine create --provider hetzner --name <name>");
  });
});

// --- what the documentation and the hints promise --------------------------------------------------

describe("the hints and the documentation", () => {
  test("every code machine.ts and the providers report has a hint", () => {
    const sources = ["machine.ts", "providers/provider.ts", "providers/hetzner.ts"].map((file) => readFileSync(join(REPO, "bin", "cli", file), "utf8"));
    const codes = new Set(sources.flatMap((source) => [...source.matchAll(/error: "([a-z0-9-]+)"/g)].map((match) => match[1]!)));
    expect(codes.size).toBeGreaterThan(25);
    expect([...codes].filter((code) => !Object.hasOwn(REMOTE_HINTS, code))).toEqual([]);
    // A destroy is the owner's decision, said in the hints an agent reads.
    expect(REMOTE_HINTS["needs-confirm"]).toContain("only if the owner asked");
  });

  test("docs/commands.md quotes every line of the usage", () => {
    const documented = readFileSync(join(REPO, "docs", "commands.md"), "utf8");
    const lines = MACHINE_USAGE.slice(1).filter((line) => line !== "").map((line) => line.replace(/^ {2}/, ""));
    for (const line of lines) expect({ line, documented: documented.includes(line) }).toEqual({ line, documented: true });
  });

  test("docs/machine.md exists, and says what the token needs", () => {
    const text = readFileSync(join(REPO, "docs", "machine.md"), "utf8");
    expect(text).toContain("Read & Write");
    expect(text).toContain("sitesolide machine destroy");
  });
});

describe("the token", () => {
  test("appears nowhere in what any run of this file printed", () => {
    expect(printed.length).toBeGreaterThan(50);
    expect(printed.filter((text) => text.includes(FAKE_TOKEN))).toEqual([]);
  });

  test("not even in human mode, through the console, on a full create and destroy", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const codes: number[] = [];
    let everything = "";
    try {
      const base = { environment: { HCLOUD_TOKEN: FAKE_TOKEN, SITESOLIDE_HETZNER_API: fake.url }, home, clock: fakeClock(), sshTarget: () => ({ hostname: "127.0.0.1", port: listener.port }), interactive: false };
      codes.push(await machine(["machine", ...CREATE, "--backups"], base));
      codes.push(await machine(["machine", "list", "--provider", "hetzner"], base));
      codes.push(await machine(["machine", "destroy", "web", "--provider", "hetzner", "--confirm", "web", "--delete-key"], base));
      codes.push(await machine(["machine", "list", "--provider", "hetzner"], { ...base, environment: { HCLOUD_TOKEN: "an-unknown-token-0000000000000000", SITESOLIDE_HETZNER_API: fake.url } }));
      everything = [...log.mock.calls, ...error.mock.calls].flat().map(String).join("\n");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
    expect(codes).toEqual([0, 0, 0, 1]);
    expect(everything).toContain("next: sitesolide setup root@203.0.113.10 --zone <your zone> --email <you>");
    expect(everything).toContain("!! Hetzner refused the token");
    expect(everything).not.toContain(FAKE_TOKEN);
    expect(everything).not.toContain("an-unknown-token");
  });

  test("a message that would carry it is scrubbed on its way out", async () => {
    const lines: string[] = [];
    const leaky = async () => {
      throw new Error(`connection reset while sending Bearer ${FAKE_TOKEN}`);
    };
    await machine(["machine", "list", "--provider", "hetzner", "--json"], { environment: { HCLOUD_TOKEN: FAKE_TOKEN, SITESOLIDE_HETZNER_API: fake.url }, output: eventOutput((line) => lines.push(line)), fetcher: leaky });
    expect(lines.join("\n")).toContain("connection reset while sending Bearer [token]");
    expect(lines.join("\n")).not.toContain(FAKE_TOKEN);
  });
});
