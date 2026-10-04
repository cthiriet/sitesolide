/**
 * Where the archives wait for the installer: `<DATA_DIR>/control/<id>/`, in
 * the dashboard's own data directory, the only place its unit lets it write.
 *
 * **The body is counted while it streams to disk**, never read whole first:
 * the dashboard runs under `MemoryMax=128M`, and an archive of a hundred
 * mebibytes read into memory would get it killed. Bun's own cap does not hold
 * either: measured on Bun 1.3.11, a body sent without `Content-Length`, in
 * chunks, goes past `maxRequestBodySize` untouched. The count here is the cap.
 *
 * Nothing in the archive is read here, not even its list of entries: the
 * installer extracts it as the project's own account, on the machine, and the
 * dashboard has no business interpreting it. Only its first two bytes are
 * looked at, the gzip signature, so that a wrong upload is refused at once
 * rather than after the installer has started.
 */
import { closeSync, mkdirSync, openSync, readdirSync, rmSync, unlinkSync, writeSync, constants } from "node:fs";
import { join } from "node:path";
import { BUNDLE_NAME, DEPLOYMENT_ID_SHAPE } from "./protocol";

export type Receipt =
  | { kind: "received"; bytes: number }
  | { kind: "too-large" }
  | { kind: "not-gzip" }
  | { kind: "empty" }
  | { kind: "interrupted" };

export type Spool = {
  /** Streams the body into `<id>/bundle.tar.gz`, at most `max` bytes. */
  receive: (id: string, body: ReadableStream<Uint8Array> | null, max: number) => Promise<Receipt>;
  remove: (id: string) => void;
  /** The deployment ids that have a folder here. */
  list: () => string[];
};

const GZIP_SIGNATURE = [0x1f, 0x8b];

function folderOf(root: string, id: string): string {
  if (!DEPLOYMENT_ID_SHAPE.test(id)) throw new Error("not a deployment id");
  return join(root, id);
}

export function createSpool(root: string): Spool {
  return {
    async receive(id, body, max) {
      const folder = folderOf(root, id);
      if (body === null) return { kind: "empty" };
      mkdirSync(root, { recursive: true, mode: 0o700 });
      // A fresh folder for every upload: an earlier attempt's leftovers go.
      rmSync(folder, { recursive: true, force: true });
      mkdirSync(folder, { mode: 0o700 });
      const path = join(folder, BUNDLE_NAME);
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let total = 0;
      let outcome: Receipt | null = null;
      const reader = body.getReader();
      try {
        for (;;) {
          let read: Awaited<ReturnType<typeof reader.read>>;
          try {
            read = await reader.read();
          } catch {
            outcome = { kind: "interrupted" };
            break;
          }
          if (read.done) break;
          const chunk = read.value;
          // The gzip signature, 1f 8b, whichever chunks its two bytes arrive in.
          for (let i = 0; i < chunk.length && total + i < 2; i++) {
            if (chunk[i] !== GZIP_SIGNATURE[total + i]) outcome = { kind: "not-gzip" };
          }
          if (outcome !== null) break;
          total += chunk.length;
          if (total > max) {
            outcome = { kind: "too-large" };
            break;
          }
          let written = 0;
          while (written < chunk.length) written += writeSync(fd, chunk, written, chunk.length - written);
        }
      } finally {
        closeSync(fd);
        if (outcome !== null) reader.cancel().catch(() => undefined);
      }
      if (outcome === null && total < 2) outcome = { kind: "empty" };
      if (outcome !== null) {
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
        rmSync(folder, { recursive: true, force: true });
        return outcome;
      }
      return { kind: "received", bytes: total };
    },

    remove(id) {
      rmSync(folderOf(root, id), { recursive: true, force: true });
    },

    list() {
      try {
        return readdirSync(root).filter((name) => DEPLOYMENT_ID_SHAPE.test(name));
      } catch {
        return [];
      }
    },
  };
}
