import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HETZNER } from "../cli/providers/hetzner";
import type { Choice, Workstation } from "../cli/providers/provider";
import type { SetupExtras, SetupOptions, SetupOutput } from "../cli/setup";
import { Cancelled, runWizard, type Prompter, type WizardDependencies } from "../cli/wizard";
import { startCloudflareMock, type CloudflareMock } from "./cloudflare-mock";
import { createFakeHetzner, FAKE_TOKEN, type FakeHetzner } from "./fake-hetzner";

/**
 * The setup wizard, its questions answered from a script, against the fake
 * Hetzner API and the Cloudflare mock. Setup itself is replaced by a function
 * that records what it was asked: what setup does is tested in
 * cli-setup.test.ts, and what matters here is what the wizard hands it, and
 * that nothing is ordered before the plan is confirmed.
 *
 * Every line the wizard shows is kept, and no credential may appear in any.
 */

const ED25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICezpiOyiQWMYqOeL4S4OgE0T7Fq2bLHWUJ1afO4cczN ada@workstation.test-zone.invalid";
const ED25519_SHA256 = "SHA256:eiqYgPmsybLkA2Wlm4qqhweGbEO3OJsW13k5pTd3oic";
/** A second key the agent may hold; its private half was deleted at once. */
const BOB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBezsiC2kgzd5Qh8zd9F2WUSbJ4TgTwllfgEh3Lwry6k bob@workstation.test-zone.invalid";
const BOB_SHA256 = "SHA256:FCkVFqw+TvEBnUmfuR7Fyq5dwiGMLT9epKIl2RPwP0w";
const CLOUDFLARE_TOKEN = "cloudflare-token-0123456789abcdef";
const ZONE = "test-zone.invalid";

let hetzner: FakeHetzner;
let cloudflare: CloudflareMock;
let home: string;
const folders: string[] = [];

beforeAll(() => {
  hetzner = createFakeHetzner();
});
afterAll(() => {
  hetzner.stop();
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
beforeEach(() => {
  locked = false;
  hetzner.reset();
  cloudflare = startCloudflareMock({ token: CLOUDFLARE_TOKEN });
  home = mkdtempSync(join(tmpdir(), "wizard-home-"));
  folders.push(home);
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "id_ed25519.pub"), `${ED25519}\n`);
});
afterEach(async () => {
  await cloudflare.stop();
});

type Answer = string | boolean | typeof CANCEL;
const CANCEL = Symbol("cancel");

/** The prompts, answered in order by the first unused answer whose pattern matches the question. */
function scripted(answers: [RegExp, Answer][]) {
  const left = [...answers];
  const shown: string[] = [];
  const asked: string[] = [];
  let confirmedPlan = false;
  const answer = (message: string): Answer => {
    asked.push(message);
    const index = left.findIndex(([pattern]) => pattern.test(message));
    // The DNS question takes its default, the provider the zone's name
    // servers say, unless a test answers it.
    if (index === -1 && /^How should .* records and certificates be made/.test(message)) return "";
    if (index === -1) throw new Error(`unexpected question: ${message}`);
    const [, value] = left.splice(index, 1)[0]!;
    if (value === CANCEL) throw new Cancelled();
    if (/^(Order the machine|Install sitesolide)/.test(message) && value === true) confirmedPlan = true;
    return value;
  };
  const setupOutput: SetupOutput = {
    json: false,
    say: (line) => shown.push(line),
    check: (report) => shown.push(report.title),
    relay: (_, line) => shown.push(line),
    secret: (lines) => shown.push(...lines),
    error: (message, details) => shown.push(message, ...details),
    result: () => {},
  };
  const prompter: Prompter = {
    intro: (title) => shown.push(title),
    outro: (text) => shown.push(text),
    note: (lines, title) => shown.push(title ?? "", ...lines),
    step: (text) => shown.push(text),
    info: (text) => shown.push(text),
    warn: (text) => shown.push(text),
    success: (text) => shown.push(text),
    error: (text, details = []) => shown.push(text, ...details),
    select: async (message, options: Choice[], initial) => {
      shown.push(message, ...options.map((option) => `${option.value} ${option.label} ${option.hint ?? ""}`));
      const value = answer(message);
      const chosen = value === "" ? initial : String(value);
      if (!options.some((option) => option.value === chosen)) throw new Error(`${String(chosen)} is not an option of: ${message}`);
      return chosen!;
    },
    text: async (message, options = {}) => {
      shown.push(message);
      const value = answer(message);
      const typed = value === "" ? (options.initial ?? "") : String(value);
      const refused = options.validate?.(typed);
      if (refused !== undefined) throw new Error(`refused by the prompt: ${refused}`);
      return typed;
    },
    secret: async (message, validate) => {
      shown.push(message);
      const typed = String(answer(message));
      const refused = validate?.(typed);
      if (refused !== undefined) throw new Error(`refused by the prompt: ${refused}`);
      return typed;
    },
    confirm: async (message) => {
      shown.push(message);
      return Boolean(answer(message));
    },
    wait: async (message, work, done) => {
      shown.push(message);
      const result = await work();
      shown.push(done(result));
      return result;
    },
    task: (title) => {
      shown.push(title);
      return { line: (text) => shown.push(text), succeed: (text) => shown.push(text), fail: (text) => shown.push(text) };
    },
    setupOutput: () => setupOutput,
  };
  return { prompter, shown, asked, left, planConfirmed: () => confirmedPlan };
}

