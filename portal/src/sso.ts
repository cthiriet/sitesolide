/**
 * The routes of a sign-in with the identity provider, two on the protected
 * site and two on the portal's own host. src/handoff.ts says why the flow
 * takes that detour, and what each of its pieces defends.
 *
 * On the site, reached through `/_portal/*`, the host coming from Caddy's
 * `X-Portal-Hote` as for the password:
 *
 * - `GET /_portal/oidc` draws the binding, seals the flow, leaves for the
 *   portal's host;
 * - `GET /_portal/oidc/complete?code=` redeems the code, judges the site's
 *   policy, sets the site's cookie.
 *
 * On `portal.<zone>`, reached through the portal manifest's `routes`, where
 * `X-Portal-Hote` means nothing and is never read:
 *
 * - `GET /oidc/start?flow=` mints a code at once when the portal already
 *   knows who this is, or sends them to the provider;
 * - `GET /oidc/callback` checks what the provider sends back and mints the
 *   code;
 * - `GET /oidc/signout?ticket=` ends the portal's session, where a site's
 *   sign-out sends the browser, and makes the next sign-in ask the provider
 *   which account.
 *
 * All five are GETs: they are top-level navigations, and none of them
 * changes anything a stranger could choose. Whoever makes a browser start a
 * flow signs its owner in as themselves; a callback or a code without the
 * cookie of the browser that began is refused; a sign-out needs the ticket
 * that only a site's own sign-out, a POST from its origin, mints.
 *
 * Built around their dependencies, like src/routes.ts: the tests drive them
 * with a provider they run themselves.
 */
import type { AuditStore, NewEvent, SharingStore } from "./database";
import {
  bindingHash,
  drawBinding,
  issueFlow,
  issueSession,
  issueTransaction,
  readFlow,
  readSession,
  readSignOut,
  readTransaction,
  transactionSuffix,
  IDENTITY_DURATION_S,
  type HandoffStore,
} from "./handoff";
import {
  authorizationUrl,
  completeSignIn,
  drawFlowSecrets,
  isFlowText,
  FLOW_DURATION_S,
  type Provider,
  type Settings,
} from "./oidc";
import { portalPage, signInPage } from "./page";
import { notSharedMessage } from "./routes";
import { identityRole, maySignIn } from "./sharing";
import {
  clearCookie,
  cookieName,
  doorHeaders,
  isValidHost,
  issueIdentityToken,
  pageHeaders,
  readCookie,
  safeReturnTo,
  setCookie,
  type Identity,
} from "./gate";

export type SsoOptions = {
  /** `null` without a hash: no flow begins, nothing could be signed at the end. */
  key: Uint8Array | null;
  /** `null`: no provider configured, every route answers that it is not offered. */
  settings: Settings | null;
  provider: Provider | null;
  online: boolean;
  sharing: SharingStore;
  audit: AuditStore;
  handoffs: HandoffStore;
};

export type SsoRoutes = {
  begin: (req: Request) => Response;
  complete: (req: Request) => Response;
  start: (req: Request) => Promise<Response>;
  callback: (req: Request) => Promise<Response>;
  signOut: (req: Request) => Response;
};

/** The binding cookie on the site, and the portal's session on its own host. */
export const BINDING_SUFFIX = "-sso";
export const SESSION_SUFFIX = "-session";

/**
 * Set on the portal's host by a sign-out, erased by the next sign-in that
 * succeeds: while it is there, a sign-in asks the provider which account
 * rather than taking the one it is still signed in with. On a shared computer,
 * the next person clicking *Sign in with* would otherwise come back as the
 * previous one. Unsigned on purpose: forged or stale, it only makes the
 * provider ask once more.
 */
export const SIGNED_OUT_SUFFIX = "-signed-out";

/**
 * How long the portal remembers that this browser signed out: a provider's own
 * session outlives the portal's by weeks, and the next person may come days
 * later.
 */
export const SIGNED_OUT_DURATION_S = 30 * 24 * 3600;

/**
 * What the person reads when the provider refuses or the token fails. Short
 * and without the detail, which goes to the audit: the page of a sign-in
 * that failed is no place to explain a JWT.
 */
