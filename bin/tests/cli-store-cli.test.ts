import { describe, expect, test } from "bun:test";
import { OWNER_SOCKET } from "../cli/access";
import { secretsOf, type Manifest } from "../cli/manifest";
import type { Failure, Output, Remote } from "../cli/remote";
import {
  apiStore,
  handleMissing,
  looksLikeValue,
  missingOf,
  missingWarning,
  NAME_MAX_HERE,
  verdictWords,
  readStoreArguments,
  runStore,
  sshStore,
  storeLines,
  storelessRefusal,
  takenBackWarning,
  withDeclared,
  withheld,
  type MissingIo,
  type StoreAsk,
  type StoreDependencies,
  type StoreTransport,
} from "../cli/store-cli";
import type { StoreChangeResponse, StoreView } from "../cli/store-protocol";
import { VALUE_LIKE_PREFIXES } from "../cli/variables";

/**
 * `sitesolide secrets`, apart from the machine: the arguments read before
 * anything is sent, the two transports driven by a fake `run` and a fake
 * `fetch` that record what they were handed, the listing, and the missing
 * names' step of deploy with an injected terminal.
 *
 * The rule held throughout: a value never travels in an argument, never
 * comes back, and no refusal quotes an argument that could be one.
 */

const VALUE = "planted-secret-value-0123";

/** A listing, as the steward answers it, with what a test overrides. */
function view(over: Partial<StoreView> = {}): StoreView {
  return {
    slug: "shop",
    exists: true,
    state: "managed",
    reason: null,
    variables: [],
    missing: [],
    files: [],
    build: [],
    public: [],
    unitReadsStore: true,
    modifiedAt: null,
    restartPending: false,
    previous: false,
    may: { write: true, reveal: false, restore: true },
    ...over,
  };
}

function change(over: Partial<StoreChangeResponse> = {}): StoreChangeResponse {
  return { store: view(), created: false, set: [], generated: [], removed: [], absent: [], files: { set: [], removed: [] }, ...over };
}

/** What an in-process run printed: its lines, its refusals whole, and its result. */
function recording() {
  const lines: string[] = [];
  const failures: Failure[] = [];
  const results: Record<string, unknown>[] = [];
  const output: Output = {
    say: (line) => lines.push(line),
    journal: (line) => lines.push(line),
    failed: (failure) => {
      failures.push(failure);
      lines.push(`!! ${failure.error}: ${failure.message}`, ...(failure.details ?? []));
    },
    succeeded: (command, fields) => results.push({ command, ...fields }),
  };
  return { lines, failures, results, output };
}

// --- the arguments ---------------------------------------------------------------------

