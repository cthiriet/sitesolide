/**
 * What the proxy decides, apart from the sockets: reading a request's head,
 * the destination it names, and whether the calling project may reach it.
 *
 * Pure, so that every refusal is checkable without a socket: proxy.ts reads
 * bytes and connects, this file says yes or no.
 */
import { matchesEgress, normalizeHost, type HostPattern } from "../../bin/cli/egress";
import type { Caller } from "./proc-net";

/** The head of an HTTP request: its first line and its headers, as sent. */
export type RequestHead = {
  method: string;
  target: string;
  version: string;
  headers: [name: string, value: string][];
};

const CRLFCRLF = [13, 10, 13, 10];

/** The index just past the blank line that ends the head, or -1 while it has not arrived. */
export function headEnd(bytes: Uint8Array): number {
  outer: for (let i = 0; i + 3 < bytes.length; i++) {
    for (let j = 0; j < 4; j++) if (bytes[i + j] !== CRLFCRLF[j]) continue outer;
    return i + 4;
  }
  return -1;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * The head, or null when it is not a well-formed HTTP/1 request. Folded
 * header lines and bare line feeds are refused rather than interpreted: two
 * readers that disagree on where a header ends are how requests get smuggled.
 */
export function parseHead(text: string): RequestHead | null {
  if (!text.endsWith("\r\n\r\n")) return null;
  const lines = text.slice(0, -4).split("\r\n");
  if (lines.some((line) => line.includes("\n") || line.includes("\r"))) return null;
  const request = /^([A-Z]+) (\S+) (HTTP\/1\.[01])$/.exec(lines[0] ?? "");
  if (request === null) return null;
  const headers: [string, string][] = [];
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    const name = line.slice(0, colon);
    if (!TOKEN.test(name)) return null;
    headers.push([name, line.slice(colon + 1).trim()]);
  }
  return { method: request[1]!, target: request[2]!, version: request[3]!, headers };
}

/** Where a request wants to go: a host name and a port. */
export type Destination = { host: string; port: number };

/**
 * The destination of a CONNECT, `api.example.com:443`. Names only: a
 * bracketed IPv6 address or a dotted IPv4 one is refused, the allowlist being
 * one of names.
 */
export function connectDestination(target: string): Destination | null {
  const colon = target.lastIndexOf(":");
  if (colon <= 0 || target.startsWith("[")) return null;
  const portText = target.slice(colon + 1);
  if (!/^[0-9]{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > 65535) return null;
  const host = normalizeHost(target.slice(0, colon));
  return host === null ? null : { host, port };
}

/**
 * The destination of a plain HTTP request sent to a proxy, in absolute form:
 * `GET http://api.example.com/path HTTP/1.1`. Returns the path the origin
 * receives instead. `https://` in absolute form is not how clients ask, they
 * send CONNECT, and is refused.
 */
export function forwardDestination(target: string): (Destination & { path: string }) | null {
  if (!target.startsWith("http://")) return null;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  const host = normalizeHost(url.hostname);
  if (host === null) return null;
  return { host, port: url.port === "" ? 80 : Number(url.port), path: `${url.pathname}${url.search}` };
}

export type Verdict =
  | { allowed: true; slug: string }
  | { allowed: false; status: number; target: string | null; reason: string; message: string };

/**
 * May this caller reach this destination? A project, whose manifest on the
 * machine lists the host. Anyone else, an account that is not a project's or a
 * connection nobody could name, is refused: the proxy serves projects, and
 * the kernel says who is one.
 */
export function decide(caller: Caller, egress: HostPattern[] | null, destination: Destination): Verdict {
  const written = `${destination.host}:${destination.port}`;
  if (caller.kind !== "project") {
    const who = caller.kind === "account" ? `the account ${caller.account}` : "a caller nobody could name";
    return {
      allowed: false,
      status: 403,
      target: null,
      reason: caller.kind === "account" ? "not a project" : "unidentified",
      message: `egress: refused, the connection comes from ${who}, not from a project's service`,
    };
  }
  if (egress === null || egress.length === 0) {
    return {
      allowed: false,
      status: 403,
      target: caller.slug,
      reason: "no egress declared",
      message: `egress: refused, ${caller.slug} declares no egress in its sitesolide.json on the server`,
    };
  }
  if (!matchesEgress(egress, destination.host, destination.port)) {
    return {
      allowed: false,
      status: 403,
      target: caller.slug,
      reason: "not in the list",
      message: `egress: refused, ${written} is not in the egress list of ${caller.slug}'s sitesolide.json`,
    };
  }
  return { allowed: true, slug: caller.slug };
}

/**
 * Headers a proxy consumes and never forwards: those of the hop between the
 * client and it, and the proxy's own.
 */
export const HOP_BY_HOP: readonly string[] = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "upgrade",
];

/**
 * The head the origin receives for a plain HTTP request: origin-form, the
 * hop's headers dropped, the host the one that was judged, and the connection
 * closed after the answer, so that a second request on the same connection
 * can never be read as going elsewhere.
 */
export function forwardedHead(head: RequestHead, destination: Destination & { path: string }): string {
  const lines = [`${head.method} ${destination.path} HTTP/1.1`];
  for (const [name, value] of head.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.includes(lower) || lower === "host") continue;
    lines.push(`${name}: ${value}`);
  }
  lines.push(`Host: ${destination.host}${destination.port === 80 ? "" : `:${destination.port}`}`, "Connection: close");
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/** A refusal the client reads: a status, a sentence, and the connection closed. */
export function refusal(status: number, message: string): string {
  const reasons: Record<number, string> = {
    400: "Bad Request",
    403: "Forbidden",
    405: "Method Not Allowed",
    431: "Request Header Fields Too Large",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
  };
  const body = `${message}\n`;
  return [
    `HTTP/1.1 ${status} ${reasons[status] ?? "Error"}`,
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${new TextEncoder().encode(body).length}`,
    "X-Sitesolide-Egress: refused",
    "Connection: close",
    "",
    body,
  ].join("\r\n");
}
