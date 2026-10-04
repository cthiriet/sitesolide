#!/usr/bin/env bun
/**
 * The installer: deploys one project on the machine for a team token, launched
 * by systemd under root's identity, one deployment per start.
 *
 *   systemctl start --no-block sitesolide-installer@cms.service
 *   cat /run/sitesolide-installer/<deployment>.json
 *
 * It is the steward that launches it, after judging the token, never the
 * dashboard. All the judgement is in src/installer/ and src/control/, tested
 * without a VM; the archive is read by the project's own account, never by
 * root (src/installer/real.ts). The same file, started with `--extract`, is
 * that reader.
 *
 * Like the steward and the gatekeeper, it does not travel with the dashboard's
 * code: bin/deploy-installer.sh builds it into a single file and installs it
 * under /usr/local/lib/sitesolide/, as root:root.
 *
 * NEVER `caddy stop` or `caddy start`: see the Production section of CLAUDE.md.
 */
import { main } from "./src/installer/main";

process.exit(await main(process.argv.slice(2), process.env));
