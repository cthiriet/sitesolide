/**
 * `sitesolide share`: who may open a project behind the portal with their work
 * account, changed from the project's folder the way a Google Doc is shared.
 *
 *   sitesolide share                          the policy, and the line to send
 *   sitesolide share alice@acme.com ...       add people
 *   sitesolide share --domain acme.com        everyone at a domain
 *   sitesolide share --remove alice@acme.com  take a person, or a domain, off
 *   sitesolide share --only-admins            back to the admins alone
 *
 * The policy itself is the portal's (portal/README.md, "Sharing"): a mode,
 * `admins`, `people` or `domain`, and two lists kept whatever the mode. The
 * command reads it, computes the next one from what was asked, and replaces
 * it whole, as the dashboard's Sharing section does.
 *
 * **Two ways to the portal, one command.**
 *
 * - A team token goes through the dashboard's control API, `GET` and `PUT
 *   /api/v1/projects/<slug>/sharing` (remote.ts builds that transport). The
 *   dashboard relays to the portal as its Sharing section does, under the
 *   token's name, and lets a token open a site only to the domains the portal
 *   already admits at sign-in, never to the public.
 * - The owner goes over SSH, as for every other command of theirs: root on the
 *   machine asks the portal's admin API on the loopback,
 *   `127.0.0.1:3026/admin/sharing`, which the loopback rule leaves to root,
 *   Caddy and the dashboard, and which portal/README.md already reads by hand
 *   with `sudo curl`. Before anything changes it reads, on the machine, that
 *   the site's manifest asks for the portal and that its block in service
 *   carries it: the check the dashboard makes against its snapshot. It never
 *   touches Caddy, nor the dashboard, nor anything but the portal's database,
 *   through the portal itself.
 *
 * **What is never done here.** Making a site public, which is turning its
 * portal off: the owner's, from the dashboard's Access section. Guest
 * passwords: the dashboard's Guests section, which shows the password once.
 *
 * The rules of an email and a domain are the portal's own, imported from
 * portal/src/sharing.ts, pure and without imports: the command refuses an
 * address with the exact rule the portal applies. bin/ runs on the
 * workstation, where the whole repository is, so the import holds.
 *
 * The decisions are pure; the two transports and the output are handed in.
 */
import { cleanDomain, cleanEmail, DOMAINS_MAX, PEOPLE_MAX, type Policy } from "../../portal/src/sharing";
import { readDepositedManifest, readManifestsCommand } from "./portal-vm";
import { fragmentIsProtected, PORTAL_PORT } from "./portal";
import type { Failure, Output } from "./remote";
import { MARKER_ABSENT, MARKER_PRESENT, readUnitAnswer } from "./unit";

export type { Policy };

/** What the command knows of a project's sharing: the control API's `ProjectSharing`, whichever way it came. */
export type SharingState = {
  slug: string;
  host: string;
  url: string;
  policy: Policy;
  updatedAt: number | null;
  sso: { configured: boolean; providerName: string | null };
  /** The domains the portal admits at sign-in; empty, anyone its provider vouches for. */
  allowedDomains: string[];
};

export type SharingReading = { ok: true; state: SharingState } | { ok: false; failure: Failure };

/** How the command reaches the portal: through the control API, or over the owner's SSH. */
export type SharingTransport = {
  /** For the first line: "through https://dashboard.example.com", "over SSH, as the owner". */
  via: string;
  read: (slug: string) => Promise<SharingReading>;
  write: (state: SharingState, policy: Policy) => Promise<SharingReading>;
};

// --- what was asked --------------------------------------------------------------

/** The options `share` takes, and whether one carries a value. */
export const SHARE_OPTIONS: Readonly<Record<string, boolean>> = { "--domain": true, "--remove": true, "--only-admins": false };

export type ShareRequest = {
  people: string[];
  domains: string[];
  remove: { people: string[]; domains: string[] };
  onlyAdmins: boolean;
};

