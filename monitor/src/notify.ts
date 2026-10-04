/**
 * What leaves the machine, and in what words.
 *
 * Two channels, both optional, both configured in
 * /etc/sitesolide/dashboard-monitor.env from the dashboard's Secrets:
 *
 *   HEARTBEAT_URL      a dead man's switch, healthchecks.io style. Every run
 *                      pings it: the URL itself while the platform stands,
 *                      `<url>/fail` while the platform itself is down, the
 *                      body listing what is down in either case. It is the
 *                      only thing that notices the machine itself dying: the
 *                      outside service alerts when the pings stop, which no
 *                      check run on this machine ever could.
 *   ALERT_WEBHOOK_URL  one message per run that has something to say, down and
 *                      recovered alike, in a JSON body Slack and Discord
 *                      incoming webhooks both accept, or as plain text for
 *                      ntfy.
 *
 * Neither address is ever written anywhere else: not in the journal, not in
 * the status the dashboard reads, not in an error message. Whoever holds the
 * heartbeat's address can silence it, whoever holds the webhook's can post in
 * the channel.
 *
 * Only the platform fails the heartbeat: Caddy, a disk, the memory, the
 * monitor's own blindness, the bare domain and the dashboard. The outside
 * service sends one alert when a check goes down and none after: while the
 * heartbeat is held on `/fail`, the machine can die without anybody hearing of
 * it. What breaks the platform is fixed within the hour, or nothing else
 * matters; one project broken for a week, a certificate fourteen days from
 * expiry or a missed backup can stay unresolved for days, and holding the
 * heartbeat on `/fail` all that time would disarm the one thing that notices
 * the machine dying. They go to the webhook, the dashboard and the journal;
 * the heartbeat's body lists them all the same, where the outside service
 * keeps it.
 *
 * Pure, `deliver` aside, which only carries a request built here.
 */
import { ago } from "./checks";
import { isDown, type Notice, type Tracked } from "./alerts";

/** Discord refuses a message over 2000 characters; Slack takes far more. */
export const MAX_MESSAGE = 1900;

/** What the outside service keeps of a ping is plenty with that. */
export const MAX_HEARTBEAT_BODY = 2000;

export type WebhookFormat = "json" | "text";

export type Delivery = { ok: true } | { ok: false; reason: string };

/**
 * An alerting address, or why it is refused. http and https only: anything
 * else is a typo or a trap, and the reason never quotes the value, which is a
 * secret.
 */
export function alertUrl(name: string, raw: string | null | undefined): { url: string | null; problem: string | null } {
  const value = (raw ?? "").trim();
  if (value === "") return { url: null, problem: null };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { url: null, problem: `${name} is not a URL` };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { url: null, problem: `${name} must be an http or https URL` };
  }
  return { url: url.toString(), problem: null };
}

/**
 * `json` unless told otherwise, and `text` for ntfy.sh itself, whose topics take
 * the message as the raw body. A self-hosted ntfy says so with
 * `ALERT_WEBHOOK_FORMAT=text`.
 */
export function webhookFormat(raw: string | null | undefined, url: string | null): { format: WebhookFormat; problem: string | null } {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "json" || value === "text") return { format: value, problem: null };
  const fallback: WebhookFormat = url !== null && new URL(url).hostname === "ntfy.sh" ? "text" : "json";
  if (value === "") return { format: fallback, problem: null };
  return { format: fallback, problem: "ALERT_WEBHOOK_FORMAT must be json or text" };
}

/** A time a person reads anywhere: UTC, to the minute. */
export function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const WORDS: Record<Notice["event"], string> = { down: "DOWN", recovered: "RECOVERED", cleared: "NO LONGER CHECKED" };

/** One line per notice, the event first, then what was seen and since when. */
export function noticeLine(notice: Notice): string {
  const word = notice.event === "down" && notice.severity === "warning" ? "WARNING" : WORDS[notice.event];
  const when =
    notice.event === "down"
      ? `since ${utc(notice.since)}`
      : notice.event === "recovered"
        ? `after ${ago(Math.max(0, notice.at - notice.since))}`
        : `was down since ${utc(notice.since)}`;
  return `${word} ${notice.summary} (${when})`;
}

/**
 * The message of a run: a title naming the machine by its zone and counting,
 * then one line per notice, critical first. Cut at MAX_MESSAGE with a count of
 * what was left out, never in the middle of a line: a storm of a hundred sites
 * still makes one message, and that message still fits.
 */
export function message(notices: readonly Notice[], zone: string): string {
  const order = { down: 0, cleared: 1, recovered: 2 };
  const sorted = [...notices].sort(
    (a, b) =>
      order[a.event] - order[b.event] ||
      (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1) ||
      a.at - b.at ||
      a.id.localeCompare(b.id),
  );
  const down = notices.filter((notice) => notice.event === "down").length;
  const recovered = notices.filter((notice) => notice.event === "recovered").length;
  const cleared = notices.length - down - recovered;
  const counts = [
    down > 0 ? `${down} down` : null,
    recovered > 0 ? `${recovered} recovered` : null,
    cleared > 0 ? `${cleared} no longer checked` : null,
  ].filter((part): part is string => part !== null);
  const title = `sitesolide monitor, ${zone}: ${counts.join(", ")}`;

  const lines = [title];
  let length = title.length;
  for (const [index, notice] of sorted.entries()) {
    const line = noticeLine(notice);
    const left = sorted.length - index;
    const tail = `... and ${left} more, see the dashboard`;
    if (length + 1 + line.length + 1 + tail.length > MAX_MESSAGE && left > 1) {
      lines.push(tail);
      break;
    }
    lines.push(line);
    length += 1 + line.length;
  }
  return lines.join("\n");
}

