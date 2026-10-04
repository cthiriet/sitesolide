import { afterAll, describe, expect, test } from "bun:test";
import type { Notice, Tracked } from "../src/alerts";
import {
  MAX_MESSAGE,
  alertUrl,
  crashRequest,
  deliver,
  heartbeatFails,
  heartbeatRequest,
  message,
  noticeLine,
  webhookFormat,
  webhookRequest,
} from "../src/notify";

const ZONE = "test-zone.invalid";
const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);
const MINUTE = 60_000;

function notice(event: Notice["event"], id: string, severity: Notice["severity"] = "critical", summary = `${id} answered 502`): Notice {
  return { event, id, kind: "site", label: id, severity, slug: null, summary, at: T0 + 5 * MINUTE, since: T0 };
}

function tracked(status: Tracked["status"], severity: Tracked["severity"], summary: string, label = summary): Tracked {
  return { kind: "site", label, severity, slug: null, status, streak: 0, since: T0, summary };
}

describe("the alerting addresses", () => {
  test("absent is silence, not a problem", () => {
    expect(alertUrl("HEARTBEAT_URL", undefined)).toEqual({ url: null, problem: null });
    expect(alertUrl("HEARTBEAT_URL", "  ")).toEqual({ url: null, problem: null });
  });

  test("a refused address is named by its variable, never quoted", () => {
    const secret = "hc-ping-token-that-must-not-leak";
    const notUrl = alertUrl("HEARTBEAT_URL", secret);
    expect(notUrl.url).toBeNull();
    expect(notUrl.problem).toBe("HEARTBEAT_URL is not a URL");
    const wrong = alertUrl("ALERT_WEBHOOK_URL", `ftp://${secret}.example/`);
    expect(wrong.problem).toBe("ALERT_WEBHOOK_URL must be an http or https URL");
    expect(JSON.stringify([notUrl, wrong])).not.toContain(secret);
  });

  test("an https address passes", () => {
    expect(alertUrl("HEARTBEAT_URL", " https://hc-ping.test-zone.invalid/0b1c ").url).toBe("https://hc-ping.test-zone.invalid/0b1c");
  });

  test("the webhook's format: recognized by the address, json for any other, or as told", () => {
    const detected = (url: string) => webhookFormat(undefined, url).format;
    expect(detected("https://hooks.slack.com/services/T000/B000/sample")).toBe("slack");
    expect(detected("https://discord.com/api/webhooks/1/sample")).toBe("discord");
    expect(detected("https://ptb.discord.com/api/webhooks/1/sample")).toBe("discord");
    expect(detected("https://discordapp.com/api/webhooks/1/sample")).toBe("discord");
    expect(detected("https://chat.googleapis.com/v1/spaces/AAAA/messages?key=k&token=t")).toBe("googlechat");
    expect(detected("https://ntfy.sh/sample-topic")).toBe("text");
    expect(detected("https://hooks.test-zone.invalid/services/x")).toBe("json");
    // A look-alike is not the service.
    expect(detected("https://discord.com.test-zone.invalid/x")).toBe("json");
    expect(webhookFormat(undefined, "https://hooks.test-zone.invalid/x")).toEqual({ format: "json", problem: null });

    expect(webhookFormat("text", "https://ntfy.test-zone.invalid/topic")).toEqual({ format: "text", problem: null });
    expect(webhookFormat("GoogleChat", "https://chat.test-zone.invalid/x")).toEqual({ format: "googlechat", problem: null });
    expect(webhookFormat("discord", "https://hooks.slack.com/services/x")).toEqual({ format: "discord", problem: null });
    expect(webhookFormat("JSON", "https://ntfy.sh/sample-topic")).toEqual({ format: "json", problem: null });
    expect(webhookFormat("xml", "https://hooks.slack.com/services/x")).toEqual({
      format: "slack",
      problem: "ALERT_WEBHOOK_FORMAT must be slack, discord, googlechat, text or json",
    });
  });
});

