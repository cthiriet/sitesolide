/**
 * Fake sites, discrepancies and accesses for the tests, complete by default:
 * each test only states what it examines.
 */
import type { Guest } from "../src/lib/guests"
import type {
  LogEntry,
  Discrepancy,
  FileView,
  PortalView,
  ProjectView,
  Service,
  ServiceView,
  Site,
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
    domain: null,
    lock: { closed: false, code: null, url: null },
    portal: { wanted: false, installed: false, exemptions: [] },
    port: 3040,
    listening: true,
    service: service(),
    bytes: 22 * 1024 * 1024,
    deployed: null,
    secrets: [],
    ...partial,
  }
}

export function discrepancy(severity: Discrepancy["severity"], slug: string | null = "calendar", message = "m"): Discrepancy {
  return { slug, severity, message }
}

export function guest(partial: Partial<Guest> = {}): Guest {
  return {
    id: "AAAAAAAAAAAAAAAA",
    host: "forum.test-zone.invalid",
    label: "Alice",
    createdAt: 0,
    expiresAt: null,
    seenAt: null,
    ...partial,
  }
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
  return { slug: "cms", service: secretService(), files: [secretFile()], portal: portalView(), ...partial }
}

export function logEntry(partial: Partial<LogEntry> = {}): LogEntry {
  return {
    a: 1_800_000_000_000,
    operation: "set",
    result: "ok",
    slug: "cms",
    file: "cms.env",
    variable: "CMS_TOKEN",
    detail: null,
    ...partial,
  }
}
