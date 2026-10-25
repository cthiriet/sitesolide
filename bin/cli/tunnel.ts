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
 *              credentials, its account, infra/tunnel/sitesolide-tunnel.service,
 *              and a connection to the edge
 *   Caddy      ::1 trusted for the visitor's address, infra/tunnel/tunnel.caddy
 *
 * Caddy goes on as everywhere else: the zone's wildcard through the DNS-01
 * challenge, which needs no port open, and every site on its 443. cloudflared
 * hands it each request over the loopback, from ::1, with the name asked as
 * SNI, so that Caddy picks the site and its certificate exactly as for a
 * visitor. The loopback rule keeps ::1 to the connector: see TUNNEL_ORIGIN in
 * bin/cli/loopback.ts.
 *
 * THE TUNNEL IS ITS OWNER'S TO CREATE. `cloudflared tunnel login`, then
 * `cloudflared tunnel create <name>`, on the workstation: the second writes the
 * tunnel's credentials, ~/.cloudflared/<id>.json, which `--tunnel` names.
 * setup could create it through Cloudflare's API, with a token allowed to make
 * tunnels for the whole account; the zone's token, which goes on the machine
 * for Caddy, must reach the zones the machine serves and nothing else, and a
 * second token kept for a single creation is one more secret lying around. A
 * tunnel whose credentials are already on the machine, in
 * /etc/cloudflared/<id>.json where Cloudflare's own guide puts them, is taken
 * as it is: `--tunnel <id>`.
 *
 * THE CREDENTIALS. Read on the workstation, checked, never printed, they reach
 * the machine inside a script on ssh's standard input, as the DNS credentials
 * do, and land in /etc/cloudflared/tunnel.json, root:root 0600, which systemd
 * hands the connector. Whoever holds them runs the tunnel, and so serves the
 * zone's names in the machine's place; they reach no DNS, no other tunnel and
 * no account. The backups copy /etc/cloudflared with the rest of the machine's
 * own state.
 *
 * A SITE'S OWN DOMAIN, when its zone is at Cloudflare in the tunnel's own
 * account. Cloudflare routes into a tunnel the names whose records point at
 * it, in that account alone: another account's name gets Cloudflare's error
 * 1014. The domain's owner makes them, proxied CNAMEs to <id>.cfargotunnel.com,
 * and `sitesolide domain --activate` checks that Cloudflare's edge serves them
 * before it switches. The ingress below lets every name through to Caddy,
 * which decides by host what it serves; the visitor sees the edge's own
 * certificate for that zone, and behind it Caddy holds one from Let's Encrypt,
 * obtained through the DNS-01 challenge with the machine's own token, which
 * the owner allows on that zone too (infra/tunnel/tunnel.caddy). A zone at
 * another DNS provider, or in another Cloudflare account, cannot reach the
 * machine.
 *
 * Pure: returns text, touches nothing. setup sends it (bin/cli/setup.ts).
 */
import { APT, machineCheck, runScript, shellQuote } from "./harden";
import { CADDY_HTTPS_PORT, LOOPBACK_TABLE, TUNNEL_ORIGIN } from "./loopback";
import type { Condition } from "./steps";

export const TUNNEL_FOLDER = "/etc/cloudflared";
export const TUNNEL_CONFIG = `${TUNNEL_FOLDER}/config.yml`;
export const TUNNEL_CREDENTIALS = `${TUNNEL_FOLDER}/tunnel.json`;
export const TUNNEL_UNIT = "sitesolide-tunnel";
export const TUNNEL_UNIT_FILE = `/etc/systemd/system/${TUNNEL_UNIT}.service`;
/**
 * The connector's account, a static one that the loopback rule names by its
 * uid (bin/cli/loopback.ts). Made by the step before the unit that names it.
 */
export const TUNNEL_ACCOUNT = "sitesolide-tunnel";
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

/**
 * cloudflared kept current: its repository among those unattended-upgrades
 * takes, and the connector restarted once dpkg has replaced its binary.
 * Cloudflare supports a connector for about a year, and a box at home is left
 * alone longer than that; the security updates setup turns on take only
 * Debian's own origins by default.
 */
