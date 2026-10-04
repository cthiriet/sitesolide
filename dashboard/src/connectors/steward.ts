/**
 * The steward's routes for the connectors: list them, create or change one,
 * remove one, grant or withdraw one.
 *
 * Mounted beside the secrets' routes by src/secrets/steward.ts, which hands
 * over its own tools: the body read with the unlock token checked first, the
 * exclusion lock every write takes, the deployed sites. A connector is written
 * under the same unlock and the same lock as a secret, and the rules are the
 * ones the egress proxy reads with, bin/cli/connectors.ts.
 *
 * **The value goes into the file and nowhere else**: no response carries it,
 * no refusal quotes it, no log line names it. The egress proxy records every
 * change in its own audit when it sees the files move, `connector.update` and
 * `connector.grant`, with the author the files carry: `owner`, the holder of
 * the dashboard's password.
 */
import {
  OWNER_ACTOR,
  connectorNamed,
  connectorViews,
  putConnector,
  removeConnector,
  setGrant,
  type ConnectorsFile,
  type GrantsFile,
} from "../../borrowed/connectors";
import { requestedConnectors } from "../../borrowed/egress";
import type { ErrorCode, Failure } from "../secrets/protocol";
import type { Site } from "../secrets/scope";
import type { ConnectorsView } from "./protocol";
import type { ConnectorStore } from "./store";

type Body = Record<string, unknown>;
type Handler = (req: Request) => Promise<Response>;

/** What the steward lends these routes: its own checks, not copies of them. */
export type StewardTools = {
  /** The body, the token checked before anything else, then the fields that must be strings. */
  bodyWithToken: (req: Request, texts: string[], others?: string[]) => Promise<Body | Response>;
  /** The task under the exclusion lock, the token checked again when its turn comes. */
  underLock: (req: Request, body: Body, task: () => Promise<Response>) => Promise<Response>;
  sites: () => Promise<Map<string, Site>>;
  now: () => number;
};

const STATUSES: Partial<Record<ErrorCode, number>> = {
  invalid: 400,
  "out-of-scope": 403,
  "not-found": 404,
  unmanaged: 409,
  failure: 500,
};

function error(code: ErrorCode, message: string): Response {
  const body: Failure = { error: code, message };
  return Response.json(body, { status: STATUSES[code] ?? 400 });
}

const NOT_INSTALLED = "the egress proxy is not installed on this server: run bin/deploy-egress.sh";

export function createConnectorRoutes(store: ConnectorStore, tools: StewardTools): Record<string, Record<string, Handler>> {
  /** The page's view, read again after every write: what the files say now. */
  async function view(): Promise<ConnectorsView> {
    const sites = await tools.sites();
    const requests = [...sites.values()]
      .map((site) => ({ slug: site.folder, connectors: site.manifest === null ? [] : requestedConnectors(site.manifest) }))
      .filter((request) => request.connectors.length > 0);
    const base = { requests, sites: [...sites.keys()].sort() };
    const reading = store.read();
    if (reading.kind === "absent") {
      return { installed: false, state: "managed", reason: NOT_INSTALLED, connectors: [], grants: [], ...base };
    }
    if (reading.kind === "unmanaged") {
      return { installed: true, state: "unmanaged", reason: reading.reason, connectors: [], grants: [], ...base };
    }
    return {
      installed: true,
      state: "managed",
      reason: null,
      connectors: connectorViews(reading.connectors),
      grants: reading.grants.grants,
      ...base,
    };
  }

  /** The files, or the refusal that says why they cannot be written. */
  function managed(): { connectors: ConnectorsFile; grants: GrantsFile } | Response {
    const reading = store.read();
    if (reading.kind === "absent") return error("not-found", NOT_INSTALLED);
    if (reading.kind === "unmanaged") return error("unmanaged", `the connectors are not managed here: ${reading.reason}`);
    return reading;
  }

  const stamp = () => new Date(tools.now()).toISOString();

  async function list(): Promise<Response> {
    return Response.json(await view());
  }

  async function put(req: Request): Promise<Response> {
    const body = await tools.bodyWithToken(req, ["name", "baseUrl", "header"], ["value"]);
    if (body instanceof Response) return body;
    if (body.value !== null && typeof body.value !== "string") return error("invalid", "value must be a string or null");
    return tools.underLock(req, body, async () => {
      const files = managed();
      if (files instanceof Response) return files;
      const result = putConnector(files.connectors, { name: body.name, baseUrl: body.baseUrl, header: body.header, value: body.value }, stamp(), OWNER_ACTOR);
      if ("error" in result) return error("invalid", result.error);
      store.write(result.file, null);
      return Response.json(await view());
    });
  }

  async function remove(req: Request): Promise<Response> {
    const body = await tools.bodyWithToken(req, ["name", "confirmation"]);
    if (body instanceof Response) return body;
    return tools.underLock(req, body, async () => {
      const files = managed();
      if (files instanceof Response) return files;
      const name = body.name as string;
      if (connectorNamed(files.connectors, name) === undefined) return error("not-found", `no connector named ${name.slice(0, 40)}`);
      // Every project using it loses it at once: the name is retyped.
      if (body.confirmation !== name) return error("invalid", `type ${name} to confirm removing the connector`);
      const result = removeConnector(files.connectors, files.grants, name, stamp(), OWNER_ACTOR);
      if ("error" in result) return error("invalid", result.error);
      store.write(result.connectors, result.grants === files.grants ? null : result.grants);
      return Response.json(await view());
    });
  }

  async function grant(req: Request): Promise<Response> {
    const body = await tools.bodyWithToken(req, ["slug", "connector"], ["granted"]);
    if (body instanceof Response) return body;
    if (typeof body.granted !== "boolean") return error("invalid", "granted must be a boolean");
    const granted = body.granted;
    return tools.underLock(req, body, async () => {
      const files = managed();
      if (files instanceof Response) return files;
      // A grant goes to a deployed site; a withdrawal is accepted for a site
      // that is gone, which is how a stale grant is cleaned up.
      if (granted && !(await tools.sites()).has(body.slug as string)) {
        return error("out-of-scope", "not a site deployed under /srv/sites");
      }
      const result = setGrant(files.grants, files.connectors, body.slug, body.connector, granted, stamp(), OWNER_ACTOR);
      if ("error" in result) return error("invalid", result.error);
      if (result.changed) store.write(null, result.file);
      return Response.json(await view());
    });
  }

  return {
    "/connectors": { GET: list },
    "/connector": { PUT: put, DELETE: remove },
    "/grant": { PUT: grant },
  };
}
