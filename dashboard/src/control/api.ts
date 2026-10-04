/**
 * The control API, `/api/v1/`, for a team member's CLI or an agent: a bearer
 * token, JSON in and out, and every refusal a stable code with a message that
 * says what to do next.
 *
 * **On the dashboard's host, and not behind the portal**, like the rest of the
 * dashboard: it is the machine's control plane already, it relays to the
 * steward already, and a CLI in a cloud sandbox has no portal cookie to show.
 *
 * **The dashboard checks, the steward decides.** Every request's bearer is
 * judged by the steward, which holds the registry; the dashboard only refuses
 * early what would be refused anyway (a manifest that does not validate, a
 * scope it can read in the identity the steward returned), so that an agent
 * learns before uploading a hundred mebibytes. A deployment happens in two
 * requests for the same reason: the manifest first, judged, then the archive,
 * streamed to the spool and handed to the installer.
 *
 * Nothing here logs a bearer, and no response carries one.
 */
import type { RandomSource } from "../sessions";
import { read } from "../read";
import type { Site } from "../state";
import { readManifest } from "../../borrowed/manifest";
import { reach, type ControlSteward, type Reached } from "./client";
import { clientAddress, type Limiter } from "./limiter";
import { allocatePorts, decideDoor, scopeRefusals } from "./policy";
import {
  CONTROL_STATUSES,
  MAX_BUNDLE_BYTES,
  MAX_JOURNAL_LINES,
  MAX_MANIFEST_BYTES,
  MAX_RUNNING,
  UPLOAD_WINDOW_MS,
  type ControlErrorCode,
  type ControlFailure,
  type DeploymentView,
  type Identity,
  type InstallerResult,
  type ProjectStatus,
} from "./protocol";
import type { Spool } from "./spool";
import type { ControlStore, DeploymentRow } from "./store";
import { bearerOf, isTokenShape } from "./tokens";
import type { Tracker } from "./tracker";

export type ApiDependencies = {
  steward: ControlSteward;
  store: ControlStore;
  spool: Spool;
  limiter: Limiter;
  tracker: Tracker;
  stateFile: string;
  publicUrl: string;
  zone: string;
  clock?: () => number;
  random?: RandomSource;
};

type Handler = (req: Request) => Promise<Response>;

export type ApiRoutes = {
  whoami: Handler;
  createDeployment: Handler;
  uploadBundle: (req: Request, id: string) => Promise<Response>;
  readDeployment: (req: Request, id: string) => Promise<Response>;
  projects: Handler;
  project: (req: Request, slug: string) => Promise<Response>;
  projectLogs: (req: Request, slug: string) => Promise<Response>;
};

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export function failure(code: ControlErrorCode, message: string, extra: { details?: string[]; wait?: number; status?: number } = {}): Response {
  const body: ControlFailure = { error: code, message };
  if (extra.details !== undefined) body.details = extra.details;
  const headers: Record<string, string> = {};
  if (extra.wait !== undefined) {
    body.wait = extra.wait;
    headers["Retry-After"] = String(extra.wait);
  }
  return json(body, extra.status ?? CONTROL_STATUSES[code], headers);
}

const unreachable = () => failure("failure", "the dashboard cannot reach the steward on the machine: try again in a minute, then tell the owner of the machine", { status: 502 });
const unavailable = () =>
  failure("not-available", "this machine does not carry the control API yet: the owner must update the steward (bin/deploy-steward.sh) and install the installer (bin/deploy-installer.sh)");
const unreadable = () => failure("failure", "the steward sent an unreadable answer: tell the owner of the machine", { status: 502 });

/** The steward's refusal, passed on with its code and message; the other outcomes said in the API's words. */
function relayed(reached: Reached): Response {
  if (reached.kind === "unreachable") return unreachable();
  if (reached.kind === "unavailable") return unavailable();
  if (reached.kind === "unreadable") return unreadable();
  const code = reached.body.error as ControlErrorCode;
  const known = Object.hasOwn(CONTROL_STATUSES, code) && code !== "locked";
  if (!known) return failure("failure", String(reached.body.message), { status: 502 });
  return failure(code, String(reached.body.message), { status: reached.status >= 500 ? 502 : CONTROL_STATUSES[code] });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON body, bounded, or null. Read piece by piece: a chunked body has no length to trust. */
async function readJson(req: Request, max: number): Promise<Record<string, unknown> | null | "too-large"> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return "too-large";
  if (req.body === null) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      total += read.value.byteLength;
      if (total > max) {
        await reader.cancel();
        return "too-large";
      }
      chunks.push(read.value);
    }
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Bun.concatArrayBuffers(chunks)));
    return isObject(body) ? body : null;
  } catch {
    return null;
  }
}

