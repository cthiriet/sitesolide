/**
 * The portal of an already deployed site, as the VM carries it.
 *
 * The dashboard puts up and takes down a site's portal on the machine: its
 * gatekeeper rewrites `/srv/sites/<slug>/sitesolide.json` and
 * `/etc/caddy/sites/<slug>.caddy`, validates and reloads Caddy. The repository
 * knows nothing of it. Yet `sitesolide deploy` re-deposits the repository's
 * manifest and generates the block from it, and bin/deploy-caddy.sh
 * re-deposits every block in the repository: without a guard, the next
 * deployment of any project would silently remove a door put up from the
 * dashboard, and the site would be served in the clear.
 *
 * The rule is the one for secrets: **the VM is the source of truth** for the
 * portal of an already deployed site. `deploy` reads the deposited manifest,
 * takes `portal` back from it and rewrites the local manifest so that the
 * repository catches up with the machine; bin/deploy-caddy.sh refuses to
 * deposit a block whose door contradicts its site's deposited manifest. A site
 * never deployed takes the value from its repository, since there is nothing on
 * the machine to contradict.
 *
 * Pure: returns commands, readings and decisions, touches nothing.
 */
import { isValidSlug } from "./manifest";

/** Where `deploy` deposits each manifest, and where the gatekeeper rewrites it. */
export const SITES_ROOT = "/srv/sites";

/**
 * The markers of the remote reading, alone on their line. A manifest is JSON,
 * and no string in it can carry a line break: an `END <slug>` line can
 * therefore not come from inside a valid manifest, and an invalid manifest
 * containing one would be refused by its reading.
 */
export const MARKER_MANIFEST = "MANIFEST";
export const MARKER_END = "END";
export const MARKER_DONE = "DONE";

export function depositedManifestPath(slug: string, root = SITES_ROOT): string {
  return `${root}/${slug}/sitesolide.json`;
}

/**
 * The script that prints the deposited manifests, each one between
 * `MANIFEST <slug>` and `END <slug>`, then `DONE`. `pattern` is `*` for every
 * site, or a slug for a single one.
 *
 * **`DONE` is what makes an absence readable.** A refused `sudo`, an ssh
 * that does not get through or a `cat` that fails part way give an empty or
 * truncated output, which does not carry that last marker: it then reads as the
 * failure it is, never as "no manifest", which would let `deploy` take the
 * repository's value back over the dashboard's.
 *
 * `root` exists only for the tests, which run this same script on a tree on
 * the workstation.
 */
export function readManifestsScript(pattern: string, root = SITES_ROOT): string {
  if (pattern !== "*" && !isValidSlug(pattern)) throw new Error(`invalid slug: ${pattern}`);
  if (/[\s'"$\\`]/.test(root)) throw new Error(`unexpected root: ${root}`);
  return [
    `for f in ${root}/${pattern}/sitesolide.json; do`,
    ` [ -f "$f" ] || continue;`,
    ` d="\${f%/sitesolide.json}";`,
    ` s="\${d##*/}";`,
    ` echo "${MARKER_MANIFEST} $s";`,
    ` cat "$f" || exit 1;`,
    " echo;",
    ` echo "${MARKER_END} $s";`,
    ` done; echo ${MARKER_DONE}`,
  ].join("");
}

/**
 * The remote command, as ssh passes it to the login shell.
 *
 * The script runs under `sudo sh -c`, and it is the one that prints the
 * markers: a refused `sudo` can therefore write nothing at all. The manifests
 * are readable without particular rights today, but the gatekeeper rewrites
 * them as root, and a reading that depended on the mode it leaves them would
 * fall silent the day that changed.
 */
export function readManifestsCommand(pattern: string): string {
  return `sudo sh -c '${readManifestsScript(pattern)}'`;
}

export type ManifestsRead =
  | { kind: "read"; manifests: Map<string, string> }
  | { kind: "unreadable"; reason: string };

function unreadable(reason: string): { kind: "unreadable"; reason: string } {
  return { kind: "unreadable", reason };
}

/**
 * The manifests read in the answer, by directory name. Only the markers are
 * recognised: any other line between two manifests, a manifest without its end,
 * a directory named twice or an answer without `DONE` make the reading
 * unreadable, and an unreadable reading authorises nothing.
 */
export function readDepositedManifests(output: string): ManifestsRead {
  const lines = output.split("\n");
  const manifests = new Map<string, string>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === MARKER_DONE) {
      if (lines.slice(i + 1).some((rest) => rest.trim() !== "")) {
        return unreadable("unexpected output after the end marker");
      }
      return { kind: "read", manifests };
    }
    const header = new RegExp(`^${MARKER_MANIFEST} (\\S+)$`).exec(line);
    if (header === null) {
      return unreadable(
        line.trim() === "" && i === lines.length - 1
          ? "the server did not finish its answer"
          : `unexpected line: ${line.slice(0, 60)}`,
      );
    }
    const name = header[1]!;
    if (manifests.has(name)) return unreadable(`${name} listed twice`);
    const end = lines.indexOf(`${MARKER_END} ${name}`, i + 1);
    if (end === -1) return unreadable(`the manifest of ${name} is cut short`);
    manifests.set(name, lines.slice(i + 1, end).join("\n"));
    i = end + 1;
  }
  return unreadable("the server did not finish its answer");
}

