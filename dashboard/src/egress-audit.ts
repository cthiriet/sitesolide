/**
 * The egress proxy's audit, seen from the dashboard: its read-only route on
 * the loopback, EGRESS_URL in src/config.ts, which it answers to the
 * dashboard's account alone, recognised by the uid of this very connection
 * like any caller: nothing to send, nothing to hold. The response comes back
 * as it stands, judged by src/audit/sources.ts, which the tests drive with a
 * simulated proxy.
 */
import { statSync } from "node:fs";
import { EGRESS_UNIT } from "../borrowed/egress";

export type EgressAudit = {
  /** The latest `limit` rows, or those older than the row of id `before`. */
  audit: (limit: number, before?: number | null) => Promise<Response>;
  /**
   * Whether the machine carries the proxy's unit, which every account may
   * read: a proxy that does not answer is down when it does, never installed
   * when it does not. Null when that cannot be told.
   */
  installed: () => boolean | null;
};

/** Where systemd reads the proxy's unit, as bin/cli/egress.ts looks for it before a deployment. */
export const EGRESS_UNIT_FILE = `/etc/systemd/system/${EGRESS_UNIT}.service`;

export function localEgressAudit(base: string, unitFile = EGRESS_UNIT_FILE, timeoutMs = 5_000): EgressAudit {
  return {
    audit: (limit, before = null) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (before !== null) query.set("before", String(before));
      return fetch(`${base}/audit?${query}`, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    },
    installed: () => {
      try {
        return statSync(unitFile).isFile();
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
      }
    },
  };
}
