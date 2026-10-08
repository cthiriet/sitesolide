import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeProjection, PROJECTION_MAX_BYTES } from "../src/access";
import { createAccessReader, READ_RETRY_MS, readText, type Read } from "../src/projection";
import { accessFolder, grant, projection, site, WRITTEN_AT } from "./access-file";
import { memoryGuests, memorySharing } from "./memory";

const HOST = "kanban.test-zone.invalid";
const OTHER = "roster.test-zone.invalid";
const ADMINS = ["owner@acme.test"];
const NOW = 1_800_000_000_000;
const HASH = "a".repeat(64);

/** Alice a developer on kanban, everyone at acme.test a visitor, one password access. */
const KANBAN = projection({
  [HOST]: site("kanban", {
    people: { "alice@acme.test": "developer" },
    domains: ["acme.test"],
    passwords: [grant({ hash: HASH, expiresAt: NOW + 3_600_000 })],
  }),
  [OTHER]: site("roster"),
});

/** The tables of a portal from before the steward, as the upgrade finds them. */
function legacyTables() {
  const sharing = memorySharing();
  sharing.put(HOST, { mode: "domain", people: ["zoe@elsewhere.test"], domains: ["acme.test"] }, 1);
  const guests = memoryGuests();
  guests.add({ id: "InViTeInViTe0001", host: HOST, label: "Alice", createdAt: 1, expiresAt: NOW + 3_600_000, seenAt: null }, "c".repeat(64));
  return { sharing, guests };
}

describe("reading the steward's projection", () => {
  test("decides from the steward's file, and leaves its mark at the first good read", () => {
    const access = accessFolder("good");
    access.write(KANBAN);
    const reader = access.reader();
    expect(existsSync(access.mark)).toBe(false);

    expect(reader.state()).toEqual({ reading: "steward", writtenAt: WRITTEN_AT });
    expect(existsSync(access.mark)).toBe(true);
    expect(statSync(access.mark).mode & 0o777).toBe(0o600);

    expect(reader.roleOf(HOST, "alice@acme.test", ADMINS)).toBe("developer");
    expect(reader.roleOf(HOST, "bob@acme.test", ADMINS)).toBe("visitor");
    expect(reader.roleOf(HOST, "eve@elsewhere.test", ADMINS)).toBeNull();
    expect(reader.roleOf(OTHER, "alice@acme.test", ADMINS)).toBeNull();
    expect(reader.roleOf("never.test-zone.invalid", "owner@acme.test", ADMINS)).toBe("admin");
  });

  test("finds a password access by its hash and by its identifier, on its own host and until its expiry", () => {
    const access = accessFolder("passwords");
    access.write(KANBAN);
    const reader = access.reader();
    expect(reader.passwordByHash(HASH, HOST, NOW)?.id).toBe("PaSsWoRdAcCeSs01");
    expect(reader.passwordById(HOST, "PaSsWoRdAcCeSs01", NOW)?.who).toBe("alice@elsewhere.test");

    expect(reader.passwordByHash(HASH, OTHER, NOW)).toBeNull();
    expect(reader.passwordById(OTHER, "PaSsWoRdAcCeSs01", NOW)).toBeNull();
    expect(reader.passwordByHash("b".repeat(64), HOST, NOW)).toBeNull();
    expect(reader.passwordById(HOST, "PaSsWoRdAcCeSs99", NOW)).toBeNull();

    expect(reader.passwordByHash(HASH, HOST, NOW + 3_599_999)).not.toBeNull();
    expect(reader.passwordByHash(HASH, HOST, NOW + 3_600_000)).toBeNull();
    expect(reader.passwordById(HOST, "PaSsWoRdAcCeSs01", NOW + 3_600_000)).toBeNull();
  });

  test("a rewrite is seen at the very next call: removing or lowering someone holds at their next request", () => {
    const access = accessFolder("rewrite");
    access.write(KANBAN);
    const reader = access.reader();
    expect(reader.roleOf(HOST, "alice@acme.test", ADMINS)).toBe("developer");

    access.write(projection({ [HOST]: site("kanban", { people: { "alice@acme.test": "viewer" } }) }, WRITTEN_AT + 1));
    expect(reader.roleOf(HOST, "alice@acme.test", ADMINS)).toBe("viewer");
    expect(reader.state()).toEqual({ reading: "steward", writtenAt: WRITTEN_AT + 1 });
    // The domain went with the rewrite, and the password access too.
    expect(reader.roleOf(HOST, "bob@acme.test", ADMINS)).toBeNull();
    expect(reader.passwordById(HOST, "PaSsWoRdAcCeSs01", NOW)).toBeNull();
    expect(reader.passwordByHash(HASH, HOST, NOW)).toBeNull();

    access.write(projection({ [HOST]: site("kanban") }, WRITTEN_AT + 2));
    expect(reader.roleOf(HOST, "alice@acme.test", ADMINS)).toBeNull();
  });

  test("even a write in place, same size and modification time, is seen: its change time moves", () => {
    // What no steward does, and what a hand edit or a repair of the file's
    // rights would: the change time is part of the file's identity.
    const access = accessFolder("unmoved");
    const at = new Date(WRITTEN_AT);
    writeFileSync(access.file, encodeProjection(KANBAN));
    utimesSync(access.file, at, at);
    const reader = access.reader();
    expect(reader.roleOf(HOST, "alice@acme.test", ADMINS)).toBe("developer");

    writeFileSync(access.file, encodeProjection(KANBAN).replace("alice@acme.test", "alicx@acme.test"));
    utimesSync(access.file, at, at);
    // Alice's own entry is gone: what is left is her domain's.
    expect(reader.roleOf(HOST, "alice@acme.test", ADMINS)).toBe("visitor");
    expect(reader.roleOf(HOST, "alicx@acme.test", ADMINS)).toBe("developer");
  });

  test("rights repaired on an unreadable file are seen without waiting for the steward", () => {
    const access = accessFolder("repaired");
    writeFileSync(access.file, encodeProjection(KANBAN));
    chmodSync(access.file, 0o000);
    const reader = access.reader();
    if (process.getuid?.() !== 0) expect(reader.state().reading).toBe("unreadable");
    chmodSync(access.file, 0o640);
    expect(reader.state().reading).toBe("steward");
  });
});

