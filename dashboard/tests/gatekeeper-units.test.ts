import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readLaunch, gatekeeperUnit } from "../src/gatekeeper/instance";

/**
 * The gatekeeper's two unit templates, read the way systemd reads them. They
 * are only measured on the bench (see the laboratory report), but what makes them
 * safe is checked here: each one writes only into the directory of the site it
 * names, with no capability too many, and the two differ only by their action.
 */
const ROOT = join(import.meta.dir, "..", "..");
const FOLDER = join(ROOT, "infra", "gatekeeper");
const ACTIONS = ["on", "off"] as const;

function read(action: string): string {
  return readFileSync(join(FOLDER, `sitesolide-gatekeeper-${action}@.service`), "utf8");
}

/** A section's directives, in order, comments and blank lines discarded. */
function directives(text: string, section: string): [string, string][] {
  const found: [string, string][] = [];
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header !== null) {
      current = header[1]!;
      continue;
    }
    if (current !== section) continue;
    const equal = line.indexOf("=");
    found.push([line.slice(0, equal), line.slice(equal + 1)]);
  }
  return found;
}

function values(text: string, key: string): string[] {
  return directives(text, "Service")
    .filter(([c]) => c === key)
    .map(([, v]) => v);
}

describe("the gatekeeper's two units", () => {
  test("the single template from before is gone", () => {
    expect(existsSync(join(FOLDER, "sitesolide-gatekeeper@.service"))).toBe(false);
  });

  test("they differ only by their action", () => {
    const on = read("on");
    const off = read("off");
    const onLines = on.split("\n");
    const offLines = off.split("\n");
    expect(offLines).toHaveLength(onLines.length);
    const differences = onLines.map((line, i) => [line, offLines[i]!] as const).filter(([a, b]) => a !== b);
    expect(differences).toEqual([
      ["# The gatekeeper, `on` action: sets the portal in front of a site, one", "# The gatekeeper, `off` action: removes the portal from a site, one"],
      ["#   systemctl start sitesolide-gatekeeper-on@cms.service", "#   systemctl start sitesolide-gatekeeper-off@cms.service"],
      ["# sitesolide-gatekeeper-off@.service differ only by the action, and", "# sitesolide-gatekeeper-on@.service differ only by the action, and"],
      ["Description=Gatekeeper, portal on %i", "Description=Gatekeeper, portal off %i"],
      ["Environment=GATEKEEPER_ACTION=on", "Environment=GATEKEEPER_ACTION=off"],
    ]);
  });

  for (const action of ACTIONS) {
    describe(`sitesolide-gatekeeper-${action}@.service`, () => {
      const text = read(action);

      test("its action, and the full name systemd resolved", () => {
        expect(values(text, "Environment")).toEqual([`GATEKEEPER_ACTION=${action}`]);
        expect(values(text, "ExecStart")).toEqual(["/usr/local/bin/bun /usr/local/lib/sitesolide/gatekeeper.js %n"]);
        expect(values(text, "Type")).toEqual(["oneshot"]);
        // What systemd would pass for cms is accepted, and only with this action.
        const name = gatekeeperUnit("cms", action === "on")!;
        expect(name).toBe(`sitesolide-gatekeeper-${action}@cms.service`);
        expect(readLaunch([name], action)).toEqual({ ok: true, instance: { slug: "cms", active: action === "on" } });
        expect(readLaunch([name], action === "on" ? "off" : "on").ok).toBe(false);
      });

      test("it writes only into the named site's directory, the blocks and its own directory", () => {
        expect(values(text, "ProtectSystem")).toEqual(["strict"]);
        expect(values(text, "ReadWritePaths")).toEqual(["/srv/sites/%i /etc/caddy/sites /run/sitesolide-gatekeeper"]);
        expect(values(text, "ReadOnlyPaths")).toEqual(["-/srv/sites/%i/app -/srv/sites/%i/public"]);
        const inaccessibles = values(text, "InaccessiblePaths").join(" ").split(" ");
        expect(inaccessibles).toContain("-/srv/sites/%i/data");
        expect(inaccessibles).toContain("-/etc/sitesolide");
        // Never the unescaped form, which would turn sample-api into the path sample/api.
        for (const [key, value] of directives(text, "Service")) {
          expect({ key, unescaped: value.includes("%I") }).toEqual({ key, unescaped: false });
        }
        expect(values(text, "RuntimeDirectory")).toEqual(["sitesolide-gatekeeper"]);
        expect(values(text, "RuntimeDirectoryPreserve")).toEqual(["yes"]);
      });

      test("two capabilities, and no more CAP_NET_BIND_SERVICE", () => {
        expect(values(text, "CapabilityBoundingSet")).toEqual(["CAP_DAC_OVERRIDE CAP_CHOWN"]);
        expect(values(text, "NoNewPrivileges")).toEqual(["true"]);
        expect(values(text, "AmbientCapabilities")).toEqual([]);
      });

      test("the rest of the hardening is kept", () => {
        const expected: Record<string, string> = {
          UMask: "0077",
          ProtectHome: "true",
          PrivateTmp: "true",
          PrivateDevices: "true",
          PrivateIPC: "true",
          IPAddressDeny: "any",
          IPAddressAllow: "localhost",
          RestrictAddressFamilies: "AF_UNIX AF_INET AF_INET6",
          ProtectKernelTunables: "true",
          ProtectKernelModules: "true",
          ProtectKernelLogs: "true",
          ProtectControlGroups: "true",
          ProtectClock: "true",
          ProtectHostname: "true",
          ProtectProc: "invisible",
          ProcSubset: "pid",
          RestrictNamespaces: "true",
          RestrictSUIDSGID: "true",
          RestrictRealtime: "true",
          LockPersonality: "true",
          SystemCallArchitectures: "native",
          SystemCallFilter: "@system-service",
          MemoryMax: "256M",
          TimeoutStopSec: "5s",
        };
        for (const [key, value] of Object.entries(expected)) {
          expect({ key, values: values(text, key) }).toEqual({ key, values: [value] });
        }
      });

      test("it never enables itself", () => {
        expect(directives(text, "Install")).toEqual([]);
        expect(text).not.toMatch(/^\[Install\]/m);
      });
    });
  }
});

describe("bin/deploy-gatekeeper.sh", () => {
  const script = readFileSync(join(ROOT, "bin", "deploy-gatekeeper.sh"), "utf8");

  test("it installs and checks both units, and removes the template from before", () => {
    for (const action of ACTIONS) {
      expect(script).toContain(`sitesolide-gatekeeper-${action}@.service`);
    }
    expect(script).toContain("systemd-analyze verify");
    expect(script).toContain("sitesolide-gatekeeper@.service");
    expect(script).toMatch(/rm -f .*PREVIOUS_TEMPLATE/);
  });

  test("it starts no transaction", () => {
    const code = script.split("\n").filter((line) => !/^\s*#/.test(line));
    for (const line of code) {
      expect({ line, starts: /systemctl\s+(start|restart|reload)\b/.test(line) }).toMatchObject({ starts: false });
    }
  });
});
