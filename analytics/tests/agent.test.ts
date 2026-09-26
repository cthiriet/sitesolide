import { describe, expect, test } from "bun:test";
import {
  deviceOf,
  isBot,
  UNKNOWN,
  languageOf,
  hasEveryDeviceLabel,
  browserOf,
  systemOf,
} from "../src/agent";

/** Real strings, taken from browsers in service. */
const AGENTS = {
  chrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
  chromeIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1",
  tabletAndroid:
    "Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
} as const;

describe("browserOf", () => {
  /**
   * The order of recognition is the only thing that counts here: every browser
   * lies about the previous ones in order to inherit their pages. Edge says
   * Chrome, Chrome says Safari, all of them say Mozilla.
   */
  test("recognises Edge, which also declares itself Chrome and Safari", () => {
    expect(browserOf(AGENTS.edge)).toBe("Edge");
  });

  test("recognises Chrome, which also declares itself Safari", () => {
    expect(browserOf(AGENTS.chrome)).toBe("Chrome");
  });

  test("recognises Chrome on iOS, which calls itself CriOS", () => {
    expect(browserOf(AGENTS.chromeIos)).toBe("Chrome");
  });

  test("recognises Safari, which declares only itself", () => {
    expect(browserOf(AGENTS.safariMac)).toBe("Safari");
    expect(browserOf(AGENTS.safariIphone)).toBe("Safari");
  });

  test("recognises Firefox", () => {
    expect(browserOf(AGENTS.firefox)).toBe("Firefox");
  });

  test("returns a label rather than nothing on an unknown agent", () => {
    expect(browserOf("un-client-http/1.0")).toBe(UNKNOWN);
    expect(browserOf("")).toBe(UNKNOWN);
  });
});

describe("systemOf", () => {
  test("recognises the common operating systems", () => {
    expect(systemOf(AGENTS.chrome)).toBe("Windows");
    expect(systemOf(AGENTS.safariMac)).toBe("macOS");
    expect(systemOf(AGENTS.safariIphone)).toBe("iOS");
    expect(systemOf(AGENTS.chromeAndroid)).toBe("Android");
    expect(systemOf(AGENTS.firefox)).toBe("Linux");
  });

  test("places Android before Linux, which Android also contains", () => {
    // The Android agent carries "Linux": the order of the table is what
    // separates them, and reversing it would file every phone under Linux.
    expect(systemOf(AGENTS.chromeAndroid)).not.toBe("Linux");
  });

  test("returns a label rather than nothing on an unknown agent", () => {
    expect(systemOf("")).toBe(UNKNOWN);
  });
});

describe("deviceOf", () => {
  test("believes the screen width before the agent", () => {
    // A desktop browser in responsive mode keeps its desktop agent; it is the
    // width that tells the truth.
    expect(deviceOf(AGENTS.chrome, 390)).toBe("mobile");
    expect(deviceOf(AGENTS.chrome, 820)).toBe("tablette");
    expect(deviceOf(AGENTS.chrome, 1512)).toBe("bureau");
  });

  test("falls back on the agent when the width is missing", () => {
    // The duration signal carries none, and a browser may return none at all.
    expect(deviceOf(AGENTS.safariIphone, null)).toBe("mobile");
    expect(deviceOf(AGENTS.chromeAndroid, null)).toBe("mobile");
    expect(deviceOf(AGENTS.chrome, null)).toBe("bureau");
  });

  test("reads an Android tablet from the absence of \"Mobile\"", () => {
    // It is the only distinction agents still carry honestly.
    expect(deviceOf(AGENTS.tabletAndroid, null)).toBe("tablette");
  });

  test("ignores an absurd width rather than drawing a family from it", () => {
    expect(deviceOf(AGENTS.chrome, 0)).toBe("bureau");
    expect(deviceOf(AGENTS.safariIphone, -1)).toBe("mobile");
  });
});

describe("isBot", () => {
  test("recognises those that name themselves", () => {
    expect(isBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
    expect(isBot("Mozilla/5.0 (compatible; bingbot/2.0)")).toBe(true);
    expect(isBot("curl/8.4.0")).toBe(true);
    expect(isBot("Mozilla/5.0 ... HeadlessChrome/140.0.0.0 ...")).toBe(true);
    expect(isBot("Chrome-Lighthouse")).toBe(true);
  });

  test("treats an empty agent as a bot", () => {
    // Every browser sends one. Its absence signals a client that is not one,
    // and the empty string would enter the fingerprint like any other:
    // everything presenting that way from one same address would count for a
    // single visitor.
    expect(isBot("")).toBe(true);
    expect(isBot("   ")).toBe(true);
  });

  test("lets an ordinary browser through", () => {
    for (const agent of Object.values(AGENTS)) {
      expect(isBot(agent)).toBe(false);
    }
  });
});

describe("languageOf", () => {
  test("reduces a tag to its primary code", () => {
    // Keeping the regional variant would scatter one same language over several
    // rows of the dashboard, and would make each visitor a little more
    // singular.
    expect(languageOf("fr-FR")).toBe("fr");
    expect(languageOf("fr-CA")).toBe("fr");
    expect(languageOf("fr")).toBe("fr");
    expect(languageOf("pt-BR")).toBe("pt");
    expect(languageOf("zh-Hans-CN")).toBe("zh");
  });

  test("tolerates case, spaces and the underscore", () => {
    expect(languageOf("  DE-de  ")).toBe("de");
    expect(languageOf("fr_CA")).toBe("fr");
  });

  test("returns null on what is not a language tag", () => {
    // The field comes from the browser, but the body that carries it comes from
    // a page: anything at all can arrive here.
    for (const raw of [null, "", "123", "!", "f"]) {
      expect(languageOf(raw)).toBe(null);
    }
  });
});

test("every device family has its label", () => {
  // Otherwise the dashboard would display the raw column value for one of them,
  // in the middle of the two others translated.
  expect(hasEveryDeviceLabel()).toBe(true);
});
