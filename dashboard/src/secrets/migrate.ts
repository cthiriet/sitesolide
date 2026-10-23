/**
 * Moving a project from its legacy files to its store, without anyone seeing
 * a value: the merge, and the decision to delete a legacy file once the
 * store makes it useless. Pure: the steward reads the files and the store,
 * hands their assignments here, and writes what comes back.
 *
 * **Values go in, never out.** The plan carries the assignments to write
 * into the store, which the steward writes and never answers; everything an
 * answer is made of is a name, a file, or a reason.
 *
 * The order of a migration (spec §8.1): the units read the store first (a
 * deploy or a refresh), then the merge, which therefore never changes what a
 * running service has, a name the store already held being the one in effect
 * today; then a restart that loads the store; only then the deletion, which
 * can no longer take a value the service still needs.
 */
import type { MigrateConflict } from "../../borrowed/store-protocol";
import { PASSWORD_VARIABLE } from "../../borrowed/variables";
import type { Refusal } from "./scope";

/** A legacy file the migration reads, in the order the units read them. */
export type MigrationSource =
  | { file: string; state: "absent" }
  | { file: string; state: "unmanaged"; reason: string }
  | { file: string; state: "managed"; assignments: readonly (readonly [string, string])[] };

export type MigrationPlan =
  | { kind: "refused"; refusal: Refusal }
  | {
      kind: "plan";
      /** The files merged from, managed and present, in order. */
      sources: string[];
      /** The files declared or read but absent: nothing to merge. */
      skipped: { file: string; reason: string }[];
      /** Names the store lacked: written by the migration. */
      merged: string[];
      /** Names the store holds with the same value. */
      already: string[];
      /** Names the store holds with another value, which it keeps: it is the one in effect. */
      overridden: string[];
      /** Names two files set to different values: the whole migration is refused while one remains. */
      conflicts: MigrateConflict[];
      /** What the write sets in the store, in order. Never answered. */
      writes: [string, string][];
    };

/**
 * The merge of a project's legacy files into its store (spec §6.8, steps 3
 * to 5).
 *
 * A source that is not managed refuses the whole migration with its reason,
 * and so does one carrying `PASSWORD_HASH` or a name the store refuses
 * (`keyRefusal`, the store's `checkKey`), naming the file and the names: a
 * migration is all or nothing. An absent source is skipped and said.
 *
 * Two files setting one name to different values are a conflict, which
 * names the files and never a value; equal values merge. Against the store:
 * the same value is `already`, another value `overridden` (the store keeps
 * its own, the one in effect), no value `merged`, written.
 */
export function planMigration(input: {
  sources: readonly MigrationSource[];
  store: ReadonlyMap<string, string>;
  keyRefusal: (name: string) => string | null;
}): MigrationPlan {
  const sources: string[] = [];
  const skipped: { file: string; reason: string }[] = [];
  const seen = new Map<string, { value: string; files: string[]; conflict: boolean }>();
  const order: string[] = [];

  for (const source of input.sources) {
    if (source.state === "absent") {
      skipped.push({ file: source.file, reason: "absent" });
      continue;
    }
    if (source.state === "unmanaged") {
      return { kind: "refused", refusal: { error: "unmanaged", message: `${source.file} is not managed here: ${source.reason}; fix it, then migrate again` } };
    }
    const refused = source.assignments.map(([name]) => name).filter((name) => name === PASSWORD_VARIABLE || input.keyRefusal(name) !== null);
    if (refused.length > 0) {
      return {
        kind: "refused",
        refusal: { error: "invalid", message: `${source.file} holds ${[...new Set(refused)].join(", ")}, which a store does not take: remove them from ${source.file} first, then migrate again` },
      };
    }
    sources.push(source.file);
    for (const [name, value] of source.assignments) {
      const known = seen.get(name);
      if (known === undefined) {
        seen.set(name, { value, files: [source.file], conflict: false });
        order.push(name);
        continue;
      }
      if (!known.files.includes(source.file)) known.files.push(source.file);
      if (known.value !== value) known.conflict = true;
    }
  }

  const conflicts: MigrateConflict[] = [];
  const merged: string[] = [];
  const already: string[] = [];
  const overridden: string[] = [];
  const writes: [string, string][] = [];
  for (const name of order) {
    const { value, files, conflict } = seen.get(name)!;
    if (conflict) {
      conflicts.push({ name, files });
      continue;
    }
    const inStore = input.store.get(name);
    if (inStore === undefined) {
      merged.push(name);
      writes.push([name, value]);
    } else if (inStore === value) {
      already.push(name);
    } else {
      overridden.push(name);
    }
  }
  // A conflict refuses the whole migration: nothing is to be written.
  return { kind: "plan", sources, skipped, merged, already, overridden, conflicts, writes: conflicts.length > 0 ? [] : writes };
}

