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
 * reserved whatever the scope says, and so are new names of the shape of
 * their files, `dashboard-*`; a slug another token created is refused;
 * and a manifest in the old form may only declare the secret file named
 * after its own slug, for the unit reads it with `EnvironmentFile=`, as
 * root, before dropping privileges: a manifest naming `dashboard.env` would
 * hand the dashboard's hash to whoever wrote it. The slug names that file, so
 * the installer checks it is the project's own on the machine
 * (src/installer/claims.ts). A manifest that lists names reads no flat file
 * at all, only its project's store, `/etc/sitesolide/projects/<slug>/`, which
 * the slug alone designates: there is nothing more to judge in it, validate()
 * has judged the names.
 *
 * **Nor what a removed project left under its name.** `sitesolide remove`
 * releases the name for any token to create again, and its creator is made
 * Admin of what it creates; but the backups' snapshots and the connectors'
 * grants are keyed by the slug alone, and stay. The project created again
 * would list its predecessor's snapshots and restore them into its own data
 * folder, and be lent the credential the owner granted to the one removed.
 * A project's store of secrets is keyed by the slug too: one the owner laid
 * ahead of a deployment, or left by a removal stopped half way, would hand
 * its values to whatever code a token deploys under that name. So no token
 * creates a name under which the machine still keeps any of them
 * (`leftoversReason`), but a store its own write made there; the owner,
 * deploying over SSH, still may.
 *
 * Pure.
 */
import {
  isApp,
  isProtected,
  isValidMemory,
  isValidSlug,
  legacySecretFiles,
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
  // The platform's own files are named after its projects,
  // `dashboard-backup.env` among them, and a project reads the file named
  // after it: a new project of that shape would be handed one the platform
  // lays later. The installer refuses a file that exists already
  // (src/installer/claims.ts); this keeps the names free for those to come.
  // A project of such a name already on the machine was the owner's, and
  // stays deployable by the tokens granted it.
  const platform = machine.exists ? undefined : RESERVED_SLUGS.find((name) => slug.startsWith(`${name}-`));
  if (platform !== undefined) {
    return refused("reserved", `${slug} starts with ${platform}-, which names the platform's own files on the machine: a token never creates such a project; pick another slug`);
  }

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

/**
 * What the machine still keeps under a name its project no longer carries:
 * the snapshots of that folder the backups' index holds, in the server's
 * repository or the bucket's, each counted once, the connector grants made
 * to that slug, and `store`, true when `/etc/sitesolide/projects/<slug>/`
 * exists, the slug is not deployed, and no write of the asking token made
 * it (src/control/claims.ts): a store the token's own write made ahead of
 * its first deployment is its own, whoever the registry names for the slug.
 * Counts alone: nothing of what they hold.
 */
export type Leftovers = { snapshots: number; grants: number; store: boolean };

const counted = (count: number, what: string) => `${count} ${what}${count === 1 ? "" : "s"}`;

/** `a`, `a and b`, `a, b and c`. */
const listed = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/**
 * Why a token may not create this slug, after decideSlug allowed the
 * creation, or null when nothing was left under it. A project created again
 * under a removed one's name inherits both, whoever creates it: its Admin
 * restores the snapshots, the restore matching nothing but the folder and the
 * time (src/backup/restore.ts), and the egress proxy lends a grant to the
 * slug that asks (egress/src/connectors.ts, `isGranted`). Neither is
 * withdrawn by the removal, and retention never forgets a folder's newest
 * snapshot. A project the machine carries is a deployment, never a creation,
 * and is not asked.
 *
 * The answer names how many of each, never a connector, a value nor a
 * snapshot's name, and what the owner may do: deploy it over SSH, which
 * stays the way to bring a removed project back, or clear what was left
 * first.
 */
export function leftoversReason(slug: string, left: Leftovers): string | null {
  const kept: string[] = [];
  const clear: string[] = [];
  if (left.snapshots > 0) kept.push(counted(left.snapshots, "backup snapshot"));
  if (left.grants > 0) {
    kept.push(counted(left.grants, "connector grant"));
    clear.push(`withdraw the grant${left.grants === 1 ? "" : "s"} on the dashboard's Connectors page`);
  }
  if (left.store) {
    kept.push("a secrets store");
    clear.push(`remove the store with sitesolide remove --confirm ${slug}`);
  }
  if (left.snapshots > 0) clear.push(`forget the snapshot${left.snapshots === 1 ? "" : "s"}`);
  if (kept.length === 0) return null;
  return (
    `the machine still keeps ${listed(kept)} of a project once named ${slug}, which a project created under that name would be handed: no token creates it. ` +
    `Pick another slug, or ask the owner of the machine, who may deploy ${slug} themselves over SSH, or ${listed(clear)} first`
  );
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
    refusals.push("lock: a preview code is chosen in the site's Access section, by its Admin or the owner, never by a deployment; remove the key");
  }
  for (const name of legacySecretFiles(manifest)) {
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
 * instead (src/people/tokens.ts): the door of an existing project was
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
        ? "a static site cannot be restricted yet: it is restricted on the machine, ask the owner of the machine"
        : "a static site cannot be restricted yet, and your token may only deploy restricted sites: add a start command, or ask the owner of the machine to allow public sites",
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
 * ask the owner, when docs/access.md promises a 403 that says to pick another
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
 * Does this entry of `services` want a port the machine chooses? A public
 * service that names none does. An internal one without a port is a worker,
 * which listens on nothing, and a scheduled service never listens: a port
 * handed to either would be held for nothing, one less for the machine's other
 * projects, and would turn the worker into a server, told a `PORT` it never
 * opens. Read as written: validate() judges the rest.
 *
 * One exception, `kept`: an internal service the machine already gave a port
 * to, before workers existed, when this function handed one to every service
 * that named none. Its manifest never wrote that port, its program listens on
 * the `PORT` it is told, and taking it away at the next deployment would cut
 * it from its siblings without a word. It keeps it, as the machine says.
 */
function wantsPort(service: unknown, kept = false): boolean {
  if (typeof service !== "object" || service === null || Array.isArray(service)) return false;
  const entry = service as Record<string, unknown>;
  if ("port" in entry || "schedule" in entry) return false;
  return entry.internal !== true || kept;
}

/**
 * Gives a port to every public service whose manifest names none: the one it
 * had on the machine if that is still free, the lowest free one of the
 * services' range otherwise. A manifest that names its ports is returned as
 * it is, and so are its workers and its scheduled services, see wantsPort.
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
      if (!wantsPort(service, previousPorts.has(name))) {
        next[name] = service;
        continue;
      }
      const port = pick(name);
      if (port === null) return { refusal: `no free port between ${SERVICE_PORTS.first} and ${SERVICE_PORTS.last} on the machine for services.${name}` };
      used.add(port);
      allocated.push({ service: name, port });
      next[name] = { ...(service as Record<string, unknown>), port };
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
    return Object.values(object.services as Record<string, unknown>).some((service) => wantsPort(service));
  }
  return typeof object.start === "string" && object.start.length > 0 && !("port" in object);
}

