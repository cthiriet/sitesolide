/**
 * What an app may reach outside the machine, and the credentials the platform
 * lends it without handing them over: the manifest's `egress` and `connectors`
 * keys, and what they change in the unit and in the deployment.
 *
 * `network` was binary until now: `localhost`, which cuts everything but the
 * loopback, or `outbound`, which opens everything. An app written by an agent
 * that needs one API had to be given the whole Internet. `egress` lists the
 * hosts it may reach instead: the unit keeps `IPAddressDeny=any`, so the
 * service still cannot leave on its own, and its HTTP clients are pointed at
 * the egress proxy on the loopback, which lets through the hosts of this list
 * and nothing else. See egress/README.md for the proxy and its threat model.
 *
 * `connectors` names credentials an administrator defined on the machine,
 * `slack` or `github`: the app calls the proxy in plain HTTP on the loopback,
 * and the proxy forwards over HTTPS with the credential added. The manifest
 * only asks; a grant made from the dashboard, on the machine, is what allows,
 * so that a manifest can never grant itself a company's credential.
 *
 * Imported by bin/cli/manifest.ts and bin/cli/unit.ts, borrowed with them by
 * the dashboard, and embedded in the egress proxy's bundle: one rule for what
 * the CLI accepts and what the proxy lets through. Pure, and with no import
 * but a type, so that a flat copy in dashboard/borrowed/ still resolves.
 */
import type { Manifest } from "./manifest";

/** The proxy listens on the loopback only: the projects reach nothing else. */
export const EGRESS_ADDRESS = "127.0.0.1";

/**
 * CONNECT and plain HTTP forwarding, the port HTTPS_PROXY and HTTP_PROXY name.
 * 3128 is the port proxies have used for decades, which says what it is to
 * whoever reads `ss -ltn`.
 *
 * OUTSIDE 3000-3099 ON PURPOSE. The loopback rule reserves that range to Caddy
 * and root (bin/cli/loopback.ts): a port inside it would be closed to the very
 * projects that need it. Nothing else of this repository listens on 3128 or
 * 3129; bin/deploy-egress.sh checks the machine before starting anything.
 */
export const EGRESS_PROXY_PORT = 3128;

/**
 * The connectors, plain HTTP on the loopback, and the read-only routes the
 * dashboard calls. A second port rather than the first one: CONNECT needs a
 * raw TCP listener, and a connector is an HTTP request with a body and a
 * streamed answer, which Bun.serve parses and streams for us. Writing a second
 * HTTP implementation into a security component to save one port would be the
 * wrong trade.
 */
export const CONNECTORS_PORT = 3129;

/** What a manifest may list. A longer list is no longer a decision anyone reads. */
export const MAX_EGRESS_ENTRIES = 64;
export const MAX_CONNECTORS = 32;

/** The unit `deploy` looks for before deploying a project that needs it. */
export const EGRESS_UNIT = "sitesolide-egress";

/** The base of the connectors' addresses, as the unit hands it to the service. */
export const CONNECTORS_URL = `http://${EGRESS_ADDRESS}:${CONNECTORS_PORT}/connectors`;

/**
 * The variables the unit sets for a project that declares `egress` or
 * `connectors`, which its own `env` may therefore not set. Both spellings of
 * the proxy variables are written, since clients disagree: curl reads only the
 * lowercase `http_proxy`, Go and Python read either.
 *
 * Both spellings are reserved for the same reason: systemd keeps the last
 * value of a variable set twice, and a lowercase `https_proxy` in `env` would
 * override the unit's for every client that reads that spelling. The manifest
 * refuses lowercase names in `env` anyway, for a rule of its own; this list
 * does not lean on it.
 */
export const PROXY_VARIABLES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "SITESOLIDE_CONNECTORS",
];

/**
 * An entry of `egress`, read: an exact host or a wildcard over its
 * subdomains, and the port when the entry names one.
 */
export type HostPattern = { wildcard: boolean; host: string; port: number | null };

/**
 * Ports a pattern without one lets through: 443 for HTTPS, 80 for plain HTTP.
 * Any other port has to be written in the entry, `db.example.com:8443`.
 */
export const DEFAULT_PORTS: readonly number[] = [443, 80];

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * A host name as the proxy compares it, or null if it is not a DNS name.
 *
 * Lowercase, without the final dot of a fully qualified name, and in its ASCII
 * form: `Bücher.Example.` and `xn--bcher-kva.example` are the same host, and a
 * client sends the second. The conversion is the URL parser's, the one every
 * HTTP client applies before sending.
 *
 * **Names, never addresses.** A last label made of digits, `127.0.0.1` or a
 * full-width `１２７.0.0.1` that the parser folds into it, is refused: an
 * allowlist of names is one an administrator can read, and an address there
 * would bypass the classification of resolved addresses.
 */
