import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { backupFolder } from "../src/gatekeeper/instance";
import { holderText, STALE_LOCK_MS, type Release, type LockResult } from "../src/gatekeeper/machine";
import { MAX_BODY, createMachine, redact, type MachineConfig, type Execution } from "../src/gatekeeper/real";

/**
 * The real machine on a throwaway tree, with no Caddy: Caddy's lock, the writes
 * that keep owner and mode, the reads that refuse a link, the backups that
 * block the next action, the probe in front of a site that answers with a body
 * that never ends.
 */
const D = mkdtempSync(join(tmpdir(), "gatekeeper-real-"));
afterAll(() => rmSync(D, { recursive: true, force: true }));

let number = 0;
function mount(systemctl?: (arguments_: string[]) => Execution, log: string[] = []) {
  const root = join(D, String(++number));
  mkdirSync(join(root, "srv", "sample"), { recursive: true });
  mkdirSync(join(root, "sites"), { recursive: true });
  const config: MachineConfig = {
    sitesDir: join(root, "srv"),
    blocksFolder: join(root, "sites"),
    caddyfile: join(root, "Caddyfile"),
    caddyEnvFile: join(root, "cloudflare.env"),
    zoneEnvFile: join(root, "sitesolide.env"),
    caddy: "/nonexistent/caddy",
    runFolder: join(root, "run"),
    blockOwner: null,
    probeConfig: { address: "127.0.0.1", port: 9, ca: null },
    caddyUnit: "caddy.service",
    collectorUnit: "sitesolide-collector.service",
    systemctl: async (arguments_) => systemctl?.(arguments_) ?? { code: 1, stdout: "", stderr: "" },
    log: (line) => log.push(line),
  };
  return { root, config, machine: createMachine(config), log };
}

function release(lockResult: LockResult): Release {
  if (lockResult.kind !== "taken") throw new Error(`lock held by ${lockResult.who}`);
  return lockResult.release;
}

/** Sets a lock the way a workstation tool does: `mkdir`, then the holder. */
function setLock(runFolder: string, holder: string | null, ageMs = 0): string {
  const folder = join(runFolder, "caddy.lock");
  mkdirSync(folder, { recursive: true });
  if (holder !== null) writeFileSync(join(folder, "holder"), holder);
  if (ageMs > 0) {
    const date = new Date(Date.now() - ageMs);
    utimesSync(folder, date, date);
  }
  return folder;
}

