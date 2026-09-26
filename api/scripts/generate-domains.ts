/**
 * Writes the client domain table to standard output, from the
 * `sitesolide.json` files of /srv/sites. Run by `bin/generate-domains.sh`,
 * which installs it into /etc/caddy/domaines.map and reloads Caddy.
 *
 * The logic lives in src/table.ts, this file only calls it: any error there
 * becomes a non-zero exit code, which interrupts the install script before it
 * touches the configuration in service.
 */
import { buildTable, render } from "../src/table";

const SITES_DIR = process.env.SITES_DIR ?? "/srv/sites";

console.log(render(buildTable(SITES_DIR)));
