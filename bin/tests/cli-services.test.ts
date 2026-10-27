import { describe, expect, test } from "bun:test";
import { generateFragment } from "../cli/fragment";
import {
  DEFAULT_TIMEOUT,
  isAnchored,
  isApp,
  isHeadless,
  mainPort,
  routesOverlap,
  scheduledServices,
  servicesOf,
  validate,
  type Manifest,
} from "../cli/manifest";
import { removalActions } from "../cli/removal";
import {
  MARKER_DONE,
  foreignUnit,
  listUnitsCommand,
  readUnitOrigins,
  unitOriginsCommand,
  projectPortsCommand,
  readCurrentPairs,
  domainConflicts,
  portConflicts,
  laterBlockPorts,
  readLoopbackState,
  readScheduleCheck,
  readSecondBlockState,
  secondBlockRefusal,
  secondBlockStateCommand,
  unguardedUnits,
  unguardedWarning,
  describeListener,
  readAccounts,
  readListeners,
  strayListeners,
  type SecondBlockState,
  readStability,
  readUidsAnswer,
  readUnitsAnswer,
  removeUnitsCommand,
  scheduleCheckCommand,
  stabilityCommand,
  staleUnits,
  uidsCommand,
  unstableUnits,
} from "../cli/services";
import { BIND_LINES_FEATURE, generateUnit, generateUnits, unitArgument, unitFileName, unitNames, withoutLaterBlockLines } from "../cli/unit";
import { loopbackRule, projectPortPairs, projectPortsFile } from "../cli/loopback";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A project of several processes, shaped like the one that asked for them: a
 * web front, an OpenAI-compatible API under /v1 and an inference server only
 * the API calls.
 */
const LAB: Manifest = {
  slug: "lab",
  install: "/usr/local/bin/uv sync --frozen --no-dev",
  env: { LAB_DB: "/srv/sites/{slug}/data/lab.db", LAB_URL: "https://{slug}.{zone}" },
  secrets: ["LAB_TOKEN"],
  memory: "512M",
  services: {
    platform: { start: "/srv/sites/lab/app/.venv/bin/python -m lab.platform --port 3050", port: 3050 },
    api: { start: "/srv/sites/lab/app/.venv/bin/python -m lab.api --port 3051", port: 3051, routes: ["/v1/*"] },
    inference: {
      start: "/srv/sites/lab/app/.venv/bin/python -m lab.inference --port 3052",
      port: 3052,
      internal: true,
      memory: "1G",
      env: { LAB_THREADS: "1" },
    },
  },
};

const APP: Manifest = { slug: "budget", port: 3022, start: "/usr/local/bin/bun run server.ts" };

/** LAB with its services replaced, the rest kept. */
function lab(services: Record<string, unknown>, extra: Partial<Manifest> = {}): Manifest {
  return { ...LAB, ...extra, services: services as Manifest["services"] };
}

describe("the services key", () => {
  test("a project of several services is valid, and an application", () => {
    expect(validate(LAB)).toEqual([]);
    expect(isApp(LAB)).toBe(true);
  });

  test("the first service keeps the slug as its unit, the others take <slug>.<name>", () => {
    expect(servicesOf(LAB).map((service) => service.unit)).toEqual(["lab", "lab.api", "lab.inference"]);
    expect(mainPort(LAB)).toBe(3050);
  });

  test("a single start reads as one service named after the project", () => {
    const [only] = servicesOf(APP);
    expect(servicesOf(APP)).toHaveLength(1);
    expect(only).toMatchObject({ name: null, unit: "budget", port: 3022, internal: false, memory: "256M" });
    expect(mainPort(APP)).toBe(3022);
    expect(servicesOf({ slug: "notes", publicDir: "dist" })).toEqual([]);
  });

  test("memory and env: the service's own, over the project's", () => {
    const [platform, , inference] = servicesOf(LAB);
    expect(platform!.memory).toBe("512M");
    expect(inference!.memory).toBe("1G");
    expect(inference!.env).toEqual({ ...LAB.env, LAB_THREADS: "1" });
  });

  test("start, port and routes are declared per service, never beside services", () => {
    const errors = validate({ ...LAB, start: "x", port: 3060, routes: ["/a"] });
    for (const key of ["start", "port", "routes"]) {
      expect(errors).toContainEqual(expect.stringContaining(`${key}: declared per service`));
    }
  });

  test("an empty or malformed services is refused", () => {
    expect(validate(lab({}))).toContainEqual(expect.stringContaining("services: an object"));
    expect(validate({ ...LAB, services: [] as unknown as Manifest["services"] })).toContainEqual(
      expect.stringContaining("services: an object"),
    );
    expect(validate(lab({ web: "run" }, { publicDir: "public" }))).toContainEqual(
      expect.stringContaining("services.web: an object"),
    );
  });

  test("a service name that could not be a unit or a matcher is refused", () => {
    // A unit type would be read as such by systemctl, `lab.socket` being a
    // socket; a leading digit would sort first and become the main service.
    for (const name of ["Web", "web_1", "-web", "web.api", "a".repeat(33), "socket", "timer", "service", "2", "9web"]) {
      expect(validate(lab({ [name]: { start: "/x", port: 3050 } }))).toContainEqual(
        expect.stringContaining(`services: "${name}"`),
      );
    }
  });

  test("an unknown key of a service is refused, like the manifest's", () => {
    expect(validate(lab({ web: { start: "/x", port: 3050, portal: true } }))).toContainEqual(
      expect.stringContaining("services.web.portal: unknown key"),
    );
  });

  test("every port sits in the closed range, once per project", () => {
    expect(validate(lab({ web: { start: "/x", port: 8000 } }))).toContainEqual(
      expect.stringContaining("services.web.port: inside 3000 to 3099 or 21000 to 29999"),
    );
    expect(validate(lab({ web: { start: "/x" } }))).toContainEqual(expect.stringContaining("services.web.port: required"));
    expect(
      validate(lab({ web: { start: "/x", port: 3050 }, api: { start: "/y", port: 3050, routes: ["/v1/*"] } })),
    ).toContainEqual(expect.stringContaining("3050 is already the port of web"));
  });

  test("start is required", () => {
    expect(validate(lab({ web: { port: 3050 } }))).toContainEqual(expect.stringContaining("services.web.start: required"));
  });

  test("a line break in a value written into the unit is refused, which would add a directive", () => {
    expect(validate(lab({ web: { start: "/x\nUser=root", port: 3050 } }))).toContainEqual(
      expect.stringContaining("services.web.start: a single line"),
    );
    expect(validate(lab({ web: { start: "/x", port: 3050, env: { MODE: "a\nUser=root" } } }))).toContainEqual(
      expect.stringContaining("services.web.env: the value of MODE must hold on one line"),
    );
    expect(validate({ ...APP, start: "/x\nUser=root" })).toContainEqual(expect.stringContaining("start: a single line"));
    expect(validate({ ...APP, env: { MODE: "a\rb" } })).toContainEqual(expect.stringContaining("env: the value of MODE"));
  });

  test("one service takes the rest, never two, and one must without publicDir", () => {
    const two = lab({ web: { start: "/x", port: 3050 }, admin: { start: "/y", port: 3051 } });
    expect(validate(two)).toContainEqual(expect.stringContaining("web, admin would all take every path left"));

    const none = lab({ api: { start: "/x", port: 3051, routes: ["/v1/*"] } });
    expect(validate(none)).toContainEqual(expect.stringContaining("without publicDir, one public service"));
    // A publicDir serves the rest instead.
    expect(validate({ ...none, publicDir: "public" })).toEqual([]);
  });

  test("an internal service carries no route, and is not the one taking the rest", () => {
    expect(
      validate(lab({ web: { start: "/x", port: 3050 }, jobs: { start: "/y", port: 3051, internal: true, routes: ["/jobs/*"] } })),
    ).toContainEqual(expect.stringContaining("services.jobs.routes: an internal service"));
    // Every service internal and no publicDir: a project that serves no page,
    // whose address says so, see isHeadless.
    expect(validate(lab({ jobs: { start: "/y", port: 3051, internal: true } }))).toEqual([]);
    expect(validate(lab({ web: { start: "/x", port: 3050, internal: "yes" } }))).toContainEqual(
      expect.stringContaining("services.web.internal: true, or absent"),
    );
  });

  test("a route that would cut the Caddy line, or reach the portal, is refused", () => {
    for (const route of ["v1/*", "/v1 /admin", '/v1"', "/_portal/x", ""]) {
      expect(
        validate(lab({ web: { start: "/x", port: 3050 }, api: { start: "/y", port: 3051, routes: [route] } })),
      ).toContainEqual(expect.stringContaining("services.api.routes"));
    }
  });

  test("two services whose routes could match the same request are refused", () => {
    const overlapping = lab({
      web: { start: "/x", port: 3050 },
      api: { start: "/y", port: 3051, routes: ["/v1/*"] },
      admin: { start: "/z", port: 3052, routes: ["/v1/admin/*"] },
    });
    expect(validate(overlapping)).toContainEqual(expect.stringContaining("could match the same request"));
  });

  test("a service's env follows the manifest's rules", () => {
    expect(
      validate(lab({ web: { start: "/x", port: 3050, env: { API_TOKEN: "x", PORT: "1" } } })),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("services.web.env: API_TOKEN looks like a secret"),
        expect.stringContaining("services.web.env: PORT is set by the deployment"),
      ]),
    );
  });

  test("a service's memory follows the manifest's rules", () => {
    expect(validate(lab({ web: { start: "/x", port: 3050, memory: "1024" } }))).toContainEqual(
      expect.stringContaining("services.web.memory"),
    );
  });

  test("a broken entry does not break the reading, only the validation", () => {
    const broken = lab({ web: { start: "/x", port: 3050 }, bad: null });
    expect(servicesOf(broken).map((service) => service.unit)).toEqual(["lab"]);
  });
});

