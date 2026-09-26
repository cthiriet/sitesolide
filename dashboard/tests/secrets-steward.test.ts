import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOLERATED_FAILURES, INITIAL_BACKOFF_MS, MAXIMUM_BACKOFF_MS } from "../src/auth";
import { portalModifiable } from "../src/gatekeeper/rules";
import type {
  LogEntry,
  Failure,
  FileView,
  ProjectView,
  ContentResponse,
  UnlockResponse,
  FileResponse,
  LogResponse,
  PasswordResponse,
  PortalResponse,
  ProjectsResponse,
  RestartResponse,
  ValueResponse,
} from "../src/secrets/protocol";
import { UNLOCK_DURATION_MS } from "../src/secrets/protocol";
import {
  MAX_BODY_BYTES,
  MAX_QUEUED,
  MAX_IN_FLIGHT,
  createSteward,
  type StewardOptions,
} from "../src/secrets/steward";
import { createSystem, isTemporary, readAccount, readGroup, type Command, type SystemConfig, type System } from "../src/secrets/system";

/**
 * The steward set up on a throwaway tree: real files, real atomic writes, but a
 * simulated `systemctl`, a simulated gatekeeper and a clock the test moves
 * forward itself. Each test has its own `mkdtemp` directory, never `.attempts`,
 * which tests/setup.ts empties on every run.
 *
 * The bench's machine looks like the real one: app sites, a static site, the
 * landing with no manifest, the dashboard and the portal with their
 * hash, a builder with its ssh key and its subdirectory of secrets.
 */

const PASSWORD = "Xith-G4r4-nRJs-uDMV-KhsD-mzuK";
const PORTAL_PASSWORD = "Portal-Shared-Password-42";
const SECRET_TOKEN = "tok_VALUE-SECRET-1";
const SECRET_SID = "ID_VALUE-SECRET-2";
const SECRET_SET = "sk_live 'VALUE' \"SECRET\" $3 #";
/** A token made only of the characters of a variable name: it would pass for a name. */
const SECRET_ALNUM = "fake_live_Q9x7Zk2Lm4Np8Rt6Vw3Yb5";
/**
 * A fake key's header, split so that a secret scanner reading this file does
 * not take it for a leaked one. At runtime it is whole.
 */
const KEY_HEADER = "-----BEGIN OPENSSH " + "PRIVATE KEY-----";
const PRIVATE_KEY = `${KEY_HEADER}\nb3BlbnNzaC1rZXktdjEAAAAAC-PRIVATE-KEY-SECRET\n-----END OPENSSH PRIVATE KEY-----\n`;
const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI-public-key builder\n";
const SECRET_REGISTRY = "reg-REGISTRY-TOKEN-SECRET\n";
const BACKSLASH = String.fromCharCode(92);
const charOf = (code: number) => String.fromCharCode(code);

const CMS_ENV = `# CMS mail, to renew at the slightest doubt\nSID=${SECRET_SID}\n\n# the token\nTOKEN=${SECRET_TOKEN}\n`;

const UID = process.getuid!();
/** The group of a file created under tmpdir: the directory's on macOS, the process's on Linux. */
const TEST_GID = (() => {
  const folder = mkdtempSync(join(tmpdir(), "gid-"));
  writeFileSync(join(folder, "f"), "");
  const gid = statSync(join(folder, "f")).gid;
  rmSync(folder, { recursive: true, force: true });
  return gid;
})();
const account = (name: string, uid = UID, gid = TEST_GID) => `${name}:x:${uid}:${gid}::/nonexistent:/usr/sbin/nologin\n`;
const ACCOUNTS = ["root", "site-cms", "site-calendar", "site-library", "site-dashboard", "site-portal", "site-builder", "site-landing"]
  .map((name) => account(name))
  .join("");

const toClean: string[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) {
    // A directory closed by a test has to be reopened before it can go.
    try {
      chmodSync(join(folder, "secrets", "builder-secrets"), 0o755);
    } catch {
      // missing
    }
    rmSync(folder, { recursive: true, force: true });
  }
});

type Scenario = (unit: string, sinceRestartMs: number) => string;

/** `ActiveEnterTimestamp` as `--timestamp=us+utc` writes it, empty for a unit never started. */
function timestampUs(ms: number): string {
  if (ms <= 0) return "";
  const date = new Date(ms);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()];
  const micro = String(Math.floor(ms * 1000) % 1_000_000).padStart(6, "0");
  return `${day} ${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 19)}.${micro} UTC`;
}

function showA(state: string, subState: string, restarts: number, startedMs: number): string {
  return `LoadState=loaded\nActiveState=${state}\nSubState=${subState}\nNRestarts=${restarts}\nActiveEnterTimestamp=${timestampUs(startedMs)}\n`;
}

function show(state: string, subState: string, restarts: number, startedS: number): string {
  return showA(state, subState, restarts, startedS * 1000);
}

const AN_HOUR_AGO_S = Math.floor((Date.now() - 3_600_000) / 1000);
const isRunning: Scenario = () => show("active", "running", 0, AN_HOUR_AGO_S);

/** What the simulated gatekeeper makes of a start: it returns `systemctl start`'s code. */
type Gatekeeper = (unit: string) => number;

type Mount = Partial<StewardOptions> & {
  accounts?: string;
  hash?: string | null;
  /** A secret read that takes time, to force the interleavings. */
  slownessMs?: number;
  /** A `systemctl show` that takes time, to count the ones running together. */
  showSlownessMs?: number;
  overrides?: Partial<System>;
};

type Bench = {
  root: string;
  sites: string;
  secrets: string;
  units: string;
  state: string;
  caddy: string;
  gatekeeper: string;
  config: SystemConfig;
  call: (method: string, path: string, body?: unknown, init?: RequestInit) => Promise<Response>;
  /** A new steward on the same machine: what Restart=always does. */
  restartSteward: () => void;
  clock: { t: number };
  systemctlCalls: string[][];
  scenario: { current: Scenario };
  simulatedGatekeeper: { current: Gatekeeper };
  /** As long as it is set, `systemctl restart` waits on it. */
  barrier: { promise: Promise<void> | null };
  /** `start-limit-hit`: restart refuses until reset-failed has run. */
  limit: { reached: boolean };
  simultaneousShows: { current: number; max: number };
  renderedTexts: string[];
};

async function mount(options: Mount = {}): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), "secretaire-"));
  toClean.push(root);
  const sites = join(root, "sites");
  const secrets = join(root, "secrets");
  const units = join(root, "units");
  const state = join(root, "state");
  const caddy = join(root, "caddy");
  const gatekeeper = join(root, "gatekeeper");
  for (const folder of [sites, secrets, units, state, caddy, gatekeeper]) mkdirSync(folder, { recursive: true });

  const project = (slug: string, content: Record<string, unknown>) => {
    mkdirSync(join(sites, slug), { recursive: true });
    writeFileSync(join(sites, slug, "sitesolide.json"), JSON.stringify({ slug, ...content }));
  };
  const appManifest = { start: "/usr/local/bin/bun run server.ts", port: 3048, publicDir: "public" };
  project("cms", {
    ...appManifest,
    env: { NODE_ENV: "production", DEFAULT_SENDER: "me@test-zone.invalid" },
    secrets: ["cms.env", "cms-webhook.env"],
  });
  project("calendar", { ...appManifest, secrets: ["calendar.env"] });
  project("library", { ...appManifest, secrets: ["library.env"] });
  project("dashboard", { ...appManifest, secrets: ["dashboard.env"] });
  project("portal", { ...appManifest, secrets: ["portal.env"] });
  project("builder", { ...appManifest, secrets: ["builder.env"] });
  project("showcase", { publicDir: "public" });
  // The landing: a directory with no manifest, named after the bare domain.
  mkdirSync(join(sites, "test-zone.invalid"));

  writeFileSync(
    join(units, "cms.service"),
    [
      "[Service]",
      "Environment=PORT=3048",
      "Environment=DATA_DIR=/srv/sites/cms/data",
      "Environment=ADDED_BY_HAND=1",
      `EnvironmentFile=-${secrets}/cms.env`,
      `EnvironmentFile=-${secrets}/cms-webhook.env`,
      "ExecStart=/usr/local/bin/bun run server.ts",
      "",
    ].join("\n"),
  );
  // An extension that sets one more variable.
  mkdirSync(join(units, "cms.service.d"));
  writeFileSync(join(units, "cms.service.d", "local.conf"), "[Service]\nEnvironment=FROM_EXTENSION=1\n");
  // A unit that reads no secret file at all.
  writeFileSync(join(units, "library.service"), "[Service]\nEnvironment=PORT=3044\nExecStart=/bin/true\n");
  writeFileSync(join(units, "dashboard.service"), `[Service]\nEnvironmentFile=-${secrets}/dashboard.env\nExecStart=/bin/true\n`);
  writeFileSync(join(units, "sitesolide-landing.service"), `[Service]\nEnvironmentFile=-${secrets}/landing-mail.env\nExecStart=/bin/true\n`);
  // builder reads the files of its subdirectory only through the directory's path.
  writeFileSync(join(units, "builder.service"), `[Service]\nEnvironment=BUILDER_SECRETS_DIR=${secrets}/builder-secrets\nExecStart=/bin/true\n`);

  writeFileSync(join(secrets, "cms.env"), CMS_ENV, { mode: 0o600 });
  writeFileSync(join(secrets, "library.env"), "KEY=1\n", { mode: 0o600 });
  // Two files no manifest declares, present as on a machine in service: the
  // landing has no manifest, builder is a service made by hand.
  writeFileSync(join(secrets, "builder.env"), "BUILDER=1\n", { mode: 0o600 });
  writeFileSync(join(secrets, "landing-mail.env"), "AWS_REGION=eu-west-3\n", { mode: 0o600 });
  writeFileSync(join(secrets, "builder-ssh"), PRIVATE_KEY, { mode: 0o400 });
  writeFileSync(join(secrets, "builder-ssh.pub"), PUBLIC_KEY, { mode: 0o444 });
  mkdirSync(join(secrets, "builder-secrets"), { mode: 0o755 });
  chmodSync(join(secrets, "builder-secrets"), 0o755);
  writeFileSync(join(secrets, "builder-secrets", "registry"), SECRET_REGISTRY, { mode: 0o400 });
  const portalHash = await Bun.password.hash(PORTAL_PASSWORD, { algorithm: "bcrypt", cost: 4 });
  writeFileSync(join(secrets, "portal.env"), `PASSWORD_HASH=${portalHash}\n`, { mode: 0o600 });
  // Two hours old: no restart pending to begin with.
  const twoHoursAgo = (Date.now() - 7_200_000) / 1000;
  utimesSync(join(secrets, "cms.env"), twoHoursAgo, twoHoursAgo);

  const hashFile = join(secrets, "dashboard.env");
  if (options.hash !== null) {
    const hash = options.hash ?? (await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 4 }));
    writeFileSync(hashFile, `PASSWORD_HASH=${hash}\n`, { mode: 0o600 });
  }

  const accountsFile = join(root, "passwd");
  writeFileSync(accountsFile, options.accounts ?? "root:x:0:0:root:/root:/bin/sh\n");

  const clock = { t: Date.now() };
  const systemctlCalls: string[][] = [];
  const scenario = { current: isRunning };
  const simulatedGatekeeper: Bench["simulatedGatekeeper"] = { current: () => 1 };
  const barrier: Bench["barrier"] = { promise: null };
  const limit = { reached: false };
  const simultaneousShows = { current: 0, max: 0 };
  let restartStart = clock.t;

  const config: SystemConfig = {
    sitesDir: sites,
    secretsFolder: secrets,
    unitsFolder: units,
    stateFolder: state,
    hashFile,
    accountsFile,
    caddyFolder: caddy,
    gatekeeperFolder: gatekeeper,
    systemctl: "/path/that/does/not/exist",
  };
  const real = createSystem(config);
  const system: System = {
    ...real,
    // A slow read leaves another request the time to read the same state:
    // with no lock, two simultaneous writes would lose one of them.
    examineSecret: async (name) => {
      const examination = await real.examineSecret(name);
      if (options.slownessMs !== undefined) await Bun.sleep(options.slownessMs);
      return examination;
    },
    now: () => clock.t,
    wait: async (ms) => {
      clock.t += ms;
    },
    systemctl: async (arguments_): Promise<Command> => {
      systemctlCalls.push(arguments_);
      if (arguments_[0] === "reset-failed") {
        limit.reached = false;
        return { code: 0, output: "" };
      }
      if (arguments_[0] === "restart") {
        if (barrier.promise !== null) await barrier.promise;
        restartStart = clock.t;
        // Lab measurement 3: at the limit, restart returns 1 and the unit stays failed.
        return { code: limit.reached ? 1 : 0, output: "" };
      }
      if (arguments_[0] === "start") return { code: simulatedGatekeeper.current(arguments_[1]!), output: "" };
      if (arguments_[0] === "show") {
        simultaneousShows.current++;
        simultaneousShows.max = Math.max(simultaneousShows.max, simultaneousShows.current);
        try {
          if (options.showSlownessMs !== undefined) await Bun.sleep(options.showSlownessMs);
          const output = limit.reached
            ? show("failed", "failed", 0, AN_HOUR_AGO_S)
            : scenario.current(arguments_[1]!, clock.t - restartStart);
          return { code: 0, output };
        } finally {
          simultaneousShows.current--;
        }
      }
      return { code: 1, output: "" };
    },
    ...options.overrides,
  };

  const { accounts: _c, hash: _e, slownessMs: _l, showSlownessMs: _s, overrides: _x, ...stewardOptions } = options;
  const newPassword = () =>
    createSteward(system, {
      secretsFolder: secrets,
      checkAccounts: false,
      ...stewardOptions,
    });
  let handler = newPassword();
  const renderedTexts: string[] = [];

  return {
    root,
    sites,
    secrets,
    units,
    state,
    caddy,
    gatekeeper,
    config,
    clock,
    systemctlCalls,
    scenario,
    simulatedGatekeeper,
    barrier,
    limit,
    simultaneousShows,
    renderedTexts,
    restartSteward() {
      handler = newPassword();
    },
    async call(method, path, body, init = {}) {
      const requested: RequestInit = { method: method, ...init };
      if (body !== undefined) requested.body = typeof body === "string" ? body : JSON.stringify(body);
      const response = await handler(new Request(`http://steward${path}`, requested));
      // Every body returned is kept for the final test: no value must appear
      // in it, except in what /value, /content and /password return.
      const text = await response.clone().text();
      if (!["/value", "/content", "/password"].includes(path)) renderedTexts.push(text);
      return response;
    },
  };
}

async function unlock(bench: Bench, password = PASSWORD): Promise<string> {
  const response = await bench.call("POST", "/unlock", { password });
  expect(response.status).toBe(200);
  return ((await response.json()) as UnlockResponse).token;
}

async function errorOf(response: Response): Promise<Failure> {
  return (await response.json()) as Failure;
}

function log(bench: Bench): LogEntry[] {
  const path = join(bench.state, "journal.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LogEntry);
}

async function projects(bench: Bench): Promise<ProjectView[]> {
  return ((await (await bench.call("GET", "/projects")).json()) as ProjectsResponse).projects;
}

async function fileSeen(bench: Bench, slug: string, name: string): Promise<FileView> {
  const site = (await projects(bench)).find((project) => project.slug === slug)!;
  return site.files.find((file) => file.name === name)!;
}

/** A counted verification: how many run together, and how many in all. */
function countedVerification() {
  const account = { current: 0, max: 0, total: 0 };
  const check = async (submitted: string, hash: string) => {
    account.current++;
    account.total++;
    account.max = Math.max(account.max, account.current);
    try {
      await Bun.sleep(5);
      return hash !== "" && (await Bun.password.verify(submitted, hash));
    } finally {
      account.current--;
    }
  };
  return { account, check };
}

/** A body that never arrives in full, as long as it is not closed. */
function endlessBody(): { stream: ReadableStream<Uint8Array>; close: () => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      c.enqueue(new TextEncoder().encode("{"));
    },
  });
  return { stream, close: () => controller.close() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const hashFast = (password: string) => Bun.password.hash(password, { algorithm: "bcrypt", cost: 4 });

describe("routing and the shape of requests", () => {
  test("unknown route 404, refused method 405 with Allow", async () => {
    const bench = await mount();
    expect((await bench.call("GET", "/unknown")).status).toBe(404);
    expect((await bench.call("GET", "/__proto__")).status).toBe(404);
    const refused = await bench.call("POST", "/projects");
    expect(refused.status).toBe(405);
    expect(refused.headers.get("Allow")).toBe("GET");
    expect((await bench.call("GET", "/variable")).headers.get("Allow")).toBe("PUT, DELETE");
    expect((await bench.call("DELETE", "/content")).headers.get("Allow")).toBe("POST, PUT");
    expect((await bench.call("GET", "/portal")).headers.get("Allow")).toBe("POST");
  });

  test("unreadable body, array, unexpected field, wrongly typed field, body too big", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const cas: [unknown, number][] = [
      ["{not json", 400],
      [[1, 2], 400],
      ["null", 400],
      [{ token, slug: "cms", file: "cms.env", variable: "TOKEN", extra: 1 }, 400],
      [{ token, slug: "cms", file: "cms.env", variable: 42 }, 400],
      [{ token, slug: "cms", file: "cms.env", variable: "TOKEN", pad: "x".repeat(MAX_BODY_BYTES) }, 400],
    ];
    for (const [body, status] of cas) {
      const response = await bench.call("POST", "/value", body);
      expect(response.status).toBe(status);
      expect((await errorOf(response)).error).toBe("invalid");
    }
  });
});