describe("a read that fails on the way", () => {
  test("too many open files, or an I/O error, keeps nothing closed beyond a few seconds, the file unchanged", () => {
    for (const code of ["EMFILE", "EIO", "ENFILE"]) {
      const access = accessFolder(`transient-${code}`);
      access.write(KANBAN);
      let now = NOW;
      let failing = true;
      const reads: string[] = [];
      const lines: string[] = [];
      const read = (path: string): Read => {
        reads.push(failing ? "failed" : "read");
        return failing ? { failed: code } : readText(path);
      };
      const reader = access.reader(null, (line) => lines.push(line), { now: () => now, read });

      // The first read fails: nothing opens from the file, the owner's emails aside.
      expect(reader.roleOf(HOST, "alice@acme.test", ADMINS)).toBeNull();
      expect(reader.roleOf(HOST, "owner@acme.test", ADMINS)).toBe("admin");
      expect(reader.state()).toEqual({ reading: "unreadable", writtenAt: null });
      expect(lines.filter((line) => line.includes(code))).toHaveLength(1);

      // Within the retry delay the file is not read again at every request.
      now += READ_RETRY_MS - 1;
      expect(reader.roleOf(HOST, "alice@acme.test", ADMINS)).toBeNull();
      expect(reads).toEqual(["failed"]);

      // Past it, the same file, never rewritten by the steward, is read again and believed.
      failing = false;
      now += 1;
      expect(reader.roleOf(HOST, "alice@acme.test", ADMINS)).toBe("developer");
      expect(reader.state()).toEqual({ reading: "steward", writtenAt: WRITTEN_AT });
      expect(reads).toEqual(["failed", "read"]);
      // Believed, it is not read again until it changes.
      now += 10 * READ_RETRY_MS;
      reader.roleOf(HOST, "alice@acme.test", ADMINS);
      expect(reads).toEqual(["failed", "read"]);
    }
  });

  test("a file judged and refused stays refused until it changes, however long it waits", () => {
    const access = accessFolder("refused-stays");
    access.write("{ not json");
    let now = NOW;
    let reads = 0;
    const reader = access.reader(null, () => {}, {
      now: () => now,
      read: (path) => {
        reads++;
        return readText(path);
      },
    });
    expect(reader.state().reading).toBe("unreadable");
    now += 100 * READ_RETRY_MS;
    expect(reader.state().reading).toBe("unreadable");
    expect(reads).toBe(1);
    access.write(KANBAN);
    expect(reader.state().reading).toBe("steward");
  });

  test("the real read says a link and a folder are refused, never a failure to retry", () => {
    const access = accessFolder("kinds");
    mkdirSync(access.file);
    expect("refused" in readText(access.file)).toBe(true);
    const linked = accessFolder("kinds-link");
    writeFileSync(join(linked.folder, "elsewhere.json"), encodeProjection(KANBAN));
    symlinkSync(join(linked.folder, "elsewhere.json"), linked.file);
    expect(readText(linked.file)).toEqual({ refused: "access.json is a link" });
    expect(readText(join(linked.folder, "absent.json"))).toEqual({ failed: "ENOENT" });
  });
});

