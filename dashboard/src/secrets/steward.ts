/**
 * The steward's routes, built around their dependencies.
 *
 * The steward runs under root, and it is the one that decides everything:
 * scope, validation, password, writing, restart, portal. The dashboard only
 * relays. This file assembles the rules of the pure modules and the inputs and
 * outputs of `System`; it carries itself only the order of the checks, which
 * is the order of the risk:
 *
 *   shape of the body, token, scope, kind, existence, management, validation,
 *   writing.
 *
 * No value, no password, no token at all enters an error message or the log. An
 * unexpected exception returns a generic 500: its message could quote a path,
 * and it is never sent back.
 *
 * **The dashboard is assumed compromised.** Everything it can send is bounded:
 * requests in flight, the queue of writes, the size and duration of a body, the
 * number of `systemctl show` launched. Bringing the steward down for want of
 * memory yields nothing: the rate limiting of the attempts is on disk, and a
 * token revoked while a write is waiting its turn makes it fail. A stolen token
 * is not enough to change a password either: `/password` demands the
 * dashboard's own, checked at that very instant and counted in the rate
 * limiting. Nor to make valid again a password that has just been changed: the
 * old hash is not kept, and a file that carries a hash is not restored.
 *
 * The routes are described in src/secrets/protocol.ts.
 */
import { hasStore, isAnchored, isApp, isProtected, isValidFileName, isValidSlug, legacySecretFiles, servicesOf, type Manifest } from "../../borrowed/manifest";
import { CREDENTIAL_ID, MAX_STORE_ENV_BYTES, MAX_STORE_FILE_BYTES, storePaths } from "../../borrowed/store";
import type {
  StoreChangeResponse,
  StoreListResponse,
  StoreRestoreResponse,
  StoreRevealResponse,
  StoreView,
} from "../../borrowed/store-protocol";
import { fragmentIsProtected } from "../../borrowed/portal";
import { isPasswordValid, isAcceptableSubmission } from "../auth";
import { addressOf, codeAddress, unitOf } from "../state";
import { reservedReason } from "../control/policy";
import { generatePassword } from "../password";
import { portalModifiable, generalChoices, DASHBOARD_SLUG, type Choices } from "../gatekeeper/rules";
import { actionFor, type GeneralAccess } from "../gatekeeper/instance";
import { installedCode, isValidCode, readCodes as readLockCodes, stanzaClosesEveryAddress } from "../../borrowed/locks";
import type { RandomSource } from "../sessions";
import {
  INITIAL_STATE,
  wait,
  hashFrom,
  encodeRateLimit,
  attemptAccepted,
  attemptRefused,
  isValidToken,
  readRateLimit,
  hashFileRefusal,
  revoke,
  type RateLimitRead,
} from "./unlock";
import {
  parseEnvBytes,
  keys,
  unitEnvironment,
  set,
  remove,
  serialise,
  envValue,
  checkKey,
  checkValue,
  type EnvDocument,
} from "./envfile";
import { createHistory, latest, page, readPageQuery, RETURNED_ENTRIES, encodeEntry, isAccessChange, MAX_FIELD } from "./log";
import {
  HASH_ONLY,
  MAX_FILE_BYTES,
  PASSWORD_VARIABLE,
  ROOT_FILES,
  expectedText,
  isStoreForm,
  kindOf,
  pathUnder,
  isSiteFolder,
  isPassword,
  readContent,
  readSites,
  folderReason,
  outsideHashReason,
  unmanagedReason,
  newPasswordReason,
  previousReason,
  outsideHashRefusal,
  nameRefusal,
  restoreRefusal,
  subFolderOf,
  checkContent,
  checkFile,
  checkSite,
  tokenFileRefusal,
  type Declaration,
  type FileInfo,
  type Owner,
  type Refusal,
  type Site,
} from "./scope";
import {
  STORE_EXPECTED,
  decodeFileContent,
  drawValue,
  envBytesRefusal,
  fileNameRefusal,
  filesRefusal,
  generateRefusal,
  legacyWriteRefusal,
  readGenerateAsk,
  removalRefusal,
  restoreRemovalRefusal,
  retiredReason,
  storeMay,
  storeNameRefusal,
  storeSlugRefusal,
  storeValueRefusal,
  storeView,
  type LegacyHolder,
  type LegacyState,
  type StoreFileState,
  type StoreState,
} from "./store";
import { planMigration, retireDecision, type MigrationSource } from "./migrate";
import {
  judgeGatekeeperResult,
  GATEKEEPER_MARGIN_MS,
  TRANSACTION_IN_PROGRESS_REASON,
  INTERRUPTED_TRANSACTION_REASON,
  backupElsewhereReason,
  gatekeeperUnitOf,
} from "./portal";
import type {
  ErrorCode,
  LogEntry,
  Failure,
  FileView,
  Operation,
  PortalView,
  ProjectView,
  ContentResponse,
  UnlockResponse,
  FileResponse,
  LogResponse,
  PasswordResponse,
  PortalResponse,
  ProjectsResponse,
  RestartResponse,
  StoreLeftoversResponse,
  StoreMigrateAnswer,
  StoreRetireAnswer,
  ValueResponse,
  ServiceView,
  Verdict,
} from "./protocol";
import { RESTART_TIMEOUT_MS, MAX_PORTAL_MS } from "./protocol";
import { isAnchorUnit, showArguments, readShow, restartPending, serviceView, verdict, withCredentials, type ServiceReading } from "./restart";
import type { Command, Permissions, Examination, System } from "./system";
import { createConnectorRoutes } from "../connectors/steward";
import type { ConnectorStore } from "../connectors/store";
import { createBackupRoutes } from "../backup/routes";
import type { BackupReader } from "../backup/reader";
import { createMemberRoutes, type KeyState } from "../people/steward";
import type { MembersSystem } from "../people/system";
import { OWNER_ACTOR, type Roles } from "../people/protocol";
import { createMemberActions, type Who } from "../people/actions";
import type { MemberAuthority, SecretsForToken } from "../control/steward";
import type { ProjectSecrets, SecretsListResponse, StewardSecretsChange, TokenFileView } from "../control/protocol";
import { isVariableName, readSecretsChange, variableRefusal, type TokenSecretsChange } from "../control/secrets";
import type { StoreForToken } from "./store-api";
import { machineRefusal, may } from "../people/powers";
import { portalReading, type PortalAdmin } from "../people/portal";
import { createAccessRoutes, createAccessStore, type AccessRoutes, type AccessStore } from "../access/steward";
import type { AccessSystem } from "../access/system";
import { GENERAL_ACCESSES, type GeneralResponse, type GeneralView, type LeavingToken } from "../access/protocol";

export type StewardOptions = {
  secretsFolder: string;
  /**
   * True in production: a file's expected owner is checked when reading and set
   * when writing, the hash's file, the subdirectories and the gatekeeper's
   * result must belong to root. False on the workstation, where those accounts
   * do not exist: neither check nor `chown`.
   */
  checkAccounts: boolean;
  /** Root's uid, 0 in production. */
  uidRoot?: number;
  /** Observation time after a restart, and the step between two readings. */
  observationMs?: number;
  stepMs?: number;
  restartTimeoutMs?: number;
  showTimeoutMs?: number;
  /** What the gatekeeper's `systemctl start` may take. */
  gatekeeperTimeoutMs?: number;
  /** Requests handled at a time; beyond that, 503. */
  maxInFlight?: number;
  /** Writes waiting behind the one that is running; beyond that, 503. */
  maxQueued?: number;
  /** Time left to a body to arrive whole. */
  bodyTimeoutMs?: number;
  /** Lifetime of a `systemctl show` reading for the list of projects. */
  cacheShowMs?: number;
  /** `systemctl show` launched at the same time. */
  maxParallelShow?: number;
  /** The verification of a password, injected so that the tests count it. */
  check?: (submitted: string, hash: string) => Promise<boolean>;
  /** The hash of a new password, argon2id in production. */
  hashPassword?: (password: string) => Promise<string>;
  /** The draw of a new password. */
  drawPassword?: () => string;
  /**
   * The wait between the `scheduled` answer and the dashboard's restart. The
   * tests hold it by hand to check that the answer leaves first.
   */
  schedule?: () => Promise<void>;
  random?: RandomSource;
  /** The egress proxy's connectors files, see src/connectors/store.ts. */
  connectors?: ConnectorStore;
  /** The backups' folders, read for `/backups`; absent, the routes say backups are not set up. */
  backups?: BackupReader | null;
  /**
   * Access and the people who sign in to the dashboard, see src/access/ and
   * src/people/. Absent, their routes do not exist, as on a steward that
   * predates them, and the owner's socket answers nothing.
   */
  members?: {
    system: MembersSystem;
    /** The access registry's files: the registry, the portal's projection, the stores before it. */
    access: AccessSystem;
    zone: string;
    /**
     * The portal's admin API through the relay (src/people/portal.ts), asked
     * whether the portal reads the projection. Absent, it is not asked.
     */
    portal?: PortalAdmin | null;
    /**
     * Someone who no longer signs in: their tokens revoked, `actor` who took
     * them off. The control routes' (src/control/steward.ts), built after
     * this handler, hence a function of their own the entry point fills in.
     */
    revokeTokens?: (email: string, actor: string) => Promise<LeavingToken[]>;
    /** A person's live tokens, as a confirmation names them (src/control/steward.ts, `tokensOf`). */
    tokensOf?: (email: string) => Promise<LeavingToken[]>;
  };
};

export type Handler = (req: Request) => Promise<Response>;

/**
 * The handler, and the one thing the control routes need to know of this one's
 * state: whether a token is the live unlock token. Creating a deployment token
 * demands the dashboard unlocked, and the unlock lives here alone.
 */
export type StewardHandler = Handler & {
  isUnlocked: (token: unknown) => Promise<boolean>;
  /**
   * The handler of the owner's socket, which only root opens: the access
   * registry, for `sitesolide share` and `sitesolide people` over the
   * owner's SSH.
   */
  owner: Handler;
  /** The sign-in key pair, laid if missing: the entry point asks at startup. */
  ensureMemberKeys: () => Promise<KeyState | null>;
  /**
   * The access registry made if it is missing, its projection written again,
   * in the background, tried again later and later until it is: the entry
   * point starts it and does not wait. Resolves once the registry is there.
   */
  startAccess: () => Promise<void>;
  /** A project removed from the machine: its people with access dropped (src/access/steward.ts); null without them. */
  forgetProjectAccess: AccessRoutes["forgetProject"] | null;
  /** What the control routes ask of the people for a person's own tokens; null without them. */
  memberAuthority: MemberAuthority | null;
  /** A token's changes of access, the token judged by the control routes. */
  accessForToken: AccessRoutes["forToken"] | null;
  /**
   * A token's secrets and restart, the token judged by the control routes:
   * the listing, a change of `<slug>.env`, a restart, the journal's refusals,
   * which those routes bound per token, and whether a project is restricted
   * as its general access reads. This steward's own code, with the token as
   * `who`.
   */
  secretsForToken: SecretsForToken | null;
  /** A token's work on a store, judged by the control routes (store-api.ts). */
  storeForToken: StoreForToken | null;
};

/**
 * The biggest legitimate body outside a content is a set: a name, a value of
 * 8 KiB at most in UTF-8, which JSON can swell with escapes.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * A replacement of content: 64 KiB of text, which one control character takes
 * to six bytes in JSON (`\u0001`). Only `PUT /content` accepts it.
 */
export const MAX_CONTENT_BODY_BYTES = 512 * 1024;

export const OBSERVATION_MS = 8000;
export const STEP_MS = 500;

/**
 * Sixteen requests at a time fit in a few MiB, 8 MiB at worst with sixteen
 * contents. Without a cap, a thousand bodies of 64 KiB never finished cost from
 * 42 to 111 MiB and a burst of `GET /projects` 300 MiB, under the MemoryMax of
 * 128M the steward then had.
 */
export const MAX_IN_FLIGHT = 16;
export const MAX_QUEUED = 4;
export const BODY_TIMEOUT_MS = 5_000;
export const CACHE_SHOW_MS = 2_000;
export const MAX_PARALLEL_SHOW = 2;

/**
 * The time left to the `scheduled` answer to leave the socket, cross the relay
 * and Caddy, before the dashboard restarts underneath it. One second is enough
 * for an answer of a few hundred bytes on the same machine.
 */
export const SCHEDULED_DELAY_MS = 1_000;

const STATUSES: Record<ErrorCode, number> = {
  locked: 401,
  refused: 401,
  "too-many-attempts": 429,
  invalid: 400,
  "out-of-scope": 403,
  "not-found": 404,
  unmanaged: 409,
  "already-present": 409,
  failure: 500,
};

function error(code: ErrorCode, message: string, waitSeconds?: number): Response {
  const body: Failure = waitSeconds === undefined ? { error: code, message } : { error: code, message, wait: waitSeconds };
  return Response.json(body, { status: STATUSES[code] });
}

const GENERIC_MESSAGE = "unexpected error, see the steward's log on the server";

/** 503 and not 500: nothing is broken, the request can be made again in a moment. */
function busy(): Response {
  const body: Failure = { error: "failure", message: "the server is busy, try again in a moment" };
  return Response.json(body, { status: 503 });
}

const abandoned = () => error("failure", "request abandoned");
const tooManyAttempts = (remainingMs: number) =>
  error("too-many-attempts", "too many attempts, wait before trying again", Math.ceil(remainingMs / 1000));

/**
 * An exclusion lock with a bounded queue: each task waits for the end of the
 * previous one, successful or not. Returns null when the queue is full, instead
 * of piling up requests that a compromised dashboard would send endlessly.
 */
function createLock(maxQueued: number): <T>(task: () => Promise<T>) => Promise<T> | null {
  let queue: Promise<unknown> = Promise.resolve();
  // The one that is running, plus those that are waiting.
  let busy = 0;
  return (task) => {
    if (busy > maxQueued) return null;
    busy++;
    const result = queue.then(task).finally(() => {
      busy--;
    });
    queue = result.catch(() => undefined);
    return result;
  };
}

/** A cap on simultaneous tasks, which makes one wait rather than refusing. */
function createLimit(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const pending: (() => void)[] = [];
  return async (task) => {
    while (running >= max) await new Promise<void>((wake) => pending.push(wake));
    running++;
    try {
      return await task();
    } finally {
      running--;
      pending.shift()?.();
    }
  };
}

type BodyRead = Uint8Array | "too-large" | "too-slow";

/**
 * The body, piece by piece, bounded in size and in time: a body that never
 * arrives must not hold a place in flight indefinitely.
 */
async function readStream(req: Request, max: number, timeoutMs: number): Promise<BodyRead> {
  if (req.body === null) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiration = new Promise<"too-slow">((resolve) => {
    timer = setTimeout(() => resolve("too-slow"), timeoutMs);
  });

  try {
    for (;;) {
      const parsed = await Promise.race([reader.read(), expiration]);
      if (parsed === "too-slow") {
        reader.cancel().catch(() => undefined);
        return "too-slow";
      }
      if (parsed.done) break;
      total += parsed.value.byteLength;
      if (total > max) {
        reader.cancel().catch(() => undefined);
        return "too-large";
      }
      chunks.push(parsed.value);
    }
  } finally {
    clearTimeout(timer);
  }

  const bytes = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.byteLength;
  }
  return bytes;
}

type Body = Record<string, unknown>;

/** The dashboard's password: whoever unlocked with it. */
const OWNER: Who = { actor: OWNER_ACTOR, member: null };

/**
 * Is this requester held to a person's bounds, the machine's own projects and
 * files refused and nothing read back unless their role reads it? A person,
 * and any token, the owner's own included: a token is a key on a laptop or in
 * an agent, not the owner's password, and what it may do is what a
 * Developer may.
 */
function restricted(who: Who): boolean {
  return who.member !== null || who.token !== undefined;
}

/** What the log can carry of a request: a well-formed name, never the raw text of a field. */
function safeName(value: unknown, shape: RegExp, max: number): string | null {
  return typeof value === "string" && value.length <= max && shape.test(value) ? value : null;
}

const SLUG_SHAPE = /^[a-z0-9.-]+$/;

type Target = { site: Site; declaration: Declaration; path: string };

/**
 * A service as the page needs it: its view, its startup to the microsecond,
 * and which managed files its unit reads, null when the unit cannot be read.
 */
type ServiceState = { view: ServiceView | null; startedUs: number | null; reads: ((name: string) => boolean) | null };

/** A file that is present and managed, with what its kind read from it. */
type Managed = {
  bytes: Uint8Array;
  info: FileInfo;
  /** The expected account as /etc/passwd gives it, null with no check. */
  real: Owner | null;
  /** The document of a `variables` file, null for a `content`. */
  document: EnvDocument | null;
  /** The text of a `content` file, null for a `variables`. */
  text: string | null;
};

type TargetState =
  | { kind: "absent" }
  | { kind: "unmanaged"; reason: string; info: FileInfo | null }
  | { kind: "managed"; managed: Managed };