export const SHARE_USAGE = [
  "sitesolide share                who may open this project with their work account, and the line to send",
  "   <email>...                   share it with these people",
  "   --domain <domain>            with everyone at this domain",
  "   --remove <email|domain>      take a person or a domain off",
  "   --only-admins                back to the admins alone",
];

function usage(message: string): Failure {
  return { error: "usage", message, details: SHARE_USAGE };
}

/** The request the arguments make, or what is wrong with them. Nothing is read or sent before this passes. */
export function readShareArguments(arguments_: string[]): ShareRequest | Failure {
  const rest = arguments_[0] === "share" ? arguments_.slice(1) : arguments_;
  const request: ShareRequest = { people: [], domains: [], remove: { people: [], domains: [] }, onlyAdmins: false };
  for (let i = 0; i < rest.length; i++) {
    const argument = rest[i]!;
    if (argument === "--json" || argument === "--api") continue;
    if (argument === "--only-admins") {
      request.onlyAdmins = true;
      continue;
    }
    if (argument === "--domain" || argument === "--remove") {
      const value = rest[i + 1];
      i++;
      if (value === undefined || value.startsWith("-")) {
        return usage(`${argument}: ${argument === "--domain" ? "a domain, like acme.com" : "an email address or a domain"} must follow`);
      }
      if (argument === "--domain") {
        const domain = cleanDomain(value);
        if (domain === null) return { error: "invalid", message: `${value} is not a domain the portal accepts, like acme.com: nothing was changed` };
        request.domains.push(domain);
      } else if (value.includes("@")) {
        const email = cleanEmail(value);
        if (email === null) return { error: "invalid", message: `${value} is not an email address the portal accepts: nothing was changed` };
        request.remove.people.push(email);
      } else {
        const domain = cleanDomain(value);
        if (domain === null) return { error: "invalid", message: `${value} is neither an email address nor a domain: nothing was changed` };
        request.remove.domains.push(domain);
      }
      continue;
    }
    if (argument.startsWith("-")) {
      return { error: "unknown-option", message: `${argument}: not an option of sitesolide share: nothing was changed`, details: SHARE_USAGE };
    }
    const email = cleanEmail(argument);
    if (email === null) {
      const domain = cleanDomain(argument);
      return {
        error: "invalid",
        message:
          domain === null
            ? `${argument} is not an email address the portal accepts: nothing was changed`
            : `${argument} is not an email address: to share with everyone at a domain, use --domain ${domain}; nothing was changed`,
      };
    }
    request.people.push(email);
  }
  if (request.onlyAdmins && (request.people.length > 0 || request.domains.length > 0)) {
    return usage("--only-admins takes the site back to the admins alone: it cannot be combined with people or --domain");
  }
  return request;
}

/** Was anything asked beyond reading? */
export function asksChange(request: ShareRequest): boolean {
  return request.onlyAdmins || request.people.length + request.domains.length + request.remove.people.length + request.remove.domains.length > 0;
}

// --- the next policy -----------------------------------------------------------------

/** Who a policy lets in beyond the admins: its people unless admins only, its domains in domain mode only. */
export function inEffect(policy: Policy): { people: string[]; domains: string[] } {
  return { people: policy.mode === "admins" ? [] : policy.people, domains: policy.mode === "domain" ? policy.domains : [] };
}

export type NextPolicy = {
  policy: Policy;
  /** Kept in a list from an earlier sharing, and let in again by the mode this change switches to. */
  reopened: string[];
  /** Asked to be removed, and in neither list. */
  absent: string[];
  /** The lists over the portal's limits. */
  tooMany: string | null;
};

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/**
 * The policy once the request is applied to the current one.
 *
 * Adding people to a site open to the admins alone switches it to `people`;
 * adding a domain switches it to `domain`; `--only-admins` goes back to
 * `admins`. The lists are kept whatever the mode, as the portal keeps them,
 * which is why a switch can let back in someone shared with earlier: that is
 * said, never done silently. Last, a mode left with nothing to apply to is
 * narrowed to the one that lets in exactly the same people, so that what is
 * shown is what holds: `domain` without a domain is `people`, `people` without
 * anyone is `admins`.
 */
