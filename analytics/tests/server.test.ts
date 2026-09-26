import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BODY_MAX, DATA_DIR, PORT } from "../src/config";
import { startServer, type StartedServer } from "./server-started";

/**
 * What `server.ts` declares to `Bun.serve`, read back as text, then tested on a
 * server launched separately, on a randomly drawn port.
 */
const ROOT = join(import.meta.dir, "..");
const SERVER = readFileSync(join(ROOT, "server.ts"), "utf8");
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "sitesolide.json"), "utf8")) as {
  port: number;
};

describe("the listening", () => {
  test("the service listens only on the loopback", () => {
    // Without `hostname`, Bun listens on 0.0.0.0: the port would be offered to
    // anything that reaches the machine, and the visitor's address would no
    // longer be the one Caddy reports.
    expect(SERVER).toContain('hostname: "127.0.0.1"');
  });

  test("the manifest's port is the configuration's", () => {
    expect(MANIFEST.port).toBe(PORT);
  });

  test("a request's body is bounded by Bun itself", () => {
    // The ceiling is applied before the body is read in full: without it, a
    // malicious page would grow the service's memory until systemd killed it,
    // and every site would stop being measured.
    expect(SERVER).toContain("maxRequestBodySize: BODY_MAX");
  });
});

describe("the service running", () => {
  let server: StartedServer;

  beforeAll(async () => {
    server = await startServer("server");
  });

  afterAll(() => server.stop());

  const post = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${server.db}/e`, { method: "POST", body: body, headers: headers });

  test("accepts a measurement signal and answers nothing", async () => {
    const response = await post('{"h":"unknown.example","p":"/","j":"abc"}');
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("sets no origin header on ingestion", async () => {
    // The browser never reads this response: `sendBeacon` does not hand it back
    // to the script. An `Access-Control-Allow-Origin: *` would let any page
    // read what this service answers, without serving anyone.
    const response = await post('{"h":"unknown.example","p":"/","j":"abc"}');
    expect(response.headers.get("access-control-allow-origin")).toBe(null);
  });

  test("sets no cookie, ever", async () => {
    // It is what exempts measured sites from a consent banner.
    const response = await post('{"h":"unknown.example","p":"/","j":"abc"}');
    expect(response.headers.get("set-cookie")).toBe(null);

    const dashboard = await fetch(`${server.db}/`);
    expect(dashboard.headers.get("set-cookie")).toBe(null);
  });

  test("refuses an outsized body before reading it", async () => {
    const response = await post("x".repeat(BODY_MAX * 2));
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  test("serves nothing on a method the route does not carry", async () => {
    // Bun lets the undeclared verb fall onto the fallback, which looks for a
    // file in public/ and finds none: a 404 rather than a 405. That suits
    // ingestion, which has nothing to confirm of its existence to whoever
    // probes it, and the dashboard's form is reachable by POST only.
    expect((await fetch(`${server.db}/e`)).status).toBe(404);
    expect((await fetch(`${server.db}/sites`)).status).toBe(404);
  });

  test("refuses a write method on the fallback", async () => {
    const response = await fetch(`${server.db}/a.js`, { method: "DELETE" });
    expect(response.status).toBe(405);
  });

  test("serves no page", async () => {
    // The numbers are read in the dashboard. This service has only one file
    // left to return, the script, and one route to receive on.
    expect((await fetch(`${server.db}/`)).status).toBe(404);
    expect((await fetch(`${server.db}/site/vineyard`)).status).toBe(404);
  });

  test("serves the measurement script from public/", async () => {
    const response = await fetch(`${server.db}/a.js`);
    expect(response.status).toBe(200);
    // It is kept in cache and revalidated: a script frozen for an hour would
    // take an hour to correct itself on every site at once.
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toContain("sendBeacon");
  });

  test("refuses a climb up out of public/", async () => {
    const response = await fetch(`${server.db}/../src/db.ts`);
    expect(response.status).toBe(404);
  });

  test("drops its snapshot for the dashboard", async () => {
    // The collector comes to fetch it every minute as root: if it is not
    // written at startup, the dashboard stays empty one minute longer on every
    // restart of the service.
    const path = join(DATA_DIR, "server", "instantane.json");
    expect(await Bun.file(path).exists()).toBe(true);

    const snapshot = JSON.parse(await Bun.file(path).text()) as { days: number };
    expect(snapshot.days).toBeGreaterThan(0);
  });
});