export const TUNNEL_UPGRADES = "/etc/apt/apt.conf.d/52sitesolide-cloudflared";
export const TUNNEL_AFTER_UPGRADE = "/usr/local/lib/sitesolide/tunnel-after-upgrade";

/** The apt configuration: Cloudflare's origin, and the hook after every dpkg run. */
export const TUNNEL_UPGRADES_CONTENT = [
  "// Laid by sitesolide setup --tunnel (bin/cli/tunnel.ts): cloudflared, from",
  "// Cloudflare's repository, upgraded with the security updates, and the",
  "// connector restarted once its binary changed.",
  'Unattended-Upgrade::Origins-Pattern { "origin=cloudflared,label=cloudflared"; };',
  `DPkg::Post-Invoke { "${TUNNEL_AFTER_UPGRADE} || true"; };`,
  "",
].join("\n");

/**
 * The hook: after any dpkg run, the connector restarted when cloudflared's
 * binary changed since it started. The change time, not the modification
 * time, which dpkg sets to the package's own build date: the change time is
 * the moment it was laid.
 */
export const TUNNEL_AFTER_UPGRADE_CONTENT = [
  "#!/bin/sh",
  "# Laid by sitesolide setup --tunnel (bin/cli/tunnel.ts), run by apt after dpkg:",
  "# the tunnel's connector restarted when cloudflared changed since it started.",
  `started=$(systemctl show -p ActiveEnterTimestamp --value ${TUNNEL_UNIT} 2>/dev/null)`,
  '[ -n "$started" ] || exit 0',
  '[ "$(stat -c %Z /usr/bin/cloudflared 2>/dev/null || echo 0)" -gt "$(date -d "$started" +%s)" ] || exit 0',
  `systemctl try-restart ${TUNNEL_UNIT}`,
  "",
].join("\n");

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
 * /etc/cloudflared/config.yml: every name to Caddy, in one rule. The
 * credentials are not named here: the unit hands them over on the command
 * line, from systemd's copy.
 *
 * One rule, and no name in it. In 0.10.0 the zone and its wildcard had a rule
 * each and any other name answered 404; but the names that reach the
 * connector are already chosen upstream, Cloudflare routing into the tunnel
 * only those whose records in its owner's account point at it, and Caddy
 * already decides by host what it serves, as on a machine served directly,
 * where any name a client sends as SNI reaches 443: a name the zone does not
 * cover and the domain table does not carry gets no certificate, the ask
 * endpoint refusing it, and the edge answers 502. A list of names here would
 * be a third list to keep in step, and the connector restarted at each
 * activation of a site's own domain.
 *
 * `matchSNItoHost` sends the name asked as SNI, which Caddy picks the site and
 * its certificate by. `noTLSVerify`, because the hop never leaves the machine:
 * cloudflared to ::1, where only Caddy listens on 443. Verifying would
 * add nothing a visitor sees, and would turn a renewal that failed into every
 * site down at the certificate's expiry, which the monitor already warns of
 * fourteen days ahead, reading the certificate on that same loopback.
 */
export function tunnelConfig(id: string): string {
  if (!TUNNEL_ID.test(id)) throw new Error(`not a tunnel's id: ${JSON.stringify(id)}`);
  return [
    "# Laid by sitesolide setup (bin/cli/tunnel.ts): every name Cloudflare routes",
    "# into the tunnel goes to Caddy on the loopback, which decides by host what",
    "# it serves. See docs/tunnel.md.",
    `tunnel: ${id}`,
    `metrics: ${TUNNEL_METRICS}`,
    "no-autoupdate: true",
    "ingress:",
    `  - service: https://[${TUNNEL_ORIGIN}]:${CADDY_HTTPS_PORT}`,
    "    originRequest:",
    "      matchSNItoHost: true",
    "      noTLSVerify: true",
    "",
  ].join("\n");
}

