/**
 * The access registry, seen from the dashboard: the steward's access routes
 * on its socket, for the owner's session. One method per route, the
 * response returned as it stands: what it means is judged in routes.ts,
 * which the tests drive with a simulated steward.
 */
import { callSteward } from "../secrets/client";

export type AccessSteward = {
  list: (slug: string) => Promise<Response>;
  put: (requested: { token?: string; slug: unknown; who: unknown; expiresInS?: unknown }) => Promise<Response>;
  remove: (requested: { slug: unknown; who: unknown }) => Promise<Response>;
  /**
   * The site's general access, any of the three, or a new code, the
   * steward's `/general`: the unlock for all but Restricted.
   */
  general: (requested: { token?: string; slug: unknown; access: "public" | "restricted" | "code"; renew?: boolean; confirmation: string }) => Promise<Response>;
};

/** Every access route answers within seconds. */
export const ACCESS_TIMEOUT_MS = 20_000;

/** A change of general access waits for the gatekeeper, up to ninety seconds, and for the steward's lock. */
export const PORTAL_TIMEOUT_MS = 200_000;

export function localAccessSteward(socket: string): AccessSteward {
  const call = (method: string, path: string, requested?: object, timeoutMs = ACCESS_TIMEOUT_MS) => callSteward(socket, method, path, requested, timeoutMs);
  return {
    list: (slug) => call("GET", `/access?${new URLSearchParams({ slug })}`),
    put: (requested) => call("PUT", "/access/entry", requested),
    remove: (requested) => call("DELETE", "/access/entry", requested),
    general: (requested) => call("POST", "/general", requested, PORTAL_TIMEOUT_MS),
  };
}
