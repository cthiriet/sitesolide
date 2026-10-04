/**
 * `sitesolide mcp`: the CLI's commands as tools an agent calls, over the Model
 * Context Protocol, on standard input and output.
 *
 * An agent that can run commands can already drive the CLI with `--json`. A
 * tool interface adds what a shell does not: each tool says what it does and
 * what it changes, in words written for a model, and the client asks its user
 * before a call that changes something. That is the point of `deploy` being a
 * tool whose description says, first, that it replaces a live site.
 *
 * EACH TOOL RUNS THE CLI ITSELF, `sitesolide <command> --json` in the folder
 * named, and returns its events. Nothing here deploys, reads or decides on its
 * own: the refusals, the dry run, the lock shared with the gatekeeper, the
 * door read from the machine all stay where they are, and a tool behaves
 * exactly like the command typed in a terminal. The configuration is read by
 * that command too, so the server starts, and lists its tools, on a
 * workstation that has none yet.
 *
 * What is not a tool, on purpose: `remove`, which deletes a project and its
 * data with no backup; `lock`, `unlock` and `domain --activate`, which change
 * what visitors see; `--force`, which replaces a file someone edited by hand
 * on the machine. Those stay the owner's, typed by them.
 *
 * THE PROTOCOL, written here rather than borrowed: a dependency for a few
 * hundred lines of JSON-RPC would be the largest thing in bin/. Both eras of
 * MCP are spoken, since the clients in use speak one or the other:
 *
 * - modern, 2026-07-28: no handshake, every request carries its protocol
 *   version and capabilities in `_meta`, `server/discover` describes the
 *   server, results carry `resultType`. A version this server does not speak
 *   is answered with UnsupportedProtocolVersionError and the versions it does;
 * - legacy, 2025-11-25 back to 2024-11-05: `initialize` negotiates the version
 *   once, `notifications/initialized` follows, then `tools/list` and
 *   `tools/call`, `ping` at any time.
 *
 * Requests are served concurrently, each answered when its command ends, and
 * `notifications/cancelled` interrupts the command as Ctrl-C would: a step in
 * progress finishes, then it stops, releasing the Caddy lock. Standard input
 * closing does the same to every command still running, then the server
 * exits. Nothing but protocol messages is ever written to standard output.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isValidSlug } from "./cli/manifest";
import { forEachLine } from "./cli/output";

const CLI = join(import.meta.dir, "sitesolide.ts");

export const MODERN_VERSIONS = ["2026-07-28"];
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** The `_meta` keys of the modern era. */
const META = {
  version: "io.modelcontextprotocol/protocolVersion",
  capabilities: "io.modelcontextprotocol/clientCapabilities",
  serverInfo: "io.modelcontextprotocol/serverInfo",
} as const;

export const SERVER_INFO = {
  name: "sitesolide",
  title: "sitesolide",
  version: (JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8")) as { version: string }).version,
};

/** The tool list changes only with a new version of this file: an hour of cache is safe. */
const CACHE = { ttlMs: 3_600_000, cacheScope: "public" } as const;

/** What the model reads about the server as a whole, before any tool. */
export const INSTRUCTIONS = [
  "sitesolide deploys project folders to the user's own server, one machine serving every site.",
  "Workflow: call detect on a folder without sitesolide.json and show the user the manifest and its notes;",
  "call deploy with dry_run true and show what would happen; deploy for real only once the user agrees,",
  "then give them the url from the result. When a call fails, its error carries a hint: follow it.",
  "Secrets never go in the repository nor in sitesolide.json: the user sets them in the dashboard's",
  "Secrets section, whose address a deploy stopped by a missing secret gives. Read logs when a service fails.",
  "Never change the server by any other means than these tools, and never retry a refusal with a workaround.",
].join(" ");

// --- tools -------------------------------------------------------------------

/** An absolute folder, as every tool but status takes it. */
const FOLDER = {
  type: "string",
  description: "Absolute path of the project's folder, the one holding sitesolide.json or the code to deploy.",
};

const SLUG = {
  type: "string",
  description:
    "The project's name on the server, used only when the folder has no sitesolide.json. Lowercase letters, digits and dashes. Defaults to the folder's name.",
};

type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
};

