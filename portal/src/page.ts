/**
 * The page that closes a site, in its two uses: the portal's login, rendered
 * here on every 401, and the door page of locked previews, which the
 * dashboard's gatekeeper writes into /srv/garde/<slug>/ when a site opens with
 * a code (dashboard/src/gatekeeper/), from this very module, borrowed.
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
 * Pure: renders text. Everything coming from the visitor is escaped. It
 * imports nothing, so that the dashboard borrows it as it stands: the
 * contact address of the door page comes in as a parameter.
 */


/**
 * The portal's icon, in `data:` so as to ask nothing of the server: the
 * favicon of the landing page and of the dashboard, a petrol gradient, the
 * light one, or the dark one when the browser is dark.
 */
const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cstyle%3E.a%7Bstop-color:%23138896%7D.b%7Bstop-color:%230a5560%7D@media (prefers-color-scheme:dark)%7B.a%7Bstop-color:%235cc8d3%7D.b%7Bstop-color:%232c98a4%7D%7D%3C/style%3E%3Cdefs%3E%3ClinearGradient id='f' x1='1' y1='1' x2='31' y2='31' gradientUnits='userSpaceOnUse'%3E%3Cstop offset='0' class='a'/%3E%3Cstop offset='1' class='b'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath d='M7.32 1H24.68A6.32 6.32 0 0 1 31 7.32V9.92H11.11A1.42 1.42 0 0 0 11.11 12.76H31V24.68A6.32 6.32 0 0 1 24.68 31H7.32A6.32 6.32 0 0 1 1 24.68V22.08H20.89A1.42 1.42 0 0 0 20.89 19.24H1V7.32A6.32 6.32 0 0 1 7.32 1Z' fill='url(%23f)'/%3E%3C/svg%3E";

/**
 * The portal's logo, drawn as the landing page's header draws it in Ledger: a
 * solid block with two slits cut in from opposite sides, the S of sitesolide,
 * filling its square in a petrol gradient, the same in light and in dark.
 * Inline rather than as a file, for the same reason as the rest of the page;
 * presentation attributes rather than a class, so that it needs nothing of the
 * stylesheet. The page holds one logo, so the gradient's id cannot collide.
 */
const BLOCK =
  "M7.32 1H24.68A6.32 6.32 0 0 1 31 7.32V9.92H11.11A1.42 1.42 0 0 0 11.11 12.76H31V24.68A6.32 6.32 0 0 1 24.68 31H7.32A6.32 6.32 0 0 1 1 24.68V22.08H20.89A1.42 1.42 0 0 0 20.89 19.24H1V7.32A6.32 6.32 0 0 1 7.32 1Z";