describe("what a compromised dashboard can send is bounded", () => {
  test("a body that never arrives is cut at the timeout", async () => {
    const bench = await mount({ bodyTimeoutMs: 50 });
    const { stream } = endlessBody();
    const start = Date.now();
    const response = await bench.call("POST", "/unlock", undefined, { body: stream });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain("too slow");
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test("beyond the in-flight requests, 503, and the slot frees up afterwards", async () => {
    const bench = await mount({ bodyTimeoutMs: 10_000 });
    const lents = Array.from({ length: MAX_IN_FLIGHT }, () => endlessBody());
    const inProgress = lents.map(({ stream }) => bench.call("POST", "/unlock", undefined, { body: stream }));
    await settle();

    const refused = await bench.call("GET", "/projects");
    expect(refused.status).toBe(503);
    expect(await errorOf(refused)).toEqual({ error: "failure", message: "the steward is busy, try again in a moment" });

    for (const { close } of lents) close();
    expect((await Promise.all(inProgress)).every((response) => response.status === 400)).toBe(true);
    expect((await bench.call("GET", "/projects")).status).toBe(200);
  });

  test("systemctl show is cached two seconds per unit, and never run for a static site", async () => {
    const bench = await mount();
    const shows = () => bench.systemctlCalls.filter((call) => call[0] === "show");
    await Promise.all([bench.call("GET", "/projects"), bench.call("GET", "/projects"), bench.call("GET", "/projects")]);
    // Seven sites with a unit, one reading each: not twenty-one, and nothing for showcase.
    expect(shows().length).toBe(7);
    expect(shows().map((call) => call[1]).sort()).toEqual(["builder", "calendar", "cms", "dashboard", "library", "portal", "sitesolide-landing"]);
    bench.clock.t += 1999;
    await bench.call("GET", "/projects");
    expect(shows().length).toBe(7);
    bench.clock.t += 1;
    await bench.call("GET", "/projects");
    expect(shows().length).toBe(14);
  });

  test("at most two systemctl show run together", async () => {
    const bench = await mount({ showSlownessMs: 20 });
    await Promise.all([bench.call("GET", "/projects"), bench.call("GET", "/projects")]);
    expect(bench.simultaneousShows.max).toBe(2);
  });

  test("a content over 64 KiB of JSON passes on /content alone", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const pad = "x".repeat(MAX_BODY_BYTES);
    expect((await bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable: "A", value: pad })).status).toBe(400);
    const content = `${pad.slice(0, 1000)}\n`;
    // Each control character becomes six bytes in JSON: 30,000 make 180 KiB.
    const controlChars = charOf(1).repeat(30_000);
    const response = await bench.call("PUT", "/content", { token, slug: "builder", file: "builder-ssh", content: `${content}${controlChars}` });
    expect(response.status).toBe(200);
  });
});

describe("GET /projects: every site", () => {
  test("every directory in /srv/sites, static, manifest-less, dashboard and portal included", async () => {
    const bench = await mount();
    const enumerate = await projects(bench);
    expect(enumerate.map((project) => project.slug)).toEqual(["builder", "calendar", "cms", "dashboard", "library", "portal", "showcase", "test-zone.invalid"]);
    const showcase = enumerate.find((project) => project.slug === "showcase")!;
    expect(showcase).toMatchObject({ service: null, files: [] });
    const landing = enumerate.find((project) => project.slug === "test-zone.invalid")!;
    expect(landing.service?.unit).toBe("sitesolide-landing");
    expect(landing.files.map((file) => [file.name, file.state, file.expected])).toEqual([
      ["landing-mail.env", "managed", "site-landing:site-landing 0600"],
    ]);
    // cloudflare.env belongs to no site, under /etc/caddy as under the secrets directory.
    expect(JSON.stringify(enumerate)).not.toContain("cloudflare");
  });

  test("a site's files, their variables, with no value at all", async () => {
    const bench = await mount();
    const response = await bench.call("GET", "/projects");
    expect(response.status).toBe(200);
    const text = await response.clone().text();
    const { projects: enumerate } = (await response.json()) as ProjectsResponse;

    const cms = enumerate.find((project) => project.slug === "cms")!;
    expect(cms.service).toEqual({ unit: "cms", state: "active", subState: "running", startedAt: AN_HOUR_AGO_S * 1000 });
    expect(cms.files).toEqual([
      {
        name: "cms.env",
        kind: "variables",
        state: "managed",
        reason: null,
        expected: "site-cms:site-cms 0600",
        readable: true,
        variables: ["SID", "TOKEN"],
        passwords: [],
        bytes: null,
        modifiedAt: expect.any(Number),
        previous: false,
        restartPending: false,
      },
      {
        name: "cms-webhook.env",
        kind: "variables",
        state: "absent",
        reason: null,
        expected: "site-cms:site-cms 0600",
        readable: true,
        variables: [],
        passwords: [],
        bytes: null,
        modifiedAt: null,
        previous: false,
        restartPending: false,
      },
    ]);

    for (const forbidden of [SECRET_TOKEN, SECRET_SID, "$2b$", PRIVATE_KEY.slice(40, 70), SECRET_REGISTRY.trim(), PUBLIC_KEY.slice(20, 50)]) {
      expect(text).not.toContain(forbidden);
    }
  });

  test("builder: variables, private key and registry token write-only, public key readable", async () => {
    const bench = await mount();
    const builder = (await projects(bench)).find((project) => project.slug === "builder")!;
    // The size of a write-only file does not come out: a key's size gives away
    // its algorithm. Its date does come out.
    expect(builder.files.map((f) => [f.name, f.kind, f.state, f.expected, f.readable, f.bytes, typeof f.modifiedAt])).toEqual([
      ["builder.env", "variables", "managed", "site-builder:site-builder 0600", true, null, "number"],
      ["builder-secrets/registry", "content", "managed", "site-builder:site-builder 0400", false, null, "number"],
      ["builder-ssh", "content", "managed", "site-builder:site-builder 0400", false, null, "number"],
      ["builder-ssh.pub", "content", "managed", "site-builder:site-builder 0444", true, PUBLIC_KEY.length, "number"],
    ]);
  });

  test("the dashboard's and the portal's hashes are passwords, never values", async () => {
    const bench = await mount();
    const enumerate = await projects(bench);
    expect(enumerate.find((p) => p.slug === "dashboard")!.files[0]).toMatchObject({
      name: "dashboard.env",
      state: "managed",
      expected: "root:root 0600",
      variables: ["PASSWORD_HASH"],
      passwords: ["PASSWORD_HASH"],
    });
    expect(enumerate.find((p) => p.slug === "portal")!.files[0]).toMatchObject({
      expected: "site-portal:site-portal 0600",
      passwords: ["PASSWORD_HASH"],
    });
  });

  test("each site's portal: asked for, installed, changeable and its reason", async () => {
    const bench = await mount();
    writeFileSync(join(bench.sites, "cms", "sitesolide.json"), JSON.stringify({ slug: "cms", start: "bun server.ts", port: 3048, portal: true, secrets: ["cms.env"] }));
    writeFileSync(join(bench.caddy, "cms.caddy"), "cms.test-zone.invalid {\n\tforward_auth @portal_guard 127.0.0.1:3026 {\n\t\turi /verifier\n\t}\n}\n");
    writeFileSync(join(bench.caddy, "calendar.caddy"), "calendar.test-zone.invalid {\n\treverse_proxy 127.0.0.1:3040\n}\n");
    // A link in place of a block is not read.
    symlinkSync(join(bench.caddy, "cms.caddy"), join(bench.caddy, "library.caddy"));

    const enumerate = await projects(bench);
    const portals = Object.fromEntries(enumerate.map((project) => [project.slug, project.portal]));
    expect(portals.cms).toEqual({ requested: true, installed: true, modifiable: true, reason: null });
    expect(portals.calendar).toEqual({ requested: false, installed: false, modifiable: true, reason: null });
    expect(portals.library).toMatchObject({ installed: false });
    expect(portals.portal).toMatchObject({ modifiable: false, reason: expect.stringContaining("itself") });
    expect(portals.dashboard).toMatchObject({ modifiable: false, reason: expect.stringContaining("dashboard") });
    expect(portals["test-zone.invalid"]).toMatchObject({ requested: false, modifiable: false, reason: expect.stringContaining("sitesolide.json") });
    // `modifiable` and `reason` are the gatekeeper rule's own, never copied.
    for (const project of enumerate) {
      const path = join(bench.sites, project.slug, "sitesolide.json");
      const manifest = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
      const { modifiable, reason } = portalModifiable(project.slug, manifest);
      expect({ modifiable: project.portal.modifiable, reason: project.portal.reason }).toEqual({ modifiable, reason });
    }
  });

  test("a service systemd does not know returns service null, not an error", async () => {
    const bench = await mount();
    bench.scenario.current = (unit) => (unit === "cms" ? "LoadState=not-found\nActiveState=inactive\n" : isRunning(unit, 0));
    expect((await projects(bench)).find((project) => project.slug === "cms")!.service).toBeNull();
  });

  test("an unmanaged content file is listed with its reason, without quoting the line", async () => {
    const bench = await mount();
    writeFileSync(join(bench.secrets, "cms.env"), `SID=1\nexport TOKEN=${SECRET_TOKEN}\n`);
    const text = await (await bench.call("GET", "/projects")).text();
    const file = (JSON.parse(text) as ProjectsResponse).projects.find((project) => project.slug === "cms")!.files[0]!;
    expect(file.state).toBe("unmanaged");
    expect(file.reason).toContain("line 2");
    expect(file.variables).toEqual([]);
    expect(text).not.toContain(SECRET_TOKEN);
  });

  test("a content file that is not UTF-8 text is unmanaged", async () => {
    const bench = await mount();
    chmodSync(join(bench.secrets, "builder-ssh"), 0o600);
    writeFileSync(join(bench.secrets, "builder-ssh"), new Uint8Array([0x41, 0xff, 0x00]));
    chmodSync(join(bench.secrets, "builder-ssh"), 0o400);
    expect(await fileSeen(bench, "builder", "builder-ssh")).toMatchObject({ state: "unmanaged", reason: "not valid UTF-8 text", bytes: null });
  });

  test("a symbolic link is unmanaged, and its target never read", async () => {
    const bench = await mount();
    const target = join(bench.root, "elsewhere.env");
    writeFileSync(target, `STOLEN=${SECRET_TOKEN}\n`);
    symlinkSync(target, join(bench.secrets, "calendar.env"));

    const text = await (await bench.call("GET", "/projects")).text();
    const calendar = (JSON.parse(text) as ProjectsResponse).projects.find((project) => project.slug === "calendar")!;
    expect(calendar.files[0]).toMatchObject({ state: "unmanaged", reason: "symbolic link", variables: [] });
    expect(text).not.toContain("STOLEN");
  });

  test("a file with two hard links is unmanaged", async () => {
    const bench = await mount();
    linkSync(join(bench.secrets, "cms.env"), join(bench.root, "copy.env"));
    expect(await fileSeen(bench, "cms", "cms.env")).toMatchObject({ state: "unmanaged", reason: "several hard links" });
  });

  test("a mode other than the expected one, more open or more closed, is unmanaged, and the reason gives the command", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    chmodSync(join(bench.secrets, "cms.env"), 0o640);
    expect((await fileSeen(bench, "cms", "cms.env")).reason).toBe(`mode 640, expected 600: sudo chmod 600 ${join(bench.secrets, "cms.env")}`);
    const set = await bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable: "A", value: "1" });
    expect(set.status).toBe(409);

    chmodSync(join(bench.secrets, "cms.env"), 0o400);
    bench.clock.t += 2000;
    expect((await fileSeen(bench, "cms", "cms.env")).reason).toContain("expected 600: sudo chmod 600");

    // A private key reopened at 0600 is not rewritten either: 0400 is expected.
    chmodSync(join(bench.secrets, "builder-ssh"), 0o600);
    expect((await fileSeen(bench, "builder", "builder-ssh")).reason).toContain("expected 400: sudo chmod 400");
    const replaced = await bench.call("PUT", "/content", { token, slug: "builder", file: "builder-ssh", content: "other\n" });
    expect(replaced.status).toBe(409);
    chmodSync(join(bench.secrets, "cms.env"), 0o600);
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).toBe(CMS_ENV);
    expect(readFileSync(join(bench.secrets, "builder-ssh"), "utf8")).toBe(PRIVATE_KEY);
  });

  test("a write in the same second as the service's start is pending (bench measurement 4)", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    // Well away from the end of a second, so that start and write fall in the same one.
    while (Date.now() % 1000 > 700 || Date.now() % 1000 < 20) await Bun.sleep(10);
    const started = Date.now() - 10;
    bench.scenario.current = () => showA("active", "running", 0, started);

    const set = await bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable: "TOKEN", value: "after" });
    const { file } = (await set.json()) as FileResponse;
    const modified = statSync(join(bench.secrets, "cms.env")).mtimeMs;
    expect(Math.floor(modified / 1000)).toBe(Math.floor(started / 1000));
    expect(file.restartPending).toBe(true);
    expect(Number.isInteger(file.modifiedAt)).toBe(true);
  });

  test("saving then restarting: nothing is pending any more", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    await bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable: "TOKEN", value: "then" });
    // The restart that follows the write, a few milliseconds later.
    const started = statSync(join(bench.secrets, "cms.env")).mtimeMs + 3;
    bench.scenario.current = () => showA("active", "running", 0, started);
    bench.clock.t += 2000;
    const cms = (await projects(bench)).find((project) => project.slug === "cms")!;
    expect(cms.service!.startedAt).toBe(Math.floor(started));
    expect(cms.files[0]!.restartPending).toBe(false);
  });

  test("a timestamp systemd would return in an unknown form announces nothing", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    bench.scenario.current = () => "LoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=0\nActiveEnterTimestamp=@1789593252\n";
    await bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable: "TOKEN", value: "x" });
    bench.clock.t += 2000;
    const cms = (await projects(bench)).find((project) => project.slug === "cms")!;
    expect(cms.service).toEqual({ unit: "cms", state: "active", subState: "running", startedAt: null });
    expect(cms.files[0]!.restartPending).toBe(false);
  });

  test("a restart pending after a change", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    await bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable: "TOKEN", value: "other" });
    expect((await fileSeen(bench, "cms", "cms.env")).restartPending).toBe(true);
  });
});

describe("a file whose site is gone", () => {
  test("a name whose site is not under /srv/sites is nowhere, and is refused", async () => {
    const bench = await mount();
    rmSync(join(bench.sites, "test-zone.invalid"), { recursive: true });
    const token = await unlock(bench);
    expect((await projects(bench)).map((project) => project.slug)).not.toContain("test-zone.invalid");
    const response = await bench.call("POST", "/file", { token, slug: "test-zone.invalid", file: "landing-mail.env" });
    expect(response.status).toBe(403);
  });
});

describe("the subdirectory of secrets", () => {
  test("replaced inside the directory, at the expected mode, previous version kept apart", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const response = await bench.call("PUT", "/content", { token, slug: "builder", file: "builder-secrets/registry", content: "reg-NEW\n" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as FileResponse).file).toMatchObject({ name: "builder-secrets/registry", state: "managed", previous: true, bytes: null });
    expect(statSync(join(bench.secrets, "builder-secrets", "registry")).mode & 0o777).toBe(0o400);
    expect(readFileSync(join(bench.secrets, "builder-secrets", "registry"), "utf8")).toBe("reg-NEW\n");
    expect(readFileSync(join(bench.state, "precedents", "builder-secrets", "registry"), "utf8")).toBe(SECRET_REGISTRY);
    expect(statSync(join(bench.state, "precedents", "builder-secrets")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(bench.secrets, "builder-secrets"))).toEqual(["registry"]);
    expect(log(bench).at(-1)).toMatchObject({ operation: "replace", result: "ok", slug: "builder", file: "builder-secrets/registry" });
  });

  test("a link in place of the directory: nothing is read or written through it", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const elsewhere = join(bench.root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "registry"), "STOLEN-THROUGH-THE-LINK\n", { mode: 0o400 });
    chmodSync(join(bench.secrets, "builder-secrets", "registry"), 0o600);
    rmSync(join(bench.secrets, "builder-secrets"), { recursive: true });
    symlinkSync(elsewhere, join(bench.secrets, "builder-secrets"));

    const text = await (await bench.call("GET", "/projects")).text();
    // The listing never follows the link, so no file of it is present, and no
    // manifest declares one: the name is out of the scope altogether.
    const files = (JSON.parse(text) as ProjectsResponse).projects.find((p) => p.slug === "builder")!.files;
    expect(files.map((f) => f.name)).not.toContain("builder-secrets/registry");
    const replaced = await bench.call("PUT", "/content", { token, slug: "builder", file: "builder-secrets/registry", content: "overwrite\n" });
    expect(replaced.status).toBe(403);
    expect(readFileSync(join(elsewhere, "registry"), "utf8")).toBe("STOLEN-THROUGH-THE-LINK\n");
    expect(text).not.toContain("STOLEN-THROUGH");
  });

  test("a directory writable by others: unmanaged, and the reason gives the command", async () => {
    const bench = await mount();
    chmodSync(join(bench.secrets, "builder-secrets"), 0o777);
    const seen = await fileSeen(bench, "builder", "builder-secrets/registry");
    expect(seen).toMatchObject({ state: "unmanaged", reason: expect.stringContaining("sudo chmod go-w") });
  });

  test("a missing directory: its files are out of the scope, and the steward never creates it", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    chmodSync(join(bench.secrets, "builder-secrets", "registry"), 0o600);
    rmSync(join(bench.secrets, "builder-secrets"), { recursive: true });
    const builder = (await projects(bench)).find((project) => project.slug === "builder")!;
    expect(builder.files.map((f) => f.name)).not.toContain("builder-secrets/registry");
    const creation = await bench.call("POST", "/file", { token, slug: "builder", file: "builder-secrets/registry" });
    expect(creation.status).toBe(403);
    expect(existsSync(join(bench.secrets, "builder-secrets"))).toBe(false);
  });

  test("with checks on, a directory not owned by root is unmanaged", async () => {
    const bench = await mount({ checkAccounts: true, accounts: ACCOUNTS, uidRoot: UID + 1 });
    const seen = await fileSeen(bench, "builder", "builder-secrets/registry");
    expect(seen).toMatchObject({ state: "unmanaged", reason: expect.stringContaining("not root: sudo chown root:root") });
  });
});

