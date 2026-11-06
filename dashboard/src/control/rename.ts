/**
 * What the steward does around a rename on the machine: the request it
 * writes, the result it trusts, and its own registries re-keyed once the
 * machine is renamed, the tokens' ownerships, scopes and claims. The people
 * with access move in src/access/registry.ts, `renameProject`.
 *
 * Pure.
 */
import type { Examination } from "../secrets/system";
import type { Claims } from "./claims";
import type { LifecycleResult, RenameResult } from "./protocol";
import type { Team } from "./tokens";

/** The tokens' registry under the new name: the token that created the project still owns it, every scope that named it names the new one. */
export function renameInTeam(team: Team, from: string, to: string): Team | null {
  const owned = Object.hasOwn(team.owners, from);
  const scoped = team.tokens.some((token) => token.scope.slugs.includes(from));
  if (!owned && !scoped) return null;
  const owners: Record<string, string> = {};
  for (const [slug, id] of Object.entries(team.owners)) owners[slug === from ? to : slug] = id;
  const tokens = team.tokens.map((token) =>
    token.scope.slugs.includes(from) ? { ...token, scope: { ...token.scope, slugs: [...new Set(token.scope.slugs.map((slug) => (slug === from ? to : slug)))] } } : token,
  );
  return { ...team, owners, tokens };
}

/** The tokens' claims under the new name, null when none named the old one. */
export function renameInClaims(claims: Claims, from: string, to: string): Claims | null {
  if (!Object.hasOwn(claims, from)) return null;
  const next: Claims = {};
  for (const [slug, claim] of Object.entries(claims)) next[slug === from ? to : slug] = claim;
  return next;
}

export type RenameJudgement = { kind: "read"; result: RenameResult } | { kind: "absent" } | { kind: "unreadable"; reason: string };

/**
 * The run's result, trusted only as root wrote it, for this rename: another
 * run's, an earlier request's above all, is no answer to this one.
 */
export function judgeRenameResult(examination: Examination, slug: string, requestedAt: number, uidRoot: number | null): RenameJudgement {
  if (examination.kind === "absent") return { kind: "absent" };
  const { info, bytes } = examination;
  if (bytes === null) return { kind: "unreadable", reason: "the rename's result is not a plain file" };
  if (uidRoot !== null && info.uid !== uidRoot) return { kind: "unreadable", reason: "the rename's result is not owned by root" };
  if ((info.mode & 0o022) !== 0) return { kind: "unreadable", reason: "the rename's result is writable by other accounts" };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { kind: "unreadable", reason: "the rename's result does not read" };
  }
  const result = value as Partial<RenameResult> | null;
  if (result === null || typeof result !== "object" || result.slug !== slug || typeof result.to !== "string") return { kind: "unreadable", reason: "the rename's result names another project" };
  if (result.requestedAt !== requestedAt) return { kind: "absent" };
  if (result.state !== "running" && result.state !== "succeeded" && result.state !== "failed") return { kind: "unreadable", reason: "the rename's result has no state" };
  if (!Array.isArray(result.log) || !result.log.every((line) => typeof line === "string")) return { kind: "unreadable", reason: "the rename's result has no log" };
  return { kind: "read", result: result as RenameResult };
}

export type LifecycleJudgement = { kind: "read"; result: LifecycleResult } | { kind: "absent" } | { kind: "unreadable"; reason: string };

/** The lifecycle run's result, trusted as a rename's is: root's, for this request. */
export function judgeLifecycleResult(examination: Examination, slug: string, requestedAt: number, uidRoot: number | null): LifecycleJudgement {
  if (examination.kind === "absent") return { kind: "absent" };
  const { info, bytes } = examination;
  if (bytes === null) return { kind: "unreadable", reason: "the result is not a plain file" };
  if (uidRoot !== null && info.uid !== uidRoot) return { kind: "unreadable", reason: "the result is not owned by root" };
  if ((info.mode & 0o022) !== 0) return { kind: "unreadable", reason: "the result is writable by other accounts" };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { kind: "unreadable", reason: "the result does not read" };
  }
  const result = value as Partial<LifecycleResult> | null;
  if (result === null || typeof result !== "object" || result.slug !== slug) return { kind: "unreadable", reason: "the result names another project" };
  if (result.requestedAt !== requestedAt) return { kind: "absent" };
  if (result.state !== "running" && result.state !== "succeeded" && result.state !== "failed") return { kind: "unreadable", reason: "the result has no state" };
  if (!Array.isArray(result.log) || !result.log.every((line) => typeof line === "string")) return { kind: "unreadable", reason: "the result has no log" };
  return { kind: "read", result: result as LifecycleResult };
}