describe("a projection that cannot be believed", () => {
  test("a malformed file opens nothing but the admin emails, says so once, and is read again when it changes", () => {
    const access = accessFolder("malformed");
    const lines: string[] = [];
    access.write(KANBAN);
    const reader = access.reader(null, (line) => lines.push(line));
    expect(reader.state().reading).toBe("steward");

    access.write(encodeProjection(KANBAN).replace('"developer"', '"member"'));
    expect(reader.state()).toEqual({ reading: "unreadable", writtenAt: null });
    expect(reader.roleOf(HOST, "alice@acme.test", ADMINS)).toBeNull();
    expect(reader.roleOf(HOST, "bob@acme.test", ADMINS)).toBeNull();
    expect(reader.passwordByHash(HASH, HOST, NOW)).toBeNull();
    expect(reader.passwordById(HOST, "PaSsWoRdAcCeSs01", NOW)).toBeNull();
    expect(reader.roleOf(HOST, "owner@acme.test", ADMINS)).toBe("admin");
    expect(lines.filter((line) => line.includes("does not have the expected shape"))).toHaveLength(1);

    access.write(KANBAN);
    expect(reader.state().reading).toBe("steward");
    expect(reader.roleOf(HOST, "alice@acme.test", ADMINS)).toBe("developer");
  });

  test("a malformed file is no reason to fall back to the old tables, nor to leave the mark", () => {
    const access = accessFolder("malformed-first");
    access.write("{ not json");
    const reader = access.reader(legacyTables());
    expect(reader.state().reading).toBe("unreadable");
    expect(reader.roleOf(HOST, "zoe@elsewhere.test", ADMINS)).toBeNull();
    expect(reader.passwordByHash("c".repeat(64), HOST, NOW)).toBeNull();
    expect(existsSync(access.mark)).toBe(false);
  });

  test("a missing file opens nothing once the mark says a projection was read, the old tables included", () => {
    const access = accessFolder("missing-marked");
    access.write(KANBAN);
    const reader = access.reader(legacyTables());
    expect(reader.state().reading).toBe("steward");

    access.remove();
    expect(reader.state()).toEqual({ reading: "unreadable", writtenAt: null });
    expect(reader.roleOf(HOST, "alice@acme.test", ADMINS)).toBeNull();
    expect(reader.roleOf(HOST, "zoe@elsewhere.test", ADMINS)).toBeNull();
    expect(reader.passwordByHash("c".repeat(64), HOST, NOW)).toBeNull();
    expect(reader.passwordById(HOST, "InViTeInViTe0001", NOW)).toBeNull();
    expect(reader.roleOf(HOST, "owner@acme.test", ADMINS)).toBe("admin");

    // A portal restarted then: the mark is on disk, not in memory.
    const restarted = access.reader(legacyTables());
    expect(restarted.state().reading).toBe("unreadable");
    expect(restarted.roleOf(HOST, "zoe@elsewhere.test", ADMINS)).toBeNull();

    access.write(KANBAN);
    expect(reader.roleOf(HOST, "alice@acme.test", ADMINS)).toBe("developer");
  });

  test("a missing file, with no old tables to fall back on, opens nothing", () => {
    const reader = accessFolder("missing-bare").reader(null);
    expect(reader.state()).toEqual({ reading: "unreadable", writtenAt: null });
    expect(reader.roleOf(HOST, "alice@acme.test", ADMINS)).toBeNull();
    expect(reader.roleOf(HOST, "owner@acme.test", ADMINS)).toBe("admin");
  });

  test("a file behind a symbolic link is not read, nor marked", () => {
    const access = accessFolder("link");
    const real = join(access.folder, "elsewhere.json");
    writeFileSync(real, encodeProjection(KANBAN));
    symlinkSync(real, access.file);
    const reader = access.reader(legacyTables());
    expect(reader.state().reading).toBe("unreadable");
    expect(reader.roleOf(HOST, "alice@acme.test", ADMINS)).toBeNull();
    expect(existsSync(access.mark)).toBe(false);
  });

  test("a folder in its place, or a file beyond the bound, is not read", () => {
    const folder = accessFolder("folder");
    mkdirSync(folder.file);
    expect(folder.reader().state().reading).toBe("unreadable");

    // Well formed JSON all the same: the bound alone refuses it.
    const large = accessFolder("large");
    const text = encodeProjection(KANBAN);
    large.write(text + " ".repeat(PROJECTION_MAX_BYTES + 1 - text.length));
    expect(large.reader().state().reading).toBe("unreadable");
  });

  test("a mark that cannot be written is said, and the projection decides all the same", () => {
    const access = accessFolder("unmarkable");
    access.write(KANBAN);
    const lines: string[] = [];
    const reader = createAccessReader({ file: access.file, mark: join(access.folder, "absent", "mark"), legacy: null, log: (line) => lines.push(line) });
    expect(reader.roleOf(HOST, "alice@acme.test", ADMINS)).toBe("developer");
    expect(lines.some((line) => line.includes("could not be written"))).toBe(true);
  });
});

