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
  PortalRequest,
  SetRequest,
  ProjectRequest,
  VariableRequest,
  LogEntry,
  Failure as SecretsError,
  FileState,
  FileView,
  FileKind,
  Operation,
  PortalView,
  ProjectView,
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
 * The control API's shapes, for the Team page: the tokens as the steward shows
 * them, and what they may do. `import type` as above: the rules of who may
 * deploy what stay with the steward and the installer.
 */
export type { Scope, TokenView, DeploymentState, AuditEntry, TeamDeployment, TeamPageResponse, CreatedTokenResponse } from "../../../src/control/protocol"

/**
 * The dashboard's members, from their contract (src/members/protocol.ts). Types
 * only: what a member may do is the steward's to decide.
 */
export type {
  IdentityView,
  MemberView,
  MembersPageResponse,
  Role,
  Roles,
  SessionResponse,
  SsoOffer,
} from "../../../src/members/protocol"

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
  LastRunView,
  RestoreResponse,
  RestoreState,
  RestoreView,
  RetentionPolicy,
  SnapshotKind,
  SnapshotView,
} from "../../../src/backup/protocol"