export type PortalRead = { kind: "read"; portal: boolean } | { kind: "unreadable"; reason: string };

/**
 * What a deposited manifest says about the portal, and nothing more.
 *
 * `portal` is `true` or missing, as `validate()` requires and as the gatekeeper
 * writes it: any other value is unreadable rather than guessed, a `false` or a
 * `"yes"` being readable either way. The rest of the manifest is not validated
 * here: a key the CLI no longer knows says nothing about the door.
 *
 * `slug`, when given, must be the one the manifest declares: a directory
 * carrying another site's manifest says nothing about this one.
 */
export function portalFromManifest(raw: string, slug?: string): PortalRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadable("not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return unreadable("not a JSON object");
  }
  const fields = parsed as Record<string, unknown>;
  if (slug !== undefined && fields.slug !== slug) {
    return unreadable(`it names another slug: ${String(fields.slug)}`);
  }
  if (fields.portal === undefined) return { kind: "read", portal: false };
  if (fields.portal === true) return { kind: "read", portal: true };
  return unreadable("portal is neither true nor absent");
}

export type DepositedRead =
  | { kind: "absent" }
  | { kind: "present"; portal: boolean }
  | { kind: "unreadable"; reason: string };

/** The reading of a single site's manifest, for `deploy`. */
export function readDepositedManifest(output: string, slug: string): DepositedRead {
  const reading = readDepositedManifests(output);
  if (reading.kind === "unreadable") return reading;
  if ([...reading.manifests.keys()].some((name) => name !== slug)) {
    return unreadable("the server answered for another site");
  }
  const raw = reading.manifests.get(slug);
  if (raw === undefined) return { kind: "absent" };
  const portal = portalFromManifest(raw, slug);
  return portal.kind === "read" ? { kind: "present", portal: portal.portal } : portal;
}

/**
 * A site's manifest taken from the reading of them all: the one `deploy` makes
 * under the lock, which serves both to confirm its door and to guard the other
 * sites' blocks. Another unreadable manifest does not make this one unreadable:
 * refusing that is guardPortals' job.
 */
export function readManifestAmongAll(output: string, slug: string): DepositedRead {
  const reading = readDepositedManifests(output);
  if (reading.kind === "unreadable") return reading;
  const raw = reading.manifests.get(slug);
  if (raw === undefined) return { kind: "absent" };
  const portal = portalFromManifest(raw, slug);
  return portal.kind === "read" ? { kind: "present", portal: portal.portal } : portal;
}

export type PortalDecision =
  /** The repository's value: first deployment, or same value on both sides. */
  | { kind: "repository"; portal: boolean }
  /** The dashboard changed the door: its value wins, the repository catches up. */
  | { kind: "dashboard"; portal: boolean }
  | { kind: "rejects"; message: string; details: string[] };

/**
 * The portal `deploy` applies, decided before anything leaves.
 *
 * The order of the cases is the order of truth, as for the secrets: a reading
 * that failed authorises nothing, a site absent from the machine takes the
 * value from its repository, and a site present keeps the machine's.
 */
