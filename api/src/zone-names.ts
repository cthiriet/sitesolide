/**
 * The zone's sites, as the ask endpoint allows them with manual DNS, and how
 * a TLS policy says the zone is certified on demand: the one writing of those
 * rules every part of the platform reads them by.
 *
 *   - the shared service decides with them (src/zone.ts);
 *   - bin/deploy-caddy.sh, bin/generate-domains.sh, `sitesolide deploy` and
 *     `remove` write the list with ZONE_NAMES_COMMAND, through
 *     bin/cli/tls.ts;
 *   - the dashboard's installer writes it with zoneNamesScript, from the copy
 *     dashboard/scripts/borrow.ts makes;
 *   - the monitor reads the policy, to check each site's own certificate.
 *
 * Pure, and importing nothing: it is borrowed and bundled as it stands, and
 * this service, deployed alone, reads it beside its other modules.
 */

/** The zone's TLS policy, laid by `sitesolide setup`, imported by the Caddyfile's `(tls-zone)` snippet. */
export const TLS_ZONE_PATH = "/etc/caddy/tls-zone.caddy";

/** The labels of the sites deployed under the zone, one per line. */
export const ZONE_NAMES_PATH = "/etc/caddy/zone-names";

/** Where the sites are deployed, one folder each. */
export const SITES_PATH = "/srv/sites";

/** Whether a TLS policy turns on-demand issuance on: a line `on_demand` of its own, as Caddy reads it. */
export function onDemandPolicy(content: string): boolean {
  return content.split("\n").some((line) => line.trim() === "on_demand");
}

/** The same test in grep's words, for the scripts. */
export const ON_DEMAND_GREP = "^[[:space:]]*on_demand[[:space:]]*$";

/** A DNS label a site folder can be served under: what the wildcard block matches, and an authority certifies. */
export const ZONE_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The labels of the zone-names file, one per line, comments and blank lines
 * left out. A line that is not a label is ignored rather than trusted: the
 * file is written from folder names, and only a label is a name Caddy
 * routes.
 */
export function parseZoneNames(content: string): Set<string> {
  const labels = new Set<string>();
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (ZONE_LABEL.test(line)) labels.add(line);
  }
  return labels;
}

/**
 * How long a verification waits for a site's first certificate when the zone
 * is certified on demand: the first handshake is the one that obtains it,
 * through HTTP-01 or TLS-ALPN-01, and the authority may take longer than one
 * request waits. Only a site that does not answer at all is waited for, and
 * only on such a zone: with a DNS provider the wildcard is already there, and
 * a site that does not answer is a failure at once.
 */
export const FIRST_CERTIFICATE_MS = 90_000;

/** The one line the script ends on, on a zone with a DNS provider. */
export const NOT_ON_DEMAND = "zone-names: the zone is not certified on demand, nothing written";

/** The one line the script ends on, on a zone certified on demand. */
const WRITTEN = /^zone-names: ([0-9]+) site\(s\) under the zone$/;

export type ZoneNamesAnswer = { onDemand: true; sites: number } | { onDemand: false };

/** What the script said, from its last line; null for an answer it never gives. */
export function readZoneNamesAnswer(output: string): ZoneNamesAnswer | null {
  const last = output.trim().split("\n").at(-1)?.trim() ?? "";
  if (last === NOT_ON_DEMAND) return { onDemand: false };
  const written = WRITTEN.exec(last);
  return written === null ? null : { onDemand: true, sites: Number(written[1]) };
}

export type ZonePaths = { sites?: string; policy?: string; names?: string };

/**
 * ZONE_LABEL in the shell's words, tested on each folder's name before it is
 * printed: a `case` on the whole name, so that a name holding a newline is
 * skipped whole rather than split into two lines a filter would read as two
 * labels. The characters are spelled out rather than ranged, which a locale
 * could widen. `continue` skips the name.
 */
const LABEL_CASE =
  'case "$name" in ""|-*|*-|*[!abcdefghijklmnopqrstuvwxyz0123456789-]*) continue ;; esac; [ "${#name}" -le 63 ] || continue;';

/** A path the script writes in the clear, inside single quotes: nothing a shell would read. */
function plainPath(path: string): string {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(path)) throw new Error(`zone-names: unexpected path ${JSON.stringify(path)}`);
  return path;
}

/**
 * Writes the list from the folders of the sites, when the policy certifies on
 * demand, and ends on one line that says which; on a zone with a DNS
 * provider, writes nothing. Run as root, on one line, with no single quote:
 * it travels as `sudo sh -c '...'`, the argument of an ssh command, and the
 * installer runs it as it stands.
 *
 * A folder whose name is not one DNS label is no site of the zone: the
 * landing's, named after the zone, is served by its own block. A link is no
 * site either, whatever it points at: only a folder deploy made is. Each name
 * is tested before it is printed, never filtered after: the script runs as
 * root, and must not rely on the slugs having been checked elsewhere. The list is
 * written beside the file and renamed over it, so that the shared service
 * never reads half of it. No lock and no reload: Caddy does not read it.
 */
export function zoneNamesScript(paths: ZonePaths = {}): string {
  const sites = plainPath(paths.sites ?? SITES_PATH);
  const policy = plainPath(paths.policy ?? TLS_ZONE_PATH);
  const names = plainPath(paths.names ?? ZONE_NAMES_PATH);
  const staged = names.replace(/[^/]+$/, ".$&.new");
  return [
    "set -e",
    `grep -Eq "${ON_DEMAND_GREP}" ${policy} 2>/dev/null || { echo "${NOT_ON_DEMAND}"; exit 0; }`,
    `new=${staged}`,
    [
      "{ ",
      'echo "# The sites deployed under the zone, one label per line: the names the ask"; ',
      'echo "# endpoint allows on demand besides the zone and its www. Written from"; ',
      `echo "# ${SITES_PATH} by the deploy scripts and the installer, see api/src/zone-names.ts."; `,
      `for folder in ${sites}/*/; do path="\${folder%/}"; [ -d "$path" ] && [ ! -L "$path" ] || continue; name="\${path##*/}"; ${LABEL_CASE} printf "%s\\n" "$name"; done | LC_ALL=C sort; `,
      '} > "$new"',
    ].join(""),
    'chmod 644 "$new"',
    'chown root:root "$new"',
    `mv -f "$new" ${names}`,
    `echo "zone-names: $(grep -vc "^#" ${names}) site(s) under the zone"`,
  ].join("; ");
}

/** The command that writes the list, as the deploy account sends it over ssh. */
export const ZONE_NAMES_COMMAND = `sudo sh -c '${zoneNamesScript()}'`;
