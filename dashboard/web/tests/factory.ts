/**
 * Fake sites, discrepancies and accesses for the tests, complete by default:
 * each test only states what it examines.
 */
import type {
  LogEntry,
  Discrepancy,
  FileView,
  LegacyFileView,
  PortalView,
  ProjectView,
  StoreFileView,
  StoreVariableView,
  StoreView,
  Service,
  ServiceView,
  Site,
  SiteService,
} from "../src/lib/types"

export function service(partial: Partial<Service> = {}): Service {
  return {
    unit: "calendar",
    loaded: true,
    active: "active",
    subState: "running",
    memory: 64 * 1024 * 1024,
    peak: 88 * 1024 * 1024,
    limit: 256 * 1024 * 1024,
    restarts: 0,
    since: null,
    cpuTotal: null,
    cpuShare: null,
    ...partial,
  }
}

export function site(partial: Partial<Site> = {}): Site {
  return {
    slug: "calendar",
    description: null,
    type: "app",
    address: "calendar.test-zone.invalid",
    headless: false,
    domain: null,
    lock: { closed: false, code: null, url: null },
    portal: { wanted: false, installed: false, exemptions: [] },
    port: 3040,
    listening: true,
    service: service(),
    services: [],
    bytes: 22 * 1024 * 1024,
    deployed: null,
    secrets: [],
    ...partial,
  }
}

/** One process of a project: a public server taking every path left, unless the test says otherwise. */
export function siteService(partial: Partial<SiteService> = {}): SiteService {
  return {
    name: "web",
    unit: "calendar",
    kind: "server",
    main: false,
    port: null,
    listening: null,
    routes: null,
    internal: false,
    service: service(),
    schedule: null,
    ...partial,
  }
}

/**
 * A scheduled service as the snapshot carries it: its timer active
 * (waiting), its last run a success an hour before `now`, its next one in a
 * quarter of an hour.
 */
export function scheduledService(now: number, partial: Partial<SiteService> = {}, schedule: Partial<NonNullable<SiteService["schedule"]>> = {}): SiteService {
  return siteService({
    name: "sync",
    unit: "calendar.sync",
    kind: "scheduled",
    internal: true,
    service: service({ unit: "calendar.sync", active: "inactive", subState: "dead", memory: null, cpuShare: null }),
    schedule: {
      expression: "hourly",
      timeout: "1h",
      timer: "calendar.sync.timer",
      timerState: { loaded: true, active: "active", subState: "waiting" },
      lastTrigger: now - 3600_000,
      next: now + 15 * 60_000,
      lastRun: { at: now - 3600_000 + 30_000, ok: true, result: "success", status: 0, failure: null },
      ...schedule,
    },
    ...partial,
  })
}

export function discrepancy(severity: Discrepancy["severity"], slug: string | null = "calendar", message = "m"): Discrepancy {
  return { slug, severity, message }
}

export function secretFile(partial: Partial<FileView> = {}): FileView {
  return {
    name: "cms.env",
    kind: "variables",
    state: "managed",
    reason: null,
    expected: "site-cms:site-cms 0600",
    readable: true,
    variables: ["CMS_TOKEN"],
    passwords: [],
    bytes: null,
    modifiedAt: 1_800_000_000_000,
    previous: false,
    restartPending: false,
    ...partial,
  }
}

export function secretService(partial: Partial<ServiceView> = {}): ServiceView {
  return { unit: "cms.service", state: "active", subState: "running", startedAt: null, ...partial }
}

export function portalView(partial: Partial<PortalView> = {}): PortalView {
  return { requested: false, installed: false, modifiable: true, reason: null, ...partial }
}

export function secretProject(partial: Partial<ProjectView> = {}): ProjectView {
  return { slug: "cms", service: secretService(), files: [secretFile()], portal: portalView(), store: null, ...partial }
}

/** A project's store as the steward lists it to the owner: managed, read by its unit, nothing pending. */
export function storeView(partial: Partial<StoreView> = {}): StoreView {
  return {
    slug: "cms",
    exists: true,
    state: "managed",
    reason: null,
    variables: [],
    missing: [],
    files: [],
    legacy: [],
    build: [],
    public: [],
    unitReadsStore: true,
    modifiedAt: 1_800_000_000_000,
    restartPending: false,
    previous: false,
    may: { write: true, reveal: true, restore: true, migrate: true },
    ...partial,
  }
}

export function storeVariable(partial: Partial<StoreVariableView> = {}): StoreVariableView {
  return { name: "ADMIN_TOKEN", source: "store", file: null, shadows: [], declared: true, ...partial }
}

export function storeFile(partial: Partial<StoreFileView> = {}): StoreFileView {
  return { name: "gcp.json", state: "set", declared: true, reason: null, bytes: 2_300, modifiedAt: 1_800_000_000_000, restartPending: false, ...partial }
}

export function legacyFile(partial: Partial<LegacyFileView> = {}): LegacyFileView {
  return { name: "cms.env", state: "managed", reason: null, variables: ["CMS_TOKEN"], read: true, leftover: false, covered: true, ...partial }
}

export function logEntry(partial: Partial<LogEntry> = {}): LogEntry {
  return {
    a: 1_800_000_000_000,
    operation: "set",
    result: "ok",
    actor: "owner",
    member: null,
    slug: "cms",
    file: "cms.env",
    variable: "CMS_TOKEN",
    detail: null,
    ...partial,
  }
}
