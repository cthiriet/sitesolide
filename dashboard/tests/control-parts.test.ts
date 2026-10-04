import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database";
import { reach, type ControlSteward } from "../src/control/client";
import { clientAddress, createLimiter } from "../src/control/limiter";
import { BUNDLE_NAME, UPLOAD_WINDOW_MS, type InstallerResult } from "../src/control/protocol";
import { cleanLine, judgeResult, readResult } from "../src/control/results";
import { createSpool } from "../src/control/spool";
import { createControlStore } from "../src/control/store";
import { createTracker, START_GRACE_MS } from "../src/control/tracker";

/** The dashboard's smaller pieces of the control API, each on its own. */

const toClean: string[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const path = mkdtempSync(join(tmpdir(), "control-parts-"));
  toClean.push(path);
  return path;
}

const ID = "aabbccddeeff001122334455";

function chunks(...pieces: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(piece);
      controller.close();
    },
  });
}

describe("the spool", () => {
  test("streams the archive to disk, 0600 in a 0700 folder", async () => {
    const root = folder();
    const spool = createSpool(join(root, "control"));
    const gz = Bun.gzipSync(new Uint8Array(5000));
    const receipt = await spool.receive(ID, chunks(gz.subarray(0, 1), gz.subarray(1, 10), gz.subarray(10)), 1024 * 1024);
    expect(receipt).toEqual({ kind: "received", bytes: gz.length });
    const path = join(root, "control", ID, BUNDLE_NAME);
    expect(readFileSync(path)).toEqual(Buffer.from(gz));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "control", ID)).mode & 0o777).toBe(0o700);
    expect(spool.list()).toEqual([ID]);
    spool.remove(ID);
    expect(spool.list()).toEqual([]);
  });

  test("counts while it writes: over the cap, the upload is dropped, nothing stays", async () => {
    const root = folder();
    const spool = createSpool(root);
    const gz = Bun.gzipSync(crypto.getRandomValues(new Uint8Array(4096)));
    expect(await spool.receive(ID, chunks(gz), 1000)).toEqual({ kind: "too-large" });
    expect(existsSync(join(root, ID))).toBe(false);
  });

  test("what is not gzip, whichever chunk its first bytes arrive in, and an empty body", async () => {
    const spool = createSpool(folder());
    expect(await spool.receive(ID, chunks(new Uint8Array([0x1f]), new Uint8Array([0x00, 1, 2])), 1000)).toEqual({ kind: "not-gzip" });
    expect(await spool.receive(ID, chunks(new TextEncoder().encode("hello")), 1000)).toEqual({ kind: "not-gzip" });
    expect(await spool.receive(ID, chunks(), 1000)).toEqual({ kind: "empty" });
    expect(await spool.receive(ID, null, 1000)).toEqual({ kind: "empty" });
  });

  test("a deployment id is the only name it accepts", () => {
    expect(() => createSpool(folder()).remove("../etc")).toThrow("not a deployment id");
  });
});

describe("the limiter", () => {
  test("three failures tolerated, then a wait that doubles, per address", () => {
    let now = 0;
    const limiter = createLimiter(() => now);
    for (let i = 0; i < 3; i++) limiter.failure("a");
    expect(limiter.wait("a")).toBe(0);
    limiter.failure("a");
    expect(limiter.wait("a")).toBe(5000);
    limiter.failure("a");
    expect(limiter.wait("a")).toBe(10000);
    expect(limiter.wait("b")).toBe(0);
    now += 10000;
    expect(limiter.wait("a")).toBe(0);
    limiter.success("a");
    limiter.failure("a");
    expect(limiter.wait("a")).toBe(0);
  });

  test("bounded: the oldest addresses are forgotten first", () => {
    const limiter = createLimiter(() => 0, 2);
    for (const address of ["a", "b", "c"]) for (let i = 0; i < 5; i++) limiter.failure(address);
    expect(limiter.wait("a")).toBe(0);
    expect(limiter.wait("c")).toBeGreaterThan(0);
  });

  test("the address Caddy forwards, a fixed key without Caddy", () => {
    expect(clientAddress(new Request("http://x", { headers: { "X-Forwarded-For": "203.0.113.5" } }))).toBe("203.0.113.5");
    expect(clientAddress(new Request("http://x"))).toBe("direct");
    expect(clientAddress(new Request("http://x", { headers: { "X-Forwarded-For": " " } }))).toBe("direct");
  });

  test("the last value, the one Caddy appends: what the client wrote in front never chooses its key", () => {
    // Caddy 2.11.4 keeps the client's value in front of its own when the peer
    // is a trusted proxy: the first value would then be anyone's choice.
    const forwarded = (value: string) => clientAddress(new Request("http://x", { headers: { "X-Forwarded-For": value } }));
    expect(forwarded("192.0.2.1, 203.0.113.5")).toBe("203.0.113.5");
    expect(forwarded("192.0.2.1, 198.51.100.7, 203.0.113.5")).toBe("203.0.113.5");
    const limiter = createLimiter(() => 0);
    for (let i = 0; i < 5; i++) limiter.failure(forwarded(`192.0.2.${i}, 203.0.113.5`));
    expect(limiter.wait("203.0.113.5")).toBeGreaterThan(0);
  });
});

