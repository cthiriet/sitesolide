import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideTake, type TakeAnswer } from "../cli/caddy-lock";
import { DEFAULT_HINT, HINTS, hintFor, hintForFailure, REMOTE_HINTS } from "../cli/hints";
import { PROJECT_PORTS_FILE } from "../cli/loopback";
import { confirmDoorUnderLock, decidePortal, guardDepositedManifest } from "../cli/portal-vm";
import { decideSecret } from "../cli/secrets";

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
    const secret = decideSecret({ name: "shop.env", onServer: false }, "https://dashboard.test-zone.invalid");
    if (secret.kind === "rejects") messages.push(secret.message);
    const unreadable = { kind: "unreadable", reason: "no answer" } as const;
    for (const decision of [
      decidePortal("shop", false, unreadable),
      confirmDoorUnderLock("shop", true, { kind: "present", portal: false }),
      guardDepositedManifest("shop", false, { kind: "present", portal: true }, "lock"),
      guardDepositedManifest("shop", true, { kind: "present", portal: false }, "domain"),
    ]) {
      if (decision.kind === "rejects") messages.push(decision.message);
    }
    expect(messages.length).toBe(7);
    expect(messages.filter((message) => hintFor(message) === DEFAULT_HINT)).toEqual([]);
  });

  test("the refusal of a folder nothing was recognised in, which the source words in two ways", () => {
    expect(hintFor("sitesolide.json not found in /code/notes, and none can be inferred")).toContain("by hand");
    expect(hintFor("nothing deployable recognised in /code/notes")).toContain("by hand");
  });

  test("the narrower patterns win: a refusal is never answered with a neighbour's hint", () => {
    expect(hintFor("sitesolide.json rejected once the portal set from the dashboard is applied")).toContain("keeping `portal`");
    expect(hintFor("sitesolide.json rejected")).toContain("docs/manifest.md");
    expect(hintFor("portal of shop changed from the dashboard during this deploy: run `sitesolide deploy` again")).toContain(
      "changed while deploy ran",
    );
  });

  test("a hint never tells an agent to force its way through", () => {
    for (const [, hint] of HINTS) {
      if (hint.includes("--force")) expect(hint).toMatch(/do not re-run with --force|--force only on the owner's/);
    }
    expect(DEFAULT_HINT).toContain("never work around");
  });

  test("a missing secret sends to the dashboard, never to the repository", () => {
    const hint = hintFor("secret missing on the server: /etc/sitesolide/shop.env");
    expect(hint).toContain("dashboard");
    expect(hint).toContain("never put secret values in the repository");
  });

  test("a refusal through the API is answered by its code, and never with --force", () => {
    expect(hintForFailure("no-dry-run", "deploy --dry-run is not available with a team token: nothing was sent")).toContain("without --dry-run");
    expect(hintForFailure("secret-missing", "/etc/sitesolide/shop.env missing")).toContain("never put secret values in the repository");
    // A code the table lacks falls back to what the message says.
    expect(hintForFailure("brand-new", "build failed: bun run build")).toBe(hintFor("build failed: bun run build"));
    for (const hint of Object.values(REMOTE_HINTS)) {
      if (hint.includes("--force")) expect(hint).toMatch(/do not re-run with --force/);
    }
    // The codes the installer stops on, as docs/team.md lists them.
    for (const code of ["install-failed", "secret-missing", "edited-by-hand", "system-unit", "caddy-busy", "bundle-refused", "service-failed", "verify-failed"]) {
      expect(Object.hasOwn(REMOTE_HINTS, code)).toBe(true);
    }
  });

  test("every refusal of share has its code's hint, whichever way it runs, and so has every code the API's sharing answers", () => {
    const source = readFileSync(join(import.meta.dir, "..", "cli", "sharing.ts"), "utf8");
    const codes = new Set([...source.matchAll(/error: "([a-z-]+)"/g)].map((match) => match[1]!));
    // Enough to be sure the scan reads the file.
    expect(codes.size).toBeGreaterThan(6);
    // What dashboard/src/control/api.ts answers on /api/v1/projects/<slug>/sharing, before and after the portal.
    for (const code of ["unauthenticated", "too-many-attempts", "not-found", "invalid", "too-large", "out-of-scope", "no-portal", "not-available", "failure", "unreachable", "unreadable"]) codes.add(code);
    expect([...codes].filter((code) => !Object.hasOwn(REMOTE_HINTS, code))).toEqual([]);
    expect(hintForFailure("no-portal", "kanban is not behind the portal")).toContain("Access section");
  });

  test("a refusal nobody foresaw gets the default, which forbids the workarounds", () => {
    expect(hintFor("something new went wrong")).toBe(DEFAULT_HINT);
  });
});
