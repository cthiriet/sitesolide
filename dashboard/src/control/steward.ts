/**
 * The steward's control routes: the token registry, and the start of the
 * installer. Mounted beside the secrets routes on the same socket, by
 * dashboard/steward.ts, under `/tokens/` and `/control/` (and `/team/`, the
 * names before, one release).
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
 * **Every token belongs to a person**, or is the owner's own. A person mints
 * theirs under their own unlock; the owner makes one for a person under the
 * owner's, minted exactly as the person's own would be. Either way it is
 * never stronger than their roles (src/people/tokens.ts): this steward reads
 * the access registry when one is minted, and again at every use of it, so
 * that a role lowered, the create right taken back or a person removed holds
 * from the next request, and a person removed takes every token of theirs
 * with them, whoever made it. The token owns a project's name from its first
 * deployment. A project a person's token creates makes that person its
 * Admin under one rule (`settleCreations`): the creation's own installer has
 * ended, succeeded, failed or stopped half way, the machine carries the
 * project, the token still owns the name, and nobody has access to the
 * project yet. Otherwise nobody is made Admin; a creation not settled within
 * a day is dropped, and the project, if there is one, is the owner's to
 * give. One undone, nothing laid, gives its name back.
 * The tokens from before every token belonged to someone are made someone's
 * once (`migrateTokens`), and the live tokens of anyone the registry gives no
 * rights are revoked every 30 seconds (`sweepTokens`), so that a person given
 * a role again never finds old tokens alive.
 *
 * **Two queues here**, the tokens' and the creations', in the order
 * src/people/steward.ts sets for every queue of this steward: the tokens'
 * may wait on the creations', which may wait on the registry's, never the
 * other way. So a creation undone gives its name back in the tokens' queue,
 * once the creations' turn is over.
 *
 * **team.json stays readable.** Revoked and expired tokens are kept 90 days,
 * then dropped, sooner when room is needed, the oldest first; a token that
 * created a project is kept, its name is its own. A change that would still
 * leave the file past what it is read with is refused, and nothing is
 * written (`pruneTeam`, `save`).
 *
 * **A token's changes of access are judged here**, the token first, then
 * the access rules (src/access/rules.ts), which let a token give Can open
 * alone: the steward writes them, and the portal reads them from its
 * projection. The journal names the token, never an actor the dashboard
 * would choose.
 *
 * The order of the checks is the order of the risk, as in src/secrets/steward.ts:
 * shape of the body, token, slug, state of the machine, writing.
 */
import type { RandomSource } from "../sessions";
import { isValidSlug, servicesOf, readManifest as parseManifest } from "../../borrowed/manifest";
import { unitArgument } from "../../borrowed/unit";
import type { MemberEvent, MemberPrincipal } from "../people/steward";
import type { AccessRoutes } from "../access/steward";
import type { LeavingToken } from "../access/protocol";
import { deployRefusal, MAX_TOKENS_PER_MEMBER, mintRefusals, narrowIdentity, scopeText, type MemberRights } from "../people/tokens";
import { CREATION_MAX_AGE_MS, encodeCreations, MAX_PENDING, readCreations, type PendingCreation } from "./creations";
import { MAX_CONTROL_FILE_BYTES, type ControlSystem } from "./system";
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
  type InstallerResult,
  type LogsResponse,
  type TeamResponse,
  type TokenView,
  OWNER_HOLDER,
} from "./protocol";
import { cleanLine, interrupted, judgeResult } from "./results";
import {
  authenticate,
  createToken,
  encodeTeam,
  forgetOwnership,
  liveTokensOf,
  MAX_UNCARRIED_NAMES,
  migrateTeam,
  ownedBy,
  pruneTeam,
  readHolder,
  readTeam,
  readTokenRequest,
  recordOwnership,
  refusalMessage,
  revokeMemberTokens,
  revokeToken,
  touch,
  viewOf,
  views,
  type Team,
} from "./tokens";

