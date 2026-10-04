/**
 * The steward's control routes: the team registry, and the start of the
 * installer. Mounted beside the secrets routes on the same socket, by
 * dashboard/steward.ts, under `/team/` and `/control/`.
 *
 * **The steward judges every token itself.** The dashboard relays the bearer
 * it received, untouched; the steward finds it by its hash, refuses it expired
 * or revoked, decides the slug, records the ownership of a project being
 * created, writes the request and starts the installer. A compromised
 * dashboard therefore deploys nothing without a live token, and nothing beyond
 * that token's scope. Creating a token demands the dashboard unlocked, the
 * unlock token of the secrets routes: a token can run code on the machine.
 *
 * Revoking does not demand it: the worst a compromised dashboard does with it
 * is revoke every token, and an owner revoking a stolen one must not have to
 * look for their password first.
 *
 * The order of the checks is the order of the risk, as in src/secrets/steward.ts:
 * shape of the body, token, slug, state of the machine, writing.
 */
import type { RandomSource } from "../sessions";
import { servicesOf, readManifest as parseManifest } from "../../borrowed/manifest";
import { unitArgument } from "../../borrowed/unit";
import { decideSlug } from "./policy";
import {
  CONTROL_STATUSES,
  DEPLOYMENT_ID_SHAPE,
  INSTALLER_PREFIX,
  MAX_JOURNAL_LINES,
  MAX_MANIFEST_BYTES,
  type ControlErrorCode,
  type ControlFailure,
  type CreatedTokenResponse,
  type DeployResponse,
  type Identity,
  type InstallRequest,
  type LogsResponse,
  type TeamResponse,
} from "./protocol";
import { cleanLine, interrupted, judgeResult } from "./results";
import type { ControlSystem } from "./system";
import {
  authenticate,
  createToken,
  encodeTeam,
  readTeam,
  readTokenRequest,
  recordOwnership,
  refusalMessage,
  revokeToken,
  touch,
  views,
  type Team,
} from "./tokens";

export type ControlStewardOptions = {
  /** The served zone: it names the landing's directory, which no token takes. */
  zone: string;
  /** Is this the live unlock token of the secrets routes? */
  isUnlocked: (token: unknown) => Promise<boolean>;
  /** Root's uid, checked on the installer's results; null on the workstation. */
  uidRoot: number | null;
  random?: RandomSource;
  /** What `systemctl` may take, for a start that does not wait for the installer. */
  systemctlTimeoutMs?: number;
  journalTimeoutMs?: number;
  bodyTimeoutMs?: number;
  maxInFlight?: number;
  /** A `running` result whose unit stopped this long ago is an interrupted installer. */
  graceMs?: number;
};

type Handler = (req: Request) => Promise<Response>;
type Body = Record<string, unknown>;

/** The biggest body: a deployment request, its manifest included. */
export const MAX_CONTROL_BODY_BYTES = MAX_MANIFEST_BYTES + 4 * 1024;

const CURSOR_SHAPE = /^[A-Za-z0-9=;_-]{1,512}$/;

function failure(code: ControlErrorCode, message: string): Response {
  const body: ControlFailure = { error: code, message };
  return Response.json(body, { status: CONTROL_STATUSES[code] });
}

function isObject(value: unknown): value is Body {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The body, bounded in size and in time, an object with the expected fields and those alone. */
async function readBody(req: Request, fields: string[], timeoutMs: number): Promise<Body | Response> {
  if (Number(req.headers.get("content-length") ?? "0") > MAX_CONTROL_BODY_BYTES) return failure("invalid", "request body too large");
  if (req.body === null) return failure("invalid", "the request body must be a JSON object");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), timeoutMs);
  });
  try {
    for (;;) {
      const read = await Promise.race([reader.read(), late]);
      if (read === "late") {
        reader.cancel().catch(() => undefined);
        return failure("invalid", "request body too slow");
      }
      if (read.done) break;
      total += read.value.byteLength;
      if (total > MAX_CONTROL_BODY_BYTES) {
        reader.cancel().catch(() => undefined);
        return failure("invalid", "request body too large");
      }
      chunks.push(read.value);
    }
  } finally {
    clearTimeout(timer);
  }
  let object: unknown;
  try {
    object = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Bun.concatArrayBuffers(chunks)));
  } catch {
    return failure("invalid", "the request body must be a JSON object");
  }
  if (!isObject(object)) return failure("invalid", "the request body must be a JSON object");
  if (Object.keys(object).some((key) => !fields.includes(key))) return failure("invalid", "unexpected field in the request body");
  return object;
}

