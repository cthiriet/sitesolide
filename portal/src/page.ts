/**
 * The page that closes a site, in its two uses: the portal's login, rendered
 * here on every 401, and the door page of locked previews, which
 * `scripts/lock-page.ts` writes just before bin/lock.sh drops it.
 *
 * A single template for both, and a test that refuses any gap between the
 * committed file and this rendering: whoever lands on a closed site sees the
 * same card, whether they were given a code or a password.
 *
 * ## Hand written CSS, and it is the repository's Tailwind exception
 *
 * The door page is served for EVERY URL of the locked host, rewritten towards
 * it by the Caddy stanza. It must therefore be enough on its own: inline CSS,
 * icon in `data:`, no external stylesheet, font or image, otherwise its own
 * resources would serve themselves in a loop. The portal's page shares this
 * template and inherits from it, its CSP authorizing nothing else anyway.
 *
 * Pure: renders text. Everything coming from the visitor is escaped.
 */
import { CONTACT } from "./config";


/**
 * The portal's icon, in `data:` so as to ask nothing of the server: the
 * dashboard's favicon, the logo's light gradient, or its dark one when the
 * browser is dark.
 */
const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cstyle%3E.a%7Bstop-color:%23138896%7D.b%7Bstop-color:%230a5560%7D@media (prefers-color-scheme:dark)%7B.a%7Bstop-color:%235cc8d3%7D.b%7Bstop-color:%232c98a4%7D%7D%3C/style%3E%3Cdefs%3E%3ClinearGradient id='f' x1='1' y1='1' x2='31' y2='31' gradientUnits='userSpaceOnUse'%3E%3Cstop offset='0' class='a'/%3E%3Cstop offset='1' class='b'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M7.32 1H24.68A6.32 6.32 0 0 1 31 7.32V9.92H11.11A1.42 1.42 0 0 0 11.11 12.76H31V24.68A6.32 6.32 0 0 1 24.68 31H7.32A6.32 6.32 0 0 1 1 24.68V22.08H20.89A1.42 1.42 0 0 0 20.89 19.24H1V7.32A6.32 6.32 0 0 1 7.32 1Z' fill='url(%23f)'/%3E%3C/svg%3E";

/**
 * The logo of the portal and of the dashboard: a solid block with two slits
 * cut in from opposite sides, the S of sitesolide. Inline rather than as a
 * file, for the same reason as the rest of the page. Its gradient is the
 * dashboard's light one, the brand's petrol around the accent. The gradient
 * identifier is global to the document, and there is only one logo per page.
 */
