/**
 * What the backup tests share: a project's data folder with real SQLite
 * databases, a writer that keeps changing one of them while a snapshot is
 * taken, and the configuration of the component on a throwaway tree, with a
 * real restic repository on restic's local backend.
 *
 * restic is a prerequisite of these tests, like Bun: `brew install restic`
 * on a workstation, `apt-get install restic` on Debian. Without it, the tests
 * that store snapshots are skipped, and say so once.
 *
 * The writer moves money between accounts, one transaction at a time: the
 * total never changes inside a transaction, so a snapshot that caught one half
 * of a transfer would show it, and `PRAGMA integrity_check` says the rest.
 */
import { Database } from "bun:sqlite";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configFrom, type BackupConfig } from "../src/backup/config";
import { readListing, type Stored } from "../src/backup/restic";

/** restic on this workstation, which the tests run for real. */
export const RESTIC = Bun.which("restic");
export const NO_RESTIC = RESTIC === null;
if (NO_RESTIC) {
  console.warn("backup tests: restic is not installed, the tests that store snapshots are skipped (brew install restic, or apt-get install restic)");
}

/**
 * One repository per test process, copied for every tree. Every copy shares
 * its key, which the offsite tests also hand as the bucket's passphrase, the
 * bucket being another copy. `bun test` fires no `exit` event, and a module is
 * shared by every file of a run: the folder is named by the process, and the
 * next run removes those of processes that are gone.
 *
 * **It is laid by hand, with a cheap key.** `restic init` calibrates scrypt
 * for three seconds, and every call then derives the key at the parameters
 * it chose (N=32768, r=8, p=14 here, half a second): most of what a backup
 * test spent. The template is written as restic's design document describes
 * a repository of version 2: a master key drawn here, sealed in a key file
 * with N=1024, r=8, p=1 (scrypt, AES-256-CTR, Poly1305-AES over the
 * ciphertext, the file named by its SHA-256), the config sealed with the
 * master key, and the empty folders. `restic cat config` must open it; should
 * a future restic refuse it, restic initialises the template instead, its key
 * resealed the same way, or kept as restic wrote it. Test repositories only:
 * nothing of this reaches a machine, and no key is committed.
 */
let template: { repository: string; key: string; cheap: boolean } | null = null;
export function repositoryTemplate(): { repository: string; key: string; cheap: boolean } {
  if (template !== null && existsSync(template.repository)) return template;
  for (const name of readdirSync(tmpdir())) {
    const pid = /^backup-template-(\d+)$/.exec(name)?.[1];
    if (pid !== undefined && Number(pid) !== process.pid && !alive(Number(pid))) rmSync(join(tmpdir(), name), { recursive: true, force: true });
  }
  const folder = join(tmpdir(), `backup-template-${process.pid}`);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { mode: 0o700 });
  const key = join(folder, "key");
  const password = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64");
  writeFileSync(key, password, { mode: 0o600 });
  const repository = join(folder, "repository");
  const env = { PATH: Bun.env.PATH ?? "", RESTIC_CACHE_DIR: join(folder, "cache") };
  const opens = () => {
    const opened = Bun.spawnSync([RESTIC!, "-r", repository, "--no-cache", "--no-lock", "cat", "config", "--password-file", key], { stdin: "ignore", env });
    if (opened.exitCode !== 0) throw new Error(opened.stderr.toString());
  };
  let cheap = true;
  try {
    layRepository(repository, password);
    opens();
  } catch (error) {
    rmSync(repository, { recursive: true, force: true });
    console.warn(`backup tests: the repository laid by hand was refused, restic initialises it (${(error as Error).message.trim().slice(0, 120)})`);
    const made = Bun.spawnSync([RESTIC!, "-r", repository, "init", "-q", "--password-file", key], { stdin: "ignore", env });
    if (made.exitCode !== 0) throw new Error(`restic init failed: ${made.stderr.toString()}`);
    const keys = join(repository, "keys");
    const [calibrated] = readdirSync(keys);
    const original = readFileSync(join(keys, calibrated!));
    try {
      const cheap = cheapKey(original.toString(), password);
      rmSync(join(keys, calibrated!), { force: true });
      writeFileSync(join(keys, cheap.id), cheap.body, { mode: 0o400 });
      opens();
    } catch (refused) {
      for (const name of readdirSync(keys)) rmSync(join(keys, name), { force: true });
      writeFileSync(join(keys, calibrated!), original, { mode: 0o400 });
      cheap = false;
      console.warn(`backup tests: the cheaper key was refused, the calibrated one is kept (${(refused as Error).message.trim().slice(0, 120)})`);
    }
  }
  template = { repository, key, cheap };
  return template;
}