describe("the arguments of secrets, read before anything is sent", () => {
  const read = (...arguments_: string[]) => readStoreArguments(["secrets", ...arguments_], false);

  test("every action, with its options wherever they stand", () => {
    expect(read()).toEqual({ action: "list" });
    expect(read("--json")).toEqual({ action: "list" });
    expect(read("set", "API_KEY")).toEqual({ action: "set", name: "API_KEY", stdin: false, restart: false });
    expect(read("--restart", "set", "API_KEY", "--stdin")).toEqual({ action: "set", name: "API_KEY", stdin: true, restart: true });
    expect(read("generate", "SESSION_SECRET")).toEqual({ action: "generate", name: "SESSION_SECRET", format: "hex", bytes: 32, replace: false, restart: false });
    expect(read("generate", "SESSION_SECRET", "--format", "base64url", "--bytes", "48", "--replace", "--restart")).toEqual({
      action: "generate",
      name: "SESSION_SECRET",
      format: "base64url",
      bytes: 48,
      replace: true,
      restart: true,
    });
    expect(read("remove", "A", "B", "--restart")).toEqual({ action: "remove", names: ["A", "B"], restart: true });
    expect(read("set-file", "gcp.json")).toEqual({ action: "set-file", name: "gcp.json", restart: false });
    expect(read("remove-file", "tls.key", "--restart")).toEqual({ action: "remove-file", name: "tls.key", restart: true });
  });

  test("a value on the line, however it stands, is refused and never quoted", () => {
    for (const asked of [["set", `API_KEY=${VALUE}`], [`API_KEY=${VALUE}`], ["set", "API_KEY", VALUE], ["set", `--value=${VALUE}`], ["generate", "A", `sk_live_${VALUE}`]]) {
      const refusal = read(...asked) as Failure;
      expect(refusal.error).toBe("value-in-arguments");
      expect(JSON.stringify(refusal)).not.toContain(VALUE);
    }
  });

  test("a name that looks like a value is refused, its owner told the shell kept it, and never quoted", () => {
    for (const prefix of VALUE_LIKE_PREFIXES) {
      for (const asked of [["set", `${prefix}${VALUE}`], [`${prefix}${VALUE}`], ["remove", "OK", `${prefix}${VALUE}`], ["generate", `${prefix}${VALUE}`], ["set-file", `${prefix}${VALUE}`]]) {
        const refusal = read(...asked) as Failure;
        expect({ asked: asked.join(" "), error: refusal.error }).toEqual({ asked: asked.join(" "), error: "looks-like-value" });
        expect(JSON.stringify(refusal)).not.toContain(VALUE);
        expect(refusal.details!.join(" ")).toContain("shell's history");
      }
    }
    const long = "A".repeat(NAME_MAX_HERE + 1);
    expect(looksLikeValue(long)).toBe(true);
    expect(looksLikeValue("A".repeat(NAME_MAX_HERE))).toBe(false);
    expect(JSON.stringify(read("set", long))).not.toContain(long);
    // A variable's usual name is not one.
    for (const name of ["STRIPE_SECRET_KEY", "API_KEY", "DATABASE_URL", "sk", "SKY_COLOUR"]) expect(looksLikeValue(name)).toBe(false);
  });

  test("every refusal by its code, and none quotes what was typed", () => {
    const cases: [string[], string][] = [
      [["list"], "usage"],
      [["--stdin"], "usage"],
      [["frobnicate"], "usage"],
      [["set"], "usage"],
      [["set", "1BAD"], "invalid"],
      [["set", "API_KEY", "--bytes", "32"], "usage"],
      [["set", "API_KEY", "--dry-run"], "usage"],
      [["set", "API_KEY", "--force"], "usage"],
      [["remove"], "usage"],
      [["remove", "A", "--stdin"], "usage"],
      [["generate"], "usage"],
      [["generate", "A", "B"], "usage"],
      [["generate", "A", "--format", "base32"], "invalid"],
      [["generate", "A", "--bytes", "8"], "invalid"],
      [["generate", "A", "--bytes", "65"], "invalid"],
      [["generate", "A", "--bytes"], "usage"],
      [["set-file"], "usage"],
      [["set-file", ".hidden"], "invalid"],
      [["set-file", "sub/x"], "invalid"],
      [["set-file", "a..b"], "invalid"],
      [["set-file", "gcp.json", "other"], "usage"],
      // No action merges or retires files any more: each is an action, or an option, the command does not take.
      [["migrate"], "usage"],
      [["migrate", "--dry-run"], "usage"],
      [["migrate", "--retire"], "usage"],
      [["remove", "A", "--retire"], "usage"],
    ];
    for (const [asked, code] of cases) {
      const refusal = read(...asked) as Failure;
      expect({ asked: asked.join(" "), code: "error" in refusal ? refusal.error : "accepted" }).toEqual({ asked: asked.join(" "), code });
    }
    // Under --json nothing prompts: set needs --stdin, said before anything is read.
    expect(readStoreArguments(["secrets", "set", "API_KEY", "--json"], true)).toMatchObject({ error: "needs-stdin" });
    expect(readStoreArguments(["secrets", "set", "API_KEY", "--json", "--stdin"], true)).toMatchObject({ action: "set", stdin: true });
  });
});

// --- over SSH -------------------------------------------------------------------------

/** A fake `run`: every command and its standard input recorded, answered by `answer`. */
function machine(answer: (command: string, input: string | undefined) => { code: number; output: string; error?: string }) {
  const ran: { command: string; input: string | undefined }[] = [];
  const run = async (command: string, input?: string) => {
    ran.push({ command, input });
    const { code, output, error = "" } = answer(command, input);
    return { code, output, error };
  };
  return { ran, transport: sshStore(run) };
}

const curl = (status: number, body: object) => ({ code: 0, output: `${JSON.stringify(body)}\n${status}\n` });