export const TOOLS: ToolDefinition[] = [
  {
    name: "detect",
    title: "Infer a manifest",
    description:
      "Infer the sitesolide.json manifest a project folder implies, from what it contains: static files, a package.json app or static site generator, a FastAPI or Flask app, a Go module. " +
      "Read-only: writes nothing and contacts no server. Returns the project kind, the manifest, why it was inferred, and notes to review with the user: secrets the code reads, outbound network calls, " +
      "and what deploy decides on its own, such as the port. Call it first on a folder without sitesolide.json.",
    inputSchema: { type: "object", properties: { folder: FOLDER, slug: SLUG }, required: ["folder"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "deploy",
    title: "Deploy a project",
    description:
      "Deploy a project folder to the user's server. THIS CHANGES THE LIVE SERVER unless dry_run is true: it builds locally, uploads, installs the service and its Caddy block, restarts it, " +
      "and replaces the version of the site visitors get. Ask the user before a real deploy, and run with dry_run true first to show them what would happen. " +
      "Needs a sitesolide.json in the folder, or accept_inferred true to write the inferred one first (refused if the server already has a project of that name). " +
      "On success the result carries the site's url, and manifestWritten true when sitesolide.json was written (an inferred manifest, a port chosen): commit it. " +
      "On failure the error carries a hint: follow it. A missing secret stops the deploy and names the dashboard page where the user sets it. " +
      "On a workstation that deploys with a team token rather than the owner's SSH access, dry_run is refused and nothing is sent: review sitesolide.json with the user instead.",
    inputSchema: {
      type: "object",
      properties: {
        folder: FOLDER,
        dry_run: {
          type: "boolean",
          description:
            "Show every step and the generated files, change nothing, and run nothing of the folder: the project's build is shown, not run, since it is the folder's own code. Default false.",
          default: false,
        },
        accept_inferred: {
          type: "boolean",
          description: "When the folder has no sitesolide.json, write the inferred one and deploy it. Default false: the inferred manifest is returned and nothing is deployed.",
          default: false,
        },
        slug: SLUG,
      },
      required: ["folder"],
      additionalProperties: false,
    },
    // Not idempotent: running it again restarts the service, a few seconds
    // of a site that does not answer.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "status",
    title: "Server status",
    description:
      "What the server runs: every project with its service state, memory, memory peak and ceiling, the ports listening on the loopback, and the machine's memory. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "logs",
    title: "Service logs",
    description:
      "The last journal entries of a deployed project's services, every unit of it interleaved by time, each with its time, unit, priority and message. Read-only. " +
      "Read them when a deploy fails at the restart or the verification, or when the site answers with an error.",
    inputSchema: {
      type: "object",
      properties: {
        folder: FOLDER,
        lines: { type: "integer", minimum: 1, maximum: 1000, description: "How many entries back. Default 50.", default: 50 },
      },
      required: ["folder"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "lock_status",
    title: "Preview lock status",
    description:
      "Whether the project's preview is closed behind an access code: wanted by the manifest, installed in Caddy, and the HTTP status a visitor gets without and with the code. " +
      "Read-only, and never reveals the code.",
    inputSchema: { type: "object", properties: { folder: FOLDER }, required: ["folder"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

export type ToolPlan = { argv: string[]; cwd: string } | { error: string };

/**
 * The CLI command a tool call stands for, or what is wrong with its
 * arguments, worded for the model to correct its call.
 */
export function planCall(name: string, args: Record<string, unknown>, cwd = process.cwd()): ToolPlan {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return { error: `unknown tool: ${name}` };
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(tool.inputSchema.properties, key)) return { error: `${key}: unknown argument; ${name} takes ${Object.keys(tool.inputSchema.properties).join(", ") || "none"}` };
  }
  const flag = (key: string): boolean | string => {
    const value = args[key];
    if (value === undefined) return false;
    return typeof value === "boolean" ? value : `${key}: true or false`;
  };

  let folder = cwd;
  if (Object.hasOwn(tool.inputSchema.properties, "folder")) {
    const given = args.folder;
    if (typeof given !== "string" || !isAbsolute(given)) return { error: "folder: required, the absolute path of the project's folder" };
    if (!existsSync(given) || !statSync(given).isDirectory()) return { error: `folder: ${given} is not a folder` };
    folder = given;
  }
  const slug = args.slug;
  if (slug !== undefined && (typeof slug !== "string" || !isValidSlug(slug))) {
    return { error: "slug: lowercase letters, digits and dashes, no dot, 63 characters at most" };
  }
  const named = typeof slug === "string" ? ["--slug", slug] : [];

  switch (name) {
    case "detect":
      return { argv: ["detect", ...named], cwd: folder };
    case "deploy": {
      const dryRun = flag("dry_run");
      const accept = flag("accept_inferred");
      if (typeof dryRun === "string") return { error: dryRun };
      if (typeof accept === "string") return { error: accept };
      return { argv: ["deploy", ...(dryRun ? ["--dry-run"] : []), ...(accept ? ["--yes"] : []), ...named], cwd: folder };
    }
    case "status":
      return { argv: ["status"], cwd: folder };
    case "logs": {
      const lines = args.lines ?? 50;
      if (typeof lines !== "number" || !Number.isInteger(lines) || lines < 1 || lines > 1000) {
        return { error: "lines: a whole number between 1 and 1000" };
      }
      return { argv: ["logs", "--lines", String(lines)], cwd: folder };
    }
    default:
      return { argv: ["lock", "--status"], cwd: folder };
  }
}

/** What a command run leaves: its exit code, its events, and whatever reached standard error. */
export type RunOutcome = { code: number; events: Record<string, unknown>[]; stderr: string };

/**
 * A tool's result: the command's `result` or `error`, the events that led to
 * it, and standard error when there was any. `isError` when the command
 * failed, so that the model sees the failure and its hint rather than a
 * protocol error it cannot act on.
 */
export function toolResult(outcome: RunOutcome): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
} {
  const without = ({ type: _type, ...rest }: Record<string, unknown>): Record<string, unknown> => rest;
  const result = outcome.events.find((event) => event.type === "result");
  const error = outcome.events.find((event) => event.type === "error");
  const ok = outcome.code === 0 && result !== undefined && error === undefined;
  const structured: Record<string, unknown> = { ok };
  if (result !== undefined) structured.result = without(result);
  if (error !== undefined) structured.error = without(error);
  else if (!ok) {
    structured.error = {
      message: `the command ended with code ${outcome.code} without saying why`,
      details: [],
      hint: "read stderr below; run the same call again once its cause is fixed",
    };
  }
  structured.events = outcome.events.filter((event) => event.type !== "result" && event.type !== "error");
  if (outcome.stderr !== "") structured.stderr = outcome.stderr.slice(-4000);
  return { content: [{ type: "text", text: JSON.stringify(structured, null, 2) }], structuredContent: structured, isError: !ok };
}

/** A command started: its outcome to come, and the way to interrupt it. */
export type Running = { done: Promise<RunOutcome>; interrupt(): void };
export type Runner = (argv: string[], cwd: string) => Running;

/**
 * Runs the CLI as a terminal would, with `--json`. Its standard input is
 * closed: the protocol's messages are this process's, and an ssh reading them
 * would eat them.
 */
export function runCli(argv: string[], cwd: string): Running {
  const proc = Bun.spawn([process.execPath, CLI, ...argv, "--json"], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const events: Record<string, unknown>[] = [];
  const done = (async (): Promise<RunOutcome> => {
    const [, stderr] = await Promise.all([
      forEachLine(proc.stdout, (line) => {
        if (line.trim() === "") return;
        try {
          const event = JSON.parse(line) as unknown;
          if (typeof event === "object" && event !== null && !Array.isArray(event)) {
            events.push(event as Record<string, unknown>);
            return;
          }
        } catch {
          // Kept below as what it is: a line that is not an event.
        }
        events.push({ type: "output", stream: "stdout", line });
      }),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, events, stderr: stderr.trim() };
  })();
  return { done, interrupt: () => proc.kill("SIGINT") };
}

// --- protocol ----------------------------------------------------------------

type Message = Record<string, unknown>;
type Id = string | number;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function success(id: Id, result: Record<string, unknown>): Message {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: Id | null, code: number, message: string, data?: unknown): Message {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** A result in the modern era's shape: `resultType`, and the server named in `_meta`. */
function modern(result: Record<string, unknown>): Record<string, unknown> {
  return { resultType: "complete", ...result, _meta: { [META.serverInfo]: { name: SERVER_INFO.name, version: SERVER_INFO.version } } };
}

const CAPABILITIES = { tools: {} };

/**
 * The server, apart from its transport: `receive` takes one line read from
 * the client and hands every answer to `send`. The tests drive it with a fake
 * runner; `serve` wires it to standard input and output.
 */
export function createServer(send: (message: Message) => void, runner: Runner = runCli, cwd = process.cwd()) {
  /** The legacy version negotiated by `initialize`, null before it. */
  let negotiated: string | null = null;
  const running = new Map<Id, { interrupt(): void; cancelled: boolean }>();

  async function call(id: Id, params: Record<string, unknown>, shape: (result: Record<string, unknown>) => Record<string, unknown>): Promise<Message | null> {
    const name = params.name;
    if (typeof name !== "string" || !TOOLS.some((tool) => tool.name === name)) {
      return failure(id, -32602, `Unknown tool: ${String(name)}`);
    }
    const args = params.arguments ?? {};
    if (!isObject(args)) return failure(id, -32602, "Invalid params: arguments must be an object");
    const plan = planCall(name, args, cwd);
    if ("error" in plan) return success(id, shape({ content: [{ type: "text", text: plan.error }], isError: true }));

    const started = runner(plan.argv, plan.cwd);
    const entry = { interrupt: started.interrupt, cancelled: false };
    running.set(id, entry);
    try {
      const outcome = await started.done;
      // A cancelled request gets no answer at all, whatever its command did.
      return entry.cancelled ? null : success(id, shape(toolResult(outcome)));
    } finally {
      running.delete(id);
    }
  }

  async function answer(id: Id, method: string, params: Record<string, unknown>): Promise<Message | null> {
    const meta = isObject(params._meta) ? params._meta : {};
    const requested = meta[META.version];

    if (typeof requested === "string") {
      const isModern = MODERN_VERSIONS.includes(requested);
      if (!isModern && !LEGACY_VERSIONS.includes(requested)) {
        return failure(id, -32022, "Unsupported protocol version", { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested });
      }
      if (isModern && !isObject(meta[META.capabilities])) {
        return failure(id, -32602, `Invalid params: _meta must carry ${META.capabilities}`);
      }
      // A legacy version named per request is served in its own shapes,
      // without a handshake: refusing it would send a client that read it in
      // the supported list round in circles.
      const shape = isModern ? modern : (result: Record<string, unknown>) => result;
      switch (method) {
        case "server/discover":
          return success(id, shape({ supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], capabilities: CAPABILITIES, instructions: INSTRUCTIONS, ...CACHE }));
        case "tools/list":
          return success(id, shape({ tools: TOOLS, ...(isModern ? CACHE : {}) }));
        case "tools/call":
          return call(id, params, shape);
        case "ping":
          return success(id, shape({}));
        default:
          return failure(id, -32601, `Method not found: ${method}`);
      }
    }

    if (method === "initialize") {
      const asked = params.protocolVersion;
      negotiated = typeof asked === "string" && LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0]!;
      return success(id, { protocolVersion: negotiated, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    if (method === "ping") return success(id, {});
    if (negotiated === null) {
      return failure(
        id,
        -32602,
        `Invalid params: _meta must carry ${META.version} (${MODERN_VERSIONS.join(", ")}), or the session must start with initialize (${LEGACY_VERSIONS.join(", ")})`,
      );
    }
    switch (method) {
      case "tools/list":
        return success(id, { tools: TOOLS });
      case "tools/call":
        return call(id, params, (result) => result);
      default:
        return failure(id, -32601, `Method not found: ${method}`);
    }
  }

  function notice(method: string, params: Record<string, unknown>): void {
    if (method !== "notifications/cancelled") return;
    const entry = running.get(params.requestId as Id);
    if (entry === undefined) return;
    entry.cancelled = true;
    entry.interrupt();
  }

  return {
    async receive(line: string): Promise<void> {
      if (line.trim() === "") return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return send(failure(null, -32700, "Parse error: a message is one JSON object per line"));
      }
      if (Array.isArray(message)) return send(failure(null, -32600, "Invalid Request: batches are not supported"));
      if (!isObject(message) || message.jsonrpc !== "2.0") return send(failure(null, -32600, "Invalid Request: not a JSON-RPC 2.0 message"));
      // A response: this server sends no request, so there is nothing it could answer.
      if (message.method === undefined && ("result" in message || "error" in message)) return;
      if (typeof message.method !== "string") return send(failure(null, -32600, "Invalid Request: method must be a string"));
      const params = isObject(message.params) ? message.params : {};
      if (!("id" in message)) return notice(message.method, params);
      const id = message.id;
      if (typeof id !== "string" && typeof id !== "number") return send(failure(null, -32600, "Invalid Request: id must be a string or a number"));
      // An id still in flight: its answer, and a cancellation aimed at it,
      // could no longer say which of the two commands they stand for.
      if (running.has(id)) return send(failure(id, -32600, "Invalid Request: this id belongs to a request still in progress"));
      const reply = await answer(id, message.method, params);
      if (reply !== null) send(reply);
    },
    /** Interrupts every command still running, as standard input closing asks. */
    interruptAll(): void {
      for (const entry of running.values()) {
        entry.cancelled = true;
        entry.interrupt();
      }
    },
  };
}

/**
 * The longest message read, in characters. This server's requests are a few
 * hundred bytes; a line without end would otherwise grow in memory until the
 * process fell over, taking the commands it runs with it.
 */
export const MAX_MESSAGE = 1024 * 1024;

/** The server on standard input and output, until standard input closes. */
export async function serve(input: ReadableStream<Uint8Array> = Bun.stdin.stream()): Promise<void> {
  const server = createServer((message) => console.log(JSON.stringify(message)));
  const pending = new Set<Promise<void>>();
  await forEachLine(
    input,
    (line) => {
      const task = server.receive(line).catch((error: unknown) => {
        console.error(`sitesolide mcp: ${(error as Error).message}`);
      });
      pending.add(task);
      void task.finally(() => pending.delete(task));
    },
    {
      length: MAX_MESSAGE,
      onOverflow: () => console.log(JSON.stringify(failure(null, -32700, `Parse error: a message is one JSON object per line, of ${MAX_MESSAGE} characters at most`))),
    },
  );
  server.interruptAll();
  await Promise.all(pending);
}
