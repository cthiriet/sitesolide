/**
 * The portal's audit, seen from the dashboard: its sign-ins, sign-outs and
 * the changes it recorded before the access registry, read through the
 * portal's admin API on the loopback, the one exception the loopback rule
 * makes for the dashboard. The dashboard keeps nothing of it; reading needs
 * a session.
 *
 * Who may open a site is no longer the portal's to keep: the steward holds
 * the access registry (src/access/), and the portal reads a projection of it.
 */
import { relay, type SessionReader } from "./routes";

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

const PAGE_DEFAULT = 100;
const PAGE_MAX = 500;

/** The portal's audit, most recent first, by pages: `GET /api/portal/audit`, the owner's. */
export function createPortalAuditRoute(options: { session: SessionReader; portal: PortalAudit }, clock: () => number = Date.now): (req: Request) => Promise<Response> {
  return async (req) => {
    if ((await options.session(req, clock())) === null) {
      return Response.json({ error: "no-session" }, { status: 401 });
    }
    const params = new URL(req.url).searchParams;
    const limit = Number(params.get("limit") ?? PAGE_DEFAULT);
    const before = params.has("before") ? Number(params.get("before")) : null;
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX || (before !== null && (!Number.isInteger(before) || before < 1))) {
      return Response.json({ error: "invalid-page" }, { status: 400 });
    }
    return relay(() => options.portal.audit(limit, before));
  };
}
