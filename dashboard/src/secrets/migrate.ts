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

/**
 * A legacy file the migration reads, in the order in effect: the order the
 * installed units read them with `EnvironmentFile=`, where the later wins,
 * the files no unit reads first, in the manifest's order.
 */
export type MigrationSource =
  | { file: string; state: "absent" }
  | { file: string; state: "unmanaged"; reason: string }
  | { file: string; state: "managed"; assignments: readonly (readonly [string, string])[] };

/**
 * A name two legacy files set to different values, the units agreeing on
 * their order: the value of `kept`, the last read, is the one the service
 * runs with, and the one merged; `others` hold another one, which is not.
 * Names and files only, never a value.
 */
export type ShadowedDuplicate = { name: string; kept: string; others: string[] };

export type MigrationPlan =
  | { kind: "refused"; refusal: Refusal }
  | {
      kind: "plan";
      /** The files merged from, managed and present, in the order in effect. */
      sources: string[];
      /** The files declared or read but absent: nothing to merge. */
      skipped: { file: string; reason: string }[];
      /** Names the store lacked: written by the migration. */
      merged: string[];
      /** Names the store holds with the same value. */
      already: string[];
      /** Names the store holds with another value, which it keeps: it is the one in effect. */
      overridden: string[];
      /** Names two files set differently, the value of the one in effect taken. */
      shadowed: ShadowedDuplicate[];
      /**
       * Names two files set differently while the project's units read those
       * files in different orders: no value is the one in effect for every
       * service, and the whole migration is refused while one remains.
       */
      conflicts: MigrateConflict[];
      /** What the write sets in the store, in order. Never answered. */
      writes: [string, string][];
    };

/**
 * The merge of a project's legacy files into its store (spec §6.8, steps 3
 * to 5).
 *
 * A source that is not managed refuses the whole migration with its reason,
 * and so does one carrying a name a store does not take, naming the file and
 * the names: a migration is all or nothing. An absent source is skipped and
 * said. Such a name is `PASSWORD_HASH`, a reserved one (`keyRefusal`, the
 * store's `checkKey` with nothing set), or one the project's env or a unit
 * sets too (`setElsewhere`). The file's value of it is the one the service
 * runs with, read after `Environment=`: the refusal says so, since removing
 * it from the file, the obvious remedy, would switch the service to another
 * value (migrationKeyRefusal).
 *
 * **The value merged is the one in effect.** Two files setting one name to
 * different values: systemd keeps the later one in the order the unit reads
 * them, and so does the merge, which therefore changes nothing the service
 * runs with; the others are said in `shadowed`, by name and file. Only when
 * the project's units disagree on that order (`orderAgreed` false) is there
 * no single value in effect: a conflict, which refuses everything. Equal
 * values merge. Against the store: the same value is `already`, another
 * value `overridden` (the store keeps its own, the one in effect), no value
 * `merged`, written.
 */
export function planMigration(input: {
  sources: readonly MigrationSource[];
  store: ReadonlyMap<string, string>;
  keyRefusal: (name: string) => string | null;
  /** Names the project's env, a service's env, the tree or an installed unit's `Environment=` sets. */
  setElsewhere?: ReadonlySet<string>;
  /** Every installed unit reads the sources in the same order. */
  orderAgreed: boolean;
}): MigrationPlan {
  const setElsewhere = input.setElsewhere ?? new Set<string>();
  const sources: string[] = [];
  const skipped: { file: string; reason: string }[] = [];
  /** Each name's assignments, in the order in effect. */
  const seen = new Map<string, { file: string; value: string }[]>();

  for (const source of input.sources) {
    if (source.state === "absent") {
      skipped.push({ file: source.file, reason: "absent" });
      continue;
    }
    if (source.state === "unmanaged") {
      return { kind: "refused", refusal: { error: "unmanaged", message: `${source.file} is not managed here: ${source.reason}; fix it, then migrate again` } };
    }
    const names = source.assignments.map(([name]) => name);
    const elsewhere = names.filter((name) => setElsewhere.has(name));
    const reserved = names.filter((name) => !setElsewhere.has(name) && (name === PASSWORD_VARIABLE || input.keyRefusal(name) !== null));
    const refusal = migrationKeyRefusal(source.file, elsewhere, reserved);
    if (refusal !== null) return { kind: "refused", refusal };
    sources.push(source.file);
    for (const [name, value] of source.assignments) {
      const known = seen.get(name) ?? [];
      known.push({ file: source.file, value });
      seen.set(name, known);
    }
  }

  const conflicts: MigrateConflict[] = [];
  const shadowed: ShadowedDuplicate[] = [];
  const merged: string[] = [];
  const already: string[] = [];
  const overridden: string[] = [];
  const writes: [string, string][] = [];
  for (const [name, assignments] of seen) {
    // The later wins, as systemd reads them.
    const kept = assignments.at(-1)!;
    const others = [...new Set(assignments.filter((one) => one.value !== kept.value).map((one) => one.file))];
    if (others.length > 0) {
      if (!input.orderAgreed) {
        conflicts.push({ name, files: [...new Set(assignments.map((one) => one.file))] });
        continue;
      }
      shadowed.push({ name, kept: kept.file, others });
    }
    const inStore = input.store.get(name);
    if (inStore === undefined) {
      merged.push(name);
      writes.push([name, kept.value]);
    } else if (inStore === kept.value) {
      already.push(name);
    } else {
      overridden.push(name);
    }
  }
  // A conflict refuses the whole migration: nothing is to be written.
  return { kind: "plan", sources, skipped, merged, already, overridden, shadowed, conflicts, writes: conflicts.length > 0 ? [] : writes };
}

