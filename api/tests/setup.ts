/**
 * Preloaded by bunfig.toml before any test.
 *
 * `src/config.ts` freezes SITESOLIDE_ZONE at the first import: setting the
 * variable in a test file comes too late if another file has already loaded the
 * configuration, and the test would then be worth the workstation's zone, so
 * something else on another machine.
 */
process.env.SITESOLIDE_ZONE ??= "test-zone.invalid";
