import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle } from "../borrowed/bundle";
import { BUNDLE_NAME, type InstallerResult } from "../src/control/protocol";
import { main } from "../src/installer/main";
import { spawn, type Commands } from "../src/installer/real";
import { INSTALLER } from "./installer-bench";

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
