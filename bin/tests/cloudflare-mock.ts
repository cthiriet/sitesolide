/**
 * Cloudflare's API as setup speaks to it, on the loopback: what the tests put
 * in place of api.cloudflare.com, which they never reach.
 *
 * It holds a few zones and their records in memory, answers in Cloudflare's
 * envelope, `{ success, errors, result, result_info }`, and refuses any
 * request without the right token in the Authorization header. Every request
 * is recorded, with its URL and its body, so that a test can read back what
 * was written, and check that the token never travelled anywhere else.
 *
 * `pageSize` cuts every listing in pages that small, whatever `per_page` says:
 * that is how a test makes sure the module reads every page.
 */
import type { DnsRecord } from "../cli/cloudflare";

export type MockRequest = { method: string; url: string; authorization: string | null; body: string };

export type CloudflareMock = {
  base: string;
  records: DnsRecord[];
  requests: MockRequest[];
  /** The requests that changed something: POST, PATCH, DELETE. */
  writes(): MockRequest[];
  stop(): Promise<void>;
};

export type MockOptions = {
  token: string;
  zones?: { id: string; name: string }[];
  records?: Omit<DnsRecord, "id">[];
  pageSize?: number;
  /** What /user/tokens/verify says of a token it knows: an account-owned one fails there. */
  verify?: "active" | "refused";
  /** Requests answered 403, as a token without DNS / Edit gets on a write. */
  readOnly?: boolean;
  /** Every zone listed whatever the name asked: a listing whose match is not on its first page. */
  listAllZones?: boolean;
};

export function startCloudflareMock(options: MockOptions): CloudflareMock {
  const zones = options.zones ?? [{ id: "zone-1", name: "test-zone.invalid" }];
  let counter = 0;
  const records: DnsRecord[] = (options.records ?? []).map((record) => ({ ...record, id: `record-${++counter}` }));
  const requests: MockRequest[] = [];
  const pageSize = options.pageSize ?? 50;

  const failure = (status: number, code: number, message: string) => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
  const page = <T>(items: T[], url: URL) => {
    const number = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    const slice = items.slice((number - 1) * pageSize, number * pageSize);
    return Response.json({
      success: true,
      errors: [],
      messages: [],
      result: slice,
      result_info: { page: number, per_page: pageSize, count: slice.length, total_count: items.length, total_pages: Math.max(1, Math.ceil(items.length / pageSize)) },
    });
  };

  /** Records the request, then answers 401 unless it carries the token. */
  const guard = async (request: Request, handle: (url: URL, body: string) => Response | Promise<Response>): Promise<Response> => {
    const body = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
    const authorization = request.headers.get("authorization");
    requests.push({ method: request.method, url: request.url, authorization, body });
    if (authorization !== `Bearer ${options.token}`) return failure(401, 10000, "Authentication error");
    return handle(new URL(request.url), body);
  };
  const zoneOf = (id: string) => zones.find((zone) => zone.id === id);

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      "/client/v4/user/tokens/verify": {
        GET: (request) =>
          guard(request, () =>
            options.verify === "refused"
              ? failure(401, 1000, "Invalid API Token")
              : Response.json({ success: true, errors: [], messages: [], result: { id: "token-id", status: "active" } }),
          ),
      },
      "/client/v4/zones": {
        GET: (request) =>
          guard(request, (url) => page(options.listAllZones ? zones : zones.filter((zone) => zone.name === url.searchParams.get("name")), url)),
      },
      "/client/v4/zones/:zone/dns_records": {
        GET: (request) =>
          guard(request, (url) => {
            if (zoneOf(request.params.zone) === undefined) return failure(404, 7003, "Could not route to the zone");
            const name = url.searchParams.get("name");
            return page(records.filter((record) => name === null || record.name === name), url);
          }),
        POST: (request) =>
          guard(request, (_, body) => {
            if (options.readOnly) return failure(403, 10000, "Authentication error");
            const created = { ...(JSON.parse(body) as Omit<DnsRecord, "id">), id: `record-${++counter}` };
            records.push(created);
            return Response.json({ success: true, errors: [], messages: [], result: created });
          }),
      },
      "/client/v4/zones/:zone/dns_records/:record": {
        PATCH: (request) =>
          guard(request, (_, body) => {
            if (options.readOnly) return failure(403, 10000, "Authentication error");
            const record = records.find((candidate) => candidate.id === request.params.record);
            if (record === undefined) return failure(404, 81044, "Record does not exist.");
            Object.assign(record, JSON.parse(body));
            return Response.json({ success: true, errors: [], messages: [], result: record });
          }),
        DELETE: (request) =>
          guard(request, () => {
            if (options.readOnly) return failure(403, 10000, "Authentication error");
            const index = records.findIndex((candidate) => candidate.id === request.params.record);
            if (index === -1) return failure(404, 81044, "Record does not exist.");
            records.splice(index, 1);
            return Response.json({ success: true, errors: [], messages: [], result: { id: request.params.record } });
          }),
      },
    },
    fetch: () => failure(404, 7000, "No route for that URI"),
  });

  return {
    base: `${server.url.origin}/client/v4`,
    records,
    requests,
    writes: () => requests.filter((request) => request.method !== "GET"),
    stop: () => server.stop(true),
  };
}