/**
 * Where Cloudflare's edge answers for any name it serves, proxied: the trace,
 * `key=value` lines, before the request goes anywhere near the origin. The
 * name as asked comes back as `h`, and the edge's location as `colo`.
 */
export const EDGE_TRACE_PATH = "/cdn-cgi/trace";

/**
 * Whether `text` is the edge's trace for `name`: what tells, from the
 * workstation, a name Cloudflare serves from one that resolves elsewhere or
 * nowhere. It answers before a site's own domain is activated too, which is
 * when `domain --activate` asks. It does not tell the account the name's zone
 * belongs to: a zone of another account answers its trace as well, and
 * Cloudflare's error 1014 to every other request.
 */
export function readEdgeTrace(text: string, name: string): boolean {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const equals = line.indexOf("=");
    if (equals > 0) fields.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim());
  }
  return fields.get("h")?.toLowerCase() === name.toLowerCase() && (fields.get("colo") ?? "") !== "";
}

/**
 * The two files that carry a site's own domain through the tunnel, each with
 * the text this release lays: the connector's configuration, whose one rule
 * lets every name through to Caddy, and Caddy's options, whose global issuer
 * certifies it. A machine from 0.10.0 holds others, which still serve the
 * zone: its connector answers 404 for any other name, and its Caddy has no
 * way to certify one. `domain --activate` compares them before it switches,
 * since a switch over them would succeed and serve the domain nothing.
 */
export function domainCarriers(id: string, caddy: string): Array<{ path: string; content: string }> {
  return [
    { path: TUNNEL_CONFIG, content: tunnelConfig(id) },
    { path: CADDY_TUNNEL_FILE, content: caddy },
  ];
}

/**
 * What a status from Cloudflare's edge says of the way a name reaches its
 * origin. `tunnel`, 502: what cloudflared answers for a request it could not
 * hand to its origin (WriteErrorResponse, in its connection/http2.go and
 * connection/quic_connection.go), Caddy refusing the handshake for a name it
 * holds no certificate for among them, and what Caddy itself answers for an
 * app that does not. `address`, 520 to 526: the edge's own answers when it
 * failed to reach an origin by its address, which a name routed into a tunnel
 * has none of; the name's record points at an address, proxied, rather than
 * at the tunnel. Null for any other answer.
 */
export function edgeOrigin(code: string): "tunnel" | "address" | null {
  if (code === "502") return "tunnel";
  return /^52[0-6]$/.test(code) ? "address" : null;
}

/** What the workstation measured of one name of a site's own domain, before it is activated behind a tunnel. */
export type EdgeReading = {
  name: string;
  /** It resolves to the machine's own address. */
  here: boolean;
  /** Cloudflare's edge answers its trace. */
  edge: boolean;
  /** The status at its root, or why nothing answered; null when it was not asked. */
  root: string | null;
};

/**
 * Why a name would not reach the machine through its tunnel, or null when it
 * would. A record left from before the tunnel, DNS only, resolves to the
 * machine, where the firewall now answers nothing; a name the edge does not
 * serve never reaches the tunnel. A record left proxied resolves to
 * Cloudflare, and its trace answers like any other: what gives it away is its
 * root, where the edge answers 520 to 526 for the address it cannot reach,
 * while a name routed into the tunnel gets the connector's 502 before its
 * activation, Caddy refusing its handshake. A proxied record pointing at a
 * host that answers is not caught: its root answers that host's status.
 */
export function tunnelRouteProblem(reading: EdgeReading, server: string): string | null {
  const { name, here, edge, root } = reading;
  if (here) return `${name} points at ${server}, a record from before the tunnel, which nothing answers there now`;
  if (!edge) return `https://${name}${EDGE_TRACE_PATH} answers no trace of Cloudflare's: the name is not proxied there, or its edge certificate is not issued yet`;
  if (root !== null && edgeOrigin(root) === "address") {
    return `https://${name}/ answers ${root}, Cloudflare's own answer for an origin it reaches by its address: its record points at an address, proxied, rather than at the tunnel`;
  }
  return null;
}

