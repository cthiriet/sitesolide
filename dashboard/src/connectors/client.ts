/**
 * The two correspondents of the Connectors page, seen from the dashboard: the
 * steward, on its Unix socket, for what is written; the egress proxy, on the
 * loopback, for what it did. Each method returns the response as it stands,
 * judged by relay.ts, which the tests drive with simulated correspondents.
 */
import { CONNECTORS_PORT, EGRESS_ADDRESS } from "../../borrowed/egress";
import { DEFAULT_TIMEOUTS, type Timeouts } from "../secrets/client";
import type { ConnectorRemoval, ConnectorWrite, GrantWrite } from "./protocol";

export type ConnectorsSteward = {
  read: () => Promise<Response>;
  put: (requested: ConnectorWrite) => Promise<Response>;
  remove: (requested: ConnectorRemoval) => Promise<Response>;
  grant: (requested: GrantWrite) => Promise<Response>;
};

/** The same socket, the same delays and the same refusal of redirects as the secrets' client. */
export function localConnectorsSteward(socket: string, timeouts: Timeouts = DEFAULT_TIMEOUTS): ConnectorsSteward {
  function call(method: string, path: string, requested?: object, timeoutMs = timeouts.shortMs): Promise<Response> {
    return fetch(`http://steward${path}`, {
      method,
      unix: socket,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      ...(requested === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(requested) }),
    });
  }
  return {
    read: () => call("GET", "/connectors"),
    put: (requested) => call("PUT", "/connector", requested, timeouts.longMs),
    remove: (requested) => call("DELETE", "/connector", requested, timeouts.longMs),
    grant: (requested) => call("PUT", "/grant", requested, timeouts.longMs),
  };
}

export type EgressReader = {
  /** The latest `limit` rows, or those older than the row of id `before`. */
  audit: (limit: number, before?: number | null) => Promise<Response>;
  status: () => Promise<Response>;
};

/**
 * The egress proxy's read-only routes. It answers them to the dashboard's
 * account alone, recognised by the uid of this very connection, like any
 * caller: nothing to send, nothing to hold.
 */
export function localEgress(base = `http://${EGRESS_ADDRESS}:${CONNECTORS_PORT}`, timeoutMs = 5_000): EgressReader {
  const call = (path: string) => fetch(`${base}${path}`, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  return {
    audit: (limit, before = null) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (before !== null) query.set("before", String(before));
      return call(`/audit?${query}`);
    },
    status: () => call("/status"),
  };
}
