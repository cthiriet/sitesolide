/**
 * What `deploy` checks of a secret file of the old form, `"secrets":
 * ["crm.env"]`, decided without ever reading its content.
 *
 * **The VM is the source of truth.** A project's secrets live on the machine:
 * in its store, `/etc/sitesolide/projects/<slug>/`, for a manifest that names
 * its variables (see ./store and ./store-cli), and in flat files of
 * `/etc/sitesolide` for one of the old form, which keep loading before the
 * store until the project migrates. `deploy` never pushes a value, and a
 * missing one never stops it: the unit reads each file with
 * `EnvironmentFile=-`, and `deploy` says which is missing.
 *
 * What still stops it, here: a file the project may not read. Where a file
 * lands and to whom it belongs follows from its name and its site:
 * `/etc/sitesolide/<name>`, `site-<slug>`, 0600; a project reads
 * `<slug>.env` and `<slug>-<name>` alone. The steward applies the same rule
 * on its side, see dashboard/src/secrets/scope.ts.
 *
 * Pure: returns a decision, touches nothing.
 */
import { isValidSecretName } from "./manifest";
import { secretPath, systemUser, MARKER_ABSENT, MARKER_PRESENT } from "./unit";

/**
 * The dashboard's address, derived from the configured zone. No default: a
 * ready-made value would send a user towards someone else's dashboard.
 */
export function dashboardAddress(zone: string): string {
  return `https://dashboard.${zone}`;
}

export type PresenceRead = { kind: "absent" } | { kind: "present" } | { kind: "unreadable" };

/**
 * The answer of the remote presence test. Anything that is neither marker, an
 * empty output included, reads as a failure: a refused sudo prints nothing,
 * and taking that silence for an absence would warn of a missing file that
 * is there.
 */
export function readPresenceAnswer(output: string): PresenceRead {
  const clean = output.trim();
  if (clean === MARKER_ABSENT) return { kind: "absent" };
  if (clean === MARKER_PRESENT) return { kind: "present" };
  return { kind: "unreadable" };
}

// --- whose file it is ----------------------------------------------------------------

/**
 * The machine's own files, root's: the dashboard's hash, the monitor's
 * alerting addresses, the backups' bucket keys and passphrase. Their names
 * attach them to the dashboard, and no project reads them. `ROOT_FILES` of
 * dashboard/src/secrets/scope.ts, mirrored rather than imported, for the
 * reason dashboard/borrowed/ is not imported from bin/ (it is not in git);
 * bin/tests/cli-secrets.test.ts holds the two lists equal.
 */
export const MACHINE_FILES: readonly string[] = ["dashboard.env", "dashboard-monitor.env", "dashboard-backup.env"];

/** The project whose name the machine's files carry. */
export const MACHINE_FILES_OWNER = "dashboard";

/**
 * Does a file's name attach it to the site labelled `label`? `<label>.env`
 * or `<label>-<anything>`, the steward's rule (`candidates` in
 * dashboard/src/secrets/scope.ts); a manifest's names are plain, so the
 * `<label>-secrets/` subfolder never arises here.
 */
export function namedAfter(name: string, label: string): boolean {
  return name === `${label}.env` || name.startsWith(`${label}-`);
}

/**
 * Why the project `slug` may not declare the secret file `name`, or null.
 *
 * The unit generated for a project reads every file its manifest declares
 * through `EnvironmentFile=`, and PID 1 reads it as root, whoever owns it:
 * `deploy` only checked that the file was there. A repository cloned and
 * deployed over SSH that declared `dashboard-backup.env` handed its code the
 * backups' bucket keys and passphrase, and one that declared `cms.env` the
 * secrets of cms. The installer refuses those for a token (claims.ts in
 * dashboard/src/installer); this is the same rule on the owner's path, and
 * the one `remove` keeps to before it deletes anything.
 *
 * `labels` are the sites deployed on the machine, by the label their files
 * carry (`landing` for the zone's folder): a name this slug prefixes,
 * `acme-crm.env` for `acme`, is the file of a more specific site when one is
 * deployed, as the steward attaches it.
 */
