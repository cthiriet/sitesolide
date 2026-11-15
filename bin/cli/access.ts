/**
 * `sitesolide share`: who may open a project's site, from the project's
 * folder, over the owner's SSH.
 *
 *   sitesolide share                                  general access and guests
 *   sitesolide share <email>... [--expires <24h|7d|30d|never>]
 *                                                     give them password access, 7 days by default
 *   sitesolide share --remove <email|name>...         take it away
 *
 * A guest opens the site and nothing more: no dashboard, no token. The
 * machine draws their password, which the command shows once and keeps
 * only as a hash.
 *
 * **One registry, the steward's.** The command speaks to the steward, which
 * judges every change (dashboard/src/access/rules.ts) and writes the
 * registry and the portal's projection of it: root on the machine, over the
 * owner's SSH, asks the steward's owner socket,
 * `/run/sitesolide-steward-owner/owner.sock`, with `curl`, the JSON body on
 * standard input so that no address goes through a shell. A token never
 * gives anyone access.
 *
 * **What is never done here.** General access is the dashboard's Access
 * section, or `sitesolide lock` and `unlock` for the code, which reach the
 * steward's owner socket through `sshGeneral` below. No email is sent: the
 * command prints the password once, for the owner to send.
 *
 * The decisions are pure; the transports and the output are handed in.
 */
import type { Failure, Output } from "./remote";

/** The durations of password access the steward accepts, by what the command takes. */
export const DURATIONS: Readonly<Record<string, number | null>> = { "24h": 24 * 3600, "7d": 7 * 24 * 3600, "30d": 30 * 24 * 3600, never: null };

export const OWNER_SOCKET = "/run/sitesolide-steward-owner/owner.sock";

// --- what the steward answers, as far as the command reads it -----------------------

/** A guest, as the steward lists them: never their password, its hash or its identifier. */
export type EntryView = {
  who: string;
  by: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  expired: boolean;
};

export type AccessState = {
  slug: string;
  host: string;
  url: string;
  general: { access: "public" | "restricted" | "code"; modifiable: boolean; reason: string | null } | null;
  entries: EntryView[];
  portal?: { reading: string; writtenAt: number | null };
};

export type EntryAnswer = { entry: EntryView; change: "add" | "none" | "remove"; password?: string };

export type Reading<T> = { ok: true; value: T } | { ok: false; failure: Failure };

/** How `share` reaches the steward. */
export type AccessTransport = {
  /** For the first line: "over SSH, as the owner". */
  via: string;
  list: (slug: string) => Promise<Reading<AccessState>>;
  give: (slug: string, who: string, expiresInS: number | null | undefined) => Promise<Reading<EntryAnswer>>;
  remove: (slug: string, who: string) => Promise<Reading<EntryAnswer>>;
};

// --- what was asked ----------------------------------------------------------------

export const SHARE_USAGE = [
  "sitesolide share                 this project's general access and guests",
  "   <email>...                    give them password access to the site, nothing more",
  "   --expires <24h|7d|30d|never>  how long it lasts, 7d by default",
  "   --remove <email>...           take it away; a guest of before by the name it is listed under",
];

export type ShareRequest = { action: "list" } | { action: "give"; who: string[]; expiresInS: number | null | undefined } | { action: "remove"; who: string[] };

