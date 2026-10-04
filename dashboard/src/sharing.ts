/**
 * Sharing, seen from the dashboard: who may open a site with their work
 * account, and the portal's audit. Like guest access, the dashboard keeps
 * nothing of it: the portal holds the policies and applies them on every
 * request, the dashboard only passes on what the page asks for, once the
 * session and the origin have been checked.
 *
 * The same protections as Guests, for the same reason: reading needs a
 * session, changing needs the dashboard's exact origin first, then a session,
 * and a host the snapshot says carries the portal. A policy changes the
 * portal's database and nothing else, never Caddy: at worst, a compromised
 * dashboard shares a personal site with someone, which it could already do
 * with a guest password.
 *
 * Making a site public is not here: it is turning its portal off, in Access,
 * through the steward and the gatekeeper.
 */
import { invitableHosts } from "./guests";
import { read } from "./read";
import { relay, type SessionReader } from "./routes";
import { isAcceptableOrigin } from "./sessions";

export type SharingPortal = {
  list: () => Promise<Response>;
  replace: (host: string, body: { mode: unknown; people: unknown; domains: unknown; actor: string }) => Promise<Response>;
  audit: (limit: number, before: number | null) => Promise<Response>;
};

/** The portal answers on the loopback in a few milliseconds; beyond that, it will not. */
const TIMEOUT_MS = 5_000;

export function localSharing(url: string): SharingPortal {
  function call(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${url}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  return {
    list: () => call("/admin/sharing"),
    replace: (host, body) =>
      call(`/admin/sharing/${encodeURIComponent(host)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    audit: (limit, before) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (before !== null) query.set("before", String(before));
      return call(`/admin/audit?${query}`);
    },
  };
}

export type SharingRoutes = {
  list: (req: Request) => Promise<Response>;
  replace: (req: Request, host: string) => Promise<Response>;
  audit: (req: Request) => Promise<Response>;
};

export type SharingOptions = {
  session: SessionReader;
  publicUrl: string;
  stateFile: string;
  portal: SharingPortal;
};

const PAGE_DEFAULT = 100;
const PAGE_MAX = 500;

export function createSharingRoutes(options: SharingOptions, clock: () => number = Date.now): SharingRoutes {
  return {
    async list(req) {
      if ((await options.session(req, clock())) === null) {
        return Response.json({ error: "no-session" }, { status: 401 });
      }
      return relay(() => options.portal.list());
    },

    /**
     * The origin before the session, as for a guest access. The body is
     * rebuilt key by key: the portal judges the mode and the addresses, and
     * receives nothing the page did not mean to send. The actor is the one
     * password this dashboard knows.
     */
    async replace(req, host) {
      const now = clock();
      if (!isAcceptableOrigin(req.headers.get("origin"), options.publicUrl)) {
        return Response.json({ error: "origin-refused" }, { status: 403 });
      }
      if ((await options.session(req, now)) === null) {
        return Response.json({ error: "no-session" }, { status: 401 });
      }

      let body: { mode?: unknown; people?: unknown; domains?: unknown } | null;
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "unreadable-body" }, { status: 400 });
      }

      const reading = await read(options.stateFile, now);
      if (!reading.present || !invitableHosts(reading.snapshot).includes(host)) {
        return Response.json({ error: "no-portal" }, { status: 400 });
      }

      return relay(() =>
        options.portal.replace(host, { mode: body?.mode, people: body?.people, domains: body?.domains, actor: "owner" }),
      );
    },

    /** The portal's audit, most recent first, by pages: what the Activity view reads. */
    async audit(req) {
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
    },
  };
}
