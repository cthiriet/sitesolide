import { LOG_WINDOW_MS, MAX_LOGGED_DOMAINS } from "./config";
import type { Table } from "./domains";

export type Routes = {
  health: () => Response;
  domainAllowed: (req: Request) => Response;
};

/**
 * Builds the routes around a domain table. The server creates a single
 * instance of it; the tests create as many as they have cases to cover.
 */
export function createRoutes(table: Table, clock: () => number = Date.now): Routes {
  /**
   * A refusal is only logged once per domain and per window. A domain pointed
   * at this machine by mistake can otherwise produce one log line per
   * handshake.
   */
  const lastRefusal = new Map<string, number>();

  function logRefusal(host: string, reason: string, now: number): void {
    const previous = lastRefusal.get(host);
    if (previous !== undefined && now - previous < LOG_WINDOW_MS) return;

    if (lastRefusal.size >= MAX_LOGGED_DOMAINS) lastRefusal.clear();
    lastRefusal.set(host, now);
    console.warn(`on demand tls refused: ${host} (${reason})`);
  }

  return {
    health: () => Response.json({ ok: true, domains: table.count(clock()) }),

    /**
     * `ask` endpoint of `on_demand_tls`. Caddy queries it during the
     * handshake, before asking for a certificate for a domain it does not
     * know: only a 200 authorizes issuance, any other response blocks it,
     * including the absence of a response. It must therefore stay immediate
     * and free of any network dependency.
     */
    domainAllowed(req) {
      const now = clock();
      const requestedDomain = new URL(req.url).searchParams.get("domain");
      const decision = table.decide(requestedDomain, now);

      if (!decision.allowed) {
        logRefusal(requestedDomain ?? "(empty)", decision.reason, now);
        return new Response(decision.reason, { status: 403 });
      }

      return new Response("ok");
    },
  };
}