const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true">
        <defs>
          <linearGradient id="mark-fill" x1="3" y1="3" x2="29" y2="29" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#138896" />
            <stop offset="1" stop-color="#0a5560" />
          </linearGradient>
        </defs>
        <path d="M8.47 3H23.53A5.47 5.47 0 0 1 29 8.47V10.73H11.76A1.23 1.23 0 0 0 11.76 13.19H29V23.53A5.47 5.47 0 0 1 23.53 29H8.47A5.47 5.47 0 0 1 3 23.53V21.27H20.24A1.23 1.23 0 0 0 20.24 18.81H3V8.47A5.47 5.47 0 0 1 8.47 3Z" fill="url(#mark-fill)" />
      </svg>`;

/**
 * The dashboard's light palette, from web/src/styles/global.css: graphite
 * neutrals, petrol for the primary action and the focus ring, red for an error
 * and nothing else. The font is the dashboard's fallback stack: the CSP
 * (`default-src 'none'`) loads no font, and the door page asks nothing of the
 * server anyway.
 */
const STYLE = `
    :root {
      --ink: #16181d;
      --ink-70: #3a404a;
      --ink-45: #5f6672;
      --glass: #f7f8fa;
      --surface: #ffffff;
      --line: #e3e6eb;
      --field: #d9dde3;
      --accent: #0b6e79;
      --accent-deep: #0a5560;
      --destructive: #b3253f;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: clamp(20px, 5vw, 48px);
      background: var(--glass);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, sans-serif;
      font-size: 1rem;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }

    main {
      width: 100%;
      max-width: 30rem;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 5px;
      padding: clamp(28px, 6vw, 44px);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      font-size: 0.9375rem;
      letter-spacing: -0.01em;
      color: var(--ink);
    }

    .brand svg {
      width: 21px;
      height: 21px;
      flex: none;
    }

    .brand .site { color: var(--ink-45); }

    h1 {
      margin: 10px 0 0;
      font-size: clamp(1.5rem, 4.4vw, 1.875rem);
      line-height: 1.15;
      letter-spacing: -0.025em;
      font-weight: 600;
    }

    p { margin: 14px 0 0; color: var(--ink-70); }

    form { margin-top: 26px; }

    label {
      display: block;
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--ink);
    }

    input {
      display: block;
      width: 100%;
      margin-top: 8px;
      padding: 13px 14px;
      font: inherit;
      font-size: 1.125rem;
      color: var(--ink);
      background: var(--surface);
      border: 1px solid var(--field);
      border-radius: 5px;
    }

    input.code { letter-spacing: 0.22em; }

    input:hover { border-color: var(--ink-70); }

    input:focus-visible,
    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .alert { margin-top: 10px; font-size: 0.875rem; color: var(--destructive); }

    button {
      margin-top: 14px;
      width: 100%;
      padding: 13px 22px;
      font: inherit;
      font-size: 0.9375rem;
      font-weight: 500;
      color: var(--surface);
      background: var(--accent);
      border: 1px solid transparent;
      border-radius: 5px;
      cursor: pointer;
    }

    button:hover { background: var(--accent-deep); }

    a.sso {
      display: block;
      margin-top: 26px;
      padding: 13px 22px;
      font-size: 0.9375rem;
      font-weight: 500;
      text-align: center;
      text-decoration: none;
      color: var(--surface);
      background: var(--accent);
      border-radius: 5px;
    }

    a.sso:hover { background: var(--accent-deep); }

    a.sso:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .or {
      margin-top: 22px;
      font-size: 0.875rem;
      color: var(--ink-45);
      text-align: center;
    }

    .or + form { margin-top: 6px; }

    .or + form button {
      color: var(--ink);
      background: var(--surface);
      border-color: var(--field);
    }

    .or + form button:hover { border-color: var(--ink-70); background: var(--surface); }

    .help {
      margin-top: 22px;
      padding-top: 18px;
      border-top: 1px solid var(--line);
      font-size: 0.875rem;
    }

    a { color: var(--ink); }
  `;

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type Template = {
  /** Already HTML: each caller escapes what comes from the visitor. */
  title: string;
  text: string;
  form: string;
  footer?: string;
  /** An HTML comment at the top, for the file written to disk. */
  comment?: string;
  /** Where the page sends the browser on its own, already escaped. */
  refresh?: string;
};

function template({ title, text, form, footer = "", comment = "", refresh = "" }: Template): string {
  const tabTitle = title.replace(/\.$/, "");
  return `<!doctype html>
<html lang="en">

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">${refresh === "" ? "" : `\n  <meta http-equiv="refresh" content="0; url=${refresh}">`}
  <title>${tabTitle}</title>${comment === "" ? "" : `\n  <!--\n${comment}\n  -->`}
  <meta name="theme-color" content="#f7f8fa">
  <link rel="icon" href="${ICON}">
  <style>${STYLE}</style>
</head>

<body>
  <main>
    <p class="brand">
      ${LOGO}
      <span><span class="site">site</span>solide</span>
    </p>
    <h1>${title}</h1>
    <p>${text}</p>
${form}${footer === "" ? "" : `\n${footer}`}
  </main>
</body>

