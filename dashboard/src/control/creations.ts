/**
 * The projects a person's token is creating, until the installer has said
 * how it went: `creations.json` in the steward's state folder, root 0600.
 *
 * **A person becomes Admin of what they created, and of nothing else.** The
 * steward notes the creation when it starts the installer, and settles it
 * under one rule (src/control/steward.ts, `settleCreations`): its person is
 * made Admin only when the creation's own installer has ended, succeeded,
 * failed or stopped half way, the machine carries the project, the token
 * that started it still owns the name, and nobody has access to the project
 * yet. Otherwise nobody is made anything. One undone, nothing laid, gives
 * its name back. One not settled within a day is dropped, the project, if
 * there is one, the owner's to give; `sitesolide remove` drops the creation
 * of the project it removes. Kept on disk rather than in memory, so that a
 * steward restarted while an installer ran still settles it.
 *
 * Pure: the file comes in as text, goes out as text.
 */
import { isValidSlug } from "../../borrowed/manifest";
import { DEPLOYMENT_ID_SHAPE } from "./protocol";

export type PendingCreation = {
  deployment: string;
  slug: string;
  /** The person whose token creates it. */
  email: string;
  token: string;
  /** When the installer was started, by the steward's clock. */
  at: number;
};

export const CREATIONS_NAME = "creations.json";

/** Past this, a creation not settled is dropped, nobody made Admin: its installer has long stopped, or the steward was away. */
export const CREATION_MAX_AGE_MS = 24 * 3600 * 1000;

/** A handful run at once at most; a list longer than this is not this steward's. */
export const MAX_PENDING = 100;

const EMAIL = /^[^\s@]+@[^\s@]+$/;
const TOKEN_ID = /^[0-9a-f]{12}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOne(value: unknown): PendingCreation | null {
  if (!isObject(value)) return null;
  const { deployment, slug, email, token, at } = value;
  if (typeof deployment !== "string" || !DEPLOYMENT_ID_SHAPE.test(deployment)) return null;
  if (typeof slug !== "string" || !isValidSlug(slug)) return null;
  if (typeof email !== "string" || email.length > 254 || !EMAIL.test(email)) return null;
  if (typeof token !== "string" || !TOKEN_ID.test(token)) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  return { deployment, slug, email, token, at };
}

/** The pending creations; a file that does not read is none, said by the caller, rather than a guess. */
export function readCreations(text: string | null): PendingCreation[] | { unreadable: string } {
  if (text === null) return [];
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    return { unreadable: "creations.json is not JSON" };
  }
  if (!isObject(object) || !Array.isArray(object.creations) || object.creations.length > MAX_PENDING) return { unreadable: "creations.json does not have the expected shape" };
  const creations: PendingCreation[] = [];
  for (const value of object.creations) {
    const one = readOne(value);
    if (one === null) return { unreadable: "a creation of creations.json does not have the expected shape" };
    creations.push(one);
  }
  return creations;
}

export function encodeCreations(creations: PendingCreation[]): string {
  return `${JSON.stringify({ creations }, null, 2)}\n`;
}
