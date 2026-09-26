import type { GuestStore } from "../src/database";
import type { Guest } from "../src/guests";

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
