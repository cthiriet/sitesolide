/**
 * The installer's result, judged by whoever reads it: the steward, which
 * relays it to the dashboard.
 *
 * The same stance as the gatekeeper's result (src/secrets/portal.ts):
 * **nothing counts as success by default.** A file that is not root's, that
 * other accounts could rewrite, that does not read, or that names another
 * deployment says that the installer has not spoken, and the deployment is not
 * reported as succeeded on its strength.
 *
 * Pure.
 */
import type { Examination } from "../secrets/system";
import { DEPLOYMENT_ID_SHAPE, MAX_LOG_LINE, MAX_LOG_LINES, type InstallerResult } from "./protocol";
import { isValidSlug } from "../../borrowed/manifest";

export type ResultJudgement = { kind: "absent" } | { kind: "read"; result: InstallerResult } | { kind: "unreadable"; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isDate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** A line the page and a terminal can show as it stands: bounded, without control characters. */
export function cleanLine(line: string): string {
  // Tabs become spaces; every other control character, an escape sequence
  // included, is dropped: a log line must not repaint a terminal.
  const clean = line.replace(/\t/g, "  ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return clean.length > MAX_LOG_LINE ? `${clean.slice(0, MAX_LOG_LINE - 3)}...` : clean;
}

/** The result's text, read, for the deployment the caller expects. */
export function readResult(text: string, deployment: string): ResultJudgement {
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    return { kind: "unreadable", reason: "the installer's result is not JSON" };
  }
  if (!isObject(object)) return { kind: "unreadable", reason: "the installer's result is not an object" };
  const { slug, state, startedAt, updatedAt, finishedAt, log, error, url, allocated } = object;
  if (object.deployment !== deployment) return { kind: "unreadable", reason: "the installer's result names another deployment" };
  if (typeof slug !== "string" || !isValidSlug(slug)) return { kind: "unreadable", reason: "the installer's result names no project" };
  if (state !== "running" && state !== "succeeded" && state !== "failed") {
    return { kind: "unreadable", reason: "the installer's result has no state" };
  }
  if (!isDate(startedAt) || !isDate(updatedAt) || !(finishedAt === null || isDate(finishedAt))) {
    return { kind: "unreadable", reason: "the installer's result has malformed dates" };
  }
  if (!Array.isArray(log) || !log.every((line) => typeof line === "string")) {
    return { kind: "unreadable", reason: "the installer's result has a malformed log" };
  }
  if (error !== null && !(isObject(error) && typeof error.code === "string" && typeof error.message === "string")) {
    return { kind: "unreadable", reason: "the installer's result has a malformed error" };
  }
  if (url !== null && typeof url !== "string") return { kind: "unreadable", reason: "the installer's result has a malformed address" };
  if (
    !Array.isArray(allocated) ||
    !allocated.every((entry) => isObject(entry) && (entry.service === null || typeof entry.service === "string") && Number.isInteger(entry.port))
  ) {
    return { kind: "unreadable", reason: "the installer's result has malformed ports" };
  }
  // A failure must say why, and a success must not carry an error.
  if (state === "failed" && error === null) return { kind: "unreadable", reason: "the installer's result fails without a reason" };
  return {
    kind: "read",
    result: {
      deployment,
      slug,
      state,
      startedAt,
      updatedAt,
      finishedAt,
      log: (log as string[]).slice(-MAX_LOG_LINES).map(cleanLine),
      error: error === null ? null : { code: cleanLine((error as { code: string }).code).slice(0, 64), message: cleanLine((error as { message: string }).message) },
      url: url as string | null,
      allocated: allocated as InstallerResult["allocated"],
    },
  };
}

/**
 * The file as the steward found it. `uidRoot` null: no owner check, for a test
 * on the workstation; the mode is always checked.
 */
export function judgeResult(examination: Examination, deployment: string, uidRoot: number | null): ResultJudgement {
  if (!DEPLOYMENT_ID_SHAPE.test(deployment)) return { kind: "unreadable", reason: "not a deployment id" };
  if (examination.kind === "absent") return { kind: "absent" };
  const { info, bytes } = examination;
  if (bytes === null) return { kind: "unreadable", reason: "the installer's result is not a plain file" };
  if (uidRoot !== null && info.uid !== uidRoot) return { kind: "unreadable", reason: "the installer's result is not owned by root" };
  if ((info.mode & 0o022) !== 0) return { kind: "unreadable", reason: "the installer's result is writable by other accounts" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "unreadable", reason: "the installer's result is not UTF-8" };
  }
  return readResult(text, deployment);
}

/**
 * A result that still says `running` while its unit is no longer active: the
 * installer was killed (its delay, its memory, a reboot) and will never write
 * again. Reported as the failure it is, with what to look at.
 */
export function interrupted(result: InstallerResult, now: number): InstallerResult {
  return {
    ...result,
    state: "failed",
    finishedAt: now,
    error: {
      code: "interrupted",
      message: `the installer stopped before finishing: the project may be half deployed; deploy again, and if it fails the same way ask the owner of the machine to read journalctl -u sitesolide-installer@${result.slug}`,
    },
  };
}
