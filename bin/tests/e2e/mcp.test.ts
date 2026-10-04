import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forEachLine } from "../../cli/output";
import { LEGACY_VERSIONS, MAX_MESSAGE, MODERN_VERSIONS } from "../../mcp";
import { createFakeVm, type FakeVm } from "./fake-vm";
import { CLI, TEST_EMAIL, TEST_ZONE, TESTS_ROOT } from "./run";

/**
 * `sitesolide mcp` for real: the server spawned as a client spawns it, spoken
 * to over its standard input and output, its tools running the real CLI.
 *
 * **It is spawned in front of the fake VM**, whose ssh answers only the reads
 * it recognises and whose zone resolves nowhere: the CLI each tool runs
 * inherits that environment. The deploy tool is only ever called here with
 * dry_run, and against that machine.
 */

type Message = Record<string, any>;

let vm: FakeVm | null = null;
let server: ReturnType<typeof Bun.spawn> | null = null;

afterEach(() => {
  server?.kill();
  server = null;
  vm?.cleanup();
  vm = null;
});

/** A server on stdio, and the messages it writes, as they come. */
function start() {
  vm = createFakeVm();
  const proc = Bun.spawn(["bun", CLI, "mcp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SITESOLIDE_ZONE: TEST_ZONE, SITESOLIDE_EMAIL: TEST_EMAIL, ...vm.env },
  });
  server = proc;
  const received: Message[] = [];
  const lines: string[] = [];
  const reading = forEachLine(proc.stdout, (line) => {
    lines.push(line);
    received.push(JSON.parse(line) as Message);
  });

  return {
    lines,
    send(message: object): void {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
      proc.stdin.flush();
    },
    /** The answer to request `id`, waited for. */
    async answer(id: string | number, timeout = 20_000): Promise<Message> {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const found = received.find((message) => message.id === id);
        if (found !== undefined) return found;
        await Bun.sleep(20);
      }
      throw new Error(`no answer to ${id}; received ${JSON.stringify(received)}`);
    },
    async close(): Promise<number> {
      proc.stdin.end();
      await reading;
      return proc.exited;
    },
  };
}

const META = {
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSIONS[0],
  "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

describe("sitesolide mcp over stdio", () => {
  test("the legacy handshake, the tool list, then detect on a folder", async () => {
    const mcp = start();
    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LEGACY_VERSIONS[0], capabilities: {}, clientInfo: { name: "e2e", version: "1" } } });
    const initialized = await mcp.answer(1);
    expect(initialized.result).toMatchObject({ protocolVersion: LEGACY_VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: "sitesolide" } });

    mcp.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = await mcp.answer(2);
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["detect", "deploy", "status", "logs", "sharing", "share", "lock_status"]);

    mcp.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "detect", arguments: { folder: join(TESTS_ROOT, "..", "infer", "bun-app") } } });
    const detected = await mcp.answer(3);
    expect(detected.result.isError).toBe(false);
    expect(detected.result.structuredContent.result).toMatchObject({
      command: "detect",
      kind: "bun",
      manifest: { slug: "bun-app", start: "/usr/local/bin/bun run server.ts" },
      written: null,
    });
    expect(JSON.parse(detected.result.content[0].text).ok).toBe(true);

    // Standard input closed: the server exits, having written nothing but messages.
    expect(await mcp.close()).toBe(0);
    for (const line of mcp.lines) expect(JSON.parse(line).jsonrpc).toBe("2.0");
    // detect reads no machine: not a single command reached the fake one.
    expect(vm!.logs()).toEqual([]);
  });

  test("the modern era: server/discover, then a call carrying its _meta", async () => {
    const mcp = start();
    mcp.send({ jsonrpc: "2.0", id: "d", method: "server/discover", params: { _meta: META } });
    const discovered = await mcp.answer("d");
    expect(discovered.result).toMatchObject({ resultType: "complete", supportedVersions: expect.arrayContaining(MODERN_VERSIONS), capabilities: { tools: {} } });

    mcp.send({ jsonrpc: "2.0", id: "x", method: "tools/call", params: { _meta: META, name: "detect", arguments: { folder: join(TESTS_ROOT, "..", "infer", "root-index") } } });
    const refused = await mcp.answer("x");
    expect(refused.result.resultType).toBe("complete");
    expect(refused.result.isError).toBe(true);
    expect(refused.result.structuredContent.error.message).toStartWith("nothing deployable recognised in");
    expect(refused.result.structuredContent.error.hint).toBeString();
    expect(await mcp.close()).toBe(0);
  });

  test("deploy with dry_run, against the fake machine: the plan and the address, nothing changed", async () => {
    const mcp = start();
    mcp.send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { _meta: META, name: "deploy", arguments: { folder: join(TESTS_ROOT, "projects", "bun-mixed"), dry_run: true } },
    });
    const deployed = await mcp.answer(7, 60_000);
    expect(deployed.result.isError).toBe(false);
    expect(deployed.result.structuredContent.result).toMatchObject({
      command: "deploy",
      slug: "sample-bun",
      dryRun: true,
      url: `https://sample-bun.${TEST_ZONE}/`,
    });
    const events = deployed.result.structuredContent.events as Message[];
    expect(events.some((event) => event.type === "planned")).toBe(true);
    // Only reads reached the machine.
    expect(vm!.logs().every((line) => line.startsWith("READ ") || line.startsWith("UNITS "))).toBe(true);
    expect(await mcp.close()).toBe(0);
  });

  test("a line beyond the limit is refused without being held, and the next one is served", async () => {
    const mcp = start();
    mcp.send({ jsonrpc: "2.0", id: "big", method: "ping", params: { _meta: META, padding: "x".repeat(MAX_MESSAGE + 10) } });
    mcp.send({ jsonrpc: "2.0", id: "after", method: "ping", params: { _meta: META } });
    expect((await mcp.answer("after")).result).toMatchObject({ resultType: "complete" });
    const refused = mcp.lines.map((line) => JSON.parse(line)).find((message) => message.id === null);
    expect(refused.error).toMatchObject({ code: -32700, message: expect.stringContaining("at most") });
    expect(mcp.lines.some((line) => line.includes('"big"'))).toBe(false);
    expect(await mcp.close()).toBe(0);
  });

  test("detect, the tool called without asking, never reads through a link out of the folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "mcp-link-"));
    try {
      const token = `sst_${"L".repeat(43)}`;
      writeFileSync(join(root, "team-token"), `${token}\n`);
      const folder = join(root, "project");
      cpSync(join(TESTS_ROOT, "..", "infer", "bun-app"), folder, { recursive: true });
      rmSync(join(folder, "package.json"));
      symlinkSync(join(root, "team-token"), join(folder, "package.json"));
      const mcp = start();
      mcp.send({ jsonrpc: "2.0", id: "l", method: "tools/call", params: { _meta: META, name: "detect", arguments: { folder } } });
      const answer = await mcp.answer("l");
      expect(answer.result.isError).toBe(true);
      expect(answer.result.structuredContent.error.details.join(" ")).toContain("a symbolic link leading outside the folder");
      expect(JSON.stringify(answer)).not.toContain("sst_");
      expect(await mcp.close()).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