export function decidePortal(slug: string, local: boolean, reading: DepositedRead): PortalDecision {
  if (reading.kind === "unreadable") {
    return {
      kind: "rejects",
      message: `cannot tell whether the portal of ${slug} was changed from the dashboard`,
      details: [
        `${depositedManifestPath(slug)}: ${reading.reason}`,
        "nothing was sent: the portal is never decided on a reading that failed,",
        "the repository could otherwise open a site the dashboard closed",
      ],
    };
  }
  if (reading.kind === "absent" || reading.portal === local) {
    return { kind: "repository", portal: local };
  }
  return { kind: "dashboard", portal: reading.portal };
}

/**
 * The door read again under the lock shared with the gatekeeper, just before
 * `deploy` deposits the manifest and the block. That is the reading that
 * decides.
 *
 * The reading at the start, which served to prepare the deployment and to warn
 * about the switch, is several minutes old: the build, the sending of the code
 * and of the files have happened since, and the gatekeeper may have changed the
 * door in the meantime. Depositing the door read at the start would then
 * contradict it, one way or the other. `deploy` stops instead, depositing
 * nothing, and running it again takes the machine's value: the order of the
 * steps depends on the door, a protected site receiving its own before its
 * files, and it cannot be caught up part way through.
 *
 * An absent manifest contradicts nothing: a first deployment, or a site removed
 * in the meantime, which the repository is once more the source of truth to put
 * in place. An unreadable reading authorises nothing.
 */
export function confirmDoorUnderLock(slug: string, applied: boolean, reading: DepositedRead): Agreement {
  if (reading.kind === "unreadable") {
    return {
      kind: "rejects",
      message: `cannot tell whether the portal of ${slug} was changed from the dashboard`,
      details: [
        `${depositedManifestPath(slug)}: ${reading.reason}`,
        "neither the manifest nor the Caddy block was deposited: nothing is decided on a reading that failed",
      ],
    };
  }
  if (reading.kind === "absent" || reading.portal === applied) return { kind: "agreed" };
  return {
    kind: "rejects",
    message: `portal of ${slug} changed from the dashboard during this deploy: run \`sitesolide deploy\` again`,
    details: [
      `this deploy was turning the portal ${applied ? "on" : "off"}, the server now has it ${reading.portal ? "on" : "off"}`,
      "neither the manifest nor the Caddy block was deposited",
    ],
  };
}

/**
 * What `deploy` says about a door changed from the dashboard. The local
 * manifest is rewritten, and it must be committed: without that commit, the
 * repository goes on saying the opposite of the machine, as bin/lock.sh recalls
 * for the lock.
 */
export function switchAnnouncement(portal: boolean, dryRun: boolean): { title: string; details: string[] } {
  const direction = portal ? "on" : "off";
  return {
    title: dryRun
      ? `portal was turned ${direction} from the dashboard; a real deploy updates sitesolide.json, then commit it`
      : `portal was turned ${direction} from the dashboard; sitesolide.json updated, commit it`,
    details: [
      "the server is the source of truth for the portal of a deployed site:",
      "change it from the dashboard, an edit of this field in sitesolide.json is put back",
    ],
  };
}

/**
 * The actions that deposit the local manifest on the VM without going through
 * `deploy`: `lock` and `unlock` (bin/lock.sh), `domain` (`sitesolide domain`).
 */
export type ManifestAction = "lock" | "unlock" | "domain";

export type Agreement = { kind: "agreed" } | { kind: "rejects"; message: string; details: string[] };

/**
 * The guard of the actions that deposit the local manifest as is, before any
 * write.
 *
 * None of them takes the VM's door back the way `deploy` does: depositing the
 * local manifest would therefore erase a portal put up from the dashboard, or
 * put one back that it removed, and bin/deploy-caddy.sh would then see no
 * divergence left to refuse. They refuse instead, and point to `deploy`, which
 * makes the repository catch up.
 *
 * Two refusals say something else, because `deploy` would not be enough there:
 * `validate()` forbids the lock and the customer domain on a site behind the
 * portal. When the VM carries the door, putting a lock in place or switching
 * the domain therefore requires removing it from the dashboard first, and the
 * message says so.
 *
 * A site absent from the machine has nothing to lose: the action goes through,
 * and it is up to it to refuse a site never deployed if need be. An unreadable
 * reading authorises nothing.
 */
