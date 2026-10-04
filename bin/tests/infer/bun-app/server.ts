/**
 * A fixture of bin/tests/cli-infer.test.ts: a Bun server that reads its port
 * from the environment, as the generated unit gives it, and a public URL that
 * is not a secret. Never run.
 */
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: "127.0.0.1",
  routes: {
    "/api/hello": () => Response.json({ hello: "world", from: process.env.PUBLIC_URL ?? "" }),
  },
  fetch: () => new Response("not found", { status: 404 }),
});

console.log(`listening on 127.0.0.1:${server.port}`);