/** A workstation with no provider CLI, git's email set, and the key loaded in the agent unless `locked`. */
let locked = false;
const workstation: Workstation = {
  environment: {},
  run: async (argv) => {
    if (argv[0] === "git") return { code: 0, stdout: "ada@test-zone.invalid\n", stderr: "" };
    if (argv[0] === "ssh-add") return locked ? { code: 1, stdout: "", stderr: "The agent has no identities." } : { code: 0, stdout: `${ED25519}\n`, stderr: "" };
    if (argv[0] === "ssh-keygen") return { code: 1, stdout: "", stderr: "incorrect passphrase supplied" };
    return { code: 127, stdout: "", stderr: "not installed" };
  },
  readFile: () => null,
};

function fakeClock() {
  let now = Date.parse("2026-10-21T10:00:00Z");
  return { now: () => now, sleep: async (milliseconds: number) => void (now += milliseconds) };
}

type Calls = { options: SetupOptions; extras: SetupExtras }[];

function dependencies(prompter: Prompter, environment: Record<string, string | undefined>, calls: Calls, planConfirmed: () => boolean, extra: Partial<WizardDependencies> = {}): WizardDependencies {
  // A write to the provider before the plan is confirmed fails the test: the bill starts with it.
  const guarded = (input: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") !== "GET" && !planConfirmed()) throw new Error(`${init?.method} ${input} before the plan was confirmed`);
    return fetch(input, init);
  };
  return {
    prompter,
    environment: { SITESOLIDE_HETZNER_API: hetzner.url, ...environment },
    home,
    workstation,
    providers: [HETZNER],
    machine: { fetcher: guarded, clock: fakeClock(), probe: async () => true, login: async () => true },
    dnsApi: { environment: { SITESOLIDE_CLOUDFLARE_API: cloudflare.base } },
    nameServers: async () => ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"],
    setup: async (options, extras) => {
      calls.push({ options, extras });
      return 0;
    },
    ...extra,
  };
}

/** The answers of a whole run on Hetzner, the token in the environment. */
const HAPPY: [RegExp, Answer][] = [
  [/^Where should sitesolide run/, "cloud"],
  [/^Which cloud/, "hetzner"],
  [/^Where\?/, "fsn1"],
  [/^Which size/, "cx23"],
  [/^Name of the machine/, "web"],
  [/backups/, false],
  [/^Domain/, ZONE],
  [/^Email/, ""],
  [/^Order the machine from Hetzner/, true],
];

