import { describe, expect, test } from "bun:test";
import { signInPage, doorPage } from "../src/page";

/** The chunk of page between two markers, bounds included. */
function between(page: string, start: string, end: string): string {
  const i = page.indexOf(start);
  const j = page.indexOf(end, i);
  expect({ start, found: i !== -1 && j !== -1 }).toEqual({ start, found: true });
  return page.slice(i, j + end.length);
}

describe("the door page of the previews", () => {
  test("is enough on its own: no external resource", () => {
    // Every URL of the locked host is rewritten towards it, including those
    // of a stylesheet or an image: what it would ask of the server would come
    // back to it as HTML, and the page would be displayed bare. The icon in
    // `data:` and the inline CSS are precisely what spares it that.
    const page = doorPage();
    for (const external of ['href="http', 'src="http', "url(http", "<script src", "<link rel=\"stylesheet"]) {
      expect(page).not.toInclude(external);
    }
  });

  test("sends the code with a GET to the root, which the Caddy stanza compares", () => {
    const page = doorPage();
    expect(page).toInclude('<form method="get" action="/">');
    expect(page).toInclude('name="key"');
    expect(page).toInclude('pattern="[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}"');
    expect(page).toInclude("this.value = this.value.toUpperCase()");
  });
});

describe("the portal login page", () => {
  test("escapes the return path and the message, which come from the visitor", () => {
    const page = signInPage('/"><script>alert(1)</script>', "<b>");
    expect(page).not.toInclude("<script>");
    expect(page).not.toInclude("<b>");
    expect(page).toInclude("&quot;&gt;&lt;script&gt;");
  });

  test("posts to the portal, with the return and the expected field", () => {
    const page = signInPage("/list");
    expect(page).toInclude('action="/_portal/connexion"');
    expect(page).toInclude('name="retour" value="/list"');
    expect(page).toInclude('name="motdepasse"');
    expect(page).toInclude('autocomplete="current-password"');
  });

  test("the message is only displayed if there is one", () => {
    expect(signInPage("/")).not.toInclude('role="alert"');
    expect(signInPage("/", "Password refused.")).toInclude('role="alert">Password refused.</p>');
  });
});

describe("a single template for both", () => {
  test("same stylesheet, same icon, same brand", () => {
    const lockPage = doorPage();
    const signIn = signInPage("/");
    for (const [start, end] of [
      ["<style>", "</style>"],
      ['<link rel="icon"', ">"],
      ['<p class="brand">', "</p>"],
    ] as const) {
      expect(between(signIn, start, end)).toBe(between(lockPage, start, end));
    }
  });

  test("the brand is the one of test-zone.invalid: the three layer logo, then the name", () => {
    for (const page of [doorPage(), signInPage("/")]) {
      const brand = between(page, '<p class="brand">', "</p>");
      for (const layer of ["layer-bottom", "layer-middle", "layer-top"]) {
        expect(brand).toInclude(`fill="url(#${layer})"`);
      }
      expect(brand).toInclude('<svg viewBox="0 0 32 32" aria-hidden="true">');
      expect(brand).toInclude('<span><span class="site">site</span>solide</span>');
    }
  });

  test("no external resource: the door page would serve itself in a loop", () => {
    for (const page of [doorPage(), signInPage("/")]) {
      expect(page).not.toMatch(/\ssrc=/);
      expect(page).not.toMatch(/href="https?:/);
      expect(page).not.toInclude("@import");
      expect(page).toInclude('<link rel="icon" href="data:');
    }
  });
});
