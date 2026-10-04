/**
 * A test service that reaches outside the machine the restricted way: through
 * the egress proxy for the hosts its manifest lists, and through a connector
 * for a credential it never sees.
 *
 * Bun's fetch reads HTTPS_PROXY by itself, which the generated unit sets; the
 * connector's address arrives in SITESOLIDE_CONNECTORS.
 */
const PORT = Number(process.env.PORT ?? 3034);
const CONNECTORS = process.env.SITESOLIDE_CONNECTORS ?? "";

Bun.serve({
  port: PORT,
  routes: {
    "/api/outside": async () => Response.json({ status: (await fetch("https://api.example.com/")).status }),
    "/api/chat": async () => Response.json({ status: (await fetch(`${CONNECTORS}/chat/ping`)).status }),
  },
  fetch: () => new Response("sample-egress", { status: 200 }),
});
