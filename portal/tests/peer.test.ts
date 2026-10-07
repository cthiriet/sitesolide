import { describe, expect, test } from "bun:test";
import { createAccessAdmin } from "../src/admin";
import { callerUidOn, uidOfConnection } from "../src/peer";
import { memoryAudit } from "./memory";

/**
 * Who calls the admin routes, from the kernel's socket tables: the egress
 * proxy's reading, borrowed. The tables are written here as a little-endian
 * kernel prints them, 127.0.0.1 being `0100007F`: the portal listens on
 * 3026 (`0BD2`), the dashboard connects from 41234 (`A112`) as uid 997, the
 * relay from 41300 (`A154`) as root.
 */
const TABLE = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  // The portal's listener, its own uid.
  "   0: 0100007F:0BD2 00000000:0000 0A 00000000:00000000 00:00000000 00000000   996        0 1000 1 0000000000000000 100 0 0 10 0",
  // The dashboard's end, and the portal's accepted mirror of it.
  "   1: 0100007F:A112 0100007F:0BD2 01 00000000:00000000 00:00000000 00000000   997        0 1001 1 0000000000000000 20 4 0 10 -1",
  "   2: 0100007F:0BD2 0100007F:A112 01 00000000:00000000 00:00000000 00000000   996        0 1002 1 0000000000000000 20 4 0 10 -1",
  // The relay's end, root, and its mirror.
  "   3: 0100007F:A154 0100007F:0BD2 01 00000000:00000000 00:00000000 00000000     0        0 1003 1 0000000000000000 20 4 0 10 -1",
  "   4: 0100007F:0BD2 0100007F:A154 01 00000000:00000000 00:00000000 00000000   996        0 1004 1 0000000000000000 20 4 0 10 -1",
].join("\n");

const readings = (tables: string[]) => ({ passwd: () => "", procNet: () => tables });
const LOCAL = { address: "127.0.0.1", port: 3026 };

describe("the uid behind a connection", () => {
  test("the caller's end names its account, never the portal's mirror of it", () => {
    expect(uidOfConnection(readings([TABLE, ""]), { remote: { address: "127.0.0.1", port: 41234 }, local: LOCAL }, true)).toBe(997);
    expect(uidOfConnection(readings([TABLE, ""]), { remote: { address: "127.0.0.1", port: 41300 }, local: LOCAL }, true)).toBe(0);
  });

  test("it fails closed: no matching socket, unreadable tables, no address", () => {
    expect(uidOfConnection(readings([TABLE, ""]), { remote: { address: "127.0.0.1", port: 50000 }, local: LOCAL }, true)).toBeNull();
    expect(uidOfConnection(readings(["", ""]), { remote: { address: "127.0.0.1", port: 41300 }, local: LOCAL }, true)).toBeNull();
    expect(uidOfConnection(readings([TABLE, ""]), { remote: null, local: LOCAL }, true)).toBeNull();
    // A socket of another port of the machine with the same caller's port is not this connection.
    expect(uidOfConnection(readings([TABLE, ""]), { remote: { address: "127.0.0.1", port: 41300 }, local: { address: "127.0.0.1", port: 3022 } }, true)).toBeNull();
  });

  test("two lines that disagree are no answer", () => {
    const forged = `${TABLE}\n   5: 0100007F:A112 0100007F:0BD2 01 00000000:00000000 00:00000000 00000000     0        0 1005 1 0000000000000000 20 4 0 10 -1`;
    expect(uidOfConnection(readings([forged, ""]), { remote: { address: "127.0.0.1", port: 41234 }, local: LOCAL }, true)).toBeNull();
  });

  test("the server's reader: requestIP gives the caller's end, a throwing one reads as nobody", () => {
    const remote = { address: "127.0.0.1", port: 41300 };
    expect(callerUidOn(() => remote, LOCAL, readings([TABLE, ""]))(new Request("http://127.0.0.1:3026/admin/guests"))).toBe(0);
    const broken = callerUidOn(
      () => {
        throw new Error("closed");
      },
      LOCAL,
      readings([TABLE, ""]),
    );
    expect(broken(new Request("http://127.0.0.1:3026/admin/guests"))).toBeNull();
  });
});

describe("the actor rule, end to end of the reading", () => {
  test("the dashboard's connection naming a person is refused, the relay's learns that the route moved", async () => {
    const audit = memoryAudit();
    let port = 41234;
    const routes = createAccessAdmin({
      access: { state: () => ({ reading: "steward", writtenAt: 1_800_000_000_000 }) },
      audit,
      settings: null,
      callerUid: callerUidOn(() => ({ address: "127.0.0.1", port }), LOCAL, readings([TABLE, ""])),
    });
    const asking = () =>
      new Request("http://127.0.0.1:3026/admin/guests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: "forum.test-zone.invalid", label: "Alice", durationS: 7 * 24 * 3600, actor: "bob@acme.test" }),
      });
    const refused = await routes.moved(asking());
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "actor-not-root" });
    port = 41300;
    const moved = await routes.moved(asking());
    expect(moved.status).toBe(410);
    expect(await moved.json()).toMatchObject({ error: "moved" });
    expect(audit.events).toEqual([]);
  });
});
