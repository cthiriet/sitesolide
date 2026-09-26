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
import { isProtected } from "../../borrowed/manifest";
import { fragmentIsProtected } from "../../borrowed/portal";
import { isPasswordValid, isAcceptableSubmission } from "../auth";
import { unitOf } from "../state";
import { generatePassword } from "../password";
import { portalModifiable, DASHBOARD_SLUG } from "../gatekeeper/rules";
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
import { latest, RETURNED_ENTRIES, encodeEntry, reread } from "./log";
import {
  MAX_FILE_BYTES,
  expectedText,
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
  type Declaration,
  type FileInfo,
  type Owner,
  type Refusal,
  type Site,
} from "./scope";
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
  ValueResponse,
  ServiceView,
  Verdict,
} from "./protocol";
import { RESTART_TIMEOUT_MS, MAX_PORTAL_MS } from "./protocol";
import { showArguments, readShow, restartPending, serviceView, verdict, type ServiceReading } from "./restart";
import type { Command, Permissions, Examination, System } from "./system";

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
};

export type Handler = (req: Request) => Promise<Response>;

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
 * 42 to 111 MiB and a burst of `GET /projects` 300 MiB, under a MemoryMax of
 * 128M.
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
  const body: Failure = { error: "failure", message: "the steward is busy, try again in a moment" };
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

/** What the log can carry of a request: a well-formed name, never the raw text of a field. */
function safeName(value: unknown, shape: RegExp, max: number): string | null {
  return typeof value === "string" && value.length <= max && shape.test(value) ? value : null;
}

const SLUG_SHAPE = /^[a-z0-9.-]+$/;

type Target = { site: Site; declaration: Declaration; path: string };

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

