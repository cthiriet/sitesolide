import { describe, expect, test } from "bun:test";
import { generateFragment } from "../cli/fragment";
import {
  isApp,
  mainPort,
  routesOverlap,
  servicesOf,
  validate,
  type Manifest,
} from "../cli/manifest";
import { removalActions } from "../cli/removal";
import {
  MARKER_DONE,
  currentPairsCommand,
  listUnitsCommand,
  projectPortsCommand,
  readCurrentPairs,
  portConflicts,
  readLoopbackState,
  readUidsAnswer,
  readUnitsAnswer,
  removeUnitsCommand,
  staleUnits,
  uidsCommand,
} from "../cli/services";
import { generateUnit, generateUnits, unitArgument } from "../cli/unit";
import { projectPortPairs, projectPortsFile } from "../cli/loopback";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  secrets: ["lab.env"],
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
      expect.stringContaining("services.web.port: between 3000 and 3099"),
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
    expect(validate(lab({ jobs: { start: "/y", port: 3051, internal: true } }))).toContainEqual(
      expect.stringContaining("without publicDir, one public service"),
    );
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
      expect(text(unit)).toInclude("EnvironmentFile=-/etc/sitesolide/lab.env");
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
    expect(fragment).toInclude("\t@service-api path /v1/*\n\treverse_proxy @service-api 127.0.0.1:3051\n");
    expect(fragment).toInclude("\treverse_proxy 127.0.0.1:3050\n");
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
    expect(mixed).toInclude("\treverse_proxy @service-platform 127.0.0.1:3050\n");
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
      "sudo systemctl disable --now lab.old.service 2>/dev/null || true && sudo rm -f /etc/systemd/system/lab.old.service && sudo systemctl daemon-reload",
    );
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

describe("removing a project with several services", () => {
  test("every unit goes in the same action, the main one first", () => {
    const [unit] = removalActions({
      slug: "lab",
      isApplication: true,
      secrets: [],
      units: servicesOf(LAB).map((service) => service.unit),
    });
    expect(unit!.command).toBe(
      "sudo systemctl disable --now lab lab.api.service lab.inference.service 2>/dev/null || true && " +
        "sudo rm -f /etc/systemd/system/lab.service /etc/systemd/system/lab.api.service /etc/systemd/system/lab.inference.service && " +
        "sudo systemctl daemon-reload",
    );
  });

  test("a single service keeps the command it always had", () => {
    const [unit] = removalActions({ slug: "budget", isApplication: true, secrets: [], units: ["budget"] });
    const [legacy] = removalActions({ slug: "budget", isApplication: true, secrets: [] });
    expect(unit!.command).toBe(legacy!.command);
    expect(unit!.command).toBe(
      "sudo systemctl disable --now budget 2>/dev/null || true && sudo rm -f /etc/systemd/system/budget.service && sudo systemctl daemon-reload",
    );
  });
});
