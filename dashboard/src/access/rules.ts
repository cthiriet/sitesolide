/**
 * What a change of access is judged by, whoever asks: the project it names
 * and the duration of a password access. Pure. Who may ask is the steward's
 * to say (steward.ts): the owner alone.
 */
import { isValidSlug } from "../../borrowed/manifest";
import { reservedReason } from "../control/policy";
import { DEFAULT_PASSWORD_DURATION_S, PASSWORD_DURATIONS_S } from "./protocol";
import type { Refusal } from "./registry";

/** What the steward knows of the machine when it judges: the zone, and which projects are deployed. */
export type Machine = { zone: string; exists: (slug: string) => boolean };

/**
 * The project's slug, refused for the platform's own and for one not
 * deployed (a change to an existing entry excepted). The registry's own
 * shape of a slug, no dot: one it would not read back is never written.
 */
export function projectRefusal(slug: unknown, machine: Machine, existing: boolean): Refusal | null {
  if (typeof slug !== "string" || !isValidSlug(slug)) return { refusal: "slug: a project's slug, lowercase letters, digits and dashes", code: "invalid" };
  if (reservedReason(slug, machine.zone) !== null) return { refusal: `${slug} belongs to the platform, which stays the owner's`, code: "out-of-scope" };
  if (!existing && !machine.exists(slug)) return { refusal: `${slug} is not deployed on this machine`, code: "not-found" };
  return null;
}

/** A password access's duration as a request names it: one of the four offered, 7 days when absent. */
export function readDuration(value: unknown): number | null | Refusal {
  if (value === undefined) return DEFAULT_PASSWORD_DURATION_S;
  if ((PASSWORD_DURATIONS_S as readonly (number | null)[]).includes(value as number | null)) return value as number | null;
  return { refusal: "expiresInS: 86400 (24 h), 604800 (7 days), 2592000 (30 days) or null (no expiry)", code: "invalid" };
}