describe("the setup wizard on a cloud", () => {
  test("orders the machine, then hands setup the machine's own account and address", async () => {
    const run = scripted(HAPPY);
    const calls: Calls = [];
    const code = await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, calls, run.planConfirmed));
    expect(code).toBe(0);
    expect(run.left).toEqual([]);
    expect(hetzner.servers.map((server) => [server.name, server.server_type, server.location])).toEqual([["web", "cx23", "fsn1"]]);
    const server = hetzner.servers[0]!;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({ login: "root", host: server.ipv4, zone: ZONE, email: "ada@test-zone.invalid", user: "deploy", dnsReplace: false, configDir: null });
    // The token came from the environment: setup reads it there itself.
    expect(calls[0]!.extras.dnsCredentials).toBeUndefined();
    const all = run.shown.join("\n");
    expect(all).toContain("sitesolide machine create --provider hetzner --name web --type cx23 --location fsn1 --ssh-key ~/.ssh/id_ed25519.pub");
    expect(all).toContain(`sitesolide setup root@${server.ipv4} --zone ${ZONE} --email ada@test-zone.invalid --user deploy`);
    expect(all).not.toContain(FAKE_TOKEN);
    expect(all).not.toContain(CLOUDFLARE_TOKEN);
  });

  test("says which providers it found credentials for, and offers that one first", async () => {
    const run = scripted(HAPPY);
    await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, [], run.planConfirmed));
    expect(run.shown).toContain("hetzner Hetzner ready, HCLOUD_TOKEN");
  });

  test("a token typed at the prompt is used, never shown, never put in the environment", async () => {
    const run = scripted([...HAPPY.slice(0, 2), [/^Hetzner token/, FAKE_TOKEN], ...HAPPY.slice(2), [/^Cloudflare API token/, CLOUDFLARE_TOKEN]]);
    const calls: Calls = [];
    const environment: Record<string, string | undefined> = {};
    const code = await runWizard(dependencies(run.prompter, environment, calls, run.planConfirmed));
    expect(code).toBe(0);
    expect(hetzner.servers).toHaveLength(1);
    expect(hetzner.requests.every((request) => request.authorization === `Bearer ${FAKE_TOKEN}`)).toBe(true);
    expect(calls[0]!.extras.dnsCredentials).toEqual({ CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN });
    expect(Object.values(environment)).not.toContain(FAKE_TOKEN);
    expect(process.env.HCLOUD_TOKEN).toBeUndefined();
    const all = run.shown.join("\n");
    expect(all).not.toContain(FAKE_TOKEN);
    expect(all).not.toContain(CLOUDFLARE_TOKEN);
    expect(all).toContain("the machine commands read HCLOUD_TOKEN from the environment next time");
  });

  test("a refused token is said, then asked again", async () => {
    const run = scripted([
      ...HAPPY.slice(0, 2),
      [/^Hetzner token/, "an-unknown-token-0000000000000000"],
      [/^Type other Hetzner credentials/, true],
      [/^Hetzner token/, FAKE_TOKEN],
      ...HAPPY.slice(2),
    ]);
    const code = await runWizard(dependencies(run.prompter, { CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, [], run.planConfirmed));
    expect(code).toBe(0);
    const all = run.shown.join("\n");
    expect(all).toContain("Hetzner refused the token");
    expect(all).not.toContain("an-unknown-token-0000000000000000");
  });

  test("a plan declined orders nothing and changes nothing", async () => {
    const run = scripted([...HAPPY.slice(0, -1), [/^Order the machine/, false]]);
    const calls: Calls = [];
    expect(await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, calls, run.planConfirmed))).toBe(0);
    expect(hetzner.requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("the plan says the price before anything is ordered", async () => {
    const run = scripted(HAPPY);
    await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, [], run.planConfirmed));
    const plan = run.shown.indexOf("The plan");
    expect(plan).toBeGreaterThan(-1);
    expect(run.shown.slice(plan).find((line) => line.startsWith("price"))).toBe("price      3.49 EUR a month before VAT");
  });

  test("a name sitesolide did not create is refused, and another one asked", async () => {
    hetzner.addServer({ name: "web" });
    const run = scripted([...HAPPY.slice(0, 4), [/^Name of the machine/, "web"], [/^Name of the machine/, "web2"], ...HAPPY.slice(5)]);
    expect(await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, [], run.planConfirmed))).toBe(0);
    expect(run.shown.join("\n")).toContain("web exists at Hetzner and sitesolide did not create it");
    expect(hetzner.servers.map((server) => server.name).sort()).toEqual(["web", "web2"]);
  });

  test("a machine sitesolide created earlier is picked up, not ordered again", async () => {
    hetzner.addServer({ name: "web", labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" } });
    const run = scripted([...HAPPY.slice(0, 5), ...HAPPY.slice(6, 8), [/^Install sitesolide/, true]]);
    const calls: Calls = [];
    expect(await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, calls, run.planConfirmed))).toBe(0);
    expect(hetzner.servers).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  test("a machine sitesolide made that is gone is not picked up: the plan says a new one is billed", async () => {
    const gone = { ...HETZNER, open: (context: Parameters<typeof HETZNER.open>[0]) => {
      const real = HETZNER.open(context);
      return { ...real, find: async (name: string) => ({ ...(await real.find(name))!, managed: true, status: "terminated" }) };
    } };
    hetzner.addServer({ name: "web", labels: { "managed-by": "sitesolide", "sitesolide-machine": "web" } });
    const run = scripted([...HAPPY.slice(0, -1), [/^Order the machine from Hetzner and install sitesolide\? Hetzner bills it from now on/, false]]);
    expect(await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, [], run.planConfirmed, { providers: [gone] }))).toBe(0);
    expect(run.shown.join("\n")).toContain("web was created by sitesolide earlier and is terminated: a new one is ordered");
  });

  test("a failed order stops before setup, and says the wizard resumes", async () => {
    hetzner.fail("POST", /^\/servers$/, 403, "resource_limit_exceeded", "server limit reached");
    const run = scripted(HAPPY);
    const calls: Calls = [];
    expect(await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, calls, run.planConfirmed))).toBe(1);
    expect(calls).toEqual([]);
    expect(run.shown.join("\n")).toContain("run sitesolide setup again with the same name");
  });

  test("cancelled anywhere, it stops with 130 and nothing ordered", async () => {
    const run = scripted([...HAPPY.slice(0, 3), [/^Which size/, CANCEL]]);
    expect(await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN }, [], run.planConfirmed))).toBe(130);
    expect(hetzner.requests.filter((request) => request.method !== "GET")).toEqual([]);
  });
});

