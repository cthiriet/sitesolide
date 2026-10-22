/**
 * Preloaded by bunfig.toml before any test.
 *
 * `src/config.ts` freezes SITESOLIDE_ZONE at the first import: setting the
 * variable in a test file comes too late if another file has already loaded the
 * configuration, and the test would then be worth the workstation's zone, so
 * something else on another machine.
 *
 * The zone's TLS policy and its list of sites are frozen the same way, and
 * aimed at a folder that does not exist: a workstation that carries an
 * /etc/caddy of its own must not decide what a test of the table sees. The
 * tests of the zone hand their own files to createZone.
 */
process.env.SITESOLIDE_ZONE ??= "test-zone.invalid";
process.env.TLS_ZONE_FILE ??= "/nonexistent/sitesolide-tests/tls-zone.caddy";
process.env.ZONE_NAMES_FILE ??= "/nonexistent/sitesolide-tests/zone-names";
