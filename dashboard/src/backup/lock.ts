/**
 * One act on the backups at a time: a run, which writes and prunes snapshots,
 * and a restore, which reads one and writes another, never overlap. Retention
 * therefore never deletes the archive a restore is extracting, and two restores
 * never swap the same folder.
 *
 * The same shape as the Caddy lock (src/gatekeeper/real.ts): a directory,
 * created by a non-recursive `mkdir` that only one candidate wins, with a
 * `holder` file saying who and since when. A holder whose process is dead is
 * taken over at once, by renaming the directory aside, which only one taker
 * can do. Both holders are root processes of this machine, so a pid is enough.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LOCK_NAME = "lock";
export const HOLDER_NAME = "holder";

export type Holder = { who: string; pid: number; since: number };

export type Taken = { ok: true; release: () => void } | { ok: false; holder: Holder | null };

/** True if the process exists. `EPERM` means it does, under another identity. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

export function readHolder(text: string): Holder | null {
  const parts = /^([a-z-]+) ([0-9]+) ([0-9]+)$/.exec(text.trim());
  if (parts === null) return null;
  return { who: parts[1]!, pid: Number(parts[2]), since: Number(parts[3]) };
}

/**
 * A lock whose holder cannot be read is taken over only once it is older than
 * this: it may be a taker between its `mkdir` and its write of `holder`.
 */
export const UNREADABLE_STALE_MS = 60_000;

export function takeLock(runFolder: string, who: string, alive: (pid: number) => boolean = isAlive, now: () => number = Date.now): Taken {
  const path = join(runFolder, LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      let holder: Holder | null = null;
      let age = 0;
      try {
        holder = readHolder(readFileSync(join(path, HOLDER_NAME), "utf8"));
      } catch {
        holder = null;
      }
      try {
        age = now() - statSync(path).mtimeMs;
      } catch {
        // Gone in the meantime: the next attempt takes it.
        continue;
      }
      const stale = holder === null ? age > UNREADABLE_STALE_MS : !alive(holder.pid);
      if (!stale) return { ok: false, holder };
      const aside = `${path}.stale-${process.pid}-${now()}`;
      try {
        renameSync(path, aside);
      } catch {
        // Another taker set it aside first; it is theirs now, or free.
        continue;
      }
      rmSync(aside, { recursive: true, force: true });
      continue;
    }

    const mine = `${who} ${process.pid} ${now()}`;
    writeFileSync(join(path, HOLDER_NAME), `${mine}\n`, { mode: 0o600 });
    return {
      ok: true,
      release: () => {
        try {
          // Only our own: a lock taken over meanwhile belongs to someone else.
          if (readFileSync(join(path, HOLDER_NAME), "utf8").trim() === mine) rmSync(path, { recursive: true, force: true });
        } catch {
          // already gone
        }
      },
    };
  }
  return { ok: false, holder: null };
}

/** Waits for the lock, polling, up to `waitMs`. */
export async function waitForLock(
  runFolder: string,
  who: string,
  waitMs: number,
  stepMs = 5000,
  alive: (pid: number) => boolean = isAlive,
): Promise<Taken> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const taken = takeLock(runFolder, who, alive);
    if (taken.ok || Date.now() + stepMs > deadline) return taken;
    await Bun.sleep(stepMs);
  }
}
