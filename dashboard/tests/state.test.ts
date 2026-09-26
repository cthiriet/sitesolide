import { describe, expect, test } from "bun:test";
import {
  LANDING_FOLDER,
  LANDING_UNIT,
  addressOf,
  buildSnapshot,
  computeCpuShare,
  readTable,
  unitOf,
  type Raw,
  type RawFolder,
  type RawUnit,
} from "../src/state";

const CODE = "A7B2K9";

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

function folder(slug: string, manifest: unknown, remaining: Partial<RawFolder> = {}): RawFolder {
  return {
    slug,
    manifest: manifest === null ? null : JSON.stringify(manifest),
    unit: null,
    bytes: 1024,
    deployed: 1_700_000_000_000,
    ...remaining,
  };
}

function raw(folders: RawFolder[], remaining: Partial<Raw> = {}): Raw {
  return {
    generated: 1_756_400_000_000,
    zone: "test-zone.invalid",
    folders,
    codes: "{}",
    domains: null,
    ports: [],
    blocks: {},
    machine: null,
    previous: null,
    ...remaining,
  };
}

/** The messages are long and will change; the tests aim at the subject, not the sentence. */
function messages(snapshot: ReturnType<typeof buildSnapshot>, slug: string | null): string[] {
  return snapshot.discrepancies.filter((discrepancy) => discrepancy.slug === slug).map((discrepancy) => discrepancy.message);
}

describe("project type", () => {
  test("a manifest with no start is a static site", () => {
    const { sites } = buildSnapshot(raw([folder("showcase", { slug: "showcase", publicDir: "public" })]));
    expect(sites[0]?.type).toBe("static");
    expect(sites[0]?.service).toBeNull();
  });

  test("a manifest with a start is an app project", () => {
    const manifest = { slug: "tool", port: 3030, publicDir: "public", start: "bun run server.ts" };
    const { sites } = buildSnapshot(
      raw([folder("tool", manifest, { unit: unit() })], { ports: [3030] }),
    );
    expect(sites[0]?.type).toBe("app");
    expect(sites[0]?.port).toBe(3030);
    expect(sites[0]?.listening).toBe(true);
  });

  test("a missing unit is not a fallen service", () => {
    const { sites } = buildSnapshot(
      raw([folder("showcase", { slug: "showcase", publicDir: "public" }, { unit: { LoadState: "not-found" } })]),
    );
    expect(sites[0]?.service).toBeNull();
    expect(messages(buildSnapshot(raw([])), null)).toHaveLength(0);
  });
});

describe("the lock", () => {
  test("a closed lock yields the link to send, code included", () => {
    const { sites, discrepancies } = buildSnapshot(
      raw([folder("client", { slug: "client", publicDir: "public", lock: true })], {
        codes: JSON.stringify({ client: CODE }),
      }),
    );
    expect(sites[0]?.lock).toEqual({
      closed: true,
      code: CODE,
      url: `https://client.test-zone.invalid/?key=${CODE}`,
    });
    expect(discrepancies).toHaveLength(0);
  });

  test("a lock asked for with no valid code is an error", () => {
    const snapshot = buildSnapshot(
      raw([folder("client", { slug: "client", publicDir: "public", lock: true })]),
    );
    expect(messages(snapshot, "client")).toHaveLength(1);
    expect(snapshot.discrepancies[0]?.severity).toBe("error");
    expect(snapshot.discrepancies[0]?.message).toContain("lock.sh enable client");
  });

  test("a lower-case or too short code does not count as a code", () => {
    const snapshot = buildSnapshot(
      raw([folder("client", { slug: "client", publicDir: "public", lock: true })], {
        codes: JSON.stringify({ client: "a7b2k9" }),
      }),
    );
    expect(snapshot.sites[0]?.lock.code).toBeNull();
    expect(messages(snapshot, "client")).toHaveLength(1);
  });

  test("a code in force with no lock asked for is an error, the other way round", () => {
    const snapshot = buildSnapshot(
      raw([folder("client", { slug: "client", publicDir: "public" })], {
        codes: JSON.stringify({ client: CODE }),
      }),
    );
    expect(snapshot.discrepancies[0]?.severity).toBe("error");
    expect(snapshot.discrepancies[0]?.message).toContain("lock.sh disable client");
  });

  test("an unreadable code table says so instead of keeping quiet", () => {
    const snapshot = buildSnapshot(raw([], { codes: "{ not json" }));
    expect(messages(snapshot, null)).toHaveLength(1);
  });
});

