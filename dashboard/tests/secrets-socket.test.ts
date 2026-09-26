import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeSocket, temporaryName, openSocket, prepareFolder, isOurSocketLeftover } from "../src/secrets/socket";

/**
 * The steward's socket, on a real directory and a real Bun.serve: what is
 * judged here is what the dashboard sees of the known name, never anything
 * askew.
 */

const toClean: string[] = [];
const servers: { stop: (force?: boolean) => Promise<void> }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function socketFolder(): { folder: string; socket: string } {
  const root = mkdtempSync(join(tmpdir(), "socket-"));
  toClean.push(root);
  return { folder: root, socket: join(root, "secretaire.sock") };
}

const answer = () => new Response("ok");

describe("opening the socket", () => {
  test("the server listens under a temporary name, and the known name only appears with its permissions", async () => {
    const { folder, socket } = socketFolder();
    const seen: { path: string; knownExists: boolean }[] = [];

    const server = openSocket(socket, null, (path) => {
      const listening = Bun.serve({ unix: path, fetch: answer });
      // What a client would see at that instant: Bun created the socket at the umask.
      seen.push({ path, knownExists: existsSync(socket) });
      return listening;
    });
    servers.push(server);

    expect(seen).toEqual([{ path: temporaryName(socket), knownExists: false }]);
    expect(statSync(folder).mode & 0o777).toBe(0o750);
    expect(lstatSync(socket).isSocket()).toBe(true);
    expect(statSync(socket).mode & 0o777).toBe(0o660);
    expect(readdirSync(folder)).toEqual(["secretaire.sock"]);
    expect((await fetch("http://steward/", { unix: socket })).status).toBe(200);
  });

  test("a failure after listening removes the temporary one and rethrows", () => {
    const { folder, socket } = socketFolder();
    // A group nobody can grant: the chown fails.
    expect(() =>
      openSocket(socket, 2 ** 31 - 2, (path) => {
        const listening = Bun.serve({ unix: path, fetch: answer });
        servers.push(listening);
        return listening;
      }),
    ).toThrow();
    expect(existsSync(socket)).toBe(false);
    expect(existsSync(temporaryName(socket))).toBe(false);
    expect(readdirSync(folder)).toEqual([]);
  });

  test("closing removes the socket, which stop() leaves behind", async () => {
    const { socket } = socketFolder();
    const server = openSocket(socket, null, (path) => Bun.serve({ unix: path, fetch: answer }));
    await server.stop(true);
    expect(existsSync(socket)).toBe(true);
    closeSocket(socket);
    expect(existsSync(socket)).toBe(false);
    expect(() => closeSocket(socket)).not.toThrow();
  });
});

describe("the socket's directory", () => {
  test("empty: nothing to say", () => {
    const { socket } = socketFolder();
    expect(prepareFolder(socket)).toBeNull();
  });

  test("our own sockets, left behind by an abrupt stop, are removed", async () => {
    const { folder, socket } = socketFolder();
    for (const path of [socket, join(folder, ".secretaire.sock.4242")]) {
      const stale = Bun.serve({ unix: path, fetch: answer });
      await stale.stop(true);
    }
    expect(prepareFolder(socket)).toBeNull();
    expect(readdirSync(folder)).toEqual([]);
  });

  test("a regular file under the socket's name is not replaced: Bun would do it without a word", () => {
    const { folder, socket } = socketFolder();
    writeFileSync(socket, "not a socket");
    expect(prepareFolder(socket)).toContain("secretaire.sock");
    expect(readdirSync(folder)).toEqual(["secretaire.sock"]);
  });

  test("any other content makes it refuse: the directory gets a chmod", () => {
    const { folder, socket } = socketFolder();
    writeFileSync(join(folder, "neighbour"), "");
    expect(prepareFolder(socket)).toContain("the socket needs a folder of its own");
    expect(existsSync(join(folder, "neighbour"))).toBe(true);
  });

  test("a missing directory", () => {
    expect(prepareFolder("/path/that/does/not/exist/secretaire.sock")).toContain("cannot be read");
  });

  test("what counts as a leftover", () => {
    const socket = "/run/sitesolide-steward/secretaire.sock";
    expect(isOurSocketLeftover(socket, "secretaire.sock")).toBe(true);
    expect(isOurSocketLeftover(socket, ".secretaire.sock.123")).toBe(true);
    expect(isOurSocketLeftover(socket, ".secretaire.sock.")).toBe(false);
    expect(isOurSocketLeftover(socket, ".secretaire.sock.12a")).toBe(false);
    expect(isOurSocketLeftover(socket, "secretaire.sock.123")).toBe(false);
    expect(isOurSocketLeftover(socket, "other.sock")).toBe(false);
  });
});
