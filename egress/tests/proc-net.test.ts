import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  accountOf,
  decodeAddress,
  identify,
  parseProcNet,
  slugOfAccount,
  socketOwner,
  uidOf,
  type Peer,
  type Readings,
} from "../src/proc-net";

/**
 * Fixtures in the kernel's own format, little-endian as on x86_64 and arm64:
 * the proxy on 127.0.0.1:3128 and :3129 (0C38, 0C39) as uid 998, and callers
 * of several accounts. tests/proc-kernel.test.ts reads a real table, from a
 * Linux kernel, when it is asked to.
 */
const FIXTURES = join(import.meta.dir, "fixtures");
const TCP = readFileSync(join(FIXTURES, "proc-net-tcp.txt"), "utf8");
const TCP6 = readFileSync(join(FIXTURES, "proc-net-tcp6.txt"), "utf8");
const PASSWD = readFileSync(join(FIXTURES, "passwd"), "utf8");
const READINGS: Readings = { passwd: () => PASSWD, procNet: () => [TCP, TCP6] };

const PROXY = { localAddress: "127.0.0.1", localPort: 3128 };
const peer = (remotePort: number, overrides: Partial<Peer> = {}): Peer => ({ ...PROXY, remoteAddress: "127.0.0.1", remotePort, ...overrides });

describe("decoding the kernel's addresses", () => {
  test("IPv4 is the processor's integer: 0100007F is 127.0.0.1 on a little-endian machine", () => {
    expect(decodeAddress("0100007F")).toBe("127.0.0.1");
    expect(decodeAddress("00000000")).toBe("0.0.0.0");
    expect(decodeAddress("0E D7 B8 5D".replaceAll(" ", ""))).toBe("93.184.215.14");
  });

  test("a big-endian machine prints the same address the other way round", () => {
    expect(decodeAddress("7F000001", false)).toBe("127.0.0.1");
    expect(decodeAddress("00000000000000000000000000000001", false)).toBe("0:0:0:0:0:0:0:1");
  });

  test("IPv6 is four such words; an IPv4-mapped address comes out as IPv4", () => {
    expect(decodeAddress("00000000000000000000000001000000")).toBe("0:0:0:0:0:0:0:1");
    expect(decodeAddress("0000000000000000FFFF00000100007F")).toBe("127.0.0.1");
    expect(decodeAddress("B80D0120000000000000000001000000")).toBe("2001:db8:0:0:0:0:0:1");
  });

  test("refuses what is not a word", () => {
    for (const hex of ["", "0100007", "0100007G", "0".repeat(31), "0".repeat(33)]) expect(decodeAddress(hex)).toBeNull();
  });
});

describe("reading the table", () => {
  test("every socket line, the header and the garbage skipped", () => {
    const lines = parseProcNet(`${TCP}\nnot a line\n  99: nonsense\n`);
    expect(lines).toHaveLength(14);
    expect(lines[0]).toEqual({ local: "127.0.0.1", localPort: 3128, remote: "0.0.0.0", remotePort: 0, state: 10, uid: 998 });
    expect(lines[3]).toEqual({ local: "127.0.0.1", localPort: 41234, remote: "127.0.0.1", remotePort: 3128, state: 1, uid: 1031 });
  });

  test("IPv6 lines read the same way", () => {
    const lines = parseProcNet(TCP6);
    expect(lines).toHaveLength(5);
    expect(lines[1]).toEqual({ local: "0:0:0:0:0:0:0:1", localPort: 50000, remote: "0:0:0:0:0:0:0:1", remotePort: 3129, state: 1, uid: 1033 });
  });
});

