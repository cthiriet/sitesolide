import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readLaunch, gatekeeperUnit } from "../src/gatekeeper/instance";

/**
 * The gatekeeper's four unit templates, read the way systemd reads them. They
 * are only measured on the bench (see the laboratory report), but what makes them
 * safe is checked here: each one writes only into the directory of the site it
 * names, the blocks and the preview locks, with no capability too many, and the
 * four differ only by their action.
 */
const ROOT = join(import.meta.dir, "..", "..");
const FOLDER = join(ROOT, "infra", "gatekeeper");
const ACTIONS = ["on", "off", "code", "renew"] as const;

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

describe("the gatekeeper's four units", () => {
  test("the single template from before is gone", () => {
    expect(existsSync(join(FOLDER, "sitesolide-gatekeeper@.service"))).toBe(false);
  });

  test("they differ only by their action", () => {
    const WORDS: Record<(typeof ACTIONS)[number], [string, string]> = {
      on: ["makes a site Restricted, one", "Restricted"],
      off: ["makes a site Public, one", "Public"],
      code: ["opens a site to anyone with its code, one", "Anyone with the code"],
      renew: ["gives a site a new code, one", "new code"],
    };
    const onLines = read("on").split("\n");
    for (const action of ACTIONS.slice(1)) {
      const lines = read(action).split("\n");
      expect(lines).toHaveLength(onLines.length);
      const differences = onLines.map((line, i) => [line, lines[i]!] as const).filter(([a, b]) => a !== b);
      expect(differences).toEqual([
        [`# The gatekeeper, \`on\` action: ${WORDS.on[0]}`, `# The gatekeeper, \`${action}\` action: ${WORDS[action][0]}`],
        ["#   systemctl start sitesolide-gatekeeper-on@cms.service", `#   systemctl start sitesolide-gatekeeper-${action}@cms.service`],
        [`Description=Gatekeeper, ${WORDS.on[1]} %i`, `Description=Gatekeeper, ${WORDS[action][1]} %i`],
        ["Environment=GATEKEEPER_ACTION=on", `Environment=GATEKEEPER_ACTION=${action}`],
      ]);
    }
  });

  for (const action of ACTIONS) {
    describe(`sitesolide-gatekeeper-${action}@.service`, () => {
      const text = read(action);

      test("its action, and the full name systemd resolved", () => {
        expect(values(text, "Environment")).toEqual([`GATEKEEPER_ACTION=${action}`]);
        expect(values(text, "ExecStart")).toEqual(["/usr/local/bin/bun /usr/local/lib/sitesolide/gatekeeper.js %n"]);
        expect(values(text, "Type")).toEqual(["oneshot"]);
        // What systemd would pass for cms is accepted, and only with this action.
        const name = gatekeeperUnit("cms", action)!;
        expect(name).toBe(`sitesolide-gatekeeper-${action}@cms.service`);
        expect(readLaunch([name], action)).toEqual({ ok: true, instance: { slug: "cms", action } });
        for (const other of ACTIONS.filter((one) => one !== action)) expect(readLaunch([name], other).ok).toBe(false);
      });

      test("it writes only into the named site's directory, the blocks, the preview locks and its own directory", () => {
        expect(values(text, "ProtectSystem")).toEqual(["strict"]);
        expect(values(text, "ReadWritePaths")).toEqual([
          "/srv/sites/%i /etc/caddy/sites /run/sitesolide-gatekeeper",
          // The codes file alone, never /etc/caddy: nothing else of it is written.
          "-/etc/caddy/locks -/etc/caddy/locks-codes.json -/srv/garde",
        ]);
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

  test("it installs and checks the four units, and removes the template from before", () => {
    for (const action of ACTIONS) {
      expect(script).toContain(`sitesolide-gatekeeper-${action}@.service`);
    }
    expect(script).toContain("systemd-analyze verify");
    expect(script).toContain("sitesolide-gatekeeper@.service");
    expect(script).toMatch(/rm -f .*PREVIOUS_TEMPLATE/);
  });

  test("it lays the preview locks' files the units open for writing, and never changes one that is there", () => {
    for (const path of ['LOCKS_FOLDER="/etc/caddy/locks"', 'CODES_FILE="/etc/caddy/locks-codes.json"', 'DOOR_PAGES_FOLDER="/srv/garde"']) expect(script).toContain(path);
    expect(script).toContain("sudo test -e $CODES_FILE || ");
    expect(script).toContain("-m 0600 -o $DEPLOY_USER -g $DEPLOY_USER");
  });

  test("it starts no transaction", () => {
    const code = script.split("\n").filter((line) => !/^\s*#/.test(line));
    for (const line of code) {
      expect({ line, starts: /systemctl\s+(start|restart|reload)\b/.test(line) }).toMatchObject({ starts: false });
    }
  });
});
