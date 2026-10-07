/**
 * The contract of the Connectors page, between the steward, which writes
 * /etc/sitesolide-egress, the dashboard's service, which relays, and the page,
 * which imports nothing from here but types.
 *
 * Shapes and constants only, like src/secrets/protocol.ts: the rules on a
 * connector live in bin/cli/connectors.ts, which the steward runs, and the
 * page shows the steward's refusal without judging anything itself.
 *
 * **A connector's value travels one way.** In the body of a write, from the
 * page to the steward, and never back: no response carries it, the relay
 * refuses one that would, and the page never asks for it.
 */
import type { ConnectorView, GrantRecord } from "../../borrowed/connectors";

export type { ConnectorView, GrantRecord };

/** What a project's deployed manifest asks for under `connectors`. */
export type ConnectorRequest = { slug: string; connectors: string[] };

export type ConnectorsView = {
  /**
   * The egress proxy's folder exists on the server. False: nothing can be
   * written, and the page says to run `sitesolide setup` without --minimal.
   */
  installed: boolean;
  /**
   * `managed`: the files read and carry the owner and mode the steward sets.
   * `unmanaged`: a file is there but not in a form managed here, `reason`
   * says why, and nothing is written until it is repaired by hand.
   */
  state: "managed" | "unmanaged";
  reason: string | null;
  connectors: ConnectorView[];
  grants: GrantRecord[];
  /** Every project whose manifest asks for a connector, granted or not. */
  requests: ConnectorRequest[];
  /** Every site deployed under /srv/sites: a grant to anything else is stale. */
  sites: string[];
};

// --- The steward's routes, on its socket ---------------------------------------
//
//   GET    /connectors                         -> ConnectorsView
//   PUT    /connector   ConnectorWrite         -> ConnectorsView
//   DELETE /connector   ConnectorRemoval       -> ConnectorsView
//   PUT    /grant       GrantWrite             -> ConnectorsView
//
// A steward deployed before these routes answers 404 `no such route`: the
// relay passes it on, and the page says to run `sitesolide upgrade`.

export type ConnectorWrite = {
  token: string;
  name: string;
  baseUrl: string;
  header: string;
  /** The whole header value; null keeps the one in place, refused for a new connector. */
  value: string | null;
};

/** `confirmation`: the name, retyped. A removal cuts every project using it. */
export type ConnectorRemoval = { token: string; name: string; confirmation: string };

export type GrantWrite = { token: string; slug: string; connector: string; granted: boolean };

// --- The dashboard's routes ------------------------------------------------------
//
//   GET    /api/connectors                -> DashboardConnectorsResponse
//   GET    /api/connectors/activity       -> ConnectorsActivityResponse
//   PUT    /api/connectors/connector      { name, baseUrl, header, value } -> ConnectorsView
//   DELETE /api/connectors/connector      { name, confirmation } -> ConnectorsView
//   PUT    /api/connectors/grant          { slug, connector, granted } -> ConnectorsView
//
// The writes need the session's unlock, the same as the secrets', and the
// token stays in the service. The activity comes from the egress proxy
// itself, which recognises the dashboard's account.

export type DashboardConnectorsResponse = ConnectorsView & {
  /** End of this session's unlocking, null if locked. */
  until: number | null;
};

/** One row of the egress proxy's audit table. `detail` is JSON, never a value. */
export type EgressAuditRow = {
  id: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
};

export type EgressStatus = {
  connectors: number;
  grants: number;
  errors: string[];
  started?: string;
  openTunnels?: number;
};

export type ConnectorsActivityResponse = { rows: EgressAuditRow[]; status: EgressStatus };
