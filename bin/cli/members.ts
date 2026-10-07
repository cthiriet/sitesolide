/**
 * `sitesolide members`: the people who sign in to the dashboard with their
 * work account, and their role on each project, from the owner's workstation.
 *
 *   sitesolide members                                          who, on what, and the line to send
 *   sitesolide members add <email> --project <slug> --role <role> [--project <slug> --role <role>]...
 *   sitesolide members add <email> --may-create                 grant the right to create projects
 *   sitesolide members remove <email>                           take them off, signed out at once
 *   sitesolide members remove <email> --project <slug>...       take those projects off them
 *   sitesolide members remove <email> --may-create              take the right to create projects back
 *
 * A role is `viewer`, `developer` or `admin`; each `--project` takes the
 * `--role` that follows it. `add` on someone already a member sets the roles
 * named and keeps their others. `--may-create` goes with either, beside
 * projects or alone: a member who may create projects mints a token of their
 * own that may, and becomes project admin of what it creates.
 *
 * **Over the owner's SSH, to the steward's owner socket.** The registry is the
 * steward's (dashboard/src/members/), which root alone may change without the
 * dashboard's unlock: its owner socket, `/run/sitesolide-steward-owner/owner.sock`,
 * only root opens. Root asks it on the machine with `curl`, as `sitesolide
 * share` asks the portal, the JSON body on standard input so that no address
 * goes through a shell. The steward judges everything: the address against the
 * portal's allowed domains, every project deployed and none of the platform's,
 * and it records the change in its journal under `owner`.
 *
 * **What is never done here.** No email is sent: the command prints the line
 * to send. A member's sessions are the steward's: removing someone signs them
 * out there, at their next request.
 *
 * The decisions are pure; the transport and the output are handed in.
 */
import type { Failure, Output } from "./remote";
import { readCurlAnswer, sharingReadCommand, type RunOnMachine } from "./sharing";

export const ROLES = ["viewer", "developer", "admin"] as const;
export type Role = (typeof ROLES)[number];
export type Roles = Record<string, Role>;

/** `create`: may they create projects. A steward from before the right says nothing of it. */
export type MemberView = { email: string; roles: Roles; create?: boolean; invitedBy: string; createdAt: number; updatedAt: number };
export type MembersList = { members: MemberView[]; signIn: { configured: boolean; allowedDomains: string[] } };

export const OWNER_SOCKET = "/run/sitesolide-steward-owner/owner.sock";

export const MEMBERS_USAGE = [
  "sitesolide members               who signs in to the dashboard, their roles, and the line to send",
  "   add <email> --project <slug> --role <viewer|developer|admin>",
  "                                 invite them, or set their role on these projects; repeat the pair",
  "   add <email> --may-create      let them create projects, project admin of what they create",
  "   remove <email>                take them off: signed out at once, their tokens revoked",
  "   remove <email> --project <slug>",
  "                                 take these projects off them, their other roles kept",
  "   remove <email> --may-create   take the right to create projects back",
];

/** `create`: true to grant the right to create projects, false to take it back, undefined to leave it. */
export type MembersRequest =
  | { action: "list" }
  | { action: "add"; email: string; roles: Roles; create?: true }
  | { action: "remove"; email: string; projects: string[]; create?: false };

function usage(message: string): Failure {
  return { error: "usage", message, details: MEMBERS_USAGE };
}

