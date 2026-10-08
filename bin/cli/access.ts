/**
 * `sitesolide share` and `sitesolide people`: who may do what on a project,
 * from the project's folder, and who may do what on the machine, from
 * anywhere.
 *
 *   sitesolide share                                   general access and people with access
 *   sitesolide share <email|@domain>... [--role <role>] [--expires <24h|7d|30d|never>]
 *                                                      give access, or change a role; Can open by default
 *   sitesolide share --remove <email|@domain|name>...  take access away
 *   sitesolide people                                  everyone, their roles, who may create projects
 *   sitesolide people <email> --may-create|--no-create the right to create projects
 *   sitesolide people --migrate-without-portal         carry access over without the portal's database
 *
 * A role is one rung of a ladder, each including the ones below: `can-open`
 * (`visitor`, the name the machine keeps, is read too), `viewer`,
 * `developer`, `admin`. A domain is Can open only. A
 * person outside the company's domains, or anyone when signing in with a
 * company account is not set up, is Can open only, with password access:
 * the machine draws the password, which the command shows once.
 *
 * **One registry, the steward's.** Both commands speak to the steward,
 * which judges every change (dashboard/src/access/rules.ts) and writes the
 * registry and the portal's projection of it:
 *
 * - the owner goes over SSH, as root, to the steward's owner socket,
 *   `/run/sitesolide-steward-owner/owner.sock`, with `curl`, the JSON body on
 *   standard input so that no address goes through a shell;
 * - a token goes through the dashboard's control API,
 *   `/api/v1/projects/<slug>/access` (remote.ts builds that transport): it
 *   gives Can open alone, to people inside the company's domains or to one
 *   of those domains, and removes Can open entries, when its person is an
 *   Admin of the project. `people` is the owner's alone.
 *
 * **What is never done here.** General access, public or restricted, is the
 * dashboard's Access section; the preview code is `sitesolide lock`. No
 * email is sent: the command prints the line to send, and a password once.
 *
 * The decisions are pure; the transports and the output are handed in.
 */
import type { Failure, Output } from "./remote";

export const ROLES = ["visitor", "viewer", "developer", "admin"] as const;
export type Role = (typeof ROLES)[number];

/** What a person reads for each role. */
export const ROLE_WORDS: Readonly<Record<Role, string>> = { visitor: "Can open", viewer: "Viewer", developer: "Developer", admin: "Admin" };

/**
 * The roles as the command takes and prints them: `can-open` for the first
 * rung, which the machine keeps as `visitor`; `visitor` is read too, the
 * name scripts written before may carry.
 */
export const ROLE_ARGUMENTS: Readonly<Record<string, Role>> = { "can-open": "visitor", visitor: "visitor", viewer: "viewer", developer: "developer", admin: "admin" };

/** A role as the command prints it in `--json` and takes it back: `can-open`, never `visitor`. */
export function roleName(role: Role): string {
  return role === "visitor" ? "can-open" : role;
}

/** The durations of password access the steward accepts, by what the command takes. */
export const DURATIONS: Readonly<Record<string, number | null>> = { "24h": 24 * 3600, "7d": 7 * 24 * 3600, "30d": 30 * 24 * 3600, never: null };

export const OWNER_SOCKET = "/run/sitesolide-steward-owner/owner.sock";

// --- what the steward answers, as far as the command reads it -----------------------

export type EntryView = {
  who: string;
  kind: "person" | "domain" | "password";
  role: Role;
  by: string;
  createdAt: number;
  updatedAt: number;
  password: { expiresAt: number | null; expired: boolean } | null;
};

export type AccessState = {
  slug: string;
  host: string;
  url: string;
  general: { access: "public" | "restricted" | "code"; modifiable: boolean; reason: string | null } | null;
  entries: EntryView[];
  signIn: { configured: boolean; allowedDomains: string[]; admins?: string[]; providerName?: string | null };
  portal?: { reading: string; writtenAt: number | null };
};

export type EntryAnswer = { entry: EntryView; change: "add" | "role" | "none" | "remove"; password?: string };

export type Reading<T> = { ok: true; value: T } | { ok: false; failure: Failure };

