import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sentModesCommand } from "../sitesolide";

/**
 * The modes a deployment sets on what it sent, run here as the deployment
 * account runs it on the machine: a plain shell, `find` and `chmod`.
 *
 * rsync -a carries a repository's links as links, and a cloned repository
 * chooses them: `app/notes -> /home/deploy/.ssh/id_ed25519`. chmod follows a
 * link it is given, so the command made the deployment account's own files,
 * which it owns, readable by every account of the machine.
 */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the modes of what a deployment sent", () => {
  test("are set on the files sent, never through a link to a file of the account's elsewhere", () => {
    const root = mkdtempSync(join(tmpdir(), "sent-modes-"));
    roots.push(root);
    const outside = join(root, "home", ".ssh", "id_ed25519");
    mkdirSync(join(root, "home", ".ssh"), { recursive: true });
    writeFileSync(outside, "a private key");
    chmodSync(outside, 0o600);
    const app = join(root, "app");
    mkdirSync(app);
    writeFileSync(join(app, "server.ts"), "Bun.serve({})");
    chmodSync(join(app, "server.ts"), 0o600);
    symlinkSync(outside, join(app, "notes"));

    const ran = Bun.spawnSync(["sh", "-c", sentModesCommand(app)]);
    expect(ran.exitCode).toBe(0);
    expect(statSync(join(app, "server.ts")).mode & 0o777).toBe(0o644);
    expect(statSync(outside).mode & 0o777).toBe(0o600);
  });
});
