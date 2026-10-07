import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Role } from "../borrowed/access";
import { bundle } from "../borrowed/bundle";
import { BUNDLE_NAME, type InstallerResult } from "../src/control/protocol";
import { main, pruneResults, RESULT_RETENTION_MS } from "../src/installer/main";
import { spawn, type Commands } from "../src/installer/real";
import { INSTALLER } from "./installer-bench";
import { registryOf, writeRegistry } from "./registry-fixtures";

/**
 * The installer as systemd launches it, `main` with an environment, on a
 * throwaway tree: the request read from the steward's state directory, the
 * gatekeeper's real machine mounted from the same variables as on the machine,
 * the archive extracted by `installer.ts --extract` in a child process, the
 * result written where the steward reads it. Only the commands that need root
 * are replaced; the probe aims at a closed port, so the deployment ends at its
 * verification, which is what this test reads.
 */

const toClean: string[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const DEPLOYMENT = "abcdefabcdefabcdefabcdef";

describe("main", () => {
  test("a static site deployed from the steward's request, its result written as it goes", async () => {
    const root = mkdtempSync(join(tmpdir(), "installer-main-"));
    toClean.push(root);
    for (const folder of ["sites", "units", "secrets", "state/installs", "results", "run", "caddy", `spool/${DEPLOYMENT}`]) mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, "passwd"), "root:x:0:0::/root:/bin/sh\n");
    writeFileSync(join(root, "spool", DEPLOYMENT, BUNDLE_NAME), bundle([{ kind: "file", path: "public/index.html", mtime: 1_789_000_000, executable: false, content: new TextEncoder().encode("<h1>notes</h1>") }]));
    writeFileSync(
      join(root, "state", "installs", "notes.json"),
      JSON.stringify({
        deployment: DEPLOYMENT,
        slug: "notes",
        requestedAt: Date.now(),
        token: { id: "aaaaaaaaaaaa", email: "ada@test-zone.invalid" },
        scope: { slugs: [], create: true, outbound: false, domain: false, public: true },
        creating: true,
        manifest: JSON.stringify({ slug: "notes", publicDir: "public" }),
      }),
    );
    const calls: string[] = [];
    const commands: Commands = {
      systemctl: async (arguments_) => {
        calls.push(`systemctl ${arguments_.join(" ")}`);
        return { code: 0, output: "" };
      },
      useradd: async (account) => {
        calls.push(`useradd ${account}`);
        writeFileSync(join(root, "passwd"), `${readFileSync(join(root, "passwd"), "utf8")}${account}:x:2000:2000::/nonexistent:/usr/sbin/nologin\n`);
        return { code: 0, output: "" };
      },
      userdel: async (account) => {
        calls.push(`userdel ${account}`);
        return { code: 0, output: "" };
      },
      asProject: async (run) => (run.purpose === "extract" ? spawn(run.command, 60_000, { stdin: run.stdin }) : { code: 1, output: "unexpected" }),
      nft: async () => ({ code: 1, output: "" }),
    };

    const code = await main(
      ["sitesolide-installer@notes.service"],
      {
        SITESOLIDE_ZONE: "test-zone.invalid",
        STEWARD_STATE: join(root, "state"),
        INSTALLER_FOLDER: join(root, "results"),
        SITES_DIR: join(root, "sites"),
        BLOCKS_FOLDER: join(root, "caddy"),
        RUN_FOLDER: join(root, "run"),
        BLOCK_OWNER: "",
        UNITS_FOLDER: join(root, "units"),
        SECRETS_FOLDER: join(root, "secrets"),
        SPOOL_FOLDER: join(root, "spool"),
        ACCOUNTS_FILE: join(root, "passwd"),
        PROJECT_PORTS_FILE: join(root, "projects.nft"),
        EXTRACTOR: `${process.execPath} ${INSTALLER}`,
        CHECK_ACCOUNTS: "",
        PROBE_PORT: "9",
      },
      { commands, systemctl: async () => ({ code: 0, stdout: "", stderr: "" }) },
    );
    expect(code).toBe(0);

    const path = join(root, "results", `${DEPLOYMENT}.json`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const result = JSON.parse(readFileSync(path, "utf8")) as InstallerResult;
    expect(result).toMatchObject({ deployment: DEPLOYMENT, slug: "notes", state: "failed", error: { code: "verify-failed" } });
    expect(result.log[0]).toBe("-> deployment abcdefabcdefabcdefabcdef of notes, for ada@test-zone.invalid (token aaaaaaaaaaaa)");
    expect(result.log).toContain("-> public, put in place");
    // Everything up to the verification happened: the files and the manifest are in place.
    expect(readFileSync(join(root, "sites", "notes", "public", "index.html"), "utf8")).toBe("<h1>notes</h1>");
    expect(JSON.parse(readFileSync(join(root, "sites", "notes", "sitesolide.json"), "utf8"))).toEqual({ slug: "notes", publicDir: "public" });
    expect(calls).toContain("useradd site-notes");
  });

  test("results older than a week are pruned, and nothing else in the folder", () => {
    const root = mkdtempSync(join(tmpdir(), "installer-prune-"));
    toClean.push(root);
    const old = join(root, "111111111111111111111111.json");
    const fresh = join(root, "222222222222222222222222.json");
    const other = join(root, "notes.txt");
    for (const path of [old, fresh, other]) writeFileSync(path, "{}");
    const weekAgo = (Date.now() - RESULT_RETENTION_MS - 60_000) / 1000;
    utimesSync(old, weekAgo, weekAgo);
    utimesSync(other, weekAgo, weekAgo);
    expect(pruneResults(root, Date.now())).toBe(1);
    expect(readdirSync(root).sort()).toEqual(["222222222222222222222222.json", "notes.txt"]);
  });

  /** A person's request, the access registry beside it as the steward keeps it, and what the installer made of it. */
  async function memberRun(
    roles: Record<string, Role> | null,
    scope: Record<string, unknown>,
    creating: boolean,
    create = false,
    extra: (root: string) => Record<string, string> = () => ({}),
  ): Promise<{ root: string; result: InstallerResult }> {
    const root = mkdtempSync(join(tmpdir(), "installer-member-"));
    toClean.push(root);
    for (const folder of ["sites", "units", "secrets", "state/installs", "results", "run", "caddy", `spool/${DEPLOYMENT}`]) mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, "passwd"), "root:x:0:0::/root:/bin/sh\n");
    writeRegistry(join(root, "state"), registryOf(roles === null ? {} : { "ada@acme.test": roles }, roles !== null && create ? ["ada@acme.test"] : []));
    writeFileSync(
      join(root, "state", "installs", "notes.json"),
      JSON.stringify({
        deployment: DEPLOYMENT,
        slug: "notes",
        requestedAt: Date.now(),
        token: { id: "aaaaaaaaaaaa", email: "ada@acme.test", member: "ada@acme.test" },
        scope: { slugs: ["notes"], create: false, outbound: false, domain: false, public: false, ...scope },
        creating,
        manifest: JSON.stringify({ slug: "notes", publicDir: "public" }),
      }),
    );
    const code = await main(["sitesolide-installer@notes.service"], { SITESOLIDE_ZONE: "test-zone.invalid", STEWARD_STATE: join(root, "state"), INSTALLER_FOLDER: join(root, "results"), ...extra(root) });
    expect(code).toBe(0);
    return { root, result: JSON.parse(readFileSync(join(root, "results", `${DEPLOYMENT}.json`), "utf8")) as InstallerResult };
  }

  test("a person's token: their role lowered to Viewer since the steward wrote the request stops it, nothing written", async () => {
    const { root, result } = await memberRun({ notes: "viewer" }, {}, false);
    expect(result).toMatchObject({ state: "failed", error: { code: "out-of-scope", message: "ada@acme.test is a Viewer on notes: deploying it takes a Developer or an Admin: nothing was changed" } });
    expect(result.log[0]).toBe("-> deployment abcdefabcdefabcdefabcdef of notes, for ada@acme.test (token aaaaaaaaaaaa, a person's own)");
    expect(readdirSync(join(root, "sites"))).toEqual([]);
  });

  test("a person's token: someone with no role left since, Can open alone, or a registry that does not read, is refused", async () => {
    const gone = "the person who holds this token no longer has a role on this dashboard: nothing was changed";
    expect((await memberRun(null, {}, false)).result).toMatchObject({ state: "failed", error: { code: "out-of-scope", message: gone } });
    expect((await memberRun({ notes: "visitor" }, {}, false)).result).toMatchObject({ state: "failed", error: { code: "out-of-scope", message: gone } });
    const unreadable = await memberRun({ notes: "admin" }, {}, false, false, (root) => {
      writeFileSync(join(root, "state", "access.json"), "{ not json");
      return {};
    });
    expect(unreadable.result).toMatchObject({ state: "failed", error: { code: "out-of-scope", message: gone } });
    const { result } = await memberRun({ notes: "admin" }, { create: true }, true, false);
    expect(result).toMatchObject({ state: "failed", error: { code: "out-of-scope", message: "ada@acme.test may no longer create projects: nothing was changed" } });
  });

  test("a person's token: a Developer's deployment loses the options an Admin's would carry", async () => {
    // Public sites asked for, Ada a developer there: the static site would need them, and is refused as private.
    const env = (root: string) => ({ SITES_DIR: join(root, "sites"), BLOCKS_FOLDER: join(root, "caddy"), RUN_FOLDER: join(root, "run"), CHECK_ACCOUNTS: "" });
    const { result } = await memberRun({ notes: "developer" }, { public: true }, false, false, env);
    expect(result.state).toBe("failed");
    expect(result.error?.code).not.toBe("misconfigured");
    expect(JSON.stringify(result.error)).toContain("your token may only deploy private sites");
  });

  test("a machine whose environment file lost DEPLOY_ACCOUNT refuses, and says so in the result", async () => {
    const root = mkdtempSync(join(tmpdir(), "installer-main-"));
    toClean.push(root);
    mkdirSync(join(root, "state", "installs"), { recursive: true });
    mkdirSync(join(root, "results"));
    writeFileSync(
      join(root, "state", "installs", "notes.json"),
      JSON.stringify({
        deployment: DEPLOYMENT,
        slug: "notes",
        requestedAt: Date.now(),
        token: { id: "aaaaaaaaaaaa", email: "ada@test-zone.invalid" },
        scope: { slugs: [], create: true, outbound: false, domain: false, public: true },
        creating: true,
        manifest: "{}",
      }),
    );
    const code = await main(["sitesolide-installer@notes.service"], { SITESOLIDE_ZONE: "test-zone.invalid", STEWARD_STATE: join(root, "state"), INSTALLER_FOLDER: join(root, "results") });
    expect(code).toBe(0);
    const result = JSON.parse(readFileSync(join(root, "results", `${DEPLOYMENT}.json`), "utf8")) as InstallerResult;
    expect(result).toMatchObject({ state: "failed", error: { code: "misconfigured" } });
  });
});