/** How `share` reaches the steward: over the owner's SSH, or through the control API. */
export type AccessTransport = {
  /** For the first line: "through https://dashboard.example.com", "over SSH, as the owner". */
  via: string;
  list: (slug: string) => Promise<Reading<AccessState>>;
  give: (slug: string, who: string, role: Role, expiresInS: number | null | undefined) => Promise<Reading<EntryAnswer>>;
  remove: (slug: string, who: string) => Promise<Reading<EntryAnswer>>;
};

// --- what was asked ----------------------------------------------------------------

/** The options `share` takes, and whether one carries a value. */
export const SHARE_OPTIONS: Readonly<Record<string, boolean>> = { "--role": true, "--expires": true, "--remove": true };

export const SHARE_USAGE = [
  "sitesolide share                 this project's general access and people with access",
  "   <email|@domain>...            give them access, Can open by default",
  "   --role <role>                 can-open, viewer, developer or admin",
  "   --expires <24h|7d|30d|never>  for password access, 7d by default",
  "   --remove <email|@domain>...   take their access away; a name given before, as it is listed",
];

export const PEOPLE_USAGE = [
  "sitesolide people                everyone with access, their roles, who may create projects",
  "   <email> --may-create          let them create projects, Admin of what they create",
  "   <email> --no-create           take that right back",
  "   --migrate-without-portal      when the portal's database does not read: carry the rest over without it",
];

export type ShareRequest =
  | { action: "list" }
  | { action: "give"; who: string[]; role: Role; expiresInS: number | null | undefined }
  | { action: "remove"; who: string[] };

