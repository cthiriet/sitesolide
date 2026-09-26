#!/usr/bin/env bun
/**
 * The gatekeeper: puts up or takes away a site's portal, launched by systemd
 * under root's identity, one transaction per startup.
 *
 *   systemctl start sitesolide-gatekeeper-on@cms.service
 *   systemctl start sitesolide-gatekeeper-off@cms.service
 *   cat /run/sitesolide-gatekeeper/cms.json
 *
 * It is the steward that launches it, never the dashboard: the dashboard has no
 * rights at all, and the steward does not reload Caddy itself. All the
 * judgement is in src/gatekeeper/, tested without a VM; the two units of
 * infra/gatekeeper/, one per action, bound what a compromised gatekeeper would
 * obtain all the same: each of them writes only in the directory of the site it
 * is named for.
 *
 * Like the steward, it does not travel with the dashboard's code:
 * bin/deploy-gatekeeper.sh builds it into a single file and installs it under
 * /usr/local/lib/sitesolide/, as root:root.
 *
 * NEVER `caddy stop` or `caddy start`: see the Production section of CLAUDE.md.
 */
import { main } from "./src/gatekeeper/main";

process.exit(await main(process.argv.slice(2), process.env));