/**
 * What this steward asks the people's routes (src/people/steward.ts) for a
 * person's tokens: their session and unlock, their rights as the registry
 * reads now, and the project one of their tokens created.
 */
export type MemberAuthority = {
  /** The person behind a session, and their unlock when it is not null; or the refusal to send back. */
  authorize: (session: unknown, unlock: unknown | null) => Promise<MemberPrincipal | Response>;
  unlockedUntil: (session: unknown) => Promise<number | null>;
  /** Their rights now; null: they do not sign in; a Response: the registry does not read. */
  rights: (email: string) => Promise<MemberRights | null | Response>;
  /** Of these people, those the registry gives no rights now, read once; a Response: the registry does not read. */
  rightless: (emails: readonly string[]) => Promise<string[] | Response>;
  /**
   * They become Admin of what their token created, the installer done, on a
   * project nobody has access to yet, journaled: null. A Response when it is
   * not recorded, refused or the registry not reading.
   */
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
   * The people who sign in, for their tokens. Absent, a steward built
   * without them: a person's token is refused, and their routes do not
   * exist.
   */
  members?: MemberAuthority;
  /**
   * A token's changes of access (src/access/steward.ts), the token judged
   * here first. Absent, a steward built without the access registry.
   */
  access?: AccessRoutes["forToken"] | null;
  /** A project removed from the machine: its people with access dropped. Absent, a steward without the registry. */
  forgetAccess?: AccessRoutes["forgetProject"] | null;
};

type Handler = (req: Request) => Promise<Response>;
type Body = Record<string, unknown>;

/**
 * The handler of the dashboard's socket, what the people's routes ask of it,
 * a person who left, every token of theirs revoked, `actor` the one who took
 * them out, and the handler of the owner's socket, which only root opens.
 */
export type ControlHandler = Handler & {
  /** Every live token of theirs revoked, once judged again; the ones revoked. */
  revokeMember: (email: string, actor: string) => Promise<LeavingToken[]>;
  /** A person's live tokens, as a confirmation names them: what their leaving would revoke. */
  tokensOf: (email: string) => Promise<LeavingToken[]>;
  /** `DELETE /tokens/project`: a project removed from the machine, its token ownership and its people with access forgotten. */
  owner: Handler;
  /** Every token made someone's, once the access registry reads: true once done, false to try again later. */
  migrateTokens: () => Promise<boolean>;
  /** The creations whose installer has finished, settled: the person Admin of what succeeded. */
  settleCreations: () => Promise<void>;
  /** The live tokens of anyone the registry gives no rights, revoked; the ones revoked. */
  sweepTokens: () => Promise<LeavingToken[]>;
};