function errorName(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return e instanceof Error ? e.name : "unknown";
}

export function installerUnit(slug: string): string {
  return `${INSTALLER_PREFIX}@${slug}.service`;
}

export function createControlSteward(system: ControlSystem, options: ControlStewardOptions): Handler {
  const systemctlTimeoutMs = options.systemctlTimeoutMs ?? 10_000;
  const journalTimeoutMs = options.journalTimeoutMs ?? 10_000;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? 5_000;
  const maxInFlight = options.maxInFlight ?? 16;
  const graceMs = options.graceMs ?? 15_000;

  /**
   * Every change to the registry, one at a time: two creations read side by
   * side would each write a registry without the other's token.
   */
  let queue: Promise<unknown> = Promise.resolve();
  function serially<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  async function team(): Promise<Team | Response> {
    let text: string | null;
    try {
      text = await system.readTeam();
    } catch (e) {
      console.error(`control: team.json unreadable (${errorName(e)})`);
      return failure("failure", "the token registry cannot be read on the machine: the owner must check /var/lib/sitesolide-steward/team.json");
    }
    const read = readTeam(text);
    if ("unreadable" in read) {
      console.error(`control: ${read.unreadable}`);
      return failure("failure", "the token registry does not read on the machine: the owner must check /var/lib/sitesolide-steward/team.json");
    }
    return read;
  }

  /** The bearer's holder, or the refusal. The last use moves forward at most once an hour. */
  async function identify(bearer: unknown): Promise<Identity | Response> {
    const registry = await team();
    if (registry instanceof Response) return registry;
    const now = system.now();
    const result = await authenticate(registry, bearer, now);
    if (result.kind === "refused") return failure("unauthenticated", refusalMessage(result));
    const touched = touch(registry, result.identity.id, now);
    if (touched !== null) {
      // Out of the request's path: a registry that cannot be written does not
      // refuse a valid token, it only leaves its date behind.
      void serially(async () => {
        const current = await team();
        if (current instanceof Response) return;
        const again = touch(current, result.identity.id, now);
        if (again !== null) await system.writeTeam(encodeTeam(again));
      }).catch((e) => console.error(`control: last use not written (${errorName(e)})`));
    }
    return result.identity;
  }

  async function slugState(slug: string): Promise<{ exists: boolean; owner: string | null } | Response> {
    const registry = await team();
    if (registry instanceof Response) return registry;
    return { exists: await system.projectExists(slug), owner: registry.owners[slug] ?? null };
  }

  // --- the registry ------------------------------------------------------------

  async function listTokens(): Promise<Response> {
    const registry = await team();
    if (registry instanceof Response) return registry;
    const body: TeamResponse = { tokens: views(registry) };
    return Response.json(body);
  }

  async function newToken(req: Request): Promise<Response> {
    const body = await readBody(req, ["token", "label", "email", "expiresAt", "scope"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    if (!(await options.isUnlocked(body.token))) return failure("locked", "locked, unlock again");
    const request = readTokenRequest(body, system.now(), options.zone);
    if ("refusal" in request) return failure("invalid", request.refusal);
    return serially(async () => {
      // Checked again once its turn has come, as the secrets routes do.
      if (!(await options.isUnlocked(body.token))) return failure("locked", "locked, unlock again");
      const registry = await team();
      if (registry instanceof Response) return registry;
      const created = await createToken(registry, request, system.now(), options.random);
      if ("refusal" in created) return failure("invalid", created.refusal);
      await system.writeTeam(encodeTeam(created.team));
      console.log(`control: token ${created.view.id} created for ${created.view.email}`);
      const response: CreatedTokenResponse = { token: created.view, secret: created.secret };
      return Response.json(response, { status: 201 });
    });
  }

  async function revoke(req: Request): Promise<Response> {
    const body = await readBody(req, ["id"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    return serially(async () => {
      const registry = await team();
      if (registry instanceof Response) return registry;
      const result = revokeToken(registry, body.id, system.now());
      if ("refusal" in result) return failure(result.refusal === "no such token" ? "not-found" : "invalid", result.refusal);
      if (result.team !== registry) {
        await system.writeTeam(encodeTeam(result.team));
        console.log(`control: token ${result.view.id} revoked`);
      }
      return Response.json({ token: result.view });
    });
  }

  // --- deploying -----------------------------------------------------------------

  async function authenticateRoute(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    const identity = await identify(body.bearer);
    if (identity instanceof Response) return identity;
    return Response.json({ identity });
  }

  async function preflight(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    const identity = await identify(body.bearer);
    if (identity instanceof Response) return identity;
    const state = await slugState(String(body.slug ?? ""));
    if (state instanceof Response) return state;
    const decision = decideSlug(identity, body.slug, { ...state, zone: options.zone });
    if (decision.kind === "refused") return failure(decision.error, decision.message);
    return Response.json({ creating: decision.creating });
  }

  async function isActive(unit: string): Promise<boolean> {
    const answer = await system.systemctl(["is-active", unit], systemctlTimeoutMs);
    const state = answer.output.trim();
    return state === "active" || state === "activating" || state === "deactivating" || state === "reloading";
  }

  async function deploy(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "deployment", "slug", "manifest"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    const identity = await identify(body.bearer);
    if (identity instanceof Response) return identity;
    const { deployment, slug, manifest } = body;
    if (typeof deployment !== "string" || !DEPLOYMENT_ID_SHAPE.test(deployment)) return failure("invalid", "not a deployment id");
    if (typeof manifest !== "string" || new TextEncoder().encode(manifest).length > MAX_MANIFEST_BYTES) {
      return failure("invalid", "manifest: the text of sitesolide.json, 64 KiB at most");
    }

    return serially(async () => {
      const state = await slugState(String(slug ?? ""));
      if (state instanceof Response) return state;
      const decision = decideSlug(identity, slug, { ...state, zone: options.zone });
      if (decision.kind === "refused") return failure(decision.error, decision.message);
      const target = slug as string;

      // The manifest must at least name the slug it is deployed under: the
      // installer re-validates everything, this only refuses a mix-up early.
      let named: unknown;
      try {
        named = (JSON.parse(manifest) as { slug?: unknown } | null)?.slug;
      } catch {
        named = undefined;
      }
      if (named !== target) return failure("invalid", `manifest: its slug must be ${target}`);

      if (!(await system.installerInstalled())) {
        return failure("not-available", "the installer is not installed on this machine yet: the owner must run bin/deploy-installer.sh");
      }
      const unit = installerUnit(target);
      if (await isActive(unit)) return failure("busy", `a deployment of ${target} is already running: wait for it to finish, then try again`);

      if (decision.creating) {
        const registry = await team();
        if (registry instanceof Response) return registry;
        const owned = recordOwnership(registry, target, identity.id);
        if (owned !== null) await system.writeTeam(encodeTeam(owned));
      }

      const request: InstallRequest = {
        deployment,
        slug: target,
        requestedAt: system.now(),
        token: { id: identity.id, email: identity.email },
        scope: identity.scope,
        creating: decision.creating,
        manifest,
      };
      await system.writeRequest(target, `${JSON.stringify(request)}\n`);
      // --no-block: the installer can take minutes, and its progress is read
      // from its result, not from this call.
      const started = await system.systemctl(["start", "--no-block", unit], systemctlTimeoutMs);
      if (started.code !== 0) {
        console.error(`control: systemctl start ${unit} returned ${started.code}`);
        return failure("failure", `the installer of ${target} did not start: the owner must read systemctl status ${unit}`);
      }
      console.log(`control: deployment ${deployment} of ${target} started for token ${identity.id}`);
      const response: DeployResponse = { deployment, slug: target, creating: decision.creating };
      return Response.json(response, { status: 202 });
    });
  }

  async function deploymentResult(req: Request): Promise<Response> {
    const ids = new URL(req.url).searchParams.getAll("id");
    if (ids.length !== 1 || !DEPLOYMENT_ID_SHAPE.test(ids[0]!)) return failure("invalid", "name one deployment id");
    const id = ids[0]!;
    const judgement = judgeResult(await system.readResult(id), id, options.uidRoot);
    if (judgement.kind === "absent") return failure("not-found", "no result for this deployment yet");
    if (judgement.kind === "unreadable") return failure("failure", judgement.reason);
    let { result } = judgement;
    if (result.state === "running" && system.now() - result.updatedAt > graceMs && !(await isActive(installerUnit(result.slug)))) {
      result = interrupted(result, system.now());
    }
    return Response.json({ result });
  }

  async function logs(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug", "lines", "cursor"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    const identity = await identify(body.bearer);
    if (identity instanceof Response) return identity;
    const { slug, lines, cursor } = body;
    if (typeof lines !== "number" || !Number.isInteger(lines) || lines < 1 || lines > MAX_JOURNAL_LINES) {
      return failure("invalid", `lines: between 1 and ${MAX_JOURNAL_LINES}`);
    }
    if (cursor !== null && (typeof cursor !== "string" || !CURSOR_SHAPE.test(cursor))) return failure("invalid", "cursor: the value a previous answer gave");
    const state = await slugState(String(slug ?? ""));
    if (state instanceof Response) return state;
    const decision = decideSlug(identity, slug, { ...state, zone: options.zone });
    if (decision.kind === "refused") return failure(decision.error, decision.message);
    if (!state.exists) return failure("not-found", `${String(slug)} is not deployed yet`);

    const target = slug as string;
    const raw = await system.readManifest(target);
    const parsed = raw === null ? undefined : parseManifest(raw).manifest;
    const units = parsed === undefined ? [target] : servicesOf(parsed).map((service) => unitArgument(service.unit));
    if (units.length === 0) return failure("not-found", `${target} is a static site: it has no service, hence no journal`);

    const answer = await system.journal(units, lines, cursor as string | null, journalTimeoutMs);
    if (answer.code !== 0 && answer.output.trim() === "") return failure("failure", "the journal could not be read on the machine");
    let next: string | null = cursor as string | null;
    const out: string[] = [];
    for (const line of answer.output.split("\n")) {
      const found = /^-- cursor: (\S+)$/.exec(line);
      if (found !== null) {
        if (CURSOR_SHAPE.test(found[1]!)) next = found[1]!;
        continue;
      }
      if (line === "" || line === "-- No entries --") continue;
      out.push(cleanLine(line));
    }
    const response: LogsResponse = { lines: out.slice(-MAX_JOURNAL_LINES), cursor: next };
    return Response.json(response);
  }

  const routes: Record<string, Record<string, Handler>> = {
    "/team/tokens": { GET: listTokens, POST: newToken },
    "/team/revoke": { POST: revoke },
    "/control/authenticate": { POST: authenticateRoute },
    "/control/preflight": { POST: preflight },
    "/control/deploy": { POST: deploy },
    "/control/deployment": { GET: deploymentResult },
    "/control/logs": { POST: logs },
  };

  let inFlight = 0;
  return async (req) => {
    if (inFlight >= maxInFlight) {
      return Response.json({ error: "failure", message: "the steward is busy, try again in a moment" } satisfies ControlFailure, { status: 503 });
    }
    inFlight++;
    try {
      const path = new URL(req.url).pathname;
      const route = Object.hasOwn(routes, path) ? routes[path] : undefined;
      if (route === undefined) return failure("not-found", "no such route");
      const handler = Object.hasOwn(route, req.method) ? route[req.method] : undefined;
      if (handler === undefined) {
        return Response.json({ error: "invalid", message: "method not allowed" } satisfies ControlFailure, {
          status: 405,
          headers: { Allow: Object.keys(route).join(", ") },
        });
      }
      return await handler(req);
    } catch (e) {
      console.error(`control: unexpected error (${errorName(e)})`);
      return failure("failure", "unexpected error, see the steward's log on the server");
    } finally {
      inFlight--;
    }
  };
}

/** Does this path belong to the control routes? The steward's entry point routes on it. */
export function isControlPath(path: string): boolean {
  return path.startsWith("/team/") || path.startsWith("/control/");
}