describe("Caddy's lock", () => {
  test("taken: a caddy.lock directory and its holder `gatekeeper <pid> <ms>`", async () => {
    const { machine, config } = mount();
    const before = Date.now();
    const lockResult = await machine.takeLock();
    expect(lockResult.kind).toBe("taken");
    const folder = join(config.runFolder, "caddy.lock");
    expect(statSync(folder).isDirectory()).toBe(true);
    expect(readdirSync(folder)).toEqual(["holder"]);
    const [who, pid, a] = readFileSync(join(folder, "holder"), "utf8").trimEnd().split(" ");
    expect(who).toBe("gatekeeper");
    expect(Number(pid)).toBe(process.pid);
    expect(Number(a)).toBeGreaterThanOrEqual(before);
    expect(Number(a)).toBeLessThanOrEqual(Date.now());
    release(lockResult)();
  });

  test("released: the directory disappears, and the next one takes it", async () => {
    const { machine, config } = mount();
    const premier = await machine.takeLock();
    expect(await machine.takeLock()).toMatchObject({ kind: "held", who: "gatekeeper" });
    release(premier)();
    expect(existsSync(join(config.runFolder, "caddy.lock"))).toBe(false);
    const second = await machine.takeLock();
    expect(second.kind).toBe("taken");
    release(second)();
    expect(readdirSync(config.runFolder)).toEqual([]);
  });

  test("held by a workstation tool: refused, with who and since when, and left in place", async () => {
    const { machine, config } = mount();
    const since = Date.now() - 90_000;
    const folder = setLock(config.runFolder, holderText({ who: "deploy-caddy", pid: 4242, a: since }), 1000);
    expect(await machine.takeLock()).toEqual({ kind: "held", who: "deploy-caddy", since });
    expect(readFileSync(join(folder, "holder"), "utf8")).toBe(`deploy-caddy 4242 ${since}\n`);
  });

  test("stale for more than fifteen minutes: taken over, and the takeover journalled", async () => {
    const { machine, config, log } = mount();
    const old = Date.now() - STALE_LOCK_MS - 60_000;
    setLock(config.runFolder, holderText({ who: "lock", pid: 4242, a: old }), STALE_LOCK_MS + 60_000);
    const lockResult = await machine.takeLock();
    expect(lockResult.kind).toBe("taken");
    expect(readFileSync(join(config.runFolder, "caddy.lock", "holder"), "utf8")).toStartWith(`gatekeeper ${process.pid} `);
    expect(log).toEqual([
      `gatekeeper: stale Caddy lock of lock 4242 since ${new Date(old).toISOString()} taken over (older than 15 minutes)`,
    ]);
    release(lockResult)();
    // No lock and no set-aside directory left behind.
    expect(readdirSync(config.runFolder)).toEqual([]);
  });

  test("holder unreadable or not yet written: held, not free", async () => {
    const { machine, config } = mount();
    setLock(config.runFolder, null);
    expect(await machine.takeLock()).toMatchObject({ kind: "held", who: null });
    writeFileSync(join(config.runFolder, "caddy.lock", "holder"), "{garbage");
    expect(await machine.takeLock()).toMatchObject({ kind: "held", who: null });
    // A link in place of the holder is not followed, and frees nothing either.
    rmSync(join(config.runFolder, "caddy.lock", "holder"));
    symlinkSync("/etc/hosts", join(config.runFolder, "caddy.lock", "holder"));
    expect(await machine.takeLock()).toMatchObject({ kind: "held", who: null });
  });

  test("holder unreadable but directory stale: taken over", async () => {
    const { machine, config, log } = mount();
    setLock(config.runFolder, "{garbage", STALE_LOCK_MS + 60_000);
    const lockResult = await machine.takeLock();
    expect(lockResult.kind).toBe("taken");
    expect(log[0]).toContain("stale Caddy lock of an unreadable holder");
    release(lockResult)();
  });

  test("a gatekeeper that died without releasing the lock: taken over at once", async () => {
    const { machine, config, log } = mount();
    // A pid that does not exist: beyond pid_max on Linux as on macOS.
    setLock(config.runFolder, holderText({ who: "gatekeeper", pid: 99_999_999, a: Date.now() }));
    const lockResult = await machine.takeLock();
    expect(lockResult.kind).toBe("taken");
    expect(log[0]).toContain("(gatekeeper 99999999 is gone)");
    release(lockResult)();
  });

  test("releasing does not remove someone else's lock", async () => {
    const { machine, config, log } = mount();
    const lockResult = await machine.takeLock();
    const other = holderText({ who: "deploy", pid: 7, a: Date.now() });
    writeFileSync(join(config.runFolder, "caddy.lock", "holder"), other);
    release(lockResult)();
    expect(readFileSync(join(config.runFolder, "caddy.lock", "holder"), "utf8")).toBe(other);
    expect(log).toContain("gatekeeper: the Caddy lock was taken over by another, left in place");
  });
});

describe("reads and writes", () => {
  test("the rewritten manifest keeps its mode and its owner, with no temporary file left", async () => {
    const { machine, config } = mount();
    const path = join(config.sitesDir, "sample", "sitesolide.json");
    writeFileSync(path, '{"slug":"sample"}\n');
    chmodSync(path, 0o640);
    const parsed = (await machine.readManifest("sample"))!;
    expect(parsed.permissions.mode).toBe(0o640);
    await machine.writeManifest("sample", '{"slug":"sample","portal":true}\n', parsed.permissions);
    expect(readFileSync(path, "utf8")).toBe('{"slug":"sample","portal":true}\n');
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(statSync(path).uid).toBe(parsed.permissions.uid);
    expect(readdirSync(join(config.sitesDir, "sample"))).toEqual(["sitesolide.json"]);
  });

  test("a block is written 0644 and removed; missing, it reads as null", async () => {
    const { machine, config } = mount();
    expect(await machine.readBlock("sample")).toBeNull();
    await machine.writeBlock("sample", "sample.test-zone.invalid {\n}\n");
    expect(statSync(join(config.blocksFolder, "sample.caddy")).mode & 0o777).toBe(0o644);
    expect(await machine.readBlock("sample")).toBe("sample.test-zone.invalid {\n}\n");
    await machine.removeBlock("sample");
    await machine.removeBlock("sample");
    expect(readdirSync(config.blocksFolder)).toEqual([]);
  });

  test("a symbolic link is never read nor followed", async () => {
    const { machine, config, root } = mount();
    writeFileSync(join(root, "elsewhere.json"), '{"slug":"sample"}');
    symlinkSync(join(root, "elsewhere.json"), join(config.sitesDir, "sample", "sitesolide.json"));
    await expect(machine.readManifest("sample")).rejects.toThrow("symbolic link");
    symlinkSync(join(root, "elsewhere.json"), join(config.blocksFolder, "sample.caddy"));
    await expect(machine.readBlock("sample")).rejects.toThrow("symbolic link");
    // Nor is a site directory replaced by a link.
    symlinkSync(join(config.sitesDir, "sample"), join(config.sitesDir, "detour"));
    await expect(machine.readManifest("detour")).rejects.toThrow("not a plain directory");
    await expect(machine.writeManifest("detour", "{}", { uid: 0, gid: 0, mode: 0o644 })).rejects.toThrow();
  });

  test("a slug out of rule never becomes a path", async () => {
    const { machine } = mount();
    await expect(machine.readManifest("../etc")).rejects.toThrow("invalid slug");
    await expect(machine.writeBlock("../../passwd", "x")).rejects.toThrow("invalid slug");
    await expect(machine.saveBackup("a/b", { manifest: { text: "", permissions: { uid: 0, gid: 0, mode: 0 } }, block: null })).rejects.toThrow();
  });
});

