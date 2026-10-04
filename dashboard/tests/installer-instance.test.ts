import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle } from "../borrowed/bundle";
import { judgeLock, holderText } from "../src/gatekeeper/machine";
import { lockHeldMessage } from "../src/gatekeeper/transaction";
import { REQUEST_MAX_AGE_MS } from "../src/control/protocol";
import { readLaunch, readRequest } from "../src/installer/instance";
import { main } from "../src/installer/main";
import { createHost, systemdRunArguments, type ProjectRun } from "../src/installer/real";

/**
 * The contract between the steward and the installer, the installer's unit
 * file, and the confinement it asks systemd for the project's account.
 */

const REPO = join(import.meta.dir, "..", "..");
const UNIT = readFileSync(join(REPO, "infra", "installer", "sitesolide-installer@.service"), "utf8");
const toClean: string[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
const REQUEST = {
  deployment: "0123456789abcdef01234567",
  slug: "shop",
  requestedAt: NOW,
  token: { id: "aaaaaaaaaaaa", email: "ada@test-zone.invalid" },
  scope: { slugs: [], create: true, outbound: false, domain: false, public: false },
  creating: true,
  manifest: "{}",
};

describe("the launch", () => {
  test("the slug from %n, and nothing else", () => {
    expect(readLaunch(["sitesolide-installer@shop.service"])).toEqual({ ok: true, slug: "shop" });
    for (const argv of [[], ["a", "b"], ["sitesolide-installer@.service"], ["sitesolide-installer@../x.service"], ["sitesolide-installer@Shop.service"], ["sitesolide-gatekeeper-on@shop.service"], ["sitesolide-installer@a.b.service"]]) {
      expect(readLaunch(argv).ok).toBe(false);
    }
  });
});

describe("the steward's request", () => {
  test("read for this slug, fresh", () => {
    expect(readRequest(JSON.stringify(REQUEST), "shop", NOW + 1000)).toEqual({ ok: true, request: REQUEST });
  });

  test("a replay, another slug, a missing field: nothing to do", () => {
    expect(readRequest(JSON.stringify(REQUEST), "shop", NOW + REQUEST_MAX_AGE_MS + 1)).toMatchObject({ ok: false, reason: expect.stringContaining("stale") });
    expect(readRequest(JSON.stringify(REQUEST), "cms", NOW)).toMatchObject({ ok: false });
    expect(readRequest(null, "shop", NOW)).toMatchObject({ ok: false });
    expect(readRequest("{", "shop", NOW)).toMatchObject({ ok: false });
    for (const key of ["deployment", "token", "scope", "creating", "manifest"]) {
      const { [key as keyof typeof REQUEST]: _dropped, ...partial } = REQUEST;
      expect(readRequest(JSON.stringify(partial), "shop", NOW).ok).toBe(false);
    }
    expect(readRequest(JSON.stringify({ ...REQUEST, scope: { ...REQUEST.scope, public: "yes" } }), "shop", NOW).ok).toBe(false);
  });

  test("main writes no result for a request it refuses: the real deployment keeps its own", async () => {
    const root = mkdtempSync(join(tmpdir(), "installer-main-"));
    toClean.push(root);
    mkdirSync(join(root, "state", "installs"), { recursive: true });
    mkdirSync(join(root, "results"));
    writeFileSync(join(root, "state", "installs", "shop.json"), JSON.stringify({ ...REQUEST, requestedAt: Date.now() - REQUEST_MAX_AGE_MS - 60_000 }));
    const code = await main(["sitesolide-installer@shop.service"], { SITESOLIDE_ZONE: "test-zone.invalid", STEWARD_STATE: join(root, "state"), INSTALLER_FOLDER: join(root, "results") });
    expect(code).toBe(0);
    expect(() => readFileSync(join(root, "results", `${REQUEST.deployment}.json`))).toThrow();
    expect(await main(["nonsense"], {})).toBe(2);
    expect(await main(["sitesolide-installer@shop.service"], {})).toBe(2);
  });
});

describe("--extract, the reader the project's account runs", () => {
  test("the built entry reads the archive on standard input and says so in one line of JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "installer-extract-"));
    toClean.push(root);
    const process = Bun.spawn([globalThis.process.execPath, join(REPO, "dashboard", "installer.ts"), "--extract", root], {
      stdin: bundle([{ kind: "file", path: "public/index.html", mtime: 1, executable: false, content: new TextEncoder().encode("hi") }]),
      stdout: "pipe",
    });
    expect(JSON.parse(await process.stdout.text())).toEqual({ ok: true, summary: { files: 1, directories: 1, bytes: 2 } });
    expect(await process.exited).toBe(0);
    expect(readFileSync(join(root, "public", "index.html"), "utf8")).toBe("hi");
  });
});

