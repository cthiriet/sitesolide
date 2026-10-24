import { describe, expect, test } from "bun:test";
import { createQueue, createServe } from "../src/secrets/requests";

/**
 * What every steward's routes share. The bodies and the refusals are driven
 * through each steward's own tests; here, what a steward relies on without
 * seeing it: each of its changes waits for the one before, and its bound on
 * requests in flight is its own, never another steward's.
 */

/** A task that runs until it is let go, and says when it started. */
function held(started: string[], name: string): { task: () => Promise<string>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    task: async () => {
      started.push(name);
      await gate;
      return name;
    },
    release,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("one change at a time", () => {
  test("each task starts once the one before it has ended, a failed one included, and answers its own result", async () => {
    const serially = createQueue();
    const started: string[] = [];
    const first = held(started, "first");
    const one = serially(first.task);
    const two = serially(async () => {
      started.push("second");
      throw new Error("refused");
    }).then(
      () => "answered",
      (e: Error) => e.message,
    );
    const three = serially(async () => {
      started.push("third");
      return 3;
    });
    await settle();
    expect(started).toEqual(["first"]);
    first.release();
    expect(await one).toBe("first");
    expect(await two).toBe("refused");
    expect(await three).toBe(3);
    expect(started).toEqual(["first", "second", "third"]);
  });

  test("two queues never wait for each other", async () => {
    const started: string[] = [];
    const blocked = held(started, "blocked");
    const waiting = createQueue()(blocked.task);
    expect(await createQueue()(async () => "free")).toBe("free");
    blocked.release();
    expect(await waiting).toBe("blocked");
  });
});

describe("the requests in flight", () => {
  test("bounded across the tables one serve answers, apart from another serve's", async () => {
    const started: string[] = [];
    const slow = held(started, "slow");
    const ok = async () => Response.json({ ok: true });
    const serve = createServe({ maxInFlight: 1, log: "test" });
    const dashboard = serve({ "/slow": { POST: async () => Response.json({ done: await slow.task() }) }, "/ok": { GET: ok } });
    const owner = serve({ "/ok": { GET: ok } });
    const other = createServe({ maxInFlight: 1, log: "other" })({ "/ok": { GET: ok } });

    const waiting = dashboard(new Request("http://steward/slow", { method: "POST" }));
    await settle();
    for (const handler of [dashboard, owner]) {
      const refused = await handler(new Request("http://steward/ok"));
      expect({ status: refused.status, body: await refused.json() }).toEqual({ status: 503, body: { error: "failure", message: "the server is busy, try again in a moment" } });
    }
    expect((await other(new Request("http://steward/ok"))).status).toBe(200);

    slow.release();
    expect(await (await waiting).json()).toEqual({ done: "slow" });
    expect((await owner(new Request("http://steward/ok"))).status).toBe(200);
  });

  test("a path renamed is served under its new name, and an unknown one never reaches a handler", async () => {
    const serve = createServe({ maxInFlight: 4, log: "test", rename: (path) => (path.startsWith("/members/") ? `/people/${path.slice("/members/".length)}` : path) });
    const handle = serve({ "/people/key": { GET: async () => Response.json({ key: true }) } });
    expect(await (await handle(new Request("http://steward/members/key"))).json()).toEqual({ key: true });
    expect(await (await handle(new Request("http://steward/people/key"))).json()).toEqual({ key: true });
    const unknown = await handle(new Request("http://steward/constructor"));
    expect({ status: unknown.status, body: await unknown.json() }).toEqual({ status: 404, body: { error: "not-found", message: "no such route" } });
  });
});