const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true">
        <defs><linearGradient id="mark" x1="1" y1="1" x2="31" y2="31" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#14899A" /><stop offset="1" stop-color="#0A5560" /></linearGradient></defs>
        <path d="${BLOCK}" fill="url(#mark)" />
      </svg>`;

/**
 * Ledger, the design of the landing page: mineral paper, one raised card with
 * a hairline and a soft layered shadow, fields sunk below it, the pressable
 * teal for the one primary action and the teal focus ring, light and dark from
 * the browser's preference. The values are the landing page's own tokens; the
 * red alone is the dashboard's, since red means an error and nothing else.
 *
 * The faces are named, Hanken Grotesk and IBM Plex Mono, but never fetched:
 * this page cannot fetch anything (see above), and carrying them in `data:`
 * would weigh some 65 KB of base64 on every 401 of every protected site and
 * take a `font-src` the CSP does not grant. A browser that has them installed
 * uses them; every other falls back on its system face, at Ledger's sizes,
 * weights and tracking.
 */
const STYLE = `
    :root {
      color-scheme: light dark;
      --bg: #F4F5F1;
      --card: #FBFBF9;
      --raised: #FFFFFF;
      --field: #FFFFFF;
      --line: #E2E3DC;
      --line-2: #D3D6CE;
      --ink: #141816;
      --ink-2: #3A413D;
      --muted: #6A6F69;
      --faint: #9EA39C;
      --accent: #0B6E79;
      --accent-text: #0A6570;
      --accent-hi: #12838F;
      --accent-lo: #0A616B;
      --accent-edge: #07484F;
      --accent-soft: #E3EDEB;
      --on-accent: #FFFFFF;
      --ring: rgba(11, 110, 121, .24);
      --error: #B3253F;
      --error-soft: rgba(179, 37, 63, .06);
      --error-line: rgba(179, 37, 63, .2);
      --dots: rgba(20, 24, 22, .085);
      --sh-panel: inset 0 1px 0 rgba(255,255,255,.85), 0 1px 1px rgba(22,32,28,.03), 0 2px 4px rgba(22,32,28,.03), 0 10px 20px -8px rgba(22,32,28,.07), 0 30px 60px -28px rgba(22,32,28,.16);
      --sh-well: inset 0 1px 2px rgba(22,32,28,.07), inset 0 0 0 1px rgba(22,32,28,.025);
      --sh-btn: inset 0 1px 0 rgba(255,255,255,.26), inset 0 -1px 1px rgba(0,0,0,.18), 0 1px 2px rgba(7,52,58,.30), 0 3px 5px -1px rgba(7,52,58,.16), 0 9px 16px -8px rgba(7,52,58,.30);
      --sh-btn-press: inset 0 1px 3px rgba(0,0,0,.30), 0 1px 1px rgba(7,52,58,.16);
      --sh-btn-2: inset 0 1px 0 #FFFFFF, 0 1px 2px rgba(22,32,28,.07), 0 3px 6px -2px rgba(22,32,28,.08);
      --sh-btn-2-press: inset 0 1px 2px rgba(22,32,28,.12);
      --btn-shade: rgba(0,0,0,.18);
      --font-sans: "Hanken Grotesk", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0D1211;
        --card: #141A19;
        --raised: #1C2422;
        --field: #0F1514;
        --line: #232C2A;
        --line-2: #303B38;
        --ink: #E8EDEA;
        --ink-2: #C4CCC7;
        --muted: #949E99;
        --faint: #5F6964;
        --accent: #3FA6AE;
        --accent-text: #74C6C6;
        --accent-hi: #148E9A;
        --accent-lo: #0B6670;
        --accent-edge: #04363B;
        --accent-soft: #112828;
        --ring: rgba(63, 166, 174, .3);
        --error: #F36F84;
        --error-soft: rgba(243, 111, 132, .08);
        --error-line: rgba(243, 111, 132, .24);
        --dots: rgba(232, 237, 234, .06);
        --sh-panel: inset 0 1px 0 rgba(255,255,255,.045), 0 1px 1px rgba(0,0,0,.32), 0 2px 4px rgba(0,0,0,.26), 0 12px 24px -10px rgba(0,0,0,.5), 0 32px 64px -28px rgba(0,0,0,.65);
        --sh-well: inset 0 1px 3px rgba(0,0,0,.5), inset 0 0 0 1px rgba(0,0,0,.25);
        --sh-btn: inset 0 1px 0 rgba(255,255,255,.24), inset 0 -1px 1px rgba(0,0,0,.28), 0 1px 2px rgba(0,0,0,.55), 0 4px 10px -2px rgba(0,0,0,.5);
        --sh-btn-press: inset 0 1px 3px rgba(0,0,0,.45);
        --sh-btn-2: inset 0 1px 0 rgba(255,255,255,.07), 0 1px 2px rgba(0,0,0,.45), 0 3px 8px -2px rgba(0,0,0,.4);
        --sh-btn-2-press: inset 0 1px 3px rgba(0,0,0,.5);
        --btn-shade: rgba(0,0,0,.28);
      }
    }

    *, *::before, *::after { box-sizing: border-box; }

    html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }

    body {
      margin: 0;
      min-height: 100vh;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: 48px max(24px, env(safe-area-inset-right)) 48px max(24px, env(safe-area-inset-left));
      background: var(--bg);
      color: var(--ink);
      font-family: var(--font-sans);
      font-size: 15px;
      line-height: 24px;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      isolation: isolate;
    }

    /* The landing page's Access stage: a faint dot grid, fading out around the card. */
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      z-index: -1;
      background-image: radial-gradient(circle at 1px 1px, var(--dots) 1px, transparent 1.5px);
      background-size: 16px 16px;
      -webkit-mask-image: radial-gradient(closest-side, #000 0%, rgba(0,0,0,.45) 55%, transparent 100%);
      mask-image: radial-gradient(closest-side, #000 0%, rgba(0,0,0,.45) 55%, transparent 100%);
      pointer-events: none;
    }

    ::selection { background: var(--accent-soft); color: var(--ink); }

    main {
      width: 100%;
      max-width: 420px;
      padding: 32px;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 24px;
      box-shadow: var(--sh-panel);
    }

    p { margin: 0; }

    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 17px;
      line-height: 24px;
      font-weight: 600;
      letter-spacing: -0.025em;
      color: var(--ink);
    }

    .brand svg { width: 24px; height: 24px; flex: none; }

    h1 {
      margin: 32px 0 0;
      font-size: 26px;
      line-height: 32px;
      font-weight: 500;
      letter-spacing: -0.02em;
      color: var(--ink);
      text-wrap: balance;
    }

    .lede { margin-top: 8px; color: var(--muted); text-wrap: pretty; }

    form {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      margin-top: 24px;
    }

    label {
      grid-column: 1 / -1;
      font-size: 14px;
      line-height: 20px;
      font-weight: 500;
      color: var(--ink);
    }

    input:not([type="hidden"]) {
      grid-column: 1 / -1;
      display: block;
      width: 100%;
      height: 44px;
      margin: 0;
      padding: 0 14px;
      font: inherit;
      font-size: 16px;
      line-height: 24px;
      color: var(--ink);
      background: var(--field);
      border: 1px solid var(--line-2);
      border-radius: 12px;
      box-shadow: var(--sh-well);
      transition: border-color .12s ease, box-shadow .12s ease;
    }

    input:not([type="hidden"]):hover { border-color: var(--faint); }

    input:not([type="hidden"]):focus {
      outline: 2px solid transparent;
      border-color: var(--accent);
      box-shadow: var(--sh-well), 0 0 0 3px var(--ring);
    }

    input::placeholder { color: var(--faint); opacity: 1; }

    /* The code: six characters of a fixed alphabet, set like a key. The indent
       gives back the tracking after the last character, so the code centres. */
    input.code {
      height: 52px;
      font-family: var(--font-mono);
      font-size: 20px;
      font-weight: 500;
      letter-spacing: .24em;
      text-indent: .24em;
      text-align: center;
    }

    .alert { grid-column: 1 / -1; font-size: 14px; line-height: 20px; color: var(--error); }

    .notice {
      margin-top: 20px;
      padding: 10px 14px;
      border-radius: 12px;
      background: var(--error-soft);
      box-shadow: inset 0 0 0 1px var(--error-line);
      text-wrap: pretty;
    }

    .notice + a.sso { margin-top: 16px; }

    button,
    a.sso {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      min-height: 44px;
      margin: 8px 0 0;
      padding: 11px 18px;
      font: inherit;
      font-size: 15px;
      line-height: 20px;
      font-weight: 500;
      letter-spacing: -0.005em;
      text-align: center;
      text-decoration: none;
      overflow-wrap: anywhere;
      cursor: pointer;
      color: var(--on-accent);
      background: linear-gradient(180deg, var(--accent-hi) 0%, var(--accent-lo) 100%);
      border: 1px solid var(--accent-edge);
      border-radius: 12px;
      box-shadow: var(--sh-btn);
      text-shadow: 0 -1px 0 var(--btn-shade);
      transition: transform .12s ease, box-shadow .12s ease, filter .12s ease, border-color .12s ease;
    }

    a.sso { margin-top: 24px; }

    button:hover,
    a.sso:hover { filter: brightness(1.06) saturate(1.04); }

    button:active,
    a.sso:active { transform: translateY(1px); box-shadow: var(--sh-btn-press); }

    button:focus-visible,
    a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }

    /* With a provider, its button is the primary action: the password goes on
       one line beside a raised neutral Enter. */
    .or {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 20px;
      font-size: 13px;
      line-height: 20px;
      color: var(--muted);
    }

    .or::before,
    .or::after { content: ""; flex: 1; height: 1px; background: var(--line); }

    .or + form { margin-top: 12px; }

    .or + form input:not([type="hidden"]) { grid-column: 1; }

    .or + form button {
      grid-column: 2;
      grid-row: 2;
      width: auto;
      margin: 0;
      padding-inline: 16px;
      color: var(--ink);
      background: linear-gradient(180deg, var(--raised) 0%, var(--card) 100%);
      border-color: var(--line-2);
      box-shadow: var(--sh-btn-2);
      text-shadow: none;
    }

    .or + form button:hover { filter: none; border-color: var(--faint); }

    .or + form button:active { box-shadow: var(--sh-btn-2-press); }

    .another { margin-top: 4px; text-align: center; font-size: 14px; line-height: 20px; }

    .another a { display: inline-flex; align-items: center; min-height: 44px; }

    .another + .or { margin-top: 4px; }

    a:not(.sso) {
      color: var(--accent-text);
      text-decoration: underline;
      text-decoration-thickness: 1px;
      text-underline-offset: 3px;
      text-decoration-color: color-mix(in srgb, var(--accent-text) 45%, transparent);
      border-radius: 4px;
    }

    a:not(.sso):hover { text-decoration-color: currentColor; }

    /* The card's foot: a hairline across the whole card, then who to ask. */
    .help {
      margin: 28px -32px -32px;
      padding: 16px 32px 20px;
      border-top: 1px solid var(--line);
      font-size: 14px;
      line-height: 20px;
      color: var(--muted);
    }

    .help a { font-family: var(--font-mono); font-size: 13px; overflow-wrap: anywhere; }

    /* On a phone the card leads from the top, where the keyboard leaves it in
       view, and the stage gives way to the plain paper, as on the landing page. */
    @media (max-width: 767px) {
      body {
        place-items: start center;
        padding: max(48px, 10vh) max(16px, env(safe-area-inset-right)) 32px max(16px, env(safe-area-inset-left));
      }

      body::before { display: none; }

      main { padding: 24px; border-radius: 20px; }

      h1 { margin-top: 24px; font-size: 22px; line-height: 28px; }

      .help { margin: 24px -24px -24px; padding: 14px 24px 16px; }

      .help a { padding-block: 12px; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { transition: none !important; }
    }
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
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="robots" content="noindex, nofollow">${refresh === "" ? "" : `\n  <meta http-equiv="refresh" content="0; url=${refresh}">`}
  <title>${tabTitle}</title>${comment === "" ? "" : `\n  <!--\n${comment}\n  -->`}
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#F4F5F1" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0D1211" media="(prefers-color-scheme: dark)">
  <link rel="icon" href="${ICON}">
  <style>${STYLE}</style>
</head>

<body>
  <main>
    <p class="brand">
      ${LOGO}
      <span>sitesolide</span>
    </p>
    <h1>${title}</h1>
    <p class="lede">${text}</p>
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
  // Without a provider, every message is the password's and sits under its
  // field. With one, most are the account's (not let in, expired, not
  // available), and they lead the card rather than redden the password.
  const alertHtml = message === "" || sso !== null ? "" : `\n      <p class="alert" role="alert">${escapeHtml(message)}</p>`;
  const noticeHtml = message === "" || sso === null ? "" : `    <p class="alert notice" role="alert">${escapeHtml(message)}</p>\n`;
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
    ? `\n    <p class="another"><a href="${begin(true)}">Use another account</a></p>`
    : "";
  return template({
    title: "This site is private.",
    text: "Sign in with your company account, or enter a password.",
    form: `${noticeHtml}    <a class="sso" href="${begin(false)}">Sign in with ${escapeHtml(sso.providerName)}</a>${another}
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
 * The root of the portal's own host, where no site lives: signing in happens
 * on each. Committed as public/index.html, which Caddy serves as it stands; a
 * test keeps the file equal to this rendering, and `bun run home-page` writes
 * it again.
 */
export function homePage(): string {
  return template({ title: "Sign-in portal.", text: "Signing in happens on each site.", form: "" });
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
 * The words that open the comment of a generated door page. The gatekeeper
 * writes the page again when it carries them, and leaves a page that does
 * not, one a site placed itself, as it is.
 */
export const DOOR_PAGE_MARKER = "Guard page of locked previews";

/**
 * The door page of the previews. What a visitor reads never calls the site a
 * preview, and that is deliberate: the word is the trade's, and whoever lands
 * here is most often a craftsman coming to look at their site. Only the
 * marker, in a comment no browser shows, says it.
 *
 * Caddy compares the key character for character: a code typed in lowercase
 * would give a 401 with no explanation. The pattern therefore accepts only the
 * exact alphabet, and the field is put back in uppercase while typing through
 * `oninput`, never through a `text-transform`, which only changes the display
 * and let `abc234` go out from a field that showed `ABC234`. Without
 * JavaScript, the browser refuses the input itself, with the `title` message.
 */
export function doorPage(contact: string): string {
  return template({
    comment: [
      `    ${DOOR_PAGE_MARKER}, generated`,
      "    from portal/src/page.ts. Do not edit: the gatekeeper writes it again",
      "    whenever the site is given a code, from the template it shares with",
      "    the portal's login.",
      "",
      "    Written by the gatekeeper into /srv/garde/<slug>/index.html, and",
      "    served with a 401 for every URL of the locked host: it must stay self",
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
      contact === ""
        ? ""
        : `    <p class="help">
      No code?
      <a href="mailto:${escapeHtml(contact)}?subject=Access%20code">${escapeHtml(contact)}</a>
    </p>`,
  });
}
