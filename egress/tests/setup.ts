/**
 * Preloaded by bunfig.toml before any test. `src/config.ts` freezes its paths
 * at first import: setting them in a test file would arrive too late, and a
 * test would read the machine's connectors or write into the proxy's real
 * audit database.
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", ".test-data");

// An empty directory on every run, otherwise the counts vary.
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

process.env.DATA_DIR = DIR;
process.env.CONFIG_DIR = join(DIR, "config");
process.env.SITES_DIR = join(DIR, "sites");
process.env.NODE_ENV = "test";
