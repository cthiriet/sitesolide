/**
 * Preloaded by bunfig.toml before any test. `src/config.ts` freezes DATA_DIR on
 * first import: setting the variable inside a test file comes too late if
 * another file has already loaded the configuration, and the tests would then
 * write into the production service's database, sessions included.
 *
 * The tests concerned check it at the top of the file rather than trusting this
 * preload.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const FOLDER = join(import.meta.dir, "..", ".test-data");

// Emptied on every run, otherwise the counts vary from one test to the next.
rmSync(FOLDER, { recursive: true, force: true });
mkdirSync(FOLDER, { recursive: true });

process.env.DATA_DIR = FOLDER;
process.env.NODE_ENV = "test";

/**
 * The test zone, frozen like DATA_DIR and for the same reason:
 * `SITESOLIDE_ZONE` decides which directory the landing serves, and a test that
 * took the workstation's own would be worth something else on another machine.
 */
process.env.SITESOLIDE_ZONE = "test-zone.invalid";

/**
 * The password hash and the public address are removed: a test has to be
 * worth the same thing on the author's workstation, which may have them in its
 * environment, and in CI where they do not exist.
 */
for (const variable of ["PASSWORD_HASH", "PUBLIC_URL", "STATE_FILE"]) {
  delete process.env[variable];
}
