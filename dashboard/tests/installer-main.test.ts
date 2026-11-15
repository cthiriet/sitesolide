import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundle } from "../borrowed/bundle";
import { BUNDLE_NAME, type InstallerResult } from "../src/control/protocol";
import { createReporter, main, pruneResults, RESULT_RETENTION_MS } from "../src/installer/main";
import { spawn, type Commands } from "../src/installer/real";
import { INSTALLER } from "./installer-bench";
import { NOT_ON_DEMAND } from "../borrowed/zone-names";

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
      systemdAnalyze: async () => ({ code: 0, output: "" }),
      shell: async () => ({ code: 0, output: `${NOT_ON_DEMAND}\n` }),
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
        TLS_ZONE_FILE: join(root, "caddy", "tls-zone.caddy"),
        ZONE_NAMES_FILE: join(root, "caddy", "zone-names"),
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
    // A static site has no store: nothing is known missing, and none was laid.
    expect(result.missingSecrets).toBeNull();
    expect(readdirSync(join(root, "secrets"))).toEqual([]);
    expect(result.log[0]).toBe("-> deployment abcdefabcdefabcdefabcdef of notes, for ada@test-zone.invalid (token aaaaaaaaaaaa)");
    expect(result.log).toContain("-> public, put in place");
    // Everything up to the verification happened: the files and the manifest are in place.
    expect(readFileSync(join(root, "sites", "notes", "public", "index.html"), "utf8")).toBe("<h1>notes</h1>");
    expect(JSON.parse(readFileSync(join(root, "sites", "notes", "sitesolide.json"), "utf8"))).toEqual({ slug: "notes", publicDir: "public" });
    expect(calls).toContain("useradd site-notes");
  });

  test("the names the store lacked go into the result with its verdict, names alone; none known until then; the folder a creation laid, at once", () => {
    const root = mkdtempSync(join(tmpdir(), "installer-reporter-"));
    toClean.push(root);
    const request = {
      deployment: DEPLOYMENT,
      slug: "shop",
      requestedAt: 1,
      token: { id: "aaaaaaaaaaaa", email: "ada@test-zone.invalid" },
      scope: { slugs: [], create: true, outbound: false, domain: false, public: false },
      creating: true,
      manifest: "{}",
    };
    const read = () => JSON.parse(readFileSync(join(root, `${DEPLOYMENT}.json`), "utf8")) as InstallerResult;
    const reporter = createReporter(root, request, () => 1, () => {});
    reporter.log("-> manifest");
    expect(read().missingSecrets).toBeNull();
    expect(read().laid).toBe(false);
    // Said at once, an installer killed from here on leaving it said.
    reporter.laid(true);
    expect(read()).toMatchObject({ state: "running", laid: true });
    reporter.finish({ ok: false, code: "service-failed", message: "shop did not come back", allocated: [], missingSecrets: { runtime: ["ADMIN_TOKEN"], files: ["gcp.json"] } });
    expect(read()).toMatchObject({ state: "failed", laid: true, missingSecrets: { runtime: ["ADMIN_TOKEN"], files: ["gcp.json"] } });
    const other = createReporter(root, request, () => 2, () => {});
    other.finish({ ok: true, url: "https://shop.test-zone.invalid/", allocated: [] });
    expect(read()).toMatchObject({ state: "succeeded", missingSecrets: null });
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

  test("a request naming a person's token, from a steward of before, does nothing and writes no result", async () => {
    const root = mkdtempSync(join(tmpdir(), "installer-member-"));
    toClean.push(root);
    for (const folder of ["sites", "state/installs", "results"]) mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(
      join(root, "state", "installs", "notes.json"),
      JSON.stringify({
        deployment: DEPLOYMENT,
        slug: "notes",
        requestedAt: Date.now(),
        token: { id: "aaaaaaaaaaaa", email: "ada@acme.test", member: "ada@acme.test" },
        scope: { slugs: ["notes"], create: false, outbound: false, domain: false, public: false },
        creating: false,
        manifest: JSON.stringify({ slug: "notes", publicDir: "public" }),
      }),
    );
    const code = await main(["sitesolide-installer@notes.service"], { SITESOLIDE_ZONE: "test-zone.invalid", STEWARD_STATE: join(root, "state"), INSTALLER_FOLDER: join(root, "results") });
    expect(code).toBe(0);
    expect(readdirSync(join(root, "results"))).toEqual([]);
    expect(readdirSync(join(root, "sites"))).toEqual([]);
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
