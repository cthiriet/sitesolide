import { DOMAIN_TABLE_FILE, PORT } from "./src/config";
import { createTable } from "./src/domains";
import { createRoutes } from "./src/routes";

const routes = createRoutes(createTable(DOMAIN_TABLE_FILE));

const server = Bun.serve({
  port: PORT,
  // Only Caddy, from the same machine, has any business with this service.
  hostname: "127.0.0.1",

  // Without a methods object, a route would answer every verb.
  routes: {
    "/health": { GET: routes.health },
    "/interne/domaine-autorise": { GET: routes.domainAllowed },
  },

  fetch: () => new Response("404: unknown route", { status: 404 }),

  /**
   * An unforeseen error must not turn into an authorization: the 500 returned
   * here is refused by Caddy like any code other than 200.
   */
  error(err) {
    console.error(err);
    return new Response("500: server error", { status: 500 });
  },
});

console.log(`sitesolide-api → ${server.url}`);
