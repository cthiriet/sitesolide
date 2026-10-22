#!/usr/bin/env bun
/**
 * The served zone's TLS policy: /etc/caddy/tls-zone.caddy, which the
 * Caddyfile's `(tls-zone)` snippet imports by name, so that the zone's own
 * blocks and every app's preview block take it. Its content is a whole
 * `tls { }` block, and it depends on who holds the zone's DNS:
 *
 *   a DNS provider   `dns <module> {env.<CREDENTIAL>}`: one certificate for
 *                    the zone and one for its wildcard, through a DNS-01
 *                    challenge, with credentials read from Caddy's
 *                    environment. Cloudflare's is what the Caddyfile carried
 *                    inline up to 0.6.
 *   manual DNS       `on_demand`: no DNS API. One certificate per name, at its
 *                    first handshake, through HTTP-01 or TLS-ALPN-01, once the
 *                    ask endpoint agrees; the shared service allows the zone,
 *                    its www and the sites deployed under it, and nothing else
 *                    (api/src/zone.ts). It reads this very file to know which
 *                    policy the zone has, so Caddy and the endpoint cannot
 *                    disagree, and no variable has to reach a running Caddy.
 *
 * With manual DNS the endpoint needs the sites deployed, which it cannot read
 * itself (its unit hides /srv/sites): /etc/caddy/zone-names lists them, one
 * label per line, written by ZONE_NAMES_COMMAND. That command writes nothing
 * on a zone with a DNS provider, so it may run anywhere.
 *
 * `sitesolide setup` lays the file with tlsZoneCheck and tlsZoneRun, before
 * bin/deploy-caddy.sh first runs: that script lays Cloudflare's policy where
 * the file is missing and the machine holds a Cloudflare token, which is what
 * a machine upgraded from 0.6 is, and refuses otherwise. It reads what it
 * needs from here, run as a script: the lines below are evaluated by it, the
 * way bin/config.sh evaluates bin/cli/settings.ts, so that the policy it lays
 * is this module's to the byte.
 */
import {
  FIRST_CERTIFICATE_MS,
  NOT_ON_DEMAND,
  ON_DEMAND_GREP,
  onDemandPolicy,
  readZoneNamesAnswer,
  TLS_ZONE_PATH,
  ZONE_NAMES_COMMAND,
  ZONE_NAMES_PATH,
} from "../../api/src/zone-names";
import { MARKERS, releaseHeldScript, takeScript } from "./caddy-lock";
import { machineCheck, runScript, shellQuote } from "./harden";

/**
 * The rules of the zone's sites live with the shared service that decides
 * with them, api/src/zone-names.ts, which the dashboard borrows and the
 * monitor bundles: one writing of them, read from here too.
 */
export { FIRST_CERTIFICATE_MS, NOT_ON_DEMAND, ON_DEMAND_GREP, readZoneNamesAnswer, ZONE_NAMES_COMMAND };

export const TLS_ZONE_FILE = TLS_ZONE_PATH;

/** The labels of the sites deployed under the zone, for the ask endpoint. */
export const ZONE_NAMES_FILE = ZONE_NAMES_PATH;

/** Where the DNS credentials live on the machine, whatever the provider: see bin/cli/dns/dns.ts. */
export const DNS_CREDENTIALS_FILE = "/etc/caddy/cloudflare.env";

export type TlsZoneMode = { kind: "dns"; title: string; directive: readonly string[] } | { kind: "on-demand" };

/** The policy the Caddyfile held inline up to 0.6, which bin/deploy-caddy.sh lays on a machine from before. */
export const CLOUDFLARE_POLICY = {
  kind: "dns",
  title: "Cloudflare",
  directive: ["dns cloudflare {env.CLOUDFLARE_API_TOKEN}"],
} as const satisfies TlsZoneMode;

/** A policy that turns on-demand issuance on: a line `on_demand` of its own, as Caddy reads it. */
export const isOnDemand = onDemandPolicy;

// --- the file's content ------------------------------------------------------------------------------

