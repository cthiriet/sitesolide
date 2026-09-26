/**
 * A Bun service, as a deployed project runs it.
 *
 * Three things come from the environment, put there by the generated systemd
 * unit: the port to listen on, the directory this service may write to, and the
 * one holding its public files. Nothing else is assumed about the machine.
 *
 * Only `/api/*` reaches this process; the manifest says so in `routes`. The
 * rest of the site is served by Caddy from `public/`, without waking Bun.
 */
const PORT = Number(process.env.PORT ?? 3040);
const DATA_DIR = process.env.DATA_DIR ?? "./data";

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  routes: {
    "/api/hello": () => Response.json({ hello: "world", at: new Date().toISOString() }),

    "/api/counter": {
      // A trivial bit of state, to show where a project may write: its own data
      // directory, and nowhere else. The unit mounts everything else read-only.
      POST: async () => {
        const file = Bun.file(`${DATA_DIR}/counter`);
        const current = (await file.exists()) ? Number(await file.text()) : 0;
        await Bun.write(file, String(current + 1));
        return Response.json({ count: current + 1 });
      },
    },
  },

  fetch: () => new Response("not found", { status: 404 }),
});

console.log(`listening on 127.0.0.1:${server.port}`);