export function normalizeHost(raw: string): string | null {
  if (raw.length === 0 || raw.length > 253) return null;
  // What would make the URL parser read something else than a host: a path, a
  // userinfo, a port, a bracketed address, a space or an escape.
  if (/[\s/\\?#@:[\]%*]/.test(raw)) return null;
  let host: string;
  try {
    host = new URL(`http://${raw}/`).hostname;
  } catch {
    return null;
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((label) => label.length <= 63 && LABEL.test(label))) return null;
  if (/^[0-9]+$/.test(labels.at(-1)!)) return null;
  return host;
}

/**
 * Reads an entry of `egress`: `api.example.com`, `*.slack.com`, or either with
 * a `:port`. Null when it is not one.
 *
 * A wildcard covers the subdomains, never the name itself: `*.slack.com`
 * matches `files.slack.com`, not `slack.com`, which is listed on its own when
 * it is wanted. It needs two labels after it, so that `*.com` cannot open a
 * whole top-level domain; a public suffix such as `co.uk` still passes, and
 * the README says so.
 */
export function parseEgressEntry(entry: unknown): HostPattern | null {
  if (typeof entry !== "string") return null;
  const match = /^(.+?)(?::([0-9]{1,5}))?$/.exec(entry);
  if (match === null) return null;
  const [, name = "", portText] = match;
  const port = portText === undefined ? null : Number(portText);
  if (port !== null && (port < 1 || port > 65535)) return null;
  const wildcard = name.startsWith("*.");
  const host = normalizeHost(wildcard ? name.slice(2) : name);
  if (host === null) return null;
  if (wildcard && host.split(".").length < 2) return null;
  return { wildcard, host, port };
}

/** The entry as the proxy and the dashboard write it back. */
export function formatPattern(pattern: HostPattern): string {
  return `${pattern.wildcard ? "*." : ""}${pattern.host}${pattern.port === null ? "" : `:${pattern.port}`}`;
}

/**
 * Does this destination match one of the patterns? `host` is already
 * normalized, `port` the one the client asked for.
 */
export function matchesEgress(patterns: readonly HostPattern[], host: string, port: number): boolean {
  return patterns.some((pattern) => {
    const portAllowed = pattern.port === null ? DEFAULT_PORTS.includes(port) : pattern.port === port;
    if (!portAllowed) return false;
    return pattern.wildcard ? host.endsWith(`.${pattern.host}`) : host === pattern.host;
  });
}

/**
 * A name every JavaScript object already answers to: `constructor`,
 * `toString`, `__proto__`. The connectors live in an object keyed by name, and
 * `connectors["constructor"]` is never undefined: a connector so named would
 * read as present before it exists, and a change without a value would then
 * write a record with none, a file the proxy refuses whole.
 */
export function isInheritedName(name: string): boolean {
  return Object.hasOwn(Object.prototype, name);
}

/**
 * A connector's name: what the manifest lists, what the dashboard grants, and a
 * segment of `/connectors/<name>/`. Same shape as a service's name, and never
 * a name every object inherits. Only `constructor` has the shape today; the
 * others are refused by name as well, should the shape widen one day.
 */
export function isValidConnectorName(name: unknown): name is string {
  return typeof name === "string" && name.length <= 32 && /^[a-z]([a-z0-9-]*[a-z0-9])?$/.test(name) && !isInheritedName(name);
}

/** Does the project list hosts to reach through the proxy? */
export function declaresEgress(manifest: Manifest): boolean {
  return Array.isArray(manifest.egress) && manifest.egress.length > 0;
}

/** Does the project ask for connectors? */
export function declaresConnectors(manifest: Manifest): boolean {
  return Array.isArray(manifest.connectors) && manifest.connectors.length > 0;
}

/** The patterns of a valid manifest, the invalid entries left out. */
export function egressPatterns(manifest: Manifest): HostPattern[] {
  if (!Array.isArray(manifest.egress)) return [];
  return manifest.egress.map(parseEgressEntry).filter((pattern): pattern is HostPattern => pattern !== null);
}

/** The connectors a valid manifest asks for, the invalid names left out. */
export function requestedConnectors(manifest: Manifest): string[] {
  if (!Array.isArray(manifest.connectors)) return [];
  return manifest.connectors.filter(isValidConnectorName);
}

/**
 * The refusals of `egress` and `connectors`, for validate(). `isApplication`
 * is passed rather than recomputed: this module imports nothing from the
 * manifest's, which imports it.
 */
export function egressErrors(manifest: Manifest, isApplication: boolean): string[] {
  const errors: string[] = [];

  if (manifest.egress !== undefined) {
    const entries = manifest.egress as unknown;
    if (!Array.isArray(entries) || entries.length === 0) {
      errors.push('egress: a non-empty list of hosts, such as ["api.example.com", "*.slack.com"]');
    } else {
      if (entries.length > MAX_EGRESS_ENTRIES) errors.push(`egress: ${MAX_EGRESS_ENTRIES} hosts at most`);
      const seen = new Set<string>();
      for (const entry of entries) {
        const pattern = parseEgressEntry(entry);
        if (pattern === null) {
          errors.push(
            `egress: "${String(entry)}" must be a host name such as api.example.com or *.example.com, optionally with :port, never an address`,
          );
          continue;
        }
        const written = formatPattern(pattern);
        if (seen.has(written)) errors.push(`egress: ${written} is listed twice`);
        seen.add(written);
      }
    }
    // Both together would read as a restriction while the unit opens
    // everything: `outbound` lifts IPAddressDeny, and the proxy is then one
    // way out among all the others.
    if (manifest.network === "outbound") {
      errors.push("egress: network outbound already reaches every host; keep egress and drop network, or the reverse");
    }
    if (!isApplication) errors.push("egress: without `start`, nothing runs to reach anything");
  }

  if (manifest.connectors !== undefined) {
    const names = manifest.connectors as unknown;
    if (!Array.isArray(names) || names.length === 0) {
      errors.push('connectors: a non-empty list of connector names, such as ["slack"]');
    } else {
      if (names.length > MAX_CONNECTORS) errors.push(`connectors: ${MAX_CONNECTORS} at most`);
      const seen = new Set<string>();
      for (const name of names) {
        if (typeof name === "string" && isInheritedName(name)) {
          errors.push(`connectors: ${name} is reserved, every JavaScript object already carries that name`);
        } else if (!isValidConnectorName(name)) {
          errors.push(`connectors: "${String(name)}" should start with a letter, then lowercase letters, digits and dashes, 32 characters at most`);
        } else if (seen.has(name)) {
          errors.push(`connectors: ${name} is listed twice`);
        } else {
          seen.add(name);
        }
      }
    }
    if (!isApplication) errors.push("connectors: without `start`, nothing runs to call them");
  }

  if (manifest.egress !== undefined || manifest.connectors !== undefined) {
    const declared = [
      ...Object.keys(manifest.env ?? {}),
      ...Object.values(manifest.services ?? {}).flatMap((service) =>
        typeof service === "object" && service !== null ? Object.keys(service.env ?? {}) : [],
      ),
    ];
    for (const name of new Set(declared)) {
      if (PROXY_VARIABLES.includes(name)) {
        errors.push(`env: ${name} is set by the deployment for egress and connectors, and cannot be redefined`);
      }
    }
  }

  return errors;
}

/**
 * The lines the unit gains for a project that declares `egress` or
 * `connectors`, comments included. None for any other project: its unit stays
 * byte for byte what it was, and the units in service are not reported as
 * diverging on the next deployment.
 */
export function egressUnitLines(manifest: Manifest): string[] {
  const lines: string[] = [];
  if (declaresEgress(manifest)) {
    const proxy = `http://${EGRESS_ADDRESS}:${EGRESS_PROXY_PORT}`;
    // localhost and the loopback addresses go direct: the services of one
    // project call each other there, and the connectors are there too.
    const direct = `localhost,${EGRESS_ADDRESS},::1`;
    lines.push(
      "",
      "# egress: the service still reaches only the loopback (see IPAddressDeny",
      "# below); its HTTP clients go through the egress proxy, which lets through",
      "# the hosts its sitesolide.json lists and refuses the rest. curl reads the",
      "# lowercase spelling, Go and Python either, Bun's fetch both; Node's fetch",
      "# reads neither by default. See egress/README.md.",
      `Environment=HTTPS_PROXY=${proxy}`,
      `Environment=https_proxy=${proxy}`,
      `Environment=HTTP_PROXY=${proxy}`,
      `Environment=http_proxy=${proxy}`,
      `Environment=NO_PROXY=${direct}`,
      `Environment=no_proxy=${direct}`,
    );
  }
  if (declaresConnectors(manifest)) {
    lines.push(
      "",
      "# connectors: credentials lent by the machine, never handed over. The",
      "# service calls <this address>/<name>/<path>, the proxy adds the",
      "# credential, if the dashboard granted it to this project.",
      `Environment=SITESOLIDE_CONNECTORS=${CONNECTORS_URL}`,
    );
  }
  return lines;
}

// --- The deployment's check ------------------------------------------------

/** The last line of the read, so that an empty output is never taken for an answer. */
export const EGRESS_MARKER = "DONE";

/**
 * Where the egress proxy stands on the machine. `systemctl is-active` needs no
 * privilege, and the unit file is readable by everyone.
 */
export function egressStateCommand(): string {
  return (
    `sh -c 'if systemctl is-active --quiet ${EGRESS_UNIT}.service; then echo active; ` +
    `elif [ -f /etc/systemd/system/${EGRESS_UNIT}.service ]; then echo inactive; else echo absent; fi; ` +
    `echo ${EGRESS_MARKER}'`
  );
}

export type EgressState = "active" | "inactive" | "absent" | "unreadable";

export function readEgressState(output: string): EgressState {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length !== 2 || lines[1] !== EGRESS_MARKER) return "unreadable";
  const state = lines[0];
  return state === "active" || state === "inactive" || state === "absent" ? state : "unreadable";
}