describe("the store", () => {
  function store() {
    return createControlStore(openDatabase(join(folder(), "dashboard.db")));
  }

  test("a deployment: waiting, running, finished once", () => {
    const s = store();
    s.createDeployment({ id: ID, tokenId: "aaaaaaaaaaaa", email: "a@b.c", slug: "shop", creating: true, manifest: "{}", createdAt: 1 });
    expect(s.deployment(ID)).toMatchObject({ state: "awaiting-bundle", creating: true, slug: "shop" });
    expect(s.activeForSlug("shop")?.id).toBe(ID);
    expect(s.countRunning()).toBe(0);
    expect(s.markRunning(ID, 2)).toBe(true);
    expect(s.countRunning()).toBe(1);
    expect(s.markRunning(ID, 3)).toBe(false);
    expect(s.finish(ID, "succeeded", 4, null)).toBe(true);
    expect(s.finish(ID, "failed", 5, "late")).toBe(false);
    expect(s.deployment(ID)).toMatchObject({ state: "succeeded", startedAt: 2, finishedAt: 4, message: null });
    expect(s.activeForSlug("shop")).toBeNull();
  });

  test("only running deployments count against the machine, and the cap is claimed with the transition", () => {
    // Three deployments that never upload used to freeze every team
    // deployment for fifteen minutes.
    const s = store();
    const ids = ["a", "b", "c", "d", "e"].map((letter) => letter.repeat(24));
    ids.forEach((id, rank) => s.createDeployment({ id, tokenId: "aaaaaaaaaaaa", email: "a@b.c", slug: `shop${rank}`, creating: true, manifest: "{}", createdAt: rank }));
    expect(s.countRunning()).toBe(0);
    expect(s.awaitingForToken("aaaaaaaaaaaa").map((row) => row.id)).toEqual(ids);
    expect(s.awaitingForToken("bbbbbbbbbbbb")).toEqual([]);
    expect(ids.slice(0, 3).map((id) => s.markRunning(id, 10, 3))).toEqual([true, true, true]);
    // Full: the fourth keeps waiting for its archive, and gets in once one ends.
    expect(s.markRunning(ids[3]!, 11, 3)).toBe(false);
    expect(s.deployment(ids[3]!)?.state).toBe("awaiting-bundle");
    expect(s.finish(ids[0]!, "succeeded", 12, null)).toBe(true);
    expect(s.markRunning(ids[3]!, 13, 3)).toBe(true);
    expect(s.countRunning()).toBe(3);
    expect(s.awaitingForToken("aaaaaaaaaaaa").map((row) => row.id)).toEqual([ids[4]!]);
  });

  test("the audit, in the shape every component shares, newest first", () => {
    const s = store();
    s.recordAudit({ at: Date.UTC(2026, 9, 4), actor: "owner", action: "token.create", target: null, detail: { id: "x" } });
    s.recordAudit({ at: Date.UTC(2026, 9, 5), actor: "token:x", action: "deploy.start", target: "shop", detail: null });
    expect(s.listAudit(10)).toEqual([
      { id: 2, at: "2026-10-05T00:00:00.000Z", actor: "token:x", action: "deploy.start", target: "shop", detail: null },
      { id: 1, at: "2026-10-04T00:00:00.000Z", actor: "owner", action: "token.create", target: null, detail: { id: "x" } },
    ]);
    expect(s.listAudit(10, "token.").map((entry) => entry.id)).toEqual([1]);
  });
});

describe("the installer's result, judged", () => {
  const result: InstallerResult = {
    deployment: ID,
    slug: "shop",
    state: "succeeded",
    startedAt: 1,
    updatedAt: 2,
    finishedAt: 3,
    log: ["ok"],
    error: null,
    url: "https://shop.test-zone.invalid/",
    allocated: [{ service: null, port: 3002 }],
  };
  const info = { link: false, regular: true, links: 1, uid: 0, gid: 0, mode: 0o600, size: 10, modifiedAt: 0 };
  const present = (value: unknown, extra: Partial<typeof info> = {}) => ({ kind: "present" as const, info: { ...info, ...extra }, bytes: new TextEncoder().encode(JSON.stringify(value)) });

  test("root's, closed to others, for this deployment: read", () => {
    expect(judgeResult(present(result), ID, 0)).toEqual({ kind: "read", result });
  });

  test("anything else is not believed", () => {
    expect(judgeResult(present(result, { uid: 1000 }), ID, 0)).toMatchObject({ kind: "unreadable" });
    expect(judgeResult(present(result, { mode: 0o622 }), ID, 0)).toMatchObject({ kind: "unreadable" });
    expect(judgeResult({ kind: "present", info, bytes: null }, ID, 0)).toMatchObject({ kind: "unreadable" });
    expect(judgeResult({ kind: "absent" }, ID, 0)).toEqual({ kind: "absent" });
    expect(readResult(JSON.stringify({ ...result, state: "done" }), ID)).toMatchObject({ kind: "unreadable" });
    expect(readResult(JSON.stringify({ ...result, slug: "../x" }), ID)).toMatchObject({ kind: "unreadable" });
  });

  test("a log line is shown as it stands: no escape sequence, bounded", () => {
    expect(cleanLine("\u001b]0;title\u0007hello\tworld")).toBe("]0;titlehello  world");
    expect(cleanLine("x".repeat(5000)).length).toBe(1000);
  });
});

