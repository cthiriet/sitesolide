/**
 * The steward's socket: what makes it open to site-dashboard and closed to
 * every other account, without a single instant askew.
 *
 * Measured in the laboratory (the bench results, measurement 2):
 *
 *   - Bun sets no rights at all on the socket, it is born `0777 & ~umask`, so
 *     0700 root:root under UMask=0077. Setting group and mode after `listen`
 *     leaves a window: over ten restarts, 85 attempts of the dashboard found
 *     the socket in 0700. The window refuses without exposing anything, but
 *     the dashboard then sees a failure that is not one.
 *   - `Bun.serve({ unix })` replaces without a word whatever occupies the path,
 *     a live socket of another server or an ordinary file, and does not remove
 *     the socket on `stop()`.
 *
 * Hence: listening under a temporary name in the same directory, setting group
 * and mode, then `rename` towards the known name, which therefore exists only
 * with its rights; refusing a directory that holds anything other than our own
 * leftovers; removing the socket on stopping.
 */
import { chmodSync, chownSync, lstatSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function temporaryName(socket: string, pid: number = process.pid): string {
  return join(dirname(socket), `.${basename(socket)}.${pid}`);
}

/** Our own leftovers: the socket, or a temporary socket of a dead process. */
export function isOurSocketLeftover(socket: string, name: string): boolean {
  const base = basename(socket);
  if (name === base) return true;
  const prefix = `.${base}.`;
  return name.startsWith(prefix) && /^[0-9]+$/.test(name.slice(prefix.length));
}

/**
 * The directory must be the socket's alone: it receives a chmod and a chgrp,
 * and SOCKET=/run/steward.sock would otherwise close /run to the whole
 * machine. Our own sockets left behind by an abrupt stop are removed; all the
 * rest, including an ordinary file bearing the socket's name, makes the startup
 * refuse. Returns the reason for the refusal, or null.
 */
export function prepareFolder(socket: string): string | null {
  const folder = dirname(socket);
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return `${folder} cannot be read, it must exist before the socket`;
  }

  for (const name of names) {
    const path = join(folder, name);
    let staleSocket = false;
    try {
      staleSocket = isOurSocketLeftover(socket, name) && lstatSync(path).isSocket();
    } catch {
      continue;
    }
    if (!staleSocket) return `${folder} holds ${name}, the socket needs a folder of its own`;
    unlinkSync(path);
  }
  return null;
}

function setPermissions(path: string, gid: number | null, mode: number): void {
  if (gid !== null) chownSync(path, process.getuid?.() ?? 0, gid);
  chmodSync(path, mode);
}

/**
 * Opens the socket: the directory receives the group and 0750, `listen` binds
 * a temporary name, which receives the group and 0660, then takes the known
 * name. A failure after listening removes the temporary one and rethrows: the
 * process stops, and systemd restarts it.
 */
export function openSocket<T>(socket: string, gid: number | null, listen: (path: string) => T): T {
  setPermissions(dirname(socket), gid, 0o750);
  const temporary = temporaryName(socket);
  const server = listen(temporary);
  try {
    setPermissions(temporary, gid, 0o660);
    renameSync(temporary, socket);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // already gone
    }
    throw error;
  }
  return server;
}

/** `stop()` does not remove the socket: it is up to us to do it. */
export function closeSocket(socket: string): void {
  for (const path of [socket, temporaryName(socket)]) {
    try {
      unlinkSync(path);
    } catch {
      // already removed
    }
  }
}
