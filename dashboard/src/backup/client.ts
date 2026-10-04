/**
 * The steward's backup routes, seen from the dashboard: one method per route,
 * the response returned as it stands. Apart from src/secrets/client.ts so that
 * the secrets' contract, and every test that simulates it, stays as it was.
 * The relay (src/secrets/routes.ts) judges what comes back, with the same
 * guards as for the secrets.
 */
import { DEFAULT_TIMEOUTS, type Timeouts } from "../secrets/client";
import type { RestoreRequest } from "./protocol";

export type BackupSteward = {
  readBackups: (slug: string) => Promise<Response>;
  /** Answers once the restore is started: it goes on in its own unit. */
  restoreBackup: (requested: RestoreRequest) => Promise<Response>;
  /** `slug` null: the audit of every site. */
  readBackupAudit: (slug: string | null) => Promise<Response>;
};

/** `redirect: "error"`: a redirect is not in the protocol, and would carry the token elsewhere. */
export function localBackupSteward(socket: string, timeouts: Timeouts = DEFAULT_TIMEOUTS): BackupSteward {
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
    readBackups: (slug) => call("GET", `/backups?${new URLSearchParams({ slug })}`),
    // Under the steward's lock: it may wait behind a secret's write or a restart.
    restoreBackup: (requested) => call("POST", "/backups/restore", requested, timeouts.longMs),
    readBackupAudit: (slug) => call("GET", slug === null ? "/backups/audit" : `/backups/audit?${new URLSearchParams({ slug })}`),
  };
}
