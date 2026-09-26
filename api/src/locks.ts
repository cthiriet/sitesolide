import { isValidDomain } from "./table";

/**
 * Code lock for previews.
 *
 * A preview lives on `<slug>.<zone>`, publicly reachable: the `noindex` keeps
 * it out of Google, it closes it to nobody. The lock closes it for good,
 * behind a six character code that the client receives once and that their
 * browser then keeps in a cookie.
 *
 * This module only decides and renders text: no disk access, no network
 * access. Reading the manifests and the codes belongs to
 * `scripts/generate-locks.ts`, installing to `bin/lock.sh`.
 *
 * ## The code is not a cryptographic secret
 *
 * It lives **in the clear** in the Caddy fragment dropped on the VM, because
 * Caddy compares it in the clear: the stanza literally contains
 * `query key=<CODE>` and a cookie comparison. It is therefore readable by
 * anyone who reads `/etc/caddy/locks/`, it travels in the clear in the URL the
 * client receives, and it stays in their browsing history.
 *
 * What it protects: a preview against a passing visitor, a curious
 * competitor, an indexing engine. What it does not protect: personal data, a
 * customer area, anything that would deserve real authentication. Six
 * characters over a 32 letter alphabet are worth about 30 bits, and nothing
 * here limits the number of attempts: Caddy answers every request without
 * counting. For a demonstration site, that is enough; for anything else,
 * `basicauth` and a hashed password are required.
 *
 * ## The day someone adds an access log
 *
 * The code travels in the URL, `/?key=A7B2K9`. No block of the Caddyfile
 * carries a `log` directive today, so that parameter is written nowhere.
 * **Adding `log` to a preview block would send every code in force into
 * journald**, readable by whoever reads the logs and kept for as long as they
 * are retained. A log placed there must therefore mask the parameter, through
 * a `query` filter on `request>uri`, or only be placed for the duration of a
 * troubleshooting session, with the locks lifted.
 */

/**
 * Alphabet of the code, without `O`, `I`, `0` or `1`: the code gets dictated
 * over the phone, and those four characters are confused pairwise by ear as
 * much as by eye.
 *
 * **32 characters, and that number is not decorative.** The draw takes a
 * random byte then brings it back into the alphabet through a modulo. A modulo
 * only biases the draw if the size of the alphabet does not divide 256: here
 * 256 / 32 = 8 exactly, so every character comes out with the same
 * probability. Removing or adding a letter would break that property
 * silently, which is why `generateCode` checks it instead of trusting.
 */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Six characters: enough not to be guessed, short enough to be dictated. */
export const CODE_LENGTH = 6;

/** Folder of the door pages on the VM, one subfolder per locked site. */
export const DOOR_PAGES_DIR = "/srv/garde";

/** Thirty days: the client does not retype their code on every visit. */
export const COOKIE_MAX_AGE_S = 2_592_000;

/** Randomness source, received as a parameter so the tests can control it. */
export type RandomSource = (bytes: number) => Uint8Array;

const defaultRandomSource: RandomSource = (bytes) => crypto.getRandomValues(new Uint8Array(bytes));

/**
 * Draws a code. Randomness comes from the parameter, never from a direct call:
 * a test can thus impose the byte sequence and check the exact rendering.
 */
