/**
 * The portal's admin API, as the steward speaks to it: whether the portal
 * reads the access projection the steward writes for it, so that a change
 * of access can say when the portal on the machine does not follow it yet.
 *
 * **As root, over the loopback, through a relay.** The steward's unit keeps
 * no network at all (`PrivateNetwork=true`, `AF_UNIX` alone), and stays so:
 * a root daemon that holds every secret has no business on the loopback,
 * where Caddy's admin API listens. It opens a Unix socket instead,
 * `/run/sitesolide-portal-relay/portal.sock`, root's alone, behind which
 * systemd's own `systemd-socket-proxyd`, running as root with no capability
 * and the loopback alone, forwards to the portal's port and nowhere else
 * (infra/steward/sitesolide-portal-relay.socket).
 *
 * One method per route, the response returned as it stands: what it means is
 * judged by the caller, which the tests drive with a portal of their making.
 */
export type PortalAdmin = {
  /** What the portal reads its access from: `GET /admin/access`. */
  access: () => Promise<Response>;
};

/** Where the relay listens: a runtime folder of its own, root's, 0700, the socket 0600. */
export const PORTAL_RELAY_SOCKET = "/run/sitesolide-portal-relay/portal.sock";

/** The portal answers on the loopback in a few milliseconds; beyond that, it will not. */
const TIMEOUT_MS = 3_000;

/** `redirect: "error"`: a redirect is no answer of the admin API. */
export function relayedPortal(socket: string): PortalAdmin {
  return {
    access: () => fetch("http://portal/admin/access", { unix: socket, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) }),
  };
}

/** What the portal says it reads its access from, as the access answers carry it. */
export type PortalReading = "steward" | "portal" | "unreadable" | "unknown";

/**
 * The most of the portal's answer the steward reads. The answer is two
 * fields, a few dozen bytes; a portal broken into answers what it likes, and
 * three seconds on the loopback carry gigabytes, which `response.json()`
 * would hold whole before parsing them: the steward, root, under its own
 * MemoryMax, would be killed at the next Access page anyone opened, every
 * unlock on the machine with it.
 */
export const MAX_ANSWER_BYTES = 64 * 1024;

/** The answer's text read piece by piece, or null past the bound: the rest is never pulled. */
async function boundedText(response: Response): Promise<string | null> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    bytes += part.value.byteLength;
    if (bytes > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(part.value);
  }
  return new TextDecoder().decode(Bun.concatArrayBuffers(chunks));
}

/**
 * The portal's word, or `unknown` when it cannot be asked: no relay, a
 * portal down, or one from before the registry, which answers no such route
 * and reads its own tables still. An answer past MAX_ANSWER_BYTES is no
 * answer of the portal's either.
 */
export async function portalReading(portal: PortalAdmin | null): Promise<{ reading: PortalReading; writtenAt: number | null }> {
  if (portal === null) return { reading: "unknown", writtenAt: null };
  try {
    const response = await portal.access();
    if (response.status === 404) return { reading: "portal", writtenAt: null };
    const text = await boundedText(response);
    if (text === null) return { reading: "unknown", writtenAt: null };
    const body: unknown = JSON.parse(text);
    if (response.status !== 200 || typeof body !== "object" || body === null) return { reading: "unknown", writtenAt: null };
    const { reading, writtenAt } = body as Record<string, unknown>;
    const known = reading === "steward" || reading === "portal" || reading === "unreadable" ? reading : "unknown";
    return { reading: known, writtenAt: typeof writtenAt === "number" ? writtenAt : null };
  } catch {
    return { reading: "unknown", writtenAt: null };
  }
}
