import { describe, expect, test } from "bun:test";
import { localPortalAudit } from "../src/portal-audit";

/** The client the Activity page reads the portal's audit through. */

describe("the client towards the portal", () => {
  test("speaks the portal's audit route, the page in the query", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        seen.push(`${req.method} ${url.pathname}${url.search}`);
        return Response.json({ events: [] });
      },
    });
    try {
      const client = localPortalAudit(`http://127.0.0.1:${server.port}`);
      await client.audit(50, 7);
      await client.audit(100, null);
      expect(seen).toEqual(["GET /admin/audit?limit=50&before=7", "GET /admin/audit?limit=100"]);
    } finally {
      server.stop(true);
    }
  });
});