describe("workers and scheduled services", () => {
  /** A front, a queue consumer that listens on nothing, and a sync every quarter of an hour. */
  const MIXED = lab({
    sync: { start: "/srv/sites/lab/app/sync", schedule: "*:0/15", timeout: "5m" },
    web: { start: "/srv/sites/lab/app/web", port: 3050 },
    queue: { start: "/srv/sites/lab/app/queue", internal: true },
  });

  test("an internal service without a port is a worker, which listens on nothing", () => {
    const manifest = lab({ web: { start: "/x", port: 3050 }, queue: { start: "/y", internal: true } });
    expect(validate(manifest)).toEqual([]);
    expect(servicesOf(manifest)[1]).toMatchObject({ name: "queue", unit: "lab.queue", kind: "worker", port: null, internal: true, schedule: null, timeout: null });
    expect(servicesOf(manifest)[0]).toMatchObject({ kind: "server", port: 3050 });
  });

  test("a service without a port that is not internal is refused: Caddy would have nothing to reach", () => {
    expect(validate(lab({ web: { start: "/x", port: 3050 }, queue: { start: "/y" } }))).toContainEqual(
      expect.stringContaining('services.queue.port: required, the loopback port the service listens on; a worker that listens on nothing says "internal": true'),
    );
  });

  test("a service with a schedule is scheduled: internal, no port, an hour at most per run unless it says otherwise", () => {
    expect(validate(MIXED)).toEqual([]);
    const sync = servicesOf(MIXED).find((service) => service.name === "sync")!;
    expect(sync).toMatchObject({ kind: "scheduled", port: null, internal: true, schedule: "*:0/15", timeout: "5m" });
    const plain = lab({ web: { start: "/x", port: 3050 }, sync: { start: "/y", schedule: "hourly" } });
    expect(servicesOf(plain)[1]).toMatchObject({ kind: "scheduled", schedule: "hourly", timeout: DEFAULT_TIMEOUT });
    // Saying it is internal changes nothing.
    expect(validate(lab({ web: { start: "/x", port: 3050 }, sync: { start: "/y", schedule: "daily", internal: true } }))).toEqual([]);
  });

  test("what a scheduled service may not carry: a port, a backup command, a route", () => {
    const errors = validate(
      lab({
        web: { start: "/x", port: 3050 },
        sync: { start: "/y", schedule: "hourly", port: 3051, backup: { folder: "db", command: "/z" }, routes: ["/sync/*"] },
      }),
    );
    expect(errors).toContainEqual(expect.stringContaining("services.sync.port: a scheduled service listens on nothing"));
    expect(errors).toContainEqual(expect.stringContaining("services.sync.backup: a scheduled service keeps no live folder"));
    expect(errors).toContainEqual(expect.stringContaining("services.sync.routes: an internal service"));
  });

  test("a timeout belongs to a scheduled service alone, from a second to a day", () => {
    expect(validate(lab({ web: { start: "/x", port: 3050, timeout: "5m" } }))).toContainEqual(
      expect.stringContaining("services.web.timeout: only a scheduled service has one"),
    );
    for (const timeout of ["90s", "15m", "15min", "2h", "24h"]) {
      expect(validate(lab({ web: { start: "/x", port: 3050 }, sync: { start: "/y", schedule: "hourly", timeout } }))).toEqual([]);
    }
    for (const timeout of ["0s", "25h", "2d", "90", "1.5h", "1 h", "", 60]) {
      expect(validate(lab({ web: { start: "/x", port: 3050 }, sync: { start: "/y", schedule: "hourly", timeout } }))).toContainEqual(
        expect.stringContaining("services.sync.timeout: how long one run may take"),
      );
    }
  });

  test("a schedule is written into the timer as it is: one line of what a calendar expression uses, nothing systemd or a shell reads", () => {
    for (const schedule of ["hourly", "daily", "*:0/15", "Mon..Fri 08:00", "*-*-* 06:30:00 Europe/Paris", "Mon,Wed *-*-* 12:00", "*:00/5"]) {
      expect(validate(lab({ web: { start: "/x", port: 3050 }, sync: { start: "/y", schedule } }))).toEqual([]);
    }
    for (const schedule of ["", " hourly", "hourly ", "hourly\nUser=root", "%H:00", "daily\\", '"daily"', "daily; reboot", "$(reboot)", "`reboot`", "x".repeat(129), 15]) {
      expect(validate(lab({ web: { start: "/x", port: 3050 }, sync: { start: "/y", schedule } }))).toContainEqual(
        expect.stringContaining("services.sync.schedule: a systemd calendar expression"),
      );
    }
  });

  test("cpu: a share of one core, the service's own over the project's", () => {
    const capped = lab({ web: { start: "/x", port: 3050, cpu: "50%" }, queue: { start: "/y", internal: true } }, { cpu: "200%" });
    expect(validate(capped)).toEqual([]);
    expect(servicesOf(capped).map((service) => service.cpu)).toEqual(["50%", "200%"]);
    expect(servicesOf(LAB).map((service) => service.cpu)).toEqual([null, null, null]);
    for (const cpu of ["50", "0%", "6500%", "half", "50 %", "1.5%"]) {
      expect(validate(lab({ web: { start: "/x", port: 3050, cpu } }))).toContainEqual(expect.stringContaining("services.web.cpu: a share of one core"));
      expect(validate({ ...APP, cpu })).toContainEqual(expect.stringContaining("cpu: a share of one core"));
    }
    expect(validate({ ...APP, cpu: "6400%" })).toEqual([]);
    expect(validate({ slug: "notes", publicDir: "dist", cpu: "50%" })).toContainEqual(expect.stringContaining("cpu: without `start`, nothing runs to be limited"));
  });

  test("the main service is the first that runs for good, whatever the written order", () => {
    // A project with no scheduled service keeps its order and its names: see
    // the first test of the services key.
    expect(servicesOf(MIXED).map((service) => [service.name, service.unit])).toEqual([
      ["web", "lab"],
      ["sync", "lab.sync"],
      ["queue", "lab.queue"],
    ]);
    expect(mainPort(MIXED)).toBe(3050);
    expect(isAnchored(MIXED)).toBe(false);
    // A worker can be the main one; it has no port to give.
    const workerFirst = lab({ sync: { start: "/y", schedule: "hourly" }, queue: { start: "/x", internal: true } });
    expect(servicesOf(workerFirst).map((service) => service.unit)).toEqual(["lab", "lab.sync"]);
    expect(mainPort(workerFirst)).toBeNull();
  });

  test("every service scheduled: the project is anchored, and its main unit is none of them", () => {
    const anchored = lab({ report: { start: "/x", schedule: "daily" }, cleanup: { start: "/y", schedule: "Sun 03:00" } });
    expect(validate(anchored)).toEqual([]);
    expect(isAnchored(anchored)).toBe(true);
    expect(servicesOf(anchored).map((service) => service.unit)).toEqual(["lab.report", "lab.cleanup"]);
    expect(mainPort(anchored)).toBeNull();
    expect(scheduledServices(anchored).map((service) => service.name)).toEqual(["report", "cleanup"]);
    expect(scheduledServices(MIXED).map((service) => service.name)).toEqual(["sync"]);
    for (const manifest of [LAB, APP, { slug: "notes", publicDir: "dist" } as Manifest]) expect(isAnchored(manifest)).toBe(false);
  });

  test("no public service and no publicDir: a project that serves no page, which can have no domain", () => {
    const headless = lab({ sync: { start: "/y", schedule: "hourly" }, queue: { start: "/x", internal: true } });
    expect(validate(headless)).toEqual([]);
    expect(isHeadless(headless)).toBe(true);
    expect(isHeadless(lab({ report: { start: "/x", schedule: "daily" } }))).toBe(true);
    expect(isHeadless({ ...headless, publicDir: "public" })).toBe(false);
    for (const manifest of [LAB, MIXED, APP, { slug: "notes", publicDir: "dist" } as Manifest]) expect(isHeadless(manifest)).toBe(false);
    expect(validate({ ...headless, domain: { name: "example.com" } })).toContainEqual(expect.stringContaining("domain: this project serves no page"));
    expect(validate({ ...headless, publicDir: "public", domain: { name: "example.com" } })).toEqual([]);
  });
});

