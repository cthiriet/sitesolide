// A search service whose index lives in DATA_DIR/index, written as it runs.
// POST /snapshot writes a consistent copy of it beside, in DATA_DIR/index-snapshot:
// the service sees no other writable folder, BACKUP_DIR included.
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";

const data = process.env.DATA_DIR!;
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  routes: {
    "/snapshot": {
      POST: () => {
        rmSync(join(data, "index-snapshot"), { recursive: true, force: true });
        cpSync(join(data, "index"), join(data, "index-snapshot"), { recursive: true });
        return new Response("written");
      },
    },
  },
  fetch: () => new Response("search"),
});
