/**
 * A test scheduled run, the only kind this project has: every one of its
 * services runs at the times it names, and between them nothing runs. It
 * writes what it did in the project's data folder.
 */
const task = process.argv.includes("--cleanup") ? "cleanup" : "report";
await Bun.write(`${process.env.DATA_DIR ?? "."}/last-${task}.txt`, `${new Date().toISOString()}\n`);
