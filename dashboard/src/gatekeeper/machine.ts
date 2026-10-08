/**
 * What the gatekeeper asks of the machine, and nothing more.
 *
 * An interface so that the transaction can be tested without a VM: the tests
 * give it a simulated machine that fails at the wanted step, or the real one,
 * on a throwaway tree in front of a test Caddy. The real one lives in
 * `real.ts`; this file carries only shapes, and the rule of the stale lock,
 * pure.
 */
import type { ProbeResponse } from "./probe";

/** Owner and mode of a file, which the gatekeeper preserves while rewriting it. */
export type Permissions = { uid: number; gid: number; mode: number };

export type ManifestRead = { text: string; permissions: Permissions };

/**
 * `output`: what a command said, already truncated, and already purged of the
 * values of /etc/caddy/cloudflare.env by the machine. Nothing else guarantees
 * their absence: the transaction quotes it in its messages.
 */
export type Command = { ok: boolean; output: string };

/**
 * The state from before the action, kept in memory and on disk until the end.
 * `locks` when the action touches the preview locks: the codes file and the
 * fragment, null for a missing one.
 */
export type Backup = { manifest: ManifestRead; block: string | null; locks?: { codes: string | null; fragment: string | null } };

/** Gives Caddy's lock back. Without effect if it is no longer this gatekeeper's. Never fails. */
export type Release = () => void;

/** What taking the lock returns: taken, or held by another since `since`. */
export type LockResult =
  | { kind: "taken"; release: Release }
  | { kind: "held"; who: string | null; since: number };

export type Machine = {
  now: () => number;
  wait: (ms: number) => Promise<void>;
  /** One line in the unit's log. Never a secret: the transaction handles none. */
  log: (line: string) => void;

  /**
   * Caddy's lock, common to the gatekeepers and to the workstation's tools:
   * only one action on Caddy at a time, across every site. A stale lock is
   * taken over, and the takeover logged.
   */
  takeLock: () => Promise<LockResult>;
  /**
   * The slug of an interrupted action whose backup has remained, or null. A
   * gatekeeper killed in the middle of a transaction leaves a configuration
   * that nobody knows whether it was validated.
   */
  interruptedTransaction: () => Promise<string | null>;
  saveBackup: (slug: string, backup: Backup) => Promise<void>;
  clearBackup: (slug: string) => Promise<void>;

  /** null: missing. Throws if the file is there but not readable without risk (link, not regular, too big). */
  readManifest: (slug: string) => Promise<ManifestRead | null>;
  readBlock: (slug: string) => Promise<string | null>;
  /** Atomic, owner and mode preserved. */
  writeManifest: (slug: string, text: string, permissions: Permissions) => Promise<void>;
  /** Atomic, root 0644 as bin/deploy-caddy.sh installs them. */
  writeBlock: (slug: string, text: string) => Promise<void>;
  removeBlock: (slug: string) => Promise<void>;

  /** `caddy validate` on the Caddyfile in place, with the environment systemd gives Caddy. */
  validateCaddy: (timeoutMs: number) => Promise<Command>;
  reloadCaddy: (timeoutMs: number) => Promise<Command>;
  /** Only for a restore that finds Caddy stopped. */
  startCaddy: (timeoutMs: number) => Promise<Command>;
  isCaddyActive: (timeoutMs: number) => Promise<boolean>;

  /** The directories of /srv/sites that serve something: a non-empty public/ or an active service. */
  servedSites: (timeoutMs: number) => Promise<string[]>;
  /**
   * `https://<host><path>`, resolved on the loopback, certificate verified.
   * `cookie`, a `name=value` pair sent as the request's only cookie: the code
   * of a site that opens with one.
   */
  probe: (host: string, path: string, timeoutMs: number, cookie?: string) => Promise<ProbeResponse>;

  /** Without waiting for the end of the reading: the dashboard will see it within the second. */
  restartCollector: (timeoutMs: number) => Promise<Command>;
};

/**
 * The preview locks, which a site's general access changes along with its
 * manifest and its block: what the gatekeeper asks of the machine for them.
 * The installer, which never changes a site's general access, mounts the
 * same machine and asks none of it.
 */