function usage(message: string, details: string[]): Failure {
  return { error: "usage", message, details };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN = /^@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;


/**
 * An email or a `@domain`, lowercase, or why not. The steward judges it
 * again by the portal's own rules; this only catches a typo before anything
 * is sent. A bare domain is said to need its `@`.
 */
export function readWho(value: string): string | Failure {
  const text = value.trim().toLowerCase();
  if (EMAIL.test(text) && !text.startsWith("@")) return text;
  if (DOMAIN.test(text)) return text;
  if (DOMAIN.test(`@${text}`)) return { error: "invalid", message: `${value}: write a whole domain with its @, like @${text}; nothing was changed` };
  return { error: "invalid", message: `${value} is neither an email address nor a domain like @acme.com: nothing was changed` };
}

/** The request the arguments make, or what is wrong with them. Nothing is read or sent before this passes. */
export function readShareArguments(arguments_: string[]): ShareRequest | Failure {
  const rest = (arguments_[0] === "share" ? arguments_.slice(1) : arguments_).filter((argument) => argument !== "--json" && argument !== "--api");
  const who: string[] = [];
  let removing = false;
  let given = false;
  let role: Role | null = null;
  let expires: number | null | undefined;
  for (let i = 0; i < rest.length; i++) {
    const argument = rest[i]!;
    if (argument === "--remove") {
      if (given) return usage("give access or take it away, one command each: --remove comes before the addresses it takes away", SHARE_USAGE);
      removing = true;
      continue;
    }
    if (argument === "--role" || argument === "--expires") {
      const value = rest[i + 1];
      i++;
      if (value === undefined || value.startsWith("-")) {
        return usage(`${argument}: ${argument === "--role" ? "can-open, viewer, developer or admin" : "24h, 7d, 30d or never"} must follow`, SHARE_USAGE);
      }
      if (argument === "--role") {
        if (!Object.hasOwn(ROLE_ARGUMENTS, value)) return { error: "invalid", message: `${value} is not a role: can-open, viewer, developer or admin; nothing was changed` };
        role = ROLE_ARGUMENTS[value]!;
      } else {
        if (!Object.hasOwn(DURATIONS, value)) return { error: "invalid", message: `${value} is not a duration: 24h, 7d, 30d or never; nothing was changed` };
        expires = DURATIONS[value];
      }
      continue;
    }
    if (argument === "--domain" || argument === "--only-admins") {
      return usage(`${argument} is gone: write a domain as @acme.com, take people off with --remove, and choose who may open the site from the dashboard's General access`, SHARE_USAGE);
    }
    if (argument.startsWith("-")) return { error: "unknown-option", message: `${argument}: not an option of sitesolide share: nothing was changed`, details: SHARE_USAGE };
    let read = readWho(argument);
    // A name a password access was carried over under ("Client Bob", "Bob @
    // the agency") is taken away as it stands, and given never. One starting
    // with @ is a domain, typed wrong.
    if (typeof read !== "string" && removing && /^[\x20-\x7e]{1,254}$/.test(argument) && argument.trim() !== "" && !argument.trim().startsWith("@")) read = argument.trim();
    if (typeof read !== "string") return read;
    if (!removing) given = true;
    if (!who.includes(read)) who.push(read);
  }
  if (removing) {
    if (who.length === 0) return usage("--remove: an email address or a @domain must follow", SHARE_USAGE);
    if (role !== null || expires !== undefined) return usage("--remove takes access away: it takes no --role nor --expires", SHARE_USAGE);
    return { action: "remove", who };
  }
  if (who.length === 0) {
    if (role !== null || expires !== undefined) return usage(`${role !== null ? "--role" : "--expires"}: name who to give access to first`, SHARE_USAGE);
    return { action: "list" };
  }
  return { action: "give", who, role: role ?? "visitor", expiresInS: expires };
}

export type PeopleRequest = { action: "list" } | { action: "create"; email: string; create: boolean } | { action: "migrate" };

export function readPeopleArguments(arguments_: string[]): PeopleRequest | Failure {
  const rest = (arguments_[0] === "people" ? arguments_.slice(1) : arguments_).filter((argument) => argument !== "--json");
  if (rest.length === 0) return { action: "list" };
  if (rest.includes("--migrate-without-portal")) {
    if (rest.length !== 1) return usage("--migrate-without-portal takes nothing else", PEOPLE_USAGE);
    return { action: "migrate" };
  }
  let email: string | null = null;
  let create: boolean | null = null;
  for (const argument of rest) {
    if (argument === "--may-create" || argument === "--no-create") {
      if (create !== null) return usage("--may-create or --no-create, once", PEOPLE_USAGE);
      create = argument === "--may-create";
      continue;
    }
    if (argument.startsWith("-")) return { error: "unknown-option", message: `${argument}: not an option of sitesolide people: nothing was changed`, details: PEOPLE_USAGE };
    if (email !== null) return usage("one email at a time", PEOPLE_USAGE);
    const text = argument.trim().toLowerCase();
    if (!EMAIL.test(text)) return { error: "invalid", message: `${argument} is not an email address: nothing was changed` };
    email = text;
  }
  if (email === null) return usage("sitesolide people: the email must come before --may-create or --no-create", PEOPLE_USAGE);
  if (create === null) return usage(`sitesolide people ${email}: --may-create or --no-create must follow; their roles are given per project, with sitesolide share`, PEOPLE_USAGE);
  return { action: "create", email, create };
}

// --- what is shown -------------------------------------------------------------------

/** A date as a person reads it, in UTC. */
function day(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** `Can open, password access until 2026-10-14 10:00 UTC`. */
export function entryText(entry: EntryView): string {
  if (entry.password === null) return ROLE_WORDS[entry.role];
  const until = entry.password.expiresAt === null ? "with no expiry" : `${entry.password.expired ? "expired" : "until"} ${day(entry.password.expiresAt)}`;
  return `${ROLE_WORDS[entry.role]}, password access ${until}`;
}

const GENERAL: Readonly<Record<"public" | "restricted" | "code", string>> = {
  public: "Public: anyone opens it",
  restricted: "Restricted: only the people with access open it",
  code: "Anyone with the code: the preview code opens it, `sitesolide lock` sets it",
};

/** The line to send someone given access with an account: where to go, with what. */
export function accessMessage(state: AccessState): string | null {
  if (!state.signIn.configured) return null;
  const name = state.signIn.providerName ?? null;
  const account = name === null || name === "your work account" ? "your company account" : `your ${name} account`;
  return `Open ${state.url} and sign in with ${account}.`;
}

/** The project's access in lines, for a person. */
export function describeAccess(state: AccessState): string[] {
  const width = Math.max(10, ...state.entries.map((entry) => entry.who.length));
  const lines = [
    `   general access: ${state.general === null ? "not deployed: its people with access are kept, its site serves nothing" : GENERAL[state.general.access]}`,
    state.entries.length === 0 ? "   people with access: nobody yet" : "   people with access:",
    ...state.entries.map((entry) => `     ${entry.who.padEnd(width)}  ${entryText(entry)}`),
    "   also open it when restricted: the owner's password, and the admin emails (OIDC_ADMIN_EMAILS)",
  ];
  if (state.general?.access === "public" && state.entries.some((entry) => entry.role === "visitor")) {
    lines.push("   its general access is Public: Can open matters once it is Restricted, from the dashboard's Access section");
  }
  return lines;
}

/** Warnings about the machine itself: a portal that does not read the registry yet. */
export function accessWarnings(state: AccessState): string[] {
  const reading = state.portal?.reading;
  if (reading === "portal") return ["!! the portal on this machine still decides from its own tables: run sitesolide upgrade, which deploys it"];
  if (reading === "unreadable") return ["!! the portal cannot read who may open a site: only the owner's password and the admin emails open one; tell the owner of the machine (journalctl -u portal)"];
  return [];
}

/** An entry as `--json` prints it: its role named as the command takes it, `can-open` for the first rung. */
function printedEntry(entry: EntryView): Omit<EntryView, "role"> & { role: string } {
  return { ...entry, role: roleName(entry.role) };
}

/** Roles per project as `--json` prints them. */
function printedRoles(roles: Record<string, Role>): Record<string, string> {
  return Object.fromEntries(Object.entries(roles).map(([slug, role]) => [slug, roleName(role)]));
}

function resultFields(state: AccessState, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    slug: state.slug,
    url: state.url,
    general: state.general?.access ?? null,
    entries: state.entries.map(printedEntry),
    signIn: { configured: state.signIn.configured, allowedDomains: state.signIn.allowedDomains },
    message: accessMessage(state),
    ...extra,
  };
}

/**
 * The command: read, change each one asked, say. Returns the exit code,
 * never throws. A refusal for one person stops before the next: what was
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
    const message = accessMessage(before);
    if (message !== null && before.entries.some((entry) => entry.password === null && entry.kind === "person")) output.say(`   send: ${message}`);
    output.succeeded("share", resultFields(before, { changed: false }));
    return 0;
  }

  const changes: { who: string; change: string; role: string | null; password?: string }[] = [];
  for (const who of request.who) {
    const done = request.action === "give" ? await transport.give(slug, who, request.role, request.expiresInS) : await transport.remove(slug, who);
    if (!done.ok) {
      if (changes.length > 0) output.say(`   already done: ${changes.map((one) => one.who).join(", ")}`);
      output.failed(done.failure);
      return 1;
    }
    const { entry, change, password } = done.value;
    changes.push({ who: entry.who, change, role: change === "remove" ? null : roleName(entry.role), ...(password === undefined ? {} : { password }) });
    if (change === "remove") output.say(`-> ${entry.who} no longer has access to ${slug}: refused from their next request`);
    else if (change === "none") output.say(`   nothing to change: ${entry.who} already has ${entryText(entry)}`);
    else output.say(`-> ${entry.who}: ${entryText(entry)} on ${slug}${change === "role" ? ", from their next request" : ""}`);
    if (password !== undefined) {
      output.say(`   password for ${entry.who}: ${password}`);
      output.say("   shown once: send it to them yourself, with the address; the machine keeps only its hash");
    }
  }
  const after = await transport.list(slug);
  const state = after.ok ? after.value : before;
  for (const line of describeAccess(state)) output.say(line);
  const message = accessMessage(state);
  if (message !== null && request.action === "give" && changes.some((one) => one.password === undefined && one.change !== "none" && !one.who.startsWith("@"))) {
    output.say(`   send: ${message}`);
  }
  output.succeeded("share", resultFields(state, { changed: changes.some((one) => one.change !== "none"), changes }));
  return 0;
}

// --- people ----------------------------------------------------------------------------

export type PersonView = {
  who: string;
  roles: Record<string, Role>;
  create: boolean;
  passwords: { slug: string; expiresAt: number | null; expired: boolean }[];
  admin: boolean;
};

export type PeopleState = {
  people: PersonView[];
  domains: { slug: string; domain: string }[];
  signIn: { configured: boolean; allowedDomains: string[]; admins: string[] };
};

export type PeopleTransport = {
  list: () => Promise<Reading<PeopleState>>;
  setCreate: (email: string, create: boolean) => Promise<Reading<{ person: PersonView; change: string }>>;
  /** The registry made from members.json alone, the portal's database left out at the owner's word. */
  migrateWithoutPortal: () => Promise<Reading<{ people: number; projects: number }>>;
};