/**
 * A command for the machine, read only: whether Caddy completes a verified
 * handshake for `name` on the loopback, and what it answers, as the monitor
 * probes it there on 127.0.0.1, which the loopback rule leaves open to every
 * account. What tells a 502 through the tunnel that comes from the name's
 * certificate from one that comes from behind Caddy, an app that does not
 * answer. One line: `handshake <curl's exit> <status>`.
 */
export function caddyHandshakeCommand(name: string): string {
  const resolve = shellQuote(`${name}:${CADDY_HTTPS_PORT}:127.0.0.1`);
  const url = shellQuote(`https://${name}/`);
  return `code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve ${resolve} ${url} 2>/dev/null); echo "handshake $? $code"`;
}

/**
 * caddyHandshakeCommand's line: `answered` with Caddy's status once the
 * handshake verified, `refused` with curl's exit when it did not, the
 * certificate missing or not trusted, Caddy not listening; null for an
 * answer that is not that line, a read that failed.
 */
export function readCaddyHandshake(output: string): { kind: "answered"; status: number } | { kind: "refused"; exit: number } | null {
  const line = /^handshake (\d+) (\d{3})$/m.exec(output.trim());
  if (line === null) return null;
  const exit = Number(line[1]);
  const status = Number(line[2]);
  return exit === 0 && status !== 0 ? { kind: "answered", status } : { kind: "refused", exit };
}

/**
 * A command for the machine, read only: the last error Caddy's TLS logged in
 * the past hour about `name`, the issuance's own failures among them, from
 * its journal as `logs` reads a project's, through sudo. Caddy writes its
 * entries as JSON under systemd.
 */
export function caddyReasonCommand(name: string): string {
  return `sudo -n journalctl -u caddy --since -1h --no-pager -o cat | grep -F -- ${shellQuote(name)} | grep -F '"level":"error"' | grep -F '"logger":"tls' | tail -n 1`;
}

/**
 * What Caddy last said of a name's certificate, from one line of its
 * journal: the message and its error, an error's alone, never an entry that
 * says it went well. Null for a line that is not one of Caddy's errors.
 * Caddy's own words, cut short: they quote the DNS provider's answer, which
 * names the zone and never the token.
 */
export function readCaddyReason(line: string): string | null {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry === null || typeof entry !== "object") return null;
  const { level, msg, error } = entry as { level?: unknown; msg?: unknown; error?: unknown };
  if (level !== "error" || typeof msg !== "string" || msg === "") return null;
  const said = typeof error === "string" && error !== "" ? `${msg}: ${error}` : msg;
  return said.length > 300 ? `${said.slice(0, 297)}...` : said;
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

/**
 * The account's uid, the static account alone: while a unit with
 * DynamicUser= runs, its dynamic account bears this same name, and the bypass
 * keeps id and useradd from taking one for the other (bin/deploy-monitor.sh).
 */
export const TUNNEL_ACCOUNT_UID = `SYSTEMD_NSS_DYNAMIC_BYPASS=1 id -u ${TUNNEL_ACCOUNT}`;

/** ::1 on the loopback, in the kernel's own list of its IPv6 addresses. */
const LOOPBACK_IPV6 = "grep -Eq '^0{31}1 .* lo$' /proc/net/if_inet6";

/** The connector runs as its account: the uid the loopback rule lets through. */
const RUNS_AS_ACCOUNT = `pid=$(systemctl show -p MainPID --value ${TUNNEL_UNIT}) && [ "$pid" != 0 ] && [ "$(stat -c %u /proc/$pid)" = "$(${TUNNEL_ACCOUNT_UID})" ]`;

export type TunnelFiles = { id: string; unit: string; caddy: string };