describe("POST /content: reading back, and only what is readable", () => {
  test("the public key reads back, the private key and the subdirectory's secrets never", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const unitEnv = await bench.call("POST", "/content", { token, slug: "builder", file: "builder-ssh.pub" });
    expect(unitEnv.status).toBe(200);
    expect(((await unitEnv.json()) as ContentResponse).content).toBe(PUBLIC_KEY);

    for (const file of ["builder-ssh", "builder-secrets/registry"]) {
      const refused = await bench.call("POST", "/content", { token, slug: "builder", file });
      expect(refused.status).toBe(403);
      const text = await refused.text();
      expect(text).toContain("write-only");
      expect(text).not.toContain("PRIVATE KEY");
      expect(text).not.toContain("REGISTRY-TOKEN");
    }
    expect(log(bench).filter((e) => e.operation === "read").map((e) => [e.file, e.result])).toEqual([
      ["builder-ssh.pub", "ok"],
      ["builder-ssh", "rejects"],
      ["builder-secrets/registry", "rejects"],
    ]);
  });

  test("a write-only file is refused before it is even opened", async () => {
    const openFiles: string[] = [];
    let real!: System;
    const bench = await mount({
      overrides: {
        examineSecret: async (name) => {
          openFiles.push(name);
          return real.examineSecret(name);
        },
      },
    });
    real = createSystem(bench.config);
    const token = await unlock(bench);
    expect((await bench.call("POST", "/content", { token, slug: "builder", file: "builder-ssh" })).status).toBe(403);
    expect(openFiles).toEqual([]);
  });

  test("an environment file is not read as one block, a content file not variable by variable", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const block = await bench.call("POST", "/content", { token, slug: "cms", file: "cms.env" });
    expect(block.status).toBe(400);
    expect(await block.text()).not.toContain(SECRET_TOKEN);
    expect((await bench.call("POST", "/value", { token, slug: "builder", file: "builder-ssh.pub", variable: "A" })).status).toBe(400);
    expect((await bench.call("PUT", "/variable", { token, slug: "builder", file: "builder-ssh", variable: "A", value: "1" })).status).toBe(400);
    expect((await bench.call("DELETE", "/variable", { token, slug: "builder", file: "builder-ssh", variable: "A" })).status).toBe(400);
    expect((await bench.call("PUT", "/content", { token, slug: "cms", file: "cms.env", content: "A=1\n" })).status).toBe(400);
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).toBe(CMS_ENV);
  });

  test("no route returns the private key", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const target = { token, slug: "builder", file: "builder-ssh" };
    const responses = [
      await bench.call("GET", "/projects"),
      await bench.call("POST", "/content", target),
      await bench.call("POST", "/value", { ...target, variable: "KEY" }),
      await bench.call("PUT", "/content", { ...target, content: "replacement\n" }),
      await bench.call("POST", "/restore", target),
      await bench.call("POST", "/content", target),
      await bench.call("POST", "/file", target),
      await bench.call("GET", "/log"),
      await bench.call("GET", "/log?slug=builder"),
    ];
    expect(readFileSync(join(bench.secrets, "builder-ssh"), "utf8")).toBe(PRIVATE_KEY);
    for (const response of responses) {
      const text = await response.text();
      expect(text).not.toContain("PRIVATE KEY");
      expect(text).not.toContain("replacement");
    }
    expect(readFileSync(join(bench.state, "journal.jsonl"), "utf8")).not.toContain("PRIVATE");
  });
});

describe("PUT /content: replacing as one block", () => {
  test("byte for byte, Windows line ending, byte order mark and final newline included, previous version kept", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const content = `${charOf(0xfeff)}${KEY_HEADER}\r\nline ${charOf(0xe9)}t${charOf(0xe9)} ${charOf(0x1f511)}\r\n\n-----END-----\n`;
    const response = await bench.call("PUT", "/content", { token, slug: "builder", file: "builder-ssh", content });
    expect(response.status).toBe(200);
    const { file } = (await response.json()) as FileResponse;
    const expected = new TextEncoder().encode(content);
    expect(file).toMatchObject({ state: "managed", readable: false, previous: true, bytes: null });
    expect(new Uint8Array(readFileSync(join(bench.secrets, "builder-ssh")))).toEqual(expected);
    expect(statSync(join(bench.secrets, "builder-ssh")).mode & 0o777).toBe(0o400);
    expect(readFileSync(join(bench.state, "precedents", "builder-ssh"), "utf8")).toBe(PRIVATE_KEY);
    expect(readdirSync(bench.secrets).filter(isTemporary)).toEqual([]);
    // The answer returns neither the content nor, for a write-only file, its size.
    expect(JSON.stringify(file)).not.toContain("BEGIN");
  });

  test("the public key keeps its 0444, and reads back as written", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const content = "ssh-ed25519 AAAA-newer builder";
    const replaced = await bench.call("PUT", "/content", { token, slug: "builder", file: "builder-ssh.pub", content });
    expect(replaced.status).toBe(200);
    // Readable, so its size is given.
    expect(((await replaced.json()) as FileResponse).file.bytes).toBe(content.length);
    expect(statSync(join(bench.secrets, "builder-ssh.pub")).mode & 0o777).toBe(0o444);
    const reread = await bench.call("POST", "/content", { token, slug: "builder", file: "builder-ssh.pub" });
    expect(((await reread.json()) as ContentResponse).content).toBe(content);
  });

  test("refused contents leave the file intact, and the message does not quote them", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const raw = (content: string) => `{"token":"${token}","slug":"builder","file":"builder-ssh","content":"${content}"}`;
    const refusal = [
      JSON.stringify({ token, slug: "builder", file: "builder-ssh", content: "SECRET\0after" }),
      JSON.stringify({ token, slug: "builder", file: "builder-ssh", content: "x".repeat(64 * 1024 + 1) }),
      JSON.stringify({ token, slug: "builder", file: "builder-ssh", content: charOf(0xe9).repeat(32 * 1024 + 1) }),
      raw(`SECRET${BACKSLASH}ud800`),
      JSON.stringify({ token, slug: "builder", file: "builder-ssh", content: 42 }),
    ];
    for (const body of refusal) {
      const response = await bench.call("PUT", "/content", body);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("SECRET");
    }
    expect(readFileSync(join(bench.secrets, "builder-ssh"), "utf8")).toBe(PRIVATE_KEY);
    expect(existsSync(join(bench.state, "precedents", "builder-ssh"))).toBe(false);
  });

  test("exactly 64 KiB passes", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const response = await bench.call("PUT", "/content", { token, slug: "builder", file: "builder-ssh", content: "x".repeat(64 * 1024) });
    expect(response.status).toBe(200);
  });

  test("missing and declared by no manifest: out of the scope, never created", async () => {
    // A content file cannot be declared by a manifest, so once gone it is no
    // site's: put it back by hand on the machine, and the dashboard manages it
    // again. Creating it from here would let the dashboard lay a file down for
    // a service that does not expect one.
    const bench = await mount();
    const token = await unlock(bench);
    chmodSync(join(bench.secrets, "builder-ssh"), 0o600);
    rmSync(join(bench.secrets, "builder-ssh"));
    const target = { token, slug: "builder", file: "builder-ssh" };
    expect((await bench.call("PUT", "/content", { ...target, content: "key\n" })).status).toBe(403);
    expect((await bench.call("POST", "/file", target)).status).toBe(403);
    expect(existsSync(join(bench.secrets, "builder-ssh"))).toBe(false);
  });

  test("restoring swaps a content file and its previous version", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const target = { token, slug: "builder", file: "builder-secrets/registry" };
    await bench.call("PUT", "/content", { ...target, content: "newer\n" });
    expect((await bench.call("POST", "/restore", target)).status).toBe(200);
    expect(readFileSync(join(bench.secrets, "builder-secrets", "registry"), "utf8")).toBe(SECRET_REGISTRY);
    expect(statSync(join(bench.secrets, "builder-secrets", "registry")).mode & 0o777).toBe(0o400);
    expect(readFileSync(join(bench.state, "precedents", "builder-secrets", "registry"), "utf8")).toBe("newer\n");
  });

  test("with checks on, creation and replacement set the account and mode that follow from the name", async () => {
    const bench = await mount({ checkAccounts: true, accounts: ACCOUNTS, uidRoot: UID });
    const token = await unlock(bench);
    // A file its manifest declares is created at 0600, an environment file.
    expect((await bench.call("POST", "/file", { token, slug: "cms", file: "cms-webhook.env" })).status).toBe(200);
    const created = statSync(join(bench.secrets, "cms-webhook.env"));
    expect([created.uid, created.gid, created.mode & 0o777]).toEqual([UID, TEST_GID, 0o600]);
    // A public key replaced keeps the 0444 its name calls for.
    expect((await bench.call("PUT", "/content", { token, slug: "builder", file: "builder-ssh.pub", content: "ssh-ed25519 X\n" })).status).toBe(200);
    expect(statSync(join(bench.secrets, "builder-ssh.pub")).mode & 0o777).toBe(0o444);
  });
});

describe("POST /unlock", () => {
  test("the right password returns a ten-minute token, a wrong one is refused", async () => {
    const bench = await mount();
    const bad = await bench.call("POST", "/unlock", { password: "wrong" });
    expect(bad.status).toBe(401);
    expect((await errorOf(bad)).error).toBe("refused");

    const bon = await bench.call("POST", "/unlock", { password: PASSWORD });
    expect(bon.status).toBe(200);
    const body = (await bon.json()) as UnlockResponse;
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBe(bench.clock.t + UNLOCK_DURATION_MS);

    expect(log(bench).map((e) => [e.operation, e.result, e.detail])).toEqual([
      ["unlock", "rejects", "wrong password"],
      ["unlock", "ok", null],
    ]);
  });

  test("password missing or too long: invalid, with no failure counted", async () => {
    const bench = await mount();
    for (const body of [{}, { password: "" }, { password: "x".repeat(257) }, { password: 42 }]) {
      expect((await bench.call("POST", "/unlock", body)).status).toBe(400);
    }
    expect(log(bench)).toEqual([]);
    expect(existsSync(join(bench.state, "rate-limit.json"))).toBe(false);
  });

  test("rate limiting: past the tolerated failures, 429 with the wait, even for the right password", async () => {
    const bench = await mount();
    for (let i = 0; i <= TOLERATED_FAILURES; i++) {
      expect((await bench.call("POST", "/unlock", { password: `wrong ${i}` })).status).toBe(401);
    }
    const throttled = await bench.call("POST", "/unlock", { password: PASSWORD });
    expect(throttled.status).toBe(429);
    expect((await errorOf(throttled)).wait).toBe(INITIAL_BACKOFF_MS / 1000);

    bench.clock.t += INITIAL_BACKOFF_MS;
    expect((await bench.call("POST", "/unlock", { password: PASSWORD })).status).toBe(200);
  });

  test("a burst: one verification at a time, bounded queue, rate limiting held", async () => {
    const { account, check } = countedVerification();
    const bench = await mount({ check });
    const burst = await Promise.all(
      Array.from({ length: 10 }, (_, i) => bench.call("POST", "/unlock", { password: `wrong ${i}` })),
    );
    const statuses = burst.map((response) => response.status);
    // Two simultaneous argon2id verifications get the service killed at 128M.
    expect(account.max).toBe(1);
    // One under way, four queued: the other five are refused outright.
    expect(statuses.filter((status) => status === 503).length).toBe(10 - MAX_QUEUED - 1);
    expect(statuses.filter((status) => status === 401).length).toBe(TOLERATED_FAILURES + 1);
    expect(statuses.filter((status) => status === 429).length).toBe(MAX_QUEUED - TOLERATED_FAILURES);
    expect(account.total).toBe(TOLERATED_FAILURES + 1);
  });

  test("the rate limiting survives a restart of the steward", async () => {
    const bench = await mount();
    for (let i = 0; i <= TOLERATED_FAILURES; i++) {
      expect((await bench.call("POST", "/unlock", { password: `wrong ${i}` })).status).toBe(401);
    }
    // A compromised dashboard brings the steward down, Restart=always starts it again.
    bench.restartSteward();
    const after = await bench.call("POST", "/unlock", { password: PASSWORD });
    expect(after.status).toBe(429);
    expect((await errorOf(after)).wait).toBe(INITIAL_BACKOFF_MS / 1000);
  });

  test("the attempt is counted on disk before the verification", async () => {
    const fieldsRead: unknown[] = [];
    const bench = await mount({
      check: async () => {
        // What an abrupt stop during argon2id would leave behind.
        fieldsRead.push(JSON.parse(readFileSync(join(bench.state, "rate-limit.json"), "utf8")));
        return false;
      },
    });
    await bench.call("POST", "/unlock", { password: "wrong" });
    await bench.call("POST", "/unlock", { password: "wrong" });
    expect(fieldsRead).toEqual([
      { failures: 1, lastFailureAt: bench.clock.t },
      { failures: 2, lastFailureAt: bench.clock.t },
    ]);
  });

  test("a success resets the on-disk counter to zero", async () => {
    const bench = await mount();
    await bench.call("POST", "/unlock", { password: "wrong" });
    await unlock(bench);
    expect(JSON.parse(readFileSync(join(bench.state, "rate-limit.json"), "utf8"))).toEqual({ failures: 0, lastFailureAt: 0 });
    expect(statSync(join(bench.state, "rate-limit.json")).mode & 0o777).toBe(0o600);
  });

  test("an unreadable rate limit at startup counts as the maximum one", async () => {
    const bench = await mount();
    writeFileSync(join(bench.state, "rate-limit.json"), "{truncated");
    bench.restartSteward();
    const response = await bench.call("POST", "/unlock", { password: PASSWORD });
    expect(response.status).toBe(429);
    expect((await errorOf(response)).wait).toBe(MAXIMUM_BACKOFF_MS / 1000);
  });

  test("with no way to count the attempt, no verification", async () => {
    const { account, check } = countedVerification();
    const bench = await mount({
      check,
      overrides: {
        writeRateLimit: async () => {
          throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        },
      },
    });
    const response = await bench.call("POST", "/unlock", { password: PASSWORD });
    expect(response.status).toBe(500);
    expect(account.total).toBe(0);
  });

  test("with no hash, nobody gets in", async () => {
    const bench = await mount({ hash: null });
    expect((await bench.call("POST", "/unlock", { password: PASSWORD })).status).toBe(401);
    expect(log(bench)[0]!.detail).toBe("no password hash");
  });

  test("the hash is read again on every attempt: a rotation counts at once", async () => {
    const bench = await mount();
    const fresh = await hashFast("a new password");
    writeFileSync(join(bench.secrets, "dashboard.env"), `PASSWORD_HASH=${fresh}\n`, { mode: 0o600 });
    expect((await bench.call("POST", "/unlock", { password: PASSWORD })).status).toBe(401);
    expect((await bench.call("POST", "/unlock", { password: "a new password" })).status).toBe(200);
  });

  test("with checks on, a hash not owned by root alone refuses every unlock", async () => {
    const { account, check } = countedVerification();
    const bench = await mount({ checkAccounts: true, accounts: ACCOUNTS, uidRoot: UID, check });

    chmodSync(join(bench.secrets, "dashboard.env"), 0o640);
    const readable = await bench.call("POST", "/unlock", { password: PASSWORD });
    expect(readable.status).toBe(500);
    expect(await errorOf(readable)).toEqual({ error: "failure", message: "unexpected error, see the steward's log on the server" });
    expect(account.total).toBe(0);
    expect(log(bench).at(-1)).toMatchObject({ operation: "unlock", result: "failure", detail: "password hash file not protected" });

    chmodSync(join(bench.secrets, "dashboard.env"), 0o600);
    expect((await bench.call("POST", "/unlock", { password: PASSWORD })).status).toBe(200);
  });

  test("with checks on, a hash that does not belong to root is refused", async () => {
    // The workstation's uid is not 0.
    const bench = await mount({ checkAccounts: true, accounts: ACCOUNTS });
    expect((await bench.call("POST", "/unlock", { password: PASSWORD })).status).toBe(500);
  });

  test("expiry: the token dies at ten minutes, locking revokes it", async () => {
    const bench = await mount();
    const body = (token: string) => ({ token, slug: "cms", file: "cms.env", variable: "TOKEN" });

    const token = await unlock(bench);
    bench.clock.t += UNLOCK_DURATION_MS - 1;
    expect((await bench.call("POST", "/value", body(token))).status).toBe(200);
    bench.clock.t += 1;
    const expire = await bench.call("POST", "/value", body(token));
    expect(expire.status).toBe(401);
    expect((await errorOf(expire)).error).toBe("locked");

    const second = await unlock(bench);
    expect((await bench.call("POST", "/lock", { token: "wrong" })).status).toBe(204);
    expect((await bench.call("POST", "/value", body(second))).status).toBe(200);
    expect((await bench.call("POST", "/lock", { token: second })).status).toBe(204);
    expect((await bench.call("POST", "/value", body(second))).status).toBe(401);
  });
});

