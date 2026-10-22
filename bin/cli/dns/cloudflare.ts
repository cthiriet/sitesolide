/**
 * Cloudflare, the first DNS provider and the default, through the module that
 * has always spoken to its API (bin/cli/cloudflare.ts): this file only puts
 * it behind the interface of bin/cli/dns/dns.ts, so that setup and the wizard
 * treat it as any other.
 *
 * The token is CLOUDFLARE_API_TOKEN, the variable setup has always read, made
 * with Zone / Zone / Read and Zone / DNS / Edit on the zone alone. A token
 * Cloudflare cannot verify as a user token, an account-owned one, is still
 * used when it reads the zone: `verify` lets it through, and `findZone`
 * decides.
 */
import {
  CloudflareError,
  cloudflareBase,
  createRecord,
  deleteRecord,
  findZone,
  listRecords,
  updateRecord,
  verifyToken,
  CLOUDFLARE_API_VARIABLE,
  type Api,
} from "../cloudflare";
import { DnsError, type DnsEntry, type ZoneApi } from "./dns";

export const TOKEN_VARIABLE = "CLOUDFLARE_API_TOKEN";

/** What a Cloudflare API token is made of, as setup has always checked it. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,200}$/;

/** The same failure, in the words every provider uses. */
async function translated<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CloudflareError) throw new DnsError(error.message, error.kind, error.details);
    throw error;
  }
}

function cloudflare(api: Api): ZoneApi {
  let refusal: DnsError | null = null;
  return {
    async verify() {
      try {
        await translated(() => verifyToken(api));
      } catch (error) {
        // An account-owned token fails here and may still read the zone.
        if (!(error instanceof DnsError) || error.kind !== "token") throw error;
        refusal = error;
      }
    },
    async findZone(zone) {
      try {
        return await translated(() => findZone(api, zone));
      } catch (error) {
        if (refusal !== null && error instanceof DnsError && (error.kind === "token" || error.kind === "zone")) {
          throw new DnsError("the Cloudflare token is not valid", "token", [
            refusal.message,
            "create one at dash.cloudflare.com/profile/api-tokens with Zone / Zone / Read and Zone / DNS / Edit on the zone",
          ]);
        }
        throw error;
      }
    },
    listRecords: (zone, name) => translated(() => listRecords(api, zone.id, name)),
    createRecord: (zone, record) => translated(() => createRecord(api, zone.id, record)),
    updateRecord: (zone, record, content) => translated(() => updateRecord(api, zone.id, record.id, content)),
    deleteRecord: (zone, record) => translated(() => deleteRecord(api, zone.id, record.id)),
  };
}

export const CLOUDFLARE: DnsEntry = {
  name: "cloudflare",
  title: "Cloudflare",
  credentials: [{ variable: TOKEN_VARIABLE, label: "API token", secret: true, shape: TOKEN_SHAPE }],
  credentialHelp: [
    "dash.cloudflare.com/profile/api-tokens, Create Token, Edit zone DNS",
    "permissions Zone / Zone / Read and Zone / DNS / Edit, on this zone alone",
  ],
  docs: "docs/dns/cloudflare.md",
  nameServers: /\.ns\.cloudflare\.com$/,
  caddy: {
    package: "github.com/caddy-dns/cloudflare",
    module: "dns.providers.cloudflare",
    directive: [`dns cloudflare {env.${TOKEN_VARIABLE}}`],
    environment: (credentials) => ({ [TOKEN_VARIABLE]: credentials[TOKEN_VARIABLE] ?? "" }),
  },
  apiVariable: CLOUDFLARE_API_VARIABLE,
  open: (context) => cloudflare({ base: cloudflareBase(context.environment), token: context.credentials[TOKEN_VARIABLE] ?? "", fetcher: context.fetcher }),
};
