#!/usr/bin/env bun
/**
 * The egress proxy: what lets a project reach the hosts its manifest lists,
 * and lends it the credentials the dashboard granted it. See README.md.
 *
 * This file only wires: settings, the database, the policy, the two
 * listeners, the timers, the stop. The decisions live in src/, tested without
 * a machine.
 *
 * Unlike a project, it does not travel with `sitesolide deploy`:
 * bin/deploy-egress.sh builds it into one file, installs it as root:root under
 * /usr/local/lib/sitesolide/ and runs it as its own account, sitesolide-egress.
 */
import { join } from "node:path";
import {
  ACCOUNTS_FILE,
  CONFIG_DIR,
  CONNECTORS_PORT,
  DASHBOARD_ACCOUNT,
  DATA_DIR,
  FLUSH_MS,
  LISTEN_ADDRESS,
  PROC_NET,
  PROXY_PORT,
  SITES_DIR,
  WATCH_MS,
} from "./src/config";
import { createAudit } from "./src/audit";
import { startConnectors } from "./src/connectors";
import { openDatabase } from "./src/database";
import { createPolicy } from "./src/policy";
import { hostIsLittleEndian, identify, machineReadings, type Peer } from "./src/proc-net";
import { startProxy } from "./src/proxy";
import { machineAddresses, systemLookup } from "./src/resolve";

const db = openDatabase(join(DATA_DIR, "egress.db"));
const audit = createAudit(db);
const policy = createPolicy(SITES_DIR, CONFIG_DIR);
const readings = machineReadings(PROC_NET, ACCOUNTS_FILE);
const littleEndian = hostIsLittleEndian();
const started = new Date().toISOString();
const who = (peer: Peer) => identify(readings, peer, littleEndian);
// One reading of the interfaces for both listeners.
const ownAddresses = machineAddresses();

/**
 * The connectors and grants, compared to what the audit last saw. Not while
 * either file fails to read: the proxy lends nothing from it then, and that
 * empty list must not be recorded as every connector removed.
 */
let reported = "";
function watch(): void {
  const lending = policy.lending();
  if (lending.errors.length > 0) {
    const message = lending.errors.join("; ");
    if (message !== reported) console.error(`egress: ${message}, nothing is lent from it`);
    reported = message;
    return;
  }
  reported = "";
  const changes = audit.observe(lending.connectors, lending.grants);
  if (changes > 0) console.log(`egress: ${changes} change(s) to the connectors or their grants recorded`);
}

const proxy = startProxy({
  hostname: LISTEN_ADDRESS,
  port: PROXY_PORT,
  identify: who,
  egressOf: (slug) => policy.project(slug)?.egress ?? null,
  lookup: systemLookup,
  ownAddresses,
  audit,
});

const connectors = startConnectors({
  hostname: LISTEN_ADDRESS,
  port: CONNECTORS_PORT,
  identify: who,
  policy,
  lookup: systemLookup,
  ownAddresses,
  audit,
  dashboardAccount: DASHBOARD_ACCOUNT,
  // How many of the machine's own addresses it refuses: null says the
  // interfaces could not be read, and that every egress is refused for it.
  // `buffered`, the bytes waiting for a slow reader, against the budgets of
  // src/proxy.ts.
  status: () => ({ started, openTunnels: proxy.open(), buffered: proxy.buffered(), ownAddresses: ownAddresses()?.size ?? null }),
});

watch();
const watcher = setInterval(watch, WATCH_MS);
const flusher = setInterval(() => {
  try {
    audit.flush();
  } catch (error) {
    console.error(`egress: audit not written (${error instanceof Error ? error.name : "unknown"})`);
  }
}, FLUSH_MS);
const pruner = setInterval(() => audit.prune(), 60 * 60_000);
audit.prune();

console.log(
  [
    `egress proxy on ${LISTEN_ADDRESS}:${proxy.port}`,
    `connectors on ${LISTEN_ADDRESS}:${connectors.port}`,
    `sites ${SITES_DIR}`,
    `config ${CONFIG_DIR}`,
    `${littleEndian ? "little" : "big"}-endian`,
  ].join(", "),
);

/** The counters of the last minute are written before stopping. */
let stopping = false;
function shutDown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`egress: ${signal}, stopping`);
  clearInterval(watcher);
  clearInterval(flusher);
  clearInterval(pruner);
  proxy.stop();
  connectors.stop(true);
  try {
    audit.flush();
  } finally {
    db.close();
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutDown("SIGTERM"));
process.on("SIGINT", () => shutDown("SIGINT"));