describe("domain", () => {
  const manifest = {
    slug: "client",
    publicDir: "public",
    domain: { name: "example.test", active: true },
  };

  test("an active domain missing from the table is an error", () => {
    const snapshot = buildSnapshot(raw([folder("client", manifest)]));
    expect(snapshot.sites[0]?.domain?.route).toBe(false);
    expect(snapshot.discrepancies[0]?.severity).toBe("error");
    expect(snapshot.discrepancies[0]?.message).toContain("generate-domains.sh");
  });

  test("an active and routed domain flags nothing", () => {
    const snapshot = buildSnapshot(
      raw([folder("client", manifest)], { domains: "\texample.test client\n" }),
    );
    expect(snapshot.sites[0]?.domain?.route).toBe(true);
    expect(snapshot.discrepancies).toHaveLength(0);
  });

  test("a routed domain the manifest no longer activates is a warning", () => {
    const inactive = { ...manifest, domain: { name: "example.test", active: false } };
    const snapshot = buildSnapshot(
      raw([folder("client", inactive)], { domains: "\texample.test client\n" }),
    );
    expect(snapshot.discrepancies[0]?.severity).toBe("warning");
  });

  test("the table ignores its comments and its wobbly lines", () => {
    const table = readTable("# generated\n\texample.test client\nwobbly\n");
    expect([...table]).toEqual([["example.test", "client"]]);
  });
});

describe("service", () => {
  const manifest = { slug: "tool", port: 3030, publicDir: "public", start: "bun run server.ts" };

  test("a failed service is a named error", () => {
    const snapshot = buildSnapshot(
      raw([folder("tool", manifest, { unit: unit({ ActiveState: "failed", SubState: "failed" }) })], {
        ports: [3030],
      }),
    );
    expect(messages(snapshot, "tool")).toEqual(["Service failed (failed)"]);
  });

  test("a declared port nobody listens on is an error", () => {
    const snapshot = buildSnapshot(
      raw([folder("tool", manifest, { unit: unit() })], { ports: [3011] }),
    );
    expect(snapshot.sites[0]?.listening).toBe(false);
    expect(messages(snapshot, "tool")[0]).toContain("3030");
  });

  test("an app project with no loaded unit is an error", () => {
    const snapshot = buildSnapshot(raw([folder("tool", manifest)], { ports: [3030] }));
    expect(messages(snapshot, "tool")[0]).toContain("without a loaded unit");
  });

  test("a peak close to the limit is a warning", () => {
    const snapshot = buildSnapshot(
      raw([folder("tool", manifest, { unit: unit({ MemoryPeak: "241591910" }) })], { ports: [3030] }),
    );
    expect(messages(snapshot, "tool")).toEqual(["Memory peak at 90% of the limit"]);
  });

  test("the unix timestamp becomes a date, and zero stays an absence", () => {
    const with_ = buildSnapshot(raw([folder("tool", manifest, { unit: unit() })], { ports: [3030] }));
    expect(with_.sites[0]?.service?.since).toBe(1_756_400_000_000);

    const without = buildSnapshot(
      raw([folder("tool", manifest, { unit: unit({ ActiveEnterTimestamp: "@0" }) })], { ports: [3030] }),
    );
    expect(without.sites[0]?.service?.since).toBeNull();
  });

  test("systemd's unset values do not become zeros", () => {
    const snapshot = buildSnapshot(
      raw([folder("tool", manifest, { unit: unit({ MemoryMax: "infinity", MemoryPeak: "[not set]" }) })], {
        ports: [3030],
      }),
    );
    expect(snapshot.sites[0]?.service?.limit).toBeNull();
    expect(snapshot.sites[0]?.service?.peak).toBeNull();
  });
});

