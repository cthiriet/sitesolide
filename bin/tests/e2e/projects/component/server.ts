/** A component's service, shaped as the dashboard's: its API under /api, the rest from public/. */
const PORT = Number(process.env.PORT ?? 3022);

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  routes: {
    "/api/state": () => Response.json({ service: "sample-component", at: new Date().toISOString() }),
  },
  fetch: () => new Response("not found", { status: 404 }),
});

console.log(`sample component on http://127.0.0.1:${PORT}`);
