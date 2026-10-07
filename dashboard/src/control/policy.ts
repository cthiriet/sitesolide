/**
 * What a token may deploy, decided once and run in three places: the dashboard
 * judges it first so that a refusal comes back before the archive is sent, the
 * steward again before it starts the installer, and the installer last, on the
 * manifest it actually extracted. Only the last two count; the first is a
 * courtesy.
 *
 * **Private by default.** A project a token creates sits behind the portal,
 * unless the token may deploy public sites and the manifest asks for it. An
 * existing project keeps the door the machine carries, as `sitesolide deploy`
 * does (bin/cli/portal-vm.ts): the door changes from the dashboard, never from a
 * deployment.
 *
 * **A token never reaches what is not its own.** The platform's projects are
 * reserved whatever the scope says; a slug another token created is refused;
 * and a manifest may only declare the secret file named after its own slug, for
 * the unit reads it with `EnvironmentFile=`, as root, before dropping
 * privileges: a manifest naming `dashboard.env` would hand the dashboard's hash
 * to whoever wrote it.
 *
 * Pure.
 */
import {
  isApp,
  isProtected,
  isValidMemory,
  isValidSlug,
  readManifest,
  servicesOf,
  SERVICE_PORTS,
  type Manifest,
} from "../../borrowed/manifest";
import { reservedPorts } from "../../borrowed/services";
import {
  MAX_TOKEN_MEMORY_BYTES,
  MAX_TOKEN_SERVICES,
  type ControlErrorCode,
  type Identity,
  type Scope,
} from "./protocol";

/**
 * The platform's own projects, and the names that would fight them: no token
 * deploys these, whatever its scope. `www` is served by the landing's block,
 * `landing` names the landing's files.
 */
export const RESERVED_SLUGS: readonly string[] = ["dashboard", "portal", "api", "analytics", "landing", "www"];

/** Why a slug can never be a token's, or null. `zone` names the landing's directory. */
export function reservedReason(slug: string, zone: string): string | null {
  if (RESERVED_SLUGS.includes(slug) || (zone !== "" && slug === zone)) {
    return `${slug} is reserved for the platform: pick another slug`;
  }
  return null;
}

export type SlugDecision =
  | { kind: "allowed"; creating: boolean }
  | { kind: "refused"; error: ControlErrorCode; message: string };

const refused = (error: ControlErrorCode, message: string): SlugDecision => ({ kind: "refused", error, message });

/**
 * May this token deploy this slug, and would it be creating it?
 *
 * `exists`: the machine carries `/srv/sites/<slug>`. `owner`: the id of the
 * token that created it, or null.
 */
export function decideSlug(identity: Identity, slug: unknown, machine: { exists: boolean; owner: string | null; zone: string }): SlugDecision {
  if (typeof slug !== "string" || !isValidSlug(slug)) {
    return refused("invalid", "slug: lowercase letters, digits and dashes, no dot, no leading or trailing dash");
  }
  const reserved = reservedReason(slug, machine.zone);
  if (reserved !== null) return refused("reserved", reserved);

  const granted = identity.scope.slugs.includes(slug);
  const own = machine.owner === identity.id;
  if (machine.owner !== null && !own && !granted) {
    return refused("out-of-scope", `${slug} belongs to another token: pick another slug, or ask the owner of the machine to grant it to yours`);
  }
  if (machine.exists) {
    if (own || granted) return { kind: "allowed", creating: false };
    return refused(
      "out-of-scope",
      `${slug} already exists on the machine and your token may not deploy it: ask the owner of the machine to grant it, or pick another slug`,
    );
  }
  if (own || granted || identity.scope.create) return { kind: "allowed", creating: true };
  return refused("out-of-scope", `your token may not create projects: ask the owner of the machine to grant ${slug}, or to allow creating projects`);
}

/** `256M` in bytes. `validate()` has already checked the shape. */
export function memoryBytes(memory: string): number {
  const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[memory.slice(-1) as "K" | "M" | "G"];
  return Number(memory.slice(0, -1)) * unit;
}

/**
 * What the token's scope refuses in a manifest that `validate()` accepts. Every
 * reason at once, each saying what to change or whom to ask.
 */
