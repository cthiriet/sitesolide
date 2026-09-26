/**
 * The routes, built around their dependencies rather than importing them: the
 * tests create as many as they have cases, with no port and no disk. The
 * server, for its part, creates only one.
 */
import { remainingWait, isAcceptableSubmission } from "../borrowed/auth";
import type { GuestStore } from "./database";
import { guestExpiration, guestOpens, type Guest } from "./guests";
import { signInPage } from "./page";
import {
  clearCookie,
  issueToken,
  guestHash,
  doorHeaders,
  isValidHost,
  readCookie,
  readToken,
  cookieName,
  isAcceptableOrigin,
  setCookie,
  isAcceptableRequest,
  returnForRequest,
  safeReturnTo,
} from "./gate";

export type Options = {
  /** `null` without a hash: nobody gets in, guests included. */
  key: Uint8Array | null;
  verifyPassword: (submitted: string) => Promise<boolean>;
  online: boolean;
  cookieDurationS: number;
  guests: GuestStore;
};

export type Routes = {
  verify: (req: Request) => Response;
  signIn: (req: Request) => Promise<Response>;
  signOut: (req: Request) => Response;
  health: () => Response;
};

/**
 * Beyond that, a guest's last visit is rewritten. Below it, every file of a
 * page would make a write for nothing.
 */
const TOUCH_STEP_MS = 60_000;

function refuse(text: string, status: number): Response {
  return new Response(text, { status, headers: { "Cache-Control": "no-store" } });
}