/** `alpha: Developer, beta: Admin; may create projects`. */
export function personText(person: PersonView): string {
  const roles = Object.entries(person.roles).sort(([a], [b]) => a.localeCompare(b));
  const parts = roles.map(([slug, role]) => {
    const password = person.passwords.find((one) => one.slug === slug);
    return password === undefined ? `${slug}: ${ROLE_WORDS[role]}` : `${slug}: ${ROLE_WORDS[role]}, password access ${password.expiresAt === null ? "with no expiry" : `${password.expired ? "expired" : "until"} ${day(password.expiresAt)}`}`;
  });
  const text = parts.length === 0 ? "no project" : parts.join(", ");
  const extra = [person.create ? "may create projects" : null, person.admin ? "admin email, opens every restricted site" : null].filter((one): one is string => one !== null);
  return extra.length === 0 ? text : `${text}; ${extra.join("; ")}`;
}

export function describePeople(state: PeopleState): string[] {
  const width = Math.max(10, ...state.people.map((person) => person.who.length));
  const lines =
    state.people.length === 0
      ? ["   nobody yet: sitesolide share <email> --role <role>, from a project's folder"]
      : state.people.map((person) => `   ${person.who.padEnd(width)}  ${personText(person)}`);
  if (state.domains.length > 0) lines.push(`   domains, Can open: ${state.domains.map((one) => `${one.slug}: ${one.domain}`).join(", ")}`);
  if (!state.signIn.configured) {
    lines.push("!! signing in with a company account is not set up on this machine: only password access opens a site, and nobody signs in to the dashboard but the owner (portal/README.md)");
  } else if (state.signIn.allowedDomains.length > 0) {
    lines.push(`   the company's domains: ${state.signIn.allowedDomains.join(", ")}; anyone else gets password access`);
  }
  return lines;
}

