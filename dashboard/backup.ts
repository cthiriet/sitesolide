#!/usr/bin/env bun
/**
 * The backup component: snapshots every project's data folder on a timer,
 * keeps them by a retention policy, copies them encrypted to a bucket if one
 * is configured, and restores one project at a time when the dashboard asks.
 *
 *   systemctl start sitesolide-backup.service            a run, now
 *   systemctl start sitesolide-restore@cms.service       a restore, from the steward only
 *   cat /var/lib/sitesolide-backup/last-run.json
 *
 * Root orchestrates and never opens a project's files: the copy and the
 * extraction run as the project's own account, in transient units confined
 * like its service (src/backup/runner.ts). All the judgement is in
 * src/backup/, tested without a VM; what is left to the machine is listed in
 * src/backup/README.md, with the commands that check it.
 *
 * Like the steward and the gatekeeper, it does not travel with the
 * dashboard's code: bin/deploy-backup.sh builds it into a single file and
 * installs it under /usr/local/lib/sitesolide/, as root:root.
 *
 * NEVER `caddy stop` or `caddy start`: nothing here touches Caddy, and nothing
 * ever should. See the Production section of CLAUDE.md.
 */
import { main } from "./src/backup/main";

process.exit(await main(process.argv.slice(2), process.env));
