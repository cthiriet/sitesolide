/**
 * The steward, seen from the dashboard: one method per route of its socket,
 * which returns the response as it stands. The judgement of what it contains
 * belongs to `routes.ts`, which is judged that way without a socket, with a
 * simulated steward.
 *
 * See `protocol.ts` for the shapes. A Unix socket rather than a port: it is
 * guarded by the permissions of its file, without a second exception to the
 * loopback rule.
 */
import type {
  WithToken,
  UnlockRequest,
  FileRequest,
  PasswordRequest,
  PortalRequest,
  SetRequest,
  ProjectRequest,
  VariableRequest,
} from "./protocol";
import { MAX_PORTAL_MS, MAX_RESTART_MS } from "./protocol";
import type {
  StoreFileRemoveRequest,
  StoreFileRequest,
  StoreGenerateRequest,
  StoreRemoveRequest,
  StoreRestoreRequest,
  StoreRevealRequest,
  StoreSetRequest,
} from "../../borrowed/store-protocol";

export type Steward = {
  readProjects: () => Promise<Response>;
  /**
   * `slug` null: the log of every site. `page`: `limit` entries dated before
   * `before`, which a steward that predates pages ignores.
   */
  readLog: (slug: string | null, page?: { limit: number; before: number | null }) => Promise<Response>;
  unlock: (requested: UnlockRequest) => Promise<Response>;
  lock: (requested: WithToken) => Promise<Response>;
  readValue: (requested: VariableRequest) => Promise<Response>;
  setVariable: (requested: SetRequest) => Promise<Response>;
  removeVariable: (requested: VariableRequest) => Promise<Response>;
  createFile: (requested: FileRequest) => Promise<Response>;
  restoreFile: (requested: FileRequest) => Promise<Response>;
  changePassword: (requested: PasswordRequest) => Promise<Response>;
  togglePortal: (requested: PortalRequest) => Promise<Response>;
  restart: (requested: ProjectRequest) => Promise<Response>;
  setStoreVariable: (requested: WithToken & StoreSetRequest) => Promise<Response>;
  removeStoreVariables: (requested: WithToken & StoreRemoveRequest) => Promise<Response>;
  /** A value drawn on the machine: the answer names it, never carries it. */
  generateStoreVariable: (requested: WithToken & StoreGenerateRequest) => Promise<Response>;
  setStoreFile: (requested: WithToken & StoreFileRequest) => Promise<Response>;
  removeStoreFile: (requested: WithToken & StoreFileRemoveRequest) => Promise<Response>;
  restoreStore: (requested: WithToken & StoreRestoreRequest) => Promise<Response>;
  /** The one route that answers a value: the owner's live unlock token alone. */
  revealStoreValue: (requested: WithToken & StoreRevealRequest) => Promise<Response>;
};

export type Timeouts = {
  /** What waits in no queue of the steward's: listing, reading the log, locking. */
  shortMs: number;
  /**
   * Everything that goes through its exclusion lock or through the queue of
   * verifications. A read or a write of a few milliseconds can wait its turn
   * behind a restart or a portal, and a portal behind a write: cutting off
   * after five seconds would return a 502 for a request the steward still
   * carries through. Unlocking is one of them too: its verification waits in
   * the same queue as the argon2id of `/password`, one hash and one
   * verification each. The longest action under the lock, `/portal`, sets this
   * delay.
   */
  longMs: number;
};

/** What the relay waits on top of the steward's longest response. */
export const RELAY_MARGIN_MS = 10_000;

export const DEFAULT_TIMEOUTS: Timeouts = {
  shortMs: 5_000,
  longMs: Math.max(MAX_RESTART_MS, MAX_PORTAL_MS) + RELAY_MARGIN_MS,
};

/**
 * `socket` is the path of the socket's file. The URL's host serves no purpose
 * on a Unix socket, it only names the correspondent in a trace.
 *
 * `redirect: "error"`: a redirect is not in the protocol, and a 307 would send
 * the same body, token included, to the address the response chooses.
 */
export function localSteward(socket: string, timeouts: Timeouts = DEFAULT_TIMEOUTS): Steward {
  function call(method: string, path: string, requested?: object, timeoutMs = timeouts.shortMs): Promise<Response> {
    return fetch(`http://steward${path}`, {
      method: method,
      unix: socket,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      ...(requested === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(requested) }),
    });
  }

  return {
    readProjects: () => call("GET", "/projects"),
    // The slug goes out encoded in the request: the steward judges it, the
    // relay only keeps it from changing the path.
    readLog: (slug, page) => {
      const query = new URLSearchParams(slug === null ? {} : { slug });
      if (page !== undefined) query.set("limit", String(page.limit));
      if (page?.before !== undefined && page.before !== null) query.set("before", String(page.before));
      return call("GET", query.size === 0 ? "/log" : `/log?${query}`);
    },
    unlock: (requested) => call("POST", "/unlock", requested, timeouts.longMs),
    lock: (requested) => call("POST", "/lock", requested),
    readValue: (requested) => call("POST", "/value", requested, timeouts.longMs),
    setVariable: (requested) => call("PUT", "/variable", requested, timeouts.longMs),
    removeVariable: (requested) => call("DELETE", "/variable", requested, timeouts.longMs),
    createFile: (requested) => call("POST", "/file", requested, timeouts.longMs),
    restoreFile: (requested) => call("POST", "/restore", requested, timeouts.longMs),
    changePassword: (requested) => call("POST", "/password", requested, timeouts.longMs),
    togglePortal: (requested) => call("POST", "/portal", requested, timeouts.longMs),
    restart: (requested) => call("POST", "/restart", requested, timeouts.longMs),
    // Every write, and the reveal, waits its turn under the steward's lock.
    setStoreVariable: (requested) => call("PUT", "/store/variable", requested, timeouts.longMs),
    removeStoreVariables: (requested) => call("DELETE", "/store/variable", requested, timeouts.longMs),
    generateStoreVariable: (requested) => call("POST", "/store/generate", requested, timeouts.longMs),
    setStoreFile: (requested) => call("PUT", "/store/file", requested, timeouts.longMs),
    removeStoreFile: (requested) => call("DELETE", "/store/file", requested, timeouts.longMs),
    restoreStore: (requested) => call("POST", "/store/restore", requested, timeouts.longMs),
    revealStoreValue: (requested) => call("POST", "/store/value", requested, timeouts.longMs),
  };
}