/** Whether a process of this pid exists: signal 0 tests it and sends nothing. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The chunker polynomial of restic's own tests, irreducible: a test repository needs no other. */
const POLYNOMIAL = "3da3358b4dc173";

/** The bits of a Poly1305 key r that are always clear, as restic stores r. */
const R_MASK = [0xff, 0xff, 0xff, 0x0f, 0xfc, 0xff, 0xff, 0x0f, 0xfc, 0xff, 0xff, 0x0f, 0xfc, 0xff, 0xff, 0x0f];

type MasterKey = { encryption: Uint8Array; macKey: Uint8Array; macR: Uint8Array };

/** An empty repository of version 2 at `path`, opened by `password` through a cheap key. */
function layRepository(path: string, password: string): void {
  const master: MasterKey = { encryption: randomBytes(32), macKey: randomBytes(16), macR: randomBytes(16).map((byte, i) => byte & R_MASK[i]!) };
  for (const name of ["index", "keys", "locks", "snapshots"]) mkdirSync(join(path, name), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 256; i++) mkdirSync(join(path, "data", i.toString(16).padStart(2, "0")), { recursive: true, mode: 0o700 });
  // The config is never compressed: it says the version that decides the rest.
  const config = JSON.stringify({ version: 2, id: randomBytes(32).toString("hex"), chunker_polynomial: POLYNOMIAL });
  writeFileSync(join(path, "config"), seal(master, Buffer.from(config)), { mode: 0o400 });
  const plain = JSON.stringify({
    mac: { k: Buffer.from(master.macKey).toString("base64"), r: Buffer.from(master.macR).toString("base64") },
    encrypt: Buffer.from(master.encryption).toString("base64"),
  });
  const file = { created: new Date().toISOString(), username: "test", hostname: "test", kdf: "scrypt" };
  const sealed = keyFile(file, password, Buffer.from(plain));
  writeFileSync(join(path, "keys", sealed.id), sealed.body, { mode: 0o400 });
}

/** restic's sealing: a random nonce, AES-256-CTR, and Poly1305-AES over the ciphertext. */
function seal(key: MasterKey, plaintext: Uint8Array): Buffer {
  const nonce = randomBytes(16);
  const cipher = createCipheriv("aes-256-ctr", key.encryption, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, Buffer.from(poly1305Aes(key.macKey, key.macR, nonce, ciphertext))]);
}

/** The key a password derives with scrypt, split as restic splits it. */
function derive(password: string, N: number, r: number, p: number, salt: Uint8Array): MasterKey {
  const bytes = scryptSync(password, salt, 64, { N, r, p, maxmem: 2 ** 31 });
  return { encryption: bytes.subarray(0, 32), macKey: bytes.subarray(32, 48), macR: bytes.subarray(48, 64) };
}

/** A key file sealing `master` with N=1024, r=8, p=1, and its name, the SHA-256 of its content. */
function keyFile(fields: Record<string, unknown>, password: string, master: Uint8Array): { id: string; body: string } {
  const salt = randomBytes(64);
  const data = seal(derive(password, 1024, 8, 1, salt), master);
  const body = JSON.stringify({ ...fields, N: 1024, r: 8, p: 1, salt: salt.toString("base64"), data: data.toString("base64") });
  return { id: new Bun.CryptoHasher("sha256").update(body).digest("hex"), body };
}

/** The little-endian integer of some bytes, as Poly1305 reads them. */
function littleEndian(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}

/** Poly1305-AES, restic's MAC: the Poly1305 key r, and s from AES-128 over the nonce. */
function poly1305Aes(macKey: Uint8Array, macR: Uint8Array, nonce: Uint8Array, message: Uint8Array): Uint8Array {
  const aes = createCipheriv("aes-128-ecb", macKey, null);
  aes.setAutoPadding(false);
  const s = Buffer.concat([aes.update(nonce), aes.final()]);
  const p = (1n << 130n) - 5n;
  const r = littleEndian(macR) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  let accumulator = 0n;
  for (let i = 0; i < message.length; i += 16) {
    const block = message.subarray(i, Math.min(i + 16, message.length));
    accumulator = ((accumulator + littleEndian(block) + (1n << BigInt(8 * block.length))) * r) % p;
  }
  let tag = (accumulator + littleEndian(s)) & ((1n << 128n) - 1n);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number(tag & 0xffn);
    tag >>= 8n;
  }
  return out;
}