const HEADER = [
  "# The served zone's TLS policy, imported by name by the (tls-zone) snippet of",
  "# /etc/caddy/Caddyfile: the zone's own blocks and every app's preview block",
  "# take it. Laid by sitesolide setup from the DNS chosen there (bin/cli/tls.ts);",
  "# bin/deploy-caddy.sh lays Cloudflare's on a machine from before this file,",
  "# whose Caddyfile carried that policy itself. Not to be edited by hand: the",
  "# shared service reads it too, to know whether the zone's names are",
  "# certified on demand.",
  "#",
];

/** A credential, read by Caddy from its environment when it runs: the only way a directive names one. */
const PLACEHOLDER = /\{env\.[A-Z_][A-Z0-9_]*\}/g;

/**
 * A token that looks like a credential written in: long, made of the
 * characters keys and tokens are made of, with a digit, or very long. Option
 * names, `resource_group_name`, and short values, `us-east-1`, are not.
 */
function looksLikeSecret(token: string): boolean {
  if (!/^[A-Za-z0-9_+/=~.-]+$/.test(token)) return false;
  return token.length >= 32 || (token.length >= 20 && /[0-9]/.test(token));
}

/**
 * The directive's lines, checked and indented one tab per block level inside
 * `tls { }`. Refused: anything that could end the block early or open another
 * one, a newline, a quote, a backslash, a comment, an `import`; `{$NAME}`,
 * which Caddy substitutes into the configuration it keeps and hands out on its
 * admin API; and anything that looks like a credential written in. A
 * credential is only ever named, `{env.NAME}`, read when Caddy runs.
 */
