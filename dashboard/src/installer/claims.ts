/**
 * The secret files a token's project may read, decided on the machine before
 * anything is written.
 *
 * The unit generated for a project reads each file its manifest declares
 * through `EnvironmentFile=`, and PID 1 reads it as root, whoever owns it.
 * `scopeRefusals` (src/control/policy.ts) only asks that the file be named
 * `<slug>.env`, which the slug alone decides: a token with the create right
 * named its new project `dashboard-backup`, declared `dashboard-backup.env`,
 * and its code was handed the backups' bucket keys and passphrase; named
 * `cms-smtp`, it read cms's own `cms-smtp.env`. Either name also took the file
 * away from the site it belonged to in the Secrets section, which attaches a
 * file by its name (src/secrets/scope.ts, `readSites`).
 *
 * So a token's deployment is refused, before anything is written, when:
 *
 * 1. it declares a file kept for root (`ROOT_FILES`), present or not: the
 *    platform creates those later, and the unit would read them then;
 * 2. a file it declares is already on the machine and is not a plain file
 *    owned by `site-<slug>`, the account the steward hands a project's files
 *    to; a file there before the account exists is somebody else's;
 * 3. a file the steward attaches to another site would leave it, declared
 *    or present, which is how a new slug takes another project's file;
 * 4. a file present that this deployment would attach to its project for
 *    the first time, declared or not, is not owned by `site-<slug>`.
 *
 * The same reading the steward makes, so that what the Secrets section shows
 * is what the installer judged. Pure: the host reads, this decides, and
 * nothing here quotes more than a file's name, never its content.
 */
import { systemUser } from "../../borrowed/unit";
import { readSites, ROOT_FILES, type ProjectEntry } from "../secrets/scope";

/** A secret file as the installer sees it, never its content. */
export type SecretFile = { kind: "absent" } | { kind: "file"; uid: number } | { kind: "other" };

/** What a deployment would change of the files' attachment. */
export type Claims = {
  /** Files another site holds now and would no longer hold. */
  leaving: { name: string; site: string }[];
  /** Files this project would hold that it does not hold now. */
  arriving: string[];
};

/**
 * The attachment of every file, before this deployment and as if its
 * manifest were deposited: `projects` every directory of /srv/sites with its
 * manifest, `present` the names in /etc/sitesolide.
 */
export function claimsOf(slug: string, text: string, projects: readonly ProjectEntry[], present: readonly string[]): Claims {
  const before = readSites([...projects], present);
  const after = readSites([...projects.filter((entry) => entry.folder !== slug), { folder: slug, manifest: text }], present);
  const leaving: Claims["leaving"] = [];
  for (const [folder, site] of before) {
    if (folder === slug) continue;
    const kept = new Set((after.get(folder)?.files ?? []).map((file) => file.name));
    for (const file of site.files) if (!kept.has(file.name)) leaving.push({ name: file.name, site: folder });
  }
  const held = new Set((before.get(slug)?.files ?? []).map((file) => file.name));
  const arriving = (after.get(slug)?.files ?? []).map((file) => file.name).filter((name) => !held.has(name));
  return { leaving, arriving };
}

/** The files whose owner the host must read for `claimRefusals`: the declared ones and those arriving. */
export function namesToCheck(declared: readonly string[], claims: Claims): string[] {
  return [...new Set([...declared, ...claims.arriving])].sort();
}

/**
 * Every reason this deployment may not read or take a secret file, empty
 * when it may. `files` holds what the host read of each name `namesToCheck`
 * gave; `account` is `site-<slug>`'s uid, null while it does not exist.
 */
export function claimRefusals(slug: string, declared: readonly string[], claims: Claims, files: ReadonlyMap<string, SecretFile>, account: number | null): string[] {
  const refusals: string[] = [];
  for (const { name, site } of claims.leaving) {
    refusals.push(`secrets: ${name} belongs to ${site}, which this deployment would take it from: pick another slug, or ask the owner of the machine`);
  }
  for (const name of namesToCheck(declared, claims)) {
    if (ROOT_FILES.includes(name)) {
      refusals.push(`secrets: ${name} belongs to the machine, root's, and no project reads it: pick another slug`);
      continue;
    }
    const file = files.get(name) ?? { kind: "absent" };
    if (file.kind === "absent") continue;
    if (file.kind === "other") {
      refusals.push(`secrets: /etc/sitesolide/${name} is not a plain file: the owner of the machine must look at it`);
    } else if (account === null || file.uid !== account) {
      refusals.push(`secrets: /etc/sitesolide/${name} is already on the machine and does not belong to ${systemUser(slug)}: a project reads its own files alone; pick another slug, or ask the owner of the machine`);
    }
  }
  return refusals;
}