function newDeploymentId(random: RandomSource): string {
  return [...random(12)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createApiRoutes(dependencies: ApiDependencies): ApiRoutes {
  const { steward, store, spool, limiter, tracker } = dependencies;
  const clock = dependencies.clock ?? Date.now;
  const random: RandomSource = dependencies.random ?? ((bytes) => crypto.getRandomValues(new Uint8Array(bytes)));

  /**
   * The request's holder, or the refusal. Rate limited per address before the
   * steward is asked anything; only a wrong token counts as a failure, not a
   * missing header, which guesses nothing.
   */
  async function authenticated(req: Request): Promise<{ identity: Identity; bearer: string } | Response> {
    const address = clientAddress(req);
    const wait = limiter.wait(address);
    if (wait > 0) {
      return failure("too-many-attempts", "too many failed authentications from this address: wait before trying again", { wait: Math.ceil(wait / 1000) });
    }
    const bearer = bearerOf(req.headers.get("authorization"));
    if (bearer === null) {
      return failure("unauthenticated", "missing token: send Authorization: Bearer <token>, the value shown once when the owner of the machine created it");
    }
    if (!isTokenShape(bearer)) {
      limiter.failure(address);
      return failure("unauthenticated", "this is not a sitesolide token: it starts with sst_ and was shown once when the owner of the machine created it");
    }
    const reached = await reach(() => steward.authenticate(bearer), [bearer]);
    if (reached.kind === "received" && reached.status === 401) limiter.failure(address);
    if (reached.kind !== "received" || reached.status !== 200) return relayed(reached);
    const identity = reached.body.identity as Identity | undefined;
    if (!isObject(identity) || typeof identity.id !== "string" || !isObject(identity.scope)) return unreadable();
    limiter.success(address);
    return { identity, bearer };
  }

  function uploadUrl(id: string): string {
    return `${dependencies.publicUrl}/api/v1/deployments/${id}/bundle`;
  }

  function view(row: DeploymentRow, result: InstallerResult | null, after: number): DeploymentView {
    const log = result?.log ?? [];
    const from = Math.min(Math.max(0, after), log.length);
    return {
      id: row.id,
      slug: row.slug,
      state: row.state,
      creating: row.creating,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      uploadUrl: row.state === "awaiting-bundle" ? uploadUrl(row.id) : null,
      log: log.slice(from),
      next: log.length,
      error:
        result?.error ??
        (row.message === null || row.state === "succeeded"
          ? null
          : { code: row.message.split(":")[0] ?? "failure", message: row.message.slice(row.message.indexOf(":") + 1).trim() }),
      url: result?.url ?? null,
      allocated: result?.allocated ?? [],
    };
  }

  /** The machine's snapshot, for the door a project carries and its status. */
  async function snapshotSites(): Promise<{ sites: Map<string, Site>; age: number | null }> {
    const reading = await read(dependencies.stateFile, clock());
    if (!reading.present) return { sites: new Map(), age: null };
    return { sites: new Map(reading.snapshot.sites.map((site) => [site.slug, site])), age: reading.age };
  }

  function statusOf(slug: string, identity: Identity, site: Site | undefined, age: number | null): ProjectStatus {
    const access = identity.owned.includes(slug) ? "owned" : "granted";
    if (site === undefined) {
      return { slug, access, deployed: false, type: null, url: null, portal: null, services: [], deployedAt: null, snapshotAge: age };
    }
    return {
      slug,
      access,
      deployed: true,
      type: site.type === "no-manifest" ? null : site.type,
      url: `https://${site.address}/`,
      portal: { wanted: site.portal.wanted, installed: site.portal.installed },
      services: site.services.map((service) => ({
        name: service.name,
        unit: service.unit,
        port: service.port,
        state: service.service?.active ?? "unknown",
        subState: service.service?.subState ?? "unknown",
        restarts: service.service?.restarts ?? null,
        since: service.service?.since ?? null,
        memory: service.service?.memory ?? null,
      })),
      deployedAt: site.deployed,
      snapshotAge: age,
    };
  }

  const visible = (identity: Identity, slug: string) => identity.owned.includes(slug) || identity.scope.slugs.includes(slug);

  /** The deployment, if this token created it; any other id reads as unknown. */
  function ownDeployment(identity: Identity, id: string): DeploymentRow | Response {
    const row = /^[0-9a-f]{24}$/.test(id) ? store.deployment(id) : null;
    if (row === null || row.tokenId !== identity.id) return failure("not-found", "no such deployment for this token");
    return row;
  }

  return {
    async whoami(req) {
      const auth = await authenticated(req);
      if (auth instanceof Response) return auth;
      return json({ identity: auth.identity });
    },

    async createDeployment(req) {
      const auth = await authenticated(req);
      if (auth instanceof Response) return auth;
      const { identity, bearer } = auth;

      const body = await readJson(req, MAX_MANIFEST_BYTES + 1024);
      if (body === "too-large") return failure("too-large", "the manifest is over 64 KiB");
      if (body === null) return failure("invalid", 'send a JSON object: { "manifest": <the content of sitesolide.json> }');
      if (Object.keys(body).some((key) => key !== "manifest")) return failure("invalid", 'unexpected field: send { "manifest": ... } and nothing else');
      const given = body.manifest;
      const text = typeof given === "string" ? given : isObject(given) ? `${JSON.stringify(given, null, 2)}\n` : null;
      if (text === null) return failure("invalid", "manifest: the content of sitesolide.json, as an object or as its text");
      if (new TextEncoder().encode(text).length > MAX_MANIFEST_BYTES) return failure("too-large", "the manifest is over 64 KiB");

      // The same validation the CLI runs, on a copy whose missing ports are
      // filled in: the installer chooses them on the machine, and their
      // absence is no reason to refuse.
      let object: unknown;
      try {
        object = JSON.parse(text);
      } catch (error) {
        return failure("invalid-manifest", "sitesolide.json is not JSON", { details: [(error as Error).message] });
      }
      if (!isObject(object)) return failure("invalid-manifest", "sitesolide.json must contain an object", { details: ["sitesolide.json must contain an object"] });
      const filled = allocatePorts(object, new Set(), null);
      const candidate = "refusal" in filled ? object : filled.object;
      const { manifest, errors } = readManifest(JSON.stringify(candidate));
      if (manifest === undefined || errors.length > 0) {
        return failure("invalid-manifest", "sitesolide.json is refused: fix every point in details, then deploy again", { details: errors });
      }
      const slug = manifest.slug;
      const refusals = scopeRefusals(manifest, identity.scope, slug);
      const { sites } = await snapshotSites();
      const site = sites.get(slug);
      const door = decideDoor(manifest, identity.scope, site === undefined ? null : site.portal.wanted);
      if ("refusal" in door) refusals.push(door.refusal);
      if (refusals.length > 0) {
        return failure("invalid-manifest", "your token may not deploy this manifest: fix every point in details, or ask the owner of the machine", {
          details: refusals,
        });
      }

      const preflight = await reach(() => steward.preflight(bearer, slug), [bearer]);
      if (preflight.kind !== "received" || preflight.status !== 200) return relayed(preflight);
      const creating = preflight.body.creating === true;

      const now = clock();
      const active = store.activeForSlug(slug);
      if (active !== null) {
        // A deployment still waiting for its archive gives way to a new one
        // from the same token, whose build failed in between, or once its
        // window has passed; a running one never does.
        const replaceable =
          active.state === "awaiting-bundle" && (active.tokenId === identity.id || now - active.createdAt > UPLOAD_WINDOW_MS);
        if (!replaceable) return failure("busy", `a deployment of ${slug} is already ${active.state === "running" ? "running" : "waiting for its archive"}: wait for it to finish, then try again`);
        if (store.finish(active.id, "expired", now, "replaced by a newer deployment before its archive arrived")) spool.remove(active.id);
      }
      if (store.countActive() >= MAX_RUNNING) return failure("busy", "the machine is already running several deployments: try again in a minute");

      const id = newDeploymentId(random);
      store.createDeployment({ id, tokenId: identity.id, email: identity.email, slug, creating, manifest: text, createdAt: now });
      const row = store.deployment(id)!;
      return json({ deployment: view(row, null, 0) }, 201, { Location: `/api/v1/deployments/${id}` });
    },

    async uploadBundle(req, id) {
      const auth = await authenticated(req);
      if (auth instanceof Response) return auth;
      const { identity, bearer } = auth;
      const row = ownDeployment(identity, id);
      if (row instanceof Response) return row;
      if (row.state !== "awaiting-bundle") {
        return failure("invalid", `this deployment is ${row.state}: create a new one with POST /api/v1/deployments`, { status: 409 });
      }
      const now = clock();
      if (now - row.createdAt > UPLOAD_WINDOW_MS) {
        if (store.finish(row.id, "expired", now, "the archive never arrived")) spool.remove(row.id);
        return failure("expired", "the archive arrived after the 15 minutes this deployment waited: create a new one");
      }

      const receipt = await spool.receive(row.id, req.body, MAX_BUNDLE_BYTES);
      if (receipt.kind !== "received") {
        const refusals = {
          "too-large": () => failure("too-large", "the archive is over 100 MiB compressed: exclude what the site does not need (dependencies, caches) in sitesolide.json"),
          "not-gzip": () => failure("invalid", "the archive must be a gzip-compressed tar holding app/ and public/: sitesolide deploy builds it"),
          empty: () => failure("invalid", "the archive is empty"),
          interrupted: () => failure("invalid", "the upload was interrupted: send the archive again"),
        } as const;
        return refusals[receipt.kind]();
      }

      const reached = await reach(() => steward.deploy({ bearer, deployment: row.id, slug: row.slug, manifest: row.manifest }), [bearer]);
      if (reached.kind !== "received" || reached.status !== 202) {
        const response = relayed(reached);
        const answer = (await response.clone().json()) as ControlFailure;
        tracker.fail(row, answer.message, answer.error);
        return response;
      }
      store.markRunning(row.id, clock());
      store.recordAudit({
        at: clock(),
        actor: `token:${identity.id}`,
        action: "deploy.start",
        target: row.slug,
        detail: { email: identity.email, deployment: row.id, creating: row.creating, bytes: receipt.bytes },
      });
      return json({ deployment: view(store.deployment(row.id)!, null, 0) }, 202);
    },

    async readDeployment(req, id) {
      const auth = await authenticated(req);
      if (auth instanceof Response) return auth;
      const found = ownDeployment(auth.identity, id);
      if (found instanceof Response) return found;
      let row: DeploymentRow = found;
      const deploymentId = row.id;
      const afterParameter = new URL(req.url).searchParams.get("after");
      const after = afterParameter === null ? 0 : Number(afterParameter);
      if (!Number.isInteger(after) || after < 0) return failure("invalid", "after: the `next` value of the previous answer, a whole number");

      let result: InstallerResult | null = null;
      if (row.state === "running" || row.state === "succeeded" || row.state === "failed") {
        const reached = await reach(() => steward.deployment(deploymentId));
        if (reached.kind === "unavailable") return unavailable();
        if (reached.kind === "received" && reached.status === 200 && isObject(reached.body.result)) {
          result = reached.body.result as InstallerResult;
          if (row.state === "running" && result.state !== "running") {
            tracker.settle(row, result);
            row = store.deployment(deploymentId)!;
          }
        }
      }
      return json({ deployment: view(row, result, after) });
    },

    async projects(req) {
      const auth = await authenticated(req);
      if (auth instanceof Response) return auth;
      const { identity } = auth;
      const { sites, age } = await snapshotSites();
      const slugs = [...new Set([...identity.owned, ...identity.scope.slugs])].sort();
      return json({ projects: slugs.map((slug) => statusOf(slug, identity, sites.get(slug), age)) });
    },

    async project(req, slug) {
      const auth = await authenticated(req);
      if (auth instanceof Response) return auth;
      if (!visible(auth.identity, slug)) return failure("not-found", `no project ${slug.slice(0, 63)} for this token`);
      const { sites, age } = await snapshotSites();
      return json({ project: statusOf(slug, auth.identity, sites.get(slug), age) });
    },

    async projectLogs(req, slug) {
      const auth = await authenticated(req);
      if (auth instanceof Response) return auth;
      if (!visible(auth.identity, slug)) return failure("not-found", `no project ${slug.slice(0, 63)} for this token`);
      const parameters = new URL(req.url).searchParams;
      const lines = Number(parameters.get("lines") ?? "100");
      if (!Number.isInteger(lines) || lines < 1 || lines > MAX_JOURNAL_LINES) return failure("invalid", `lines: between 1 and ${MAX_JOURNAL_LINES}`);
      const cursor = parameters.get("cursor");
      const reached = await reach(() => steward.logs({ bearer: auth.bearer, slug, lines, cursor }), [auth.bearer]);
      if (reached.kind !== "received" || reached.status !== 200) return relayed(reached);
      return json({ lines: reached.body.lines, cursor: reached.body.cursor });
    },
  };
}
