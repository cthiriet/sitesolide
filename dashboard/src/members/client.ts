/**
 * The members, seen from the dashboard: the steward's member routes on its
 * socket, and the portal's two dashboard routes on the loopback. One method
 * per route, the response returned as it stands: what it means is judged in
 * routes.ts, which the tests drive with simulated correspondents.
 */
import type { PutMemberRequest } from "./protocol";

export type MembersSteward = {
  list: () => Promise<Response>;
  key: () => Promise<Response>;
  put: (requested: PutMemberRequest & { token: string }) => Promise<Response>;
  remove: (email: string) => Promise<Response>;
  signIn: (assertion: string) => Promise<Response>;
  whoami: (session: string) => Promise<Response>;
  signOut: (session: string) => Promise<Response>;
  restart: (session: string, slug: string) => Promise<Response>;
};

/** Every route answers within seconds, but a restart: its observation, and the lock it may wait for. */
export const MEMBERS_TIMEOUT_MS = 10_000;
export const RESTART_TIMEOUT_MS = 100_000;

/** `redirect: "error"`: a redirect would carry a session to the address it names. */
export function localMembersSteward(socket: string): MembersSteward {
  function call(method: string, path: string, requested?: object, timeoutMs = MEMBERS_TIMEOUT_MS): Promise<Response> {
    return fetch(`http://steward${path}`, {
      method,
      unix: socket,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      ...(requested === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(requested) }),
    });
  }
  return {
    list: () => call("GET", "/members"),
    key: () => call("GET", "/members/key"),
    put: (requested) => call("PUT", "/members/member", requested),
    remove: (email) => call("DELETE", "/members/member", { email }),
    signIn: (assertion) => call("POST", "/members/signin", { assertion }),
    whoami: (session) => call("POST", "/members/whoami", { session }),
    signOut: (session) => call("POST", "/members/signout", { session }),
    restart: (session, slug) => call("POST", "/members/restart", { session, slug }, RESTART_TIMEOUT_MS),
  };
}

export type DashboardPortal = {
  /** How people sign in: the portal's `GET /admin/sharing`, of which the dashboard reads `sso`. */
  sso: () => Promise<Response>;
  flow: (body: { binding: string; returnTo: string; chooseAccount: boolean }) => Promise<Response>;
  redeem: (body: { code: string; binding: string | null }) => Promise<Response>;
};

/** The portal answers on the loopback in a few milliseconds; beyond that, it will not. */
const PORTAL_TIMEOUT_MS = 5_000;

export function localDashboardPortal(url: string): DashboardPortal {
  function call(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${url}${path}`, { ...init, redirect: "error", signal: AbortSignal.timeout(PORTAL_TIMEOUT_MS) });
  }
  const post = (path: string, body: object) => call(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return {
    sso: () => call("/admin/sharing"),
    flow: (body) => post("/admin/dashboard/flow", body),
    redeem: (body) => post("/admin/dashboard/redeem", body),
  };
}