/**
 * The webhook's request. The JSON body carries the message twice, `text` for
 * Slack, Mattermost and Google Chat, `content` for Discord, each ignoring the
 * other's field. The text body is ntfy's, with a title and a high priority
 * when something critical went down.
 */
export function webhookRequest(url: string, format: WebhookFormat, notices: readonly Notice[], zone: string): { url: string; init: RequestInit } {
  const text = message(notices, zone);
  if (format === "text") {
    const urgent = notices.some((notice) => notice.event === "down" && notice.severity === "critical");
    return {
      url,
      init: {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8", Title: `sitesolide monitor, ${zone}`, Priority: urgent ? "high" : "default" },
        body: text,
      },
    };
  }
  return {
    url,
    init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, content: text }) },
  };
}

/** The dashboard's directory, served at `dashboard.<zone>` like any project. */
export const DASHBOARD_SLUG = "dashboard";

/** The kinds that are the platform's whatever they name. */
const PLATFORM_KINDS: ReadonlySet<Tracked["kind"]> = new Set(["caddy", "disk", "memory", "monitor"]);

/**
 * Whether a check is the platform's rather than one project's: Caddy, a disk,
 * the memory, the monitor's own blindness, and two sites, the bare domain and
 * the dashboard, which every installation serves and from which the author
 * sees the rest. The memory and the monitor are warnings on the dashboard, yet
 * they fail the heartbeat: a machine out of memory is about to lose every
 * site, and a monitor that cannot read the machine cannot be trusted when it
 * says all is well.
 */
export function platformWide(tracked: Tracked, zone: string): boolean {
  if (PLATFORM_KINDS.has(tracked.kind)) return true;
  return tracked.kind === "site" && (tracked.label === zone || tracked.label === `${DASHBOARD_SLUG}.${zone}`);
}

/** Whether the heartbeat fails this run: something of the platform is down. */
export function heartbeatFails(checks: Readonly<Record<string, Tracked>>, zone: string): boolean {
  return Object.values(checks).some((tracked) => isDown(tracked) && platformWide(tracked, zone));
}

/**
 * The heartbeat's request: `<url>/fail` when something of the platform is
 * down, the URL itself otherwise, the body listing what is down in either
 * case, the platform's first: a project down a week long travels in the body
 * of a successful ping. The suffix goes on the path, before any query string.
 */
export function heartbeatRequest(url: string, checks: Readonly<Record<string, Tracked>>, zone: string): { url: string; init: RequestInit } {
  const failing = heartbeatFails(checks, zone);
  const target = new URL(url);
  if (failing) target.pathname = `${target.pathname.replace(/\/+$/, "")}/fail`;

  const rank = (tracked: Tracked): number => (platformWide(tracked, zone) ? 0 : 2) + (tracked.severity === "critical" ? 0 : 1);
  const down = Object.values(checks)
    .filter(isDown)
    .sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
  const total = Object.keys(checks).length;
  const head =
    down.length === 0
      ? `ok: ${total} checks pass`
      : failing
        ? `down: ${down.length} of ${total} checks`
        : `ok for the platform: ${down.length} of ${total} checks down, none of them platform-wide`;
  let body = head;
  for (const tracked of down) {
    const line = `\n${tracked.severity === "critical" ? "DOWN" : "WARNING"} ${tracked.summary}`;
    if (body.length + line.length > MAX_HEARTBEAT_BODY) break;
    body += line;
  }
  return { url: target.toString(), init: { method: "POST", headers: { "Content-Type": "text/plain; charset=utf-8" }, body } };
}

/**
 * The heartbeat's last word when a run fails before judging anything: `/fail`
 * and the reason, rather than silence. Silence would be noticed as well, but
 * only once the outside service's grace period runs out, and without a reason.
 */
export function crashRequest(url: string, reason: string): { url: string; init: RequestInit } {
  const target = new URL(url);
  target.pathname = `${target.pathname.replace(/\/+$/, "")}/fail`;
  const body = `the monitor failed: ${reason}`.slice(0, MAX_HEARTBEAT_BODY);
  return { url: target.toString(), init: { method: "POST", headers: { "Content-Type": "text/plain; charset=utf-8" }, body } };
}

/**
 * Sends a request, bounded in time, and says how it went without ever quoting
 * the address: a fetch error message carries the URL, so only its code or its
 * name is kept. Never throws.
 */
export async function deliver(
  request: { url: string; init: RequestInit },
  timeoutMs: number,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Delivery> {
  try {
    const response = await fetcher(request.url, { ...request.init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    if (response.status >= 200 && response.status < 300) return { ok: true };
    return { ok: false, reason: `HTTP ${response.status}` };
  } catch (error) {
    const { code, name } = error as { code?: unknown; name?: unknown };
    if (typeof code === "string" && code !== "") return { ok: false, reason: code };
    if (typeof name === "string" && name !== "" && name !== "Error") return { ok: false, reason: name };
    return { ok: false, reason: "request failed" };
  }
}
