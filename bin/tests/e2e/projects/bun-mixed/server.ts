/**
 * A test service: the dynamic half of a mixed project.
 *
 * In production, Caddy serves public/ directly and only wakes this service for
 * what matches no file. Here, the same server does both, so that the project
 * starts on the workstation with a single `bun run dev`.
 */
const PORT = Number(process.env.PORT ?? 3031);
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? new URL("public", import.meta.url).pathname;

Bun.serve({
  port: PORT,
  routes: {
    "/api/state": () =>
      Response.json({
        service: "sample-bun",
        timestamp: new Date().toISOString(),
        // The data folder is the only one the service can write to.
        data: process.env.DATA_DIR ?? null,
      }),
  },
  fetch(request) {
    const path = new URL(request.url).pathname;
    const file = Bun.file(`${PUBLIC_DIR}${path === "/" ? "/index.html" : path}`);
    return file.exists().then((exists) =>
      exists ? new Response(file) : new Response("not found", { status: 404 }),
    );
  },
});

console.log(`sample-bun on http://127.0.0.1:${PORT}`);