const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** The shape of an address: the steward cleans and judges it by the portal's own rule. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** The request the arguments make, or what is wrong with them. Nothing is read or sent before this passes. */
export function readMembersArguments(arguments_: string[]): MembersRequest | Failure {
  const rest = (arguments_[0] === "members" ? arguments_.slice(1) : arguments_).filter((argument) => argument !== "--json");
  const action = rest[0];
  if (action === undefined) return { action: "list" };
  if (action !== "add" && action !== "remove") {
    return action.startsWith("-") ? usage(`${action}: not an option of sitesolide members`) : usage(`${action}: not a members command, add or remove`);
  }
  const email = rest[1];
  if (email === undefined || email.startsWith("-")) return usage(`sitesolide members ${action}: the member's email must follow`);
  if (!EMAIL.test(email.trim())) return { error: "invalid", message: `${email} is not an email address: nothing was changed` };
  const address = email.trim().toLowerCase();

  const roles: Roles = {};
  const projects: string[] = [];
  let pending: string | null = null;
  let mayCreate = false;
  for (let i = 2; i < rest.length; i++) {
    const option = rest[i]!;
    const value = rest[i + 1];
    if (option === "--may-create") {
      if (pending !== null) return usage(`--project ${pending}: its --role must follow, before --may-create`);
      if (mayCreate) return usage("--may-create: named twice");
      mayCreate = true;
      continue;
    }
    if (option !== "--project" && option !== "--role") return usage(`${option}: not an option of sitesolide members ${action}`);
    if (value === undefined || value.startsWith("-")) return usage(`${option}: ${option === "--project" ? "a project's slug" : "viewer, developer or admin"} must follow`);
    i++;
    if (option === "--project") {
      if (!SLUG.test(value)) return { error: "invalid", message: `${value} is not a project slug: nothing was changed` };
      if (action === "remove") {
        projects.push(value);
        continue;
      }
      if (pending !== null) return usage(`--project ${pending}: give its --role before the next --project`);
      if (Object.hasOwn(roles, value)) return usage(`--project ${value}: named twice`);
      pending = value;
      continue;
    }
    if (action === "remove") return usage("--role: remove takes projects off, with no role");
    if (pending === null) return usage(`--role ${value}: give the --project it is for first`);
    if (!isRole(value)) return { error: "invalid", message: `${value} is not a role: viewer, developer or admin; nothing was changed` };
    roles[pending] = value;
    pending = null;
  }
  if (pending !== null) return usage(`--project ${pending}: its --role must follow`);
  if (action === "add") {
    if (Object.keys(roles).length === 0 && !mayCreate) return usage("sitesolide members add: give at least one --project and its --role, or --may-create");
    return mayCreate ? { action: "add", email: address, roles, create: true } : { action: "add", email: address, roles };
  }
  return mayCreate ? { action: "remove", email: address, projects, create: false } : { action: "remove", email: address, projects };
}

const ROLE_TEXT: Readonly<Record<Role, string>> = { viewer: "viewer", developer: "developer", admin: "project admin" };

/** `blog: developer, shop: viewer`. */
export function rolesText(roles: Roles): string {
  const entries = Object.entries(roles).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? "no project" : entries.map(([slug, role]) => `${slug}: ${ROLE_TEXT[role]}`).join(", ");
}

/** The roles, and the create right when held: `blog: developer; may create projects`. */
export function rightsText(roles: Roles, create: boolean | undefined): string {
  return create === true ? `${rolesText(roles)}; may create projects` : rolesText(roles);
}

/** The line to send someone invited: where to go, and with what. No email is sent. */
export function invitationLine(dashboardUrl: string, providerName: string | null): string {
  const account = providerName === null || providerName === "your work account" ? "your work account" : `your ${providerName} work account`;
  return `Open ${dashboardUrl} and sign in with ${account}.`;
}

/** The roles once `add` is applied to the current ones: those named set, the others kept. */
export function addedRoles(current: Roles, added: Roles): Roles {
  return { ...current, ...added };
}

/** The roles once `remove --project` is applied: those named taken off. Null when one is not theirs. */
export function removedRoles(current: Roles, projects: readonly string[]): { roles: Roles; absent: string[] } {
  const roles: Roles = { ...current };
  const absent: string[] = [];
  for (const slug of projects) {
    if (Object.hasOwn(roles, slug)) delete roles[slug];
    else absent.push(slug);
  }
  return { roles, absent };
}

