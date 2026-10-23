/**
 * The snapshot types, imported from the server rather than copied over.
 *
 * `import type` only: the import is erased at build time, so `src/state.ts`
 * and what it borrows never enter the bundle sent to the browser. What
 * crosses over is the shape of the data, and it has a single source.
 */
export type {
  Discrepancy,
  Snapshot,
  RawMachine,
  Service,
  Site,
  SiteService,
} from "../../../src/state"

/**
 * The audience measurement, from the same contract as the service. It comes in
 * the same reading as the machine state: one call, one file.
 */
export type { Audience, DayCount, Row, Measure } from "../../../src/audience"

export type Reading =
  | { present: false; reason: string }
  | {
      present: true
      snapshot: import("../../../src/state").Snapshot
      audience: import("../../../src/audience").Audience
      age: number
      stale: boolean
    }

/**
 * The shapes of secrets management, from the same contract as the steward and
 * the service. `import type` here too: no rule of the protocol enters the
 * page, which sends and shows the steward's refusal without judging anything
 * itself.
 */
export type {
  ErrorCode,
  ContentRequest,
  FileRequest,
  PasswordRequest,
  SetRequest,
  ProjectRequest,
  VariableRequest,
  Failure as SecretsError,
  FileState,
  FileView,
  FileKind,
  PortalView,
  ContentResponse,
  DashboardUnlockResponse,
  FileResponse,
  LogResponse,
  PasswordResponse,
  PortalResponse,
  RestartResponse,
  DashboardResponse,
  ValueResponse,
  OperationResult,
  WithoutToken,
  ServiceView,
  VerdictKind,
  Verdict as RestartVerdict,
} from "../../../src/secrets/protocol"

/**
 * A project's store of secrets, from the shapes the steward answers in
 * (bin/cli/store-protocol.ts, borrowed into the dashboard): the same file the
 * CLI renders its `sitesolide secrets` listing from. `import type` here too:
 * names, states and what the viewer may do, never a value, but the one a
 * reveal returns to the owner.
 */
export type {
  LegacyFileView,
  MigrateConflict,
  StoreChangeResponse,
  StoreFileView,
  StoreMay,
  StoreMigrateResponse,
  StoreMissing,
  StoreRestoreResponse,
  StoreRetireResponse,
  StoreRevealResponse,
  StoreVariableView,
  StoreView,
  VariableSource,
} from "../../../borrowed/store-protocol"
export type { GenerateFormat } from "../../../borrowed/store"

/**
 * A project as the page reads it: the steward's, with its store, null for a
 * static site and a project whose files stay flat (the dashboard, the portal).
 * Written over the steward's own type rather than re-exported, so that a
 * steward that does not send `store` yet reads as a project with none
 * (`sortProjects` makes the field null): the page then shows the files alone,
 * as it did before stores.
 */
export type ProjectView = Omit<import("../../../src/secrets/protocol").ProjectView, "store"> & {
  store: import("../../../borrowed/store-protocol").StoreView | null
}

/** A project as it arrives, before the page has made sure of its `store`. */
export type ArrivingProjectView = Omit<ProjectView, "store"> & {
  store?: import("../../../borrowed/store-protocol").StoreView | null
}

/**
 * The steward's operations, with the three a store adds: a value drawn on the
 * server, legacy files merged into the store, and legacy files retired. Spelled
 * here as well as in the steward's type, so the log names them whichever of the
 * two the page is built against.
 */
export type Operation = import("../../../src/secrets/protocol").Operation | "generate" | "migrate" | "retire"

/** One line of the steward's log, its operation read with the store's three. Never a value. */
export type LogEntry = Omit<import("../../../src/secrets/protocol").LogEntry, "operation"> & { operation: Operation }

/**
 * The shapes of the Connectors page, from the same contract as the steward and
 * the service, `import type` alone like the secrets': a connector's value is
 * never part of them.
 */
export type {
  ConnectorView,
  ConnectorsView,
  ConnectorRequest,
  GrantRecord,
  DashboardConnectorsResponse,
  ConnectorsActivityResponse,
  EgressAuditRow,
  EgressStatus,
} from "../../../src/connectors/protocol"

/**
 * The control API's shapes, for the Tokens page: the tokens as the steward shows
 * them, and what they may do. `import type` as above: the rules of who may
 * deploy what stay with the steward and the installer.
 */
export type { Scope, TokenView, DeploymentState, AuditEntry, TeamDeployment, TeamPageResponse, CreatedTokenResponse } from "../../../src/control/protocol"

/**
 * Who is signed in, from the contract of the people who sign in
 * (src/people/protocol.ts). Types only: what a person may do is the
 * steward's to decide.
 */
export type { IdentityView, Roles, SessionResponse, SsoOffer, DashboardRole as Role } from "../../../src/people/protocol"

/**
 * Access, from its contract (src/access/protocol.ts): a project's general
 * access and people with access, and the machine's People.
 */
export type {
  AccessPageResponse,
  EntryResponse,
  EntryView,
  GeneralAccess,
  GeneralResponse,
  GeneralView,
  PeoplePageResponse,
  PersonResponse,
  PersonView,
  Role as AccessRole,
} from "../../../src/access/protocol"

/**
 * The machine's audit, every component's in one shape (src/audit/protocol.ts).
 * Types only: which rows exist and what they hold is the components' to say.
 */
export type { AuditResponse, AuditRow, AuditSource, SourceState, SourceStatus } from "../../../src/audit/protocol"

/**
 * The backups, from the contract the steward and the service share
 * (src/backup/protocol.ts). Types only: what may be restored is the steward's
 * to say, and the page shows its reason.
 */
export type {
  AuditEntry as BackupAuditEntry,
  BackupAuditResponse,
  BackupsResponse,
  BackupsView,
  CheckView,
  LastRunView,
  RestoreResponse,
  RestoreState,
  RestoreView,
  RetentionPolicy,
  SnapshotKind,
  SnapshotView,
} from "../../../src/backup/protocol"