describe("the message", () => {
  test("a title naming the zone and counting, then one line per notice, critical down first", () => {
    const text = message(
      [
        notice("recovered", "disk:/", "critical", "/ is 72% full, 22.1 GB free"),
        notice("down", "certificate:*.test-zone.invalid", "warning", "The certificate for *.test-zone.invalid expires in 9 days, on 2026-10-13"),
        notice("down", "caddy", "critical", "Caddy is inactive (dead), result success"),
        notice("cleared", "site:old.test-zone.invalid", "critical", "https://old.test-zone.invalid/ answered 502"),
      ],
      ZONE,
    );
    expect(text.split("\n")).toEqual([
      "sitesolide monitor, test-zone.invalid: 2 down, 1 recovered, 1 no longer checked",
      "DOWN Caddy is inactive (dead), result success (since 2026-10-04 12:00 UTC)",
      "WARNING The certificate for *.test-zone.invalid expires in 9 days, on 2026-10-13 (since 2026-10-04 12:00 UTC)",
      "NO LONGER CHECKED https://old.test-zone.invalid/ answered 502 (was down since 2026-10-04 12:00 UTC)",
      "RECOVERED / is 72% full, 22.1 GB free (after 5 min)",
    ]);
  });

  test("a storm of a hundred sites is still one message that fits Discord", () => {
    const notices = Array.from({ length: 100 }, (_, index) => notice("down", `site:site-${String(index).padStart(3, "0")}.${ZONE}`));
    const text = message(notices, ZONE);
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE);
    expect(text.split("\n")[0]).toBe("sitesolide monitor, test-zone.invalid: 100 down");
    expect(text).toMatch(/\.\.\. and \d+ more, see the dashboard$/);
    expect(text).toContain("site-000");
  });

  test("a line says how long a recovery took", () => {
    expect(noticeLine({ ...notice("recovered", "caddy"), at: T0 + 3 * 60 * MINUTE })).toContain("(after 3 h)");
  });
});

describe("the webhook's request", () => {
  const notices = [notice("down", "caddy", "critical", "Caddy is inactive (dead), result success")];

  test("json, for any other service: the message as text and as content", () => {
    const { url, init } = webhookRequest("https://hooks.test-zone.invalid/x", "json", notices, ZONE);
    expect(url).toBe("https://hooks.test-zone.invalid/x");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init.body as string) as { text: string; content: string };
    expect(body.text).toBe(message(notices, ZONE));
    expect(body.content).toBe(body.text);
  });

  /** A summary carrying what each service reads as a mention or a markup. */
  const loud = [notice("down", "unit:shop.service", "critical", "shop.service <!channel> @everyone <@U0123> & <users/all> is failed (failed)")];

  test("Slack: text alone, with <, > and & escaped, so that nothing in a summary pings a channel", () => {
    const body = JSON.parse(webhookRequest("https://hooks.slack.com/services/x", "slack", loud, ZONE).init.body as string) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["text"]);
    expect(body.text).toContain("shop.service &lt;!channel&gt; @everyone &lt;@U0123&gt; &amp; &lt;users/all&gt; is failed");
    expect(body.text).not.toContain("<");
  });

  test("Discord: content alone, with every mention disabled", () => {
    const body = JSON.parse(webhookRequest("https://discord.com/api/webhooks/1/x", "discord", loud, ZONE).init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ content: message(loud, ZONE), allowed_mentions: { parse: [] } });
  });

  test("Google Chat: text alone, the only field it accepts", () => {
    const body = JSON.parse(webhookRequest("https://chat.googleapis.com/v1/spaces/A/messages", "googlechat", notices, ZONE).init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ text: message(notices, ZONE) });
  });

  test("text, for ntfy: the raw message, a title, a high priority when something critical went down", () => {
    const urgent = webhookRequest("https://ntfy.sh/sample-topic", "text", notices, ZONE).init;
    expect(urgent.body).toBe(message(notices, ZONE));
    expect(urgent.headers).toMatchObject({ Title: "sitesolide monitor, test-zone.invalid", Priority: "high" });
    const calm = webhookRequest("https://ntfy.sh/sample-topic", "text", [notice("recovered", "caddy")], ZONE).init;
    expect(calm.headers).toMatchObject({ Priority: "default" });
  });
});