export function scopeRefusals(manifest: Manifest, scope: Scope, slug: string): string[] {
  const refusals: string[] = [];
  if (manifest.slug !== slug) refusals.push(`slug: the manifest names ${String(manifest.slug)}, the deployment was created for ${slug}`);
  if (manifest.network === "outbound" && !scope.outbound) {
    refusals.push('network: your token may not deploy "network": "outbound"; remove it, or ask the owner of the machine to allow it');
  }
  // `egress` reaches outside hosts too, through the egress proxy: narrower
  // than `outbound`, but a way out all the same, and the hosts are the
  // manifest's own choice. It needs the same permission. `connectors` does
  // not: a manifest only asks for one, and nothing reaches it until the
  // owner grants it to the project from the dashboard, on the machine.
  if (manifest.egress !== undefined && !scope.outbound) {
    refusals.push("egress: your token may not reach outside hosts; remove egress, or ask the owner of the machine to allow outbound network");
  }
  if (manifest.domain !== undefined && !scope.domain) {
    refusals.push("domain: your token may not declare a domain; remove it, or ask the owner of the machine to allow it");
  }
  if (manifest.portalExempt !== undefined && manifest.portalExempt.length > 0 && !scope.public) {
    refusals.push("portalExempt: exempted paths are public, and your token may only deploy private sites; remove them, or ask the owner of the machine to allow public sites");
  }
  if (manifest.lock !== undefined) {
    refusals.push("lock: the preview lock is set by the owner of the machine with sitesolide lock; remove the key");
  }
  for (const name of manifest.secrets ?? []) {
    if (name !== `${slug}.env`) {
      refusals.push(`secrets: a token's project reads ${slug}.env and no other file; ${String(name)} is not its own`);
    }
  }
  const services = servicesOf(manifest);
  if (services.length > MAX_TOKEN_SERVICES) refusals.push(`services: ${MAX_TOKEN_SERVICES} at most for a token's project`);
  for (const service of services) {
    if (isValidMemory(service.memory) && memoryBytes(service.memory) > MAX_TOKEN_MEMORY_BYTES) {
      const who = service.name === null ? "memory" : `services.${service.name}.memory`;
      refusals.push(`${who}: 1G at most for a token's project`);
    }
  }
  return refusals;
}

export type Door = { portal: boolean } | { refusal: string };

/**
 * The door this deployment applies.
 *
 * `onMachine`: the door the deposited manifest carries, null when the machine
 * has none (a project being created, or one whose manifest is gone). The
 * machine's wins, as for `sitesolide deploy`; otherwise private unless the
 * token may go public and the manifest asks for it.
 *
 * `member`: a member's own token. An owner's token without the public
 * permission deploys private sites only, an existing public one included: a
 * stolen one publishes nothing. A member's token answers to the member's role
 * instead (src/members/tokens.ts): the door of an existing project was
 * decided by the owner or its Admin, a deployment never changes it,
 * and a Developer deploys the project as it stands, in the open if it is.
 * What opens a door, a new project in the open or paths exempted from the
 * portal, still takes the public permission, an Admin's.
 */
export function decideDoor(manifest: Manifest, scope: Scope, onMachine: boolean | null, member = false): Door {
  const portal = onMachine ?? (scope.public ? isProtected(manifest) : true);
  if (!portal && !scope.public && !(member && onMachine === false)) {
    return { refusal: "this site is public on the machine, and your token may only deploy private sites: ask the owner of the machine" };
  }
  if (portal && !isApp(manifest)) {
    return {
      refusal: scope.public
        ? "a static site cannot sit behind the portal yet: it is behind it on the machine, ask the owner of the machine"
        : "a static site cannot sit behind the portal yet, and your token may only deploy private sites: add a start command, or ask the owner of the machine to allow public sites",
    };
  }
  return { portal };
}

export type ManifestDecision =
  | { kind: "allowed"; portal: boolean }
  | { kind: "refused"; error: "reserved"; message: string }
  | { kind: "refused"; error: "invalid-manifest"; details: string[] };

/**
 * What the dashboard answers a manifest before any upload: the slug, the
 * scope, then the door.
 *
 * **The reserved slugs come first.** A platform project is refused `reserved`
 * whatever else the manifest says, as the steward refuses it in decideSlug:
 * judged after the door, `dashboard`, public on the machine, came back to a
 * private token as "this site is public on the machine", a 422 telling it to
 * ask the owner, when docs/team.md promises a 403 that says to pick another
 * slug, and nothing the owner could grant would ever change the answer.
 */
