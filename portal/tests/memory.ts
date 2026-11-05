import type { AuditEvent, AuditStore } from "../src/database";

/** The audit, in memory: the tests read what was recorded, in order. */
export function memoryAudit(): AuditStore & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    record(event, now) {
      events.push({
        id: events.length + 1,
        at: new Date(now).toISOString(),
        actor: event.actor,
        action: event.action,
        target: event.target ?? null,
        detail: event.detail ?? null,
      });
    },
    recent: (limit, before = Number.MAX_SAFE_INTEGER) =>
      events.filter((event) => event.id < before).reverse().slice(0, limit),
  };
}
