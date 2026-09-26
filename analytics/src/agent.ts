/**
 * What is drawn from the user agent: a bot or not, a browser, an operating
 * system, a device family.
 *
 * **The agent itself never enters the database.** It serves to compute the
 * visitor's fingerprint, then these three labels, and it is forgotten: a
 * complete agent string is singular enough to designate a person on its own,
 * which three broad labels do not.
 *
 * The analysis is deliberately coarse. A recognition library knows a thousand
 * times more, at the price of a dependency to keep up to date in order to tell
 * apart variants no decision ever looks at: this dashboard answers "should the
 * mobile layout be looked after", not "which version of WebKit".
 *
 * Pure: returns labels, touches nothing.
 */
import { DEVICES, type Device } from "./schema";

/**
 * What gives a bot away.
 *
 * The filter does not do all the work, and does not have to: the measurement
 * starts from a script, and most bots never run it. What remains are those that
 * render the whole page, modern search engines and monitoring tools, which
 * their agent almost always names. A bot that really hid itself would get
 * through, and that is accepted: the aim is an accurate dashboard, not a
 * defence.
 */
const BOTS =
  /bot|crawl|spider|slurp|headless|phantom|puppeteer|playwright|selenium|lighthouse|pagespeed|preview|monitor|uptime|curl|wget|python-requests|axios|http-client|facebookexternalhit|whatsapp|telegram|discord|preview|scanner|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot|perplexity/i;

/**
 * An empty agent is one too.
 *
 * Every browser sends one; its absence signals a client that is not one, or one
 * that is trying not to be recognised. The empty string would moreover enter
 * the fingerprint like any other, and would collapse into a single visitor
 * everything presenting that way from one same address.
 */
export function isBot(agent: string): boolean {
  return agent.trim() === "" || BOTS.test(agent);
}

/**
 * The browser, recognised in an order that does not permute.
 *
 * Every browser lies about the previous ones in order to inherit their pages:
 * Edge's agent contains `Chrome`, Chrome's contains `Safari`, and almost all of
 * them contain `Mozilla`. The first pattern that matches wins, so the most
 * specific one comes first. Checked in tests/agent.test.ts against real
 * strings.
 */
const BROWSERS: readonly (readonly [string, RegExp])[] = [
  ["Edge", /\bEdg(?:e|A|iOS)?\//],
  ["Samsung Internet", /SamsungBrowser\//],
  ["Opera", /\bOPR\/|\bOpera\//],
  ["Firefox", /\bFxiOS\/|\bFirefox\//],
  ["Chrome", /\bCriOS\/|\bChrome\//],
  ["Safari", /\bSafari\//],
];

/** The label returned when nothing matches. */
export const UNKNOWN = "autre";

export function browserOf(agent: string): string {
  for (const [name, pattern] of BROWSERS) {
    if (pattern.test(agent)) return name;
  }
  return UNKNOWN;
}

/**
 * The operating system. `iPadOS` is not told apart from `iOS`: since 2019 an
 * iPad declares itself Macintosh, and separating them would mean guessing.
 */
const SYSTEMS: readonly (readonly [string, RegExp])[] = [
  ["Android", /\bAndroid\b/],
  ["iOS", /\b(?:iPhone|iPad|iPod)\b/],
  ["Windows", /\bWindows NT\b/],
  ["macOS", /\bMac OS X\b|\bMacintosh\b/],
  ["ChromeOS", /\bCrOS\b/],
  ["Linux", /\bLinux\b/],
];

export function systemOf(agent: string): string {
  for (const [name, pattern] of SYSTEMS) {
    if (pattern.test(agent)) return name;
  }
  return UNKNOWN;
}

/**
 * The width thresholds, in CSS pixels. They are Tailwind's, `md` and `lg`, and
 * that is deliberate: the dashboard serves to decide whether a layout needs
 * looking after, so it may as well count in the same bands as the ones where
 * that layout switches.
 */
export const MOBILE_THRESHOLD = 768;
export const TABLET_THRESHOLD = 1024;

/**
 * The device family, drawn from the screen width when it is given.
 *
 * **The width comes before the agent**, which disguises itself: an iPad has
 * declared itself Macintosh since 2019, a desktop browser in responsive mode
 * keeps its desktop agent. The width, for its part, comes from `screen.width`,
 * which the script reads on the device itself.
 *
 * The agent only serves as a fallback, for the duration signal that carries no
 * width and for a browser that would not return one.
 */
export function deviceOf(agent: string, width: number | null): Device {
  if (width !== null && width > 0) {
    if (width < MOBILE_THRESHOLD) return "mobile";
    if (width < TABLET_THRESHOLD) return "tablette";
    return "bureau";
  }

  // `Mobile` in an Android or iOS agent says phone; its absence, tablet. It is
  // the only distinction agents still carry honestly.
  if (/\bAndroid\b|\b(?:iPhone|iPod)\b/.test(agent)) {
    return /\bMobile\b/.test(agent) ? "mobile" : "tablette";
  }
  if (/\biPad\b/.test(agent)) return "tablette";
  return "bureau";
}

/**
 * The browser language, reduced to its primary code.
 *
 * `fr-FR`, `fr-CA` and `fr` all become `fr`. Keeping the regional variant would
 * scatter one same language over several rows of the dashboard without teaching
 * anything more, and would make each visitor a little more singular: it is the
 * only clue of origin this service keeps, so it may as well be broad.
 *
 * Returns null on anything that is not a language tag: the field comes from the
 * browser, but the body that carries it comes from a page.
 */
export function languageOf(raw: string | null): string | null {
  if (raw === null) return null;
  const match = /^([a-z]{2,3})(?:[-_]|$)/.exec(raw.trim().toLowerCase());
  return match?.[1] ?? null;
}

/** The label of a device family, for the dashboard. */
export const DEVICE_LABELS: Readonly<Record<Device, string>> = {
  mobile: "Mobile",
  tablette: "Tablet",
  bureau: "Desktop",
};

/** Safeguard: one label per family, no more and no less. */
export function hasEveryDeviceLabel(): boolean {
  return DEVICES.every((device) => DEVICE_LABELS[device] !== undefined);
}