describe("source", () => {
  test("a path relative to the manifest, climbing out of it included", () => {
    expect(validate({ ...APP, source: "../../mini-lab" })).toEqual([]);
    expect(validate({ ...APP, source: "app" })).toEqual([]);
  });

  test("never absolute, which would name the workstation that wrote it", () => {
    for (const source of ["/Users/me/Code/app", "~/Code/app", "C:/app", "", "../a\nb"]) {
      expect(validate({ ...APP, source })).toContainEqual(expect.stringContaining("source:"));
    }
  });
});

describe("routes that could overlap", () => {
  test.each([
    ["/v1/*", "/v1/chat", true],
    ["/v1/*", "/V1/chat", true],
    ["/v1/*", "/v1/admin/*", true],
    ["/api", "/api", true],
    ["*.php", "/index.php", true],
    ["/v1/*", "/v1", false],
    ["/v1/*", "/v2/*", false],
    ["/api", "/api2", false],
    ["/webhook/*", "/v1/*", false],
  ])("%s and %s: %p", (a, b, expected) => {
    expect(routesOverlap(a, b)).toBe(expected);
    expect(routesOverlap(b, a)).toBe(expected);
  });
});

describe("the units of a project with several services", () => {
  const units = generateUnits(LAB, { slug: "lab", zone: "test-zone.invalid", contact: "" });
  const text = (unit: string): string => units.find((generated) => generated.unit === unit)!.text;

  test("one unit per service, the main one first", () => {
    expect(units.map((generated) => generated.unit)).toEqual(["lab", "lab.api", "lab.inference"]);
    expect(generateUnit(LAB, { slug: "lab", zone: "test-zone.invalid", contact: "" })).toBe(text("lab"));
  });

  test("the main unit wants the others and starts after them; they follow it", () => {
    expect(text("lab")).toInclude("Wants=lab.api.service lab.inference.service");
    expect(text("lab")).toInclude("After=lab.api.service lab.inference.service");
    expect(text("lab")).toInclude("[Install]\nWantedBy=multi-user.target");
    for (const unit of ["lab.api", "lab.inference"]) {
      expect(text(unit)).toInclude("PartOf=lab.service");
      // Never enabled on its own: the main unit starts it.
      expect(text(unit)).not.toMatch(/^\[Install\]$/m);
      expect(text(unit)).not.toInclude("PartOf=lab.api");
    }
    expect(text("lab")).not.toInclude("PartOf=");
  });

  test("each unit runs its own command on its own port, as the project's user", () => {
    for (const [unit, port] of [["lab", 3050], ["lab.api", 3051], ["lab.inference", 3052]] as const) {
      expect(text(unit)).toInclude(`Environment=PORT=${port}\n`);
      expect(text(unit)).toInclude(`--port ${port}\n`);
      expect(text(unit)).toInclude("User=site-lab\nGroup=site-lab");
      expect(text(unit)).toInclude("ReadWritePaths=/srv/sites/lab/data");
      expect(text(unit)).toInclude("EnvironmentFile=-/etc/sitesolide/projects/lab/env");
      expect(text(unit)).toInclude("Environment=LAB_DB=/srv/sites/lab/data/lab.db");
      expect(text(unit)).toInclude("Environment=LAB_URL=https://lab.test-zone.invalid");
      expect(text(unit)).toInclude("IPAddressAllow=localhost");
      expect(text(unit)).toInclude("RestrictNamespaces=true");
    }
  });

  test("memory and env of each service", () => {
    expect(text("lab")).toInclude("MemoryMax=512M");
    expect(text("lab.inference")).toInclude("MemoryMax=1G");
    expect(text("lab.inference")).toInclude("Environment=LAB_THREADS=1");
    expect(text("lab.api")).not.toInclude("LAB_THREADS");
  });

  test("the description names the service", () => {
    expect(text("lab.api")).toInclude("Description=Project lab, service api\n");
  });

  test("systemctl is given a secondary unit with its type, the main one as it always was", () => {
    expect(unitArgument("lab")).toBe("lab");
    expect(unitArgument("lab.api")).toBe("lab.api.service");
  });

  test("a single start keeps its one unit, with no relation to any other", () => {
    const [only, ...rest] = generateUnits(APP);
    expect(rest).toEqual([]);
    expect(only!.unit).toBe("budget");
    expect(only!.text).not.toInclude("PartOf=");
    expect(only!.text).not.toMatch(/^Wants=(?!network-online)/m);
    expect(only!.text).toInclude("Description=Project budget\n");
  });
});

describe("the Caddy block of a project with several services", () => {
  const fragment = generateFragment(LAB)!;

  test("the routed service gets its paths, the main one the rest, the internal one nothing", () => {
    expect(fragment).toInclude("\t@service-api path /v1/*\n\treverse_proxy @service-api 127.0.0.1:3051 {\n\t\theader_up X-Forwarded-For {client_ip}\n\t}\n");
    expect(fragment).toInclude("\treverse_proxy 127.0.0.1:3050 {\n\t\theader_up X-Forwarded-For {client_ip}\n\t}\n");
    expect(fragment).not.toInclude("3052");
    expect(fragment).not.toInclude("file_server");
  });

  test("still no handle", () => {
    const code = fragment.split("\n").filter((line) => !line.trimStart().startsWith("#"));
    expect(code.some((line) => /^\s*handle\b/.test(line))).toBe(false);
  });

  test("next to a publicDir, the rest goes to the service minus the files and the other routes", () => {
    const mixed = generateFragment({ ...LAB, publicDir: "public" })!;
    expect(mixed).toInclude("\troot * /srv/sites/lab/public\n");
    expect(mixed).toInclude("\t@service-platform {\n\t\tnot file\n\t\tnot path /v1/*\n\t}\n");
    expect(mixed).toInclude("\treverse_proxy @service-platform 127.0.0.1:3050 {\n\t\theader_up X-Forwarded-For {client_ip}\n\t}\n");
    expect(mixed).toInclude("\tfile_server");
  });

  test("with a publicDir and routed services only, the rest is served from disk", () => {
    const routedOnly = generateFragment(
      lab({ api: { start: "/x", port: 3051, routes: ["/v1/*"] } }, { publicDir: "public" }),
    )!;
    expect(routedOnly).toInclude("reverse_proxy @service-api 127.0.0.1:3051");
    expect(routedOnly).not.toInclude("not file");
    expect(routedOnly).toInclude("\tfile_server");
  });

  test("behind the portal, the door stands in front of every service", () => {
    const door = generateFragment({ ...LAB, portal: true, portalExempt: ["/v1/*"] })!;
    expect(door).toInclude("forward_auth @portal_guard");
    expect(door).toInclude("@portal_guard not path /_portal/* /v1/*");
    expect(door).toInclude("reverse_proxy @service-api 127.0.0.1:3051");
  });
});

describe("ports taken on the machine", () => {
  const deposited = new Map([
    ["budget", JSON.stringify(APP)],
    ["broken", "{ not json"],
    ["lab", JSON.stringify({ ...LAB, services: { platform: { start: "/x", port: 3099 } } })],
  ]);

  test("a port another project declares is refused, the project's own previous ports are not", () => {
    expect(portConflicts(LAB, deposited)).toEqual([]);
    const clash = lab({ platform: { start: "/x", port: 3050 }, api: { start: "/y", port: 3022, routes: ["/v1/*"] } });
    expect(portConflicts(clash, deposited)).toEqual(["port 3022 (service api) is already declared by project budget"]);
  });

  test("the landing's and the shared service's ports are reserved", () => {
    expect(portConflicts({ ...APP, slug: "other", port: 3001 }, new Map())).toEqual([
      "port 3001 is already declared by the shared service (api/)",
    ]);
  });

  test("the platform's ports too, deployed or not, for every project but the one they belong to", () => {
    // A project on the portal's port before the portal is deployed would
    // refuse the portal's first deployment, and the loopback rule lets the
    // dashboard through to it.
    expect(portConflicts({ ...APP, slug: "other", port: 3026 }, new Map())).toEqual([
      "port 3026 is already declared by the platform's portal, deployed or not",
    ]);
    expect(portConflicts(lab({ web: { start: "/x", port: 3029 } }), new Map())).toEqual([
      "port 3029 (service web) is already declared by the platform's analytics, deployed or not",
    ]);
    expect(portConflicts({ ...APP, slug: "portal", port: 3026 }, new Map())).toEqual([]);
    expect(portConflicts({ ...APP, slug: "dashboard", port: 3022 }, new Map())).toEqual([]);
  });
});

