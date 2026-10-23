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
 * give. One undone, nothing laid, gives its name back. No token creates a
 * name under which the machine still keeps a removed project's snapshots or
 * connector grants (`judgeDeployment`): its creator would be their Admin.
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
 * **A token's secrets and restart are judged here too**, the token, its
 * person's role and its `secrets` flag, then handed to the secrets routes'
 * own code (src/secrets/steward.ts, `secretsForToken`), with the token as
 * the requester, under their lock, or the project's own turn for a restart,
 * where this judgement is made again once the turn has come. Each token is
 * bounded per hour, in memory: what it may push through the journal, its
 * changes, its restarts and its refusals each, those of its changes of
 * access included, and how often it cuts a service.
 *
 * **So is a token's work on a project's store** (`/control/store/*`): the
 * same judgement, then the store's own code (src/secrets/steward.ts,
 * `storeForToken`, the contract of src/secrets/store-api.ts). On a slug the
 * machine does not carry yet, a token that may create it writes its store
 * ahead of its first deployment: judged as that deployment's creation would
 * be, the leftovers of a removed project included, a store laid there by
 * anyone else among them. The name becomes the token's only once the store
 * answers that this write made its folder, and the store is the token's own
 * because its write made it, never because the registry names the token
 * (src/control/claims.ts): a write that wrote nothing claims nothing. A
 * project of that name deployed by anyone but that token, the owner over
 * SSH above all, releases the token's hold on it, and a name with no
 * project, no store and no deployment under way is given back. Its person
 * becomes Admin through its own deployment, as for any creation
 * (`settleCreations`), never through a store alone: the registry never makes
 * anyone Admin of a name the machine does not carry. No value is ever sent
 * back: neither one set, nor one drawn, nor a file's content.
 *
 * The order of the checks is the order of the risk, as in src/secrets/steward.ts:
 * shape of the body, token, slug, state of the machine, writing.
 */
import type { RandomSource } from "../sessions";
import { hasStore, isValidSlug, secretsOf, servicesOf, readManifest as parseManifest } from "../../borrowed/manifest";
import { portalFromManifest } from "../../borrowed/portal-vm";
import { unitArgument } from "../../borrowed/unit";
import type { MemberEvent, MemberPrincipal, TokenRefusal } from "../people/steward";
import type { Who } from "../people/actions";
import { may, powerRefusal, roleDetail, type Power } from "../people/powers";
import type { Role } from "../people/protocol";
import type { AccessRoutes } from "../access/steward";
import type { LeavingToken } from "../access/protocol";
import { deployRefusal, MAX_TOKENS_PER_MEMBER, mintRefusals, narrowIdentity, scopeText, type MemberRights } from "../people/tokens";
import type { StoreForToken } from "../secrets/store-api";
import type { StoreView } from "../../borrowed/store-protocol";
import { readFileContent, readFileName, readGenerate, readSecretsChange, type TokenSecretsChange } from "./secrets";
import { CREATION_MAX_AGE_MS, encodeCreations, MAX_PENDING, readCreations, type PendingCreation } from "./creations";
import {
  claimOf,
  credited,
  encodeClaims,
  madeStore,
  MAX_CLAIMS,
  readClaims,
  released,
  settle,
  withDeployment,
  withStoreMade,
  without,
  type Claims,
  type DeploymentOutcome,
} from "./claims";
import { MAX_CONTROL_FILE_BYTES, type ControlSystem } from "./system";
import { decideManifest, decideSlug, legacyLossOfView, legacyLossRefusal, leftoversReason, reservedReason, type Leftovers, type SlugDecision } from "./policy";
import {
  CONTROL_STATUSES,
  DEPLOYMENT_ID_SHAPE,
  INSTALLER_PREFIX,
  MAX_JOURNAL_LINES,
  MAX_MANIFEST_BYTES,
  MAX_SECRETS_BODY_BYTES,
  TOKEN_REFUSALS_PER_HOUR,
  TOKEN_RESTARTS_PER_HOUR,
  TOKEN_SECRET_CHANGES_PER_HOUR,
  type ControlErrorCode,
  type ControlFailure,
  type ClaimReleased,
  type ClaimView,
  type CreatedTokenResponse,
  type DeployResponse,
  type Identity,
  type InstallRequest,
  type InstallerResult,
  type LogsResponse,
  type PreflightResponse,
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
  /**
   * A token's secrets and restart (src/secrets/steward.ts), the token judged
   * here first. Absent, the routes do not exist, as on a steward that
   * predates them, and the dashboard says to upgrade.
   */
  secrets?: SecretsForToken | null;
  /**
   * A token's work on a project's store (src/secrets/store-api.ts), the
   * token judged here first. Absent, the store routes do not exist, as on a
   * steward that predates them, and the dashboard says to upgrade.
   */
  store?: StoreForToken | null;
  /**
   * A store's variables and files moved aside, under the secrets' lock, when
   * the owner adopts a name a token held (src/secrets/steward.ts,
   * `storeAside`): `{ variables, files }`. Absent, nothing is moved.
   */
  storeAside?: ((slug: string) => Promise<Response>) | null;
  /**
   * What `{contact}` becomes on this machine, `SITESOLIDE_CONTACT`: a
   * deployment's build fills it in on the client. Empty when the machine
   * declares none.
   */
  contact?: string;
  /** The hourly bounds per token, lower in the tests. */
  secretChangesPerHour?: number;
  restartsPerHour?: number;
  refusalsPerHour?: number;
};

/**
 * What this steward asks the secrets routes for a token's secrets and
 * restart. `still` is asked once the turn has come, the secrets' lock for a
 * change, the project's own turn for a restart: the token, its person's role
 * and its flag judged again, nothing done on a refusal.
 */
export type SecretsForToken = {
  /** One project's files as a token lists them, never a value: `SecretsListResponse`. */
  list: (slug: string, who: Who) => Promise<Response>;
  /** A change of `<slug>.env`, all or nothing: `StewardSecretsChange`, 201 when the file was created. */
  change: (req: Request, change: TokenSecretsChange, who: Who, still: () => Promise<Response | null>) => Promise<Response>;
  /** The project's service restarted and observed: `TokenRestartResponse`. */
  restart: (req: Request, slug: string, who: Who, still: () => Promise<Response | null>) => Promise<Response>;
  /** A refusal decided here, into the journal: bounded per token here, before it is asked. */
  refuse: (event: TokenRefusal) => Promise<void>;
  /** Is the project restricted as its general access reads: the portal asked for and its protected block in service? */
  restricted: (slug: string) => Promise<boolean>;
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
  /** The owner wrote into this project's store: a name the machine does not carry is theirs from then on (src/control/claims.ts). */
  ownerWroteStore: (slug: string) => Promise<void>;
  /** Is this store, of a name the machine does not carry, a token's write ahead, to move aside before the owner's write? Read alone. */
  storeClaimed: (slug: string) => Promise<boolean>;
};

