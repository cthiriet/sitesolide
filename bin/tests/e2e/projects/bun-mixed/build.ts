/** Writes public/index.html: what the deployment will send to Caddy. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const target = join(import.meta.dir, "public");
mkdirSync(target, { recursive: true });
writeFileSync(
  join(target, "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sample mixed Bun project</title>
  </head>
  <body>
    <h1>Sample mixed Bun project</h1>
    <p>This page is served by Caddy. The state comes from the service:</p>
    <pre id="state">loading...</pre>
    <script>
      fetch("/api/state")
        .then((r) => r.json())
        .then((d) => (document.getElementById("state").textContent = JSON.stringify(d, null, 2)))
        .catch((e) => (document.getElementById("state").textContent = String(e)));
    </script>
  </body>
</html>
`,
);
console.log("public/index.html built");
