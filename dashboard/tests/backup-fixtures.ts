/**
 * What the backup tests share: a project's data folder with real SQLite
 * databases, a writer that keeps changing one of them while a snapshot is
 * taken, and the configuration of the component on a throwaway tree.
 *
 * The writer moves money between accounts, one transaction at a time: the
 * total never changes inside a transaction, so a snapshot that caught one half
 * of a transfer would show it, and `PRAGMA integrity_check` says the rest.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configFrom, type BackupConfig } from "../src/backup/config";

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

/** The component's folders on a throwaway tree, with no isolation and no owners: the workstation's way. */
export function tree(extra: Record<string, string> = {}): Tree {
  const root = mkdtempSync(join(tmpdir(), "backup-tree-"));
  const sites = join(root, "sites");
  for (const name of ["sites", "backups", "state", "run", "staging"]) mkdirSync(join(root, name));
  writeFileSync(join(root, "passwd"), "");
  const config = configFrom(
    {
      SITES_DIR: sites,
      BACKUP_FOLDER: join(root, "backups"),
      BACKUP_STATE_FOLDER: join(root, "state"),
      BACKUP_RUN_FOLDER: join(root, "run"),
      BACKUP_STAGING_FOLDER: join(root, "staging"),
      ACCOUNTS_FILE: join(root, "passwd"),
      BACKUP_ISOLATION: "none",
      BACKUP_DISK_RESERVE: "0",
      SITESOLIDE_ZONE: "test-zone.invalid",
      ...extra,
    },
    { bun: process.execPath, script: SCRIPT },
  );
  return { root, sites, config };
}

/** A deployed app: its folder, its manifest, its data folder. */
export function project(sites: string, slug: string, manifest: Record<string, unknown> = {}): string {
  const data = join(sites, slug, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(sites, slug, "sitesolide.json"), JSON.stringify({ slug, start: "bun run server.ts", port: 3040, ...manifest }));
  return data;
}
