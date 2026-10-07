/**
 * `GET /api/audit`, the Activity page's one route, built around its
 * dependencies like the dashboard's other routes.
 *
 * **The session, and nothing more.** No unlock: an audit row never carries a
 * secret value, each component sees to it where it writes, and its tests say
 * so. Reading the log is therefore like reading the snapshot: whoever opened
 * the dashboard reads it, and no route here writes anything.
 *
 * The snapshot is read on every call, for one thing only: which site a host
 * belongs to, so that a site's filter finds the portal's rows on its domain.
 */
import { read } from "../read";
import type { SessionReader } from "../routes";
import type { Snapshot } from "../state";
import { aggregate, BUDGET, type Budget, type Readers } from "./aggregate";
import { readQuery, siteResolver, type Restriction } from "./merge";

export type AuditOptions = {
  session: SessionReader;
  /**
   * What the session may read: null for the super admin's whole machine, a
   * member's projects and own rows otherwise. Absent, every session reads it
   * all, as before members.
   */
  restriction?: (req: Request, now: number) => Promise<Restriction | null>;
  readers: Readers;
  stateFile: string;
  zone: string;
  budget?: Budget;
};

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The snapshot, or null: the log reads it only to name sites, and a snapshot
 * missing or malformed costs those names, never the log.
 */
async function snapshot(stateFile: string, now: number): Promise<Snapshot | null> {
  try {
    const reading = await read(stateFile, now);
    return reading.present ? reading.snapshot : null;
  } catch {
    return null;
  }
}

export function createAuditRoutes(options: AuditOptions, clock: () => number = Date.now): { list: (req: Request) => Promise<Response> } {
  return {
    async list(req) {
      const now = clock();
      if ((await options.session(req, now)) === null) return Response.json({ error: "no-session" }, { status: 401, headers: NO_STORE });
      const read = readQuery(new URL(req.url).searchParams);
      if ("error" in read) return Response.json({ error: "invalid", message: read.error }, { status: 400, headers: NO_STORE });
      const query = { ...read, restrict: (await options.restriction?.(req, now)) ?? null };

      const resolve = siteResolver(await snapshot(options.stateFile, now), options.zone);
      const page = await aggregate(query, options.readers, resolve, options.budget ?? BUDGET, clock);
      if ("error" in page) return Response.json({ error: "invalid", message: page.error }, { status: 400, headers: NO_STORE });
      return Response.json(page, { headers: NO_STORE });
    },
  };
}
