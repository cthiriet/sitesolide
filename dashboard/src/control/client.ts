/**
 * The steward's control routes, seen from the dashboard: one method per route,
 * the response returned as it stands, and `reach`, which reads it without ever
 * throwing.
 *
 * **An older steward is not a failure.** Until bin/deploy-steward.sh has run
 * with this code, the steward answers `404 no such route` to every control
 * route. That answer, and that one only, reads as `unavailable`: the API says
 * the machine does not carry it yet, the Tokens page says which script to run.
 */
import type { CreateTokenRequest, DeployRequest, LogsRequest } from "./protocol";

export type ControlSteward = {
  listTokens: () => Promise<Response>;
  createToken: (requested: CreateTokenRequest) => Promise<Response>;
  revokeToken: (id: string) => Promise<Response>;
  authenticate: (bearer: string) => Promise<Response>;
  preflight: (bearer: string, slug: string) => Promise<Response>;
  deploy: (requested: DeployRequest) => Promise<Response>;
  deployment: (id: string) => Promise<Response>;
  logs: (requested: LogsRequest) => Promise<Response>;
  /** A project's access, as a token reads it. */
  accessList: (bearer: string, slug: string) => Promise<Response>;
  /** Someone given Can open, or taken off, by a token: the steward judges both. */
  accessPut: (requested: { bearer: string; slug: string; who: unknown; role: unknown }) => Promise<Response>;
  accessRemove: (requested: { bearer: string; slug: string; who: unknown }) => Promise<Response>;
};

/**
 * Every control route answers within seconds: the installer is started without
 * waiting for it, and the journal is read with its own delay.
 */
export const CONTROL_TIMEOUT_MS = 20_000;

/** `redirect: "error"`: a redirect would send the bearer to the address it names. */
export function localControlSteward(socket: string, timeoutMs = CONTROL_TIMEOUT_MS): ControlSteward {
  function call(method: string, path: string, requested?: object): Promise<Response> {
    return fetch(`http://steward${path}`, {
      method,
      unix: socket,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      ...(requested === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(requested) }),
    });
  }
  return {
    listTokens: () => call("GET", "/tokens/list"),
    createToken: (requested) => call("POST", "/tokens/create", requested),
    revokeToken: (id) => call("POST", "/tokens/revoke", { id }),
    authenticate: (bearer) => call("POST", "/control/authenticate", { bearer }),
    preflight: (bearer, slug) => call("POST", "/control/preflight", { bearer, slug }),
    deploy: (requested) => call("POST", "/control/deploy", requested),
    deployment: (id) => call("GET", `/control/deployment?${new URLSearchParams({ id })}`),
    logs: (requested) => call("POST", "/control/logs", requested),
    accessList: (bearer, slug) => call("POST", "/control/access/list", { bearer, slug }),
    accessPut: (requested) => call("PUT", "/control/access", requested),
    accessRemove: (requested) => call("DELETE", "/control/access", requested),
  };
}

export type Reached =
  | { kind: "unreachable" }
  | { kind: "unavailable" }
  | { kind: "unreadable" }
  | { kind: "received"; status: number; body: Record<string, unknown> };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The call and the whole reading of its answer. `secrets` are strings of the
 * request that must never come back out: the bearer, above all, which a
 * steward copying a request into a message by mistake would otherwise hand to
 * whoever reads the response.
 */
export async function reach(call: () => Promise<Response>, secrets: string[] = []): Promise<Reached> {
  let response: Response;
  let text: string;
  try {
    response = await call();
    text = await response.text();
  } catch {
    return { kind: "unreachable" };
  }
  for (const secret of secrets) {
    if (secret.length >= 12 && text.includes(secret)) return { kind: "unreadable" };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: "unreadable" };
  }
  if (!isObject(body)) return { kind: "unreadable" };
  const status = response.status;
  if (status === 404 && body.error === "not-found" && body.message === "no such route") return { kind: "unavailable" };
  const success = status >= 200 && status < 300;
  if (!success && !(status >= 400 && status < 600)) return { kind: "unreadable" };
  if (!success && (typeof body.error !== "string" || typeof body.message !== "string")) return { kind: "unreadable" };
  return { kind: "received", status, body };
}