describe("before the steward writes its projection", () => {
  test("the portal decides from its own tables as before: a member opens as visitor, an admin email as admin", () => {
    const reader = accessFolder("legacy").reader(legacyTables());
    expect(reader.state()).toEqual({ reading: "portal", writtenAt: null });
    expect(reader.roleOf(HOST, "zoe@elsewhere.test", ADMINS)).toBe("visitor");
    expect(reader.roleOf(HOST, "bob@acme.test", ADMINS)).toBe("visitor");
    expect(reader.roleOf(HOST, "owner@acme.test", ADMINS)).toBe("admin");
    expect(reader.roleOf(HOST, "eve@elsewhere.test", ADMINS)).toBeNull();
    // A site with no policy of its own has the narrowest: the admins alone.
    expect(reader.roleOf(OTHER, "zoe@elsewhere.test", ADMINS)).toBeNull();
    expect(reader.roleOf(OTHER, "owner@acme.test", ADMINS)).toBe("admin");
  });

  test("a guest from before signs in by its hash, its cookie is found by its identifier, on its own host and until its expiry", () => {
    const reader = accessFolder("legacy-guests").reader(legacyTables());
    expect(reader.passwordByHash("c".repeat(64), HOST, NOW)).toEqual({ id: "InViTeInViTe0001", who: "Alice", hash: "", expiresAt: NOW + 3_600_000 });
    expect(reader.passwordById(HOST, "InViTeInViTe0001", NOW)?.id).toBe("InViTeInViTe0001");

    expect(reader.passwordByHash("c".repeat(64), OTHER, NOW)).toBeNull();
    expect(reader.passwordById(OTHER, "InViTeInViTe0001", NOW)).toBeNull();
    expect(reader.passwordByHash("d".repeat(64), HOST, NOW)).toBeNull();
    expect(reader.passwordById(HOST, "InViTeInViTe0001", NOW + 3_600_000)).toBeNull();
    expect(reader.passwordByHash("c".repeat(64), HOST, NOW + 3_600_000)).toBeNull();
  });

  test("once the steward writes, its projection alone decides, and the old tables are never read again", () => {
    const access = accessFolder("legacy-then-steward");
    const reader = access.reader(legacyTables());
    expect(reader.roleOf(HOST, "zoe@elsewhere.test", ADMINS)).toBe("visitor");

    access.write(KANBAN);
    expect(reader.state().reading).toBe("steward");
    expect(existsSync(access.mark)).toBe(true);
    expect(reader.roleOf(HOST, "zoe@elsewhere.test", ADMINS)).toBeNull();
    expect(reader.passwordById(HOST, "InViTeInViTe0001", NOW)).toBeNull();

    access.remove();
    expect(reader.state().reading).toBe("unreadable");
    expect(reader.roleOf(HOST, "zoe@elsewhere.test", ADMINS)).toBeNull();
  });
});