export function generateCode(random: RandomSource = defaultRandomSource): string {
  // See CODE_ALPHABET: without that exact division, the modulo would favor the
  // first characters of the alphabet. The day someone removes a letter from it,
  // they learn it here and not through a guessable code.
  if (256 % CODE_ALPHABET.length !== 0) {
    throw new Error(`alphabet of ${CODE_ALPHABET.length} characters: the draw would be biased`);
  }

  const bytes = random(CODE_LENGTH);
  if (bytes.length < CODE_LENGTH) {
    throw new Error(`randomness source too short: ${bytes.length} bytes for ${CODE_LENGTH}`);
  }

  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * An accepted code is exactly six characters of the alphabet. Nothing else: no
 * lowercase, no spaces, no longer code, because this text goes out as is into
 * a Caddy stanza and into a `Set-Cookie` header.
 */
export function isValidCode(code: unknown): code is string {
  if (typeof code !== "string") return false;
  if (code.length !== CODE_LENGTH) return false;

  for (const char of code) {
    if (!CODE_ALPHABET.includes(char)) return false;
  }
  return true;
}

/**
 * The slug serves in three places at once: Caddy matcher name, cookie name,
 * and last segment of the door page path. It is therefore held to something
 * shorter than the one in `table.ts`, which tolerates the dot and the
 * underscore.
 */
export function isValidLockSlug(slug: unknown): slug is string {
  return typeof slug === "string" && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(slug);
}

/**
 * Cookie name derived from the slug. A cookie name is an HTTP token: no space,
 * no separator, and no dot that would cut the `{http.request.cookie.NAME}`
 * placeholder read by Caddy. The dash, for its part, passes everywhere and
 * stays as is, `sample-wheels` giving `lock_sample-wheels`.
 *
 * The replacement is only a safety net: `buildFragment` already refuses
 * the slugs that would need it, failing which two distinct slugs could come
 * down to the same cookie.
 */
export function cookieName(slug: string): string {
  return `lock_${slug.replace(/[^A-Za-z0-9-]/g, "_")}`;
}

/**
 * Preview address of a site, by naming convention.
 *
 * The zone is a parameter with no default value. Reusing the one from the
 * configuration would render `<slug>.` where it is not declared, an address
 * that belongs to nobody and that nothing would flag.
 */
export function previewHost(slug: string, zone: string): string {
  return `${slug}.${zone}`;
}

export type LockOptions = {
  /** Root of the door pages, one subfolder per site. */
  doorPagesDir?: string;
  /**
   * `Secure` attribute of the cookie. True in production, which is on HTTPS. A
   * local lab on plain HTTP must set it to false: otherwise the client does
   * not even record the cookie and the lock never opens.
   */
  secure?: boolean;
};

/**
 * Renders the Caddy stanza of a locked site.
 *
 * Three sibling `handle`s, therefore mutually exclusive: the first one that
 * accepts the request excludes the other two. The order carries the whole
 * meaning.
 *
 *   1. the key passed in the query sets the cookie and redirects to the root;
 *   2. the right cookie falls into an **empty** `handle`, and that emptiness
 *      is the mechanism: the request leaves the group with no response
 *      written and reaches the `file_server` of the calling block, the one
 *      that serves the real site;
 *   3. everything else gets the door page, with a 401.
 *
 * Three traps are worth naming, each one paid for by a measurement:
 *
 * - `route` in place of `handle` returns 401 to the legitimate visitor:
 *   `route` is not exclusive, the request goes through the empty branch then
 *   falls back into the guard branch;
 * - a `header Cookie *lock_x=CODE*` matcher is a pattern, not an equality: a
 *   cookie named `traplock_x` opens the site. Without the stars, it
 *   compares the whole `Cookie` header and the slightest analytics cookie
 *   closes the site to the legitimate visitor. Only
 *   `expression {http.request.cookie.NAME} == "CODE"` compares the exact value
 *   of the named cookie;
 * - without the `{ status 401 }` subblock, `file_server` serves the door page
 *   with a 200, therefore indexable.
 *
 * The `rewrite * /index.html` brings every URL of the host back onto the guard
 * page, `/style.css` included. That page must therefore be self contained:
 * inline CSS, no image and no external font, otherwise its own resources would
 * serve themselves in a loop.
 *
 * ## The two cache headers are not decorative
 *
 * `Cache-Control: no-store` on the door page, **without the `?` prefix**,
 * therefore as an overwrite. The `(commun)` snippet sets its cache policy
 * according to the *requested* path, and `handle` is sorted after `header`:
 * without that line, the door page goes back out with the
 * `public, max-age=31536000, immutable` of `@immuable` as soon as the
 * requested URL ends in `.ico` or `.png`. Measured. The browser asks for
 * `/favicon.ico` all by itself while displaying the door page: it would
 * therefore keep an HTML page at the icon's address, for a year, without ever
 * revalidating, long after the lock was opened.
 *
 * `Vary: Cookie` over the whole locked host, because the same URL renders
 * either the guard or the real site depending on a cookie. Without a shared
 * cache in front of Caddy, it is useless; with a shared proxy that would cache
 * a `public` response brought back by an authorized visitor, it is the only
 * thing that prevents serving it again to a visitor without a code.
 */
export function stanza(slug: string, host: string, code: string, options: LockOptions = {}): string {
  const doorPagesDir = options.doorPagesDir ?? DOOR_PAGES_DIR;
  const secure = options.secure ?? true;
  const cookie = cookieName(slug);
  const attributes = [
    `${cookie}=${code}`,
    "Path=/",
    `Max-Age=${COOKIE_MAX_AGE_S}`,
    ...(secure ? ["Secure"] : []),
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");

  // The three matchers are suffixed with the slug: named matchers share a
  // single namespace for the whole site block, imports included. Two stanzas
  // using the same name would make the entire adaptation fail, therefore all
  // of production, and not only the faulty site.
  return `# Preview lock: ${slug}
@lock_host_${slug} host ${host}
handle @lock_host_${slug} {
	# The response depends on a cookie: a shared cache that ignored it would
	# serve to everyone what an authorized visitor brought back.
	header Vary Cookie

	@lock_key_${slug} query key=${code}
	handle @lock_key_${slug} {
		header Set-Cookie "${attributes}"
		header Cache-Control "no-store"
		redir * / 303
	}

	@lock_open_${slug} expression {http.request.cookie.${cookie}} == "${code}"
	handle @lock_open_${slug} {
	}

	handle {
		root * ${doorPagesDir}/${slug}
		rewrite * /index.html
		# Without an overwrite, the guard inherits the cache of the requested
		# path, and /favicon.ico keeps an HTML page for a year. See the header
		# of api/src/locks.ts.
		header Cache-Control "no-store"
		file_server {
			status 401
		}
	}
}`;
}

/** A site as the generator reads it: descriptor on one side, code on the other. */
export type LockSite = {
  slug: string;
  host: string;
  /** `lock` field of the site's manifest, as is. */
  lock?: unknown;
  /** Code associated with the slug in the codes file, as is. */
  code?: unknown;
};

const HEADER = [
  "# Generated by api/scripts/generate-locks.ts, do not edit by hand.",
  "#",
  "# Preview locks: each stanza closes a subdomain behind a six character code.",
  "# The code is not a cryptographic secret, it is written here in the clear",
  "# because Caddy compares it in the clear.",
  "#",
  "# Regenerate with bin/lock.sh, never by hand: the file is overwritten.",
];

/**
 * Renders the complete fragment, one stanza per locked site, sorted by slug so
 * that two generations of the same state give the same text.
 *
 * **A lock asked for without a valid code interrupts everything.** Neither a
 * silently opened site, nor a partial stanza: the generator exits with an
 * error and the install script stops before having touched the configuration
 * in service. The worst possible outcome would be an owner believing their
 * site closed while it is open, and that is exactly what this rule prevents.
 *
 * **A code in force without a lock asked for interrupts it just as much**, and
 * it is the same rule taken the other way around. The intent is versioned, the
 * code is not: a `sitesolide.json` returned to its original form by a
 * `git checkout`, then redeployed by a perfectly ordinary `sitesolide deploy`,
 * goes back up onto the VM without its `lock` and erases the intent without
 * touching the code. The next regeneration, triggered days later by a
 * completely different site, would then reopen this one silently. The gap
 * between the two sources is a reason to stop here, never an opening.
 */
export function buildFragment(sites: LockSite[], options: LockOptions = {}): string {
  const kept: string[] = [];
  const seen = new Map<string, string>();

  for (const site of [...sites].sort((a, b) => a.slug.localeCompare(b.slug))) {
    if (site.lock !== true) {
      if (isValidCode(site.code)) {
        throw new Error(
          `${site.slug}: a code is in force but the manifest no longer asks for a lock. ` +
            `Close it again with "bin/lock.sh enable ${site.slug}", or remove the code with "bin/lock.sh disable ${site.slug}".`,
        );
      }
      continue;
    }

    if (!isValidLockSlug(site.slug)) {
      throw new Error(`slug unusable for a lock: "${site.slug}"`);
    }
    if (!isValidCode(site.code)) {
      throw new Error(`${site.slug}: lock requested without a valid code`);
    }
    if (!isValidDomain(site.host)) {
      throw new Error(`${site.slug}: invalid preview host "${site.host}"`);
    }

    // Two slugs coming down to the same cookie would open each other, and two
    // stanzas on the same host would make a duplicate of matchers.
    const cookie = cookieName(site.slug);
    for (const [key, value] of [
      ["cookie", cookie],
      ["host", site.host],
    ] as const) {
      const occupant = seen.get(value);
      if (occupant !== undefined) {
        throw new Error(`${site.slug} and ${occupant} share the same ${key} "${value}"`);
      }
      seen.set(value, site.slug);
    }

    kept.push(stanza(site.slug, site.host, site.code, options));
  }

  // A fragment with no stanza stays a valid Caddy file: nothing but comments.
  // Caddy accepts it being empty anyway, or the folder imported by glob not
  // existing, with a simple warning.
  return [HEADER.join("\n"), ...kept].join("\n\n") + "\n";
}
