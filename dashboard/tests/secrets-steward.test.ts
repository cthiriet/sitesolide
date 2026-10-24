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
import { buildFragment } from "../borrowed/locks";
import type { Manifest } from "../borrowed/manifest";
import { generateUnits } from "../borrowed/unit";
import { TOLERATED_FAILURES, INITIAL_BACKOFF_MS, MAXIMUM_BACKOFF_MS } from "../src/auth";
import { portalModifiable } from "../src/gatekeeper/rules";
import type {
  LogEntry,
  Failure,
  FileView,
  ProjectView,
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
import { fromJournal } from "../src/audit/normalize";
import { IDENTITY_VARIABLES } from "../borrowed/sharing";
import {
  MAX_BODY_BYTES,
  MAX_QUEUED,
  MAX_IN_FLIGHT,
  createSteward,
  type StewardHandler,
  type StewardOptions,
} from "../src/secrets/steward";
import { createSystem, isTemporary, readAccount, readGroup, type Command, type SystemConfig, type System } from "../src/secrets/system";
import type { StoreChangeResponse, StoreListResponse, StoreRevealResponse, StoreView } from "../borrowed/store-protocol";
import { ACCESS_MAX_LINES, ACCESS_PRUNE_BYTES, ACCESS_PRUNE_INTERVAL_MS, ACCESS_RETENTION_MS, createHistory, encodeEntry, inWindow, latest, MAX_ENTRY_BYTES, mergeLogs, page, reread, type AccessWindow } from "../src/secrets/log";

/**
 * The steward set up on a throwaway tree: real files, real atomic writes, but a
 * simulated `systemctl`, a simulated gatekeeper and a clock the test moves
 * forward itself. Each test has its own `mkdtemp` directory, never `.attempts`,
 * which tests/setup.ts empties on every run.
 *
 * The bench's machine looks like the real one: app sites with their stores, a
 * static site, the landing with no manifest and the file its old service
 * reads, the dashboard with its hash and its monitor's alerting, and the
 * portal with its hash.
 */

const PASSWORD = "Xith-G4r4-nRJs-uDMV-KhsD-mzuK";
const PORTAL_PASSWORD = "Portal-Shared-Password-42";
const SECRET_TOKEN = "tok_VALUE-SECRET-1";
const SECRET_SID = "ID_VALUE-SECRET-2";
const SECRET_SET = "sk_live 'VALUE' \"SECRET\" $3 #";
/** A token made only of the characters of a variable name: it would pass for a name. */
const SECRET_ALNUM = "fake_live_Q9x7Zk2Lm4Np8Rt6Vw3Yb5";
const charOf = (code: number) => String.fromCharCode(code);

const MONITOR_ENV = `# the alerting, to renew at the slightest doubt\nSID=${SECRET_SID}\n\n# the token\nTOKEN=${SECRET_TOKEN}\n`;

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
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
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
  /** The owner's socket, which only root opens: `sitesolide lock` and `unlock` over SSH. */
  owner: (method: string, path: string, body?: unknown) => Promise<Response>;
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
  /** The steward in service, for what the control routes hand it: a token's secrets. */
  current: () => StewardHandler;
};