describe("the domain", () => {
  test("a zone the token cannot read is said before anything is ordered", async () => {
    const run = scripted([...HAPPY.slice(0, 6), [/^Domain/, "other-zone.invalid"], [/^Email/, ""], [/^Type other Cloudflare credentials/, false]]);
    expect(await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, [], run.planConfirmed))).toBe(1);
    expect(run.shown.join("\n")).toContain("no Cloudflare zone the token can read holds other-zone.invalid");
    expect(hetzner.requests.filter((request) => request.method !== "GET")).toEqual([]);
  });

  test("records already in the zone are shown, and replaced only on a yes", async () => {
    await cloudflare.stop();
    cloudflare = startCloudflareMock({ token: CLOUDFLARE_TOKEN, records: [{ type: "A", name: ZONE, content: "198.51.100.7", proxied: false, ttl: 1 }] });
    const declined = scripted([...HAPPY.slice(0, 8), [/^Replace them/, false]]);
    expect(await runWizard(dependencies(declined.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, [], declined.planConfirmed))).toBe(0);
    expect(declined.shown.join("\n")).toContain("198.51.100.7");
    expect(hetzner.servers).toEqual([]);

    const accepted = scripted([...HAPPY.slice(0, 8), [/^Replace them/, true], HAPPY.at(-1)!]);
    const calls: Calls = [];
    expect(await runWizard(dependencies(accepted.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, calls, accepted.planConfirmed))).toBe(0);
    expect(calls[0]!.options.dnsReplace).toBe(true);
  });
});