export type LockFiles = {
  /** `/etc/caddy/locks-codes.json`, null when missing. Throws if it is there but not readable without risk. */
  readCodes: () => Promise<string | null>;
  /**
   * The codes file, rewritten in place: the unit may write that one file of
   * /etc/caddy and create nothing beside it. Owner and mode kept; a missing
   * file is created 0600 for `owner` where the folder allows it.
   */
  writeCodes: (text: string, owner: { uid: number; gid: number } | null) => Promise<void>;
  /** `/etc/caddy/locks/verrous.caddy`, null when missing. */
  readLocksFragment: () => Promise<string | null>;
  /** Atomic, root 0644 as Caddy's other files. */
  writeLocksFragment: (text: string) => Promise<void>;
  removeLocksFragment: () => Promise<void>;
  /** Every directory of /srv/sites and its manifest's `lock`. Throws when one does not read. */
  readLockSites: () => Promise<{ slug: string; lock: unknown }[]>;
  /** `/srv/garde/<slug>/index.html`, null when missing. */
  readDoorPage: (slug: string) => Promise<string | null>;
  /** Atomic, 0644 in a 0755 folder, both given to `owner` when there is one. */
  writeDoorPage: (slug: string, text: string, owner: { uid: number; gid: number } | null) => Promise<void>;
};

/** The machine of a change of general access. */
export type GeneralMachine = Machine & LockFiles;

/**
 * Beyond that, a lock is stale whatever it says: no action on Caddy lasts that
 * long, neither the gatekeeper (TimeoutStartSec) nor a deployment from the
 * workstation. The clock is the machine's, which also writes the holder.
 */
export const STALE_LOCK_MS = 15 * 60 * 1000;

/** Who may hold the lock: the gatekeeper and the workstation's tools. */
export const HOLDERS = ["gatekeeper", "installer", "deploy-caddy", "lock", "deploy", "generate-domains", "deploy-gatekeeper"] as const;

/**
 * The content of `caddy.lock/holder`, one line:
 * `<who> <pid> <ms since the epoch>`, for example `deploy-caddy 4242 1789650000000`.
 */
export type Holder = { who: string; pid: number; a: number };

export function holderText(holder: Holder): string {
  return `${holder.who} ${holder.pid} ${holder.a}\n`;
}

/**
 * null if the line does not have the expected form. A `who` that is unknown but
 * well formed is accepted: one more tool must not make its lock pass for
 * unreadable, and the name ends up in a message, hence its bounded form.
 */
export function readHolder(text: string): Holder | null {
  const found = /^([a-z][a-z0-9-]{0,31}) ([1-9][0-9]{0,9}) ([0-9]{1,15})\n?$/.exec(text);
  if (found === null) return null;
  const pid = Number(found[2]);
  const a = Number(found[3]);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(a)) return null;
  return { who: found[1]!, pid, a };
}

export type LockJudgement = {
  kind: "held" | "stale";
  /** null: holder missing or unreadable. */
  holder: Holder | null;
  /** Since when it has been held, in ms, according to the machine's clock. */
  since: number;
  /** For the log, when it is stale. */
  reason: string;
};

/**
 * Can the lock found in place be taken over?
 *
 *   - the date is the holder's, or the directory's if it is unreadable or
 *     dated from the future: a lock with no readable holder is **held**, its
 *     author may still be writing, and it is only taken over once stale by the
 *     directory's date;
 *   - stale beyond `STALE_LOCK_MS`;
 *   - a gatekeeper's or an installer's lock whose process is dead is taken
 *     over straight away: killed by systemd, it gave nothing back. Both run on
 *     the machine, so their pid is theirs. `alive` returns true when in doubt,
 *     and a reused pid delays the takeover without ever hastening it. Not for
 *     the workstation's tools: their pid is that of one ssh command among
 *     others, dead well before the end of their action.
 *
 * Pure.
 */
export function judgeLock(
  text: string | null,
  folderModifiedAt: number,
  now: number,
  alive: (pid: number) => boolean,
): LockJudgement {
  const holder = text === null ? null : readHolder(text);
  const since = holder === null || holder.a > now ? folderModifiedAt : Math.min(holder.a, folderModifiedAt);
  if (now - since > STALE_LOCK_MS) {
    return { kind: "stale", holder, since, reason: "older than 15 minutes" };
  }
  if ((holder?.who === "gatekeeper" || holder?.who === "installer") && !alive(holder.pid)) {
    return { kind: "stale", holder, since, reason: `${holder.who} ${holder.pid} is gone` };
  }
  return { kind: "held", holder, since, reason: "" };
}