export function nextPolicy(current: Policy, request: ShareRequest): NextPolicy {
  const people = new Set(current.people);
  const domains = new Set(current.domains);
  const absent: string[] = [];
  for (const email of request.remove.people) {
    if (!people.delete(email)) absent.push(email);
  }
  for (const domain of request.remove.domains) {
    if (!domains.delete(domain)) absent.push(domain);
  }
  for (const email of request.people) people.add(email);
  for (const domain of request.domains) domains.add(domain);

  let mode = current.mode;
  if (request.onlyAdmins) mode = "admins";
  else if (request.domains.length > 0) mode = "domain";
  else if (request.people.length > 0 && mode === "admins") mode = "people";
  if (mode === "domain" && domains.size === 0) mode = "people";
  if (mode === "people" && people.size === 0) mode = "admins";

  const policy: Policy = { mode, people: sorted(people), domains: sorted(domains) };
  const before = inEffect(current);
  const after = inEffect(policy);
  const asked = new Set([...request.people, ...request.domains]);
  const reopened = [
    ...after.people.filter((email) => !before.people.includes(email) && !asked.has(email)),
    ...after.domains.filter((domain) => !before.domains.includes(domain) && !asked.has(domain)),
  ];
  const tooMany =
    policy.people.length > PEOPLE_MAX
      ? `${policy.people.length} people: the portal keeps ${PEOPLE_MAX} at most, share with a domain instead`
      : policy.domains.length > DOMAINS_MAX
        ? `${policy.domains.length} domains: the portal keeps ${DOMAINS_MAX} at most`
        : null;
  return { policy, reopened, absent, tooMany };
}

export function samePolicy(a: Policy, b: Policy): boolean {
  return a.mode === b.mode && a.people.join(",") === b.people.join(",") && a.domains.join(",") === b.domains.join(",");
}

// --- what is shown ---------------------------------------------------------------------

const MODE_TEXT: Readonly<Record<Policy["mode"], string>> = {
  admins: "the admins alone",
  people: "the people listed, and the admins",
  domain: "everyone at the domains listed, the people listed, and the admins",
};

/**
 * The line to send to the people the site is shared with: where to go, and
 * with what. Nothing in it opens the site; they still sign in, and get in only
 * if the policy lets them. null while signing in with a work account is not
 * set up: there is nothing they could sign in with.
 */
export function shareMessage(state: SharingState): string | null {
  if (!state.sso.configured) return null;
  const name = state.sso.providerName;
  const account = name === null || name === "your work account" ? "your work account" : `your ${name} work account`;
  return `Open ${state.url} and sign in with ${account}.`;
}

/** The policy in lines, for a person: who gets in, and the line to send once someone beyond the admins does. */
export function describeSharing(state: SharingState): string[] {
  const { policy } = state;
  const effect = inEffect(policy);
  const keptPeople = policy.people.filter((email) => !effect.people.includes(email));
  const keptDomains = policy.domains.filter((domain) => !effect.domains.includes(domain));
  const message = shareMessage(state);
  return [
    `   who gets in: ${MODE_TEXT[policy.mode]}`,
    ...(effect.domains.length > 0 ? [`   domains: ${effect.domains.join(", ")}`] : []),
    ...(effect.people.length > 0 ? [`   people: ${effect.people.join(", ")}`] : []),
    ...(keptPeople.length + keptDomains.length > 0 ? [`   kept for later, not in effect: ${[...keptDomains, ...keptPeople].join(", ")}`] : []),
    "   the admins: the owner's password, the admin emails, and guests with a password",
    ...(message === null || policy.mode === "admins" ? [] : [`   send: ${message}`]),
  ];
}