describe("the heartbeat's request", () => {
  const url = "https://hc-ping.test-zone.invalid/5a7f";

  test("all clear: the URL itself, and how many checks passed", () => {
    const checks = {
      caddy: { ...tracked("ok", "critical", "Caddy is active (running)"), kind: "caddy" as const },
      memory: { ...tracked("failing", "warning", "x"), kind: "memory" as const },
    };
    const { url: target, init } = heartbeatRequest(url, checks, ZONE);
    expect(target).toBe(url);
    expect(init.body).toBe("ok: 2 checks pass");
    expect(heartbeatFails(checks, ZONE)).toBe(false);
  });

  test("the platform down: /fail, and everything that is down, the platform's first", () => {
    const checks = {
      "site:a": tracked("recovering", "critical", "https://a.test-zone.invalid/ answered 200"),
      caddy: { ...tracked("down", "critical", "Caddy is inactive (dead), result success"), kind: "caddy" as const },
      backup: { ...tracked("down", "warning", "The last backup run finished 30 h ago, more than 26 h"), kind: "backup" as const },
      memory: { ...tracked("ok", "warning", "40% of memory available"), kind: "memory" as const },
    };
    const { url: target, init } = heartbeatRequest(url, checks, ZONE);
    expect(target).toBe(`${url}/fail`);
    expect((init.body as string).split("\n")).toEqual([
      "down: 3 of 4 checks",
      "DOWN Caddy is inactive (dead), result success",
      "DOWN https://a.test-zone.invalid/ answered 200",
      "WARNING The last backup run finished 30 h ago, more than 26 h",
    ]);
  });

  test("each platform-wide check fails it: Caddy, a disk, the memory, the monitor's blindness, the bare domain, the dashboard", () => {
    const platform: Record<string, Tracked> = {
      caddy: { ...tracked("down", "critical", "Caddy is failed (failed)"), kind: "caddy" },
      "disk:/": { ...tracked("down", "critical", "/ is 93% full, 5.2 GB free"), kind: "disk" },
      memory: { ...tracked("down", "warning", "4% of memory available"), kind: "memory" },
      monitor: { ...tracked("down", "warning", "The monitor could not run fully: systemctl list-units: timed out"), kind: "monitor" },
      [`site:${ZONE}`]: tracked("down", "critical", `https://${ZONE}/ answered 502`, ZONE),
      [`site:dashboard.${ZONE}`]: tracked("down", "critical", `https://dashboard.${ZONE}/ answered 502`, `dashboard.${ZONE}`),
    };
    for (const [id, check] of Object.entries(platform)) {
      expect([id, heartbeatFails({ [id]: check }, ZONE)]).toEqual([id, true]);
      expect(heartbeatRequest(url, { [id]: check }, ZONE).url).toBe(`${url}/fail`);
    }
  });

  test("one project down, however long, never fails it: the dead man's switch must stay armed", () => {
    const checks = {
      [`site:shop.${ZONE}`]: { ...tracked("down", "critical", `https://shop.${ZONE}/ answered 502`, `shop.${ZONE}`), slug: "shop" },
      "unit:shop.service": { ...tracked("down", "critical", "shop.service is failed (failed)", "shop.service"), kind: "unit" as const, slug: "shop" },
      [`site:www.${ZONE}`]: tracked("ok", "critical", `https://www.${ZONE}/ answered 200`, `www.${ZONE}`),
      backup: { ...tracked("down", "warning", "The last backup run failed for shop, 2 h ago"), kind: "backup" as const },
    };
    expect(heartbeatFails(checks, ZONE)).toBe(false);
    const { url: target, init } = heartbeatRequest(url, checks, ZONE);
    expect(target).toBe(url);
    expect((init.body as string).split("\n")).toEqual([
      "ok for the platform: 3 of 4 checks down, none of them platform-wide",
      "DOWN shop.service is failed (failed)",
      `DOWN https://shop.${ZONE}/ answered 502`,
      "WARNING The last backup run failed for shop, 2 h ago",
    ]);
  });

  test("/fail goes on the path, before a query string, whatever the trailing slash", () => {
    const checks = { caddy: { ...tracked("down", "critical", "Caddy is failed (failed)"), kind: "caddy" as const } };
    expect(heartbeatRequest("https://hc.test-zone.invalid/ping/5a7f/?create=1", checks, ZONE).url).toBe(
      "https://hc.test-zone.invalid/ping/5a7f/fail?create=1",
    );
    expect(crashRequest("https://hc.test-zone.invalid/ping/5a7f", "ENOSPC").url).toBe("https://hc.test-zone.invalid/ping/5a7f/fail");
    expect(crashRequest("https://hc.test-zone.invalid/ping/5a7f", "ENOSPC").init.body).toBe("the monitor failed: ENOSPC");
  });
});

