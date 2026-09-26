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


/** The portal's icon, in `data:` so as to ask nothing of the server. */
const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='f' x1='0' y1='0' x2='32' y2='32' gradientUnits='userSpaceOnUse'%3E%3Cstop offset='0' stop-color='%231b2b47'/%3E%3Cstop offset='1' stop-color='%230b1220'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='7' fill='url(%23f)'/%3E%3Cpath d='M16 16L27 21.5L16 27L5 21.5Z' fill='%235b6c92'/%3E%3Cpath d='M16 10.5L27 16L16 21.5L5 16Z' fill='%239aa8c4'/%3E%3Cpath d='M16 5L27 10.5L16 16L5 10.5Z' fill='%23d93a55'/%3E%3C/svg%3E";

/**
 * The logo of the portal and of the dashboard: three layers, the topmost one
 * carrying the accent. Inline rather than as a file, for the same reason as
 * the rest of the page. The gradient identifiers are global to the document,
 * and there is only one logo per page.
 */
const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true">
        <defs>
          <linearGradient id="layer-bottom" x1="3" y1="17" x2="29" y2="24" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#33456b" />
            <stop offset="1" stop-color="#1d2b47" />
          </linearGradient>
          <linearGradient id="layer-middle" x1="3" y1="11" x2="29" y2="18" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#5b6c92" />
            <stop offset="1" stop-color="#35446a" />
          </linearGradient>
          <linearGradient id="layer-top" x1="3" y1="4" x2="29" y2="12" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#e8556b" />
            <stop offset="1" stop-color="#a51f3a" />
          </linearGradient>
        </defs>
        <path d="M16 16L29 22.5L16 29L3 22.5Z" fill="url(#layer-bottom)" />
        <path d="M16 9.5L29 16L16 22.5L3 16Z" fill="url(#layer-middle)" />
        <path d="M16 3L29 9.5L16 16L3 9.5Z" fill="url(#layer-top)" />
      </svg>`;

const STYLE = `
    :root {
      --ink: #0e1726;
      --ink-70: #3b4a63;
      --ink-45: #6c7a91;
      --glass: #e8ecf1;
      --surface: #ffffff;
      --line: #d2d9e3;
      --seal: #b3253f;
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
      font-family: "Helvetica Neue", Helvetica, Arial, "Segoe UI", system-ui, sans-serif;
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
      border: 1px solid var(--line);
      border-radius: 5px;
    }

    input.code { letter-spacing: 0.22em; }

    input:hover { border-color: var(--ink-70); }

    input:focus-visible,
    button:focus-visible {
      outline: 2px solid var(--seal);
      outline-offset: 2px;
    }

    .alert { margin-top: 10px; font-size: 0.875rem; color: var(--seal); }

    button {
      margin-top: 14px;
      width: 100%;
      padding: 13px 22px;
      font: inherit;
      font-size: 0.9375rem;
      font-weight: 500;
      color: var(--surface);
      background: var(--ink);
      border: 1px solid transparent;
      border-radius: 5px;
      cursor: pointer;
    }

    button:hover { background: #1c2c47; }

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
};

function template({ title, text, form, footer = "", comment = "" }: Template): string {
  const tabTitle = title.replace(/\.$/, "");
  return `<!doctype html>
<html lang="en">

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${tabTitle}</title>${comment === "" ? "" : `\n  <!--\n${comment}\n  -->`}
  <meta name="theme-color" content="#e8ecf1">
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
export function signInPage(returnTo: string, message = ""): string {
  const alertHtml = message === "" ? "" : `\n      <p class="alert" role="alert">${escapeHtml(message)}</p>`;
  return template({
    title: "This site is private.",
    text: "Enter your password.",
    form: `    <form method="post" action="/_portal/connexion">
      <input type="hidden" name="retour" value="${escapeHtml(returnTo)}">
      <label for="motdepasse">Password</label>
      <input id="motdepasse" name="motdepasse" type="password" autocomplete="current-password" required autofocus>${alertHtml}
      <button type="submit">Enter</button>
    </form>`,
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
