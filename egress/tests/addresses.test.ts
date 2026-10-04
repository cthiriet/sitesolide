import { describe, expect, test } from "bun:test";
import { canonicalAddress, forbiddenReason, parseIPv4, parseIPv6, urlHost } from "../src/addresses";

describe("reading an address", () => {
  test("IPv4: four decimal parts, no leading zero, nothing above 255", () => {
    expect(parseIPv4("93.184.215.14")).toEqual([93, 184, 215, 14]);
    for (const text of ["1.2.3", "1.2.3.4.5", "01.2.3.4", "256.1.1.1", "1.2.3.-4", "0x7f.0.0.1", "", "1..3.4"]) {
      expect({ text, parsed: parseIPv4(text) }).toEqual({ text, parsed: null });
    }
  });

  test("IPv6: compressed, full, with an IPv4 tail", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6("2606:4700::6810:84e5")).toEqual([0x2606, 0x4700, 0, 0, 0, 0, 0x6810, 0x84e5]);
    expect(parseIPv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIPv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6("1:2:3:4:5:6:1.2.3.4")).toEqual([1, 2, 3, 4, 5, 6, 0x0102, 0x0304]);
  });

  test("IPv6: refuses what is not one, and a zone", () => {
    for (const text of [":::", "1::2::3", "1:2:3:4:5:6:7:8:9", "12345::", "fe80::1%eth0", "g::1", "1:2:3:4:5:6:7", ""]) {
      expect({ text, parsed: parseIPv6(text) }).toEqual({ text, parsed: null });
    }
  });

  test("one spelling per address, an IPv4-mapped one read as IPv4", () => {
    expect(canonicalAddress("127.0.0.1")).toBe("127.0.0.1");
    expect(canonicalAddress("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(canonicalAddress("::ffff:7f00:1")).toBe("127.0.0.1");
    expect(canonicalAddress("::1")).toBe("0:0:0:0:0:0:0:1");
    expect(canonicalAddress("0:0:0:0:0:0:0:1")).toBe("0:0:0:0:0:0:0:1");
    expect(canonicalAddress("[2001:DB8::1]")).toBe("2001:db8:0:0:0:0:0:1");
    expect(canonicalAddress("nope")).toBeNull();
  });

  test("an IPv6 address goes into a URL between brackets", () => {
    expect(urlHost("2606:4700::1")).toBe("[2606:4700::1]");
    expect(urlHost("93.184.215.14")).toBe("93.184.215.14");
  });
});

describe("what the proxy refuses to connect to", () => {
  test("every IPv4 block that is not globally reachable", () => {
    const refused: [string, string][] = [
      ["0.0.0.0", "unspecified"],
      ["0.1.2.3", "unspecified"],
      ["10.0.0.1", "private"],
      ["10.255.255.255", "private"],
      ["100.64.0.1", "shared address space (CGNAT)"],
      ["100.127.255.254", "shared address space (CGNAT)"],
      ["127.0.0.1", "loopback"],
      ["127.255.255.254", "loopback"],
      ["169.254.0.1", "link-local"],
      ["172.16.0.1", "private"],
      ["172.31.255.255", "private"],
      ["192.0.0.1", "reserved for protocol assignments"],
      ["192.0.2.10", "documentation"],
      ["192.88.99.1", "reserved (6to4 relay)"],
      ["192.168.1.1", "private"],
      ["198.18.0.1", "benchmarking"],
      ["198.19.255.255", "benchmarking"],
      ["198.51.100.7", "documentation"],
      ["203.0.113.9", "documentation"],
      ["224.0.0.1", "multicast"],
      ["239.255.255.250", "multicast"],
      ["240.0.0.1", "reserved"],
      ["255.255.255.255", "reserved"],
    ];
    for (const [address, reason] of refused) expect({ address, reason: forbiddenReason(address) }).toEqual({ address, reason });
  });

  test("the cloud metadata services are named as such", () => {
    expect(forbiddenReason("169.254.169.254")).toBe("cloud metadata");
    expect(forbiddenReason("100.100.100.200")).toBe("cloud metadata");
    expect(forbiddenReason("fd00:ec2::254")).toBe("cloud metadata");
  });

  test("the edges of the blocks: just outside them is public", () => {
    for (const address of ["9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "192.169.0.0", "198.17.255.255", "198.20.0.0", "223.255.255.255", "93.184.215.14", "1.1.1.1"]) {
      expect({ address, reason: forbiddenReason(address) }).toEqual({ address, reason: null });
    }
  });

  test("IPv6 local, reserved and special blocks", () => {
    const refused: [string, string][] = [
      ["::", "unspecified"],
      ["::1", "loopback"],
      ["fc00::1", "unique local"],
      ["fd12:3456::1", "unique local"],
      ["fe80::1", "link-local"],
      ["febf::1", "link-local"],
      ["fec0::1", "site-local"],
      ["ff02::1", "multicast"],
      ["::1.2.3.4", "not a global address"],
      ["100::1", "not a global address"],
      ["64:ff9b:1::1", "not a global address"],
      ["2001:db8::1", "documentation"],
      ["3fff::1", "documentation"],
      ["2001::1", "reserved for protocol assignments"],
      ["2001:10::1", "reserved for protocol assignments"],
    ];
    for (const [address, reason] of refused) expect({ address, reason: forbiddenReason(address) }).toEqual({ address, reason });
  });

  test("an IPv6 address that embeds an IPv4 one is judged by it", () => {
    expect(forbiddenReason("::ffff:127.0.0.1")).toBe("loopback (IPv4-mapped)");
    expect(forbiddenReason("::ffff:a9fe:a9fe")).toBe("cloud metadata (IPv4-mapped)");
    expect(forbiddenReason("::ffff:10.1.2.3")).toBe("private (IPv4-mapped)");
    expect(forbiddenReason("64:ff9b::10.0.0.1")).toBe("private (NAT64)");
    expect(forbiddenReason("64:ff9b::c0a8:101")).toBe("private (NAT64)");
    expect(forbiddenReason("2002:7f00:1::1")).toBe("loopback (6to4)");
    expect(forbiddenReason("2002:c0a8:101::1")).toBe("private (6to4)");
    // A public IPv4 address stays public under any of these spellings.
    expect(forbiddenReason("::ffff:93.184.215.14")).toBeNull();
    expect(forbiddenReason("64:ff9b::93.184.215.14")).toBeNull();
    expect(forbiddenReason("2002:5db8:d70e::1")).toBeNull();
  });

  test("global unicast IPv6 passes", () => {
    for (const address of ["2606:4700::6810:84e5", "2a01:4f8:c17:1::1", "2001:4860:4860::8888", "3ffe::1"]) {
      expect({ address, reason: forbiddenReason(address) }).toEqual({ address, reason: null });
    }
  });

  test("what is not an address is refused, never let through", () => {
    for (const text of ["", "localhost", "example.com", "1.2.3", "fe80::1%lo"]) expect(forbiddenReason(text)).toBe("not an address");
  });
});
