import { describe, expect, test } from "bun:test";
import { LINK_MEMORY_MS, MAX_LINKS, countLinks, readEstablished, rememberLinks, unitOfCgroup, type RawLink } from "../src/links";
import { buildSnapshot, type Raw, type RawFolder, type RawUnit } from "../src/state";

const NOW = 1_756_400_000_000;

describe("the connections ss prints", () => {
  const listening = new Set([3047, 3048, 3049, 3128]);

  test("the client's end of a connection to a listening port, with its process", () => {
    const output = [
      '0      0      127.0.0.1:41234   127.0.0.1:3049  users:(("python3",pid=812,fd=9))',
      '0      0      127.0.0.1:3049    127.0.0.1:41234 users:(("python3",pid=640,fd=12))',
    ].join("\n");
    expect(readEstablished(output, listening)).toEqual([{ pid: 812, port: 3049 }]);
  });

  test("the State column, when ss prints it, and IPv6 loopback addresses", () => {
    const output = 'ESTAB 0 0 [::1]:51000 [::1]:3048 users:(("bun",pid=77,fd=20))';
    expect(readEstablished(output, listening)).toEqual([{ pid: 77, port: 3048 }]);
  });

  test("a socket bound to the loopback device by name", () => {
    expect(readEstablished("0 0 127.0.0.1%lo:52000 127.0.0.1%lo:3047", listening)).toEqual([{ pid: null, port: 3047 }]);
  });

  test("nothing that leaves the machine, nor a port that listens on nothing", () => {
    const output = [
      '0 0 203.0.113.10:443 198.51.100.7:51234 users:(("caddy",pid=5,fd=3))',
      '0 0 127.0.0.1:41000 127.0.0.1:5432 users:(("bun",pid=6,fd=3))',
      "garbage",
      "",
    ].join("\n");
    expect(readEstablished(output, listening)).toEqual([]);
  });

  test("a process's own name cannot pass for another pid: the last one is ss's", () => {
    const output = '0 0 127.0.0.1:41000 127.0.0.1:3049 users:(("a",pid=1,fd=1),("b",pid=900,fd=4))';
    expect(readEstablished(output, listening)).toEqual([{ pid: 900, port: 3049 }]);
  });
});

describe("a process's unit", () => {
  test("the innermost service of the unified hierarchy", () => {
    expect(unitOfCgroup("0::/system.slice/playground.api.service\n")).toBe("playground.api.service");
    expect(unitOfCgroup("0::/system.slice/caddy.service/payload\n")).toBe("caddy.service");
  });

  test("a login session or a scope belongs to no service", () => {
    expect(unitOfCgroup("0::/user.slice/user-1000.slice/session-3.scope\n")).toBeNull();
    expect(unitOfCgroup("0::/init.scope")).toBeNull();
    expect(unitOfCgroup("")).toBeNull();
  });

  test("a name systemd would never write is no unit", () => {
    expect(unitOfCgroup('0::/system.slice/a"b.service')).toBeNull();
  });
});

describe("counting and remembering", () => {
  test("connections are counted by unit and port, each process asked once", () => {
    const asked: number[] = [];
    const units: Record<number, string> = { 1: "caddy.service", 2: "playground.service" };
    const links = countLinks(
      [
        { pid: 1, port: 3047 },
        { pid: 1, port: 3047 },
        { pid: 2, port: 3049 },
        { pid: null, port: 3049 },
      ],
      (pid) => {
        asked.push(pid);
        return units[pid] ?? null;
      },
      NOW,
    );
    expect(asked).toEqual([1, 2]);
    expect(links).toEqual([
      { from: "caddy.service", port: 3047, open: 2, seen: NOW },
      { from: "playground.service", port: 3049, open: 1, seen: NOW },
      { from: null, port: 3049, open: 1, seen: NOW },
    ]);
  });

  test("a link not seen now is remembered closed, for a week", () => {
    const current: RawLink[] = [{ from: "caddy.service", port: 3047, open: 3, seen: NOW }];
    const previous = [
      { from: "caddy.service", port: 3047, open: 1, seen: NOW - 60_000 },
      { from: "playground.service", port: 3049, open: 2, seen: NOW - 60_000 },
      { from: "playground.digest.service", port: 3048, open: 0, seen: NOW - LINK_MEMORY_MS - 1 },
    ];
    expect(rememberLinks(current, previous, NOW)).toEqual([
      { from: "caddy.service", port: 3047, open: 3, seen: NOW },
      { from: "playground.service", port: 3049, open: 0, seen: NOW - 60_000 },
    ]);
  });

  test("what the previous file holds is checked, since another account owns its folder", () => {
    const previous = [
      { from: "x.service", port: 3049, open: 0, seen: NOW + 1 },
      { from: "../../etc", port: 3049, open: 0, seen: NOW },
      { from: "x.service", port: 99999, open: 0, seen: NOW },
      { from: "x.service", port: 3049, open: -1, seen: NOW },
      "a string",
      null,
    ];
    expect(rememberLinks([], previous, NOW)).toEqual([]);
    expect(rememberLinks([], { not: "a list" }, NOW)).toEqual([]);
  });

  test("a reading holds a bounded number of links", () => {
    const many = Array.from({ length: MAX_LINKS + 10 }, (_, index) => ({ from: `u${index}.service`, port: 3047, open: 0, seen: NOW - index }));
    expect(rememberLinks([], many, NOW)).toHaveLength(MAX_LINKS);
  });
});

