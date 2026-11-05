/**
 * The optional copy of every snapshot in an S3-compatible bucket: Hetzner
 * Object Storage, Cloudflare R2, Backblaze B2 through its S3 API, AWS S3, a
 * MinIO of one's own.
 *
 * The machine's disk is the first copy, and it dies with the machine. The
 * bucket is the second, elsewhere: a restic repository of its own,
 * `<prefix>-restic` in the bucket, encrypted by restic on the machine with the
 * passphrase, which lives in /etc/sitesolide/dashboard-backup.env and, above
 * all, in its owner's password manager. Without it, the copies are noise. It
 * is filled by `restic copy` from the server's repository (run.ts), and read
 * back anywhere with stock restic (README).
 *
 * Absent configuration, nothing here runs and nothing leaves the machine:
 * local snapshots only, exactly as before. Half a configuration is an error the
 * dashboard shows, not a silent fallback: someone who set three variables out
 * of five believes they have offsite copies.
 */
import type { Repository } from "./restic";

export type Offsite = {
  endpoint: string;
  bucket: string;
  region: string | null;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
  passphrase: string;
  /** The bucket's restic repository: `s3:<endpoint>/<bucket>/<prefix>-restic`, or a folder for the tests. */
  repository: string;
};

/** `null`: no bucket, local only. `{ error }`: a configuration started and not finished. */
export type OffsiteSetting = Offsite | null | { error: string };

export const DEFAULT_PREFIX = "sitesolide";

/** What follows the prefix in the repository's path. */
export const REPOSITORY_SUFFIX = "-restic";

/** A passphrase shorter than this is refused: offsite copies stay off rather than weakly sealed. */
export const MIN_PASSPHRASE = 16;

export const OFFSITE_VARIABLES = [
  "BACKUP_S3_ENDPOINT",
  "BACKUP_S3_BUCKET",
  "BACKUP_S3_ACCESS_KEY_ID",
  "BACKUP_S3_SECRET_ACCESS_KEY",
  "BACKUP_ENCRYPTION_PASSPHRASE",
] as const;

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

/**
 * The bucket's settings, judged. No value of them ever enters a message: the
 * variables are named, never quoted. `BACKUP_OFFSITE_REPOSITORY` replaces the
 * repository drawn from them by a folder, the tests' bucket, and only with
 * `BACKUP_ISOLATION=none`, the workstation's: the file the dashboard's Secrets
 * page writes cannot point root's restic at a backend that runs programs,
 * `sftp:` or `rclone:` (config.ts refuses `none` to root under systemd).
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
  const endpoint = url.toString().replace(/\/+$/, "");
  const bucket = env.BACKUP_S3_BUCKET!;
  return {
    endpoint,
    bucket,
    region: (env.BACKUP_S3_REGION ?? "") === "" ? null : env.BACKUP_S3_REGION!,
    accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID!,
    secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY!,
    prefix,
    passphrase: env.BACKUP_ENCRYPTION_PASSPHRASE!,
    repository:
      env.BACKUP_ISOLATION === "none" && (env.BACKUP_OFFSITE_REPOSITORY ?? "") !== ""
        ? env.BACKUP_OFFSITE_REPOSITORY!
        : `s3:${endpoint}/${bucket}/${prefix}${REPOSITORY_SUFFIX}`,
  };
}

/**
 * The bucket's repository as restic is handed it: the passphrase in the
 * environment of that call alone, the credentials as its S3 backend reads
 * them, the region when one is set (restic's default is us-east-1).
 */
export function bucketRepository(offsite: Offsite): Repository {
  return {
    url: offsite.repository,
    password: { value: offsite.passphrase },
    backend: {
      AWS_ACCESS_KEY_ID: offsite.accessKeyId,
      AWS_SECRET_ACCESS_KEY: offsite.secretAccessKey,
      ...(offsite.region === null ? {} : { AWS_DEFAULT_REGION: offsite.region }),
    },
    store: "offsite",
  };
}

/**
 * A bucket's error, fit for the journal: the provider's own words, with any
 * of the credentials in them replaced, should a provider ever quote them, and
 * no query string, where a presigned URL would carry a signature.
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
    BACKUP_OFFSITE_REPOSITORY: offsite.repository,
    BACKUP_ISOLATION: "none",
  };
}

/** What the dashboard may show of the bucket: where it is, never how to get in. */
export function offsiteTarget(offsite: Offsite): string {
  return `${offsite.bucket} at ${new URL(offsite.endpoint).host}`;
}