describe("who serves the zone's DNS", () => {
  test("the provider the name servers say is offered first, and setup is told it", async () => {
    const run = scripted(HAPPY);
    const calls: Calls = [];
    expect(await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, calls, run.planConfirmed))).toBe(0);
    expect(run.shown).toContain(`${ZONE}'s DNS is at Cloudflare`);
    expect(calls[0]!.options).toMatchObject({ dns: "cloudflare", skipDns: false });
  });

  test("a registrar sitesolide has no module for: records by hand, nothing asked of any DNS API, setup told manual", async () => {
    const run = scripted(HAPPY);
    const calls: Calls = [];
    const code = await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN }, calls, run.planConfirmed, { nameServers: async () => ["ns1.registrar.test-zone.invalid"] }));
    expect(code).toBe(0);
    expect(run.shown.join("\n")).toContain("which sitesolide has no module for");
    expect(run.shown.join("\n")).toContain("names in public logs");
    expect(cloudflare.requests).toEqual([]);
    expect(calls[0]!.options).toMatchObject({ dns: "manual", skipDns: true, dnsReplace: false });
    expect(calls[0]!.extras.dnsCredentials).toBeUndefined();
    expect(run.shown.join("\n")).toContain("--dns manual");
  });

  test("manual can be chosen even when a provider serves the zone", async () => {
    const run = scripted([...HAPPY, [/^How should/, "manual"]]);
    const calls: Calls = [];
    expect(await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, calls, run.planConfirmed))).toBe(0);
    expect(calls[0]!.options.dns).toBe("manual");
    expect(cloudflare.requests).toEqual([]);
  });
});

describe("the records already there", () => {
  test("mail and text records are never shown as replaced: setup does not touch them", async () => {
    await cloudflare.stop();
    cloudflare = startCloudflareMock({
      token: CLOUDFLARE_TOKEN,
      records: [
        { type: "MX", name: ZONE, content: "mail.test-zone.invalid", proxied: false, ttl: 1 },
        { type: "TXT", name: ZONE, content: "v=spf1 -all", proxied: false, ttl: 1 },
      ],
    });
    const run = scripted(HAPPY);
    expect(await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, [], run.planConfirmed))).toBe(0);
    expect(run.asked.some((question) => /^Replace them/.test(question))).toBe(false);
  });

  test("a proxied record pointing at the machine itself is shown: setup would refuse it as it stands", async () => {
    await cloudflare.stop();
    cloudflare = startCloudflareMock({ token: CLOUDFLARE_TOKEN, records: [{ type: "A", name: ZONE, content: "198.51.100.20", proxied: true, ttl: 1 }] });
    const run = scripted([[/^Where should sitesolide run/, "own"], [/^SSH address/, "root@198.51.100.20"], [/^Domain/, ZONE], [/^Email/, ""], [/^Replace them/, false]]);
    expect(await runWizard(dependencies(run.prompter, { CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, [], run.planConfirmed))).toBe(0);
    expect(run.shown.join("\n")).toContain("198.51.100.20");
  });
});

