import { describe, expect, test } from "bun:test";
import { parseHead } from "../src/decide";
import {
  answerFraming,
  bodyReader,
  downstreamHead,
  expectsContinue,
  parseAnswerHead,
  requestFraming,
  upstreamHead,
  type BodyRead,
  type Framing,
} from "../src/http1";

const encoder = new TextEncoder();
const decoder = new TextDecoder("latin1");

/** Feeds a body in the pieces given, and says what came of it: the data, the bytes used of each piece, the end, or the error. */
function feed(framing: Framing, pieces: string[]): { data: string; used: number[]; done: boolean } | { error: string } {
  const reader = bodyReader(framing);
  let data = "";
  const used: number[] = [];
  let done = false;
  for (const piece of pieces) {
    const read: BodyRead = reader.read(encoder.encode(piece));
    if ("error" in read) return read;
    for (const each of read.data) data += decoder.decode(each);
    used.push(read.used);
    done = read.done;
    if (done) break;
  }
  return { data, used, done };
}

/** Every way of cutting a text in two, to prove a reader keeps its state across reads. */
function splits(text: string): string[][] {
  return Array.from({ length: text.length + 1 }, (_, i) => [text.slice(0, i), text.slice(i)]);
}

describe("the framing of a request's body", () => {
  test("a length, chunks, or none", () => {
    expect(requestFraming([["Content-Length", "12"]])).toEqual({ kind: "length", length: 12 });
    expect(requestFraming([["Transfer-Encoding", "Chunked"]])).toEqual({ kind: "chunked" });
    expect(requestFraming([["Host", "x"]])).toEqual({ kind: "none" });
    // The same length twice, as a list or on two lines, is one length.
    expect(requestFraming([["Content-Length", "5, 5"]])).toEqual({ kind: "length", length: 5 });
    expect(requestFraming([["Content-Length", "5"], ["content-length", "5"]])).toEqual({ kind: "length", length: 5 });
  });

  test("whatever two readers could read two ways is refused", () => {
    // The classic smuggling pair: one reader takes the length, the other the chunks.
    expect(requestFraming([["Content-Length", "5"], ["Transfer-Encoding", "chunked"]])).toMatchObject({ status: 400 });
    for (const length of ["5, 6", "-1", "0x10", "1e3", "", " ", "9".repeat(16)]) {
      expect(requestFraming([["Content-Length", length]])).toMatchObject({ status: 400 });
    }
    for (const coding of ["gzip, chunked", "chunked, chunked", "identity", "chunked;q=1"]) {
      expect(requestFraming([["Transfer-Encoding", coding]])).toMatchObject({ status: 501 });
    }
  });
});

describe("the framing of an answer's body", () => {
  test("no body after HEAD, an interim status, 204 or 304, whatever the headers say", () => {
    const length: [string, string][] = [["Content-Length", "10"]];
    expect(answerFraming("HEAD", 200, length)).toEqual({ kind: "none" });
    for (const status of [100, 204, 304]) expect(answerFraming("GET", status, length)).toEqual({ kind: "none" });
  });

  test("chunks win over a length, a coding past them runs to the close, and nothing said runs to the close", () => {
    expect(answerFraming("GET", 200, [["Content-Length", "10"], ["Transfer-Encoding", "chunked"]])).toEqual({ kind: "chunked" });
    expect(answerFraming("GET", 200, [["Transfer-Encoding", "gzip, chunked"]])).toEqual({ kind: "chunked" });
    expect(answerFraming("GET", 200, [["Transfer-Encoding", "gzip"]])).toEqual({ kind: "close" });
    expect(answerFraming("GET", 200, [])).toEqual({ kind: "close" });
    expect(answerFraming("GET", 200, [["Content-Length", "7"]])).toEqual({ kind: "length", length: 7 });
    expect(answerFraming("GET", 200, [["Content-Length", "7, 8"]])).toMatchObject({ error: expect.stringContaining("Content-Length") });
  });
});

