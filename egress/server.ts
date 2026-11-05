#!/usr/bin/env bun
/**
 * The egress proxy: what lets a project reach the hosts its manifest lists.
 * See README.md.
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
import { ACCOUNTS_FILE, DASHBOARD_ACCOUNT, DATA_DIR, FLUSH_MS, LISTEN_ADDRESS, PROC_NET, PROXY_PORT, SITES_DIR, STATUS_PORT } from "./src/config";
import { createAudit } from "./src/audit";
import { openDatabase } from "./src/database";
import { createPolicy } from "./src/policy";
import { hostIsLittleEndian, identify, machineReadings, type Peer } from "./src/proc-net";
import { startProxy } from "./src/proxy";
import { machineAddresses, systemLookup } from "./src/resolve";
import { startStatusPort } from "./src/status";

const db = openDatabase(join(DATA_DIR, "egress.db"));
const audit = createAudit(db);
const policy = createPolicy(SITES_DIR);
const readings = machineReadings(PROC_NET, ACCOUNTS_FILE);
const littleEndian = hostIsLittleEndian();
const started = new Date().toISOString();
const who = (peer: Peer) => identify(readings, peer, littleEndian);
// One reading of the interfaces: the proxy refuses them, the status port counts them.
const ownAddresses = machineAddresses();

const proxy = startProxy({
  hostname: LISTEN_ADDRESS,
  port: PROXY_PORT,
  identify: who,
  egressOf: (slug) => policy.project(slug)?.egress ?? null,
  lookup: systemLookup,
  ownAddresses,
  audit,
});

const status = startStatusPort({
  hostname: LISTEN_ADDRESS,
  port: STATUS_PORT,
  identify: who,
  audit,
  dashboardAccount: DASHBOARD_ACCOUNT,
  // One count of connections and of bytes for both ports: what it bounds,
  // descriptors and memory, is the process's. See src/admission.ts.
  admission: proxy.admission,
  // How many of the machine's own addresses it refuses: null says the
  // interfaces could not be read, and that every egress is refused for it.
  // `buffered`, the bytes waiting for a slow reader on both ports, against
  // the budgets of src/proxy.ts.
  status: () => ({ started, openTunnels: proxy.open(), buffered: proxy.buffered(), ownAddresses: ownAddresses()?.size ?? null }),
});

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
    `status on ${LISTEN_ADDRESS}:${status.port}`,
    `sites ${SITES_DIR}`,
    `${littleEndian ? "little" : "big"}-endian`,
  ].join(", "),
);

/** The counters of the last minute are written before stopping. */
let stopping = false;
function shutDown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`egress: ${signal}, stopping`);
  clearInterval(flusher);
  clearInterval(pruner);
  proxy.stop();
  status.stop();
  try {
    audit.flush();
  } finally {
    db.close();
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutDown("SIGTERM"));
process.on("SIGINT", () => shutDown("SIGINT"));