</html>
`;
}

/**
 * The portal's login, rendered in the body of the 401 itself: no redirect,
 * because `sitesolide deploy` and `deploy-caddy.sh` only accept 200 and 401,
 * and the second restores the old configuration on the first other code.
 *
 * The host name no longer appears in it: the address bar already shows it, and
 * the page of a closed site has no business saying more than the lock's one.
 */
export function signInPage(returnTo: string, message = "", sso: SsoOffer | null = null): string {
  const alertHtml = message === "" ? "" : `\n      <p class="alert" role="alert">${escapeHtml(message)}</p>`;
  const passwordForm = `    <form method="post" action="/_portal/connexion">
      <input type="hidden" name="retour" value="${escapeHtml(returnTo)}">
      <label for="motdepasse">Password</label>
      <input id="motdepasse" name="motdepasse" type="password" autocomplete="current-password" required${sso === null ? " autofocus" : ""}>${alertHtml}
      <button type="submit">Enter</button>
    </form>`;
  if (sso === null) {
    return template({ title: "This site is private.", text: "Enter your password.", form: passwordForm });
  }

  // A link and not a form: the flow leaves for the portal's own host, which
  // the CSP's `form-action 'self'` would refuse to a form's redirect. What the
  // link starts changes nothing on its own, see src/sso.ts.
  const begin = (choose: boolean) =>
    escapeHtml(`/_portal/oidc?${new URLSearchParams({ retour: returnTo, ...(choose ? { account: "choose" } : {}) })}`);
  const another = sso.chooseAccount
    ? `\n    <p class="or"><a href="${begin(true)}">Use another account</a></p>`
    : "";
  return template({
    title: "This site is private.",
    text: "Sign in with your company account, or enter a password.",
    form: `    <a class="sso" href="${begin(false)}">Sign in with ${escapeHtml(sso.providerName)}</a>${another}
    <p class="or">or</p>
${passwordForm}`,
  });
}

/** The provider the sign-in page offers, and whether to offer choosing another account. */
export type SsoOffer = { providerName: string; chooseAccount?: boolean };

/**
 * A page of the portal's own host, where a sign-in with the provider passes:
 * what went wrong, and the way back to the site when the portal knows it.
 * Everything in it is escaped, the message included.
 */
export function portalPage(title: string, message: string, back: { href: string; label: string } | null = null): string {
  return template({
    title: escapeHtml(title),
    text: escapeHtml(message),
    form: back === null ? "" : `    <a class="sso" href="${escapeHtml(back.href)}">${escapeHtml(back.label)}</a>`,
  });
}

/**
 * What a site's sign-out answers once the portal knows a provider: signed out
 * of the site, on the way to the portal's host to end its session too. The
 * browser goes on its own, and the link is there for one that does not follow
 * a refresh. `next` is the portal's address, escaped here.
 */
export function signedOutPage(next: string): string {
  const href = escapeHtml(next);
  return template({
    title: "Signed out.",
    text: "You&#39;re signed out of this site. The next sign-in on this device will ask which account to use.",
    form: `    <a class="sso" href="${href}">Continue</a>`,
    refresh: href,
  });
}

/**
 * The door page of the previews. The word "preversion" does not appear in it,
 * and that is deliberate: nobody outside the trade knows it. Whoever lands
 * here is most often a craftsman coming to look at their site.
 *
 * Caddy compares the key character for character: a code typed in lowercase
 * would give a 401 with no explanation. The pattern therefore accepts only the
 * exact alphabet, and the field is put back in uppercase while typing through
 * `oninput`, never through a `text-transform`, which only changes the display
 * and let `abc234` go out from a field that showed `ABC234`. Without
 * JavaScript, the browser refuses the input itself, with the `title` message.
 */
export function doorPage(): string {
  return template({
    comment: [
      "    Guard page of locked previews, generated by",
      "    portal/scripts/lock-page.ts from portal/src/page.ts. Do not edit:",
      "    portal/tests/page.test.ts refuses any gap with the template, which is",
      "    also the one of the portal's login.",
      "",
      "    Dropped by bin/lock.sh into /srv/garde/<slug>/index.html, and served",
      "    with a 401 for every URL of the locked host: it must stay self",
      "    contained.",
    ].join("\n"),
    title: "This site is not public yet.",
    text: "Enter the code you were given.",
    form: `    <form method="get" action="/">
      <label for="key">Access code</label>
      <input id="key" class="code" name="key" type="text" inputmode="text" autocapitalize="characters" autocomplete="off"
        autocorrect="off" spellcheck="false" maxlength="6" minlength="6" size="6"
        pattern="[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}" required
        title="Six characters, without O, I, 0 or 1." placeholder="ABC234" autofocus
        oninput="this.value = this.value.toUpperCase()">
      <button type="submit">View site</button>
    </form>`,
    // Without a declared contact address, no line: better to propose nothing
    // than to send the visitor towards an address that belongs to nobody.
    footer:
      CONTACT === ""
        ? ""
        : `    <p class="help">
      No code?
      <a href="mailto:${escapeHtml(CONTACT)}?subject=Access%20code">${escapeHtml(CONTACT)}</a>
    </p>`,
  });
}