/** Who a bearer is, narrowed to their person's rights for a person's token. */
type Holder = { identity: Identity; rights: MemberRights | null };

/** A slug as a deployment's judgement reads it. */
type SlugState = { exists: boolean; owner: string | null; claims: Claims | null };

/** The biggest body but a change of secrets: a deployment request, its manifest included. */
export const MAX_CONTROL_BODY_BYTES = MAX_MANIFEST_BYTES + 4 * 1024;

/**
 * A change of secrets as the dashboard relays it: the API's own bound, and
 * room for the bearer, the slug and the file it adds. The steward's socket
 * admits it (dashboard/steward.ts, `maxRequestBodySize`).
 */
export const MAX_SECRETS_CHANGE_BODY_BYTES = MAX_SECRETS_BODY_BYTES + 4 * 1024;

const HOUR_MS = 3_600_000;

const CURSOR_SHAPE = /^[A-Za-z0-9=;_-]{1,512}$/;

/** The old token route's answer for a project whose variables live in its store. */
export const STORE_FORM = "this project keeps its variables in its store: update your sitesolide CLI, then sitesolide secrets set NAME";

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
async function readBody(req: Request, fields: string[], timeoutMs: number, max = MAX_CONTROL_BODY_BYTES): Promise<Body | Response> {
  if (Number(req.headers.get("content-length") ?? "0") > max) return failure("invalid", "request body too large");
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
      if (total > max) {
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
   * What tokens did to names the machine did not carry (claims.ts), as the
   * file reads now: null when it does not read, which is said in the log
   * and counted as no claim, so that no store is anyone's own on its
   * strength.
   */
  async function claimsNow(): Promise<Claims | null> {
    let text: string | null;
    try {
      text = await system.readClaims();
    } catch (e) {
      console.error(`control: claims.json unreadable (${errorName(e)})`);
      return null;
    }
    const read = readClaims(text);
    if ("unreadable" in read) {
      console.error(`control: ${read.unreadable}`);
      return null;
    }
    return read;
  }

  /** The claims for a change, in the tokens' queue: a refusal when they do not read, and nothing is written. */
  async function claimsToChange(): Promise<Claims | Response> {
    return (await claimsNow()) ?? failure("failure", "the tokens' claims on names cannot be read on the machine: the owner must check /var/lib/sitesolide-steward/claims.json");
  }

  /**
   * Is this token's hold on a name it claimed released now? Released when
   * the machine carries the project and the token's own deployment of it
   * did not succeed, or still runs: the owner's SSH deploy laid it. Here at
   * once, and in the registry at the next settlement.
   */
  async function releasedNow(claims: Claims, slug: string, token: string, onMachine: boolean): Promise<boolean> {
    const claim = claimOf(claims, slug);
    if (!onMachine || claim === null) return false;
    const outcome = claim.deployment === null || claim.deployer !== token ? null : await outcomeOf(claim.deployment, slug, claim.at);
    return released(claim, onMachine, credited(claim, token, outcome));
  }

  /** The names a token holds, but those whose hold is released (`releasedNow`). */
  async function heldNow(identity: Identity, claims: Claims): Promise<Identity> {
    if (identity.owned.every((slug) => !Object.hasOwn(claims, slug))) return identity;
    const owned: string[] = [];
    for (const slug of identity.owned) {
      if (Object.hasOwn(claims, slug) && (await releasedNow(claims, slug, identity.id, await system.projectExists(slug)))) continue;
      owned.push(slug);
    }
    return { ...identity, owned };
  }

  /**
   * The bearer's holder, or the refusal. A person's token is narrowed to
   * their rights as the registry reads now, and refused once they no longer
   * sign in. The last use moves forward at most once an hour; `touching`
   * false for a judgement made again under the secrets' lock, which must
   * never wait on this file's queue while it holds that lock.
   */
  async function identify(bearer: unknown, touching = true): Promise<Holder | Response> {
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
    // What tokens claimed decides which names a token holds: while that does
    // not read, a hold released could come back, so no token is served.
    const claims = await claimsNow();
    if (claims === null) return failure("failure", "the tokens' claims on names do not read on the machine, and no token is served meanwhile: the owner must check /var/lib/sitesolide-steward/claims.json");
    holder = { ...holder, identity: await heldNow(holder.identity, claims) };
    const touched = touching ? touch(registry, result.identity.id, now) : null;
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

  /**
   * A token holds a bounded number of names the machine does not carry:
   * creations running or undone, and stores written ahead of a first
   * deployment. A name per attempt would grow the registry until nothing
   * reads it. The refusal past the bound, or null.
   */
  async function uncarriedBound(registry: Team, id: string, target: string): Promise<Response | null> {
    const uncarried: string[] = [];
    for (const name of ownedBy(registry, id)) {
      if (name !== target && !(await system.projectExists(name))) uncarried.push(name);
    }
    if (uncarried.length < MAX_UNCARRIED_NAMES) return null;
    return failure(
      "too-many-attempts",
      `this token already holds ${uncarried.length} names of projects the machine does not carry, creations still running or undone, or stores written ahead of a first deployment: wait for those running to finish, then try again; the owner frees the others with sitesolide remove --confirm <name>`,
    );
  }

  /**
   * The machine carries the project or not, the token the registry names for
   * it, but one whose hold is released (`heldNow`), and the claims, null
   * when they do not read.
   */
  async function slugState(slug: string): Promise<SlugState | Response> {
    const registry = await team();
    if (registry instanceof Response) return registry;
    const exists = await system.projectExists(slug);
    const claims = await claimsNow();
    const named = registry.owners[slug] ?? null;
    const gone = named !== null && (claims === null || (await releasedNow(claims, slug, named, exists)));
    return { exists, owner: gone ? null : named, claims };
  }

  /**
   * A deployment's slug judged as `judgeSlug` does, then, for a creation,
   * on what the machine still keeps under that name: a removed project's
   * snapshots and connector grants, which the project created again would
   * be handed (src/control/policy.ts, `leftoversReason`). Any token, a
   * person's or the owner's own: a person is made Admin of what their token
   * creates, and a grant is lent to whatever code runs under the slug. A
   * project on the machine is deployed again and never asked; the owner's
   * SSH deploy does not come here.
   *
   * Asked of the deployment itself, in the tokens' queue, right before the
   * request is written and the installer started: a name the machine does
   * not carry gains no snapshot until a run finds its folder, the new
   * project's then, and no grant, which the Connectors page gives to a
   * deployed site alone. So the installer does not ask again; it could not
   * open the index besides, SQLite in WAL under its read-only /var/lib. One
   * gap stays, the owner's own doing: an index made again from a repository
   * that holds more, its database deleted by hand or a bucket attached from
   * another machine, lists again at its next run what it finds. What does
   * not read refuses the creation: an index or a grants file that cannot be
   * read must never pass for one that holds nothing.
   */
  async function judgeDeployment(holder: Holder, slug: unknown, state: SlugState): Promise<SlugDecision | Response> {
    const decision = judgeSlug(holder, slug, state);
    if (decision.kind === "refused" || !decision.creating) return decision;
    const target = slug as string;
    let left: Leftovers;
    try {
      left = await system.leftovers(target);
    } catch (e) {
      console.error(`control: what the machine keeps under ${target} does not read (${e instanceof Error ? e.message : errorName(e)}): its creation refused`);
      return failure("failure", `what a removed project may have left under ${target}, backups or connector grants, cannot be read on the machine, and no token creates it meanwhile: the owner must read the steward's log`);
    }
    // A store this token's write made ahead of its first deployment is its
    // own; any other is a leftover, whoever the registry names for the slug.
    const reason = leftoversReason(target, { ...left, store: left.store && !madeStore(state.claims, target, holder.identity.id) });
    return reason === null ? decision : { kind: "refused", error: "reserved", message: reason };
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
    const decision = await judgeDeployment(holder, body.slug, state);
    if (decision instanceof Response) return decision;
    if (decision.kind === "refused") return failure(decision.error, decision.message);
    const answer: PreflightResponse = { creating: decision.creating, placeholders: { zone: options.zone, contact: options.contact ?? "" } };
    return Response.json(answer);
  }

  /**
   * The values a deployment of this manifest would drop, as the store's own
   * listing says what the installed units read and the store holds: those
   * of the legacy files the manifest no longer declares, its old form or
   * not; null when none, or when the store cannot list it here (the
   * installer judges it again from the files).
   */
  async function lossOf(holder: Holder, slug: string, manifest: string): Promise<string | null> {
    const { manifest: read } = parseManifest(manifest);
    if (read === undefined || !hasStore(read) || store === null) return null;
    const listed = await store.list(slug, whoOf(holder), false);
    if (listed.status !== 200) return null;
    const view = ((await listed.json()) as { store?: StoreView }).store;
    if (view === undefined || !Array.isArray(view.legacy) || !Array.isArray(view.variables)) return null;
    // The files its old form still declares are kept, and supply what they hold.
    return legacyLossRefusal(legacyLossOfView(view, secretsOf(read).legacy));
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
      const decision = await judgeDeployment(holder, slug, state);
      if (decision instanceof Response) return decision;
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

      // A manifest that reads the store alone, over units that read legacy
      // files the store lacks the values of: deployed, the service would
      // start without them. Judged here, whatever the client checked or
      // could list, and again by the installer before it lays a unit.
      const loss = state.exists ? await lossOf(holder, target, manifest) : null;
      if (loss !== null) return failure("migrate-first", loss);

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
        const bounded = await uncarriedBound(held, identity.id, target);
        if (bounded !== null) return bounded;
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
        // Which token deployed it, so that a hold this one claimed ahead is
        // kept once the project is there, and the name settled otherwise.
        const claims = await claimsToChange();
        if (claims instanceof Response) return claims;
        if (!Object.hasOwn(claims, target) && Object.keys(claims).length >= MAX_CLAIMS) {
          return failure("too-many-attempts", "the machine holds as many names for tokens as it keeps: the owner frees the names nobody deploys with sitesolide remove --confirm <name>");
        }
        await system.writeClaims(encodeClaims(withDeployment(claims, target, identity.id, deployment, system.now())));
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
    // Every declared service, as `sitesolide logs` reads them over SSH: a
    // scheduled service's runs are in its own journal, what each printed and
    // how it ended. Neither its timer nor the anchor of a project whose every
    // service is scheduled runs anything to read, and servicesOf leaves both out.
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

  /**
   * A token's change of access, charged to the hour of its refusals
   * (`refusal`, below) before it is asked, and given back once accepted.
   * The access routes journal a token's refusal, Admin asked of a token that
   * gives Can open alone, someone outside the company's domains: unbounded,
   * a stolen token, a deploy token alone, wrote twenty lines a minute, and
   * within the hour pushed past the thousand lines the journal keeps every
   * change of secrets made in it, any token's. An accepted change goes to
   * the access log, bounded by the registry's own hour per actor; `silent`
   * says which other answers wrote no line either.
   */
  async function accessChange(holder: Holder, change: () => Promise<Response>, silent: (answer: Response) => boolean = (answer) => answer.ok): Promise<Response> {
    const key = `refusals:${holder.identity.id}`;
    const before = system.now();
    const bounded = withinHour(key, 1, refusalsPerHour, "refused requests");
    if (bounded !== null) return bounded;
    const answer = await change();
    if (silent(answer)) giveBack(key, before);
    return answer;
  }

  const accessList = (req: Request) => accessRoute(req, [], (holder, slug) => options.access!.list(slug, granterOf(holder)));
  const accessGrant = (req: Request) =>
    accessRoute(req, ["who", "role"], (holder, slug, body) => accessChange(holder, () => options.access!.grant(slug, body.who, body.role, granterOf(holder))));
  // An entry not there to remove is said, never journaled: a cleanup run twice costs nothing.
  const accessRemove = (req: Request) =>
    accessRoute(req, ["who"], (holder, slug, body) =>
      accessChange(holder, () => options.access!.remove(slug, body.who, granterOf(holder)), (answer) => answer.ok || answer.status === 404),
    );

  // --- a token's secrets and restart -----------------------------------------------

  const secrets = options.secrets ?? null;
  const secretChangesPerHour = options.secretChangesPerHour ?? TOKEN_SECRET_CHANGES_PER_HOUR;
  const restartsPerHour = options.restartsPerHour ?? TOKEN_RESTARTS_PER_HOUR;
  const refusalsPerHour = options.refusalsPerHour ?? TOKEN_REFUSALS_PER_HOUR;

  /** What a token asks for, and the power each takes of its person's role. */
  type Work = "list" | "write" | "restart";
  const POWERS: Record<Work, Power> = { list: "secrets.list", write: "secrets.write", restart: "restart" };
  type WorkOperation = TokenRefusal["operation"];

  /** The requester the secrets routes act for: the token, and the person it belongs to. */
  const whoOf = (holder: Holder): Who => ({ actor: `token:${holder.identity.id}`, member: holder.identity.member, token: holder.identity.id });

  function roleOn(rights: MemberRights, slug: string): Role | null {
    return Object.hasOwn(rights.roles, slug) ? rights.roles[slug]! : null;
  }

  /** The slug a token names, or the refusal: a platform project reads as unknown, as any other it does not reach. */
  function tokenSlug(slug: unknown): string | Response {
    if (typeof slug !== "string" || !isValidSlug(slug)) return failure("invalid", "slug: lowercase letters, digits and dashes");
    if (reservedReason(slug, options.zone) !== null) return failure("not-found", `no project ${slug} for this token`);
    return slug;
  }

  const deploying = (slug: string) => failure("busy", `a deployment of ${slug} is running, and restarts it once done: wait for it to finish`);

  /**
   * May an owner's token without `public` change this project's secrets?
   * Those of a project it could deploy as the machine carries it alone, its
   * deposited manifest judged as a deployment of it would be
   * (src/control/policy.ts, `decideManifest`), and restricted as its general
   * access reads it, the portal asked for and its protected block in
   * service. The manifest's `portal` alone was not enough: paths exempted
   * from the portal are public, and so is a site whose protected block is
   * not in place. A manifest missing, unreadable or refused is not.
   */
  async function privateTokenWrites(identity: Identity, slug: string): Promise<boolean> {
    const raw = await system.readManifest(slug);
    if (raw === null) return false;
    const { manifest, errors } = parseManifest(raw);
    if (manifest === undefined || errors.length > 0) return false;
    const door = portalFromManifest(raw, slug);
    if (door.kind !== "read" || !door.portal) return false;
    if (decideManifest(manifest, identity.scope, door.portal, options.zone).kind !== "allowed") return false;
    return secrets !== null && (await secrets.restricted(slug));
  }

  /**
   * A refusal of this token's, journaled once its hour allows it: each costs
   * one of `TOKEN_REFUSALS_PER_HOUR`, charged before the line is written, and
   * past them the answer is `too-many-attempts`, journaled no more. Without
   * this bound, a stolen token would push its own changes out of the journal
   * within the hour, twenty refusals a minute, and spend nothing of its hour.
   * `quiet`: judged again once the turn has come, journaled once already.
   */
  async function refusal(holder: Holder, slug: string, operation: WorkOperation, detail: string, refused: Response, quiet: boolean): Promise<Response> {
    if (quiet) return refused;
    const bounded = withinHour(`refusals:${holder.identity.id}`, 1, refusalsPerHour, "refused requests");
    if (bounded !== null) return bounded;
    await secrets?.refuse({ operation, result: "rejects", actor: `token:${holder.identity.id}`, member: holder.identity.member, slug, detail });
    return refused;
  }

  /**
   * May this holder do this work on this project now? In the order of the
   * risk: a person's role first, whatever the token's scope says, as for a
   * deployment (`judgeSlug`); then the project among those the token
   * reaches, any other reading as unknown and never journaled, a guess
   * learning nothing; the project on the machine; then the `secrets` flag,
   * which a restart does not need: any token that deploys a project may
   * restart it. An owner's token without `public` changes the secrets of a
   * project it could deploy as it stands and that is restricted
   * (`privateTokenWrites`): it changes nothing of a project it could not
   * deploy, nor of one in the open. A person's token answers to the role
   * instead, as for a deployment. Each refusal journaled is charged to the
   * token's hour (`refusal`).
   */
  async function judgeWork(holder: Holder, slug: string, work: Work, operation: WorkOperation, quiet = false): Promise<Response | null> {
    const { identity, rights } = holder;
    if (rights !== null) {
      const role = roleOn(rights, slug);
      if (!may(role, POWERS[work])) return refusal(holder, slug, operation, roleDetail(role), failure("out-of-scope", powerRefusal(rights.email, role, slug, POWERS[work])), quiet);
    }
    if (!identity.owned.includes(slug) && !identity.scope.slugs.includes(slug)) return failure("not-found", `no project ${slug} for this token`);
    if (!(await system.projectExists(slug))) return failure("not-found", `${slug} is not deployed on this machine`);
    if (work === "restart") return null;
    if (identity.scope.secrets !== true) return noSecrets(holder, slug, operation, quiet);
    if (work === "write" && rights === null && !identity.scope.public && !(await privateTokenWrites(identity, slug))) {
      const message = `${slug} is not restricted on the machine as this token could deploy it, and this token, which deploys private sites only, changes the secrets of those alone: ask the owner of the machine`;
      return refusal(holder, slug, operation, "not restricted", failure("out-of-scope", message), quiet);
    }
    return null;
  }

  /**
   * Does the project keep its variables in its store: an app, not the
   * dashboard nor the portal, whose deployed manifest conforms and lists
   * names, or nothing, rather than files? A manifest missing or refused
   * is not: the old route keeps today's rules for it.
   */
  async function keepsAStore(slug: string): Promise<boolean> {
    const raw = await system.readManifest(slug);
    if (raw === null) return false;
    const { manifest, errors } = parseManifest(raw);
    if (manifest === undefined || errors.length > 0) return false;
    return hasStore(manifest) && secretsOf(manifest).form !== "legacy";
  }

  /** A token without the `secrets` flag: refused, journaled within its hour. */
  function noSecrets(holder: Holder, slug: string, operation: WorkOperation, quiet: boolean): Promise<Response> {
    const another = holder.rights === null ? "ask the owner of the machine for one that may manage secrets" : "mint one with Manage secrets from the dashboard's Tokens page";
    return refusal(holder, slug, operation, "no secrets permission", failure("out-of-scope", `this token may not manage secrets: ${another}`), quiet);
  }

  /** What each token used of its hour, by bound: in memory, a restart of the steward forgets it. */
  const spent = new Map<string, number[]>();

  function recentOf(key: string): number[] {
    const now = system.now();
    const recent = (spent.get(key) ?? []).filter((at) => now - at < HOUR_MS && at <= now);
    if (recent.length === 0) spent.delete(key);
    else spent.set(key, recent);
    return recent;
  }

  function spend(key: string, cost: number): void {
    spent.set(key, [...(spent.get(key) ?? []), ...Array<number>(cost).fill(system.now())]);
    // A map that keeps only the tokens seen this hour.
    if (spent.size > 10_000) for (const old of [...spent.keys()].slice(0, 1_000)) spent.delete(old);
  }

  /** One charge made since `since` given back: the work it was counted for wrote no line of this bound. */
  function giveBack(key: string, since: number): void {
    const times = spent.get(key) ?? [];
    const index = times.findLastIndex((at) => at >= since);
    if (index >= 0) times.splice(index, 1);
  }

  /**
   * `cost` more of this token's hour, or the refusal with the seconds until
   * enough of it ages out. Counted before the work, whatever comes of it: a
   * refused change is a journal line too.
   */
  function withinHour(key: string, cost: number, limit: number, what: string): Response | null {
    const recent = recentOf(key);
    if (recent.length + cost > limit) {
      const index = Math.min(recent.length - 1, recent.length + cost - limit - 1);
      const wait = index < 0 ? HOUR_MS / 1000 : Math.max(1, Math.ceil((recent[index]! + HOUR_MS - system.now()) / 1000));
      const body: ControlFailure = { error: "too-many-attempts", message: `${limit} ${what} per hour at most for a token: try again in ${wait} s`, wait };
      return Response.json(body, { status: CONTROL_STATUSES["too-many-attempts"] });
    }
    spend(key, cost);
    return null;
  }

  async function secretsList(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    const holder = await identify(body.bearer);
    if (holder instanceof Response) return holder;
    const slug = tokenSlug(body.slug);
    if (slug instanceof Response) return slug;
    const refused = await judgeWork(holder, slug, "list", "list");
    if (refused !== null) return refused;
    return secrets!.list(slug, whoOf(holder));
  }

  /**
   * A change of `<slug>.env`: the body read first, every name's shape and
   * every value judged before the token is, so that nothing malformed goes
   * further; then the token, and the change handed over with a `still`
   * judged again once the secrets' lock is taken.
   */
  async function secretsChange(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug", "file", "set", "remove"], bodyTimeoutMs, MAX_SECRETS_CHANGE_BODY_BYTES);
    if (body instanceof Response) return body;
    const change = readSecretsChange(body.set, body.remove);
    if ("refusal" in change) return failure("invalid", change.refusal);
    if (typeof body.file !== "string") return failure("invalid", "file: the name of the project's .env file");
    const holder = await identify(body.bearer);
    if (holder instanceof Response) return holder;
    const slug = tokenSlug(body.slug);
    if (slug instanceof Response) return slug;
    const operation = change.set.length === 0 && change.remove.length > 0 ? "remove" : "set";
    const refused = await judgeWork(holder, slug, "write", operation);
    if (refused !== null) return refused;
    // A project that keeps its variables in its store: a `<slug>.env` its
    // units no longer read would take the change and change nothing. A CLI
    // from before the store sends this route; it is told to update.
    if (await keepsAStore(slug)) return refusal(holder, slug, operation, "kept in its store", failure("out-of-scope", STORE_FORM), false);
    // The file asked for is never quoted nor journaled: a value pasted in its place would stay.
    if (body.file !== `${slug}.env`) return refusal(holder, slug, operation, "out-of-scope", failure("out-of-scope", `a token manages ${slug}.env alone`), false);
    const names = change.set.length + change.remove.length;
    const key = `secrets:${holder.identity.id}`;
    const bounded = withinHour(key, Math.max(1, names), secretChangesPerHour, "variable names set or removed");
    if (bounded !== null) return bounded;
    const still = async (): Promise<Response | null> => {
      const again = await identify(body.bearer, false);
      if (again instanceof Response) return again;
      return judgeWork(again, slug, "write", operation, true);
    };
    const answer = await secrets!.change(req, { slug, file: body.file, set: change.set, remove: change.remove }, whoOf(holder), still);
    // A file created alongside names is one line more in the journal: counted once known.
    if (answer.status === 201 && names > 0) spend(key, 1);
    return answer;
  }

  /**
   * The tokens with a restart under way. One at a time each: a restart holds
   * a request of this socket, of `maxInFlight`, for up to some 43 seconds,
   * and a token that fired them side by side on every project it deploys
   * would hold them all.
   */
  const restarting = new Set<string>();

  /**
   * A restart, for any token that may deploy the project, a person's while
   * they hold `restart` there: never while its installer runs, which
   * restarts it at its own end, asked again once the project's turn has
   * come, a deployment started meanwhile included.
   */
  async function restartRoute(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    const holder = await identify(body.bearer);
    if (holder instanceof Response) return holder;
    const slug = tokenSlug(body.slug);
    if (slug instanceof Response) return slug;
    const refused = await judgeWork(holder, slug, "restart", "restart");
    if (refused !== null) return refused;
    if (await isActive(installerUnit(slug))) return deploying(slug);
    const id = holder.identity.id;
    if (restarting.has(id)) return failure("busy", "this token's previous restart is still under way: wait for its verdict, then ask again");
    const bounded = withinHour(`restart:${id}`, 1, restartsPerHour, "restarts");
    if (bounded !== null) return bounded;
    const still = async (): Promise<Response | null> => {
      const again = await identify(body.bearer, false);
      if (again instanceof Response) return again;
      const judged = await judgeWork(again, slug, "restart", "restart", true);
      if (judged !== null) return judged;
      return (await isActive(installerUnit(slug))) ? deploying(slug) : null;
    };
    restarting.add(id);
    try {
      return await secrets!.restart(req, slug, whoOf(holder), still);
    } finally {
      restarting.delete(id);
    }
  }

  // --- a token's work on a project's store -------------------------------------------

  const store = options.store ?? null;

  /**
   * May this holder list or write this project's store now, and is it a
   * slug the machine does not carry yet? A deployed project is judged as
   * for its secrets (`judgeWork`): the person's role, the project among
   * those the token reaches, the flag, and an owner's token without
   * `public` writes the store of a project restricted on the machine alone.
   *
   * A slug not deployed is judged as the deployment that would create it
   * (`judgeSlug`): a name the token may not create, another token's, of a
   * platform's prefix, reads as unknown and is never journaled, a guess
   * learning nothing; then the flag, journaled; then what a removed
   * project left under the name (`leftoversReason`), a store there that no
   * write of this token made included, whoever the registry names for the
   * slug: the token would otherwise adopt it, and then deploy code that
   * reads it. Not `public`: the project it creates will be private
   * (src/control/policy.ts).
   */
  async function judgeStoreWork(holder: Holder, slug: string, work: "list" | "write", operation: WorkOperation, quiet = false): Promise<{ creating: boolean } | Response> {
    if (await system.projectExists(slug)) {
      const refused = await judgeWork(holder, slug, work, operation, quiet);
      return refused ?? { creating: false };
    }
    const registry = await team();
    if (registry instanceof Response) return registry;
    const owner = registry.owners[slug] ?? null;
    if (judgeSlug(holder, slug, { exists: false, owner }).kind === "refused") return failure("not-found", `no project ${slug} for this token`);
    if (holder.identity.scope.secrets !== true) return noSecrets(holder, slug, operation, quiet);
    let left: Leftovers;
    try {
      left = await system.leftovers(slug);
    } catch (e) {
      console.error(`control: what the machine keeps under ${slug} does not read (${e instanceof Error ? e.message : errorName(e)}): its store refused to a token`);
      return failure("failure", `what a removed project may have left under ${slug} cannot be read on the machine, and no token writes its store meanwhile: the owner must read the steward's log`);
    }
    const reason = leftoversReason(slug, { ...left, store: left.store && !madeStore(await claimsNow(), slug, holder.identity.id) });
    if (reason !== null) return failure("reserved", reason);
    return { creating: true };
  }

  /**
   * Room for one more name this token holds on a slug the machine does not
   * carry, asked before a write that may lay its store: the bound of a
   * creation (`uncarriedBound`), and the claims' own. Read alone: the name
   * is recorded only once the store answers that the write made its folder
   * (`recordStoreMade`).
   */
  async function roomForStore(holder: Holder, slug: string): Promise<Response | null> {
    const registry = await team();
    if (registry instanceof Response) return registry;
    if (registry.owners[slug] === holder.identity.id) return null;
    const bounded = await uncarriedBound(registry, holder.identity.id, slug);
    if (bounded !== null) return bounded;
    const claims = await claimsToChange();
    if (claims instanceof Response) return claims;
    if (!Object.hasOwn(claims, slug) && Object.keys(claims).length >= MAX_CLAIMS) {
      return failure("too-many-attempts", "the machine holds as many names for tokens as it keeps: the owner frees the names nobody deploys with sitesolide remove --confirm <name>");
    }
    return null;
  }

  /**
   * The slug recorded as this token's, and its store as made by it, once the
   * store answered that this write made its folder, in the tokens' queue: a
   * write that made nothing, a removal of a name the store never held or a
   * refused set, claims nothing. Not when the machine carries the project
   * by then: its store is the project's, deployed by whoever deployed it.
   * A record that fails leaves a store no token holds, which none may then
   * adopt, its writer included: said in the log, for the owner.
   */
  function recordStoreMade(holder: Holder, slug: string): Promise<void> {
    const { identity } = holder;
    return serially(async () => {
      if (await system.projectExists(slug)) return;
      const claims = await claimsToChange();
      if (claims instanceof Response) {
        console.error(`control: the store of ${slug} made by token ${identity.id} is not recorded as its own: claims.json does not read`);
        return;
      }
      await system.writeClaims(encodeClaims(withStoreMade(claims, slug, identity.id, system.now())));
      const registry = await team();
      if (registry instanceof Response) return;
      const owned = recordOwnership(registry, slug, identity.id);
      if (owned !== null && (await save(owned)) !== null) {
        console.error(`control: ${slug} not recorded as token ${identity.id}'s: the registry is full`);
        return;
      }
      console.log(`control: ${slug} is now token ${identity.id}'s, its store made ahead of its first deployment`);
    }).catch((e) => console.error(`control: the store of ${slug} made by token ${identity.id} is not recorded (${errorName(e)})`));
  }

  /** Did this answer make the store's folder? One journal line more, counted once known. */
  async function answerMadeStore(answer: Response): Promise<boolean> {
    if (answer.status !== 200 && answer.status !== 201) return false;
    try {
      return ((await answer.clone().json()) as { created?: unknown }).created === true;
    } catch {
      return false;
    }
  }

  /**
   * A project's store as the token reads it. `quiet`: the listing a
   * deployment asks for (`GET .../store?for=deploy`), to learn whether it
   * would drop values: a refusal for scope is then neither journaled nor
   * charged to the token's hour, which a token deploying without Manage
   * secrets would otherwise exhaust, sixty deployments an hour; it still
   * answers the refusal, and lists nothing.
   */
  async function storeList(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug", "quiet"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    if (body.quiet !== undefined && typeof body.quiet !== "boolean") return failure("invalid", "quiet must be true or false");
    const holder = await identify(body.bearer);
    if (holder instanceof Response) return holder;
    const slug = tokenSlug(body.slug);
    if (slug instanceof Response) return slug;
    const judged = await judgeStoreWork(holder, slug, "list", "list", body.quiet === true);
    if (judged instanceof Response) return judged;
    return store!.list(slug, whoOf(holder), judged.creating);
  }

  /**
   * A write to a project's store, its body read and judged first: the
   * token, the slug, the token's hour, for a slug not deployed the room for
   * one more name; the write handed over with a `still` judged again once
   * the secrets' lock is taken, as a change of secrets is; then, when the
   * store answers that this write made its folder, the name recorded as the
   * token's. `cost`: what it spends of the hour, one more once the store's
   * folder was made. `creates`: a write that may lay the store, every one
   * but a file removed.
   */
  async function storeWrite(
    body: Body,
    operation: WorkOperation,
    cost: number,
    creates: boolean,
    hand: (who: Who, slug: string, creating: boolean, still: () => Promise<Response | null>) => Promise<Response>,
  ): Promise<Response> {
    const holder = await identify(body.bearer);
    if (holder instanceof Response) return holder;
    const slug = tokenSlug(body.slug);
    if (slug instanceof Response) return slug;
    const judged = await judgeStoreWork(holder, slug, "write", operation);
    if (judged instanceof Response) return judged;
    const key = `secrets:${holder.identity.id}`;
    const bounded = withinHour(key, Math.max(1, cost), secretChangesPerHour, "secret names and files changed");
    if (bounded !== null) return bounded;
    if (judged.creating && creates) {
      const room = await roomForStore(holder, slug);
      if (room !== null) return room;
    }
    const still = async (): Promise<Response | null> => {
      const again = await identify(body.bearer, false);
      if (again instanceof Response) return again;
      const rejudged = await judgeStoreWork(again, slug, "write", operation, true);
      return rejudged instanceof Response ? rejudged : null;
    };
    const answer = await hand(whoOf(holder), slug, judged.creating, still);
    if (await answerMadeStore(answer)) {
      spend(key, 1);
      if (judged.creating) await recordStoreMade(holder, slug);
    }
    return answer;
  }

  /** Names set and removed in one write, all or nothing. A name that starts like a key is a value, refused unquoted. */
  async function storeChange(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug", "set", "remove"], bodyTimeoutMs, MAX_SECRETS_CHANGE_BODY_BYTES);
    if (body instanceof Response) return body;
    const change = readSecretsChange(body.set, body.remove, true);
    if ("refusal" in change) return failure("invalid", change.refusal);
    const operation = change.set.length === 0 && change.remove.length > 0 ? "remove" : "set";
    return storeWrite(body, operation, change.set.length + change.remove.length, true, (who, slug, creating, still) =>
      store!.change(req, { slug, set: change.set, remove: change.remove }, who, creating, still),
    );
  }

  /** A value drawn on the machine: never sent back, journaled as a set. */
  async function storeGenerate(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug", "name", "format", "bytes", "replace"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    const asked = readGenerate(body.name, body.format, body.bytes, body.replace);
    if ("refusal" in asked) return failure("invalid", asked.refusal);
    return storeWrite(body, "set", 1, true, (who, slug, creating, still) => store!.generate(req, { slug, ...asked }, who, creating, still));
  }

  /** A file of the store, its bytes in base64, 64 KiB at most: judged here first, never quoted. */
  async function storeSetFile(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug", "name", "content"], bodyTimeoutMs, MAX_SECRETS_CHANGE_BODY_BYTES);
    if (body instanceof Response) return body;
    const name = readFileName(body.name);
    if (typeof name !== "string") return failure("invalid", name.refusal);
    const content = readFileContent(body.content);
    if (!(content instanceof Uint8Array)) return failure("invalid", content.refusal);
    const text = body.content as string;
    return storeWrite(body, "set", 1, true, (who, slug, creating, still) => store!.setFile(req, { slug, name, content: text }, who, creating, still));
  }

  /** A file of the store removed, that file alone: never the folder, which every unit loads. */
  async function storeRemoveFile(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug", "name"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    const name = readFileName(body.name);
    if (typeof name !== "string") return failure("invalid", name.refusal);
    return storeWrite(body, "remove", 1, false, (who, slug, _creating, still) => store!.removeFile(req, { slug, name }, who, still));
  }

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
   * another token may create a project of that name later, once the machine
   * keeps none of its snapshots and none of its connector grants, neither
   * of which releasing the name withdraws (`judgeDeployment`). Only once the
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
      // Its claims too: a project created again under the name starts from nobody's.
      const claims = await claimsToChange();
      if (claims instanceof Response) return claims;
      if (Object.hasOwn(claims, slug)) await system.writeClaims(encodeClaims(without(claims, slug)));
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

  // --- a name a token claims, taken back by the owner -----------------------------------

  /** The token the registry names for a slug, but one whose hold is released (`releasedNow`). */
  async function holderOf(registry: Team, claims: Claims, slug: string, onMachine: boolean): Promise<string | null> {
    const named = registry.owners[slug] ?? null;
    return named !== null && (await releasedNow(claims, slug, named, onMachine)) ? null : named;
  }

  /** Is a deployment of this slug under way: a claim's own not ended, or an installer of it at work? */
  async function deployingNow(claims: Claims, slug: string): Promise<boolean> {
    const claim = claimOf(claims, slug);
    if (claim !== null && claim.deployment !== null && (await outcomeOf(claim.deployment, slug, claim.at)) === "under-way") return true;
    return isActive(installerUnit(slug));
  }

  /**
   * `GET /tokens/claim?slug=<slug>` on the owner's socket: does a token hold
   * this name, or claim it, whether or not the machine carries its project,
   * and is a deployment of it under way? The owner's SSH deploy asks before
   * laying anything (`sitesolide deploy`): it waits while a deployment runs,
   * and refuses a name a token holds unless `--adopt`, since the owner's
   * code would otherwise run under a name, and with values, the token may
   * still deploy over. Read alone, no queue.
   */
  async function claimRoute(req: Request): Promise<Response> {
    const wanted = new URL(req.url).searchParams.getAll("slug");
    if (wanted.length !== 1 || !isValidSlug(wanted[0]!)) return failure("invalid", "name one project: ?slug=<slug>");
    const slug = wanted[0]!;
    const registry = await team();
    if (registry instanceof Response) return registry;
    const claims = await claimsToChange();
    if (claims instanceof Response) return claims;
    const onMachine = await system.projectExists(slug);
    const claim = claimOf(claims, slug);
    const holder = (await holderOf(registry, claims, slug, onMachine)) ?? (claim === null ? null : (claim.creator ?? claim.deployer));
    const record = holder === null ? undefined : registry.tokens.find((one) => one.id === holder);
    const answer: ClaimView = {
      slug,
      claimed: holder !== null,
      onMachine,
      token: holder === null ? null : { id: holder, label: record?.label ?? "", email: record?.email ?? "" },
      store: holder !== null && madeStore(claims, slug, holder),
      deploying: await deployingNow(claims, slug),
    };
    return Response.json(answer);
  }

  /**
   * `DELETE /tokens/claim { slug }` on the owner's socket: the owner takes
   * a name back from the token that holds or claims it, before deploying it
   * themselves (`sitesolide deploy --adopt`), on the machine or not: the
   * token's hold, its claim and its person's creation of it dropped, as
   * `DELETE /tokens/project` forgets a removed project's token, and the
   * store's variables and files moved aside first, kept as their previous
   * versions and named in the answer, so that none of the token's values
   * stays in effect under the owner's code. Its people with access stay,
   * the owner's to change. Refused while a deployment of it runs. A name no
   * token holds changes nothing, the owner's own store above all.
   * Journaled under the owner.
   */
  async function takeBackRoute(req: Request): Promise<Response> {
    const body = await readBody(req, ["slug"], bodyTimeoutMs);
    if (body instanceof Response) return body;
    const { slug } = body;
    if (typeof slug !== "string" || !isValidSlug(slug)) return failure("invalid", "slug: lowercase letters, digits and dashes");
    const taken = await takeBack(slug, true);
    if (taken instanceof Response) return taken;
    const answer: ClaimReleased = { slug, ...taken };
    return Response.json(answer);
  }

  /**
   * A name taken back from the token that holds or claims it, in the
   * tokens' queue. `adopting`: the owner's `DELETE /tokens/claim`, on the
   * machine or not, refused while a deployment of it runs, the store moved
   * aside here (`storeAside`); otherwise the owner's write into a store of
   * a name the machine does not carry, whose store src/secrets/steward.ts
   * has moved aside already, under its lock, before that write.
   */
  function takeBack(slug: string, adopting: boolean): Promise<{ released: string | null; dropped: { variables: string[]; files: string[] } } | Response> {
    return serially(async () => {
      const nothing = { variables: [] as string[], files: [] as string[] };
      const onMachine = await system.projectExists(slug);
      if (!adopting && onMachine) return { released: null, dropped: nothing };
      const registry = await team();
      if (registry instanceof Response) return registry;
      const claims = await claimsToChange();
      if (claims instanceof Response) return claims;
      const claim = claimOf(claims, slug);
      const holder = registry.owners[slug] ?? null;
      if (holder === null && claim === null) return { released: null, dropped: nothing };
      if (adopting && (await deployingNow(claims, slug))) {
        return failure("busy", `a deployment of ${slug} is under way: wait for it to end, then take the name back`);
      }
      let dropped = nothing;
      if (adopting && options.storeAside !== undefined && options.storeAside !== null) {
        const aside = await options.storeAside(slug);
        if (!aside.ok) return failure("failure", `the store of ${slug} could not be moved aside: nothing was taken back`);
        dropped = (await aside.json()) as typeof nothing;
      }
      const pendings = await dropPending(slug);
      if (pendings instanceof Response) return pendings;
      if (claim !== null) await system.writeClaims(encodeClaims(without(claims, slug)));
      const released = holder ?? claim?.creator ?? claim?.deployer ?? null;
      if (holder !== null) {
        const forgotten = forgetOwnership(registry, slug);
        if (forgotten !== null) {
          const refused = await save(forgotten.team);
          if (refused !== null) return refused;
        }
      }
      const where = onMachine ? "its project on the machine adopted" : "before any project of that name";
      console.log(`control: ${slug} taken back by the owner from token ${released}, ${where}`);
      await options.members?.journal({ operation: "project.remove", result: "ok", actor: "owner", member: null, detail: `taken back from token ${released}, ${where}`, slug });
      return { released, dropped };
    });
  }

  /**
   * The owner wrote into a project's store, on the dashboard or over SSH
   * (told by src/secrets/steward.ts once the write answered): a name the
   * machine does not carry is the owner's from then on, whatever a token
   * claimed there, and even while a deployment of it by the token runs,
   * which its installer then refuses (the store no longer its own). Never
   * fails the write it follows. A project on the machine stays its
   * holder's: the owner sets a colleague's secret there as any other.
   */
  async function ownerWroteStore(slug: string): Promise<void> {
    if (!isValidSlug(slug)) return;
    const taken = await takeBack(slug, false).catch((e: unknown) => failure("failure", errorName(e)));
    if (taken instanceof Response) console.error(`control: ${slug} not taken back from a token after the owner wrote into its store`);
  }

  /**
   * Asked under the secrets' lock before an owner's write into a store
   * (src/secrets/steward.ts, `ownerStoreClaimed`): does a token's write
   * ahead hold it, the machine not carrying the project? Then it is moved
   * aside before the owner's write lands. Read alone: never this file's
   * queue, which may wait on that lock.
   */
  async function storeClaimed(slug: string): Promise<boolean> {
    if (!isValidSlug(slug) || (await system.projectExists(slug))) return false;
    // Claims that do not read serve no token meanwhile (`identify`): nothing moved.
    const claims = await claimsNow();
    const claim = claims === null ? null : claimOf(claims, slug);
    return claim !== null && claim.creator !== null;
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
    return (await outcomeOf(creation.deployment, creation.slug, creation.at)) !== "under-way";
  }

  /**
   * How a deployment of this slug, accepted at `at`, went (claims.ts): under
   * way while its result says so or none is there yet within the grace, its
   * installer active; succeeded only by its own final result; ended
   * otherwise. A result that does not read, or an earlier one of the same
   * id, says nothing yet.
   */
  async function outcomeOf(deployment: string, slug: string, at: number): Promise<DeploymentOutcome> {
    const judgement = judgeResult(await system.readResult(deployment), deployment, options.uidRoot);
    if (judgement.kind === "absent") return system.now() - at > graceMs && !(await isActive(installerUnit(slug))) ? "ended" : "under-way";
    if (judgement.kind !== "read") return "under-way";
    const { result } = judgement;
    if (result.slug !== slug || result.startedAt < at) return "under-way";
    if (result.state === "running") return (await stopped(result)) ? (result.laid === true ? "laid" : "ended") : "under-way";
    if (result.state === "succeeded") return "succeeded";
    return result.laid === true ? "laid" : "ended";
  }

  /**
   * The creations settled, under one rule. Its person is made Admin only
   * when all of this holds at once: its own installer has ended, having
   * laid the project's folder itself and kept it, its deployment succeeded
   * or not (a service that did not start for want of a secret: they deploy
   * it again), a creation's installer never laying itself over a project
   * the owner deployed meanwhile (src/installer/pipeline.ts); the machine
   * carries the project, the token that started it still owns its name,
   * and nobody has access to the project yet, which the registry
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
        const outcome = await outcomeOf(creation.deployment, creation.slug, creation.at);
        if (!expired && outcome === "under-way") {
          left.push(creation);
          continue;
        }
        const carried = await system.projectExists(creation.slug);
        if (!carried) undone.push(creation);
        if (expired || !carried || options.members === undefined) {
          console.log(`control: the creation of ${creation.slug} by ${creation.email} ${expired ? "not settled within a day" : "undone"}: dropped, nobody made Admin`);
          continue;
        }
        if (outcome !== "succeeded" && outcome !== "laid") {
          // Whatever the machine carries under the name was not laid by a
          // deployment of theirs: the owner's to give.
          console.log(`control: the creation of ${creation.slug} by ${creation.email} laid nothing that stands: dropped, nobody made Admin`);
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
    if (undone.length > 0) for (const creation of undone) console.log(`control: the creation of ${creation.slug} undone, its name settled with the others`);
    await settleNames();
  }

  /**
   * Every name the tokens' registry holds, or a claim names, settled in the
   * tokens' queue (src/control/claims.ts, `settle`), the facts read once
   * the turn has come:
   *
   *   - a project on the machine that its holder claimed ahead and never
   *     deployed, the owner's SSH deploy of it above all, is no longer the
   *     holder's;
   *   - a name with no project, no store its holder's write made, and no
   *     deployment under way, its installer active, a person's creation
   *     noted, or the claim's own deployment not ended (`ended`), is given
   *     back.
   *
   * So a creation undone, or a write ahead that made nothing, holds no name
   * for good, and `owners` never grows by one name per attempt. A file that
   * does not read settles nothing.
   */
  function settleNames(): Promise<void> {
    return serially(async () => {
      let registry = await team();
      if (registry instanceof Response) return;
      const read = await claimsNow();
      if (read === null) return;
      let claims = read;
      // The tokens' queue may wait on the creations' turn, never the other way.
      const noted = await inCreationsTurn(pending);
      if (noted instanceof Response) return;
      const given: string[] = [];
      for (const slug of new Set([...Object.keys(registry.owners), ...Object.keys(claims)])) {
        const holder = Object.hasOwn(registry.owners, slug) ? registry.owners[slug]! : null;
        const claim = claimOf(claims, slug);
        const onMachine = await system.projectExists(slug);
        const outcome = claim === null || claim.deployment === null ? null : await outcomeOf(claim.deployment, slug, claim.at);
        const noting = noted.some((one) => one.slug === slug) || outcome === "under-way";
        const store = onMachine || noting ? false : await storeKept(slug);
        let settled = settle(claim, holder, { onMachine, store, pending: noting, credited: credited(claim, holder, outcome) });
        // Asked last, of what would otherwise be let go: an installer still at work.
        if ((settled.forget || settled.drop) && !onMachine && !noting && isValidSlug(slug) && (await isActive(installerUnit(slug)))) settled = { forget: false, drop: false };
        if (settled.forget) {
          const forgotten = forgetOwnership(registry, slug);
          if (forgotten !== null) {
            registry = forgotten.team;
            given.push(`${slug} (token ${forgotten.id}${onMachine ? ", laid by no deployment of its that succeeded" : ""})`);
          }
        }
        if (settled.drop) claims = without(claims, slug);
      }
      if (claims !== read) await system.writeClaims(encodeClaims(claims));
      if (given.length === 0 || (await save(registry)) !== null) return;
      console.log(`control: name${given.length === 1 ? "" : "s"} given back: ${given.join(", ")}`);
    });
  }

  /** Is the store's folder there? One that cannot be told counts as there. */
  async function storeKept(slug: string): Promise<boolean> {
    try {
      return await system.storeExists(slug);
    } catch {
      return true;
    }
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
    ...(secrets === null
      ? {}
      : {
          "/control/secrets/list": { POST: secretsList },
          "/control/secrets": { PATCH: secretsChange },
          "/control/restart": { POST: restartRoute },
        }),
    ...(store === null
      ? {}
      : {
          "/control/store/list": { POST: storeList },
          "/control/store": { PATCH: storeChange },
          "/control/store/generate": { POST: storeGenerate },
          "/control/store/file": { PUT: storeSetFile, DELETE: storeRemoveFile },
        }),
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
    owner: serve({
      "/tokens/project": { DELETE: forgetProject },
      "/team/project": { DELETE: forgetProject },
      "/tokens/claim": { GET: claimRoute, DELETE: takeBackRoute },
    }),
    ownerWroteStore,
    storeClaimed,
    migrateTokens,
    settleCreations,
    sweepTokens,
  });
}

/** Does this path belong to the control routes? The steward's entry point routes on it. */
export function isControlPath(path: string): boolean {
  return path.startsWith("/tokens/") || path.startsWith("/team/") || path.startsWith("/control/");
}

