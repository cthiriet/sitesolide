// @ts-check
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "astro/config"
import react from "@astrojs/react"

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
  },
  integrations: [react()],
})
