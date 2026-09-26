/**
 * Where a visit comes from.
 *
 * Two signals, in this order: the `utm_*` parameters of the URL, which whoever
 * placed the link wrote themselves, then the referrer the browser passes on.
 * The first always wins, because it says an intention where the second says
 * only a path.
 *
 * **The referrer is kept only in the form of a host.** The full URL of a page
 * pointing to a site sometimes says a lot about its reader, an internal search
 * or a shared document; the host is enough to know where people come from.
 * `Referrer-Policy: strict-origin-when-cross-origin`, set by the Caddyfile on
 * every site of the machine, moreover means the browser already sends only the
 * origin.
 *
 * Pure: receives strings, returns a label.
 */
import { DIRECT, SOURCE_MAX, CAMPAIGN_MAX } from "./schema";

/**
 * The hosts that have a readable name.
 *
 * The list does not aim at completeness: it groups what would otherwise arrive
 * on several rows for one same referrer, `google.fr` and `google.com`,
 * `l.facebook.com` and `m.facebook.com`. Any absent host is returned as is,
 * which is already readable: a local directory reads better under its domain
 * than under an invented label.
 *
 * **Every pattern anchors on the end of the host, and leaves the top-level
 * domain only one or two labels without digits.** A wider pattern would take
 * `google.com.example.test` for Google: that is a name registered in five
 * minutes, and the dashboard would then credit the search engine with visits
 * bought elsewhere.
 */
const KNOWN: readonly (readonly [string, RegExp])[] = [
  ["Google", /(^|\.)google(\.[a-z]{2,}){1,2}$/],
  ["Bing", /(^|\.)bing\.com$/],
  ["DuckDuckGo", /(^|\.)duckduckgo\.com$/],
  ["Qwant", /(^|\.)qwant\.com$/],
  ["Ecosia", /(^|\.)ecosia\.org$/],
  ["Yahoo", /(^|\.)yahoo(\.[a-z]{2,}){1,2}$/],
  ["Brave", /(^|\.)search\.brave\.com$/],
  ["LinkedIn", /(^|\.)linkedin\.com$|(^|\.)lnkd\.in$/],
  ["Facebook", /(^|\.)facebook\.com$|(^|\.)fb\.me$/],
  ["Instagram", /(^|\.)instagram\.com$/],
  ["X", /(^|\.)(?:twitter|x)\.com$|(^|\.)t\.co$/],
  ["YouTube", /(^|\.)youtube\.com$|(^|\.)youtu\.be$/],
  ["Reddit", /(^|\.)reddit\.com$/],
  ["ChatGPT", /(^|\.)chatgpt\.com$|(^|\.)openai\.com$/],
  ["Perplexity", /(^|\.)perplexity\.ai$/],
  ["Claude", /(^|\.)claude\.ai$/],
  ["Malt", /(^|\.)malt(\.[a-z]{2,}){1,2}$/],
  ["Upwork", /(^|\.)upwork\.com$/],
  ["Pages Jaunes", /(^|\.)pagesjaunes\.fr$/],
  ["Gmail", /(^|\.)mail\.google\.com$/],
];

/** The readable name of a host, or the host without its `www.`. */
export function readableName(host: string): string {
  const clean = host.toLowerCase().replace(/^www\./, "");
  for (const [name, pattern] of KNOWN) {
    if (pattern.test(clean)) return name;
  }
  return clean;
}

/**
 * The host of a referrer, or null.
 *
 * Anything that is not a valid http(s) URL returns null: a referrer is written
 * by the browser, but the body that carries it this far is written by a page,
 * so by anyone.
 */
export function referrerHost(referrer: string): string | null {
  if (referrer === "") return null;
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.hostname === "" ? null : url.hostname.toLowerCase();
}

/** Truncates, and never returns an empty string where the schema refuses one. */
function truncate(value: string, maximum: number): string {
  return value.slice(0, maximum);
}

/**
 * The source of a page view.
 *
 * `utm_source` first: it is the only referrer known for a newsletter or a QR
 * code, where the browser has no referrer to give. The referrer next. A
 * referrer from the site itself is not a source: the visitor was already there,
 * and a visit resuming after half an hour of inactivity counts as direct rather
 * than as coming from itself.
 */
export function sourceOf(
  referrer: string,
  utmSource: string | null,
  siteHost: string,
): string {
  if (utmSource !== null && utmSource.trim() !== "") {
    return truncate(utmSource.trim(), SOURCE_MAX);
  }

  const host = referrerHost(referrer);
  if (host === null) return DIRECT;
  if (host === siteHost.toLowerCase() || host === `www.${siteHost.toLowerCase()}`) {
    return DIRECT;
  }

  return truncate(readableName(host), SOURCE_MAX);
}

/** The campaign, when the URL carried one. */
export function campaignOf(utmCampaign: string | null): string | null {
  if (utmCampaign === null) return null;
  const clean = utmCampaign.trim();
  return clean === "" ? null : truncate(clean, CAMPAIGN_MAX);
}