function directiveLines(directive: readonly string[]): string[] {
  if (directive.length === 0) throw new Error("tls-zone: an empty directive");
  const lines: string[] = [];
  let depth = 0;
  directive.forEach((raw, index) => {
    const where = `tls-zone: directive line ${index + 1}`;
    if (/[\n\r]/.test(raw)) throw new Error(`${where} holds a newline`);
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(raw)) throw new Error(`${where} holds a control character`);
    if (/["`]/.test(raw)) throw new Error(`${where} holds a quote, which would change where the block ends`);
    if (raw.includes("\\")) throw new Error(`${where} holds a backslash`);
    if (raw.includes("#")) throw new Error(`${where} holds a #, which would comment out the rest of it`);
    if (raw.includes("{$")) throw new Error(`${where} names {$...}, which Caddy writes into its configuration: a credential is named {env.NAME}`);
    const line = raw.trim();
    if (line === "") throw new Error(`${where} is empty`);

    const bare = line.replace(PLACEHOLDER, "").trim();
    const tokens = bare.split(/\s+/).filter((token) => token !== "");
    if (tokens[0] === "import") throw new Error(`${where} imports a file`);
    if (tokens.includes("on_demand")) throw new Error(`${where} names on_demand, which is manual DNS's policy, not a provider's`);
    for (const token of tokens) {
      if (looksLikeSecret(token)) throw new Error(`${where} looks like a credential written in: name it {env.NAME}, read from Caddy's environment`);
    }
    if (/[{}]/.test(line.replace(PLACEHOLDER, ""))) {
      const closes = bare === "}";
      const opens = /\s\{$/.test(bare) && !/[{}]/.test(bare.slice(0, -1));
      if (!closes && !opens) throw new Error(`${where} holds a brace that neither opens nor closes a block`);
      if (closes) {
        if (depth === 0) throw new Error(`${where} closes the tls block itself`);
        depth -= 1;
        lines.push(`${"\t".repeat(depth + 1)}}`);
        return;
      }
      lines.push(`${"\t".repeat(depth + 1)}${line}`);
      depth += 1;
      return;
    }
    lines.push(`${"\t".repeat(depth + 1)}${line}`);
  });
  if (depth !== 0) throw new Error("tls-zone: the directive leaves a block open");
  if (!/^\tdns [a-z0-9_]+( |$)/.test(lines[0]!)) throw new Error("tls-zone: a provider's directive starts with dns <module>");
  return lines;
}

/**
 * The whole file: a header that says what it is and who lays it, what the
 * policy does, and the `tls` block. Throws on a directive tlsZoneContent
 * would not write, see directiveLines.
 */
export function tlsZoneContent(mode: TlsZoneMode): string {
  if (mode.kind === "on-demand") {
    return [
      ...HEADER,
      "# Manual DNS, no DNS API: one certificate per name, obtained at its first TLS",
      "# handshake through HTTP-01 or TLS-ALPN-01, once the ask endpoint agrees. It",
      "# agrees to the zone, its www and the sites deployed under it, listed in",
      `# ${ZONE_NAMES_FILE}, and to nothing else: see api/src/zone.ts.`,
      "tls {",
      "\ton_demand",
      "}",
      "",
    ].join("\n");
  }
  const title = mode.title.trim();
  if (title === "" || title.length > 60 || /[\u0000-\u001f\u007f]/.test(mode.title)) {
    throw new Error(`tls-zone: ${JSON.stringify(mode.title)} is not a provider's title`);
  }
  return [
    ...HEADER,
    `# ${title}: one certificate for the zone and one for its wildcard, through a`,
    "# DNS-01 challenge. The credentials are read from Caddy's environment, which",
    `# systemd loads from ${DNS_CREDENTIALS_FILE}: never written here, this file`,
    "# is readable by all.",
    "tls {",
    ...directiveLines(mode.directive),
    "}",
    "",
  ].join("\n");
}

// --- what bin/deploy-caddy.sh reads before it deposits ------------------------------------------------

/** What TLS_ZONE_STATE_COMMAND answers, one line. */
export const TLS_ZONE_STATES = {
  /** The file is there, and certifies on demand: the zone's sites are listed with each deposit. */
  onDemand: "tls-zone: on-demand",
  /** The file is there, a provider's. */
  dns: "tls-zone: dns",
  /**
   * The file is there and holds no policy this release recognises: empty, cut
   * short by a full disk, or edited. Caddy would validate it all the same and
   * put the zone under its default issuers, where the wildcard cannot renew:
   * nothing is written on such a machine until setup lays it again.
   */
  unrecognised: "tls-zone: unrecognised",
  /** No file, and a Cloudflare token: a machine from before the file, whose policy was Cloudflare's. */
  cloudflare: "tls-zone: cloudflare",
  /** No file, and nothing that says which policy the zone had: setup lays it. */
  none: "tls-zone: none",
} as const;

/**
 * A policy this release recognises, in grep's words: a `tls {` line, a line
 * that closes it, and either an `on_demand` line or a `dns <module>` one. What
 * tlsZoneContent writes always is; an empty file, one cut short, or one with
 * only its comments, never.
 */
const TLS_OPEN_GREP = "^[[:space:]]*tls[[:space:]]*\\{[[:space:]]*$";
const BLOCK_CLOSE_GREP = "^[[:space:]]*\\}[[:space:]]*$";
const DNS_LINE_GREP = "^[[:space:]]*dns[[:space:]]+[a-z0-9_]+([[:space:]]|$)";

/** The same recognition, for the tests and for whoever reads a file here. */
export function recognisedPolicy(content: string): "on-demand" | "dns" | null {
  const lines = content.split("\n").map((line) => line.trim());
  if (!lines.some((line) => /^tls\s*\{$/.test(line)) || !lines.includes("}")) return null;
  if (lines.includes("on_demand")) return "on-demand";
  return lines.some((line) => /^dns\s+[a-z0-9_]+(\s|$)/.test(line)) ? "dns" : null;
}

/**
 * A token line systemd reads: leading blanks allowed, a value that is not
 * empty, bare, double- or single-quoted. The quote is matched as any one
 * character that cannot start a token, since the pattern itself travels
 * between single quotes.
 */
const CLOUDFLARE_TOKEN_GREP = `^[[:space:]]*CLOUDFLARE_API_TOKEN=[^[:alnum:]_-]?[A-Za-z0-9_-]`;

/**
 * Reads, and only reads, which of TLS_ZONE_STATES the machine is in. The
 * token file is only searched for its variable, never printed.
 */
export const TLS_ZONE_STATE_COMMAND = [
  `if sudo test -f ${TLS_ZONE_FILE}; then`,
  `if ! sudo grep -Eq '${TLS_OPEN_GREP}' ${TLS_ZONE_FILE} || ! sudo grep -Eq '${BLOCK_CLOSE_GREP}' ${TLS_ZONE_FILE}; then echo '${TLS_ZONE_STATES.unrecognised}';`,
  `elif sudo grep -Eq '${ON_DEMAND_GREP}' ${TLS_ZONE_FILE}; then echo '${TLS_ZONE_STATES.onDemand}';`,
  `elif sudo grep -Eq '${DNS_LINE_GREP}' ${TLS_ZONE_FILE}; then echo '${TLS_ZONE_STATES.dns}';`,
  `else echo '${TLS_ZONE_STATES.unrecognised}'; fi;`,
  `elif sudo grep -Eq '${CLOUDFLARE_TOKEN_GREP}' ${DNS_CREDENTIALS_FILE} 2>/dev/null; then echo '${TLS_ZONE_STATES.cloudflare}';`,
  `else echo '${TLS_ZONE_STATES.none}'; fi`,
].join(" ");

/** The assignments bin/deploy-caddy.sh and bin/generate-domains.sh evaluate. */
export function shellAssignments(): string {
  const values: Record<string, string> = {
    TLS_ZONE_FILE,
    TLS_ZONE_CLOUDFLARE: tlsZoneContent(CLOUDFLARE_POLICY),
    TLS_ZONE_STATE_COMMAND,
    TLS_ZONE_ON_DEMAND: TLS_ZONE_STATES.onDemand,
    TLS_ZONE_DNS: TLS_ZONE_STATES.dns,
    TLS_ZONE_UNRECOGNISED: TLS_ZONE_STATES.unrecognised,
    TLS_ZONE_LAY_CLOUDFLARE: TLS_ZONE_STATES.cloudflare,
    TLS_ZONE_NONE: TLS_ZONE_STATES.none,
    ZONE_NAMES_COMMAND,
    FIRST_CERTIFICATE_S: String(FIRST_CERTIFICATE_MS / 1000),
  };
  return Object.entries(values)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join("\n");
}

// --- setup's step ------------------------------------------------------------------------------------

function fingerprint(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

/**
 * Reads whether the machine carries exactly `content`, root:root 0644; with
 * manual DNS, also the list of the zone's sites, which the run writes.
 */
export function tlsZoneCheck(content: string, live = false): string {
  return machineCheck("setup:tls-zone:check", [
    // Asked by the credentials step only: whether a new policy would reach a running Caddy.
    ...(live ? [{ label: "tls-zone-live", test: POLICY_LIVE }] : []),
    { label: "tls-zone-file", test: `test -f ${TLS_ZONE_FILE}` },
    { label: "tls-zone-permissions", test: `[ "$(stat -c '%U:%G %a' ${TLS_ZONE_FILE})" = 'root:root 644' ]` },
    { label: "tls-zone-same", test: `[ "$(sha256sum < ${TLS_ZONE_FILE} | cut -d' ' -f1)" = '${fingerprint(content)}' ]` },
    ...(isOnDemand(content)
      ? [
          { label: "zone-names", test: `test -f ${ZONE_NAMES_FILE}` },
          { label: "no-wildcard", test: `! ${WILDCARD_HELD}` },
        ]
      : []),
  ]);
}

const DELIMITER = "TLS_ZONE";

/** The line tlsZoneRun prints when it restarted Caddy, for the step's report. */
export const TLS_ZONE_RESTARTED = "tls-zone: Caddy restarted with it";

/** What makes a Caddyfile in service import the policy file, in grep's words. */
const IMPORTS_POLICY = `grep -Eq '^[[:space:]]*import ${TLS_ZONE_FILE.replaceAll(".", "\\.")}' /etc/caddy/Caddyfile 2>/dev/null`;

/** A Caddy that runs a Caddyfile importing the policy file: a new policy reaches it through tlsZoneRun's restart. */
export const POLICY_LIVE = `${IMPORTS_POLICY} && systemctl is-active --quiet caddy`;

/**
 * True when the tls-zone step will lay another policy than the one in place
 * on a Caddy that runs it, and so restart Caddy: a switch of provider, whose
 * new credentials that restart reads too.
 */
export function policyPending(content: string): string {
  return `{ ${POLICY_LIVE} && [ "$(sha256sum < ${TLS_ZONE_FILE} 2>/dev/null | cut -d' ' -f1)" != '${fingerprint(content)}' ]; }`;
}

/** Where Caddy, run by its package's unit as the caddy account, keeps its certificates. */
export const CADDY_CERTIFICATES = "/var/lib/caddy/.local/share/caddy/certificates";

/** Where a wildcard set aside waits, outside Caddy's storage, until the run that set it aside ends. */
const RETIRED_WILDCARDS = "/var/lib/caddy/sitesolide-wildcards";

/** A wildcard certificate in Caddy's storage, which no certificate on demand renews. */
const WILDCARD_HELD = `ls -d ${CADDY_CERTIFICATES}/*/wildcard_.* >/dev/null 2>&1`;

/**
 * What both of setup's scripts that restart Caddy share, as shell functions:
 *
 *   lock_caddy <who>   takes the Caddy lock the deploys and the dashboard's
 *                      gatekeeper take (bin/cli/caddy-lock.ts), as `setup
 *                      <pid>`; held elsewhere, or unreadable, stops the script
 *                      with nothing changed. A stale one is left to the next
 *                      deploy, which takes it over.
 *   validate_caddy     `caddy validate` with the environment files loaded the
 *                      way systemd loads them, the DNS credentials and the zone.
 *   restart_caddy      `systemctl restart caddy`, then Caddy active three
 *                      seconds in a row. A restart and not a reload: only a
 *                      restart loads a new binary, after `caddy add-package`,
 *                      and a new environment file, systemd reading
 *                      EnvironmentFile at start alone. A blip on every site.
 *
 * The lock is handed back on every path: an EXIT trap, and HUP, INT, TERM and
 * PIPE turned into an exit, so that a dropped ssh session still runs it, and
 * `cleanup`, which each script defines, first. Never `caddy stop` nor `caddy
 * start`, see the Production section of CLAUDE.md.
 */
function restartPrelude(pid: number): string {
  return `
held=""
cleanup() { :; }
take_lock() {
  ${takeScript("setup", pid)}
}
release_lock() {
  ${releaseHeldScript("held")}
}
finish() { cleanup || true; [ -z "$held" ] || ( release_lock ) >/dev/null 2>&1 || true; held=""; }
trap finish EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 141' PIPE
lock_caddy() {
  taken=$(take_lock) || taken=""
  case "$taken" in
    "${MARKERS.taken} "*) held="\${taken#${MARKERS.taken} }" ;;
    "${MARKERS.held} "*)
      echo "$1: Caddy is being changed by $(echo "$taken" | sed -n 3p): nothing was changed, run setup again in a moment" >&2
      exit 1
      ;;
    *)
      echo "$1: the Caddy lock could not be taken: nothing was changed" >&2
      exit 1
      ;;
  esac
}
validate_caddy() {
  bash -c 'set -a; [ ! -f ${DNS_CREDENTIALS_FILE} ] || . ${DNS_CREDENTIALS_FILE}; . /etc/caddy/sitesolide.env; set +a; caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile' >/dev/null 2>&1
}
restart_caddy() {
  systemctl restart caddy || return 1
  for second in 1 2 3; do
    sleep 1
    systemctl is-active --quiet caddy || return 1
  done
}
`;
}

/**
 * Lays `content`, written beside the file and renamed over it: Caddy and the
 * shared service never read half of it. With manual DNS, the list of the
 * zone's sites follows.
 *
 * A file that already holds `content` is left as it is, its owner and mode
 * set again, and Caddy is left alone: a run of setup that finds nothing new
 * changes nothing.
 *
 * On a machine whose Caddyfile in service imports the file and whose Caddy
 * is active, a new policy, a mode or provider switch, only counts once Caddy
 * restarts: the run holds the Caddy lock from before the write, validates,
 * restarts (see restartPrelude for why not a reload), and says so with
 * TLS_ZONE_RESTARTED. On ANY failure, validation, restart, or Caddy not
 * active after it, and on an interruption, the previous file is put back,
 * or the new one removed when there was none, and after a failed restart
 * Caddy is restarted once more with it. On a first install the Caddyfile in
 * service is the package's and imports nothing: no lock, no restart,
 * bin/deploy-caddy.sh validates and reloads further on.
 *
 * `pid` names the run in the lock's holder line, the workstation's process
 * by default, as every take from the workstation does.
 */
export function tlsZoneRun(content: string, pid: number = process.pid): string {
  if (!content.endsWith("\n") || content.split("\n").includes(DELIMITER)) {
    throw new Error("tls-zone: the content is not what tlsZoneContent writes");
  }
  const staged = TLS_ZONE_FILE.replace(/[^/]+$/, ".$&.new");
  const names = isOnDemand(content) ? ZONE_NAMES_COMMAND.replace(/^sudo /, "") : ":";
  // A wildcard certificate a provider's DNS challenge obtained stays in
  // Caddy's storage when the zone turns to certificates on demand: Caddy goes
  // on serving it for every name, cannot renew it without that challenge, and
  // every site would go dark the day it expires. It is set aside, put back
  // with the previous policy if that one has to come back, deleted otherwise.
  const setAside = isOnDemand(content)
    ? `for wildcard in ${CADDY_CERTIFICATES}/*/wildcard_.*; do
  [ -d "$wildcard" ] || continue
  [ -n "$retired" ] || retired=$(mktemp -d ${RETIRED_WILDCARDS}.XXXXXX)
  issuer=$(basename "$(dirname "$wildcard")")
  mkdir -p "$retired/$issuer"
  mv "$wildcard" "$retired/$issuer/"
  echo "tls-zone: $(basename "$wildcard") set aside: a certificate on demand never renews a wildcard"
done`
    : "";
  // A Caddyfile in service from before this file carries Cloudflare's policy
  // itself and imports nothing: any other policy written here would change
  // nothing Caddy runs, while the credentials step has already changed what
  // it would read at its next start. Such a machine is upgraded first.
  const inline =
    content === tlsZoneContent(CLOUDFLARE_POLICY)
      ? ""
      : `if grep -q SITESOLIDE_ZONE /etc/caddy/Caddyfile 2>/dev/null && ! ${IMPORTS_POLICY}; then
  echo "tls-zone: the Caddyfile in service carries Cloudflare's policy itself, from a release before this file: run sitesolide upgrade first, then setup again" >&2
  exit 1
fi`;
  return runScript(
    "setup:tls-zone:run",
    `
[ -d /etc/caddy ] || { echo "tls-zone: /etc/caddy is missing, Caddy is not installed" >&2; exit 1; }
${inline}
${restartPrelude(pid)}
previous=""
existed=""
written=""
completed=""
retired=""
put_back() {
  if [ -n "$existed" ]; then install -m 644 -o root -g root "$previous" ${TLS_ZONE_FILE}; else rm -f ${TLS_ZONE_FILE}; fi
  if [ -n "$retired" ]; then
    for issuer in "$retired"/*; do
      [ -d "$issuer" ] || continue
      mkdir -p ${CADDY_CERTIFICATES}/"$(basename "$issuer")"
      for wildcard in "$issuer"/*; do mv "$wildcard" ${CADDY_CERTIFICATES}/"$(basename "$issuer")"/; done
    done
    rm -rf "$retired"
    retired=""
  fi
  written=""
}
cleanup() {
  if [ -n "$written" ] && [ -z "$completed" ]; then put_back; fi
  [ -z "$retired" ] || rm -rf "$retired"
  rm -f ${staged}
  [ -z "$previous" ] || rm -f "$previous"
}
live=""
if ${IMPORTS_POLICY} && systemctl is-active --quiet caddy; then
  live=yes
  lock_caddy tls-zone
fi
install -m 644 -o root -g root /dev/stdin ${staged} <<'${DELIMITER}'
${content}${DELIMITER}
if [ -f ${TLS_ZONE_FILE} ] && cmp -s ${staged} ${TLS_ZONE_FILE}${isOnDemand(content) ? ` && ! ${WILDCARD_HELD}` : ""}; then
  mv -f ${staged} ${TLS_ZONE_FILE}
  ${names}
  completed=yes
  echo "tls-zone: ${TLS_ZONE_FILE} already holds this policy: its owner and mode set again, Caddy left alone"
  exit 0
fi
if [ -f ${TLS_ZONE_FILE} ]; then previous=$(mktemp); cp ${TLS_ZONE_FILE} "$previous"; existed=yes; fi
# Marked before the move: an interruption between the two still puts the
# previous file back, which the move had not yet replaced.
written=yes
mv -f ${staged} ${TLS_ZONE_FILE}
echo "tls-zone: ${TLS_ZONE_FILE} written"
${names}
${setAside}
if [ -n "$live" ]; then
  if ! validate_caddy; then
    put_back
    echo "tls-zone: caddy validate refuses the configuration with this policy: the previous one is back, Caddy was not restarted and still serves with it" >&2
    exit 1
  fi
  if ! restart_caddy; then
    put_back
    if restart_caddy; then
      echo "tls-zone: Caddy did not come back active with this policy: the previous one is back, and Caddy with it" >&2
    else
      echo "tls-zone: Caddy did not come back active with this policy, nor with the previous one put back: sudo journalctl -u caddy" >&2
    fi
    exit 1
  fi
  # Caddy runs this policy now: an interruption from here on must not put the
  # previous file back under it, so the run counts as completed before
  # anything more is said.
  completed=yes
  echo "${TLS_ZONE_RESTARTED}"
fi
completed=yes
`,
  );
}

/** A reason a restart line names: words, never a character a shell or a log line would read. */
const RESTART_REASON = /^[A-Za-z0-9 .,:;()/_+-]{1,120}$/;

/** The lines caddyRestartScript ends on, for the step that runs it. */
export const CADDY_RESTART = {
  restarted: "caddy-restart: Caddy restarted",
  skipped: "caddy-restart: not restarted, Caddy is not active with the platform's Caddyfile",
} as const;

/**
 * Restarts Caddy so that it reads what changed beside its configuration: a
 * new token in /etc/caddy/cloudflare.env, a rotation, which the running
 * process holds in memory since it filled its `{env.NAME}` at start. Run as
 * root by setup, like tlsZoneRun, under the tag `setup:caddy-restart:run`.
 *
 *   - Caddy not active, or the Caddyfile in service not the platform's (no
 *     SITESOLIDE_ZONE in it, a first install): nothing done, exit 0, and the
 *     line CADDY_RESTART.skipped; Caddy reads the files when it starts.
 *   - Otherwise the Caddy lock, as `setup <pid>`: held elsewhere, exit 1,
 *     nothing done. Then `caddy validate` with the environment files as
 *     systemd loads them: refused, exit 1, no restart, Caddy going on with
 *     the previous values. Then `systemctl restart caddy` and Caddy active
 *     three seconds in a row: exit 0 and `CADDY_RESTART.restarted (<reason>)`;
 *     not active, exit 1, pointing at the journal.
 *   - The lock handed back on every path, interruptions included.
 *
 * `reason` is said in the lines: letters, digits, spaces and `.,:;()/_+-`,
 * 120 at most.
 */
export function caddyRestartScript(reason: string, pid: number = process.pid): string {
  if (!RESTART_REASON.test(reason)) throw new Error(`caddy-restart: ${JSON.stringify(reason)} is not a reason this script says`);
  return runScript(
    "setup:caddy-restart:run",
    `
${restartPrelude(pid)}
if ! grep -q SITESOLIDE_ZONE /etc/caddy/Caddyfile 2>/dev/null || ! systemctl is-active --quiet caddy; then
  echo "${CADDY_RESTART.skipped} (${reason}): it reads the environment files when it starts"
  exit 0
fi
lock_caddy caddy-restart
if ! validate_caddy; then
  echo "caddy-restart: not restarted (${reason}): caddy validate refuses the configuration with the environment files as they are now, Caddy goes on with the previous values" >&2
  exit 1
fi
if ! restart_caddy; then
  echo "caddy-restart: Caddy did not come back active after its restart (${reason}): sudo journalctl -u caddy" >&2
  exit 1
fi
echo "${CADDY_RESTART.restarted} (${reason})"
`,
  );
}

if (import.meta.main) {
  console.log(shellAssignments());
}
