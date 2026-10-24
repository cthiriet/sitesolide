/**
 * What the tests that read the generated Caddy text, or run a real Caddy in
 * front of it, share: a block found by its header, a free port, and the wait
 * for something to answer at an address.
 */

/**
 * A block of a Caddy text, from the line its header starts to the brace
 * that closes it: the same extraction as api/tests/caddyfile.test.ts.
 * Comments readily quote braces and take no part in the structure.
 */
export function block(text: string, header: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.trimStart().startsWith(header));
  if (first === -1) throw new Error(`block not found: ${header}`);
  const body: string[] = [];
  let depth = 0;
  for (const line of lines.slice(first)) {
    const code = line.trimStart().startsWith("#") ? "" : line;
    depth += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
    body.push(line);
    if (depth === 0 && body.length > 1) break;
  }
  return body.join("\n");
}

/** A port of the loopback nothing listens on, as the system hands one out. */
export function freePort(): number {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
}

/** Once something answers at `url`, whatever its status; five seconds at most. */
export async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
  throw new Error(`nothing answers on ${url}`);
}
