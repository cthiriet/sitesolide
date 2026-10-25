/**
 * A machine served through a Cloudflare Tunnel, for one the Internet cannot
 * reach: a box at home behind its router's NAT, a VM on a machine that already
 * serves something else. `sitesolide setup --tunnel <tunnel>`, see
 * docs/tunnel.md.
 *
 *   records    the zone and its wildcard, proxied CNAMEs to <id>.cfargotunnel.com,
 *              made with the zone's Cloudflare token, the one Caddy holds
 *   firewall   ssh alone: nothing reaches 80 nor 443 but through the tunnel
 *   tunnel     cloudflared from Cloudflare's repository, its configuration, its
 *              credentials, infra/tunnel/sitesolide-tunnel.service, and a
 *              connection to the edge
 *   Caddy      the loopback trusted for the visitor's address,
 *              infra/tunnel/tunnel.caddy
 *
 * Caddy goes on as everywhere else: the zone's wildcard through the DNS-01
 * challenge, which needs no port open, and every site on its 443. cloudflared
 * hands it each request over the loopback, with the name asked as SNI, so
 * that Caddy picks the site and its certificate exactly as for a visitor.
 *
 * THE TUNNEL IS ITS OWNER'S TO CREATE. `cloudflared tunnel login`, then
 * `cloudflared tunnel create <name>`, on the workstation: the second writes the
 * tunnel's credentials, ~/.cloudflared/<id>.json, which `--tunnel` names.
 * setup could create it through Cloudflare's API, with a token allowed to make
 * tunnels for the whole account; the zone's token, which goes on the machine
 * for Caddy, must stay the zone's alone, and a second token kept for a single
 * creation is one more secret lying around. A tunnel whose credentials are
 * already on the machine, in /etc/cloudflared/<id>.json where Cloudflare's own
 * guide puts them, is taken as it is: `--tunnel <id>`.
 *
 * THE CREDENTIALS. Read on the workstation, checked, never printed, they reach
 * the machine inside a script on ssh's standard input, as the DNS credentials
 * do, and land in /etc/cloudflared/tunnel.json, root:root 0600, which systemd
 * hands the connector. Whoever holds them runs the tunnel, and so serves the
 * zone's names in the machine's place; they reach no DNS, no other tunnel and
 * no account. The backups copy /etc/cloudflared with the rest of the machine's
 * own state.
 *
 * WHAT A TUNNEL DOES NOT CARRY: a customer's own domain. Cloudflare routes into
 * a tunnel the names of the account's own zones alone, and an on-demand
 * certificate needs Let's Encrypt to reach the machine: the ingress below
 * answers 404 to any name outside the zone.
 *
 * Pure: returns text, touches nothing. setup sends it (bin/cli/setup.ts).
 */
import { APT, machineCheck, runScript } from "./harden";
import type { Condition } from "./steps";

export const TUNNEL_FOLDER = "/etc/cloudflared";
export const TUNNEL_CONFIG = `${TUNNEL_FOLDER}/config.yml`;
export const TUNNEL_CREDENTIALS = `${TUNNEL_FOLDER}/tunnel.json`;
export const TUNNEL_UNIT = "sitesolide-tunnel";
export const TUNNEL_UNIT_FILE = `/etc/systemd/system/${TUNNEL_UNIT}.service`;
/** Caddy's global options for the tunnel, which the Caddyfile imports by glob. */
export const CADDY_TUNNEL_FILE = "/etc/caddy/global.d/tunnel.caddy";
/**
 * Where cloudflared answers `/ready`, 200 once a connection to the edge is up:
 * the step's last check, and the monitor's. Outside 20241 to 20245, the ports
 * cloudflared takes by default: a second connector, the package's own, sits
 * there, and its answer would pass for this one's.
 */
export const TUNNEL_METRICS = "127.0.0.1:20240";
/** The unit `cloudflared service install` lays, a second connector beside this one's when it runs. */
export const PACKAGE_UNIT = "cloudflared.service";

/** The kit's files the step lays as they are. */
export const TUNNEL_KIT_FILES = { unit: "infra/tunnel/sitesolide-tunnel.service", caddy: "infra/tunnel/tunnel.caddy" } as const;

const TUNNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT_TAG = /^[0-9a-f]{32}$/;
/** 32 random bytes and more, in standard base64: what `cloudflared tunnel create` draws. */
const TUNNEL_SECRET = /^[A-Za-z0-9+/]{43,}={0,2}$/;

/** Whether `--tunnel` names a tunnel by its id rather than by its credentials file. */
export function isTunnelId(value: string): boolean {
  return TUNNEL_ID.test(value);
}

/** A tunnel's credentials, read and checked: its id, and the file's text as the machine gets it. */
export type TunnelCredentials = { id: string; text: string };

/**
 * The credentials file `cloudflared tunnel create` writes, checked field by
 * field. What it says when it refuses names a field, never a value: the file
 * holds the tunnel's secret.
 */
export function readTunnelCredentials(text: string): TunnelCredentials | { problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problem: "it is not JSON: give the file cloudflared tunnel create wrote, ~/.cloudflared/<id>.json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { problem: "it is not a JSON object" };
  const fields = parsed as Record<string, unknown>;
  const { AccountTag: account, TunnelSecret: secret, TunnelID: id } = fields;
  if (typeof id !== "string" || !TUNNEL_ID.test(id)) return { problem: "its TunnelID is missing, or not a tunnel's id" };
  if (typeof account !== "string" || !ACCOUNT_TAG.test(account)) return { problem: "its AccountTag is missing, or not an account's id" };
  if (typeof secret !== "string" || !TUNNEL_SECRET.test(secret)) return { problem: "its TunnelSecret is missing, or not one cloudflared draws" };
  // The three fields alone, in cloudflared's order: an Endpoint or anything
  // else the file carries stays on the workstation.
  return { id, text: `${JSON.stringify({ AccountTag: account, TunnelSecret: secret, TunnelID: id })}\n` };
}

/** The name the zone's records point at, which Cloudflare's edge routes into the tunnel. */
export function tunnelTarget(id: string): string {
  return `${id}.cfargotunnel.com`;
}

/**
 * /etc/cloudflared/config.yml: the zone and its wildcard to Caddy, any other
 * name 404. The credentials are not named here: the unit hands them over on
 * the command line, from systemd's copy.
 *
 * `matchSNItoHost` sends the name asked as SNI, which Caddy picks the site and
 * its certificate by. `noTLSVerify`, because the hop never leaves the machine:
 * cloudflared to 127.0.0.1, where only Caddy listens on 443. Verifying would
 * add nothing a visitor sees, and would turn a renewal that failed into every
 * site down at the certificate's expiry, which the monitor already warns of
 * fourteen days ahead, reading the certificate on that same loopback.
 */
export function tunnelConfig(zone: string, id: string): string {
  if (!TUNNEL_ID.test(id)) throw new Error(`not a tunnel's id: ${JSON.stringify(id)}`);
  const origin = ["    service: https://127.0.0.1:443", "    originRequest:", "      matchSNItoHost: true", "      noTLSVerify: true"];
  return [
    "# Laid by sitesolide setup (bin/cli/tunnel.ts): every name of the zone goes to",
    "# Caddy on the loopback, any other answers 404. See docs/tunnel.md.",
    `tunnel: ${id}`,
    `metrics: ${TUNNEL_METRICS}`,
    "no-autoupdate: true",
    "ingress:",
    `  - hostname: ${zone}`,
    ...origin,
    `  - hostname: "*.${zone}"`,
    ...origin,
    "  - service: http_status:404",
    "",
  ].join("\n");
}

