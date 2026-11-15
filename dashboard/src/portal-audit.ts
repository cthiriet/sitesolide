/**
 * The portal's audit, seen from the dashboard: its sign-ins, sign-outs and
 * the changes it recorded before the access registry, read through the
 * portal's admin API on the loopback, the one exception the loopback rule
 * makes for the dashboard. The dashboard keeps nothing of it: the Activity
 * page reads it through src/audit/sources.ts, with the owner's session.
 *
 * Who may open a site is no longer the portal's to keep: the steward holds
 * the access registry (src/access/), and the portal reads a projection of it.
 */
export type PortalAudit = {
  audit: (limit: number, before: number | null) => Promise<Response>;
};

/** The portal answers on the loopback in a few milliseconds; beyond that, it will not. */
const TIMEOUT_MS = 5_000;

export function localPortalAudit(url: string): PortalAudit {
  return {
    audit: (limit, before) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (before !== null) query.set("before", String(before));
      return fetch(`${url}/admin/audit?${query}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    },
  };
}
