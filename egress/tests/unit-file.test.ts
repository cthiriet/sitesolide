import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EGRESS_ACCOUNT, EGRESS_CONFIG_DIR } from "../../bin/cli/connectors";
import { forbiddenReason } from "../src/addresses";

/**
 * The unit as the machine will run it. What it must carry, and above all
 * what it must not: one directive more and the proxy would stop seeing who
 * calls, or start seeing secrets.
 */
const UNIT = readFileSync(join(import.meta.dir, "..", "..", "infra", "egress", "sitesolide-egress.service"), "utf8");
const DIRECTIVES = UNIT.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
const CONFIG = readFileSync(join(import.meta.dir, "..", "src", "config.ts"), "utf8");

function values(name: string): string[] {
  return DIRECTIVES.filter((line) => line.startsWith(`${name}=`)).map((line) => line.slice(name.length + 1));
}

describe("the egress proxy's unit", () => {
  test("runs as its own account, with no capability", () => {
    expect(values("User")).toEqual([EGRESS_ACCOUNT]);
    expect(values("Group")).toEqual([EGRESS_ACCOUNT]);
    expect(values("CapabilityBoundingSet")).toEqual([""]);
    expect(values("NoNewPrivileges")).toEqual(["true"]);
  });

  test("runs the file bin/deploy-egress.sh installs", () => {
    const script = readFileSync(join(import.meta.dir, "..", "..", "bin", "deploy-egress.sh"), "utf8");
    const target = /^TARGET_JS="([^"]+)"$/m.exec(script)?.[1];
    expect(values("ExecStart")).toEqual([`/usr/local/bin/bun ${target}`]);
  });

  test("never gains what would hide the callers from it", () => {
    // In its own network namespace, no project reaches it and /proc/net lists
    // none of their sockets; with ProcSubset=pid, /proc/net is gone.
    expect(values("PrivateNetwork")).toEqual([]);
    expect(values("ProcSubset")).toEqual([]);
    expect(values("IPAddressDeny").join(" ")).not.toContain("localhost");
    expect(values("IPAddressDeny").join(" ")).not.toContain("any");
  });

  test("refuses the private ranges and the metadata service at the kernel too", () => {
    const denied = values("IPAddressDeny").join(" ").split(/\s+/);
    for (const range of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16", "fc00::/7", "fe80::/10", "multicast"]) {
      expect(denied).toContain(range);
    }
    // Each range really is one the code refuses: the two lists agree.
    for (const range of denied.filter((entry) => entry.includes("/"))) {
      expect(forbiddenReason(range.split("/")[0]!.replace(/::$/, "::1"))).not.toBeNull();
    }
  });

  test("keeps netlink, through which the machine's own addresses are read", () => {
    // Without it the reading fails, and src/resolve.ts refuses every egress
    // rather than let the machine's public address through unchecked.
    expect(values("RestrictAddressFamilies").join(" ").split(/\s+/)).toContain("AF_NETLINK");
  });

  test("sees neither the secrets nor Caddy", () => {
    const hidden = values("InaccessiblePaths").join(" ");
    for (const path of ["/etc/sitesolide", "/etc/caddy", "/var/lib/sitesolide-steward"]) expect(hidden).toContain(`-${path}`);
    // The connectors' folder is not hidden: it is what the proxy reads.
    expect(hidden).not.toContain(EGRESS_CONFIG_DIR);
    expect(values("ProtectSystem")).toEqual(["strict"]);
  });

  test("writes only its state directory, the one the configuration defaults to", () => {
    expect(values("StateDirectory")).toEqual(["sitesolide-egress"]);
    expect(values("ReadWritePaths")).toEqual([]);
    expect(CONFIG).toContain('process.env.DATA_DIR ?? "/var/lib/sitesolide-egress"');
  });
});
