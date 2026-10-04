import type { AuditEvent, AuditStore, GuestStore, SharingStore } from "../src/database";
import type { Guest } from "../src/guests";
import { DEFAULT_POLICY, type Policy } from "../src/sharing";

/** An in memory guest access store: the routes are judged without a database. */
export function memoryStore(): GuestStore & { rows: Map<string, { guest: Guest; hash: string }> } {
  const rows = new Map<string, { guest: Guest; hash: string }>();
  return {
    rows,
    byId: (id) => rows.get(id)?.guest ?? null,
    byHash: (hash) => [...rows.values()].find((row) => row.hash === hash)?.guest ?? null,
    list: () => [...rows.values()].map((row) => row.guest).sort((a, b) => b.createdAt - a.createdAt),
    create(guest, hash) {
      rows.set(guest.id, { guest: { ...guest }, hash });
    },
    touch(id, now) {
      const row = rows.get(id);
      if (row !== undefined) row.guest.seenAt = now;
    },
    remove: (id) => rows.delete(id),
  };
}

/** The sharing policies, in memory. */
export function memorySharing(): SharingStore & { rows: Map<string, { policy: Policy; updatedAt: number }> } {
  const rows = new Map<string, { policy: Policy; updatedAt: number }>();
  return {
    rows,
    get: (host) => rows.get(host)?.policy ?? DEFAULT_POLICY,
    list: () => [...rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([host, row]) => ({ host, ...row })),
    set(host, policy, now) {
      rows.set(host, { policy, updatedAt: now });
    },
  };
}

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
