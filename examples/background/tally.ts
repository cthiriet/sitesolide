/**
 * The scheduled run: its timer starts it every quarter of an hour, it records
 * one row, the worker's count at that moment, and exits. Between two runs
 * nothing runs, and nothing is spent.
 *
 * Exiting 0 leaves its unit inactive until the next run. An exception exits
 * non-zero and leaves it failed until the next run, which `sitesolide status`
 * shows, and the error is in `sitesolide logs`.
 */
import { openDatabase } from "./database";

const db = openDatabase();
const at = new Date().toISOString();
const beats = db.query<{ beats: number }, []>("SELECT beats FROM worker WHERE id = 1").get()?.beats ?? 0;
db.query<unknown, { at: string; beats: number }>("INSERT INTO runs (at, beats) VALUES ($at, $beats)").run({ at, beats });
// A thousand runs, ten days at this schedule, are enough to show, and keep the
// table small however long the project lives.
db.run("DELETE FROM runs WHERE id <= (SELECT max(id) FROM runs) - 1000");
db.close();

console.log(`run recorded at ${at}, the worker at ${beats} beats, shown at ${process.env.PUBLIC_URL ?? "http://127.0.0.1:3041"}`);
