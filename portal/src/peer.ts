/**
 * Who calls the portal's admin routes, read from the kernel rather than from
 * anything the caller sends: the uid of the account that opened the other end
 * of the connection.
 *
 * Three callers reach those routes over the loopback: the dashboard, as
 * `site-dashboard`; the steward, as root, through its relay
 * (`sitesolide-portal-relay`, systemd's own proxy, running as root); and the
 * owner's `sitesolide share` over SSH, as root through `sudo curl`. Only root
 * may say who acts, a Project admin's email or a team token: the steward
 * checked that person's role, or that token, before it asked. The dashboard is
 * assumed compromised everywhere else, and a dashboard that could name any
 * actor would write a member's email on a change it made itself. So it speaks
 * as `owner`, and nothing else (src/admin.ts, `readActor`).
 *
 * The reading is the egress proxy's, borrowed (egress/src/proc-net.ts): the
 * ESTABLISHED socket whose local end is the caller's address and port and
 * whose remote end is this server, in `/proc/net/tcp` or `tcp6`, and its uid.
 * Nothing the caller sends can change it, and **it fails closed**: no single
 * matching line, a table that cannot be read, and the caller is not root. It
 * holds because the portal runs in the host's network namespace and its unit
 * does not hide /proc/net (no `PrivateNetwork`, no `ProcSubset=pid`), as the
 * unit generator writes it (bin/cli/unit.ts).
 */
import { hostIsLittleEndian, machineReadings, parseProcNet, socketOwner, type Readings } from "../borrowed/proc-net";

/** The uid behind a request, or null when it cannot be read whole. */
export type CallerUid = (req: Request) => number | null;

/** What the server knows of a connection: the caller's end, as Bun's `requestIP` gives it, and this server's own. */
export type Connection = { remote: { address: string; port: number } | null; local: { address: string; port: number } };

/** The uid of the account behind this connection, or null. */
export function uidOfConnection(readings: Readings, connection: Connection, littleEndian = hostIsLittleEndian()): number | null {
  if (connection.remote === null) return null;
  const lines = readings.procNet().flatMap((text) => parseProcNet(text, littleEndian));
  if (lines.length === 0) return null;
  return socketOwner(lines, {
    remoteAddress: connection.remote.address,
    remotePort: connection.remote.port,
    localAddress: connection.local.address,
    localPort: connection.local.port,
  });
}

/**
 * The reader of the machine: `requestIP` is the server's, which says the
 * caller's address and port; this server listens on `address:port`.
 */
export function callerUidOn(requestIP: (req: Request) => { address: string; port: number } | null, local: { address: string; port: number }, readings: Readings = machineReadings()): CallerUid {
  const littleEndian = hostIsLittleEndian();
  return (req) => {
    let remote: { address: string; port: number } | null;
    try {
      remote = requestIP(req);
    } catch {
      remote = null;
    }
    return uidOfConnection(readings, { remote, local }, littleEndian);
  };
}

/** Root, and root alone, may name who acts. */
export const ROOT_UID = 0;
