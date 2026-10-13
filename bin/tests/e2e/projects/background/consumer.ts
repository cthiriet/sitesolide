/**
 * A test worker: it listens on nothing and runs for good, as a queue's
 * consumer waits for work rather than for a request. The queue a real one
 * would read is a pause here.
 */
for (;;) {
  await Bun.sleep(60_000);
}