export function guardDepositedManifest(
  slug: string,
  local: boolean,
  reading: DepositedRead,
  action: ManifestAction,
): Agreement {
  if (reading.kind === "unreadable") {
    return {
      kind: "rejects",
      message: `cannot tell whether the portal of ${slug} was changed from the dashboard`,
      details: [
        `${depositedManifestPath(slug)}: ${reading.reason}`,
        "nothing was written: the manifest is never deposited on a reading that failed",
      ],
    };
  }
  if (reading.kind === "absent") return { kind: "agreed" };

  if (reading.portal && action !== "unlock") {
    return {
      kind: "rejects",
      message: `${slug} is behind the portal: turn it off from the dashboard first`,
      details: [
        action === "lock"
          ? "a site behind the portal takes no preview lock"
          : "a site behind the portal cannot switch to its own domain yet",
        // The local manifest still asking for the door would contradict it once
        // removed: `deploy` makes it catch up.
        ...(local ? ["then run `sitesolide deploy` in its folder, so that the repository follows"] : []),
        "nothing was written",
      ],
    };
  }
  if (reading.portal !== local) {
    return {
      kind: "rejects",
      message: `portal of ${slug} changed from the dashboard: run \`sitesolide deploy\` in its folder first`,
      details: [
        `depositing this sitesolide.json would turn the portal ${local ? "back on" : "back off"}`,
        "nothing was written",
      ],
    };
  }
  return { kind: "agreed" };
}

/** A site's block as the repository describes it, and its door. */
export type RepoBlock = { slug: string; isProtected: boolean };

/**
 * The guard's verdict. In a refusal, each line is a reason, except those that
 * start with a space and give detail on the previous one.
 */
export type Guard = { kind: "agreed"; protectedSlugs: string[] } | { kind: "rejects"; lines: string[] };

/**
 * The guard of bin/deploy-caddy.sh: every block in the repository set against
 * its site's deposited manifest, before any write.
 *
 * - a block whose door contradicts the deposited manifest is refused, both
 *   ways: depositing it would remove a door put up from the dashboard, or put
 *   one back that it removed;
 * - a block with no deposited manifest goes through: the site is not deployed
 *   yet, or `deploy` puts its door up before its manifest, and the repository
 *   is then the source of truth;
 * - a deposited manifest with no block in the repository goes through too: the
 *   script deposits nothing for it and never deletes an orphan, which may be
 *   the door of a static site put up from the dashboard;
 * - the block `SITESOLIDE_REMOVE` names is not set against anything: it is
 *   going away.
 *
 * An unreadable deposited manifest stops everything, like the answer itself: it
 * could be that of a site whose door is at stake.
 *
 * The agreement returns the sites their deposited manifest puts behind the
 * portal, so that the script does not present their orphan block as a block to
 * remove.
 */
export function guardPortals(blocks: RepoBlock[], output: string, removeSlug = ""): Guard {
  const reading = readDepositedManifests(output);
  if (reading.kind === "unreadable") {
    return {
      kind: "rejects",
      lines: [
        `cannot read the manifests deposited on the server: ${reading.reason}`,
        "  nothing was deposited: a block is never checked against a reading that failed",
      ],
    };
  }

  const lines: string[] = [];
  const portals = new Map<string, boolean>();
  for (const [slug, raw] of reading.manifests) {
    const wasRead = portalFromManifest(raw);
    if (wasRead.kind === "unreadable") {
      lines.push(`cannot read ${depositedManifestPath(slug)}: ${wasRead.reason}`);
    } else {
      portals.set(slug, wasRead.portal);
    }
  }

  const removedSlug = removeSlug.replace(/\.caddy$/, "");
  for (const block of [...blocks].sort((a, b) => a.slug.localeCompare(b.slug))) {
    if (block.slug === removedSlug) continue;
    const portal = portals.get(block.slug);
    if (portal === undefined || portal === block.isProtected) continue;
    lines.push(
      `portal of ${block.slug} changed from the dashboard: run \`sitesolide deploy\` in its folder first`,
      block.isProtected
        ? `  the repository block is behind the portal, the server's manifest is not`
        : `  the server's manifest is behind the portal, the repository block is not`,
    );
  }

  if (lines.length > 0) return { kind: "rejects", lines };
  const protectedSlugs = [...portals].filter(([, portal]) => portal).map(([slug]) => slug);
  return { kind: "agreed", protectedSlugs: protectedSlugs.sort() };
}
