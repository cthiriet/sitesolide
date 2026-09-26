Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: () => new Response("service") });