/** The command: read, change, say. Returns the exit code, never throws. */
export async function people(arguments_: string[], dashboardUrl: string, transport: PeopleTransport, output: Output): Promise<number> {
  const request = readPeopleArguments(arguments_);
  if ("error" in request) {
    output.failed(request);
    return 1;
  }
  if (request.action === "migrate") {
    const migrated = await transport.migrateWithoutPortal();
    if (!migrated.ok) {
      output.failed(migrated.failure);
      return 1;
    }
    output.say(`-> access carried over on ${dashboardUrl} without the portal's database: ${migrated.value.people} person(s) signing in to the dashboard, ${migrated.value.projects} project(s) with people`);
    output.say("   who could open which site, and password access, stay in the portal's database, read-only: give them again with sitesolide share");
    output.succeeded("people", { migrated: true, withoutPortal: true, people: migrated.value.people, projects: migrated.value.projects, changed: true });
    return 0;
  }
  const read = await transport.list();
  if (!read.ok) {
    output.failed(read.failure);
    return 1;
  }
  output.say(`-> people of ${dashboardUrl}, over SSH, as the owner`);
  if (request.action === "list") {
    for (const line of describePeople(read.value)) output.say(line);
    output.succeeded("people", { people: read.value.people.map((person) => ({ ...person, roles: printedRoles(person.roles) })), domains: read.value.domains, signIn: read.value.signIn, changed: false });
    return 0;
  }
  const set = await transport.setCreate(request.email, request.create);
  if (!set.ok) {
    output.failed(set.failure);
    return 1;
  }
  const { person, change } = set.value;
  output.say(
    change === "none"
      ? `   nothing to change: ${request.email} ${request.create ? "may already" : "may not"} create projects`
      : request.create
        ? `-> ${request.email} may create projects, Admin of each one they create: open ${dashboardUrl} and sign in with their company account`
        : `-> ${request.email} may no longer create projects`,
  );
  output.say(`   ${person.who}  ${personText(person)}`);
  output.succeeded("people", { email: request.email, create: person.create, roles: printedRoles(person.roles), change, changed: change !== "none" });
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
 * body. The address quoted: a `?` is a pattern to the remote shell.
 */
export function ownerReadCommand(path: "/people" | `/access?slug=${string}`): string {
  return `sudo curl -sS --max-time 30 -w '\\n%{http_code}\\n' ${SOCKET} 'http://steward${path}'`;
}

/** A change, the JSON body on standard input: no address of the request ever goes through a shell. */
export function ownerWriteCommand(method: "PUT" | "DELETE" | "POST", path: "/access/entry" | "/people/person" | "/access/migrate"): string {
  return `sudo curl -sS --max-time 30 -X ${method} -H 'Content-Type: application/json' --data-binary @- -w '\\n%{http_code}\\n' ${SOCKET} http://steward${path}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The steward's answer over SSH, or the failure in the command's words. */
async function askSteward(run: RunOnMachine, command: string, input?: string): Promise<Reading<Record<string, unknown>>> {
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
    return { ok: false, failure: { error: "steward-outdated", message: "the steward on the server does not keep people with access yet: run sitesolide upgrade first" } };
  }
  if (answer.status >= 400) {
    const code = typeof body.error === "string" ? body.error : "failure";
    return { ok: false, failure: { error: code, message: `${typeof body.message === "string" ? body.message : `refused (${answer.status})`}: nothing was changed` } };
  }
  return { ok: true, value: body };
}

function readAccess(body: Record<string, unknown>): AccessState | null {
  if (typeof body.slug !== "string" || typeof body.url !== "string" || !Array.isArray(body.entries) || !isObject(body.signIn)) return null;
  return body as unknown as AccessState;
}

function readEntry(body: Record<string, unknown>): EntryAnswer | null {
  if (!isObject(body.entry) || typeof body.change !== "string") return null;
  return body as unknown as EntryAnswer;
}

const unreadable = (what: string): { ok: false; failure: Failure } => ({ ok: false, failure: { error: "failure", message: `the steward's ${what} does not read: nothing was changed` } });

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
    async give(slug, who, role, expiresInS) {
      const read = await askSteward(run, ownerWriteCommand("PUT", "/access/entry"), JSON.stringify({ slug, who, role, ...(expiresInS === undefined ? {} : { expiresInS }) }));
      if (!read.ok) return read;
      const entry = readEntry(read.value);
      return entry === null ? unreadable("answer") : { ok: true, value: entry };
    },
    async remove(slug, who) {
      const read = await askSteward(run, ownerWriteCommand("DELETE", "/access/entry"), JSON.stringify({ slug, who }));
      if (!read.ok) return read;
      const entry = readEntry(read.value);
      return entry === null ? unreadable("answer") : { ok: true, value: entry };
    },
  };
}

/** The owner's transport for `people`. */
export function sshPeople(run: RunOnMachine): PeopleTransport {
  return {
    async list() {
      const read = await askSteward(run, ownerReadCommand("/people"));
      if (!read.ok) return read;
      const { people: listed, domains, signIn } = read.value;
      if (!Array.isArray(listed) || !Array.isArray(domains) || !isObject(signIn)) return unreadable("list of people");
      return { ok: true, value: read.value as unknown as PeopleState };
    },
    async setCreate(email, create) {
      const read = await askSteward(run, ownerWriteCommand("PUT", "/people/person"), JSON.stringify({ email, create }));
      if (!read.ok) return read;
      if (!isObject(read.value.person) || typeof read.value.change !== "string") return unreadable("answer");
      return { ok: true, value: read.value as unknown as { person: PersonView; change: string } };
    },
    async migrateWithoutPortal() {
      const read = await askSteward(run, ownerWriteCommand("POST", "/access/migrate"), JSON.stringify({ withoutPortal: true }));
      if (!read.ok) return read;
      const { people: counted, projects } = read.value;
      if (typeof counted !== "number" || typeof projects !== "number") return unreadable("answer");
      return { ok: true, value: { people: counted, projects } };
    },
  };
}
