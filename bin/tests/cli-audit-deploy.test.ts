import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, eventOutput, login, readRemote, runRemote } from "../cli/remote";
import { createFakeVm, type FakeVm } from "./e2e/fake-vm";
import { run, TESTS_ROOT, type Result } from "./e2e/run";

/**
 * What a repository the owner clones and deploys may not make the CLI do:
 * its manifest, its file names and its links are someone else's text, as
 * bin/cli/source.ts already says of `source`.
 *
 * Every run is the real CLI in front of the fake machine of e2e/fake-vm.ts,
 * a dry run unless said otherwise, with a configuration folder of its own so
 * that nothing of the workstation's configuration is read.
 */

const TEMP_DIRS: string[] = [];
const VMS: FakeVm[] = [];

afterEach(() => {
  for (const vm of VMS.splice(0)) vm.cleanup();
  for (const folder of TEMP_DIRS.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function fakeVm(): FakeVm {
  const vm = createFakeVm();
  VMS.push(vm);
  return vm;
}

/** A temporary folder, by its real path: on macOS /var is a link to /private/var. */
function temporary(): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "audit-deploy-")));
  TEMP_DIRS.push(folder);
  return folder;
}

/** The CLI with a configuration folder that holds nothing, and no sites repository. */
function cli(folder: string, arguments_: string[], vm: FakeVm): Promise<Result> {
  return run(folder, arguments_, { vm, env: { SITESOLIDE_CONFIG_DIR: join(temporary(), "config"), SITESOLIDE_SITES_REPO: "" } });
}

type Event = Record<string, unknown>;

function events(r: Result): Event[] {
  return r.output
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Event);
}

function errorOf(r: Result): Event | undefined {
  return events(r).find((event) => event.type === "error");
}

/** Everything a run printed, its events' messages and details included. */
function said(r: Result): string {
  return events(r)
    .map((event) => [event.message, ...((event.details as string[] | undefined) ?? [])].join("\n"))
    .join("\n");
}

/**
 * A cloned repository: a `.git`, as `git clone` leaves, a home folder beside
 * it holding what the workstation keeps private, and the repository at the
 * depth a clone usually sits, `~/Code/<name>`.
 */
