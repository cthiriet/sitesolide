/**
 * The portal's admin API, as the steward speaks to it for a Project admin:
 * sharing and guest access, the actor the member's email this steward
 * verified, never one a request named.
 *
 * **As root, over the loopback, through a relay.** The steward's unit keeps
 * no network at all (`PrivateNetwork=true`, `AF_UNIX` alone), and stays so:
 * a root daemon that holds every secret has no business on the loopback,
 * where Caddy's admin API listens. It opens a Unix socket instead,
 * `/run/sitesolide-portal-relay/portal.sock`, root's alone, behind which
 * systemd's own `systemd-socket-proxyd`, running as root with no capability
 * and the loopback alone, forwards to the portal's port and nowhere else
 * (infra/steward/sitesolide-portal-relay.socket). The portal sees root, as
 * for `sitesolide share` over the owner's SSH; the steward reaches one port
 * of the loopback, the portal's.
 *
 * One method per route, the response returned as it stands: what it means is
 * judged in actions.ts, which the tests drive with a portal of their making.
 */
export type PortalAdmin = {
  /** How people sign in, and every site's policy: `GET /admin/sharing`. */
  sharing: () => Promise<Response>;
  replaceSharing: (host: string, body: { mode: unknown; people: unknown; domains: unknown; actor: string }) => Promise<Response>;
  guests: () => Promise<Response>;
  createGuest: (body: { host: string; label: unknown; durationS: unknown; actor: string }) => Promise<Response>;
  revokeGuest: (id: string, actor: string) => Promise<Response>;
};

/** Where the relay listens: a runtime folder of its own, root's, 0700, the socket 0600. */
export const PORTAL_RELAY_SOCKET = "/run/sitesolide-portal-relay/portal.sock";

/** The portal answers on the loopback in a few milliseconds; beyond that, it will not. */
const TIMEOUT_MS = 5_000;

/** `redirect: "error"`: a redirect is no answer of the admin API, and would carry the actor elsewhere. */
export function relayedPortal(socket: string): PortalAdmin {
  function call(method: string, path: string, body?: object): Promise<Response> {
    return fetch(`http://portal${path}`, {
      method,
      unix: socket,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  }
  return {
    sharing: () => call("GET", "/admin/sharing"),
    replaceSharing: (host, body) => call("PUT", `/admin/sharing/${encodeURIComponent(host)}`, body),
    guests: () => call("GET", "/admin/guests"),
    createGuest: (body) => call("POST", "/admin/guests", body),
    revokeGuest: (id, actor) => call("DELETE", `/admin/invites/${encodeURIComponent(id)}`, { actor }),
  };
}
