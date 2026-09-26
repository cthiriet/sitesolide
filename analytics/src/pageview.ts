/**
 * What the browser sends, and what the service keeps of it.
 *
 * **Everything entering here is written by a web page**, so by anyone: the
 * measurement script is public, its format too, and nothing authenticates
 * ingestion. This file is the only place where the received body is believed,
 * and it believes it on nothing: every field is checked, bounded, or refused.
 *
 * Two signals, because the time spent is only known on departure:
 *
 * - the **page view**, sent when the page loads;
 * - the **duration**, sent when the page is hidden or left, which carries only
 *   the page view's token and a number of seconds.
 *
 * Pure: receives already deserialised JSON, returns a page view or a refusal.
 * Nothing that depends on the clock, the network or the database is read here.
 */
import { PATH_MAX, HOST_MAX } from "./schema";

/** Length of the token the browser draws to tie the duration to the view. */
export const TOKEN_MAX = 32;

/** What the browser sends on load, once checked. */
export type ReceivedView = {
  host: string;
  path: string;
  referrer: string;
  utmSource: string | null;
  utmCampaign: string | null;
  language: string | null;
  width: number | null;
  token: string;
};

/** What it sends on departure. */
export type ReceivedDuration = { token: string; seconds: number };

export type Parsed<T> = { ok: true; value: T } | { ok: false; pattern: string };

const refuse = (pattern: string): Parsed<never> => ({ ok: false, pattern });

/** A string, or null if the field is missing or is not one. */
function asString(raw: unknown): string | null {
  return typeof raw === "string" ? raw : null;
}

/**
 * A host in the shape of a domain name, in lower case.
 *
 * The same rule as `isValidDomain` of the platform's CLI: what passes there
 * must pass here, otherwise a deployable site would not be measurable. Any port
 * is stripped, a site served locally declaring itself `localhost:3000`.
 */
export function isValidHost(host: string): boolean {
  return (
    host.length > 0 &&
    host.length <= HOST_MAX &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)
  );
}

/**
 * The bytes a path cannot carry: ASCII controls and DEL.
 *
 * The body is JSON, which carries them perfectly in escaped form; they have no
 * business in a URL, and a row of the dashboard that contained some would cut
 * off its own display.
 */
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]");

/**
 * The path, reduced to its canonical form.
 *
 * The trailing slash falls, `/pricing` and `/pricing/` designating the same page
 * for whoever reads the dashboard; the root keeps it, otherwise it would become
 * empty. Nothing else is touched: case counts on a file server, and two paths
 * that differ only by it are two pages.
 */
export function normalizePath(raw: string): string | null {
  if (!raw.startsWith("/")) return null;
  if (CONTROL_CHARS.test(raw)) return null;

  const cut = raw.slice(0, PATH_MAX);
  const withoutSlash = cut.length > 1 ? cut.replace(/\/+$/, "") : cut;
  return withoutSlash === "" ? "/" : withoutSlash;
}

/** The token: what the browser drew, bounded to what the column accepts. */
function isValidToken(token: string): boolean {
  return token.length > 0 && token.length <= TOKEN_MAX && /^[A-Za-z0-9_-]+$/.test(token);
}

/**
 * The page view sent on load.
 *
 * Field names fit in one letter: this body leaves on every page view of every
 * site, often on a phone on a slow network, and full names would make it weigh
 * three times more without saying anything more.
 */
export function readView(body: unknown): Parsed<ReceivedView> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refuse("a JSON object is expected");
  }
  const raw = body as Record<string, unknown>;

  const host = asString(raw.h)?.toLowerCase().replace(/:\d+$/, "") ?? null;
  if (host === null || !isValidHost(host)) return refuse("h: host expected");

  const rawPath = asString(raw.p);
  if (rawPath === null) return refuse("p: path expected");
  const path = normalizePath(rawPath);
  if (path === null) return refuse("p: path expected, starting with /");

  const token = asString(raw.j);
  if (token === null || !isValidToken(token)) return refuse("j: token expected");

  // The width serves to classify the device. Missing or absurd, the agent takes
  // over: it is not a ground for refusal, the page view did take place.
  const rawWidth = raw.w;
  const width =
    typeof rawWidth === "number" && Number.isFinite(rawWidth) && rawWidth > 0
      ? Math.min(Math.round(rawWidth), 100_000)
      : null;

  return {
    ok: true,
    value: {
      host,
      path,
      referrer: asString(raw.r) ?? "",
      utmSource: asString(raw.s),
      utmCampaign: asString(raw.c),
      language: asString(raw.l),
      width,
      token,
    },
  };
}

/**
 * The duration sent on departure.
 *
 * The ceiling is not applied here but at write time, with `MAX_DURATION_S`: it is
 * a measurement policy, not a format rule, and the tests must be able to vary
 * it without touching the reading.
 */
export function readDuration(body: unknown): Parsed<ReceivedDuration> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return refuse("a JSON object is expected");
  }
  const raw = body as Record<string, unknown>;

  const token = asString(raw.j);
  if (token === null || !isValidToken(token)) return refuse("j: token expected");

  const seconds = raw.d;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    return refuse("d: a number of seconds expected");
  }

  return { ok: true, value: { token, seconds: Math.round(seconds) } };
}
