/**
 * Preloaded by bunfig.toml before any test. `src/config.ts` freezes `DATA_DIR`
 * at first import: setting it in a test file would arrive too late, and the
 * tests would write into the real database of visits, the one that carries the
 * measurement of every site online.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", ".test-data");

// An empty database on every run, otherwise the counts vary.
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

process.env.DATA_DIR = DIR;
process.env.NODE_ENV = "test";

/**
 * The time zone is set explicitly.
 *
 * It cuts the days up, and so the visits and the salts. A test that left it to
 * the machine's would pass on the workstation, in Europe, and would fail on a
 * machine set elsewhere, or the day the VM changed time zone: that is exactly
 * the kind of failure one only understands after an hour.
 */
process.env.TIME_ZONE = "Europe/Paris";
