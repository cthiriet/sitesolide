import { describe, expect, test } from "bun:test";
import { MAX_SESSIONS_PER_MEMBER, MEMBER_SESSION_DURATION_MS } from "../src/people/protocol";
import { dropMember, encodeBook, EMPTY_BOOK, findSession, openMemberSession, readBook, spendNonce } from "../src/people/sessions";
import { memberReading } from "../src/people/view";
import type { Reading } from "../src/read";

/**
 * The pure rules of the people who sign in to the dashboard: what their
 * sessions read back as, and what they see of the snapshot. The routes that
 * apply them, as root, are in members-steward.test.ts; who they are and what
 * roles they hold is the access registry's.
 */

const NOW = 1_800_000_000_000;

describe("a person's sessions", () => {
  test("half a day, found by the token alone, gone with the person", async () => {
    const opened = await openMemberSession(EMPTY_BOOK, "alice@acme.test", NOW);
    expect(opened.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(opened.record.expiresAt).toBe(NOW + MEMBER_SESSION_DURATION_MS);
    // Only the hash is kept.
    expect(encodeBook(opened.book)).not.toContain(opened.token);
    expect(await findSession(opened.book, opened.token, NOW + 1)).toEqual(opened.record);
    expect(await findSession(opened.book, opened.token, NOW + MEMBER_SESSION_DURATION_MS)).toBeNull();
    expect(await findSession(opened.book, "x".repeat(43), NOW)).toBeNull();
    expect(await findSession(dropMember(opened.book, "alice@acme.test"), opened.token, NOW)).toBeNull();
    expect(await findSession(readBook(encodeBook(opened.book)), opened.token, NOW)).toEqual(opened.record);
  });

  test("a person holds ten at most, the oldest giving its place", async () => {
    let book = EMPTY_BOOK;
    const tokens: string[] = [];
    for (let i = 0; i <= MAX_SESSIONS_PER_MEMBER; i++) {
      const opened = await openMemberSession(book, "alice@acme.test", NOW + i);
      book = opened.book;
      tokens.push(opened.token);
    }
    expect(book.sessions.length).toBe(MAX_SESSIONS_PER_MEMBER);
    expect(await findSession(book, tokens[0], NOW + 20)).toBeNull();
    expect(await findSession(book, tokens.at(-1), NOW + 20)).not.toBeNull();
  });

  test("an assertion's nonce is spent once, until it would have expired", () => {
    const nonce = "n".repeat(43);
    const spent = spendNonce(EMPTY_BOOK, nonce, NOW + 300_000, NOW);
    if (typeof spent === "string") throw new Error(spent);
    expect(spendNonce(spent, nonce, NOW + 300_000, NOW + 1)).toBe("replayed");
    expect(spendNonce(readBook(encodeBook(spent)), nonce, NOW + 300_000, NOW + 1)).toBe("replayed");
    expect(typeof spendNonce(spent, nonce, NOW + 600_000, NOW + 300_000)).toBe("object");
  });

  test("a file that does not read is an empty book: everyone signs in again", () => {
    expect(readBook("not json")).toEqual(EMPTY_BOOK);
    expect(readBook(JSON.stringify({ sessions: [{ hash: "short" }], nonces: {} }))).toEqual(EMPTY_BOOK);
  });
});

describe("what a person sees of the snapshot", () => {
  const site = (slug: string) => ({ slug }) as never;
  const reading = {
    present: true,
    age: 1,
    stale: false,
    snapshot: {
      generated: NOW,
      zone: "test-zone.invalid",
      sites: [site("blog"), site("shop"), site("secret-project")],
      discrepancies: [
        { slug: "blog", severity: "error", message: "blog is down" },
        { slug: "secret-project", severity: "error", message: "secret-project is down" },
        { slug: null, severity: "warning", message: "disk at 91%" },
      ],
      machine: { memoryTotal: 1, memoryAvailable: 1, diskTotal: 1, diskFree: 1, load1: 1, load5: 1, load15: 1, cores: 1 },
    },
    audience: { present: true, age: 1, stale: false, days: 30, from: "", to: "", sites: { blog: {} as never, "secret-project": {} as never } },
  } as Reading;

  test("their projects alone, and nothing of the machine's own figures", () => {
    const seen = memberReading(reading, { blog: "viewer", shop: "developer" });
    if (!seen.present) throw new Error("absent");
    expect(seen.snapshot.sites.map((one) => one.slug)).toEqual(["blog", "shop"]);
    expect(seen.snapshot.discrepancies.map((one) => one.message)).toEqual(["blog is down"]);
    expect(seen.snapshot.machine).toBeNull();
    expect(Object.keys(seen.audience.sites)).toEqual(["blog"]);
    expect(JSON.stringify(seen)).not.toContain("secret-project");
  });
});
