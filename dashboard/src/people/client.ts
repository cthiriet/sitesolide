/**
 * The people who sign in to the dashboard, seen from it: the steward's
 * session routes on its socket, and the portal's two dashboard routes on the
 * loopback. One method per route, the response returned as it stands: what
 * it means is judged in routes.ts, which the tests drive with simulated
 * correspondents.
 */
export type MembersSteward = {
  key: () => Promise<Response>;
  signIn: (assertion: string) => Promise<Response>;
  whoami: (session: string) => Promise<Response>;
  signOut: (session: string) => Promise<Response>;
  restart: (session: string, slug: string) => Promise<Response>;
  /** A member's unlock, from a forced sign-in's assertion. */
  unlock: (session: string, assertion: string) => Promise<Response>;
  lock: (session: string, token: string) => Promise<Response>;
  /**
   * A person's work on their projects (src/people/actions.ts) and on their
   * people with access (src/access/steward.ts): the route and the body as the
   * relay builds them, the session and the person's unlock token inside.
   * `long`: a route that waits under the steward's lock, a restart or a
   * change of general access.
   */
  act: (method: "POST" | "PUT" | "DELETE", path: string, body: object, long?: boolean) => Promise<Response>;
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
    key: () => call("GET", "/members/key"),
    signIn: (assertion) => call("POST", "/members/signin", { assertion }),
    whoami: (session) => call("POST", "/members/whoami", { session }),
    signOut: (session) => call("POST", "/members/signout", { session }),
    restart: (session, slug) => call("POST", "/members/restart", { session, slug }, RESTART_TIMEOUT_MS),
    unlock: (session, assertion) => call("POST", "/members/unlock", { session, assertion }),
    lock: (session, token) => call("POST", "/members/lock", { session, token }),
    act: (method, path, body, long = false) => call(method, path, body, long ? RESTART_TIMEOUT_MS : MEMBERS_TIMEOUT_MS),
  };
}

export type DashboardPortal = {
  /** How people sign in: the portal's `GET /admin/sharing`, of which the dashboard reads `sso` alone. */
  sso: () => Promise<Response>;
  /** `reauth`: a member unlocking, whom the provider must sign in again; a portal that predates it signs in as usual, and the steward refuses the unlock. */
  flow: (body: { binding: string; returnTo: string; chooseAccount: boolean; reauth?: boolean }) => Promise<Response>;
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