describe("the owner of a connection", () => {
  const lines = [...parseProcNet(TCP), ...parseProcNet(TCP6)];

  test("the caller's socket, not the proxy's mirror of it", () => {
    expect(socketOwner(lines, peer(41234))).toBe(1031);
    expect(socketOwner(lines, peer(41300))).toBe(1032);
  });

  test("the port on the proxy's side counts too: the same client port towards 3129 is another socket", () => {
    expect(socketOwner(lines, peer(41234, { localPort: 3129 }))).toBeNull();
    expect(socketOwner(lines, peer(45232, { localPort: 3129 }))).toBe(1022);
  });

  test("a socket that is no longer established names nobody", () => {
    // TIME_WAIT lines carry uid 0: taking them would name root.
    expect(socketOwner(lines, peer(41000))).toBeNull();
  });

  test("a connection nobody holds names nobody", () => {
    expect(socketOwner(lines, peer(40000))).toBeNull();
    expect(socketOwner(lines, peer(41234, { remoteAddress: "127.0.0.2" }))).toBeNull();
  });

  test("IPv6, and an IPv4 client seen by a dual-stack listener", () => {
    expect(socketOwner(lines, { remoteAddress: "::1", remotePort: 50000, localAddress: "::1", localPort: 3129 })).toBe(1033);
    expect(socketOwner(lines, peer(45056, { remoteAddress: "::ffff:127.0.0.1", localAddress: "::ffff:127.0.0.1" }))).toBe(1034);
    expect(socketOwner(lines, peer(45056))).toBe(1034);
  });

  test("two lines that disagree on the owner are not trusted", () => {
    const twice = [...lines, { local: "127.0.0.1", localPort: 41234, remote: "127.0.0.1", remotePort: 3128, state: 1, uid: 1032 }];
    expect(socketOwner(twice, peer(41234))).toBeNull();
  });

  test("an address that does not read names nobody", () => {
    expect(socketOwner(lines, peer(41234, { remoteAddress: "localhost" }))).toBeNull();
  });
});

describe("from a uid to a project", () => {
  test("the account of a uid, and the uid of an account", () => {
    expect(accountOf(PASSWD, 1031)).toBe("site-shop");
    expect(accountOf(PASSWD, 0)).toBe("root");
    expect(accountOf(PASSWD, 4242)).toBeNull();
    expect(uidOf(PASSWD, "site-dashboard")).toBe(1022);
    expect(uidOf(PASSWD, "nobody-here")).toBeNull();
  });

  test("two accounts on one uid are not trusted", () => {
    expect(accountOf(`${PASSWD}site-other:x:1031:1031::/:/usr/sbin/nologin\n`, 1031)).toBeNull();
  });

  test("site-<slug> is a project, with a slug deploy would accept", () => {
    expect(slugOfAccount("site-shop")).toBe("shop");
    expect(slugOfAccount("site-my-api")).toBe("my-api");
    for (const name of ["root", "caddy", "sitesolide-egress", "site-", "site-Bad_Name", "site-a.b", "website-shop"]) {
      expect(slugOfAccount(name)).toBeNull();
    }
  });
});

describe("identifying a caller", () => {
  test("a project's service", () => {
    expect(identify(READINGS, peer(41234))).toEqual({ kind: "project", slug: "shop", account: "site-shop" });
  });

  test("the dashboard, a project too, which the read-only routes recognise by its account", () => {
    expect(identify(READINGS, peer(45232, { localPort: 3129 }))).toEqual({ kind: "project", slug: "dashboard", account: "site-dashboard" });
  });

  test("root is an account, not a project", () => {
    expect(identify(READINGS, peer(49154))).toEqual({ kind: "account", account: "root" });
  });

  test("fails closed at every step", () => {
    expect(identify(READINGS, peer(49153)).kind).toBe("unknown");
    expect(identify(READINGS, peer(40000)).kind).toBe("unknown");
    expect(identify({ passwd: () => PASSWD, procNet: () => ["", ""] }, peer(41234))).toEqual({
      kind: "unknown",
      reason: "the socket tables could not be read",
    });
    expect(identify({ passwd: () => "", procNet: () => [TCP, TCP6] }, peer(41234)).kind).toBe("unknown");
  });
});