describe("domain names taken on the machine", () => {
  const deposited = new Map([
    ["shop", JSON.stringify({ slug: "shop", publicDir: "public", domain: { name: "shop.example", aliases: ["boutique.example"], active: true } })],
    ["draft", JSON.stringify({ ...APP, slug: "draft", port: 3040, domain: { name: "draft.example", active: false } })],
    ["broken", "{ not json"],
  ]);
  const own = (domain: { name: string; aliases?: string[] }) => ({ ...APP, slug: "budget", domain });

  test("a name, an alias or their www another project declares, active or not, is refused", () => {
    // An app's block names its host, and beats the nameless block of the
    // static sites' domains: it would take the other site's visitors.
    expect(domainConflicts(own({ name: "shop.example" }), deposited)).toEqual([
      "shop.example is already declared by project shop",
      "www.shop.example is already declared by project shop",
    ]);
    expect(domainConflicts(own({ name: "budget.example", aliases: ["www.boutique.example"] }), deposited)).toEqual([
      "www.boutique.example is already declared by project shop",
    ]);
    expect(domainConflicts(own({ name: "draft.example" }), deposited)).toEqual([
      "draft.example is already declared by project draft",
      "www.draft.example is already declared by project draft",
    ]);
  });

  test("its own previous names, another name, or no domain at all, are not", () => {
    expect(domainConflicts({ ...APP, slug: "shop", domain: { name: "shop.example", active: true } }, deposited)).toEqual([]);
    expect(domainConflicts(own({ name: "budget.example" }), deposited)).toEqual([]);
    expect(domainConflicts(APP, deposited)).toEqual([]);
  });
});

