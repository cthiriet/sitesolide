#!/usr/bin/env bun
/**
 * The portal guard, run by the scripts before any write.
 *
 *   SITESOLIDE_SERVER=<account@host> bun bin/portal-guard.ts <block.caddy>...
 *   SITESOLIDE_SERVER=<account@host> bun bin/portal-guard.ts --manifest <slug> <sitesolide.json> lock|unlock
 *   SITESOLIDE_SERVER=<account@host> bun bin/portal-guard.ts --lock take <who> <pid>
 *   SITESOLIDE_SERVER=<account@host> bun bin/portal-guard.ts --lock release|verify <holder line>
 *
 * The dashboard puts a site's portal in place and takes it away on the VM,
 * without the repository knowing it until `sitesolide deploy` has gone through
 * that site.
 *
 * The first form is the one of bin/deploy-caddy.sh: depositing the blocks of
 * the repository would silently remove a door put in place from the dashboard.
 * Each named block is therefore confronted with the deposited manifest of its
 * site, all read together over a single connection. Exit 0: no contradiction,
 * and standard output names, one per line, the sites that their deposited
 * manifest puts behind the portal.
 *
 * The second is the one of bin/lock.sh, which deposits the local manifest as
 * is: it would erase the door of the deposited manifest in the same way. Only
 * the site's manifest is read. Exit 0: the gesture may deposit that manifest.
 *
 * Exit 1 in both cases: a contradiction or an unreadable read, told on the
 * error output. Exit 2: a malformed call.
 *
 * The third is the lock that the scripts share with the dashboard's gatekeeper
 * before touching Caddy, see bin/cli/caddy-lock.ts. `take` prints the holder
 * line, which the script keeps in order to release it or to pass it on through
 * CADDY_LOCK_HELD; held by another, it refuses with exit 1. `release` only
 * removes the lock whose holder is still that line, and exits 0 even when it
 * cannot: it is called from an exit trap, and the warning is enough.
 * `verify` exits 1 if the VM does not confirm the ownership passed to it. The
 * announcements go to the error output, standard output carrying only the line.
 *
 * What decides lives in bin/cli/portal-vm.ts and bin/cli/caddy-lock.ts, tested
 * without a server. This file only reads the local files, queries the VM and
 * returns the answer. It reads nothing other than the manifests and the lock,
 * and writes nothing other than the lock.
 */
import { basename } from "node:path";
import { isValidSlug } from "./cli/manifest";
import { fragmentIsProtected } from "./cli/portal";
import {
  takeLock,
  releaseLock,
  HOLDERS,
  checkOwnership,
  type Execution,
  type Who,
} from "./cli/caddy-lock";
import {
  readManifestsCommand,
  guardDepositedManifest,
  guardPortals,
  readDepositedManifest,
  portalFromManifest,
} from "./cli/portal-vm";

/** An indented line details the previous one; the others are each a refusal. */
function die(lines: string[], code = 1): never {
  for (const line of lines) {
    console.error(line.startsWith(" ") ? `   ${line.trim()}` : `!! ${line}`);
  }
  process.exit(code);
}

const server = process.env.SITESOLIDE_SERVER ?? "";
if (server === "") die(["SITESOLIDE_SERVER is not set"], 2);

/**
 * The VM's answer to a read, or the stop if the command failed. An array of
 * arguments, never an assembled string: the remote command is the only string,
 * and it carries no value coming from the outside, the pattern being checked by
 * readManifestsCommand.
 */
async function read(pattern: string): Promise<string> {
  const proc = Bun.spawn(["ssh", server, readManifestsCommand(pattern)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if ((await proc.exited) !== 0) {
    die([
      `reading the deposited manifests failed: ${error.trim() || "no message"}`,
      "  nothing was written: nothing is decided on a reading that failed",
    ]);
  }
  return output;
}

/** A lock command on the VM, whose code and outputs are returned as they are. */
async function remote(command: string): Promise<Execution> {
  // Bounded and without a prompt: `release` runs from an exit trap, after a
  // Ctrl-C included, and must neither wait for a passphrase nor hang.
  const proc = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", server, command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, output, error };
}

const arguments_ = process.argv.slice(2);

if (arguments_[0] === "--lock") {
  const [, action = "", value = "", pid = ""] = arguments_;
  if (action === "take") {
    if (!(HOLDERS as readonly string[]).includes(value) || !/^[0-9]{1,10}$/.test(pid)) {
      die([`usage: portal-guard.ts --lock take ${HOLDERS.join("|")} <pid>`], 2);
    }
    const acquisition = await takeLock(value as Who, Number(pid), remote);
    if (acquisition.kind === "rejects") {
      die([acquisition.message, ...acquisition.details.map((line) => `  ${line}`)]);
    }
    for (const announcement of acquisition.announcements) console.error(`-> ${announcement}`);
    console.log(acquisition.line);
  } else if (action === "release") {
    const release = await releaseLock(value, remote).catch((error: Error) => ({
      kind: "warning" as const,
      message: `the Caddy lock was not released: ${error.message}`,
      details: [],
    }));
    if (release.kind === "warning") {
      for (const line of [release.message, ...release.details.map((detail) => `  ${detail}`)]) {
        console.error(line.startsWith(" ") ? `   ${line.trim()}` : `!! ${line}`);
      }
    }
  } else if (action === "verify") {
    const ownership = await checkOwnership(value, remote);
    if (ownership.kind === "rejects") {
      die([ownership.message, ...ownership.details.map((line) => `  ${line}`)]);
    }
  } else {
    die(["usage: portal-guard.ts --lock take|release|verify ..."], 2);
  }
} else if (arguments_[0] === "--manifest") {
  const [, slug = "", path = "", action = ""] = arguments_;
  if (action !== "lock" && action !== "unlock") {
    die(["usage: portal-guard.ts --manifest <slug> <sitesolide.json> lock|unlock"], 2);
  }
  if (!isValidSlug(slug)) die([`invalid slug: ${slug}`], 2);
  const file = Bun.file(path);
  if (!(await file.exists())) die([`not found: ${path}`], 2);
  const local = portalFromManifest(await file.text(), slug);
  if (local.kind === "unreadable") die([`cannot read ${path}: ${local.reason}`]);

  const agreement = guardDepositedManifest(slug, local.portal, readDepositedManifest(await read(slug), slug), action);
  if (agreement.kind === "rejects") die([agreement.message, ...agreement.details.map((line) => `  ${line}`)]);
} else {
  const blocks = await Promise.all(
    arguments_.map(async (path) => ({
      slug: basename(path, ".caddy"),
      isProtected: fragmentIsProtected(await Bun.file(path).text()),
    })),
  );
  const guard = guardPortals(blocks, await read("*"), process.env.SITESOLIDE_REMOVE ?? "");
  if (guard.kind === "rejects") die(guard.lines);
  if (guard.protectedSlugs.length > 0) console.log(guard.protectedSlugs.join("\n"));
}
