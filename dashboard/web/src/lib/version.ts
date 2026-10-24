/** Replaced by astro.config.mjs with what the page was built from; undeclared, hence `dev`, in the tests. */
declare const SITESOLIDE_BUILD_VERSION: string | undefined

/**
 * The release this page was built from, as the sidebar's footer shows it: a
 * tag such as v0.8.0 from a release, `git describe` from a checkout, `dev`
 * when neither said. Written at build time, and only that: every other piece
 * of the page arrives through /api/*.
 */
export const VERSION: string = typeof SITESOLIDE_BUILD_VERSION === "string" ? SITESOLIDE_BUILD_VERSION : "dev"