export function decideManifest(manifest: Manifest, scope: Scope, onMachine: boolean | null, zone: string, member = false): ManifestDecision {
  const reserved = reservedReason(manifest.slug, zone);
  if (reserved !== null) return { kind: "refused", error: "reserved", message: reserved };
  const refusals = scopeRefusals(manifest, scope, manifest.slug);
  const door = decideDoor(manifest, scope, onMachine, member);
  if ("refusal" in door) refusals.push(door.refusal);
  if (refusals.length > 0 || "refusal" in door) return { kind: "refused", error: "invalid-manifest", details: refusals };
  return { kind: "allowed", portal: door.portal };
}

// --- ports ----------------------------------------------------------------------------

/**
 * The ports taken on the machine for this project: the landing's, the shared
 * service's, the platform services' whether deployed or not, and every port
 * another deposited manifest declares. The same knowledge `portConflicts` of
 * bin/cli/services.ts uses, which refuses what this would hand out.
 */
export function takenPorts(deposited: ReadonlyMap<string, string>, slug: string): Set<number> {
  const taken = new Set<number>(reservedPorts(slug).keys());
  for (const [folder, raw] of deposited) {
    if (folder === slug) continue;
    const { manifest } = readManifest(raw);
    if (manifest === undefined) continue;
    for (const service of servicesOf(manifest)) {
      if (typeof service.port === "number") taken.add(service.port);
    }
  }
  return taken;
}

export type Allocation = { object: Record<string, unknown>; allocated: { service: string | null; port: number }[] } | { refusal: string };

/**
 * Gives a port to every service whose manifest names none: the one it had on
 * the machine if that is still free, the lowest free one of the services' range
 * otherwise. A manifest that names its ports is returned as it is.
 *
 * Works on the parsed object, before `validate()`, which would refuse a
 * missing port. The ports chosen are written into the manifest deposited on the
 * machine, so that the next deployment finds them there.
 */
export function allocatePorts(object: Record<string, unknown>, taken: ReadonlySet<number>, previous: Manifest | null): Allocation {
  const used = new Set<number>(taken);
  const previousPorts = new Map<string | null, number>();
  if (previous !== null) {
    for (const service of servicesOf(previous)) {
      if (typeof service.port === "number") previousPorts.set(service.name, service.port);
    }
  }
  const allocated: { service: string | null; port: number }[] = [];
  const pick = (name: string | null): number | null => {
    const before = previousPorts.get(name);
    if (before !== undefined && before >= SERVICE_PORTS.first && before <= SERVICE_PORTS.last && !used.has(before)) return before;
    for (let port = SERVICE_PORTS.first; port <= SERVICE_PORTS.last; port++) if (!used.has(port)) return port;
    return null;
  };

  const services = object.services;
  if (typeof services === "object" && services !== null && !Array.isArray(services)) {
    const entries = Object.entries(services as Record<string, unknown>);
    for (const [, service] of entries) {
      const port = (service as { port?: unknown } | null)?.port;
      if (typeof port === "number") used.add(port);
    }
    const next: Record<string, unknown> = {};
    for (const [name, service] of entries) {
      if (typeof service !== "object" || service === null || Array.isArray(service) || "port" in service) {
        next[name] = service;
        continue;
      }
      const port = pick(name);
      if (port === null) return { refusal: `no free port between ${SERVICE_PORTS.first} and ${SERVICE_PORTS.last} on the machine for services.${name}` };
      used.add(port);
      allocated.push({ service: name, port });
      next[name] = { ...service, port };
    }
    return { object: allocated.length === 0 ? object : { ...object, services: next }, allocated };
  }

  if (typeof object.start === "string" && object.start.length > 0 && !("port" in object)) {
    const port = pick(null);
    if (port === null) return { refusal: `no free port between ${SERVICE_PORTS.first} and ${SERVICE_PORTS.last} on the machine` };
    allocated.push({ service: null, port });
    return { object: { ...object, port }, allocated };
  }
  return { object, allocated };
}

/** True when the manifest leaves a port for the machine to choose. */
export function leavesPorts(object: Record<string, unknown>): boolean {
  if (typeof object.services === "object" && object.services !== null && !Array.isArray(object.services)) {
    return Object.values(object.services as Record<string, unknown>).some(
      (service) => typeof service === "object" && service !== null && !Array.isArray(service) && !("port" in service),
    );
  }
  return typeof object.start === "string" && object.start.length > 0 && !("port" in object);
}

