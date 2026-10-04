/**
 * The optional copy of every snapshot in an S3-compatible bucket: Hetzner
 * Object Storage, Cloudflare R2, Backblaze B2, AWS S3, a MinIO of one's own.
 *
 * The machine's disk is the first copy, and it dies with the machine. The
 * bucket is the second, elsewhere, encrypted on the machine before it leaves
 * (crypto.ts): what is uploaded is unreadable without the passphrase, which
 * lives in /etc/sitesolide/dashboard-backup.env and, above all, in its
 * owner's password manager. Without it, the copies are noise.
 *
 * Absent configuration, nothing here runs and nothing leaves the machine:
 * local snapshots only, exactly as before. Half a configuration is an error the
 * dashboard shows, not a silent fallback: someone who set three variables out
 * of five believes they have offsite copies.
 *
 * The objects are `<prefix>/<folder>/<snapshot>.enc`: one folder per project,
 * the snapshot's own name, so that the bucket can be read by hand. Each object
 * is sealed for that key (crypto.ts): copied under another, it is refused.
 */
import { readSnapshotName, type Snapshot } from "../../borrowed/backups";
import { decryptStream, encryptFile, MIN_PASSPHRASE, type Decrypted, type Master } from "./crypto";

export type Offsite = {
  endpoint: string;
  bucket: string;
  region: string | null;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  passphrase: string;
};

/** `null`: no bucket, local only. `{ error }`: a configuration started and not finished. */
export type OffsiteSetting = Offsite | null | { error: string };

export const DEFAULT_PREFIX = "sitesolide";

export const OFFSITE_VARIABLES = [
  "BACKUP_S3_ENDPOINT",
  "BACKUP_S3_BUCKET",
  "BACKUP_S3_ACCESS_KEY_ID",
  "BACKUP_S3_SECRET_ACCESS_KEY",
  "BACKUP_ENCRYPTION_PASSPHRASE",
] as const;

/** The suffix of an encrypted object. */
export const OBJECT_SUFFIX = ".enc";

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

/**
 * The bucket's settings, judged. No value of them ever enters a message: the
 * variables are named, never quoted.
 */
export function offsiteFrom(env: Record<string, string | undefined>): OffsiteSetting {
  const given = OFFSITE_VARIABLES.filter((name) => (env[name] ?? "") !== "");
  if (given.length === 0 && (env.BACKUP_S3_REGION ?? "") === "" && (env.BACKUP_S3_PREFIX ?? "") === "") return null;
  const missing = OFFSITE_VARIABLES.filter((name) => (env[name] ?? "") === "");
  if (missing.length > 0) return { error: `offsite copy half configured: ${missing.join(", ")} missing` };

  let url: URL;
  try {
    url = new URL(env.BACKUP_S3_ENDPOINT!);
  } catch {
    return { error: "BACKUP_S3_ENDPOINT is not a URL" };
  }
  // Credentials and data never cross the network in the clear, except to a
  // test server on this very machine.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    return { error: "BACKUP_S3_ENDPOINT must be an https:// address" };
  }
  if (env.BACKUP_ENCRYPTION_PASSPHRASE!.length < MIN_PASSPHRASE) {
    return { error: `BACKUP_ENCRYPTION_PASSPHRASE must be at least ${MIN_PASSPHRASE} characters long` };
  }
  const prefix = (env.BACKUP_S3_PREFIX ?? "").replace(/^\/+|\/+$/g, "") || DEFAULT_PREFIX;
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(prefix) || prefix.split("/").includes("..")) {
    return { error: "BACKUP_S3_PREFIX may only hold letters, digits, dots, dashes, underscores and slashes" };
  }
  return {
    endpoint: url.toString().replace(/\/+$/, ""),
    bucket: env.BACKUP_S3_BUCKET!,
    region: (env.BACKUP_S3_REGION ?? "") === "" ? null : env.BACKUP_S3_REGION!,
    accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID!,
    secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY!,
    prefix,
    passphrase: env.BACKUP_ENCRYPTION_PASSPHRASE!,
  };
}

/**
 * A bucket's error, fit for the status file: the provider's own words, with
 * any of the credentials in them replaced, should a provider ever quote them,
 * and no query string, where a presigned URL would carry a signature.
 */