const REFUSALS: Record<string, string> = {
  "domain-not-allowed": "This account's domain isn't allowed to sign in here.",
  "unmanaged-account": "This account isn't one of your organization's: sign in with your work account.",
  "unverified-email": "Your identity provider didn't confirm this account's email address.",
  "no-email": "Your identity provider didn't share this account's email address.",
  "unusable-email": "Your identity provider sent an email address this server can't use.",
  "provider-error": "The sign-in was cancelled or refused by your identity provider.",
  "provider-unreachable": "Your identity provider can't be reached right now. Try again in a moment.",
};

const GENERIC_REFUSAL = "The sign-in couldn't be verified. Go back to the site and try again.";

function headers(cookies: string[], extra: Record<string, string> = {}): Headers {
  const result = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...extra });
  for (const cookie of cookies) result.append("Set-Cookie", cookie);
  return result;
}

function redirect(location: string, cookies: string[] = []): Response {
  return new Response(null, { status: 303, headers: headers(cookies, { Location: location }) });
}

/**
 * Failed sign-ins recorded per host and per minute, at most. Anyone can begin a
 * flow and make it fail, without the password's rate limiting in the way: past
 * this, the failures of that minute go unrecorded rather than filling the
 * database. A code that was never minted is never recorded at all: it is noise.
 */
const FAILURES_PER_MINUTE = 30;

