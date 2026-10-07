/**
 * The contract between the steward and the installer: the unit to start, what
 * systemd passes to the installer, and the request the steward leaves.
 *
 *   systemctl start --no-block sitesolide-installer@cms.service
 *
 * **One template, the slug alone as the instance**, `%i` and not `%I` for the
 * reason src/gatekeeper/instance.ts gives. The installer receives `%n`, draws
 * the slug from it, and reads `installs/<slug>.json` in the steward's state
 * directory: the request names the deployment, the token's scope as the
 * steward judged it, the member whose token it is if any, and the manifest. A
 * unit started by hand without a fresh request does nothing.
 *
 * Pure.
 */
import { isValidSlug } from "../../borrowed/manifest";
import { DEPLOYMENT_ID_SHAPE, INSTALLER_PREFIX, REQUEST_MAX_AGE_MS, type InstallRequest, type Scope } from "../control/protocol";

export type Launch = { ok: true; slug: string } | { ok: false; reason: string };

/** `argv` as the unit passes it, `installer.js %n`. The input is never quoted back as it stands. */
export function readLaunch(argv: readonly string[]): Launch {
  if (argv.length !== 1) return { ok: false, reason: "expected exactly one argument, the unit name (%n)" };
  const found = new RegExp(`^${INSTALLER_PREFIX}@([^@/]+)\\.service$`).exec(argv[0]!);
  if (found === null) return { ok: false, reason: `unexpected unit name, expected ${INSTALLER_PREFIX}@<slug>.service` };
  if (!isValidSlug(found[1]!)) return { ok: false, reason: "invalid slug in the unit name" };
  return { ok: true, slug: found[1]! };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScope(value: unknown): value is Scope {
  return (
    isObject(value) &&
    Array.isArray(value.slugs) &&
    value.slugs.every((slug) => typeof slug === "string" && isValidSlug(slug)) &&
    ["create", "outbound", "domain", "public"].every((key) => typeof value[key] === "boolean")
  );
}

export type RequestRead = { ok: true; request: InstallRequest } | { ok: false; reason: string };

/**
 * The steward's request, for this unit's slug, fresh. A request for another
 * slug, older than `REQUEST_MAX_AGE_MS` or malformed is refused: a unit
 * restarted by hand, or by a reboot, must not replay a deployment nobody asked
 * for again.
 */
export function readRequest(text: string | null, slug: string, now: number): RequestRead {
  if (text === null) return { ok: false, reason: "no request from the steward for this project" };
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the steward's request is not JSON" };
  }
  if (!isObject(object)) return { ok: false, reason: "the steward's request is not an object" };
  const { deployment, requestedAt, token, scope, creating, manifest } = object;
  if (object.slug !== slug) return { ok: false, reason: "the steward's request names another project" };
  if (typeof deployment !== "string" || !DEPLOYMENT_ID_SHAPE.test(deployment)) return { ok: false, reason: "the steward's request names no deployment" };
  if (typeof requestedAt !== "number" || !Number.isFinite(requestedAt)) return { ok: false, reason: "the steward's request has no date" };
  if (now - requestedAt > REQUEST_MAX_AGE_MS || requestedAt - now > 60_000) {
    return { ok: false, reason: "the steward's request is stale: it is replayed, not asked for" };
  }
  if (!isObject(token) || typeof token.id !== "string" || typeof token.email !== "string") return { ok: false, reason: "the steward's request names no token" };
  // A request from a steward before members' tokens names no member: an owner's token.
  const member = token.member === undefined || token.member === null ? null : token.member;
  if (member !== null && (typeof member !== "string" || !/^[^\s@]+@[^\s@]+$/.test(member))) return { ok: false, reason: "the steward's request names a member that is no email" };
  if (!isScope(scope)) return { ok: false, reason: "the steward's request carries no scope" };
  if (typeof creating !== "boolean") return { ok: false, reason: "the steward's request does not say whether the project is new" };
  if (typeof manifest !== "string") return { ok: false, reason: "the steward's request carries no manifest" };
  return {
    ok: true,
    request: { deployment, slug, requestedAt, token: { id: token.id, email: token.email, member }, scope, creating, manifest },
  };
}
