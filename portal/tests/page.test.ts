import { describe, expect, test } from "bun:test";
import { signInPage, signedOutPage, doorPage, portalPage, DOOR_PAGE_MARKER } from "../src/page";

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

  test("without a provider, exactly the page from before: no link, the password field focused", () => {
    const page = signInPage("/list");
    expect(page).not.toInclude("/_portal/oidc");
    expect(page).toInclude("Enter your password.");
    expect(page).toInclude("required autofocus>");
  });

  test("with a provider, a link to begin the flow above the password, the return kept", () => {
    const page = signInPage("/list?week=3", "", { providerName: "Google" });
    expect(page).toInclude('<a class="sso" href="/_portal/oidc?retour=%2Flist%3Fweek%3D3">Sign in with Google</a>');
    expect(page.indexOf('class="sso"')).toBeLessThan(page.indexOf('action="/_portal/connexion"'));
    expect(page).toInclude('name="motdepasse"');
    expect(page).not.toInclude("autofocus");
    expect(page).not.toInclude("account=choose");
  });

  test("another account is offered when the one signed in is not let in", () => {
    const page = signInPage("/", "Not shared.", { providerName: "Google", chooseAccount: true });
    expect(page).toInclude('href="/_portal/oidc?retour=%2F&amp;account=choose">Use another account</a>');
  });

  test("the provider's name is escaped, it comes from the configuration", () => {
    const page = signInPage("/", "", { providerName: "<b>Acme</b>" });
    expect(page).toInclude("Sign in with &lt;b&gt;Acme&lt;/b&gt;");
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
});

describe("the page a site's sign-out answers", () => {
  test("goes on to the portal's host on its own, and offers the link for a browser that does not", () => {
    const page = signedOutPage('https://portal.test-zone.invalid/oidc/signout?ticket=a.b&x="y');
    expect(page).toInclude('<meta http-equiv="refresh" content="0; url=https://portal.test-zone.invalid/oidc/signout?ticket=a.b&amp;x=&quot;y">');
    expect(page).toInclude('href="https://portal.test-zone.invalid/oidc/signout?ticket=a.b&amp;x=&quot;y"');
    expect(page).not.toInclude('"y"');
    // The door page shares the template and gains nothing from it.
    expect(doorPage("")).not.toInclude("http-equiv");
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

  test("the brand is the one of test-zone.invalid: the slotted block, then the name", () => {
    for (const page of [doorPage(""), signInPage("/")]) {
      const brand = between(page, '<p class="brand">', "</p>");
      expect(brand).toInclude('fill="url(#mark-fill)"');
      expect(brand).toInclude('<svg viewBox="0 0 32 32" aria-hidden="true">');
      expect(brand).toInclude('<span><span class="site">site</span>solide</span>');
    }
  });

  test("no external resource: the door page would serve itself in a loop", () => {
    for (const page of [doorPage(""), signInPage("/")]) {
      expect(page).not.toMatch(/\ssrc=/);
      expect(page).not.toMatch(/href="https?:/);
      expect(page).not.toInclude("@import");
      expect(page).toInclude('<link rel="icon" href="data:');
    }
  });
});
