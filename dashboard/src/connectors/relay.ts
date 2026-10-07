/**
 * The /api/connectors/* routes, built around their dependencies like those of
 * src/secrets/routes.ts, and judged the same way: with a simulated steward and
 * a simulated proxy, with neither socket nor port.
 *
 * The dashboard judges no connector rule. It checks the session, and for a
 * write the origin and the unlock, through the very checks of the secrets'
 * routes (`withToken`), then relays. The steward decides and writes; its
 * refusal goes back to the page as it came. A connector's value goes out in
 * the request to the steward and nowhere else: the relay refuses a response
 * that would carry it back.
 *
 * The activity is read from the egress proxy itself, which answers the
 * dashboard's account alone.
 */
import type { SessionReader } from "../routes";
import { fields, reach, relay, type Extraction, type SecretsRoutes } from "../secrets/routes";
import type { Tokens } from "../secrets/tokens";
import type { ConnectorsSteward, EgressReader } from "./client";
import type {
  ConnectorRemoval,
  ConnectorWrite,
  ConnectorsActivityResponse,
  DashboardConnectorsResponse,
  EgressAuditRow,
  EgressStatus,
  GrantWrite,
} from "./protocol";

export type ConnectorsDependencies = {
  session: SessionReader;
  steward: ConnectorsSteward;
  egress: EgressReader;
  tokens: Tokens;
  withToken: SecretsRoutes["withToken"];
};

type Handler = (req: Request) => Promise<Response>;

export type ConnectorsRoutes = {
  list: Handler;
  activity: Handler;
  putConnector: Handler;
  removeConnector: Handler;
  setGrant: Handler;
};

/** The rows the page shows: the latest hundred, the rest stays in the proxy's table. */
export const ACTIVITY_ROWS = 100;

const NO_CACHE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_CACHE });
}

const missingSession = () => json({ error: "no-session" }, 401);

/**
 * A steward deployed before the connectors answers `no such route`. Said in
 * words the page can act on, rather than as a 404 nobody understands.
 */
async function explainOldSteward(pending: Promise<Response>): Promise<Response> {
  const response = await pending;
  if (response.status !== 404) return response;
  const text = await response.text();
  let body: { error?: unknown; message?: unknown } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    return new Response(text, { status: 404, headers: response.headers });
  }
  if (body.message !== "no such route") return new Response(text, { status: 404, headers: response.headers });
  return Response.json(
    { error: "not-found", message: "The steward on the server predates connectors: run sitesolide upgrade." },
    { status: 404 },
  );
}

/** `/connector`: three names, and the value, a string or null to keep the one in place. */
const extractPut: Extraction<Omit<ConnectorWrite, "token">> = (body) => {
  const names = fields(["name", "baseUrl", "header"] as const)(body);
  if (names instanceof Response) return names;
  const value = body!.value;
  if (value !== null && typeof value !== "string") {
    return json({ error: "invalid", message: "Missing or non-text field: value." }, 400);
  }
  return { ...names, value };
};

/** `/grant`: the site, the connector, and `granted`, a boolean. */
const extractGrant: Extraction<Omit<GrantWrite, "token">> = (body) => {
  const names = fields(["slug", "connector"] as const)(body);
  if (names instanceof Response) return names;
  const granted = body!.granted;
  if (typeof granted !== "boolean") return json({ error: "invalid", message: "Missing or non-boolean field: granted." }, 400);
  return { ...names, granted };
};

const extractRemoval: Extraction<Omit<ConnectorRemoval, "token">> = fields(["name", "confirmation"] as const);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createConnectorsRoutes(dependencies: ConnectorsDependencies, clock: () => number = Date.now): ConnectorsRoutes {
  const { session, steward, egress, tokens, withToken } = dependencies;

  return {
    /** The connectors, their grants, who asks for what, and the end of this session's unlocking. */
    async list(req) {
      const open = await session(req, clock());
      if (open === null) return missingSession();
      const received = await reach(() => explainOldSteward(steward.read()), null);
      if (received.kind !== "received" || received.status < 200 || received.status >= 300) return relay(received);
      const body = received.body;
      if (!isObject(body) || !Array.isArray(body.connectors) || !Array.isArray(body.grants) || typeof body.installed !== "boolean") {
        return json({ error: "failure", message: "The steward sent an unreadable answer." }, 502);
      }
      const until = tokens.read(open.hash)?.expiresAt ?? null;
      return json({ ...(body as Omit<DashboardConnectorsResponse, "until">), until } satisfies DashboardConnectorsResponse);
    },

    /** The egress proxy's audit and state, read from the proxy. */
    async activity(req) {
      if ((await session(req, clock())) === null) return missingSession();
      let rows: unknown;
      let status: unknown;
      try {
        const [auditResponse, statusResponse] = await Promise.all([egress.audit(ACTIVITY_ROWS), egress.status()]);
        if (!auditResponse.ok || !statusResponse.ok) {
          const refused = (await (auditResponse.ok ? statusResponse : auditResponse).json().catch(() => ({}))) as { message?: unknown };
          const why = typeof refused.message === "string" ? refused.message : `status ${auditResponse.ok ? statusResponse.status : auditResponse.status}`;
          return json({ error: "failure", message: `The egress proxy refused the dashboard: ${why}.` }, 502);
        }
        rows = ((await auditResponse.json()) as { rows?: unknown }).rows;
        status = await statusResponse.json();
      } catch {
        return json({ error: "failure", message: "Can't reach the egress proxy." }, 502);
      }
      if (!Array.isArray(rows) || !isObject(status)) {
        return json({ error: "failure", message: "The egress proxy sent an unreadable answer." }, 502);
      }
      return json({ rows: rows as EgressAuditRow[], status: status as EgressStatus } satisfies ConnectorsActivityResponse);
    },

    putConnector: withToken(extractPut, (requested) => explainOldSteward(steward.put(requested)), {
      secrets: (requested) => (requested.value === null ? [] : [requested.value]),
    }),
    removeConnector: withToken(extractRemoval, (requested) => explainOldSteward(steward.remove(requested))),
    setGrant: withToken(extractGrant, (requested) => explainOldSteward(steward.grant(requested))),
  };
}
