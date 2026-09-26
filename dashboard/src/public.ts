/**
 * The fallback of `bun run dev`: serving `public/` the way Caddy serves it in
 * production, for lack of Caddy on the workstation.
 *
 * In production, nothing that is not /api/* gets this far: the Caddy fragment
 * routes only that family, and `file_server` serves the page without waking
 * Bun. The fallback is therefore closed as soon as NODE_ENV is production,
 * rather than left open "just in case": a service that knows how to serve
 * files ends up serving some, and the day the fragment changed, the fault
 * would show here rather than cover for itself.
 *
 * What it takes over from `file_server`, because the page depends on it: one
 * page per directory, `/sites/` serving `sites/index.html`, and `/sites`
 * redirects to `/sites/` keeping the query. Without that, reloading
 * `/sites/?site=cms` under `bun run dev` returned 404.
 */
import { join, resolve, sep } from "node:path";

const NOT_FOUND = "404: unknown route";

/**
 * The path on disk that an address path designates, or null if it leaves
 * `root`.
 *
 * The path is decoded, as Caddy does: a file whose name carries a space is
 * found. But decoding restores `..%2f` to its climbing form, which the parsing
 * of the address had let through since it saw no `..` segment in it. Hence the
 * guard, after resolution: the result must be the root itself or a path under
 * it. An invalid encoding or a null byte designate nothing.
 */
export function publicPath(root: string, path: string): string | null {
  let decode: string;
  try {
    decode = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decode.includes("\0")) return null;
  const base = resolve(root);
  const target = resolve(base, `.${decode.startsWith("/") ? decode : `/${decode}`}`);
  return target === base || target.startsWith(base + sep) ? target : null;
}

export async function servePublic(req: Request, options: { root: string; production: boolean }): Promise<Response> {
  const notFound = () => new Response(NOT_FOUND, { status: 404 });
  if (options.production) return notFound();

  const url = new URL(req.url);
  const target = publicPath(options.root, url.pathname);
  if (target === null) return notFound();

  // A directory is asked for with its trailing slash, and is served by its index.
  if (url.pathname.endsWith("/")) {
    const index = Bun.file(join(target, "index.html"));
    return (await index.exists()) ? new Response(index) : notFound();
  }

  // `exists()` is false for a directory: only a file is served as it stands.
  const file = Bun.file(target);
  if (await file.exists()) return new Response(file);

  // A directory asked for without its slash: file_server's redirect, query included. A single
  // leading slash, so that `//host` does not become an address towards another site.
  if (await Bun.file(join(target, "index.html")).exists()) {
    const path = `/${url.pathname.replace(/^\/+/, "")}/`;
    return new Response(null, { status: 308, headers: { Location: `${path}${url.search}` } });
  }
  return notFound();
}
