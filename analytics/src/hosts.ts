/**
 * The hosts this service accepts, and the site each one belongs to.
 *
 * **This service cannot know the other sites on the machine**, and that is
 * deliberate: its systemd unit replaces `/srv` with an empty mount where only
 * its own directories are re-exposed, and `/etc/caddy/domaines.map` is no more
 * accessible to it. It can therefore neither read the manifests dropped at the
 * root of the other projects, nor know which domain serves which directory.
 *
 * The dashboard's collector, for its part, knows all of that: it runs as root
 * once a minute, walks `/srv/sites` and reads the domain table. It therefore
 * drops the mapping here, host to served directory, and this file is
 * ingestion's only door.
 *
 * Two consequences that read in the dashboard rather than in the code:
 *
 * - **a deployed site is measurable with no gesture at all.** There is no form
 *   any more, no declaration to make, no list to keep up to date;
 * - **a missing file refuses everything.** A service started before the
 *   collector's first pass writes nothing, rather than accepting everything:
 *   it is the same refusal as that of a missing key elsewhere in the
 *   repository.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config";

/** Dropped by `dashboard/collector.ts`, rewritten on every pass. */
export const HOSTS_FILE = join(DATA_DIR, "hotes.json");

/**
 * Minimum delay between two checks of the file's date.
 *
 * The collector passes every minute; asking the disk on every page view would
 * teach nothing more and would add a system call on the hottest path of the
 * service. Five seconds let a page view arrive at worst five seconds after its
 * host became measurable.
 */
export const REREAD_STEP_MS = 5_000;

type Table = Readonly<Record<string, string>>;

let table: Table = {};
let readDate = -1;
let nextCheck = 0;

/**
 * Reads the file again if it has changed.
 *
 * The modification date decides: reading an unchanged file again on every page
 * view would cost one disk read per page view of every site on the machine. A
 * read error keeps the previous table rather than refusing everything, a file
 * being rewritten not having to stop the measurement; the collector moreover
 * writes by renaming, which is atomic.
 */
function reload(now: number): void {
  if (now < nextCheck) return;
  nextCheck = now + REREAD_STEP_MS;

  let date: number;
  try {
    date = statSync(HOSTS_FILE).mtimeMs;
  } catch {
    // Missing: no host is accepted, and that is the right refusal.
    table = {};
    readDate = -1;
    return;
  }

  if (date === readDate) return;

  try {
    // A synchronous read, assumed: it only happens when the file changes, so
    // once a minute at most, and ingestion decides on the spot. `Bun.file`
    // would return a promise that would have to be awaited in the middle of the
    // hottest path of the service.
    const raw = JSON.parse(readFileSync(HOSTS_FILE, "utf8")) as {
      hosts?: Record<string, string>;
    };
    table = raw.hosts ?? {};
    readDate = date;
  } catch {
    // Truncated or malformed file: we keep what we had. The collector writes by
    // renaming, which is atomic, but a full disk or an interrupted reading
    // would leave something other than a whole JSON document.
  }
}

/**
 * The site a host belongs to, or null if it is not served.
 *
 * `now` is given rather than read: that is what makes the re-read
 * testable without waiting five seconds.
 */
export function siteOf(host: string, now: number): string | null {
  reload(now);
  return table[host] ?? null;
}

/** The table in force, for the snapshot and the tests. */
export function knownHosts(now: number): Table {
  reload(now);
  return table;
}

/** Forgets what has been read. Exists only for the tests. */
export function forget(): void {
  table = {};
  readDate = -1;
  nextCheck = 0;
}