export function createSteward(system: System, options: StewardOptions): Handler {
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
  // queue: two at once get the service killed at 128M
  // (the bench results, m2), and a burst would otherwise go
  // through in its entirety before the first failure is counted.
  const exclusive = createLock(options.maxQueued ?? MAX_QUEUED);
  const oneAtATime = createLock(options.maxQueued ?? MAX_QUEUED);
  const showLimit = createLimit(options.maxParallelShow ?? MAX_PARALLEL_SHOW);
  const cacheShow = new Map<string, { at: number; response: Promise<Command | null> }>();

  // --- Log -------------------------------------------------------------------

  /**
   * The log never makes an operation fail: it keeps quiet and says so.
   * `variable` is passed separately and not read from the body: on a refusal, a
   * token pasted in the place of a name never enters it.
   */
  async function writeLog(
    operation: Operation,
    result: LogEntry["result"],
    body: Body | null,
    detail: string | null,
    variable: string | null = null,
  ): Promise<void> {
    const entry: LogEntry = {
      a: system.now(),
      operation,
      result,
      slug: safeName(body?.slug, SLUG_SHAPE, 63),
      // The shape of an accepted file name, climbing paths and hidden names excluded.
      file: nameRefusal(body?.file) === null ? (body!.file as string) : null,
      variable,
      detail,
    };
    try {
      await system.appendLog(encodeEntry(entry));
    } catch (e) {
      console.error(`log: cannot write (${errorName(e)})`);
    }
  }

  /** `variable`: only a name already present in the file, or declared as a password. */
  async function refuse(operation: Operation, body: Body, refusal: Refusal, variable: string | null = null): Promise<Response> {
    await writeLog(operation, "rejects", body, refusal.error, variable);
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
    const taken = exclusive(async () => {
      if (req.signal.aborted) return abandoned();
      if (!(await isValidToken(state, body.token, system.now()))) {
        return error("locked", "locked, unlock again");
      }
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
  async function readService(site: Site): Promise<{ view: ServiceView | null; startedUs: number | null }> {
    if (site.isStatic) return { view: null, startedUs: null };
    const unit = unitOf(site.folder);
    const response = await show(unit);
    if (response === null || response.code !== 0) return { view: null, startedUs: null };
    const parsed = readShow(response.output);
    const view = serviceView(unit, parsed);
    return { view, startedUs: view === null ? null : parsed.startedUs };
  }

  // --- Scope and state of a file ---------------------------------------------

  async function sites(): Promise<Map<string, Site>> {
    return readSites(await system.listProjects(), await system.listSecrets());
  }

  async function target(operation: Operation, body: Body): Promise<Target | Response> {
    const found = checkSite(await sites(), body.slug);
    if ("refusal" in found) return refuse(operation, body, found.refusal);
    const file = checkFile(found.site, body.file, secretsFolder);
    if ("refusal" in file) return refuse(operation, body, file.refusal);
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
  async function managedFile(operation: Operation, body: Body, c: Target, variable: string | null = null): Promise<Managed | Response> {
    const parsed = await examineTarget(c);
    const name = c.declaration.name;
    if (parsed.kind === "absent") {
      return refuse(operation, body, { error: "not-found", message: `${name} does not exist, create it first` }, variable);
    }
    if (parsed.kind === "unmanaged") {
      return refuse(operation, body, { error: "unmanaged", message: `${name} is not managed here: ${parsed.reason}` }, variable);
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

  async function fileView(c: Target, startedUs: number | null): Promise<FileView> {
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
            restartPending: restartPending(info.modifiedAt, startedUs),
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

  async function fileResponse(c: Target): Promise<Response> {
    const service = await readService(c.site);
    const body: FileResponse = { file: await fileView(c, service.startedUs) };
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

  // --- A site's portal -------------------------------------------------------

  /** The sites whose gatekeeper the steward is waiting for at this moment. */
  const gatekeepersInFlight = new Set<string>();

  async function portalView(site: Site): Promise<PortalView> {
    let modifiable = false;
    let reason: string | null = "sitesolide.json could not be checked";
    try {
      ({ modifiable, reason } = portalModifiable(site.folder, site.manifest));
    } catch (e) {
      console.error(`portal: rule unreadable for ${site.folder} (${errorName(e)})`);
    }

    // A backup that remains says a gatekeeper stopped in the middle: the block
    // in service is not necessarily the one being read any more, and a new
    // action would start from a state nobody knows. While this steward is
    // waiting for the gatekeeper, it is normal, and the page says so otherwise.
    try {
      if (await system.gatekeeperBackup(site.folder)) {
        modifiable = false;
        reason = gatekeepersInFlight.has(site.folder) ? TRANSACTION_IN_PROGRESS_REASON : INTERRUPTED_TRANSACTION_REASON;
      } else {
        const other = (await system.gatekeeperBackups()).find((name) => name !== site.folder);
        if (other !== undefined) {
          modifiable = false;
          reason = backupElsewhereReason(other, gatekeepersInFlight.has(other));
        }
      }
    } catch (e) {
      // When in doubt, no action: we do not know whether a gatekeeper stopped.
      console.error(`portal: gatekeeper backup unreadable for ${site.folder} (${errorName(e)})`);
      modifiable = false;
      reason = "the gatekeeper's state could not be checked on the server";
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

  // --- The routes ------------------------------------------------------------

  async function listProjects(): Promise<Response> {
    const seen = await Promise.all(
      [...(await sites()).values()].map(async (site): Promise<ProjectView> => {
        const service = await readService(site);
        const files: FileView[] = [];
        for (const declaration of site.files) {
          const path = pathUnder(secretsFolder, declaration.name) ?? declaration.name;
          try {
            files.push(await fileView({ site, declaration, path }, service.startedUs));
          } catch (e) {
            // An unreadable file does not bring the whole list down.
            console.error(`projects: ${declaration.name} unreadable (${errorName(e)})`);
            files.push(unreadableView(declaration));
          }
        }
        return { slug: site.folder, service: service.view, files, portal: await portalView(site) };
      }),
    );
    const body: ProjectsResponse = { projects: seen };
    return Response.json(body);
  }

  async function readLog(req: Request): Promise<Response> {
    const wanted = new URL(req.url).searchParams.getAll("slug");
    if (wanted.length > 1) return error("invalid", "name one site at most");
    const slug = wanted[0] ?? null;
    if (slug !== null && !isSiteFolder(slug)) return error("invalid", "not a site name");
    const body: LogResponse = { entries: latest(reread(await system.readLog()), RETURNED_ENTRIES, slug) };
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

    return underLock(req, body, async () => {
      const found = await target("read", body);
      if (found instanceof Response) return found;
      const kind = kindRefusal(found, "variables");
      if (kind !== null) return refuse("read", body, kind);
      // Before any reading of the file: a hash is never read back.
      if (isPassword(found.declaration, body.variable)) {
        const message = `${body.variable as string} is never read back, change it with Change password`;
        return refuse("read", body, { error: "out-of-scope", message }, body.variable as string);
      }
      const managed = await managedFile("read", body, found);
      if (managed instanceof Response) return managed;

      const value = envValue(managed.document!, body.variable as string);
      if (value === null) {
        return refuse("read", body, { error: "not-found", message: `no such variable in ${found.declaration.name}` });
      }
      await writeLog("read", "ok", body, null, body.variable as string);
      const response: ValueResponse = { value };
      return Response.json(response);
    });
  }

  /** The refusal of an ordinary route on a hash, for setting as for removing. */
  function passwordRefusal(c: Target, variable: unknown): Refusal | null {
    if (!isPassword(c.declaration, variable)) return null;
    return { error: "out-of-scope", message: `${variable as string} is a password hash, change it with Change password` };
  }

  async function setVariable(req: Request): Promise<Response> {
    const body = await bodyWithToken(req, ["slug", "file", "variable", "value"]);
    if (body instanceof Response) return body;

    return underLock(req, body, async () => {
      const found = await target("set", body);
      if (found instanceof Response) return found;
      const kind = kindRefusal(found, "variables");
      if (kind !== null) return refuse("set", body, kind);
      const password = passwordRefusal(found, body.variable);
      if (password !== null) return refuse("set", body, password, body.variable as string);
      const foreign = outsideHashRefusal(found.declaration.name, body.variable);
      if (foreign !== null) return refuse("set", body, foreign);
      const managed = await managedFile("set", body, found);
      if (managed instanceof Response) return managed;

      const variable = body.variable as string;
      const value = body.value as string;
      const known = knownVariable(managed.document, body);
      const keyReason = checkKey(variable, await setKeys(found.site));
      if (keyReason !== null) return refuse("set", body, { error: "invalid", message: keyReason }, known);
      const valueReason = checkValue(value);
      if (valueReason !== null) return refuse("set", body, { error: "invalid", message: valueReason }, known);

      const refusal = await rewrite(found, managed, set(managed.document!, variable, value));
      if (refusal !== null) {
        await writeLog("set", "rejects", body, "invalid", known);
        return refusal;
      }
      await writeLog("set", "ok", body, null, variable);
      return fileResponse(found);
    });
  }

  async function removeVariable(req: Request): Promise<Response> {
    const body = await bodyWithToken(req, ["slug", "file", "variable"]);
    if (body instanceof Response) return body;

    return underLock(req, body, async () => {
      const found = await target("remove", body);
      if (found instanceof Response) return found;
      const kind = kindRefusal(found, "variables");
      if (kind !== null) return refuse("remove", body, kind);
      const password = passwordRefusal(found, body.variable);
      if (password !== null) return refuse("remove", body, password, body.variable as string);
      const managed = await managedFile("remove", body, found);
      if (managed instanceof Response) return managed;

      const variable = body.variable as string;
      if (envValue(managed.document!, variable) === null) {
        return refuse("remove", body, { error: "not-found", message: `no such variable in ${found.declaration.name}` });
      }
      // A reserved key that is already present can be removed: that is repairing, not setting.
      await rewrite(found, managed, remove(managed.document!, variable));
      await writeLog("remove", "ok", body, null, variable);
      return fileResponse(found);
    });
  }

  async function createFile(req: Request): Promise<Response> {
    const body = await bodyWithToken(req, ["slug", "file"]);
    if (body instanceof Response) return body;

    return underLock(req, body, async () => {
      const found = await target("create", body);
      if (found instanceof Response) return found;
      const { declaration } = found;

      // The steward never creates a directory in /etc/sitesolide: a
      // subdirectory is put in place by hand, as root, as the deployment does.
      const folder = await subFolderState(declaration.name);
      if (folder.kind === "absent") {
        return refuse("create", body, { error: "not-found", message: `${folder.path} does not exist on the server` });
      }
      if (folder.kind === "rejects") {
        return refuse("create", body, { error: "unmanaged", message: `${declaration.name} is not managed here: ${folder.reason}` });
      }

      if ((await system.examineSecret(declaration.name)).kind !== "absent") {
        return refuse("create", body, { error: "already-present", message: `${declaration.name} already exists` });
      }

      const account = await realAccount(declaration);
      if (account === null) {
        const message = `account ${declaration.expected.owner} does not exist, deploy the site first`;
        return refuse("create", body, { error: "not-found", message });
      }

      const created = await system.createEmptySecret(declaration.name, expectedPermissions(declaration, account ?? null));
      if (!created) {
        return refuse("create", body, { error: "already-present", message: `${declaration.name} already exists` });
      }
      await writeLog("create", "ok", body, null);
      return fileResponse(found);
    });
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

    return underLock(req, body, async () => {
      const found = await target("restore", body);
      if (found instanceof Response) return found;
      const { declaration } = found;
      // A hash-only file, before even reading it.
      const fixed = restoreRefusal(declaration, []);
      if (fixed !== null) return refuse("restore", body, fixed);
      const managed = await managedFile("restore", body, found);
      if (managed instanceof Response) return managed;
      const { name } = declaration;

      const current = restoreRefusal(declaration, managed.document === null ? [] : keys(managed.document));
      if (current !== null) return refuse("restore", body, current);

      const kept = await system.examinePrevious(name);
      if (kept.kind === "absent") {
        return refuse("restore", body, { error: "not-found", message: `no previous version of ${name}` });
      }
      const keptRefusal = restoreRefusal(declaration, previousKeys(declaration, kept));
      if (keptRefusal !== null) return refuse("restore", body, keptRefusal);
      const reason = previousReason(kept.info, managed.real, found.declaration.expected.owner);
      const readable =
        kept.bytes !== null &&
        (found.declaration.kind === "variables" ? parseEnvBytes(kept.bytes).ok : "text" in readContent(kept.bytes));
      if (reason !== null || !readable) {
        const message = reason ?? `the previous version of ${name} is not in a form managed here`;
        return refuse("restore", body, { error: "unmanaged", message });
      }

      await writeKeepingPrevious(found, managed, kept.bytes!);
      await writeLog("restore", "ok", body, null);
      return fileResponse(found);
    });
  }

  /**
   * The content of a file managed as one block. Refused before any reading for
   * a write-only file: a private key is replaced, it never comes back to the
   * screen.
   */
  async function readFileContent(req: Request): Promise<Response> {
    const body = await bodyWithToken(req, ["slug", "file"]);
    if (body instanceof Response) return body;

    return underLock(req, body, async () => {
      const found = await target("read", body);
      if (found instanceof Response) return found;
      const kind = kindRefusal(found, "content");
      if (kind !== null) return refuse("read", body, kind);
      if (!found.declaration.readable) {
        const message = `${found.declaration.name} is write-only, it can be replaced but never read back`;
        return refuse("read", body, { error: "out-of-scope", message });
      }
      const managed = await managedFile("read", body, found);
      if (managed instanceof Response) return managed;

      await writeLog("read", "ok", body, null);
      const response: ContentResponse = { content: managed.text! };
      return Response.json(response);
    });
  }

  /** Replaces a file managed as one block, byte for byte, and keeps the previous version. */
  async function replaceContent(req: Request): Promise<Response> {
    const body = await bodyWithToken(req, ["slug", "file", "content"], [], MAX_CONTENT_BODY_BYTES);
    if (body instanceof Response) return body;

    return underLock(req, body, async () => {
      const found = await target("replace", body);
      if (found instanceof Response) return found;
      const kind = kindRefusal(found, "content");
      if (kind !== null) return refuse("replace", body, kind);
      const reason = checkContent(body.content as string);
      if (reason !== null) return refuse("replace", body, { error: "invalid", message: reason });
      const managed = await managedFile("replace", body, found);
      if (managed instanceof Response) return managed;

      await writeKeepingPrevious(found, managed, encoder.encode(body.content as string));
      await writeLog("replace", "ok", body, null);
      return fileResponse(found);
    });
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
        file: await fileView(found, service.startedUs),
        password: newPassword === null ? fresh.password : null,
      };
      return Response.json(response);
    });
  }

  /**
   * Puts up or takes away a site's portal through the gatekeeper, under the
   * exclusion lock: two actions on Caddy never cross.
   */
  async function togglePortal(req: Request): Promise<Response> {
    const body = await bodyWithToken(req, ["slug", "confirmation"], ["active"]);
    if (body instanceof Response) return body;
    if (typeof body.active !== "boolean") return error("invalid", "active must be a boolean");
    const active = body.active;
    const direction = active ? "on" : "off";

    return underLock(req, body, async () => {
      const found = checkSite(await sites(), body.slug);
      if ("refusal" in found) return refuse("portal", body, found.refusal);
      const { site } = found;

      const { modifiable, reason } = await portalView(site);
      const unit = gatekeeperUnitOf(active, site.folder);
      if (!modifiable || unit === null) {
        return refuse("portal", body, { error: "out-of-scope", message: reason ?? "the portal of this site cannot be changed" });
      }
      // Taking away the portal makes the site public: the name is retyped.
      if (!active && body.confirmation !== site.folder) {
        return refuse("portal", body, { error: "invalid", message: `type ${site.folder} to confirm removing the portal` });
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
      await writeLog("portal", result, body, `${direction}, ${result}`);

      // A refusal from the gatekeeper, Caddy being changed from the workstation
      // included: nothing has moved, the message says what to do.
      if (result === "rejects") return error("unmanaged", message);
      if (result === "failure") return error("failure", message);
      const reread = (await sites()).get(site.folder) ?? site;
      const response: PortalResponse = { portal: await portalView(reread), detail: message };
      return Response.json(response);
    });
  }

  /** Eight seconds of readings after a restart, and the verdict that comes out of them. */
  async function observe(unit: string): Promise<Verdict> {
    const readings: ServiceReading[] = [];
    const start = system.now();
    for (;;) {
      const response = await show(unit, true);
      if (response !== null && response.code === 0) readings.push({ ...readShow(response.output), a: system.now() });
      if (system.now() - start >= observationMs) break;
      await system.wait(stepMs);
    }
    return verdict(readings);
  }

  const verdictDetail = (result: Verdict) => `${result.kind}, ${result.state}/${result.subState}, ${result.restarts} restarts`;

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

      // Restarting a unit that reads none of the managed files would apply
      // nothing, and would cut the service for nothing. A file is read through
      // `EnvironmentFile=`, or by the service itself when the unit gives it its
      // path, or that of its subdirectory, through `Environment=`.
      const unitEnv = unitEnvironment(text);
      const readFiles = new Set(unitEnv.files.map((file) => file.path));
      const values = new Set(unitEnv.values.map((value) => value.replace(/\/+$/, "")));
      const reads = site.files.some(({ name }) => {
        const path = pathUnder(secretsFolder, name);
        const subFolder = subFolderOf(name);
        const folder = subFolder === null ? null : pathUnder(secretsFolder, subFolder);
        return path !== null && (readFiles.has(path) || values.has(path) || (folder !== null && values.has(folder)));
      });
      if (!reads) {
        const message = `${unit}.service reads none of the managed files, by EnvironmentFile= or Environment=, a restart would apply nothing`;
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

      const result = await observe(unit);
      await writeLog("restart", result.kind === "active" ? "ok" : "failure", body, verdictDetail(result));
      const response: RestartResponse = { verdict: result };
      return Response.json(response);
    });
  }

  // --- Routing -----------------------------------------------------------------

  const routes: Record<string, Record<string, (req: Request) => Promise<Response>>> = {
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
    "/restart": { POST: restart },
  };

  let inFlight = 0;

  return async (req) => {
    if (inFlight >= maxInFlight) return busy();
    inFlight++;
    try {
      const path = new URL(req.url).pathname;
      const route = Object.hasOwn(routes, path) ? routes[path] : undefined;
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
}

function errorName(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return e instanceof Error ? e.name : "unknown";
}
