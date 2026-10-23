/**
 * The shapes a project's store is listed and changed in: the steward's
 * answers and the bodies it takes, on the dashboard's socket, the owner's and
 * through the control API, which the CLI and the dashboard's page read too.
 *
 * Types only. The dashboard imports `../../borrowed/store-protocol`, its web
 * page `import type` from the same; the CLI imports this file. None of these
 * shapes carries a value but StoreRevealResponse, which only the owner's
 * unlocked dashboard ever receives.
 */
import type { GenerateFormat } from "./store";

/**
 * The steward's Verdict (dashboard/src/secrets/protocol.ts), structurally
 * identical. `reason`: why it did not come back, when the steward can say
 * better than systemd, a service that could not load its secret files (exit
 * status 243) worded as deploy and the monitor word it; absent otherwise.
 */
export type RestartVerdict = { kind: "active" | "looping" | "failure" | "scheduled"; state: string; subState: string; restarts: number; reason?: string };

/** Where a variable's value in force comes from: the store, a legacy file, or nowhere yet. */
export type VariableSource = "store" | "legacy" | "none";

export type StoreVariableView = {
  name: string;
  source: VariableSource;
  /** The legacy file it comes from when `source` is "legacy", the last one the unit reads; null otherwise. */
  file: string | null;
  /** Legacy files that hold it too and are overridden. Names only. */
  shadows: string[];
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

export type LegacyFileView = {
  /** The flat name under /etc/sitesolide. */
  name: string;
  state: "managed" | "absent" | "unmanaged";
  reason: string | null;
  variables: string[];
  /** An installed unit of the project reads it with EnvironmentFile=. */
  read: boolean;
  /** No longer declared: listed to be retired, never written. */
  leftover: boolean;
  /** To the owner alone: every variable is in the store with the same value. null to anyone else. */
  covered: boolean | null;
};

export type StoreMay = { write: boolean; reveal: boolean; restore: boolean; migrate: boolean };

export type StoreView = {
  slug: string;
  exists: boolean;
  state: "managed" | "absent" | "unmanaged";
  reason: string | null;
  variables: StoreVariableView[];
  missing: string[];
  files: StoreFileView[];
  legacy: LegacyFileView[];
  build: string[];
  public: { name: string; value: string }[];
  unitReadsStore: boolean | null;
  modifiedAt: number | null;
  restartPending: boolean;
  previous: boolean;
  may: StoreMay;
};

export type StoreMissing = { runtime: string[]; files: string[] };

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
export type StoreMigrateRequest = StoreTarget & { dryRun?: boolean };
/** `force`: the owner's explicit choice to retire a file whose values differ from the store's, the store's standing alone. */
export type StoreRetireRequest = StoreTarget & { files: string[]; force?: boolean };

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
/** A name the project's units read from its legacy files in different orders: which value is in effect cannot be told, and the migration refuses. */
export type MigrateConflict = { name: string; files: string[] };
/** A name two legacy files set differently: the value of `kept`, the last the units read and the one the service runs with, merged; the `others`' not. */
export type MigrateShadowed = { name: string; kept: string; others: string[] };
export type StoreMigrateResponse = {
  store: StoreView;
  sources: string[];
  skipped: { file: string; reason: string }[];
  merged: string[];
  already: string[];
  overridden: string[];
  shadowed: MigrateShadowed[];
  conflicts: MigrateConflict[];
  written: boolean;
};
/** `forced`: the files retired only because the request carried `force`, the store's values standing where theirs differed. */
export type StoreRetireResponse = { store: StoreView; retired: string[]; forced: string[]; kept: { file: string; reason: string }[] };
/**
 * A project's leftover flat files, names only, in the folder's order: those
 * no manifest declares and whose most specific owner by prefix is this
 * project, which names its secrets in its store. Empty for a project that is
 * not deployed, keeps the old form, or has none. Root's alone, on the owner's
 * socket: what `sitesolide remove` reads before it deletes the served folder.
 */
export type StoreLeftoversResponse = { slug: string; leftovers: string[] };

export type StoreApiChangeBody = { set?: Record<string, string>; remove?: string[]; restart?: boolean };
export type StoreApiGenerateBody = { name: string; format?: GenerateFormat; bytes?: number; replace?: boolean; restart?: boolean };
export type StoreApiFileBody = { content: string; restart?: boolean };
export type StoreRestartOutcome = { verdict: RestartVerdict } | { error: string; message: string; wait?: number };
export type StoreApiChangeResponse = StoreChangeResponse & { restart: StoreRestartOutcome | null };
