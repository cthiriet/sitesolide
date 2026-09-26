import { describe, expect, test } from "bun:test";
import { campaignOf, referrerHost, readableName, sourceOf } from "../src/source";
import { DIRECT, SOURCE_MAX } from "../src/schema";

describe("referrerHost", () => {
  test("returns the host of an ordinary URL", () => {
    expect(referrerHost("https://www.google.com/search?q=vineyard")).toBe("www.google.com");
  });

  test("returns null on what is not a URL", () => {
    // The referrer is written by the browser, but the body that carries it is
    // written by a page, so by anyone.
    expect(referrerHost("")).toBe(null);
    expect(referrerHost("not a url")).toBe(null);
    expect(referrerHost("//example.test")).toBe(null);
  });

  test("refuses a scheme that is not the web", () => {
    // `javascript:` and `data:` have no business in a dashboard, and less still
    // in a page that would display them.
    expect(referrerHost("javascript:alert(1)")).toBe(null);
    expect(referrerHost("data:text/html,<b>x</b>")).toBe(null);
    expect(referrerHost("file:///etc/passwd")).toBe(null);
  });
});

describe("readableName", () => {
  test("groups the domains of one same search engine", () => {
    // Otherwise google.fr and google.com would make two rows for one same
    // referrer.
    expect(readableName("www.google.fr")).toBe("Google");
    expect(readableName("google.com")).toBe("Google");
    expect(readableName("news.google.co.uk")).toBe("Google");
  });

  test("groups the short addresses of the social networks", () => {
    expect(readableName("lnkd.in")).toBe("LinkedIn");
    expect(readableName("t.co")).toBe("X");
    expect(readableName("youtu.be")).toBe("YouTube");
  });

  test("returns the host as is when it has no name, without its www", () => {
    // A local directory reads better under its domain than under an invented
    // label.
    expect(readableName("www.architects-directory.test")).toBe("architects-directory.test");
  });

  test("does not confuse a domain that contains another's name", () => {
    expect(readableName("google.com.example.test")).toBe("google.com.example.test");
    expect(readableName("notgoogle.test")).toBe("notgoogle.test");
  });
});

describe("sourceOf", () => {
  test("prefers utm_source to the referrer", () => {
    // It is the only referrer known for a newsletter or a QR code, where the
    // browser has no referrer to give.
    expect(sourceOf("https://www.google.com/", "newsletter", "vineyard.test")).toBe("newsletter");
  });

  test("treats a visit without a referrer as direct", () => {
    expect(sourceOf("", null, "vineyard.test")).toBe(DIRECT);
  });

  test("treats a visit coming from the site itself as direct", () => {
    // The visitor was already there: it is not a referrer.
    expect(sourceOf("https://vineyard.test/pricing", null, "vineyard.test")).toBe(DIRECT);
    expect(sourceOf("https://www.vineyard.test/pricing", null, "vineyard.test")).toBe(DIRECT);
  });

  test("names the referrer when it comes from elsewhere", () => {
    expect(sourceOf("https://www.google.fr/search?q=x", null, "vineyard.test")).toBe("Google");
  });

  test("bounds what a page can write into the column", () => {
    // utm_source comes from a URL, so from anyone: without a bound, the
    // schema's CHECK would refuse the row and the page view would be lost.
    const long = "x".repeat(SOURCE_MAX * 3);
    expect(sourceOf("", long, "vineyard.test")).toHaveLength(SOURCE_MAX);
  });

  test("ignores a utm_source that is empty or made of spaces", () => {
    expect(sourceOf("", "   ", "vineyard.test")).toBe(DIRECT);
    expect(sourceOf("", "", "vineyard.test")).toBe(DIRECT);
  });
});

describe("campaignOf", () => {
  test("returns null when there is none", () => {
    expect(campaignOf(null)).toBe(null);
    expect(campaignOf("  ")).toBe(null);
  });

  test("keeps the campaign, bounded", () => {
    expect(campaignOf(" autumn-brochure ")).toBe("autumn-brochure");
    expect(campaignOf("x".repeat(500))).toHaveLength(128);
  });
});
