/**
 * The access registry, seen from the dashboard: the steward's access routes
 * on its socket, for the owner's session. A person's go through the members
 * client's `act`, their session inside. One method per route, the response
 * returned as it stands: what it means is judged in routes.ts, which the
 * tests drive with a simulated steward.
 */
export type AccessSteward = {
  list: (slug: string) => Promise<Response>;
  put: (requested: { token?: string; slug: unknown; who: unknown; role: unknown; expiresInS?: unknown }) => Promise<Response>;
  remove: (requested: { slug: unknown; who: unknown }) => Promise<Response>;
  people: () => Promise<Response>;
  putPerson: (requested: { token?: string; email: unknown; create: unknown }) => Promise<Response>;
  removePerson: (email: unknown) => Promise<Response>;
};

/** Every access route answers within seconds; the migration, at most once, a few more. */
export const ACCESS_TIMEOUT_MS = 20_000;

/** `redirect: "error"`: a redirect would carry a request to the address it names. */
export function localAccessSteward(socket: string): AccessSteward {
  function call(method: string, path: string, requested?: object): Promise<Response> {
    return fetch(`http://steward${path}`, {
      method,
      unix: socket,
      redirect: "error",
      signal: AbortSignal.timeout(ACCESS_TIMEOUT_MS),
      ...(requested === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(requested) }),
    });
  }
  return {
    list: (slug) => call("GET", `/access?${new URLSearchParams({ slug })}`),
    put: (requested) => call("PUT", "/access/entry", requested),
    remove: (requested) => call("DELETE", "/access/entry", requested),
    people: () => call("GET", "/people"),
    putPerson: (requested) => call("PUT", "/people/person", requested),
    removePerson: (email) => call("DELETE", "/people/person", { email }),
  };
}