/** Warnings worth a line before the change: who it lets in that was not asked for, who cannot sign in at all. */
export function shareWarnings(state: SharingState, next: NextPolicy): string[] {
  const warnings: string[] = [];
  if (next.reopened.length > 0) {
    warnings.push(`!! let in again, kept from an earlier sharing: ${next.reopened.join(", ")}; take them off with --remove`);
  }
  if (next.absent.length > 0) warnings.push(`!! ${next.absent.join(", ")}: not in the policy, nothing to remove`);
  if (!state.sso.configured && next.policy.mode !== "admins") {
    warnings.push("!! signing in with a work account is not set up on this machine: until the owner sets it up (portal/README.md), only passwords open the site");
  }
  const allowed = state.allowedDomains;
  if (allowed.length > 0) {
    const outside = inEffect(next.policy).people.filter((email) => !allowed.includes(email.slice(email.lastIndexOf("@") + 1)));
    if (outside.length > 0) warnings.push(`!! ${outside.join(", ")} cannot sign in: the portal admits only ${allowed.join(", ")}, unless they are admins`);
  }
  return warnings;
}

/** What the `result` event carries. */
function resultFields(state: SharingState, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    slug: state.slug,
    url: state.url,
    policy: state.policy,
    inEffect: inEffect(state.policy),
    updatedAt: state.updatedAt,
    signIn: state.sso,
    allowedDomains: state.allowedDomains,
    message: shareMessage(state),
    ...extra,
  };
}

/**
 * The command: read, compute, replace, say. Returns the exit code, never
 * throws. Nothing is written when the request changes nothing.
 */
export async function share(arguments_: string[], slug: string, transport: SharingTransport, output: Output): Promise<number> {
  const request = readShareArguments(arguments_);
  if ("error" in request) {
    output.failed(request);
    return 1;
  }
  const read = await transport.read(slug);
  if (!read.ok) {
    output.failed(read.failure);
    return 1;
  }
  const current = read.state;
  output.say(`-> sharing of ${slug}, ${current.url}, ${transport.via}`);

  if (!asksChange(request)) {
    for (const line of describeSharing(current)) output.say(line);
    if (!current.sso.configured) output.say("!! signing in with a work account is not set up on this machine: only passwords open the site for now (portal/README.md)");
    output.succeeded("share", resultFields(current, { changed: false }));
    return 0;
  }

  const next = nextPolicy(current.policy, request);
  if (next.tooMany !== null) {
    output.failed({ error: "invalid", message: `${next.tooMany}: nothing was changed` });
    return 1;
  }
  for (const warning of shareWarnings(current, next)) output.say(warning);
  if (samePolicy(next.policy, current.policy)) {
    output.say("   nothing to change: the policy already says so");
    for (const line of describeSharing(current)) output.say(line);
    output.succeeded("share", resultFields(current, { changed: false }));
    return 0;
  }

  output.say(`-> replace the policy: ${MODE_TEXT[current.policy.mode]} -> ${MODE_TEXT[next.policy.mode]}`);
  const written = await transport.write(current, next.policy);
  if (!written.ok) {
    output.failed(written.failure);
    return 1;
  }
  for (const line of describeSharing(written.state)) output.say(line);
  output.say("   holds from their next request; the portal records the change in its audit");
  output.succeeded("share", resultFields(written.state, { changed: true, previous: current.policy }));
  return 0;
}

// --- the owner's way: over SSH, to the portal on the loopback ------------------------

/** What a command run on the machine leaves. */
export type Execution = { code: number; output: string; error: string };

/** A command on the machine over the owner's SSH, `input` on its standard input. */
export type RunOnMachine = (command: string, input?: string) => Promise<Execution>;

const PORTAL_SHARING = `http://127.0.0.1:${PORTAL_PORT}/admin/sharing`;

/** The portal's host names, as the portal judges them: a name that becomes a URL path, never anything a shell reads. */
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The portal's policies and sign-in settings, read as root on the loopback.
 * `-w` writes the status on a line of its own after the body: a 404, a portal
 * from before sharing, reads apart from a refusal.
 */