describe("processor", () => {
  const manifest = { slug: "tool", port: 3030, publicDir: "public", start: "bun run server.ts" };

  test("with no previous reading, the rate is absent and not zero", () => {
    const { sites } = buildSnapshot(
      raw([folder("tool", manifest, { unit: unit() })], { ports: [3030] }),
    );
    expect(sites[0]?.service?.cpuShare).toBeNull();
    // The running total, though, reads from the very first reading: it needs no delta.
    expect(sites[0]?.service?.cpuTotal).toBe(120_000);
  });

  test("one full core over the whole window makes a hundred per cent", () => {
    // Sixty seconds of wall clock, sixty seconds of CPU consumed.
    expect(computeCpuShare(120_000_000_000, 60_000_000_000, 60_000)).toBe(100);
    expect(computeCpuShare(90_000_000_000, 60_000_000_000, 60_000)).toBe(50);
  });

  test("a service with several threads goes past a hundred, and that is not capped", () => {
    expect(computeCpuShare(240_000_000_000, 60_000_000_000, 60_000)).toBe(300);
  });

  test("a counter that goes backwards is a restart, not negative consumption", () => {
    expect(computeCpuShare(10_000_000_000, 60_000_000_000, 60_000)).toBeNull();
  });

  test("a zero window or a missing counter yield nothing", () => {
    expect(computeCpuShare(120_000_000_000, 60_000_000_000, 0)).toBeNull();
    expect(computeCpuShare(120_000_000_000, undefined, 60_000)).toBeNull();
    expect(computeCpuShare(null, 60_000_000_000, 60_000)).toBeNull();
  });

  test("the rate is computed over the window between the two readings", () => {
    const { sites } = buildSnapshot(
      raw([folder("tool", manifest, { unit: unit() })], {
        ports: [3030],
        generated: 1_756_400_060_000,
        previous: { generated: 1_756_400_000_000, cpu: { tool: 90_000_000_000 } },
      }),
    );
    expect(sites[0]?.service?.cpuShare).toBe(50);
  });
});

describe("the machine's load", () => {
  const machine = {
    memoryTotal: null,
    memoryAvailable: null,
    diskTotal: null,
    diskFree: null,
    load1: 0.5,
    load5: 0.4,
    load15: 0.3,
    cores: 4,
  };

  test("an idle machine flags nothing", () => {
    expect(buildSnapshot(raw([], { machine })).discrepancies).toHaveLength(0);
  });

  test("a load beyond the number of cores is a warning", () => {
    const chargee = buildSnapshot(raw([], { machine: { ...machine, load5: 6.2 } }));
    expect(chargee.discrepancies[0]).toMatchObject({ slug: null, severity: "warning" });
    expect(chargee.discrepancies[0]?.message).toContain("6.2");
    expect(chargee.discrepancies[0]?.message).toContain("4 cores");
  });

  test("a load equal to the number of cores does not trigger yet", () => {
    expect(buildSnapshot(raw([], { machine: { ...machine, load5: 4 } })).discrepancies).toHaveLength(0);
  });

  test("with no known cores, no load is judged", () => {
    const without = { ...machine, load5: 99, cores: null };
    expect(buildSnapshot(raw([], { machine: without })).discrepancies).toHaveLength(0);
  });
});

describe("the machine's special cases", () => {
  test("the landing is neither a forgotten directory nor a fallen service", () => {
    expect(unitOf(LANDING_FOLDER)).toBe(LANDING_UNIT);
    const snapshot = buildSnapshot(
      raw([folder(LANDING_FOLDER, null, { unit: unit() })]),
    );
    expect(snapshot.sites[0]?.type).toBe("app");
    expect(snapshot.discrepancies).toHaveLength(0);
  });

  test("the landing takes the bare domain, not test-zone.invalid.test-zone.invalid", () => {
    expect(addressOf(LANDING_FOLDER, "test-zone.invalid")).toBe("test-zone.invalid");
    expect(addressOf("client", "test-zone.invalid")).toBe("client.test-zone.invalid");
    const snapshot = buildSnapshot(raw([folder(LANDING_FOLDER, null)]));
    expect(snapshot.sites[0]?.address).toBe("test-zone.invalid");
  });

  test("any other directory with no manifest is flagged", () => {
    const snapshot = buildSnapshot(raw([folder("forgotten", null)]));
    expect(snapshot.sites[0]?.type).toBe("no-manifest");
    expect(snapshot.discrepancies[0]?.severity).toBe("warning");
  });

  test("an unreadable manifest is an error, not a site ignored", () => {
    const snapshot = buildSnapshot(
      raw([{ slug: "broken", manifest: "{ oops", unit: null, bytes: null, deployed: null }]),
    );
    expect(messages(snapshot, "broken")[0]).toContain("unreadable");
  });

  test("a Caddy fragment with no directory is flagged", () => {
    const snapshot = buildSnapshot(raw([], { blocks: { ghost: "" } }));
    expect(snapshot.discrepancies[0]).toMatchObject({ slug: "ghost", severity: "warning" });
  });

  test("the sites come out sorted, and the errors before the warnings", () => {
    const snapshot = buildSnapshot(
      raw([folder("zebra", null), folder("client", { slug: "client", publicDir: "public", lock: true })]),
    );
    expect(snapshot.sites.map((site) => site.slug)).toEqual(["client", "zebra"]);
    expect(snapshot.discrepancies.map((discrepancy) => discrepancy.severity)).toEqual(["error", "warning"]);
  });

  test("the secrets are named, never read", () => {
    const manifest = { slug: "tool", port: 3030, start: "bun run server.ts", secrets: ["tool.env"] };
    const { sites } = buildSnapshot(
      raw([folder("tool", manifest, { unit: unit() })], { ports: [3030] }),
    );
    expect(sites[0]?.secrets).toEqual(["tool.env"]);
  });
});