describe("a machine already running", () => {
  test("its address is asked, and setup runs on it; no provider is asked anything", async () => {
    const run = scripted([
      [/^Where should sitesolide run/, "own"],
      [/^SSH address/, "admin@198.51.100.20"],
      [/^Domain/, ZONE],
      [/^Email/, ""],
      [/^Install sitesolide/, true],
    ]);
    const calls: Calls = [];
    expect(await runWizard(dependencies(run.prompter, { CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, calls, run.planConfirmed))).toBe(0);
    expect(calls[0]!.options).toMatchObject({ login: "admin", host: "198.51.100.20", user: "deploy" });
    expect(hetzner.requests).toEqual([]);
  });
});

describe("a workstation that already names a machine", () => {
  function configure(folder: string): void {
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "config.json"), JSON.stringify({ server: "deploy@198.51.100.30", zone: ZONE, email: "ada@test-zone.invalid" }));
  }

  test("quitting changes nothing", async () => {
    configure(join(home, ".config", "sitesolide"));
    const run = scripted([[/^What now/, "quit"]]);
    expect(await runWizard(dependencies(run.prompter, {}, [], run.planConfirmed))).toBe(0);
    expect(run.shown.join("\n")).toContain("names deploy@198.51.100.30");
  });

  test("checking it is a dry run first, the list of what would change, then a yes; the default answer is to quit", async () => {
    configure(join(home, ".config", "sitesolide"));
    const asked: (string | undefined)[] = [];
    const run = scripted([
      [/^What now/, "resume"],
      [/^Connect as/, ""],
      [/^Run these 1 step\(s\) on deploy@198.51.100.30/, false],
    ]);
    const select = run.prompter.select;
    run.prompter.select = async (message, options, initial) => {
      asked.push(initial);
      return select(message, options, initial);
    };
    const calls: Calls = [];
    const setup = async (options: SetupOptions, extras: SetupExtras) => {
      calls.push({ options, extras });
      if (options.dryRun) extras.output!.check({ step: "monitor", title: "monitor", status: "todo", detail: "inactive" });
      return 0;
    };
    expect(await runWizard(dependencies(run.prompter, {}, calls, run.planConfirmed, { setup }))).toBe(0);
    expect(asked[0]).toBe("quit");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toMatchObject({ dryRun: true, login: "deploy", host: "198.51.100.30", zone: ZONE, email: "ada@test-zone.invalid", user: "deploy" });
    expect(run.shown.join("\n")).toContain("monitor: inactive");
  });

  test("a configuration in outdated keys, or in the environment, counts as one", async () => {
    const folder = join(home, ".config", "sitesolide");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "config.json"), JSON.stringify({ serveur: "deploy@198.51.100.30", zone: ZONE, courriel: "ada@test-zone.invalid" }));
    const legacy = scripted([[/^What now/, "quit"]]);
    expect(await runWizard(dependencies(legacy.prompter, {}, [], legacy.planConfirmed))).toBe(0);
    rmSync(join(folder, "config.json"));
    const environment = scripted([[/^What now/, "quit"]]);
    expect(await runWizard(dependencies(environment.prompter, { SITESOLIDE_SERVER: "deploy@198.51.100.31" }, [], environment.planConfirmed))).toBe(0);
    expect(environment.shown.join("\n")).toContain("names deploy@198.51.100.31");
  });

  test("a separate installation while SITESOLIDE_ZONE is exported is refused before anything is ordered", async () => {
    configure(join(home, ".config", "sitesolide"));
    const run = scripted([[/^What now/, "new"]]);
    expect(await runWizard(dependencies(run.prompter, { SITESOLIDE_ZONE: ZONE, HCLOUD_TOKEN: FAKE_TOKEN }, [], run.planConfirmed))).toBe(1);
    expect(run.shown.join("\n")).toContain("unset SITESOLIDE_ZONE");
    expect(hetzner.requests).toEqual([]);
  });

  test("a separate installation gets its own folder, never the one in service", async () => {
    configure(join(home, ".config", "sitesolide"));
    const taken = scripted([[/^What now/, "new"], [/^Configuration folder/, "~/.config/sitesolide"]]);
    expect(await runWizard(dependencies(taken.prompter, {}, [], taken.planConfirmed))).toBe(1);
    expect(taken.shown.join("\n")).toContain("that folder names a machine too");

    // The zone in service, or one inside it, is refused: the records would be shared.
    const same = scripted([[/^What now/, "new"], [/^Configuration folder/, ""], ...HAPPY.slice(0, 6), [/^Domain/, `apps.${ZONE}`]]);
    expect(await runWizard(dependencies(same.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, [], same.planConfirmed))).toBe(1);
    expect(same.shown.join("\n")).toContain(`${ZONE} is served by the installation in service`);

    await cloudflare.stop();
    cloudflare = startCloudflareMock({ token: CLOUDFLARE_TOKEN, zones: [{ id: "zone-1", name: ZONE }, { id: "zone-2", name: "other-zone.invalid" }] });
    const run = scripted([[/^What now/, "new"], [/^Configuration folder/, ""], ...HAPPY.slice(0, 6), [/^Domain/, "other-zone.invalid"], ...HAPPY.slice(7)]);
    const calls: Calls = [];
    expect(await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, calls, run.planConfirmed))).toBe(0);
    expect(calls[0]!.options.configDir).toBe("~/.config/sitesolide-2");
    expect(run.shown.join("\n")).toContain("SITESOLIDE_CONFIG_DIR=~/.config/sitesolide-2 sitesolide deploy");
  });
});

