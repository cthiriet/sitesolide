import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createServer,
  LEGACY_VERSIONS,
  MODERN_VERSIONS,
  planCall,
  TOOLS,
  toolResult,
  type RunOutcome,
  type Runner,
} from "../mcp";

/**
 * The MCP server apart from its transport and from the CLI: every message
 * goes through `receive`, every answer comes back through `send`, and the
 * commands are run by a fake runner that records what it was asked. The real
 * thing, over stdio with the real CLI, is in e2e/mcp.test.ts.
 */
const FOLDER = join(import.meta.dir, "infer", "bun-app");

type Message = Record<string, any>;

/** A server, what it sent, and the commands it ran. */
function harness(outcome: RunOutcome = { code: 0, events: [{ type: "result", ok: true, command: "detect" }], stderr: "" }) {
  const sent: Message[] = [];
  const ran: { argv: string[]; cwd: string }[] = [];
  let interrupted = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held = false;
  const runner: Runner = (argv, cwd) => {
    ran.push({ argv, cwd });
    return {
      done: (held ? gate : Promise.resolve()).then(() => outcome),
      interrupt: () => {
        interrupted++;
      },
    };
  };
  const server = createServer((message) => sent.push(message), runner, "/tmp");
  return {
    sent,
    ran,
    server,
    interrupted: () => interrupted,
    /** The next commands wait for `release()` before ending. */
    hold: () => (held = true),
    release: () => release(),
    async send(message: object): Promise<Message | undefined> {
      const before = sent.length;
      await server.receive(JSON.stringify(message));
      return sent.length > before ? sent.at(-1) : undefined;
    },
  };
}

/** The `_meta` a modern client puts on every request. */
const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSIONS[0],
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

describe("the legacy handshake", () => {
  test("initialize answers with the version asked for, the tools capability and the instructions", async () => {
    const h = harness();
    const reply = await h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect(reply).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "sitesolide" } } });
    expect(reply!.result.instructions).toContain("dry_run");
  });

  test("a version it does not speak gets its latest one, which the client may refuse", async () => {
    const reply = await harness().send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(reply!.result.protocolVersion).toBe(LEGACY_VERSIONS[0]);
  });

  test("notifications/initialized gets no answer; then tools/list, without resultType", async () => {
    const h = harness();
    await h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
    expect(await h.send({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    const list = await h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list!.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["detect", "deploy", "status", "logs", "sharing", "share", "lock_status"]);
    expect(list!.result.resultType).toBeUndefined();
  });

  test("ping is answered at any time, before initialize included", async () => {
    expect(await harness().send({ jsonrpc: "2.0", id: "p", method: "ping" })).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
  });

  test("a request before initialize and without _meta is refused, naming both ways in", async () => {
    const reply = await harness().send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(reply!.error.code).toBe(-32602);
    expect(reply!.error.message).toContain("initialize");
    expect(reply!.error.message).toContain("io.modelcontextprotocol/protocolVersion");
  });
});

describe("the modern era, no handshake", () => {
  test("server/discover: the versions, the capabilities, the server, the instructions, a cache hint", async () => {
    const reply = await harness().send({ jsonrpc: "2.0", id: "d", method: "server/discover", params: { _meta: META } });
    expect(reply!.result).toMatchObject({
      resultType: "complete",
      supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
      capabilities: { tools: {} },
      cacheScope: "public",
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "sitesolide" } },
    });
    expect(reply!.result.ttlMs).toBeGreaterThan(0);
  });

  test("tools/list carries resultType and the cache hint", async () => {
    const reply = await harness().send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: META } });
    expect(reply!.result.resultType).toBe("complete");
    expect(reply!.result.tools).toHaveLength(TOOLS.length);
    expect(reply!.result.cacheScope).toBe("public");
  });

  test("an unknown version: UnsupportedProtocolVersionError with every version spoken", async () => {
    const reply = await harness().send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: { ...META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } },
    });
    expect(reply!.error).toEqual({
      code: -32022,
      message: "Unsupported protocol version",
      data: { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested: "1900-01-01" },
    });
  });

  test("a legacy version named per request is served in its shape, so the supported list never sends a client round in circles", async () => {
    const reply = await harness().send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } } });
    expect(reply!.result.tools).toHaveLength(TOOLS.length);
    expect(reply!.result.resultType).toBeUndefined();
  });

  test("a modern request without its client capabilities is malformed", async () => {
    const reply = await harness().send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_VERSIONS[0] } } });
    expect(reply!.error.code).toBe(-32602);
  });

  test("an unknown method", async () => {
    const reply = await harness().send({ jsonrpc: "2.0", id: 1, method: "resources/list", params: { _meta: META } });
    expect(reply!.error.code).toBe(-32601);
  });
});

