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
 * **A member mints their own tokens**, under their own unlock, never stronger
 * than their roles (src/members/tokens.ts): this steward reads the members
 * registry when one is minted, and again at every use of it, so that a role
 * lowered, the create right taken back or a member removed holds from the
 * next request. A project a member's token creates makes that member its
 * Project admin, recorded with the token's ownership. And a member removed
 * takes their tokens with them.
 *
 * **A token's sharing reaches the portal from here**, as root, through the
 * relay a Project admin's sharing takes: the portal believes an actor other
 * than `owner` from root alone, so the dashboard can no longer name a token
 * as the author of a change it made itself.
 *
 * The order of the checks is the order of the risk, as in src/secrets/steward.ts:
 * shape of the body, token, slug, state of the machine, writing.
 */
import type { RandomSource } from "../sessions";
import { isValidSlug, servicesOf, readManifest as parseManifest } from "../../borrowed/manifest";
import { unitArgument } from "../../borrowed/unit";
import { may, powerRefusal, roleDetail } from "../members/powers";
import type { MemberEvent, MemberPrincipal } from "../members/steward";
import { deployRefusal, MAX_TOKENS_PER_MEMBER, mintRefusals, narrowIdentity, scopeText, type MemberRights } from "../members/tokens";
import { decideSlug, reservedReason, type SlugDecision } from "./policy";
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
  forgetOwnership,
  liveTokensOf,
  readTeam,
  readTokenRequest,
  recordOwnership,
  refusalMessage,
  revokeMemberTokens,
  revokeToken,
  touch,
  views,
  type Team,
} from "./tokens";

/**
 * What this steward asks the members routes (src/members/steward.ts) for a
 * member's tokens: their session and unlock, their rights as the registry
 * reads now, and the project one of their tokens creates.
 */
export type MemberAuthority = {
  /** The member behind a session, and their unlock when it is not null; or the refusal to send back. */
  authorize: (session: unknown, unlock: unknown | null) => Promise<MemberPrincipal | Response>;
  unlockedUntil: (session: unknown) => Promise<number | null>;
  /** Their rights now; null: no member; a Response: the registry does not read. */
  rights: (email: string) => Promise<MemberRights | null | Response>;
  /** They become Project admin of what their token creates, journaled; a Response when it cannot be recorded. */
  recordCreation: (slug: string, email: string, tokenId: string) => Promise<Response | null>;
  journal: (event: MemberEvent) => Promise<void>;
  /** A refusal, bounded per minute. */
  journalRefusal: (event: MemberEvent) => Promise<void>;
};

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
  /**
   * The dashboard's members, for their own tokens. Absent, a steward built
   * without them: a member's token is refused, and the member routes do not
   * exist.
   */
  members?: MemberAuthority;
  /**
   * A token's sharing, handed to the portal as root through the relay, the
   * actor `token:<id>` (src/members/actions.ts, `createSharing`). Absent,
   * sharing by token says the relay is missing.
   */
  share?: (slug: string, policy: Record<string, unknown>, actor: string) => Promise<Response>;
};

type Handler = (req: Request) => Promise<Response>;
type Body = Record<string, unknown>;

/**
 * The handler of the dashboard's socket, what the members routes ask of it, a
 * member removed, every token of theirs revoked, `actor` the one who removed
 * them, and the handler of the owner's socket, which only root opens.
 */
export type ControlHandler = Handler & {
  revokeMember: (email: string, actor: string) => Promise<number>;
  /** `DELETE /team/project`: a project removed from the machine, its token ownership forgotten. */
  owner: Handler;
};

/** Who a bearer is, narrowed to their member's rights for a member's token. */
type Holder = { identity: Identity; rights: MemberRights | null };

/** The biggest body: a deployment request, its manifest included. */
export const MAX_CONTROL_BODY_BYTES = MAX_MANIFEST_BYTES + 4 * 1024;

const CURSOR_SHAPE = /^[A-Za-z0-9=;_-]{1,512}$/;

function failure(code: ControlErrorCode, message: string, details?: string[]): Response {
  const body: ControlFailure = details === undefined ? { error: code, message } : { error: code, message, details };
  return Response.json(body, { status: CONTROL_STATUSES[code] });
}