describe("the write queue", () => {
  function blockQueue(bench: Bench): () => void {
    let release!: () => void;
    bench.barrier.promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      bench.barrier.promise = null;
      release();
    };
  }

  test("a write waiting behind a restart does not go through if you lock in the meantime", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const release = blockQueue(bench);

    const restarting = bench.call("POST", "/restart", { token, slug: "cms" });
    const set = bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable: "TOKEN", value: "stolen" });
    const replacing = bench.call("PUT", "/content", { token, slug: "builder", file: "builder-ssh", content: "stolen\n" });
    await settle();
    // Locking does not wait on the queue: it is what stops whatever is waiting.
    expect((await bench.call("POST", "/lock", { token })).status).toBe(204);
    release();

    expect((await restarting).status).toBe(200);
    for (const refused of [await set, await replacing]) {
      expect(refused.status).toBe(401);
      expect((await errorOf(refused)).error).toBe("locked");
    }
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).toBe(CMS_ENV);
    expect(readFileSync(join(bench.secrets, "builder-ssh"), "utf8")).toBe(PRIVATE_KEY);
  });

  test("a request the relay gave up on is not carried out", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const release = blockQueue(bench);
    const abandon = new AbortController();

    const restarting = bench.call("POST", "/restart", { token, slug: "cms" });
    const set = bench.call(
      "PUT",
      "/variable",
      { token, slug: "cms", file: "cms.env", variable: "TOKEN", value: "too late" },
      { signal: abandon.signal },
    );
    await settle();
    abandon.abort();
    release();

    await restarting;
    expect((await set).status).toBe(500);
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).toBe(CMS_ENV);
  });

  test("beyond four waiting requests, 503", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const release = blockQueue(bench);

    const queued = [bench.call("POST", "/restart", { token, slug: "cms" })];
    for (let i = 0; i < MAX_QUEUED; i++) {
      queued.push(bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable: `KEY_${i}`, value: "1" }));
    }
    await settle();
    const refused = await bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable: "TOO_MANY", value: "1" });
    expect(refused.status).toBe(503);

    release();
    expect((await Promise.all(queued)).map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).not.toContain("TOO_MANY");
  });

  test("two simultaneous writes go one after the other, neither is lost", async () => {
    const bench = await mount({ slownessMs: 5 });
    const token = await unlock(bench);
    const poses = Array.from({ length: MAX_QUEUED + 1 }, (_, i) =>
      bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable: `KEY_${i}`, value: `${i}` }),
    );
    expect((await Promise.all(poses)).map((response) => response.status)).toEqual(Array(MAX_QUEUED + 1).fill(200));
    const text = readFileSync(join(bench.secrets, "cms.env"), "utf8");
    for (let i = 0; i <= MAX_QUEUED; i++) expect(text).toContain(`KEY_${i}=${i}\n`);
  });
});

describe("the scope of requests", () => {
  test("with no token, nothing: no read, no write, no password, no portal, no restart", async () => {
    const bench = await mount();
    const before = readFileSync(join(bench.secrets, "cms.env"), "utf8");
    const wanted: [string, string, Record<string, unknown>][] = [
      ["POST", "/value", { slug: "cms", file: "cms.env", variable: "TOKEN" }],
      ["PUT", "/variable", { slug: "cms", file: "cms.env", variable: "TOKEN", value: "x" }],
      ["DELETE", "/variable", { slug: "cms", file: "cms.env", variable: "TOKEN" }],
      ["POST", "/file", { slug: "cms", file: "cms-webhook.env" }],
      ["POST", "/restore", { slug: "cms", file: "cms.env" }],
      ["POST", "/content", { slug: "builder", file: "builder-ssh.pub" }],
      ["PUT", "/content", { slug: "builder", file: "builder-ssh", content: "x" }],
      ["POST", "/password", { slug: "portal", file: "portal.env", variable: "PASSWORD_HASH", dashboardPassword: PASSWORD, newPassword: null }],
      ["POST", "/portal", { slug: "cms", active: true, confirmation: "" }],
      ["POST", "/restart", { slug: "cms" }],
    ];
    for (const [method, path, body] of wanted) {
      for (const token of [undefined, "wrong", ""]) {
        const response = await bench.call(method, path, token === undefined ? body : { ...body, token });
        expect(response.status).toBe(401);
      }
    }
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).toBe(before);
    expect(readFileSync(join(bench.secrets, "builder-ssh"), "utf8")).toBe(PRIVATE_KEY);
    expect(existsSync(join(bench.secrets, "cms-webhook.env"))).toBe(false);
    expect(bench.systemctlCalls).toEqual([]);
    // A dashboard password submitted with no token does not count towards the rate limiting.
    expect(existsSync(join(bench.state, "rate-limit.json"))).toBe(false);
  });

  test("traversals, undeclared names, unknown sites: 403", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const targets: [string, string][] = [
      ["cms", "../dashboard.env"],
      ["cms", "../../etc/passwd"],
      ["cms", "cms.env/../dashboard.env"],
      ["cms", "..%2fdashboard.env"],
      ["cms", "cms.env\0"],
      ["cms", "dashboard.env"],
      ["cms", "cms-non-declare.env"],
      ["cms", "calendar.env"],
      ["builder", "builder-secrets/../cms.env"],
      ["builder", "builder-secrets/unknown"],
      ["builder", "cms-secrets/registry"],
      ["../cms", "cms.env"],
      ["showcase", "showcase.env"],
      ["unknown", "unknown.env"],
      ["landing", "landing-mail.env"],
      ["test-zone.invalid", "cloudflare.env"],
    ];
    for (const [slug, file] of targets) {
      const response = await bench.call("POST", "/value", { token, slug, file, variable: "TOKEN" });
      expect(response.status).toBe(403);
      expect((await errorOf(response)).error).toBe("out-of-scope");
    }
    const response = await bench.call("PUT", "/variable", { token, slug: "cms", file: "../dashboard.env", variable: "PASSWORD_HASH", value: "x" });
    expect(response.status).toBe(403);
    expect(readFileSync(join(bench.secrets, "dashboard.env"), "utf8")).toContain("PASSWORD_HASH=$2");
  });

  test("refusals after the token are journalled, without the malformed name", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    await bench.call("POST", "/value", { token, slug: "cms", file: "../dashboard.env", variable: "X" });
    expect(log(bench).at(-1)).toMatchObject({
      operation: "read",
      result: "rejects",
      slug: "cms",
      file: null,
      variable: null,
      detail: "out-of-scope",
    });
  });

  test("builder.env and the landing are handled like ordinary variables", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    for (const [slug, file] of [["builder", "builder.env"], ["test-zone.invalid", "landing-mail.env"]] as const) {
      expect((await bench.call("PUT", "/variable", { token, slug, file, variable: "KEY", value: "v1" })).status).toBe(200);
      const unitEnv = await bench.call("POST", "/value", { token, slug, file, variable: "KEY" });
      expect(((await unitEnv.json()) as ValueResponse).value).toBe("v1");
    }
    expect(log(bench).find((e) => e.slug === "test-zone.invalid")).toMatchObject({ file: "landing-mail.env" });
  });
});

describe("hash only: dashboard.env and portal.env carry nothing but PASSWORD_HASH", () => {
  test("any other variable is refused on write, and the file stays intact", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const cas: [string, string, string][] = [
      // The dashboard's relay would send the next Unlock's password to another socket.
      ["dashboard", "dashboard.env", "STEWARD_SOCKET"],
      ["dashboard", "dashboard.env", "PORTAL_URL"],
      ["dashboard", "dashboard.env", "STATE_FILE"],
      ["portal", "portal.env", "OTHER"],
    ];
    const before = { dashboard: readFileSync(join(bench.secrets, "dashboard.env"), "utf8"), portal: readFileSync(join(bench.secrets, "portal.env"), "utf8") };
    for (const [slug, file, variable] of cas) {
      const response = await bench.call("PUT", "/variable", { token, slug, file, variable, value: "/tmp/trap.sock" });
      expect(response.status).toBe(403);
      expect(await errorOf(response)).toEqual({
        error: "out-of-scope",
        message: `${file} holds PASSWORD_HASH only: any other variable would change how its service runs, not add a secret`,
      });
    }
    expect(readFileSync(join(bench.secrets, "dashboard.env"), "utf8")).toBe(before.dashboard);
    expect(readFileSync(join(bench.secrets, "portal.env"), "utf8")).toBe(before.portal);
    for (const file of ["dashboard.env", "portal.env"]) expect(existsSync(join(bench.state, "precedents", file))).toBe(false);
    // A name incomplete from the file does not enter the log.
    expect(log(bench).filter((e) => e.operation === "set").map((e) => [e.result, e.variable, e.detail])).toEqual(
      Array(cas.length).fill(["rejects", null, "out-of-scope"]),
    );
  });

  test("a file that already carries another one is unmanaged: listed with the reason, never rewritten", async () => {
    const { account, check } = countedVerification();
    const bench = await mount({ check, hashPassword: hashFast });
    const token = await unlock(bench);
    const trap = `${readFileSync(join(bench.secrets, "portal.env"), "utf8")}PORTAL_URL=http://127.0.0.1:9/\n`;
    writeFileSync(join(bench.secrets, "portal.env"), trap, { mode: 0o600 });

    const seen = await fileSeen(bench, "portal", "portal.env");
    expect(seen).toMatchObject({ state: "unmanaged", variables: [], passwords: [], previous: false });
    expect(seen.reason).toBe(
      `holds variables other than PASSWORD_HASH (PORTAL_URL), which would change how its service runs: remove them by hand from ${join(bench.secrets, "portal.env")}`,
    );

    const totalBefore = account.total;
    const actions: [string, string, Record<string, unknown>][] = [
      ["DELETE", "/variable", { variable: "PORTAL_URL" }],
      ["POST", "/value", { variable: "PORTAL_URL" }],
      ["POST", "/password", { variable: "PASSWORD_HASH", dashboardPassword: PASSWORD, newPassword: null }],
    ];
    for (const [method, path, others] of actions) {
      const response = await bench.call(method, path, { token, slug: "portal", file: "portal.env", ...others });
      expect(response.status).toBe(409);
      expect((await errorOf(response)).message).toContain("holds variables other than PASSWORD_HASH");
    }
    expect(account.total).toBe(totalBefore);
    expect(readFileSync(join(bench.secrets, "portal.env"), "utf8")).toBe(trap);
  });
});

describe("reading and writing", () => {
  test("POST /value returns the value, 404 for a missing variable or file", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const unitEnv = await bench.call("POST", "/value", { token, slug: "cms", file: "cms.env", variable: "TOKEN" });
    expect(((await unitEnv.json()) as ValueResponse).value).toBe(SECRET_TOKEN);

    expect((await bench.call("POST", "/value", { token, slug: "cms", file: "cms.env", variable: "NON" })).status).toBe(404);
    expect((await bench.call("POST", "/value", { token, slug: "cms", file: "cms-webhook.env", variable: "X" })).status).toBe(404);

    expect(log(bench).find((e) => e.operation === "read" && e.result === "ok")).toMatchObject({
      slug: "cms",
      file: "cms.env",
      variable: "TOKEN",
    });
  });

  test("PUT /variable replaces in place, keeps the comments, the previous version and the expected mode", async () => {
    const bench = await mount();
    const token = await unlock(bench);

    const response = await bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable: "TOKEN", value: SECRET_SET });
    expect(response.status).toBe(200);
    expect(((await response.json()) as FileResponse).file).toMatchObject({ name: "cms.env", state: "managed", variables: ["SID", "TOKEN"], previous: true });

    const text = readFileSync(join(bench.secrets, "cms.env"), "utf8");
    expect(text.startsWith(`# CMS mail, to renew at the slightest doubt\nSID=${SECRET_SID}\n\n# the token\nTOKEN=`)).toBe(true);
    expect(readFileSync(join(bench.state, "precedents", "cms.env"), "utf8")).toBe(CMS_ENV);
    expect(statSync(join(bench.state, "precedents", "cms.env")).mode & 0o777).toBe(0o600);
    expect(statSync(join(bench.secrets, "cms.env")).mode & 0o777).toBe(0o600);
    expect(readdirSync(bench.secrets).filter(isTemporary)).toEqual([]);

    const reread = await bench.call("POST", "/value", { token, slug: "cms", file: "cms.env", variable: "TOKEN" });
    expect(((await reread.json()) as ValueResponse).value).toBe(SECRET_SET);
  });

  test("a new variable goes to the end", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    await bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable: "REGION", value: "eu-west-3" });
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).toBe(`${CMS_ENV}REGION=eu-west-3\n`);
  });

  test("the keys set by the unit, its extensions, the manifest, and the reserved families are refused", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const refused = [
      "PORT",
      "DATA_DIR",
      "ADDED_BY_HAND",
      "FROM_EXTENSION",
      "NODE_ENV",
      "DEFAULT_SENDER",
      "LD_PRELOAD",
      "PATH",
      "BUN_OPTIONS",
      "HTTPS_PROXY",
      "https_proxy",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "SSL_CERT_FILE",
      "1X",
      "A-B",
    ];
    for (const variable of refused) {
      const response = await bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable, value: "x" });
      expect(response.status).toBe(400);
      expect((await errorOf(response)).error).toBe("invalid");
    }
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).toBe(CMS_ENV);
  });

  test("the refused values, and the message does not quote them", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    for (const value of [`${SECRET_SET}\nINJECTED=1`, `a\rb`, "a\0b", "x".repeat(8193), `SECRET${charOf(0xd800)}`]) {
      const response = await bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable: "TOKEN", value });
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain("SECRET");
    }
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).toBe(CMS_ENV);
  });

  test("an unmanaged file or a link is never rewritten: 409", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    writeFileSync(join(bench.secrets, "cms.env"), "export A=1\n");
    const target = join(bench.root, "elsewhere.env");
    writeFileSync(target, "A=1\n");
    symlinkSync(target, join(bench.secrets, "calendar.env"));

    for (const [slug, file] of [["cms", "cms.env"], ["calendar", "calendar.env"]] as const) {
      const response = await bench.call("PUT", "/variable", { token, slug, file, variable: "B", value: "2" });
      expect(response.status).toBe(409);
      expect((await errorOf(response)).error).toBe("unmanaged");
    }
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).toBe("export A=1\n");
    expect(readFileSync(target, "utf8")).toBe("A=1\n");
    expect(lstatSync(join(bench.secrets, "calendar.env")).isSymbolicLink()).toBe(true);
  });

  test("PUT on a missing file: 404, it has to be created first", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const response = await bench.call("PUT", "/variable", { token, slug: "cms", file: "cms-webhook.env", variable: "A", value: "1" });
    expect(response.status).toBe(404);
    expect(existsSync(join(bench.secrets, "cms-webhook.env"))).toBe(false);
  });

  test("DELETE /variable removes without touching the neighbours, 404 if missing", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const response = await bench.call("DELETE", "/variable", { token, slug: "cms", file: "cms.env", variable: "SID" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as FileResponse).file.variables).toEqual(["TOKEN"]);
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).toBe(`# CMS mail, to renew at the slightest doubt\n\n# the token\nTOKEN=${SECRET_TOKEN}\n`);
    expect((await bench.call("DELETE", "/variable", { token, slug: "cms", file: "cms.env", variable: "SID" })).status).toBe(404);
  });

  test("POST /file creates a declared and missing file empty at 0600, 409 if it exists", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const response = await bench.call("POST", "/file", { token, slug: "cms", file: "cms-webhook.env" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as FileResponse).file).toMatchObject({ state: "managed", variables: [] });
    expect(readFileSync(join(bench.secrets, "cms-webhook.env"), "utf8")).toBe("");
    expect(statSync(join(bench.secrets, "cms-webhook.env")).mode & 0o777).toBe(0o600);

    const encore = await bench.call("POST", "/file", { token, slug: "cms", file: "cms-webhook.env" });
    expect(encore.status).toBe(409);
    expect((await errorOf(encore)).error).toBe("already-present");

    expect((await bench.call("POST", "/file", { token, slug: "cms", file: "cms.env" })).status).toBe(409);
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).toBe(CMS_ENV);
  });

  test("POST /file does not replace a symbolic link", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    symlinkSync(join(bench.root, "nowhere"), join(bench.secrets, "cms-webhook.env"));
    expect((await bench.call("POST", "/file", { token, slug: "cms", file: "cms-webhook.env" })).status).toBe(409);
    expect(existsSync(join(bench.root, "nowhere"))).toBe(false);
  });

  test("POST /restore swaps current and previous, twice comes back to the start", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const target = { token, slug: "cms", file: "cms.env" };

    expect((await bench.call("POST", "/restore", target)).status).toBe(404);

    await bench.call("PUT", "/variable", { ...target, variable: "TOKEN", value: "newvalue" });
    const modified = readFileSync(join(bench.secrets, "cms.env"), "utf8");

    expect((await bench.call("POST", "/restore", target)).status).toBe(200);
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).toBe(CMS_ENV);
    expect(readFileSync(join(bench.state, "precedents", "cms.env"), "utf8")).toBe(modified);

    expect((await bench.call("POST", "/restore", target)).status).toBe(200);
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).toBe(modified);
  });

  test("restoring writes the previous version before the secret: a stop between the two keeps the version in place", async () => {
    const order: string[] = [];
    let real!: System;
    const bench = await mount({
      overrides: {
        writePrevious: async (name, bytes, owner) => {
          order.push("previous");
          return real.writePrevious(name, bytes, owner);
        },
        writeSecret: async (name, bytes, permissions) => {
          order.push("secret");
          return real.writeSecret(name, bytes, permissions);
        },
      },
    });
    real = createSystem(bench.config);
    const token = await unlock(bench);
    const target = { token, slug: "cms", file: "cms.env" };
    await bench.call("PUT", "/variable", { ...target, variable: "TOKEN", value: "newvalue" });
    order.length = 0;

    expect((await bench.call("POST", "/restore", target)).status).toBe(200);
    expect(order).toEqual(["previous", "secret"]);
  });

  test("an unmanaged previous version is not restored", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    mkdirSync(join(bench.state, "precedents"), { recursive: true });
    writeFileSync(join(bench.state, "precedents", "cms.env"), "export A=1\n");
    expect((await bench.call("POST", "/restore", { token, slug: "cms", file: "cms.env" })).status).toBe(409);
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).toBe(CMS_ENV);
  });
});