describe("JSON-RPC itself", () => {
  test("not JSON, a batch, an object that is not a request", async () => {
    const h = harness();
    await h.server.receive("{ not json");
    expect(h.sent.at(-1)!.error.code).toBe(-32700);
    expect((await h.send([{ jsonrpc: "2.0", id: 1, method: "ping" }]))!.error.code).toBe(-32600);
    expect((await h.send({ id: 1, method: "ping" }))!.error.code).toBe(-32600);
    expect((await h.send({ jsonrpc: "2.0", id: null, method: "ping" }))!.error.code).toBe(-32600);
  });

  test("a response or a blank line gets nothing back", async () => {
    const h = harness();
    expect(await h.send({ jsonrpc: "2.0", id: 9, result: {} })).toBeUndefined();
    await h.server.receive("   ");
    expect(h.sent).toEqual([]);
  });
});

describe("tools/call", () => {
  test("detect runs the CLI with --json's command in the folder named, and returns its result", async () => {
    const h = harness({ code: 0, events: [{ type: "info", message: "x" }, { type: "result", ok: true, command: "detect", kind: "bun" }], stderr: "" });
    const reply = await h.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { _meta: META, name: "detect", arguments: { folder: FOLDER } } });
    expect(h.ran).toEqual([{ argv: ["detect"], cwd: FOLDER }]);
    expect(reply!.result).toMatchObject({
      resultType: "complete",
      isError: false,
      structuredContent: { ok: true, result: { ok: true, command: "detect", kind: "bun" }, events: [{ type: "info", message: "x" }] },
    });
    expect(JSON.parse(reply!.result.content[0].text)).toEqual(reply!.result.structuredContent);
  });

  test("a command that fails is a tool error carrying the CLI's error and hint, not a protocol error", async () => {
    const h = harness({ code: 1, events: [{ type: "error", message: "build failed: bun run build", details: [], hint: "run the build" }], stderr: "" });
    await h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
    const reply = await h.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "deploy", arguments: { folder: FOLDER, dry_run: true } } });
    expect(reply!.result.isError).toBe(true);
    expect(reply!.result.structuredContent.error).toEqual({ message: "build failed: bun run build", details: [], hint: "run the build" });
    expect(h.ran[0]!.argv).toEqual(["deploy", "--dry-run"]);
  });

  test("bad arguments are a tool error the model can correct, and nothing runs", async () => {
    const h = harness();
    const call = (args: object) => h.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { _meta: META, name: "deploy", arguments: args } });
    expect((await call({ folder: "relative/path" }))!.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("absolute") }] });
    expect((await call({ folder: FOLDER, force: true }))!.result.content[0].text).toContain("force: unknown argument");
    expect((await call({ folder: FOLDER, dry_run: "yes" }))!.result.content[0].text).toContain("dry_run: true or false");
    expect(h.ran).toEqual([]);
  });

  test("an unknown tool is a protocol error", async () => {
    const reply = await harness().send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { _meta: META, name: "remove", arguments: {} } });
    expect(reply!.error).toEqual({ code: -32602, message: "Unknown tool: remove" });
  });

  test("notifications/cancelled interrupts the command, and the request is never answered", async () => {
    const h = harness();
    h.hold();
    const pending = h.server.receive(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { _meta: META, name: "detect", arguments: { folder: FOLDER } } }));
    await Bun.sleep(5);
    await h.server.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 8, reason: "user" } }));
    expect(h.interrupted()).toBe(1);
    h.release();
    await pending;
    expect(h.sent).toEqual([]);
  });

  test("an id still in flight is refused for another request, and the first one keeps its answer", async () => {
    const h = harness();
    h.hold();
    const first = h.server.receive(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { _meta: META, name: "status", arguments: {} } }));
    await h.server.receive(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { _meta: META, name: "detect", arguments: { folder: FOLDER } } }));
    expect(h.sent).toEqual([{ jsonrpc: "2.0", id: 8, error: { code: -32600, message: "Invalid Request: this id belongs to a request still in progress" } }]);
    // The second never ran: only the first command was started.
    expect(h.ran.map((entry) => entry.argv)).toEqual([["status"]]);
    h.release();
    await first;
    expect(h.sent.at(-1)).toMatchObject({ id: 8, result: { isError: false } });
    // Once answered, the id is free again.
    expect(await h.send({ jsonrpc: "2.0", id: 8, method: "ping", params: { _meta: META } })).toMatchObject({ id: 8, result: {} });
  });

  test("calls are served side by side: a slow one does not hold a quick one back", async () => {
    const h = harness();
    h.hold();
    const slow = h.server.receive(JSON.stringify({ jsonrpc: "2.0", id: "slow", method: "tools/call", params: { _meta: META, name: "status", arguments: {} } }));
    await h.server.receive(JSON.stringify({ jsonrpc: "2.0", id: "quick", method: "ping" }));
    expect(h.sent.map((message) => message.id)).toEqual(["quick"]);
    h.release();
    await slow;
    expect(h.sent.map((message) => message.id)).toEqual(["quick", "slow"]);
  });
});

