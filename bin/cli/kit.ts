/**
 * Where the scripts, the infra files and the server components' sources live,
 * and the environment a child script needs to run.
 *
 * A stand-in: in a clone of the repository the kit is the repository itself,
 * and a child needs nothing beyond this process's environment. A compiled
 * binary carries the kit inside it and extracts it, and its `bun` has to work
 * without Bun installed; that version of this file replaces this one, with the
 * same two names, so that nothing calling them changes.
 *
 * Every script `setup` runs is found through `kitRoot()` and launched with
 * `kitEnv()` on top of its environment, never through a path of its own.
 */
import { resolve } from "node:path";

/** The folder holding bin/, infra/, dashboard/, portal/ and the rest. */
export function kitRoot(): string {
  return resolve(import.meta.dir, "..", "..");
}

/** What a child script's environment needs on top of this process's. Nothing, in a clone. */
export function kitEnv(): Record<string, string> {
  return {};
}
