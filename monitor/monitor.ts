#!/usr/bin/env bun
/**
 * The monitor: one pass over the machine, started every minute by
 * sitesolide-monitor.timer, under a dynamic account with no privilege at all.
 *
 * It checks that Caddy runs, that every served site answers over HTTPS, that
 * no project's unit failed, that disk and memory have room, that no
 * certificate is about to expire and that the last backup is recent; it
 * alerts once when something goes down and once when it recovers; and it
 * pings an outside heartbeat that notices the machine itself dying. See
 * monitor/README.md.
 *
 * Built into a single file by bin/deploy-monitor.sh and installed as
 * /usr/local/lib/sitesolide/monitor.js. On a test tree, the paths come from
 * the environment, read only with --test-tree, which the unit never passes
 * (src/config.ts says why):
 *
 *   SITESOLIDE_ZONE=test-zone.invalid SITES_DIR=/tmp/attempt/srv STATE_DIRECTORY=/tmp/attempt/state bun monitor.ts --test-tree
 */
import { TEST_TREE_FLAG, readConfig } from "./src/config";
import { createMachine } from "./src/machine";
import { crashRequest } from "./src/notify";
import { run, SEND_TIMEOUT_MS } from "./src/run";

const read = readConfig(process.env, { testTree: Bun.argv.slice(2).includes(TEST_TREE_FLAG) });
if ("error" in read) {
  console.error(`monitor: ${read.error}`);
  process.exit(1);
}

const machine = createMachine(read.config);
try {
  await run(read.config, machine, Date.now());
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`monitor: the run failed: ${error instanceof Error ? (error.stack ?? reason) : reason}`);
  if (read.config.heartbeatUrl !== null) {
    await machine.send(crashRequest(read.config.heartbeatUrl, reason.slice(0, 200)), SEND_TIMEOUT_MS);
  }
  process.exit(1);
}
