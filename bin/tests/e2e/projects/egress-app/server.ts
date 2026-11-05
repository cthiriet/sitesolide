/**
 * A test service that reaches outside the machine the restricted way: through
 * the egress proxy, for the hosts its manifest lists.
 *
 * Bun's fetch reads HTTPS_PROXY by itself, which the generated unit sets.
 */
const PORT = Number(process.env.PORT ?? 3034);

Bun.serve({
  port: PORT,
  routes: {
    "/api/outside": async () => Response.json({ status: (await fetch("https://api.example.com/")).status }),
  },
  fetch: () => new Response("sample-egress", { status: 200 }),
});