// --- the transport ---------------------------------------------------------------

export type Answer = { ok: true; status: number; body: Record<string, unknown> } | { ok: false; failure: Failure };

/** How the command reaches the steward's members registry. */
export type MembersTransport = {
  list: () => Promise<Answer>;
  /** `create` undefined leaves the right as it stands. */
  put: (email: string, roles: Roles, create?: boolean) => Promise<Answer>;
  remove: (email: string) => Promise<Answer>;
  /** The provider's name, for the line to send; null when the portal does not say. */
  providerName: () => Promise<string | null>;
};

const STEWARD = `--unix-socket ${OWNER_SOCKET} http://steward`;

/** The registry read as root on the machine; the status on a line of its own after the body. */
export function membersReadCommand(): string {
  return `sudo curl -sS --max-time 10 -w '\\n%{http_code}\\n' ${STEWARD}/members`;
}

/** A change, the JSON body on standard input: no address of the request ever goes through a shell. */
export function membersWriteCommand(method: "PUT" | "DELETE"): string {
  return `sudo curl -sS --max-time 10 -X ${method} -H 'Content-Type: application/json' --data-binary @- -w '\\n%{http_code}\\n' ${STEWARD}/members/member`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The owner's transport: root on the machine asks the steward's owner socket. */
export function sshMembers(run: RunOnMachine): MembersTransport {
  async function ask(command: string, input?: string): Promise<Answer> {
    const done = await run(command, input);
    if (done.code === 255) {
      return { ok: false, failure: { error: "ssh-failed", message: "cannot reach the server over SSH: nothing was changed", details: [done.error.trim() || "no message"] } };
    }
    if (done.code !== 0) {
      // curl's 7: no socket. A steward from before members, or one whose unit
      // has no owner's socket yet.
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
      return { ok: false, failure: { error: "steward-outdated", message: "the steward on the server does not know members yet: run sitesolide upgrade first" } };
    }
    if (answer.status >= 400) {
      // The steward's own `not-found`, for a member, is no project of a token's.
      const code = typeof body.error !== "string" ? "failure" : body.error === "not-found" ? "not-a-member" : body.error;
      return { ok: false, failure: { error: code, message: `${typeof body.message === "string" ? body.message : `refused (${answer.status})`}: nothing was changed` } };
    }
    return { ok: true, status: answer.status, body };
  }

  return {
    list: () => ask(membersReadCommand()),
    put: (email, roles, create) => ask(membersWriteCommand("PUT"), JSON.stringify(create === undefined ? { email, roles } : { email, roles, create })),
    remove: (email) => ask(membersWriteCommand("DELETE"), JSON.stringify({ email })),
    async providerName() {
      const listed = await run(sharingReadCommand());
      if (listed.code !== 0) return null;
      const answer = readCurlAnswer(listed.output);
      if (answer === null || answer.status !== 200) return null;
      try {
        const body = JSON.parse(answer.body) as { sso?: { configured?: unknown; providerName?: unknown } };
        return body.sso?.configured === true && typeof body.sso.providerName === "string" ? body.sso.providerName : null;
      } catch {
        return null;
      }
    },
  };
}

function readList(body: Record<string, unknown>): MembersList | null {
  const { members, signIn } = body;
  if (!Array.isArray(members) || !isObject(signIn) || typeof signIn.configured !== "boolean" || !Array.isArray(signIn.allowedDomains)) return null;
  for (const member of members) {
    if (!isObject(member) || typeof member.email !== "string" || !isObject(member.roles)) return null;
  }
  return { members: members as MemberView[], signIn: { configured: signIn.configured, allowedDomains: signIn.allowedDomains as string[] } };
}

/** The registry in lines, for a person. */
export function describeMembers(list: MembersList, line: string): string[] {
  const lines =
    list.members.length === 0
      ? ["   nobody yet: sitesolide members add <email> --project <slug> --role viewer"]
      : list.members.map((member) => `   ${member.email}  ${rightsText(member.roles, member.create)}`);
  if (!list.signIn.configured) {
    lines.push("!! signing in with a work account is not set up on this machine: members cannot sign in until the portal has an identity provider (portal/README.md)");
  } else if (list.members.length > 0) {
    lines.push(`   send: ${line}`);
  }
  return lines;
}

/**
 * The command: read, compute, write, say. Returns the exit code, never throws.
 * `dashboardUrl` is `https://dashboard.<zone>`, the address the line names.
 */
export async function members(arguments_: string[], dashboardUrl: string, transport: MembersTransport, output: Output): Promise<number> {
  const request = readMembersArguments(arguments_);
  if ("error" in request) {
    output.failed(request);
    return 1;
  }
  const read = await transport.list();
  if (!read.ok) {
    output.failed(read.failure);
    return 1;
  }
  const list = readList(read.body);
  if (list === null) {
    output.failed({ error: "failure", message: "the steward's members list does not read: nothing was changed" });
    return 1;
  }
  const line = invitationLine(dashboardUrl, await transport.providerName());
  output.say(`-> members of ${dashboardUrl}, over SSH, as the owner`);

  if (request.action === "list") {
    for (const one of describeMembers(list, line)) output.say(one);
    output.succeeded("members", { members: list.members, signIn: list.signIn, message: list.signIn.configured ? line : null, changed: false });
    return 0;
  }

  const current = list.members.find((member) => member.email === request.email) ?? null;

  if (request.action === "remove" && request.projects.length === 0 && request.create === undefined) {
    if (current === null) {
      output.failed({ error: "not-a-member", message: `${request.email} is not a member: nothing was changed` });
      return 1;
    }
    const removed = await transport.remove(request.email);
    if (!removed.ok) {
      output.failed(removed.failure);
      return 1;
    }
    output.say(`-> ${request.email} removed: signed out of the dashboard, their tokens revoked, refused at their next request`);
    output.succeeded("members", { email: request.email, removed: true, roles: current.roles, changed: true });
    return 0;
  }

  let roles: Roles;
  if (request.action === "remove") {
    if (current === null) {
      output.failed({ error: "not-a-member", message: `${request.email} is not a member: nothing was changed` });
      return 1;
    }
    const next = removedRoles(current.roles, request.projects);
    if (next.absent.length > 0) output.say(`!! ${next.absent.join(", ")}: not among their projects, nothing to take off`);
    roles = next.roles;
  } else {
    roles = addedRoles(current?.roles ?? {}, request.roles);
  }

  if (request.create === true && current === null && Object.keys(request.roles).length === 0) {
    // Someone new with the create right alone: a member who sees nothing yet, until they create.
    output.say(`   ${request.email} holds no project yet: they may create one with a token of their own`);
  }
  const put = await transport.put(request.email, roles, request.create);
  if (!put.ok) {
    output.failed(put.failure);
    return 1;
  }
  const change = put.body.change === "invite" || put.body.change === "role" ? put.body.change : "none";
  const member = isObject(put.body.member) ? (put.body.member as MemberView) : null;
  const saved = member?.roles ?? roles;
  const create = member?.create ?? request.create ?? current?.create;
  output.say(
    change === "invite"
      ? `-> ${request.email} invited: ${rightsText(saved, create)}`
      : change === "role"
        ? `-> ${request.email}: ${rightsText(saved, create)}`
        : `   nothing to change: ${request.email} already holds ${rightsText(saved, create)}`,
  );
  if (change === "invite") {
    if (list.signIn.configured) output.say(`   send: ${line}`);
    else output.say("!! signing in with a work account is not set up on this machine: they cannot sign in until the portal has an identity provider (portal/README.md)");
  }
  output.succeeded("members", { email: request.email, roles: saved, create: create === true, change, message: list.signIn.configured ? line : null, changed: change !== "none" });
  return 0;
}