/** Everything the tunnel step leaves on the machine, condition by condition. */
export function tunnelConditions(files: TunnelFiles): Condition[] {
  return [
    { label: "loopback-ipv6", test: LOOPBACK_IPV6 },
    { label: "cloudflared-package", test: "dpkg-query -W -f='${Status}' cloudflared | grep -q 'ok installed'" },
    { label: "tunnel-credentials", test: namesTunnel(TUNNEL_CREDENTIALS, files.id) },
    { label: "tunnel-credentials-permissions", test: `[ "$(stat -c '%U:%G %a' ${TUNNEL_CREDENTIALS})" = 'root:root 600' ]` },
    ...sameFile("tunnel-config", TUNNEL_CONFIG, tunnelConfig(files.id), "644"),
    { label: "tunnel-account", test: `${TUNNEL_ACCOUNT_UID} >/dev/null 2>&1` },
    ...sameFile("tunnel-unit", TUNNEL_UNIT_FILE, files.unit, "644"),
    ...sameFile("tunnel-caddy", CADDY_TUNNEL_FILE, files.caddy, "644"),
    ...sameFile("tunnel-upgrades", TUNNEL_UPGRADES, TUNNEL_UPGRADES_CONTENT, "644"),
    ...sameFile("tunnel-after-upgrade", TUNNEL_AFTER_UPGRADE, TUNNEL_AFTER_UPGRADE_CONTENT, "755"),
    { label: "tunnel-enabled", test: `systemctl is-enabled --quiet ${TUNNEL_UNIT}` },
    { label: "tunnel-active", test: `systemctl is-active --quiet ${TUNNEL_UNIT}` },
    { label: "tunnel-as-account", test: RUNS_AS_ACCOUNT },
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
  account: `tunnel: account ${TUNNEL_ACCOUNT} created`,
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
    # The file taken is a copy of the secret too: root's alone as well.
    chown root:root ${own}
    chmod 600 ${own}
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
if ! ${LOOPBACK_IPV6} 2>/dev/null; then
  echo "tunnel: the loopback has no ::1, where the connector reaches Caddy: IPv6 is off on lo (net.ipv6.conf.lo.disable_ipv6, or ipv6.disable on the kernel's command line)" >&2
  exit 1
fi
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
${layFile(TUNNEL_CONFIG, "644", tunnelConfig(id), "CONFIG", "config")}
# The account before the unit that names it: its own group, no home, no shell.
if ! ${TUNNEL_ACCOUNT_UID} >/dev/null 2>&1; then
  SYSTEMD_NSS_DYNAMIC_BYPASS=1 useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ${TUNNEL_ACCOUNT}
  changed="$changed account"
  echo "${TUNNEL_SAID.account}"
fi
${layFile(TUNNEL_UNIT_FILE, "644", files.unit, "UNIT", "unit")}
case "$changed" in *unit*) systemctl daemon-reload ;; esac
systemctl enable ${TUNNEL_UNIT} >/dev/null 2>&1
if [ -n "$changed" ] || ! systemctl is-active --quiet ${TUNNEL_UNIT} || ! { ${RUNS_AS_ACCOUNT}; }; then
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
# Its upgrades, laid once the connector runs: they restart nothing now.
install -d -m 0755 -o root -g root ${TUNNEL_AFTER_UPGRADE.slice(0, TUNNEL_AFTER_UPGRADE.lastIndexOf("/"))}
${layFile(TUNNEL_AFTER_UPGRADE, "755", TUNNEL_AFTER_UPGRADE_CONTENT, "HOOK", "hook")}
${layFile(TUNNEL_UPGRADES, "644", TUNNEL_UPGRADES_CONTENT, "UPGRADES", "upgrades")}
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

/**
 * A test for sh: the loaded table lets the connector's account, as it is now,
 * reach Caddy from ::1. setup's check of the loopback rule on a machine
 * served through a tunnel, so that a run of setup lays the rule again over a
 * table laid before the tunnel, or before its account.
 */
export function tunnelRuleLoaded(): string {
  return `uid=$(${TUNNEL_ACCOUNT_UID}) && nft list chain inet ${LOOPBACK_TABLE} output | grep -Fq "ip6 saddr ${TUNNEL_ORIGIN} tcp dport ${CADDY_HTTPS_PORT} meta skuid $uid accept"`;
}