describe("reach", () => {
  test("an older steward's 404 reads as unavailable, nothing else does", async () => {
    expect(await reach(async () => Response.json({ error: "not-found", message: "no such route" }, { status: 404 }))).toEqual({ kind: "unavailable" });
    expect(await reach(async () => Response.json({ error: "not-found", message: "no such deployment" }, { status: 404 }))).toMatchObject({ kind: "received", status: 404 });
    expect(await reach(async () => new Response("<html>"))).toEqual({ kind: "unreadable" });
    expect(await reach(async () => Promise.reject(new Error("ECONNREFUSED")))).toEqual({ kind: "unreachable" });
  });

  test("an answer copying the bearer back is never relayed", async () => {
    const bearer = `sst_${"q".repeat(43)}`;
    expect(await reach(async () => Response.json({ error: "invalid", message: `bad ${bearer}` }, { status: 400 }), [bearer])).toEqual({ kind: "unreadable" });
  });
});

describe("the tracker", () => {
  function setup(answer: (id: string) => Response) {
    const root = folder();
    const store = createControlStore(openDatabase(join(root, "dashboard.db")));
    const spool = createSpool(join(root, "spool"));
    let now = 1_000_000;
    const steward = { deployment: async (id: string) => answer(id) } as unknown as ControlSteward;
    const tracker = createTracker({ store, steward, spool, clock: () => now });
    return { store, spool, tracker, root, advance: (ms: number) => (now += ms), now: () => now };
  }

  test("a running deployment that finished: its state and its audit, once, and its archive gone", async () => {
    const t = setup((id) => Response.json({ result: { deployment: id, slug: "shop", state: "failed", startedAt: 1, updatedAt: 2, finishedAt: 3, log: [], error: { code: "install-failed", message: "boom" }, url: null, allocated: [] } }));
    t.store.createDeployment({ id: ID, tokenId: "aaaaaaaaaaaa", email: "a@b.c", slug: "shop", creating: false, manifest: "{}", createdAt: t.now() });
    t.store.markRunning(ID, t.now());
    await t.spool.receive(ID, chunks(Bun.gzipSync(new Uint8Array(10))), 1000);
    await t.tracker.tick();
    await t.tracker.tick();
    expect(t.store.deployment(ID)).toMatchObject({ state: "failed", message: "install-failed: boom" });
    expect(t.store.listAudit(10).map((entry) => `${entry.action} ${entry.actor}`)).toEqual(["deploy.failure token:aaaaaaaaaaaa"]);
    expect(t.spool.list()).toEqual([]);
  });

  test("an installer that never wrote anything fails after the grace", async () => {
    const t = setup(() => Response.json({ error: "not-found", message: "no result for this deployment yet" }, { status: 404 }));
    t.store.createDeployment({ id: ID, tokenId: "aaaaaaaaaaaa", email: "a@b.c", slug: "shop", creating: false, manifest: "{}", createdAt: t.now() });
    t.store.markRunning(ID, t.now());
    await t.tracker.tick();
    expect(t.store.deployment(ID)?.state).toBe("running");
    t.advance(START_GRACE_MS + 1);
    await t.tracker.tick();
    expect(t.store.deployment(ID)).toMatchObject({ state: "failed", message: expect.stringContaining("no-result") });
  });

  test("an archive that never arrived expires, and a leftover in the spool goes", async () => {
    const t = setup(() => Response.json({}));
    t.store.createDeployment({ id: ID, tokenId: "aaaaaaaaaaaa", email: "a@b.c", slug: "shop", creating: false, manifest: "{}", createdAt: t.now() });
    await t.spool.receive("ffffffffffffffffffffffff", chunks(Bun.gzipSync(new Uint8Array(10))), 1000);
    t.advance(UPLOAD_WINDOW_MS + 1);
    await t.tracker.tick();
    expect(t.store.deployment(ID)?.state).toBe("expired");
    expect(t.spool.list()).toEqual([]);
  });
});
