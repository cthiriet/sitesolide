/**
 * The contract between the steward, which asks for a restore, and the restore
 * one-shot, which carries it out: the unit to start, the request it reads, the
 * result it leaves. Pure.
 *
 * **One template, the folder alone as the instance**, like the gatekeeper:
 *
 *   systemctl start --no-block sitesolide-restore@cms.service
 *
 * so that the unit writes only into `/srv/sites/%i`: a compromised restore
 * holds the one project it was named for. The snapshot cannot ride in the
 * name, which would break that bound; it rides in a request file the steward
 * writes, root's, 0600, in `/var/lib/sitesolide-backup/requests/<folder>.json`,
 * and that the restore consumes: read once, removed, and refused if it is more
 * than a few minutes old. A request nobody acted on does not wait for a later
 * start to replay it.
 *
 * The result lives in `/run/sitesolide-backup/restore/<folder>.json`, root's,
 * 0600 in a 0700 folder (a refused archive's message may quote a file name of
 * the project's data), rewritten at every phase: the page follows it by reading it
 * through the steward, since a restore can take longer than any request should
 * stay open.
 */
import { isBackupFolder, readSnapshotName } from "../../borrowed/backups";

export const RESTORE_PREFIX = "sitesolide-restore";
export const REQUESTS_NAME = "requests";
export const RESULTS_NAME = "restore";

/** A request older than this is not acted on: the page that sent it has long moved on. */
export const REQUEST_MAX_AGE_MS = 5 * 60 * 1000;
/** Nor one from the future beyond a clock's hesitation. */
const REQUEST_FUTURE_MS = 60 * 1000;
export const MAX_REQUEST_BYTES = 4096;
export const MAX_RESULT_BYTES = 8192;
export const MESSAGE_MAX = 400;

/** The unit for this folder, or null if the folder cannot go into a unit name. */
export function restoreUnit(folder: string): string | null {
  return isBackupFolder(folder) ? `${RESTORE_PREFIX}@${folder}.service` : null;
}

/** `%n` as systemd passes it, read back. Anything else is refused before reading or writing anything. */
export function readRestoreLaunch(argv: readonly string[]): { ok: true; folder: string } | { ok: false; reason: string } {
  if (argv.length !== 1) return { ok: false, reason: "expected exactly one argument, the unit name (%n)" };
  const found = /^sitesolide-restore@([^@/]+)\.service$/.exec(argv[0]!);
  if (found === null) return { ok: false, reason: "unexpected unit name, expected sitesolide-restore@<folder>.service" };
  if (!isBackupFolder(found[1])) return { ok: false, reason: "invalid folder in the unit name" };
  return { ok: true, folder: found[1]! };
}

/**
 * Who asked: an email, `owner` for the dashboard's password holder, a token's
 * id, as every component's audit records it. Bounded, and never anything that
 * could carry a value.
 */
export function isActor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 320 &&
    (value === "owner" || /^token:[A-Za-z0-9_-]{1,64}$/.test(value) || /^[^\s@"'<>\\]{1,64}@[A-Za-z0-9.-]{1,253}$/.test(value))
  );
}

export type RestoreRequest = { nonce: string; snapshot: string; actor: string; requestedAt: number };

export function encodeRequest(request: RestoreRequest): string {
  return `${JSON.stringify(request)}\n`;
}

/** The request read and judged, or the reason it is not acted on. */
export function readRequest(folder: string, text: string, now: number): { request: RestoreRequest } | { refusal: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { refusal: "the restore request is unreadable" };
  }
  if (typeof parsed !== "object" || parsed === null) return { refusal: "the restore request is unreadable" };
  const { nonce, snapshot, actor, requestedAt } = parsed as Record<string, unknown>;
  if (typeof nonce !== "string" || !/^[0-9a-f]{16}$/.test(nonce)) return { refusal: "the restore request is unreadable" };
  if (typeof snapshot !== "string" || readSnapshotName(folder, snapshot) === null) return { refusal: "the restore request names no snapshot of this site" };
  if (!isActor(actor)) return { refusal: "the restore request names no valid requester" };
  if (typeof requestedAt !== "number" || !Number.isFinite(requestedAt)) return { refusal: "the restore request is unreadable" };
  if (now - requestedAt > REQUEST_MAX_AGE_MS) return { refusal: "the restore request is too old, start it again from the dashboard" };
  if (requestedAt - now > REQUEST_FUTURE_MS) return { refusal: "the restore request is dated in the future" };
  return { request: { nonce, snapshot, actor, requestedAt } };
}

export type RestoreState = "running" | "ok" | "failure" | "rejects";

export type RestoreResult = {
  nonce: string | null;
  state: RestoreState;
  /** What is happening or happened, in English, for the page. */
  message: string;
  snapshot: string | null;
  /** The snapshot of the data the restore replaced, which undoes it. */
  preRestore: string | null;
  actor: string | null;
  startedAt: number;
  at: number;
};

/** A message fit for the page: one line, bounded. */
export function pageMessage(message: string): string {
  const line = message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return line.length > MESSAGE_MAX ? `${line.slice(0, MESSAGE_MAX - 3)}...` : line;
}

export type ResultFile = { info: { uid: number; mode: number; regular: boolean }; bytes: Uint8Array | null } | null;

/**
 * The result as the steward reads it. Nothing counts by default: a file that is
 * not root's, that other accounts could rewrite, or that does not read, says
 * nothing, and the page says the result is unknown.
 */
export function judgeResult(file: ResultFile, uidRoot: number | null): RestoreResult | { unreadable: string } | null {
  if (file === null) return null;
  if (!file.info.regular || file.bytes === null) return { unreadable: "the restore's result is not a plain file" };
  if (uidRoot !== null && file.info.uid !== uidRoot) return { unreadable: "the restore's result is not owned by root" };
  if ((file.info.mode & 0o022) !== 0) return { unreadable: "the restore's result is writable by other accounts" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes));
  } catch {
    return { unreadable: "the restore's result is unreadable" };
  }
  if (typeof parsed !== "object" || parsed === null) return { unreadable: "the restore's result is unreadable" };
  const r = parsed as Record<string, unknown>;
  const states: RestoreState[] = ["running", "ok", "failure", "rejects"];
  const textOrNull = (value: unknown) => value === null || typeof value === "string";
  if (
    !states.includes(r.state as RestoreState) ||
    typeof r.message !== "string" ||
    !textOrNull(r.nonce) ||
    !textOrNull(r.snapshot) ||
    !textOrNull(r.preRestore) ||
    !textOrNull(r.actor) ||
    typeof r.startedAt !== "number" ||
    typeof r.at !== "number"
  ) {
    return { unreadable: "the restore's result is unreadable" };
  }
  return {
    nonce: r.nonce as string | null,
    state: r.state as RestoreState,
    message: pageMessage(r.message),
    snapshot: r.snapshot as string | null,
    preRestore: r.preRestore as string | null,
    actor: r.actor as string | null,
    startedAt: r.startedAt,
    at: r.at,
  };
}