describe("the tools", () => {
  test("deploy and share say first what they change, and are the only ones not read-only", () => {
    const deploy = TOOLS.find((tool) => tool.name === "deploy")!;
    expect(deploy.description).toContain("THIS CHANGES THE LIVE SERVER");
    expect(deploy.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const share = TOOLS.find((tool) => tool.name === "share")!;
    expect(share.description).toContain("THIS GIVES REAL PEOPLE ACCESS to the app and to the data");
    expect(share.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(TOOLS.find((tool) => tool.name === "sharing")!.description).toContain("real people access to the app and to the data");
    for (const tool of TOOLS.filter((candidate) => !["deploy", "share"].includes(candidate.name))) expect(tool.annotations.readOnlyHint).toBe(true);
  });

  test("no tool removes a project, locks, switches a domain or forces", () => {
    // share's `remove` takes a person or a domain off a site's sharing, which
    // only ever narrows who gets in: the one use of the word allowed.
    const words = TOOLS.flatMap((tool) => [tool.name, ...Object.keys(tool.inputSchema.properties).filter((key) => !(tool.name === "share" && key === "remove"))]);
    for (const forbidden of ["remove", "unlock", "force", "activate", "confirm", "public"]) expect(words.join(" ")).not.toContain(forbidden);
  });

  test("share's command line: the addresses as arguments, never as options", () => {
    expect(planCall("sharing", { folder: FOLDER })).toEqual({ argv: ["share"], cwd: FOLDER });
    expect(planCall("share", { folder: FOLDER, people: ["a@acme.test", "b@acme.test"], domain: "acme.test", remove: ["old.test", "c@acme.test"] })).toEqual({
      argv: ["share", "a@acme.test", "b@acme.test", "--domain", "acme.test", "--remove", "old.test", "--remove", "c@acme.test"],
      cwd: FOLDER,
    });
    expect(planCall("share", { folder: FOLDER, only_admins: true })).toEqual({ argv: ["share", "--only-admins"], cwd: FOLDER });
    expect(planCall("share", { folder: FOLDER })).toHaveProperty("error");
    expect(planCall("share", { folder: FOLDER, people: ["--only-admins"] })).toEqual({ error: "people: a list of email addresses" });
    expect(planCall("share", { folder: FOLDER, people: "a@acme.test" })).toHaveProperty("error");
    expect(planCall("share", { folder: FOLDER, domain: "--remove" })).toEqual({ error: "domain: a domain, like acme.com" });
    expect(planCall("share", { folder: FOLDER, public: true })).toHaveProperty("error");
  });

  test("each tool's command line", () => {
    expect(planCall("deploy", { folder: FOLDER, accept_inferred: true, slug: "shop" })).toEqual({ argv: ["deploy", "--yes", "--slug", "shop"], cwd: FOLDER });
    expect(planCall("logs", { folder: FOLDER, lines: 200 })).toEqual({ argv: ["logs", "--lines", "200"], cwd: FOLDER });
    expect(planCall("lock_status", { folder: FOLDER })).toEqual({ argv: ["lock", "--status"], cwd: FOLDER });
    expect(planCall("status", {}, "/somewhere")).toEqual({ argv: ["status"], cwd: "/somewhere" });
    expect(planCall("logs", { folder: FOLDER, lines: 0 })).toEqual({ error: "lines: a whole number between 1 and 1000" });
    expect(planCall("detect", { folder: FOLDER, slug: "Not.Valid" })).toHaveProperty("error");
    expect(planCall("detect", { folder: join(FOLDER, "missing") })).toHaveProperty("error");
  });

  test("a command that ended badly without an error event still reads as a failure", () => {
    const result = toolResult({ code: 2, events: [], stderr: "Segmentation fault" });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.stderr).toBe("Segmentation fault");
    expect((result.structuredContent.error as { message: string }).message).toContain("code 2");
  });
});