describe("backups", () => {
  test("a backup left behind flags an interrupted transaction, until it is erased", async () => {
    const { machine, config } = mount();
    expect(await machine.interruptedTransaction()).toBeNull();
    await machine.saveBackup("sample", {
      manifest: { text: '{"slug":"sample"}\n', permissions: { uid: 1, gid: 1, mode: 0o644 } },
      block: null,
    });
    expect(await machine.interruptedTransaction()).toBe("sample");
    // The path the steward reads back to report the unknown state.
    const folder = backupFolder("sample", config.runFolder);
    expect(folder).toBe(join(config.runFolder, "sauvegardes", "sample"));
    expect(readdirSync(folder).sort()).toEqual(["permissions.json", "sample.caddy.absent", "sitesolide.json"]);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(folder, "sitesolide.json")).mode & 0o777).toBe(0o600);
    await machine.clearBackup("sample");
    expect(await machine.interruptedTransaction()).toBeNull();
  });
});

describe("served sites and commands", () => {
  test("a non-empty public/, or an active service", async () => {
    const { machine, config } = mount((arguments_) => ({
      code: 3,
      stdout: `${arguments_.slice(1).map((u) => (u === "api.service" ? "active" : "inactive")).join("\n")}\n`,
      stderr: "",
    }));
    mkdirSync(join(config.sitesDir, "showcase", "public"), { recursive: true });
    writeFileSync(join(config.sitesDir, "showcase", "public", "index.html"), "x");
    mkdirSync(join(config.sitesDir, "empty", "public"), { recursive: true });
    mkdirSync(join(config.sitesDir, "api"), { recursive: true });
    mkdirSync(join(config.sitesDir, "test-zone.invalid", "public"), { recursive: true });
    writeFileSync(join(config.sitesDir, "test-zone.invalid", "public", "index.html"), "x");
    expect(await machine.servedSites(1000)).toEqual(["api", "showcase"]);
  });

  test("with no readable cloudflare.env, validation fails without running Caddy", async () => {
    const { machine, config } = mount();
    const verdict = await machine.validateCaddy(1000);
    expect(verdict).toEqual({ ok: false, output: `Error: ${config.caddyEnvFile} is missing` });
    writeFileSync(config.caddyEnvFile, "export CLOUDFLARE_API_TOKEN=secret-not-to-be-quoted\n");
    const refuse = await machine.validateCaddy(1000);
    expect(refuse.ok).toBe(false);
    expect(refuse.output).not.toContain("secret-not-to-be-quoted");
  });

  test("with no zone variables, validation fails and says so", async () => {
    // The Caddyfile and the fragments name no machine: without that file,
    // `caddy validate` would refuse empty addresses, and the message would
    // send you looking for a configuration error that does not exist.
    const { machine, config } = mount();
    writeFileSync(config.caddyEnvFile, "CLOUDFLARE_API_TOKEN=abcd1234\n");
    const verdict = await machine.validateCaddy(1000);
    expect(verdict).toEqual({ ok: false, output: `Error: ${config.zoneEnvFile} is missing` });
  });

  test("a missing binary yields a failure, never an exception", async () => {
    const { machine, config } = mount();
    writeFileSync(config.caddyEnvFile, "CLOUDFLARE_API_TOKEN=abcd1234\n");
    writeFileSync(config.zoneEnvFile, "SITESOLIDE_ZONE=test-zone.invalid\n");
    const verdict = await machine.validateCaddy(1000);
    expect(verdict.ok).toBe(false);
    expect(verdict.output).toContain("cannot run");
  });

  test("redact removes every value, and leaves the too short ones", () => {
    expect(redact("a token-1 b token-1 c", ["token-1"])).toBe("a [redacted] b [redacted] c");
    expect(redact("abc", ["b"])).toBe("abc");
  });
});

/**
 * The probe in front of a compromised site. A real HTTPS server, certificate
 * drawn by a test authority, and bodies that never end: the probe has to yield
 * the code after at most `MAX_BODY` bytes, close the connection, decompress
 * nothing, and keep its timeout.
 */
const OPENSSL = Bun.which("openssl");