async function mount(options: Mount = {}): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), "steward-"));
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
    secrets: ["SID", "TOKEN"],
  });
  project("calendar", { ...appManifest, secrets: ["API_KEY"] });
  project("library", { ...appManifest, secrets: ["KEY"] });
  project("dashboard", { ...appManifest });
  project("portal", { ...appManifest });
  project("builder", { ...appManifest, secrets: ["BUILDER"] });
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
      `EnvironmentFile=-${secrets}/projects/cms/env`,
      `LoadCredential=files:${secrets}/projects/cms/files`,
      "ExecStart=/usr/local/bin/bun run server.ts",
      "",
    ].join("\n"),
  );
  // An extension that sets one more variable.
  mkdirSync(join(units, "cms.service.d"));
  writeFileSync(join(units, "cms.service.d", "local.conf"), "[Service]\nEnvironment=FROM_EXTENSION=1\n");
  // A unit that reads no secret at all.
  writeFileSync(join(units, "library.service"), "[Service]\nEnvironment=PORT=3044\nExecStart=/bin/true\n");
  writeFileSync(join(units, "dashboard.service"), `[Service]\nEnvironmentFile=-${secrets}/dashboard.env\nExecStart=/bin/true\n`);
  writeFileSync(join(units, "portal.service"), `[Service]\nEnvironmentFile=-${secrets}/portal.env\nExecStart=/bin/true\n`);
  // The landing's old service, made by hand, reads a file of its own: no site lists it.
  writeFileSync(join(units, "sitesolide-landing.service"), `[Service]\nEnvironmentFile=-${secrets}/landing-mail.env\nExecStart=/bin/true\n`);
  writeFileSync(join(units, "builder.service"), "[Service]\nExecStart=/bin/true\n");

  // The monitor's alerting, which the dashboard's site lists and the monitor's unit reads.
  writeFileSync(join(secrets, "dashboard-monitor.env"), MONITOR_ENV, { mode: 0o600 });
  // Flat files of no platform project, present as on a machine where a
  // service made by hand or an earlier release left them: listed nowhere.
  writeFileSync(join(secrets, "cms.env"), `TOKEN=${SECRET_TOKEN}\n`, { mode: 0o600 });
  writeFileSync(join(secrets, "landing-mail.env"), "AWS_REGION=eu-west-3\n", { mode: 0o600 });
  const portalHash = await Bun.password.hash(PORTAL_PASSWORD, { algorithm: "bcrypt", cost: 4 });
  writeFileSync(join(secrets, "portal.env"), `PASSWORD_HASH=${portalHash}\n`, { mode: 0o600 });
  // Two hours old: no restart pending to begin with.
  const twoHoursAgo = (Date.now() - 7_200_000) / 1000;
  for (const name of ["dashboard-monitor.env", "portal.env"]) utimesSync(join(secrets, name), twoHoursAgo, twoHoursAgo);

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
    codesFile: join(root, "locks-codes.json"),
    locksFragment: join(root, "verrous.caddy"),
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
    current: () => handler,
    async owner(method, path, body) {
      return handler.owner(new Request(`http://steward${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    },
    async call(method, path, body, init = {}) {
      const requested: RequestInit = { method: method, ...init };
      if (body !== undefined) requested.body = typeof body === "string" ? body : JSON.stringify(body);
      const response = await handler(new Request(`http://steward${path}`, requested));
      // Every body returned is kept for the final test: no value must appear
      // in it, except in what /value and /password return.
      const text = await response.clone().text();
      if (!["/value", "/password", "/store/value"].includes(path)) renderedTexts.push(text);
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

/** The accepted changes of access, general access among them, kept 180 days apart from the journal. */
function accessLogOf(bench: Bench): LogEntry[] {
  const path = join(bench.state, "access-log.jsonl");
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
    expect((await bench.call("GET", "/restore")).headers.get("Allow")).toBe("POST");
    expect((await bench.call("GET", "/portal")).headers.get("Allow")).toBe("POST");
  });

  test("unreadable body, array, unexpected field, wrongly typed field, body too big", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const cas: [unknown, number][] = [
      ["{not json", 400],
      [[1, 2], 400],
      ["null", 400],
      [{ token, slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN", extra: 1 }, 400],
      [{ token, slug: "dashboard", file: "dashboard-monitor.env", variable: 42 }, 400],
      [{ token, slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN", pad: "x".repeat(MAX_BODY_BYTES) }, 400],
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
    expect(await errorOf(refused)).toEqual({ error: "failure", message: "the server is busy, try again in a moment" });

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

  test("a store's file over 64 KiB of JSON passes on the store's routes alone", async () => {
    const bench = await mount();
    addStoreProject(bench);
    const token = await unlock(bench);
    const pad = "x".repeat(MAX_BODY_BYTES);
    expect((await bench.call("PUT", "/variable", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "A", value: pad })).status).toBe(400);
    // 60 KiB of a file make 80 KiB in base64.
    const response = await bench.call("PUT", "/store/file", { token, slug: "shop", name: "gcp.json", content: b64("x".repeat(60 * 1024)) });
    expect(response.status).toBeLessThan(300);
  });
});

describe("GET /projects: every site", () => {
  test("every directory in /srv/sites, static, manifest-less, dashboard and portal included", async () => {
    const bench = await mount();
    const enumerate = await projects(bench);
    expect(enumerate.map((project) => project.slug)).toEqual(["builder", "calendar", "cms", "dashboard", "library", "portal", "showcase", "test-zone.invalid"]);
    const showcase = enumerate.find((project) => project.slug === "showcase")!;
    expect(showcase).toMatchObject({ service: null, files: [] });
    // The landing's service made by hand reads a file of its own: no site lists it.
    const landing = enumerate.find((project) => project.slug === "test-zone.invalid")!;
    expect(landing.service?.unit).toBe("sitesolide-landing");
    expect(landing.files).toEqual([]);
    expect(JSON.stringify(enumerate)).not.toContain("landing-mail");
    // cloudflare.env belongs to no site, under /etc/caddy as under the secrets directory.
    expect(JSON.stringify(enumerate)).not.toContain("cloudflare");
  });

  test("the platform's files, their variables, with no value at all", async () => {
    const bench = await mount();
    const response = await bench.call("GET", "/projects");
    expect(response.status).toBe(200);
    const text = await response.clone().text();
    const { projects: enumerate } = (await response.json()) as ProjectsResponse;

    const dashboard = enumerate.find((project) => project.slug === "dashboard")!;
    expect(dashboard.files.map((file) => file.name)).toEqual(["dashboard.env", "dashboard-monitor.env"]);
    expect(dashboard.files[1]).toEqual({
      name: "dashboard-monitor.env",
      state: "managed",
      reason: null,
      expected: "root:root 0600",
      variables: ["SID", "TOKEN"],
      passwords: [],
      modifiedAt: expect.any(Number),
      previous: false,
      restartPending: false,
    });

    for (const forbidden of [SECRET_TOKEN, SECRET_SID, "$2b$"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  test("a project lists no file: its secrets are its store's, a flat file named after it on the machine included", async () => {
    const bench = await mount();
    const enumerate = await projects(bench);
    for (const slug of ["builder", "calendar", "cms", "library"]) expect(enumerate.find((project) => project.slug === slug)!.files).toEqual([]);
    expect(JSON.stringify(enumerate)).not.toContain("cms.env");
    const token = await unlock(bench);
    const target = { token, slug: "cms", file: "cms.env" };
    for (const [method, path, body] of [
      ["POST", "/value", { ...target, variable: "TOKEN" }],
      ["PUT", "/variable", { ...target, variable: "TOKEN", value: "x" }],
      ["DELETE", "/variable", { ...target, variable: "TOKEN" }],
      ["POST", "/file", target],
      ["POST", "/restore", target],
    ] as const) {
      const response = await bench.call(method, path, body);
      expect({ path, status: response.status }).toEqual({ path, status: 403 });
    }
    expect(readFileSync(join(bench.secrets, "cms.env"), "utf8")).toBe(`TOKEN=${SECRET_TOKEN}\n`);
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
    writeFileSync(join(bench.sites, "cms", "sitesolide.json"), JSON.stringify({ slug: "cms", start: "bun server.ts", port: 3048, portal: true, secrets: ["SID", "TOKEN"] }));
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

  test("an unmanaged file is listed with its reason, without quoting the line", async () => {
    const bench = await mount();
    writeFileSync(join(bench.secrets, "dashboard-monitor.env"), `SID=1\nexport TOKEN=${SECRET_TOKEN}\n`);
    const text = await (await bench.call("GET", "/projects")).text();
    const file = (JSON.parse(text) as ProjectsResponse).projects.find((project) => project.slug === "dashboard")!.files[1]!;
    expect(file.state).toBe("unmanaged");
    expect(file.reason).toContain("line 2");
    expect(file.variables).toEqual([]);
    expect(text).not.toContain(SECRET_TOKEN);
  });

  test("a symbolic link is unmanaged, and its target never read", async () => {
    const bench = await mount();
    const target = join(bench.root, "elsewhere.env");
    writeFileSync(target, `STOLEN=${SECRET_TOKEN}\n`);
    rmSync(join(bench.secrets, "portal.env"));
    symlinkSync(target, join(bench.secrets, "portal.env"));

    const text = await (await bench.call("GET", "/projects")).text();
    const portal = (JSON.parse(text) as ProjectsResponse).projects.find((project) => project.slug === "portal")!;
    expect(portal.files[0]).toMatchObject({ name: "portal.env", state: "unmanaged", reason: "symbolic link", variables: [] });
    expect(text).not.toContain("STOLEN");
  });

  test("a file with two hard links is unmanaged", async () => {
    const bench = await mount();
    linkSync(join(bench.secrets, "dashboard-monitor.env"), join(bench.root, "copy.env"));
    expect(await fileSeen(bench, "dashboard", "dashboard-monitor.env")).toMatchObject({ state: "unmanaged", reason: "several hard links" });
  });

  test("a mode other than the expected one, more open or more closed, is unmanaged, and the reason gives the command", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    chmodSync(join(bench.secrets, "dashboard-monitor.env"), 0o640);
    expect((await fileSeen(bench, "dashboard", "dashboard-monitor.env")).reason).toBe(`mode 640, expected 600: sudo chmod 600 ${join(bench.secrets, "dashboard-monitor.env")}`);
    const set = await bench.call("PUT", "/variable", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "A", value: "1" });
    expect(set.status).toBe(409);

    chmodSync(join(bench.secrets, "dashboard-monitor.env"), 0o400);
    bench.clock.t += 2000;
    expect((await fileSeen(bench, "dashboard", "dashboard-monitor.env")).reason).toContain("expected 600: sudo chmod 600");
    chmodSync(join(bench.secrets, "dashboard-monitor.env"), 0o600);
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe(MONITOR_ENV);
  });

  test("a write in the same second as the service's start is pending (bench measurement 4)", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    // Well away from the end of a second, so that start and write fall in the same one.
    while (Date.now() % 1000 > 700 || Date.now() % 1000 < 20) await Bun.sleep(10);
    const started = Date.now() - 10;
    bench.scenario.current = () => showA("active", "running", 0, started);

    const set = await bench.call("PUT", "/variable", { token, slug: "portal", file: "portal.env", variable: "OIDC_ISSUER", value: "https://id.test-zone.invalid" });
    const { file } = (await set.json()) as FileResponse;
    const modified = statSync(join(bench.secrets, "portal.env")).mtimeMs;
    expect(Math.floor(modified / 1000)).toBe(Math.floor(started / 1000));
    expect(file.restartPending).toBe(true);
    expect(Number.isInteger(file.modifiedAt)).toBe(true);
  });

  test("saving then restarting: nothing is pending any more", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    await bench.call("PUT", "/variable", { token, slug: "portal", file: "portal.env", variable: "OIDC_ISSUER", value: "https://then.test-zone.invalid" });
    // The restart that follows the write, a few milliseconds later.
    const started = statSync(join(bench.secrets, "portal.env")).mtimeMs + 3;
    bench.scenario.current = () => showA("active", "running", 0, started);
    bench.clock.t += 2000;
    const portal = (await projects(bench)).find((project) => project.slug === "portal")!;
    expect(portal.service!.startedAt).toBe(Math.floor(started));
    expect(portal.files[0]!.restartPending).toBe(false);
  });

  test("a timestamp systemd would return in an unknown form announces nothing", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    bench.scenario.current = () => "LoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=0\nActiveEnterTimestamp=@1789593252\n";
    await bench.call("PUT", "/variable", { token, slug: "portal", file: "portal.env", variable: "OIDC_ISSUER", value: "https://x.test-zone.invalid" });
    bench.clock.t += 2000;
    const portal = (await projects(bench)).find((project) => project.slug === "portal")!;
    expect(portal.service).toEqual({ unit: "portal", state: "active", subState: "running", startedAt: null });
    expect(portal.files[0]!.restartPending).toBe(false);
  });

  test("a restart pending after a change", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    await bench.call("PUT", "/variable", { token, slug: "portal", file: "portal.env", variable: "OIDC_ISSUER", value: "https://other.test-zone.invalid" });
    expect((await fileSeen(bench, "portal", "portal.env")).restartPending).toBe(true);
  });

  test("a file its site's unit does not read waits for no restart: the monitor's and the backups' are read by units of their own", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    expect((await bench.call("PUT", "/variable", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN", value: "2" })).status).toBe(200);
    expect((await fileSeen(bench, "dashboard", "dashboard-monitor.env")).restartPending).toBe(false);
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

describe("GET /log by pages, for the Activity page", () => {
  test("without a page asked, the latest fifty as always; with one, paged and dated", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    for (let i = 0; i < 3; i++) await bench.call("POST", "/value", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN" });
    const plain = (await (await bench.call("GET", "/log")).json()) as LogResponse;
    expect(plain.paged).toBeUndefined();
    expect(plain.entries.length).toBe(4);

    const first = (await (await bench.call("GET", "/log?limit=2")).json()) as LogResponse;
    expect(first.paged).toBe(true);
    expect(first.entries).toEqual(plain.entries.slice(0, 2));
    const oldest = plain.entries.at(-1)!.a;
    const older = (await (await bench.call("GET", `/log?limit=50&before=${oldest + 1}`)).json()) as LogResponse;
    expect(older.entries.every((entry) => entry.a <= oldest)).toBe(true);
    expect(older.entries.at(-1)).toEqual(plain.entries.at(-1));
    const site = (await (await bench.call("GET", "/log?slug=dashboard&limit=10")).json()) as LogResponse;
    expect(site.entries.map((entry) => entry.operation)).toEqual(["read", "read", "read"]);
  });

  test("a page that does not read is refused", async () => {
    const bench = await mount();
    for (const query of ["limit=0", "limit=501", "limit=1&before=yesterday", "before=12"]) {
      expect((await bench.call("GET", `/log?${query}`)).status).toBe(400);
    }
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
    // Two simultaneous argon2id verifications got the service killed at 128M on the bench, three at 192M.
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
    const body = (token: string) => ({ token, slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN" });

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
    const set = bench.call("PUT", "/variable", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN", value: "stolen" });
    await settle();
    // Locking does not wait on the queue: it is what stops whatever is waiting.
    expect((await bench.call("POST", "/lock", { token })).status).toBe(204);
    release();

    expect((await restarting).status).toBe(200);
    const refused = await set;
    expect(refused.status).toBe(401);
    expect((await errorOf(refused)).error).toBe("locked");
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe(MONITOR_ENV);
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
      { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN", value: "too late" },
      { signal: abandon.signal },
    );
    await settle();
    abandon.abort();
    release();

    await restarting;
    expect((await set).status).toBe(500);
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe(MONITOR_ENV);
  });

  test("beyond four waiting requests, 503", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const release = blockQueue(bench);

    const queued = [bench.call("POST", "/restart", { token, slug: "cms" })];
    for (let i = 0; i < MAX_QUEUED; i++) {
      queued.push(bench.call("PUT", "/variable", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: `KEY_${i}`, value: "1" }));
    }
    await settle();
    const refused = await bench.call("PUT", "/variable", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "TOO_MANY", value: "1" });
    expect(refused.status).toBe(503);

    release();
    expect((await Promise.all(queued)).map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).not.toContain("TOO_MANY");
  });

  test("two simultaneous writes go one after the other, neither is lost", async () => {
    const bench = await mount({ slownessMs: 5 });
    const token = await unlock(bench);
    const poses = Array.from({ length: MAX_QUEUED + 1 }, (_, i) =>
      bench.call("PUT", "/variable", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: `KEY_${i}`, value: `${i}` }),
    );
    expect((await Promise.all(poses)).map((response) => response.status)).toEqual(Array(MAX_QUEUED + 1).fill(200));
    const text = readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8");
    for (let i = 0; i <= MAX_QUEUED; i++) expect(text).toContain(`KEY_${i}=${i}\n`);
  });
});

describe("the scope of requests", () => {
  test("with no token, nothing: no read, no write, no password, no portal, no restart", async () => {
    const bench = await mount();
    const before = readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8");
    const wanted: [string, string, Record<string, unknown>][] = [
      ["POST", "/value", { slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN" }],
      ["PUT", "/variable", { slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN", value: "x" }],
      ["DELETE", "/variable", { slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN" }],
      ["POST", "/file", { slug: "dashboard", file: "dashboard.env" }],
      ["POST", "/restore", { slug: "dashboard", file: "dashboard-monitor.env" }],
      ["POST", "/password", { slug: "portal", file: "portal.env", variable: "PASSWORD_HASH", dashboardPassword: PASSWORD, newPassword: null }],
      // Making a site public; restricting one takes no token (POST /portal's own tests).
      ["POST", "/portal", { slug: "cms", active: false, confirmation: "cms" }],
      ["POST", "/restart", { slug: "cms" }],
    ];
    for (const [method, path, body] of wanted) {
      for (const token of [undefined, "wrong", ""]) {
        const response = await bench.call(method, path, token === undefined ? body : { ...body, token });
        expect(response.status).toBe(401);
      }
    }
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe(before);
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
      ["builder", "builder.env/../cms.env"],
      ["builder", "folder/unknown"],
      ["builder", "cms/registry"],
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

  test("the backups' file, once present, holds ordinary variables; the landing's and a project's flat files are no site's", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    writeFileSync(join(bench.secrets, "dashboard-backup.env"), "", { mode: 0o600 });
    expect((await bench.call("PUT", "/variable", { token, slug: "dashboard", file: "dashboard-backup.env", variable: "KEY", value: "v1" })).status).toBe(200);
    const read = await bench.call("POST", "/value", { token, slug: "dashboard", file: "dashboard-backup.env", variable: "KEY" });
    expect(((await read.json()) as ValueResponse).value).toBe("v1");
    expect(log(bench).at(-1)).toMatchObject({ operation: "read", slug: "dashboard", file: "dashboard-backup.env", variable: "KEY" });
    for (const [slug, file] of [["test-zone.invalid", "landing-mail.env"], ["cms", "cms.env"], ["dashboard", "cms.env"]] as const) {
      expect((await bench.call("PUT", "/variable", { token, slug, file, variable: "KEY", value: "v1" })).status).toBe(403);
    }
    expect(readFileSync(join(bench.secrets, "landing-mail.env"), "utf8")).toBe("AWS_REGION=eu-west-3\n");
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
    const held: Record<string, string> = {
      "dashboard.env": "PASSWORD_HASH",
      "portal.env": `PASSWORD_HASH and ${IDENTITY_VARIABLES.join(", ")}`,
    };
    for (const [slug, file, variable] of cas) {
      const response = await bench.call("PUT", "/variable", { token, slug, file, variable, value: "/tmp/trap.sock" });
      expect(response.status).toBe(403);
      expect(await errorOf(response)).toEqual({
        error: "out-of-scope",
        message: `${file} holds ${held[file]} only: any other variable would change how its service runs, not add a secret`,
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

  test("the portal's sign-in settings are written into portal.env, which stays managed", async () => {
    const bench = await mount({ hashPassword: hashFast });
    const token = await unlock(bench);
    for (const [variable, value] of [
      ["OIDC_ISSUER", "https://idp.test-zone.invalid"],
      ["OIDC_CLIENT_SECRET", "not-a-real-secret"],
      ["OIDC_ADMIN_EMAILS", "owner@test-zone.invalid"],
    ]) {
      const response = await bench.call("PUT", "/variable", { token, slug: "portal", file: "portal.env", variable, value });
      expect({ variable, status: response.status }).toEqual({ variable, status: 200 });
    }
    const content = readFileSync(join(bench.secrets, "portal.env"), "utf8");
    expect(content).toContain("OIDC_ISSUER=https://idp.test-zone.invalid");
    expect(content).toContain("PASSWORD_HASH=");

    const seen = await fileSeen(bench, "portal", "portal.env");
    expect(seen.state).not.toBe("unmanaged");
    // Change password still works on the file that carries them.
    const password = await bench.call("POST", "/password", {
      token,
      slug: "portal",
      file: "portal.env",
      variable: "PASSWORD_HASH",
      dashboardPassword: PASSWORD,
      newPassword: null,
    });
    expect(password.status).toBe(200);
    expect(readFileSync(join(bench.secrets, "portal.env"), "utf8")).toContain("OIDC_CLIENT_SECRET=not-a-real-secret");
  });
});

describe("reading and writing", () => {
  test("POST /value returns the value, 404 for a missing variable or file", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const unitEnv = await bench.call("POST", "/value", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN" });
    expect(((await unitEnv.json()) as ValueResponse).value).toBe(SECRET_TOKEN);

    expect((await bench.call("POST", "/value", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "NON" })).status).toBe(404);
    rmSync(join(bench.secrets, "portal.env"));
    expect((await bench.call("POST", "/value", { token, slug: "portal", file: "portal.env", variable: "OIDC_ISSUER" })).status).toBe(404);

    expect(log(bench).find((e) => e.operation === "read" && e.result === "ok")).toMatchObject({
      slug: "dashboard",
      file: "dashboard-monitor.env",
      variable: "TOKEN",
    });
  });

  test("PUT /variable replaces in place, keeps the comments, the previous version and the expected mode", async () => {
    const bench = await mount();
    const token = await unlock(bench);

    const response = await bench.call("PUT", "/variable", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN", value: SECRET_SET });
    expect(response.status).toBe(200);
    expect(((await response.json()) as FileResponse).file).toMatchObject({ name: "dashboard-monitor.env", state: "managed", variables: ["SID", "TOKEN"], previous: true });

    const text = readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8");
    expect(text.startsWith(`# the alerting, to renew at the slightest doubt\nSID=${SECRET_SID}\n\n# the token\nTOKEN=`)).toBe(true);
    expect(readFileSync(join(bench.state, "precedents", "dashboard-monitor.env"), "utf8")).toBe(MONITOR_ENV);
    expect(statSync(join(bench.state, "precedents", "dashboard-monitor.env")).mode & 0o777).toBe(0o600);
    expect(statSync(join(bench.secrets, "dashboard-monitor.env")).mode & 0o777).toBe(0o600);
    expect(readdirSync(bench.secrets).filter(isTemporary)).toEqual([]);

    const reread = await bench.call("POST", "/value", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN" });
    expect(((await reread.json()) as ValueResponse).value).toBe(SECRET_SET);
  });

  test("a new variable goes to the end", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    await bench.call("PUT", "/variable", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "REGION", value: "eu-west-3" });
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe(`${MONITOR_ENV}REGION=eu-west-3\n`);
  });

  test("the keys set by the unit, its extensions, the manifest, and the reserved families are refused", async () => {
    const bench = await mount();
    writeFileSync(join(bench.units, "dashboard.service"), `[Service]\nEnvironment=PORT=3022\nEnvironment=ADDED_BY_HAND=1\nEnvironmentFile=-${bench.secrets}/dashboard.env\nExecStart=/bin/true\n`);
    mkdirSync(join(bench.units, "dashboard.service.d"));
    writeFileSync(join(bench.units, "dashboard.service.d", "local.conf"), "[Service]\nEnvironment=FROM_EXTENSION=1\n");
    writeFileSync(join(bench.sites, "dashboard", "sitesolide.json"), JSON.stringify({ slug: "dashboard", start: "bun server.ts", port: 3022, env: { NODE_ENV: "production", DEFAULT_SENDER: "me@test-zone.invalid" } }));
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
      const response = await bench.call("PUT", "/variable", { token, slug: "dashboard", file: "dashboard-monitor.env", variable, value: "x" });
      expect(response.status).toBe(400);
      expect((await errorOf(response)).error).toBe("invalid");
    }
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe(MONITOR_ENV);
  });

  test("the refused values, and the message does not quote them", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    for (const value of [`${SECRET_SET}\nINJECTED=1`, `a\rb`, "a\0b", "x".repeat(8193), `SECRET${charOf(0xd800)}`]) {
      const response = await bench.call("PUT", "/variable", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN", value });
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toContain("SECRET");
    }
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe(MONITOR_ENV);
  });

  test("an unmanaged file or a link is never rewritten: 409", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    writeFileSync(join(bench.secrets, "dashboard-monitor.env"), "export A=1\n");
    const target = join(bench.root, "elsewhere.env");
    writeFileSync(target, "A=1\n");
    rmSync(join(bench.secrets, "portal.env"));
    symlinkSync(target, join(bench.secrets, "portal.env"));

    for (const [slug, file, variable] of [["dashboard", "dashboard-monitor.env", "B"], ["portal", "portal.env", "OIDC_ISSUER"]] as const) {
      const response = await bench.call("PUT", "/variable", { token, slug, file, variable, value: "2" });
      expect(response.status).toBe(409);
      expect((await errorOf(response)).error).toBe("unmanaged");
    }
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe("export A=1\n");
    expect(readFileSync(target, "utf8")).toBe("A=1\n");
    expect(lstatSync(join(bench.secrets, "portal.env")).isSymbolicLink()).toBe(true);
  });

  test("PUT on a missing file: 404, it has to be created first", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    rmSync(join(bench.secrets, "portal.env"));
    const response = await bench.call("PUT", "/variable", { token, slug: "portal", file: "portal.env", variable: "OIDC_ISSUER", value: "1" });
    expect(response.status).toBe(404);
    expect(existsSync(join(bench.secrets, "portal.env"))).toBe(false);
  });

  test("DELETE /variable removes without touching the neighbours, 404 if missing", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const response = await bench.call("DELETE", "/variable", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "SID" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as FileResponse).file.variables).toEqual(["TOKEN"]);
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe(`# the alerting, to renew at the slightest doubt\n\n# the token\nTOKEN=${SECRET_TOKEN}\n`);
    expect((await bench.call("DELETE", "/variable", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "SID" })).status).toBe(404);
  });

  test("POST /file creates a listed and missing file empty at 0600, 409 if it exists", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    rmSync(join(bench.secrets, "portal.env"));
    const response = await bench.call("POST", "/file", { token, slug: "portal", file: "portal.env" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as FileResponse).file).toMatchObject({ state: "managed", variables: [] });
    expect(readFileSync(join(bench.secrets, "portal.env"), "utf8")).toBe("");
    expect(statSync(join(bench.secrets, "portal.env")).mode & 0o777).toBe(0o600);

    const encore = await bench.call("POST", "/file", { token, slug: "portal", file: "portal.env" });
    expect(encore.status).toBe(409);
    expect((await errorOf(encore)).error).toBe("already-present");

    expect((await bench.call("POST", "/file", { token, slug: "dashboard", file: "dashboard-monitor.env" })).status).toBe(409);
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe(MONITOR_ENV);
  });

  test("POST /file does not replace a symbolic link", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    rmSync(join(bench.secrets, "portal.env"));
    symlinkSync(join(bench.root, "nowhere"), join(bench.secrets, "portal.env"));
    expect((await bench.call("POST", "/file", { token, slug: "portal", file: "portal.env" })).status).toBe(409);
    expect(existsSync(join(bench.root, "nowhere"))).toBe(false);
  });

  test("POST /restore swaps current and previous, twice comes back to the start", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const target = { token, slug: "dashboard", file: "dashboard-monitor.env" };

    expect((await bench.call("POST", "/restore", target)).status).toBe(404);

    await bench.call("PUT", "/variable", { ...target, variable: "TOKEN", value: "newvalue" });
    const modified = readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8");

    expect((await bench.call("POST", "/restore", target)).status).toBe(200);
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe(MONITOR_ENV);
    expect(readFileSync(join(bench.state, "precedents", "dashboard-monitor.env"), "utf8")).toBe(modified);

    expect((await bench.call("POST", "/restore", target)).status).toBe(200);
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe(modified);
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
    const target = { token, slug: "dashboard", file: "dashboard-monitor.env" };
    await bench.call("PUT", "/variable", { ...target, variable: "TOKEN", value: "newvalue" });
    order.length = 0;

    expect((await bench.call("POST", "/restore", target)).status).toBe(200);
    expect(order).toEqual(["previous", "secret"]);
  });

  test("an unmanaged previous version is not restored", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    mkdirSync(join(bench.state, "precedents"), { recursive: true });
    writeFileSync(join(bench.state, "precedents", "dashboard-monitor.env"), "export A=1\n");
    expect((await bench.call("POST", "/restore", { token, slug: "dashboard", file: "dashboard-monitor.env" })).status).toBe(409);
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe(MONITOR_ENV);
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

describe("PASSWORD_HASH in the monitor's file: a password like the dashboard's and the portal's", () => {
  const MONITOR_PASSWORD = "Monitor-Password-2026";

  /** dashboard-monitor.env with an ordinary token and a hash. */
  async function callsWithHash(bench: Bench): Promise<string> {
    const hash = await hashFast(MONITOR_PASSWORD);
    writeFileSync(join(bench.secrets, "dashboard-monitor.env"), `TOKEN=${SECRET_TOKEN}\nPASSWORD_HASH=${hash}\n`, { mode: 0o600 });
    return hash;
  }

  test("never read back, never set or removed through /variable, and offered to Change password", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const hash = await callsWithHash(bench);
    const before = readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8");
    const target = { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "PASSWORD_HASH" };

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
    writeFileSync(join(bench.secrets, "dashboard-backup.env"), "TOKEN=x\n", { mode: 0o600 });
    const backup = await bench.call("PUT", "/variable", { token, slug: "dashboard", file: "dashboard-backup.env", variable: "PASSWORD_HASH", value: "$argon2id$wrong" });
    expect(backup.status).toBe(403);
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe(before);
    expect(readFileSync(join(bench.secrets, "dashboard-backup.env"), "utf8")).toBe("TOKEN=x\n");

    // The neighbours stay ordinary.
    const neighbour = await bench.call("POST", "/value", { ...target, variable: "TOKEN" });
    expect(((await neighbour.json()) as ValueResponse).value).toBe(SECRET_TOKEN);
    expect(await fileSeen(bench, "dashboard", "dashboard-monitor.env")).toMatchObject({ state: "managed", variables: ["TOKEN", "PASSWORD_HASH"], passwords: ["PASSWORD_HASH"] });
    expect((await fileSeen(bench, "dashboard", "dashboard-backup.env")).passwords).toEqual([]);
  });

  test("changed through /password, without keeping the old one, and never restored", async () => {
    const bench = await mount({ hashPassword: hashFast });
    const token = await unlock(bench);
    const previous = await callsWithHash(bench);
    const target = { token, slug: "dashboard", file: "dashboard-monitor.env" };

    // Writing a neighbour keeps a previous version, which carries the
    // hash of the moment: the page does not offer it.
    expect((await bench.call("PUT", "/variable", { ...target, variable: "TOKEN", value: "newer" })).status).toBe(200);
    expect(readFileSync(join(bench.state, "precedents", "dashboard-monitor.env"), "utf8")).toContain(previous);
    expect((await fileSeen(bench, "dashboard", "dashboard-monitor.env")).previous).toBe(false);

    const change = await bench.call("POST", "/password", { ...target, variable: "PASSWORD_HASH", dashboardPassword: PASSWORD, newPassword: null });
    expect(change.status).toBe(200);
    const { password, file } = (await change.json()) as PasswordResponse;
    expect(file).toMatchObject({ variables: ["TOKEN", "PASSWORD_HASH"], passwords: ["PASSWORD_HASH"], previous: false });
    const fresh = hashOfFile(bench, "dashboard-monitor.env");
    expect(await Bun.password.verify(password!, fresh)).toBe(true);
    expect(await Bun.password.verify(MONITOR_PASSWORD, fresh)).toBe(false);
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toContain("TOKEN=newer\n");
    // The previous version that carried the old one went with it.
    expect(existsSync(join(bench.state, "precedents", "dashboard-monitor.env"))).toBe(false);

    // A write after the change keeps a previous version, which still cannot be restored.
    expect((await bench.call("PUT", "/variable", { ...target, variable: "TOKEN", value: "encore" })).status).toBe(200);
    const restore = await bench.call("POST", "/restore", target);
    expect(restore.status).toBe(403);
    expect((await errorOf(restore)).message).toBe("a password is only changed with Change password");
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toContain("TOKEN=encore\n");
    expect(hashOfFile(bench, "dashboard-monitor.env")).toBe(fresh);
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
    writeFileSync(join(bench.state, "precedents", "dashboard-monitor.env"), "PASSWORD_HASH=$2b$04$older\nTOKEN=x\n", { mode: 0o600 });
    expect((await fileSeen(bench, "dashboard", "dashboard-monitor.env")).previous).toBe(false);
    expect((await bench.call("POST", "/restore", { token, slug: "dashboard", file: "dashboard-monitor.env" })).status).toBe(403);
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe(MONITOR_ENV);

    // With no hash on either side, restoring is still offered.
    writeFileSync(join(bench.state, "precedents", "dashboard-monitor.env"), "TOKEN=x\n", { mode: 0o600 });
    expect((await fileSeen(bench, "dashboard", "dashboard-monitor.env")).previous).toBe(true);
    expect((await bench.call("POST", "/restore", { token, slug: "dashboard", file: "dashboard-monitor.env" })).status).toBe(200);
  });

  test("a current file carrying a hash cannot be restored, even to a version that carried none", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const current = `TOKEN=y\nPASSWORD_HASH=${await hashFast("Monitor-Password-2026")}\n`;
    writeFileSync(join(bench.secrets, "dashboard-monitor.env"), current, { mode: 0o600 });
    mkdirSync(join(bench.state, "precedents"), { recursive: true });
    // Restoring would remove the hash: the service would ask for nothing any more.
    writeFileSync(join(bench.state, "precedents", "dashboard-monitor.env"), "TOKEN=x\n", { mode: 0o600 });
    expect((await fileSeen(bench, "dashboard", "dashboard-monitor.env")).previous).toBe(false);
    const response = await bench.call("POST", "/restore", { token, slug: "dashboard", file: "dashboard-monitor.env" });
    expect(response.status).toBe(403);
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe(current);
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
      actor: "owner",
      member: null,
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
    expect((await bench.call("POST", "/value", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN" })).status).toBe(200);
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
      [{ slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN" }, 403],
      [{ slug: "cms", file: "../portal.env" }, 403],
      // A flat file of a project is no platform file, whatever it holds.
      [{ slug: "cms", file: "cms.env" }, 403],
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
      bench.call("POST", "/password", requested(token, { newPassword: "first-password-of-the-portal" })),
      bench.call("POST", "/unlock", { password: PASSWORD }),
      bench.call("POST", "/password", requested(token, { newPassword: "second-password-of-the-portal" })),
    ]);
    expect(account.max).toBe(1);
    // The concurrent unlock replaces the token: whatever comes after it is locked.
    expect(responses.every((response) => [200, 401].includes(response.status))).toBe(true);
  });
});

/**
 * General access, the three of it and a new code, through the gatekeeper:
 * the owner's session on the dashboard's socket, and root on the owner's,
 * which `sitesolide lock` and `unlock` reach over SSH. The gatekeeper is
 * simulated as doing what it says: the manifest, the codes file and the
 * locks' fragment written, then its result. The code it draws comes back in
 * the answer, read from the codes file, and is written nowhere else.
 */
describe("POST /general", () => {
  const CODE = "K7M2PQ";
  const NEW_CODE = "W4XN8R";

  function gatekeeperThatDoes(bench: Bench, draws: string[] = [CODE, NEW_CODE]): Gatekeeper {
    return (unit) => {
      const [, action, slug] = /^sitesolide-gatekeeper-(on|off|code|renew)@(.+)\.service$/.exec(unit)!;
      const path = join(bench.sites, slug!, "sitesolide.json");
      const { portal: _portal, lock: _lock, ...manifest } = JSON.parse(readFileSync(path, "utf8"));
      const codesPath = bench.config.codesFile;
      const codes = existsSync(codesPath) ? JSON.parse(readFileSync(codesPath, "utf8")) : {};
      const code = action === "code" ? (codes[slug!] ?? draws.shift()!) : action === "renew" ? draws.shift()! : null;
      writeFileSync(path, JSON.stringify({ ...manifest, ...(action === "on" ? { portal: true } : {}), ...(code !== null ? { lock: true } : {}) }));
      writeFileSync(join(bench.caddy, `${slug}.caddy`), action === "on" ? "forward_auth @portal_guard 127.0.0.1:3026 {\n}\n" : "reverse_proxy 127.0.0.1:3048\n");
      if (code === null) delete codes[slug!];
      else codes[slug!] = code;
      writeFileSync(codesPath, `${JSON.stringify(codes)}\n`, { mode: 0o600 });
      writeFileSync(bench.config.locksFragment, code === null ? "# Preview locks\n" : buildFragment([{ slug: slug!, host: `${slug}.test-zone.invalid`, lock: true, code }]));
      writeFileSync(join(bench.gatekeeper, `${slug}.json`), `${JSON.stringify({ a: bench.clock.t, result: "ok", message: `${action}: validated, reloaded`, requested: action === "on", installed: action === "on" })}\n`, { mode: 0o644 });
      return 0;
    };
  }
  const starts = (bench: Bench) => bench.systemctlCalls.filter((call) => call[0] === "start").map((call) => call[1]);
  /** Every line the steward wrote, journal and access log: never a code. */
  const written = (bench: Bench) => [join(bench.state, "journal.jsonl"), join(bench.state, "access-log.jsonl")].filter(existsSync).map((file) => readFileSync(file, "utf8")).join("");

  test("Anyone with the code: the unlock, the slug retyped, the gatekeeper, and the code in the answer alone", async () => {
    const bench = await mount();
    bench.simulatedGatekeeper.current = gatekeeperThatDoes(bench);
    expect((await bench.call("POST", "/general", { slug: "cms", access: "code", confirmation: "cms" })).status).toBe(401);
    const token = await unlock(bench);
    const unconfirmed = await bench.call("POST", "/general", { token, slug: "cms", access: "code", confirmation: "" });
    expect(unconfirmed.status).toBe(400);
    expect((await errorOf(unconfirmed)).message).toBe("type cms to confirm opening it with a code");
    expect(starts(bench)).toEqual([]);

    const response = await bench.call("POST", "/general", { token, slug: "cms", access: "code", confirmation: "cms" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      general: { access: "code", modifiable: true, choices: { public: null, restricted: null, code: null } },
      detail: "code: validated, reloaded",
      code: { code: CODE, url: null },
    });
    expect(starts(bench)).toEqual(["sitesolide-gatekeeper-code@cms.service"]);
    expect(accessLogOf(bench).at(-1)).toMatchObject({ operation: "portal", result: "ok", actor: "owner", slug: "cms", detail: "code, ok" });
    expect(written(bench)).not.toContain(CODE);
  });

  test("a new code: the unlock and no retyping, journaled as a new code, never the code", async () => {
    const bench = await mount();
    bench.simulatedGatekeeper.current = gatekeeperThatDoes(bench);
    const token = await unlock(bench);
    await bench.call("POST", "/general", { token, slug: "cms", access: "code", confirmation: "cms" });
    const renewed = await bench.call("POST", "/general", { token, slug: "cms", access: "code", renew: true, confirmation: "" });
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toMatchObject({ general: { access: "code" }, code: { code: NEW_CODE } });
    expect(starts(bench)).toEqual(["sitesolide-gatekeeper-code@cms.service", "sitesolide-gatekeeper-renew@cms.service"]);
    expect(accessLogOf(bench).at(-1)).toMatchObject({ operation: "code", result: "ok", slug: "cms", detail: "renew, ok" });
    // Read back as a new code on the Activity page, under the owner.
    expect(fromJournal([accessLogOf(bench).at(-1)])[0]!.row).toMatchObject({ action: "access.code", actor: "owner", target: "cms" });
    expect(written(bench)).not.toContain(CODE);
    expect(written(bench)).not.toContain(NEW_CODE);
    // Without the unlock, no new code.
    await bench.call("POST", "/lock", { token });
    expect((await bench.call("POST", "/general", { token, slug: "cms", access: "code", renew: true, confirmation: "" })).status).toBe(401);
  });

  test("a new code for a site that does not open with one is refused before the gatekeeper", async () => {
    const bench = await mount();
    bench.simulatedGatekeeper.current = gatekeeperThatDoes(bench);
    const response = await bench.call("POST", "/general", { token: await unlock(bench), slug: "cms", access: "code", renew: true, confirmation: "" });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toBe("cms does not open with a code: choose Anyone with the code first");
    expect(starts(bench)).toEqual([]);
  });

  test("from the code to Restricted with no unlock, and to Public with it and the slug retyped", async () => {
    const bench = await mount();
    bench.simulatedGatekeeper.current = gatekeeperThatDoes(bench);
    const token = await unlock(bench);
    await bench.call("POST", "/general", { token, slug: "cms", access: "code", confirmation: "cms" });
    const restricted = await bench.call("POST", "/general", { slug: "cms", access: "restricted", confirmation: "" });
    expect(restricted.status).toBe(200);
    expect(await restricted.json()).toMatchObject({ general: { access: "restricted" }, code: null });
    expect(JSON.parse(readFileSync(bench.config.codesFile, "utf8"))).toEqual({});
    const opened = await bench.call("POST", "/general", { token, slug: "cms", access: "public", confirmation: "cms" });
    expect(await opened.json()).toMatchObject({ general: { access: "public" }, code: null });
    expect(starts(bench)).toEqual(["sitesolide-gatekeeper-code@cms.service", "sitesolide-gatekeeper-on@cms.service", "sitesolide-gatekeeper-off@cms.service"]);
    expect(accessLogOf(bench).map((entry) => entry.detail)).toEqual(["code, ok", "on, ok", "off, ok"]);
  });

  test("already open with its code, applied: nothing started, nothing logged, the code said back", async () => {
    const bench = await mount();
    bench.simulatedGatekeeper.current = gatekeeperThatDoes(bench);
    const token = await unlock(bench);
    await bench.call("POST", "/general", { token, slug: "cms", access: "code", confirmation: "cms" });
    const again = await bench.call("POST", "/general", { token, slug: "cms", access: "code", confirmation: "cms" });
    expect(await again.json()).toMatchObject({ detail: "cms already opens with a code: nothing to change", code: { code: CODE } });
    expect(starts(bench)).toHaveLength(1);
    expect(accessLogOf(bench)).toHaveLength(1);
  });

  test("already open with its code, its stanza from an earlier release: the gatekeeper writes it again", async () => {
    // An earlier stanza matches the preview's host alone, and leaves the
    // site's own domain open: never "nothing to change".
    const bench = await mount();
    bench.simulatedGatekeeper.current = gatekeeperThatDoes(bench);
    const token = await unlock(bench);
    await bench.call("POST", "/general", { token, slug: "cms", access: "code", confirmation: "cms" });
    const current = readFileSync(bench.config.locksFragment, "utf8");
    writeFileSync(bench.config.locksFragment, current.replace(/^@lock_host_cms expression .*$/m, "@lock_host_cms host cms.test-zone.invalid"));
    const again = await bench.call("POST", "/general", { token, slug: "cms", access: "code", confirmation: "cms" });
    expect(again.status).toBe(200);
    expect(starts(bench)).toHaveLength(2);
    expect(readFileSync(bench.config.locksFragment, "utf8")).toBe(current);
  });

  test("each choice the rule refuses is said, and refused before the gatekeeper", async () => {
    const bench = await mount();
    bench.simulatedGatekeeper.current = gatekeeperThatDoes(bench);
    const token = await unlock(bench);
    // A static site takes a code, never the portal.
    const general = (await (await bench.call("POST", "/general", { token, slug: "showcase", access: "restricted", confirmation: "" })).json()) as Failure;
    expect(general).toEqual({ error: "out-of-scope", message: "a static site cannot be restricted yet" });
    expect((await bench.call("POST", "/general", { token, slug: "showcase", access: "code", confirmation: "showcase" })).status).toBe(200);
    // The dashboard and the portal take none of the three.
    for (const slug of ["dashboard", "portal"]) {
      expect((await bench.call("POST", "/general", { token, slug, access: "code", confirmation: slug })).status).toBe(403);
    }
    // Malformed.
    for (const body of [{ token, slug: "cms", access: "open", confirmation: "" }, { token, slug: "cms", access: "public", renew: true, confirmation: "cms" }, { token, slug: "cms", access: "code", renew: "yes", confirmation: "" }]) {
      expect((await bench.call("POST", "/general", body)).status).toBe(400);
    }
    expect(starts(bench)).toEqual(["sitesolide-gatekeeper-code@showcase.service"]);
  });

  test("the owner's socket: `sitesolide lock` and `unlock` as root, no unlock and no retyping, journaled under the owner", async () => {
    const bench = await mount();
    bench.simulatedGatekeeper.current = gatekeeperThatDoes(bench);
    const locked = await bench.owner("POST", "/general", { slug: "cms", access: "code" });
    expect(locked.status).toBe(200);
    expect(await locked.json()).toMatchObject({ general: { access: "code" }, code: { code: CODE } });
    const renewed = await bench.owner("POST", "/general", { slug: "cms", access: "code", renew: true });
    expect(await renewed.json()).toMatchObject({ code: { code: NEW_CODE } });
    const unlocked = await bench.owner("POST", "/general", { slug: "cms", access: "public" });
    expect(await unlocked.json()).toMatchObject({ general: { access: "public" }, code: null });
    expect(starts(bench)).toEqual(["sitesolide-gatekeeper-code@cms.service", "sitesolide-gatekeeper-renew@cms.service", "sitesolide-gatekeeper-off@cms.service"]);
    expect(accessLogOf(bench).map((entry) => [entry.operation, entry.actor, entry.detail])).toEqual([
      ["portal", "owner", "code, ok"],
      ["code", "owner", "renew, ok"],
      ["portal", "owner", "off, ok"],
    ]);
    expect(written(bench)).not.toContain(CODE);
    // A token field is no part of it: the owner's socket takes the three fields alone.
    expect((await bench.owner("POST", "/general", { slug: "cms", access: "code", token: "x" })).status).toBe(400);
  });

  test("the old route keeps its answer's shape for a dashboard deployed before", async () => {
    const bench = await mount();
    bench.simulatedGatekeeper.current = gatekeeperThatDoes(bench);
    const response = await bench.call("POST", "/portal", { slug: "cms", active: true, confirmation: "" });
    expect(Object.keys((await response.json()) as object).sort()).toEqual(["detail", "portal"]);
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
    // A change of general access: kept 180 days in the access log, not rotated with the journal.
    expect(accessLogOf(bench).at(-1)).toMatchObject({ operation: "portal", result: "ok", slug: "cms", file: null, detail: "on, ok" });
  });

  test("restricting a site takes no unlock; making it public does", async () => {
    const bench = await mount();
    bench.simulatedGatekeeper.current = gatekeeperThatSucceeds(bench);
    // No token at all, or a wrong one: restricting goes through all the same.
    for (const extra of [{}, { token: "wrong" }]) {
      const restricted = await bench.call("POST", "/portal", { ...extra, slug: "cms", active: true, confirmation: "" });
      expect(restricted.status).toBe(200);
    }
    expect(accessLogOf(bench).at(-1)).toMatchObject({ operation: "portal", result: "ok", actor: "owner", detail: "on, ok" });
    const opened = await bench.call("POST", "/portal", { slug: "cms", active: false, confirmation: "cms" });
    expect(opened.status).toBe(401);
    // Restricted already the second time: nothing started again, nothing logged again.
    expect(bench.systemctlCalls.filter((call) => call[0] === "start")).toEqual([["start", "sitesolide-gatekeeper-on@cms.service"]]);
    expect(accessLogOf(bench).filter((one) => one.operation === "portal")).toHaveLength(1);
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
    expect(accessLogOf(bench).at(-1)).toMatchObject({ detail: "off, ok" });
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
    const set = bench.call("PUT", "/variable", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "A", value: "1" });
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
    await bench.call("POST", "/value", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN" });
    await bench.call("PUT", "/variable", { token, slug: "portal", file: "portal.env", variable: "OIDC_ISSUER", value: "https://id.test-zone.invalid" });
    await bench.call("POST", "/file", { token, slug: "test-zone.invalid", file: "landing-mail.env" });

    const whole = (await (await bench.call("GET", "/log")).json()) as LogResponse;
    expect(whole.entries.map((e) => e.slug)).toEqual(["test-zone.invalid", "portal", "dashboard", null]);

    const portal = (await (await bench.call("GET", "/log?slug=portal")).json()) as LogResponse;
    expect(portal.entries.map((e) => [e.slug, e.file])).toEqual([["portal", "portal.env"]]);
    const landing = (await (await bench.call("GET", "/log?slug=test-zone.invalid")).json()) as LogResponse;
    expect(landing.entries.map((e) => [e.operation, e.result])).toEqual([["create", "rejects"]]);
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
    await bench.call("PUT", "/variable", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN", value: "new" });

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
    expect((await fileSeen(bon, "portal", "portal.env")).state).toBe("managed");
    expect((await fileSeen(bon, "dashboard", "dashboard.env")).state).toBe("managed");

    const other = await underChecks({ accounts: ACCOUNTS.replace(account("site-portal"), account("site-portal", UID + 1)) });
    const file = await fileSeen(other, "portal", "portal.env");
    expect(file.state).toBe("unmanaged");
    expect(file.reason).toContain("sudo chown site-portal:site-portal");
  });

  test("the dashboard's hash has to belong to root", async () => {
    const bench = await underChecks({ accounts: ACCOUNTS.replace(account("root"), account("root", UID + 1, 0)) });
    expect((await fileSeen(bench, "dashboard", "dashboard.env")).reason).toContain("not root: sudo chown root:root");
  });

  test("a file in another group is unmanaged, and the reason gives chgrp", async () => {
    const bench = await underChecks({ accounts: ACCOUNTS.replace(account("site-portal"), account("site-portal", UID, TEST_GID + 1)) });
    expect((await fileSeen(bench, "portal", "portal.env")).reason).toBe(
      `group gid ${TEST_GID}, not site-portal: sudo chgrp site-portal ${join(bench.secrets, "portal.env")}`,
    );
  });

  test("a missing account: file unmanaged, creation refused", async () => {
    const bench = await underChecks({ accounts: ACCOUNTS.replace(account("site-portal"), "") });
    const token = await unlock(bench);
    expect((await fileSeen(bench, "portal", "portal.env")).reason).toContain("does not exist");
    rmSync(join(bench.secrets, "portal.env"));
    expect((await bench.call("POST", "/file", { token, slug: "portal", file: "portal.env" })).status).toBe(404);
  });

  test("creation sets the site's account, and a write carries it over", async () => {
    const bench = await underChecks();
    const token = await unlock(bench);
    rmSync(join(bench.secrets, "portal.env"));
    expect((await bench.call("POST", "/file", { token, slug: "portal", file: "portal.env" })).status).toBe(200);
    const created = statSync(join(bench.secrets, "portal.env"));
    expect([created.uid, created.gid, created.mode & 0o777]).toEqual([UID, TEST_GID, 0o600]);

    expect((await bench.call("PUT", "/variable", { token, slug: "portal", file: "portal.env", variable: "OIDC_ISSUER", value: "https://id.test-zone.invalid" })).status).toBe(200);
    expect(statSync(join(bench.secrets, "portal.env")).uid).toBe(UID);
  });

  test("the previous version keeps the owner of the file it replaces", async () => {
    const bench = await underChecks();
    const token = await unlock(bench);
    await bench.call("PUT", "/variable", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN", value: "x" });
    const previous = statSync(join(bench.state, "precedents", "dashboard-monitor.env"));
    const current = statSync(join(bench.secrets, "dashboard-monitor.env"));
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
    const target = { token, slug: "dashboard", file: "dashboard-monitor.env" };
    await bench.call("PUT", "/variable", { ...target, variable: "TOKEN", value: "newvalue" });
    const current = readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8");

    const response = await bench.call("POST", "/restore", target);
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toContain(`uid ${UID + 7}`);
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe(current);
  });

  test("a file created here starts with no previous version, even one left by an earlier site whose uid its account was given again", async () => {
    // `useradd --system` hands out the highest free uid below the lowest in
    // use: an account removed last comes back on the same uid, and the uid no
    // longer tells the earlier site's previous version from this one's. The
    // earlier file was removed by hand, its previous version stayed.
    const PREDECESSOR = "OIDC_CLIENT_SECRET=predecessor-secret-value\n";
    const bench = await underChecks();
    const token = await unlock(bench);
    rmSync(join(bench.secrets, "portal.env"));
    mkdirSync(join(bench.state, "precedents"), { recursive: true, mode: 0o700 });
    writeFileSync(join(bench.state, "precedents", "portal.env"), PREDECESSOR, { mode: 0o600 });
    expect((await bench.call("POST", "/file", { token, slug: "portal", file: "portal.env" })).status).toBe(200);
    expect(readFileSync(join(bench.secrets, "portal.env"), "utf8")).toBe("");
    // The earlier file's previous version went before the file was made.
    expect(existsSync(join(bench.state, "precedents", "portal.env"))).toBe(false);
    expect((await fileSeen(bench, "portal", "portal.env")).previous).toBe(false);
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

  test("the landing's service made by hand reads no managed file nor any store: refused, with no restart", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const response = await bench.call("POST", "/restart", { token, slug: "test-zone.invalid" });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).message).toContain("a restart would apply nothing");
    expect(bench.systemctlCalls).toEqual([]);
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

  test("a project whose every service is scheduled: its runs read the store anew, nothing waits for a restart, and none is made", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const manifest = { slug: "jobs", services: { sync: { start: "/usr/local/bin/bun run sync.ts", schedule: "hourly" } }, secrets: ["KEY"] } as Manifest;
    mkdirSync(join(bench.sites, "jobs"));
    writeFileSync(join(bench.sites, "jobs", "sitesolide.json"), JSON.stringify(manifest));
    // The anchor, started an hour ago; the store is newer.
    writeFileSync(join(bench.units, "jobs.service"), generateUnits(manifest)[0]!.text);
    expect((await bench.call("PUT", "/store/variable", { token, slug: "jobs", name: "KEY", value: "1" })).status).toBe(201);
    freshReadings(bench);
    const jobs = (await projects(bench)).find((project) => project.slug === "jobs")!;
    expect(jobs.files).toEqual([]);
    expect(jobs.store?.restartPending).toBe(false);
    const response = await bench.call("POST", "/restart", { token, slug: "jobs" });
    expect(response.status).toBe(403);
    const { message } = await errorOf(response);
    expect(message).toContain("every service of jobs is scheduled");
    expect(message).toContain("the next run applies the change");
    expect(message).not.toContain("reads none");
    expect(bench.systemctlCalls.filter((call) => call[0] !== "show")).toEqual([]);
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
    const set = bench.call("PUT", "/variable", { token, slug: "dashboard", file: "dashboard-monitor.env", variable: "AFTER", value: "1" });
    await settle();
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).not.toContain("AFTER");

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

describe("no value outside /value", () => {
  test("a refusal journals a variable name only if it exists in the file", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const target = { token, slug: "dashboard", file: "dashboard-monitor.env" };

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
    const target = { token, slug: "dashboard", file: "dashboard-monitor.env" };
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
    await bench.call("POST", "/file", { token, slug: "dashboard", file: "dashboard.env" });
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
    expect(entries.every((e) => e.variable === null || /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.variable))).toBe(true);

    // The Activity page reads this very answer, put in the shared shape: the
    // same names, and still no value.
    const rows = fromJournal(entries);
    expect(rows.length).toBe(entries.length);
    const handed = JSON.stringify(rows);
    for (const forbidden of forbiddenValues) expect(handed).not.toContain(forbidden);
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
      codesFile: join(root, "locks-codes.json"),
      locksFragment: join(root, "verrous.caddy"),
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

  describe("a project's store", () => {
    test("ensureStore lays the three folders 0700, drops a predecessor's previous versions once, then answers present", async () => {
      const root = throwawayRoot();
      mkdirSync(join(root, "secrets"));
      const previous = join(root, "state", "precedents", "projects", "shop");
      mkdirSync(join(previous, "files"), { recursive: true });
      writeFileSync(join(previous, "env"), "A=from-a-removed-project\n");
      const system = systemOn(root);
      expect(await system.ensureStore("shop")).toEqual({ kind: "created" });
      for (const part of ["", "/shop", "/shop/files"]) expect(statSync(join(root, "secrets", `projects${part}`)).mode & 0o777).toBe(0o700);
      expect(existsSync(previous)).toBe(false);
      writeFileSync(join(root, "state", "precedents", "projects", "kept"), "");
      // files/ deleted by hand: laid again, and the project's folder being there, nothing else is dropped.
      rmSync(join(root, "secrets", "projects", "shop", "files"), { recursive: true });
      await system.writeStorePrevious("shop", "env", new TextEncoder().encode("A=1\n"));
      expect(await system.ensureStore("shop")).toEqual({ kind: "present" });
      expect(existsSync(join(root, "secrets", "projects", "shop", "files"))).toBe(true);
      expect(readFileSync(join(previous, "env"), "utf8")).toBe("A=1\n");
      expect(await system.ensureStore("shop")).toEqual({ kind: "present" });
      expect(await system.examineStoreFolder("shop", "files")).toMatchObject({ link: false, folder: true, mode: 0o700 });
      expect(await system.examineStoreFolder("other", "folder")).toBeNull();
    });

    test("a link or a file at any of the three folders: refused, and nothing is read or written through it", async () => {
      for (const part of ["projects", "projects/shop", "projects/shop/files"]) {
        const root = throwawayRoot();
        const elsewhere = join(root, "elsewhere");
        mkdirSync(elsewhere);
        mkdirSync(join(root, "secrets", part, ".."), { recursive: true });
        symlinkSync(elsewhere, join(root, "secrets", part));
        const system = systemOn(root);
        expect(await system.ensureStore("shop")).toEqual({ kind: "refused", path: join(root, "secrets", part) });
        if (part !== "projects/shop/files") await expect(system.writeStoreEnv("shop", new TextEncoder().encode("A=1\n"))).rejects.toThrow();
        await expect(system.writeStoreFile("shop", "gcp.json", new Uint8Array([1]))).rejects.toThrow();
        await expect(system.listStoreFiles("shop")).rejects.toThrow();
        expect(readdirSync(elsewhere)).toEqual([]);
      }
      const root = throwawayRoot();
      mkdirSync(join(root, "secrets"));
      writeFileSync(join(root, "secrets", "projects"), "");
      expect(await systemOn(root).ensureStore("shop")).toEqual({ kind: "refused", path: join(root, "secrets", "projects") });
    });

    test("no path from a slug or a name that is not valid; a file written through a dot-named temporary; removing one leaves the folder", async () => {
      const root = throwawayRoot();
      mkdirSync(join(root, "secrets"));
      const system = systemOn(root);
      for (const slug of ["../x", "", "a/b", "Shop", "x.y"]) await expect(system.ensureStore(slug)).rejects.toThrow();
      await system.ensureStore("shop");
      for (const name of ["../env", ".hidden", "a/b", "a..b", "x".repeat(65)]) {
        await expect(system.writeStoreFile("shop", name, new Uint8Array([1]))).rejects.toThrow();
        await expect(system.removeStoreFile("shop", name)).rejects.toThrow();
      }
      for (const part of ["files/../env", "files/.x", "env/../x", "other"] as const) {
        await expect(system.readStorePrevious("shop", part as "env")).rejects.toThrow();
      }
      for (const name of ["../env", ".x", "a/b", ""]) await expect(system.readStoreFile("shop", name)).rejects.toThrow();

      await system.writeStoreFile("shop", "gcp.json", new TextEncoder().encode("{}"));
      const files = join(root, "secrets", "projects", "shop", "files");
      expect(readdirSync(files)).toEqual(["gcp.json"]);
      expect(statSync(join(files, "gcp.json")).mode & 0o777).toBe(0o600);
      // A temporary left by an abrupt stop is a dot file, which LoadCredential= skips, and goes at the next start.
      writeFileSync(join(files, ".gcp.json.0123456789abcdef.tmp"), "{");
      writeFileSync(join(root, "secrets", "projects", "shop", ".env.0123456789abcdef.tmp"), "A=");
      expect(await system.listStoreFiles("shop")).toEqual(["gcp.json"]);
      expect(await system.cleanTemporaries()).toBe(2);
      await system.removeStoreFile("shop", "gcp.json");
      await system.removeStoreFile("shop", "gcp.json");
      expect(readdirSync(files)).toEqual([]);
    });

  });

  describe("the access log", () => {
    const NOW = 1_800_000_000_000;
    const DAY = 24 * 3600 * 1000;
    const line = (a: number, others: Partial<LogEntry> = {}) =>
      encodeEntry({ a, operation: "access.add", result: "ok", actor: "owner", member: "carol@acme.test", slug: "blog", file: null, variable: null, detail: "carol@acme.test: Can open", ...others });
    const accessLog = (root: string) => join(root, "state", "access-log.jsonl");
    /** What the Activity page's first read asks for: the newest fifty rows, every site's. */
    const NEWEST: AccessWindow = { before: null, slug: null, need: 50 };
    const details = (root: string) => reread(readFileSync(accessLog(root), "utf8")).map((one) => one.detail);

    test("seeded at startup from the journal's accepted changes of access, root's alone, and never again", async () => {
      const root = throwawayRoot();
      mkdirSync(join(root, "state"));
      const journal = [
        line(NOW - 3 * DAY, { detail: "given" }),
        line(NOW - 2 * DAY, { operation: "unlock", member: null, slug: null, detail: null }),
        line(NOW - 2 * DAY, { result: "rejects", detail: "refused" }),
        line(NOW - DAY, { operation: "access.remove", detail: "removed" }),
      ].join("");
      writeFileSync(join(root, "state", "journal.jsonl"), journal);
      const system = systemOn(root);
      expect(await system.readAccessLog(NEWEST)).toBeNull();

      await system.prepareAccessLog(NOW);
      expect(details(root)).toEqual(["given", "removed"]);
      expect(statSync(accessLog(root)).mode & 0o777).toBe(0o600);
      // The journal is left as it was: the reader filters it.
      expect(readFileSync(join(root, "state", "journal.jsonl"), "utf8")).toBe(journal);

      // An access log that exists is never seeded again: a restart tops it up
      // with what the journal holds and it lacks, once; an append adds itself alone.
      writeFileSync(join(root, "state", "journal.jsonl"), journal + line(NOW, { detail: "journal only" }));
      await systemOn(root).prepareAccessLog(NOW);
      await systemOn(root).prepareAccessLog(NOW);
      await systemOn(root).appendAccessLog(line(NOW, { detail: "appended" }), NOW);
      expect(details(root)).toEqual(["given", "removed", "journal only", "appended"]);
      expect(readdirSync(join(root, "state")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    test("with no journal, it is laid empty: its existence alone says the seeding is done", async () => {
      const root = throwawayRoot();
      const system = systemOn(root);
      await system.prepareAccessLog(NOW);
      expect(await system.readAccessLog(NEWEST)).toBe("");
      // A refusal in the journal is no change of access: never topped up with it.
      writeFileSync(join(root, "state", "journal.jsonl"), line(NOW, { result: "rejects", detail: "refused" }));
      await system.prepareAccessLog(NOW);
      expect(await system.readAccessLog(NEWEST)).toBe("");
    });

    test("an append before any startup seeds first, so the journal's rows come before it", async () => {
      const root = throwawayRoot();
      mkdirSync(join(root, "state"));
      writeFileSync(join(root, "state", "journal.jsonl"), line(NOW - DAY, { detail: "earlier" }));
      await systemOn(root).appendAccessLog(line(NOW, { detail: "now" }), NOW);
      expect(details(root)).toEqual(["earlier", "now"]);
    });

    test("pruned at startup, then at most once an hour on the append that follows", async () => {
      const root = throwawayRoot();
      mkdirSync(join(root, "state"));
      writeFileSync(accessLog(root), line(NOW - ACCESS_RETENTION_MS - 1, { detail: "expired at startup" }) + line(NOW - DAY, { detail: "kept" }), { mode: 0o600 });
      const system = systemOn(root);
      await system.prepareAccessLog(NOW);
      expect(details(root)).toEqual(["kept"]);

      // Within the hour, a line already past its 180 days waits for the next pruning.
      await system.appendAccessLog(line(NOW - ACCESS_RETENTION_MS - 1, { detail: "expired" }), NOW + 1000);
      await system.appendAccessLog(line(NOW + 2000, { detail: "fresh" }), NOW + 2000);
      expect(details(root)).toEqual(["kept", "expired", "fresh"]);
      await system.appendAccessLog(line(NOW + ACCESS_PRUNE_INTERVAL_MS, { detail: "an hour on" }), NOW + ACCESS_PRUNE_INTERVAL_MS);
      expect(details(root)).toEqual(["kept", "fresh", "an hour on"]);
      expect(statSync(accessLog(root)).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(root, "state")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    test("grown past its size within the hour, it is pruned on the next append all the same", async () => {
      const root = throwawayRoot();
      const system = systemOn(root);
      await system.prepareAccessLog(NOW);
      const padding = "x".repeat(1000);
      const expired = `{"a":${NOW - ACCESS_RETENTION_MS - 1},"p":"${padding}"}\n`;
      writeFileSync(accessLog(root), expired.repeat(Math.ceil(ACCESS_PRUNE_BYTES / expired.length) + 1));
      await system.appendAccessLog(line(NOW + 1000, { detail: "after the flood" }), NOW + 1000);
      expect(details(root)).toEqual(["after the flood"]);
    });

    test("never pushed out young: past its count of rows younger than 180 days, it is full, and keeps every one", async () => {
      const root = throwawayRoot();
      mkdirSync(join(root, "state"));
      const many = Array.from({ length: ACCESS_MAX_LINES + 5 }, (_, i) => `{"a":${NOW - DAY + i}}\n`).join("");
      writeFileSync(accessLog(root), many, { mode: 0o600 });
      const system = systemOn(root);
      await system.prepareAccessLog(NOW);
      const lines = readFileSync(accessLog(root), "utf8").split("\n").filter((one) => one !== "");
      expect(lines.length).toBe(ACCESS_MAX_LINES + 5);
      expect(lines[0]).toBe(`{"a":${NOW - DAY}}`);
      expect(await system.accessLogFull(NOW)).toBe(true);
      // Once 180 days have passed for them, they age out and room comes back.
      expect(await system.accessLogFull(NOW + ACCESS_RETENTION_MS + 2 * DAY)).toBe(false);
    });

    test("past what is ever read at once, it is still pruned by age, line by line, and GET /log reads its newest part", async () => {
      const root = throwawayRoot();
      mkdirSync(join(root, "state"));
      // A flood a day old, pushed past the read bound by rows nothing refuses,
      // then one recent row at the end.
      const old = line(NOW - DAY, { operation: "portal", detail: "on, ok" });
      const flood = old.repeat(Math.ceil((ACCESS_PRUNE_BYTES + 1024 * 1024) / old.length));
      writeFileSync(accessLog(root), flood + line(NOW, { detail: "the newest" }), { mode: 0o600 });
      writeFileSync(join(root, "state", "journal.jsonl"), "", { mode: 0o600 });
      const system = systemOn(root);
      await system.prepareAccessLog(NOW);
      expect(statSync(accessLog(root)).size).toBeGreaterThan(ACCESS_PRUNE_BYTES);
      expect(await system.accessLogFull(NOW)).toBe(true);
      // Its newest fifty rows, whole lines: the latest change is there.
      const read = (await system.readAccessLog(NEWEST))!;
      expect(reread(read)).toHaveLength(50);
      expect(read.startsWith("{")).toBe(true);
      expect(reread(read).at(-1)?.detail).toBe("the newest");
      // 200 days later every flooded row is past its 180 days: pruned, room again.
      const later = NOW + 200 * DAY;
      await system.appendAccessLog(line(later, { detail: "much later" }), later);
      expect(details(root)).toEqual(["much later"]);
      expect(await system.accessLogFull(later)).toBe(false);
      expect(readdirSync(join(root, "state")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    test("a line longer than any a log writes, or one without a date, is dropped by the pruning", async () => {
      const root = throwawayRoot();
      mkdirSync(join(root, "state"));
      writeFileSync(accessLog(root), `${"y".repeat(200_000)}\nnot json\n${line(NOW - DAY, { detail: "kept" })}${line(NOW - ACCESS_RETENTION_MS - 1, { detail: "old" })}`, { mode: 0o600 });
      await systemOn(root).prepareAccessLog(NOW);
      expect(readFileSync(accessLog(root), "utf8")).toBe(line(NOW - DAY, { detail: "kept" }));
    });

    /** The window GET /log reads, worked out the plain way: every line that reads as an entry, then the newest `need` of them. */
    function expectedWindow(text: string, window: AccessWindow): string {
      const lines = text.split("\n").filter((one) => one !== "" && one.length <= MAX_ENTRY_BYTES && inWindow(one, window) && reread(one).length > 0);
      const kept = lines.slice(Math.max(0, lines.length - window.need));
      return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
    }

    test("GET /log reads a window ending at the page's date, of the site named, the rows the answer needs and no more", async () => {
      const root = throwawayRoot();
      mkdirSync(join(root, "state"));
      // Some 3 MB of rows of every length, sites mixed, a line longer than any
      // entry and a torn one among them, so that lines straddle every piece read.
      // Rows of other sites naming rare elsewhere, which hold its bytes and
      // are not its rows; and last, a row of rare written with its keys in
      // another order, which only a parse finds.
      const rows: string[] = [];
      let size = 0;
      let i = 0;
      for (; size < 3 * 1024 * 1024; i++) {
        const slug = i % 97 === 0 ? "rare" : i % 3 === 0 ? "shop" : "blog";
        const row = line(NOW - 10 * DAY + i * 1000, { slug, member: i % 5 === 1 ? `rare${i}@acme.test` : `p${i}@acme.test`, detail: `p${i}@acme.test: Can open ${"x".repeat((i * 37) % 150)}`.slice(0, 160) });
        rows.push(i === 5000 ? `${"y".repeat(70_000)}\n` : i === 6000 ? "{torn\n" : row);
        size += row.length;
      }
      rows.push(`${JSON.stringify({ slug: "rare", operation: "access.add", result: "ok", actor: "owner", member: "reordered@acme.test", file: null, variable: null, detail: null, a: NOW - 10 * DAY + i * 1000 })}\n`);
      const text = rows.join("");
      writeFileSync(accessLog(root), text, { mode: 0o600 });
      const system = systemOn(root);
      const windows: AccessWindow[] = [
        { before: null, slug: null, need: 50 },
        { before: null, slug: "rare", need: 50 },
        { before: NOW - 10 * DAY + 4_000_000, slug: null, need: 500 },
        { before: NOW - 10 * DAY + 4_000_000, slug: "shop", need: 500 },
        { before: NOW - 10 * DAY + 3_000, slug: null, need: 500 },
        { before: NOW - 20 * DAY, slug: null, need: 500 },
        { before: null, slug: "nowhere", need: 50 },
      ];
      for (const window of windows) {
        const read = (await system.readAccessLog(window))!;
        expect(read).toBe(expectedWindow(text, window));
        expect(reread(read).length).toBeLessThanOrEqual(window.need);
      }
      // A page further back: the newest rows before its date, what it asks for.
      const back = reread((await system.readAccessLog({ before: NOW - 10 * DAY + 4_000_000, slug: null, need: 500 }))!);
      expect(back.length).toBe(500);
      expect(back.every((one) => one.a < NOW - 10 * DAY + 4_000_000)).toBe(true);
      expect(back.at(-1)?.a).toBe(NOW - 10 * DAY + 3_999_000);
      // A rare site's fifty, however far back they lie, and no more: the
      // walk stops there. The row written otherwise is among them, and no
      // row that only names it.
      const rare = reread((await system.readAccessLog({ before: null, slug: "rare", need: 50 }))!);
      expect(rare.length).toBe(50);
      expect(rare.every((one) => one.slug === "rare")).toBe(true);
      expect(rare.some((one) => one.member === "reordered@acme.test")).toBe(true);
      expect(reread((await system.readAccessLog({ before: null, slug: "shop", need: 500 }))!)).toHaveLength(500);
    });

    test("a line torn by a crash takes no row's place: every page of GET /log is what the two whole files merged give", async () => {
      const root = throwawayRoot();
      mkdirSync(join(root, "state"));
      // Rows of two sites, every seventh line dated and torn mid-append, and
      // a journal with rows of its own between them.
      const rows: string[] = [];
      for (let i = 0; i < 3000; i++) {
        const a = NOW - DAY + i * 1000;
        const slug = i % 3 === 0 ? "shop" : "blog";
        rows.push(i % 7 === 3 ? `{"a":${a},"operation":"access.add","slug":"${slug}"\n` : line(a, { slug, detail: `p${i}@acme.test: Can open` }));
      }
      const text = rows.join("");
      writeFileSync(accessLog(root), text, { mode: 0o600 });
      const journal = Array.from({ length: 300 }, (_, i) => line(NOW - DAY + i * 9_000 + 500, { operation: "read", member: null, file: "blog.env", variable: "X", detail: null })).join("");
      writeFileSync(join(root, "state", "journal.jsonl"), journal, { mode: 0o600 });
      const system = systemOn(root);
      const history = createHistory({ readJournal: () => system.readLog(), readAccessLog: (window) => system.readAccessLog(window) });
      const whole = mergeLogs(reread(journal), reread(text));
      for (const slug of [null, "shop", "blog"]) {
        expect(await history.read({ before: null, slug, need: 50 }, (entries) => latest(entries, 50, slug))).toEqual(latest(whole, 50, slug));
        // Paged back to the first row, each page from the date of the last
        // one's oldest: every row once, none skipped.
        const seen: LogEntry[] = [];
        for (let before: number | null = null; ; ) {
          const query = { limit: 100, before };
          const got: LogEntry[] = await history.read({ before, slug, need: 100 }, (entries) => page(entries, query, slug));
          expect(got).toEqual(page(whole, query, slug));
          if (got.length === 0) break;
          seen.push(...got);
          before = got.at(-1)!.a;
        }
        expect(seen).toEqual(page(whole, { limit: whole.length, before: null }, slug));
      }
    });

    test("a burst of GET /log over a 12 MB access log holds one window at a time, and keeps none", async () => {
      const root = throwawayRoot();
      mkdirSync(join(root, "state"));
      const row = (i: number) => line(NOW - DAY + i, { member: `${"m".repeat(60)}${i}@acme-industries.com`, slug: "customer-portal-staging", detail: `${"m".repeat(60)}@acme-industries.com: Can open` });
      const parts: string[] = [];
      for (let i = 0, size = 0; size < 12 * 1024 * 1024; i++) {
        const one = row(i);
        parts.push(one);
        size += one.length;
      }
      writeFileSync(accessLog(root), parts.join(""), { mode: 0o600 });
      writeFileSync(join(root, "state", "journal.jsonl"), "", { mode: 0o600 });
      parts.length = 0;
      const system = systemOn(root);
      const history = createHistory({ readJournal: () => system.readLog(), readAccessLog: (window) => system.readAccessLog(window) });
      Bun.gc(true);
      const before = process.memoryUsage().rss;
      const pages = await Promise.all(
        Array.from({ length: 16 }, (_, i) => history.read({ before: NOW - i * 1000, slug: null, need: 500 }, (entries) => page(entries, { limit: 500, before: NOW - i * 1000 }).length)),
      );
      Bun.gc(true);
      expect(pages).toEqual(Array(16).fill(500));
      // A megabyte's window, parsed once at a time: a few megabytes at most.
      expect(process.memoryUsage().rss - before).toBeLessThan(24 * 1024 * 1024);
    });

    test("counted as it grows: below its cap, it has room; at it, it is full", async () => {
      const root = throwawayRoot();
      mkdirSync(join(root, "state"));
      writeFileSync(accessLog(root), Array.from({ length: ACCESS_MAX_LINES - 1 }, (_, i) => `{"a":${NOW - DAY + i}}\n`).join(""), { mode: 0o600 });
      const system = systemOn(root);
      await system.prepareAccessLog(NOW);
      expect(await system.accessLogFull(NOW)).toBe(false);
      await system.appendAccessLog(line(NOW + 1, { detail: "the last one" }), NOW + 1);
      expect(await system.accessLogFull(NOW + 2)).toBe(true);
    });
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
    // Flat names alone: no folder of /etc/sitesolide is ever written into.
    mkdirSync(join(root, "secrets", "builder-secrets"));
    await expect(system.writeSecret("keys/registry", new Uint8Array(0), permissions)).rejects.toThrow();
    await expect(system.examineSecret("keys/registry")).rejects.toThrow();
    expect(readdirSync(join(root, "secrets", "builder-secrets"))).toEqual([]);
    await expect(system.readFragment("../secrets/cms")).rejects.toThrow();
    await expect(system.readGatekeeperResult("cms/../x")).rejects.toThrow();
    expect(existsSync(join(root, "evade.env"))).toBe(false);
  });

  test("at startup, only the temporary files matching our pattern are removed, in the folders this steward writes", async () => {
    const root = throwawayRoot();
    for (const folder of ["secrets/other", "state/precedents"]) mkdirSync(join(root, folder), { recursive: true });
    const ours = [
      "secrets/.portal.env.0123456789abcdef.tmp",
      "state/precedents/.portal.env.fedcba9876543210.tmp",
      "state/.journal.jsonl.00112233445566ff.tmp",
    ];
    const others = [
      "secrets/cms.env",
      "secrets/.cms.env.tmp",
      // Upper case from another name: on macOS, the file system ignores case.
      "secrets/.cms.env.ABCDEFABCDEFABCD.tmp",
      "secrets/.cms.env.0123.tmp",
      "secrets/cms.env.0123456789abcdef.tmp",
      // In a folder this steward never writes into: not ours.
      "secrets/other/.x.0123456789abcdef.tmp",
      "state/precedents/cms.env",
    ];
    for (const path of [...ours, ...others]) writeFileSync(join(root, path), "x");
    // A link matching our pattern is not one of our files.
    symlinkSync(join(root, "secrets", "cms.env"), join(root, "secrets", ".link.env.aaaaaaaaaaaaaaaa.tmp"));

    expect(await systemOn(root).cleanTemporaries()).toBe(ours.length);
    for (const path of ours) expect(existsSync(join(root, path))).toBe(false);
    for (const path of others) expect(existsSync(join(root, path))).toBe(true);
    expect(lstatSync(join(root, "secrets", ".link.env.aaaaaaaaaaaaaaaa.tmp")).isSymbolicLink()).toBe(true);
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

  test("removing a previous version: missing, nothing to do; present, it goes; a name with a folder never", async () => {
    const root = throwawayRoot();
    mkdirSync(join(root, "secrets"));
    const system = systemOn(root);
    await system.removePrevious("portal.env");
    await system.writePrevious("portal.env", new TextEncoder().encode("A=1\n"), null);
    await system.removePrevious("portal.env");
    expect((await system.examinePrevious("portal.env")).kind).toBe("absent");
    await expect(system.writePrevious("keys/x.env", new TextEncoder().encode("B=1\n"), null)).rejects.toThrow();
    await expect(system.removePrevious("keys/x.env")).rejects.toThrow();
    await expect(system.removePrevious("../portal.env")).rejects.toThrow();
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
      "MemoryMax=192M",
      "UMask=0077",
      "RuntimeDirectoryMode=0750",
      "StateDirectoryMode=0700",
    ]) {
      expect(directives).toContain(expected);
    }
    expect(unit).not.toMatch(/^CapabilityBoundingSet=.*(CAP_FOWNER|CAP_DAC_OVERRIDE|CAP_SYS_ADMIN)/m);
    // Nothing written outside /etc/sitesolide, the egress proxy's connectors,
    // the portal's key, its own directories and the backup component's state,
    // where it drops restore requests: Caddy, the gatekeeper and the archives
    // are only read.
    expect(directives.filter((line) => line.startsWith("ReadWritePaths="))).toEqual([
      "ReadWritePaths=/etc/sitesolide",
      "ReadWritePaths=-/etc/sitesolide-egress",
      "ReadWritePaths=-/etc/sitesolide-portal",
      "ReadWritePaths=-/var/lib/sitesolide-backup",
    ]);
    // The owner's socket has a runtime folder of its own, which systemd removes at stop.
    expect(directives).toContain("RuntimeDirectory=sitesolide-steward sitesolide-steward-owner");
    expect(unit).not.toMatch(/^ReadWritePaths=.*\/var\/backups/m);
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
    // The steward creates no directory in /etc/sitesolide but a project's
    // store, its three folders root's 0700 (ensureStore); the others are its
    // previous versions'.
    expect(source.match(/mkdirSync\(/g)?.length).toBe(3);
    const ensure = source.slice(source.indexOf("async ensureStore("), source.indexOf("async readStoreEnv("));
    expect(ensure.match(/mkdirSync\(/g)?.length).toBe(1);
    expect(ensure).toContain("mkdirSync(path, { mode: 0o700 })");
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
    for (const folder of ["sites/cms", "sites/dashboard", "secrets", "units", "state/precedents", "run", "owner", "portal-key", "caddy", "gatekeeper"]) {
      mkdirSync(join(root, folder), { recursive: true });
    }
    writeFileSync(
      join(root, "sites/cms/sitesolide.json"),
      JSON.stringify({ slug: "cms", start: "bun server.ts", port: 3048, publicDir: "public", secrets: ["SID", "TOKEN"] }),
    );
    writeFileSync(join(root, "sites/dashboard/sitesolide.json"), JSON.stringify({ slug: "dashboard", start: "bun server.ts" }));
    writeFileSync(join(root, "secrets/dashboard-monitor.env"), MONITOR_ENV, { mode: 0o600 });
    // A temporary file from an abrupt stop, which the start has to remove.
    writeFileSync(join(root, "secrets/.dashboard-monitor.env.0123456789abcdef.tmp"), "A=1\n");
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
        OWNER_SOCKET: join(root, "owner", "owner.sock"),
        PORTAL_KEY_FOLDER: join(root, "portal-key"),
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

      // The owner's socket: root's alone, the access registry and nothing else.
      const ownerSocket = join(root, "owner", "owner.sock");
      expect(statSync(join(root, "owner")).mode & 0o777).toBe(0o700);
      expect(statSync(ownerSocket).mode & 0o777).toBe(0o600);
      expect((await fetch("http://steward/people", { unix: ownerSocket })).status).toBe(200);
      expect((await fetch("http://steward/members", { unix: ownerSocket })).status).toBe(404);
      expect((await fetch("http://steward/projects", { unix: ownerSocket })).status).toBe(404);
      // The access registry was made at startup, nothing before it, and its projection laid for the portal.
      expect(existsSync(join(root, "state", "access.json"))).toBe(true);
      expect(existsSync(join(root, "portal-key", "access.json"))).toBe(true);
      // The key pair was laid at startup, the private half where the portal reads it.
      expect(existsSync(join(root, "portal-key", "assertion.key"))).toBe(true);
      expect(existsSync(join(root, "state", "assertion.pub"))).toBe(true);
      expect(existsSync(join(root, "secrets/.dashboard-monitor.env.0123456789abcdef.tmp"))).toBe(false);

      const { projects: enumerate } = (await (await fetch("http://steward/projects", { unix: socket })).json()) as ProjectsResponse;
      expect(enumerate.map((project) => project.slug)).toEqual(["cms", "dashboard"]);
      // A project lists no file; the dashboard its own, from the platform's table.
      expect(enumerate[0]!.files).toEqual([]);
      expect(enumerate[1]!.files[0]).toMatchObject({ name: "dashboard.env", passwords: ["PASSWORD_HASH"] });
      expect(enumerate[1]!.files[1]!.variables).toEqual(["SID", "TOKEN"]);

      const opening = await fetch("http://steward/unlock", {
        unix: socket,
        method: "POST",
        body: JSON.stringify({ password: PASSWORD }),
      });
      const { token } = (await opening.json()) as UnlockResponse;
      const value = await fetch("http://steward/value", {
        unix: socket,
        method: "POST",
        body: JSON.stringify({ token, slug: "dashboard", file: "dashboard-monitor.env", variable: "TOKEN" }),
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

/** A value set into a store, that no answer, journal line or log may ever carry but `/store/value`'s. */
const STORE_CANARY = "store-canary-VALUE-4b19e7d2";
/** A file's bytes, the same rule. */
const FILE_CANARY = "-----BEGIN FAKE KEY-----\nfile-canary-CONTENT-82ac\n-----END FAKE KEY-----\n";
/** The draws of `generate` on the bench: every byte known, so that the value drawn is too. */
const drawn = (bytes: number) => Uint8Array.from({ length: bytes }, (_, i) => (i * 29 + 7) % 256);
const DRAWN_HEX = drawn(32).toHex();

type StorePaths = { root: string; folder: string; env: string; files: string };
const storeOf = (bench: Bench, slug: string): StorePaths => ({
  root: join(bench.secrets, "projects"),
  folder: join(bench.secrets, "projects", slug),
  env: join(bench.secrets, "projects", slug, "env"),
  files: join(bench.secrets, "projects", slug, "files"),
});

/** A unit as this release generates it: the store, its files loaded, the folder hidden. */
function storeUnit(bench: Bench, slug: string, extra: string[] = []): string {
  const store = storeOf(bench, slug);
  return [
    "[Service]",
    "Environment=PORT=3050",
    ...extra,
    `EnvironmentFile=-${store.env}`,
    `LoadCredential=files:${store.files}`,
    "ExecStart=/usr/local/bin/bun run server.ts",
    "InaccessiblePaths=-/etc/sitesolide",
    "ProtectProc=invisible",
    "",
  ].join("\n");
}

const SHOP = {
  start: "/usr/local/bin/bun run server.ts",
  port: 3050,
  publicDir: "public",
  env: { NODE_ENV: "production", DEFAULT_SENDER: "shop@test-zone.invalid" },
  secrets: { runtime: ["API_KEY", "SESSION_KEY"], files: ["gcp.json"], build: ["CMS_TOKEN"] },
};

/** An app deployed on the bench: its manifest and its unit, as this release lays them. */
function addStoreProject(bench: Bench, slug = "shop", manifest: Record<string, unknown> = SHOP): void {
  mkdirSync(join(bench.sites, slug), { recursive: true });
  writeFileSync(join(bench.sites, slug, "sitesolide.json"), JSON.stringify({ slug, ...manifest }));
  writeFileSync(join(bench.units, `${slug}.service`), storeUnit(bench, slug));
}

/** cms's unit as this release lays it. */
function cmsReadsStore(bench: Bench): void {
  writeFileSync(join(bench.units, "cms.service"), storeUnit(bench, "cms", ["Environment=DATA_DIR=/srv/sites/cms/data"]));
}

async function storeList(bench: Bench, slug: string): Promise<StoreView> {
  const response = await bench.call("GET", `/store?slug=${slug}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as StoreListResponse).store;
}

const b64 = (text: string) => new TextEncoder().encode(text).toBase64();
const modeOf = (path: string) => statSync(path).mode & 0o777;
/** The bench's clock moved past the cache of `systemctl show`, so that the next reading is fresh. */
const freshReadings = (bench: Bench) => {
  bench.clock.t += 3_000;
};

describe("a project's store: the owner's routes on the dashboard's socket", () => {
  test("GET /store lists names, sources and states, never a value; a store not made yet reads absent", async () => {
    const bench = await mount();
    addStoreProject(bench);
    const store = await storeList(bench, "shop");
    expect(store).toMatchObject({
      slug: "shop",
      exists: false,
      state: "absent",
      missing: ["API_KEY", "SESSION_KEY"],
      build: ["CMS_TOKEN"],
      unitReadsStore: true,
      previous: false,
      may: { write: true, reveal: true, restore: true },
    });
    expect(store.variables.map((variable) => [variable.name, variable.source, variable.declared])).toEqual([
      ["API_KEY", "none", true],
      ["SESSION_KEY", "none", true],
    ]);
    expect(store.files).toEqual([{ name: "gcp.json", state: "missing", declared: true, reason: null, bytes: null, modifiedAt: null, restartPending: false }]);
    expect(store.public).toEqual([
      { name: "NODE_ENV", value: "production" },
      { name: "DEFAULT_SENDER", value: "shop@test-zone.invalid" },
    ]);
    // Reading it creates nothing.
    expect(existsSync(storeOf(bench, "shop").root)).toBe(false);
    expect((await bench.call("GET", "/store")).status).toBe(400);
    expect((await bench.call("GET", "/store?slug=shop&slug=cms")).status).toBe(400);
  });

  test("PUT /store/variable lays the store, root's folders 0700 and its env 0600, and answers names alone, 201 when it made it", async () => {
    const bench = await mount();
    addStoreProject(bench);
    const token = await unlock(bench);
    const first = await bench.call("PUT", "/store/variable", { token, slug: "shop", name: "API_KEY", value: STORE_CANARY });
    expect(first.status).toBe(201);
    const answer = (await first.json()) as StoreChangeResponse;
    expect(answer).toMatchObject({ created: true, set: ["API_KEY"], generated: [], removed: [], absent: [], files: { set: [], removed: [] } });
    expect(answer.store.variables.find((variable) => variable.name === "API_KEY")).toMatchObject({ source: "store" });
    expect(JSON.stringify(answer)).not.toContain(STORE_CANARY);
    const store = storeOf(bench, "shop");
    expect([modeOf(store.root), modeOf(store.folder), modeOf(store.files), modeOf(store.env)]).toEqual([0o700, 0o700, 0o700, 0o600]);
    expect(readFileSync(store.env, "utf8")).toBe(`API_KEY=${STORE_CANARY}\n`);
    expect(readdirSync(store.files)).toEqual([]);
    expect(log(bench).slice(-2)).toMatchObject([
      { operation: "create", result: "ok", slug: "shop", file: "store", variable: null },
      { operation: "set", result: "ok", slug: "shop", file: "store", variable: "API_KEY" },
    ]);

    const second = await bench.call("PUT", "/store/variable", { token, slug: "shop", name: "SESSION_KEY", value: "x" });
    expect(second.status).toBe(200);
    expect(((await second.json()) as StoreChangeResponse).created).toBe(false);
    // Without the live unlock, nothing.
    expect((await bench.call("PUT", "/store/variable", { token: "x".repeat(43), slug: "shop", name: "A", value: "b" })).status).toBe(401);
    expect((await bench.call("PUT", "/store/variable", { slug: "shop", name: "A", value: "b" })).status).toBe(401);
    expect(readFileSync(store.env, "utf8")).toBe(`API_KEY=${STORE_CANARY}\nSESSION_KEY=x\n`);
  });

  test("DELETE /store/variable removes, says what the store did not hold, and keeps the version before", async () => {
    const bench = await mount();
    addStoreProject(bench);
    const token = await unlock(bench);
    await bench.call("PATCH", "/store", { token, slug: "shop", set: { A: "1", B: "2" }, remove: [] });
    const removed = await bench.call("DELETE", "/store/variable", { token, slug: "shop", names: ["A", "NEVER_SET"] });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ removed: ["A"], absent: ["NEVER_SET"], set: [] });
    expect(readFileSync(storeOf(bench, "shop").env, "utf8")).toBe("B=2\n");
    expect(readFileSync(join(bench.state, "precedents", "projects", "shop", "env"), "utf8")).toBe("A=1\nB=2\n");
    expect(log(bench).at(-1)).toMatchObject({ operation: "remove", result: "ok", file: "store", variable: "A" });
    // Removing every name leaves an empty env and every folder in place.
    await bench.call("DELETE", "/store/variable", { token, slug: "shop", names: ["B"] });
    expect(readFileSync(storeOf(bench, "shop").env, "utf8")).toBe("");
    expect(existsSync(storeOf(bench, "shop").files)).toBe(true);
    // Nothing to remove from a store that does not exist: nothing is made.
    addStoreProject(bench, "other");
    expect(await (await bench.call("DELETE", "/store/variable", { token, slug: "other", names: ["A"] })).json()).toMatchObject({ created: false, absent: ["A"] });
    expect(existsSync(storeOf(bench, "other").folder)).toBe(false);
  });

  test("PATCH /store is all or nothing: one name refused, nothing written, nothing made", async () => {
    const bench = await mount();
    addStoreProject(bench);
    const token = await unlock(bench);
    for (const [set, remove, message] of [
      [{ OK: "1", PATH: "x" }, [], "set: PATH changes how the runtime behaves, not what the site does, and cannot be set here"],
      [{ OK: "1", NODE_ENV: "development" }, [], "set: NODE_ENV changes how the runtime behaves, not what the site does, and cannot be set here"],
      [{ OK: "1", DEFAULT_SENDER: "x" }, [], "set: DEFAULT_SENDER is set by the service unit, a secret would silently override it"],
      [{ OK: "1", PASSWORD_HASH: "$argon2id$x" }, [], "PASSWORD_HASH is changed with Change password, in the dashboard's and the portal's files alone"],
      [{ OK: `${STORE_CANARY}\nINJECTED=1` }, [], "set: OK: the value must fit on one line"],
      [{ OK: "1" }, ["OK"], "OK is both set and removed: name it in one list"],
    ] as const) {
      const response = await bench.call("PATCH", "/store", { token, slug: "shop", set, remove });
      const failure = await errorOf(response);
      expect([response.status, failure.message]).toEqual([response.status === 403 ? 403 : 400, message]);
      expect(JSON.stringify(failure)).not.toContain(STORE_CANARY);
    }
    expect(existsSync(storeOf(bench, "shop").folder)).toBe(false);
    expect(log(bench).filter((entry) => entry.result === "rejects").every((entry) => entry.variable === null && entry.file === "store")).toBe(true);
  });

  test("POST /store/generate draws on the machine and answers the name alone; hex or base64url; never twice without replace", async () => {
    const bench = await mount({ random: drawn });
    addStoreProject(bench);
    const token = await unlock(bench);
    const made = await bench.call("POST", "/store/generate", { token, slug: "shop", name: "SESSION_KEY" });
    expect(made.status).toBe(201);
    const answer = (await made.json()) as StoreChangeResponse;
    expect(answer).toMatchObject({ created: true, generated: ["SESSION_KEY"], set: [] });
    expect(readFileSync(storeOf(bench, "shop").env, "utf8")).toBe(`SESSION_KEY=${DRAWN_HEX}\n`);
    expect(JSON.stringify(answer)).not.toContain(DRAWN_HEX);
    expect(log(bench).at(-1)).toMatchObject({ operation: "generate", result: "ok", file: "store", variable: "SESSION_KEY", detail: "hex" });
    expect(readFileSync(join(bench.state, "journal.jsonl"), "utf8")).not.toContain(DRAWN_HEX);

    const again = await bench.call("POST", "/store/generate", { token, slug: "shop", name: "SESSION_KEY" });
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toEqual({ error: "already-present", message: "SESSION_KEY is already set; --replace draws a new value in its place" });
    const replaced = await bench.call("POST", "/store/generate", { token, slug: "shop", name: "SESSION_KEY", format: "base64url", bytes: 16, replace: true });
    expect(replaced.status).toBe(200);
    expect(readFileSync(storeOf(bench, "shop").env, "utf8")).toBe(`SESSION_KEY=${drawn(16).toBase64({ alphabet: "base64url", omitPadding: true })}\n`);
    for (const extra of [{ format: "base64" }, { bytes: 8 }, { bytes: 65 }, { replace: "yes" }]) {
      expect((await bench.call("POST", "/store/generate", { token, slug: "shop", name: "OTHER", ...extra })).status).toBe(400);
    }
  });

  test("PUT /store/file and DELETE /store/file: a file read whole, root's 0600, its last version kept; the folder never removed", async () => {
    const bench = await mount();
    addStoreProject(bench);
    const token = await unlock(bench);
    const store = storeOf(bench, "shop");
    const set = await bench.call("PUT", "/store/file", { token, slug: "shop", name: "gcp.json", content: b64(FILE_CANARY) });
    expect(set.status).toBe(201);
    const answer = (await set.json()) as StoreChangeResponse;
    expect(answer.files).toEqual({ set: ["gcp.json"], removed: [] });
    expect(answer.store.files[0]).toMatchObject({ name: "gcp.json", state: "set", declared: true, bytes: FILE_CANARY.length });
    expect(JSON.stringify(answer)).not.toContain("file-canary");
    expect(readFileSync(join(store.files, "gcp.json"), "utf8")).toBe(FILE_CANARY);
    expect(modeOf(join(store.files, "gcp.json"))).toBe(0o600);
    // No temporary left where LoadCredential= reads.
    expect(readdirSync(store.files)).toEqual(["gcp.json"]);
    expect(log(bench).at(-1)).toMatchObject({ operation: "replace", result: "ok", file: "store/gcp.json", variable: null });

    // An undeclared file may be set: every unit loads the whole folder.
    expect((await bench.call("PUT", "/store/file", { token, slug: "shop", name: "extra.pem", content: b64("x") })).status).toBe(200);
    await bench.call("PUT", "/store/file", { token, slug: "shop", name: "gcp.json", content: b64("{}") });
    expect(readFileSync(join(bench.state, "precedents", "projects", "shop", "files", "gcp.json"), "utf8")).toBe(FILE_CANARY);

    for (const name of ["gcp.json", "extra.pem"]) {
      const removed = await bench.call("DELETE", "/store/file", { token, slug: "shop", name });
      expect(removed.status).toBe(200);
      expect(((await removed.json()) as StoreChangeResponse).files.removed).toEqual([name]);
    }
    // The last file gone, files/ stays, empty: every start of the project needs it (rule 7).
    expect(readdirSync(store.files)).toEqual([]);
    expect(existsSync(store.folder)).toBe(true);
    expect(log(bench).at(-1)).toMatchObject({ operation: "remove", result: "ok", file: "store/extra.pem" });
    expect(await errorOf(await bench.call("DELETE", "/store/file", { token, slug: "shop", name: "gcp.json" }))).toEqual({ error: "not-found", message: "gcp.json is not in the store" });
  });

  test("a file's name and size refused at each limit, the name never quoted", async () => {
    const bench = await mount();
    addStoreProject(bench);
    const token = await unlock(bench);
    for (const name of [".env", ".hidden.json", "sub/x.json", "../shop.env", "a..b", "x".repeat(65), "sk_live_pasted-as-a-file"]) {
      const response = await bench.call("PUT", "/store/file", { token, slug: "shop", name, content: b64("x") });
      if (name === "sk_live_pasted-as-a-file") {
        // A valid file name, whatever it looks like: a file name is no variable.
        expect(response.status).toBe(201);
        continue;
      }
      expect(response.status).toBe(400);
      expect((await errorOf(response)).message).not.toContain(name);
    }
    await bench.call("DELETE", "/store/file", { token, slug: "shop", name: "sk_live_pasted-as-a-file" });
    const full = new Uint8Array(64 * 1024).fill(65);
    expect((await bench.call("PUT", "/store/file", { token, slug: "shop", name: "k0", content: full.toBase64() })).status).toBe(200);
    expect((await errorOf(await bench.call("PUT", "/store/file", { token, slug: "shop", name: "big", content: new Uint8Array(64 * 1024 + 1).toBase64() }))).message).toBe(
      "content: a file is 64 KiB at most",
    );
    // 512 KiB in all: eight files of 64 KiB, and not one byte more.
    for (let i = 1; i < 8; i++) expect((await bench.call("PUT", "/store/file", { token, slug: "shop", name: `k${i}`, content: full.toBase64() })).status).toBe(200);
    expect(await errorOf(await bench.call("PUT", "/store/file", { token, slug: "shop", name: "one-more", content: b64("x") }))).toEqual({
      error: "invalid",
      message: "the store's files would weigh more than 512 KiB in all: remove one first",
    });
    // Replacing one by a smaller one still fits.
    expect((await bench.call("PUT", "/store/file", { token, slug: "shop", name: "k7", content: b64("small") })).status).toBe(200);
    // 32 files, and not one more.
    for (let i = 0; i < 8; i++) await bench.call("DELETE", "/store/file", { token, slug: "shop", name: `k${i}` });
    for (let i = 0; i < 32; i++) expect((await bench.call("PUT", "/store/file", { token, slug: "shop", name: `f${i}`, content: b64("x") })).status).toBe(200);
    expect((await errorOf(await bench.call("PUT", "/store/file", { token, slug: "shop", name: "f32", content: b64("x") }))).message).toBe(
      "the store would hold more than 32 files: remove one first",
    );
    expect(readdirSync(storeOf(bench, "shop").files).length).toBe(32);
  });

  test("POST /store/restore swaps the env and its previous version; a dry run says what would appear and disappear", async () => {
    const bench = await mount();
    addStoreProject(bench);
    const token = await unlock(bench);
    expect(await errorOf(await bench.call("POST", "/store/restore", { token, slug: "shop" }))).toMatchObject({ error: "not-found" });
    await bench.call("PUT", "/store/variable", { token, slug: "shop", name: "A", value: "1" });
    await bench.call("PUT", "/store/variable", { token, slug: "shop", name: "B", value: "2" });
    const dry = await bench.call("POST", "/store/restore", { token, slug: "shop", dryRun: true });
    expect(await dry.json()).toMatchObject({ appeared: [], disappeared: ["B"], restored: false });
    expect(readFileSync(storeOf(bench, "shop").env, "utf8")).toBe("A=1\nB=2\n");
    expect(await (await bench.call("POST", "/store/restore", { token, slug: "shop" })).json()).toMatchObject({ disappeared: ["B"], restored: true });
    expect(readFileSync(storeOf(bench, "shop").env, "utf8")).toBe("A=1\n");
    expect(log(bench).at(-1)).toMatchObject({ operation: "restore", result: "ok", file: "store" });
    // Twice comes back to the start.
    await bench.call("POST", "/store/restore", { token, slug: "shop" });
    expect(readFileSync(storeOf(bench, "shop").env, "utf8")).toBe("A=1\nB=2\n");
    // The first version of an env had none before it: restoring it empties the store.
    addStoreProject(bench, "fresh-app");
    await bench.call("PUT", "/store/variable", { token, slug: "fresh-app", name: "A", value: "1" });
    expect(await (await bench.call("POST", "/store/restore", { token, slug: "fresh-app", dryRun: true })).json()).toMatchObject({ disappeared: ["A"] });
  });

  test("POST /store/value: the owner's live unlock alone, journaled as a read, never over SSH", async () => {
    const bench = await mount();
    addStoreProject(bench);
    const token = await unlock(bench);
    await bench.call("PUT", "/store/variable", { token, slug: "shop", name: "API_KEY", value: STORE_CANARY });
    const read = await bench.call("POST", "/store/value", { token, slug: "shop", name: "API_KEY" });
    expect(await read.json()).toEqual({ value: STORE_CANARY });
    expect(log(bench).at(-1)).toMatchObject({ operation: "read", result: "ok", slug: "shop", file: "store", variable: "API_KEY" });
    expect((await bench.call("POST", "/store/value", { token: "x".repeat(43), slug: "shop", name: "API_KEY" })).status).toBe(401);
    expect(await errorOf(await bench.call("POST", "/store/value", { token, slug: "shop", name: "OTHER" }))).toEqual({ error: "not-found", message: "no such variable in the store of shop" });
    expect((await bench.owner("POST", "/store/value", { slug: "shop", name: "API_KEY" })).status).toBe(404);
  });

  test("a store laid ahead of the first deployment, for the owner", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    const made = await bench.call("PUT", "/store/variable", { token, slug: "not-yet", name: "API_KEY", value: "x" });
    expect(made.status).toBe(201);
    expect(await storeList(bench, "not-yet")).toMatchObject({ exists: true, state: "managed", unitReadsStore: null, variables: [{ name: "API_KEY", source: "store", declared: false }] });
  });

  test("storeless, static, the landing, a unit of the machine, a slug that is none: refused, nothing made", async () => {
    const bench = await mount();
    const token = await unlock(bench);
    for (const [slug, status, message] of [
      ["dashboard", 403, "dashboard keeps its password hash in dashboard.env, which its unit reads: it has no store"],
      ["portal", 403, "portal keeps its password hash in portal.env, which its unit reads: it has no store"],
      ["showcase", 403, "a static site has no service to read a store; its build secrets stay with whoever deploys"],
      ["landing", 403, "landing names the landing's account, never a project's store"],
      ["caddy", 403, "caddy names a unit of the machine, never a project"],
      ["test-zone.invalid", 400, "slug: a project's slug, lowercase letters, digits and dashes"],
      ["sk_live_pasted", 400, "slug: a project's slug, lowercase letters, digits and dashes"],
    ] as const) {
      const response = await bench.call("PUT", "/store/variable", { token, slug, name: "A", value: "1" });
      expect([slug, response.status, (await errorOf(response)).message]).toEqual([slug, status, message]);
    }
    expect(existsSync(join(bench.secrets, "projects"))).toBe(false);
    // The journal keeps a slug only when it has a site folder's shape, the landing's included.
    expect(log(bench).filter((entry) => entry.result === "rejects").map((entry) => entry.slug)).toEqual(["dashboard", "portal", "showcase", "landing", "caddy", "test-zone.invalid", null]);
  });

  test("the platform's own projects: the owner's", async () => {
    const bench = await mount();
    addStoreProject(bench, "analytics", { start: "/usr/local/bin/bun run server.ts", port: 3030 });
    const token = await unlock(bench);
    expect((await bench.call("PUT", "/store/variable", { token, slug: "analytics", name: "SALT_KEY", value: "x" })).status).toBe(201);
    expect((await bench.owner("PUT", "/store/variable", { slug: "analytics", name: "OTHER", value: "x" })).status).toBe(200);
  });
});

describe("a project's store: what refuses every write", () => {
  test("a symbolic link at each of its three folders refuses every write, and nothing lands through it", async () => {
    for (const part of ["root", "folder", "files"] as const) {
      const bench = await mount();
      addStoreProject(bench);
      const token = await unlock(bench);
      const store = storeOf(bench, "shop");
      const elsewhere = join(bench.root, "elsewhere");
      mkdirSync(elsewhere);
      if (part !== "root") mkdirSync(store.root, { mode: 0o700 });
      if (part === "files") mkdirSync(store.folder, { mode: 0o700 });
      symlinkSync(elsewhere, store[part]);
      const writes = [
        bench.call("PUT", "/store/variable", { token, slug: "shop", name: "A", value: STORE_CANARY }),
        bench.call("PATCH", "/store", { token, slug: "shop", set: { A: "1" }, remove: [] }),
        bench.call("POST", "/store/generate", { token, slug: "shop", name: "SESSION_KEY" }),
        bench.call("PUT", "/store/file", { token, slug: "shop", name: "gcp.json", content: b64(FILE_CANARY) }),
        bench.owner("PUT", "/store/variable", { slug: "shop", name: "A", value: STORE_CANARY }),
      ];
      for (const response of await Promise.all(writes)) {
        expect([part, response.status]).toEqual([part, 409]);
        expect((await errorOf(response)).message).toContain("is a symbolic link");
      }
      expect([part, readdirSync(elsewhere)]).toEqual([part, []]);
      expect((await storeList(bench, "shop")).state).toBe("unmanaged");
    }
  });

  test("a file where a folder goes, an env that is a link, open to others, or that does not parse: refused, the reason said", async () => {
    const bench = await mount();
    addStoreProject(bench);
    const token = await unlock(bench);
    const store = storeOf(bench, "shop");
    writeFileSync(store.root, "");
    expect((await errorOf(await bench.call("PUT", "/store/variable", { token, slug: "shop", name: "A", value: "1" }))).message).toContain("is not a folder");
    rmSync(store.root);

    await bench.call("PUT", "/store/variable", { token, slug: "shop", name: "A", value: "1" });
    chmodSync(store.env, 0o644);
    const open = await bench.call("PUT", "/store/variable", { token, slug: "shop", name: "B", value: "2" });
    expect(open.status).toBe(409);
    expect((await errorOf(open)).message).toContain("mode 644, expected 600");
    expect((await storeList(bench, "shop")).reason).toContain("env: mode 644");
    chmodSync(store.env, 0o600);
    writeFileSync(store.env, "export A=1\n", { mode: 0o600 });
    expect((await errorOf(await bench.call("PUT", "/store/variable", { token, slug: "shop", name: "B", value: "2" }))).message).toContain("line 1");
    rmSync(store.env);
    symlinkSync(join(bench.secrets, "dashboard-monitor.env"), store.env);
    expect((await errorOf(await bench.call("POST", "/store/generate", { token, slug: "shop", name: "B" }))).message).toContain("symbolic link");
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe(MONITOR_ENV);
  });

  test("a file of the store that is a link or open to others is not managed: its name refuses writes, the others do not", async () => {
    const bench = await mount();
    addStoreProject(bench);
    const token = await unlock(bench);
    await bench.call("PUT", "/store/file", { token, slug: "shop", name: "ok.pem", content: b64("x") });
    const store = storeOf(bench, "shop");
    symlinkSync(join(bench.secrets, "dashboard-monitor.env"), join(store.files, "gcp.json"));
    const refused = await bench.call("PUT", "/store/file", { token, slug: "shop", name: "gcp.json", content: b64("y") });
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).message).toBe("gcp.json in the store is not managed here: symbolic link");
    expect((await bench.call("DELETE", "/store/file", { token, slug: "shop", name: "gcp.json" })).status).toBe(409);
    expect((await bench.call("PUT", "/store/file", { token, slug: "shop", name: "ok.pem", content: b64("z") })).status).toBe(200);
    expect(readFileSync(join(bench.secrets, "dashboard-monitor.env"), "utf8")).toBe(MONITOR_ENV);
    expect((await storeList(bench, "shop")).files.find((file) => file.name === "gcp.json")).toMatchObject({ state: "unmanaged", reason: "symbolic link", bytes: null });
  });
});

describe("the owner's socket: the store over SSH", () => {
  test("every route but the value, no unlock asked: root has asked", async () => {
    const bench = await mount({ random: drawn });
    addStoreProject(bench);
    expect((await bench.owner("PUT", "/store/variable", { slug: "shop", name: "API_KEY", value: STORE_CANARY })).status).toBe(201);
    expect((await bench.owner("PATCH", "/store", { slug: "shop", set: { A: "1" }, remove: [] })).status).toBe(200);
    expect((await bench.owner("POST", "/store/generate", { slug: "shop", name: "SESSION_KEY" })).status).toBe(200);
    expect((await bench.owner("PUT", "/store/file", { slug: "shop", name: "gcp.json", content: b64(FILE_CANARY) })).status).toBe(200);
    expect((await bench.owner("DELETE", "/store/file", { slug: "shop", name: "gcp.json" })).status).toBe(200);
    expect((await bench.owner("DELETE", "/store/variable", { slug: "shop", names: ["A"] })).status).toBe(200);
    expect(await (await bench.owner("POST", "/store/restore", { slug: "shop", dryRun: true })).json()).toMatchObject({ appeared: ["A"] });
    const listed = (await (await bench.owner("GET", "/store?slug=shop")).json()) as StoreListResponse;
    expect(listed.store.may).toEqual({ write: true, reveal: false, restore: true });
    expect(JSON.stringify(listed)).not.toContain(STORE_CANARY);
    expect(JSON.stringify(listed)).not.toContain(DRAWN_HEX);
    // Unknown fields refused, the token's place included.
    expect((await bench.owner("PUT", "/store/variable", { slug: "shop", name: "A", value: "1", token: "x" })).status).toBe(400);
    expect(log(bench).find((entry) => entry.operation === "set" && entry.variable === "API_KEY")).toMatchObject({ actor: "owner" });
  });

  test("a store laid ahead of a deployment, over SSH", async () => {
    const bench = await mount();
    expect((await bench.owner("PUT", "/store/variable", { slug: "not-yet", name: "A", value: "1" })).status).toBe(201);
    expect(log(bench).filter((entry) => entry.operation === "create").map((entry) => [entry.operation, entry.actor, entry.slug])).toEqual([["create", "owner", "not-yet"]]);
  });

  test("POST /restart restarts a project's service, whatever files it reads, the platform's too", async () => {
    const bench = await mount();
    const restarted = await bench.owner("POST", "/restart", { slug: "library" });
    expect(restarted.status).toBe(200);
    expect(((await restarted.json()) as RestartResponse).verdict.kind).toBe("active");
    expect(bench.systemctlCalls.slice(0, 2)).toEqual([
      ["reset-failed", "library"],
      ["restart", "library"],
    ]);
    expect(log(bench).at(-1)).toMatchObject({ operation: "restart", result: "ok", actor: "owner", slug: "library" });
    expect((await bench.owner("POST", "/restart", { slug: "showcase" })).status).toBe(404);
    expect((await bench.owner("POST", "/restart", { slug: 42 })).status).toBe(400);
  });
});

describe("the units this release generates read the store as the steward expects", () => {
  test("every service unit reads the store and loads its files: the store is in effect, a restart applies it", async () => {
    const bench = await mount();
    const lab = { slug: "lab", services: { web: { start: "/usr/local/bin/bun run server.ts", port: 3052 }, job: { start: "/bin/true", schedule: "daily" } }, secrets: ["LAB_KEY"] };
    mkdirSync(join(bench.sites, "lab"), { recursive: true });
    writeFileSync(join(bench.sites, "lab", "sitesolide.json"), JSON.stringify(lab));
    // The units as the generator writes them, the machine's folder of secrets being the bench's.
    for (const { unit, text } of generateUnits(lab as Manifest, { slug: "lab", zone: "test-zone.invalid", contact: "" })) {
      if (unit.endsWith(".timer")) continue;
      writeFileSync(join(bench.units, `${unit}.service`), text.replaceAll("/etc/sitesolide", bench.secrets));
    }
    expect(await storeList(bench, "lab")).toMatchObject({ unitReadsStore: true, missing: ["LAB_KEY"], variables: [{ name: "LAB_KEY", source: "none", declared: true }] });
    const token = await unlock(bench);
    expect((await bench.call("PUT", "/store/variable", { token, slug: "lab", name: "LAB_KEY", value: "from-the-store" })).status).toBe(201);
    expect((await storeList(bench, "lab")).variables[0]).toEqual({ name: "LAB_KEY", source: "store", declared: true });
    expect((await bench.call("POST", "/restart", { token, slug: "lab" })).status).toBe(200);
  });
});

describe("a restart that cannot load the store's files (I-6)", () => {
  test("a service looping on exit 243 is worded as deploy and the monitor word it, the journal saying 243/CREDENTIALS", async () => {
    const bench = await mount();
    addStoreProject(bench);
    const token = await unlock(bench);
    bench.scenario.current = (_unit, since) => `LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nNRestarts=${Math.floor(since / 2000) + 1}\nActiveEnterTimestamp=\nExecMainStatus=243\n`;
    const restarted = (await (await bench.call("POST", "/restart", { token, slug: "shop" })).json()) as RestartResponse;
    expect(restarted.verdict).toMatchObject({
      kind: "looping",
      reason: "shop.service could not load its secret files (243/CREDENTIALS): the store's files folder is missing, or its files are too large; sitesolide refresh shop lays the folder again",
    });
    expect(log(bench).at(-1)).toMatchObject({ operation: "restart", result: "failure", detail: expect.stringMatching(/^looping, .*, 243\/CREDENTIALS$/) });
    // The same through the owner's socket and a token.
    expect(((await (await bench.owner("POST", "/restart", { slug: "shop" })).json()) as RestartResponse).verdict.reason).toStartWith("shop.service could not load its secret files");
    const ops = bench.current().secretsForToken!;
    const byToken = await ops.restart(new Request("http://steward/control/restart", { method: "POST" }), "shop", { actor: "token:0123456789ab", member: null, token: "0123456789ab" }, async () => null);
    expect(((await byToken.json()) as RestartResponse).verdict.reason).toStartWith("shop.service could not load its secret files");
    // Another exit status is not worded so.
    bench.scenario.current = () => "LoadState=loaded\nActiveState=failed\nSubState=failed\nNRestarts=0\nActiveEnterTimestamp=\nExecMainStatus=1\n";
    expect(((await (await bench.call("POST", "/restart", { token, slug: "shop" })).json()) as RestartResponse).verdict.reason).toBeUndefined();
  });
});

describe("a restart applies the store", () => {
  test("a unit that reads its project's store is restarted from the Secrets section", async () => {
    const bench = await mount();
    addStoreProject(bench);
    const token = await unlock(bench);
    expect((await bench.call("POST", "/restart", { token, slug: "shop" })).status).toBe(200);
    // Its files alone are enough too.
    writeFileSync(join(bench.units, "shop.service"), `[Service]\nLoadCredential=files:${storeOf(bench, "shop").files}\n`);
    expect((await bench.call("POST", "/restart", { token, slug: "shop" })).status).toBe(200);
    // Another project's store is not its own.
    writeFileSync(join(bench.units, "shop.service"), `[Service]\nEnvironmentFile=-${storeOf(bench, "cms").env}\n`);
    expect((await errorOf(await bench.call("POST", "/restart", { token, slug: "shop" }))).message).toContain("reads none of the managed files nor its project's store");
  });

  test("a change after the service started is pending; the anchor of a scheduled project waits for nothing", async () => {
    const bench = await mount();
    addStoreProject(bench);
    const token = await unlock(bench);
    await bench.call("PUT", "/store/variable", { token, slug: "shop", name: "API_KEY", value: "x" });
    expect((await storeList(bench, "shop")).restartPending).toBe(true);
    bench.scenario.current = () => showA("active", "running", 0, Date.now() + 1_000);
    freshReadings(bench);
    expect((await storeList(bench, "shop")).restartPending).toBe(false);
  });
});

describe("GET /projects carries each project's store", () => {
  test("an app's; null for a static site, a storeless project and the landing", async () => {
    const bench = await mount();
    addStoreProject(bench);
    const all = await projects(bench);
    const store = (slug: string) => all.find((project) => project.slug === slug)!.store;
    expect(store("shop")).toMatchObject({ slug: "shop", exists: false, missing: ["API_KEY", "SESSION_KEY"] });
    expect(store("cms")).toMatchObject({ slug: "cms", exists: false, unitReadsStore: true, missing: ["SID", "TOKEN"] });
    for (const slug of ["showcase", "dashboard", "portal", "test-zone.invalid"]) expect([slug, store(slug)]).toEqual([slug, null]);
  });
});

describe("a token's store, handed over by the control routes", () => {
  const TOKEN = { actor: "token:0123456789ab", member: null, token: "0123456789ab" };
  const still = async () => null;
  const request = () => new Request("http://steward/control/store", { method: "PATCH" });

  test("lists, sets, generates, sets and removes a file: a Developer's view, names alone, journaled under the token", async () => {
    const bench = await mount({ random: drawn });
    addStoreProject(bench);
    const ops = bench.current().storeForToken!;
    const changed = await ops.change(request(), { slug: "shop", set: [["API_KEY", STORE_CANARY]], remove: [] }, TOKEN, false, still);
    expect(changed.status).toBe(201);
    const generated = await ops.generate(request(), { slug: "shop", name: "SESSION_KEY" }, TOKEN, false, still);
    expect(generated.status).toBe(200);
    const filed = await ops.setFile(request(), { slug: "shop", name: "gcp.json", content: b64(FILE_CANARY) }, TOKEN, false, still);
    expect(filed.status).toBe(200);
    const listed = (await (await ops.list("shop", TOKEN, false)).json()) as StoreListResponse;
    expect(listed.store.may).toEqual({ write: true, reveal: false, restore: false });
    expect(listed.store.previous).toBe(false);
    expect(listed.store.files[0]).toMatchObject({ name: "gcp.json", state: "set", bytes: null });
    const removed = await ops.removeFile(request(), { slug: "shop", name: "gcp.json" }, TOKEN, still);
    expect(removed.status).toBe(200);
    const texts = await Promise.all([changed, generated, filed, removed].map((response) => response.text()));
    for (const text of [...texts, JSON.stringify(listed)]) {
      for (const value of [STORE_CANARY, DRAWN_HEX, "file-canary"]) expect(text).not.toContain(value);
    }
    expect(log(bench).filter((entry) => entry.slug === "shop").map((entry) => [entry.operation, entry.actor, entry.file, entry.variable])).toEqual([
      ["create", TOKEN.actor, "store", null],
      ["set", TOKEN.actor, "store", "API_KEY"],
      ["generate", TOKEN.actor, "store", "SESSION_KEY"],
      ["replace", TOKEN.actor, "store/gcp.json", null],
      ["remove", TOKEN.actor, "store/gcp.json", null],
    ]);
  });

  test("ahead of a deployment only when the control routes let it create the slug; never the platform's", async () => {
    const bench = await mount();
    const ops = bench.current().storeForToken!;
    const refused = await ops.change(request(), { slug: "fresh", set: [["A", "1"]], remove: [] }, TOKEN, false, still);
    expect(await errorOf(refused)).toEqual({ error: "not-found", message: "fresh is not a project deployed on this machine" });
    expect(log(bench).at(-1)).toMatchObject({ operation: "set", result: "rejects", actor: TOKEN.actor, slug: "fresh" });
    expect(await errorOf(await ops.list("fresh", TOKEN, false))).toMatchObject({ error: "not-found" });
    expect(log(bench).at(-1)).toMatchObject({ operation: "list", result: "rejects", actor: TOKEN.actor });
    const made = await ops.change(request(), { slug: "fresh", set: [["A", "1"]], remove: [] }, TOKEN, true, still);
    expect(made.status).toBe(201);
    expect(readFileSync(storeOf(bench, "fresh").env, "utf8")).toBe("A=1\n");
    addStoreProject(bench, "analytics", { start: "/usr/local/bin/bun run server.ts", port: 3030 });
    for (const slug of ["analytics", "dashboard"]) {
      expect((await ops.change(request(), { slug, set: [["A", "1"]], remove: [] }, TOKEN, true, still)).status).toBe(403);
    }
    expect(existsSync(storeOf(bench, "analytics").folder)).toBe(false);
  });

  test("a refusal under the lock comes back as it stands, and nothing is written", async () => {
    const bench = await mount();
    addStoreProject(bench);
    const ops = bench.current().storeForToken!;
    const revoked = async () => Response.json({ error: "unauthenticated", message: "this token was revoked" }, { status: 401 });
    expect((await ops.change(request(), { slug: "shop", set: [["A", "1"]], remove: [] }, TOKEN, false, revoked)).status).toBe(401);
    expect((await ops.generate(request(), { slug: "shop", name: "A" }, TOKEN, false, revoked)).status).toBe(401);
    expect((await ops.setFile(request(), { slug: "shop", name: "a.pem", content: b64("x") }, TOKEN, false, revoked)).status).toBe(401);
    expect(existsSync(storeOf(bench, "shop").folder)).toBe(false);
  });
});

describe("no store value outside /store/value (I1): the canary", () => {
  test("a value set through every write route never appears in an answer, a journal line, the access log or the console", async () => {
    const printed: string[] = [];
    const original = { log: console.log, error: console.error, warn: console.warn };
    const capture = (...parts: unknown[]) => {
      printed.push(parts.map(String).join(" "));
    };
    console.log = capture;
    console.error = capture;
    console.warn = capture;
    try {
      const bench = await mount({ random: drawn });
      addStoreProject(bench);
      cmsReadsStore(bench);
      const token = await unlock(bench);
      const TOKEN = { actor: "token:0123456789ab", member: null, token: "0123456789ab" };
      const ops = bench.current().storeForToken!;
      const request = () => new Request("http://steward/control/store", { method: "PATCH" });
      const answers: string[] = [];
      const keep = async (response: Response | Promise<Response>) => answers.push(await (await response).text());

      // Every write route, the owner's, root's and a token's; set, refused, removed.
      await keep(bench.call("PUT", "/store/variable", { token, slug: "shop", name: "API_KEY", value: STORE_CANARY }));
      await keep(bench.call("PATCH", "/store", { token, slug: "shop", set: { SESSION_KEY: `${STORE_CANARY}-2`, PATH: STORE_CANARY }, remove: [] }));
      await keep(bench.call("PATCH", "/store", { token, slug: "shop", set: { SESSION_KEY: `${STORE_CANARY}-2` }, remove: [] }));
      await keep(bench.call("PUT", "/store/variable", { token, slug: "shop", name: STORE_CANARY.replace(/-/g, "_"), value: STORE_CANARY }));
      await keep(bench.call("PUT", "/store/variable", { token, slug: "shop", name: "BROKEN", value: `${STORE_CANARY}\n` }));
      await keep(bench.call("POST", "/store/generate", { token, slug: "shop", name: "GENERATED" }));
      await keep(bench.call("PUT", "/store/file", { token, slug: "shop", name: "gcp.json", content: b64(FILE_CANARY) }));
      await keep(bench.owner("PUT", "/store/variable", { slug: "shop", name: "BY_ROOT", value: `${STORE_CANARY}-root` }));
      await keep(bench.owner("PUT", "/store/file", { slug: "shop", name: "root.pem", content: b64(FILE_CANARY) }));
      await keep(ops.change(request(), { slug: "shop", set: [["BY_TOKEN", `${STORE_CANARY}-token`]], remove: [] }, TOKEN, false, async () => null));
      await keep(ops.setFile(request(), { slug: "shop", name: "token.pem", content: b64(FILE_CANARY) }, TOKEN, false, async () => null));
      await keep(ops.generate(request(), { slug: "shop", name: "TOKEN_DRAWN", replace: true }, TOKEN, false, async () => null));
      await keep(bench.call("POST", "/store/restore", { token, slug: "shop", dryRun: true }));
      await keep(bench.call("POST", "/store/restore", { token, slug: "shop" }));
      await keep(bench.call("POST", "/store/restore", { token, slug: "shop" }));
      await keep(bench.call("DELETE", "/store/variable", { token, slug: "shop", names: ["API_KEY"] }));
      await keep(bench.call("DELETE", "/store/file", { token, slug: "shop", name: "gcp.json" }));
      // Every listing.
      await keep(bench.call("GET", "/store?slug=shop"));
      await keep(bench.call("GET", "/store?slug=cms"));
      await keep(bench.call("GET", "/projects"));
      await keep(bench.owner("GET", "/store?slug=shop"));
      await keep(ops.list("shop", TOKEN, false));
      await keep(bench.call("GET", "/log"));

      // The one read: the owner's, unlocked.
      const revealed = (await (await bench.call("POST", "/store/value", { token, slug: "shop", name: "BY_ROOT" })).json()) as StoreRevealResponse;
      expect(revealed.value).toBe(`${STORE_CANARY}-root`);
      const generated = (await (await bench.call("POST", "/store/value", { token, slug: "shop", name: "GENERATED" })).json()) as StoreRevealResponse;
      expect(generated.value).toBe(DRAWN_HEX);

      const journal = readFileSync(join(bench.state, "journal.jsonl"), "utf8");
      const accessLog = existsSync(join(bench.state, "access-log.jsonl")) ? readFileSync(join(bench.state, "access-log.jsonl"), "utf8") : "";
      for (const forbidden of [STORE_CANARY, DRAWN_HEX, "file-canary", SECRET_SID, SECRET_TOKEN]) {
        for (const text of [...answers, ...bench.renderedTexts, journal, accessLog, ...printed]) expect(text).not.toContain(forbidden);
      }
      // The journal has what was done, by name.
      const operations = log(bench).map((entry) => entry.operation);
      for (const operation of ["create", "set", "generate", "replace", "remove", "restore", "read"] as const) expect(operations).toContain(operation);
    } finally {
      console.log = original.log;
      console.error = original.error;
      console.warn = original.warn;
    }
  });
});
