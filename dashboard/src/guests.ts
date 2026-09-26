/**
 * Guest access, seen from the dashboard. It keeps nothing of it: the portal
 * holds it and checks it, the dashboard only passes on to it what the page
 * asks for, once the session and the origin have been checked.
 *
 * This is the dashboard's only write, and it is bounded on purpose: neither
 * Caddy, nor a service, nor the owner's password. At worst, a compromised
 * dashboard creates a guest access on a personal site.
 */
import type { Snapshot } from "./state";

export type Portal = {
  list: () => Promise<Response>;
  create: (body: { host: string; label: unknown; durationS: unknown }) => Promise<Response>;
  remove: (id: string) => Promise<Response>;
};

/** The portal answers on the loopback in a few milliseconds; beyond that, it will not answer. */
const TIMEOUT_MS = 5_000;

export function localPortal(url: string): Portal {
  function call(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${url}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  return {
    list: () => call("/admin/guests"),
    create: (body) =>
      call("/admin/guests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    remove: (id) => call(`/admin/invites/${encodeURIComponent(id)}`, { method: "DELETE" }),
  };
}

/**
 * The hosts where a guest access makes sense: the sites that ask for the portal
 * AND whose block in service carries it. A site that asks for it without
 * carrying it is served in the clear, and a password would close nothing there.
 */
export function invitableHosts(snapshot: Snapshot): string[] {
  return snapshot.sites
    .filter((site) => site.portal.wanted && site.portal.installed)
    .map((site) => site.address);
}