/** What the journal keeps of a reason: one line, bounded. */
function line(text: string): string {
  return text.length <= 150 ? text : `${text.slice(0, 149)}…`;
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

export function createControlSteward(system: ControlSystem, options: ControlStewardOptions): ControlHandler {
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

  /**
   * The bearer's holder, or the refusal. A member's token is narrowed to the
   * member's rights as the registry reads now, and refused once they are no
   * member. The last use moves forward at most once an hour.
   */
  async function identify(bearer: unknown): Promise<Holder | Response> {
    const registry = await team();
    if (registry instanceof Response) return registry;
    const now = system.now();
    const result = await authenticate(registry, bearer, now);
    if (result.kind === "refused") return failure("unauthenticated", refusalMessage(result));
    let holder: Holder = { identity: result.identity, rights: null };
    const member = result.identity.member;
    if (member !== null) {
      if (options.members === undefined) {
        return failure("unauthenticated", "this token is a member's, and this steward does not know members: the owner must run sitesolide upgrade");
      }
      const rights = await options.members.rights(member);
      if (rights instanceof Response) return rights;
      if (rights === null) {
        return failure("unauthenticated", `this token belongs to ${member}, who is no longer a member of this dashboard: it is refused`);
      }
      holder = { identity: narrowIdentity(result.identity, rights), rights };
    }
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
    return holder;
  }

  /**
   * May this holder deploy this slug, and would it create it? For a member's
   * token, the member's role first, or the create right for a new project,
   * then the token's own rule, its refusals said in a member's words: the
   * Team page is where they mint another.
   */
  function judgeSlug(holder: Holder, slug: unknown, state: { exists: boolean; owner: string | null }): SlugDecision {
    const { rights } = holder;
    const shaped = typeof slug === "string" && isValidSlug(slug) && reservedReason(slug, options.zone) === null;
    if (rights !== null && shaped) {
      const refusal = deployRefusal(rights, slug as string, state.exists);
      if (refusal !== null) return { kind: "refused", error: "out-of-scope", message: refusal };
    }
    const decision = decideSlug(holder.identity, slug, { ...state, zone: options.zone });
    if (rights === null || decision.kind !== "refused" || decision.error !== "out-of-scope") return decision;
    return {
      kind: "refused",
      error: "out-of-scope",
      message: state.exists
        ? `${String(slug)} is not among this token's projects: mint a token for it from the dashboard's Team page`
        : "this token may not create projects: mint one that may from the dashboard's Team page",
    };
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
    // The owner's route, under the owner's unlock: a member mints theirs at /team/member/tokens.
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
    const holder = await identify(body.bearer);
    if (holder instanceof Response) return holder;
    return Response.json({ identity: holder.identity });
  }

  async function preflight(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    const holder = await identify(body.bearer);
    if (holder instanceof Response) return holder;
    const state = await slugState(String(body.slug ?? ""));
    if (state instanceof Response) return state;
    const decision = judgeSlug(holder, body.slug, state);
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
    const holder = await identify(body.bearer);
    if (holder instanceof Response) return holder;
    const { identity } = holder;
    const { deployment, slug, manifest } = body;
    if (typeof deployment !== "string" || !DEPLOYMENT_ID_SHAPE.test(deployment)) return failure("invalid", "not a deployment id");
    if (typeof manifest !== "string" || new TextEncoder().encode(manifest).length > MAX_MANIFEST_BYTES) {
      return failure("invalid", "manifest: the text of sitesolide.json, 64 KiB at most");
    }

    return serially(async () => {
      const state = await slugState(String(slug ?? ""));
      if (state instanceof Response) return state;
      const decision = judgeSlug(holder, slug, state);
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
        return failure("not-available", "the installer is not installed on this machine yet: the owner must run sitesolide setup again for this machine, without --minimal");
      }
      const unit = installerUnit(target);
      if (await isActive(unit)) return failure("busy", `a deployment of ${target} is already running: wait for it to finish, then try again`);

      if (decision.creating) {
        // A member's creation first: they become its Project admin before the
        // token owns it, so that a refusal there leaves no slug held for
        // nobody to deploy.
        if (identity.member !== null && options.members !== undefined) {
          const recorded = await options.members.recordCreation(target, identity.member, identity.id);
          if (recorded !== null) return recorded;
        }
        const registry = await team();
        if (registry instanceof Response) return registry;
        const owned = recordOwnership(registry, target, identity.id);
        if (owned !== null) await system.writeTeam(encodeTeam(owned));
      }

      const request: InstallRequest = {
        deployment,
        slug: target,
        requestedAt: system.now(),
        token: { id: identity.id, email: identity.email, member: identity.member },
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
    const holder = await identify(body.bearer);
    if (holder instanceof Response) return holder;
    const { slug, lines, cursor } = body;
    if (typeof lines !== "number" || !Number.isInteger(lines) || lines < 1 || lines > MAX_JOURNAL_LINES) {
      return failure("invalid", `lines: between 1 and ${MAX_JOURNAL_LINES}`);
    }
    if (cursor !== null && (typeof cursor !== "string" || !CURSOR_SHAPE.test(cursor))) return failure("invalid", "cursor: the value a previous answer gave");
    const state = await slugState(String(slug ?? ""));
    if (state instanceof Response) return state;
    const decision = judgeSlug(holder, slug, state);
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

  // --- sharing ---------------------------------------------------------------------

  /**
   * A token's sharing, judged here and handed to the portal as root: the
   * project the token reaches, and for a member's token the member's own
   * power to share it, a Project admin's; then the portal's rules, the site's
   * door and the domains it admits (src/members/actions.ts).
   */
  async function sharing(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug", "mode", "people", "domains"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    const holder = await identify(body.bearer);
    if (holder instanceof Response) return holder;
    const { identity, rights } = holder;
    const { slug } = body;
    if (typeof slug !== "string" || !isValidSlug(slug)) return failure("invalid", "slug: lowercase letters, digits and dashes");
    if (!identity.owned.includes(slug) && !identity.scope.slugs.includes(slug)) return failure("not-found", `no project ${slug} for this token`);
    if (rights !== null) {
      const role = Object.hasOwn(rights.roles, slug) ? rights.roles[slug]! : null;
      if (!may(role, "sharing")) {
        await options.members?.journalRefusal({ operation: "sharing", result: "rejects", actor: rights.email, member: rights.email, slug, detail: `token ${identity.id}, ${roleDetail(role)}` });
        return failure("out-of-scope", powerRefusal(rights.email, role, slug, "sharing"));
      }
    }
    if (options.share === undefined) return failure("not-available", "this steward cannot reach the portal: the owner must run sitesolide upgrade");
    return options.share(slug, { mode: body.mode, people: body.people, domains: body.domains }, `token:${identity.id}`);
  }

  // --- a member's own tokens ------------------------------------------------------

  const members = options.members;

  async function memberList(req: Request): Promise<Response> {
    if (members === undefined) return failure("not-found", "no such route");
    const body = await readBody(req, ["session"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    const principal = await members.authorize(body.session, null);
    if (principal instanceof Response) return principal;
    const registry = await team();
    if (registry instanceof Response) return registry;
    return Response.json({
      tokens: views(registry).filter((view) => view.member === principal.email),
      rights: { roles: principal.roles, create: principal.create },
      until: await members.unlockedUntil(body.session),
    });
  }

  /**
   * A member's token: under their own unlock, with their email, within their
   * roles as the registry reads once its turn has come. A refusal names every
   * reason, and enters the journal.
   */
  async function memberCreate(req: Request): Promise<Response> {
    if (members === undefined) return failure("not-found", "no such route");
    const body = await readBody(req, ["session", "token", "label", "expiresAt", "scope"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    const principal = await members.authorize(body.session, body.token);
    if (principal instanceof Response) return principal;
    const request = readTokenRequest({ label: body.label, email: principal.email, expiresAt: body.expiresAt, scope: body.scope }, system.now(), options.zone);
    if ("refusal" in request) return failure("invalid", request.refusal);
    return serially(async () => {
      const again = await members.authorize(body.session, body.token);
      if (again instanceof Response) return again;
      const email = again.email;
      if (email !== principal.email) return failure("out-of-scope", "this session is someone else's now");
      const refusals = mintRefusals(request.scope, { email, roles: again.roles, create: again.create });
      if (refusals.length > 0) {
        await members.journalRefusal({ operation: "token.create", result: "rejects", actor: email, member: email, detail: line(refusals[0]!) });
        return failure("out-of-scope", refusals.join("; "), refusals);
      }
      const registry = await team();
      if (registry instanceof Response) return registry;
      if (liveTokensOf(registry, email, system.now()).length >= MAX_TOKENS_PER_MEMBER) {
        return failure("invalid", `${MAX_TOKENS_PER_MEMBER} live tokens per member at most: revoke one you no longer use`);
      }
      const created = await createToken(registry, request, system.now(), options.random, email);
      if ("refusal" in created) return failure("invalid", created.refusal);
      await system.writeTeam(encodeTeam(created.team));
      await members.journal({ operation: "token.create", result: "ok", actor: email, member: email, detail: line(`${created.view.id}: ${scopeText(created.view.scope)}`) });
      console.log(`control: token ${created.view.id} created by member ${email}`);
      const response: CreatedTokenResponse = { token: created.view, secret: created.secret };
      return Response.json(response, { status: 201 });
    });
  }

  /** A member revokes a token of theirs, no unlock, as the owner does; anyone else's reads as unknown. */
  async function memberRevoke(req: Request): Promise<Response> {
    if (members === undefined) return failure("not-found", "no such route");
    const body = await readBody(req, ["session", "id"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    const principal = await members.authorize(body.session, null);
    if (principal instanceof Response) return principal;
    return serially(async () => {
      const registry = await team();
      if (registry instanceof Response) return registry;
      const record = registry.tokens.find((candidate) => candidate.id === body.id);
      if (record === undefined || record.member !== principal.email) return failure("not-found", "no such token of yours");
      const result = revokeToken(registry, body.id, system.now());
      if ("refusal" in result) return failure("invalid", result.refusal);
      if (result.team !== registry) {
        await system.writeTeam(encodeTeam(result.team));
        await members.journal({ operation: "token.revoke", result: "ok", actor: principal.email, member: principal.email, detail: result.view.id });
        console.log(`control: token ${result.view.id} revoked by member ${principal.email}`);
      }
      return Response.json({ token: result.view });
    });
  }

  /** Every live token of a member removed, revoked, journaled under whoever removed them. */
  function revokeMember(email: string, actor: string): Promise<number> {
    return serially(async () => {
      const registry = await team();
      if (registry instanceof Response) return 0;
      const result = revokeMemberTokens(registry, email, system.now());
      if (result.revoked.length === 0) return 0;
      await system.writeTeam(encodeTeam(result.team));
      const ids = result.revoked.map((view) => view.id).join(", ");
      await members?.journal({ operation: "token.revoke", result: "ok", actor, member: email, detail: line(`${ids}: ${email} is no longer a member`) });
      console.log(`control: ${result.revoked.length} token(s) of ${email} revoked, no longer a member`);
      return result.revoked.length;
    });
  }

  // --- a project removed, for root -----------------------------------------------------

  /**
   * A project removed from the machine by `sitesolide remove`, over the
   * owner's SSH: the token that created it no longer owns its name, so that
   * another token may create a project of that name later. Only once the
   * machine no longer carries it: a removal stopped half way keeps the
   * ownership, and running it again finishes both. Journaled under `owner`,
   * the token in the detail. On the owner's socket alone: a compromised
   * dashboard cannot hand a project's name to another token.
   */
  async function forgetProject(req: Request): Promise<Response> {
    const body = await readBody(req, ["slug"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    const { slug } = body;
    if (typeof slug !== "string" || !isValidSlug(slug)) return failure("invalid", "slug: lowercase letters, digits and dashes");
    return serially(async () => {
      if (await system.projectExists(slug)) {
        return failure("busy", `${slug} is still on the machine: remove it first, with sitesolide remove --confirm ${slug}`);
      }
      const registry = await team();
      if (registry instanceof Response) return registry;
      const forgotten = forgetOwnership(registry, slug);
      if (forgotten === null) return Response.json({ slug, forgotten: null });
      await system.writeTeam(encodeTeam(forgotten.team));
      await options.members?.journal({ operation: "project.remove", result: "ok", actor: "owner", member: null, detail: `created by token ${forgotten.id}, its name free again`, slug });
      console.log(`control: ${slug} removed, no longer token ${forgotten.id}'s`);
      return Response.json({ slug, forgotten: forgotten.id });
    });
  }

  const routes: Record<string, Record<string, Handler>> = {
    "/team/tokens": { GET: listTokens, POST: newToken },
    "/team/revoke": { POST: revoke },
    "/control/authenticate": { POST: authenticateRoute },
    "/control/preflight": { POST: preflight },
    "/control/deploy": { POST: deploy },
    "/control/deployment": { GET: deploymentResult },
    "/control/logs": { POST: logs },
    "/control/sharing": { PUT: sharing },
    ...(members === undefined
      ? {}
      : {
          "/team/member/list": { POST: memberList },
          "/team/member/tokens": { POST: memberCreate },
          "/team/member/revoke": { POST: memberRevoke },
        }),
  };

  let inFlight = 0;
  /** One socket's routes, behind the same bound on requests in flight and the same catch. */
  const serve = (table: Record<string, Record<string, Handler>>): Handler => async (req) => {
    if (inFlight >= maxInFlight) {
      return Response.json({ error: "failure", message: "the steward is busy, try again in a moment" } satisfies ControlFailure, { status: 503 });
    }
    inFlight++;
    try {
      const path = new URL(req.url).pathname;
      const route = Object.hasOwn(table, path) ? table[path] : undefined;
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
  return Object.assign(serve(routes), { revokeMember, owner: serve({ "/team/project": { DELETE: forgetProject } }) });
}

/** Does this path belong to the control routes? The steward's entry point routes on it. */
export function isControlPath(path: string): boolean {
  return path.startsWith("/team/") || path.startsWith("/control/");
}