export function createSteward(system: System, options: StewardOptions): StewardHandler {
  const observationMs = options.observationMs ?? OBSERVATION_MS;
  const stepMs = options.stepMs ?? STEP_MS;
  const restartTimeoutMs = options.restartTimeoutMs ?? RESTART_TIMEOUT_MS;
  const showTimeoutMs = options.showTimeoutMs ?? 5_000;
  const gatekeeperTimeoutMs = options.gatekeeperTimeoutMs ?? MAX_PORTAL_MS - GATEKEEPER_MARGIN_MS;
  const maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? BODY_TIMEOUT_MS;
  const cacheShowMs = options.cacheShowMs ?? CACHE_SHOW_MS;
  const uidRoot = options.uidRoot ?? 0;
  const check = options.check ?? isPasswordValid;
  const hashPassword = options.hashPassword ?? ((password: string) => Bun.password.hash(password, "argon2id"));
  const drawPassword = options.drawPassword ?? (() => generatePassword());
  const schedule = options.schedule ?? (() => Bun.sleep(SCHEDULED_DELAY_MS));
  const checked = options.checkAccounts;
  const { secretsFolder } = options;
  /** What a generated value is drawn from: the injected source in the tests, the system's otherwise. */
  const random = options.random ?? ((bytes: number) => crypto.getRandomValues(new Uint8Array(bytes)));
  /** The served zone: it names the landing's folder, which, like every platform project, is never a member's. */
  const memberZone = options.members?.zone ?? "";

  let state = INITIAL_STATE;

  // The rate limiting from before the last stop, re-read straight away: it is
  // what the next attempt must find, not a new counter.
  const rateLimitReread: Promise<void> = (async () => {
    let reading: RateLimitRead;
    try {
      reading = await system.readRateLimit();
    } catch {
      reading = { kind: "unreadable" };
    }
    if (reading.kind === "unreadable") console.error("rate limiting: state unreadable, slowing to the maximum out of caution");
    state = { ...state, ...readRateLimit(reading, system.now()) };
  })();

  // Two queues: a write never waits for an unlocking, and an unlocking does not
  // wait for the eight seconds of a restart. The verifications and the argon2id
  // hashes go through one by one, unlocking and password change in the same
  // queue: two at once got the service killed at 128M on the bench (m2),
  // three at 192M, and a burst would otherwise go
  // through in its entirety before the first failure is counted.
  const exclusive = createLock(options.maxQueued ?? MAX_QUEUED);
  const oneAtATime = createLock(options.maxQueued ?? MAX_QUEUED);
  const showLimit = createLimit(options.maxParallelShow ?? MAX_PARALLEL_SHOW);
  const cacheShow = new Map<string, { at: number; response: Promise<Command | null> }>();

  // --- Log -------------------------------------------------------------------

  // The access log seeded from the journal if it does not exist yet, before
  // the journal's next rotation can take what an earlier steward wrote there,
  // then pruned: at startup, as the rate limiting is read.
  const accessLogPrepared: Promise<void> = (async () => {
    try {
      await system.prepareAccessLog(system.now());
    } catch (e) {
      console.error(`access log: not prepared (${errorName(e)}), seeded at the first change of access`);
    }
  })();

  /**
   * The log never makes an operation fail: it keeps quiet and says so.
   * `variable` is passed separately and not read from the body: on a refusal, a
   * token pasted in the place of a name never enters it. `who` is what this
   * steward verified: the dashboard's password unless said otherwise, never a
   * name a request carries.
   *
   * Every line goes through here, whoever writes it: the access store, the
   * access routes, a token's changes through the control routes, the people
   * and their sessions. An accepted change of access goes to the access log,
   * kept 180 days, everything else to the journal (log.ts).
   */
  async function writeLog(
    operation: Operation,
    result: LogEntry["result"],
    body: Body | null,
    detail: string | null,
    variable: string | null = null,
    who: Who = OWNER,
    file?: string | null,
  ): Promise<void> {
    const entry: LogEntry = {
      a: system.now(),
      operation,
      result,
      actor: who.actor,
      member: who.member,
      slug: safeName(body?.slug, SLUG_SHAPE, 63),
      // The shape of an accepted file name, climbing paths and hidden names
      // excluded; or what a store's work names, `store` and `store/<name>`,
      // built from names already judged.
      file: file !== undefined ? file : nameRefusal(body?.file) === null ? (body!.file as string) : null,
      variable,
      detail,
    };
    const toAccessLog = isAccessChange(entry);
    try {
      if (toAccessLog) {
        await accessLogPrepared;
        await system.appendAccessLog(encodeEntry(entry), system.now());
      } else {
        await system.appendLog(encodeEntry(entry));
      }
    } catch (e) {
      console.error(`${toAccessLog ? "access log" : "log"}: cannot write (${errorName(e)})`);
    }
  }

  /** `variable`: only a name already present in the file, or declared as a password. */
  async function refuse(operation: Operation, body: Body, refusal: Refusal, variable: string | null = null, who: Who = OWNER): Promise<Response> {
    await writeLog(operation, "rejects", body, refusal.error, variable, who);
    return error(refusal.error, refusal.message);
  }

  /** The body's variable name if it exists in the document, null otherwise. */
  function knownVariable(document: EnvDocument | null, body: Body): string | null {
    const variable = body.variable;
    if (document === null || typeof variable !== "string") return null;
    return envValue(document, variable) === null ? null : variable;
  }

  // --- Reading the body ------------------------------------------------------

  async function readBody(req: Request, fields: string[], max = MAX_BODY_BYTES): Promise<Body | Response> {
    const announced = Number(req.headers.get("content-length") ?? "0");
    if (announced > max) return error("invalid", "request body too large");

    const bytes = await readStream(req, max, bodyTimeoutMs);
    if (bytes === "too-large") return error("invalid", "request body too large");
    if (bytes === "too-slow") return error("invalid", "request body too slow");

    let object: unknown;
    try {
      object = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return error("invalid", "the request body must be a JSON object");
    }
    if (typeof object !== "object" || object === null || Array.isArray(object)) {
      return error("invalid", "the request body must be a JSON object");
    }
    // An unknown field is a typing mistake of the relay's, refused rather than
    // passed over in silence. Its name is not repeated: nothing says what it
    // contains.
    if (Object.keys(object).some((key) => !fields.includes(key))) {
      return error("invalid", "unexpected field in the request body");
    }
    return object as Body;
  }

  /**
   * The body, then the token, before all the rest: without a token, nothing is
   * learned of the scope. `texts`: the fields that must be strings; the other
   * accepted fields are checked separately.
   */
  async function bodyWithToken(req: Request, texts: string[], others: string[] = [], max = MAX_BODY_BYTES): Promise<Body | Response> {
    const body = await readBody(req, ["token", ...texts, ...others], max);
    if (body instanceof Response) return body;
    if (!(await isValidToken(state, body.token, system.now()))) {
      return error("locked", "locked, unlock again");
    }
    for (const field of texts) {
      if (typeof body[field] !== "string") return error("invalid", `${field} must be a string`);
    }
    return body;
  }

  /**
   * The task under the exclusion lock. The token is checked again once its turn
   * has come: a write that was waiting behind a restart must not run if the
   * session has been locked in the meantime. And a relay that has stopped
   * waiting is no longer there to see the result: nothing is done.
   */
  function underLock(req: Request, body: Body, task: () => Promise<Response>): Promise<Response> {
    return underLockWith(
      req,
      async () => ((await isValidToken(state, body.token, system.now())) ? null : error("locked", "locked, unlock again")),
      task,
    );
  }

  /**
   * The same lock for any requester: `still` says, once the turn has come,
   * whether they may still act, the owner's token alive, a member's
   * session, unlock and role still theirs; its refusal goes back as it stands.
   */
  function underLockWith(req: Request, still: () => Promise<Response | null>, task: () => Promise<Response>): Promise<Response> {
    const taken = exclusive(async () => {
      if (req.signal.aborted) return abandoned();
      const refusal = await still();
      if (refusal !== null) return refusal;
      return task();
    });
    return taken ?? Promise.resolve(busy());
  }

  // --- systemctl show --------------------------------------------------------

  /**
   * One reading per unit every two seconds at most, and two `systemctl` at a
   * time: each `Bun.spawn` costs a process, and a burst of `GET /projects`
   * launched hundreds of them. `fresh` for the readings of a restart, which
   * cannot date from before it.
   */
  function show(unit: string, fresh = false): Promise<Command | null> {
    const now = system.now();
    const known = cacheShow.get(unit);
    if (!fresh && known !== undefined && now - known.at < cacheShowMs) return known.response;

    const response = showLimit(() => system.systemctl(showArguments(unit), showTimeoutMs)).catch(() => null);
    if (fresh) cacheShow.delete(unit);
    else cacheShow.set(unit, { at: now, response });
    return response;
  }

  /**
   * The service's view for the page, and its startup to the microsecond to
   * judge a pending restart: the view's millisecond would not be enough to
   * settle a set made just afterwards. A static site has no unit, and costs no
   * `systemctl` at all.
   */
  async function readService(site: Site): Promise<ServiceState> {
    if (site.isStatic) return { view: null, startedUs: null, reads: null };
    const unit = unitOf(site.folder);
    const text = await system.readUnit(unit);
    const reads = text === null ? null : unitReads(text);
    const response = await show(unit);
    if (response === null || response.code !== 0) return { view: null, startedUs: null, reads };
    const parsed = readShow(response.output);
    const view = serviceView(unit, parsed);
    // An anchor's startup says nothing of what reads the files: its scheduled
    // services read them anew at every run, and no change waits for a restart.
    const anchor = text !== null && isAnchorUnit(text);
    return { view, startedUs: view === null || anchor ? null : parsed.startedUs, reads };
  }

  /**
   * Which managed files a unit reads: through `EnvironmentFile=`, or by the
   * service itself when `Environment=` gives it the file's path, or that of its
   * subdirectory. A restart applies those, and only those.
   */
  function unitReads(text: string): (name: string) => boolean {
    const unitEnv = unitEnvironment(text);
    const readFiles = new Set(unitEnv.files.map((file) => file.path));
    const values = new Set(unitEnv.values.map((value) => value.replace(/\/+$/, "")));
    return (name) => {
      const path = pathUnder(secretsFolder, name);
      const subFolder = subFolderOf(name);
      const folder = subFolder === null ? null : pathUnder(secretsFolder, subFolder);
      return path !== null && (readFiles.has(path) || values.has(path) || (folder !== null && values.has(folder)));
    };
  }

  // --- Scope and state of a file ---------------------------------------------

  async function sites(): Promise<Map<string, Site>> {
    return readSites(await system.listProjects(), await system.listSecrets());
  }

  /**
   * The site and the file a request names, within the scope. For a member or
   * a token, never the machine's own: a platform project, or a file kept for
   * root, whatever role a hand-edited registry would claim
   * (src/people/powers.ts).
   */
  async function target(operation: Operation, body: Body, who: Who = OWNER): Promise<Target | Response> {
    const found = checkSite(await sites(), body.slug);
    if ("refusal" in found) return refuse(operation, body, found.refusal, null, who);
    const file = checkFile(found.site, body.file, secretsFolder);
    if ("refusal" in file) return refuse(operation, body, file.refusal, null, who);
    if (restricted(who)) {
      const machine = machineRefusal(found.site.folder, file.declaration, memberZone);
      if (machine !== null) return refuse(operation, body, { error: "out-of-scope", message: machine }, null, who);
    }
    return { site: found.site, declaration: file.declaration, path: file.path };
  }

  /** The expected account, `undefined` when the check is off, null when it is missing from /etc/passwd. */
  async function realAccount(declaration: Declaration): Promise<Owner | null | undefined> {
    if (!checked) return undefined;
    return system.account(declaration.expected.owner);
  }

  /** A file's subdirectory: missing, to be refused, or traversable. */
  async function subFolderState(name: string): Promise<{ kind: "ok" } | { kind: "absent"; path: string } | { kind: "rejects"; reason: string }> {
    const subFolder = subFolderOf(name);
    if (subFolder === null) return { kind: "ok" };
    const path = pathUnder(secretsFolder, subFolder) ?? subFolder;
    const info = await system.examineFolder(subFolder);
    if (info === null) return { kind: "absent", path };
    const reason = folderReason(info, checked ? uidRoot : null, path);
    return reason === null ? { kind: "ok" } : { kind: "rejects", reason };
  }

  async function judge({ declaration, path }: Target, info: FileInfo, bytes: Uint8Array | null): Promise<Managed | { reason: string }> {
    const account = await realAccount(declaration);
    if (account === null) return { reason: `account ${declaration.expected.owner} does not exist` };
    const real = account ?? null;

    const reason = unmanagedReason(info, declaration.expected, real, path);
    if (reason !== null) return { reason };
    if (bytes === null) return { reason: "could not be read" };

    if (declaration.kind === "variables") {
      const parsed = parseEnvBytes(bytes);
      if (!parsed.ok) return { reason: parsed.line > 0 ? `line ${parsed.line}: ${parsed.reason}` : parsed.reason };
      const foreign = outsideHashReason(declaration.name, keys(parsed.document), path);
      if (foreign !== null) return { reason: foreign };
      return { bytes, info, real, document: parsed.document, text: null };
    }
    const parsed = readContent(bytes);
    if ("reason" in parsed) return parsed;
    return { bytes, info, real, document: null, text: parsed.text };
  }

  /**
   * The state of a declared file: absent, present and managed, or present but
   * out of management, with the reason read on the file itself.
   */
  async function examineTarget(c: Target): Promise<TargetState> {
    const folder = await subFolderState(c.declaration.name);
    if (folder.kind === "rejects") return { kind: "unmanaged", reason: folder.reason, info: null };

    const examination = folder.kind === "absent" ? ({ kind: "absent" } as const) : await system.examineSecret(c.declaration.name);
    if (examination.kind === "absent") return { kind: "absent" };

    const judgement = await judge(c, examination.info, examination.bytes);
    if ("reason" in judgement) return { kind: "unmanaged", reason: judgement.reason, info: examination.info };
    return { kind: "managed", managed: judgement };
  }

  /** A file that is present and managed, or the refusal that says so. */
  async function managedFile(operation: Operation, body: Body, c: Target, variable: string | null = null, who: Who = OWNER): Promise<Managed | Response> {
    const parsed = await examineTarget(c);
    const name = c.declaration.name;
    if (parsed.kind === "absent") {
      return refuse(operation, body, { error: "not-found", message: `${name} does not exist, create it first` }, variable, who);
    }
    if (parsed.kind === "unmanaged") {
      return refuse(operation, body, { error: "unmanaged", message: `${name} is not managed here: ${parsed.reason}` }, variable, who);
    }
    return parsed.managed;
  }

  /** The kind a route demands, or the refusal that sends you to the right one. */
  function kindRefusal(c: Target, expected: Declaration["kind"]): Refusal | null {
    if (c.declaration.kind === expected) return null;
    const message =
      expected === "variables"
        ? `${c.declaration.name} is managed as a whole, replace its content instead`
        : `${c.declaration.name} is an environment file, change its variables instead`;
    return { error: "invalid", message };
  }

  /** Expected owner and mode, the ones a write sets. */
  function expectedPermissions(declaration: Declaration, real: Owner | null): Permissions {
    return { owner: checked ? real : null, mode: declaration.expected.mode };
  }

  async function fileView(c: Target, service: ServiceState): Promise<FileView> {
    const { declaration } = c;
    const parsed = await examineTarget(c);
    const variables = parsed.kind === "managed" && parsed.managed.document !== null ? keys(parsed.managed.document) : [];
    const previous = await system.examinePrevious(declaration.name);
    const base: FileView = {
      name: declaration.name,
      kind: declaration.kind,
      state: "absent",
      reason: null,
      expected: expectedText(declaration.expected),
      readable: declaration.readable,
      variables: [],
      passwords: [],
      bytes: null,
      modifiedAt: null,
      // What `/restore` would accept: the page does not offer an action that is refused.
      previous:
        previous.kind === "present" &&
        restoreRefusal(declaration, variables) === null &&
        restoreRefusal(declaration, previousKeys(declaration, previous)) === null,
      restartPending: false,
    };
    if (parsed.kind === "absent") return base;

    const info = parsed.kind === "managed" ? parsed.managed.info : parsed.info;
    const dates =
      info === null
        ? {}
        : {
            // The page receives whole milliseconds; the comparison keeps the fraction.
            modifiedAt: Math.floor(info.modifiedAt),
            // A variables file the unit does not read waits for no restart:
            // the monitor's and the backups' files are the dashboard site's,
            // and other units read them, each at its own next pass.
            restartPending:
              (declaration.kind !== "variables" || service.reads === null || service.reads(declaration.name)) &&
              restartPending(info.modifiedAt, service.startedUs),
          };
    if (parsed.kind === "unmanaged") return { ...base, ...dates, state: "unmanaged", reason: parsed.reason };

    const { managed } = parsed;
    return {
      ...base,
      ...dates,
      state: "managed",
      variables,
      // The ones the file carries: the page offers them in a value's place.
      passwords: variables.filter((name) => isPassword(declaration, name)),
      // Not even the size of a write-only file comes out: that of a key says
      // its algorithm, that of a token its shape.
      bytes: managed.document === null && declaration.readable ? managed.bytes.length : null,
    };
  }

  /** The variable names of a previous version, none if it cannot be read back as such. */
  function previousKeys(declaration: Declaration, examination: Examination): string[] {
    if (declaration.kind !== "variables" || examination.kind !== "present" || examination.bytes === null) return [];
    const parsed = parseEnvBytes(examination.bytes);
    return parsed.ok ? keys(parsed.document) : [];
  }

  /** A view when the reading failed: the whole list does not fall for one file. */
  function unreadableView(declaration: Declaration): FileView {
    return {
      name: declaration.name,
      kind: declaration.kind,
      state: "unmanaged",
      reason: "could not be read",
      expected: expectedText(declaration.expected),
      readable: declaration.readable,
      variables: [],
      passwords: [],
      bytes: null,
      modifiedAt: null,
      previous: false,
      restartPending: false,
    };
  }

  /** A file as someone who never reads it back sees it: no size, no previous version, write-only. */
  const writeOnly = (file: FileView): FileView => ({ ...file, readable: false, previous: false, bytes: null });

  /**
   * The file's view after a write. To a member who may not read it back, or
   * any token, as the listing shows it: no size, no previous version,
   * write-only.
   */
  async function fileAfter(c: Target, who: Who): Promise<FileView> {
    const service = await readService(c.site);
    const file = await fileView(c, service);
    return asSeenBy(file, who);
  }

  /**
   * A file as a requester sees it: the owner whole; anyone else write-only,
   * but told a previous version is kept when they may restore it, an Admin.
   */
  function asSeenBy(file: FileView, who: Who): FileView {
    if (!restricted(who) || who.readsBack === true) return file;
    return who.restores === true ? { ...writeOnly(file), previous: file.previous } : writeOnly(file);
  }

  async function fileResponse(c: Target, who: Who = OWNER): Promise<Response> {
    const body: FileResponse = { file: await fileAfter(c, who) };
    return Response.json(body);
  }

  /** What the unit and the manifest already set, which a secret would overwrite. */
  async function setKeys(site: Site): Promise<string[]> {
    const set = new Set(Object.keys(site.manifest?.env ?? {}));
    const text = await system.readUnit(unitOf(site.folder));
    if (text !== null) for (const key of unitEnvironment(text).keys) set.add(key);
    return [...set];
  }

  const encoder = new TextEncoder();

  /**
   * S2: the names a site's store holds, read for a write to one of its legacy
   * files; empty for a site with no store, null when its store cannot be read.
   */
  async function storeNamesFor(site: Site): Promise<ReadonlySet<string> | null> {
    const { manifest } = site;
    if (manifest === null || manifest.slug !== site.folder || !hasStore(manifest)) return new Set();
    const reading = await readStore(site.folder);
    if (storeStateRefusal(site.folder, reading) !== null) return null;
    return new Set(storeValues(reading).keys());
  }

  /**
   * Keeps the current state as the previous version, with its owner, then
   * writes the new one with the expected owner and mode. The previous version
   * first: a stop between the two leaves in place the version that was serving,
   * kept as the previous version as well.
   */
  async function writeKeepingPrevious(c: Target, managed: Managed, bytes: Uint8Array): Promise<void> {
    const permissions = expectedPermissions(c.declaration, managed.real);
    await system.writePrevious(c.declaration.name, managed.bytes, permissions.owner);
    await system.writeSecret(c.declaration.name, bytes, permissions);
  }

  /**
   * Creates a missing file, empty and with no previous version. What
   * precedents/ still holds under its name is an earlier file's, removed by
   * hand or with its site, and the uid `previousReason` compares does not
   * tell them apart: `useradd --system` hands out the highest free uid below
   * the lowest in use, so a site removed and then created again under the same
   * name, by whoever holds the right to create it, gets its predecessor's uid,
   * and a restore would hand it its predecessor's secrets. Removed first: a
   * stop between the two leaves neither.
   */
  async function createFresh(name: string, permissions: Permissions): Promise<boolean> {
    await system.removePrevious(name);
    return system.createEmptySecret(name, permissions);
  }

  /** The serialised document, or null if it goes beyond what a managed file may weigh. */
  function boundedBytes(document: EnvDocument): Uint8Array | null {
    const bytes = encoder.encode(serialise(document));
    return bytes.length > MAX_FILE_BYTES ? null : bytes;
  }

  const tooBig = () => error("invalid", "the file would grow beyond 256 KiB");

  async function rewrite(c: Target, managed: Managed, document: EnvDocument): Promise<Response | null> {
    const bytes = boundedBytes(document);
    if (bytes === null) return tooBig();
    await writeKeepingPrevious(c, managed, bytes);
    return null;
  }

  // --- A site's general access ----------------------------------------------

  /** The sites whose gatekeeper the steward is waiting for at this moment. */
  const gatekeepersInFlight = new Set<string>();

  /**
   * What stops every change of general access on this site right now, null
   * if nothing. A backup that remains says a gatekeeper stopped in the
   * middle: the block in service is not necessarily the one being read any
   * more, and a new action would start from a state nobody knows. While this
   * steward is waiting for the gatekeeper, it is normal, and the page says so
   * otherwise.
   */
  async function blockerOf(site: Site): Promise<string | null> {
    try {
      if (await system.gatekeeperBackup(site.folder)) {
        return gatekeepersInFlight.has(site.folder) ? TRANSACTION_IN_PROGRESS_REASON : INTERRUPTED_TRANSACTION_REASON;
      }
      const other = (await system.gatekeeperBackups()).find((name) => name !== site.folder);
      return other === undefined ? null : backupElsewhereReason(other, gatekeepersInFlight.has(other));
    } catch (e) {
      // When in doubt, no action: we do not know whether a gatekeeper stopped.
      console.error(`portal: gatekeeper backup unreadable for ${site.folder} (${errorName(e)})`);
      return "the gatekeeper's state could not be checked on the server";
    }
  }

  async function portalView(site: Site, blocker?: string | null): Promise<PortalView> {
    let modifiable = false;
    let reason: string | null = "sitesolide.json could not be checked";
    try {
      ({ modifiable, reason } = portalModifiable(site.folder, site.manifest));
    } catch (e) {
      console.error(`portal: rule unreadable for ${site.folder} (${errorName(e)})`);
    }
    const stop = blocker === undefined ? await blockerOf(site) : blocker;
    if (stop !== null) {
      modifiable = false;
      reason = stop;
    }

    let installed = false;
    try {
      const fragment = await system.readFragment(site.folder);
      installed = fragment !== null && fragmentIsProtected(fragment);
    } catch (e) {
      console.error(`portal: Caddy block unreadable for ${site.folder} (${errorName(e)})`);
    }
    return { requested: site.manifest !== null && isProtected(site.manifest), installed, modifiable, reason };
  }

  /**
   * The preview code in force for a site, and whether the fragment in service
   * applies it: read from the files the gatekeeper writes, never kept here.
   * Unreadable reads as no code, said in the journal.
   */
  async function codeOf(slug: string): Promise<{ code: string | null; applied: boolean }> {
    try {
      const raw = readLockCodes(await system.readCodes())[slug];
      const code = isValidCode(raw) ? raw : null;
      // Applied in the form that closes the site's own domain too: one an
      // earlier release wrote is no reason to say there is nothing to change.
      const fragment = await system.readLocksFragment();
      return { code, applied: code !== null && installedCode(fragment, slug) === code && stanzaClosesEveryAddress(fragment, slug) };
    } catch (e) {
      console.error(`general: preview code unreadable for ${slug} (${errorName(e)})`);
      return { code: null, applied: false };
    }
  }

  type GeneralState = { view: GeneralView; choices: Choices; portal: PortalView; code: string | null; applied: boolean };

  /**
   * A site's general access as the machine carries it, Public, Restricted or
   * Anyone with the code, and for each of the three whether it may be chosen
   * from here: the gatekeeper's rule (src/gatekeeper/rules.ts), and a
   * gatekeeper in flight or interrupted, which stops all three.
   */
  async function generalState(site: Site): Promise<GeneralState> {
    const blocker = await blockerOf(site);
    const portal = await portalView(site, blocker);
    let choices: Choices;
    try {
      choices = generalChoices(site.folder, site.manifest);
    } catch (e) {
      console.error(`general: rule unreadable for ${site.folder} (${errorName(e)})`);
      const unknown = "sitesolide.json could not be checked";
      choices = { public: unknown, restricted: unknown, code: unknown };
    }
    if (blocker !== null) choices = { public: blocker, restricted: blocker, code: blocker };
    const access: GeneralAccess = portal.requested && portal.installed ? "restricted" : site.manifest?.lock === true ? "code" : "public";
    const { code, applied } = await codeOf(site.folder);
    const others = GENERAL_ACCESSES.filter((one) => one !== access);
    const open = others.some((one) => choices[one] === null);
    const reason = open ? null : (blocker ?? choices[others[0]!] ?? null);
    return { view: { access, modifiable: open, reason, choices }, choices, portal, code, applied };
  }

  /** The code and the link that carries it, for whoever may see them. */
  function codeView(site: Site, code: string | null): { code: string; url: string | null } | null {
    if (code === null) return null;
    return { code, url: memberZone === "" ? null : `https://${codeAddress(site.folder, memberZone, site.manifest)}/?key=${code}` };
  }

  // --- The routes ------------------------------------------------------------

  /** A project as the page shows it: its service, the files given, its portal, and its store as `actor` may see it. */
  async function projectView(site: Site, declarations: readonly Declaration[] = site.files, actor: StoreActor = OWNER_STORE): Promise<ProjectView> {
    const service = await readService(site);
    const files: FileView[] = [];
    for (const declaration of declarations) {
      const path = pathUnder(secretsFolder, declaration.name) ?? declaration.name;
      try {
        files.push(await fileView({ site, declaration, path }, service));
      } catch (e) {
        // An unreadable file does not bring the whole list down.
        console.error(`projects: ${declaration.name} unreadable (${errorName(e)})`);
        files.push(unreadableView(declaration));
      }
    }
    return { slug: site.folder, service: service.view, files, portal: await portalView(site), store: await projectStore(site, actor) };
  }

  /**
   * The store of a listed project: an app's that has one, null for a static
   * site, a storeless project, or a folder whose manifest does not describe
   * it. A store that cannot be read does not bring the list down.
   */
  async function projectStore(site: Site, actor: StoreActor): Promise<StoreView | null> {
    const { manifest } = site;
    if (manifest === null || manifest.slug !== site.folder || !hasStore(manifest)) return null;
    try {
      return await buildStoreView({ slug: site.folder, site, manifest }, actor);
    } catch (e) {
      console.error(`projects: the store of ${site.folder} unreadable (${errorName(e)})`);
      return null;
    }
  }

  async function listProjects(): Promise<Response> {
    const seen = await Promise.all([...(await sites()).values()].map((site) => projectView(site)));
    const body: ProjectsResponse = { projects: seen };
    return Response.json(body);
  }

  /**
   * What a member lists of their projects: those where their role lets them
   * see the files, never a platform project nor a file kept for root. To a
   * Developer every file is write-only: no value, no size, no previous version
   * offered, since none of it is theirs to read back.
   */
  async function memberProjects(roles: Roles): Promise<ProjectView[]> {
    const all = await sites();
    const views: ProjectView[] = [];
    for (const [slug, role] of Object.entries(roles).sort(([a], [b]) => a.localeCompare(b))) {
      const site = all.get(slug);
      if (site === undefined || !may(role, "secrets.list") || machineRefusal(slug, null, memberZone) !== null) continue;
      const restores = may(role, "secrets.restore");
      const actor: StoreActor = { who: { actor: OWNER_ACTOR, member: OWNER_ACTOR }, kind: "person", creating: false, restores };
      const view = await projectView(site, site.files.filter((declaration) => machineRefusal(slug, declaration, memberZone) === null), actor);
      // Nobody but the owner reads a value back: every file write-only, a
      // previous version said to whoever may put it back.
      views.push({ ...view, files: view.files.map((file) => (restores ? { ...writeOnly(file), previous: file.previous } : writeOnly(file))) });
    }
    return views;
  }

  /**
   * One project's files as a token lists them, the control routes having
   * judged the token, its role and its flag: a Developer's listing, every
   * file write-only whatever the role, never a platform project nor a file
   * kept for root, and `writable` on the one file a token changes. No portal:
   * a token reads general access through its own route.
   */
  async function tokenProject(slug: string, who: Who): Promise<Response> {
    const found = checkSite(await sites(), slug);
    if ("refusal" in found) return error("not-found", `${slug} is not a site deployed on this machine`);
    const { site } = found;
    const machine = machineRefusal(site.folder, null, memberZone);
    if (machine !== null) {
      await writeLog("list", "rejects", { slug }, "out-of-scope", null, who);
      return error("out-of-scope", machine);
    }
    const declarations = site.files.filter((declaration) => machineRefusal(site.folder, declaration, memberZone) === null);
    const service = await readService(site);
    const files: TokenFileView[] = [];
    for (const declaration of declarations) {
      const path = pathUnder(secretsFolder, declaration.name) ?? declaration.name;
      let file: FileView;
      try {
        file = await fileView({ site, declaration, path }, service);
      } catch (e) {
        // An unreadable file does not bring the whole list down.
        console.error(`projects: ${declaration.name} unreadable (${errorName(e)})`);
        file = unreadableView(declaration);
      }
      files.push({ ...writeOnly(file), writable: tokenFileRefusal(site, declaration.name) === null });
    }
    const secrets: ProjectSecrets = { slug: site.folder, service: service.view, files };
    const body: SecretsListResponse = { secrets };
    return Response.json(body);
  }

  /** The journal and a window of the access log as one history, read one request at a time and kept by none (log.ts). */
  const history = createHistory({
    readJournal: async () => {
      await accessLogPrepared;
      return system.readLog();
    },
    readAccessLog: (window) => system.readAccessLog(window),
  });

  async function readLog(req: Request): Promise<Response> {
    const params = new URL(req.url).searchParams;
    const wanted = params.getAll("slug");
    if (wanted.length > 1) return error("invalid", "name one site at most");
    const slug = wanted[0] ?? null;
    if (slug !== null && !isSiteFolder(slug)) return error("invalid", "not a site name");
    const asked = readPageQuery(params);
    if (asked !== null && "error" in asked) return error("invalid", asked.error);
    // One history, the journal's and the access log's, sorted by date before
    // `latest` takes its last lines or `page` its dates.
    await accessLogPrepared;
    // The access log's window: the newest rows before the page's date, of the
    // site when one is named, as many as the answer holds at least.
    const window = asked === null ? { before: null, slug, need: RETURNED_ENTRIES } : { before: asked.before, slug, need: asked.limit };
    const body: LogResponse = await history.read(window, (entries) => (asked === null ? { entries: latest(entries, RETURNED_ENTRIES, slug) } : { entries: page(entries, asked, slug), paged: true }));
    return Response.json(body);
  }

  /** The hash, or the response that refuses to use it. */
  async function safeHash(operation: Operation): Promise<string | Response> {
    const reading = await system.readHash();
    if (reading.kind === "absent") return "";
    if (checked) {
      const reason = hashFileRefusal(reading.info, uidRoot);
      if (reason !== null) {
        // A deployment mistake, not a wrong password: it is said in the
        // service's log, where the administrator will read it, and the page
        // receives the generic message.
        console.error(`${operation} refused: the password hash file is not protected (${reason})`);
        await writeLog(operation, "failure", null, "password hash file not protected");
        return error("failure", GENERIC_MESSAGE);
      }
    }
    if (reading.bytes === null) return "";
    try {
      return hashFrom(new TextDecoder("utf-8", { fatal: true }).decode(reading.bytes));
    } catch {
      return "";
    }
  }

  /**
   * An attempt at the dashboard's password, in the one-at-a-time queue: rate
   * limiting checked again when its turn comes, attempt counted on disk BEFORE
   * the verification, reset to zero on a success. Returns null on a success,
   * the refusal response otherwise. The token in force is never touched here.
   */
  async function tryDashboardPassword(operation: Operation, submitted: string, body: Body | null, variable: string | null): Promise<Response | null> {
    const remaining = wait(state, system.now());
    if (remaining > 0) return tooManyAttempts(remaining);

    const hash = await safeHash(operation);
    if (hash instanceof Response) return hash;

    // If argon2id gets the process killed, or if the process is killed in order
    // to start again, the attempt stays counted. Without this write, no
    // verification.
    const pessimistic = attemptRefused(state, system.now());
    try {
      await system.writeRateLimit(encodeRateLimit(pessimistic));
    } catch (e) {
      console.error(`rate limiting: cannot write (${errorName(e)}), ${operation} refused`);
      return error("failure", GENERIC_MESSAGE);
    }
    state = pessimistic;

    if (!(await check(submitted, hash))) {
      await writeLog(operation, "rejects", body, hash === "" ? "no password hash" : "wrong password", variable);
      return error("refused", "wrong password");
    }

    state = { ...state, failures: 0, lastFailureAt: 0 };
    try {
      await system.writeRateLimit(encodeRateLimit(state));
    } catch (e) {
      // The counter stays at one failure too many on disk: nothing serious.
      console.error(`rate limiting: reset not written (${errorName(e)})`);
    }
    return null;
  }

  async function unlock(req: Request): Promise<Response> {
    await rateLimitReread;
    // Before reading the body, like the dashboard's sign-in: a rate-limited
    // attempt costs nothing, not even the reading of its request.
    const remaining = wait(state, system.now());
    if (remaining > 0) return tooManyAttempts(remaining);

    const body = await readBody(req, ["password"]);
    if (body instanceof Response) return body;
    const submitted = body.password;
    if (!isAcceptableSubmission(submitted)) return error("invalid", "password missing or too long");

    const taken = oneAtATime(async () => {
      if (req.signal.aborted) return abandoned();
      // Checked again when its turn comes: the attempts that were waiting
      // behind a failure are subject to it.
      const refusal = await tryDashboardPassword("unlock", submitted, null, null);
      if (refusal !== null) return refusal;

      const accepted = await attemptAccepted(state, system.now(), options.random);
      state = accepted.state;
      await writeLog("unlock", "ok", null, null);
      const response: UnlockResponse = { token: accepted.token, expiresAt: accepted.expiresAt };
      return Response.json(response);
    });
    return taken ?? busy();
  }

  /**
   * 204 even on a token that is already dead: the relay locks on signing out,
   * often after the expiry, and what it asks for is already true. A wrong token
   * does not revoke the right one. Outside the lock: locking must never wait
   * for the end of a restart, which is precisely what stops the writes waiting
   * behind it.
   */
  async function lock(req: Request): Promise<Response> {
    const body = await readBody(req, ["token"]);
    if (body instanceof Response) return body;
    if (await isValidToken(state, body.token, system.now())) {
      state = revoke(state);
      await writeLog("lock", "ok", null, null);
    }
    return new Response(null, { status: 204 });
  }

  async function readValue(req: Request): Promise<Response> {
    const body = await bodyWithToken(req, ["slug", "file", "variable"]);
    if (body instanceof Response) return body;
    return underLock(req, body, () => readValueTask(req, body, OWNER));
  }

  /** A variable's value, under the lock, for the owner or an Admin. */
  async function readValueTask(_req: Request, body: Body, who: Who): Promise<Response> {
    const found = await target("read", body, who);
    if (found instanceof Response) return found;
    const kind = kindRefusal(found, "variables");
    if (kind !== null) return refuse("read", body, kind, null, who);
    // Before any reading of the file: a hash is never read back.
    if (isPassword(found.declaration, body.variable)) {
      const message = `${body.variable as string} is never read back, change it with Change password`;
      return refuse("read", body, { error: "out-of-scope", message }, body.variable as string, who);
    }
    const managed = await managedFile("read", body, found, null, who);
    if (managed instanceof Response) return managed;

    const value = envValue(managed.document!, body.variable as string);
    if (value === null) {
      return refuse("read", body, { error: "not-found", message: `no such variable in ${found.declaration.name}` }, null, who);
    }
    await writeLog("read", "ok", body, null, body.variable as string, who);
    const response: ValueResponse = { value };
    return Response.json(response);
  }

  /** The refusal of an ordinary route on a hash, for setting as for removing. */
  function passwordRefusal(c: Target, variable: unknown): Refusal | null {
    if (!isPassword(c.declaration, variable)) return null;
    return { error: "out-of-scope", message: `${variable as string} is a password hash, change it with Change password` };
  }

  async function setVariable(req: Request): Promise<Response> {
    const body = await bodyWithToken(req, ["slug", "file", "variable", "value"]);
    if (body instanceof Response) return body;
    return underLock(req, body, () => setVariableTask(req, body, OWNER));
  }

  /** Sets a variable, under the lock. The answer is the file's view, never the value written. */
  async function setVariableTask(_req: Request, body: Body, who: Who): Promise<Response> {
    const found = await target("set", body, who);
    if (found instanceof Response) return found;
    const kind = kindRefusal(found, "variables");
    if (kind !== null) return refuse("set", body, kind, null, who);
    const password = passwordRefusal(found, body.variable);
    if (password !== null) return refuse("set", body, password, body.variable as string, who);
    const foreign = outsideHashRefusal(found.declaration.name, body.variable);
    if (foreign !== null) return refuse("set", body, foreign, null, who);
    const managed = await managedFile("set", body, found, null, who);
    if (managed instanceof Response) return managed;

    const variable = body.variable as string;
    const value = body.value as string;
    const known = knownVariable(managed.document, body);
    const keyReason = checkKey(variable, await setKeys(found.site));
    if (keyReason !== null) return refuse("set", body, { error: "invalid", message: keyReason }, known, who);
    const valueReason = checkValue(value);
    if (valueReason !== null) return refuse("set", body, { error: "invalid", message: valueReason }, known, who);
    // S2: the store is read after every legacy file, and a name it holds
    // would make this write change nothing the service gets.
    const shadowed = legacyWriteRefusal(variable, await storeNamesFor(found.site), found.declaration.name);
    if (shadowed !== null) return refuse("set", body, shadowed, known, who);

    const refusal = await rewrite(found, managed, set(managed.document!, variable, value));
    if (refusal !== null) {
      await writeLog("set", "rejects", body, "invalid", known, who);
      return refusal;
    }
    await writeLog("set", "ok", body, null, variable, who);
    return fileResponse(found, who);
  }

  async function removeVariable(req: Request): Promise<Response> {
    const body = await bodyWithToken(req, ["slug", "file", "variable"]);
    if (body instanceof Response) return body;
    return underLock(req, body, () => removeVariableTask(req, body, OWNER));
  }

  async function removeVariableTask(_req: Request, body: Body, who: Who): Promise<Response> {
    const found = await target("remove", body, who);
    if (found instanceof Response) return found;
    const kind = kindRefusal(found, "variables");
    if (kind !== null) return refuse("remove", body, kind, null, who);
    const password = passwordRefusal(found, body.variable);
    if (password !== null) return refuse("remove", body, password, body.variable as string, who);
    const managed = await managedFile("remove", body, found, null, who);
    if (managed instanceof Response) return managed;

    const variable = body.variable as string;
    if (envValue(managed.document!, variable) === null) {
      return refuse("remove", body, { error: "not-found", message: `no such variable in ${found.declaration.name}` }, null, who);
    }
    // A reserved key that is already present can be removed: that is repairing, not setting.
    await rewrite(found, managed, remove(managed.document!, variable));
    await writeLog("remove", "ok", body, null, variable, who);
    return fileResponse(found, who);
  }

  async function createFile(req: Request): Promise<Response> {
    const body = await bodyWithToken(req, ["slug", "file"]);
    if (body instanceof Response) return body;
    return underLock(req, body, () => createFileTask(req, body, OWNER));
  }

  async function createFileTask(_req: Request, body: Body, who: Who): Promise<Response> {
    const found = await target("create", body, who);
    if (found instanceof Response) return found;
    const { declaration } = found;

    // The steward never creates a directory in /etc/sitesolide: a
    // subdirectory is put in place by hand, as root, as the deployment does.
    const folder = await subFolderState(declaration.name);
    if (folder.kind === "absent") {
      return refuse("create", body, { error: "not-found", message: `${folder.path} does not exist on the server` }, null, who);
    }
    if (folder.kind === "rejects") {
      return refuse("create", body, { error: "unmanaged", message: `${declaration.name} is not managed here: ${folder.reason}` }, null, who);
    }

    if ((await system.examineSecret(declaration.name)).kind !== "absent") {
      return refuse("create", body, { error: "already-present", message: `${declaration.name} already exists` }, null, who);
    }

    const account = await realAccount(declaration);
    if (account === null) {
      const message = `account ${declaration.expected.owner} does not exist, deploy the site first`;
      return refuse("create", body, { error: "not-found", message }, null, who);
    }

    const created = await createFresh(declaration.name, expectedPermissions(declaration, account ?? null));
    if (!created) {
      return refuse("create", body, { error: "already-present", message: `${declaration.name} already exists` }, null, who);
    }
    await writeLog("create", "ok", body, null, null, who);
    return fileResponse(found, who);
  }

  /**
   * A token's change of `<slug>.env`, under the lock, the token judged by the
   * control routes and judged again once the turn came. All or nothing: every
   * name and every value judged first, and the whole file measured, before
   * anything is created or written; then one write, one previous version, and
   * one journal line per name, under `token:<id>`.
   *
   * The file is created when its project's manifest declares it and it is
   * missing, unless the request only removes. A name removed that the file
   * does not carry is said in `absent`, and nothing is journaled for it. A set
   * is always written and journaled: the answer never says whether a value
   * changed, which would tell whoever holds the token what the file holds.
   *
   * The file a request names is never journaled nor quoted until it is the one
   * a token manages, and a name is never journaled when the request is
   * refused but for `PASSWORD_HASH`: a value pasted in its place would stay.
   */
  async function changeVariablesTask(change: TokenSecretsChange, who: Who): Promise<Response> {
    const removing = change.set.length === 0 && change.remove.length > 0;
    const operation: Operation = removing ? "remove" : "set";
    const asked: Body = { slug: change.slug };
    const found = checkSite(await sites(), change.slug);
    if ("refusal" in found) return refuse(operation, asked, found.refusal, null, who);
    const machine = machineRefusal(found.site.folder, null, memberZone);
    if (machine !== null) return refuse(operation, asked, { error: "out-of-scope", message: machine }, null, who);
    const foreignFile = tokenFileRefusal(found.site, change.file);
    if (foreignFile !== null) return refuse(operation, asked, foreignFile, null, who);

    const body: Body = { slug: change.slug, file: change.file };
    const c = await target(operation, body, who);
    if (c instanceof Response) return c;
    const name = c.declaration.name;

    const keysOfUnit = await setKeys(c.site);
    const storeNames = change.set.length === 0 ? new Set<string>() : await storeNamesFor(c.site);
    for (const [variable, value] of change.set) {
      if (!isVariableName(variable)) return refuse("set", body, { error: "invalid", message: "set: a name is not a variable name" }, null, who);
      const password = passwordRefusal(c, variable);
      if (password !== null) return refuse("set", body, password, variable, who);
      const hashOnly = outsideHashRefusal(name, variable);
      if (hashOnly !== null) return refuse("set", body, hashOnly, null, who);
      const keyReason = checkKey(variable, keysOfUnit);
      if (keyReason !== null) return refuse("set", body, { error: "invalid", message: variableRefusal("set", variable, keyReason) }, null, who);
      const valueReason = checkValue(value);
      if (valueReason !== null) return refuse("set", body, { error: "invalid", message: variableRefusal("set", variable, valueReason) }, null, who);
      const shadowed = legacyWriteRefusal(variable, storeNames, name);
      if (shadowed !== null) return refuse("set", body, shadowed, null, who);
    }
    for (const variable of change.remove) {
      if (!isVariableName(variable)) return refuse("remove", body, { error: "invalid", message: "remove: a name is not a variable name" }, null, who);
      const password = passwordRefusal(c, variable);
      if (password !== null) return refuse("remove", body, password, variable, who);
    }

    /** The change applied to a document: what is set, what is removed, what was not there to remove. */
    const apply = (document: EnvDocument) => {
      let next = document;
      const written: string[] = [];
      const removed: string[] = [];
      const absent: string[] = [];
      for (const [variable, value] of change.set) {
        next = set(next, variable, value);
        written.push(variable);
      }
      for (const variable of change.remove) {
        if (envValue(next, variable) === null) {
          absent.push(variable);
          continue;
        }
        next = remove(next, variable);
        removed.push(variable);
      }
      return { document: next, written, removed, absent };
    };
    const tooBigRefused = async () => {
      await writeLog(operation, "rejects", body, "invalid", null, who);
      return tooBig();
    };

    let state = await examineTarget(c);
    let created = false;
    if (state.kind === "absent") {
      if (removing) return refuse("remove", body, { error: "not-found", message: `${name} does not exist: there is nothing to remove` }, null, who);
      // Measured before the file is created: a file created, then the change
      // refused, would not be all or nothing.
      if (boundedBytes(apply({ lines: [] }).document) === null) return tooBigRefused();
      const account = await realAccount(c.declaration);
      if (account === null) {
        return refuse("create", body, { error: "not-found", message: `account ${c.declaration.expected.owner} does not exist, deploy the site first` }, null, who);
      }
      created = await createFresh(name, expectedPermissions(c.declaration, account ?? null));
      if (created) await writeLog("create", "ok", body, null, null, who);
      // Created here or, in a race, by someone else a moment before: read as it stands.
      state = await examineTarget(c);
    }
    if (state.kind === "absent") return refuse(operation, body, { error: "not-found", message: `${name} could not be created` }, null, who);
    if (state.kind === "unmanaged") {
      return refuse(operation, body, { error: "unmanaged", message: `${name} is not managed here: ${state.reason}` }, null, who);
    }

    const { managed } = state;
    const applied = apply(managed.document!);
    if (applied.written.length + applied.removed.length > 0) {
      const bytes = boundedBytes(applied.document);
      if (bytes === null) return tooBigRefused();
      await writeKeepingPrevious(c, managed, bytes);
      for (const variable of applied.written) await writeLog("set", "ok", body, null, variable, who);
      for (const variable of applied.removed) await writeLog("remove", "ok", body, null, variable, who);
    }
    const answer: StewardSecretsChange = {
      file: { ...(await fileAfter(c, who)), writable: true },
      created,
      set: applied.written,
      removed: applied.removed,
      absent: applied.absent,
    };
    return Response.json(answer, { status: created ? 201 : 200 });
  }

  /**
   * Swaps the file and its previous version: restoring twice comes back to the
   * starting point. Never automatic, see PLAN-SECRETS.md: the previous version
   * may be the key that leaked.
   *
   * Never for a file that carries a password, in its current version or in the
   * previous one: after a Change password following a leak, a token would
   * otherwise be enough to make the old one valid again.
   */
  async function restore(req: Request): Promise<Response> {
    const body = await bodyWithToken(req, ["slug", "file"]);
    if (body instanceof Response) return body;
    return underLock(req, body, () => restoreTask(req, body, OWNER));
  }

  async function restoreTask(_req: Request, body: Body, who: Who): Promise<Response> {
    const found = await target("restore", body, who);
    if (found instanceof Response) return found;
    const { declaration } = found;
    // A hash-only file, before even reading it.
    const fixed = restoreRefusal(declaration, []);
    if (fixed !== null) return refuse("restore", body, fixed, null, who);
    const managed = await managedFile("restore", body, found, null, who);
    if (managed instanceof Response) return managed;
    const { name } = declaration;

    const current = restoreRefusal(declaration, managed.document === null ? [] : keys(managed.document));
    if (current !== null) return refuse("restore", body, current, null, who);

    const kept = await system.examinePrevious(name);
    if (kept.kind === "absent") {
      return refuse("restore", body, { error: "not-found", message: `no previous version of ${name}` }, null, who);
    }
    const keptRefusal = restoreRefusal(declaration, previousKeys(declaration, kept));
    if (keptRefusal !== null) return refuse("restore", body, keptRefusal, null, who);
    const reason = previousReason(kept.info, managed.real, found.declaration.expected.owner);
    const readable =
      kept.bytes !== null &&
      (found.declaration.kind === "variables" ? parseEnvBytes(kept.bytes).ok : "text" in readContent(kept.bytes));
    if (reason !== null || !readable) {
      const message = reason ?? `the previous version of ${name} is not in a form managed here`;
      return refuse("restore", body, { error: "unmanaged", message }, null, who);
    }

    await writeKeepingPrevious(found, managed, kept.bytes!);
    await writeLog("restore", "ok", body, null, null, who);
    return fileResponse(found, who);
  }

  /**
   * The content of a file managed as one block. Refused before any reading for
   * a write-only file: a private key is replaced, it never comes back to the
   * screen.
   */
  async function readFileContent(req: Request): Promise<Response> {
    const body = await bodyWithToken(req, ["slug", "file"]);
    if (body instanceof Response) return body;
    return underLock(req, body, () => readContentTask(req, body, OWNER));
  }

  async function readContentTask(_req: Request, body: Body, who: Who): Promise<Response> {
    const found = await target("read", body, who);
    if (found instanceof Response) return found;
    const kind = kindRefusal(found, "content");
    if (kind !== null) return refuse("read", body, kind, null, who);
    if (!found.declaration.readable) {
      const message = `${found.declaration.name} is write-only, it can be replaced but never read back`;
      return refuse("read", body, { error: "out-of-scope", message }, null, who);
    }
    const managed = await managedFile("read", body, found, null, who);
    if (managed instanceof Response) return managed;

    await writeLog("read", "ok", body, null, null, who);
    const response: ContentResponse = { content: managed.text! };
    return Response.json(response);
  }

  /** Replaces a file managed as one block, byte for byte, and keeps the previous version. */
  async function replaceContent(req: Request): Promise<Response> {
    const body = await bodyWithToken(req, ["slug", "file", "content"], [], MAX_CONTENT_BODY_BYTES);
    if (body instanceof Response) return body;
    return underLock(req, body, () => replaceContentTask(req, body, OWNER));
  }

  async function replaceContentTask(_req: Request, body: Body, who: Who): Promise<Response> {
    const found = await target("replace", body, who);
    if (found instanceof Response) return found;
    const kind = kindRefusal(found, "content");
    if (kind !== null) return refuse("replace", body, kind, null, who);
    const reason = checkContent(body.content as string);
    if (reason !== null) return refuse("replace", body, { error: "invalid", message: reason }, null, who);
    const managed = await managedFile("replace", body, found, null, who);
    if (managed instanceof Response) return managed;

    await writeKeepingPrevious(found, managed, encoder.encode(body.content as string));
    await writeLog("replace", "ok", body, null, null, who);
    return fileResponse(found, who);
  }

  /**
   * Changes a password hash. In order: token, shape, target, then the
   * dashboard's password in the one-at-a-time queue, which counts the attempt
   * as an unlocking, then the new hash in the same queue, read back against its
   * password before being written, then the write under the exclusion lock. The
   * drawn password goes out only in the response, once.
   */
  async function changePassword(req: Request): Promise<Response> {
    await rateLimitReread;
    const body = await bodyWithToken(req, ["slug", "file", "variable", "dashboardPassword"], ["newPassword"]);
    if (body instanceof Response) return body;

    const remaining = wait(state, system.now());
    if (remaining > 0) return tooManyAttempts(remaining);
    const submitted = body.dashboardPassword;
    if (!isAcceptableSubmission(submitted)) return error("invalid", "dashboard password missing or too long");
    const newPassword = body.newPassword;
    if (newPassword !== null && typeof newPassword !== "string") return error("invalid", "newPassword must be a string or null");
    if (typeof newPassword === "string") {
      const reason = newPasswordReason(newPassword);
      if (reason !== null) return error("invalid", reason);
    }

    // The target before the verification: an argon2id is not spent on a file
    // outside the scope, and the refusal does not count in the rate limiting.
    const before = await target("password", body);
    if (before instanceof Response) return before;
    if (!isPassword(before.declaration, body.variable)) {
      const message = `only ${before.declaration.passwords.join(", ") || "a password hash"} changes here`;
      return refuse("password", body, { error: "out-of-scope", message });
    }
    const variable = body.variable as string;
    const present = await managedFile("password", body, before, variable);
    if (present instanceof Response) return present;

    const taken = oneAtATime(async (): Promise<Response | { password: string; hash: string }> => {
      if (req.signal.aborted) return abandoned();
      // A token revoked during the wait does not cost one more argon2id.
      if (!(await isValidToken(state, body.token, system.now()))) return error("locked", "locked, unlock again");
      const refusal = await tryDashboardPassword("password", submitted, body, variable);
      if (refusal !== null) return refusal;

      const password = newPassword ?? drawPassword();
      const hash = await hashPassword(password);
      // The hash is read back before being written, like scripts/fingerprint.ts:
      // a hash that does not verify its password would shut the door for good,
      // with nothing saying so before the next sign-in.
      if (checkValue(hash) !== null || !(await check(password, hash))) {
        await writeLog("password", "failure", body, "the new hash does not verify", variable);
        return error("failure", GENERIC_MESSAGE);
      }
      return { password, hash };
    });
    if (taken === null) return busy();
    const fresh = await taken;
    if (fresh instanceof Response) return fresh;

    return underLock(req, body, async () => {
      const found = await target("password", body);
      if (found instanceof Response) return found;
      if (!isPassword(found.declaration, variable)) {
        return refuse("password", body, { error: "out-of-scope", message: "this variable is no longer a password" });
      }
      const managed = await managedFile("password", body, found, variable);
      if (managed instanceof Response) return managed;

      const bytes = boundedBytes(set(managed.document!, variable, fresh.hash));
      if (bytes === null) {
        await writeLog("password", "rejects", body, "invalid", variable);
        return tooBig();
      }
      // The old hash is not kept: it may be the one that leaked. The previous
      // version goes first, the new file next, in the same turn of the lock: a
      // stop between the two leaves the old hash in place and no previous
      // version, never the new one beside the old one. A set made during the
      // argon2id may have kept one: it goes too.
      const { name } = found.declaration;
      await system.removePrevious(name);
      await system.writeSecret(name, bytes, expectedPermissions(found.declaration, managed.real));
      await writeLog("password", "ok", body, null, variable);
      const service = await readService(found.site);
      const response: PasswordResponse = {
        file: await fileView(found, service),
        password: newPassword === null ? fresh.password : null,
      };
      return Response.json(response);
    });
  }

  /**
   * Restricts a site or makes it public, through the gatekeeper: the route the
   * dashboard called before the three general accesses, kept for a dashboard
   * deployed before this steward. Its answer keeps its shape.
   */
  async function togglePortal(req: Request): Promise<Response> {
    const body = await readBody(req, ["token", "slug", "confirmation", "active"]);
    if (body instanceof Response) return body;
    if (typeof body.active !== "boolean") return error("invalid", "active must be a boolean");
    for (const field of ["slug", "confirmation"]) if (typeof body[field] !== "string") return error("invalid", `${field} must be a string`);
    if (body.active) return underLockWith(req, async () => null, () => portalTask(req, body, OWNER));
    if (!(await isValidToken(state, body.token, system.now()))) return error("locked", "locked, unlock again");
    return underLock(req, body, () => portalTask(req, body, OWNER));
  }

  /** `POST /portal`'s and `/people/portal`'s body read as a general access, answered in their shape. */
  async function portalTask(req: Request, body: Body, who: Who): Promise<Response> {
    const { active, ...rest } = body;
    const changed = await generalChange(req, { ...rest, access: active === true ? "restricted" : "public" }, who, "dashboard");
    if (changed instanceof Response) return changed;
    const response: PortalResponse = { portal: changed.portal, detail: changed.detail };
    return Response.json(response);
  }

  /**
   * A site's general access, any of the three, or a new code, for the owner's
   * session: the unlock for everything but Restricted, which lets nobody new
   * in, and is never refused for want of a password.
   */
  async function setGeneral(req: Request): Promise<Response> {
    const body = await readBody(req, ["token", "slug", "access", "renew", "confirmation"]);
    if (body instanceof Response) return body;
    if (body.access === "restricted") return underLockWith(req, async () => null, () => generalTask(req, body, OWNER));
    if (!(await isValidToken(state, body.token, system.now()))) return error("locked", "locked, unlock again");
    return underLock(req, body, () => generalTask(req, body, OWNER));
  }

  /**
   * The same over the owner's socket, which only root opens: `sitesolide lock`
   * and `sitesolide unlock`, over the owner's SSH. Root has asked for it:
   * neither the dashboard's unlock nor the slug retyped, and the bound of the
   * owner over SSH (src/access/steward.ts, `widen`).
   */
  async function ownerGeneral(req: Request): Promise<Response> {
    const body = await readBody(req, ["slug", "access", "renew"]);
    if (body instanceof Response) return body;
    return underLockWith(req, async () => null, () => generalTask(req, body, OWNER, "ssh"));
  }

  async function generalTask(req: Request, body: Body, who: Who, channel: "dashboard" | "ssh" = "dashboard"): Promise<Response> {
    const changed = await generalChange(req, body, who, channel);
    return changed instanceof Response ? changed : Response.json(changed);
  }

  /**
   * A change of general access through the gatekeeper, under the exclusion
   * lock: two actions on Caddy never cross. Making a site public, opening it
   * with a code, and a new code each let someone in who was not: they take
   * the unlock (the callers'), are bounded as every change that lets more
   * people in (src/access/steward.ts, `widen`), and the first two take the
   * slug retyped. Restricting takes none of it: less exposure is never refused
   * for want of a password, nor for the access log's room. A site already as
   * asked is left as it is: nothing started, nothing logged, so that what
   * nothing refuses never fills the access log.
   *
   * The journal says `portal` and the general access chosen, `on`, `off` or
   * `code`, or `code` and `renew` for a new code: never the code itself, which
   * the gatekeeper draws on the machine. The answer carries it, for the owner and
   * the project's Admins, read back from the codes file.
   */
  async function generalChange(req: Request, body: Body, who: Who, channel: "dashboard" | "ssh"): Promise<GeneralResponse | Response> {
    if (body.access !== "public" && body.access !== "restricted" && body.access !== "code") return error("invalid", "access: public, restricted or code");
    if (body.renew !== undefined && typeof body.renew !== "boolean") return error("invalid", "renew must be a boolean");
    if (typeof body.slug !== "string") return error("invalid", "slug must be a string");
    if (body.confirmation !== undefined && typeof body.confirmation !== "string") return error("invalid", "confirmation must be a string");
    const target: GeneralAccess = body.access;
    const renew = body.renew === true;
    if (renew && target !== "code") return error("invalid", "a new code is asked with access: code");
    const action = actionFor(target, renew);
    const operation: Operation = renew ? "code" : "portal";

    const found = checkSite(await sites(), body.slug);
    if ("refusal" in found) return refuse(operation, body, found.refusal, null, who);
    const { site } = found;
    if (restricted(who)) {
      const machine = machineRefusal(site.folder, null, memberZone);
      if (machine !== null) return refuse(operation, body, { error: "out-of-scope", message: machine }, null, who);
    }

    const current = await generalState(site);
    if (!renew && target === "restricted" && current.portal.requested && current.portal.installed) {
      return { portal: current.portal, general: current.view, detail: `${site.folder} is already restricted: nothing to change`, code: null };
    }
    if (!renew && target === "code" && current.view.access === "code" && current.applied) {
      return { portal: current.portal, general: current.view, detail: `${site.folder} already opens with a code: nothing to change`, code: codeView(site, current.code) };
    }
    if (renew && current.view.access !== "code") {
      return refuse(operation, body, { error: "invalid", message: `${site.folder} does not open with a code: choose Anyone with the code first` }, null, who);
    }
    const reason = current.choices[target];
    const unit = gatekeeperUnitOf(action, site.folder);
    if (reason !== null || unit === null) {
      return refuse(operation, body, { error: "out-of-scope", message: reason ?? "the general access of this site cannot be changed" }, null, who);
    }
    // Making a site public, or opening it to anyone who holds a code: the name
    // is retyped. Root over its own socket has typed the command itself.
    if (channel !== "ssh" && !renew && target !== "restricted" && body.confirmation !== site.folder) {
      const what = target === "public" ? "making it public" : "opening it with a code";
      return refuse(operation, body, { error: "invalid", message: `type ${site.folder} to confirm ${what}` }, null, who);
    }
    if (target !== "restricted" && access !== null) {
      const bounded = await access.widen(channel, who.actor);
      if (bounded !== null) return bounded;
    }
    // Checked again just before the launch: re-reading the site and its block
    // took time, and a gatekeeper launched for a requester who has gone would
    // change Caddy without anyone seeing the result.
    if (req.signal.aborted) return abandoned();

    const launch = system.now();
    gatekeepersInFlight.add(site.folder);
    try {
      // `start` waits for the end of the gatekeeper, which is a oneshot. Its
      // code does not decide: the result written by the gatekeeper is
      // authoritative.
      await system.systemctl(["start", unit], gatekeeperTimeoutMs);
    } catch (e) {
      console.error(`portal: systemctl start failed (${errorName(e)})`);
    } finally {
      gatekeepersInFlight.delete(site.folder);
    }
    let examination: Examination = { kind: "absent" };
    try {
      examination = await system.readGatekeeperResult(site.folder);
    } catch (e) {
      console.error(`portal: result unreadable (${errorName(e)})`);
    }
    const { result, message } = judgeGatekeeperResult(examination, launch, checked ? uidRoot : null);
    await writeLog(operation, result, body, `${action}, ${result}`, null, who);

    // A refusal from the gatekeeper, Caddy being changed from the workstation
    // included: nothing has moved, the message says what to do.
    if (result === "rejects") return error("unmanaged", message);
    if (result === "failure") return error("failure", message);
    const reread = (await sites()).get(site.folder) ?? site;
    const after = await generalState(reread);
    return { portal: after.portal, general: after.view, detail: message, code: target === "code" ? codeView(site, after.code) : null };
  }

  /**
   * Eight seconds of readings after a restart, and the verdict that comes out
   * of them. `anchor`: the unit runs nothing and stays `active (exited)`, see
   * isAnchorUnit.
   */
  async function observe(unit: string, anchor = false, slug: string | null = null): Promise<Verdict> {
    const readings: ServiceReading[] = [];
    const start = system.now();
    for (;;) {
      const response = await show(unit, true);
      if (response !== null && response.code === 0) readings.push({ ...readShow(response.output), a: system.now() });
      if (system.now() - start >= observationMs) break;
      await system.wait(stepMs);
    }
    const result = verdict(readings, { anchor });
    return slug === null ? result : withCredentials(result, readings, unit, slug);
  }

  const verdictDetail = (result: Verdict) => `${result.kind}, ${result.state}/${result.subState}, ${result.restarts} restarts${result.reason === undefined ? "" : ", 243/CREDENTIALS"}`;

  /**
   * The restart of the dashboard itself. The relay that would carry the verdict
   * is precisely what restarts: the `scheduled` answer leaves first, the
   * restart is booked in the queue straight away and only begins after
   * `schedule`, in `--no-block` so that nothing waits for the dashboard, and
   * the observed verdict goes to the log.
   */
  async function scheduleDashboardRestart(site: Site, body: Body): Promise<Response> {
    const unit = unitOf(site.folder);
    const before = await show(unit, true);
    const parsed = before !== null && before.code === 0 ? readShow(before.output) : null;

    const reserved = exclusive(async () => {
      await schedule();
      await system.systemctl(["reset-failed", unit], showTimeoutMs);
      await system.systemctl(["restart", "--no-block", unit], restartTimeoutMs);
      const result = await observe(unit);
      await writeLog("restart", result.kind === "active" ? "ok" : "failure", body, `${verdictDetail(result)}, scheduled`);
    });
    if (reserved === null) return busy();
    reserved.catch((e) => console.error(`scheduled restart: failed (${errorName(e)})`));

    const response: RestartResponse = {
      verdict: { kind: "scheduled", state: parsed?.state ?? "unknown", subState: parsed?.subState ?? "unknown", restarts: 0 },
    };
    return Response.json(response);
  }

  async function restart(req: Request): Promise<Response> {
    const body = await bodyWithToken(req, ["slug"]);
    if (body instanceof Response) return body;

    return underLock(req, body, async () => {
      const found = checkSite(await sites(), body.slug);
      if ("refusal" in found) return refuse("restart", body, found.refusal);
      const { site } = found;
      const unit = unitOf(site.folder);

      const text = site.isStatic ? null : await system.readUnit(unit);
      if (text === null) {
        return refuse("restart", body, { error: "not-found", message: `${unit}.service is not installed` });
      }

      // The anchor of a project whose every service is scheduled runs
      // nothing, and its services read their files anew at every run: the
      // next one applies the change on its own, and a restart would only cut
      // short a run in progress. Said so, rather than that nothing reads the
      // files, which is not true of the services.
      if (isAnchorUnit(text)) {
        const message = `every service of ${site.folder} is scheduled, and each run reads its files as they stand: the next run applies the change, without a restart`;
        return refuse("restart", body, { error: "out-of-scope", message });
      }

      // Restarting a unit that reads none of the managed files would apply
      // nothing, and would cut the service for nothing. A file is read through
      // `EnvironmentFile=`, or by the service itself when the unit gives it its
      // path, or that of its subdirectory, through `Environment=`.
      const readsFile = unitReads(text);
      const reads = site.files.some(({ name }) => readsFile(name)) || unitTouchesStore(text, site.folder);
      if (!reads) {
        const message = `${unit}.service reads none of the managed files nor its project's store, by EnvironmentFile=, LoadCredential= or Environment=, a restart would apply nothing`;
        return refuse("restart", body, { error: "out-of-scope", message });
      }

      if (site.folder === DASHBOARD_SLUG) return scheduleDashboardRestart(site, body);

      // `reset-failed` first: five startups in ten seconds, and systemd refuses
      // every following restart (`start-limit-hit`) until that action,
      // including the one that follows the restore of a key that was making the
      // service loop. Measured in the laboratory, measurement 3.
      await system.systemctl(["reset-failed", unit], showTimeoutMs);
      // The exit code does not decide: `restart` returns 0 even when the service
      // dies at once. The readings say what happened.
      await system.systemctl(["restart", unit], restartTimeoutMs);

      const result = await observe(unit, false, site.folder);
      await writeLog("restart", result.kind === "active" ? "ok" : "failure", body, verdictDetail(result));
      const response: RestartResponse = { verdict: result };
      return Response.json(response);
    });
  }

  /**
   * A member's restart, the role already judged by src/people/steward.ts and
   * judged again here once the lock is taken. Unlike the Secrets section's, it
   * does not ask whether the unit reads a managed file: a member restarts a
   * service to restart it, not to apply a secret. The platform's own projects
   * are never a member's, and the dashboard's restart would cut the relay that
   * carries the verdict: both are refused. A token's restart is the same
   * code (`restartFor`).
   */
  function memberRestart(req: Request, slug: string, who: Who, allowed: () => Promise<boolean>): Promise<Response> {
    return restartFor(req, slug, who, async () => ((await allowed()) ? null : error("out-of-scope", `${who.actor} may no longer restart ${slug}`)));
  }

  /**
   * A person's restart or a token's, in `turn`: the lock for a person, the
   * project's own turn for a token (`tokenRestartTurn`). `still` says, once
   * the turn has come, whether they may still restart it, and its refusal
   * goes back as it stands, journaled: `busy` for a deployment of the
   * project started meanwhile, "no longer allowed" otherwise. The journal
   * names `who`: the person, or the token and the person it belongs to.
   */
  async function restartFor(
    req: Request,
    slug: string,
    who: Who,
    still: () => Promise<Response | null>,
    turn: <T>(task: () => Promise<T>) => Promise<T> | null = exclusive,
  ): Promise<Response> {
    const body: Body = { slug };
    const taken = turn(async () => {
      if (req.signal.aborted) return abandoned();
      const refusal = await still();
      if (refusal !== null) {
        await writeLog("restart", "rejects", body, refusal.status === 409 ? "busy" : "no longer allowed", null, who);
        return refusal;
      }
      const found = checkSite(await sites(), slug);
      if ("refusal" in found) {
        await writeLog("restart", "rejects", body, found.refusal.error, null, who);
        return error(found.refusal.error, found.refusal.message);
      }
      const { site } = found;
      // A person's or a token's: never the platform's projects. Root over the
      // owner's socket restarts any of them, the dashboard included, whose
      // relay is not in the way there.
      if (restricted(who)) {
        if (site.folder === DASHBOARD_SLUG) return error("out-of-scope", "the dashboard is the owner's to restart");
        // The second lock, whatever a hand-edited registry or team.json claims.
        const machine = machineRefusal(site.folder, null, memberZone);
        if (machine !== null) {
          await writeLog("restart", "rejects", body, "out-of-scope", null, who);
          return error("out-of-scope", machine);
        }
      }
      const unit = unitOf(site.folder);
      const text = site.isStatic ? null : await system.readUnit(unit);
      if (text === null) {
        await writeLog("restart", "rejects", body, "not-found", null, who);
        return error("not-found", site.isStatic ? `${slug} is a static site: it has no service to restart` : `${unit}.service is not installed`);
      }
      await system.systemctl(["reset-failed", unit], showTimeoutMs);
      // A project whose every service is scheduled restarts through its
      // anchor: its timers, and a run in progress, follow it by their PartOf.
      await system.systemctl(["restart", unit], restartTimeoutMs);
      const result = await observe(unit, isAnchorUnit(text), site.folder);
      await writeLog("restart", result.kind === "active" ? "ok" : "failure", body, verdictDetail(result), null, who);
      const response: RestartResponse = { verdict: result };
      return Response.json(response);
    });
    return taken ?? busy();
  }

  // --- A project's store -------------------------------------------------------

  // `/etc/sitesolide/projects/<slug>/`: its env, read last by every unit of
  // the project, and its files, loaded whole by `LoadCredential=`. Root's
  // alone: no `site-<slug>` account is needed to hold one, so a slug not yet
  // deployed can have one. The decisions are store.ts's and migrate.ts's;
  // here, the order of the checks (spec §6.4), the reads and the writes.
  //
  // **No answer of this section carries a value** but `/store/value`, the
  // owner's, unlocked. A set is always written and journaled under its name:
  // no answer says whether a value changed.

  /** The store's folder and files, as `<secrets>/projects/<slug>/...`. */
  const storeRoot = pathUnder(secretsFolder, "projects") ?? `${secretsFolder}/projects`;

  /** The env file and the files folder of a slug's store, the slug validated (storePaths throws). */
  function storeLocation(slug: string): { folder: string; env: string; files: string } {
    return storePaths(slug, storeRoot);
  }

  /**
   * Does this unit read the project's store, its env file last, as every
   * generated unit does? Then a name the store holds wins over every legacy
   * file the unit reads (I4), and the merge of a migration keeps what is in
   * effect today.
   */
  function unitReadsStoreLast(text: string, slug: string): boolean {
    const files = unitEnvironment(text).files;
    return files.length > 0 && files.at(-1)!.path === storeLocation(slug).env;
  }

  /** Does this unit read anything of the project's store, its env or its files? A restart then applies something. */
  function unitTouchesStore(text: string, slug: string): boolean {
    const environment = unitEnvironment(text);
    const { env, files } = storeLocation(slug);
    return environment.files.some((file) => file.path === env) || environment.credentials.some((credential) => credential.id === CREDENTIAL_ID && credential.path === files);
  }

  /** Who works on a store, as this steward verified them. */
  type StoreActor = {
    who: Who;
    /** The owner in the dashboard, root over its socket, a person, a token. */
    kind: "owner" | "ssh" | "person" | "token";
    /** A token the control routes let create this slug (spec §6.5). */
    creating: boolean;
    /** May put a previous version back: the owner, an Admin. */
    restores: boolean;
  };

  const OWNER_STORE: StoreActor = { who: OWNER, kind: "owner", creating: false, restores: true };
  const SSH_STORE: StoreActor = { who: OWNER, kind: "ssh", creating: false, restores: true };

  const isOwnerKind = (actor: StoreActor) => actor.kind === "owner" || actor.kind === "ssh";

  type StoreProject = {
    slug: string;
    /** The deployed folder, null ahead of a deployment. */
    site: Site | null;
    /** The deployed manifest naming this slug, an app's; null otherwise. */
    manifest: Manifest | null;
  };

  /** Rule 1 (spec §6.4): the slug, for this requester, or the refusal. */
  async function storeProject(slug: unknown, actor: StoreActor): Promise<StoreProject | Refusal> {
    const all = await sites();
    const site = typeof slug === "string" && isSiteFolder(slug) ? (all.get(slug) ?? null) : null;
    const refusal = storeSlugRefusal(slug, {
      requester: isOwnerKind(actor) ? "owner" : actor.kind === "person" ? "person" : "token",
      creating: actor.creating,
      zone: memberZone,
      site,
    });
    if (refusal !== null) return refusal;
    const manifest = site?.manifest ?? null;
    const conforms = manifest !== null && manifest.slug === slug && isApp(manifest);
    return { slug: slug as string, site, manifest: conforms ? manifest : null };
  }

  type InstalledUnit = { unit: string; text: string };

  /**
   * The project's service units installed on the machine, every one that
   * runs something: the anchor of a project whose every service is scheduled
   * runs `/bin/true` and reads nothing, its scheduled services do.
   */
  async function installedUnits(project: StoreProject): Promise<InstalledUnit[]> {
    let names: string[];
    if (project.manifest === null) {
      names = project.site === null ? [] : [unitOf(project.slug)];
    } else {
      try {
        names = servicesOf(project.manifest).map((service) => service.unit);
      } catch {
        names = [unitOf(project.slug)];
      }
    }
    const units: InstalledUnit[] = [];
    for (const unit of names) {
      const text = await system.readUnit(unit);
      if (text !== null) units.push({ unit, text });
    }
    return units;
  }

  /** Every installed unit reads the store last; null ahead of a deployment, false with no unit installed. */
  function unitsReadStore(project: StoreProject, units: readonly InstalledUnit[]): boolean | null {
    if (project.site === null || project.manifest === null) return null;
    return units.length > 0 && units.every((unit) => unitReadsStoreLast(unit.text, project.slug));
  }

  /**
   * What a store value would silently override: the manifest's `env`, each
   * service's, the tree variables, and the `Environment=` of every installed
   * unit (rule 3).
   */
  function storeSetKeys(project: StoreProject, units: readonly InstalledUnit[]): string[] {
    const found = new Set<string>(["PORT", "DATA_DIR", "PUBLIC_DIR"]);
    const env = project.manifest?.env as unknown;
    if (typeof env === "object" && env !== null) for (const key of Object.keys(env)) found.add(key);
    if (project.manifest !== null) {
      try {
        for (const service of servicesOf(project.manifest)) {
          if (typeof service.env === "object" && service.env !== null) for (const key of Object.keys(service.env)) found.add(key);
        }
      } catch {
        // a manifest too broken to list its services sets nothing more
      }
    }
    for (const unit of units) for (const key of unitEnvironment(unit.text).keys) found.add(key);
    return [...found];
  }

  type EnvReading =
    | { kind: "absent" }
    | { kind: "managed"; bytes: Uint8Array; document: EnvDocument; info: FileInfo }
    | { kind: "unmanaged"; reason: string; info: FileInfo | null };

  /** A file of the store as its listing reads it: never its bytes, which only a write of that very file reads. */
  type FileReading =
    | { name: string; kind: "managed"; info: FileInfo }
    | { name: string; kind: "unmanaged"; reason: string; info: FileInfo | null };

  type StoreReading = {
    exists: boolean;
    /** A folder that is a link, no folder, or not root's: why. Nothing below it is read. */
    refusal: string | null;
    env: EnvReading;
    files: FileReading[];
    previous: boolean;
  };

  /** Root's account as /etc/passwd gives it, `undefined` without the check, null when missing. */
  async function rootAccount(): Promise<Owner | null | undefined> {
    if (!checked) return undefined;
    return system.account("root");
  }

  /** A store file's or env's reason to be left alone, or null: root's, 0600, one name, within its bound. */
  function storeFileReason(info: FileInfo, real: Owner | null | undefined, path: string, max: number): string | null {
    if (real === null) return "account root does not exist";
    const reason = unmanagedReason(info, STORE_EXPECTED, real ?? null, path);
    if (reason !== null) return reason;
    return info.size > max ? `larger than ${max / 1024} KiB` : null;
  }

  /**
   * The store of a slug as it stands: its three folders judged first, root's
   * and real (rule 2), then its env, parsed, then every file systemd would
   * load. Never throws for what it finds: a store that cannot be read is
   * said so.
   */
  async function readStore(slug: string): Promise<StoreReading> {
    const empty: StoreReading = { exists: false, refusal: null, env: { kind: "absent" }, files: [], previous: false };
    try {
      const location = storeLocation(slug);
      const parts = [
        ["root", storeRoot],
        ["folder", location.folder],
        ["files", location.files],
      ] as const;
      const found: Partial<Record<"root" | "folder" | "files", boolean>> = {};
      for (const [part, path] of parts) {
        const info = await system.examineStoreFolder(slug, part);
        found[part] = info !== null;
        if (info === null) continue;
        const reason = folderReason(info, checked ? uidRoot : null, path);
        if (reason !== null) return { ...empty, exists: found.folder === true, refusal: reason };
      }
      if (found.folder !== true) return empty;

      const real = await rootAccount();
      let env: EnvReading = { kind: "absent" };
      const examined = await system.readStoreEnv(slug);
      if (examined.kind === "present") {
        const reason = storeFileReason(examined.info, real, location.env, MAX_STORE_ENV_BYTES);
        if (reason !== null) env = { kind: "unmanaged", reason, info: examined.info };
        else if (examined.bytes === null) env = { kind: "unmanaged", reason: "could not be read", info: examined.info };
        else {
          const parsed = parseEnvBytes(examined.bytes);
          env = parsed.ok
            ? { kind: "managed", bytes: examined.bytes, document: parsed.document, info: examined.info }
            : { kind: "unmanaged", reason: parsed.line > 0 ? `line ${parsed.line}: ${parsed.reason}` : parsed.reason, info: examined.info };
        }
      }

      const files: FileReading[] = [];
      if (found.files === true) {
        for (const name of await system.listStoreFiles(slug)) {
          let info: FileInfo | null;
          try {
            info = await system.examineStoreFile(slug, name);
          } catch {
            files.push({ name, kind: "unmanaged", reason: "could not be read", info: null });
            continue;
          }
          if (info === null) continue;
          const reason = !isValidFileName(name)
            ? "not a name the store writes: rename or remove it by hand"
            : storeFileReason(info, real, `${location.files}/${name}`, MAX_STORE_FILE_BYTES);
          files.push(reason === null ? { name, kind: "managed", info } : { name, kind: "unmanaged", reason, info });
        }
      }
      const previous = (await system.readStorePrevious(slug, "env")).kind === "present";
      return { exists: true, refusal: null, env, files, previous };
    } catch (e) {
      console.error(`store: ${slug} unreadable (${errorName(e)})`);
      return { ...empty, exists: true, refusal: "could not be read" };
    }
  }

  /** The store's variables, or empty while it has no env. Only for a managed env. */
  function storeValues(reading: StoreReading): Map<string, string> {
    return reading.env.kind === "managed" ? documentValues(reading.env.document) : new Map();
  }

  /** The reason an unreadable store refuses every write, or null (rule 2). */
  function storeStateRefusal(slug: string, reading: StoreReading): Refusal | null {
    if (reading.refusal !== null) return { error: "unmanaged", message: `the store of ${slug} is not managed here: ${reading.refusal}` };
    if (reading.env.kind === "unmanaged") return { error: "unmanaged", message: `the store's env of ${slug} is not managed here: ${reading.env.reason}` };
    return null;
  }

  /** A legacy file of the project, as the rules of a store read it. */
  type LegacyFile = {
    declaration: Declaration;
    read: boolean;
    declared: boolean;
    leftover: boolean;
    state: TargetState;
    /** Its assignments when they can be read, whatever its owner or mode: systemd reads it as root all the same. */
    holder: LegacyHolder;
  };

  /**
   * The project's legacy environment files and leftovers: read first, in the
   * order of the main unit's `EnvironmentFile=` lines, then the others in
   * the site's order. The machine's own files are never a project's.
   */
  async function legacyFilesOf(project: StoreProject, units: readonly InstalledUnit[]): Promise<LegacyFile[]> {
    const { site } = project;
    if (site === null) return [];
    const order: string[] = [];
    for (const unit of units) {
      for (const file of unitEnvironment(unit.text).files) if (!order.includes(file.path)) order.push(file.path);
    }
    const declared = project.manifest === null ? [] : legacySecretFiles(project.manifest);
    const candidates = [
      ...site.files.map((declaration) => ({ declaration, leftover: false })),
      ...site.leftovers.map((declaration) => ({ declaration, leftover: true })),
    ].filter(({ declaration }) => declaration.kind === "variables" && !ROOT_FILES.includes(declaration.name) && !HASH_ONLY.includes(declaration.name));

    const files: LegacyFile[] = [];
    for (const { declaration, leftover } of candidates) {
      const path = pathUnder(secretsFolder, declaration.name) ?? declaration.name;
      let state: TargetState;
      try {
        state = await examineTarget({ site, declaration, path });
      } catch {
        state = { kind: "unmanaged", reason: "could not be read", info: null };
      }
      let holder: LegacyHolder;
      const read = order.includes(path);
      if (state.kind === "absent") holder = { file: declaration.name, read, known: true, values: new Map() };
      else if (state.kind === "managed") holder = { file: declaration.name, read, known: true, values: documentValues(state.managed.document!) };
      else holder = await rawHolder(declaration.name, read);
      files.push({ declaration, read, declared: declared.includes(declaration.name), leftover, state, holder });
    }
    const rank = (file: LegacyFile) => {
      const at = order.indexOf(pathUnder(secretsFolder, file.declaration.name) ?? "");
      return at === -1 ? order.length : at;
    };
    return files.map((file, index) => ({ file, index })).sort((a, b) => rank(a.file) - rank(b.file) || a.index - b.index).map(({ file }) => file);
  }

  /** A legacy file that is not managed, read as systemd would read it when it is a plain file that parses: else unknown. */
  async function rawHolder(name: string, read: boolean): Promise<LegacyHolder> {
    try {
      const examination = await system.examineSecret(name);
      if (examination.kind === "absent") return { file: name, read, known: true, values: new Map() };
      if (examination.bytes === null) return { file: name, read, known: false };
      const parsed = parseEnvBytes(examination.bytes);
      return parsed.ok ? { file: name, read, known: true, values: documentValues(parsed.document) } : { file: name, read, known: false };
    } catch {
      return { file: name, read, known: false };
    }
  }

  function documentValues(document: EnvDocument): Map<string, string> {
    return new Map(keys(document).map((name) => [name, envValue(document, name)!]));
  }

  /**
   * The legacy files whose names a store removal may bring back (S1): every
   * one attached to the project, but a leftover the steward does not manage,
   * which no unit of the project reads and a redeploy could not claim.
   */
  function holdersOf(legacy: readonly LegacyFile[]): LegacyHolder[] {
    return legacy.filter((file) => !file.leftover || file.state.kind === "managed").map((file) => file.holder);
  }

  /** The store's state as store.ts reads it: names, sizes, dates, never a value but for the coverage, computed there and never answered. */
  function storeState(reading: StoreReading): StoreState {
    const env: StoreState["env"] =
      reading.env.kind === "absent"
        ? { kind: "absent" }
        : reading.env.kind === "managed"
          ? { kind: "managed", values: storeValues(reading), modifiedAt: reading.env.info.modifiedAt }
          : { kind: "unmanaged", reason: reading.env.reason, modifiedAt: reading.env.info?.modifiedAt ?? null };
    const files: StoreFileState[] = reading.files.map((file) =>
      file.kind === "managed"
        ? { name: file.name, kind: "managed", size: file.info.size, modifiedAt: file.info.modifiedAt }
        : { name: file.name, kind: "unmanaged", reason: file.reason, modifiedAt: file.info?.modifiedAt ?? null },
    );
    return { exists: reading.exists, refusal: reading.refusal, env, files, previous: reading.previous };
  }

  function legacyStates(legacy: readonly LegacyFile[]): LegacyState[] {
    return legacy.map((file) => ({
      file: file.declaration.name,
      state: file.state.kind,
      reason: file.state.kind === "unmanaged" ? file.state.reason : null,
      values: file.state.kind === "managed" ? documentValues(file.state.managed.document!) : null,
      read: file.read,
      leftover: file.leftover,
    }));
  }

  /**
   * The legacy files retire deleted and kept a copy of, as the listing shows
   * them: absent, where the copy is and how it is put back. One the project
   * still names stays in its place in the list, its reason said; the others
   * follow. Never a holder of anything for S1: nothing reads a copy.
   */
  async function withRetired(project: StoreProject, states: LegacyState[], units: readonly InstalledUnit[]): Promise<LegacyState[]> {
    let retired: string[];
    try {
      retired = await system.listRetired(project.slug);
    } catch (e) {
      console.error(`store: the retired files of ${project.slug} unreadable (${errorName(e)})`);
      return states;
    }
    if (retired.length === 0) return states;
    const read = new Set(units.flatMap((unit) => unitEnvironment(unit.text).files.map((file) => file.path)));
    const listed = states.map((state) => (state.state === "absent" && retired.includes(state.file) ? { ...state, reason: retiredReason(project.slug, state.file) } : state));
    const others = retired
      .filter((name) => !states.some((state) => state.file === name))
      .map((name): LegacyState => ({ file: name, state: "absent", reason: retiredReason(project.slug, name), values: null, read: read.has(pathUnder(secretsFolder, name) ?? ""), leftover: false }));
    return [...listed, ...others];
  }

  /** The store as `actor` may see it (spec §6.11). */
  async function buildStoreView(project: StoreProject, actor: StoreActor, known?: { reading: StoreReading; units: InstalledUnit[]; legacy: LegacyFile[] }): Promise<StoreView> {
    const units = known?.units ?? (await installedUnits(project));
    const reading = known?.reading ?? (await readStore(project.slug));
    const legacy = known?.legacy ?? (await legacyFilesOf(project, units));
    const service = project.site === null || project.manifest === null ? null : await readService(project.site);
    return storeView({
      slug: project.slug,
      manifest: project.manifest,
      store: storeState(reading),
      legacy: await withRetired(project, legacyStates(legacy), units),
      unitReadsStore: unitsReadStore(project, units),
      startedUs: service?.startedUs ?? null,
      may: storeMay({ kind: actor.kind, restore: actor.restores }),
      owner: isOwnerKind(actor),
    });
  }

  /** The journal's line for a store, `store`, or one of its files, `store/<name>`, the name judged first. */
  const STORE_LABEL = "store";
  const storeFileLabel = (name: string) => (isValidFileName(name) ? `${STORE_LABEL}/${name}` : STORE_LABEL);

  /** A refusal of a store's work, journaled under the store: never the name asked for, which may be a value pasted in its place. */
  async function storeRefuse(operation: Operation, slug: unknown, refusal: Refusal, actor: StoreActor, file: string = STORE_LABEL): Promise<Response> {
    await writeLog(operation, "rejects", { slug }, refusal.error, null, actor.who, file);
    return error(refusal.error, refusal.message);
  }

  /** The store's folders laid when missing, or the refusal; journaled `create` when this request made them. */
  async function ensureStoreFor(project: StoreProject, actor: StoreActor, operation: Operation): Promise<{ created: boolean } | Response> {
    const laid = await system.ensureStore(project.slug);
    if (laid.kind === "refused") {
      return storeRefuse(operation, project.slug, { error: "unmanaged", message: `${laid.path} is not a folder root owns: the owner of the machine must look at it; nothing was changed` }, actor);
    }
    if (laid.kind === "created") await writeLog("create", "ok", { slug: project.slug }, null, null, actor.who, STORE_LABEL);
    return { created: laid.kind === "created" };
  }

  /**
   * The env written, its version before kept first: a stop between the two
   * leaves the version that was serving in place, kept as well. A store with
   * no env yet keeps an empty one, so that putting the previous version back
   * returns it to having none of its variables.
   */
  async function writeStoreEnvKeeping(slug: string, before: EnvReading, bytes: Uint8Array): Promise<void> {
    await system.writeStorePrevious(slug, "env", before.kind === "managed" ? before.bytes : new Uint8Array(0));
    await system.writeStoreEnv(slug, bytes);
  }

  type ChangeAnswer = Omit<StoreChangeResponse, "store">;

  async function changeResponse(project: StoreProject, actor: StoreActor, answer: ChangeAnswer, extra: Record<string, unknown> = {}): Promise<Response> {
    const body = { store: await buildStoreView(project, actor), ...answer, ...extra };
    return Response.json(body, { status: answer.created ? 201 : 200 });
  }

  const noChange = (): ChangeAnswer => ({ created: false, set: [], generated: [], removed: [], absent: [], files: { set: [], removed: [] } });

  /**
   * Set and remove variables of a store, all or nothing (rules 1 to 9): the
   * slug, the store's state, every name and value, S1 for every removal and
   * the size of the result judged before the store is created or written.
   * One write, one previous version, one journal line per name.
   */
  async function storeChangeTask(slug: unknown, setting: readonly (readonly [unknown, unknown])[], removing: readonly unknown[], actor: StoreActor): Promise<Response> {
    const operation: Operation = setting.length > 0 ? "set" : "remove";
    const project = await storeProject(slug, actor);
    if (!("slug" in project)) return storeRefuse(operation, slug, project, actor);
    const reading = await readStore(project.slug);
    const state = storeStateRefusal(project.slug, reading);
    if (state !== null) return storeRefuse(operation, project.slug, state, actor);

    const units = await installedUnits(project);
    const setKeys = setting.length > 0 ? storeSetKeys(project, units) : [];
    const pairs: [string, string][] = [];
    for (const [name, value] of setting) {
      const refused = storeNameRefusal("set", name, setKeys) ?? storeValueRefusal(name as string, value);
      if (refused !== null) return storeRefuse("set", project.slug, refused, actor);
      if (pairs.some(([known]) => known === name)) return storeRefuse("set", project.slug, { error: "invalid", message: `set: ${name} is named twice` }, actor);
      pairs.push([name as string, value as string]);
    }
    const names: string[] = [];
    for (const name of removing) {
      const refused = storeNameRefusal("remove", name, null);
      if (refused !== null) return storeRefuse("remove", project.slug, refused, actor);
      if (names.includes(name as string)) return storeRefuse("remove", project.slug, { error: "invalid", message: `remove: ${name as string} is named twice` }, actor);
      if (pairs.some(([known]) => known === name)) return storeRefuse("remove", project.slug, { error: "invalid", message: `${name as string} is both set and removed: name it in one list` }, actor);
      names.push(name as string);
    }

    const values = storeValues(reading);
    if (names.length > 0) {
      const legacy = await legacyFilesOf(project, units);
      const resurrects = removalRefusal(names, values, holdersOf(legacy), isOwnerKind(actor));
      if (resurrects !== null) return storeRefuse("remove", project.slug, resurrects, actor);
    }

    let document: EnvDocument = reading.env.kind === "managed" ? reading.env.document : { lines: [] };
    const removed: string[] = [];
    const absent: string[] = [];
    for (const [name, value] of pairs) document = set(document, name, value);
    for (const name of names) {
      if (envValue(document, name) === null) {
        absent.push(name);
        continue;
      }
      document = remove(document, name);
      removed.push(name);
    }
    const answer: ChangeAnswer = { ...noChange(), set: pairs.map(([name]) => name), removed, absent };
    if (pairs.length === 0 && removed.length === 0) return changeResponse(project, actor, answer);

    const bytes = encoder.encode(serialise(document));
    const tooLarge = envBytesRefusal(bytes);
    if (tooLarge !== null) return storeRefuse(operation, project.slug, tooLarge, actor);

    const laid = await ensureStoreFor(project, actor, operation);
    if (laid instanceof Response) return laid;
    await writeStoreEnvKeeping(project.slug, reading.env, bytes);
    for (const [name] of pairs) await writeLog("set", "ok", { slug: project.slug }, null, name, actor.who, STORE_LABEL);
    for (const name of removed) await writeLog("remove", "ok", { slug: project.slug }, null, name, actor.who, STORE_LABEL);
    return changeResponse(project, actor, { ...answer, created: laid.created });
  }

  /**
   * A value drawn on the machine into the store (spec §6.6). The answer
   * names it, never the value, which no journal line nor log carries either:
   * only the owner may read it back, in the dashboard.
   */
  async function storeGenerateTask(body: Body, actor: StoreActor): Promise<Response> {
    const project = await storeProject(body.slug, actor);
    if (!("slug" in project)) return storeRefuse("generate", body.slug, project, actor);
    if (body.replace !== undefined && typeof body.replace !== "boolean") return storeRefuse("generate", project.slug, { error: "invalid", message: "replace must be a boolean" }, actor);
    const ask = readGenerateAsk(body.format, body.bytes);
    if ("refusal" in ask) return storeRefuse("generate", project.slug, ask.refusal, actor);
    const reading = await readStore(project.slug);
    const state = storeStateRefusal(project.slug, reading);
    if (state !== null) return storeRefuse("generate", project.slug, state, actor);
    const units = await installedUnits(project);
    const named = storeNameRefusal("generate", body.name, storeSetKeys(project, units));
    if (named !== null) return storeRefuse("generate", project.slug, named, actor);
    const name = body.name as string;

    const legacy = await legacyFilesOf(project, units);
    const already = generateRefusal(name, new Set(storeValues(reading).keys()), legacy.map((file) => file.holder), body.replace === true);
    if (already !== null) return storeRefuse("generate", project.slug, already, actor);

    const document = set(reading.env.kind === "managed" ? reading.env.document : { lines: [] }, name, drawValue(random, ask));
    const bytes = encoder.encode(serialise(document));
    const tooLarge = envBytesRefusal(bytes);
    if (tooLarge !== null) return storeRefuse("generate", project.slug, tooLarge, actor);
    const laid = await ensureStoreFor(project, actor, "generate");
    if (laid instanceof Response) return laid;
    await writeStoreEnvKeeping(project.slug, reading.env, bytes);
    await writeLog("generate", "ok", { slug: project.slug }, ask.format, name, actor.who, STORE_LABEL);
    return changeResponse(project, actor, { ...noChange(), created: laid.created, generated: [name] });
  }

  /**
   * A file of the store set whole (rule 8): a valid name, its content base64
   * decoded strictly, 64 KiB at most, and every file of the folder after it
   * within what systemd loads for a unit. A file declared or not: every unit
   * loads the whole folder. Written through a dot-named temporary, which
   * `LoadCredential=` skips.
   */
  async function storeFileTask(body: Body, actor: StoreActor): Promise<Response> {
    const project = await storeProject(body.slug, actor);
    if (!("slug" in project)) return storeRefuse("replace", body.slug, project, actor);
    const named = fileNameRefusal(body.name);
    if (named !== null) return storeRefuse("replace", project.slug, named, actor);
    const name = body.name as string;
    const label = storeFileLabel(name);
    const decoded = decodeFileContent(body.content);
    if ("refusal" in decoded) return storeRefuse("replace", project.slug, decoded.refusal, actor, label);
    const reading = await readStore(project.slug);
    const state = storeStateRefusal(project.slug, reading);
    if (state !== null) return storeRefuse("replace", project.slug, state, actor, label);
    const present = reading.files.find((file) => file.name === name);
    if (present?.kind === "unmanaged") {
      return storeRefuse("replace", project.slug, { error: "unmanaged", message: `${name} in the store is not managed here: ${present.reason}` }, actor, label);
    }
    const after = [
      ...reading.files.filter((file) => file.name !== name && file.info !== null && file.info.regular && !file.info.link).map((file) => ({ name: file.name, size: file.info!.size })),
      { name, size: decoded.bytes.length },
    ];
    const budget = filesRefusal(after);
    if (budget !== null) return storeRefuse("replace", project.slug, budget, actor, label);

    // The version it replaces, read now, kept first.
    const before = present === undefined ? null : await readStoreFileBytes(project.slug, name);
    if (before !== null && "refusal" in before) return storeRefuse("replace", project.slug, before.refusal, actor, label);
    const laid = await ensureStoreFor(project, actor, "replace");
    if (laid instanceof Response) return laid;
    if (before !== null) await system.writeStorePrevious(project.slug, `files/${name}`, before.bytes);
    await system.writeStoreFile(project.slug, name, decoded.bytes);
    await writeLog("replace", "ok", { slug: project.slug }, null, null, actor.who, label);
    return changeResponse(project, actor, { ...noChange(), created: laid.created, files: { set: [name], removed: [] } });
  }

  /** The bytes of a managed file of the store, read for its previous version, or why they cannot be. */
  async function readStoreFileBytes(slug: string, name: string): Promise<{ bytes: Uint8Array } | { refusal: Refusal }> {
    const examined = await system.readStoreFile(slug, name);
    if (examined.kind === "absent") return { refusal: { error: "not-found", message: `${name} is not in the store` } };
    const reason = storeFileReason(examined.info, await rootAccount(), `${storeLocation(slug).files}/${name}`, MAX_STORE_FILE_BYTES) ?? (examined.bytes === null ? "could not be read" : null);
    if (reason !== null) return { refusal: { error: "unmanaged", message: `${name} in the store is not managed here: ${reason}` } };
    return { bytes: examined.bytes! };
  }

  /** A file of the store removed, its last version kept for the owner; the folder never (I3'). */
  async function storeFileRemoveTask(body: Body, actor: StoreActor): Promise<Response> {
    const project = await storeProject(body.slug, actor);
    if (!("slug" in project)) return storeRefuse("remove", body.slug, project, actor);
    const named = fileNameRefusal(body.name);
    if (named !== null) return storeRefuse("remove", project.slug, named, actor);
    const name = body.name as string;
    const label = storeFileLabel(name);
    const reading = await readStore(project.slug);
    const state = storeStateRefusal(project.slug, reading);
    if (state !== null) return storeRefuse("remove", project.slug, state, actor, label);
    const present = reading.files.find((file) => file.name === name);
    if (present === undefined) return storeRefuse("remove", project.slug, { error: "not-found", message: `${name} is not in the store` }, actor, label);
    if (present.kind === "unmanaged") {
      return storeRefuse("remove", project.slug, { error: "unmanaged", message: `${name} in the store is not managed here: ${present.reason}` }, actor, label);
    }
    const before = await readStoreFileBytes(project.slug, name);
    if ("refusal" in before) return storeRefuse("remove", project.slug, before.refusal, actor, label);
    await system.writeStorePrevious(project.slug, `files/${name}`, before.bytes);
    await system.removeStoreFile(project.slug, name);
    await writeLog("remove", "ok", { slug: project.slug }, null, null, actor.who, label);
    return changeResponse(project, actor, { ...noChange(), files: { set: [], removed: [name] } });
  }

  /**
   * The store's env swapped with its previous version (spec §6.10): twice
   * comes back to the start. `dryRun` says which names would appear and
   * disappear, for the confirmation. Refused when either version does not
   * parse or carries a password hash, or by S1'.
   */
  async function storeRestoreTask(body: Body, actor: StoreActor): Promise<Response> {
    const project = await storeProject(body.slug, actor);
    if (!("slug" in project)) return storeRefuse("restore", body.slug, project, actor);
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") return storeRefuse("restore", project.slug, { error: "invalid", message: "dryRun must be a boolean" }, actor);
    const reading = await readStore(project.slug);
    const state = storeStateRefusal(project.slug, reading);
    if (state !== null) return storeRefuse("restore", project.slug, state, actor);
    if (!reading.exists) return storeRefuse("restore", project.slug, { error: "not-found", message: `${project.slug} has no store` }, actor);

    const kept = await system.readStorePrevious(project.slug, "env");
    if (kept.kind === "absent") return storeRefuse("restore", project.slug, { error: "not-found", message: "no previous version of the store's env" }, actor);
    const real = await rootAccount();
    const keptReason = real === null ? "account root does not exist" : kept.info.link || !kept.info.regular || kept.info.links > 1 ? "the previous version is not a plain file" : kept.bytes === null ? "the previous version could not be read" : null;
    const parsed = kept.bytes === null ? null : parseEnvBytes(kept.bytes);
    if (keptReason !== null || parsed === null || !parsed.ok) {
      return storeRefuse("restore", project.slug, { error: "unmanaged", message: keptReason ?? "the previous version of the store's env is not in a form managed here" }, actor);
    }
    const current = storeValues(reading);
    const previous = documentValues(parsed.document);
    if (current.has(PASSWORD_VARIABLE) || previous.has(PASSWORD_VARIABLE)) {
      return storeRefuse("restore", project.slug, { error: "out-of-scope", message: "a password is only changed with Change password" }, actor);
    }
    const units = await installedUnits(project);
    const legacy = await legacyFilesOf(project, units);
    const resurrects = restoreRemovalRefusal(current, previous, holdersOf(legacy), isOwnerKind(actor));
    if (resurrects !== null) return storeRefuse("restore", project.slug, resurrects, actor);

    const appeared = [...previous.keys()].filter((name) => !current.has(name));
    const disappeared = [...current.keys()].filter((name) => !previous.has(name));
    if (body.dryRun === true) {
      return changeResponse(project, actor, noChange(), { appeared, disappeared, restored: false } satisfies Omit<StoreRestoreResponse, keyof StoreChangeResponse>);
    }
    const tooLarge = envBytesRefusal(kept.bytes!);
    if (tooLarge !== null) return storeRefuse("restore", project.slug, tooLarge, actor);
    await writeStoreEnvKeeping(project.slug, reading.env, kept.bytes!);
    await writeLog("restore", "ok", { slug: project.slug }, null, null, actor.who, STORE_LABEL);
    return changeResponse(project, actor, noChange(), { appeared, disappeared, restored: true });
  }

  /**
   * A store value read back (spec §6.7): the owner's, in the dashboard, under
   * the live unlock alone. Journaled `read` with its name.
   */
  async function storeRevealTask(body: Body): Promise<Response> {
    const actor = OWNER_STORE;
    const project = await storeProject(body.slug, actor);
    if (!("slug" in project)) return storeRefuse("read", body.slug, project, actor);
    const named = storeNameRefusal("name", body.name, null);
    if (named !== null) return storeRefuse("read", project.slug, named, actor);
    const name = body.name as string;
    const reading = await readStore(project.slug);
    const state = storeStateRefusal(project.slug, reading);
    if (state !== null) return storeRefuse("read", project.slug, state, actor);
    const value = reading.env.kind === "managed" ? envValue(reading.env.document, name) : null;
    if (value === null) return storeRefuse("read", project.slug, { error: "not-found", message: `no such variable in the store of ${project.slug}` }, actor);
    await writeLog("read", "ok", { slug: project.slug }, null, name, actor.who, STORE_LABEL);
    const answer: StoreRevealResponse = { value };
    return Response.json(answer);
  }

  /** A deployed app with a manifest that names it: what migrate and retire work on. */
  function deployedApp(project: StoreProject): Refusal | null {
    if (project.site === null || project.manifest === null) {
      return { error: "out-of-scope", message: `${project.slug} is not an app deployed with its sitesolide.json on this machine: deploy it first` };
    }
    return null;
  }

  /**
   * The order in effect of a project's legacy files: those no installed unit
   * reads first, in the manifest's order, then those the units read, in the
   * order they read them, the later winning as systemd reads them.
   * `orderAgreed` false: two units read them in different orders, and no
   * single value is in effect for every service of a name they disagree on.
   */
  function inEffectOrder(files: readonly LegacyFile[], units: readonly InstalledUnit[], declared: readonly string[]): { legacy: LegacyFile[]; orderAgreed: boolean } {
    const pathOf = (file: LegacyFile) => pathUnder(secretsFolder, file.declaration.name) ?? file.declaration.name;
    const paths = new Set(files.map(pathOf));
    const orders = units.map((unit) => [...new Set(unitEnvironment(unit.text).files.map((file) => file.path).filter((path) => paths.has(path)))]);
    const first = orders[0] ?? [];
    const orderAgreed = orders.every((order) => order.length === first.length && order.every((path, index) => path === first[index]));
    const read = first.map((path) => files.find((file) => pathOf(file) === path)!);
    const rank = (file: LegacyFile) => {
      const at = declared.indexOf(file.declaration.name);
      return at === -1 ? declared.length : at;
    };
    const unread = files.filter((file) => !first.includes(pathOf(file))).sort((a, b) => rank(a) - rank(b));
    return { legacy: [...unread, ...read], orderAgreed };
  }

  /**
   * A project's legacy files merged into its store, owner only, without
   * anyone seeing a value (spec §6.8): idempotent, never restarting, the
   * legacy files untouched. A conflict, two files giving one name two
   * values, refuses the whole migration, naming the name and the files.
   */
  async function storeMigrateTask(body: Body, actor: StoreActor): Promise<Response> {
    const project = await storeProject(body.slug, actor);
    if (!("slug" in project)) return storeRefuse("migrate", body.slug, project, actor);
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") return storeRefuse("migrate", project.slug, { error: "invalid", message: "dryRun must be a boolean" }, actor);
    const deployed = deployedApp(project);
    if (deployed !== null) return storeRefuse("migrate", project.slug, deployed, actor);
    const units = await installedUnits(project);
    if (unitsReadStore(project, units) !== true) {
      return storeRefuse("migrate", project.slug, { error: "out-of-scope", message: `deploy or refresh ${project.slug} first, so that its units read the store: sitesolide refresh ${project.slug}` }, actor);
    }
    const reading = await readStore(project.slug);
    const state = storeStateRefusal(project.slug, reading);
    if (state !== null) return storeRefuse("migrate", project.slug, state, actor);

    // The sources: the legacy files the deployed manifest declares or a unit
    // reads, in the order in effect. A leftover is read by no unit: merging
    // it would add variables the service does not have today.
    const declared = legacySecretFiles(project.manifest!);
    const attached = await legacyFilesOf(project, units);
    const { legacy, orderAgreed } = inEffectOrder(
      attached.filter((file) => !file.leftover && (file.read || declared.includes(file.declaration.name))),
      units,
      declared,
    );
    const sources: MigrationSource[] = legacy.map((file) =>
      file.state.kind === "absent"
        ? { file: file.declaration.name, state: "absent" }
        : file.state.kind === "unmanaged"
          ? { file: file.declaration.name, state: "unmanaged", reason: file.state.reason }
          : { file: file.declaration.name, state: "managed", assignments: [...documentValues(file.state.managed.document!)] },
    );
    const setKeys = storeSetKeys(project, units);
    const plan = planMigration({ sources, store: storeValues(reading), keyRefusal: (name) => checkKey(name, setKeys), orderAgreed });
    if (plan.kind === "refused") return storeRefuse("migrate", project.slug, plan.refusal, actor);

    const outcome = (written: boolean, store: StoreView): StoreMigrateAnswer => ({
      store,
      sources: plan.sources,
      skipped: plan.skipped,
      merged: plan.merged,
      already: plan.already,
      overridden: plan.overridden,
      shadowed: plan.shadowed,
      conflicts: plan.conflicts,
      written,
    });
    if (plan.conflicts.length > 0 && body.dryRun !== true) {
      await writeLog("migrate", "rejects", { slug: project.slug }, "conflicts", null, actor.who, STORE_LABEL);
      const message = `${plan.conflicts.map((conflict) => `${conflict.name}: in ${conflict.files.join(" and ")}, with different values, which the units of ${project.slug} read in different orders`).join("; ")}. sitesolide refresh ${project.slug}, then migrate again; nothing was written`;
      const answer = { error: "unmanaged", message, ...outcome(false, await buildStoreView(project, actor, { reading, units, legacy: attached })) };
      return Response.json(answer, { status: 409 });
    }
    if (body.dryRun === true || plan.writes.length === 0) {
      return Response.json(outcome(false, await buildStoreView(project, actor)));
    }

    let document: EnvDocument = reading.env.kind === "managed" ? reading.env.document : { lines: [] };
    for (const [name, value] of plan.writes) document = set(document, name, value);
    const bytes = encoder.encode(serialise(document));
    const tooLarge = envBytesRefusal(bytes);
    if (tooLarge !== null) return storeRefuse("migrate", project.slug, tooLarge, actor);
    const laid = await ensureStoreFor(project, actor, "migrate");
    if (laid instanceof Response) return laid;
    await writeStoreEnvKeeping(project.slug, reading.env, bytes);
    const shadowedDetail = plan.shadowed.length === 0 ? "" : `; ${plan.shadowed.length} taken from the file in effect over another value`;
    await writeLog("migrate", "ok", { slug: project.slug }, bounded(`${plan.writes.length} merged from ${plan.sources.join(", ")}${shadowedDetail}`), null, actor.who, STORE_LABEL);
    return Response.json(outcome(true, await buildStoreView(project, actor)));
  }

  /** The most files a retire names at once. */
  const MAX_RETIRED = 64;

  /**
   * Legacy files deleted once the store makes them useless, owner only (spec
   * §6.9): each one judged alone, by retireDecision, kept as its previous
   * version with its owner, then unlinked. One failing a rule stays, with
   * its reason.
   */
  async function storeRetireTask(body: Body, actor: StoreActor): Promise<Response> {
    const project = await storeProject(body.slug, actor);
    if (!("slug" in project)) return storeRefuse("retire", body.slug, project, actor);
    if (body.force !== undefined && typeof body.force !== "boolean") return storeRefuse("retire", project.slug, { error: "invalid", message: "force must be a boolean" }, actor);
    const force = body.force === true;
    const asked = body.files;
    if (!Array.isArray(asked) || asked.length === 0 || asked.length > MAX_RETIRED) {
      return storeRefuse("retire", project.slug, { error: "invalid", message: `files: a list of 1 to ${MAX_RETIRED} legacy file names` }, actor);
    }
    for (const [index, name] of asked.entries()) {
      if (nameRefusal(name) !== null) return storeRefuse("retire", project.slug, { error: "invalid", message: `files: entry ${index + 1} is not a legacy file's name` }, actor);
      if (asked.indexOf(name) !== index) return storeRefuse("retire", project.slug, { error: "invalid", message: `files: ${name as string} is named twice` }, actor);
    }
    const deployed = deployedApp(project);
    if (deployed !== null) return storeRefuse("retire", project.slug, deployed, actor);
    const reading = await readStore(project.slug);
    const state = storeStateRefusal(project.slug, reading);
    if (state !== null) return storeRefuse("retire", project.slug, state, actor);

    const site = project.site!;
    const units = await installedUnits(project);
    const readsStore = unitsReadStore(project, units) === true;
    const legacy = await legacyFilesOf(project, units);
    const service = await readService(site);
    const allScheduled = isAnchored(project.manifest!);
    const envModifiedMs = reading.env.kind === "managed" ? reading.env.info.modifiedAt : null;
    const values = reading.env.kind === "managed" ? storeValues(reading) : reading.env.kind === "absent" ? new Map<string, string>() : null;

    const retired: string[] = [];
    const forced: string[] = [];
    const kept: { file: string; reason: string }[] = [];
    for (const name of asked as string[]) {
      const attached = [...site.files, ...site.leftovers].find((declaration) => declaration.name === name);
      const file = legacy.find((one) => one.declaration.name === name);
      let fileState: TargetState = file?.state ?? { kind: "absent" };
      if (file === undefined && attached !== undefined) {
        try {
          fileState = await examineTarget({ site, declaration: attached, path: pathUnder(secretsFolder, name) ?? name });
        } catch {
          fileState = { kind: "unmanaged", reason: "could not be read", info: null };
        }
      }
      const decision = retireDecision({
        file: name,
        attached: attached !== undefined,
        flat: subFolderOf(name) === null,
        variables: kindOf(name) === "variables",
        machine: ROOT_FILES.includes(name) || HASH_ONLY.includes(name),
        state:
          fileState.kind === "managed" && fileState.managed.document !== null
            ? { kind: "managed", assignments: [...documentValues(fileState.managed.document)] }
            : fileState.kind === "managed"
              ? { kind: "unmanaged", reason: "not an environment file" }
              : fileState.kind === "unmanaged"
                ? { kind: "unmanaged", reason: fileState.reason }
                : { kind: "absent" },
        read: file?.read ?? false,
        force,
        store: values,
        unitsReadStore: readsStore,
        allScheduled,
        main: { active: service.view?.state === "active", startedUs: service.startedUs },
        envModifiedMs,
        slug: project.slug,
      });
      if (!decision.retire) {
        kept.push({ file: name, reason: decision.reason });
        continue;
      }
      const managed = (fileState as Extract<TargetState, { kind: "managed" }>).managed;
      // Kept first, under the project's own previous versions, its owner with
      // it: `sitesolide remove` deletes that folder whole, and the owner puts
      // the file back by hand with the command the listing gives
      // (retiredReason). Not in precedents/<name>, which nothing deletes
      // with a project whose manifest no longer names the file. The version
      // the dashboard kept there of it goes too, for the same reason.
      await system.writeStorePrevious(project.slug, `legacy/${name}`, managed.bytes, checked ? managed.real : null);
      await system.removePrevious(name);
      await system.removeLegacy(name);
      await writeLog("retire", "ok", { slug: project.slug }, decision.forced ? "forced: the store's values stand" : null, null, actor.who, name);
      retired.push(name);
      if (decision.forced) forced.push(name);
    }
    const answer: StoreRetireAnswer = { store: await buildStoreView(project, actor), retired, forced, kept };
    return Response.json(answer);
  }

  /** The store's listing, for any surface; a token's refusal journaled as its listing's. */
  async function storeListTask(slug: unknown, actor: StoreActor): Promise<Response> {
    const project = await storeProject(slug, actor);
    if (!("slug" in project)) {
      if (actor.kind === "token") await writeLog("list", "rejects", { slug }, project.error, null, actor.who, STORE_LABEL);
      return error(project.error, project.message);
    }
    const answer: StoreListResponse = { store: await buildStoreView(project, actor) };
    return Response.json(answer);
  }

  // --- The store's routes ------------------------------------------------------

  /** A body's set, as pairs, never assigned into an object (`__proto__` is a variable name). */
  function storeChange(body: Body): { set: [string, unknown][]; remove: unknown[] } | Refusal {
    const read = readSecretsChange(body.set, body.remove);
    if ("refusal" in read) return { error: "invalid", message: read.refusal };
    return { set: read.set, remove: read.remove };
  }

  /** The operations of a store, each with its body already read: the routes below take the lock around them. */
  const storeTasks = {
    set: (body: Body, actor: StoreActor) =>
      typeof body.value !== "string"
        ? storeRefuse("set", body.slug, { error: "invalid", message: "value must be a string" }, actor)
        : storeChangeTask(body.slug, [[body.name as string, body.value]], [], actor),
    remove: (body: Body, actor: StoreActor) => {
      if (!Array.isArray(body.names) || body.names.length === 0) return storeRefuse("remove", body.slug, { error: "invalid", message: "names: a list of variable names" }, actor);
      const read = storeChange({ remove: body.names });
      return "error" in read ? storeRefuse("remove", body.slug, read, actor) : storeChangeTask(body.slug, [], read.remove, actor);
    },
    change: (body: Body, actor: StoreActor) => {
      const read = storeChange(body);
      return "error" in read ? storeRefuse("set", body.slug, read, actor) : storeChangeTask(body.slug, read.set, read.remove, actor);
    },
    generate: storeGenerateTask,
    setFile: storeFileTask,
    removeFile: storeFileRemoveTask,
    restore: storeRestoreTask,
    migrate: storeMigrateTask,
    retire: storeRetireTask,
  };

  type StoreTask = (body: Body, actor: StoreActor) => Promise<Response>;

  /** A store's route on the dashboard's socket: the owner's live unlock, checked again under the lock. */
  function ownerStoreRoute(texts: string[], others: string[], task: StoreTask, max = MAX_BODY_BYTES): (req: Request) => Promise<Response> {
    return async (req) => {
      const body = await bodyWithToken(req, texts, others, max);
      if (body instanceof Response) return body;
      const { token: _token, ...fields } = body;
      return underLock(req, body, () => task(fields, OWNER_STORE));
    };
  }

  /** The same on the owner's socket, which only root opens: no unlock, root has asked. */
  function sshStoreRoute(texts: string[], others: string[], task: StoreTask, max = MAX_BODY_BYTES): (req: Request) => Promise<Response> {
    return async (req) => {
      const body = await readBody(req, [...texts, ...others], max);
      if (body instanceof Response) return body;
      for (const field of texts) if (typeof body[field] !== "string") return error("invalid", `${field} must be a string`);
      return underLockWith(req, async () => null, () => task(body, SSH_STORE));
    };
  }

  /** `GET /store?slug=<slug>`: the listing, which reads no value and takes no lock. */
  function storeListRoute(actor: StoreActor): (req: Request) => Promise<Response> {
    return async (req) => {
      const wanted = new URL(req.url).searchParams.getAll("slug");
      if (wanted.length !== 1) return error("invalid", "name one project: ?slug=<slug>");
      return storeListTask(wanted[0], actor);
    };
  }

  /** The store's routes, for the owner's unlocked dashboard or for root over SSH. */
  function storeRoutes(ssh: boolean): Record<string, Record<string, (req: Request) => Promise<Response>>> {
    const route = ssh ? sshStoreRoute : ownerStoreRoute;
    return {
      "/store": { GET: storeListRoute(ssh ? SSH_STORE : OWNER_STORE), PATCH: route(["slug"], ["set", "remove"], storeTasks.change, MAX_CONTENT_BODY_BYTES) },
      "/store/variable": { PUT: route(["slug", "name", "value"], [], storeTasks.set), DELETE: route(["slug"], ["names"], storeTasks.remove) },
      "/store/generate": { POST: route(["slug", "name"], ["format", "bytes", "replace"], storeTasks.generate) },
      "/store/file": { PUT: route(["slug", "name", "content"], [], storeTasks.setFile, MAX_CONTENT_BODY_BYTES), DELETE: route(["slug", "name"], [], storeTasks.removeFile) },
      "/store/restore": { POST: route(["slug"], ["dryRun"], storeTasks.restore) },
      "/store/migrate": { POST: route(["slug"], ["dryRun"], storeTasks.migrate) },
      "/store/retire": { POST: route(["slug"], ["files", "force"], storeTasks.retire) },
      // A value read back: the owner's unlocked dashboard alone, never over SSH.
      ...(ssh ? {} : { "/store/value": { POST: ownerStoreRoute(["slug", "name"], [], (body) => storeRevealTask(body)) } }),
    };
  }

  /**
   * `GET /store/leftovers?slug=<slug>` on the owner's socket: the flat files a
   * store-form project left under /etc/sitesolide, for `sitesolide remove`,
   * which deletes them with the project once it has judged them its own
   * (removableSecrets in bin/cli/removal.ts). Read while the project is
   * still deployed: once its folder is gone, its leftovers are nobody's.
   * The machine's own files never are one; a subfolder's never is either.
   */
  async function ownerLeftovers(req: Request): Promise<Response> {
    const wanted = new URL(req.url).searchParams.getAll("slug");
    if (wanted.length !== 1 || !isValidSlug(wanted[0]!)) return error("invalid", "name one project: ?slug=<slug>");
    const slug = wanted[0]!;
    const site = (await sites()).get(slug);
    const leftovers = (site?.leftovers ?? [])
      .map((declaration) => declaration.name)
      .filter((name) => subFolderOf(name) === null && !ROOT_FILES.includes(name) && !HASH_ONLY.includes(name));
    const answer: StoreLeftoversResponse = { slug, leftovers };
    return Response.json(answer);
  }

  /** `POST /restart { slug }` on the owner's socket: the restart a person's is, with root as who and no refusal for want of a managed file. */
  async function ownerRestart(req: Request): Promise<Response> {
    const body = await readBody(req, ["slug"]);
    if (body instanceof Response) return body;
    if (typeof body.slug !== "string") return error("invalid", "slug must be a string");
    return restartFor(req, body.slug, OWNER, async () => null);
  }

  /** A person's store work, the role judged by src/people/actions.ts, under the lock it takes. */
  const personStore = (task: StoreTask) => (_req: Request, body: Body, who: Who) => task(body, { who, kind: "person", creating: false, restores: who.restores === true });

  /** A token's store work, the token judged by the control routes, its turn under the lock. */
  const storeForToken: StoreForToken = {
    list: (slug, who, creating) => storeListTask(slug, { who, kind: "token", creating, restores: false }),
    change: (req, change, who, creating, still) =>
      underLockWith(req, still, () => storeChangeTask(change.slug, change.set, change.remove, { who, kind: "token", creating, restores: false })),
    generate: (req, request, who, creating, still) => underLockWith(req, still, () => storeGenerateTask({ ...request }, { who, kind: "token", creating, restores: false })),
    setFile: (req, request, who, creating, still) => underLockWith(req, still, () => storeFileTask({ ...request }, { who, kind: "token", creating, restores: false })),
    removeFile: (req, request, who, still) => underLockWith(req, still, () => storeFileRemoveTask({ ...request }, { who, kind: "token", creating: false, restores: false })),
  };

  // --- Access and the people who sign in -----------------------------------------

  // The registry is the access store's (src/access/steward.ts); the people's
  // sessions, keys and unlocks are the members routes' (src/people/steward.ts),
  // which read their roles from it at every request.
  const journalEvent = (event: { operation: Operation; result: "ok" | "rejects"; actor: string; member: string | null; slug?: string; detail: string | null }) =>
    writeLog(event.operation, event.result, event.slug === undefined ? null : { slug: event.slug }, bounded(event.detail), null, { actor: event.actor, member: event.member });

  const accessStore: AccessStore | null =
    options.members === undefined
      ? null
      : createAccessStore({
          system: options.members.access,
          zone: memberZone,
          hostOf: (slug) => (reservedReason(slug, memberZone) === null ? addressOf(slug, memberZone) : null),
          journal: journalEvent,
          logFull: async (share, reserve) => {
            await accessLogPrepared;
            try {
              return await system.accessLogFull(system.now(), share, reserve);
            } catch (e) {
              // A log that cannot be counted takes nothing more.
              console.error(`access log: not counted (${errorName(e)}), changes of access refused`);
              return true;
            }
          },
        });

  const members =
    options.members === undefined || accessStore === null
      ? null
      : createMemberRoutes({
          system: options.members.system,
          access: accessStore,
          zone: options.members.zone,
          readBody: (req, fields) => readBody(req, fields),
          journal: journalEvent,
          restart: memberRestart,
          revokeTokens: options.members.revokeTokens,
          random: options.random,
        });

  /** A project's general access as the machine carries it: the preview lock, the portal, or neither, and what may change. */
  async function generalOf(slug: string): Promise<GeneralView | null> {
    const found = checkSite(await sites(), slug);
    if ("refusal" in found) return null;
    return (await generalState(found.site)).view;
  }

  const access: AccessRoutes | null =
    members === null || accessStore === null || options.members === undefined
      ? null
      : createAccessRoutes({
          store: accessStore,
          zone: memberZone,
          hostOf: (slug) => addressOf(slug, memberZone),
          projectExists: options.members.system.projectExists,
          signIn: () => options.members!.system.readPortalSettings(),
          general: generalOf,
          portalReading: () => portalReading(options.members?.portal ?? null),
          isUnlocked: (token) => isValidToken(state, token, system.now()),
          readBody: (req, fields) => readBody(req, fields),
          journal: journalEvent,
          // A token's refusal goes to the journal as it stands: the control
          // routes bound it per token and per hour before asking
          // (src/control/steward.ts, `accessChange`). Through the people's
          // bound per minute, shared with everyone, twenty of a token's kept
          // every other refusal of that minute out, a failed sign-in included.
          journalRefusal: (event) => (/^token:[0-9a-f]{12}$/.test(event.actor) ? journalEvent(event) : members.journalRefusal(event)),
          authorize: members.authorize,
          leave: members.leave,
          ...(options.members.tokensOf === undefined ? {} : { tokensOf: options.members.tokensOf }),
        });

  // --- Backups -----------------------------------------------------------------

  // Their rules live in src/backup/routes.ts; the token, the body, the lock and
  // the scope of the sites are this steward's own, handed over.
  const backups = createBackupRoutes({
    reader: options.backups ?? null,
    sites,
    bodyWithToken: (req, texts, others) => bodyWithToken(req, texts, others),
    underLock,
    systemctl: (args, timeoutMs) => system.systemctl(args, timeoutMs),
    fail: error,
    now: system.now,
    uidRoot: checked ? uidRoot : null,
  });

  // --- A person's work on their projects ------------------------------------------

  // The operations above, with the person as requester: their role judged by
  // src/people/actions.ts, their session, unlock and role asked again under
  // the lock, the machine's own projects and files refused by `target`.
  const memberActions =
    members === null
      ? {}
      : createMemberActions({
          members,
          readBody: (req, fields, max) => readBody(req, fields, max),
          underLock: underLockWith,
          ops: {
            projects: memberProjects,
            readValue: readValueTask,
            setVariable: setVariableTask,
            removeVariable: removeVariableTask,
            createFile: createFileTask,
            restoreFile: restoreTask,
            readContent: readContentTask,
            replaceContent: replaceContentTask,
            portal: portalTask,
            general: (req, body, who) => generalTask(req, body, who),
            storeSet: personStore(storeTasks.set),
            storeRemove: personStore(storeTasks.remove),
            storeGenerate: personStore(storeTasks.generate),
            storeSetFile: personStore(storeTasks.setFile),
            storeRemoveFile: personStore(storeTasks.removeFile),
            storeRestore: personStore(storeTasks.restore),
          },
          startRestore: backups.start,
          zone: memberZone,
          maxContentBytes: MAX_CONTENT_BODY_BYTES,
        });

  // --- A token's secrets and restart ------------------------------------------------

  // The token, its role and its flag are judged by src/control/steward.ts;
  // these are the operations above with the token as `who`, held to a
  // person's bounds (`restricted`). Its refusals are bounded per token there,
  // charged before they come here: through the people's bound per minute,
  // shared with everyone, a token refused twenty times a minute kept every
  // other refusal of that minute, a lowered person's included, out of the
  // journal, and spent nothing of its own hour.

  /**
   * Is this project restricted on the machine, as its general access reads:
   * the portal asked for by its manifest and its protected block in service.
   * A manifest asking for it alone leaves the site in the open.
   */
  async function restrictedForToken(slug: string): Promise<boolean> {
    const found = checkSite(await sites(), slug);
    if ("refusal" in found) return false;
    const portal = await portalView(found.site, null);
    return portal.requested && portal.installed;
  }

  // A token's restart waits for the restarts of the same project alone, never
  // under `exclusive`: a unit ignoring SIGTERM held it some 43 seconds a
  // restart, `reset-failed`, `restart` and the observation, and thirty
  // restarts an hour by a token then queued everyone's writes, door changes
  // and restores, past four of them refused `busy`. A write needs nothing of
  // a restart: the file is replaced whole by a rename, so the service starts
  // with the version before or the version after. A person's restart keeps
  // its place under the lock, as the Secrets section's.
  const tokenRestartTurns = new Map<string, <T>(task: () => Promise<T>) => Promise<T> | null>();
  function tokenRestartTurn(slug: string): <T>(task: () => Promise<T>) => Promise<T> | null {
    let turn = tokenRestartTurns.get(slug);
    if (turn === undefined) {
      turn = createLock(options.maxQueued ?? MAX_QUEUED);
      tokenRestartTurns.set(slug, turn);
    }
    return turn;
  }

  const secretsForToken: SecretsForToken = {
    list: (slug, who) => tokenProject(slug, who),
    change: (req, change, who, still) => underLockWith(req, still, () => changeVariablesTask(change, who)),
    restart: (req, slug, who, still) => restartFor(req, slug, who, still, tokenRestartTurn(slug)),
    refuse: (event) => journalEvent(event),
    restricted: restrictedForToken,
  };

  // --- Routing -----------------------------------------------------------------

  // The connectors of the egress proxy, written under the same unlock and the
  // same lock as a secret: see src/connectors/steward.ts. Without a store, the
  // routes do not exist, as on a steward that predates them.
  const connectorRoutes =
    options.connectors === undefined
      ? {}
      : createConnectorRoutes(options.connectors, { bodyWithToken, underLock, sites, now: () => system.now() });

  const routes: Record<string, Record<string, (req: Request) => Promise<Response>>> = {
    ...storeRoutes(false),
    ...connectorRoutes,
    ...(members?.dashboard ?? {}),
    ...(access?.dashboard ?? {}),
    ...memberActions,
    "/projects": { GET: listProjects },
    "/log": { GET: readLog },
    "/unlock": { POST: unlock },
    "/lock": { POST: lock },
    "/value": { POST: readValue },
    "/variable": { PUT: setVariable, DELETE: removeVariable },
    "/file": { POST: createFile },
    "/restore": { POST: restore },
    "/content": { POST: readFileContent, PUT: replaceContent },
    "/password": { POST: changePassword },
    "/portal": { POST: togglePortal },
    "/general": { POST: setGeneral },
    "/restart": { POST: restart },
    "/backups": { GET: backups.list },
    "/backups/restore": { POST: backups.restore },
    "/backups/audit": { GET: backups.audit },
  };

  let inFlight = 0;

  /**
   * A person's routes under the names they had before `/people/`: a
   * dashboard deployed before this steward still calls them. Kept one
   * release.
   */
  const current = (path: string): string => (path.startsWith("/members/") ? `/people/${path.slice("/members/".length)}` : path);

  /** One socket's routes, behind the same bound on requests in flight and the same catch. */
  const serve = (table: Record<string, Record<string, (req: Request) => Promise<Response>>>): Handler => async (req) => {
    if (inFlight >= maxInFlight) return busy();
    inFlight++;
    try {
      const path = current(new URL(req.url).pathname);
      const route = Object.hasOwn(table, path) ? table[path] : undefined;
      if (route === undefined) return error("not-found", "no such route");

      const handler = Object.hasOwn(route, req.method) ? route[req.method] : undefined;
      if (handler === undefined) {
        const body: Failure = { error: "invalid", message: "method not allowed" };
        return Response.json(body, { status: 405, headers: { Allow: Object.keys(route).join(", ") } });
      }
      return await handler(req);
    } catch (e) {
      // The name of the error only: the message of a system error quotes a
      // path, and that of another could quote worse.
      console.error(`steward: unexpected error (${errorName(e)})`);
      return error("failure", GENERIC_MESSAGE);
    } finally {
      inFlight--;
    }
  };

  const handle = serve(routes);
  return Object.assign(handle, {
    isUnlocked: (token: unknown) => isValidToken(state, token, system.now()),
    owner: serve({
      ...(access?.owner ?? {}),
      ...storeRoutes(true),
      "/store/leftovers": { GET: ownerLeftovers },
      "/general": { POST: ownerGeneral },
      "/restart": { POST: ownerRestart },
    }),
    ensureMemberKeys: async () => (members === null ? null : members.ensureKeys()),
    startAccess: async () => accessStore?.start(),
    forgetProjectAccess: access?.forgetProject ?? null,
    memberAuthority:
      members === null
        ? null
        : {
            authorize: members.authorize,
            unlockedUntil: members.unlockedUntil,
            rights: members.rights,
            rightless: members.rightless,
            recordCreation: members.recordCreation,
            journal: members.journal,
            journalRefusal: members.journalRefusal,
          },
    accessForToken: access?.forToken ?? null,
    secretsForToken,
    storeForToken,
  });
}

/** A journal's detail, one line within its bound: a list of roles grows with the projects. */
function bounded(detail: string | null): string | null {
  if (detail === null) return null;
  const flat = detail.replace(/[\n\r\0]/g, " ");
  return flat.length <= MAX_FIELD ? flat : `${flat.slice(0, MAX_FIELD - 1)}…`;
}

function errorName(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return e instanceof Error ? e.name : "unknown";
}