/**
 * Why a legacy file's names keep it from being merged, or null, with the
 * remedy that keeps what the service runs with. The file is read with
 * `EnvironmentFile=`, after `Environment=`: its value wins over the
 * project's env and its unit's, and removing a name from it switches the
 * service to the env's value, or to none. Names only, never a value.
 *
 * - a name the env or a unit sets too: drop it there and deploy, and the
 *   store, which then takes it, keeps the file's value;
 * - a name no store holds, reserved or a password hash: the file's value is
 *   in effect, and going on means moving it where it belongs, knowingly.
 */
export function migrationKeyRefusal(file: string, setElsewhere: readonly string[], reserved: readonly string[]): Refusal | null {
  const sentences: string[] = [];
  /** The words of one name or of several. */
  const words = (names: readonly string[]) => {
    const unique = [...new Set(names)];
    const one = unique.length === 1;
    return {
      list: unique.join(", "),
      it: one ? "it" : "them",
      they: one ? "it" : "they",
      its: one ? "its value" : "their values",
      value: one ? "value" : "values",
      is: one ? "is the one" : "are the ones",
      belongs: one ? "belongs" : "belong",
    };
  };
  if (setElsewhere.length > 0) {
    const w = words(setElsewhere);
    sentences.push(
      `${file} holds ${w.list}, which the project's env or its unit sets too: the file's ${w.value}, read after, ${w.is} the service runs with, and a store takes no name its unit sets. Drop ${w.it} from the manifest's env (or the unit) and deploy, then migrate again: the store keeps ${w.its} from ${file}. Removing ${w.it} from ${file} instead would switch the service to the env's value`,
    );
  }
  if (reserved.length > 0) {
    const w = words(reserved);
    sentences.push(
      `${file} holds ${w.list}, which a store never holds: the file's ${w.value} ${w.is} the service runs with, and removing ${w.it} from ${file} changes that. Move ${w.it} to the manifest's env if ${w.they} ${w.belongs} there, deploy, then remove ${w.it} from ${file} and migrate again`,
    );
  }
  return sentences.length === 0 ? null : { error: "invalid", message: sentences.join(". ") };
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
  /** An installed unit reads it with `EnvironmentFile=`: what it holds is in effect, unless the store holds it too. */
  read: boolean;
  /**
   * The owner asked for it to go whatever its values: every name it holds
   * that the store holds too keeps the store's value, which is the one in
   * effect, and the file is kept as a copy. A name the store lacks still
   * keeps a file a unit reads: that value would leave the service.
   */
  force: boolean;
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
 *
 * With `force`, the owner's explicit choice, a value that differs from the
 * store's does not keep the file: the store's is the one in effect, and the
 * file's is kept in its copy. Nor does a name the store lacks, in a file no
 * unit reads. `forced` says it took that choice.
 */
export function retireDecision(input: RetireInput): { retire: true; forced: boolean } | { retire: false; reason: string } {
  const keep = (reason: string) => ({ retire: false as const, reason });
  if (!input.attached) return keep("not a legacy file of this project");
  if (!input.flat || !input.variables) return keep("not a flat environment file: only those are retired");
  if (input.machine) return keep("the machine's own file: never retired");
  const { state } = input;
  if (state.kind === "absent") return keep("absent: nothing to retire");
  if (state.kind === "unmanaged") return keep(`not managed here: ${state.reason}`);

  let forced = false;
  for (const [name, value] of state.assignments) {
    const inStore = input.store?.get(name);
    if (inStore === undefined) {
      // Read by no unit, its value is in effect nowhere: forced, it goes, its copy kept.
      if (input.force && !input.read) {
        forced = true;
        continue;
      }
      return keep(`not covered: ${name} is not in the store; sitesolide secrets migrate first`);
    }
    if (inStore !== value) {
      if (input.force) {
        forced = true;
        continue;
      }
      return keep(`not covered: the value of ${name} differs from the store's, which is the one in effect; retire it with force to let the store's value stand alone`);
    }
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
  return { retire: true, forced };
}
