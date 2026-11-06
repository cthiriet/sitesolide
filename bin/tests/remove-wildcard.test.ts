/**
 * The wildcard block, in a real Caddy on the workstation (admin off, free
 * port, stopped by its PID): while a restricted app's block is in
 * /etc/caddy/sites, its public/ is never served by the wildcard; once the
 * block is gone and Caddy reloaded, the same files go to anyone. Why a
 * removal sets public/ aside before it takes the block out, and a rename lays
 * the new name's block before it moves the folder: see
 * dashboard/tests/lifecycle-exposure.test.ts.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { block, freePort, waitFor } from "./caddy-lab";

const CADDY = Bun.which("caddy");
const REPO_ROOT = join(import.meta.dir, "..", "..");
const ZONE = "example.localhost";
const CADDYFILE = readFileSync(join(REPO_ROOT, "infra", "caddy", "Caddyfile"), "utf8");
let caddy: ReturnType<typeof Bun.spawn> | undefined;
let folder = "";
afterEach(() => { caddy?.kill(); caddy = undefined; if (folder !== "") rmSync(folder, { recursive: true, force: true }); });

async function serve(withBlock: boolean, port: number): Promise<void> {
  folder = mkdtempSync(join(tmpdir(), "wildcard-"));
  mkdirSync(join(folder, "sites", "nis2", "public"), { recursive: true });
  writeFileSync(join(folder, "sites", "nis2", "public", "index.html"), "members-only page");
  mkdirSync(join(folder, "caddy-sites"));
  mkdirSync(join(folder, "locks"));
  // The block's presence is all the wildcard's @app looks at.
  if (withBlock) writeFileSync(join(folder, "caddy-sites", "nis2.caddy"), "# the app's own block\n");
  const wildcard = block(CADDYFILE, "*.{$SITESOLIDE_ZONE} {")
    .replace("*.{$SITESOLIDE_ZONE} {", `http://*.${ZONE}:${port} {`)
    .replace("\timport tls-zone\n", "")
    .replaceAll("/srv/sites/", `${folder}/sites/`)
    .replace("root /etc/caddy/sites", `root ${folder}/caddy-sites`)
    .replace("/etc/caddy/locks/*.caddy", `${folder}/locks/*.caddy`);
  writeFileSync(join(folder, "Caddyfile"), ["{", "\tadmin off", "\tauto_https off", "}", block(CADDYFILE, "(commun) {"), wildcard].join("\n"));
  caddy = Bun.spawn([CADDY!, "run", "--config", join(folder, "Caddyfile"), "--adapter", "caddyfile"], {
    env: { ...process.env, SITESOLIDE_SLUG: "{labels.2}", SITESOLIDE_ZONE: ZONE, HOME: folder, XDG_DATA_HOME: join(folder, "data"), XDG_CONFIG_HOME: join(folder, "config") },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitFor(`http://127.0.0.1:${port}/`);
}

const get = (port: number) => fetch(`http://127.0.0.1:${port}/`, { headers: { Host: `nis2.${ZONE}:${port}` } });

test.skipIf(CADDY === null)("with its block: the wildcard refuses the app's folder", async () => {
  const port = freePort();
  await serve(true, port);
  const response = await get(port);
  expect(response.status).toBe(404);
});

test.skipIf(CADDY === null)("block removed, folder still there: the wildcard serves it to anyone", async () => {
  const port = freePort();
  await serve(false, port);
  const response = await get(port);
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).toBe("members-only page");
});
