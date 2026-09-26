import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The script placed on measured sites, read back as text.
 *
 * It does not run here: there is no `document` in Bun, and mounting it in a
 * fake browser would test that fake browser. What can be checked, on the other
 * hand, is what it does not contain, and that is what counts: every line of
 * this file holds a promise made to the visitors of measured sites, the one
 * that exempts them from a consent banner.
 */
const SCRIPT = readFileSync(join(import.meta.dir, "..", "public", "a.js"), "utf8");

describe("what the script does not do", () => {
  test("sets neither cookie nor storage in the browser", () => {
    // That is the promise: nothing is written on the visitor's side, so nothing
    // to consent to. The identity is recomputed server side on every page view.
    expect(SCRIPT).not.toMatch(/document\.cookie/);
    expect(SCRIPT).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });

  test("does not send the page's query string", () => {
    // It sometimes carries a reset token or an email address. Only the two
    // parameters that say a referrer are drawn from it, by name.
    expect(SCRIPT).toContain("location.pathname");
    expect(SCRIPT).not.toMatch(/p:\s*location\.href/);
    expect(SCRIPT).toContain('params.get("utm_source")');
    expect(SCRIPT).toContain('params.get("utm_campaign")');
  });

  test("does not measure a page embedded in an iframe", () => {
    // A site displayed in a dashboard preview or in a third party's page is not
    // being read by someone who came to see it, and an iframe reloaded in a
    // loop would count as many visits as it has refreshes.
    expect(SCRIPT).toContain("window.self !== window.top");
  });

  test("does not measure from a development workstation", () => {
    expect(SCRIPT).toContain("localhost");
    expect(SCRIPT).toContain("file:");
  });
});

describe("what it honours", () => {
  test("the two refusals to be tracked that browsers carry", () => {
    // Honouring them costs a few percent of measurement; not honouring them
    // would cost the sentence that tells a customer this service respects their
    // visitors.
    expect(SCRIPT).toContain("doNotTrack");
    expect(SCRIPT).toContain("globalPrivacyControl");
  });

  test("never interrupts the page it measures", () => {
    // An error here would land on customer sites.
    expect(SCRIPT.match(/try\s*{/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("what it sends", () => {
  test("derives the address from its own tag", () => {
    // The service can thus move without any measured site having to be
    // modified: it is the script's address that decides.
    expect(SCRIPT).toContain('new URL("e", script.src)');
  });

  test("leaves by sendBeacon, with a fallback that survives the page's departure", () => {
    expect(SCRIPT).toContain("nav.sendBeacon");
    expect(SCRIPT).toContain("keepalive: true");
  });

  test("labels the body as text/plain, which avoids a round trip", () => {
    // `application/json` would trigger a preflight request before every page
    // view of every measured site.
    expect(SCRIPT).toContain('type: "text/plain"');
  });

  test("sends the browser language, of which the service keeps only the code", () => {
    // It is the measurement's only clue of origin, and it asks for no
    // geolocation database.
    expect(SCRIPT).toContain("l: nav.language");
  });

  test("counts the time over visible periods only", () => {
    // A tab open in the background is not being read: counting it would skew
    // every average.
    expect(SCRIPT).toContain("visibilitychange");
    expect(SCRIPT).toContain("pagehide");
  });

  test("fits within what a showcase site can afford", () => {
    // Comments included, before compression by Caddy. The day this file went
    // past them, it would mean it had taken on one function too many.
    expect(SCRIPT.length).toBeLessThan(6000);
  });
});