describe("the SSH key", () => {
  test("a key behind a passphrase nobody loaded stops before anything is ordered, unless ssh-add loads it", async () => {
    locked = true;
    const refused = scripted([...HAPPY.slice(0, 6), [/^Load it now with ssh-add/, false]]);
    expect(await runWizard(dependencies(refused.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, [], refused.planConfirmed, { sshAdd: async () => true }))).toBe(1);
    expect(refused.shown.join("\n")).toContain("needs its passphrase, which setup cannot type");
    expect(hetzner.requests.filter((request) => request.method !== "GET")).toEqual([]);

    const loaded = scripted([...HAPPY.slice(0, 6), [/^Load it now with ssh-add/, true], ...HAPPY.slice(6)]);
    const sshAdd = async () => {
      locked = false;
      return true;
    };
    expect(await runWizard(dependencies(loaded.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, [], loaded.planConfirmed, { sshAdd }))).toBe(0);
    expect(hetzner.servers).toHaveLength(1);
  });

  test("none in ~/.ssh, one in the SSH agent: it is used without a question", async () => {
    rmSync(join(home, ".ssh", "id_ed25519.pub"));
    const run = scripted(HAPPY);
    expect(await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, [], run.planConfirmed))).toBe(0);
    expect(run.shown).toContain(`SSH key: ada@workstation.test-zone.invalid, from the SSH agent, ${ED25519_SHA256}`);
    expect(hetzner.servers).toHaveLength(1);
  });

  test("none in ~/.ssh, several in the SSH agent: the one the machine trusts is picked", async () => {
    rmSync(join(home, ".ssh", "id_ed25519.pub"));
    const agent: Workstation = { ...workstation, run: async (argv) => (argv[0] === "ssh-add" ? { code: 0, stdout: `${ED25519}\n${BOB}\n`, stderr: "" } : workstation.run(argv)) };
    const run = scripted([...HAPPY.slice(0, 6), [/^SSH key the machine trusts/, BOB_SHA256], ...HAPPY.slice(6)]);
    expect(await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, [], run.planConfirmed, { workstation: agent }))).toBe(0);
    expect(run.shown).toContain(`ssh key    bob@workstation.test-zone.invalid, from the SSH agent, ${BOB_SHA256}`);
    expect(hetzner.keys[0]).toMatchObject({ public_key: BOB });
  });

  test("none on the workstation: ssh-keygen is offered, and declining stops before anything is ordered", async () => {
    locked = true;
    rmSync(join(home, ".ssh", "id_ed25519.pub"));
    const run = scripted([...HAPPY.slice(0, 6), [/^Create one now with ssh-keygen/, false]]);
    const code = await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, [], run.planConfirmed, { keygen: async () => true }));
    expect(code).toBe(1);
    expect(hetzner.requests.filter((request) => request.method !== "GET")).toEqual([]);
  });

  test("a key made by ssh-keygen is used at once", async () => {
    locked = true;
    rmSync(join(home, ".ssh", "id_ed25519.pub"));
    const run = scripted([...HAPPY.slice(0, 6), [/^Create one now with ssh-keygen/, true], ...HAPPY.slice(6)]);
    const keygen = async () => {
      writeFileSync(join(home, ".ssh", "id_ed25519.pub"), `${ED25519}\n`);
      // Without a passphrase, as setup's ssh needs it: the fake says so through the agent.
      locked = false;
      return true;
    };
    expect(await runWizard(dependencies(run.prompter, { HCLOUD_TOKEN: FAKE_TOKEN, CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN }, [], run.planConfirmed, { keygen }))).toBe(0);
    expect(hetzner.servers).toHaveLength(1);
  });
});
