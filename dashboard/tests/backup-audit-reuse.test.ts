/**
 * A project removed, and another created later under its name: what the
 * backup component does on its own.
 *
 * `sitesolide remove` takes the folder, the secrets, their previous versions,
 * the account, and has the steward release the name (bin/cli/removal.ts).
 * The snapshots of the removed project stay in the repository, under
 * `/<folder>.tar`, the newest kept whatever its age (retention.ts). This
 * component knows a project by its folder alone: asked to restore a snapshot
 * of `shop`, it restores it into whatever `shop` is now, its predecessor's
 * data included. It has no way to tell the two apart, nothing on the machine
 * saying when a folder changed hands, and it does not try.
 *
 * So the guard is upstream, where a name changes hands: a token creates no
 * project under a name the backups' index still holds snapshots of, nor one
 * a connector is still granted to (src/control/steward.ts, `judgeDeployment`;
 * src/control/policy.ts, `leftoversReason`), proved in
 * tests/control-creations.test.ts, "a name a removed project left things
 * under is never a token's creation". The owner's own deployment over SSH
 * still may, which is how a removed project is brought back with its data.
 *
 * This test keeps the component's side on record: a restore hands a folder's
 * snapshots to whoever holds the folder now. Anything else that one day gives
 * a removed project's name to someone new, a rename, another way to create,
 * needs the same guard as the steward's.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshotName } from "../borrowed/backups";
import { encodeRequest } from "../src/backup/request";
import { restore, type Command } from "../src/backup/restore";
import { runBackups } from "../src/backup/run";
import { NO_RESTIC, project, tree } from "./backup-fixtures";

setDefaultTimeout(120_000);

const HOUR = 3_600_000;
const T = Date.UTC(2026, 9, 4, 13, 0, 0);
const silent = () => undefined;
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** systemd as the restore sees it: one unit, loaded, that stops and starts and stays running. */
async function systemctl(args: string[]): Promise<Command> {
  const [verb] = args;
  if (verb === "show" && args.includes("LoadState") && args.includes("--value")) return { code: 0, output: "loaded\n" };
  if (verb === "show") return { code: 0, output: "LoadState=loaded\nActiveState=active\nSubState=running\nNRestarts=0\nActiveEnterTimestamp=Sun 2026-10-04 13:00:00.000000 UTC\n" };
  if (verb === "is-active") return { code: 0, output: "inactive\n" };
  return { code: 0, output: "" };
}

describe.skipIf(NO_RESTIC)("a project created again under a removed project's name", () => {
  test("is handed its predecessor's data by a restore: the component judges the folder alone, the steward who holds it", async () => {
    const { root, sites, config } = tree();
    roots.push(root);
    const first = project(sites, "shop");
    writeFileSync(join(first, "customers.csv"), "the first shop's customers");
    const run = await runBackups({ config, now: () => T - 2 * HOUR, log: silent });
    expect(run.projects.shop?.ok).toBe(true);
    const predecessor = snapshotName("shop", T - 2 * HOUR, "scheduled");

    // `sitesolide remove shop`: the folder goes, the snapshots stay.
    rmSync(join(sites, "shop"), { recursive: true, force: true });
    // `shop` laid again, which the steward now lets the owner alone do, over
    // SSH; whoever is then its Admin asks for the restore.
    const fresh = project(sites, "shop", { start: "bun run other.ts" });
    writeFileSync(join(fresh, "notes.txt"), "the new shop's own data");

    mkdirSync(join(config.stateFolder, "requests"), { recursive: true });
    writeFileSync(
      join(config.stateFolder, "requests", "shop.json"),
      encodeRequest({ nonce: "0123456789abcdef", snapshot: predecessor, actor: "admin@test-zone.invalid", requestedAt: T }),
      { mode: 0o600 },
    );
    let now = T;
    const result = await restore({ config, now: () => now, wait: async (ms) => void (now += ms), log: silent, systemctl }, "shop");

    // What the new project's code can now read: the removed project's data.
    // Only the owner's own deployment reaches this point now: no token
    // creates `shop` while this snapshot is in the index.
    const handed = existsSync(join(fresh, "customers.csv")) ? readFileSync(join(fresh, "customers.csv"), "utf8") : null;
    expect({ state: result.state, handed }).toEqual({ state: "ok", handed: "the first shop's customers" });
  });
});