export function secretFileRefusal(slug: string, name: string, labels: readonly string[] = []): string | null {
  if (MACHINE_FILES.includes(name)) {
    return slug === MACHINE_FILES_OWNER ? null : `${name} belongs to the machine, root's, and no project reads it`;
  }
  if (!namedAfter(name, slug)) {
    return `${name} is not named after ${slug}: a project reads ${slug}.env and ${slug}-<name> files alone`;
  }
  const holder = labels
    .filter((label) => label !== slug && label.length > slug.length && namedAfter(name, label))
    .sort((a, b) => b.length - a.length)[0];
  return holder === undefined ? null : `${name} belongs to ${holder}, deployed on the machine`;
}

/** What closes the reading of the declared files' owners: an answer without it read nothing. */
export const OWNERS_DONE = "SECRET-OWNERS-DONE";

/** A declared file as root sees it, never a byte of its content. */
export type SecretOwner = { kind: "absent" } | { kind: "other" } | { kind: "file"; owner: string };

/**
 * The owner of each file named, in /etc/sitesolide, read as root without
 * opening it: `<name> absent`, `<name> other` for what is not a plain file
 * (a link, a folder), `<name> <account>` otherwise. A name is a manifest's,
 * letters, digits, dots, dashes and underscores, nothing a shell reads; one
 * that is not is refused here rather than quoted.
 */
export function secretOwnersCommand(names: readonly string[]): string {
  const strange = names.find((name) => !isValidSecretName(name));
  if (strange !== undefined) throw new Error(`not a secret file's name: ${JSON.stringify(strange)}`);
  return (
    `sudo sh -c 'for f in ${names.join(" ")}; do p=/etc/sitesolide/$f; ` +
    `if [ -L "$p" ] || { [ -e "$p" ] && [ ! -f "$p" ]; }; then echo "$f other"; ` +
    `elif [ -f "$p" ]; then echo "$f $(stat -c %U "$p")"; else echo "$f absent"; fi; done; echo ${OWNERS_DONE}'`
  );
}

/**
 * The answer of secretOwnersCommand, or null when it is not one: every name
 * once, in any order, then the marker, and nothing else. A refused sudo
 * prints nothing, and nothing is no answer.
 */
export function readSecretOwners(output: string, names: readonly string[]): Map<string, SecretOwner> | null {
  const lines = output.split("\n").filter((line) => line.trim() !== "");
  if (lines.at(-1) !== OWNERS_DONE) return null;
  const found = new Map<string, SecretOwner>();
  for (const line of lines.slice(0, -1)) {
    const match = /^(\S+) (\S+)$/.exec(line);
    if (match === null || !names.includes(match[1]!) || found.has(match[1]!)) return null;
    const state = match[2]!;
    found.set(match[1]!, state === "absent" ? { kind: "absent" } : state === "other" ? { kind: "other" } : { kind: "file", owner: state });
  }
  return names.every((name) => found.has(name)) ? found : null;
}

/**
 * Why the project `slug` may not read the file `name` the machine already
 * carries, or null. The steward hands a project's files to its account,
 * `site-<slug>`: a file there owned by anyone else is somebody else's, which
 * a name alone cannot tell, the landing's `landing-mail.env` for a slug
 * `landing-mail` or a file a less specific site keeps. The installer's rule
 * for a token (claims.ts in dashboard/src/installer). The machine's own files
 * are root's, and the dashboard's.
 */
export function ownerRefusal(slug: string, name: string, found: SecretOwner): string | null {
  if (found.kind === "absent") return null;
  if (MACHINE_FILES.includes(name) && slug === MACHINE_FILES_OWNER) return null;
  if (found.kind === "other") return `${secretPath(name)} is not a plain file: the owner of the machine must look at it`;
  const account = systemUser(slug);
  return found.owner === account ? null : `${secretPath(name)} is already on the machine and belongs to ${found.owner}, not ${account}: a project reads its own files alone`;
}
