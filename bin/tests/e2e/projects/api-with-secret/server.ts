/**
 * A test service that expects a credential.
 *
 * The key arrives through the environment, deposited by systemd from
 * /etc/sitesolide/sample-secret.env: it is never read by the CLI, never written
 * into this repository, and appears in no log.
 */
const PORT = Number(process.env.PORT ?? 3033);

Bun.serve({
  port: PORT,
  routes: {
    // The value does not get out: only its presence is announced.
    "/api/state": () => Response.json({ service: "sample-secret", key: Boolean(process.env.API_KEY) }),
  },
  fetch: () => new Response("sample-secret", { status: 200 }),
});