describe("reading a body as it streams", () => {
  test("a length: its bytes and no more, whichever way the reads cut it", () => {
    for (const pieces of splits("hello world!rest")) {
      expect(feed({ kind: "length", length: 12 }, pieces)).toMatchObject({ data: "hello world!", done: true });
    }
    // What follows the body is not used.
    expect(feed({ kind: "length", length: 3 }, ["abcdef"])).toEqual({ data: "abc", used: [3], done: true });
    expect(feed({ kind: "length", length: 0 }, ["abc"])).toEqual({ data: "", used: [0], done: true });
  });

  test("chunks: their data, extensions and trailers read past, whichever way the reads cut them", () => {
    const body = "5;name=value\r\nhello\r\n6\r\n world\r\n0\r\nTrailer: yes\r\n\r\n";
    for (const pieces of splits(`${body}GET /next HTTP/1.1\r\n\r\n`)) {
      const read = feed({ kind: "chunked" }, pieces);
      expect(read).toMatchObject({ data: "hello world", done: true });
      // The bytes used end where the body does: the request behind it is not.
      if (!("error" in read)) expect(read.used.reduce((sum, each) => sum + each, 0)).toBe(body.length);
    }
    expect(feed({ kind: "chunked" }, ["A\r\n0123456789\r\n0\r\n\r\n"])).toMatchObject({ data: "0123456789", done: true });
  });

  test("chunks that two readers could cut two ways are refused", () => {
    for (const body of [
      "5\nhello\r\n0\r\n\r\n", // a bare line feed after the size
      "5\r\nhello\n0\r\n\r\n", // after the data
      "5\r\nhelloX\r\n0\r\n\r\n", // data longer than its size
      "5\rhello\r\n0\r\n\r\n", // a carriage return alone
      "-5\r\nhello\r\n0\r\n\r\n",
      "0x5\r\nhello\r\n0\r\n\r\n",
      " 5\r\nhello\r\n0\r\n\r\n",
      "\r\nhello\r\n0\r\n\r\n",
      `${"1".repeat(14)}\r\n`, // past 2^52
      `5;${"x".repeat(5000)}\r\n`,
      `0\r\n${"x: y\r\n".repeat(3000)}\r\n`,
    ]) {
      expect(feed({ kind: "chunked" }, [body])).toMatchObject({ error: expect.any(String) });
    }
  });

  test("to the close: everything, and never an end of its own", () => {
    expect(feed({ kind: "close" }, ["abc", "def"])).toEqual({ data: "abcdef", used: [3, 3], done: false });
    expect(bodyReader({ kind: "close" }).closes).toBe(true);
    expect(feed({ kind: "none" }, ["abc"])).toEqual({ data: "", used: [0], done: true });
  });
});

describe("the heads the proxy writes", () => {
  test("an answer's head reads like a request's, strictly", () => {
    expect(parseAnswerHead("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n")).toEqual({
      status: 200,
      reason: "OK",
      headers: [["Content-Type", "text/plain"], ["Set-Cookie", "a=1"], ["Set-Cookie", "b=2"]],
    });
    expect(parseAnswerHead("HTTP/1.0 204\r\n\r\n")).toEqual({ status: 204, reason: "", headers: [] });
    for (const text of [
      "HTTP/1.1 200 OK\r\nX: a\nY: b\r\n\r\n",
      "HTTP/1.1 200 OK\r\n folded\r\n\r\n",
      "HTTP/1.1 20 OK\r\n\r\n",
      "HTTP/2 200 OK\r\n\r\n",
      "HTTP/1.1 200 OK\r\nX: a\u0000b\r\n\r\n",
      "HTTP/1.1 200 OK\r\nBad Name: a\r\n\r\n",
    ]) {
      expect(parseAnswerHead(text)).toBeNull();
    }
  });

  test("the app's head: the upstream's own, the hop's headers and the proxy's namespace removed, the framing kept", () => {
    const head = parseAnswerHead(
      "HTTP/1.1 200 OK\r\nConnection: keep-alive, x-hop\r\nKeep-Alive: timeout=5\r\nX-Hop: 1\r\nX-Sitesolide-Egress: refused\r\nContent-Encoding: gzip\r\nContent-Length: 12\r\nTransfer-Encoding: chunked\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n",
    )!;
    expect(downstreamHead(head, "chat")).toBe(
      "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nTransfer-Encoding: chunked\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nX-Sitesolide-Connector: chat\r\nConnection: close\r\n\r\n",
    );
    // A length alone stays, even named in Connection: the bytes still follow it.
    const sized = parseAnswerHead("HTTP/1.1 200 OK\r\nConnection: content-length\r\nContent-Length: 2\r\n\r\n")!;
    expect(downstreamHead(sized, "chat")).toContain("Content-Length: 2\r\n");
  });

  test("the upstream's head: the proxy's framing, the connection closed, the spelling asked for", () => {
    const headers = new Headers({ "x-request-id": "1", host: "chat.test-zone.invalid", authorization: "lent" });
    expect(upstreamHead("POST", "/api/x?y=1", headers, { kind: "chunked" }, ["Host", "Authorization"])).toBe(
      "POST /api/x?y=1 HTTP/1.1\r\nAuthorization: lent\r\nHost: chat.test-zone.invalid\r\nx-request-id: 1\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
    );
    expect(upstreamHead("PUT", "/", new Headers(), { kind: "length", length: 0 })).toBe("PUT / HTTP/1.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });

  test("an app that waits to be told before sending its body", () => {
    expect(expectsContinue(parseHead("PUT / HTTP/1.1\r\nExpect: 100-Continue\r\n\r\n")!)).toBe(true);
    expect(expectsContinue(parseHead("PUT / HTTP/1.1\r\n\r\n")!)).toBe(false);
  });
});