describe("units the manifest no longer declares", () => {
  test("listed by a pattern that only the project's own units can match", () => {
    expect(listUnitsCommand("lab")).toInclude("/etc/systemd/system/lab.*.service");
    expect(() => listUnitsCommand("lab; rm -rf /")).toThrow();
  });

  test("only the units deploy generated are listed, never one written by hand or by the system", () => {
    const root = mkdtempSync(join(tmpdir(), "sitesolide-units-"));
    try {
      const generated = generateUnits(LAB, { slug: "lab", zone: "test-zone.invalid", contact: "" });
      for (const { unit, text } of generated) writeFileSync(join(root, `${unit}.service`), text);
      // A secondary of a service since dropped from the manifest, as deploy wrote it.
      writeFileSync(join(root, "lab.old.service"), generated[1]!.text);
      // A helper written by hand beside the project, and a system unit whose
      // name starts like the slug.
      writeFileSync(join(root, "lab.rollup.service"), "[Unit]\nPartOf=lab.service\n");
      writeFileSync(join(root, "lab.freedesktop.service"), "# generated by bin/sitesolide.ts\n[Unit]\n");
      const script = listUnitsCommand("lab")
        .replace(/^sudo sh -c '/, "")
        .replace(/'$/, "")
        .replaceAll("/etc/systemd/system", root);
      const output = Bun.spawnSync(["sh", "-c", script]).stdout.toString();
      const read = readUnitsAnswer(output, "lab");
      expect(read).toEqual({ kind: "read", units: ["lab.api", "lab.inference", "lab.old"] });
      expect(staleUnits(LAB, read.kind === "read" ? read.units : [])).toEqual(["lab.old"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a listing without its end marker is unreadable, never empty", () => {
    expect(readUnitsAnswer("", "lab")).toEqual({ kind: "unreadable" });
    expect(readUnitsAnswer("lab.api\n", "lab")).toEqual({ kind: "unreadable" });
    expect(readUnitsAnswer(`${MARKER_DONE}\n`, "lab")).toEqual({ kind: "read", units: [] });
    expect(readUnitsAnswer(`lab.api\nlab.old\n${MARKER_DONE}\n`, "lab")).toEqual({ kind: "read", units: ["lab.api", "lab.old"] });
    // A name the pattern could not have produced says the read went wrong.
    expect(readUnitsAnswer(`other.api\n${MARKER_DONE}\n`, "lab")).toEqual({ kind: "unreadable" });
  });

  test("only what the manifest no longer declares is stale", () => {
    expect(staleUnits(LAB, ["lab.api", "lab.old", "lab.inference"])).toEqual(["lab.old"]);
    expect(staleUnits(APP, ["budget.worker"])).toEqual(["budget.worker"]);
  });

  test("removed one by one, their absence tolerated", () => {
    expect(removeUnitsCommand(["lab.old"])).toBe(
      "sudo systemctl disable --now lab.old.service 2>/dev/null || true && sudo rm -f /etc/systemd/system/lab.old.service && sudo systemctl daemon-reload && " +
        "{ sudo systemctl reset-failed lab.old.service 2>/dev/null || true; }",
    );
  });
});

describe("units systemd already knows, read before anything is laid", () => {
  const facts = (loadState: string, fragmentPath: string, generated = false, project = false) => ({ loadState, fragmentPath, generated, project });

  test("unknown, generated, or this project's own unit written by hand: free to lay", () => {
    expect(foreignUnit("shop", "shop", facts("not-found", ""))).toBeNull();
    expect(foreignUnit("shop", "shop", facts("loaded", "/etc/systemd/system/shop.service", true))).toBeNull();
    expect(foreignUnit("shop.api", "shop", facts("loaded", "/etc/systemd/system/shop.api.service", true))).toBeNull();
    // decideUnit settles a hand-written one as it always has, --force included.
    expect(foreignUnit("shop", "shop", facts("loaded", "/etc/systemd/system/shop.service", false, true))).toBeNull();
  });

  test("a package's unit, an alias, a masked name, someone else's unit in /etc: never", () => {
    expect(foreignUnit("mailer", "mailer", facts("loaded", "/lib/systemd/system/mailer.service"))).toContain("already a service of the machine, read from /lib/systemd/system/mailer.service");
    // An alias in /etc names the vendor file systemd really reads.
    expect(foreignUnit("sshd", "sshd", facts("loaded", "/usr/lib/systemd/system/ssh.service"))).toContain("/usr/lib/systemd/system/ssh.service");
    expect(foreignUnit("shop", "shop", facts("masked", "/etc/systemd/system/shop.service", true))).toContain("masked");
    expect(foreignUnit("backup", "backup", facts("loaded", "/etc/systemd/system/backup.service"))).toContain("a unit deploy did not write");
    // A drop-in only, or a generator's unit: known, from nowhere deploy writes.
    expect(foreignUnit("shop", "shop", facts("loaded", "/run/systemd/generator/shop.service", true))).not.toBeNull();
  });

  test("the script, run against a systemctl that knows a package's unit and one of deploy's", () => {
    const root = mkdtempSync(join(tmpdir(), "sitesolide-origins-"));
    try {
      const units = join(root, "units");
      Bun.spawnSync(["mkdir", "-p", units, join(root, "bin")]);
      writeFileSync(join(units, "lab.service"), generateUnits(LAB, { slug: "lab", zone: "test-zone.invalid", contact: "" })[0]!.text);
      writeFileSync(join(root, "vendor.service"), "[Service]\nExecStart=/usr/sbin/inference\n");
      // A systemctl answering `show -p <property> --value <unit>.service` as
      // systemd would for these three units.
      writeFileSync(
        join(root, "bin", "systemctl"),
        [
          "#!/bin/sh",
          'property=$3; unit=$5',
          `case "$unit" in`,
          `  lab.service) state=loaded; file=${units}/lab.service ;;`,
          `  lab.inference.service) state=loaded; file=${root}/vendor.service ;;`,
          "  *) state=not-found; file= ;;",
          "esac",
          '[ "$property" = LoadState ] && echo "$state" || echo "$file"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const asked = ["lab", "lab.api", "lab.inference"];
      const script = unitOriginsCommand("lab", asked).replace(/^sudo sh -c '/, "").replace(/'$/, "");
      const output = Bun.spawnSync(["sh", "-c", script], { env: { PATH: `${join(root, "bin")}:/usr/bin:/bin` } }).stdout.toString();
      const read = readUnitOrigins(output, asked);
      if (read.kind !== "read") throw new Error(`unreadable: ${output}`);
      expect(read.facts.get("lab")).toEqual({ loadState: "loaded", fragmentPath: join(units, "lab.service"), generated: true, project: true });
      expect(read.facts.get("lab.api")).toEqual({ loadState: "not-found", fragmentPath: "", generated: false, project: false });
      expect(foreignUnit("lab", "lab", read.facts.get("lab")!, units)).toBeNull();
      expect(foreignUnit("lab.inference", "lab", read.facts.get("lab.inference")!, units)).toContain("vendor.service");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a unit asked for and not answered, or no systemd at all, is unreadable", () => {
    expect(readUnitOrigins("", ["shop"])).toEqual({ kind: "unreadable" });
    expect(readUnitOrigins(`${MARKER_DONE}\n`, ["shop"])).toEqual({ kind: "unreadable" });
    expect(readUnitOrigins(`UNIT shop unknown no no -\n${MARKER_DONE}\n`, ["shop"])).toEqual({ kind: "unreadable" });
    expect(readUnitOrigins(`UNIT other loaded no no /x\n${MARKER_DONE}\n`, ["shop"])).toEqual({ kind: "unreadable" });
    expect(() => unitOriginsCommand("shop", ["other"])).toThrow();
    expect(() => unitOriginsCommand("shop", ["shop; reboot"])).toThrow();
  });
});

describe("the project set's file on the machine", () => {
  const FILE = projectPortsFile([{ manifest: LAB, uid: 1600 }]);

  /** The command run by a local sh, with the machine's paths and nft swapped for a folder and a stand-in. */
  function runLocally(command: string, nft: "accepts" | "refuses"): { code: number; root: string } {
    const root = mkdtempSync(join(tmpdir(), "sitesolide-set-"));
    writeFileSync(join(root, "sitesolide-loopback-projects.nft"), "previous\n");
    const local = command
      .replace(/^sudo sh -c '/, "")
      .replace(/'$/, "")
      .replaceAll("/etc/", `${root}/`)
      // The nft commands alone, not the file names that end in .nft.
      .replace(/(^|\n|&& )nft /g, (_, lead: string) => `${lead}${nft === "accepts" ? "true" : "false"} `);
    const result = Bun.spawnSync(["sh", "-c", local]);
    return { code: result.exitCode, root };
  }

  test("applied, the file replaces the previous one and nothing is left beside it", () => {
    const { code, root } = runLocally(projectPortsCommand(FILE, true), "accepts");
    try {
      expect(code).toBe(0);
      expect(readFileSync(join(root, "sitesolide-loopback-projects.nft"), "utf8")).toBe(FILE);
      expect(existsSync(join(root, "sitesolide-loopback-projects.nft.new"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refused, the previous file stays, so that boot replays what the kernel carries", () => {
    const { code, root } = runLocally(projectPortsCommand(FILE, true), "refuses");
    try {
      expect(code).not.toBe(0);
      expect(readFileSync(join(root, "sitesolide-loopback-projects.nft"), "utf8")).toBe("previous\n");
      expect(existsSync(join(root, "sitesolide-loopback-projects.nft.new"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("without the set, the file is written and not applied", () => {
    const command = projectPortsCommand(FILE, false);
    expect(command).not.toInclude("nft -f");
    const { code, root } = runLocally(command, "refuses");
    try {
      expect(code).toBe(0);
      expect(readFileSync(join(root, "sitesolide-loopback-projects.nft"), "utf8")).toBe(FILE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the pairs the kernel lists are read back, on one line or several", () => {
    const listed = [
      "table inet sitesolide_boucle {",
      "\tset project_ports {",
      "\t\ttypeof tcp dport . meta skuid",
      "\t\telements = { 3050 . 1600, 3051 . 1600,",
      "\t\t\t     3052 . 1600 }",
      "\t}",
      "}",
      MARKER_DONE,
    ].join("\n");
    expect(readCurrentPairs(listed)).toEqual(["3050 . 1600", "3051 . 1600", "3052 . 1600"]);
    expect(readCurrentPairs(listed)).toEqual(projectPortPairs([{ manifest: LAB, uid: 1600 }]));
    expect(readCurrentPairs(`table inet sitesolide_boucle {\n}\n${MARKER_DONE}\n`)).toEqual([]);
    expect(readCurrentPairs("")).toBeNull();
  });
});

describe("reads behind the project set", () => {
  test("the state of the loopback rule", () => {
    for (const state of ["none", "table", "set"] as const) {
      expect(readLoopbackState(`${state}\n${MARKER_DONE}\n`)).toBe(state);
    }
    expect(readLoopbackState("")).toBe("unreadable");
    expect(readLoopbackState("set\n")).toBe("unreadable");
    expect(readLoopbackState(`maybe\n${MARKER_DONE}\n`)).toBe("unreadable");
  });

  test("the uids, all of them or none", () => {
    expect(uidsCommand(["lab"])).toInclude("id -u site-lab");
    expect(readUidsAnswer(`lab 1005\nshop 1006\n${MARKER_DONE}\n`, ["lab", "shop"])).toEqual({
      kind: "read",
      uids: new Map([
        ["lab", 1005],
        ["shop", 1006],
      ]),
    });
    // A missing user prints an empty uid: the whole read is refused.
    expect(readUidsAnswer(`lab \nshop 1006\n${MARKER_DONE}\n`, ["lab", "shop"])).toEqual({ kind: "unreadable" });
    expect(readUidsAnswer(`lab 1005\n`, ["lab"])).toEqual({ kind: "unreadable" });
    expect(readUidsAnswer(`lab 1005\n${MARKER_DONE}\n`, ["lab", "shop"])).toEqual({ kind: "unreadable" });
  });
});

/** The header of /proc/net/tcp, and a line of it: `st` 0A for a listening socket, 01 for a connection. */
const TCP_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
function tcpLine(port: number, uid: number, state = "0A"): string {
  return `   0: 0100007F:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 ${String(uid).padStart(5)}        0 20311 1 0000000000000000 100 0 0 10 0\n`;
}

describe("the second block, opened on the machine before a port there", () => {
  /**
   * The order of an upgrade is a security property. A unit's SocketBindDeny
   * is what keeps a project from listening on another project's port, and a
   * unit generated before the second block denies none of it: until every
   * such unit is gone, the components that run a project's programs carry
   * the new lines, the kernel hands none of the block's ports out by itself
   * and the loopback rule refuses others there, a port of the block could be
   * taken by a neighbour, or reached by anyone. deploy and the installer read
   * all of it at every deployment of an app.
   */
  const ON_SECOND: Manifest = { slug: "lab", services: { web: { start: "/x", port: 21000 }, api: { start: "/y", port: 3051, routes: ["/v1/*"] } } };
  const PLACEHOLDERS = { slug: "lab", zone: "test-zone.invalid", contact: "" };
  const LINES = ["2019", "3000-3099", "3128-3129", "21000-29999"];
  const OPEN: SecondBlockState = {
    reserved: true,
    units: [{ unit: "shop.service", user: "site-shop", denied: LINES, needsReload: false }],
    components: { backup: "current", installer: "current" },
    listeners: [],
    autobind: false,
  };
  const OLD_UNIT = { unit: "old.service", user: "site-old", denied: LINES.slice(0, 3), needsReload: false };

  test("only the ports outside the first block ask for it", () => {
    expect(laterBlockPorts(ON_SECOND)).toEqual([21000]);
    expect(laterBlockPorts(LAB)).toEqual([]);
    expect(laterBlockPorts({ slug: "shop", start: "/x", port: 29999 })).toEqual([29999]);
    expect(laterBlockPorts({ slug: "blog", publicDir: "public" })).toEqual([]);
    expect(secondBlockRefusal([], { ...OPEN, reserved: false }, undefined)).toBeNull();
  });

  test("open: the rule refuses others on every block, no unit may listen there, the components are current, the kernel hands none out", () => {
    expect(secondBlockRefusal([21000], OPEN)).toBeNull();
    // A component that is not installed runs nothing.
    expect(secondBlockRefusal([21000], { ...OPEN, components: { backup: "absent", installer: "absent" } })).toBeNull();
  });

  test("each missing condition keeps it shut, and says which", () => {
    const cases: [Partial<SecondBlockState>, string][] = [
      [{ reserved: false }, "does not refuse other accounts on that block"],
      [{ units: [...OPEN.units, OLD_UNIT] }, "units that may still listen there, taking another project's visitors: old.service"],
      [{ components: { backup: "outdated", installer: "current" } }, "components built before that block, whose programs may listen there: backup"],
      [{ autobind: true }, "the kernel may hand a port of that block to any process that asks for none"],
    ];
    for (const [change, said] of cases) {
      const refusal = secondBlockRefusal([21001, 21000, 21000], { ...OPEN, ...change });
      expect(refusal![0]).toBe("port 21000, 21001: the second block of the services' ports, which this machine has not opened yet");
      expect(refusal!.join("\n")).toInclude(said);
      expect(refusal!.join("\n")).toInclude("sitesolide upgrade, sitesolide refresh --all, then bin/deploy-loopback.sh close, in that order");
      expect(refusal!.join("\n")).toInclude("then systemctl daemon-reload and a restart");
      expect(refusal!.join("\n")).toInclude("3000 to 3099 works as before");
    }
    // The CLI names the kit's script.
    expect(secondBlockRefusal([21000], { ...OPEN, reserved: false }, () => "/kit/bin/deploy-loopback.sh close")!.join("\n")).toInclude("then /kit/bin/deploy-loopback.sh close,");
  });

  test("a unit is read as systemd has it loaded: a file changed and not reloaded, a line for one family, keep it shut", () => {
    for (const unit of [{ ...OPEN.units[0]!, needsReload: true }, { ...OPEN.units[0]!, denied: [...LINES.slice(0, 3), "ipv4:21000-29999"] }]) {
      expect(secondBlockRefusal([21000], { ...OPEN, units: [unit] })).not.toBeNull();
    }
    // The project being deployed is not held against itself: its units are about to be written.
    expect(secondBlockRefusal([21000], { ...OPEN, units: [...OPEN.units, { ...OLD_UNIT, unit: "lab.service" }] }, undefined, ["lab", "lab.api"])).toBeNull();
  });

  test("once the block is open, every other deployment says when a unit may listen in it again, and goes on", () => {
    const again = { ...OPEN, units: [...OPEN.units, OLD_UNIT] };
    expect(unguardedWarning(again)![0]).toInclude("old.service");
    expect(unguardedWarning(again)!.join("\n")).toInclude("sitesolide refresh --all");
    expect(unguardedWarning(OPEN)).toBeNull();
    // Not open, nothing is sent there: nothing to say.
    expect(unguardedWarning({ ...again, reserved: false })).toBeNull();
    expect(unguardedWarning(again, ["old"])).toBeNull();
    expect(unguardedUnits(again)).toEqual(["old.service"]);
  });

  /**
   * The read run by a local sh, as root runs it on the machine: its paths
   * swapped for the test's, nft and systemctl for stand-ins that answer from
   * the test's files, systemctl as systemd prints `show`.
   */
  function machineRead(files: {
    units?: Record<string, string>;
    links?: Record<string, string>;
    table?: string;
    components?: Record<string, string>;
    portRange?: string;
    reserved?: string;
    /** systemctl fails after answering for the first unit, or answers for the first one alone. */
    systemctl?: "fails" | "cut";
    tcp?: string;
    passwd?: string;
  }): SecondBlockState | null {
    const root = mkdtempSync(join(tmpdir(), "sitesolide-machine-"));
    try {
      for (const folder of ["units", "lib", "proc", "bin"]) mkdirSync(join(root, folder));
      for (const [name, text] of Object.entries(files.units ?? {})) writeFileSync(join(root, "units", name), text);
      for (const [name, target] of Object.entries(files.links ?? {})) symlinkSync(target, join(root, "units", name));
      for (const [name, text] of Object.entries(files.components ?? {})) writeFileSync(join(root, "lib", `${name}.js`), text);
      writeFileSync(join(root, "proc", "ip_local_port_range"), `${files.portRange ?? "32768\t60999"}\n`);
      writeFileSync(join(root, "proc", "ip_local_reserved_ports"), `${files.reserved ?? ""}\n`);
      if (files.table !== undefined) writeFileSync(join(root, "table"), files.table);
      writeFileSync(join(root, "proc", "tcp"), files.tcp ?? TCP_HEADER);
      writeFileSync(join(root, "bin", "getent"), `#!/bin/sh\nprintf '%s' '${files.passwd ?? "root:x:0:0::/root:/bin/sh\n"}'\n`, { mode: 0o755 });
      writeFileSync(join(root, "bin", "nft"), `#!/bin/sh\ncat "${root}/table" 2>/dev/null\n`, { mode: 0o755 });
      writeFileSync(
        join(root, "bin", "systemctl"),
        [
          "#!/bin/sh",
          'echo "$*" >> "' + root + '/calls"',
          'while [ "$1" != "--" ]; do shift; done; shift',
          'for name in "$@"; do',
          '  echo "Id=$name"',
          `  echo "User=$(sed -n 's/^User=//p' "${root}/units/$name" | tail -1)"`,
          `  sed -n 's/^SocketBindDeny=..*$/&/p' "${root}/units/$name"`,
          '  echo "NeedDaemonReload=no"',
          "  echo",
          ...(files.systemctl === undefined ? [] : [files.systemctl === "fails" ? "  exit 1" : "  exit 0"]),
          "done",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const command = secondBlockStateCommand();
      expect(command).toStartWith("sudo sh -c '");
      const local = command
        .replace(/^sudo sh -c '/, "")
        .replace(/'$/, "")
        .replaceAll("/etc/systemd/system", join(root, "units"))
        .replaceAll("/usr/local/lib/sitesolide", join(root, "lib"))
        .replaceAll("/proc/sys/net/ipv4", join(root, "proc"))
        .replaceAll("/proc/net/tcp6", join(root, "proc", "tcp6"))
        .replaceAll("/proc/net/tcp", join(root, "proc", "tcp"));
      const run = Bun.spawnSync(["sh", "-c", local], { env: { PATH: `${join(root, "bin")}:/usr/bin:/bin` } });
      return readSecondBlockState(run.stdout.toString());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const current = Object.fromEntries(generateUnits(LAB, PLACEHOLDERS).map(({ unit, text }) => [unitFileName(unit), text]));
  const before = Object.fromEntries(
    generateUnits({ slug: "old", services: { web: { start: "/x", port: 3060 } } }, { ...PLACEHOLDERS, slug: "old" }).map(({ unit, text }) => [unitFileName(unit), withoutLaterBlockLines(text)]),
  );
  const BUILT = { backup: `console.log("${BIND_LINES_FEATURE}")`, installer: `console.log("${BIND_LINES_FEATURE}")` };

  test("read on the machine in one go: the rule, every unit as systemd has it, the components, the kernel's ports", () => {
    const state = machineRead({ units: current, table: loopbackRule(997, "close", 1022), components: BUILT });
    expect(state).toEqual({ reserved: true, units: expect.any(Array), components: { backup: "current", installer: "current" }, listeners: [], autobind: false });
    expect(state!.units.map((unit) => unit.unit).sort()).toEqual(Object.keys(current).filter((name) => name.endsWith(".service")).sort());
    expect(unguardedUnits(state!)).toEqual([]);
    expect(secondBlockRefusal([21000], state!)).toBeNull();
  });

  test("a unit of the release before, one written by hand, an outdated or missing component, a widened ephemeral range: each read", () => {
    const platform = "[Service]\nUser=sitesolide-api\nExecStart=/usr/local/bin/bun server.ts\n";
    const byHand = "[Service]\nUser=site-landing\nExecStart=/usr/local/bin/bun server.ts\n";
    const state = machineRead({
      units: { ...current, ...before, "sitesolide-api.service": platform, "landing.service": byHand, "sitesolide-installer@.service": "[Service]\nUser=root\n" },
      // A masked unit and a dangling link run nothing, and are skipped, as the installer skips them.
      links: { "masked.service": "/dev/null", "gone.service": "/nonexistent/gone.service" },
      table: loopbackRule(997, "observe", 1022),
      components: { backup: "console.log('older')" },
      portRange: "1024\t65535",
    });
    expect(state).not.toBeNull();
    expect(unguardedUnits(state!)).toEqual(["landing.service", "old.service"]);
    expect(state!.units.some((unit) => ["masked.service", "gone.service", "sitesolide-installer@.service"].includes(unit.unit))).toBe(false);
    expect(state!.reserved).toBe(false);
    expect(state!.components).toEqual({ backup: "outdated", installer: "absent" });
    expect(state!.autobind).toBe(true);
    // Every block reserved from the kernel's own choice, the widened range is harmless.
    expect(machineRead({ units: current, portRange: "1024\t65535", reserved: "3000-3099,21000-29999" })!.autobind).toBe(false);
  });

  test("a systemctl that fails, or answers for fewer units than there are files, is no answer: never a machine with no unit at fault", () => {
    const answers = machineRead({ units: current, table: loopbackRule(997, "close", 1022), components: BUILT });
    expect(answers).not.toBeNull();
    for (const systemctl of ["fails", "cut"] as const) {
      expect({ systemctl, state: machineRead({ units: current, table: loopbackRule(997, "close", 1022), components: BUILT, systemctl }) }).toEqual({ systemctl, state: null });
    }
  });

  test("what already listens on the second block, and as whom, from the kernel's own lines", () => {
    const tcp = `${TCP_HEADER}${tcpLine(21000, 1600)}${tcpLine(3022, 1022)}${tcpLine(21001, 1700, "01")}`;
    const state = machineRead({ units: current, table: loopbackRule(997, "close", 1022), components: BUILT, tcp, passwd: "site-old:x:1600:1600::/nonexistent:/usr/sbin/nologin\nsite-lab:x:1700:1700::/nonexistent:/usr/sbin/nologin\n" });
    // 3022 is the first block's, 21001 is a connection, not a listener.
    expect(state!.listeners).toEqual([{ port: 21000, uid: 1600, account: "site-old" }]);
    // Another account on the port: refused, the machine open or not.
    const refusal = secondBlockRefusal([21000], state!, undefined, ["lab"], "site-lab");
    expect(refusal![0]).toBe("port 21000: taken on this machine");
    expect(refusal![1]).toInclude("already listened on by another account, which Caddy would send this project's visitors to: 21000 (site-old)");
    expect(secondBlockRefusal([21000], { ...state!, reserved: false }, undefined, ["lab"], "site-lab")!.join("\n")).toInclude("21000 (site-old)");
    // The project's own service on its port, a redeployment: fine.
    expect(secondBlockRefusal([21000], state!, undefined, ["old"], "site-old")).toBeNull();
    // A port nobody listens on: fine.
    expect(secondBlockRefusal([21002], state!, undefined, ["lab"], "site-lab")).toBeNull();
  });

  test("a listener of the second block a deposited manifest accounts for is no stray; any other is", () => {
    const listeners = [
      { port: 21000, uid: 1500, account: "site-shop" },
      { port: 21001, uid: 1600, account: "site-old" },
      { port: 25000, uid: 0, account: "root" },
    ];
    const deposited = new Map([
      ["shop", JSON.stringify({ slug: "shop", start: "/x", port: 21000 })],
      ["lab", JSON.stringify({ ...LAB, services: { web: { start: "/x", port: 21001 } } })],
      ["broken", "{ not json"],
    ]);
    expect(strayListeners(listeners, deposited).map(describeListener)).toEqual(["21001 (site-old)", "25000 (root)"]);
    expect(strayListeners([], deposited)).toEqual([]);
  });

  test("the accounts and the kernel's socket lines, read or refused whole", () => {
    expect(readAccounts("root:0\nsite-old:1600\n")).toEqual(new Map([[0, "root"], [1600, "site-old"]]));
    expect(readAccounts("root:x:0:0::/root:/bin/sh\n")).toEqual(new Map([[0, "root"]]));
    expect(readAccounts("garbage\n")).toBeNull();
    const accounts = new Map([[1600, "site-old"]]);
    // IPv6, a listener on [::]:21000, by an account /etc/passwd does not name.
    const v6 = "   1: 00000000000000000000000000000000:5208 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1700        0 20400 1 0000000000000000 100 0 0 10 0";
    expect(readListeners([tcpLine(21000, 1600).trim(), v6], accounts)).toEqual([
      { port: 21000, uid: 1600, account: "site-old" },
      { port: 21000, uid: 1700, account: null },
    ]);
    expect(readListeners(["not a socket line"], accounts)).toBeNull();
  });

  test("a read that broke off, or that does not read, is no answer", () => {
    const whole = ["== rule", "== units", "files 0", "== components", "backup absent", "installer absent", "== listeners", "== accounts", "root:0", "== ports", "32768\t60999", "", MARKER_DONE, ""].join("\n");
    expect(readSecondBlockState(whole)).toEqual({ reserved: false, units: [], components: { backup: "absent", installer: "absent" }, listeners: [], autobind: false });
    // The units: their count missing, or more files than blocks, or systemctl failed.
    expect(readSecondBlockState(whole.replace("files 0\n", ""))).toBeNull();
    expect(readSecondBlockState(whole.replace("files 0", "files 2"))).toBeNull();
    expect(readSecondBlockState(whole.replace("files 0", "files 1\nId=a.service\nUser=site-a\nread failed"))).toBeNull();
    expect(readSecondBlockState(whole.replace("== listeners", "== listeners\nread failed"))).toBeNull();
    expect(readSecondBlockState(whole.replace("root:0", "read failed"))).toBeNull();
    expect(readSecondBlockState(whole.replace(MARKER_DONE, ""))).toBeNull();
    expect(readSecondBlockState(whole.replace("== units\n", ""))).toBeNull();
    expect(readSecondBlockState(whole.replace("installer absent", "installer maybe"))).toBeNull();
    expect(readSecondBlockState(whole.replace("installer absent\n", ""))).toBeNull();
    expect(readSecondBlockState(whole.replace("32768\t60999", "every port"))).toBeNull();
    expect(readSecondBlockState(whole.replace("== components", "User=site-x\n== components"))).toBeNull();
    expect(readSecondBlockState(whole.replace("== accounts", "== accounts\n").replace("== listeners", "== listeners\nnot a socket"))).toBeNull();
    expect(readSecondBlockState("")).toBeNull();
  });
});

describe("removing a project with several services", () => {
  test("every unit goes in the same action, the main one first", () => {
    const [unit] = removalActions({
      slug: "lab",
      isApplication: true,
      units: servicesOf(LAB).map((service) => service.unit),
    });
    expect(unit!.command).toBe(
      "sudo systemctl disable --now lab lab.api.service lab.inference.service 2>/dev/null || true && " +
        "sudo rm -f /etc/systemd/system/lab.service /etc/systemd/system/lab.api.service /etc/systemd/system/lab.inference.service && " +
        "sudo systemctl daemon-reload && { sudo systemctl reset-failed lab lab.api.service lab.inference.service 2>/dev/null || true; }",
    );
  });

  test("a single service keeps the command it always had", () => {
    const [unit] = removalActions({ slug: "budget", isApplication: true, units: ["budget"] });
    const [unnamed] = removalActions({ slug: "budget", isApplication: true });
    expect(unit!.command).toBe(unnamed!.command);
    expect(unit!.command).toBe(
      "sudo systemctl disable --now budget 2>/dev/null || true && sudo rm -f /etc/systemd/system/budget.service && sudo systemctl daemon-reload && " +
        "{ sudo systemctl reset-failed budget 2>/dev/null || true; }",
    );
  });
});

describe("the units of workers and scheduled services, on the machine", () => {
  /** The front, a sync every quarter of an hour with its timer, and a queue consumer. */
  const MIXED = lab({
    web: { start: "/srv/sites/lab/app/web", port: 3050 },
    sync: { start: "/srv/sites/lab/app/sync", schedule: "*:0/15" },
    queue: { start: "/srv/sites/lab/app/queue", internal: true },
  });
  const PLACEHOLDERS = { slug: "lab", zone: "test-zone.invalid", contact: "" };

  test("the listing finds the timers deploy laid, by their name with its suffix", () => {
    expect(listUnitsCommand("lab")).toInclude("/etc/systemd/system/lab.*.timer");
    const root = mkdtempSync(join(tmpdir(), "sitesolide-timers-"));
    try {
      const generated = generateUnits(MIXED, PLACEHOLDERS);
      for (const { unit, text } of generated) writeFileSync(join(root, unitFileName(unit)), text);
      // The timer of a schedule since dropped from the manifest, as deploy wrote it.
      const timer = generated.find(({ unit }) => unit === "lab.sync.timer")!.text;
      writeFileSync(join(root, "lab.old.timer"), timer.replace("schedule of service sync", "schedule of service old"));
      // A timer written by hand beside the project.
      writeFileSync(join(root, "lab.rollup.timer"), "[Unit]\nPartOf=lab.service\n[Timer]\nOnCalendar=daily\n");
      const script = listUnitsCommand("lab").replace(/^sudo sh -c '/, "").replace(/'$/, "").replaceAll("/etc/systemd/system", root);
      const read = readUnitsAnswer(Bun.spawnSync(["sh", "-c", script]).stdout.toString(), "lab");
      expect(read).toEqual({ kind: "read", units: ["lab.queue", "lab.sync", "lab.old.timer", "lab.sync.timer"] });
      expect(staleUnits(MIXED, read.kind === "read" ? read.units : [])).toEqual(["lab.old.timer"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a schedule dropped takes its timer with it, and a service that becomes a server leaves its timer stale", () => {
    expect(staleUnits(MIXED, ["lab.sync", "lab.sync.timer", "lab.queue"])).toEqual([]);
    expect(staleUnits(LAB, ["lab.api", "lab.inference", "lab.sync", "lab.sync.timer"])).toEqual(["lab.sync", "lab.sync.timer"]);
    const server = lab({ web: { start: "/x", port: 3050 }, sync: { start: "/y", port: 3051, internal: true } });
    expect(staleUnits(server, ["lab.sync", "lab.sync.timer"])).toEqual(["lab.sync.timer"]);
  });

  test("removed, the timers go first, so that none starts its service on the way out", () => {
    expect(removeUnitsCommand(["lab.sync", "lab.sync.timer"])).toBe(
      "sudo systemctl disable --now lab.sync.timer lab.sync.service 2>/dev/null || true && " +
        "sudo rm -f /etc/systemd/system/lab.sync.timer /etc/systemd/system/lab.sync.service && sudo systemctl daemon-reload && " +
        "{ sudo systemctl reset-failed lab.sync.timer lab.sync.service 2>/dev/null || true; }",
    );
  });

  test("a timer is asked of systemd by its own name, and judged as one", () => {
    expect(unitOriginsCommand("lab", ["lab", "lab.sync", "lab.sync.timer"])).toInclude('case "$u" in *.timer) n="$u";; *) n="$u.service";; esac;');
    const root = mkdtempSync(join(tmpdir(), "sitesolide-origins-"));
    try {
      const units = join(root, "units");
      Bun.spawnSync(["mkdir", "-p", units, join(root, "bin")]);
      const timer = generateUnits(MIXED, PLACEHOLDERS).find(({ unit }) => unit === "lab.sync.timer")!.text;
      writeFileSync(join(units, "lab.sync.timer"), timer);
      writeFileSync(join(root, "vendor.timer"), "[Timer]\nOnCalendar=daily\n");
      // A systemctl that knows deploy's timer, and a package's under the
      // name of a second one; it is asked `<name>.service` for a service.
      writeFileSync(
        join(root, "bin", "systemctl"),
        [
          "#!/bin/sh",
          "property=$3; unit=$5",
          `case "$unit" in`,
          `  lab.sync.timer) state=loaded; file=${units}/lab.sync.timer ;;`,
          `  lab.nightly.timer) state=loaded; file=${root}/vendor.timer ;;`,
          "  *) state=not-found; file= ;;",
          "esac",
          '[ "$property" = LoadState ] && echo "$state" || echo "$file"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const asked = ["lab.sync", "lab.sync.timer", "lab.nightly.timer"];
      const script = unitOriginsCommand("lab", asked).replace(/^sudo sh -c '/, "").replace(/'$/, "");
      const output = Bun.spawnSync(["sh", "-c", script], { env: { PATH: `${join(root, "bin")}:/usr/bin:/bin` } }).stdout.toString();
      const read = readUnitOrigins(output, asked);
      if (read.kind !== "read") throw new Error(`unreadable: ${output}`);
      // The service was asked as lab.sync.service, which this systemctl does not know.
      expect(read.facts.get("lab.sync")).toEqual({ loadState: "not-found", fragmentPath: "", generated: false, project: false });
      expect(read.facts.get("lab.sync.timer")).toEqual({ loadState: "loaded", fragmentPath: join(units, "lab.sync.timer"), generated: true, project: false });
      expect(foreignUnit("lab.sync.timer", "lab", read.facts.get("lab.sync.timer")!, units)).toBeNull();
      expect(foreignUnit("lab.nightly.timer", "lab", read.facts.get("lab.nightly.timer")!, units)).toBe(
        `lab.nightly.timer is already a timer of the machine, read from ${join(root, "vendor.timer")}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("removing the project takes every unit, the timers first", () => {
    const [unit] = removalActions({ slug: "lab", isApplication: true, units: unitNames(MIXED) });
    expect(unit!.command).toBe(
      "sudo systemctl disable --now lab.sync.timer lab lab.sync.service lab.queue.service 2>/dev/null || true && " +
        "sudo rm -f /etc/systemd/system/lab.sync.timer /etc/systemd/system/lab.service /etc/systemd/system/lab.sync.service /etc/systemd/system/lab.queue.service && " +
        "sudo systemctl daemon-reload && { sudo systemctl reset-failed lab.sync.timer lab lab.sync.service lab.queue.service 2>/dev/null || true; }",
    );
    // An anchored project: its anchor goes with its services and timers.
    const anchored = lab({ report: { start: "/x", schedule: "daily" } });
    const [anchor] = removalActions({ slug: "lab", isApplication: true, units: unitNames(anchored) });
    expect(anchor!.command).toStartWith("sudo systemctl disable --now lab.report.timer lab lab.report.service 2>/dev/null || true");
  });
});

describe("the schedules, read by systemd on the machine", () => {
  /** What `systemd-analyze calendar` accepts here: these three expressions, nothing else. */
  function check(schedules: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "sitesolide-calendar-"));
    try {
      writeFileSync(
        join(root, "systemd-analyze"),
        ["#!/bin/sh", '[ "$1" = calendar ] || exit 2', 'case "$2" in', '  hourly|"*:0/15"|"Mon..Fri 08:00") exit 0 ;;', "esac", "exit 1", ""].join("\n"),
        { mode: 0o755 },
      );
      const script = scheduleCheckCommand(schedules).replace(/^sh -c '/, "").replace(/'$/, "");
      return Bun.spawnSync(["sh", "-c", script], { env: { PATH: `${root}:/usr/bin:/bin` }, cwd: root }).stdout.toString();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("each expression asked as written, a star and a space included, one answer each and the end marker", () => {
    expect(scheduleCheckCommand(["hourly", "Mon..Fri 08:00"])).toBe(
      `sh -c 'if systemd-analyze calendar "hourly" >/dev/null 2>&1; then echo OK; else echo BAD; fi; ` +
        `if systemd-analyze calendar "Mon..Fri 08:00" >/dev/null 2>&1; then echo OK; else echo BAD; fi; echo ${MARKER_DONE}'`,
    );
    const schedules = ["hourly", "*:0/15", "every day", "Mon..Fri 08:00"];
    expect(readScheduleCheck(check(schedules), schedules)).toEqual(["every day"]);
    expect(readScheduleCheck(check(["hourly"]), ["hourly"])).toEqual([]);
  });

  test("an expression validate() refuses is never sent to a shell", () => {
    for (const schedule of ["daily'; reboot; '", "$(reboot)", 'daily" ; reboot ; "', "daily\nreboot"]) {
      expect(() => scheduleCheckCommand([schedule])).toThrow(/invalid schedule/);
    }
  });

  test("an answer without its marker, or with an answer missing or unknown, is unreadable", () => {
    expect(readScheduleCheck("", ["hourly"])).toBeNull();
    expect(readScheduleCheck("OK\n", ["hourly"])).toBeNull();
    expect(readScheduleCheck(`${MARKER_DONE}\n`, ["hourly"])).toBeNull();
    expect(readScheduleCheck(`OK\nOK\n${MARKER_DONE}\n`, ["hourly"])).toBeNull();
    expect(readScheduleCheck(`MAYBE\n${MARKER_DONE}\n`, ["hourly"])).toBeNull();
    expect(readScheduleCheck(`BAD\nOK\n${MARKER_DONE}\n`, ["daily", "hourly"])).toEqual(["daily"]);
  });
});

describe("how the services stand after their restart", () => {
  const UNITS = ["lab", "lab.queue"];

  /** `systemctl show` as systemd prints it: the service's own properties before the unit's, a blank line between units. */
  function shown(standings: [id: string, active: string, sub: string, restarts: number][]): string {
    const blocks = standings.map(([id, active, sub, restarts]) => `NRestarts=${restarts}\nId=${id}\nActiveState=${active}\nSubState=${sub}\n`);
    return `${blocks.join("\n")}${MARKER_DONE}\n`;
  }

  test("asked without sudo, the main unit as it always was, a secondary with its type", () => {
    expect(stabilityCommand(UNITS)).toBe(`systemctl show -p Id -p ActiveState -p SubState -p NRestarts -p ExecMainStatus lab lab.queue.service && echo ${MARKER_DONE}`);
    expect(() => stabilityCommand(["lab; reboot"])).toThrow(/invalid unit/);
  });

  test("each unit read by its Id, whatever the order systemd prints", () => {
    const read = readStability(shown([["lab.service", "active", "running", 0], ["lab.queue.service", "active", "running", 3]]), UNITS);
    expect(read).toEqual(
      new Map([
        ["lab", { active: "active", sub: "running", restarts: 0 }],
        ["lab.queue", { active: "active", sub: "running", restarts: 3 }],
      ]),
    );
  });

  test("a unit missing from the answer, or no marker, is unreadable", () => {
    expect(readStability(shown([["lab.service", "active", "running", 0]]), UNITS)).toBeNull();
    expect(readStability(shown([["lab.service", "active", "running", 0], ["lab.queue.service", "active", "running", 0]]).replace(MARKER_DONE, ""), UNITS)).toBeNull();
    expect(readStability("", UNITS)).toBeNull();
  });

  test("a service that held is never named; one that fell or was restarted meanwhile is, with what was seen", () => {
    const before = readStability(shown([["lab.service", "active", "running", 0], ["lab.queue.service", "active", "running", 1]]), UNITS)!;
    const held = readStability(shown([["lab.service", "active", "running", 0], ["lab.queue.service", "active", "running", 1]]), UNITS)!;
    expect(unstableUnits(before, held)).toEqual([]);
    const fell = readStability(shown([["lab.service", "failed", "failed", 0], ["lab.queue.service", "activating", "auto-restart", 4]]), UNITS)!;
    expect(unstableUnits(before, fell)).toEqual([
      "lab.service is failed (failed)",
      "lab.queue.service is activating (auto-restart), restarted 3 time(s) by systemd",
    ]);
    // Up again by the second reading, but restarted by systemd in between: it fell all the same.
    const flapped = readStability(shown([["lab.service", "active", "running", 2], ["lab.queue.service", "active", "running", 1]]), UNITS)!;
    expect(unstableUnits(before, flapped)).toEqual(["lab.service is active (running), restarted 2 time(s) by systemd"]);
  });

  test("a unit whose start exited 243 is said to lack its secret files, never as systemd's Protocol error", () => {
    const withStatus = (status: number) =>
      `Id=lab.service\nActiveState=failed\nSubState=failed\nNRestarts=0\nExecMainStatus=0\n\nId=lab.queue.service\nActiveState=activating\nSubState=auto-restart\nNRestarts=2\nExecMainStatus=${status}\n${MARKER_DONE}\n`;
    const before = readStability(shown([["lab.service", "active", "running", 0], ["lab.queue.service", "active", "running", 0]]), UNITS)!;
    const after = readStability(withStatus(243), UNITS)!;
    expect(after.get("lab.queue")).toEqual({ active: "activating", sub: "auto-restart", restarts: 2, status: 243 });
    expect(unstableUnits(before, after)).toEqual([
      "lab.service is failed (failed)",
      "lab.queue.service could not load its secret files (243/CREDENTIALS): the store's files folder is missing, or its files are too large; sitesolide refresh lab lays the folder again",
    ]);
    // Any other status is worded as before; a reading without the property keeps its shape.
    expect(unstableUnits(before, readStability(withStatus(1), UNITS)!)[1]).toBe("lab.queue.service is activating (auto-restart), restarted 2 time(s) by systemd");
    expect(readStability(shown([["lab.service", "active", "running", 0], ["lab.queue.service", "active", "running", 0]]), UNITS)!.get("lab")).toEqual({ active: "active", sub: "running", restarts: 0 });
  });
});