describe("the owner's transport, over SSH to the steward's owner socket", () => {
  test("a listing: the read quoted, root on the owner's socket, nothing on standard input", async () => {
    const { ran, transport } = machine(() => curl(200, { store: view({ variables: [{ name: "A", source: "store", declared: true }] }) }));
    const listed = await transport.list("shop");
    expect(listed.ok).toBe(true);
    expect(ran).toEqual([{ command: `sudo curl -sS --max-time 30 -w '\\n%{http_code}\\n' --unix-socket ${OWNER_SOCKET} 'http://steward/store?slug=shop'`, input: undefined }]);
    expect(transport.owner).toBe(true);
    expect(transport.via).toBe("over SSH, as the owner");
  });

  test("every change: its route and method, the body on standard input, the value never in the command", async () => {
    const { ran, transport } = machine(() => curl(200, change()));
    await transport.change("shop", { set: [["API_KEY", VALUE]], remove: [] });
    await transport.change("shop", { set: [], remove: ["A", "B"] });
    await transport.change("shop", { set: [["A", VALUE]], remove: ["B"] });
    await transport.generate("shop", { name: "SESSION", format: "hex", bytes: 32 });
    await transport.setFile("shop", "gcp.json", new TextEncoder().encode(VALUE));
    await transport.removeFile("shop", "gcp.json");
    const routes = ran.map(({ command }) => /-X (\w+) .* http:\/\/steward(\/\S*)$/.exec(command)!.slice(1).join(" "));
    expect(routes).toEqual(["PUT /store/variable", "DELETE /store/variable", "PATCH /store", "POST /store/generate", "PUT /store/file", "DELETE /store/file"]);
    expect(ran.map(({ input }) => JSON.parse(input!))).toEqual([
      { slug: "shop", name: "API_KEY", value: VALUE },
      { slug: "shop", names: ["A", "B"] },
      { slug: "shop", set: { A: VALUE }, remove: ["B"] },
      { slug: "shop", name: "SESSION", format: "hex", bytes: 32 },
      { slug: "shop", name: "gcp.json", content: new TextEncoder().encode(VALUE).toBase64() },
      { slug: "shop", name: "gcp.json" },
    ]);
    for (const { command } of ran) {
      expect(command).not.toContain(VALUE);
      expect(command).toContain("--data-binary @-");
      expect(command).toContain(`--unix-socket ${OWNER_SOCKET}`);
    }
  });

  test("restart: its route, curl waiting longer for it, the slug on standard input", async () => {
    const { ran, transport } = machine(() => curl(200, { verdict: { kind: "active", state: "active", subState: "running", restarts: 0 } }));
    expect((await transport.restart("shop")).ok).toBe(true);
    expect(ran.map(({ input }) => JSON.parse(input!))).toEqual([{ slug: "shop" }]);
    expect(ran[0]!.command).toContain("--max-time 120");
    expect(ran[0]!.command).toEndWith("http://steward/restart");
  });

  test("a steward from before the store, one with no owner's socket, an ssh that does not connect: each said, nothing changed", async () => {
    const outdated = await machine(() => curl(404, { error: "not-found", message: "no such route" })).transport.list("shop");
    expect(outdated).toMatchObject({ ok: false, failure: { error: "steward-outdated" } });
    expect(JSON.stringify(outdated)).toContain("sitesolide upgrade");
    const socketless = await machine(() => ({ code: 7, output: "", error: "curl: (7) Couldn't connect" })).transport.change("shop", { set: [["A", VALUE]], remove: [] });
    expect(socketless).toMatchObject({ ok: false, failure: { error: "steward-outdated" } });
    const unreachable = await machine(() => ({ code: 255, output: "", error: "ssh: connect to host" })).transport.list("shop");
    expect(unreachable).toMatchObject({ ok: false, failure: { error: "ssh-failed" } });
    const refused = await machine(() => curl(400, { error: "invalid", message: "PORT is set by the deployment" })).transport.change("shop", { set: [["PORT", VALUE]], remove: [] });
    expect(refused).toMatchObject({ ok: false, failure: { error: "invalid", message: "PORT is set by the deployment: nothing was changed" } });
    const garbled = await machine(() => curl(200, { store: { slug: "shop" } })).transport.list("shop");
    expect(garbled).toMatchObject({ ok: false, failure: { error: "unreadable" } });
  });

  test("a slug that is not one never reaches a command", async () => {
    const { ran, transport } = machine(() => curl(200, change()));
    for (const slug of ["Shop", "shop'; reboot", "../etc", ""]) {
      expect((await transport.list(slug)).ok).toBe(false);
      expect((await transport.change(slug, { set: [], remove: ["A"] })).ok).toBe(false);
    }
    expect(ran).toEqual([]);
  });
});

// --- through the API ---------------------------------------------------------------------