describe("password hashes never go through /value or /variable", () => {
  test("POST /value refuses, without ever opening the file, and nothing comes out", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    for (const [slug, file] of [["dashboard", "dashboard.env"], ["portal", "portal.env"]] as const) {
      const response = await bench.call("POST", "/value", { token, slug, file, variable: "PASSWORD_HASH" });
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).toContain("Change password");
      expect(text).not.toContain("$2b$");
    }
    expect(log(bench).filter((e) => e.operation === "read").map((e) => [e.slug, e.variable, e.result])).toEqual([
      ["dashboard", "PASSWORD_HASH", "rejects"],
      ["portal", "PASSWORD_HASH", "rejects"],
    ]);
  });

  test("PUT and DELETE /variable refuse: change it with Change password", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const before = readFileSync(join(bench.secrets, "portal.env"), "utf8");
    const set = await bench.call("PUT", "/variable", { token, slug: "portal", file: "portal.env", variable: "PASSWORD_HASH", value: "$argon2id$wrong" });
    expect(set.status).toBe(403);
    expect((await errorOf(set)).message).toContain("change it with Change password");
    const removal = await bench.call("DELETE", "/variable", { token, slug: "dashboard", file: "dashboard.env", variable: "PASSWORD_HASH" });
    expect(removal.status).toBe(403);
    expect(readFileSync(join(bench.secrets, "portal.env"), "utf8")).toBe(before);
    expect(readFileSync(join(bench.secrets, "dashboard.env"), "utf8")).toContain("PASSWORD_HASH=$2");
  });
});

describe("PASSWORD_HASH in a site's file: a password like the dashboard's and the portal's", () => {
  const CALENDAR_PASSWORD = "Calendar-Password-2026";

  /** calendar.env with an ordinary token and a hash. */
  async function callsWithHash(bench: Bench): Promise<string> {
    const hash = await hashFast(CALENDAR_PASSWORD);
    writeFileSync(join(bench.secrets, "calendar.env"), `TOKEN=${SECRET_TOKEN}\nPASSWORD_HASH=${hash}\n`, { mode: 0o600 });
    return hash;
  }

  test("never read back, never set or removed through /variable, and offered to Change password", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const hash = await callsWithHash(bench);
    const before = readFileSync(join(bench.secrets, "calendar.env"), "utf8");
    const target = { token, slug: "calendar", file: "calendar.env", variable: "PASSWORD_HASH" };

    const unitEnv = await bench.call("POST", "/value", target);
    expect(unitEnv.status).toBe(403);
    const text = await unitEnv.text();
    expect(text).toContain("change it with Change password");
    expect(text).not.toContain(hash);
    for (const [method, body] of [
      ["PUT", { ...target, value: "$argon2id$wrong" }],
      ["DELETE", target],
    ] as const) {
      const response = await bench.call(method, "/variable", body);
      expect(response.status).toBe(403);
      expect((await errorOf(response)).message).toBe("PASSWORD_HASH is a password hash, change it with Change password");
    }
    // A file that carries none does not get one through /variable either.
    const cms = await bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable: "PASSWORD_HASH", value: "$argon2id$wrong" });
    expect(cms.status).toBe(403);
    expect(readFileSync(join(bench.secrets, "calendar.env"), "utf8")).toBe(before);
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).toBe(CMS_ENV);

    // The neighbours stay ordinary.
    const neighbour = await bench.call("POST", "/value", { ...target, variable: "TOKEN" });
    expect(((await neighbour.json()) as ValueResponse).value).toBe(SECRET_TOKEN);
    expect(await fileSeen(bench, "calendar", "calendar.env")).toMatchObject({ state: "managed", variables: ["TOKEN", "PASSWORD_HASH"], passwords: ["PASSWORD_HASH"] });
    expect((await fileSeen(bench, "cms", "cms.env")).passwords).toEqual([]);
  });

  test("changed through /password, without keeping the old one, and never restored", async () => {
    const bench = await mount({ hashPassword: hashFast });
    const token = await unlock(bench);
    const previous = await callsWithHash(bench);
    const target = { token, slug: "calendar", file: "calendar.env" };

    // Writing a neighbour keeps a previous version, which carries the
    // hash of the moment: the page does not offer it.
    expect((await bench.call("PUT", "/variable", { ...target, variable: "TOKEN", value: "newer" })).status).toBe(200);
    expect(readFileSync(join(bench.state, "precedents", "calendar.env"), "utf8")).toContain(previous);
    expect((await fileSeen(bench, "calendar", "calendar.env")).previous).toBe(false);

    const change = await bench.call("POST", "/password", { ...target, variable: "PASSWORD_HASH", dashboardPassword: PASSWORD, newPassword: null });
    expect(change.status).toBe(200);
    const { password, file } = (await change.json()) as PasswordResponse;
    expect(file).toMatchObject({ variables: ["TOKEN", "PASSWORD_HASH"], passwords: ["PASSWORD_HASH"], previous: false });
    const fresh = hashOfFile(bench, "calendar.env");
    expect(await Bun.password.verify(password!, fresh)).toBe(true);
    expect(await Bun.password.verify(CALENDAR_PASSWORD, fresh)).toBe(false);
    expect(readFileSync(join(bench.secrets, "calendar.env"), "utf8")).toContain("TOKEN=newer\n");
    // The previous version that carried the old one went with it.
    expect(existsSync(join(bench.state, "precedents", "calendar.env"))).toBe(false);

    // A write after the change keeps a previous version, which still cannot be restored.
    expect((await bench.call("PUT", "/variable", { ...target, variable: "TOKEN", value: "encore" })).status).toBe(200);
    const restore = await bench.call("POST", "/restore", target);
    expect(restore.status).toBe(403);
    expect((await errorOf(restore)).message).toBe("a password is only changed with Change password");
    expect(readFileSync(join(bench.secrets, "calendar.env"), "utf8")).toContain("TOKEN=encore\n");
    expect(hashOfFile(bench, "calendar.env")).toBe(fresh);
  });
});

describe("restoring never gives back a hash that Change password replaced", () => {
  test("after Change password, /restore is refused and the portal's old password does not come back", async () => {
    const bench = await mount({ hashPassword: hashFast });
    const token = await unlock(bench);
    const newPassword = "portal-after-the-leak-2026-09";
    const target = { token, slug: "portal", file: "portal.env" };
    const change = await bench.call("POST", "/password", { ...target, variable: "PASSWORD_HASH", dashboardPassword: PASSWORD, newPassword });
    expect(change.status).toBe(200);
    expect(((await change.json()) as PasswordResponse).file.previous).toBe(false);
    const after = readFileSync(join(bench.secrets, "portal.env"), "utf8");

    // A token was all it took to make the old one valid again.
    const restore = await bench.call("POST", "/restore", target);
    expect(restore.status).toBe(403);
    expect(await errorOf(restore)).toEqual({ error: "out-of-scope", message: "a password is only changed with Change password" });
    expect(readFileSync(join(bench.secrets, "portal.env"), "utf8")).toBe(after);
    const hash = hashOfFile(bench, "portal.env");
    expect(await Bun.password.verify(newPassword, hash)).toBe(true);
    expect(await Bun.password.verify(PORTAL_PASSWORD, hash)).toBe(false);
    expect(log(bench).at(-1)).toMatchObject({ operation: "restore", result: "rejects", slug: "portal", file: "portal.env", detail: "out-of-scope" });
  });

  test("the dashboard and the portal: a previous version that exists is neither offered nor restored", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    mkdirSync(join(bench.state, "precedents"), { recursive: true });
    for (const [slug, file] of [["dashboard", "dashboard.env"], ["portal", "portal.env"]] as const) {
      const before = readFileSync(join(bench.secrets, file), "utf8");
      writeFileSync(join(bench.state, "precedents", file), "PASSWORD_HASH=$2b$04$older\n", { mode: 0o600 });
      expect((await fileSeen(bench, slug, file)).previous).toBe(false);
      expect((await bench.call("POST", "/restore", { token, slug, file })).status).toBe(403);
      expect(readFileSync(join(bench.secrets, file), "utf8")).toBe(before);
    }
  });

  test("a previous version carrying a hash cannot be restored, even when the current file no longer carries one", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    mkdirSync(join(bench.state, "precedents"), { recursive: true });
    writeFileSync(join(bench.state, "precedents", "cms.env"), "PASSWORD_HASH=$2b$04$older\nTOKEN=x\n", { mode: 0o600 });
    expect((await fileSeen(bench, "cms", "cms.env")).previous).toBe(false);
    expect((await bench.call("POST", "/restore", { token, slug: "cms", file: "cms.env" })).status).toBe(403);
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).toBe(CMS_ENV);

    // With no hash on either side, restoring is still offered.
    writeFileSync(join(bench.state, "precedents", "cms.env"), "TOKEN=x\n", { mode: 0o600 });
    expect((await fileSeen(bench, "cms", "cms.env")).previous).toBe(true);
    expect((await bench.call("POST", "/restore", { token, slug: "cms", file: "cms.env" })).status).toBe(200);
  });

  test("a current file carrying a hash cannot be restored, even to a version that carried none", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const current = `TOKEN=y\nPASSWORD_HASH=${await hashFast("Calendar-Password-2026")}\n`;
    writeFileSync(join(bench.secrets, "calendar.env"), current, { mode: 0o600 });
    mkdirSync(join(bench.state, "precedents"), { recursive: true });
    // Restoring would remove the hash: the service would ask for nothing any more.
    writeFileSync(join(bench.state, "precedents", "calendar.env"), "TOKEN=x\n", { mode: 0o600 });
    expect((await fileSeen(bench, "calendar", "calendar.env")).previous).toBe(false);
    const response = await bench.call("POST", "/restore", { token, slug: "calendar", file: "calendar.env" });
    expect(response.status).toBe(403);
    expect(readFileSync(join(bench.secrets, "calendar.env"), "utf8")).toBe(current);
  });

  test("the dashboard and the portal are never restored, not even with no hash, nor when unmanaged", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    mkdirSync(join(bench.state, "precedents"), { recursive: true });
    // An empty portal.env, a previous version with no hash either: the rule holds by the file.
    writeFileSync(join(bench.secrets, "portal.env"), "# empty\n", { mode: 0o600 });
    writeFileSync(join(bench.state, "precedents", "portal.env"), "# old\n", { mode: 0o600 });
    expect((await fileSeen(bench, "portal", "portal.env")).previous).toBe(false);
    expect((await bench.call("POST", "/restore", { token, slug: "portal", file: "portal.env" })).status).toBe(403);
    expect(readFileSync(join(bench.secrets, "portal.env"), "utf8")).toBe("# empty\n");
    // Unmanaged, the refusal comes before it is even read.
    chmodSync(join(bench.secrets, "dashboard.env"), 0o644);
    writeFileSync(join(bench.state, "precedents", "dashboard.env"), "# old\n", { mode: 0o600 });
    const refusal = await bench.call("POST", "/restore", { token, slug: "dashboard", file: "dashboard.env" });
    expect(refusal.status).toBe(403);
    expect((await errorOf(refusal)).message).toBe("a password is only changed with Change password");
  });

  test("/password removes the previous version before writing, and writes nothing if it cannot remove it", async () => {
    const order: string[] = [];
    let real!: System;
    const removal = { broken: false };
    const bench = await mount({
      hashPassword: hashFast,
      overrides: {
        removePrevious: async (name) => {
          order.push("remove previous");
          if (removal.broken) throw Object.assign(new Error("EIO"), { code: "EIO" });
          return real.removePrevious(name);
        },
        writePrevious: async (name, bytes, owner) => {
          order.push("previous");
          return real.writePrevious(name, bytes, owner);
        },
        writeSecret: async (name, bytes, permissions) => {
          order.push("secret");
          return real.writeSecret(name, bytes, permissions);
        },
      },
    });
    real = createSystem(bench.config);
    const token = await unlock(bench);
    const requested = { token, slug: "portal", file: "portal.env", variable: "PASSWORD_HASH", dashboardPassword: PASSWORD, newPassword: null };

    expect((await bench.call("POST", "/password", requested)).status).toBe(200);
    expect(order).toEqual(["remove previous", "secret"]);

    order.length = 0;
    removal.broken = true;
    const before = readFileSync(join(bench.secrets, "portal.env"), "utf8");
    expect((await bench.call("POST", "/password", requested)).status).toBe(500);
    expect(order).toEqual(["remove previous"]);
    expect(readFileSync(join(bench.secrets, "portal.env"), "utf8")).toBe(before);
  });
});

describe("POST /password", () => {
  const requested = (token: string, others: Record<string, unknown> = {}) => ({
    token,
    slug: "portal",
    file: "portal.env",
    variable: "PASSWORD_HASH",
    dashboardPassword: PASSWORD,
    newPassword: null,
    ...others,
  });

  function hashOf(bench: Bench, file: string): string {
    return /^PASSWORD_HASH='?([^'\n]+)'?$/m.exec(readFileSync(join(bench.secrets, file), "utf8"))![1]!;
  }

  test("draws, writes the hash, and returns the password once only, verifiable against the hash written", async () => {
    const bench = await mount({ hashPassword: hashFast });
    const token = await unlock(bench);
    const before = readFileSync(join(bench.secrets, "portal.env"), "utf8");
    const response = await bench.call("POST", "/password", requested(token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as PasswordResponse;
    expect(body.password).toMatch(/^([A-Za-z2-9]{4}-){5}[A-Za-z2-9]{4}$/);
    expect(body.file).toMatchObject({ name: "portal.env", state: "managed", variables: ["PASSWORD_HASH"], passwords: ["PASSWORD_HASH"], previous: false });
    expect(JSON.stringify(body.file)).not.toContain("$2b$");

    const hash = hashOf(bench, "portal.env");
    expect(await Bun.password.verify(body.password!, hash)).toBe(true);
    expect(await Bun.password.verify(PORTAL_PASSWORD, hash)).toBe(false);
    // The old hash is kept nowhere.
    expect(readFileSync(join(bench.secrets, "portal.env"), "utf8")).not.toBe(before);
    expect(existsSync(join(bench.state, "precedents", "portal.env"))).toBe(false);

    expect(log(bench).at(-1)).toEqual({
      a: bench.clock.t,
      operation: "password",
      result: "ok",
      slug: "portal",
      file: "portal.env",
      variable: "PASSWORD_HASH",
      detail: null,
    });
    const raw = readFileSync(join(bench.state, "journal.jsonl"), "utf8");
    for (const forbidden of [body.password!, hash, PASSWORD]) expect(raw).not.toContain(forbidden);
  });

  test("argon2id by default, like scripts/fingerprint.ts", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const response = await bench.call("POST", "/password", requested(token, { newPassword: "a-chosen-password-long-enough" }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as PasswordResponse).password).toBeNull();
    const hash = hashOf(bench, "portal.env");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await Bun.password.verify("a-chosen-password-long-enough", hash)).toBe(true);
  });

  test("the dashboard: the next unlock takes the new hash at once", async () => {
    const bench = await mount({ hashPassword: hashFast });
    const token = await unlock(bench);
    const newPassword = "dashboard-new-password-2026";
    const response = await bench.call("POST", "/password", requested(token, { slug: "dashboard", file: "dashboard.env", newPassword }));
    expect(response.status).toBe(200);
    // The token in force stays valid: changing the password does not lock.
    expect((await bench.call("POST", "/value", { token, slug: "cms", file: "cms.env", variable: "TOKEN" })).status).toBe(200);
    expect((await bench.call("POST", "/unlock", { password: PASSWORD })).status).toBe(401);
    expect((await bench.call("POST", "/unlock", { password: newPassword })).status).toBe(200);
  });

  test("a wrong dashboard password is refused and counts towards the shared rate limiting", async () => {
    const { account, check } = countedVerification();
    const bench = await mount({ check, hashPassword: hashFast });
    const token = await unlock(bench);
    const before = readFileSync(join(bench.secrets, "portal.env"), "utf8");
    const totalBefore = account.total;

    for (let i = 0; i <= TOLERATED_FAILURES; i++) {
      const refuse = await bench.call("POST", "/password", requested(token, { dashboardPassword: `wrong password ${i}` }));
      expect(refuse.status).toBe(401);
      expect((await errorOf(refuse)).error).toBe("refused");
    }
    expect(account.total - totalBefore).toBe(TOLERATED_FAILURES + 1);
    expect(JSON.parse(readFileSync(join(bench.state, "rate-limit.json"), "utf8")).failures).toBe(TOLERATED_FAILURES + 1);

    // The same rate limiting as the unlock, in both directions.
    expect((await bench.call("POST", "/password", requested(token))).status).toBe(429);
    expect((await bench.call("POST", "/unlock", { password: PASSWORD })).status).toBe(429);
    expect(readFileSync(join(bench.secrets, "portal.env"), "utf8")).toBe(before);
    expect(log(bench).filter((e) => e.operation === "password").every((e) => e.result === "rejects" && e.detail === "wrong password")).toBe(true);

    bench.clock.t += INITIAL_BACKOFF_MS;
    expect((await bench.call("POST", "/password", requested(token))).status).toBe(200);
    expect(JSON.parse(readFileSync(join(bench.state, "rate-limit.json"), "utf8"))).toEqual({ failures: 0, lastFailureAt: 0 });
  });

  test("the refused shapes cost no verification and do not count", async () => {
    const { account, check } = countedVerification();
    const bench = await mount({ check, hashPassword: hashFast });
    const token = await unlock(bench);
    const totalBefore = account.total;
    const cas: [Record<string, unknown>, number][] = [
      [{ newPassword: "too-short" }, 400],
      [{ newPassword: "x".repeat(257) }, 400],
      [{ newPassword: `${"x".repeat(20)}${charOf(0xd800)}` }, 400],
      [{ newPassword: 42 }, 400],
      [{ dashboardPassword: "" }, 400],
      [{ dashboardPassword: "x".repeat(257) }, 400],
      [{ variable: "OTHER" }, 403],
      [{ slug: "cms", file: "cms.env", variable: "TOKEN" }, 403],
      [{ slug: "cms", file: "../portal.env" }, 403],
      [{ slug: "builder", file: "builder-ssh" }, 403],
      // PASSWORD_HASH can be changed anywhere, but calendar.env does not exist.
      [{ slug: "calendar", file: "calendar.env" }, 404],
    ];
    for (const [others, status] of cas) {
      const response = await bench.call("POST", "/password", requested(token, others));
      expect(response.status).toBe(status);
    }
    expect(account.total).toBe(totalBefore);
    expect(existsSync(join(bench.state, "rate-limit.json")) ? JSON.parse(readFileSync(join(bench.state, "rate-limit.json"), "utf8")).failures : 0).toBe(0);
  });

  test("a missing or unmanaged file: refused before any verification", async () => {
    const { account, check } = countedVerification();
    const bench = await mount({ check, hashPassword: hashFast });
    const token = await unlock(bench);
    const totalBefore = account.total;
    chmodSync(join(bench.secrets, "portal.env"), 0o644);
    expect((await bench.call("POST", "/password", requested(token))).status).toBe(409);
    rmSync(join(bench.secrets, "portal.env"));
    expect((await bench.call("POST", "/password", requested(token))).status).toBe(404);
    expect(account.total).toBe(totalBefore);
  });

  test("a hash that does not verify its password is never written", async () => {
    const bench = await mount({ hashPassword: async () => "$argon2id$v=19$m=65536,t=2,p=1$damaged$damaged" });
    const token = await unlock(bench);
    const before = readFileSync(join(bench.secrets, "portal.env"), "utf8");
    const response = await bench.call("POST", "/password", requested(token));
    expect(response.status).toBe(500);
    expect(readFileSync(join(bench.secrets, "portal.env"), "utf8")).toBe(before);
    expect(log(bench).at(-1)).toMatchObject({ operation: "password", result: "failure" });
  });

  test("verifications and hashes go one at a time, unlocks included", async () => {
    const account = { current: 0, max: 0 };
    const count = async <T>(task: () => Promise<T>): Promise<T> => {
      account.current++;
      account.max = Math.max(account.max, account.current);
      try {
        await Bun.sleep(5);
        return await task();
      } finally {
        account.current--;
      }
    };
    const bench = await mount({
      check: (submitted, hash) => count(async () => hash !== "" && Bun.password.verify(submitted, hash)),
      hashPassword: (password) => count(() => hashFast(password)),
    });
    const token = await unlock(bench);
    const responses = await Promise.all([
      bench.call("POST", "/password", requested(token, { newPassword: "premier-mot-de-passe-du-portal" })),
      bench.call("POST", "/unlock", { password: PASSWORD }),
      bench.call("POST", "/password", requested(token, { newPassword: "second-mot-de-passe-du-portal" })),
    ]);
    expect(account.max).toBe(1);
    // The concurrent unlock replaces the token: whatever comes after it is locked.
    expect(responses.every((response) => [200, 401].includes(response.status))).toBe(true);
  });
});