export function redact(message: string, offsite: Offsite): string {
  let clean = message;
  for (const secret of [offsite.secretAccessKey, offsite.passphrase, offsite.accessKeyId]) {
    if (secret.length >= 4) clean = clean.split(secret).join("[redacted]");
  }
  return clean.replace(/\?[^\s"']*/g, "?[redacted]");
}

/**
 * The settings as the variables offsiteFrom reads, for a download child run
 * without isolation, on the workstation. Under systemd the child reads them
 * from the file itself (runner.ts): they never ride on a command line.
 */
export function offsiteEnvironment(offsite: Offsite): Record<string, string> {
  return {
    BACKUP_S3_ENDPOINT: offsite.endpoint,
    BACKUP_S3_BUCKET: offsite.bucket,
    ...(offsite.region === null ? {} : { BACKUP_S3_REGION: offsite.region }),
    BACKUP_S3_ACCESS_KEY_ID: offsite.accessKeyId,
    BACKUP_S3_SECRET_ACCESS_KEY: offsite.secretAccessKey,
    BACKUP_S3_PREFIX: offsite.prefix,
    BACKUP_ENCRYPTION_PASSPHRASE: offsite.passphrase,
  };
}

/** What the dashboard may show of the bucket: where it is, never how to get in. */
export function offsiteTarget(offsite: Offsite): string {
  return `${offsite.bucket} at ${new URL(offsite.endpoint).host}`;
}

export function objectKey(offsite: Offsite, folder: string, name: string): string {
  return `${offsite.prefix}/${folder}/${name}${OBJECT_SUFFIX}`;
}

export type RemoteObject = { folder: string; snapshot: Snapshot; key: string; bytes: number };

/**
 * A listed key read back: one of our snapshots, of a known folder, or null. An
 * object that is not one is never deleted, whatever retention decides.
 */
export function readObjectKey(offsite: Offsite, key: string, bytes: number): RemoteObject | null {
  const start = `${offsite.prefix}/`;
  if (!key.startsWith(start) || !key.endsWith(OBJECT_SUFFIX)) return null;
  const rest = key.slice(start.length, -OBJECT_SUFFIX.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  const folder = rest.slice(0, slash);
  const snapshot = readSnapshotName(folder, rest.slice(slash + 1));
  return snapshot === null ? null : { folder, snapshot, key, bytes };
}

/** The bucket as this component uses it: four verbs, nothing else. */
export type Bucket = {
  /** Every object under the prefix, all pages read. Throws rather than return a partial list. */
  list: () => Promise<RemoteObject[]>;
  upload: (key: string, path: string, master: Master) => Promise<number>;
  /** Refuses an object sealed for another key than `key`. */
  download: (key: string, write: (bytes: Uint8Array) => Promise<void>) => Promise<Decrypted>;
  remove: (key: string) => Promise<void>;
};

/** Upload parts of 8 MiB, two in flight at most: 16 MiB of memory whatever the archive. */
const PART_BYTES = 8 * 1024 * 1024;

export function openBucket(offsite: Offsite): Bucket {
  const client = new Bun.S3Client({
    endpoint: offsite.endpoint,
    bucket: offsite.bucket,
    accessKeyId: offsite.accessKeyId,
    secretAccessKey: offsite.secretAccessKey,
    ...(offsite.region === null ? {} : { region: offsite.region }),
  });

  return {
    async list() {
      const found: RemoteObject[] = [];
      let startAfter: string | undefined;
      // A thousand keys per page; ten thousand pages is no backup bucket any more.
      for (let page = 0; page < 10_000; page++) {
        const response = await client.list({ prefix: `${offsite.prefix}/`, maxKeys: 1000, ...(startAfter === undefined ? {} : { startAfter }) });
        const contents = response.contents ?? [];
        for (const item of contents) {
          const read = readObjectKey(offsite, item.key, item.size ?? 0);
          if (read !== null) found.push(read);
        }
        if (response.isTruncated !== true || contents.length === 0) return found;
        startAfter = contents[contents.length - 1]!.key;
      }
      throw new Error("the bucket listing never ended");
    },

    async upload(key, path, master) {
      const writer = client.file(key).writer({ partSize: PART_BYTES, queueSize: 2, retry: 3, type: "application/octet-stream" });
      let buffered = 0;
      const total = await encryptFile(path, key, master, async (bytes) => {
        writer.write(bytes);
        buffered += bytes.byteLength;
        if (buffered >= PART_BYTES) {
          await writer.flush();
          buffered = 0;
        }
      });
      await writer.end();
      return total;
    },

    async download(key, write) {
      return decryptStream(client.file(key).stream() as ReadableStream<Uint8Array>, offsite.passphrase, write, { expectedKey: key });
    },

    async remove(key) {
      await client.delete(key);
    },
  };
}
