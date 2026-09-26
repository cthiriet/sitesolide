/**
 * The gatekeeper launched by systemd: read the instance, mount the real
 * machine, carry the transaction through, write the result.
 *
 * `dashboard/gatekeeper.ts` does nothing but call `main`: the body lives
 * here, under src/, so that typing and the tests cover it.
 *
 * The exit code does not carry the verdict. 0 as soon as a result is written,
 * `refusal` and `failure` included: it is the file that is authoritative, and a
 * unit in failure for an ordinary refusal would fill `systemctl --failed` with
 * false alarms. Non-zero only for what could not produce a result: a malformed
 * launch (unit name, action, slug), or an unforeseen error.
 */
import { readFileSync } from "node:fs";
import { readLaunch } from "./instance";
import { createMachine, writeResult, realSystemctl, type MachineConfig, type Systemctl } from "./real";
import { run, type Result } from "./transaction";

export type Environment = Record<string, string | undefined>;

/**
 * Each path comes from a variable, with the production default, like the
 * collector. On the workstation, a test tree:
 *
 *   GATEKEEPER_ACTION=on SITES_DIR=$E/srv BLOCKS_FOLDER=$E/sites CADDYFILE=$E/Caddyfile \
 *     CADDY_ENV_FILE=$E/cloudflare.env RUN_FOLDER=$E/run BLOCK_OWNER= \
 *     PROBE_PORT=8443 PROBE_CA=$E/ca.pem SYSTEMCTL=/usr/bin/false \
 *     bun gatekeeper.ts sitesolide-gatekeeper-on@attempt.service
 */
export function configFrom(env: Environment, systemctl?: Systemctl): MachineConfig {
  const owner = env.BLOCK_OWNER ?? "0:0";
  let blockOwner: MachineConfig["blockOwner"] = null;
  if (owner !== "") {
    const [uid, gid] = owner.split(":").map(Number);
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error("BLOCK_OWNER: uid:gid expected");
    blockOwner = { uid: uid!, gid: gid! };
  }
  const port = Number(env.PROBE_PORT ?? "443");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PROBE_PORT: a port expected");

  return {
    sitesDir: env.SITES_DIR ?? "/srv/sites",
    blocksFolder: env.BLOCKS_FOLDER ?? "/etc/caddy/sites",
    caddyfile: env.CADDYFILE ?? "/etc/caddy/Caddyfile",
    caddyEnvFile: env.CADDY_ENV_FILE ?? "/etc/caddy/cloudflare.env",
    zoneEnvFile: env.ZONE_ENV_FILE ?? "/etc/caddy/sitesolide.env",
    // Absolute paths: under a minimal PATH, nothing to look for.
    caddy: env.CADDY ?? "/usr/bin/caddy",
    runFolder: env.RUN_FOLDER ?? "/run/sitesolide-gatekeeper",
    blockOwner,
    probeConfig: {
      address: env.PROBE_ADDRESS ?? "127.0.0.1",
      port,
      ca: env.PROBE_CA === undefined || env.PROBE_CA === "" ? null : readFileSync(env.PROBE_CA, "utf8"),
    },
    caddyUnit: env.CADDY_UNIT ?? "caddy.service",
    collectorUnit: env.COLLECTOR_UNIT ?? "sitesolide-collector.service",
    systemctl: systemctl ?? realSystemctl(env.SYSTEMCTL ?? "/usr/bin/systemctl"),
    log: (line) => console.log(line),
  };
}

export async function main(argv: string[], env: Environment): Promise<number> {
  const launch = readLaunch(argv, env.GATEKEEPER_ACTION);
  if (!launch.ok) {
    // Nothing is read or written: neither result, nor lock. The input comes
    // from outside: quoted bounded and escaped, never as it stands.
    console.error(`gatekeeper: refused to start: ${launch.reason} (got ${JSON.stringify((argv[0] ?? "").slice(0, 80))})`);
    return 2;
  }
  const { instance } = launch;

  const config = configFrom(env);
  // No zone by default: the gatekeeper probes `<slug>.<zone>` after reloading
  // Caddy, and an invented zone would make the probe fail on every site, and
  // therefore cancel a perfectly sound transaction.
  const zone = env.SITESOLIDE_ZONE ?? "";
  if (zone === "") throw new Error("SITESOLIDE_ZONE: the served zone is required");
  let result: Result;
  try {
    result = await run(createMachine(config), { ...instance, zone }, config.runFolder);
  } catch (error) {
    console.error(`gatekeeper ${instance.slug}: unexpected error: ${(error as Error).message}`);
    try {
      writeResult(config.runFolder, instance.slug, {
        a: Date.now(),
        result: "failure",
        message: "unexpected error in the gatekeeper, check its journal and Caddy",
        requested: false,
        installed: false,
      } satisfies Result);
    } catch {
      // Nothing more to do: the log already carries the error.
    }
    return 1;
  }

  try {
    writeResult(config.runFolder, instance.slug, result);
  } catch (error) {
    console.error(`gatekeeper ${instance.slug}: result not written: ${(error as Error).message}`);
    return 1;
  }
  return 0;
}
