import { describe, expect, test } from "bun:test";
import { interfaceAddresses } from "../src/addresses";
import { machineAddresses, OWN_ADDRESSES_REFRESH_MS, resolveChecked } from "../src/resolve";
import { stubLookup } from "./helpers";

/**
 * The machine's own addresses, refused like the loopback. The interfaces are
 * injected in the shape `os.networkInterfaces()` gives: what a VM with a
 * public address on its interface would list, nothing of this workstation's.
 */
const PUBLIC_V4 = "203.0.114.5";
const PUBLIC_V6 = "2a01:4f8:ffff::5";
const INTERFACES = {
  lo: [
    { address: "127.0.0.1", family: "IPv4", internal: true },
    { address: "::1", family: "IPv6", internal: true },
  ],
  eth0: [
    { address: PUBLIC_V4, family: "IPv4", internal: false },
    { address: "2A01:04F8:FFFF:0000::5", family: "IPv6", internal: false },
    { address: "fe80::1%eth0", family: "IPv6", internal: false },
  ],
  idle: undefined,
};

describe("the machine's own addresses", () => {
  test("read from every interface, canonical, a link-local zone dropped", () => {
    expect([...interfaceAddresses(INTERFACES)].sort()).toEqual(
      ["0:0:0:0:0:0:0:1", "127.0.0.1", "203.0.114.5", "2a01:4f8:ffff:0:0:0:0:5", "fe80:0:0:0:0:0:0:1"].sort(),
    );
  });

  test("a listed name that resolves to one of them is refused, in any spelling", async () => {
    const own = machineAddresses(() => INTERFACES);
    const lookup = stubLookup({
      "self.test-zone.invalid": [PUBLIC_V4],
      "self6.test-zone.invalid": [PUBLIC_V6],
      "mapped.test-zone.invalid": [`::ffff:${PUBLIC_V4}`],
      "mixed.test-zone.invalid": ["203.0.114.6", PUBLIC_V4],
      "other.test-zone.invalid": ["203.0.114.6"],
    });
    for (const host of ["self.test-zone.invalid", "self6.test-zone.invalid", "mapped.test-zone.invalid", "mixed.test-zone.invalid"]) {
      const resolution = await resolveChecked(host, lookup, 1000, own);
      expect({ host, resolution }).toMatchObject({ host, resolution: { ok: false, status: 403, reason: "resolves to this machine's own address" } });
    }
    expect(await resolveChecked("self.test-zone.invalid", lookup, 1000, own)).toMatchObject({
      message: `egress: refused, self.test-zone.invalid resolves to ${PUBLIC_V4}, this machine's own address`,
    });
    // A neighbour on the same public network is not the machine.
    expect(await resolveChecked("other.test-zone.invalid", lookup, 1000, own)).toEqual({ ok: true, addresses: ["203.0.114.6"] });
  });

  test("read again once the delay has passed, and not before", () => {
    let clock = 0;
    let reads = 0;
    let interfaces: Record<string, { address: string }[]> = { eth0: [{ address: PUBLIC_V4 }] };
    const own = machineAddresses(
      () => {
        reads++;
        return interfaces;
      },
      OWN_ADDRESSES_REFRESH_MS,
      () => clock,
    );
    expect(own()?.has(PUBLIC_V4)).toBe(true);
    interfaces = { eth0: [{ address: "203.0.114.7" }] };
    clock += OWN_ADDRESSES_REFRESH_MS - 1;
    expect(own()?.has(PUBLIC_V4)).toBe(true);
    expect(reads).toBe(1);
    clock += 1;
    expect(own()?.has("203.0.114.7")).toBe(true);
    expect(own()?.has(PUBLIC_V4)).toBe(false);
    expect(reads).toBe(2);
  });

  test("a reading that fails keeps the last good one; with none yet, nothing goes out", async () => {
    let clock = 0;
    let failing = false;
    const own = machineAddresses(
      () => {
        if (failing) throw new Error("netlink refused");
        return INTERFACES;
      },
      1000,
      () => clock,
    );
    expect(own()?.has(PUBLIC_V4)).toBe(true);
    failing = true;
    clock += 1000;
    expect(own()?.has(PUBLIC_V4)).toBe(true);

    const never = machineAddresses(() => {
      throw new Error("netlink refused");
    });
    expect(never()).toBeNull();
    const lookup = stubLookup({ "api.test-zone.invalid": ["203.0.114.6"] });
    expect(await resolveChecked("api.test-zone.invalid", lookup, 1000, never)).toMatchObject({ ok: false, status: 503, reason: "own addresses unknown" });
    // Refused before resolving: no point asking the resolver.
    expect(lookup.asked).toEqual([]);
  });
});
