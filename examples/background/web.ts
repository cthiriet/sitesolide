/**
 * The page: what the worker and the scheduled run wrote, read from the
 * database the three share. It is the project's only public service, so it
 * receives every path, and must answer `/` itself: deploy checks that it does.
 */
import { openDatabase } from "./database";

const PORT = Number(process.env.PORT ?? 3041);

const db = openDatabase();
const worker = db.query<{ beats: number; last_beat: string | null }, []>("SELECT beats, last_beat FROM worker WHERE id = 1");
const runs = db.query<{ at: string; beats: number }, []>("SELECT at, beats FROM runs ORDER BY id DESC LIMIT 12");

/** Every value here was written by this project's own code, numbers and ISO dates: nothing to escape. */
function page(): string {
  const state = worker.get();
  const rows = runs.all().map((run) => `<tr><td>${run.at}</td><td>${run.beats}</td></tr>`);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Background</title>
    <style>
      body { font: 16px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; }
      table { border-collapse: collapse; }
      td, th { padding: 0.2em 1em 0.2em 0; text-align: left; }
    </style>
  </head>
  <body>
    <h1>Work that runs without a visitor.</h1>
    <p>
      The worker records a beat every ten seconds:
      ${state?.beats ?? 0} so far${state?.last_beat ? `, the last at ${state.last_beat}` : ""}.
    </p>
    <p>
      The scheduled run records the worker's count every quarter of an hour.
      ${rows.length === 0 ? "None yet: the first comes at the next quarter of an hour." : ""}
    </p>
    ${rows.length === 0 ? "" : `<table><tr><th>Run</th><th>Beats</th></tr>${rows.join("")}</table>`}
  </body>
</html>
`;
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  routes: {
    "/": () => new Response(page(), { headers: { "Content-Type": "text/html; charset=utf-8" } }),
  },

  fetch: () => new Response("not found", { status: 404 }),
});

console.log(`listening on 127.0.0.1:${server.port}`);
