/**
 * What the service decides, once the request is received.
 *
 * `server.ts` only wires these functions onto routes: everything that judges,
 * refuses or counts lives here, and receives its clock as a parameter rather
 * than reading it. That is what makes ingestion testable without waiting for
 * tomorrow, and the dashboard verifiable without a customer's database.
 */
import { deviceOf, isBot, languageOf, browserOf, systemOf } from "./agent";
import {
  MAX_DURATION_S,
  TIME_ZONE,
  RETENTION_MS,
  SALTS_KEPT,
  MAX_VIEWS,
  VIEWS_PER_MINUTE,
} from "./config";
import { attachDuration, recordView, purge, saltOfDay } from "./db";
import { siteOf } from "./hosts";
import { accept } from "./rate";
import { clientAddress, computeFingerprint, generateSalt } from "./fingerprint";
import { dayOf, minusDays } from "./day";
import { acknowledge } from "./responses";
import { campaignOf, sourceOf } from "./source";
import { readDuration, readView } from "./pageview";

/* --- ingestion ------------------------------------------------------------- */

/**
 * The body of a signal, read without trusting its declared type.
 *
 * The browser sends it as `text/plain`: that is what avoids the preflight
 * request `application/json` would trigger before **every** page view, that is
 * one more round trip on every measured site. The content is JSON despite the
 * label, and `JSON.parse` is the only judge.
 */
function jsonBody(received: string): unknown {
  try {
    return JSON.parse(received);
  } catch {
    return null;
  }
}

export type Context = {
  now: number;
  /** The visitor's address, as Caddy reports it. Never written. */
  ip: string;
  agent: string;
};

/**
 * A measurement signal: a page view on load, a duration on departure.
 *
 * **Every refusal answers like a success**, and that is deliberate. The browser
 * does not read that answer: `sendBeacon` does not hand it back to the script.
 * Nobody therefore has anything to learn from a 400, except someone trying to
 * guess the list of accepted hosts, which a distinct error code would give them
 * one host at a time.
 */
export function measure(raw: string, context: Context): Response {
  const body = jsonBody(raw);
  if (body === null || typeof body !== "object") return acknowledge();

  // The departure signal carries no host: that is what tells them apart, and it
  // is safer than a type field the sender could forget.
  if (!("h" in body)) {
    const parsed = readDuration(body);
    if (parsed.ok) {
      attachDuration(
        parsed.value.token,
        Math.min(parsed.value.seconds, MAX_DURATION_S),
        // The age bound: a token replayed months later must not be able to
        // lengthen an old page view. A tab left open longer than that has
        // exceeded the duration ceiling anyway.
        context.now - MAX_DURATION_S * 1000 * 2,
      );
    }
    return acknowledge();
  }

  const parsed = readView(body);
  if (!parsed.ok) return acknowledge();
  const view = parsed.value;

  // The allow list, dropped by the dashboard's collector: a host the machine
  // does not serve writes nothing. Without it, any page on the web could copy
  // the script and fill this database. See src/hosts.ts.
  const site = siteOf(view.host, context.now);
  if (site === null) return acknowledge();

  // Bots that run the script are rare, and almost all of them name themselves.
  // Counting them would inflate the dashboard with traffic nobody has read.
  if (isBot(context.agent)) return acknowledge();

  const day = dayOf(context.now, TIME_ZONE);
  const salt = saltOfDay(day, generateSalt);
  const visitor = computeFingerprint(salt, view.host, context.ip, context.agent);

  if (!accept(visitor, context.now, VIEWS_PER_MINUTE)) return acknowledge();

  recordView({
    viewedAt: context.now,
    site,
    host: view.host,
    day,
    path: view.path,
    visitor,
    token: view.token,
    source: sourceOf(view.referrer, view.utmSource, view.host),
    campaign: campaignOf(view.utmCampaign),
    language: languageOf(view.language),
    device: deviceOf(context.agent, view.width),
    browser: browserOf(context.agent),
    system: systemOf(context.agent),
  });

  return acknowledge();
}

/** The context of an ingestion request, extracted from the headers. */
export function contextOf(req: Request, fallbackIp: string, now: number): Context {
  return {
    now,
    ip: clientAddress(req.headers.get("x-forwarded-for"), fallbackIp),
    agent: req.headers.get("user-agent") ?? "",
  };
}

/* --- maintenance ----------------------------------------------------------- */

/**
 * The purge, launched by the service itself.
 *
 * It erases three things: page views that are too old, those beyond the
 * ceiling, and **the salts**, which are what makes the measurement anonymous.
 * That last erasure is not maintenance: it is the promise made to the visitors
 * of measured sites, and it holds only as long as this function runs.
 */
export function cleanUp(now: number) {
  return purge(
    now,
    RETENTION_MS,
    MAX_VIEWS,
    minusDays(dayOf(now, TIME_ZONE), SALTS_KEPT),
  );
}
