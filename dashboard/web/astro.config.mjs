// @ts-check
/// <reference types="bun" />
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "astro/config"
import react from "@astrojs/react"

/**
 * What the page says it was built from, in the sidebar's footer. A release
 * hands its tag in SITESOLIDE_BUILD_VERSION, which bin/build.ts sets for the
 * builds it runs: those run in a staged copy of the kit, no git checkout, and
 * the variable is the only source there. A checkout asks git, and only when
 * the repository's root is itself one, so that git never answers for some
 * other repository holding the folder; the commit is described from the
 * nearest tag, `-dirty` when the tree has changes. Anything else says `dev`.
 * `sitesolide deploy` hands a project's build no SITESOLIDE_ variable, so a
 * checkout deployed by the release binary still names its own commit.
 */
function buildVersion() {
  const handed = Bun.env.SITESOLIDE_BUILD_VERSION
  if (handed !== undefined && handed !== "") return handed
  const root = fileURLToPath(new URL("../..", import.meta.url))
  if (!existsSync(`${root}/.git`)) return "dev"
  const described = Bun.spawnSync(["git", "-C", root, "describe", "--tags", "--always", "--dirty"], { stdout: "pipe", stderr: "ignore" })
  const version = described.stdout.toString().trim()
  return described.exitCode === 0 && version !== "" ? version : "dev"
}

/**
 * The page is built here and dropped into ../public, the manifest's
 * `publicDir`: the platform sends it with its own rsync and Caddy serves it
 * without ever waking Bun. This `web/` directory never goes up to the VM,
 * neither Astro, nor React, nor any of their dependencies.
 *
 * Static output, with no adapter: every piece of state arrives through /api/*,
 * behind the session, so nothing sensitive can end up in a page Caddy serves
 * in the clear.
 */
export default defineConfig({
  outDir: "../public",
  output: "static",
  // The directory is emptied on every build. It holds only what that build
  // produces, and the deployment's rsync runs with --delete.
  //
  // One page per directory, `sites/index.html` for `/sites/`: Caddy serves
  // public/ through `file_server`, with no rewrite, which serves a directory's
  // index and redirects `/sites` to `/sites/`. A `sites.html` would only be
  // served at its exact name. The page's links are therefore written with the
  // trailing slash.
  build: { assets: "_assets", format: "directory" },
  trailingSlash: "always",
  vite: {
    plugins: [tailwindcss()],
    // Read by src/lib/version.ts.
    define: { SITESOLIDE_BUILD_VERSION: JSON.stringify(buildVersion()) },
  },
  integrations: [react()],
})
