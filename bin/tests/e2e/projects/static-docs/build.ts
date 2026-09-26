/** Builds dist/ from src/: the minimum a doc generator would do. */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const source = join(import.meta.dir, "src");
const target = join(import.meta.dir, "dist");
mkdirSync(target, { recursive: true });

for (const file of readdirSync(source)) {
  if (!file.endsWith(".md")) continue;
  const markdown = Bun.file(join(source, file));
  const title = (await markdown.text()).split("\n")[0]?.replace(/^#\s*/, "") ?? "Documentation";
  const body = (await markdown.text())
    .split("\n\n")
    .map((block) => (block.startsWith("#") ? `<h1>${title}</h1>` : `<p>${block.trim()}</p>`))
    .join("\n    ");

  writeFileSync(
    join(target, file.replace(/\.md$/, ".html")),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body>
    ${body}
  </body>
</html>
`,
  );
}
console.log("dist/ built");
