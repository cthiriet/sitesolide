import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideTake, type TakeAnswer } from "../cli/caddy-lock";
import { DEFAULT_HINT, HINTS, hintFor, hintForFailure, REMOTE_HINTS } from "../cli/hints";
import { PROJECT_PORTS_FILE } from "../cli/loopback";
import { confirmDoorUnderLock, decidePortal, guardDepositedManifest } from "../cli/portal-vm";
import { missingBuildSecrets, unreadableWorkstation } from "../cli/build-secrets";
import { credentialsFailure } from "../cli/store";
import { foreignSecretFiles, storeRefused } from "../cli/refresh";
import { storelessRefusal } from "../cli/store-cli";
import type { Manifest } from "../cli/manifest";

/**
 * Every refusal the CLI prints carries, under --json, a hint an agent can act
 * on. The refusals are worded where they happen; the hints live in one table,
 * and these tests are what keeps the two in step.
 */
const SOURCE = readFileSync(join(import.meta.dir, "..", "sitesolide.ts"), "utf8");

/**
 * The literal messages of `die(...)` and of `fail(...)`, the strict mode of the
 * loopback rebuild, as the source writes them, `${...}` replaced by a sample
 * value. A message built elsewhere, `die(decision.message, ...)`, is not a
 * literal: those are covered below, from the modules that build them.
 */
