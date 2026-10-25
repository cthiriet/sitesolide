/**
 * The shapes a project's store is listed and changed in: the steward's
 * answers and the bodies it takes, on the dashboard's socket, the owner's and
 * through the control API, which the CLI and the dashboard's page read too.
 * And the one reading of a listing every side shares: what the store lacks
 * of what the manifest declares, and how serious that is.
 *
 * Shapes and that pure reading, no import but types. The dashboard imports
 * `../../borrowed/store-protocol`, its web page from the same; the CLI
 * imports this file. None of these shapes carries a value but
 * StoreRevealResponse, which only the owner's unlocked dashboard ever
 * receives.
 */
import type { GenerateFormat } from "./store";

/**
 * The steward's Verdict (dashboard/src/secrets/protocol.ts), structurally
 * identical. `reason`: why it did not come back, when the steward can say
 * better than systemd, a service that could not load its secret files (exit
 * status 243) worded as deploy and the monitor word it; absent otherwise.
 */
export type RestartVerdict = { kind: "active" | "looping" | "failure" | "scheduled"; state: string; subState: string; restarts: number; reason?: string };

/** Whether a variable has a value in the store, or none yet. */
export type VariableSource = "store" | "none";

export type StoreVariableView = {
  name: string;
  source: VariableSource;
  /** The deployed manifest lists it under `secrets` or `secrets.runtime`. */
  declared: boolean;
};

export type StoreFileView = {
  name: string;
  state: "set" | "missing" | "unmanaged";
  declared: boolean;
  reason: string | null;
  /** To the owner alone; null otherwise. */
  bytes: number | null;
  modifiedAt: number | null;
  restartPending: boolean;
};

export type StoreMay = { write: boolean; reveal: boolean; restore: boolean };

export type StoreView = {
  slug: string;
  exists: boolean;
  state: "managed" | "absent" | "unmanaged";
  reason: string | null;
  variables: StoreVariableView[];
  missing: string[];
  files: StoreFileView[];
  build: string[];
  public: { name: string; value: string }[];
  unitReadsStore: boolean | null;
  modifiedAt: number | null;
  restartPending: boolean;
  previous: boolean;
  may: StoreMay;
};

export type StoreMissing = { runtime: string[]; files: string[] };

/**
 * What a listing says the store lacks: the declared runtime names with no
 * value, and the declared files absent or empty, in the steward's order.
 * `sitesolide deploy` warns by it, the dashboard counts it among its
 * discrepancies and its Secrets section draws it: one rule, so that none of
 * them names what another does not.
 */
export function storeMissing(view: Pick<StoreView, "missing" | "files">): StoreMissing {
  return { runtime: [...view.missing], files: view.files.filter((file) => file.declared && file.state === "missing").map((file) => file.name) };
}

/**
 * How serious a declared name the store lacks is: a warning, not an error.
 * `sitesolide deploy` warns and goes on (docs/secrets.md, "Deploy never waits
 * on a runtime secret"), and the service starts without it: an app that
 * cannot live without the value stops at start, and that stop is an error of
 * its own, the service's, which the dashboard already says. The missing name
 * is what to set, worth a look; red stays for what has failed.
 */
export const MISSING_SECRET_SEVERITY = "warning";

export type StoreTarget = { slug: string };
export type StoreSetRequest = StoreTarget & { name: string; value: string };
export type StoreRemoveRequest = StoreTarget & { names: string[] };
export type StoreChangeRequest = StoreTarget & { set: Record<string, string>; remove: string[] };
export type StoreGenerateRequest = StoreTarget & { name: string; format?: GenerateFormat; bytes?: number; replace?: boolean };
/** `content`: the file's bytes in base64. */
export type StoreFileRequest = StoreTarget & { name: string; content: string };
export type StoreFileRemoveRequest = StoreTarget & { name: string };
export type StoreRevealRequest = StoreTarget & { name: string };
export type StoreRestoreRequest = StoreTarget & { dryRun?: boolean };

export type StoreListResponse = { store: StoreView };
/**
 * What an owner's write moved aside before it was made: the store a token's
 * write made ahead, on a name the machine does not carry, taken back with
 * the name and kept as its previous versions. Names only.
 */
export type StoreTakenBack = { slug: string; variables: string[]; files: string[] };
export type StoreChangeResponse = {
  store: StoreView;
  /** The store's folder was made by this request. */
  created: boolean;
  set: string[];
  generated: string[];
  removed: string[];
  /** Names asked to be removed that the store did not hold. */
  absent: string[];
  files: { set: string[]; removed: string[] };
  /** The owner's writes alone, when a token's store was moved aside first. */
  takenBack?: StoreTakenBack;
};
export type StoreRevealResponse = { value: string };
export type StoreRestoreResponse = StoreChangeResponse & { appeared: string[]; disappeared: string[]; restored: boolean };

export type StoreApiChangeBody = { set?: Record<string, string>; remove?: string[]; restart?: boolean };
export type StoreApiGenerateBody = { name: string; format?: GenerateFormat; bytes?: number; replace?: boolean; restart?: boolean };
export type StoreApiFileBody = { content: string; restart?: boolean };
export type StoreRestartOutcome = { verdict: RestartVerdict } | { error: string; message: string; wait?: number };
export type StoreApiChangeResponse = StoreChangeResponse & { restart: StoreRestartOutcome | null };
