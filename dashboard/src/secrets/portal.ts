/**
 * Putting a site's portal up or taking it away: what the steward asks of the
 * gatekeeper, and what it believes of its answer.
 *
 * The steward never touches Caddy. It launches the unit
 * `sitesolide-gatekeeper-on@<slug>.service` or `sitesolide-gatekeeper-off@<slug>.service`,
 * which validates the whole configuration, reloads, checks the site and
 * restores the previous state at the slightest failure, then it reads the
 * result the gatekeeper leaves in `/run/sitesolide-gatekeeper/<slug>.json`. The
 * action is in the name of the template and not in the instance: each unit
 * thereby writes only its own site's directory. The rule of what is modifiable
 * belongs to the gatekeeper (src/gatekeeper/rules.ts), which the steward reads
 * before launching it.
 *
 * The gatekeeper also refuses when Caddy is already being changed, from the
 * workstation or by another action: it then writes a `refusal` result that says
 * so, which the steward relays like any refusal, in 409.
 *
 * Pure: an examination of the file and the time of the launch come in, a
 * result comes out. **Nothing counts as success by default**: a file that is
 * missing, unreadable, badly protected or older than the launch says that the
 * gatekeeper has not spoken, and that is a failure.
 */
import { gatekeeperUnit } from "../gatekeeper/instance";
import type { Examination } from "./system";

/** The directory where the gatekeeper writes its results, root 0755, one 0644 file per site. */
export const GATEKEEPER_FOLDER = "/run/sitesolide-gatekeeper";

/**
 * Under `GATEKEEPER_FOLDER/sauvegardes/<slug>` (src/gatekeeper/instance.ts), the
 * gatekeeper keeps the manifest and the block from before during its
 * transaction, and erases them once the site is back to a known state.
 *
 * What the page says when a backup remains from an interrupted gatekeeper: the
 * block in service may be the old one, the new one, or neither, and `installed`
 * is worth nothing any more.
 */
export const INTERRUPTED_TRANSACTION_REASON = "an interrupted portal change left this site in an unknown state: check Caddy on the server";

/** While the steward waits for this site's gatekeeper, its backup is normal. */
export const TRANSACTION_IN_PROGRESS_REASON = "a portal change is in progress for this site";

/**
 * The gatekeeper refuses every action, on every site, as long as a backup
 * remains (`interruptedTransaction` of src/gatekeeper/real.ts takes the first
 * one): the page says so on each site, rather than offering a button that would
 * end in a refusal.
 */
export function backupElsewhereReason(other: string, inProgress: boolean): string {
  return inProgress
    ? `a portal change is in progress for ${other}: try again in a moment`
    : `an interrupted portal change on ${other} blocks portal changes on every site: check Caddy on the server`;
}

/**
 * What `systemctl start` may take, under `MAX_PORTAL_MS`: the margin
 * leaves the steward the time to read the result, to re-read the site and to
 * answer before the relay stops waiting.
 */
export const GATEKEEPER_MARGIN_MS = 5_000;

/** A bigger result is not the gatekeeper's. */
export const MAX_RESULT_BYTES = 4096;

/** A longer message does not fit under a button. */
export const MESSAGE_MAX = 300;

export type ResultKind = "ok" | "rejects" | "failure";

export type GatekeeperResult = { result: ResultKind; message: string };

/**
 * The gatekeeper's unit for this action, or null if the slug cannot go into it.
 * The name belongs to the contract that src/gatekeeper/instance.ts holds, which
 * the gatekeeper re-reads at its launch: it is not copied here.
 */
export function gatekeeperUnitOf(active: boolean, slug: string): string | null {
  return gatekeeperUnit(slug, active);
}

const DEFAULTS: Record<ResultKind, string> = {
  ok: "done",
  rejects: "the gatekeeper refused the change",
  failure: "the gatekeeper failed, the previous state should be back",
};

const failure = (message: string): GatekeeperResult => ({ result: "failure", message });

/**
 * The gatekeeper's result, judged.
 *
 * `uidRoot` null: no check of the owner, for a test on the workstation. The
 * mode is always checked: a file that other accounts could rewrite would make
 * the dashboard say what they wanted.
 */
export function judgeGatekeeperResult(examination: Examination, launch: number, uidRoot: number | null): GatekeeperResult {
  if (examination.kind === "absent") return failure("the gatekeeper left no result, it may not have run");
  const { info, bytes } = examination;
  if (bytes === null) return failure("the gatekeeper's result is not a plain file");
  if (uidRoot !== null && info.uid !== uidRoot) return failure("the gatekeeper's result is not owned by root");
  if ((info.mode & 0o022) !== 0) return failure("the gatekeeper's result is writable by other accounts");

  let object: unknown;
  try {
    object = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return failure("the gatekeeper's result is unreadable");
  }
  if (typeof object !== "object" || object === null || Array.isArray(object)) return failure("the gatekeeper's result is unreadable");
  const { a, result, message, requested, installed } = object as Record<string, unknown>;
  if (
    typeof a !== "number" ||
    !Number.isFinite(a) ||
    (result !== "ok" && result !== "rejects" && result !== "failure") ||
    typeof message !== "string" ||
    typeof requested !== "boolean" ||
    typeof installed !== "boolean"
  ) {
    return failure("the gatekeeper's result is unreadable");
  }
  // A result from before the launch is that of a previous action: this
  // request's gatekeeper wrote nothing.
  if (a < launch) return failure("no fresh result from the gatekeeper, it may not have run");

  // The message is displayed as it stands: bounded, and with no control character.
  const readable = message.length > 0 && message.length <= MESSAGE_MAX && !/[\u0000-\u001f\u007f]/.test(message);
  return { result, message: readable ? message : DEFAULTS[result] };
}