function literalMessages(): string[] {
  // The interpolations whose value the hints rely on; any other stands for a
  // slug, a path or a reason, which no pattern reads.
  const values: Record<string, string> = {
    MANIFEST_NAME: "sitesolide.json",
    PROJECT_PORTS_FILE: PROJECT_PORTS_FILE,
    code: "1",
  };
  const messages: string[] = [];
  for (const match of SOURCE.matchAll(/\b(?:die|fail)\(\s*(["`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    messages.push(match[2]!.replace(/\$\{([^}]*)\}/g, (_, name: string) => values[name.trim()] ?? "sample"));
  }
  return messages;
}

describe("the hints", () => {
  test("every literal refusal of bin/sitesolide.ts has one of its own", () => {
    const messages = literalMessages();
    // Enough to be sure the scan reads the file, and not an empty list.
    expect(messages.length).toBeGreaterThan(35);
    const uncovered = messages.filter((message) => hintFor(message) === DEFAULT_HINT);
    expect(uncovered).toEqual([]);
  });

  test("the refusals built by the modules are covered too", () => {
    const messages: string[] = [];
    const lockAnswers: TakeAnswer[] = [
      { kind: "unreadable", reason: "no answer" },
      { kind: "held", now: Date.now(), stale: false, content: "" },
    ];
    for (const answer of lockAnswers) {
      const decision = decideTake(answer);
      if (decision.kind === "rejects") messages.push(decision.message);
    }
    // The store and the build's secrets: deploy and refresh word these where they stop.
    messages.push(
      missingBuildSecrets(["CMS_TOKEN"], "/home/someone/.config/sitesolide/secrets/blog.env").message,
      unreadableWorkstation("/home/someone/.config/sitesolide/secrets/blog.env", "line 3: invalid variable name").message,
      "the store of secrets cannot be laid: /etc/sitesolide/projects/shop is a link or not a folder",
      "cannot tell whether the store's folders of shop are laid",
      credentialsFailure("shop.service", "shop"),
      foreignSecretFiles("shop"),
      storeRefused("shop"),
      storelessRefusal({ slug: "blog", publicDir: "dist" } as Manifest).message,
      storelessRefusal({ slug: "portal", start: "/x", port: 3001 } as Manifest).message,
    );
    const unreadable = { kind: "unreadable", reason: "no answer" } as const;
    for (const decision of [
      decidePortal("shop", { portal: false, lock: false }, unreadable),
      confirmDoorUnderLock("shop", { portal: true, lock: false }, { kind: "present", portal: false, lock: false }),
      guardDepositedManifest("shop", { portal: false, lock: false }, { kind: "present", portal: true, lock: false }, "domain"),
      guardDepositedManifest("shop", { portal: true, lock: false }, { kind: "present", portal: false, lock: false }, "domain"),
    ]) {
      if (decision.kind === "rejects") messages.push(decision.message);
    }
    expect(messages.length).toBe(15);
    expect(messages.filter((message) => hintFor(message) === DEFAULT_HINT)).toEqual([]);
  });

  test("the refusal of a folder nothing was recognised in, which the source words in two ways", () => {
    expect(hintFor("sitesolide.json not found in /code/notes, and none can be inferred")).toContain("by hand");
    expect(hintFor("nothing deployable recognised in /code/notes")).toContain("by hand");
  });

  test("the narrower patterns win: a refusal is never answered with a neighbour's hint", () => {
    expect(hintFor("sitesolide.json rejected once the portal set from the dashboard is applied")).toContain("keeping `portal`");
    expect(hintFor("sitesolide.json rejected")).toContain("docs/manifest.md");
    expect(hintFor("general access of shop changed from the dashboard during this deploy: run `sitesolide deploy` again")).toContain(
      "changed while deploy ran",
    );
  });

  test("a hint never tells an agent to force its way through", () => {
    for (const [, hint] of HINTS) {
      if (hint.includes("--force")) expect(hint).toMatch(/do not re-run with --force|--force only on the owner's/);
    }
    expect(DEFAULT_HINT).toContain("never work around");
  });

  test("a 404 at the root says what to serve there, over SSH and through the API", () => {
    expect(hintFor("https://shop.test-zone.invalid/ answered 404: nothing is served at the site's root")).toContain("index.html in publicDir");
    expect(hintForFailure("verify-failed", "https://shop.test-zone.invalid/ answered 404: nothing is served at the site's root")).toContain("index.html in publicDir");
  });

  test("a missing build secret goes to whoever deploys, never into the repository", () => {
    const hint = hintFor("build secrets missing: CMS_TOKEN");
    expect(hint).toContain("export it");
    expect(hint).toContain("never put its value in the repository");
  });

  test("a refusal through the API is answered by its code, and never with --force", () => {
    expect(hintForFailure("no-dry-run", "deploy --dry-run is not available with a token: nothing was sent")).toContain("without --dry-run");
    expect(hintForFailure("secret-missing", "/etc/sitesolide/shop.env missing")).toContain("never put secret values in the repository");
    // A code the table lacks falls back to what the message says.
    expect(hintForFailure("brand-new", "build failed: bun run build")).toBe(hintFor("build failed: bun run build"));
    for (const hint of Object.values(REMOTE_HINTS)) {
      if (hint.includes("--force")) expect(hint).toMatch(/do not re-run with --force/);
    }
    // The codes the installer stops on, as docs/access.md lists them.
    for (const code of ["install-failed", "secret-taken", "store-refused", "store-failed", "edited-by-hand", "system-unit", "caddy-busy", "bundle-refused", "service-failed", "verify-failed"]) {
      expect(Object.hasOwn(REMOTE_HINTS, code)).toBe(true);
    }
  });

  test("a deployment stopped over a secret file has its code's hint, the file another project's or the machine's never declared instead", () => {
    // The installer's codes reach the CLI as the deployment's error.code
    // (bin/cli/remote.ts), and a code without a hint would fall back to the
    // message's: every `secret-` one it stops on is covered here.
    const source = readFileSync(join(import.meta.dir, "..", "..", "dashboard", "src", "installer", "pipeline.ts"), "utf8");
    const codes = new Set([...source.matchAll(/new Stop\(\s*"(secret-[a-z-]+)"/g)].map((match) => match[1]!));
    // A missing file no longer stops a deployment: only one the project may not read does.
    expect([...codes].sort()).toEqual(["secret-taken"]);
    expect([...codes].filter((code) => !Object.hasOwn(REMOTE_HINTS, code))).toEqual([]);
    // And the store's folders, which the installer lays before the units.
    const store = new Set([...source.matchAll(/new Stop\(\s*"(store-[a-z-]+)"/g)].map((match) => match[1]!));
    expect([...store].sort()).toEqual(["store-failed", "store-refused"]);
    expect([...store].filter((code) => !Object.hasOwn(REMOTE_HINTS, code))).toEqual([]);
    expect(hintForFailure("store-failed", "the project's store of secrets could not be laid under /etc/sitesolide/projects (EACCES)")).toContain("tell the owner of the machine");
    const hint = hintForFailure("secret-taken", "secrets: /etc/sitesolide/shop.env is already on the machine and does not belong to site-shop; nothing was changed");
    expect(hint).toContain("pick another slug in sitesolide.json");
    expect(hint).toContain("tell the owner of the machine");
    expect(hint).toContain("never declare another file");
    expect(hint).not.toContain("--force");
  });

  test("busy names a token's previous restart as well as a deployment, and asks once", () => {
    expect(hintForFailure("busy", "this token's previous restart is still under way: wait for its verdict, then ask again")).toContain("previous restart is still under way");
    expect(REMOTE_HINTS.busy).toContain("a deployment of this project is already running");
    expect(REMOTE_HINTS.busy).toContain("never retry in a loop");
  });

  test("every refusal of share and people has its code's hint, whichever way they run, and so has every code the API's access answers", () => {
    const source = readFileSync(join(import.meta.dir, "..", "cli", "access.ts"), "utf8");
    const codes = new Set([...source.matchAll(/error: "([a-z-]+)"/g)].map((match) => match[1]!));
    // Enough to be sure the scan reads the file.
    expect(codes.size).toBeGreaterThan(5);
    for (const code of ["usage", "invalid", "unknown-option", "ssh-failed", "steward-outdated", "failure"]) expect(codes.has(code)).toBe(true);
    // What the steward refuses a change with, carried as it stands over the owner's SSH (dashboard/src/access/rules.ts).
    for (const code of ["invalid", "out-of-scope", "not-found", "locked"]) codes.add(code);
    // What dashboard/src/control/api.ts answers on /api/v1/projects/<slug>/access, and what the CLI says of an old dashboard.
    for (const code of ["unauthenticated", "too-many-attempts", "not-found", "invalid", "too-large", "out-of-scope", "not-available", "failure", "unreachable", "unreadable"]) codes.add(code);
    expect([...codes].filter((code) => !Object.hasOwn(REMOTE_HINTS, code))).toEqual([]);
    expect(hintForFailure("steward-outdated", "the steward on the server has no owner's socket")).toContain("sitesolide upgrade");
    expect(hintForFailure("locked", "giving Admin needs the dashboard's unlock")).toContain("unlock");
  });

  test("every refusal of a token's run has its code's hint, the secrets routes' and the CLI's own among them", () => {
    // `secrets` and `restart` live in store-cli.ts, which both ways run.
    const source = ["remote.ts", "store-cli.ts"].map((file) => readFileSync(join(import.meta.dir, "..", "cli", file), "utf8")).join("\n");
    const codes = new Set([...source.matchAll(/error: "([a-z-]+)"/g)].map((match) => match[1]!));
    // Enough to be sure the scan reads the file.
    for (const code of ["value-in-arguments", "needs-stdin", "cancelled", "restart-failed", "needs-ssh", "unknown-option", "stdin-is-terminal", "looks-like-value", "unconfirmed"]) expect(codes.has(code)).toBe(true);
    // What the API answers on its secrets and restart routes (docs/access.md), `unmanaged` the one they add,
    // and what the steward refuses a change of the store with, over SSH as through the API.
    for (const code of ["unauthenticated", "too-many-attempts", "out-of-scope", "invalid", "not-found", "busy", "too-large", "unmanaged", "not-available", "failure", "already-present", "store-unmanaged", "store-refused", "steward-outdated", "ssh-failed"]) codes.add(code);
    expect([...codes].filter((code) => !Object.hasOwn(REMOTE_HINTS, code))).toEqual([]);
  });

  test("a secret's value comes from the user, or from what an agent generates itself, never from the conversation nor a command line", () => {
    for (const code of ["value-in-arguments", "needs-stdin", "secret-missing", "stdin-is-terminal", "looks-like-value"]) {
      expect(REMOTE_HINTS[code]).toContain("never a value read from the conversation");
      expect(REMOTE_HINTS[code]).toContain("sitesolide secrets set NAME");
    }
    // A key typed where the name goes: the user is told to change it, as for one on the line.
    expect(REMOTE_HINTS["looks-like-value"]).toContain("shell's history");
    // A change whose answer never came: checked, then made again once, never in a loop.
    expect(hintForFailure("unconfirmed", "the change of shop.env was sent and its answer never came: it may have been written")).toContain("sitesolide secrets --json");
    expect(REMOTE_HINTS.unconfirmed).toContain("never retry in a loop");
    expect(REMOTE_HINTS["secret-missing"]).toContain("never put secret values in the repository");
    expect(REMOTE_HINTS["needs-ssh"]).toContain("secrets, restart and login");
    expect(hintForFailure("restart-failed", "the service of shop did not hold after its restart")).toContain("never restart in a loop");
    expect(hintForFailure("unmanaged", "shop.env is not managed here")).toContain("tell the owner");
  });

  test("the store's and the build secrets' codes: what to do, never a value read or printed", () => {
    expect(REMOTE_HINTS["build-secret-missing"]).toContain("never a value read from the conversation");
    expect(REMOTE_HINTS["build-secret-missing"]).toContain("nothing was sent");
    expect(REMOTE_HINTS["build-secrets-unreadable"]).toContain("never read, print or rewrite the file yourself");
    expect(REMOTE_HINTS["migrate-conflict"]).toContain("sitesolide refresh <slug>`, then migrate again");
    expect(REMOTE_HINTS["migrate-conflict"]).not.toContain("duplicate");
    // A deployment that would drop legacy values stops, and says to migrate first, the owner's.
    expect(REMOTE_HINTS["migrate-first"]).toContain("sitesolide secrets migrate --restart");
    expect(hintFor("migrate first: sitesolide secrets migrate --restart; the service reads A from legacy files this manifest no longer reads, and the store lacks it")).toBe(REMOTE_HINTS["migrate-first"]!);
    expect(REMOTE_HINTS["migrate-conflict"]).toContain("never read or print a value");
    expect(REMOTE_HINTS["store-refused"]).toContain("never move, delete or replace it yourself");
    expect(REMOTE_HINTS["already-present"]).toContain("--replace");
    expect(REMOTE_HINTS["steward-outdated"]).toContain("sitesolide upgrade");
    // 243 is said by what to run, refresh, never by a hand on the machine.
    expect(hintFor(credentialsFailure("shop.worker.service", "shop"))).toContain("sitesolide refresh <slug>");
    // The stop it described is gone: a missing runtime secret never stops a deployment.
    expect(HINTS.some(([pattern]) => pattern.test("secret missing on the server: /etc/sitesolide/shop.env"))).toBe(false);
  });

  test("the codes of what is gone have no hint left: members and the portal's own sharing", () => {
    for (const code of ["not-a-member", "portal-unreachable"]) expect(Object.hasOwn(REMOTE_HINTS, code)).toBe(false);
    for (const hint of Object.values(REMOTE_HINTS)) {
      expect(hint).not.toContain("sitesolide members");
      expect(hint).not.toMatch(/\bsharing\b/);
    }
  });

  test("a refusal nobody foresaw gets the default, which forbids the workarounds", () => {
    expect(hintFor("something new went wrong")).toBe(DEFAULT_HINT);
  });
});
