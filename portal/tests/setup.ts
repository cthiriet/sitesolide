/**
 * Preloaded by bunfig.toml before any test. `src/config.ts` freezes DATA_DIR
 * at the first import: setting the variable in a test file comes too late if
 * another file has already loaded the configuration.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", ".attempts");
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

process.env.DATA_DIR = DIR;
process.env.NODE_ENV = "test";

// A test must be worth the same on the workstation, where the hash may
// be lying around in the environment, and elsewhere.
delete process.env.PASSWORD_HASH;