describe("the portal's door", () => {
  const PROTEGE = { slug: "kanban", port: 3045, start: "bun run server.ts", portal: true };
  /** What bin/cli/portal.ts writes into the block, and the collector reads back. */
  const WITH_DOOR = "forward_auth @portal_guard 127.0.0.1:3026 {\n\turi /verifier\n}";

  test("a protected site whose block carries the door has nothing to flag", () => {
    const snapshot = buildSnapshot(
      raw([folder("kanban", PROTEGE), folder("portal", { slug: "portal", port: 3026, start: "bun run server.ts" }, { unit: unit() })], {
        blocks: { kanban: WITH_DOOR },
      }),
    );
    expect(snapshot.sites[0]?.portal).toEqual({ wanted: true, installed: true, exemptions: [] });
    expect(messages(snapshot, "kanban").filter((m) => m.includes("portal"))).toEqual([]);
  });

  test("portal asked for and block with no door: the worst state, told as an error", () => {
    // The manifest says closed, Caddy serves in the clear, and the owner
    // believes their site is closed. That is exactly what this dashboard
    // exists to show.
    const snapshot = buildSnapshot(
      raw([folder("kanban", PROTEGE)], { blocks: { kanban: "reverse_proxy 127.0.0.1:3045" } }),
    );
    expect(snapshot.sites[0]?.portal.installed).toBe(false);
    expect(messages(snapshot, "kanban")).toContainEqual(expect.stringContaining("served unprotected"));
    expect(snapshot.discrepancies.find((e) => e.slug === "kanban")?.severity).toBe("error");
  });

  test("a door installed that the manifest no longer asks for", () => {
    const snapshot = buildSnapshot(
      raw([folder("kanban", { ...PROTEGE, portal: undefined })], { blocks: { kanban: WITH_DOOR } }),
    );
    expect(messages(snapshot, "kanban")).toContainEqual(expect.stringContaining("no longer asks for it"));
  });

  test("the exemptions are taken from the manifest, never guessed", () => {
    const snapshot = buildSnapshot(
      raw([folder("roster", { ...PROTEGE, slug: "roster", portalExempt: ["/webhooks/*", 42] })], {
        blocks: { roster: WITH_DOOR },
      }),
    );
    expect(snapshot.sites[0]?.portal.exemptions).toEqual(["/webhooks/*"]);
  });

  test("the portal's service being stopped is said once, not per site", () => {
    const snapshot = buildSnapshot(
      raw([folder("kanban", PROTEGE), folder("roster", { ...PROTEGE, slug: "roster" })], {
        blocks: { kanban: WITH_DOOR, roster: WITH_DOOR },
      }),
    );
    expect(messages(snapshot, "portal")).toContainEqual(
      expect.stringContaining("2 site(s) behind the portal"),
    );
  });

  test("with no protected site, a stopped portal says nothing", () => {
    const snapshot = buildSnapshot(raw([folder("showcase", { slug: "showcase", publicDir: "public" })]));
    expect(messages(snapshot, "portal").filter((m) => m.includes("behind the portal"))).toEqual([]);
  });
});
