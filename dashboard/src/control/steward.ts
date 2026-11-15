/**
 * The steward's control routes: the token registry, and the start of the
 * installer. Mounted beside the secrets routes on the same socket, by
 * dashboard/steward.ts, under `/tokens/` and `/control/`.
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
 * **Every token is the owner's**, for themselves and their agents. The
 * token owns a project's name from its first deployment; one undone,
 * nothing laid, gives its name back (`settleNames`). No token creates a
 * name under which the machine still keeps a removed project's snapshots or
 * store of secrets (`judgeDeployment`): they would be handed to its code. A
 * person's token from before is refused at every use (src/control/tokens.ts).
 *
 * **team.json stays readable.** Revoked and expired tokens are kept 90 days,
 * then dropped, sooner when room is needed, the oldest first; a token that
 * created a project is kept, its name is its own. A change that would still
 * leave the file past what it is read with is refused, and nothing is
 * written (`pruneTeam`, `save`).
 *
 * **A token never changes access.** A project's guests are the owner's to
 * give, from the dashboard or over SSH (src/access/steward.ts).
 *
 * **A token's restart is judged here too**, then handed to the secrets routes' own code (src/secrets/steward.ts,
 * `secretsForToken`), with the token as the requester, in the project's own
 * turn, where this judgement is made again once the turn has come. Each
 * token is bounded per hour, in memory: what it may push through the
 * journal, its changes, its restarts and its refusals each, and how often
 * it cuts a service.
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
 * project, no store and no deployment under way is given back. No value is
 * ever sent back: neither one set, nor one drawn, nor a file's content.
 *
 * The order of the checks is the order of the risk, as in src/secrets/steward.ts:
 * shape of the body, token, slug, state of the machine, writing.
 */
import type { RandomSource } from "../sessions";
import { isValidSlug, servicesOf, readManifest as parseManifest } from "../../borrowed/manifest";
import { portalFromManifest } from "../../borrowed/portal-vm";
import { unitArgument } from "../../borrowed/unit";
import type { AccessRoutes } from "../access/steward";
import type { StoreForToken, Who } from "../secrets/store-api";
import { createQueue, createServe, errorName, readJsonBody, type Body, type Handler } from "../secrets/requests";
import { readFileContent, readFileName, readGenerate, readSecretsChange } from "./secrets";
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
import { decideManifest, decideSlug, everyProject, leftoversReason, reservedReason, type Leftovers, type SlugDecision } from "./policy";
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
  type PlanResponse,
  type PreflightResponse,
  type TeamResponse,
  OWNER_HOLDER,
} from "./protocol";
import { cleanLine, interrupted, judgeResult } from "./results";
import { finalManifest, Stop } from "../installer/pipeline";
import { judgeLifecycleResult, judgeRenameResult, renameInClaims, renameInTeam } from "./rename";
import { isLifecycle, lifecycleRefusal } from "../../borrowed/lifecycle";
import { renameRefusal, renamedTo } from "../../borrowed/rename";
import { LIFECYCLE_PREFIX, RENAME_PREFIX, type LifecycleRequest, type RenameRequest, type RenameResult } from "./protocol";
import {
  authenticate,
  createToken,
  encodeTeam,
  forgetOwnership,
  MAX_UNCARRIED_NAMES,
  ownedBy,
  pruneTeam,
  readTeam,
  readTokenRequest,
  recordOwnership,
  refusalMessage,
  revokeToken,
  touch,
  views,
  type Team,
} from "./tokens";

/** A token's refusal, into the journal of the secrets routes. */
export type TokenRefusal = {
  operation: "list" | "set" | "remove" | "restart";
  result: "rejects";
  actor: string;
  member: string | null;
  slug: string;
  detail: string;
};