describe("a token's transport, through the control API's store routes", () => {
  const remote: Remote = { api: "https://dashboard.test-zone.invalid", token: `sst_${"T".repeat(43)}` };
  type Seen = { method: string; url: string; body: unknown; authorization: string | null };

  function api(answer: (seen: Seen) => Response | Promise<Response>) {
    const seen: Seen[] = [];
    const fetcher = async (input: string, init?: BunFetchRequestInit) => {
      const one = {
        method: init?.method ?? "GET",
        url: input,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        authorization: new Headers(init?.headers).get("authorization"),
      };
      seen.push(one);
      return answer(one);
    };
    return { seen, transport: apiStore(remote, fetcher) };
  }

  test("each route, its method and body, the bearer on every one, the slug and the file encoded", async () => {
    const { seen, transport } = api((one) =>
      one.url.endsWith("/restart") ? Response.json({ verdict: { kind: "active", state: "active", subState: "running", restarts: 0 } }) : one.method === "GET" ? Response.json({ store: view() }) : Response.json({ ...change(), restart: null }),
    );
    await transport.list("shop");
    await transport.change("shop", { set: [["A", VALUE]], remove: ["B"] });
    await transport.generate("shop", { name: "SESSION" });
    await transport.setFile("shop", "gcp.json", new Uint8Array([1, 2, 3]));
    await transport.removeFile("shop", "tls.key");
    await transport.restart("shop");
    expect(seen.map(({ method, url, body }) => [method, url.replace(remote.api, ""), body])).toEqual([
      ["GET", "/api/v1/projects/shop/store", null],
      ["PATCH", "/api/v1/projects/shop/store", { set: { A: VALUE }, remove: ["B"] }],
      ["POST", "/api/v1/projects/shop/store/generate", { name: "SESSION" }],
      ["PUT", "/api/v1/projects/shop/store/files/gcp.json", { content: "AQID" }],
      ["DELETE", "/api/v1/projects/shop/store/files/tls.key", null],
      ["POST", "/api/v1/projects/shop/restart", null],
    ]);
    expect(seen.every(({ authorization }) => authorization === `Bearer ${remote.token}`)).toBe(true);
    expect(transport.owner).toBe(false);
  });

  test("a dashboard before the store: not-available, the owner to upgrade", async () => {
    const { transport } = api(() => Response.json({ error: "not-found", message: "no such route: see docs/access.md" }, { status: 404 }));
    expect(await transport.list("shop")).toMatchObject({ ok: false, failure: { error: "not-available" } });
    expect(await transport.change("shop", { set: [["A", VALUE]], remove: [] })).toMatchObject({ ok: false, failure: { error: "not-available" } });
  });

  test("a change whose answer never came may be written: unconfirmed, and how to check; a connection refused sent nothing", async () => {
    const dropped = api(() => {
      throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    });
    expect(await dropped.transport.change("shop", { set: [["A", VALUE]], remove: [] })).toMatchObject({ ok: false, failure: { error: "unconfirmed" } });
    const refused = api(() => {
      throw Object.assign(new Error("refused"), { code: "ConnectionRefused" });
    });
    expect(await refused.transport.change("shop", { set: [["A", VALUE]], remove: [] })).toMatchObject({ ok: false, failure: { error: "unreachable" } });
    const proxied = api(() => new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(await proxied.transport.generate("shop", { name: "A" })).toMatchObject({ ok: false, failure: { error: "unconfirmed" } });
  });
});

// --- the listing --------------------------------------------------------------------------

describe("the listing", () => {
  test("names, whether the store holds each, the files and their path, the build's names: never a value", () => {
    const lines = storeLines(
      view({
        variables: [
          { name: "ADMIN_TOKEN", source: "store", declared: true },
          { name: "STRIPE_SECRET_KEY", source: "store", declared: true },
          { name: "SMTP_URL", source: "store", declared: false },
          { name: "STRIPE_WEBHOOK_SECRET", source: "none", declared: true },
        ],
        missing: ["STRIPE_WEBHOOK_SECRET"],
        files: [
          { name: "gcp.json", state: "set", declared: true, reason: null, bytes: 2048, modifiedAt: 1, restartPending: false },
          { name: "tls.key", state: "missing", declared: true, reason: null, bytes: null, modifiedAt: null, restartPending: false },
        ],
        build: ["CMS_TOKEN"],
        public: [{ name: "PUBLIC_URL", value: "https://shop.test-zone.invalid" }],
        restartPending: true,
      }),
    );
    expect(lines).toEqual([
      "   ADMIN_TOKEN             set",
      "   STRIPE_SECRET_KEY       set",
      "   SMTP_URL                set, not declared in sitesolide.json",
      "   STRIPE_WEBHOOK_SECRET   missing: sitesolide secrets set STRIPE_WEBHOOK_SECRET",
      "   files, read at $CREDENTIALS_DIRECTORY/files_<name>: gcp.json set (2048 bytes), tls.key missing (sitesolide secrets set-file tls.key < tls.key)",
      "   build, kept by whoever deploys: CMS_TOKEN",
      "   public, from sitesolide.json's env: PUBLIC_URL",
      "   restart pending: sitesolide secrets ... --restart, or the dashboard's Restart service",
      "   a value is never shown here",
    ]);
    // The public value is the repository's, yet the listing names it only.
    expect(lines.join("\n")).not.toContain("https://shop.test-zone.invalid");
  });

  test("a store the service does not read yet, or one not managed, says so first", () => {
    const lines = storeLines(view({ unitReadsStore: false, state: "unmanaged", reason: "env is owned by site-shop" }));
    expect(lines[0]).toContain("the store is not managed by the dashboard: env is owned by site-shop");
    expect(lines[1]).toContain("sitesolide refresh shop");
    expect(lines).toContain("   no variable yet: sitesolide secrets set NAME, or sitesolide secrets generate NAME");
  });
});

// --- deploy's missing names ------------------------------------------------------------------

/** A transport recording its changes, answering each as the steward would. */
function recordingTransport(over: Partial<StoreTransport> = {}) {
  const calls: { what: string; slug: string; detail: unknown }[] = [];
  const transport: StoreTransport = {
    via: "over SSH, as the owner",
    owner: true,
    list: async () => ({ ok: true, value: view() }),
    change: async (slug, asked) => {
      calls.push({ what: "change", slug, detail: asked });
      return { ok: true, value: change({ set: asked.set.map(([name]) => name), removed: asked.remove }) };
    },
    generate: async (slug, request) => {
      calls.push({ what: "generate", slug, detail: request });
      return { ok: true, value: change({ generated: [request.name] }) };
    },
    setFile: async (slug, name, content) => {
      calls.push({ what: "set-file", slug, detail: { name, content: new TextDecoder().decode(content) } });
      return { ok: true, value: change({ files: { set: [name], removed: [] } }) };
    },
    removeFile: async (slug, name) => {
      calls.push({ what: "remove-file", slug, detail: name });
      return { ok: true, value: change({ files: { set: [], removed: [name] } }) };
    },
    restart: async (slug) => {
      calls.push({ what: "restart", slug, detail: null });
      return { ok: true, value: { verdict: { kind: "active", state: "active", subState: "running", restarts: 0 } } };
    },
    ...over,
  };
  return { calls, transport };
}

/** A terminal answering each question in turn, and the typed values in turn. */
function terminal(answers: (string | null)[], typed: (string | null | { refused: string })[] = [], over: Partial<MissingIo> = {}) {
  const asked: string[] = [];
  const said: string[] = [];
  const warned: { message: string; details: string[] }[] = [];
  const io: MissingIo = {
    terminal: true,
    json: false,
    ask: async (question) => {
      asked.push(question);
      return answers.shift() ?? null;
    },
    secret: async (question) => {
      asked.push(question);
      return typed.shift() ?? null;
    },
    say: (line) => said.push(line),
    warn: (message, details) => warned.push({ message, details }),
    ...over,
  };
  return { io, asked, said, warned };
}

describe("the missing names of deploy", () => {
  const declared = (secrets: object): ReturnType<typeof secretsOf> => secretsOf({ slug: "shop", start: "/x", port: 3000, secrets } as Manifest);

  test("the local manifest's names, not the deployed one's: a name only the store supplies is not missing", () => {
    const listed = view({
      variables: [
        { name: "A", source: "store", declared: true },
        { name: "OLD", source: "none", declared: true },
      ],
      missing: ["OLD"],
      files: [
        { name: "gcp.json", state: "set", declared: false, reason: null, bytes: null, modifiedAt: null, restartPending: false },
        { name: "gone.pem", state: "missing", declared: true, reason: null, bytes: null, modifiedAt: null, restartPending: false },
      ],
    });
    const local = withDeclared(listed, declared({ runtime: ["A", "B", "C"], files: ["gcp.json", "tls.key"] }));
    // OLD the deployed manifest declared, this one does not: not missing any more.
    expect(missingOf(local)).toEqual({ runtime: ["B", "C"], files: ["tls.key"] });
    expect(missingOf(withDeclared(listed, declared(["A", "B"]))).runtime).toEqual(["B"]);
    expect(local.files.find((file) => file.name === "gcp.json")?.declared).toBe(true);
    expect(local.files.some((file) => file.name === "gone.pem")).toBe(false);
  });

  test("at a terminal: set, typed without echo, then sent; generate, drawn on the server; leave; no restart asked", async () => {
    const { calls, transport } = recordingTransport();
    const { io, asked, said } = terminal(["s", "g", "l"], [VALUE]);
    const left = await handleMissing(view({ missing: ["API_KEY", "SESSION_SECRET", "LATER"] }), transport, io);
    expect(left).toEqual({ runtime: ["LATER"], files: [] });
    expect(asked).toEqual([
      "API_KEY is not set on the server. [s]et it now (typed, not shown), [g]enerate a random value on the server, or [l]eave it unset? ",
      "API_KEY (no echo): ",
      "SESSION_SECRET is not set on the server. [s]et it now (typed, not shown), [g]enerate a random value on the server, or [l]eave it unset? ",
      "LATER is not set on the server. [s]et it now (typed, not shown), [g]enerate a random value on the server, or [l]eave it unset? ",
    ]);
    expect(calls).toEqual([
      { what: "change", slug: "shop", detail: { set: [["API_KEY", VALUE]], remove: [] } },
      { what: "generate", slug: "shop", detail: { name: "SESSION_SECRET", format: "hex", bytes: 32 } },
    ]);
    expect(said.join("\n")).not.toContain(VALUE);
  });

  test("a file is never prompted for: one line says how to set it", async () => {
    const { calls, transport } = recordingTransport();
    const { io, asked, said } = terminal([]);
    const left = await handleMissing(view({ files: [{ name: "tls.key", state: "missing", declared: true, reason: null, bytes: null, modifiedAt: null, restartPending: false }] }), transport, io);
    expect(left).toEqual({ runtime: [], files: ["tls.key"] });
    expect(asked).toEqual([]);
    expect(calls).toEqual([]);
    expect(said).toEqual(["   the file tls.key is not set on the server: sitesolide secrets set-file tls.key < path"]);
  });

  test("an answer it does not read is asked again, then left; nothing typed, a refused key or a value the steward would refuse is left too, nothing sent", async () => {
    const { calls, transport } = recordingTransport();
    const { io, said } = terminal(["x", "y", "z", "s", "s", "s"], [null, { refused: "Tab was typed at the prompt" }, "two\nlines"]);
    const left = await handleMissing(view({ missing: ["A", "B", "C", "D"] }), transport, io);
    expect(left.runtime).toEqual(["A", "B", "C", "D"]);
    expect(calls).toEqual([]);
    expect(said).toEqual([
      "   A left unset",
      "   B left unset: nothing typed",
      "   !! C left unset: Tab was typed at the prompt",
      "   !! D left unset: the value must fit on one line",
    ]);
  });

  test("a refusal that would quote the value typed is withheld", async () => {
    const { transport } = recordingTransport({ change: async () => ({ ok: false, failure: { error: "invalid", message: `refused: ${VALUE}` } }) });
    const { io, said } = terminal(["s"], [VALUE]);
    const left = await handleMissing(view({ missing: ["A"] }), transport, io);
    expect(left.runtime).toEqual(["A"]);
    expect(said.join("\n")).not.toContain(VALUE);
    expect(said.join("\n")).toContain("withheld");
  });

  test("without a terminal, or under --json: one warning with the commands, nothing asked, nothing sent", async () => {
    for (const over of [{ terminal: false }, { json: true }]) {
      const { calls, transport } = recordingTransport();
      const { io, asked, warned } = terminal(["s"], [VALUE], over);
      const left = await handleMissing(view({ missing: ["A", "B"], files: [{ name: "tls.key", state: "missing", declared: true, reason: null, bytes: null, modifiedAt: null, restartPending: false }] }), transport, io);
      expect(left).toEqual({ runtime: ["A", "B"], files: ["tls.key"] });
      expect(asked).toEqual([]);
      expect(calls).toEqual([]);
      expect(warned).toEqual([missingWarning({ runtime: ["A", "B"], files: ["tls.key"] })]);
    }
    expect(missingWarning({ runtime: ["A"], files: [] })).toEqual({
      message: "runtime secrets not set on the server: A",
      details: ["sitesolide secrets set A, or sitesolide secrets generate A (a random key, drawn on the server)", "the deployment goes on: a service that cannot live without one stops at start, and says so in its log"],
    });
  });

  test("nothing missing: nothing said, nothing asked", async () => {
    const { io, asked, said, warned } = terminal([]);
    expect(await handleMissing(view(), recordingTransport().transport, io)).toEqual({ runtime: [], files: [] });
    expect([asked, said, warned]).toEqual([[], [], []]);
  });
});

// --- the commands ---------------------------------------------------------------------------

function dependencies(output: Output, over: Partial<StoreDependencies> = {}): StoreDependencies {
  return {
    output,
    json: false,
    terminal: () => false,
    stdin: async () => new TextEncoder().encode(`${VALUE}\n`),
    secretPrompt: async () => VALUE,
    ...over,
  };
}

describe("the commands", () => {
  const run = async (ask: StoreAsk, transport: StoreTransport, over: Partial<StoreDependencies> = {}) => {
    const record = recording();
    const code = await runStore(ask, "shop", transport, dependencies(record.output, over));
    return { code, ...record };
  };

  test("set from a pipe: one trailing line break dropped, the value sent and never printed", async () => {
    const { calls, transport } = recordingTransport();
    const r = await run({ action: "set", name: "API_KEY", stdin: true, restart: false }, transport);
    expect(r.code).toBe(0);
    expect(calls).toEqual([{ what: "change", slug: "shop", detail: { set: [["API_KEY", VALUE]], remove: [] } }]);
    expect(r.lines.join("\n")).not.toContain(VALUE);
    expect(r.results).toEqual([{ command: "secrets", action: "set", slug: "shop", created: false, set: ["API_KEY"], generated: [], removed: [], absent: [], files: { set: [], removed: [] }, restart: null }]);
  });

  test("set over a store a token's write made: what the steward moved aside first is said and handed on, names only", async () => {
    const takenBack = { slug: "shop", variables: ["DATABASE_URL"], files: ["signing.pem"] };
    const { transport } = recordingTransport({ change: async () => ({ ok: true, value: change({ set: ["API_KEY"], takenBack }) }) });
    const r = await run({ action: "set", name: "API_KEY", stdin: true, restart: false }, transport);
    expect(r.code).toBe(0);
    expect(r.lines).toContain("   !! shop's store held what a token set there: moved aside, no longer set: DATABASE_URL, the file signing.pem");
    expect(r.lines.join("\n")).toContain("set what the project needs yourself");
    expect(r.results).toEqual([expect.objectContaining({ action: "set", set: ["API_KEY"], takenBack })]);
  });

  test("set at a terminal prompts without echo; --stdin there, no terminal without --stdin, an empty value or one the steward refuses: nothing sent", async () => {
    const prompted = recordingTransport();
    const asked: string[] = [];
    const r = await run({ action: "set", name: "API_KEY", stdin: false, restart: false }, prompted.transport, { terminal: () => true, secretPrompt: async (question) => (asked.push(question), VALUE) });
    expect(r.code).toBe(0);
    expect(asked).toEqual(["API_KEY for shop's store (no echo): "]);
    expect(prompted.calls).toHaveLength(1);

    const cases: [Partial<StoreDependencies>, boolean, string][] = [
      [{ terminal: () => true }, true, "stdin-is-terminal"],
      [{ terminal: () => false }, false, "needs-stdin"],
      [{ stdin: async () => new TextEncoder().encode("\n") }, true, "invalid"],
      [{ stdin: async () => new TextEncoder().encode(`${VALUE}\nsecond line`) }, true, "invalid"],
      [{ stdin: async () => new Uint8Array([0xff, 0xfe]) }, true, "invalid"],
      [{ terminal: () => true, secretPrompt: async () => null }, false, "cancelled"],
      [{ terminal: () => true, secretPrompt: async () => ({ refused: "an arrow key" }) }, false, "invalid"],
    ];
    for (const [over, stdin, code] of cases) {
      const { calls, transport } = recordingTransport();
      const refused = await run({ action: "set", name: "API_KEY", stdin, restart: false }, transport, over);
      expect({ code: refused.code, error: refused.failures[0]?.error }).toEqual({ code: 1, error: code });
      expect(calls).toEqual([]);
      expect(refused.lines.join("\n")).not.toContain(VALUE);
    }
  });

  test("a refusal that would quote the value sent is withheld", async () => {
    const { transport } = recordingTransport({ change: async () => ({ ok: false, failure: { error: "invalid", message: `API_KEY: ${VALUE} is refused`, details: [VALUE] } }) });
    const r = await run({ action: "set", name: "API_KEY", stdin: true, restart: false }, transport);
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).not.toContain(VALUE);
    expect(withheld({ error: "invalid", message: "fine" }, [VALUE])).toEqual({ error: "invalid", message: "fine" });
  });

  test("--restart: the change, then the restart; a service that does not hold fails the run, the change said written", async () => {
    const held = recordingTransport();
    const ok = await run({ action: "generate", name: "SESSION", format: "hex", bytes: 32, replace: false, restart: true }, held.transport);
    expect(ok.code).toBe(0);
    expect(held.calls.map(({ what }) => what)).toEqual(["generate", "restart"]);
    expect(ok.results[0]).toMatchObject({ action: "generate", generated: ["SESSION"], restart: { kind: "active" } });
    const failing = recordingTransport({ restart: async () => ({ ok: true, value: { verdict: { kind: "failure", state: "failed", subState: "failed", restarts: 3 } } }) });
    const fell = await run({ action: "remove", names: ["A"], restart: true }, failing.transport);
    expect(fell.code).toBe(1);
    expect(fell.failures[0]).toMatchObject({ error: "restart-failed" });
    expect(fell.failures[0]!.details).toContain("the change is written");
  });

  test("generate without --replace sends none, with it sends one; the value is never in the answer", async () => {
    const { calls, transport } = recordingTransport();
    await run({ action: "generate", name: "A", format: "base64url", bytes: 16, replace: false, restart: false }, transport);
    await run({ action: "generate", name: "A", format: "hex", bytes: 32, replace: true, restart: false }, transport);
    expect(calls.map(({ detail }) => detail)).toEqual([
      { name: "A", format: "base64url", bytes: 16 },
      { name: "A", format: "hex", bytes: 32, replace: true },
    ]);
  });

  test("set-file reads standard input as bytes: never a terminal, never empty, 64 KiB at most", async () => {
    const { calls, transport } = recordingTransport();
    const ok = await run({ action: "set-file", name: "gcp.json", restart: false }, transport, { stdin: async () => new TextEncoder().encode('{"k":1}') });
    expect(ok.code).toBe(0);
    expect(calls).toEqual([{ what: "set-file", slug: "shop", detail: { name: "gcp.json", content: '{"k":1}' } }]);
    expect(ok.lines).toContain("   file set: gcp.json, read at $CREDENTIALS_DIRECTORY/files_gcp.json");
    for (const [over, code] of [
      [{ terminal: () => true }, "stdin-is-terminal"],
      [{ stdin: async () => new Uint8Array() }, "invalid"],
      [{ stdin: async () => new Uint8Array(64 * 1024 + 1) }, "invalid"],
    ] as const) {
      const refused = recordingTransport();
      const r = await run({ action: "set-file", name: "gcp.json", restart: false }, refused.transport, over);
      expect({ code: r.code, error: r.failures[0]?.error }).toEqual({ code: 1, error: code });
      expect(refused.calls).toEqual([]);
    }
  });

  test("a static site and the dashboard have no store, each said why", () => {
    expect(storelessRefusal({ slug: "blog", publicDir: "dist" } as Manifest).message).toContain("a static site");
    expect(storelessRefusal({ slug: "dashboard", start: "/x", port: 3000 } as Manifest).message).toContain("dashboard.env");
  });
});