export function sharingReadCommand(): string {
  return `sudo curl -sS --max-time 10 -w '\\n%{http_code}\\n' ${PORTAL_SHARING}`;
}

/** A site's policy replaced, the JSON body on standard input: no address of the list ever goes through a shell. */
export function sharingWriteCommand(host: string): string {
  if (!HOST.test(host)) throw new Error(`not a host: ${host}`);
  return `sudo curl -sS --max-time 10 -X PUT -H 'Content-Type: application/json' --data-binary @- -w '\\n%{http_code}\\n' ${PORTAL_SHARING}/${host}`;
}

/** The block in service, read with markers, as `deploy` reads it. */
export function blockReadCommand(slug: string): string {
  const path = `/etc/caddy/sites/${slug}.caddy`;
  return `if sudo test -f ${path}; then echo ${MARKER_PRESENT}; sudo cat ${path}; else echo ${MARKER_ABSENT}; fi`;
}

/** curl's answer: the body, then the status on the last line. null when it is not that. */
export function readCurlAnswer(output: string): { status: number; body: string } | null {
  const text = output.endsWith("\n") ? output.slice(0, -1) : output;
  const cut = text.lastIndexOf("\n");
  const status = text.slice(cut + 1);
  if (!/^[0-9]{3}$/.test(status)) return null;
  return { status: Number(status), body: cut === -1 ? "" : text.slice(0, cut) };
}

const sshFailed = (what: string, execution: Execution): Failure => ({
  error: "ssh-failed",
  message: `cannot ${what} on the server over SSH: nothing was changed`,
  details: [execution.error.trim() || "no message"],
});

const portalUnreachable = (execution: Execution): Failure => ({
  error: "portal-unreachable",
  message: "the portal does not answer on the server: nothing was changed",
  details: [execution.error.trim() || "no message", "check it on the server: systemctl status portal"],
});

const portalTooOld: Failure = {
  error: "not-available",
  message: "the portal on the server does not know sharing yet: deploy it from this release first, cd portal && sitesolide deploy --force (portal/README.md)",
};

function portalUnreadable(status: number): Failure {
  return { error: "failure", message: `the portal answered ${status} with something this CLI cannot read: nothing was changed` };
}

type PortalList = { sso: { configured: boolean; providerName: string | null; allowedDomains: string[] }; sites: { host: string; policy: Policy; updatedAt: number }[] };

function isPolicy(value: unknown): value is Policy {
  if (typeof value !== "object" || value === null) return false;
  const { mode, people, domains } = value as Record<string, unknown>;
  const list = (entries: unknown) => Array.isArray(entries) && entries.every((entry) => typeof entry === "string");
  return (mode === "admins" || mode === "people" || mode === "domain") && list(people) && list(domains);
}

function readPortalList(body: string): PortalList | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { sso, sites } = parsed as Record<string, unknown>;
  if (typeof sso !== "object" || sso === null || !Array.isArray(sites)) return null;
  const view = sso as Record<string, unknown>;
  const allowed = view.allowedDomains;
  if (typeof view.configured !== "boolean" || !Array.isArray(allowed) || !allowed.every((entry) => typeof entry === "string")) return null;
  const read: PortalList["sites"] = [];
  for (const site of sites as unknown[]) {
    const { host, policy, updatedAt } = (site ?? {}) as Record<string, unknown>;
    if (typeof host !== "string" || !isPolicy(policy) || typeof updatedAt !== "number") return null;
    read.push({ host, policy, updatedAt });
  }
  return { sso: { configured: view.configured, providerName: typeof view.providerName === "string" ? view.providerName : null, allowedDomains: allowed as string[] }, sites: read };
}

function stateOf(slug: string, host: string, list: PortalList): SharingState {
  const found = list.sites.find((site) => site.host === host);
  return {
    slug,
    host,
    url: `https://${host}/`,
    policy: found?.policy ?? { mode: "admins", people: [], domains: [] },
    updatedAt: found?.updatedAt ?? null,
    sso: { configured: list.sso.configured, providerName: list.sso.providerName },
    allowedDomains: list.sso.allowedDomains,
  };
}