describe.skipIf(OPENSSL === null)("the probe reads at most MAX_BODY bytes", () => {
  const T = mkdtempSync(join(tmpdir(), "gatekeeper-probe-"));
  const HOST = "sample.test-zone.invalid";
  let server: ReturnType<typeof Bun.serve>;
  let ca = "";
  /** Per path: bytes put into the stream, stream cancelled, Accept-Encoding received. */
  const seen = new Map<string, { sent: number; cancelled: boolean; encoding: string | null }>();
  // 64 MiB of zeros, 64 KiB once compressed.
  const bomb = gzipSync(new Uint8Array(64 * 1024 * 1024));

  function openssl(...arguments_: string[]): void {
    const output = Bun.spawnSync([OPENSSL!, ...arguments_], { cwd: T, stdout: "ignore", stderr: "pipe" });
    if (output.exitCode !== 0) throw new Error(`openssl ${arguments_[0]}: ${output.stderr.toString()}`);
  }

  function probeMachine() {
    const { config } = mount();
    return createMachine({ ...config, probeConfig: { address: "127.0.0.1", port: server.port!, ca } });
  }

  beforeAll(() => {
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2",
      "-subj", "/CN=Probe sample", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign");
    openssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "site.key", "-out", "site.csr", "-subj", "/CN=test-zone.invalid");
    writeFileSync(join(T, "site.ext"), "subjectAltName=DNS:*.test-zone.invalid\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n");
    openssl("x509", "-req", "-in", "site.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "site.pem",
      "-days", "2", "-extfile", "site.ext");
    ca = readFileSync(join(T, "ca.pem"), "utf8");

    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { cert: readFileSync(join(T, "site.pem"), "utf8"), key: readFileSync(join(T, "site.key"), "utf8") },
      fetch(req) {
        const path = new URL(req.url).pathname;
        const trace = { sent: 0, cancelled: false, encoding: req.headers.get("accept-encoding") };
        seen.set(path, trace);
        if (path === "/bomb") {
          return new Response(bomb, { headers: { "Content-Encoding": "gzip", "X-Portal": "connexion" }, status: 401 });
        }
        // /slow: 1 KiB every 20 ms, endlessly. /fast: 1 MiB at once,
        // endlessly. /mute: the headers, then nothing more.
        const chunk = path === "/fast" ? 1024 * 1024 : 1024;
        return new Response(
          new ReadableStream({
            async pull(controller) {
              if (path === "/mute") {
                await Bun.sleep(60_000);
                return;
              }
              await Bun.sleep(path === "/slow" ? 20 : 1);
              controller.enqueue(new Uint8Array(chunk).fill(0x61));
              trace.sent += chunk;
            },
            cancel() {
              trace.cancelled = true;
            },
          }),
          { status: 401, headers: { "X-Portal": "connexion" } },
        );
      },
    });
  });

  afterAll(() => {
    server?.stop(true);
    rmSync(T, { recursive: true, force: true });
  });

  test("a slow and endless body: the code at once, 4 KiB read, the connection closed", async () => {
    const start = performance.now();
    const response = await probeMachine().probe(HOST, "/slow", 4000);
    const elapsed = performance.now() - start;
    expect(response).toEqual({ code: 401, door: true, body: "a".repeat(MAX_BODY) });
    // Four 1 KiB chunks at 20 ms: well before the 4 s timeout.
    expect(elapsed).toBeLessThan(2000);
    await Bun.sleep(300);
    const slow = seen.get("/slow")!;
    expect(slow.cancelled).toBe(true);
    const sent = slow.sent;
    await Bun.sleep(300);
    expect(seen.get("/slow")!.sent).toBe(sent);
  });

  test("a huge and fast body: memory does not follow the stream", async () => {
    const response = await probeMachine().probe(HOST, "/fast", 4000);
    expect(response).toMatchObject({ code: 401, door: true });
    expect("body" in response && response.body.length).toBe(MAX_BODY);
    await Bun.sleep(500);
    const fast = seen.get("/fast")!;
    expect(fast.cancelled).toBe(true);
    // What the kernel could buffer before the close, nothing more.
    expect(fast.sent).toBeLessThan(64 * 1024 * 1024);
  });

  test("Accept-Encoding: identity, and a compressed body is never decompressed", async () => {
    const response = await probeMachine().probe(HOST, "/bomb", 4000);
    expect(seen.get("/bomb")!.encoding).toBe("identity");
    expect(response).toMatchObject({ code: 401, door: true });
    // The gzip's raw bytes, not the zeros it contains.
    const body = "body" in response ? response.body : "";
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(body.charCodeAt(0)).toBe(0x1f);
  });

  test("the per-request timeout runs on the body too", async () => {
    const start = performance.now();
    const response = await probeMachine().probe(HOST, "/mute", 800);
    expect(response).toEqual({ error: "TimeoutError" });
    expect(performance.now() - start).toBeLessThan(3000);
  });
});
