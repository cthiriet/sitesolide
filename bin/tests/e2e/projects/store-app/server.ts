/**
 * A test service that keeps its secrets in the project's store.
 *
 * Its variables arrive through the environment, read by systemd from
 * /etc/sitesolide/projects/sample-store/env, and its file under
 * $CREDENTIALS_DIRECTORY, as files_signing.pem: the CLI never reads either,
 * nothing of them is written into this repository, and no log shows them.
 */
import { existsSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 3036);
const signing = `${process.env.CREDENTIALS_DIRECTORY ?? "/nonexistent"}/files_signing.pem`;

Bun.serve({
  port: PORT,
  routes: {
    // Presence alone, never a value.
    "/api/state": () =>
      Response.json({
        service: "sample-store",
        session: Boolean(process.env.SESSION_SECRET),
        mail: Boolean(process.env.MAIL_API_KEY),
        signing: existsSync(signing),
      }),
  },
  fetch: () => new Response("sample-store", { status: 200 }),
});