describe("POST /portal", () => {
  const writeResult = (bench: Bench, slug: string, object: Record<string, unknown>) =>
    writeFileSync(join(bench.gatekeeper, `${slug}.json`), `${JSON.stringify(object)}\n`, { mode: 0o644 });

  /** A gatekeeper that does what it says: it sets the portal in the manifest and the block, then writes its result. */
  function gatekeeperThatSucceeds(bench: Bench): Gatekeeper {
    return (unit) => {
      const [, direction, slug] = /^sitesolide-gatekeeper-(on|off)@(.+)\.service$/.exec(unit)!;
      const path = join(bench.sites, slug!, "sitesolide.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...manifest, portal: direction === "on" }));
      writeFileSync(join(bench.caddy, `${slug}.caddy`), direction === "on" ? "forward_auth @portal_guard 127.0.0.1:3026 {\n}\n" : "reverse_proxy 127.0.0.1:3048\n");
      writeResult(bench, slug!, { a: bench.clock.t, result: "ok", message: `portal ${direction}, caddy reloaded, checked`, requested: direction === "on", installed: direction === "on" });
      return 0;
    };
  }

  test("setting it: the gatekeeper is started, and the answer carries the portal read back", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    bench.simulatedGatekeeper.current = gatekeeperThatSucceeds(bench);
    const response = await bench.call("POST", "/portal", { token, slug: "cms", active: true, confirmation: "" });
    expect(response.status).toBe(200);
    expect((await response.json()) as PortalResponse).toEqual({
      portal: { requested: true, installed: true, modifiable: true, reason: null },
      detail: "portal on, caddy reloaded, checked",
    });
    expect(bench.systemctlCalls.filter((call) => call[0] === "start")).toEqual([["start", "sitesolide-gatekeeper-on@cms.service"]]);
    expect(log(bench).at(-1)).toMatchObject({ operation: "portal", result: "ok", slug: "cms", file: null, detail: "on, ok" });
  });

  test("removing requires the site's name retyped: without it, 400 and nothing is started", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    bench.simulatedGatekeeper.current = gatekeeperThatSucceeds(bench);
    for (const confirmation of ["", "CMS", "cms ", "calendar"]) {
      const response = await bench.call("POST", "/portal", { token, slug: "cms", active: false, confirmation });
      expect(response.status).toBe(400);
      expect((await errorOf(response)).message).toContain("type cms to confirm");
    }
    expect(bench.systemctlCalls.filter((call) => call[0] === "start")).toEqual([]);

    const confirmed = await bench.call("POST", "/portal", { token, slug: "cms", active: false, confirmation: "cms" });
    expect(confirmed.status).toBe(200);
    expect(bench.systemctlCalls.filter((call) => call[0] === "start")).toEqual([["start", "sitesolide-gatekeeper-off@cms.service"]]);
    expect(log(bench).at(-1)).toMatchObject({ detail: "off, ok" });
  });

  test("not changeable, unknown or malformed: refused without starting the gatekeeper", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const cas: [Record<string, unknown>, number, string][] = [
      [{ slug: "portal", active: true, confirmation: "" }, 403, "itself"],
      [{ slug: "dashboard", active: true, confirmation: "" }, 403, "dashboard"],
      [{ slug: "test-zone.invalid", active: false, confirmation: "test-zone.invalid" }, 403, "sitesolide.json"],
      [{ slug: "unknown", active: true, confirmation: "" }, 403, "not a site"],
      [{ slug: "../cms", active: true, confirmation: "" }, 403, "not a site"],
      [{ slug: "cms", active: "yes", confirmation: "" }, 400, "boolean"],
      [{ slug: "cms", active: true }, 400, "confirmation"],
    ];
    for (const [others, status, message] of cas) {
      const response = await bench.call("POST", "/portal", { token, ...others });
      expect(response.status).toBe(status);
      expect((await errorOf(response)).message).toContain(message);
    }
    // An invalid manifest on the machine: the gatekeeper would not rewrite it.
    writeFileSync(join(bench.sites, "calendar", "sitesolide.json"), JSON.stringify({ slug: "calendar", start: "x", unknown: 1 }));
    expect((await bench.call("POST", "/portal", { token, slug: "calendar", active: true, confirmation: "" })).status).toBe(403);
    expect(bench.systemctlCalls.filter((call) => call[0] === "start")).toEqual([]);
  });

  test("refusal from the gatekeeper: 409 with its message", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    bench.simulatedGatekeeper.current = () => {
      writeResult(bench, "cms", { a: bench.clock.t, result: "rejects", message: "caddy validate rejected the new block", requested: false, installed: false });
      return 1;
    };
    const response = await bench.call("POST", "/portal", { token, slug: "cms", active: true, confirmation: "" });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toEqual({ error: "unmanaged", message: "caddy validate rejected the new block" });
    expect(log(bench).at(-1)).toMatchObject({ operation: "portal", result: "rejects", detail: "on, rejects" });
  });

  test("failure of the gatekeeper: 500 with its message", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    bench.simulatedGatekeeper.current = () => {
      writeResult(bench, "cms", { a: bench.clock.t, result: "failure", message: "the site did not answer, previous block restored", requested: false, installed: false });
      return 0;
    };
    const response = await bench.call("POST", "/portal", { token, slug: "cms", active: true, confirmation: "" });
    expect(response.status).toBe(500);
    expect((await errorOf(response)).message).toBe("the site did not answer, previous block restored");
  });

  test("stale, missing or unreadable: failure, even if systemctl returns 0", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const essayer = async () => {
      const response = await bench.call("POST", "/portal", { token, slug: "cms", active: true, confirmation: "" });
      expect(response.status).toBe(500);
      return (await errorOf(response)).message;
    };

    // A result from an earlier action, left behind in the directory.
    writeResult(bench, "cms", { a: bench.clock.t - 60_000, result: "ok", message: "old", requested: true, installed: true });
    bench.simulatedGatekeeper.current = () => 0;
    expect(await essayer()).toContain("no fresh result");

    rmSync(join(bench.gatekeeper, "cms.json"));
    expect(await essayer()).toContain("no result");

    bench.simulatedGatekeeper.current = () => {
      writeFileSync(join(bench.gatekeeper, "cms.json"), "{truncated");
      return 0;
    };
    expect(await essayer()).toContain("unreadable");

    bench.simulatedGatekeeper.current = () => {
      rmSync(join(bench.gatekeeper, "cms.json"), { force: true });
      symlinkSync(join(bench.root, "passwd"), join(bench.gatekeeper, "cms.json"));
      return 0;
    };
    expect(await essayer()).toContain("not a plain file");
    expect(log(bench).filter((e) => e.operation === "portal").every((e) => e.result === "failure")).toBe(true);
  });

  test("a backup left by an interrupted gatekeeper: the site can no longer be changed, and nothing is started", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    bench.simulatedGatekeeper.current = gatekeeperThatSucceeds(bench);
    // The block read says there is no portal, but the gatekeeper stopped halfway.
    writeFileSync(join(bench.caddy, "cms.caddy"), "reverse_proxy 127.0.0.1:3048\n");
    mkdirSync(join(bench.gatekeeper, "sauvegardes", "cms"), { recursive: true });
    writeFileSync(join(bench.gatekeeper, "sauvegardes", "cms", "cms.caddy"), "reverse_proxy 127.0.0.1:3048\n");

    const portals = Object.fromEntries((await projects(bench)).map((project) => [project.slug, project.portal]));
    expect(portals.cms).toEqual({
      requested: false,
      installed: false,
      modifiable: false,
      reason: "an interrupted portal change left this site in an unknown state: check Caddy on the server",
    });
    // The other sites are blocked too: the gatekeeper refuses every action, on
    // every site, as long as a backup remains, and the page has to say so
    // everywhere.
    expect(portals.calendar).toEqual({
      requested: false,
      installed: false,
      modifiable: false,
      reason: "an interrupted portal change on cms blocks portal changes on every site: check Caddy on the server",
    });

    const response = await bench.call("POST", "/portal", { token, slug: "cms", active: true, confirmation: "" });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).message).toContain("an interrupted portal change");
    expect(bench.systemctlCalls.filter((call) => call[0] === "start")).toEqual([]);

    // A link in place of the directory counts too: when in doubt, nothing moves.
    rmSync(join(bench.gatekeeper, "sauvegardes", "cms"), { recursive: true });
    symlinkSync(bench.root, join(bench.gatekeeper, "sauvegardes", "cms"));
    expect((await projects(bench)).find((project) => project.slug === "cms")!.portal.modifiable).toBe(false);

    // Once the backup is gone, the site can be changed again.
    rmSync(join(bench.gatekeeper, "sauvegardes"), { recursive: true });
    expect((await projects(bench)).find((project) => project.slug === "cms")!.portal).toEqual({ requested: false, installed: false, modifiable: true, reason: null });
  });

  test("a backup that cannot be examined: nothing can be changed, and the reason claims nothing", async () => {
    const bench = await mount({
      overrides: {
        gatekeeperBackup: async (slug) => {
          if (slug === "cms") throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          return false;
        },
      },
    });
    const portals = Object.fromEntries((await projects(bench)).map((project) => [project.slug, project.portal]));
    expect(portals.cms).toMatchObject({ modifiable: false, reason: "the gatekeeper's state could not be checked on the server" });
    expect(portals.calendar).toMatchObject({ modifiable: true, reason: null });
  });

  test("while the steward waits on the gatekeeper, its backup is not reported as interrupted", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let bench!: Bench;
    const backup = () => join(bench.gatekeeper, "sauvegardes", "cms");
    bench = await mount({
      overrides: {
        systemctl: async (arguments_) => {
          if (arguments_[0] !== "start") return { code: 1, output: "" };
          mkdirSync(backup(), { recursive: true });
          await barrier;
          rmSync(join(bench.gatekeeper, "sauvegardes"), { recursive: true });
          writeResult(bench, "cms", { a: bench.clock.t, result: "ok", message: "done", requested: true, installed: true });
          return { code: 0, output: "" };
        },
      },
    });
    const token = await unlock(bench);
    const portal = bench.call("POST", "/portal", { token, slug: "cms", active: true, confirmation: "" });
    await settle();
    expect(existsSync(backup())).toBe(true);
    expect((await projects(bench)).find((project) => project.slug === "cms")!.portal).toMatchObject({
      modifiable: false,
      reason: "a portal change is in progress for this site",
    });
    release();
    expect((await portal).status).toBe(200);
    expect((await projects(bench)).find((project) => project.slug === "cms")!.portal.reason).toBeNull();
  });

  test("a requester gone while the site is read again: the gatekeeper is not started", async () => {
    const abandon = new AbortController();
    const bench = await mount({
      overrides: {
        // Reading the block again is the last read before the start.
        readFragment: async () => {
          abandon.abort();
          return null;
        },
      },
    });
    const token = await unlock(bench);
    bench.simulatedGatekeeper.current = gatekeeperThatSucceeds(bench);
    const response = await bench.call("POST", "/portal", { token, slug: "cms", active: true, confirmation: "" }, { signal: abandon.signal });
    expect(response.status).toBe(500);
    expect((await errorOf(response)).message).toBe("request abandoned");
    expect(bench.systemctlCalls.filter((call) => call[0] === "start")).toEqual([]);
    expect(JSON.parse(readFileSync(join(bench.sites, "cms", "sitesolide.json"), "utf8")).portal).toBeUndefined();
  });

  test("Caddy being changed from the workstation: the gatekeeper's refusal comes back as a readable 409", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const message = "Caddy is being changed from the workstation (deploy-caddy, since 14:32:05): try again in a moment";
    const lancees: string[] = [];
    bench.simulatedGatekeeper.current = (unit) => {
      lancees.push(unit);
      writeResult(bench, "cms", { a: bench.clock.t, result: "rejects", message, requested: false, installed: false });
      return 1;
    };
    const response = await bench.call("POST", "/portal", { token, slug: "cms", active: true, confirmation: "" });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toEqual({ error: "unmanaged", message });
    expect(lancees).toEqual(["sitesolide-gatekeeper-on@cms.service"]);
    // Nothing moved: the site stays changeable, to retry a moment later.
    expect((await projects(bench)).find((project) => project.slug === "cms")!.portal).toEqual({ requested: false, installed: false, modifiable: true, reason: null });
    expect(log(bench).at(-1)).toMatchObject({ operation: "portal", result: "rejects", slug: "cms", detail: "on, rejects" });
  });

  test("the gatekeeper goes under the lock: a write waits until it has finished", async () => {
    const order: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let real!: System;
    let bench!: Bench;
    bench = await mount({
      overrides: {
        systemctl: async (arguments_) => {
          if (arguments_[0] !== "start") return { code: 1, output: "" };
          order.push("gatekeeper");
          await barrier;
          writeResult(bench, "cms", { a: bench.clock.t, result: "ok", message: "done", requested: true, installed: true });
          order.push("gatekeeper done");
          return { code: 0, output: "" };
        },
        writeSecret: async (name, bytes, permissions) => {
          order.push("write");
          return real.writeSecret(name, bytes, permissions);
        },
      },
    });
    real = createSystem(bench.config);
    const token = await unlock(bench);
    const portal = bench.call("POST", "/portal", { token, slug: "cms", active: true, confirmation: "" });
    const set = bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable: "A", value: "1" });
    await settle();
    release();
    expect((await portal).status).toBe(200);
    expect((await set).status).toBe(200);
    expect(order).toEqual(["gatekeeper", "gatekeeper done", "write"]);
  });
});