/** A restic key file's content resealed with N=1024, r=8, p=1, and its name. */
function cheapKey(content: string, password: string): { id: string; body: string } {
  const file = JSON.parse(content) as { N: number; r: number; p: number; salt: string; data: string };
  const sealed = Buffer.from(file.data, "base64");
  const nonce = sealed.subarray(0, 16);
  const ciphertext = sealed.subarray(16, sealed.length - 16);
  const old = derive(password, file.N, file.r, file.p, Buffer.from(file.salt, "base64"));
  if (Buffer.compare(Buffer.from(poly1305Aes(old.macKey, old.macR, nonce, ciphertext)), sealed.subarray(sealed.length - 16)) !== 0) throw new Error("the key file does not open with the password");
  const decipher = createCipheriv("aes-256-ctr", old.encryption, nonce);
  return keyFile(file, password, Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

/** A copy of the template repository at `path`, with the template's key. */
export function copyRepository(path: string): void {
  cpSync(repositoryTemplate().repository, path, { recursive: true });
}

/**
 * restic run synchronously against a tree's repository, for what a test reads
 * of it or seeds in it. A listing and a dump take no lock: restic waits a
 * moment after taking one, and a test reads nothing a run writes meanwhile.
 */
export function restic(config: BackupConfig, args: string[], repository = config.repository): { code: number; stdout: Buffer; stderr: string } {
  const reads = args[0] === "snapshots" || args[0] === "dump" || args[0] === "cat";
  const run = Bun.spawnSync([config.restic, "-r", repository, "--password-file", config.repositoryKey, ...(reads ? ["--no-lock"] : []), ...args], {
    stdin: "ignore",
    env: { PATH: Bun.env.PATH ?? "", TZ: "UTC", RESTIC_CACHE_DIR: config.resticCache },
  });
  return { code: run.exitCode, stdout: run.stdout, stderr: run.stderr.toString() };
}

/** A repository's snapshots of ours, newest first. */
export function stored(config: BackupConfig, repository = config.repository): Stored[] {
  const listed = restic(config, ["snapshots", "--json", "-q"], repository);
  if (listed.code !== 0) throw new Error(`restic snapshots failed: ${listed.stderr}`);
  return readListing(listed.stdout.toString());
}

/** A snapshot dumped into a plain tar file of the tree: what `tar -xf` and the readers of a test take. */
export function dumped(config: BackupConfig, folder: string, name: string, repository = config.repository): string {
  const found = stored(config, repository).find((snapshot) => snapshot.folder === folder && snapshot.name === name);
  if (found === undefined) throw new Error(`no snapshot ${name} in ${repository}`);
  const out = join(config.stagingFolder, `${name}.${crypto.randomUUID()}.dump`);
  const run = restic(config, ["dump", found.id, `/${folder}.tar`], repository);
  if (run.code !== 0) throw new Error(`restic dump failed: ${run.stderr}`);
  writeFileSync(out, run.stdout);
  return out;
}

/** The names a project's snapshots carry in a repository. */
export function names(config: BackupConfig, folder: string, repository = config.repository): string[] {
  return stored(config, repository)
    .filter((snapshot) => snapshot.folder === folder)
    .map((snapshot) => snapshot.name);
}

export const ACCOUNTS = 2000;
export const BALANCE = 100;

/** A WAL database of accounts, as a project would open it. */
export function createAccounts(path: string, padding = 2000): void {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA busy_timeout = 10000");
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL, pad BLOB)");
  const insert = db.query("INSERT INTO accounts (balance, pad) VALUES (?, randomblob(?))");
  db.transaction(() => {
    for (let i = 0; i < ACCOUNTS; i++) insert.run(BALANCE, padding);
  })();
  db.close();
}

/** A database left in rollback-journal mode, the SQLite default some projects keep. */
export function createLegacy(path: string): void {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = DELETE");
  db.run("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  db.run("INSERT INTO notes (body) VALUES ('été'), ('second')");
  db.close();
}

const WRITER = `
const { Database } = require("bun:sqlite");
const [path, durationMs, ready] = process.argv.slice(2);
const db = new Database(path);
db.run("PRAGMA busy_timeout = 10000");
db.run("PRAGMA journal_mode = WAL");
const debit = db.query("UPDATE accounts SET balance = balance - 1 WHERE id = ?");
const credit = db.query("UPDATE accounts SET balance = balance + 1 WHERE id = ?");
const move = db.transaction((a, b) => { debit.run(a); credit.run(b); });
let n = 0;
const end = Date.now() + Number(durationMs);
require("node:fs").writeFileSync(ready, "1");
while (Date.now() < end) {
  move(1 + Math.floor(Math.random() * ${ACCOUNTS}), 1 + Math.floor(Math.random() * ${ACCOUNTS}));
  n++;
}
db.close();
console.log(n);
`;

/** Starts the writer; resolves once it writes, and gives its count of transactions at the end. */
export async function startWriter(folder: string, database: string, durationMs: number): Promise<{ done: Promise<number> }> {
  const script = join(folder, `writer-${crypto.randomUUID()}.js`);
  const ready = `${script}.ready`;
  writeFileSync(script, WRITER);
  const child = Bun.spawn(["bun", script, database, String(durationMs), ready], { stdout: "pipe", stderr: "inherit" });
  while (!(await Bun.file(ready).exists())) await Bun.sleep(10);
  return { done: child.exited.then(async () => Number((await child.stdout.text()).trim())) };
}

/** The total of the accounts, and the database's own verdict on itself. */
export function audit(path: string): { total: number; rows: number; integrity: string } {
  const db = new Database(path, { readonly: true });
  try {
    const { total, rows } = db.query("SELECT sum(balance) AS total, count(*) AS rows FROM accounts").get() as { total: number; rows: number };
    const { integrity_check } = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
    return { total, rows, integrity: integrity_check };
  } finally {
    db.close();
  }
}

/** The script the children run: the component's entry point, as the unit runs its build. */
export const SCRIPT = resolve(import.meta.dir, "..", "backup.ts");

export type Tree = { root: string; sites: string; config: BackupConfig };

/**
 * The component's folders on a throwaway tree, with no isolation and no
 * owners: the workstation's way. Its repository is a copy of the template,
 * unless the test runs without restic.
 */
export function tree(extra: Record<string, string> = {}): Tree {
  const root = mkdtempSync(join(tmpdir(), "backup-tree-"));
  const sites = join(root, "sites");
  for (const name of ["sites", "backups", "state", "run", "staging", "cache"]) mkdirSync(join(root, name));
  writeFileSync(join(root, "passwd"), "");
  if (!NO_RESTIC) {
    copyRepository(join(root, "repository"));
    copyFileSync(repositoryTemplate().key, join(root, "key"));
  }
  return { root, sites, config: configAt(root, extra) };
}

/**
 * A copy of a whole tree, its projects, repository, state and all, under a
 * fresh root, with the same settings: a state a file's tests share, made once.
 */
export function cloneTree(made: Tree, extra: Record<string, string> = {}): Tree {
  const root = mkdtempSync(join(tmpdir(), "backup-tree-"));
  cpSync(made.root, root, { recursive: true });
  return { root, sites: join(root, "sites"), config: configAt(root, extra) };
}

/** The component's configuration for a tree at `root`. */
function configAt(root: string, extra: Record<string, string>): BackupConfig {
  const sites = join(root, "sites");
  return configFrom(
    {
      SITES_DIR: sites,
      BACKUP_FOLDER: join(root, "backups"),
      BACKUP_STATE_FOLDER: join(root, "state"),
      BACKUP_RUN_FOLDER: join(root, "run"),
      BACKUP_STAGING_FOLDER: join(root, "staging"),
      BACKUP_REPOSITORY: join(root, "repository"),
      BACKUP_REPOSITORY_KEY: join(root, "key"),
      BACKUP_RESTIC: RESTIC ?? "/usr/bin/restic",
      BACKUP_RESTIC_CACHE: join(root, "cache"),
      ACCOUNTS_FILE: join(root, "passwd"),
      BACKUP_ISOLATION: "none",
      BACKUP_DISK_RESERVE: "0",
      SITESOLIDE_ZONE: "test-zone.invalid",
      ...extra,
    },
    { bun: process.execPath, script: SCRIPT },
  );
}

/** A deployed app: its folder, its manifest, its data folder. */
export function project(sites: string, slug: string, manifest: Record<string, unknown> = {}): string {
  const data = join(sites, slug, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(sites, slug, "sitesolide.json"), JSON.stringify({ slug, start: "bun run server.ts", port: 3040, ...manifest }));
  return data;
}