/** Who a bearer is, narrowed to their person's rights for a person's token. */
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
   * The registry written, the dead tokens it no longer needs left out first;
   * a refusal, and nothing written, when even then it would pass what it is
   * read with: every token on the machine would be refused at the next read.
   */
  async function save(next: Team): Promise<Response | null> {
    const kept = pruneTeam(next, system.now(), MAX_CONTROL_FILE_BYTES);
    if (kept === null) {
      console.error("control: team.json would pass what it is read with: nothing written");
      return failure("invalid", "the token registry is full: revoke the tokens nobody uses, then try again");
    }
    await system.writeTeam(encodeTeam(kept));
    return null;
  }

  /**
   * The bearer's holder, or the refusal. A person's token is narrowed to
   * their rights as the registry reads now, and refused once they no longer
   * sign in. The last use moves forward at most once an hour.
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
        return failure("unauthenticated", "this token belongs to a person, and this steward does not keep people with access: the owner must run sitesolide upgrade");
      }
      const rights = await options.members.rights(member);
      if (rights instanceof Response) return rights;
      if (rights === null) {
        return failure("unauthenticated", `this token belongs to ${member}, who no longer has a role on this dashboard: it is refused`);
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
        if (again !== null) await save(again);
      }).catch((e) => console.error(`control: last use not written (${errorName(e)})`));
    }
    return holder;
  }

  /**
   * May this holder deploy this slug, and would it create it? For a person's
   * token, their role first, or the create right for a new project, then the
   * token's own rule, its refusals said in a person's words: the Tokens page
   * is where they mint another.
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
        ? `${String(slug)} is not among this token's projects: mint a token for it from the dashboard's Tokens page`
        : "this token may not create projects: mint one that may from the dashboard's Tokens page",
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

  /**
   * The owner's route, under the owner's unlock. `holder` says whose token it
   * is: `owner`, the owner's own, its scope free; or a person of People, the
   * token minted exactly as their own would be, within their roles, counted
   * among theirs, and revoked with them. A person mints theirs at
   * /tokens/person/create.
   */
  async function newToken(req: Request): Promise<Response> {
    const body = await readBody(req, ["token", "label", "holder", "expiresAt", "scope"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    if (!(await options.isUnlocked(body.token))) return failure("locked", "locked, unlock again");
    const holder = readHolder(body.holder);
    if (typeof holder !== "string") return failure("invalid", holder.refusal);
    const request = readTokenRequest({ label: body.label, email: holder, expiresAt: body.expiresAt, scope: body.scope }, system.now(), options.zone);
    if ("refusal" in request) return failure("invalid", request.refusal);
    return serially(async () => {
      // Checked again once its turn has come, as the secrets routes do.
      if (!(await options.isUnlocked(body.token))) return failure("locked", "locked, unlock again");
      let member: string | null = null;
      if (holder !== OWNER_HOLDER) {
        if (options.members === undefined) return failure("not-available", "this steward does not keep people with access: a token is the owner's own");
        const rights = await options.members.rights(holder);
        if (rights instanceof Response) return rights;
        if (rights === null) return failure("invalid", `${holder} does not sign in to this dashboard: a token belongs to a person of People with a role above Can open, or to you`);
        const refusals = mintRefusals(request.scope, rights);
        if (refusals.length > 0) return failure("out-of-scope", refusals.join("; "), refusals);
        member = holder;
      }
      const registry = await team();
      if (registry instanceof Response) return registry;
      if (member !== null && liveTokensOf(registry, member, system.now()).length >= MAX_TOKENS_PER_MEMBER) {
        return failure("invalid", `${MAX_TOKENS_PER_MEMBER} live tokens per person at most: revoke one of ${member}'s first`);
      }
      const created = await createToken(registry, request, system.now(), options.random, member, member !== null);
      if ("refusal" in created) return failure("invalid", created.refusal);
      const refused = await save(created.team);
      if (refused !== null) return refused;
      if (member !== null) {
        await options.members?.journal({ operation: "token.create", result: "ok", actor: OWNER_HOLDER, member, detail: line(`${created.view.id}: ${scopeText(created.view.scope)}; made by the owner for ${member}`) });
      }
      console.log(`control: token ${created.view.id} created ${member === null ? "for the owner" : `by the owner for ${member}`}`);
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
        const refused = await save(result.team);
        if (refused !== null) return refused;
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

  /** An installer stopped half way, by a reboot, a timeout or the OOM killer: its result still `running`, untouched past the grace, its unit no longer active. */
  async function stopped(result: InstallerResult): Promise<boolean> {
    return result.state === "running" && system.now() - result.updatedAt > graceMs && !(await isActive(installerUnit(result.slug)));
  }

  async function deploy(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "deployment", "slug", "manifest"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    const holder = await identify(body.bearer);
    if (holder instanceof Response) return holder;
    const { identity } = holder;
    const { deployment, slug, manifest } = body;
    if (typeof deployment !== "string" || !DEPLOYMENT_ID_SHAPE.test(deployment)) return failure("invalid", "not a deployment id");
    // An id is used once: a result already there is another deployment's,
    // which a creation would otherwise be settled by.
    if ((await system.readResult(deployment)).kind !== "absent") return failure("invalid", "this deployment id was already used: create a new deployment");
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
        // A name per attempt would grow the registry until nothing reads it:
        // a token holds a bounded number the machine does not carry.
        const held = await team();
        if (held instanceof Response) return held;
        const uncarried: string[] = [];
        for (const name of ownedBy(held, identity.id)) {
          if (name !== target && !(await system.projectExists(name))) uncarried.push(name);
        }
        if (uncarried.length >= MAX_UNCARRIED_NAMES) {
          return failure(
            "too-many-attempts",
            `this token already holds ${uncarried.length} names of projects the machine does not carry, creations still running or undone: wait for those running to finish, then try again; the owner frees the others with sitesolide remove --confirm <name>`,
          );
        }
        // The token owns the name from its first deployment; a person
        // becomes its Admin once the installer has finished, noted here so
        // that it is settled then, even across a restart of this steward.
        if (identity.member !== null && options.members !== undefined) {
          // A project created is a change of access, its creator's: bounded
          // as theirs are, before anything starts.
          const bounded = (await options.access?.widen(identity.member)) ?? null;
          if (bounded !== null) {
            const { message } = (await bounded.json()) as { message: string };
            return failure(bounded.status === 429 ? "too-many-attempts" : "not-available", message);
          }
          const noted = await notePending({ deployment, slug: target, email: identity.member, token: identity.id, at: system.now() });
          if (noted !== null) return noted;
        }
        const registry = await team();
        if (registry instanceof Response) return registry;
        const owned = recordOwnership(registry, target, identity.id);
        if (owned !== null) {
          const refused = await save(owned);
          if (refused !== null) return refused;
        }
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
    if (await stopped(result)) result = interrupted(result, system.now());
    // A creation that just finished is settled before its result is handed
    // over: whoever reads "succeeded" finds its creator Admin already.
    if (result.state !== "running") await settleCreations();
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

  // --- access ----------------------------------------------------------------------

  /**
   * A token's request on a project's access: the token judged, the project
   * among those it reaches, any other reading as unknown; then the access
   * rules, the person a token belongs to an Admin of it, Can open alone.
   */
  async function accessRoute(req: Request, fields: string[], run: (holder: Holder, slug: string, body: Body) => Promise<Response>): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug", ...fields], bodyTimeoutMs);
    if (body instanceof Response) return body;
    const holder = await identify(body.bearer);
    if (holder instanceof Response) return holder;
    const { identity } = holder;
    const { slug } = body;
    if (typeof slug !== "string" || !isValidSlug(slug)) return failure("invalid", "slug: lowercase letters, digits and dashes");
    if (!identity.owned.includes(slug) && !identity.scope.slugs.includes(slug)) return failure("not-found", `no project ${slug} for this token`);
    if (options.access === undefined || options.access === null) return failure("not-available", "this steward does not carry the access registry: the owner must run sitesolide upgrade");
    return run(holder, slug, body);
  }

  const granterOf = (holder: Holder) => ({ kind: "token" as const, id: holder.identity.id, email: holder.identity.member, role: null });

  const accessList = (req: Request) => accessRoute(req, [], (holder, slug) => options.access!.list(slug, granterOf(holder)));
  const accessGrant = (req: Request) => accessRoute(req, ["who", "role"], (holder, slug, body) => options.access!.grant(slug, body.who, body.role, granterOf(holder)));
  const accessRemove = (req: Request) => accessRoute(req, ["who"], (holder, slug, body) => options.access!.remove(slug, body.who, granterOf(holder)));

  // --- a person's own tokens ------------------------------------------------------

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
   * A person's own token: under their own unlock, with their email, within
   * their roles as the registry reads once its turn has come. A refusal names
   * every reason, and enters the journal.
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
        return failure("invalid", `${MAX_TOKENS_PER_MEMBER} live tokens per person at most: revoke one you no longer use`);
      }
      const created = await createToken(registry, request, system.now(), options.random, email);
      if ("refusal" in created) return failure("invalid", created.refusal);
      const refused = await save(created.team);
      if (refused !== null) return refused;
      await members.journal({ operation: "token.create", result: "ok", actor: email, member: email, detail: line(`${created.view.id}: ${scopeText(created.view.scope)}`) });
      console.log(`control: token ${created.view.id} created by ${email}`);
      const response: CreatedTokenResponse = { token: created.view, secret: created.secret };
      return Response.json(response, { status: 201 });
    });
  }

  /** A person revokes a token of theirs, whoever made it, no unlock, as the owner does; anyone else's reads as unknown. */
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
        const refused = await save(result.team);
        if (refused !== null) return refused;
        await members.journal({ operation: "token.revoke", result: "ok", actor: principal.email, member: principal.email, detail: result.view.id });
        console.log(`control: token ${result.view.id} revoked by ${principal.email}`);
      }
      return Response.json({ token: result.view });
    });
  }

  /** A token as a confirmation names it. */
  const leavingToken = (view: { id: string; label: string; by: string }): LeavingToken => ({ id: view.id, label: view.label, madeBy: view.by === OWNER_HOLDER ? "owner" : "them" });

  async function tokensOf(email: string): Promise<LeavingToken[]> {
    const registry = await team();
    if (registry instanceof Response) return [];
    return liveTokensOf(registry, email, system.now()).map((record) => leavingToken(viewOf(registry, record)));
  }

  /**
   * Every live token of a person who left, whoever made it, revoked,
   * journaled under whoever took them out. Judged again in this queue: given
   * a role again since they left, they keep their tokens; a registry that
   * does not read revokes nothing, their tokens being refused meanwhile.
   */
  function revokeMember(email: string, actor: string): Promise<LeavingToken[]> {
    return serially(async () => {
      const rights = members === undefined ? null : await members.rights(email);
      if (rights instanceof Response) {
        console.error(`control: the tokens of ${email} not revoked, the access registry does not read; refused meanwhile`);
        return [];
      }
      if (rights !== null) return [];
      const registry = await team();
      if (registry instanceof Response) return [];
      const result = revokeMemberTokens(registry, email, system.now());
      if (result.revoked.length === 0) return [];
      const refused = await save(result.team);
      if (refused !== null) return [];
      const ids = result.revoked.map((view) => view.id).join(", ");
      await members?.journal({ operation: "token.revoke", result: "ok", actor, member: email, detail: line(`${ids}: ${email} no longer has a role on this dashboard`) });
      console.log(`control: ${result.revoked.length} token(s) of ${email} revoked, no role left`);
      return result.revoked.map(leavingToken);
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
   *
   * A creation of that name still waiting for its installer goes too, in
   * the creations' turn, which this queue may wait on: settled later, it
   * would make its person Admin of whatever the machine carries under that
   * name by then, the owner's own project included.
   */
  async function forgetProject(req: Request): Promise<Response> {
    const body = await readBody(req, ["slug"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    const { slug } = body;
    if (typeof slug !== "string" || !isValidSlug(slug)) return failure("invalid", "slug: lowercase letters, digits and dashes");
    const released = await serially(async () => {
      if (await system.projectExists(slug)) {
        return failure("busy", `${slug} is still on the machine: remove it first, with sitesolide remove --confirm ${slug}`);
      }
      // The creation first: a removal stopped between the two, run again,
      // finds the ownership still there and finishes.
      const dropped = await dropPending(slug);
      if (dropped instanceof Response) return dropped;
      const registry = await team();
      if (registry instanceof Response) return registry;
      const forgotten = forgetOwnership(registry, slug);
      if (forgotten === null) return null;
      const refused = await save(forgotten.team);
      if (refused !== null) return refused;
      console.log(`control: ${slug} removed, no longer token ${forgotten.id}'s`);
      return forgotten.id;
    });
    if (released instanceof Response) return released;
    // Its people with access go with it, outside this file's queue: someone
    // they were the last role of leaves, and their tokens are revoked there.
    let dropped = 0;
    if (options.forgetAccess !== undefined && options.forgetAccess !== null) {
      const result = await options.forgetAccess(slug, "owner");
      if (result instanceof Response) return result;
      dropped = result;
    }
    if (released !== null) {
      await options.members?.journal({ operation: "project.remove", result: "ok", actor: "owner", member: null, detail: `created by token ${released}, its name free again`, slug });
    }
    return Response.json({ slug, forgotten: released, access: dropped });
  }

  // --- creations and the tokens from before -----------------------------------------

  /** The creations waiting for their installer, one change at a time. */
  let creationsTurn: Promise<unknown> = Promise.resolve();
  function inCreationsTurn<T>(task: () => Promise<T>): Promise<T> {
    const next = creationsTurn.then(task, task);
    creationsTurn = next.catch(() => undefined);
    return next;
  }

  async function pending(): Promise<PendingCreation[] | Response> {
    let text: string | null;
    try {
      text = await system.readCreations();
    } catch (e) {
      console.error(`control: creations.json unreadable (${errorName(e)})`);
      return failure("failure", "the creations in progress cannot be read on the machine: the owner must read the steward's log");
    }
    const read = readCreations(text);
    if ("unreadable" in read) {
      console.error(`control: ${read.unreadable}`);
      return failure("failure", "the creations in progress do not read on the machine: the owner must read the steward's log");
    }
    return read;
  }

  /** A creation noted before its installer starts; a refusal when it cannot be, and nothing is started. */
  function notePending(creation: PendingCreation): Promise<Response | null> {
    return inCreationsTurn(async () => {
      const current = await pending();
      if (current instanceof Response) return current;
      const kept = current.filter((one) => one.slug !== creation.slug && system.now() - one.at < CREATION_MAX_AGE_MS);
      await system.writeCreations(encodeCreations([...kept, creation].slice(-MAX_PENDING)));
      return null;
    });
  }

  /** The creations of this slug dropped, in the creations' turn: the project they were for is gone. How many; a refusal when the file does not read. */
  function dropPending(slug: string): Promise<number | Response> {
    return inCreationsTurn(async () => {
      const current = await pending();
      if (current instanceof Response) return current;
      const kept = current.filter((one) => one.slug !== slug);
      if (kept.length === current.length) return 0;
      await system.writeCreations(encodeCreations(kept));
      for (const one of current.filter((creation) => creation.slug === slug)) {
        console.log(`control: the creation of ${slug} by ${one.email} dropped, the project removed from the machine`);
      }
      return current.length - kept.length;
    });
  }

  /**
   * Has this creation's own installer ended: a result of its own deployment,
   * started once the creation was noted, final, succeeded or failed, or left
   * `running` by an installer stopped half way (`stopped`)? No result at all,
   * the creation noted past the grace and its installer not active, is an
   * end too: results live on tmpfs, and a reboot takes them. An earlier
   * result, of a project of that name removed since, is another deployment's.
   */
  async function ended(creation: PendingCreation): Promise<boolean> {
    const judgement = judgeResult(await system.readResult(creation.deployment), creation.deployment, options.uidRoot);
    if (judgement.kind === "absent") return system.now() - creation.at > graceMs && !(await isActive(installerUnit(creation.slug)));
    if (judgement.kind !== "read") return false;
    const { result } = judgement;
    if (result.slug !== creation.slug || result.startedAt < creation.at) return false;
    return result.state !== "running" || (await stopped(result));
  }

  /**
   * The creations settled, under one rule. Its person is made Admin only
   * when all of this holds at once: its own installer has ended (`ended`),
   * the machine carries the project, the token that started it still owns
   * its name, and nobody has access to the project yet, which the registry
   * checks in its own queue with the create right (`recordCreation`). An
   * ended creation is dropped either way: one of those failing, nobody is
   * made anything. Ended with nothing on the machine, it is undone, and its
   * name comes back once this turn is over (see the queues above). Not ended
   * within `CREATION_MAX_AGE_MS`: dropped, nobody made Admin, the project, if
   * there is one, the owner's to give by hand. A result not there yet, its
   * installer active or the creation within the grace, waits for the next
   * call.
   */
  async function settleCreations(): Promise<void> {
    const undone: PendingCreation[] = [];
    await inCreationsTurn(async () => {
      const current = await pending();
      if (current instanceof Response || current.length === 0) return;
      const left: PendingCreation[] = [];
      /** The token registry, read once, when a creation needs it. */
      let held: Team | Response | null = null;
      for (const creation of current) {
        const expired = system.now() - creation.at >= CREATION_MAX_AGE_MS;
        if (!expired && !(await ended(creation))) {
          left.push(creation);
          continue;
        }
        const carried = await system.projectExists(creation.slug);
        if (!carried) undone.push(creation);
        if (expired || !carried || options.members === undefined) {
          console.log(`control: the creation of ${creation.slug} by ${creation.email} ${expired ? "not settled within a day" : "undone"}: dropped, nobody made Admin`);
          continue;
        }
        held ??= await team();
        // The registry of tokens being unreadable: tried again at the next call.
        if (held instanceof Response) {
          left.push(creation);
          continue;
        }
        if (held.owners[creation.slug] !== creation.token) {
          console.log(`control: the creation of ${creation.slug} by ${creation.email} dropped, nobody made Admin: its name is no longer token ${creation.token}'s`);
          continue;
        }
        const refused = await options.members.recordCreation(creation.slug, creation.email, creation.token);
        // The registry being made or unreadable: tried again at the next call.
        if (refused !== null && refused.status >= 500) {
          left.push(creation);
          continue;
        }
        if (refused !== null) console.log(`control: the creation of ${creation.slug} by ${creation.email} dropped, nobody made Admin: refused by the registry`);
      }
      if (left.length !== current.length) await system.writeCreations(encodeCreations(left));
    });
    if (undone.length > 0) await giveNamesBack(undone);
  }

  /**
   * The names of creations undone given back, in the tokens' queue: each one
   * still its token's, still not on the machine and with no creation of it
   * noted since, checked once the turn has come, so that a project laid
   * meanwhile keeps its owner, and a new creation of it its name. Otherwise
   * `owners` would grow by one name per attempt.
   */
  function giveNamesBack(undone: readonly PendingCreation[]): Promise<void> {
    return serially(async () => {
      let registry = await team();
      if (registry instanceof Response) return;
      // The tokens' queue may wait on the creations' turn, never the other way.
      const noted = await inCreationsTurn(pending);
      if (noted instanceof Response) return;
      const given: string[] = [];
      for (const creation of undone) {
        if (noted.some((one) => one.slug === creation.slug)) continue;
        if (registry.owners[creation.slug] !== creation.token || (await system.projectExists(creation.slug))) continue;
        const forgotten = forgetOwnership(registry, creation.slug);
        if (forgotten === null) continue;
        registry = forgotten.team;
        given.push(creation.slug);
      }
      if (given.length === 0) return;
      if ((await save(registry)) !== null) return;
      console.log(`control: name${given.length === 1 ? "" : "s"} given back, creation undone: ${given.join(", ")}`);
    });
  }

  /**
   * The live tokens of anyone the registry gives no rights, revoked in this
   * queue, journaled under `system`. Someone taken out while their tokens
   * could not be revoked, the registry not reading then, or out of a
   * registry restored or edited by hand, would otherwise find them alive
   * again the day they are given a role back. A registry that does not read
   * revokes nothing: their tokens are refused meanwhile.
   */
  function sweepTokens(): Promise<LeavingToken[]> {
    if (members === undefined) return Promise.resolve([]);
    return serially(async () => {
      const registry = await team();
      if (registry instanceof Response) return [];
      const now = system.now();
      const holders = [...new Set(registry.tokens.flatMap((record) => (record.member === undefined ? [] : [record.member])))].filter(
        (email) => liveTokensOf(registry, email, now).length > 0,
      );
      if (holders.length === 0) return [];
      const gone = await members.rightless(holders);
      if (gone instanceof Response || gone.length === 0) return [];
      let next = registry;
      const revoked: { email: string; views: TokenView[] }[] = [];
      for (const email of gone) {
        const result = revokeMemberTokens(next, email, now);
        if (result.revoked.length === 0) continue;
        next = result.team;
        revoked.push({ email, views: result.revoked });
      }
      if (revoked.length === 0 || (await save(next)) !== null) return [];
      for (const { email, views } of revoked) {
        const ids = views.map((view) => view.id).join(", ");
        await members.journal({ operation: "token.revoke", result: "ok", actor: "system", member: email, detail: line(`${ids}: ${email} has no role on this dashboard`) });
        console.log(`control: ${views.length} token(s) of ${email} revoked, no role on this dashboard`);
      }
      return revoked.flatMap(({ views }) => views.map(leavingToken));
    });
  }

  /**
   * Every token made someone's, once: those whose email signs in to the
   * dashboard become that person's, the others the owner's own. Waits for an
   * access registry that reads: false, and nothing written, until then.
   */
  async function migrateTokens(): Promise<boolean> {
    if (options.members === undefined) return true;
    const members = options.members;
    return serially(async () => {
      const registry = await team();
      if (registry instanceof Response) return false;
      if (registry.version === 2) return true;
      const people = new Map<string, boolean>();
      for (const record of registry.tokens) {
        const email = record.email.trim().toLowerCase();
        if (record.member !== undefined || people.has(email)) continue;
        const rights = await members.rights(email);
        if (rights instanceof Response) return false;
        people.set(email, rights !== null);
      }
      const migrated = migrateTeam(registry, (email) => people.get(email) === true);
      if ((await save(migrated.team)) !== null) return false;
      for (const record of migrated.persons) {
        await members.journal({ operation: "token.create", result: "ok", actor: "system", member: record.member ?? null, detail: line(`${record.id}: now ${record.member}'s, narrowed to their roles; made by the owner before every token belonged to someone`) });
      }
      console.log(`control: tokens made someone's: ${migrated.persons.length} a person's, ${migrated.owner.length} the owner's own`);
      return true;
    });
  }

  const routes: Record<string, Record<string, Handler>> = {
    "/tokens/list": { GET: listTokens },
    "/tokens/create": { POST: newToken },
    "/tokens/revoke": { POST: revoke },
    "/control/authenticate": { POST: authenticateRoute },
    "/control/preflight": { POST: preflight },
    "/control/deploy": { POST: deploy },
    "/control/deployment": { GET: deploymentResult },
    "/control/logs": { POST: logs },
    "/control/access/list": { POST: accessList },
    "/control/access": { PUT: accessGrant, DELETE: accessRemove },
    // The names before `/tokens/`, which a dashboard deployed before this
    // steward still calls: kept one release.
    "/team/tokens": { GET: listTokens, POST: newToken },
    "/team/revoke": { POST: revoke },
    ...(members === undefined
      ? {}
      : {
          "/tokens/person/list": { POST: memberList },
          "/tokens/person/create": { POST: memberCreate },
          "/tokens/person/revoke": { POST: memberRevoke },
          "/team/member/list": { POST: memberList },
          "/team/member/tokens": { POST: memberCreate },
          "/team/member/revoke": { POST: memberRevoke },
        }),
  };

  let inFlight = 0;
  /** One socket's routes, behind the same bound on requests in flight and the same catch. */
  const serve = (table: Record<string, Record<string, Handler>>): Handler => async (req) => {
    if (inFlight >= maxInFlight) {
      return Response.json({ error: "failure", message: "the server is busy, try again in a moment" } satisfies ControlFailure, { status: 503 });
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
  return Object.assign(serve(routes), {
    revokeMember,
    tokensOf,
    // `/team/project`: what a CLI from before the rename calls, kept one release.
    owner: serve({ "/tokens/project": { DELETE: forgetProject }, "/team/project": { DELETE: forgetProject } }),
    migrateTokens,
    settleCreations,
    sweepTokens,
  });
}

/** Does this path belong to the control routes? The steward's entry point routes on it. */
export function isControlPath(path: string): boolean {
  return path.startsWith("/tokens/") || path.startsWith("/team/") || path.startsWith("/control/");
}