describe("GET /log", () => {
  test("with no slug, everything; with one, that site alone; a name that is not a site, 400", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    await bench.call("POST", "/value", { token, slug: "cms", file: "cms.env", variable: "TOKEN" });
    await bench.call("POST", "/content", { token, slug: "builder", file: "builder-ssh.pub" });
    await bench.call("POST", "/file", { token, slug: "test-zone.invalid", file: "landing-mail.env" });

    const whole = (await (await bench.call("GET", "/log")).json()) as LogResponse;
    expect(whole.entries.map((e) => e.slug)).toEqual(["test-zone.invalid", "builder", "cms", null]);

    const builder = (await (await bench.call("GET", "/log?slug=builder")).json()) as LogResponse;
    expect(builder.entries.map((e) => [e.slug, e.file])).toEqual([["builder", "builder-ssh.pub"]]);
    const landing = (await (await bench.call("GET", "/log?slug=test-zone.invalid")).json()) as LogResponse;
    expect(landing.entries.map((e) => e.operation)).toEqual(["create"]);
    expect(((await (await bench.call("GET", "/log?slug=showcase")).json()) as LogResponse).entries).toEqual([]);

    for (const request of ["/log?slug=", "/log?slug=..%2Fcms", "/log?slug=CMS", "/log?slug=landing", "/log?slug=cms&slug=builder"]) {
      expect((await bench.call("GET", request)).status).toBe(400);
    }
  });

  test("a line written before the operations were translated still shows, under its new name", async () => {
    const bench = await mount();
    // journal.jsonl outlives the deployment: this is the line an earlier
    // steward left on the VM, written by hand because encodeEntry refuses it.
    const before = { a: 1, operation: "pose", resultat: "ok", slug: "cms", fichier: "cms.env", variable: "TOKEN", detail: null };
    const restarted = { ...before, a: 2, operation: "redemarrage", variable: null, detail: "boucle, activating/auto-restart, 3 restarts" };
    writeFileSync(join(bench.state, "journal.jsonl"), `${JSON.stringify(before)}\n${JSON.stringify(restarted)}\n`);

    const token = await unlock(bench);
    await bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable: "TOKEN", value: "new" });

    const { entries } = (await (await bench.call("GET", "/log")).json()) as LogResponse;
    expect(entries.map((e) => [e.operation, e.detail])).toEqual([
      ["set", null],
      ["unlock", null],
      ["restart", "looping, activating/auto-restart, 3 restarts"],
      ["set", null],
    ]);
    // Read, never written: the file still carries what it carried.
    expect(readFileSync(join(bench.state, "journal.jsonl"), "utf8")).toContain('"operation":"pose"');
  });
});

describe("owners checked", () => {
  const underChecks = (others: Mount = {}) => mount({ checkAccounts: true, accounts: ACCOUNTS, uidRoot: UID, ...others });

  test("a file under the right account is managed, under another it is unmanaged", async () => {
    const bon = await underChecks();
    expect((await fileSeen(bon, "cms", "cms.env")).state).toBe("managed");
    expect((await fileSeen(bon, "dashboard", "dashboard.env")).state).toBe("managed");

    const other = await underChecks({ accounts: ACCOUNTS.replace(account("site-cms"), account("site-cms", UID + 1)) });
    const file = await fileSeen(other, "cms", "cms.env");
    expect(file.state).toBe("unmanaged");
    expect(file.reason).toContain("sudo chown site-cms:site-cms");
  });

  test("the dashboard's hash has to belong to root", async () => {
    const bench = await underChecks({ accounts: ACCOUNTS.replace(account("root"), account("root", UID + 1, 0)) });
    expect((await fileSeen(bench, "dashboard", "dashboard.env")).reason).toContain("not root: sudo chown root:root");
  });

  test("a file in another group is unmanaged, and the reason gives chgrp", async () => {
    const bench = await underChecks({ accounts: ACCOUNTS.replace(account("site-cms"), account("site-cms", UID, TEST_GID + 1)) });
    expect((await fileSeen(bench, "cms", "cms.env")).reason).toBe(
      `group gid ${TEST_GID}, not site-cms: sudo chgrp site-cms ${join(bench.secrets, "cms.env")}`,
    );
  });

  test("a missing account: file unmanaged, creation refused", async () => {
    const bench = await underChecks({ accounts: ACCOUNTS.replace(account("site-cms"), "") });
    const token = await unlock(bench);
    expect((await fileSeen(bench, "cms", "cms.env")).reason).toContain("does not exist");
    expect((await bench.call("POST", "/file", { token, slug: "cms", file: "cms-webhook.env" })).status).toBe(404);
  });

  test("creation sets the site's account, and a write carries it over", async () => {
    const bench = await underChecks();
    const token = await unlock(bench);
    expect((await bench.call("POST", "/file", { token, slug: "cms", file: "cms-webhook.env" })).status).toBe(200);
    const created = statSync(join(bench.secrets, "cms-webhook.env"));
    expect([created.uid, created.gid, created.mode & 0o777]).toEqual([UID, TEST_GID, 0o600]);

    expect((await bench.call("PUT", "/variable", { token, slug: "cms", file: "cms-webhook.env", variable: "A", value: "1" })).status).toBe(200);
    expect(statSync(join(bench.secrets, "cms-webhook.env")).uid).toBe(UID);
  });

  test("the previous version keeps the owner of the file it replaces", async () => {
    const bench = await underChecks();
    const token = await unlock(bench);
    await bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable: "TOKEN", value: "x" });
    const previous = statSync(join(bench.state, "precedents", "cms.env"));
    const current = statSync(join(bench.secrets, "cms.env"));
    expect([previous.uid, previous.gid, previous.mode & 0o777]).toEqual([current.uid, current.gid, 0o600]);
  });

  test("a previous version from another uid, that of an earlier site with the same name, is not restored", async () => {
    let real!: System;
    const bench = await underChecks({
      overrides: {
        examinePrevious: async (name) => {
          const examination = await real.examinePrevious(name);
          return examination.kind === "present" ? { ...examination, info: { ...examination.info, uid: UID + 7 } } : examination;
        },
      },
    });
    real = createSystem(bench.config);
    const token = await unlock(bench);
    const target = { token, slug: "cms", file: "cms.env" };
    await bench.call("PUT", "/variable", { ...target, variable: "TOKEN", value: "newvalue" });
    const current = readFileSync(join(bench.secrets, "cms.env"), "utf8");

    const response = await bench.call("POST", "/restore", target);
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toContain(`uid ${UID + 7}`);
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).toBe(current);
  });

  test("with checks on, a gatekeeper result owned by root passes, one writable by others does not", async () => {
    const bench = await underChecks();
    const token = await unlock(bench);
    let mode = 0o644;
    bench.simulatedGatekeeper.current = () => {
      const path = join(bench.gatekeeper, "cms.json");
      writeFileSync(path, JSON.stringify({ a: bench.clock.t, result: "ok", message: "done", requested: true, installed: true }));
      chmodSync(path, mode);
      return 0;
    };
    expect((await bench.call("POST", "/portal", { token, slug: "cms", active: true, confirmation: "" })).status).toBe(200);
    mode = 0o666;
    const refuse = await bench.call("POST", "/portal", { token, slug: "cms", active: true, confirmation: "" });
    expect(refuse.status).toBe(500);
    expect((await errorOf(refuse)).message).toContain("writable by other accounts");
  });

  test("reading the accounts and the groups", () => {
    const passwd = "root:x:0:0:root:/root:/bin/bash\nsite-cms:x:998:997::/nonexistent:/usr/sbin/nologin\ndamaged:x::\n";
    expect(readAccount(passwd, "site-cms")).toEqual({ uid: 998, gid: 997 });
    expect(readAccount(passwd, "site")).toBeNull();
    expect(readAccount(passwd, "damaged")).toBeNull();
    expect(readAccount(passwd, "absent")).toBeNull();
    const group = "root:x:0:\nsite-dashboard:x:995:\n";
    expect(readGroup(group, "site-dashboard")).toBe(995);
    expect(readGroup(group, "site-dash")).toBeNull();
  });
});

describe("POST /restart", () => {
  test("active: reset-failed, restart, then readings for eight seconds", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const response = await bench.call("POST", "/restart", { token, slug: "cms" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as RestartResponse).verdict).toEqual({ kind: "active", state: "active", subState: "running", restarts: 0 });
    expect(bench.systemctlCalls.slice(0, 2)).toEqual([
      ["reset-failed", "cms"],
      ["restart", "cms"],
    ]);
    expect(bench.systemctlCalls.filter((call) => call[0] === "show").length).toBe(17);
    expect(log(bench).at(-1)).toMatchObject({ operation: "restart", result: "ok", slug: "cms", detail: expect.stringContaining("active") });
  });

  test("the landing restarts under its unit, which reads its file", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    expect((await bench.call("POST", "/restart", { token, slug: "test-zone.invalid" })).status).toBe(200);
    expect(bench.systemctlCalls.slice(0, 2)).toEqual([
      ["reset-failed", "sitesolide-landing"],
      ["restart", "sitesolide-landing"],
    ]);
  });

  test("builder: a unit that gives the subdirectory's path through Environment= does read its secrets", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    expect((await bench.call("POST", "/restart", { token, slug: "builder" })).status).toBe(200);

    // Another site's directory, or a directory with no managed file in it, is not enough.
    writeFileSync(join(bench.units, "builder.service"), `[Service]\nEnvironment=DIR=${bench.secrets}/cms-secrets\nEnvironment=ROOT=${bench.secrets}\n`);
    const refuse = await bench.call("POST", "/restart", { token, slug: "builder" });
    expect(refuse.status).toBe(403);
    expect((await errorOf(refuse)).message).toContain("reads none of the managed files");

    // The path of a managed file, through Environment=, is enough.
    writeFileSync(join(bench.units, "builder.service"), `[Service]\nEnvironment="KEY=${bench.secrets}/builder-ssh"\n`);
    expect((await bench.call("POST", "/restart", { token, slug: "builder" })).status).toBe(200);
  });

  test("after start-limit-hit, reset-failed makes the restart possible", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    // Five starts in ten seconds: systemd refuses the sixth.
    bench.limit.reached = true;
    const { verdict } = (await (await bench.call("POST", "/restart", { token, slug: "cms" })).json()) as RestartResponse;
    expect(verdict.kind).toBe("active");
  });

  test("the readings taken after the restart are not the earlier ones", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    await bench.call("GET", "/projects");
    // The cached reading said the unit was running; after the restart it falls.
    bench.scenario.current = () => show("failed", "failed", 0, 0);
    const { verdict } = (await (await bench.call("POST", "/restart", { token, slug: "cms" })).json()) as RestartResponse;
    expect(verdict.kind).toBe("failure");
  });

  test("looping: restart returns 0, but the counter climbs", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    bench.scenario.current = (_, ms) => show("active", "running", Math.floor(ms / 2500), AN_HOUR_AGO_S);
    const { verdict } = (await (await bench.call("POST", "/restart", { token, slug: "cms" })).json()) as RestartResponse;
    expect(verdict.kind).toBe("looping");
    expect(log(bench).at(-1)).toMatchObject({ result: "failure", detail: expect.stringContaining("looping") });
  });

  test("failure: restart returns 0, but the unit falls", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    bench.scenario.current = (_, ms) => (ms < 1000 ? show("active", "running", 0, 0) : show("failed", "failed", 0, 0));
    const { verdict } = (await (await bench.call("POST", "/restart", { token, slug: "cms" })).json()) as RestartResponse;
    expect(verdict.kind).toBe("failure");
  });

  test("a unit that reads no managed file is refused, with no restart", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const response = await bench.call("POST", "/restart", { token, slug: "library" });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).message).toContain("EnvironmentFile");
    expect(bench.systemctlCalls).toEqual([]);
  });

  test("a missing unit, a static site, an unknown site are refused", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    expect((await bench.call("POST", "/restart", { token, slug: "calendar" })).status).toBe(404);
    expect((await bench.call("POST", "/restart", { token, slug: "showcase" })).status).toBe(404);
    expect((await bench.call("POST", "/restart", { token, slug: "unknown" })).status).toBe(403);
    expect(bench.systemctlCalls).toEqual([]);
  });

  test("the dashboard itself: the scheduled answer goes out first, the restart next, the verdict to the journal", async () => {
    let trigger!: () => void;
    const scheduled = new Promise<void>((resolve) => {
      trigger = resolve;
    });
    const bench = await mount({ schedule: () => scheduled });
    const token = await unlock(bench);

    const response = await bench.call("POST", "/restart", { token, slug: "dashboard" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as RestartResponse).verdict).toEqual({ kind: "scheduled", state: "active", subState: "running", restarts: 0 });
    // The answer is there: nothing has been restarted yet, and the log said nothing.
    await settle();
    expect(bench.systemctlCalls.filter((call) => call[0] !== "show")).toEqual([]);
    expect(log(bench).filter((e) => e.operation === "restart")).toEqual([]);

    // A write that arrived in the meantime waits on the reserved restart.
    const set = bench.call("PUT", "/variable", { token, slug: "cms", file: "cms.env", variable: "AFTER", value: "1" });
    await settle();
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).not.toContain("AFTER");

    trigger();
    expect((await set).status).toBe(200);
    expect(bench.systemctlCalls.filter((call) => call[0] !== "show")).toEqual([
      ["reset-failed", "dashboard"],
      ["restart", "--no-block", "dashboard"],
    ]);
    expect(log(bench).filter((e) => e.operation === "restart")).toEqual([
      expect.objectContaining({ result: "ok", slug: "dashboard", detail: expect.stringMatching(/^active, .*scheduled$/) }),
    ]);
  });
});

describe("no value outside /value and /content", () => {
  test("a refusal journals a variable name only if it exists in the file", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const target = { token, slug: "cms", file: "cms.env" };

    // A token pasted into the name field: it has the shape of a name.
    await bench.call("POST", "/value", { ...target, variable: SECRET_ALNUM });
    await bench.call("DELETE", "/variable", { ...target, variable: SECRET_ALNUM });
    await bench.call("PUT", "/variable", { ...target, variable: SECRET_ALNUM, value: "a\nb" });
    // A name that exists, refused for its value: that one may appear in it.
    await bench.call("PUT", "/variable", { ...target, variable: "TOKEN", value: "a\nb" });

    const refusal = log(bench).filter((e) => e.result === "rejects");
    expect(refusal.map((e) => e.variable)).toEqual([null, null, null, "TOKEN"]);
  });

  test("neither in the journal, nor in any other answer", async () => {
    const bench = await mount({ hashPassword: hashFast });
    const token = await unlock(bench);
    const target = { token, slug: "cms", file: "cms.env" };
    const NEW_VALUE = "new-portal-password-SECRET";

    await bench.call("POST", "/unlock", { password: "wrong" });
    await bench.call("POST", "/value", { ...target, variable: "TOKEN" });
    await bench.call("PUT", "/variable", { ...target, variable: "NEWONE", value: SECRET_SET });
    await bench.call("PUT", "/variable", { ...target, variable: "ALNUM", value: SECRET_ALNUM });
    await bench.call("PUT", "/variable", { ...target, variable: "PORT", value: SECRET_SET });
    await bench.call("PUT", "/variable", { ...target, variable: SECRET_TOKEN, value: SECRET_SET });
    await bench.call("POST", "/value", { ...target, variable: SECRET_ALNUM });
    await bench.call("DELETE", "/variable", { ...target, variable: SECRET_ALNUM });
    await bench.call("PUT", "/variable", { ...target, variable: SECRET_ALNUM, value: `${SECRET_SET}\n` });
    await bench.call("PUT", "/variable", { ...target, variable: "TOKEN", value: `${SECRET_SET}\n` });
    await bench.call("DELETE", "/variable", { ...target, variable: "SID" });
    await bench.call("POST", "/restore", target);
    await bench.call("POST", "/file", { token, slug: "cms", file: "cms-webhook.env" });
    await bench.call("PUT", "/content", { token, slug: "builder", file: "builder-secrets/registry", content: "reg-REPLACEMENT-SECRET\n" });
    await bench.call("POST", "/password", {
      token,
      slug: "portal",
      file: "portal.env",
      variable: "PASSWORD_HASH",
      dashboardPassword: PASSWORD,
      newPassword: NEW_VALUE,
    });
    await bench.call("POST", "/password", {
      token,
      slug: "portal",
      file: "portal.env",
      variable: "PASSWORD_HASH",
      dashboardPassword: "wrong-dashboard-password",
      newPassword: null,
    });
    await bench.call("POST", "/restart", { token, slug: "cms" });
    await bench.call("GET", "/projects");
    await bench.call("GET", "/log");
    await bench.call("POST", "/lock", { token });

    const forbiddenValues = [
      SECRET_TOKEN,
      SECRET_SID,
      SECRET_SET,
      SECRET_ALNUM,
      "VALUE",
      PASSWORD,
      PORTAL_PASSWORD,
      NEW_VALUE,
      "wrong-password",
      "PRIVATE KEY",
      "REPLACEMENT",
      "PROFILE",
      token,
      "$2b$",
      hashOfFile(bench, "portal.env"),
    ];
    const rawLog = readFileSync(join(bench.state, "journal.jsonl"), "utf8");
    const rawRateLimit = readFileSync(join(bench.state, "rate-limit.json"), "utf8");
    for (const forbidden of forbiddenValues) {
      expect(rawLog).not.toContain(forbidden);
      expect(rawRateLimit).not.toContain(forbidden);
      for (const text of bench.renderedTexts.filter((t) => !t.includes('"token"'))) {
        expect(text).not.toContain(forbidden);
      }
    }

    const { entries } = (await (await bench.call("GET", "/log")).json()) as LogResponse;
    expect(entries[0]!.operation).toBe("lock");
    expect(entries.map((e) => e.operation)).toContain("read");
    expect(entries.map((e) => e.operation)).toContain("password");
    expect(entries.map((e) => e.operation)).toContain("replace");
    expect(entries.every((e) => e.variable === null || /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.variable))).toBe(true);
  });
});