/**
 * The deliveries themselves, against a local server standing in for
 * healthchecks.io and for a Slack or Discord webhook: what arrives is what was
 * built, and an address never shows in what the monitor reports.
 */
describe("delivery", () => {
  const received: Array<{ path: string; type: string | null; body: string }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      "/ping/:check": {
        POST: async (req) => {
          received.push({ path: new URL(req.url).pathname, type: req.headers.get("content-type"), body: await req.text() });
          return new Response("OK");
        },
      },
      "/ping/:check/fail": {
        POST: async (req) => {
          received.push({ path: new URL(req.url).pathname, type: req.headers.get("content-type"), body: await req.text() });
          return new Response("OK");
        },
      },
      "/hooks/discord": {
        POST: async (req) => {
          received.push({ path: "/hooks/discord", type: req.headers.get("content-type"), body: await req.text() });
          return new Response(null, { status: 204 });
        },
      },
      "/broken": () => new Response("no", { status: 500 }),
      "/slow": async () => {
        await Bun.sleep(1000);
        return new Response("late");
      },
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  afterAll(() => server.stop(true));

  test("the heartbeat arrives on /fail with its body, the webhook as Discord's JSON", async () => {
    received.length = 0;
    const checks = { caddy: { ...tracked("down", "critical", "Caddy is inactive (dead), result success"), kind: "caddy" as const } };
    expect(await deliver(heartbeatRequest(`${base}/ping/5a7f`, checks, ZONE), 5000)).toEqual({ ok: true });
    const notices = [notice("down", "caddy", "critical", "Caddy is inactive (dead), result success")];
    expect(await deliver(webhookRequest(`${base}/hooks/discord`, "discord", notices, ZONE), 5000)).toEqual({ ok: true });

    expect(received.map((request) => request.path)).toEqual(["/ping/5a7f/fail", "/hooks/discord"]);
    expect(received[0]!.body).toBe("down: 1 of 1 checks\nDOWN Caddy is inactive (dead), result success");
    expect(received[1]!.type).toBe("application/json");
    expect(JSON.parse(received[1]!.body)).toEqual({ content: message(notices, ZONE), allowed_mentions: { parse: [] } });
  });

  test("a refusal, a closed port and a timeout are reasons, never the address", async () => {
    const secretPath = "/broken";
    const refused = await deliver({ url: `${base}${secretPath}`, init: { method: "POST", body: "x" } }, 5000);
    expect(refused).toEqual({ ok: false, reason: "HTTP 500" });

    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const closedUrl = `http://127.0.0.1:${closed.port}/ping/secret-token`;
    closed.stop(true);
    const unreachable = await deliver({ url: closedUrl, init: { method: "POST", body: "x" } }, 5000);
    expect(unreachable.ok).toBe(false);
    if (!unreachable.ok) {
      expect(unreachable.reason).not.toContain("secret-token");
      expect(unreachable.reason).not.toContain("127.0.0.1");
    }

    const late = await deliver({ url: `${base}/slow`, init: { method: "POST", body: "x" } }, 200);
    expect(late).toEqual({ ok: false, reason: "TimeoutError" });
  });
});
