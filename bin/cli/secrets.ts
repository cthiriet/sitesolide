/**
 * What `deploy` does with a declared secret, decided without ever reading its
 * content.
 *
 * The rule fits in one sentence: **the VM is the source of truth**.
 * `/etc/sitesolide` is the vault, and the dashboard's *Secrets* section holds
 * it: there a variable is read, set and removed, a declared file that is
 * missing is created, then the service is restarted. A secret present on the
 * machine is therefore the right one, and the only one.
 *
 * `deploy` never pushes a secret. It used to fill what the machine lacked from
 * a copy of every secret kept on the workstation, which meant a plain copy of
 * all of production on a laptop, and two copies to keep equal. It now checks
 * that the declared file is there, and when it is not, it says where to create
 * it. The manifest has been deposited by then, so the dashboard already knows
 * the file belongs to the site.
 *
 * Where a secret lands and to whom it belongs follows from its name and its
 * site: `/etc/sitesolide/<name>`, `site-<slug>`, 0600. A registry used to say
 * so line by line, and all but two of its lines repeated that rule; the steward
 * applies the same rule on its side, see dashboard/src/secrets/scope.ts.
 *
 * Pure: returns a decision, touches nothing.
 */
import { secretPath, MARKER_ABSENT, MARKER_PRESENT } from "./unit";

/**
 * The dashboard's address, derived from the configured zone. No default: a
 * ready-made value would send a user towards someone else's dashboard.
 */
export function dashboardAddress(zone: string): string {
  return `https://dashboard.${zone}`;
}

/** What is known about a declared secret, before deciding. Never a value. */
export type SecretState = {
  name: string;
  onServer: boolean;
};

export type SecretAction = { kind: "present" } | { kind: "rejects"; message: string; details: string[] };

/**
 * The decision for a declared secret.
 *
 * On the VM, it is left alone: it is the right one. Missing, the deployment
 * stops: `EnvironmentFile=` carries a dash, so the service would start and stay
 * silent, like a contact form without its mail credentials, which records the
 * requests and warns nobody.
 */
export function decideSecret(state: SecretState, dashboard: string): SecretAction {
  if (state.onServer) return { kind: "present" };
  return {
    kind: "rejects",
    message: `secret missing on the server: ${secretPath(state.name)}`,
    details: [
      "the service would start and silently notify no one",
      `create ${state.name} and its variables in the Secrets section of ${dashboard},`,
      "then run sitesolide deploy again",
    ],
  };
}

export type PresenceRead = { kind: "absent" } | { kind: "present" } | { kind: "unreadable" };

/**
 * The answer of the remote presence test. Anything that is neither marker, an
 * empty output included, reads as a failure: a refused sudo prints nothing,
 * and taking that silence for an absence would stop a deployment for a secret
 * that is there.
 */
export function readPresenceAnswer(output: string): PresenceRead {
  const clean = output.trim();
  if (clean === MARKER_ABSENT) return { kind: "absent" };
  if (clean === MARKER_PRESENT) return { kind: "present" };
  return { kind: "unreadable" };
}