function hashOfFile(bench: Bench, file: string): string {
  return /^PASSWORD_HASH='?([^'\n]+)'?$/m.exec(readFileSync(join(bench.secrets, file), "utf8"))![1]!;
}

describe("the real system", () => {
  function systemOn(root: string): System {
    return createSystem({
      sitesDir: join(root, "sites"),
      secretsFolder: join(root, "secrets"),
      unitsFolder: join(root, "units"),
      stateFolder: join(root, "state"),
      hashFile: join(root, "secrets", "dashboard.env"),
      accountsFile: join(root, "passwd"),
      caddyFolder: join(root, "caddy"),
      gatekeeperFolder: join(root, "gatekeeper"),
      systemctl: "false",
    });
  }

  function throwawayRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "system-"));
    toClean.push(root);
    return root;
  }

  test("the journal drops to 500 lines when it goes past 1000", async () => {
    const root = throwawayRoot();
    mkdirSync(join(root, "state"));
    writeFileSync(join(root, "state", "journal.jsonl"), Array.from({ length: 1000 }, (_, i) => `line ${i}\n`).join(""));

    const system = systemOn(root);
    await system.appendLog("last\n");
    const lines = readFileSync(join(root, "state", "journal.jsonl"), "utf8").split("\n").filter((l) => l !== "");
    expect(lines.length).toBe(500);
    expect(lines.at(-1)).toBe("last");
    expect(statSync(join(root, "state", "journal.jsonl")).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, "state")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("a named pipe in place of a secret is never opened", async () => {
    const root = throwawayRoot();
    mkdirSync(join(root, "secrets"));
    expect(Bun.spawnSync(["mkfifo", join(root, "secrets", "cms.env")]).exitCode).toBe(0);
    const examination = await systemOn(root).examineSecret("cms.env");
    expect(examination.kind === "present" && [examination.info.regular, examination.bytes]).toEqual([false, null]);
  });

  test("creating never replaces a file that exists, and the second lock refuses a name that leaves", async () => {
    const root = throwawayRoot();
    mkdirSync(join(root, "secrets"));
    writeFileSync(join(root, "secrets", "cms.env"), "A=1\n");

    const system = systemOn(root);
    const permissions = { owner: null, mode: 0o600 };
    expect(await system.createEmptySecret("cms.env", permissions)).toBe(false);
    expect(readFileSync(join(root, "secrets", "cms.env"), "utf8")).toBe("A=1\n");
    expect(readdirSync(join(root, "secrets"))).toEqual(["cms.env"]);

    await expect(system.writeSecret("../evade.env", new Uint8Array(0), permissions)).rejects.toThrow();
    await expect(system.writeSecret("a/b/c", new Uint8Array(0), permissions)).rejects.toThrow();
    await expect(system.examineSecret(".cache.env")).rejects.toThrow();
    await expect(system.examineSecret("builder-secrets/.cache")).rejects.toThrow();
    await expect(system.readFragment("../secrets/cms")).rejects.toThrow();
    await expect(system.readGatekeeperResult("cms/../x")).rejects.toThrow();
    await expect(system.examineFolder("../etc")).rejects.toThrow();
    expect(existsSync(join(root, "evade.env"))).toBe(false);
  });

  test("the second lock refuses a subdirectory that is a link", async () => {
    const root = throwawayRoot();
    mkdirSync(join(root, "secrets"));
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(root, "secrets", "builder-secrets"));
    const system = systemOn(root);
    await expect(system.writeSecret("builder-secrets/registry", new TextEncoder().encode("x"), { owner: null, mode: 0o400 })).rejects.toThrow();
    await expect(system.examineSecret("builder-secrets/registry")).rejects.toThrow();
    expect(readdirSync(join(root, "elsewhere"))).toEqual([]);
    expect(await system.examineFolder("builder-secrets")).toMatchObject({ link: true, folder: false });
    expect(await system.examineFolder("absent-secrets")).toBeNull();
  });

  test("writing at 0400 into a subdirectory, through the already open descriptor", async () => {
    const root = throwawayRoot();
    mkdirSync(join(root, "secrets", "builder-secrets"), { recursive: true });
    const system = systemOn(root);
    await system.writeSecret("builder-secrets/registry", new TextEncoder().encode("premier\n"), { owner: null, mode: 0o400 });
    await system.writeSecret("builder-secrets/registry", new TextEncoder().encode("second\n"), { owner: null, mode: 0o400 });
    expect(readFileSync(join(root, "secrets", "builder-secrets", "registry"), "utf8")).toBe("second\n");
    expect(statSync(join(root, "secrets", "builder-secrets", "registry")).mode & 0o777).toBe(0o400);
    expect(readdirSync(join(root, "secrets", "builder-secrets"))).toEqual(["registry"]);
  });

  test("at startup, only the temporary files matching our pattern are removed, subdirectories included", async () => {
    const root = throwawayRoot();
    for (const folder of ["secrets/builder-secrets", "secrets/other", "state/precedents/builder-secrets"]) mkdirSync(join(root, folder), { recursive: true });
    const ours = [
      "secrets/.cms.env.0123456789abcdef.tmp",
      "secrets/builder-secrets/.registry.0123456789abcdef.tmp",
      "state/precedents/.cms.env.fedcba9876543210.tmp",
      "state/precedents/builder-secrets/.registry.fedcba9876543210.tmp",
      "state/.journal.jsonl.00112233445566ff.tmp",
    ];
    const others = [
      "secrets/cms.env",
      "secrets/.cms.env.tmp",
      // Upper case from another name: on macOS, the file system ignores case.
      "secrets/.cms.env.ABCDEFABCDEFABCD.tmp",
      "secrets/.cms.env.0123.tmp",
      "secrets/cms.env.0123456789abcdef.tmp",
      // Outside a secrets subdirectory: not ours.
      "secrets/other/.x.0123456789abcdef.tmp",
      "state/precedents/cms.env",
    ];
    for (const path of [...ours, ...others]) writeFileSync(join(root, path), "x");
    // A link matching our pattern is not one of our files.
    symlinkSync(join(root, "secrets", "cms.env"), join(root, "secrets", ".lien.env.aaaaaaaaaaaaaaaa.tmp"));

    expect(await systemOn(root).cleanTemporaries()).toBe(ours.length);
    for (const path of ours) expect(existsSync(join(root, path))).toBe(false);
    for (const path of others) expect(existsSync(join(root, path))).toBe(true);
    expect(lstatSync(join(root, "secrets", ".lien.env.aaaaaaaaaaaaaaaa.tmp")).isSymbolicLink()).toBe(true);
    expect(isTemporary(".cms.env.0123456789abcdef.tmp")).toBe(true);
    expect(isTemporary("cms.env")).toBe(false);
  });

  test("an abrupt restart in the middle of a write leaves only the old file and a temporary one", async () => {
    const root = throwawayRoot();
    mkdirSync(join(root, "secrets"));
    writeFileSync(join(root, "secrets", "cms.env"), "A=1\n", { mode: 0o600 });
    // What a stop between writing the temporary file and renaming it leaves.
    writeFileSync(join(root, "secrets", ".cms.env.abcdefabcdefabcd.tmp"), "A=2\n");
    const system = systemOn(root);
    await system.cleanTemporaries();
    expect(readdirSync(join(root, "secrets"))).toEqual(["cms.env"]);
    expect(readFileSync(join(root, "secrets", "cms.env"), "utf8")).toBe("A=1\n");
  });

  test("the Caddy block and the gatekeeper's result are read without following a link", async () => {
    const root = throwawayRoot();
    for (const folder of ["caddy", "gatekeeper"]) mkdirSync(join(root, folder));
    writeFileSync(join(root, "caddy", "test-zone.invalid.caddy"), "bloc\n");
    writeFileSync(join(root, "passwd"), "root:x:0:0\n");
    symlinkSync(join(root, "passwd"), join(root, "caddy", "cms.caddy"));
    const system = systemOn(root);
    expect(await system.readFragment("test-zone.invalid")).toBe("bloc\n");
    expect(await system.readFragment("cms")).toBeNull();
    expect(await system.readFragment("absent")).toBeNull();
    expect((await system.readGatekeeperResult("cms")).kind).toBe("absent");
  });

  test("a gatekeeper backup is seen without being followed, and a name that is not a site is refused", async () => {
    const root = throwawayRoot();
    const system = systemOn(root);
    // Neither the gatekeeper's directory nor the backups' one: nothing interrupted.
    expect(await system.gatekeeperBackup("cms")).toBe(false);
    expect(await system.gatekeeperBackups()).toEqual([]);
    mkdirSync(join(root, "gatekeeper", "sauvegardes", "cms"), { recursive: true });
    writeFileSync(join(root, "gatekeeper", "sauvegardes", "calendar"), "");
    symlinkSync(join(root, "absent"), join(root, "gatekeeper", "sauvegardes", "library"));
    expect(await system.gatekeeperBackup("cms")).toBe(true);
    expect(await system.gatekeeperBackup("calendar")).toBe(true);
    expect(await system.gatekeeperBackup("library")).toBe(true);
    expect(await system.gatekeeperBackup("builder")).toBe(false);
    await expect(system.gatekeeperBackup("../cms")).rejects.toThrow();
    // The complete list, links and files included, in order.
    expect(await system.gatekeeperBackups()).toEqual(["calendar", "cms", "library"]);
  });

  test("removing a previous version: missing, nothing to do; present, it goes, flat as in a subdirectory", async () => {
    const root = throwawayRoot();
    mkdirSync(join(root, "secrets"));
    const system = systemOn(root);
    await system.removePrevious("cms.env");
    await system.removePrevious("builder-secrets/x.env");
    await system.writePrevious("cms.env", new TextEncoder().encode("A=1\n"), null);
    await system.writePrevious("builder-secrets/x.env", new TextEncoder().encode("B=1\n"), null);
    await system.removePrevious("cms.env");
    await system.removePrevious("builder-secrets/x.env");
    expect((await system.examinePrevious("cms.env")).kind).toBe("absent");
    expect(readdirSync(join(root, "state", "precedents", "builder-secrets"))).toEqual([]);
    await expect(system.removePrevious("../cms.env")).rejects.toThrow();
  });
});

describe("unit and capabilities", () => {
  const unit = readFileSync(join(import.meta.dir, "..", "..", "infra", "steward", "sitesolide-steward.service"), "utf8");
  const directives = unit.split("\n").filter((line) => /^[A-Za-z]+=/.test(line));
  const source = readFileSync(join(import.meta.dir, "..", "src", "secrets", "system.ts"), "utf8");

  test("the unit the lab proposed, with nothing taken off the hardening", () => {
    for (const expected of [
      "ExecStart=/usr/local/bin/bun /usr/local/lib/sitesolide/steward.js",
      "CapabilityBoundingSet=CAP_CHOWN CAP_DAC_READ_SEARCH",
      "SystemCallFilter=@system-service",
      "PrivateNetwork=true",
      "IPAddressDeny=any",
      "ProtectSystem=strict",
      "ReadWritePaths=/etc/sitesolide",
      "NoNewPrivileges=true",
      "ProtectProc=invisible",
      "ProcSubset=pid",
      "RestrictAddressFamilies=AF_UNIX",
      "MemoryMax=128M",
      "UMask=0077",
      "RuntimeDirectoryMode=0750",
      "StateDirectoryMode=0700",
    ]) {
      expect(directives).toContain(expected);
    }
    expect(unit).not.toMatch(/^CapabilityBoundingSet=.*(CAP_FOWNER|CAP_DAC_OVERRIDE|CAP_SYS_ADMIN)/m);
    // Nothing written outside /etc/sitesolide and its own directories: Caddy
    // and the gatekeeper are only read.
    expect(directives.filter((line) => line.startsWith("ReadWritePaths="))).toEqual(["ReadWritePaths=/etc/sitesolide"]);
    expect(unit).not.toMatch(/^(ReadWritePaths|BindPaths)=.*(caddy|gatekeeper)/m);
    expect(unit).not.toMatch(/^(InaccessiblePaths|TemporaryFileSystem)=.*(\/etc\/caddy|\/run)/m);
  });

  test("the code does not require what the unit does not grant", () => {
    // With no CAP_FOWNER: neither link() on another account's file, nor fchmod
    // after fchown.
    expect(/\blinkSync\b/.test(source)).toBe(false);
    for (const func of ["function writeAtomically", "function createEmpty"]) {
      const body = source.slice(source.indexOf(func));
      expect(body.indexOf("fchmodSync(")).toBeGreaterThan(0);
      expect(body.indexOf("fchmodSync(")).toBeLessThan(body.indexOf("fchownSync("));
    }
    // The steward creates no directory in /etc/sitesolide: only its previous
    // versions get a mkdir.
    expect(source.match(/mkdirSync\(/g)?.length).toBe(2);
  });
});

/**
 * The entry point itself, launched the way systemd would launch it: a real Unix
 * socket in a throwaway directory, queried by fetch({ unix }), with the
 * embedded registry.
 */
describe("integration: dashboard/steward.ts on a socket", () => {
  test("listens, sets the socket's permissions, answers, and stops cleanly", async () => {
    const root = mkdtempSync(join(tmpdir(), "secr-"));
    toClean.push(root);
    for (const folder of ["sites/cms", "sites/dashboard", "secrets", "units", "state/precedents", "run", "caddy", "gatekeeper"]) {
      mkdirSync(join(root, folder), { recursive: true });
    }
    writeFileSync(
      join(root, "sites/cms/sitesolide.json"),
      JSON.stringify({ slug: "cms", start: "bun server.ts", port: 3048, publicDir: "public", secrets: ["cms.env"] }),
    );
    writeFileSync(join(root, "sites/dashboard/sitesolide.json"), JSON.stringify({ slug: "dashboard", start: "bun server.ts", secrets: ["dashboard.env"] }));
    writeFileSync(join(root, "secrets/cms.env"), CMS_ENV, { mode: 0o600 });
    // A temporary file from an abrupt stop, which the start has to remove.
    writeFileSync(join(root, "secrets/.cms.env.0123456789abcdef.tmp"), "A=1\n");
    const hash = await hashFast(PASSWORD);
    writeFileSync(join(root, "secrets/dashboard.env"), `PASSWORD_HASH=${hash}\n`, { mode: 0o600 });
    const socket = join(root, "run", "secretaire.sock");

    // A stale socket, as an abrupt stop leaves behind: Bun does not remove the
    // file when it stops, and the steward has to replace it.
    const stale = Bun.serve({ unix: socket, fetch: () => new Response("stale") });
    await stale.stop(true);
    expect(lstatSync(socket).isSocket()).toBe(true);

    const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "steward.ts")], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        SITES_DIR: join(root, "sites"),
        SECRETS_FOLDER: join(root, "secrets"),
        UNITS_FOLDER: join(root, "units"),
        STATE_FOLDER: join(root, "state"),
        CADDY_FOLDER: join(root, "caddy"),
        GATEKEEPER_FOLDER: join(root, "gatekeeper"),
        SOCKET: socket,
        SOCKET_GROUP: "",
        OWNERS: "",
        SYSTEMCTL: "false",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      let ready = false;
      for (let attempt = 0; attempt < 100 && !ready; attempt++) {
        try {
          ready = (await fetch("http://steward/projects", { unix: socket })).status === 200;
        } catch {
          await Bun.sleep(50);
        }
      }
      expect(ready).toBe(true);

      expect(statSync(join(root, "run")).mode & 0o777).toBe(0o750);
      expect(statSync(socket).mode & 0o777).toBe(0o660);
      // The temporary name took the known name: nothing else is left.
      expect(readdirSync(join(root, "run"))).toEqual(["secretaire.sock"]);
      expect(existsSync(join(root, "secrets/.cms.env.0123456789abcdef.tmp"))).toBe(false);

      const { projects: enumerate } = (await (await fetch("http://steward/projects", { unix: socket })).json()) as ProjectsResponse;
      expect(enumerate.map((project) => project.slug)).toEqual(["cms", "dashboard"]);
      expect(enumerate[0]!.files[0]!.variables).toEqual(["SID", "TOKEN"]);
      // The embedded registry does not know this throwaway directory: the
      // dashboard's expectation is a manifest's, and the real registry was
      // indeed read.
      expect(enumerate[1]!.files[0]).toMatchObject({ name: "dashboard.env", passwords: ["PASSWORD_HASH"] });

      const opening = await fetch("http://steward/unlock", {
        unix: socket,
        method: "POST",
        body: JSON.stringify({ password: PASSWORD }),
      });
      const { token } = (await opening.json()) as UnlockResponse;
      const value = await fetch("http://steward/value", {
        unix: socket,
        method: "POST",
        body: JSON.stringify({ token, slug: "cms", file: "cms.env", variable: "TOKEN" }),
      });
      expect(((await value.json()) as ValueResponse).value).toBe(SECRET_TOKEN);

      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
      expect(existsSync(socket)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("refuses to start in a directory that is not its own", async () => {
    const root = mkdtempSync(join(tmpdir(), "secr-"));
    toClean.push(root);
    writeFileSync(join(root, "neighbour"), "");
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "..", "steward.ts")], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", SOCKET: join(root, "s.sock"), SOCKET_GROUP: "", OWNERS: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    expect(await child.stderr.text()).toContain("the socket needs a folder of its own");
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });
});