export function createSso(options: SsoOptions, clock: () => number = Date.now): SsoRoutes {
  const { online } = options;
  const failures = new Map<string, { minute: number; count: number }>();

  function audit(event: NewEvent, now: number): void {
    if (event.action === "portal.signin_failed") {
      const minute = Math.floor(now / 60_000);
      const key = event.target ?? "";
      const seen = failures.get(key);
      const count = seen?.minute === minute ? seen.count + 1 : 1;
      if (failures.size > 1000 && seen === undefined) failures.clear();
      failures.set(key, { minute, count });
      if (count > FAILURES_PER_MINUTE) return;
    }
    try {
      options.audit.record(event, now);
    } catch (err) {
      console.error(`audit: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function siteOrigin(host: string): string {
    return `${online ? "https" : "http"}://${host}`;
  }

  /** The sign-in page on the site, with the provider offered: the way back from every refusal there. */
  function door(returnTo: string, status: number, message: string, cookies: string[], chooseAccount = false): Response {
    const sso = options.settings === null ? null : { providerName: options.settings.providerName, chooseAccount };
    return new Response(signInPage(returnTo, message, sso), { status, headers: headers(cookies, doorHeaders()) });
  }

  /** A page on the portal's own host, with the way back to the site when the flow names it. */
  function page(status: number, title: string, message: string, back: { host: string; returnTo: string } | null, cookies: string[] = []): Response {
    const link = back === null ? null : { href: `${siteOrigin(back.host)}${back.returnTo}`, label: `Back to ${back.host}` };
    return new Response(portalPage(title, message, link), { status, headers: headers(cookies, pageHeaders()) });
  }

  function hostOf(req: Request): string | null {
    const host = (req.headers.get("x-portal-hote") ?? "").toLowerCase();
    return isValidHost(host) ? host : null;
  }

  /**
   * The way back to the site with a fresh code, or the page saying why there
   * is none. `sessionExpiry` travels with the code: the site's cookie will not
   * outlive the session that vouched for the person.
   */
  function handOver(
    flow: { host: string; binding: string; returnTo: string },
    identity: Identity,
    sessionExpiry: number,
    now: number,
    cookies: string[],
  ): Response {
    const minting = options.handoffs.mint({ ...flow, identity, sessionExpiry }, now);
    if ("refusal" in minting) {
      return minting.refusal === "spent-flow"
        ? page(400, "This sign-in link was already used.", "Go back to the site and sign in again.", flow, cookies)
        : page(503, "Too many sign-ins at once.", "Try again in a minute.", flow, cookies);
    }
    const target = `${siteOrigin(flow.host)}/_portal/oidc/complete?${new URLSearchParams({ code: minting.code })}`;
    return redirect(target, cookies);
  }

  return {
    begin(req) {
      const host = hostOf(req);
      if (host === null) return new Response("portal: unknown host", { status: 400, headers: headers([]) });
      const params = new URL(req.url).searchParams;
      const returnTo = safeReturnTo(params.get("retour"));
      if (options.key === null || options.settings === null) {
        return door(returnTo, 404, "Signing in with a work account isn't available here.", []);
      }

      const now = clock();
      const binding = drawBinding();
      const flow = issueFlow(
        options.key,
        { host, returnTo, binding: bindingHash(binding), chooseAccount: params.get("account") === "choose" },
        Math.floor(now / 1000),
      );
      const start = `${options.settings.portalOrigin}/oidc/start?${new URLSearchParams({ flow })}`;
      return redirect(start, [setCookie(binding, online, FLOW_DURATION_S, BINDING_SUFFIX)]);
    },

    async start(req) {
      if (options.key === null || options.settings === null || options.provider === null) {
        return page(404, "Not available.", "Signing in with a work account isn't configured on this server.", null);
      }
      const now = clock();
      const nowS = Math.floor(now / 1000);
      const sealed = new URL(req.url).searchParams.get("flow");
      const flow = readFlow(options.key, sealed, nowS);
      if (sealed === null || flow === null) {
        return page(400, "This sign-in link has expired.", "Go back to the site and sign in again.", null);
      }

      // The portal already knows this person: no detour through the provider.
      // The settings are judged again, an address taken off the allowed
      // domains since does not keep signing in for a day.
      const cookies = req.headers.get("cookie");
      const known = readSession(options.key, readCookie(cookies, cookieName(online, SESSION_SUFFIX)), nowS);
      const allowed = known !== null && maySignIn(known.identity.email, options.settings.allowedDomains, options.settings.admins);
      if (known !== null && allowed && !flow.chooseAccount) {
        return handOver(flow, known.identity, known.expiry, now, []);
      }
      // After a sign-out on this browser, the provider is asked which account,
      // whatever the site asked: see SIGNED_OUT_SUFFIX.
      const chooseAccount = flow.chooseAccount || readCookie(cookies, cookieName(online, SIGNED_OUT_SUFFIX)) !== null;

      let discovery;
      try {
        discovery = await options.provider.discovery();
      } catch (err) {
        console.error(`oidc: ${err instanceof Error ? err.message : String(err)}`);
        return page(502, "Your identity provider can't be reached.", "Try again in a moment.", flow);
      }
      // The flow travels on as it was sealed, its expiry with it: the whole
      // sign-in fits in the life of the binding cookie set when it began.
      const secrets = drawFlowSecrets();
      const transaction = issueTransaction(
        options.key,
        { state: secrets.state, nonce: secrets.nonce, verifier: secrets.verifier, flow: sealed },
        nowS,
      );
      return redirect(authorizationUrl(discovery, options.settings, secrets, chooseAccount), [
        setCookie(transaction, online, FLOW_DURATION_S, transactionSuffix(secrets.state)),
      ]);
    },

    async callback(req) {
      if (options.key === null || options.settings === null || options.provider === null) {
        return page(404, "Not available.", "Signing in with a work account isn't configured on this server.", null);
      }
      const now = clock();
      const nowS = Math.floor(now / 1000);
      const params = new URL(req.url).searchParams;
      const state = params.get("state");
      if (!isFlowText(state)) {
        return page(400, "This sign-in has expired.", "Go back to the site and sign in again.", null);
      }

      // The transaction is read once and erased in every answer: a callback
      // replayed, by the browser's history or by anyone else, finds nothing.
      const suffix = transactionSuffix(state);
      const spent = [clearCookie(online, suffix)];
      const transaction = readTransaction(options.key, readCookie(req.headers.get("cookie"), cookieName(online, suffix)), state, nowS);
      const flow = transaction === null ? null : readFlow(options.key, transaction.flow, nowS);
      if (transaction === null || flow === null) {
        return page(400, "This sign-in has expired.", "It may have been started in another browser. Go back to the site and sign in again.", null, spent);
      }

      const fail = (reason: string, email: string | null, status = 403): Response => {
        audit({ actor: email ?? "anonymous", action: "portal.signin_failed", target: flow.host, detail: { method: "oidc", reason } }, now);
        return page(status, "Sign-in refused.", REFUSALS[reason] ?? GENERIC_REFUSAL, flow, spent);
      };

      // RFC 9207: a provider that names itself must name the configured one.
      const issuer = params.get("iss");
      if (issuer !== null && issuer !== options.settings.issuer) return fail("wrong-issuer", null);
      if (params.has("error")) return fail("provider-error", null);
      const code = params.get("code");
      if (code === null || code === "" || code.length > 2048) return fail("no-code", null, 400);

      const result = await completeSignIn(
        options.provider,
        options.settings,
        { code, verifier: transaction.verifier, nonce: transaction.nonce },
        nowS,
      );
      if ("refusal" in result) {
        return fail(result.refusal, result.email, result.refusal === "provider-unreachable" ? 502 : 403);
      }

      // A new session, and this browser no longer counts as signed out.
      const session = setCookie(issueSession(options.key, result.identity, nowS), online, IDENTITY_DURATION_S, SESSION_SUFFIX);
      const cookies = [...spent, session, clearCookie(online, SIGNED_OUT_SUFFIX)];
      return handOver(flow, result.identity, nowS + IDENTITY_DURATION_S, now, cookies);
    },

    complete(req) {
      const host = hostOf(req);
      if (host === null) return new Response("portal: unknown host", { status: 400, headers: headers([]) });
      if (options.key === null || options.settings === null) {
        return door("/", 404, "Signing in with a work account isn't available here.", []);
      }
      const now = clock();
      // The binding is spent with the code: one flow, one redemption.
      const spent = [clearCookie(online, BINDING_SUFFIX)];
      const binding = readCookie(req.headers.get("cookie"), cookieName(online, BINDING_SUFFIX));
      const redemption = options.handoffs.redeem(new URL(req.url).searchParams.get("code") ?? "", host, binding, now);
      if ("refusal" in redemption) {
        if (redemption.refusal !== "unknown-code") {
          audit({ actor: "anonymous", action: "portal.signin_failed", target: host, detail: { method: "oidc", reason: redemption.refusal } }, now);
        }
        return door("/", 400, "This sign-in link has expired or was opened in another browser. Sign in again.", spent);
      }

      const { identity, returnTo } = redemption.handoff;
      const role = identityRole(identity.email, options.sharing.get(host), options.settings.admins);
      if (role === null) {
        audit({ actor: identity.email, action: "portal.signin_failed", target: host, detail: { method: "oidc", reason: "not-shared" } }, now);
        return door(returnTo, 403, notSharedMessage(identity.email), spent, true);
      }

      // A day at most, and never past the portal session that vouched for the
      // person: an account closed at the provider is out of every site a day
      // after signing in there, not a day after the last site it reached.
      const nowS = Math.floor(now / 1000);
      const expiration = Math.min(nowS + IDENTITY_DURATION_S, redemption.handoff.sessionExpiry);
      if (expiration <= nowS) {
        audit({ actor: identity.email, action: "portal.signin_failed", target: host, detail: { method: "oidc", reason: "expired-session" } }, now);
        return door(returnTo, 400, "Your sign-in has expired. Sign in again.", spent);
      }
      audit({ actor: identity.email, action: "portal.signin", target: host, detail: { method: "oidc", role } }, now);
      const cookie = setCookie(issueIdentityToken(options.key, host, expiration, identity), online, expiration - nowS);
      return redirect(returnTo, [...spent, cookie]);
    },

    signOut(req) {
      if (options.key === null || options.settings === null) {
        return page(404, "Not available.", "Signing in with a work account isn't configured on this server.", null);
      }
      const host = readSignOut(options.key, new URL(req.url).searchParams.get("ticket"), Math.floor(clock() / 1000));
      if (host === null) {
        return page(400, "This sign-out link has expired.", "Go back to the site and sign out again.", null);
      }
      return redirect(`${siteOrigin(host)}/`, [
        clearCookie(online, SESSION_SUFFIX),
        setCookie("1", online, SIGNED_OUT_DURATION_S, SIGNED_OUT_SUFFIX),
      ]);
    },
  };
}
