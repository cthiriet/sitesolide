/**
 * A test scheduled run: its timer starts it, it does its work and exits, and
 * nothing runs until the next time. The work is writing when it ran, in the
 * project's data folder.
 */
await Bun.write(`${process.env.DATA_DIR ?? "."}/last-digest.txt`, `${new Date().toISOString()}\n`);