describe("the confinement asked of systemd-run", () => {
  const run = {
    slug: "shop",
    purpose: "extract" as const,
    command: ["/usr/local/bin/bun", "/usr/local/lib/sitesolide/installer.js", "--extract", "/srv/sites/shop/.incoming"],
    stdin: 3,
    binds: [{ source: "/srv/sites/shop/.incoming", target: "/srv/sites/shop/.incoming" }],
    workingDirectory: null,
    network: false,
    timeoutS: 300,
    memory: "256M",
  };

  test("the project's account, /srv hidden but the staging directory, no network for the extraction", () => {
    const line = systemdRunArguments(run).join(" ");
    for (const expected of [
      "-p User=site-shop",
      "-p Group=site-shop",
      "-p NoNewPrivileges=yes",
      "-p ProtectSystem=strict",
      "-p TemporaryFileSystem=/srv:ro",
      "-p BindPaths=/srv/sites/shop/.incoming:/srv/sites/shop/.incoming",
      "-p InaccessiblePaths=-/etc/sitesolide",
      "-p PrivateNetwork=yes",
      "-p MemoryMax=256M",
      "-p RuntimeMaxSec=300",
      "--wait --pipe",
    ]) {
      expect(line).toContain(expected);
    }
    expect(line.endsWith("/usr/local/bin/bun /usr/local/lib/sitesolide/installer.js --extract /srv/sites/shop/.incoming")).toBe(true);
  });

  test("install: the network, never the loopback, the staged app/ at its final path, writable", () => {
    const line = systemdRunArguments({ ...run, purpose: "install", network: true, binds: [{ source: "/srv/sites/shop/.incoming/app", target: "/srv/sites/shop/app" }], workingDirectory: "/srv/sites/shop/app", command: ["/bin/sh", "-s"] }).join(" ");
    expect(line).toContain("-p IPAddressDeny=localhost");
    expect(line).not.toContain("PrivateNetwork");
    expect(line).toContain("-p BindPaths=/srv/sites/shop/.incoming/app:/srv/sites/shop/app -p ReadWritePaths=/srv/sites/shop/app");
    expect(line).toContain("-p WorkingDirectory=/srv/sites/shop/app");
  });

  test("nothing expanded in the command line, and the manifest's command never in it", async () => {
    expect(systemdRunArguments(run)).toContain("--expand-environment=no");
    const seen: { command: string[]; stdin: unknown }[] = [];
    const root = mkdtempSync(join(tmpdir(), "installer-install-"));
    toClean.push(root);
    const host = createHost({
      sitesDir: root,
      unitsFolder: root,
      secretsFolder: root,
      spoolFolder: root,
      accountsFile: join(root, "passwd"),
      projectPortsFile: join(root, "nft"),
      deployAccount: null,
      dashboardAccount: null,
      extractor: [],
      machine: {} as never,
      commands: {
        asProject: async (requested: ProjectRun) => {
          seen.push({ command: requested.command, stdin: requested.stdin });
          return { code: 0, output: "" };
        },
      } as never,
      log: () => {},
    });
    mkdirSync(join(root, "shop", ".incoming"), { recursive: true });
    await host.install("shop", join(root, "shop", ".incoming"), "echo $HOME %n && bun install");
    expect(seen[0]!.command).toEqual(["/bin/sh", "-s"]);
    expect(new TextDecoder().decode(seen[0]!.stdin as Uint8Array)).toBe("echo $HOME %n && bun install\n");
  });
});

describe("the unit template", () => {
  test("a oneshot, started by the steward alone, with its environment and its limits", () => {
    for (const line of [
      "Type=oneshot",
      "ExecStart=/usr/local/bin/bun /usr/local/lib/sitesolide/installer.js %n",
      "EnvironmentFile=/etc/caddy/sitesolide.env",
      "EnvironmentFile=/etc/sitesolide-installer.env",
      "RuntimeDirectory=sitesolide-installer",
      "RuntimeDirectoryMode=0700",
      "NoNewPrivileges=true",
      "ProtectSystem=strict",
      "ReadOnlyPaths=/etc/sitesolide",
      "IPAddressDeny=any",
      "IPAddressAllow=localhost",
    ]) {
      expect(UNIT.split("\n")).toContain(line);
    }
    const directives = UNIT.split("\n").filter((line) => !line.startsWith("#"));
    expect(directives).not.toContain("[Install]");
    expect(directives.join("\n")).not.toMatch(/caddy (stop|start)/);
  });

  test("its delay covers the steps it bounds: extraction, install, and a Caddy step", () => {
    const minutes = Number(/^TimeoutStartSec=(\d+)min$/m.exec(UNIT)?.[1]);
    expect(minutes * 60).toBeGreaterThan(300 + 900 + 90);
  });
});

describe("Caddy's lock, held by an installer", () => {
  test("a dead installer's lock is taken over at once, as a dead gatekeeper's", () => {
    const now = 1_800_000_000_000;
    const text = holderText({ who: "installer", pid: 42, a: now - 1000 });
    expect(judgeLock(text, now - 1000, now, () => false)).toMatchObject({ kind: "stale", reason: "installer 42 is gone" });
    expect(judgeLock(text, now - 1000, now, () => true)).toMatchObject({ kind: "held" });
  });

  test("the gatekeeper says a deployment holds it, not the workstation", () => {
    expect(lockHeldMessage("installer", Date.UTC(2026, 9, 4, 14, 3, 12))).toBe("a deployment is being installed on the machine (since 14:03:12 UTC): try again in a moment");
  });
});