function fingerprint(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

function sameFile(label: string, path: string, content: string, mode: string): Condition[] {
  return [
    { label, test: `[ "$(sha256sum < ${path} | cut -d' ' -f1)" = '${fingerprint(content)}' ]` },
    { label: `${label}-permissions`, test: `[ "$(stat -c '%U:%G %a' ${path})" = 'root:root ${mode}' ]` },
  ];
}

/** What the credentials file says of a tunnel's id, in grep's words: cloudflared's file is not always compact. */
function namesTunnel(path: string, id: string): string {
  return `grep -Eq '"TunnelID"[[:space:]]*:[[:space:]]*"${id}"' ${path}`;
}

export type TunnelFiles = { zone: string; id: string; unit: string; caddy: string };

/** Everything the tunnel step leaves on the machine, condition by condition. */
export function tunnelConditions(files: TunnelFiles): Condition[] {
  return [
    { label: "cloudflared-package", test: "dpkg-query -W -f='${Status}' cloudflared | grep -q 'ok installed'" },
    { label: "tunnel-credentials", test: namesTunnel(TUNNEL_CREDENTIALS, files.id) },
    { label: "tunnel-credentials-permissions", test: `[ "$(stat -c '%U:%G %a' ${TUNNEL_CREDENTIALS})" = 'root:root 600' ]` },
    ...sameFile("tunnel-config", TUNNEL_CONFIG, tunnelConfig(files.zone, files.id), "644"),
    ...sameFile("tunnel-unit", TUNNEL_UNIT_FILE, files.unit, "644"),
    ...sameFile("tunnel-caddy", CADDY_TUNNEL_FILE, files.caddy, "644"),
    { label: "tunnel-enabled", test: `systemctl is-enabled --quiet ${TUNNEL_UNIT}` },
    { label: "tunnel-active", test: `systemctl is-active --quiet ${TUNNEL_UNIT}` },
    { label: "tunnel-ready", test: `curl -fsS --max-time 5 http://${TUNNEL_METRICS}/ready` },
    // A connector of the package's own, laid by `cloudflared service install`,
    // reading the configuration this step rewrites.
    { label: "no-second-connector", test: `! systemctl is-active --quiet ${PACKAGE_UNIT}` },
  ];
}

export function tunnelCheck(files: TunnelFiles): string {
  return machineCheck("setup:tunnel:check", tunnelConditions(files));
}

/** The lines tunnelRun prints for the step's report, each when it did what it says. */
export const TUNNEL_SAID = {
  installed: "tunnel: cloudflared installed",
  credentials: "tunnel: credentials laid",
  adopted: "tunnel: credentials taken from",
  started: "tunnel: connector started",
  caddy: "tunnel: Caddy reloaded with it",
  second: "tunnel: the package's own connector stopped",
} as const;

/** What tunnelRun exits with when the machine holds no credentials for the tunnel, and none were given. */
export const NO_CREDENTIALS_EXIT = 3;

/**
 * A file laid only when its text differs, through a temporary file of the
 * same folder, so that it is replaced whole or not at all; `$changed` names
 * what was.
 */
function layFile(path: string, mode: string, content: string, delimiter: string, label: string): string {
  if (content.includes(`\n${delimiter}\n`) || !content.endsWith("\n")) throw new Error(`${path}: the text cannot be laid through its heredoc`);
  const folder = path.slice(0, path.lastIndexOf("/"));
  return `
next=$(mktemp ${folder}/.sitesolide.XXXXXX)
cat > "$next" <<'${delimiter}'
${content}${delimiter}
chmod ${mode} "$next"
chown root:root "$next"
if cmp -s "$next" ${path}; then rm -f "$next"; else mv -f "$next" ${path}; changed="$changed ${label}"; fi`;
}

/**
 * The step's run: everything tunnelConditions checks, each part laid only
 * when it differs. `credentials`: the text read on the workstation, or null to
 * take the tunnel's file the machine already holds, /etc/cloudflared/<id>.json.
 *
 * The order keeps the sites up: the connector is restarted, and waited for
 * until the edge answers, before the package's own is stopped; Caddy is
 * reloaded only when its file changed under a Caddyfile that imports it, and
 * the previous file is put back if Caddy refuses it.
 */
export function tunnelRun(files: TunnelFiles, credentials: string | null): string {
  const { id } = files;
  if (!TUNNEL_ID.test(id)) throw new Error(`not a tunnel's id: ${JSON.stringify(id)}`);
  const own = `${TUNNEL_FOLDER}/${id}.json`;
  const credentialsPart =
    credentials === null
      ? `
if ! { [ -f ${TUNNEL_CREDENTIALS} ] && ${namesTunnel(TUNNEL_CREDENTIALS, id)}; }; then
  if [ -f ${own} ] && ${namesTunnel(own, id)}; then
    install -m 600 -o root -g root ${own} ${TUNNEL_CREDENTIALS}
    changed="$changed credentials"
    echo "${TUNNEL_SAID.adopted} ${own}"
  else
    echo "tunnel: no credentials for tunnel ${id} on the machine" >&2
    exit ${NO_CREDENTIALS_EXIT}
  fi
fi
chown root:root ${TUNNEL_CREDENTIALS}
chmod 600 ${TUNNEL_CREDENTIALS}`
      : `${layFile(TUNNEL_CREDENTIALS, "600", credentials, "CREDENTIALS", "credentials")}
case "$changed" in *credentials*) echo "${TUNNEL_SAID.credentials}" ;; esac`;
  return runScript(
    "setup:tunnel:run",
    `
if ! dpkg-query -W -f='\${Status}' cloudflared 2>/dev/null | grep -q 'ok installed'; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
  ${APT} update -q </dev/null
  ${APT} install -y -q cloudflared </dev/null
  echo "${TUNNEL_SAID.installed}"
fi
install -d -m 0755 -o root -g root ${TUNNEL_FOLDER}
changed=""
${credentialsPart}
${layFile(TUNNEL_CONFIG, "644", tunnelConfig(files.zone, id), "CONFIG", "config")}
${layFile(TUNNEL_UNIT_FILE, "644", files.unit, "UNIT", "unit")}
case "$changed" in *unit*) systemctl daemon-reload ;; esac
systemctl enable ${TUNNEL_UNIT} >/dev/null 2>&1
if [ -n "$changed" ] || ! systemctl is-active --quiet ${TUNNEL_UNIT}; then
  if ! systemctl restart ${TUNNEL_UNIT}; then
    echo "tunnel: the connector did not start" >&2
    journalctl -u ${TUNNEL_UNIT} -n 15 --no-pager >&2 || true
    exit 1
  fi
  echo "${TUNNEL_SAID.started}"
fi
tries=0
until curl -fsS --max-time 3 http://${TUNNEL_METRICS}/ready >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 30 ]; then
    echo "tunnel: not connected to Cloudflare's edge after a minute" >&2
    journalctl -u ${TUNNEL_UNIT} -n 15 --no-pager >&2 || true
    exit 1
  fi
  sleep 2
done
if systemctl is-active --quiet ${PACKAGE_UNIT} || systemctl is-enabled --quiet ${PACKAGE_UNIT} 2>/dev/null; then
  systemctl disable --now ${PACKAGE_UNIT} >/dev/null 2>&1
  echo "${TUNNEL_SAID.second}"
fi
install -d -m 0755 -o root -g root ${CADDY_TUNNEL_FILE.slice(0, CADDY_TUNNEL_FILE.lastIndexOf("/"))}
previous=""
if [ -f ${CADDY_TUNNEL_FILE} ]; then previous=$(mktemp /etc/caddy/.sitesolide.XXXXXX); cp -p ${CADDY_TUNNEL_FILE} "$previous"; fi
changed=""
${layFile(CADDY_TUNNEL_FILE, "644", files.caddy, "CADDY", "caddy")}
if [ -n "$changed" ] && grep -Eq '^[[:space:]]*import /etc/caddy/global\\.d/' /etc/caddy/Caddyfile 2>/dev/null && systemctl is-active --quiet caddy; then
  if ! systemctl reload caddy; then
    if [ -n "$previous" ]; then mv -f "$previous" ${CADDY_TUNNEL_FILE}; else rm -f ${CADDY_TUNNEL_FILE}; fi
    echo "tunnel: Caddy refused ${CADDY_TUNNEL_FILE}: the previous one is back" >&2
    exit 1
  fi
  echo "${TUNNEL_SAID.caddy}"
fi
[ -z "$previous" ] || rm -f "$previous"
`,
  );
}
