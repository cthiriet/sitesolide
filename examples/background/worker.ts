/**
 * The worker: it runs for good and listens on nothing. It does, in the small,
 * what a queue's consumer or a bot holding a connection does: light work at a
 * steady pace, here a beat recorded every ten seconds.
 *
 * systemd stops it with SIGTERM, at a deployment, a restart from the
 * dashboard or a stop, and kills it if it is still there a minute and a half
 * later. It finishes the beat in progress, closes the database and exits.
 */
import { openDatabase } from "./database";

const INTERVAL_MS = 10_000;

const db = openDatabase();
const beat = db.query<unknown, { at: string }>("UPDATE worker SET beats = beats + 1, last_beat = $at WHERE id = 1");

let stopping = false;
let wake = () => {};
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopping = true;
    wake();
  });
}

console.log("worker started");
while (!stopping) {
  beat.run({ at: new Date().toISOString() });
  // A wait the stop cuts short: Bun.sleep would hold it for up to ten seconds.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, INTERVAL_MS);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

db.close();
console.log("worker stopped");
process.exit(0);