function unit(properties: Partial<RawUnit> = {}): RawUnit {
  return {
    LoadState: "loaded",
    ActiveState: "active",
    SubState: "running",
    MemoryCurrent: "20971520",
    MemoryPeak: "31457280",
    MemoryMax: "268435456",
    NRestarts: "0",
    ActiveEnterTimestamp: "@1756400000",
    CPUUsageNSec: "120000000000",
    ...properties,
  };
}

const PLAYGROUND = {
  slug: "playground",
  env: { INFERENCE_URL: "http://127.0.0.1:3049", PUBLIC_URL: "https://{slug}.{zone}" },
  egress: ["api.anthropic.com"],
  connectors: ["slack"],
  publicDir: "public",
  services: {
    platform: { start: "/usr/local/bin/bun run web.ts", port: 3047, env: { API_URL: "http://localhost:3048/v1" } },
    api: { start: "/usr/local/bin/bun run api.ts --model http://127.0.0.1:3049", port: 3048, routes: ["/v1/*"] },
    inference: { start: "/usr/local/bin/bun run model.ts", port: 3049, internal: true },
    db: { start: "/usr/bin/postgres -D /srv/sites/playground/data/pg -p 3050", port: 3050, internal: true, backup: { folder: "pg", command: "/usr/bin/pg_dump" } },
  },
};

function snapshotWith(links: RawLink[] | undefined) {
  const folder: RawFolder = {
    slug: "playground",
    manifest: JSON.stringify(PLAYGROUND),
    unit: unit(),
    units: { "playground.api": unit(), "playground.inference": unit(), "playground.db": unit() },
    bytes: 1024,
    deployed: NOW,
  };
  const raw: Raw = {
    generated: NOW,
    zone: "test-zone.invalid",
    folders: [folder],
    codes: "{}",
    domains: null,
    ports: [3047, 3048, 3049, 3050],
    blocks: {},
    machine: null,
    previous: null,
    ...(links === undefined ? {} : { links }),
  };
  return buildSnapshot(raw).sites[0]!;
}

describe("a site's map", () => {
  test("what the manifest declares, a reading older than links aside", () => {
    const site = snapshotWith(undefined);
    expect(site.publicDir).toBe("public");
    expect(site.network).toEqual({ outbound: false, egress: ["api.anthropic.com"], connectors: ["slack"] });
    expect(site.services.map((service) => service.backup)).toEqual([null, null, null, "pg"]);
    expect(site.links).toEqual([
      // The service's own env, and the project's, which every service receives.
      { from: "playground", to: "playground.api", open: 0, seen: null, declared: ["API_URL"], shared: false },
      { from: "playground", to: "playground.inference", open: 0, seen: null, declared: ["INFERENCE_URL"], shared: true },
      // A port named on the command line; the shared variable rides along.
      { from: "playground.api", to: "playground.inference", open: 0, seen: null, declared: ["start", "INFERENCE_URL"], shared: false },
      { from: "playground.db", to: "playground.inference", open: 0, seen: null, declared: ["INFERENCE_URL"], shared: true },
    ]);
  });

  test("what was seen open, by whom, and nothing of another site's", () => {
    const site = snapshotWith([
      { from: "caddy.service", port: 3047, open: 4, seen: NOW },
      { from: "caddy.service", port: 3048, open: 0, seen: NOW - 3_600_000 },
      { from: "playground.api.service", port: 3050, open: 5, seen: NOW },
      { from: "playground.api.service", port: 3128, open: 1, seen: NOW },
      { from: "playground.service", port: 3129, open: 0, seen: NOW - 60_000 },
      // Another project's, and a process of no service reaching this site.
      { from: "blog.service", port: 3128, open: 2, seen: NOW },
      { from: null, port: 3049, open: 1, seen: NOW },
      // Caddy reaching another site's port.
      { from: "caddy.service", port: 3040, open: 1, seen: NOW },
    ]);
    const seen = site.links.filter((link) => link.seen !== null);
    expect(seen).toEqual([
      { from: "caddy", to: "playground", open: 4, seen: NOW, declared: [], shared: false },
      { from: "caddy", to: "playground.api", open: 0, seen: NOW - 3_600_000, declared: [], shared: false },
      { from: "playground.api", to: "playground.db", open: 5, seen: NOW, declared: [], shared: false },
      { from: "playground.api", to: "egress", open: 1, seen: NOW, declared: [], shared: false },
      { from: "playground", to: "connectors", open: 0, seen: NOW - 60_000, declared: [], shared: false },
      { from: "outside", to: "playground.inference", open: 1, seen: NOW, declared: [], shared: false },
    ]);
  });

  test("a link both seen and declared is one line", () => {
    const site = snapshotWith([{ from: "playground.api.service", port: 3049, open: 2, seen: NOW }]);
    expect(site.links.find((link) => link.from === "playground.api" && link.to === "playground.inference")).toEqual({
      from: "playground.api",
      to: "playground.inference",
      open: 2,
      seen: NOW,
      declared: ["start", "INFERENCE_URL"],
      shared: false,
    });
  });

  test("a static site has no map", () => {
    const raw: Raw = {
      generated: NOW,
      zone: "test-zone.invalid",
      folders: [{ slug: "blog", manifest: JSON.stringify({ slug: "blog", publicDir: "public" }), unit: null, bytes: 1, deployed: NOW }],
      codes: "{}",
      domains: null,
      ports: [],
      links: [{ from: "caddy.service", port: 3047, open: 1, seen: NOW }],
      blocks: {},
      machine: null,
      previous: null,
    };
    const site = buildSnapshot(raw).sites[0]!;
    expect(site.links).toEqual([]);
    expect(site.publicDir).toBeNull();
  });
});
