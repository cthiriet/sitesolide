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