/** A line of the journal, written by the secrets routes. */
export type ControlEvent = {
  operation: "project.remove";
  result: "ok";
  actor: string;
  member: null;
  slug: string;
  detail: string;
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
  /** Into the journal: a project removed or taken back. Absent, nothing is journaled. */
  journal?: (event: ControlEvent) => Promise<void>;
  /** A project removed from the machine: its guests dropped. Absent, a steward without the registry. */
  forgetAccess?: AccessRoutes["forgetProject"] | null;
  /** A project renamed on the machine: its guests moved to the new name. Absent, a steward without the registry. */
  renameAccess?: AccessRoutes["renameProject"] | null;
  /** How long the steward waits on a rename run, its unit's TimeoutStartSec and a margin. */
  renameTimeoutMs?: number;
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
 * What this steward asks the secrets routes for a token's restart. `still`
 * is asked once the project's own turn has come: the token judged again,
 * nothing done on a refusal.
 */
export type SecretsForToken = {
  /** The project's service restarted and observed: `TokenRestartResponse`. */
  restart: (req: Request, slug: string, who: Who, still: () => Promise<Response | null>) => Promise<Response>;
  /** A refusal decided here, into the journal: bounded per token here, before it is asked. */
  refuse: (event: TokenRefusal) => Promise<void>;
  /** Is the project restricted as its general access reads: the portal asked for and its protected block in service? */
  restricted: (slug: string) => Promise<boolean>;
};

/**
 * The handler of the dashboard's socket, and the handler of the owner's
 * socket, which only root opens.
 */
export type ControlHandler = Handler & {
  /** `DELETE /tokens/project`: a project removed from the machine, its token ownership and its guests forgotten. */
  owner: Handler;
  /** Every name the tokens hold settled: a creation undone gives its name back (`settleNames`). */
  settle: () => Promise<void>;
  /** The owner wrote into this project's store: a name the machine does not carry is theirs from then on (src/control/claims.ts). */
  ownerWroteStore: (slug: string) => Promise<void>;
  /** Is this store, of a name the machine does not carry, a token's write ahead, to move aside before the owner's write? Read alone. */
  storeClaimed: (slug: string) => Promise<boolean>;
};

/** Who a bearer is. */
type Holder = { identity: Identity };

/** A slug as a deployment's judgement reads it. */
type SlugState = { exists: boolean; owner: string | null; claims: Claims | null };

/** The biggest body but a change of secrets: a deployment request, its manifest included. */
export const MAX_CONTROL_BODY_BYTES = MAX_MANIFEST_BYTES + 4 * 1024;

/**
 * A change of a store as the dashboard relays it: the API's own bound, and
 * room for the bearer and the slug it adds. The steward's socket
 * admits it (dashboard/steward.ts, `maxRequestBodySize`).
 */
export const MAX_SECRETS_CHANGE_BODY_BYTES = MAX_SECRETS_BODY_BYTES + 4 * 1024;

const HOUR_MS = 3_600_000;

const CURSOR_SHAPE = /^[A-Za-z0-9=;_-]{1,512}$/;

function failure(code: ControlErrorCode, message: string, details?: string[]): Response {
  const body: ControlFailure = details === undefined ? { error: code, message } : { error: code, message, details };
  return Response.json(body, { status: CONTROL_STATUSES[code] });
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

  /** The body, bounded in size and in time, an object with the expected fields and those alone. */
  const readBody = (req: Request, fields: string[], max = MAX_CONTROL_BODY_BYTES) => readJsonBody(req, fields, max, bodyTimeoutMs);

  /**
   * Every change to the registry, one at a time: two creations read side by
   * side would each write a registry without the other's token.
   */
  const serially = createQueue();

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
    return (await claimsNow()) ?? failure("failure", "the tokens' claims on names cannot be read on the machine: the owner must restore /var/lib/sitesolide-steward/claims.json from the steward's backups, never delete it, since a claim dropped hands its name to whoever deploys next");
  }

  /** The claims for a change that may add one on `slug`: a refusal too when they hold as many names as they keep. */
  async function claimsWithRoom(slug: string): Promise<Claims | Response> {
    const claims = await claimsToChange();
    if (claims instanceof Response || Object.hasOwn(claims, slug) || Object.keys(claims).length < MAX_CLAIMS) return claims;
    return failure("too-many-attempts", "the machine holds as many names for tokens as it keeps: the owner frees the names nobody deploys with sitesolide remove --confirm <name>");
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
   * The owner's token for every project, its projects read from the machine
   * at each request: every one the machine carries, but the platform's own
   * and those another token holds, which `sitesolide deploy --adopt` takes
   * back first (`claimRoute`). Read here, so that every judgement that
   * follows, the deployment's, the logs', the store's, the restart's and the
   * access', finds them among the token's own slugs, as for a token granted
   * them one by one.
   */
  async function everyProjectOf(identity: Identity, registry: Team, claims: Claims): Promise<Identity> {
    let folders: string[];
    try {
      folders = [...(await system.readManifests()).keys()];
    } catch (e) {
      console.error(`control: the projects on the machine do not read (${errorName(e)}): the owner's token reaches its own slugs alone`);
      return identity;
    }
    const slugs = new Set(identity.scope.slugs);
    for (const slug of folders) {
      if (reservedReason(slug, options.zone) !== null) continue;
      const holder = registry.owners[slug];
      if (holder !== undefined && holder !== identity.id && !(await releasedNow(claims, slug, holder, true))) continue;
      slugs.add(slug);
    }
    return { ...identity, scope: { ...identity.scope, slugs: [...slugs].sort() } };
  }

  /**
   * The bearer's holder, or the refusal. The last use moves forward at most once an hour; `touching`
   * false for a judgement made again under the secrets' lock, which must
   * never wait on this file's queue while it holds that lock.
   */
  async function identify(bearer: unknown, touching = true): Promise<Holder | Response> {
    const registry = await team();
    if (registry instanceof Response) return registry;
    const now = system.now();
    const result = await authenticate(registry, bearer, now);
    if (result.kind === "refused") return failure("unauthenticated", refusalMessage(result));
    let holder: Holder = { identity: result.identity };
    // What tokens claimed decides which names a token holds: while that does
    // not read, a hold released could come back, so no token is served.
    const claims = await claimsNow();
    if (claims === null) return failure("failure", "the tokens' claims on names do not read on the machine, and no token is served meanwhile: the owner must check /var/lib/sitesolide-steward/claims.json");
    holder = { identity: await heldNow(holder.identity, claims) };
    if (everyProject(holder.identity)) holder = { identity: await everyProjectOf(holder.identity, registry, claims) };
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

  /** May this holder deploy this slug, and would it create it? */
  function judgeSlug(holder: Holder, slug: unknown, state: { exists: boolean; owner: string | null }): SlugDecision {
    return decideSlug(holder.identity, slug, { ...state, zone: options.zone });
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
   * snapshots and store of secrets, which the project created again would
   * be handed (src/control/policy.ts, `leftoversReason`): a store is read
   * by whatever code runs under the slug. A project on the machine is deployed again and never asked; the owner's
   * SSH deploy does not come here.
   *
   * Asked of the deployment itself, in the tokens' queue, right before the
   * request is written and the installer started: a name the machine does
   * not carry gains no snapshot until a run finds its folder, the new
   * project's then. So the installer does not ask again; it could not
   * open the index besides, SQLite in WAL under its read-only /var/lib. One
   * gap stays, the owner's own doing: an index made again from a repository
   * that holds more, its database deleted by hand or a bucket attached from
   * another machine, lists again at its next run what it finds. What does
   * not read refuses the creation: an index that cannot be read must never
   * pass for one that holds nothing.
   */
  async function judgeDeployment(holder: Holder, slug: unknown, state: SlugState): Promise<SlugDecision | Response> {
    const decision = judgeSlug(holder, slug, state);
    if (decision.kind === "refused" || !decision.creating) return decision;
    // The owner brings a removed project back under its name, with what it
    // left: the owner's token for every project is not asked, as the owner's
    // SSH deployment never was.
    if (everyProject(holder.identity)) return decision;
    const target = slug as string;
    let left: Leftovers;
    try {
      left = await system.leftovers(target);
    } catch (e) {
      console.error(`control: what the machine keeps under ${target} does not read (${e instanceof Error ? e.message : errorName(e)}): its creation refused`);
      return failure("failure", `what a removed project may have left under ${target}, its backups or its store of secrets, cannot be read on the machine, and no token creates it meanwhile: the owner must read the steward's log`);
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
   * The owner's route, under the owner's unlock. `holder`, from a dashboard
   * of before, may only say `owner`: every token is the owner's.
   */
  async function newToken(req: Request): Promise<Response> {
    const body = await readBody(req, ["token", "label", "holder", "expiresAt", "scope"]);
    if (body instanceof Response) return body;
    if (!(await options.isUnlocked(body.token))) return failure("locked", "locked, unlock again");
    if (body.holder !== undefined && body.holder !== OWNER_HOLDER) return failure("invalid", "holder: every token is the owner's");
    const request = readTokenRequest({ label: body.label, expiresAt: body.expiresAt, scope: body.scope }, system.now(), options.zone);
    if ("refusal" in request) return failure("invalid", request.refusal);
    return serially(async () => {
      // Checked again once its turn has come, as the secrets routes do.
      if (!(await options.isUnlocked(body.token))) return failure("locked", "locked, unlock again");
      const registry = await team();
      if (registry instanceof Response) return registry;
      const created = await createToken(registry, request, system.now(), options.random);
      if ("refusal" in created) return failure("invalid", created.refusal);
      const refused = await save(created.team);
      if (refused !== null) return refused;
      console.log(`control: token ${created.view.id} created for the owner`);
      const response: CreatedTokenResponse = { token: created.view, secret: created.secret };
      return Response.json(response, { status: 201 });
    });
  }

  /**
   * `POST /tokens/owner { label, expiresAt }` on the owner's socket, which
   * root alone opens: the owner's own token, every permission and every
   * project (`all`), minted for the workstation that runs `sitesolide login
   * --owner` over SSH, as the Tokens page mints one under the unlock. Root
   * over SSH is the proof the unlock stands for: whoever opens this socket
   * already holds the machine. The secret goes back in this answer alone,
   * which the CLI writes into the workstation's vault, never on a screen.
   */
  async function ownerToken(req: Request): Promise<Response> {
    const body = await readBody(req, ["label", "expiresAt"]);
    if (body instanceof Response) return body;
    const request = readTokenRequest(
      { label: body.label, expiresAt: body.expiresAt ?? null, scope: { slugs: [], create: true, outbound: true, domain: true, public: true, secrets: true, all: true } },
      system.now(),
      options.zone,
    );
    if ("refusal" in request) return failure("invalid", request.refusal);
    return serially(async () => {
      const registry = await team();
      if (registry instanceof Response) return registry;
      const created = await createToken(registry, request, system.now(), options.random);
      if ("refusal" in created) return failure("invalid", created.refusal);
      const refused = await save(created.team);
      if (refused !== null) return refused;
      console.log(`control: token ${created.view.id} created for the owner, every project, over SSH`);
      const response: CreatedTokenResponse = { token: created.view, secret: created.secret };
      return Response.json(response, { status: 201 });
    });
  }

  async function revoke(req: Request): Promise<Response> {
    const body = await readBody(req, ["id"]);
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
    const body = await readBody(req, ["bearer"]);
    if (body instanceof Response) return body;
    const holder = await identify(body.bearer);
    if (holder instanceof Response) return holder;
    return Response.json({ identity: holder.identity });
  }

  async function preflight(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug"]);
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
   * `force`, absent or a boolean, and true only for the owner's token for
   * every project: a unit or a block edited by hand replaced, as
   * `sitesolide deploy --force` did over SSH. Or the refusal.
   */
  function forceAsked(value: unknown, identity: Identity): boolean | Response {
    if (value === undefined || value === false) return false;
    if (value !== true) return failure("invalid", "force must be true or false");
    if (!everyProject(identity)) return failure("out-of-scope", "--force replaces a file edited by hand on the machine: the owner's own token for every project alone may ask it, never a token of chosen projects");
    return true;
  }

  /**
   * A deployment judged and planned, nothing written: `sitesolide deploy
   * --dry-run`. The judgement is the deployment's own (`judgeDeployment`),
   * then the manifest the installer would deposit, as the installer computes
   * it (src/installer/pipeline.ts, `finalManifest`), from the manifests the
   * machine carries now. What only the installer reads, the units and the
   * block in service and systemd's reading of a schedule, waits for the
   * deployment, which stops before writing on any of them.
   */
  async function plan(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug", "manifest", "force"]);
    if (body instanceof Response) return body;
    const holder = await identify(body.bearer);
    if (holder instanceof Response) return holder;
    const { identity } = holder;
    const { slug, manifest } = body;
    const force = forceAsked(body.force, identity);
    if (force instanceof Response) return force;
    if (typeof manifest !== "string" || new TextEncoder().encode(manifest).length > MAX_MANIFEST_BYTES) {
      return failure("invalid", "manifest: the text of sitesolide.json, 64 KiB at most");
    }
    const state = await slugState(String(slug ?? ""));
    if (state instanceof Response) return state;
    const decision = await judgeDeployment(holder, slug, state);
    if (decision instanceof Response) return decision;
    if (decision.kind === "refused") return failure(decision.error, decision.message);
    const target = slug as string;
    let deposited: Map<string, string>;
    try {
      deposited = await system.readManifests();
    } catch (e) {
      console.error(`control: the manifests on the machine do not read (${errorName(e)})`);
      return failure("failure", "the manifests on the machine cannot be read: the owner must read the steward's log");
    }
    const request: InstallRequest = {
      deployment: "0".repeat(24),
      slug: target,
      requestedAt: system.now(),
      token: { id: identity.id, email: identity.email },
      scope: identity.scope,
      creating: decision.creating,
      manifest,
    };
    let final: ReturnType<typeof finalManifest>;
    try {
      final = finalManifest(request, deposited);
    } catch (e) {
      if (e instanceof Stop) {
        const known: Record<string, ControlErrorCode> = { "out-of-scope": "out-of-scope", "invalid-manifest": "invalid-manifest", "machine-unreadable": "failure" };
        const code = known[e.code] ?? "invalid-manifest";
        return failure(code, e.message, code === "invalid-manifest" ? [e.message] : undefined);
      }
      throw e;
    }
    const answer: PlanResponse = {
      slug: target,
      creating: decision.creating,
      existing: deposited.has(target),
      portal: final.portal,
      allocated: final.allocated,
      manifest: final.text,
      placeholders: { zone: options.zone, contact: options.contact ?? "" },
    };
    return Response.json(answer);
  }

  /**
   * `DELETE /control/claim { bearer, slug }`: the owner's token for every
   * project takes a name back from the token that holds it, as the owner's
   * socket does for `sitesolide deploy --adopt` (`takeBackRoute`): the hold
   * dropped, the store's values moved aside and named. Any other token is
   * refused, and a name no token holds changes nothing.
   */
  async function claimForToken(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug"]);
    if (body instanceof Response) return body;
    const holder = await identify(body.bearer);
    if (holder instanceof Response) return holder;
    if (!everyProject(holder.identity)) {
      return failure("out-of-scope", "taking a name back from the token that holds it is the owner's: their own token for every project alone may");
    }
    const { slug } = body;
    if (typeof slug !== "string" || !isValidSlug(slug)) return failure("invalid", "slug: lowercase letters, digits and dashes");
    const reserved = reservedReason(slug, options.zone);
    if (reserved !== null) return failure("reserved", reserved);
    const taken = await takeBack(slug, true);
    if (taken instanceof Response) return taken;
    if (taken.released !== null) console.log(`control: ${slug} taken back from token ${taken.released} by the owner's token ${holder.identity.id}`);
    const answer: ClaimReleased = { slug, ...taken };
    return Response.json(answer);
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
    const body = await readBody(req, ["bearer", "deployment", "slug", "manifest", "force"]);
    if (body instanceof Response) return body;
    const holder = await identify(body.bearer);
    if (holder instanceof Response) return holder;
    const { identity } = holder;
    const { deployment, slug, manifest } = body;
    const force = forceAsked(body.force, identity);
    if (force instanceof Response) return force;
    if (typeof deployment !== "string" || !DEPLOYMENT_ID_SHAPE.test(deployment)) return failure("invalid", "not a deployment id");
    // An id is used once: a result already there is another deployment's,
    // which a creation's name would otherwise be settled by.
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

      if (!(await system.installerInstalled())) {
        return failure("not-available", "the installer is not installed on this machine yet: the owner must run sitesolide setup again for this machine, without --minimal");
      }
      const unit = installerUnit(target);
      if (await isActive(unit)) return failure("busy", `a deployment of ${target} is already running: wait for it to finish, then try again`);
      if (await ownerChanging(target)) return ownerBusy(target);

      if (decision.creating) {
        // A name per attempt would grow the registry until nothing reads it:
        // a token holds a bounded number the machine does not carry.
        const held = await team();
        if (held instanceof Response) return held;
        const bounded = await uncarriedBound(held, identity.id, target);
        if (bounded !== null) return bounded;
        // The token owns the name from its first deployment. Which token deployed it, so that a hold this one claimed ahead is
        // kept once the project is there, and the name settled otherwise.
        const claims = await claimsWithRoom(target);
        if (claims instanceof Response) return claims;
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
        token: { id: identity.id, email: identity.email },
        scope: identity.scope,
        creating: decision.creating,
        manifest,
        ...(force ? { force: true } : {}),
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
    // A creation that just ended is settled before its result is handed
    // over: one undone gives its name back at once.
    if (result.state !== "running") await settleNames();
    return Response.json({ result });
  }

  async function logs(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug", "lines", "cursor"]);
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

  // --- a token's secrets and restart -----------------------------------------------

  const secrets = options.secrets ?? null;
  const secretChangesPerHour = options.secretChangesPerHour ?? TOKEN_SECRET_CHANGES_PER_HOUR;
  const restartsPerHour = options.restartsPerHour ?? TOKEN_RESTARTS_PER_HOUR;
  const refusalsPerHour = options.refusalsPerHour ?? TOKEN_REFUSALS_PER_HOUR;

  /** What a token asks for. */
  type Work = "list" | "write" | "restart";
  type WorkOperation = TokenRefusal["operation"];

  /** The requester the secrets routes act for: the token. */
  const whoOf = (holder: Holder): Who => ({ actor: `token:${holder.identity.id}`, member: null, token: holder.identity.id });

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
    await secrets?.refuse({ operation, result: "rejects", actor: `token:${holder.identity.id}`, member: null, slug, detail });
    return refused;
  }

  /**
   * May this holder do this work on this project now? In the order of the
   * risk: the project among those the token reaches, any other reading as unknown and never journaled, a guess
   * learning nothing; the project on the machine; then the `secrets` flag,
   * which a restart does not need: any token that deploys a project may
   * restart it. An owner's token without `public` changes the secrets of a
   * project it could deploy as it stands and that is restricted
   * (`privateTokenWrites`): it changes nothing of a project it could not
   * deploy, nor of one in the open. Each refusal journaled is charged to the
   * token's hour (`refusal`).
   */
  async function judgeWork(holder: Holder, slug: string, work: Work, operation: WorkOperation, quiet = false): Promise<Response | null> {
    const { identity } = holder;
    if (!identity.owned.includes(slug) && !identity.scope.slugs.includes(slug)) return failure("not-found", `no project ${slug} for this token`);
    if (!(await system.projectExists(slug))) return failure("not-found", `${slug} is not deployed on this machine`);
    if (work === "restart") return null;
    if (identity.scope.secrets !== true) return noSecrets(holder, slug, operation, quiet);
    if (work === "write" && !identity.scope.public && !(await privateTokenWrites(identity, slug))) {
      const message = `${slug} is not restricted on the machine as this token could deploy it, and this token, which deploys private sites only, changes the secrets of those alone: ask the owner of the machine`;
      return refusal(holder, slug, operation, "not restricted", failure("out-of-scope", message), quiet);
    }
    return null;
  }

  /** A token without the `secrets` flag: refused, journaled within its hour. */
  function noSecrets(holder: Holder, slug: string, operation: WorkOperation, quiet: boolean): Promise<Response> {
    return refusal(holder, slug, operation, "no secrets permission", failure("out-of-scope", "this token may not manage secrets: ask the owner of the machine for one that may"), quiet);
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

  /**
   * The tokens with a restart under way. One at a time each: a restart holds
   * a request of this socket, of `maxInFlight`, for up to some 43 seconds,
   * and a token that fired them side by side on every project it deploys
   * would hold them all.
   */
  const restarting = new Set<string>();

  /**
   * A restart, for any token that may deploy the project: never while its
   * installer runs, which
   * restarts it at its own end, asked again once the project's turn has
   * come, a deployment started meanwhile included.
   */
  async function restartRoute(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug"]);
    if (body instanceof Response) return body;
    const holder = await identify(body.bearer);
    if (holder instanceof Response) return holder;
    const slug = tokenSlug(body.slug);
    if (slug instanceof Response) return slug;
    const refused = await judgeWork(holder, slug, "restart", "restart");
    if (refused !== null) return refused;
    if (await isActive(installerUnit(slug))) return deploying(slug);
    if (await ownerChanging(slug)) return ownerBusy(slug);
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
   * for its secrets (`judgeWork`): the project among those the token reaches, the flag, and an owner's token without
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
    const claims = await claimsWithRoom(slug);
    return claims instanceof Response ? claims : null;
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
    const body = await readBody(req, ["bearer", "slug", "quiet"]);
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
    // A store written under a name a rename is moving would be left behind it.
    if (await ownerChanging(slug)) return ownerBusy(slug);
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
      if (rejudged instanceof Response) return rejudged;
      return (await ownerChanging(slug)) ? ownerBusy(slug) : null;
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
    const body = await readBody(req, ["bearer", "slug", "set", "remove"], MAX_SECRETS_CHANGE_BODY_BYTES);
    if (body instanceof Response) return body;
    const change = readSecretsChange(body.set, body.remove);
    if ("refusal" in change) return failure("invalid", change.refusal);
    const operation = change.set.length === 0 && change.remove.length > 0 ? "remove" : "set";
    return storeWrite(body, operation, change.set.length + change.remove.length, true, (who, slug, creating, still) =>
      store!.change(req, { slug, set: change.set, remove: change.remove }, who, creating, still),
    );
  }

  /** A value drawn on the machine: never sent back, journaled as a set. */
  async function storeGenerate(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug", "name", "format", "bytes", "replace"]);
    if (body instanceof Response) return body;
    const asked = readGenerate(body.name, body.format, body.bytes, body.replace);
    if ("refusal" in asked) return failure("invalid", asked.refusal);
    return storeWrite(body, "set", 1, true, (who, slug, creating, still) => store!.generate(req, { slug, ...asked }, who, creating, still));
  }

  /** A file of the store, its bytes in base64, 64 KiB at most: judged here first, never quoted. */
  async function storeSetFile(req: Request): Promise<Response> {
    const body = await readBody(req, ["bearer", "slug", "name", "content"], MAX_SECRETS_CHANGE_BODY_BYTES);
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
    const body = await readBody(req, ["bearer", "slug", "name"]);
    if (body instanceof Response) return body;
    const name = readFileName(body.name);
    if (typeof name !== "string") return failure("invalid", name.refusal);
    return storeWrite(body, "remove", 1, false, (who, slug, _creating, still) => store!.removeFile(req, { slug, name }, who, still));
  }

  // --- a project removed, for root -----------------------------------------------------

  /**
   * A project removed from the machine by `sitesolide remove`, over the
   * owner's SSH: the token that created it no longer owns its name, so that
   * another token may create a project of that name later, once the machine
   * keeps none of its snapshots and no store of secrets, neither of which
   * releasing the name withdraws (`judgeDeployment`). Only once the
   * machine no longer carries it: a removal stopped half way keeps the
   * ownership, and running it again finishes both. Journaled under `owner`,
   * the token in the detail. On the owner's socket alone: a compromised
   * dashboard cannot hand a project's name to another token.
   */
  async function forgetProject(req: Request): Promise<Response> {
    const body = await readBody(req, ["slug"]);
    if (body instanceof Response) return body;
    const { slug } = body;
    if (typeof slug !== "string" || !isValidSlug(slug)) return failure("invalid", "slug: lowercase letters, digits and dashes");
    return releaseRemoved(slug);
  }

  /** A project gone from the machine: its name released from its token, its claims dropped, its guests let go. */
  async function releaseRemoved(slug: string): Promise<Response> {
    const released = await serially(async () => {
      if (await system.projectExists(slug)) {
        return failure("busy", `${slug} is still on the machine: remove it first, with sitesolide remove --confirm ${slug}`);
      }
      // Its claims first: a project created again under the name starts from nobody's.
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
    // Its guests go with it, outside this file's queue.
    let dropped = 0;
    if (options.forgetAccess !== undefined && options.forgetAccess !== null) {
      const result = await options.forgetAccess(slug, "owner");
      if (result instanceof Response) return result;
      dropped = result;
    }
    if (released !== null) {
      await options.journal?.({ operation: "project.remove", result: "ok", actor: "owner", member: null, detail: `created by token ${released}, its name free again`, slug });
    }
    return Response.json({ slug, forgotten: released, access: dropped });
  }

  // --- a project renamed ------------------------------------------------------------------

  /** The renames under way, by their current slug: one at a time per project. */
  const renaming = new Set<string>();
  /**
   * The owner's rename or turn off, on, or delete of `slug` under way, or a
   * rename to it: a token's deployment or restart started meanwhile would
   * work from a reading taken before it. The units too, for a run this
   * steward did not start, from before its own restart.
   */
  async function ownerChanging(slug: string): Promise<boolean> {
    if (renaming.has(slug)) return true;
    return (await isActive(`${RENAME_PREFIX}@${slug}.service`)) || (await isActive(`${LIFECYCLE_PREFIX}@${slug}.service`));
  }
  const ownerBusy = (slug: string) => failure("busy", `the owner is changing ${slug} right now: wait for it to finish, then try again`);

  /**
   * The owner renames a project, from the dashboard, unlocked, or over the
   * owner's SSH, `sitesolide rename`. The machine is renamed by its own run,
   * sitesolide-rename@<slug> (src/installer/rename.ts), which this waits
   * on; then this steward's registries follow: the token that created the
   * project still owns it, every token scoped to it reaches it under its new
   * name, its guests open it there.
   *
   * Asked again for a project already renamed on the machine, whose
   * registries did not follow, a crash between the two, it finishes the
   * registries alone: the request is the same, and it is safe to repeat.
   */
  async function renameRoute(req: Request, channel: "dashboard" | "ssh"): Promise<Response> {
    const body = await readBody(req, channel === "dashboard" ? ["token", "slug", "to"] : ["slug", "to"]);
    if (body instanceof Response) return body;
    if (channel === "dashboard" && !(await options.isUnlocked(body.token))) return failure("locked", "locked, unlock again");
    const { slug, to } = body;
    if (typeof slug !== "string" || !isValidSlug(slug)) return failure("invalid", "slug: the project's current slug");
    if (typeof to !== "string" || to.length > 63) return failure("invalid", "to: the project's new slug");
    if (renaming.has(slug) || renaming.has(to)) return failure("busy", `a rename of ${slug} is already running: wait for it to finish`);
    renaming.add(slug);
    renaming.add(to);
    try {
      return await renameProject(slug, to, channel);
    } finally {
      renaming.delete(slug);
      renaming.delete(to);
    }
  }

  async function renameProject(slug: string, to: string, channel: "dashboard" | "ssh"): Promise<Response> {
    if (!(await system.renameInstalled())) {
      return failure("not-available", "this machine cannot rename a project yet: the owner must run sitesolide upgrade");
    }
    let deposited: Map<string, string>;
    try {
      deposited = await system.readManifests();
    } catch (e) {
      console.error(`control: manifests unreadable (${errorName(e)})`);
      return failure("failure", "the manifests on the machine cannot be read: nothing was changed");
    }
    // Renamed on the machine already, by a run whose answer this steward
    // never got to: the registries alone are left.
    const done = !deposited.has(slug) && renamedTo(deposited, slug) === to;
    let result: RenameResult | null = null;
    if (!done) {
      const refusal = renameRefusal(slug, to, deposited, options.zone);
      if (refusal !== null) return failure("invalid", `${refusal}: nothing was changed`);
      let left: Leftovers;
      try {
        left = await system.leftovers(to);
      } catch {
        return failure("failure", "the backups' index does not read: nothing was changed");
      }
      // A removed project's snapshots under the new name would be taken for this one's.
      if (left.snapshots > 0 || left.store) {
        return failure("invalid", `${to} was the name of a removed project, which left ${left.snapshots > 0 ? "backup snapshots" : "a secrets store"} under it: pick another name; nothing was changed`);
      }
      if (await isActive(installerUnit(slug))) return failure("busy", `a deployment of ${slug} is running: wait for it to finish, then rename`);

      const request: RenameRequest = { slug, to, requestedAt: system.now(), actor: OWNER_HOLDER };
      await system.writeRenameRequest(slug, `${JSON.stringify(request)}\n`);
      const unit = `${RENAME_PREFIX}@${slug}.service`;
      console.log(`control: rename of ${slug} to ${to} started, ${channel}`);
      // `start` waits for the run, a oneshot; its result, not its exit code, decides.
      await system.systemctl(["start", unit], options.renameTimeoutMs ?? 11 * 60_000);
      const judged = judgeRenameResult(await system.readRenameResult(slug), slug, request.requestedAt, options.uidRoot);
      if (judged.kind !== "read") {
        return failure("failure", `the rename left no result to read (${judged.kind === "absent" ? "none written" : judged.reason}): the owner must read journalctl -u ${unit}`);
      }
      result = judged.result;
      if (result.state !== "succeeded") {
        const message = result.error?.message ?? `the rename stopped before finishing: the owner must read journalctl -u ${unit}`;
        return failure(result.error?.code === "refused" ? "invalid" : result.error?.code === "caddy-busy" || result.error?.code === "backup-busy" ? "busy" : "failure", message, result.log);
      }
    }

    // The registries, the machine renamed.
    const moved = await serially(async () => {
      const claims = await claimsToChange();
      if (claims instanceof Response) return claims;
      const renamedClaims = renameInClaims(claims, slug, to);
      if (renamedClaims !== null) await system.writeClaims(encodeClaims(renamedClaims));
      const registry = await team();
      if (registry instanceof Response) return registry;
      const renamed = renameInTeam(registry, slug, to);
      if (renamed !== null) {
        const refused = await save(renamed);
        if (refused !== null) return refused;
      }
      return null;
    });
    if (moved instanceof Response) return failure("failure", `${slug} is renamed ${to} on the machine, but the tokens' registry did not follow: rename it again, which finishes it`);
    let people = 0;
    if (options.renameAccess !== undefined && options.renameAccess !== null) {
      const answer = await options.renameAccess(slug, to, OWNER_HOLDER);
      if (answer instanceof Response) return failure("failure", `${slug} is renamed ${to} on the machine, but its guests did not follow: rename it again, which finishes it`);
      people = answer;
    }
    console.log(`control: ${slug} renamed ${to}`);
    return Response.json({
      slug,
      to,
      url: result?.url ?? `https://${to}.${options.zone}/`,
      log: result?.log ?? [`-> ${slug} was already renamed ${to} on the machine: the registries followed`],
      people,
    });
  }

  // --- a project turned off, on, or removed ------------------------------------------------

  /**
   * The owner turns a project off or on, or removes it: from the dashboard,
   * unlocked, the slug retyped for a removal; or over the owner's SSH,
   * `sitesolide disable` and `enable`. The machine's own run does it,
   * sitesolide-lifecycle@<slug> (src/installer/lifecycle.ts), which this
   * waits on; a removal then lets go of the project's token and guests, as
   * `sitesolide remove` does through /tokens/project.
   */
  async function lifecycleRoute(req: Request, channel: "dashboard" | "ssh"): Promise<Response> {
    const body = await readBody(req, channel === "dashboard" ? ["token", "slug", "action", "confirmation"] : ["slug", "action"]);
    if (body instanceof Response) return body;
    if (channel === "dashboard" && !(await options.isUnlocked(body.token))) return failure("locked", "locked, unlock again");
    const { slug, action } = body;
    if (typeof slug !== "string" || !isValidSlug(slug)) return failure("invalid", "slug: the project's slug");
    if (!isLifecycle(action)) return failure("invalid", "action: disable, enable or remove");
    if (action === "remove" && channel === "dashboard" && body.confirmation !== slug) return failure("invalid", `type ${slug} to confirm its removal`);
    if (renaming.has(slug)) return failure("busy", `a change of ${slug} is already running: wait for it to finish`);
    renaming.add(slug);
    try {
      if (!(await system.lifecycleInstalled())) return failure("not-available", "this machine cannot do that yet: the owner must run sitesolide upgrade");
      let deposited: Map<string, string>;
      try {
        deposited = await system.readManifests();
      } catch {
        return failure("failure", "the manifests on the machine cannot be read: nothing was changed");
      }
      const refusal = lifecycleRefusal(action, slug, deposited, options.zone);
      if (refusal !== null) return failure("invalid", `${refusal}: nothing was changed`);
      if (await isActive(installerUnit(slug))) return failure("busy", `a deployment of ${slug} is running: wait for it to finish`);
      const request: LifecycleRequest = { slug, action, requestedAt: system.now(), actor: OWNER_HOLDER };
      await system.writeLifecycleRequest(slug, `${JSON.stringify(request)}\n`);
      const unit = `${LIFECYCLE_PREFIX}@${slug}.service`;
      console.log(`control: ${slug} ${action}, ${channel}`);
      await system.systemctl(["start", unit], options.renameTimeoutMs ?? 11 * 60_000);
      const judged = judgeLifecycleResult(await system.readLifecycleResult(slug), slug, request.requestedAt, options.uidRoot);
      if (judged.kind !== "read") return failure("failure", `the run left no result to read (${judged.kind === "absent" ? "none written" : judged.reason}): the owner must read journalctl -u ${unit}`);
      const result = judged.result;
      if (result.state !== "succeeded") {
        const code = result.error?.code;
        return failure(code === "refused" ? "invalid" : code === "caddy-busy" || code === "backup-busy" ? "busy" : "failure", result.error?.message ?? `the run stopped before finishing: the owner must read journalctl -u ${unit}`, result.log);
      }
      if (action === "remove") {
        const released = await releaseRemoved(slug);
        if (!released.ok) return failure("failure", `${slug} is removed from the machine, but its token and guests were not let go: run sitesolide remove --confirm ${slug} in its folder, which finishes it`, result.log);
      }
      return Response.json({ slug, action, log: result.log });
    } finally {
      renaming.delete(slug);
    }
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
   * token's hold and its claim dropped, as
   * `DELETE /tokens/project` forgets a removed project's token, and the
   * store's variables and files moved aside first, kept as their previous
   * versions and named in the answer, so that none of the token's values
   * stays in effect under the owner's code. Its guests stay, the owner's to
   * change. Refused while a deployment of it runs. A name no
   * token holds changes nothing, the owner's own store above all.
   * Journaled under the owner.
   */
  async function takeBackRoute(req: Request): Promise<Response> {
    const body = await readBody(req, ["slug"]);
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
      await options.journal?.({ operation: "project.remove", result: "ok", actor: "owner", member: null, detail: `taken back from token ${released}, ${where}`, slug });
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
   * holder's: the owner sets a secret there as any other.
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

  // --- the names the tokens hold ---------------------------------------------------

  /**
   * How a deployment of this slug, accepted at `at`, went (claims.ts): under
   * way while its result says so or none is there yet within the grace, its
   * installer active; succeeded only by its own final result; ended
   * otherwise, an installer stopped half way (`stopped`) included. No result
   * past the grace, its installer not active, is an end too: results live on
   * tmpfs, and a reboot takes them. A result that does not read, or an
   * earlier one of the same id, of a project of that name removed since,
   * says nothing yet.
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
   * Every name the tokens' registry holds, or a claim names, settled in the
   * tokens' queue (src/control/claims.ts, `settle`), the facts read once
   * the turn has come:
   *
   *   - a project on the machine that its holder claimed ahead and never
   *     deployed, the owner's SSH deploy of it above all, is no longer the
   *     holder's;
   *   - a name with no project, no store its holder's write made, and no
   *     deployment under way, its installer active or the claim's own
   *     deployment not ended (`outcomeOf`), is given back.
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
      const given: string[] = [];
      for (const slug of new Set([...Object.keys(registry.owners), ...Object.keys(claims)])) {
        const holder = Object.hasOwn(registry.owners, slug) ? registry.owners[slug]! : null;
        const claim = claimOf(claims, slug);
        const onMachine = await system.projectExists(slug);
        const outcome = claim === null || claim.deployment === null ? null : await outcomeOf(claim.deployment, slug, claim.at);
        const noting = outcome === "under-way";
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

  const routes: Record<string, Record<string, Handler>> = {
    "/tokens/list": { GET: listTokens },
    "/tokens/create": { POST: newToken },
    "/tokens/revoke": { POST: revoke },
    "/control/authenticate": { POST: authenticateRoute },
    "/control/preflight": { POST: preflight },
    "/control/plan": { POST: plan },
    "/control/claim": { DELETE: claimForToken },
    "/control/deploy": { POST: deploy },
    "/control/deployment": { GET: deploymentResult },
    "/control/logs": { POST: logs },
    "/control/rename": { POST: (req) => renameRoute(req, "dashboard") },
    "/control/lifecycle": { POST: (req) => lifecycleRoute(req, "dashboard") },
    ...(secrets === null
      ? {}
      : {
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
  };

  // Both sockets' routes, behind the same bound on requests in flight.
  const serve = createServe({ maxInFlight, log: "control" });
  return Object.assign(serve(routes), {
    owner: serve({
      "/tokens/project": { DELETE: forgetProject },
      "/tokens/claim": { GET: claimRoute, DELETE: takeBackRoute },
      "/tokens/owner": { POST: ownerToken },
      "/control/rename": { POST: (req) => renameRoute(req, "ssh") },
      "/control/lifecycle": { POST: (req) => lifecycleRoute(req, "ssh") },
    }),
    ownerWroteStore,
    storeClaimed,
    settle: settleNames,
  });
}

/** Does this path belong to the control routes? The steward's entry point routes on it. */
export function isControlPath(path: string): boolean {
  return path.startsWith("/tokens/") || path.startsWith("/control/");
}

