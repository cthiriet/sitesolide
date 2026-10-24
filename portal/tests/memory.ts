import type { AuditEvent, AuditStore, GuestStore, SharingStore } from "../src/database";
import type { Guest } from "../src/database";
import { DEFAULT_POLICY, type Policy } from "../src/sharing";

/**
 * The guest accesses from before the steward kept them, in memory and
 * read-only like the table: a test lays its rows with `add`, the way a portal
 * upgraded with its old database finds them.
 */
export function memoryGuests(): GuestStore & { add: (guest: Guest, hash: string) => void } {
  const rows = new Map<string, { guest: Guest; hash: string }>();
  return {
    byId: (id) => rows.get(id)?.guest ?? null,
    byHash: (hash) => [...rows.values()].find((row) => row.hash === hash)?.guest ?? null,
    add(guest, hash) {
      rows.set(guest.id, { guest: { ...guest }, hash });
    },
  };
}

/** The sharing policies from before the steward, in memory and read-only: `put` stands for a row already there. */
export function memorySharing(): SharingStore & { put: (host: string, policy: Policy) => void } {
  const rows = new Map<string, Policy>();
  return {
    get: (host) => rows.get(host) ?? DEFAULT_POLICY,
    put(host, policy) {
      rows.set(host, policy);
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
