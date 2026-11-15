import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { signInPage, doorPage, portalPage, homePage, DOOR_PAGE_MARKER } from "../src/page";

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
    const page = doorPage("");
    for (const external of ['href="http', 'src="http', "url(http", "<script src", "<link rel=\"stylesheet"]) {
      expect(page).not.toInclude(external);
    }
  });

  test("names the contact address it is given, escaped, and none without one", () => {
    const page = doorPage('owner+"x"@test-zone.invalid');
    expect(page).toInclude("No code?");
    expect(page).toInclude("mailto:owner+&quot;x&quot;@test-zone.invalid?subject=Access%20code");
    expect(doorPage("")).not.toInclude("No code?");
  });

  test("carries the marker the gatekeeper recognises a generated page by", () => {
    expect(doorPage("")).toInclude(DOOR_PAGE_MARKER);
  });

  test("sends the code with a GET to the root, which the Caddy stanza compares", () => {
    const page = doorPage("");
    expect(page).toInclude('<form method="get" action="/">');
    expect(page).toInclude('name="key"');
    // Ten characters, and the six of a code drawn before, which still opens its site.
    expect(page).toInclude('pattern="[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}|[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}"');
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

  test("without a passkey, the password alone, its field focused", () => {
    const page = signInPage("/list");
    expect(page).not.toInclude("/_portal/oidc");
    expect(page).toInclude("Enter your password.");
    expect(page).toInclude("required autofocus>");
  });

  test("without a passkey offered, nothing of the passkey's layout", () => {
    const page = signInPage("/list");
    expect(page).not.toInclude("/_portal/passkey");
    expect(page).not.toInclude('class="glyph"');
    expect(page).not.toInclude("Were you given a password?");
  });

  test("with a passkey, its button leads the card and the password follows for guests", () => {
    const page = signInPage("/list?week=3", "", true);
    expect(page).toInclude("Sign in with your passkey, or enter the password you were given.");
    expect(page).toInclude('<a class="button" href="/_portal/passkey?retour=%2Flist%3Fweek%3D3"><svg class="glyph"');
    expect(page).toInclude("<span>Sign in with a passkey</span></a>");
    const passkeyAt = page.indexOf("/_portal/passkey");
    expect(passkeyAt).toBeLessThan(page.indexOf('<p class="or">'));
    expect(page.indexOf('<p class="or">')).toBeLessThan(page.indexOf('action="/_portal/connexion"'));
    // The same fields as ever, under a label that speaks to the guest.
    expect(page).toInclude('name="retour" value="/list?week=3"');
    expect(page).toInclude('<label for="motdepasse">Were you given a password?</label>');
    expect(page).toInclude('name="motdepasse"');
    // The owner's password opens nothing here: no focus to invite it.
    expect(page).not.toInclude("autofocus");
    // Never folded away: a guest needs no script and no click to find it.
    expect(page).not.toInclude("<details");
  });

  test("with a passkey, a password's message sits under its field, any other leads the card", () => {
    const refused = signInPage("/", "Password refused. The owner signs in with a passkey.", true, true);
    expect(refused).toInclude('<p class="alert" role="alert">Password refused. The owner signs in with a passkey.</p>');
    expect(refused.indexOf('role="alert"')).toBeGreaterThan(refused.indexOf('name="motdepasse"'));
    // The guest retypes: the field takes the focus back.
    expect(refused).toInclude("required autofocus>");
    const revoked = signInPage("/", "This passkey is no longer registered.", true);
    expect(revoked).toInclude('<p class="alert notice" role="alert">This passkey is no longer registered.</p>');
    expect(revoked.indexOf('role="alert"')).toBeLessThan(revoked.indexOf("/_portal/passkey"));
    expect(revoked).not.toInclude("autofocus");
    for (const page of [refused, revoked]) expect(page.split('role="alert"')).toHaveLength(2);
  });

});

describe("the pages of the portal's own host", () => {
  test("escape the title, the message and the way back", () => {
    const page = portalPage("<t>", "<m>", { href: 'https://kanban.test-zone.invalid/"x', label: "<l>" });
    for (const raw of ["<t>", "<m>", "<l>", '/"x']) expect(page).not.toInclude(raw);
    expect(page).toInclude('href="https://kanban.test-zone.invalid/&quot;x"');
  });

  test("without a way back, no link", () => {
    expect(portalPage("Expired.", "Sign in again.")).not.toInclude("<a ");
  });

  test("the root's page is the committed public/index.html, from the same template", async () => {
    // Caddy serves the file as it stands: a change of the template that did
    // not reach it would leave the portal's own host in the old design.
    const committed = await Bun.file(join(import.meta.dir, "..", "public", "index.html")).text();
    expect({ upToDate: committed === homePage(), fix: "bun run home-page" }).toEqual({ upToDate: true, fix: "bun run home-page" });
  });
});

describe("a single template for both", () => {
  test("same stylesheet, same icon, same brand", () => {
    const lockPage = doorPage("");
    const signIn = signInPage("/");
    for (const [start, end] of [
      ["<style>", "</style>"],
      ['<link rel="icon"', ">"],
      ['<p class="brand">', "</p>"],
    ] as const) {
      expect(between(signIn, start, end)).toBe(between(lockPage, start, end));
    }
  });

  test("the brand is the landing page's: the slotted block in its petrol gradient, then the name", () => {
    for (const page of [doorPage(""), signInPage("/"), homePage()]) {
      const brand = between(page, '<p class="brand">', "</p>");
      expect(brand).toInclude('<svg viewBox="0 0 32 32" aria-hidden="true">');
      expect(brand).toInclude('<stop offset="0" stop-color="#14899A" /><stop offset="1" stop-color="#0A5560" />');
      expect(brand).toInclude('fill="url(#mark)"');
      // Ledger draws no hard offset shadow and no outline around the mark.
      expect(brand).not.toInclude("translate(");
      expect(brand).not.toInclude("stroke");
      expect(brand).toInclude("<span>sitesolide</span>");
    }
  });

  test("light and dark from the browser's preference, and no face fetched", () => {
    const page = signInPage("/");
    expect(page).toInclude("@media (prefers-color-scheme: dark)");
    expect(page).toInclude('<meta name="color-scheme" content="light dark">');
    expect(page).not.toInclude("@font-face");
    expect(page).toInclude('"Hanken Grotesk", ui-sans-serif, system-ui');
  });

  test("no external resource: the door page would serve itself in a loop", () => {
    for (const page of [doorPage(""), signInPage("/"), homePage()]) {
      expect(page).not.toMatch(/\ssrc=/);
      expect(page).not.toMatch(/href="https?:/);
      expect(page).not.toInclude("@import");
      expect(page).toInclude('<link rel="icon" href="data:');
    }
  });
});
