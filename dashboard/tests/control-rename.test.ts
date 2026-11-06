import { describe, expect, test } from "bun:test";
import { EMPTY_REGISTRY, entriesOf, putEntry, renameProject } from "../src/access/registry";
import { judgeRenameResult, renameInClaims, renameInTeam } from "../src/control/rename";
import type { Claims } from "../src/control/claims";
import type { Team, TokenRecord } from "../src/control/tokens";
import type { Examination } from "../src/secrets/system";

const SCOPE = { create: false, outbound: false, domain: false, public: false, secrets: false };

function token(id: string, slugs: string[]): TokenRecord {
  return { id, label: id, email: "owner", createdAt: 1, expiresAt: null, revokedAt: null, lastUsedAt: null, scope: { ...SCOPE, slugs }, hash: "h" } as unknown as TokenRecord;
}

describe("the steward's registries follow a rename", () => {
  test("the token that created the project still owns it, every scope reaches the new name", () => {
    const team: Team = { version: 2, owners: { nis2: "aaaaaaaaaaaa", blog: "bbbbbbbbbbbb" }, tokens: [token("aaaaaaaaaaaa", ["nis2", "blog"]), token("cccccccccccc", ["blog"])] };
    const renamed = renameInTeam(team, "nis2", "cybersolide")!;
    expect(renamed.owners).toEqual({ cybersolide: "aaaaaaaaaaaa", blog: "bbbbbbbbbbbb" });
    expect(renamed.tokens.map((record) => record.scope.slugs)).toEqual([["cybersolide", "blog"], ["blog"]]);
    expect(renameInTeam(team, "shop", "store")).toBeNull();
  });

  test("a claim moves to the new name", () => {
    const claims = { nis2: { token: "aaaaaaaaaaaa" } } as unknown as Claims;
    expect(Object.keys(renameInClaims(claims, "nis2", "cybersolide")!)).toEqual(["cybersolide"]);
    expect(renameInClaims(claims, "blog", "journal")).toBeNull();
  });

  test("the people with access keep their roles under the new name", () => {
    const put = putEntry(EMPTY_REGISTRY, "nis2", "ada@test-zone.invalid", "admin", "owner", 1);
    if ("refusal" in put) throw new Error(put.refusal);
    const { registry, moved } = renameProject(put.registry, "nis2", "cybersolide");
    expect(moved).toBe(1);
    expect(entriesOf(registry, "nis2")).toEqual([]);
    expect(entriesOf(registry, "cybersolide").map((entry) => [entry.who, entry.role])).toEqual([["ada@test-zone.invalid", "admin"]]);
  });
});

describe("the rename's result", () => {
  const result = { slug: "nis2", to: "cybersolide", requestedAt: 42, state: "succeeded", startedAt: 1, finishedAt: 2, log: ["-> renamed"], error: null, url: "https://cybersolide.test-zone.invalid/" };
  const present = (value: unknown, uid = 0, mode = 0o600): Examination => ({ kind: "present", info: { uid, mode } as never, bytes: new TextEncoder().encode(JSON.stringify(value)) }) as Examination;

  test("trusted when root wrote it for this request", () => {
    expect(judgeRenameResult(present(result), "nis2", 42, 0)).toEqual({ kind: "read", result: result as never });
  });

  test("an earlier request's is no answer, another account's or a writable one is refused", () => {
    expect(judgeRenameResult(present(result), "nis2", 43, 0).kind).toBe("absent");
    expect(judgeRenameResult(present(result, 1000), "nis2", 42, 0).kind).toBe("unreadable");
    expect(judgeRenameResult(present(result, 0, 0o666), "nis2", 42, 0).kind).toBe("unreadable");
    expect(judgeRenameResult(present({ ...result, slug: "blog" }), "nis2", 42, 0).kind).toBe("unreadable");
  });
});