function usage(message: string, details: string[]): Failure {
  return { error: "usage", message, details };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * An email, lowercase, or why not. The steward judges it again by the
 * portal's own rules; this only catches a typo before anything is sent.
 */
export function readWho(value: string): string | Failure {
  const text = value.trim().toLowerCase();
  if (text.startsWith("@")) return { error: "invalid", message: `${value}: a whole domain is given access no more, name its people one by one; nothing was changed` };
  if (EMAIL.test(text)) return text;
  return { error: "invalid", message: `${value} is not an email address: nothing was changed` };
}

/** The request the arguments make, or what is wrong with them. Nothing is read or sent before this passes. */
export function readShareArguments(arguments_: string[]): ShareRequest | Failure {
  const rest = (arguments_[0] === "share" ? arguments_.slice(1) : arguments_).filter((argument) => argument !== "--json");
  const who: string[] = [];
  let removing = false;
  let given = false;
  let expires: number | null | undefined;
  for (let i = 0; i < rest.length; i++) {
    const argument = rest[i]!;
    if (argument === "--remove") {
      if (given) return usage("give access or take it away, one command each: --remove comes before the addresses it takes away", SHARE_USAGE);
      removing = true;
      continue;
    }
    if (argument === "--expires") {
      const value = rest[i + 1];
      i++;
      if (value === undefined || value.startsWith("-")) return usage("--expires: 24h, 7d, 30d or never must follow", SHARE_USAGE);
      if (!Object.hasOwn(DURATIONS, value)) return { error: "invalid", message: `${value} is not a duration: 24h, 7d, 30d or never; nothing was changed` };
      expires = DURATIONS[value];
      continue;
    }
    if (argument === "--role" || argument === "--domain" || argument === "--only-admins" || argument === "--api") {
      return usage(`${argument} is gone: a guest opens the site with a password and nothing more, and general access is chosen in the dashboard's Access section`, SHARE_USAGE);
    }
    if (argument.startsWith("-")) return { error: "unknown-option", message: `${argument}: not an option of sitesolide share: nothing was changed`, details: SHARE_USAGE };
    let read = readWho(argument);
    // A name a password access was carried over under ("Client Bob", "Bob @
    // the agency") is taken away as it stands, and given never. One starting
    // with @ is a domain.
    if (typeof read !== "string" && removing && /^[\x20-\x7e]{1,254}$/.test(argument) && argument.trim() !== "" && !argument.trim().startsWith("@")) read = argument.trim();
    if (typeof read !== "string") return read;
    if (!removing) given = true;
    if (!who.includes(read)) who.push(read);
  }
  if (removing) {
    if (who.length === 0) return usage("--remove: an email address must follow", SHARE_USAGE);
    if (expires !== undefined) return usage("--remove takes access away: it takes no --expires", SHARE_USAGE);
    return { action: "remove", who };
  }
  if (who.length === 0) {
    if (expires !== undefined) return usage("--expires: name who to give access to first", SHARE_USAGE);
    return { action: "list" };
  }
  return { action: "give", who, expiresInS: expires };
}

// --- what is shown -------------------------------------------------------------------

/** A date as a person reads it, in UTC. */
function day(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** `password access until 2026-10-14 10:00 UTC`, `expired ...`, or `with no expiry`. */
export function entryText(entry: EntryView): string {
  return `password access ${entry.expiresAt === null ? "with no expiry" : `${entry.expired ? "expired" : "until"} ${day(entry.expiresAt)}`}`;
}

const GENERAL: Readonly<Record<"public" | "restricted" | "code", string>> = {
  public: "Public: anyone can open it.",
  restricted: "Restricted: visitors are asked to sign in.",
  code: "Anyone with the code: the preview code opens it.",
};

/** The project's access in lines, for a person. */
export function describeAccess(state: AccessState): string[] {
  const width = Math.max(10, ...state.entries.map((entry) => entry.who.length));
  const lines = [
    `   general access: ${state.general === null ? "not deployed: its guests are kept, its site serves nothing" : GENERAL[state.general.access]}`,
    state.entries.length === 0 ? "   guests: nobody yet" : "   guests:",
    ...state.entries.map((entry) => `     ${entry.who.padEnd(width)}  ${entryText(entry)}`),
    "   The owner also opens it.",
  ];
  if (state.general?.access === "public" && state.entries.length > 0) {
    lines.push(`   ${state.slug} is public, so anyone can open it: its guests matter once you restrict it.`);
  }
  return lines;
}

/** Warnings about the machine itself: a portal that cannot read the registry's projection. */
export function accessWarnings(state: AccessState): string[] {
  const reading = state.portal?.reading;
  if (reading === "unreadable") return ["!! the portal cannot read who may open a site: only the owner opens one; tell the owner of the machine (journalctl -u portal)"];
  return [];
}

function resultFields(state: AccessState, extra: Record<string, unknown>): Record<string, unknown> {
  return { slug: state.slug, url: state.url, general: state.general?.access ?? null, entries: state.entries, ...extra };
}

/**
 * The command: read, change each one asked, say. Returns the exit code,
 * never throws. A refusal for one guest stops before the next: what was
 * already given stays given, and is said.
 */
export async function share(arguments_: string[], slug: string, transport: AccessTransport, output: Output): Promise<number> {
  const request = readShareArguments(arguments_);
  if ("error" in request) {
    output.failed(request);
    return 1;
  }
  const read = await transport.list(slug);
  if (!read.ok) {
    output.failed(read.failure);
    return 1;
  }
  const before = read.value;
  output.say(`-> access to ${slug}, ${before.url}, ${transport.via}`);
  for (const warning of accessWarnings(before)) output.say(warning);

  if (request.action === "list") {
    for (const line of describeAccess(before)) output.say(line);
    output.succeeded("share", resultFields(before, { changed: false }));
    return 0;
  }

  const changes: { who: string; change: string; password?: string }[] = [];
  for (const who of request.who) {
    const done = request.action === "give" ? await transport.give(slug, who, request.expiresInS) : await transport.remove(slug, who);
    if (!done.ok) {
      if (changes.length > 0) output.say(`   already done: ${changes.map((one) => one.who).join(", ")}`);
      output.failed(done.failure);
      return 1;
    }
    const { entry, change, password } = done.value;
    changes.push({ who: entry.who, change, ...(password === undefined ? {} : { password }) });
    if (change === "remove") output.say(`-> ${entry.who} no longer has access to ${slug}: refused from their next request`);
    else if (change === "none") output.say(`   nothing to change: ${entry.who} already has ${entryText(entry)}; remove them first to draw a new password`);
    else output.say(`-> ${entry.who}: ${entryText(entry)} on ${slug}`);
    if (password !== undefined) {
      output.say(`   password for ${entry.who}: ${password}`);
      output.say(`   shown once: send it to them yourself, with ${before.url}; the machine keeps only its hash`);
    }
  }
  const after = await transport.list(slug);
  const state = after.ok ? after.value : before;
  for (const line of describeAccess(state)) output.say(line);
  output.succeeded("share", resultFields(state, { changed: changes.some((one) => one.change !== "none"), changes }));
  return 0;
}

// --- the owner's way: over SSH, to the steward's owner socket -------------------------

/** What a command run on the machine leaves. */
export type Execution = { code: number; output: string; error: string };

/** A command on the machine over the owner's SSH, `input` on its standard input. */
export type RunOnMachine = (command: string, input?: string) => Promise<Execution>;

/** curl's answer: the body, then the status on the last line. null when it is not that. */
export function readCurlAnswer(output: string): { status: number; body: string } | null {
  const text = output.endsWith("\n") ? output.slice(0, -1) : output;
  const cut = text.lastIndexOf("\n");
  const status = text.slice(cut + 1);
  if (!/^[0-9]{3}$/.test(status)) return null;
  return { status: Number(status), body: cut === -1 ? "" : text.slice(0, cut) };
}

const SOCKET = `--unix-socket ${OWNER_SOCKET}`;
const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A read, as root on the machine; the status on a line of its own after the
 * body. The address quoted: a `?` is a pattern to the remote shell. A slug
 * is built into the address only once it has a slug's shape: the address is
 * quoted, and a quote in it would end the quoting.
 */
export function ownerReadCommand(
  path: "/passkeys" | `/access?slug=${string}` | `/store?slug=${string}` | `/tokens/claim?slug=${string}`,
): string {
  const slug = /\?slug=(.*)$/.exec(path)?.[1];
  if (slug !== undefined && !SLUG.test(slug)) throw new Error("not a project's slug: no read is built from it");
  return `sudo curl -sS --max-time 30 -w '\\n%{http_code}\\n' ${SOCKET} 'http://steward${path}'`;
}

/** The owner socket's routes that change something, each taking its JSON body on standard input. */
export type OwnerWritePath =
  | "/access/entry"
  | "/store"
  | "/store/variable"
  | "/store/generate"
  | "/store/file"
  | "/restart"
  | "/general"
  | "/tokens/claim"
  | "/tokens/project"
  | "/tokens/owner"
  | "/control/rename"
  | "/control/lifecycle"
  | "/passkeys/link"
  | "/passkeys/credential";

/**
 * How long curl waits, in seconds, for the routes not given the thirty of
 * every other write. A restart watches the service for a few seconds, and a
 * change of general access waits for the steward's lock and then for the
 * gatekeeper, up to ninety seconds: both are given longer. The release of a
 * removed project's name comes once the project is gone, and is given less.
 */
const WRITE_SECONDS: Partial<Record<OwnerWritePath, number>> = { "/restart": 120, "/general": 240, "/tokens/project": 10, "/control/rename": 270, "/control/lifecycle": 270 };

/** A change, the JSON body on standard input: no address of the request, nor any value, ever goes through a shell. */
export function ownerWriteCommand(method: "PUT" | "DELETE" | "POST" | "PATCH", path: OwnerWritePath): string {
  return `sudo curl -sS --max-time ${WRITE_SECONDS[path] ?? 30} -X ${method} -H 'Content-Type: application/json' --data-binary @- -w '\\n%{http_code}\\n' ${SOCKET} http://steward${path}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A change of general access, the JSON body on standard input. */
export function ownerGeneralCommand(): string {
  return ownerWriteCommand("POST", "/general");
}

/**
 * The steward's answer over SSH, or the failure in the command's words: an
 * ssh that did not connect, a socket missing (a steward from before the
 * owner's socket), a route the steward does not carry yet (`outdated`), or
 * its refusal as it stands. `unchanged` adds that nothing was changed to a
 * refusal, which a read or a change that may have half happened leaves out.
 */
export async function askSteward(
  run: RunOnMachine,
  command: string,
  input?: string,
  words: {
    outdated: string;
    unchanged: boolean;
  } = { outdated: "the steward on the server does not keep guests yet: run sitesolide upgrade first", unchanged: true },
): Promise<Reading<Record<string, unknown>>> {
  const done = await run(command, input);
  if (done.code === 255) {
    return { ok: false, failure: { error: "ssh-failed", message: "cannot reach the server over SSH: nothing was changed", details: [done.error.trim() || "no message"] } };
  }
  if (done.code !== 0) {
    // curl's 7: no socket, a steward whose unit has no owner's socket yet.
    return {
      ok: false,
      failure: {
        error: "steward-outdated",
        message: "the steward on the server has no owner's socket: run sitesolide upgrade first, which brings the steward up to date",
        details: [done.error.trim() || "no message", `the socket: ${OWNER_SOCKET}`],
      },
    };
  }
  const answer = readCurlAnswer(done.output);
  if (answer === null) return { ok: false, failure: { error: "failure", message: "the steward answered with something this CLI cannot read: nothing was changed" } };
  let body: unknown;
  try {
    body = JSON.parse(answer.body);
  } catch {
    body = null;
  }
  if (!isObject(body)) return { ok: false, failure: { error: "failure", message: `the steward answered ${answer.status} with something this CLI cannot read` } };
  if (answer.status === 404 && body.message === "no such route") {
    return { ok: false, failure: { error: "steward-outdated", message: words.outdated } };
  }
  if (answer.status >= 400) {
    const code = typeof body.error === "string" ? body.error : "failure";
    const said = typeof body.message === "string" ? body.message : `refused (${answer.status})`;
    return { ok: false, failure: { error: code, message: words.unchanged ? `${said}: nothing was changed` : said } };
  }
  return { ok: true, value: body };
}

function readAccess(body: Record<string, unknown>): AccessState | null {
  if (typeof body.slug !== "string" || typeof body.url !== "string" || !Array.isArray(body.entries)) return null;
  return body as unknown as AccessState;
}

function readEntry(body: Record<string, unknown>): EntryAnswer | null {
  if (!isObject(body.entry) || typeof body.change !== "string") return null;
  return body as unknown as EntryAnswer;
}

const unreadable = (what: string): { ok: false; failure: Failure } => ({ ok: false, failure: { error: "failure", message: `the steward's ${what} does not read: nothing was changed` } });

/** A change of an entry, as the steward answered it. */
function entryRead(read: Reading<Record<string, unknown>>): Reading<EntryAnswer> {
  if (!read.ok) return read;
  const entry = readEntry(read.value);
  return entry === null ? unreadable("answer") : { ok: true, value: entry };
}

/** The owner's transport for `share`: root on the machine asks the steward's owner socket. */
export function sshAccess(run: RunOnMachine): AccessTransport {
  return {
    via: "over SSH, as the owner",
    async list(slug) {
      if (!SLUG.test(slug)) return { ok: false, failure: { error: "invalid", message: `${slug} is not a project's slug` } };
      const read = await askSteward(run, ownerReadCommand(`/access?slug=${slug}`));
      if (!read.ok) return read;
      const state = readAccess(read.value);
      return state === null ? unreadable("access list") : { ok: true, value: state };
    },
    give: async (slug, who, expiresInS) =>
      entryRead(await askSteward(run, ownerWriteCommand("PUT", "/access/entry"), JSON.stringify({ slug, who, ...(expiresInS === undefined ? {} : { expiresInS }) }))),
    remove: async (slug, who) => entryRead(await askSteward(run, ownerWriteCommand("DELETE", "/access/entry"), JSON.stringify({ slug, who }))),
  };
}

// --- general access, for `sitesolide lock` and `unlock` -------------------------------

/** What the steward answers once the gatekeeper is done, as far as the command reads it. */
export type GeneralAnswer = {
  general: { access: "public" | "restricted" | "code" };
  /** The gatekeeper's verdict, in its words. */
  detail: string;
  /** The code in force when the site opens with one: the steward read it back from the machine. */
  code: { code: string; url: string | null } | null;
};

/**
 * A project turned off or on, over the owner's socket: the steward runs the
 * machine's own run and waits on it. A refusal carries the run's log.
 */
export async function sshLifecycle(run: RunOnMachine, slug: string, action: "disable" | "enable"): Promise<Reading<{ log: string[] }>> {
  const done = await run(ownerWriteCommand("POST", "/control/lifecycle"), JSON.stringify({ slug, action }));
  const read = await askSteward(async () => done, "", undefined, { outdated: "the steward on the server cannot turn a project off or on yet: run sitesolide upgrade first", unchanged: false });
  if (!read.ok) {
    const answer = readCurlAnswer(done.output);
    let details: string[] = [];
    try {
      const body = answer === null ? null : (JSON.parse(answer.body) as { details?: unknown });
      if (Array.isArray(body?.details)) details = body.details.filter((line): line is string => typeof line === "string");
    } catch {
      // No log to quote.
    }
    return { ok: false, failure: { ...read.failure, details: [...(read.failure.details ?? []), ...details] } };
  }
  const { log } = read.value;
  return { ok: true, value: { log: Array.isArray(log) ? log.filter((line): line is string => typeof line === "string") : [] } };
}

/** A rename as the steward answered it: the new address and the machine's log. */
export type RenameAnswer = { slug: string; to: string; url: string; log: string[] };

/**
 * A project renamed, over the owner's socket: the steward runs the machine's
 * rename and waits on it, then re-keys its registries. A refusal carries the
 * run's log in its details, and says nothing of what was changed: a failed
 * rename puts everything back, which its log says.
 */
export async function sshRename(run: RunOnMachine, slug: string, to: string): Promise<Reading<RenameAnswer>> {
  const done = await run(ownerWriteCommand("POST", "/control/rename"), JSON.stringify({ slug, to }));
  const read = await askSteward(async () => done, "", undefined, { outdated: "the steward on the server cannot rename a project yet: run sitesolide upgrade first", unchanged: false });
  if (!read.ok) {
    const answer = readCurlAnswer(done.output);
    let details: string[] = [];
    try {
      const body = answer === null ? null : (JSON.parse(answer.body) as { details?: unknown });
      if (Array.isArray(body?.details)) details = body.details.filter((line): line is string => typeof line === "string");
    } catch {
      // No log to quote.
    }
    return { ok: false, failure: { ...read.failure, details: [...(read.failure.details ?? []), ...details] } };
  }
  const { url, log } = read.value;
  if (typeof url !== "string" || !Array.isArray(log)) return unreadable("answer");
  return { ok: true, value: { slug, to, url, log: log.filter((line): line is string => typeof line === "string") } };
}

/**
 * The owner's way to a site's general access: root on the machine asks the
 * steward on its owner socket, which launches the gatekeeper, the one path
 * that changes Caddy from the machine, the dashboard's too. `renew` asks for a
 * new code. The gatekeeper's message comes back as it stands: a failure says
 * itself whether the previous configuration was restored.
 */
export async function sshGeneral(run: RunOnMachine, slug: string, access: "public" | "code", renew: boolean): Promise<Reading<GeneralAnswer>> {
  if (!SLUG.test(slug)) return { ok: false, failure: { error: "invalid", message: `${slug} is not a project's slug` } };
  const read = await askSteward(run, ownerGeneralCommand(), JSON.stringify({ slug, access, ...(renew ? { renew } : {}) }), {
    outdated: "the steward on the server cannot change a site's general access yet: run sitesolide upgrade first, which brings the steward and the gatekeeper up to date",
    unchanged: false,
  });
  if (!read.ok) return read;
  const { general, detail, code } = read.value;
  if (!isObject(general) || typeof general.access !== "string" || typeof detail !== "string") return unreadable("answer");
  if (code !== null && (!isObject(code) || typeof code.code !== "string")) return unreadable("answer");
  return { ok: true, value: read.value as unknown as GeneralAnswer };
}

// --- a name a token holds, for the owner's deploy -------------------------------------

/**
 * Whether a token holds, or claims, a name, the machine carrying its project
 * or not: its deployment accepted, its write that made the project's store,
 * or a creation that made it the project's Admin. The owner's SSH deploy of
 * such a name would hand the token what the owner sets there, so it stops
 * unless the owner takes the name back (`--adopt`). As
 * dashboard/src/control/protocol.ts answers it.
 */
export type ClaimView = {
  slug: string;
  claimed: boolean;
  /** The machine carries the project; null from a steward that did not say, which answered for names it did not carry alone. */
  onMachine: boolean | null;
  token: { id: string; label: string; email: string } | null;
  /** The project's store was made by that token's write, ahead of any deployment. */
  store: boolean;
  /** A deployment of the name is under way, that token's or any: deploying, or taking it back, waits for its end. */
  deploying: boolean;
};

/** A name taken back: the token released, null when none held it, and what its store held, moved aside, names only. */
export type ClaimReleased = { slug: string; released: string | null; dropped: { variables: string[]; files: string[] } };

const NOTHING_CLAIMED = (slug: string): ClaimView => ({ slug, claimed: false, onMachine: null, token: null, store: false, deploying: false });

/** How askSteward words a steward without the route, here: told apart from a socket missing. */
const BEFORE_CLAIMS = "the steward predates claims";

/**
 * The claim on a name, asked of the steward's owner socket, as root. A
 * steward from before claims answers no such route: nothing is claimed then,
 * no token having been able to hold a name ahead of a deployment.
 */
export async function sshClaim(run: RunOnMachine, slug: string): Promise<Reading<ClaimView>> {
  if (!SLUG.test(slug)) return { ok: false, failure: { error: "invalid", message: `${slug} is not a project's slug` } };
  const read = await askSteward(run, ownerReadCommand(`/tokens/claim?slug=${slug}`), undefined, { outdated: BEFORE_CLAIMS, unchanged: false });
  if (!read.ok) return read.failure.error === "steward-outdated" && read.failure.message === BEFORE_CLAIMS ? { ok: true, value: NOTHING_CLAIMED(slug) } : read;
  const { claimed, onMachine, token, store, deploying } = read.value;
  const tokenRead = token === null || (isObject(token) && typeof token.id === "string" && typeof token.label === "string" && typeof token.email === "string");
  const placed = onMachine === undefined || typeof onMachine === "boolean";
  if (read.value.slug !== slug || typeof claimed !== "boolean" || !placed || typeof store !== "boolean" || typeof deploying !== "boolean" || !tokenRead) return unreadable("claim");
  return {
    ok: true,
    value: { slug, claimed, onMachine: typeof onMachine === "boolean" ? onMachine : null, token: token as ClaimView["token"], store, deploying },
  };
}

/**
 * The owner takes back a name a token holds: its hold and claim dropped, and
 * a store its write made moved aside. The token released, or null when none
 * held it, and what was moved aside; none from a steward that did not say.
 */
export async function sshTakeBack(run: RunOnMachine, slug: string): Promise<Reading<ClaimReleased>> {
  if (!SLUG.test(slug)) return { ok: false, failure: { error: "invalid", message: `${slug} is not a project's slug` } };
  const read = await askSteward(run, ownerWriteCommand("DELETE", "/tokens/claim"), JSON.stringify({ slug }), {
    outdated: "the steward on the server cannot take a name back from a token yet: run sitesolide upgrade first",
    unchanged: true,
  });
  if (!read.ok) return read;
  const { released, dropped } = read.value;
  const isNames = (value: unknown): value is string[] => Array.isArray(value) && value.every((one) => typeof one === "string");
  const droppedRead = dropped === undefined || (isObject(dropped) && isNames(dropped.variables) && isNames(dropped.files));
  if (read.value.slug !== slug || (released !== null && typeof released !== "string") || !droppedRead) return unreadable("answer");
  const moved = isObject(dropped) && isNames(dropped.variables) && isNames(dropped.files) ? { variables: dropped.variables, files: dropped.files } : { variables: [], files: [] };
  return { ok: true, value: { slug, released: released as string | null, dropped: moved } };
}