function clone(manifest: object, files: Record<string, string> = {}): { home: string; repository: string } {
  const root = temporary();
  const home = join(root, "home");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nnot a real key\n");
  const repository = join(home, "Code", "cloned");
  mkdirSync(join(repository, ".git"), { recursive: true });
  writeFileSync(join(repository, "sitesolide.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repository, path, ".."), { recursive: true });
    writeFileSync(join(repository, path), content);
  }
  return { home, repository };
}

describe("a cloned repository's publicDir", () => {
  test("a publicDir that is a link out of the repository is refused before anything is sent", async () => {
    const { repository } = clone({ slug: "sample-leak", publicDir: "public" });
    // `public` is the workstation's ~/.ssh, two levels up from the clone.
    symlinkSync("../../.ssh", join(repository, "public"));
    const r = await cli(repository, ["deploy", "--dry-run", "--json"], fakeVm());
    expect(r.code).toBe(1);
    expect(String(errorOf(r)?.message)).toContain("publicDir leads outside the repository");
    // Nothing of the folder was even planned for sending.
    expect(said(r)).not.toContain("rsync");
  });

  test("a publicDir that is a link inside the repository is still sent", async () => {
    const { repository } = clone({ slug: "sample-inside", publicDir: "public" }, { "site/index.html": "<h1>hello</h1>\n" });
    symlinkSync("site", join(repository, "public"));
    const r = await cli(repository, ["deploy", "--dry-run", "--json"], fakeVm());
    expect(errorOf(r)).toBeUndefined();
    expect(r.code).toBe(0);
  });

  test("the folder of a project in the sites repository is the owner's, and may lead anywhere", async () => {
    const { home, repository } = clone({ slug: "sample-owner", publicDir: "public" });
    mkdirSync(join(home, "shared"), { recursive: true });
    writeFileSync(join(home, "shared", "index.html"), "<h1>shared</h1>\n");
    symlinkSync("../../shared", join(repository, "public"));
    const r = await run(repository, ["deploy", "--dry-run", "--json"], {
      vm: fakeVm(),
      env: { SITESOLIDE_CONFIG_DIR: join(temporary(), "config"), SITESOLIDE_SITES_REPO: join(home, "Code") },
    });
    expect(errorOf(r)).toBeUndefined();
    expect(r.code).toBe(0);
  });
});

describe("links in the public files", () => {
  test("a link to an absolute path is refused: Caddy would follow it on the machine", async () => {
    const { repository } = clone({ slug: "sample-links", publicDir: "public" }, { "public/index.html": "<h1>hello</h1>\n" });
    // Readable by Caddy's group on the machine, the DNS token of the zone.
    symlinkSync("/etc/caddy/cloudflare.env", join(repository, "public", "robots.txt"));
    const r = await cli(repository, ["deploy", "--dry-run", "--json"], fakeVm());
    expect(r.code).toBe(1);
    const error = errorOf(r);
    expect(String(error?.message)).toContain("links that lead out of publicDir");
    expect((error?.details as string[]).join("\n")).toContain("robots.txt -> /etc/caddy/cloudflare.env");
    expect(said(r)).not.toContain("rsync");
  });

  test("a relative link that climbs out of the public folder is refused too", async () => {
    const { repository } = clone({ slug: "sample-climb", publicDir: "public" }, { "public/index.html": "<h1>hello</h1>\n" });
    mkdirSync(join(repository, "public", "assets"));
    symlinkSync("../../../../../../../../../../var/lib/caddy/.local/share/caddy", join(repository, "public", "assets", "certificates"));
    const r = await cli(repository, ["deploy", "--dry-run", "--json"], fakeVm());
    expect(r.code).toBe(1);
    expect((errorOf(r)?.details as string[]).join("\n")).toContain("assets/certificates -> ../../../../");
  });

  test("a link that stays inside the public folder is sent, as rsync carries it", async () => {
    const { repository } = clone({ slug: "sample-alias", publicDir: "public" }, { "public/v2/index.html": "<h1>v2</h1>\n" });
    symlinkSync("v2", join(repository, "public", "latest"));
    const r = await cli(repository, ["deploy", "--dry-run", "--json"], fakeVm());
    expect(errorOf(r)).toBeUndefined();
    expect(r.code).toBe(0);
  });
});

/** An app of the shape of e2e/projects/api-with-secret, with the secrets given. */
function secretApp(slug: string, secrets: string[]): string {
  const folder = join(temporary(), slug);
  cpSync(join(TESTS_ROOT, "projects", "api-with-secret"), folder, { recursive: true });
  const manifest = { slug, port: 3033, start: "/usr/local/bin/bun run server.ts", exclude: ["node_modules"], secrets };
  writeFileSync(join(folder, "sitesolide.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return folder;
}

describe("a manifest that names a file of /etc/sitesolide", () => {
  test("is refused before anything is sent, the machine's own files and another project's alike: a secret is a variable's name", async () => {
    for (const secrets of [["dashboard-backup.env"], ["cms.env"], ["sample-thief.env"], ["../../etc/shadow"]]) {
      const r = await cli(secretApp("sample-thief", secrets), ["deploy", "--dry-run", "--json"], fakeVm());
      expect(r.code).toBe(1);
      expect(String(errorOf(r)?.message)).toBe("sitesolide.json rejected");
      expect((errorOf(r)?.details as string[]).join("\n")).toContain("secrets: entry 1 is not a variable name");
      expect(said(r)).not.toContain("rsync");
    }
  });

  test("the dashboard declares none either: its unit reads its own file, which no manifest names", async () => {
    const r = await cli(secretApp("dashboard", ["dashboard.env"]), ["deploy", "--dry-run", "--json"], fakeVm());
    expect(r.code).toBe(1);
    expect((errorOf(r)?.details as string[]).join("\n")).toContain("secrets: dashboard keeps its password hash in dashboard.env, which its unit reads: it declares no secret");
    expect(said(r)).not.toContain("rsync");
  });

  test("a manifest that names its variables passes", async () => {
    const r = await cli(secretApp("sample-secret", ["API_KEY", "SMTP_URL"]), ["deploy", "--dry-run", "--json"], fakeVm());
    expect(errorOf(r)).toBeUndefined();
    expect(r.code).toBe(0);
  });
});

describe("remove", () => {
  test("deletes no flat file of /etc/sitesolide, only the project's store", async () => {
    const r = await cli(secretApp("sample-gone", ["API_KEY"]), ["remove", "--confirm", "sample-gone", "--dry-run", "--json"], fakeVm());
    expect(r.code).toBe(0);
    const text = said(r);
    expect(text).toContain("sudo rm -rf /etc/sitesolide/projects/sample-gone");
    expect(text).not.toMatch(/rm -f \/etc\/sitesolide\//);
  });
});

describe("the token kept in the vault", () => {
  const TOKEN = `sst_${"T".repeat(43)}`;
  const DASHBOARD = "https://dashboard.test-zone.invalid";

  /** A workstation `login` left: the address in config.json, the token in the vault. */
  function station(): string {
    const home = temporary();
    const config = join(home, ".config", "sitesolide");
    mkdirSync(join(config, "secrets"), { recursive: true });
    writeFileSync(join(config, "config.json"), `${JSON.stringify({ api: DASHBOARD })}\n`);
    writeFileSync(join(config, "secrets", "team-token"), `${TOKEN}\n`);
    return home;
  }

  test("goes to the dashboard it was checked against, never to an address the environment names", () => {
    const home = station();
    expect(readRemote({}, home)).toEqual({ api: DASHBOARD, token: TOKEN });
    expect(readRemote({ SITESOLIDE_API: `${DASHBOARD}/` }, home)).toEqual({ api: DASHBOARD, token: TOKEN });
    expect(readRemote({ SITESOLIDE_API: "https://collector.attacker.invalid" }, home)).toEqual({
      missing: `SITESOLIDE_API names https://collector.attacker.invalid, not ${DASHBOARD}, the dashboard the token in the vault was checked against: run sitesolide login --url https://collector.attacker.invalid, or set SITESOLIDE_TOKEN beside it`,
    });
    // A token given beside the address is the sandbox's own, and goes where it is told.
    expect(readRemote({ SITESOLIDE_API: "https://other.test-zone.invalid", SITESOLIDE_TOKEN: TOKEN }, home)).toEqual({ api: "https://other.test-zone.invalid", token: TOKEN });
  });

  test("goes nowhere a configuration the environment points at names, though that configuration names the vault", () => {
    // The configuration folder and the home are the environment's too, and
    // a file anyone may write: one that names the attacker's address and the
    // real vault, through its `vault` key or SITESOLIDE_VAULT, made its own
    // `api` the one the vault's token was compared with, and sent it there.
    const home = station();
    const vault = join(home, ".config", "sitesolide", "secrets");
    const ATTACKER = "https://collector.attacker.invalid";
    const planted = temporary();
    writeFileSync(join(planted, "config.json"), `${JSON.stringify({ api: ATTACKER, vault })}\n`);
    const elsewhere = temporary();
    mkdirSync(join(elsewhere, ".config", "sitesolide"), { recursive: true });
    writeFileSync(join(elsewhere, ".config", "sitesolide", "config.json"), `${JSON.stringify({ api: ATTACKER, vault })}\n`);
    // A vault of the attacker's own, holding its address and the real token
    // by a link or a second name.
    const linked = temporary();
    writeFileSync(join(linked, "team-token-api"), `${ATTACKER}\n`);
    symlinkSync(join(vault, "team-token"), join(linked, "team-token"));
    const named = temporary();
    writeFileSync(join(named, "team-token-api"), `${ATTACKER}\n`);
    linkSync(join(vault, "team-token"), join(named, "team-token"));
    for (const [environment, from] of [
      [{ SITESOLIDE_CONFIG_DIR: planted }, home],
      [{ SITESOLIDE_CONFIG_DIR: planted, SITESOLIDE_VAULT: vault, SITESOLIDE_API: ATTACKER }, home],
      [{}, elsewhere],
      [{ SITESOLIDE_VAULT: linked, SITESOLIDE_API: ATTACKER }, home],
      [{ SITESOLIDE_VAULT: named, SITESOLIDE_API: ATTACKER }, home],
    ] as const) {
      const read = readRemote(environment, from);
      expect("token" in read).toBe(false);
      expect(read).toMatchObject({ missing: expect.stringContaining("run sitesolide login") });
    }
  });

  test("login binds the token to the dashboard it checked: a configuration rewritten afterwards sends it nowhere else", async () => {
    // config.json is no secret, and an agent that may not read the vault may
    // still write it, or run `sitesolide init --api`: the address the token
    // goes to is kept in the vault, beside it, where `login` wrote both.
    const home = temporary();
    const code = await login(["login", "--url", DASHBOARD, "--token-stdin", "--json"], {
      environment: {},
      home,
      output: eventOutput(() => {}),
      stdin: async () => `${TOKEN}\n`,
      fetcher: async () => Response.json({ identity: { id: "t1", label: "laptop", email: "ada@test-zone.invalid", expiresAt: null, scope: { slugs: [], create: false, outbound: false, domain: false, public: false }, owned: [] } }),
    });
    expect(code).toBe(0);
    expect(readRemote({}, home)).toEqual({ api: DASHBOARD, token: TOKEN });
    writeFileSync(join(home, ".config", "sitesolide", "config.json"), `${JSON.stringify({ api: "https://collector.attacker.invalid" })}\n`);
    const read = readRemote({}, home);
    expect("token" in read).toBe(false);
    expect(read).toMatchObject({ missing: expect.stringContaining("run sitesolide login") });
  });

  test("a command run with another address sends nothing anywhere", async () => {
    const home = station();
    const asked: string[] = [];
    const lines: string[] = [];
    const code = await runRemote("status", ["status", "--json"], {
      folder: home,
      home,
      environment: { SITESOLIDE_API: "https://collector.attacker.invalid" },
      output: eventOutput((line) => lines.push(line)),
      build: async () => {},
      checkPublic: () => {},
      fetcher: async (input) => {
        asked.push(input);
        return Response.json({});
      },
    });
    expect(code).toBe(1);
    expect(asked).toEqual([]);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});

const OPENSSL = Bun.which("openssl");

describe.skipIf(OPENSSL === null)("the bearer on the wire", () => {
  test("goes only over a certificate that verifies, NODE_TLS_REJECT_UNAUTHORIZED=0 in the environment or not", async () => {
    // HTTPS_PROXY, an environment variable too, lets the proxy choose who
    // answers the TLS handshake: the certificate is then all that keeps the
    // bearer from it, and NODE_TLS_REJECT_UNAUTHORIZED=0 beside it, which
    // Bun's fetch obeys, handed the proxy every request's Authorization.
    const folder = temporary();
    const made = Bun.spawnSync([OPENSSL!, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(folder, "key.pem"), "-out", join(folder, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
    expect(made.exitCode).toBe(0);
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { key: Bun.file(join(folder, "key.pem")), cert: Bun.file(join(folder, "cert.pem")) },
      fetch: (req) => {
        seen.push(req.headers.get("authorization") ?? "");
        return Response.json({});
      },
    });
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      const answer = await call({ api: `https://127.0.0.1:${server.port}`, token: `sst_${"T".repeat(43)}` }, "/api/v1/whoami");
      expect(answer.ok).toBe(false);
      expect(seen).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
      server.stop(true);
    }
  });
});

describe("login at a terminal", () => {
  const TOKEN = `sst_${"T".repeat(43)}`;

  test("asks for the token without echo, never with the prompt that shows what is typed", async () => {
    const home = temporary();
    const shown: string[] = [];
    const hidden: string[] = [];
    const lines: string[] = [];
    const code = await login(["login", "--url", "https://dashboard.test-zone.invalid"], {
      environment: {},
      home,
      output: eventOutput((line) => lines.push(line)),
      prompt: (question) => {
        shown.push(question);
        return TOKEN;
      },
      secretPrompt: async (question) => {
        hidden.push(question);
        return TOKEN;
      },
      terminal: () => true,
      fetcher: async () => Response.json({ identity: { id: "t1", label: "laptop", email: "ada@test-zone.invalid", expiresAt: null, scope: { slugs: [], create: false, outbound: false, domain: false, public: false }, owned: [] } }),
    });
    expect(code).toBe(0);
    expect(shown.filter((question) => question.includes("Token"))).toEqual([]);
    expect(hidden).toHaveLength(1);
  });
});
