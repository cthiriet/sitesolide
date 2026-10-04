import { describe, expect, test } from "bun:test";
import { parseEgressEntry, type HostPattern } from "../../bin/cli/egress";
import {
  connectDestination,
  decide,
  forwardDestination,
  forwardedHead,
  headEnd,
  parseHead,
  refusal,
} from "../src/decide";
import type { Caller } from "../src/proc-net";

const SHOP: Caller = { kind: "project", slug: "shop", account: "site-shop" };
const LIST: HostPattern[] = ["api.example.com", "*.slack.com", "db.example.com:8443"].map((entry) => parseEgressEntry(entry)!);
const encoder = new TextEncoder();

describe("the head of a request", () => {
  test("ends at the first blank line, which may arrive in pieces", () => {
    expect(headEnd(encoder.encode("CONNECT a:443 HTTP/1.1\r\nHost: a:443\r\n\r\nrest"))).toBe(39);
    expect(headEnd(encoder.encode("CONNECT a:443 HTTP/1.1\r\nHost: a:443\r\n"))).toBe(-1);
    expect(headEnd(encoder.encode("\r\n\r"))).toBe(-1);
  });

  test("a request line and headers", () => {
    expect(parseHead("CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\nUser-Agent: curl/8\r\n\r\n")).toEqual({
      method: "CONNECT",
      target: "api.example.com:443",
      version: "HTTP/1.1",
      headers: [
        ["Host", "api.example.com:443"],
        ["User-Agent", "curl/8"],
      ],
    });
  });

  test("refuses what two readers could disagree on", () => {
    for (const text of [
      "CONNECT a:443 HTTP/1.1\r\n folded: header\r\n\r\n",
      "CONNECT a:443 HTTP/1.1\nHost: a\r\n\r\n",
      "CONNECT a:443 HTTP/2\r\n\r\n",
      "connect a:443 HTTP/1.1\r\n\r\n",
      "CONNECT  a:443 HTTP/1.1\r\n\r\n",
      "CONNECT a:443 HTTP/1.1\r\nBad Name: x\r\n\r\n",
      "CONNECT a:443 HTTP/1.1\r\n: empty\r\n\r\n",
      "CONNECT a:443 HTTP/1.1\r\nHost: a\r\n",
    ]) {
      expect({ text, head: parseHead(text) }).toEqual({ text, head: null });
    }
  });
});

describe("the destination", () => {
  test("of a CONNECT: a host name and a port", () => {
    expect(connectDestination("API.Example.com.:443")).toEqual({ host: "api.example.com", port: 443 });
    expect(connectDestination("bücher.example:443")).toEqual({ host: "xn--bcher-kva.example", port: 443 });
    for (const target of ["api.example.com", "api.example.com:", "api.example.com:0", "api.example.com:99999", "10.0.0.1:443", "[::1]:443", ":443", "a b:443"]) {
      expect({ target, destination: connectDestination(target) }).toEqual({ target, destination: null });
    }
  });

  test("of a plain HTTP request: an http:// address, and the path the origin receives", () => {
    expect(forwardDestination("http://api.example.com/v1/x?y=1")).toEqual({ host: "api.example.com", port: 80, path: "/v1/x?y=1" });
    expect(forwardDestination("http://api.example.com:8080")).toEqual({ host: "api.example.com", port: 8080, path: "/" });
    for (const target of ["/v1/x", "https://api.example.com/", "http://user:pw@api.example.com/", "http://127.0.0.1/", "http://[::1]/"]) {
      expect({ target, destination: forwardDestination(target) }).toEqual({ target, destination: null });
    }
  });
});

describe("the decision", () => {
  test("a listed host is let through for its project", () => {
    expect(decide(SHOP, LIST, { host: "api.example.com", port: 443 })).toEqual({ allowed: true, slug: "shop" });
    expect(decide(SHOP, LIST, { host: "files.slack.com", port: 443 })).toEqual({ allowed: true, slug: "shop" });
    expect(decide(SHOP, LIST, { host: "db.example.com", port: 8443 })).toEqual({ allowed: true, slug: "shop" });
  });

  test("anything else is refused, and the message names the host and the manifest", () => {
    const verdict = decide(SHOP, LIST, { host: "evil.example.net", port: 443 });
    expect(verdict).toMatchObject({ allowed: false, status: 403, target: "shop", reason: "not in the list" });
    if (!verdict.allowed) expect(verdict.message).toContain("evil.example.net:443 is not in the egress list of shop's sitesolide.json");
    expect(decide(SHOP, LIST, { host: "api.example.com", port: 22 })).toMatchObject({ allowed: false });
    expect(decide(SHOP, LIST, { host: "slack.com", port: 443 })).toMatchObject({ allowed: false });
  });

  test("a project without a list reaches nothing", () => {
    expect(decide(SHOP, null, { host: "api.example.com", port: 443 })).toMatchObject({ allowed: false, reason: "no egress declared" });
    expect(decide(SHOP, [], { host: "api.example.com", port: 443 })).toMatchObject({ allowed: false, reason: "no egress declared" });
  });

  test("an account that is not a project's, or nobody, is refused whatever the list", () => {
    expect(decide({ kind: "account", account: "root" }, LIST, { host: "api.example.com", port: 443 })).toMatchObject({
      allowed: false,
      target: null,
      reason: "not a project",
    });
    expect(decide({ kind: "unknown", reason: "x" }, LIST, { host: "api.example.com", port: 443 })).toMatchObject({
      allowed: false,
      reason: "unidentified",
    });
  });
});

describe("what the origin receives for plain HTTP", () => {
  test("origin form, the hop's headers dropped, the host judged, the connection closed", () => {
    const head = parseHead(
      "GET http://api.example.com/v1?x=1 HTTP/1.1\r\nHost: evil.example.net\r\nProxy-Authorization: Basic eA==\r\nProxy-Connection: keep-alive\r\nConnection: keep-alive\r\nAccept: */*\r\n\r\n",
    )!;
    const rewritten = forwardedHead(head, forwardDestination(head.target)!);
    expect(rewritten).toBe("GET /v1?x=1 HTTP/1.1\r\nAccept: */*\r\nHost: api.example.com\r\nConnection: close\r\n\r\n");
  });
});

describe("a refusal", () => {
  test("a status, a sentence, its length, and the connection closed", () => {
    const text = refusal(403, "egress: refused, é");
    expect(text.startsWith("HTTP/1.1 403 Forbidden\r\n")).toBe(true);
    expect(text).toContain("Content-Length: 20\r\n");
    expect(text).toContain("X-Sitesolide-Egress: refused\r\n");
    expect(text).toContain("Connection: close\r\n");
    expect(text.endsWith("\r\n\r\negress: refused, é\n")).toBe(true);
  });
});
