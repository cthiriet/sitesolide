/**
 * The access registry as the tests seed it: per person, their roles on each
 * project, and who may create projects. Built with the registry's own pure
 * operations (src/access/registry.ts), so that what a test writes is what the
 * steward would have written, then either laid where the steward reads it,
 * `access.json` in its state folder, or kept in memory behind the two methods
 * of the access store the members routes ask.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "../borrowed/access";
import { REGISTRY_NAME } from "../src/access/protocol";
import { EMPTY_REGISTRY, encodeRegistry, putEntry, readRegistry, setCreate, type Registry } from "../src/access/registry";
import type { AccessStore } from "../src/access/steward";

/** By email, or by `@domain` for a whole domain, the role on each project. */
export type People = Record<string, Record<string, Role>>;

/** A registry holding these people, and these who may create projects, given by the owner. */
export function registryOf(people: People, creators: readonly string[] = [], at = 1): Registry {
  let registry: Registry = EMPTY_REGISTRY;
  for (const [who, roles] of Object.entries(people)) {
    for (const [slug, role] of Object.entries(roles)) {
      const put = putEntry(registry, slug, who, role, "owner", at);
      if ("refusal" in put) throw new Error(put.refusal);
      registry = put.registry;
    }
  }
  for (const email of creators) {
    const set = setCreate(registry, email, true, "owner", at);
    if ("refusal" in set) throw new Error(set.refusal);
    registry = set.registry;
  }
  return registry;
}

/** The registry laid where the steward reads it, in its state folder. */
export function writeRegistry(stateFolder: string, registry: Registry): void {
  mkdirSync(stateFolder, { recursive: true });
  writeFileSync(join(stateFolder, REGISTRY_NAME), encodeRegistry(registry), { mode: 0o600 });
}

/** The registry as the steward left it in its state folder. */
export function readRegistryFile(stateFolder: string): Registry {
  const read = readRegistry(readFileSync(join(stateFolder, REGISTRY_NAME), "utf8"));
  if ("unreadable" in read) throw new Error(read.unreadable);
  return read;
}

/**
 * The access store's `read` and `change` on a registry kept in memory, which
 * the test may replace at any time as the owner would change it. A change
 * applies at once: one test drives one request at a time.
 */
export function memoryAccess(initial: Registry): Pick<AccessStore, "read" | "change"> & { value: Registry } {
  const store = {
    value: initial,
    read: async (): Promise<Registry | Response> => store.value,
    async change<T>(task: (registry: Registry) => Promise<{ registry: Registry; value: T } | Response>): Promise<T | Response> {
      const out = await task(store.value);
      if (out instanceof Response) return out;
      store.value = out.registry;
      return out.value;
    },
  };
  return store;
}