describe("a restart's verdict", () => {
  test("it says why the service did not come back when the steward can tell", () => {
    const failed = { kind: "looping" as const, state: "activating", subState: "auto-restart", restarts: 4 };
    expect(verdictWords(failed)).toBe("activating, auto-restart, 4 restart(s) by systemd: the service restarts in a loop");
    const reason = "shop.service could not load its secret files (243/CREDENTIALS): the store's files folder is missing, or its files are too large; sitesolide refresh shop lays the folder again";
    expect(verdictWords({ ...failed, reason })).toBe(`activating, auto-restart, 4 restart(s) by systemd: the service restarts in a loop; ${reason}`);
  });
});

describe("a token's store taken back by the owner's write", () => {
  test("a change's takenBack is read, names only; one of another shape makes the answer unreadable; none is none", async () => {
    const answered = (body: object) => machine(() => ({ code: 0, output: `${JSON.stringify(body)}\n200\n` })).transport.change("shop", { set: [["API_KEY", VALUE]], remove: [] });
    const base = { store: view(), created: false, set: ["API_KEY"], generated: [], removed: [], absent: [], files: { set: [], removed: [] } };
    const takenBack = { slug: "shop", variables: ["DATABASE_URL"], files: [] };
    expect(await answered({ ...base, takenBack })).toMatchObject({ ok: true, value: { takenBack } });
    expect(await answered(base)).toMatchObject({ ok: true, value: { set: ["API_KEY"] } });
    expect(((await answered(base)) as { value: object }).value).not.toHaveProperty("takenBack");
    expect((await answered({ ...base, takenBack: { slug: "shop", variables: "DATABASE_URL" } })).ok).toBe(false);
  });

  test("the warning names what was moved aside, and says when it held nothing", () => {
    expect(takenBackWarning("shop", "token ci (tok_1)", { variables: ["A", "B"], files: ["key.pem"] })).toEqual({
      message: "shop's store held what token ci (tok_1) set there: moved aside, no longer set: A, B, the file key.pem",
      details: [
        "kept as the store's previous versions, never read by the service again unless restored",
        "set what the project needs yourself: sitesolide secrets set NAME, or set-file NAME < path for a file",
      ],
    });
    expect(takenBackWarning("shop", "a token", { variables: [], files: [] }).message).toBe("shop's store was made by a token: taken back, it held no value");
  });

  test("deploy's prompts: a write that took a token's store back is warned of, then the next name asked", async () => {
    const takenBack = { slug: "shop", variables: ["DATABASE_URL"], files: [] };
    const { transport } = recordingTransport({ generate: async (_slug, request) => ({ ok: true, value: change({ generated: [request.name], takenBack }) }) });
    const { io, warned, said } = terminal(["g", "l"]);
    const left = await handleMissing(view({ missing: ["SESSION_SECRET", "LATER"] }), transport, io);
    expect(left.runtime).toEqual(["LATER"]);
    expect(said).toContain("   SESSION_SECRET generated on the server, never shown");
    expect(warned).toEqual([expect.objectContaining({ message: "shop's store held what a token set there: moved aside, no longer set: DATABASE_URL" })]);
  });
});
