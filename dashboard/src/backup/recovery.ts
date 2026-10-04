/**
 * What a restore leaves beside a project's data folder while it works, and
 * what to do with it if the restore was cut short. Pure.
 *
 * A restore swaps folders inside `/srv/sites/<folder>/`, by rename, which is
 * atomic one folder at a time:
 *
 *   .restore-incoming    the snapshot, extracted, waiting
 *   data                 renamed to .restore-previous, then
 *   .restore-incoming    renamed to data
 *   .restore-previous    removed once the service runs on the new data
 *   .restore-failed      the new data, set aside when the service did not
 *                        come back and the previous data was put back
 *
 * A stop at any instant leaves one of a few combinations. Those whose meaning
 * is certain are repaired at the next restore, and said so; the one that is
 * not, the new data in place with the previous one beside it, is refused: the
 * service may be running fine on the restored data, or not, and a human
 * decides, with the commands src/backup/README.md gives.
 */

export const DATA = "data";
export const INCOMING = ".restore-incoming";
export const PREVIOUS = ".restore-previous";
export const FAILED = ".restore-failed";

export type Present = { data: boolean; incoming: boolean; previous: boolean; failed: boolean };

export type Step = { rename: [from: string, to: string] } | { remove: string };

export type Plan = { kind: "clean"; steps: Step[]; note: string | null } | { kind: "refuse"; reason: string };

export const INTERRUPTED_REASON =
  "a restore of this site was interrupted after replacing its data: check the site, then see the Backups README on the server";

export function recoveryPlan(present: Present): Plan {
  const { data, incoming, previous, failed } = present;
  if (!incoming && !previous && !failed) return { kind: "clean", steps: [], note: null };
  // Stopped before the swap: the data in service was never touched.
  if (data && incoming && !previous && !failed) {
    return { kind: "clean", steps: [{ remove: INCOMING }], note: "an extraction left by an interrupted restore was removed" };
  }
  // Stopped between the two renames: the data in service is the previous one.
  if (!data && incoming && previous && !failed) {
    return {
      kind: "clean",
      steps: [{ rename: [PREVIOUS, DATA] }, { remove: INCOMING }],
      note: "an interrupted restore had left the site without its data folder: the previous data was put back",
    };
  }
  // Stopped while putting the previous data back after a failed start.
  if (!data && previous && failed && !incoming) {
    return {
      kind: "clean",
      steps: [{ rename: [PREVIOUS, DATA] }, { remove: FAILED }],
      note: "an interrupted rollback was finished: the previous data was put back",
    };
  }
  if (data && failed && !previous && !incoming) {
    return { kind: "clean", steps: [{ remove: FAILED }], note: "data set aside by an earlier failed restore was removed" };
  }
  return { kind: "refuse", reason: INTERRUPTED_REASON };
}