export function createRoutes(options: Options, clock: () => number = Date.now): Routes {
  /**
   * The rate limiting, in memory and per host. Not per address: an attacker who
   * changes address would bypass a per IP counter for free. Per host rather
   * than global ever since guests type their own password: whoever gets it
   * wrong on one site does not slow the owner down on another. What the
   * attacker gains from it, one more attempt per site, weighs nothing against
   * passwords drawn over 92 bits and more.
   *
   * A restart resets it to zero, which gives nothing more to whoever is trying
   * their luck, for the same reason.
   */
  const attempts = new Map<string, { failures: number; lastAt: number }>();

  /**
   * One argon2id verification at a time, all hosts together: each one reserves
   * 64 MiB, and a burst of simultaneous requests would exceed the service's
   * MemoryMax before the failure counter had moved.
   */
  let verifying = false;

  /** The host set by Caddy, in lowercase, or null if it does not have that shape. */
  function hostOf(req: Request): string | null {
    const host = (req.headers.get("x-portal-hote") ?? "").toLowerCase();
    return isValidHost(host) ? host : null;
  }

  function door(returnTo: string, status: number, message = "", headers: Record<string, string> = {}) {
    return new Response(signInPage(returnTo, message), {
      status,
      headers: { ...doorHeaders(), ...headers },
    });
  }

  function open(returnTo: string, token: string, durationS: number): Response {
    return new Response(null, {
      status: 303,
      headers: {
        Location: returnTo,
        "Set-Cookie": setCookie(token, options.online, durationS),
        "Cache-Control": "no-store",
      },
    });
  }

  return {
    /**
     * Queried by `forward_auth` before every request of a protected site. A
     * 200 lets it through; any other response goes out as is to the visitor,
     * body included, and that is what makes the 401 the login page.
     *
     * Without `X-Portal-Hote`, 401: this route is never reached by anything
     * but Caddy, which always sets the header, and its absence must open
     * nothing.
     */
    verify(req) {
      const host = hostOf(req);
      if (host === null) return refuse("portal: unknown host", 401);

      const method = req.headers.get("x-forwarded-method") ?? "GET";
      const returnTo = returnForRequest(method, req.headers.get("x-forwarded-uri"));
      const token = readCookie(req.headers.get("cookie"), cookieName(options.online));
      const now = clock();

      const bearer = readToken(token, options.key, host, Math.floor(now / 1000), options.cookieDurationS);
      if (bearer === null) return door(returnTo, 401);

      // A guest's access is re-read on every request, and that is what makes
      // revocation immediate: the cookie stays properly signed, the row is no
      // longer there.
      let guest: Guest | null = null;
      if (bearer.guest !== null) {
        guest = options.guests.byId(bearer.guest);
        if (!guestOpens(guest, host, now)) return door(returnTo, 401, "This access is no longer valid.");
      }

      if (!isAcceptableRequest(method, req.headers.get("origin"), host, options.online)) {
        return refuse("portal: origin refused", 403);
      }

      if (guest !== null && now - (guest.seenAt ?? 0) > TOUCH_STEP_MS) {
        options.guests.touch(guest.id, now);
      }
      return new Response(null, { status: 200 });
    },

    async signIn(req) {
      const host = hostOf(req);
      if (host === null) return refuse("portal: unknown host", 400);

      // The only check that exists before there is a cookie. Without it, any
      // page at all could aim at this route and, through failed attempts made
      // in the visitor's name, close the gate to the real user. It therefore
      // comes before the counter.
      if (!isAcceptableOrigin(req.headers.get("origin"), host, options.online)) {
        return refuse("portal: origin refused", 403);
      }

      // An HTML form without a file arrives urlencoded: URLSearchParams is
      // enough, and formData(), which the types mark as deprecated on the
      // server side, would only bring the multipart parsing nobody needs
      // here.
      const form = new URLSearchParams(await req.text().catch(() => ""));
      const returnTo = safeReturnTo(form.get("retour"));

      const now = clock();
      const record = attempts.get(host) ?? { failures: 0, lastAt: 0 };
      const wait = remainingWait(record.failures, record.lastAt, now);
      if (wait > 0) {
        const seconds = Math.ceil(wait / 1000);
        return door(returnTo, 429, `Too many attempts. Try again in ${seconds} s.`, {
          "Retry-After": String(seconds),
        });
      }

      const submitted = form.get("motdepasse");
      if (!isAcceptableSubmission(submitted)) return door(returnTo, 400, "Password missing.");

      // A guest first: their password is found back through its hash,
      // without argon2id, and a guest must not wait for another verification
      // to finish. A lapsed access, or one meant for another site, falls back
      // into the general case and counts as a failure.
      const nowS = Math.floor(now / 1000);
      if (options.key !== null) {
        const guest = options.guests.byHash(guestHash(submitted));
        if (guestOpens(guest, host, now)) {
          attempts.delete(host);
          const expiration = guestExpiration(guest, nowS, options.cookieDurationS);
          return open(returnTo, issueToken(options.key, host, expiration, guest.id), expiration - nowS);
        }
      }

      if (verifying) {
        return door(returnTo, 429, "A check is in progress. Try again.", { "Retry-After": "1" });
      }
      verifying = true;
      let ok: boolean;
      try {
        ok = options.key !== null && (await options.verifyPassword(submitted));
      } finally {
        verifying = false;
      }

      if (!ok) {
        attempts.set(host, { failures: record.failures + 1, lastAt: now });
        // A single message for every cause: wrong password, revoked access,
        // absent or malformed hash. What the portal knows about its own
        // configuration is not learned here.
        return door(returnTo, 401, "Password refused.");
      }

      attempts.delete(host);
      const expiration = nowS + options.cookieDurationS;
      return open(returnTo, issueToken(options.key!, host, expiration), options.cookieDurationS);
    },

    signOut(req) {
      const host = hostOf(req);
      if (host === null) return refuse("portal: unknown host", 400);
      if (!isAcceptableOrigin(req.headers.get("origin"), host, options.online)) {
        return refuse("portal: origin refused", 403);
      }
      // The cookie is erased even if it was no longer valid: a dead cookie
      // would otherwise stay in the browser.
      return new Response(null, {
        status: 303,
        headers: { Location: "/", "Set-Cookie": clearCookie(options.online), "Cache-Control": "no-store" },
      });
    },

    /**
     * What `sitesolide deploy` queries before protecting a site. `configure`
     * says that a hash is in place: protecting a site behind a portal
     * that refuses everyone would close that site to its owner.
     */
    health: () => Response.json({ ok: true, configure: options.key !== null }),
  };
}