/**
 * The owner's transport. `zone` names the site's host, `<slug>.<zone>`, the
 * one Caddy announces to the portal for it: a site behind the portal has no
 * other, a `domain` and the portal being refused together.
 */
export function sshSharing(run: RunOnMachine, zone: string): SharingTransport {
  return {
    via: "over SSH, as the owner",

    async read(slug) {
      const host = `${slug}.${zone}`;
      if (!HOST.test(host)) return { ok: false, failure: { error: "invalid", message: `${host} is not a host name the portal accepts` } };

      // The door, read on the machine as the dashboard reads it in its
      // snapshot: the manifest asks for the portal, and the block carries it.
      const manifests = await run(readManifestsCommand(slug));
      if (manifests.code !== 0) return { ok: false, failure: sshFailed(`read the manifest of ${slug}`, manifests) };
      const deposited = readDepositedManifest(manifests.output, slug);
      if (deposited.kind === "unreadable") return { ok: false, failure: { ...sshFailed(`read the manifest of ${slug}`, manifests), details: [deposited.reason] } };
      if (deposited.kind === "absent") return { ok: false, failure: { error: "no-portal", message: `${slug} is not deployed on the server: deploy it behind the portal, then share it` } };
      if (!deposited.portal) {
        return { ok: false, failure: { error: "no-portal", message: `${slug} is not behind the portal: everyone gets in already; put it behind the portal from the dashboard's Access section first` } };
      }
      const block = await run(blockReadCommand(slug));
      const fragment = block.code === 0 ? readUnitAnswer(block.output) : { kind: "unreadable" as const };
      if (fragment.kind === "unreadable") return { ok: false, failure: sshFailed(`read the Caddy block of ${slug}`, block) };
      if (fragment.kind === "absent" || !fragmentIsProtected(fragment.content)) {
        return { ok: false, failure: { error: "no-portal", message: `${slug} asks for the portal, but its block in service does not carry it: run sitesolide deploy in this folder, then share it` } };
      }

      const listed = await run(sharingReadCommand());
      if (listed.code === 255) return { ok: false, failure: sshFailed("ask the portal", listed) };
      if (listed.code !== 0) return { ok: false, failure: portalUnreachable(listed) };
      const answer = readCurlAnswer(listed.output);
      if (answer === null) return { ok: false, failure: portalUnreadable(0) };
      if (answer.status === 404) return { ok: false, failure: portalTooOld };
      const list = answer.status === 200 ? readPortalList(answer.body) : null;
      if (list === null) return { ok: false, failure: portalUnreadable(answer.status) };
      return { ok: true, state: stateOf(slug, host, list) };
    },

    async write(state, policy) {
      const body = JSON.stringify({ mode: policy.mode, people: policy.people, domains: policy.domains });
      const written = await run(sharingWriteCommand(state.host), body);
      if (written.code === 255) return { ok: false, failure: sshFailed("ask the portal", written) };
      if (written.code !== 0) return { ok: false, failure: portalUnreachable(written) };
      const answer = readCurlAnswer(written.output);
      if (answer === null) return { ok: false, failure: portalUnreadable(0) };
      if (answer.status === 404) return { ok: false, failure: portalTooOld };
      let saved: Record<string, unknown> | null = null;
      try {
        saved = JSON.parse(answer.body) as Record<string, unknown>;
      } catch {
        saved = null;
      }
      if (answer.status === 400) {
        return { ok: false, failure: { error: "invalid", message: `the portal refused this policy (${String(saved?.error ?? "no reason given")}): nothing was changed` } };
      }
      if (answer.status !== 200 || saved === null || !isPolicy(saved.policy) || typeof saved.updatedAt !== "number") {
        return { ok: false, failure: portalUnreadable(answer.status) };
      }
      return { ok: true, state: { ...state, policy: saved.policy, updatedAt: saved.updatedAt } };
    },
  };
}
