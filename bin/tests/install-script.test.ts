import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { binaryName, TARGETS } from "../build";

/**
 * install.sh, the one line a README hands out, run as a reader runs it: by
 * sh, against a release served locally by Bun.serve, with `uname` faked to
 * stand for each system it must recognise. It installs into a temporary
 * folder, never into this machine's PATH.
 *
 * The release served is fake too: each "binary" is a shell script that says
 * which one it is, which is what tells the right one was picked.
 */

const SCRIPT = resolve(import.meta.dir, "..", "..", "install.sh");
const WORK = mkdtempSync(join(tmpdir(), "install-test-"));
const RELEASE = join(WORK, "release");
const FAKES = join(WORK, "fakes");
const NAMES = TARGETS.map(binaryName);
const requests: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let base = "";
/** What SHA256SUMS says, replaced by a test that wants a lie. */
let sums = "";

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function fake(name: string, body: string): void {
  writeFileSync(join(FAKES, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(FAKES, name), 0o755);
}

beforeAll(() => {
  mkdirSync(RELEASE, { recursive: true });
  mkdirSync(FAKES, { recursive: true });
  for (const name of NAMES) writeFileSync(join(RELEASE, name), `#!/bin/sh\necho "sitesolide ${name}"\n`);
  sums = NAMES.map((name) => `${sha256(readFileSync(join(RELEASE, name), "utf8"))}  ${name}\n`).join("");
  // The system and the processor install.sh reads, as each test sets them.
  fake("uname", 'case "$1" in -s) echo "$FAKE_OS" ;; -m) echo "$FAKE_ARCH" ;; *) exit 1 ;; esac');
  fake("sysctl", 'echo "${FAKE_TRANSLATED:-0}"');
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      const name = path.split("/").pop() ?? "";
      if (name === "SHA256SUMS") return new Response(sums);
      if (NAMES.includes(name)) return new Response(Bun.file(join(RELEASE, name)));
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}/releases/download/v9.9.9`;
});

afterAll(() => {
  server.stop(true);
  rmSync(WORK, { recursive: true, force: true });
});

let counter = 0;

/** Runs install.sh with `sh`, the system and processor given, into a folder of its own. */
async function install(os: string, arch: string, options: { env?: Record<string, string>; shell?: string; path?: string } = {}) {
  const home = join(WORK, `home-${counter++}`);
  mkdirSync(home, { recursive: true });
  const directory = join(home, "bin");
  const proc = Bun.spawn([options.shell ?? "/bin/sh", SCRIPT], {
    cwd: home,
    env: {
      HOME: home,
      PATH: options.path ?? `${FAKES}:/usr/bin:/bin`,
      FAKE_OS: os,
      FAKE_ARCH: arch,
      SITESOLIDE_DOWNLOAD_URL: base,
      SITESOLIDE_INSTALL_DIR: directory,
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  const installed = join(options.env?.SITESOLIDE_INSTALL_DIR ?? directory, "sitesolide");
  return { code, output, error, home, directory, installed };
}

describe("install.sh", () => {
  test("is POSIX sh: it runs under dash too, the /bin/sh of Debian and Ubuntu", async () => {
    for (const shell of ["/bin/sh", "/bin/dash"]) {
      if (!existsSync(shell)) continue;
      expect(Bun.spawnSync([shell, "-n", SCRIPT]).exitCode).toBe(0);
      const r = await install("Linux", "x86_64", { shell });
      expect({ shell, code: r.code, installed: existsSync(r.installed) }).toEqual({ shell, code: 0, installed: true });
    }
  });

  test("each system and processor gets its binary", async () => {
    const cases: [string, string, string, Record<string, string>?][] = [
      ["Darwin", "arm64", "sitesolide-darwin-arm64"],
      ["Darwin", "x86_64", "sitesolide-darwin-x64"],
      // A shell under Rosetta on Apple Silicon: the native binary.
      ["Darwin", "x86_64", "sitesolide-darwin-arm64", { FAKE_TRANSLATED: "1" }],
      ["Linux", "x86_64", "sitesolide-linux-x64"],
      ["Linux", "amd64", "sitesolide-linux-x64"],
      ["Linux", "aarch64", "sitesolide-linux-arm64"],
      ["Linux", "arm64", "sitesolide-linux-arm64"],
    ];
    for (const [os, arch, expected, env] of cases) {
      const r = await install(os, arch, { env });
      expect({ os, arch, code: r.code, error: r.error }).toMatchObject({ os, arch, code: 0 });
      expect(readFileSync(r.installed, "utf8")).toBe(readFileSync(join(RELEASE, expected), "utf8"));
      expect(statSync(r.installed).mode & 0o777).toBe(0o755);
      expect(r.output).toContain(`installed: ${r.installed} (sitesolide ${expected})`);
    }
  });

  test("a system or a processor no binary is built for is refused before anything is downloaded", async () => {
    for (const [os, arch, message] of [
      ["FreeBSD", "amd64", "no binary for FreeBSD"],
      ["MINGW64_NT-10.0", "x86_64", "no binary for MINGW64_NT-10.0"],
      ["Linux", "i686", "no binary for the i686 processor"],
      ["Linux", "riscv64", "no binary for the riscv64 processor"],
    ] as const) {
      const before = requests.length;
      const r = await install(os, arch);
      expect({ os, arch, code: r.code }).toEqual({ os, arch, code: 1 });
      expect(r.error).toContain(message);
      expect(existsSync(r.installed)).toBe(false);
      expect(requests.length).toBe(before);
    }
  });

  test("a download that does not match SHA256SUMS is refused, and an earlier binary stays", async () => {
    const honest = sums;
    try {
      const first = await install("Linux", "x86_64");
      expect(first.code).toBe(0);
      sums = sums.replace(sha256(readFileSync(join(RELEASE, "sitesolide-linux-x64"), "utf8")), "0".repeat(64));
      const r = await install("Linux", "x86_64", { env: { SITESOLIDE_INSTALL_DIR: first.directory } });
      expect(r.code).toBe(1);
      expect(r.error).toContain("does not match SHA256SUMS");
      expect(r.error).toContain("nothing was installed");
      expect(readFileSync(first.installed, "utf8")).toBe(readFileSync(join(RELEASE, "sitesolide-linux-x64"), "utf8"));
      // Nothing half written beside it either.
      expect(Bun.spawnSync(["ls", "-A", first.directory]).stdout.toString()).toBe("sitesolide\n");
    } finally {
      sums = honest;
    }
  });

  test("a binary SHA256SUMS does not list is refused", async () => {
    const honest = sums;
    try {
      sums = sums
        .split("\n")
        .filter((line) => !line.endsWith("sitesolide-linux-arm64"))
        .join("\n");
      const r = await install("Linux", "aarch64");
      expect(r.code).toBe(1);
      expect(r.error).toContain("SHA256SUMS lists no sitesolide-linux-arm64");
      expect(existsSync(r.installed)).toBe(false);
    } finally {
      sums = honest;
    }
  });

  test("~/.local/bin by default, and a word when it is not on the PATH", async () => {
    const r = await install("Darwin", "arm64", { env: { SITESOLIDE_INSTALL_DIR: "" } });
    expect(r.code).toBe(0);
    expect(existsSync(join(r.home, ".local", "bin", "sitesolide"))).toBe(true);
    expect(r.error).toContain(`${join(r.home, ".local", "bin")} is not on your PATH`);
    expect(r.error).toContain(`export PATH="${join(r.home, ".local", "bin")}:$PATH"`);
  });

  test("no word about the PATH when the folder is on it", async () => {
    const home = join(WORK, "on-path");
    const r = await install("Darwin", "arm64", { env: { SITESOLIDE_INSTALL_DIR: join(home, "bin") }, path: `${FAKES}:${join(home, "bin")}:/usr/bin:/bin` });
    expect(r.code).toBe(0);
    expect(r.error).not.toContain("is not on your PATH");
  });

  test("the latest release, or the one SITESOLIDE_VERSION names, from GitHub", async () => {
    // A curl that records where it was sent and fails, so that nothing leaves.
    const offline = join(WORK, "offline");
    mkdirSync(offline, { recursive: true });
    writeFileSync(join(offline, "curl"), `#!/bin/sh\nfor a in "$@"; do echo "$a"; done >> "${join(offline, "log")}"\nexit 22\n`);
    chmodSync(join(offline, "curl"), 0o755);
    const path = `${offline}:${FAKES}:/usr/bin:/bin`;
    const latest = await install("Linux", "x86_64", { env: { SITESOLIDE_DOWNLOAD_URL: "" }, path });
    expect(latest.code).toBe(1);
    expect(latest.error).toContain("cannot download https://github.com/cthiriet/sitesolide/releases/latest/download/SHA256SUMS");
    const pinned = await install("Linux", "x86_64", { env: { SITESOLIDE_DOWNLOAD_URL: "", SITESOLIDE_VERSION: "v0.3.0" }, path });
    expect(pinned.error).toContain("cannot download https://github.com/cthiriet/sitesolide/releases/download/v0.3.0/SHA256SUMS");
    for (const version of ["v0.3.0/../../x", "v0.3.0 x", "$(id)"]) {
      const refused = await install("Linux", "x86_64", { env: { SITESOLIDE_DOWNLOAD_URL: "", SITESOLIDE_VERSION: version }, path });
      expect({ version, code: refused.code }).toEqual({ version, code: 1 });
      expect(refused.error).toContain("is not a release tag");
    }
  });

  test("it never runs sudo", () => {
    const commands = readFileSync(SCRIPT, "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      // The words of the messages are not commands.
      .map((line) => line.replace(/"[^"]*"/g, '""'));
    expect(commands.filter((line) => /\bsudo\b/.test(line))).toEqual([]);
  });
});
