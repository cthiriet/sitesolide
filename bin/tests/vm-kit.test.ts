import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * infra/vm, the VM that is sitesolide's machine on a host that already runs
 * something: what the host keeps of its own, read in the files install.sh
 * lays. The wall itself was measured on a host (docs/tunnel.md, "A VM on a
 * machine you already run"); these hold what that measure relied on.
 */

const VM = join(import.meta.dir, "..", "..", "infra", "vm");
const read = (name: string) => readFileSync(join(VM, name), "utf8");

describe("the VM's unit", () => {
  const unit = read("sitesolide-vm.service");
  const install = read("install.sh");

  test("every field of the template is one install.sh fills", () => {
    const fields = [...new Set([...unit.matchAll(/@([A-Z_]+)@/g)].map((match) => match[1]!))].sort();
    expect(fields).toEqual(["CPUS", "FIRMWARE", "HIDDEN", "MACHINE", "MEMORY", "MEMORY_MAX", "PORT", "QEMU"]);
    for (const field of fields) expect(install).toContain(`@${field}@`);
  });

  test("QEMU runs as its own account, its memory bounded, behind the wall it cannot run without", () => {
    for (const line of [
      "Requires=sitesolide-vm-wall.service",
      "After=sitesolide-vm-wall.service network-online.target",
      "User=sitesolide-vm",
      "SupplementaryGroups=kvm",
      "CapabilityBoundingSet=",
      "NoNewPrivileges=true",
      "ProtectSystem=strict",
      "ProtectHome=true",
      "ReadWritePaths=/var/lib/sitesolide-vm",
      "DevicePolicy=closed",
      "DeviceAllow=/dev/kvm rw",
      "MemoryMax=@MEMORY_MAX@M",
      "MemorySwapMax=0",
      "ExecStop=/usr/local/lib/sitesolide-vm/powerdown",
    ]) {
      expect(unit).toContain(`\n${line}\n`);
    }
  });

  test("the guest's ssh is forwarded to the host's loopback alone, and nothing else", () => {
    const forwards = [...unit.matchAll(/hostfwd=([^ ,\\]+)/g)].map((match) => match[1]);
    expect(forwards).toEqual(["tcp:127.0.0.1:@PORT@-:22"]);
  });
});

describe("the wall", () => {
  const wall = read("wall.nft");
  const rules = wall.split("\n").filter((line) => line.startsWith("\t\t"));

  test("judged on QEMU's account alone, its replies passing, then the host and every private range refused", () => {
    expect(rules[0]).toBe("\t\ttype filter hook output priority filter; policy accept;");
    expect(rules[1]).toBe('\t\tmeta skuid != "sitesolide-vm" accept');
    expect(rules[2]).toBe("\t\tct state established,related accept");
    for (const range of ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16"]) expect(rules[3]).toContain(range);
    for (const range of ["::/127", "fc00::/7", "fe80::/10"]) expect(rules[4]).toContain(range);
    expect(rules.slice(3).every((rule) => rule.endsWith(" counter reject"))).toBe(true);
  });

  test("laid again in one transaction, never doubled; reloaded in place, never by a restart that would take the VM down", () => {
    expect(wall).toContain("table inet sitesolide_vm\ndelete table inet sitesolide_vm\ntable inet sitesolide_vm {");
    const unit = read("sitesolide-vm-wall.service");
    expect(unit).toContain("ExecReload=/usr/sbin/nft -f /etc/sitesolide-vm/wall.nft\n");
    expect(read("install.sh")).toContain("systemctl reload sitesolide-vm-wall.service");
    expect(read("install.sh")).not.toContain("systemctl restart sitesolide-vm-wall");
  });
});

describe("the scripts", () => {
  test("both read as shell, and the disk is never laid over one already there", () => {
    for (const [shell, name] of [["bash", "install.sh"], ["sh", "powerdown"]] as const) {
      const run = Bun.spawnSync([shell, "-n", join(VM, name)], { stderr: "pipe" });
      expect({ name, code: run.exitCode, said: run.stderr.toString() }).toEqual({ name, code: 0, said: "" });
    }
    const install = read("install.sh");
    expect(install).toContain('if [ -e "$STATE/disk.raw" ]; then');
    // The image is checked against Debian's own list before anything is laid.
    expect(install.indexOf("sha512sum -c")).toBeLessThan(install.indexOf("qemu-img create"));
  });
});