/** One legacy file asked to be retired, as the steward found it. */
export type RetireInput = {
  file: string;
  /** In the project's files or leftovers (scope.ts, readSites). */
  attached: boolean;
  /** A flat name under /etc/sitesolide, not `<slug>-secrets/<name>`. */
  flat: boolean;
  /** An environment file, read variable by variable. */
  variables: boolean;
  /** The machine's own files, or a hash-only one: never a project's to delete. */
  machine: boolean;
  state:
    | { kind: "absent" }
    | { kind: "unmanaged"; reason: string }
    | { kind: "managed"; assignments: readonly (readonly [string, string])[] };
  /** The store's variables, null when its env cannot be read. */
  store: ReadonlyMap<string, string> | null;
  /** Every installed unit of the project reads the store, last. */
  unitsReadStore: boolean;
  /** Every service of the project is scheduled: each run reads the store afresh. */
  allScheduled: boolean;
  /** The main service: active, and when it started, to the microsecond. */
  main: { active: boolean; startedUs: number | null };
  /** When the store's env was last written, with its fraction of a millisecond. */
  envModifiedMs: number | null;
  slug: string;
};

/**
 * May this legacy file be deleted (spec §6.9)? Attached to the project, flat,
 * an environment file, not the machine's; managed; covered, every assignment
 * in the store with the very same value; every unit reading the store; and,
 * when it holds a variable and the project runs a service for good, that
 * service active and started after the store's env was last written: the
 * store's values were loaded and the service holds. The reason, to the owner
 * alone, may say a value differs, never which.
 */
export function retireDecision(input: RetireInput): { retire: true } | { retire: false; reason: string } {
  const keep = (reason: string) => ({ retire: false as const, reason });
  if (!input.attached) return keep("not a legacy file of this project");
  if (!input.flat || !input.variables) return keep("not a flat environment file: only those are retired");
  if (input.machine) return keep("the machine's own file: never retired");
  const { state } = input;
  if (state.kind === "absent") return keep("absent: nothing to retire");
  if (state.kind === "unmanaged") return keep(`not managed here: ${state.reason}`);

  for (const [name, value] of state.assignments) {
    const inStore = input.store?.get(name);
    if (inStore === undefined) return keep(`not covered: ${name} is not in the store; sitesolide secrets migrate first`);
    if (inStore !== value) return keep(`not covered: the value of ${name} differs from the store's`);
  }

  if (!input.unitsReadStore) return keep(`not every unit of the project reads the store yet: sitesolide refresh ${input.slug}`);

  if (state.assignments.length > 0 && !input.allScheduled) {
    if (!input.main.active) return keep("the service is not active: its restart has to load the store first");
    const { startedUs } = input.main;
    const written = input.envModifiedMs === null ? null : Math.floor(input.envModifiedMs * 1000);
    if (startedUs === null || written === null || startedUs <= written) {
      return keep("the service has not restarted since the store was last written: restart it, then retire");
    }
  }
  return { retire: true };
}
