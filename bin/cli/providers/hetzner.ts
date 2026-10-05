/**
 * Hetzner Cloud, through its API: what infra/main.tf created with Terraform,
 * without Terraform. https://docs.hetzner.cloud/reference/cloud
 *
 * A machine is three resources, each labelled `managed-by=sitesolide` and
 * `sitesolide-machine=<name>`:
 *
 *   - the workstation's SSH key, reused when the project already holds it
 *     under any name, uploaded otherwise;
 *   - a firewall named after the machine, inbound TCP 22, 80 and 443 and ICMP
 *     from everywhere, as main.tf had it;
 *   - the server, with both public addresses, the key and the firewall, and no
 *     user_data: `sitesolide setup` hardens it over SSH, which a run can be
 *     repeated against, where cloud-init only ever ran once.
 *
 * Everything that can refuse is read before the first write, so that a
 * refusal leaves nothing behind: the server, by name (one sitesolide did not
 * create is never touched), the type and the location against what Hetzner
 * sells there (a refusal that lists the cheapest types of the location says
 * more than the API's 422), and the firewall's name.
 *
 * Every call carries the token in the Authorization header and nowhere else,
 * follows no redirect, and fails with a ProviderError whose code
 * bin/cli/hints.ts knows. The API's own error format is
 * `{"error": {"code", "message", "details"}}`; `failureFrom` reads it.
 *
 * Lists are paginated: `meta.pagination.next_page` is followed until it is
 * null, fifty items a page, the most the API returns. Actions are polled every
 * two seconds through GET /actions/{id}, bounded: the project may make 3600
 * requests an hour, given back one a second.
 */
import {
  formatPrice,
  isManaged,
  labelsFor,
  MANAGED_LABEL,
  MANAGED_VALUE,
  MACHINE_LABEL,
  ProviderError,
  type CreateOutcome,
  type CreateRequest,
  type DestroyOutcome,
  type Machine,
  type Provider,
  type ProviderContext,
  type ProviderEntry,
  type Report,
  type Resource,
} from "./provider";
import type { Failure } from "../remote";

export const DEFAULT_API = "https://api.hetzner.cloud/v1";

/** The API's address, for tests against a local fake: https, or http on the loopback only. */
export const API_VARIABLE = "SITESOLIDE_HETZNER_API";

/** How long each wait lasts at most, and how often it asks. */
export const WAITS = {
  actionMs: 10 * 60_000,
  runningMs: 5 * 60_000,
  pollMs: 2_000,
  /** A firewall still marked in use a moment after its server went. */
  firewallTries: 5,
};

/** Every rule allows these sources, as main.tf did, ssh_allowed_from's default included. */
const EVERYWHERE = ["0.0.0.0/0", "::/0"];

export const FIREWALL_RULES = [
  { direction: "in", protocol: "tcp", port: "22", source_ips: EVERYWHERE, description: "ssh" },
  { direction: "in", protocol: "tcp", port: "80", source_ips: EVERYWHERE, description: "http" },
  { direction: "in", protocol: "tcp", port: "443", source_ips: EVERYWHERE, description: "https" },
  // Ping serves diagnosis and external monitoring.
  { direction: "in", protocol: "icmp", source_ips: EVERYWHERE, description: "ping" },
];

// --- the API's objects, as far as this file reads them ---------------------------------

type Price = { location: string; price_monthly: { net: string; gross: string } };
type Deprecation = { unavailable_after: string; announced: string } | null;

export type HetznerAction = {
  id: number;
  command: string;
  status: "running" | "success" | "error";
  progress: number;
  error: { code: string; message: string } | null;
};

export type HetznerServer = {
  id: number;
  name: string;
  status: string;
  public_net: {
    /** `id` is the Primary IP's, a resource of its own. */
    ipv4: { id?: number; ip: string } | null;
    ipv6: { id?: number; ip: string } | null;
    firewalls?: { id: number; status: string }[];
  };
  server_type: { name: string; prices?: Price[] };
  location?: { name: string };
  /** Before the API moved the location onto the server, it lived here. */
  datacenter?: { location?: { name: string } };
  labels: Record<string, string>;
  /** Null while backups are off. */
  backup_window: string | null;
};

export type HetznerServerType = {
  id: number;
  name: string;
  cores: number;
  memory: number;
  disk: number;
  architecture?: string;
  cpu_type?: string;
  prices: Price[];
  deprecation?: Deprecation;
  /** Where the type is sold, and whether it is right now; absent from older answers, where `prices` says where. */
  locations?: { name: string; available?: boolean; deprecation?: Deprecation }[];
};

type HetznerLocation = { name: string; city?: string; country?: string };
type HetznerKey = { id: number; name: string; fingerprint: string; public_key: string; labels: Record<string, string> };
type HetznerFirewall = {
  id: number;
  name: string;
  labels: Record<string, string>;
  applied_to: { type: string; server?: { id: number }; label_selector?: { selector: string } }[];
};

// --- reading the API's answers ----------------------------------------------------------

/** A failure of the API, its HTTP status and its own code kept for the callers that tell them apart. */
export class HetznerError extends ProviderError {
  constructor(
    failure: Failure,
    readonly status: number,
    readonly code: string,
  ) {
    super(failure);
  }
}

/** The codes a wait shrugs off until its deadline: they say "later", not "no". */
const TRANSIENT = new Set(["provider-rate-limited", "provider-failure", "provider-unreachable", "provider-busy"]);

/** `invalid_input` names the fields it refused, and why. */
function fieldDetails(details: unknown): string[] {
  const fields = (details as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) return [];
  return fields.map((field) => {
    const { name, messages } = field as { name?: unknown; messages?: unknown };
    const said = Array.isArray(messages) ? messages.map(String).join(", ") : "";
    return `${String(name ?? "field")}${said === "" ? "" : `: ${said}`}`;
  });
}

/**
 * An error answer of the API as a failure the CLI reports, with the code its
 * hint is found by. `what` says what was being done, in the infinitive, for
 * the message: `create the server web`. `now` in milliseconds, for the rate
 * limit's reset, which the API gives as a UNIX timestamp.
 */
export function failureFrom(status: number, body: unknown, headers: Headers, what: string, now: number): HetznerError {
  const error = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
  const code = typeof error?.code === "string" ? error.code : "";
  const said = typeof error?.message === "string" ? error.message : `answered ${status}`;
  const fields = fieldDetails(error?.details);
  const answer = `${status}${code === "" ? "" : ` ${code}`}`;
  const make = (failure: Failure) => new HetznerError(failure, status, code);

  if (status === 401) {
    return make({
      error: "provider-unauthenticated",
      message: `Hetzner refused the token (${answer}): it is unknown, revoked, or was copied wrong`,
      details: ["a token belongs to one project: create one in that project's Security > API tokens, with Read & Write"],
    });
  }
  if (status === 403 && code === "resource_limit_exceeded") {
    return make({ error: "provider-limit", message: `Hetzner refused to ${what} (${answer}): ${said}`, details: ["the project has reached one of its limits, listed in the Hetzner console under the project's Limits"] });
  }
  if (status === 403 && code === "maintenance") {
    return make({ error: "provider-unavailable", message: `Hetzner could not ${what} (${answer}): ${said}` });
  }
  if (status === 403) {
    return make({
      error: "provider-forbidden",
      message: `the token may not ${what} (${answer}): ${said}`,
      details: ["a Read only token can list but neither create nor delete: the token needs Read & Write"],
    });
  }
  if (status === 404) return make({ error: "provider-not-found", message: `Hetzner could not ${what} (${answer}): ${said}` });
  if (status === 409 && code === "uniqueness_error") {
    return make({ error: "provider-name-taken", message: `Hetzner refused to ${what} (${answer}): ${said}`, details: fields });
  }
  if (status === 409 || status === 423) return make({ error: "provider-busy", message: `Hetzner could not ${what} right now (${answer}): ${said}` });
  if (status === 412) return make({ error: "provider-unavailable", message: `Hetzner could not ${what} (${answer}): ${said}` });
  if (status === 429) {
    const reset = Number(headers.get("RateLimit-Reset"));
    const untilReset = Number.isFinite(reset) && reset > 0 ? Math.max(0, Math.ceil(reset - now / 1000)) : null;
    const retryAfter = Number(headers.get("Retry-After"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : Math.min(60, Math.max(1, untilReset ?? 60));
    const limit = headers.get("RateLimit-Limit");
    return make({
      error: "provider-rate-limited",
      message: `Hetzner's rate limit is reached, nothing more can be asked of it for now (${answer})`,
      details: [
        `the project may make ${limit ?? "3600"} requests an hour, given back gradually`,
        ...(untilReset === null ? [] : [`all of them are back in ${untilReset} s`]),
      ],
      wait,
    });
  }
  if (status >= 500) return make({ error: "provider-failure", message: `Hetzner failed to ${what} (${answer}): ${said}`, details: ["the failure is on Hetzner's side"] });
  return make({ error: "provider-invalid", message: `Hetzner refused to ${what} (${answer}): ${said}`, details: fields });
}

/** The API's address from the environment, or why it is refused. */
export function apiBase(environment: Record<string, string | undefined>): string {
  const raw = environment[API_VARIABLE]?.trim() || DEFAULT_API;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError({ error: "provider-endpoint", message: `${API_VARIABLE} is not an address` });
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ProviderError({ error: "provider-endpoint", message: `${API_VARIABLE}: the token only leaves over https, or over http to the loopback` });
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new ProviderError({ error: "provider-endpoint", message: `${API_VARIABLE} carries more than an address` });
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

// --- what the answers mean -------------------------------------------------------------------

/** `2001:db8::/64` -> `2001:db8::1`, the address Hetzner's images configure; null when it cannot tell. */
export function hostAddress(network: string | null): string | null {
  if (network === null) return null;
  const prefix = network.split("/")[0] ?? "";
  return prefix.endsWith("::") ? `${prefix}1` : null;
}

function locationOf(server: HetznerServer): string {
  return server.location?.name ?? server.datacenter?.location?.name ?? "unknown";
}

export function toMachine(server: HetznerServer, currency: string | null): Machine {
  const network = server.public_net?.ipv6?.ip ?? null;
  const location = locationOf(server);
  const price = server.server_type?.prices?.find((entry) => entry.location === location)?.price_monthly;
  return {
    provider: "hetzner",
    id: String(server.id),
    name: server.name,
    type: server.server_type?.name ?? "unknown",
    location,
    status: server.status,
    ipv4: server.public_net?.ipv4?.ip ?? null,
    ipv6: hostAddress(network),
    ipv6Network: network,
    monthlyPrice: price === undefined ? null : { net: price.net, gross: price.gross, currency },
    backups: server.backup_window !== null && server.backup_window !== undefined,
    managed: isManaged(server.labels),
    labels: server.labels ?? {},
  };
}

/** Whether a type can be ordered at a location, and a warning when it can but is on its way out. */
export function typeOffer(type: HetznerServerType, location: string, now: number): { orderable: boolean; reason: string; warning: string | null } {
  const entry = type.locations?.find((candidate) => candidate.name === location);
  const sold = type.locations === undefined ? type.prices.some((price) => price.location === location) : entry !== undefined;
  if (!sold) return { orderable: false, reason: `${type.name} is not sold at ${location}`, warning: null };
  if (entry?.available === false) return { orderable: false, reason: `${type.name} is temporarily unavailable at ${location}`, warning: null };
  const deprecation = entry?.deprecation ?? type.deprecation ?? null;
  if (deprecation !== null) {
    const until = Date.parse(deprecation.unavailable_after);
    if (Number.isFinite(until) && until <= now) return { orderable: false, reason: `${type.name} is no longer sold at ${location}`, warning: null };
    return { orderable: true, reason: "", warning: `${type.name} is deprecated at ${location}, sold until ${deprecation.unavailable_after.slice(0, 10)}` };
  }
  return { orderable: true, reason: "", warning: null };
}

function monthlyNet(type: HetznerServerType, location: string): number {
  const price = type.prices.find((entry) => entry.location === location)?.price_monthly.net;
  return price === undefined ? Number.POSITIVE_INFINITY : Number(price);
}

/** The cheapest types one can order at a location, not deprecated, one line each, cheapest first. */
export function cheapestTypes(types: HetznerServerType[], location: string, now: number, currency: string | null, count = 6): string[] {
  return types
    .filter((type) => {
      const offer = typeOffer(type, location, now);
      return offer.orderable && offer.warning === null;
    })
    .sort((a, b) => monthlyNet(a, location) - monthlyNet(b, location) || a.name.localeCompare(b.name))
    .slice(0, count)
    .map((type) => {
      const price = monthlyNet(type, location);
      const cost = Number.isFinite(price) ? `, ${formatPrice(price, currency)}` : "";
      return `${type.name.padEnd(8)} ${type.cores} vCPU, ${type.memory} GB RAM, ${type.disk} GB disk${type.architecture === undefined ? "" : `, ${type.architecture}`}${cost}`;
    });
}

/** The key itself, without its comment: two copies of a key compare equal through it. */
function keyMaterial(line: string): string {
  return line.trim().split(/\s+/).slice(0, 2).join(" ");
}

/** Where a firewall applies besides the server `except`. */
function appliedElsewhere(firewall: HetznerFirewall, except: number): string[] {
  const elsewhere: string[] = [];
  for (const target of firewall.applied_to ?? []) {
    if (target.type === "server" && target.server !== undefined && target.server.id !== except) elsewhere.push(`server ${target.server.id}`);
    if (target.type === "label_selector") elsewhere.push(`the servers matching ${target.label_selector?.selector ?? "a label selector"}`);
  }
  return elsewhere;
}

// --- the provider ---------------------------------------------------------------------------

export function hetzner(context: ProviderContext): Provider {
  const base = apiBase(context.environment);
  const host = new URL(base).host;
  const { clock, fetcher, token } = context;

  /** One call: the token in its header, JSON both ways, every failure said in the CLI's words. */
  async function call<T>(method: string, path: string, what: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method,
        redirect: "error",
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      // The message of a failed fetch names the address at most; it is
      // scrubbed all the same, on the way out, by bin/cli/machine.ts.
      throw new HetznerError({ error: "provider-unreachable", message: `${host} unreachable while trying to ${what}: ${(error as Error).message}` }, 0, "");
    }
    if (response.status === 204) return {} as T;
    let parsed: unknown = null;
    let readable = true;
    try {
      parsed = await response.json();
    } catch {
      readable = false;
    }
    // A proxy in front of the API may answer a 502 or a 429 in HTML: still
    // Hetzner saying "later". Anything else that is not JSON is not its API.
    const later = response.status >= 500 || response.status === 429;
    if (!readable && !later) {
      throw new HetznerError(
        { error: "provider-unreadable", message: `${host} answered ${response.status} with something that is not Hetzner's API, while trying to ${what}` },
        response.status,
        "",
      );
    }
    if (!response.ok) throw failureFrom(response.status, parsed, response.headers, what, clock.now());
    return parsed as T;
  }

  /** Every page of a list, following `meta.pagination.next_page`. */
  async function listAll<T>(path: string, key: string, what: string, query: Record<string, string> = {}): Promise<T[]> {
    const items: T[] = [];
    let page: number | null = 1;
    for (let pages = 0; page !== null && pages < 500; pages++) {
      const parameters = new URLSearchParams({ ...query, page: String(page), per_page: "50" });
      const answer: Record<string, unknown> = await call<Record<string, unknown>>("GET", `${path}?${parameters}`, what);
      const list = answer[key];
      if (!Array.isArray(list)) {
        throw new HetznerError({ error: "provider-unreadable", message: `${host} answered without the list of ${key}, while trying to ${what}` }, 200, "");
      }
      items.push(...(list as T[]));
      const next: unknown = (answer.meta as { pagination?: { next_page?: unknown } } | undefined)?.pagination?.next_page;
      page = typeof next === "number" && next > page ? next : null;
    }
    return items;
  }

  /** The project's currency, for prices; null when the pricing cannot be read, which stops nothing. */
  let currencyRead: Promise<string | null> | null = null;
  function currency(): Promise<string | null> {
    currencyRead ??= call<{ pricing?: { currency?: unknown } }>("GET", "/pricing", "read the prices").then(
      (answer) => (typeof answer.pricing?.currency === "string" ? answer.pricing.currency : null),
      () => null,
    );
    return currencyRead;
  }

  async function findServer(name: string): Promise<HetznerServer | null> {
    const servers = await listAll<HetznerServer>("/servers", "servers", "read the servers", { name });
    return servers.find((server) => server.name === name) ?? null;
  }

  /**
   * A call made while waiting: a failure that says "later" is tolerated until
   * the deadline, once warned; any other ends the wait.
   */
  async function patiently<T>(attempt: () => Promise<T>, deadline: number, report: Report, warned: { done: boolean }): Promise<T | null> {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof ProviderError) || !TRANSIENT.has(error.failure.error) || clock.now() >= deadline) throw error;
      if (!warned.done) report(`!! ${error.failure.message}: still waiting`);
      warned.done = true;
      return null;
    }
  }

  async function waitForAction(action: HetznerAction, report: Report): Promise<void> {
    const deadline = clock.now() + WAITS.actionMs;
    const warned = { done: false };
    let current = action;
    let shown = -1;
    for (;;) {
      if (current.status === "success") {
        report(`   ${current.command}: done`);
        return;
      }
      if (current.status === "error") {
        throw new ProviderError({
          error: "action-failed",
          message: `Hetzner's ${current.command} failed: ${current.error?.message ?? "no reason given"}`,
          details: [`action ${current.id}${current.error?.code === undefined ? "" : `, ${current.error.code}`}`],
        });
      }
      if (current.progress !== shown) {
        report(`   ${current.command}: ${current.progress} %`);
        shown = current.progress;
      }
      if (clock.now() >= deadline) {
        throw new ProviderError({
          error: "machine-timeout",
          message: `Hetzner's ${current.command} still runs after ${WAITS.actionMs / 60_000} minutes`,
          details: [`action ${current.id}, ${current.progress} %`],
        });
      }
      await clock.sleep(WAITS.pollMs);
      const id = current.id;
      const read = await patiently(() => call<{ action: HetznerAction }>("GET", `/actions/${id}`, `follow ${current.command}`), deadline, report, warned);
      if (read !== null) current = read.action;
    }
  }

  async function waitRunning(id: number, name: string, report: Report, justCreated: boolean): Promise<HetznerServer> {
    const deadline = clock.now() + WAITS.runningMs;
    const warned = { done: false };
    let last = "";
    for (;;) {
      const read = await patiently(() => call<{ server: HetznerServer }>("GET", `/servers/${id}`, `read the server ${name}`), deadline, report, warned);
      if (read !== null) {
        const server = read.server;
        if (server.status !== last) report(`   status: ${server.status}`);
        last = server.status;
        if (server.status === "running") return server;
        if (server.status === "off" && !justCreated) {
          throw new ProviderError({ error: "machine-off", message: `${name} exists but is powered off`, details: ["sitesolide never powers a machine on or off by itself"] });
        }
      }
      if (clock.now() >= deadline) {
        throw new ProviderError({ error: "machine-timeout", message: `${name} is still not running after ${WAITS.runningMs / 60_000} minutes`, details: [`last status: ${last || "unread"}`] });
      }
      await clock.sleep(WAITS.pollMs);
    }
  }

  async function checkOffer(request: CreateRequest, report: Report): Promise<void> {
    report(`-> ${request.type} at ${request.location}, what Hetzner sells there`);
    const locations = await listAll<HetznerLocation>("/locations", "locations", "read the locations");
    if (!locations.some((location) => location.name === request.location)) {
      throw new ProviderError({
        error: "invalid-location",
        message: `${request.location} is not a Hetzner location`,
        details: ["the locations:", ...locations.map((location) => `${location.name.padEnd(6)} ${[location.city, location.country].filter(Boolean).join(", ")}`)],
      });
    }
    const types = await listAll<HetznerServerType>("/server_types", "server_types", "read the server types");
    const chosen = types.find((type) => type.name === request.type);
    const offer = chosen === undefined ? { orderable: false, reason: `${request.type} is not a Hetzner server type`, warning: null } : typeOffer(chosen, request.location, clock.now());
    if (chosen === undefined || !offer.orderable) {
      const cheapest = cheapestTypes(types, request.location, clock.now(), await currency());
      throw new ProviderError({
        error: "invalid-server-type",
        message: offer.reason,
        details: cheapest.length === 0 ? [`no type can be ordered at ${request.location} right now`] : [`the cheapest types sold at ${request.location}:`, ...cheapest],
      });
    }
    if (offer.warning !== null) report(`!! ${offer.warning}`);
    const price = monthlyNet(chosen, request.location);
    report(`   ${chosen.cores} vCPU, ${chosen.memory} GB RAM, ${chosen.disk} GB disk${Number.isFinite(price) ? `, ${formatPrice(price, await currency())}` : ""}`);
  }

  async function ensureKey(request: CreateRequest, report: Report): Promise<HetznerKey & { reused: boolean }> {
    report("-> SSH key");
    const keys = await listAll<HetznerKey>("/ssh_keys", "ssh_keys", "read the SSH keys");
    const ours = `${request.key.algorithm} ${request.key.blob}`;
    const same = keys.find((key) => key.fingerprint === request.key.fingerprint || keyMaterial(key.public_key) === ours);
    if (same !== undefined) {
      report(`   ${same.name}, already in the project (${request.key.fingerprint}), reused`);
      return { ...same, reused: true };
    }
    // A name of its own, never one the project already uses for another key.
    const taken = new Set(keys.map((key) => key.name));
    const plain = `sitesolide-${request.name}`;
    const name = taken.has(plain) ? `${plain}-${request.key.fingerprint.replaceAll(":", "").slice(0, 8)}` : plain;
    const line = [request.key.algorithm, request.key.blob, request.key.comment].filter((part) => part !== "").join(" ");
    const created = await call<{ ssh_key: HetznerKey }>("POST", "/ssh_keys", `upload the SSH key ${name}`, { name, public_key: line, labels: labelsFor(request.name) });
    report(`   ${name}, uploaded (${request.key.fingerprint})`);
    return { ...created.ssh_key, reused: false };
  }

  /** The firewall of that name, when sitesolide created it; read before anything is created, so that a refusal leaves nothing. */
  async function findFirewall(name: string): Promise<HetznerFirewall | null> {
    const firewalls = await listAll<HetznerFirewall>("/firewalls", "firewalls", "read the firewalls");
    const same = firewalls.find((firewall) => firewall.name === name);
    if (same !== undefined && !isManaged(same.labels)) {
      throw new ProviderError({
        error: "firewall-taken",
        message: `a firewall named ${name} exists in the project, and sitesolide did not create it`,
        details: [`it lacks the label ${MANAGED_LABEL}=${MANAGED_VALUE}: it is never adopted nor changed`],
      });
    }
    return same ?? null;
  }

  async function ensureFirewall(name: string, found: HetznerFirewall | null, report: Report): Promise<HetznerFirewall & { reused: boolean }> {
    report(`-> firewall ${name}`);
    if (found !== null) {
      report("   already created by sitesolide, reused");
      return { ...found, reused: true };
    }
    const created = await call<{ firewall: HetznerFirewall; actions?: HetznerAction[] }>("POST", "/firewalls", `create the firewall ${name}`, {
      name,
      labels: labelsFor(name),
      rules: FIREWALL_RULES,
    });
    for (const action of created.actions ?? []) await waitForAction(action, report);
    report("   created: inbound tcp 22, 80, 443 and icmp, from everywhere");
    return { ...created.firewall, reused: false };
  }

  async function ensureBackups(server: HetznerServer, report: Report): Promise<void> {
    report("-> backups");
    if (server.backup_window !== null && server.backup_window !== undefined) {
      report("   already enabled");
      return;
    }
    const answer = await call<{ action: HetznerAction }>("POST", `/servers/${server.id}/actions/enable_backup`, `enable the backups of ${server.name}`);
    await waitForAction(answer.action, report);
    report("   enabled: one image a day, seven kept, about 20 % on the price of the machine");
  }

  return {
    name: "hetzner",

    async find(name) {
      const server = await findServer(name);
      return server === null ? null : toMachine(server, await currency());
    },

    async create(request, report): Promise<CreateOutcome> {
      const resources: Resource[] = [];
      report(`-> a server named ${request.name} in the project`);
      const existing = await findServer(request.name);
      let server: HetznerServer;
      let created: boolean;
      if (existing !== null) {
        const found = toMachine(existing, null);
        if (!found.managed) {
          throw new ProviderError({
            error: "machine-exists",
            message: `a server named ${request.name} exists in the project, and sitesolide did not create it`,
            details: [
              `${found.type} at ${found.location}, ${found.status}, ${[found.ipv4, found.ipv6].filter(Boolean).join(", ") || "no public address"}`,
              `it lacks the label ${MANAGED_LABEL}=${MANAGED_VALUE}: nothing was created, nothing was changed`,
            ],
          });
        }
        report(`   already created by sitesolide: ${found.type} at ${found.location}, ${found.status}`);
        if (found.type !== request.type || found.location !== request.location) {
          report(`!! it is ${found.type} at ${found.location}: --type and --location only apply to a machine being created`);
        }
        server = existing;
        created = false;
        resources.push({ kind: "server", name: existing.name, id: String(existing.id), reused: true });
      } else {
        report("   none of that name yet");
        await checkOffer(request, report);
        const existingFirewall = await findFirewall(request.name);
        const key = await ensureKey(request, report);
        resources.push({ kind: "ssh key", name: key.name, id: String(key.id), reused: key.reused });
        const firewall = await ensureFirewall(request.name, existingFirewall, report);
        resources.push({ kind: "firewall", name: firewall.name, id: String(firewall.id), reused: firewall.reused });

        report(`-> server ${request.name}: ${request.type} at ${request.location}, ${request.image}`);
        const answer = await call<{ server: HetznerServer; action: HetznerAction; next_actions?: HetznerAction[] }>("POST", "/servers", `create the server ${request.name}`, {
          name: request.name,
          server_type: request.type,
          location: request.location,
          image: request.image,
          ssh_keys: [key.id],
          firewalls: [{ firewall: firewall.id }],
          public_net: { enable_ipv4: true, enable_ipv6: true },
          labels: labelsFor(request.name),
          start_after_create: true,
        });
        server = answer.server;
        created = true;
        resources.push({ kind: "server", name: server.name, id: String(server.id), reused: false });
        report(`   ordered, id ${server.id}`);
        // The server is locked while it is created and started: backups wait for both.
        for (const action of [answer.action, ...(answer.next_actions ?? [])]) await waitForAction(action, report);
      }
      if (request.backups) await ensureBackups(server, report);
      report(`-> ${request.name} running`);
      const running = await waitRunning(server.id, request.name, report, created);
      return { machine: toMachine(running, await currency()), created, resources };
    },

    async list() {
      const servers = await listAll<HetznerServer>("/servers", "servers", "read the servers", { label_selector: `${MANAGED_LABEL}=${MANAGED_VALUE}` });
      const unit = servers.length === 0 ? null : await currency();
      return servers.filter((server) => isManaged(server.labels)).map((server) => toMachine(server, unit));
    },

    async destroy(machine, options, report): Promise<DestroyOutcome> {
      const removed: string[] = [];
      const kept: string[] = [];
      const id = Number(machine.id);
      const addresses = [machine.ipv4, machine.ipv6].filter(Boolean).join(", ");

      report(`-> server ${machine.name}`);
      // Its addresses are Primary IPs of their own, billed while they exist:
      // created with the server, they go with it, which is checked after.
      const before = await call<{ server: HetznerServer }>("GET", `/servers/${id}`, `read the server ${machine.name}`);
      const primaryIps = [before.server.public_net?.ipv4, before.server.public_net?.ipv6].filter((ip): ip is { id: number; ip: string } => typeof ip?.id === "number");
      const deletion = await call<{ action?: HetznerAction }>("DELETE", `/servers/${id}`, `delete the server ${machine.name}`);
      if (deletion.action !== undefined) await waitForAction(deletion.action, report);
      removed.push(`server ${machine.name}${addresses === "" ? "" : ` (${addresses})`}`);
      for (const address of primaryIps) {
        try {
          await call("GET", `/primary_ips/${address.id}`, `read the primary IP ${address.ip}`);
          kept.push(`primary IP ${address.ip}: Hetzner kept it after the server, and bills it until it is deleted from the console`);
          report(`!! primary IP ${address.ip} outlived the server: delete it from the console, or it stays billed`);
        } catch (error) {
          if (!(error instanceof HetznerError) || error.status !== 404) report(`!! could not check that the primary IP ${address.ip} went with the server: look in the console`);
        }
      }

      report(`-> firewall ${machine.name}`);
      const firewalls = await listAll<HetznerFirewall>("/firewalls", "firewalls", "read the firewalls");
      const firewall = firewalls.find((candidate) => candidate.name === machine.name && isManaged(candidate.labels));
      if (firewall === undefined) {
        report("   none created by sitesolide under that name");
      } else {
        const elsewhere = appliedElsewhere(firewall, id);
        if (elsewhere.length > 0) {
          kept.push(`firewall ${firewall.name}: still applied to ${elsewhere.join(", ")}`);
          report(`   kept: still applied to ${elsewhere.join(", ")}`);
        } else {
          // Hetzner may still count the deleted server for a moment.
          for (let attempt = 1; ; attempt++) {
            try {
              await call("DELETE", `/firewalls/${firewall.id}`, `delete the firewall ${firewall.name}`);
              removed.push(`firewall ${firewall.name}`);
              report("   deleted");
              break;
            } catch (error) {
              if (!(error instanceof HetznerError) || error.code !== "resource_in_use") throw error;
              if (attempt >= WAITS.firewallTries) {
                kept.push(`firewall ${firewall.name}: Hetzner still says it is in use`);
                report("   kept: Hetzner still says it is in use; delete it from the console once it is free");
                break;
              }
              await clock.sleep(WAITS.pollMs);
            }
          }
        }
      }

      report("-> SSH key");
      const keys = await listAll<HetznerKey>("/ssh_keys", "ssh_keys", "read the SSH keys", {
        label_selector: `${MANAGED_LABEL}=${MANAGED_VALUE},${MACHINE_LABEL}=${machine.name}`,
      });
      if (keys.length === 0) report(`   none was uploaded for ${machine.name}: the key it used was already in the project`);
      for (const key of keys) {
        if (options.deleteKey) {
          await call("DELETE", `/ssh_keys/${key.id}`, `delete the SSH key ${key.name}`);
          removed.push(`SSH key ${key.name}`);
          report(`   ${key.name}: deleted`);
        } else {
          kept.push(`SSH key ${key.name}: other machines may be created with it; --delete-key deletes it`);
          report(`   ${key.name}: kept, other machines may be created with it`);
        }
      }
      return { removed, kept };
    },
  };
}

/** The token is read from HCLOUD_TOKEN, as the hcloud CLI and the Terraform provider read it. */
export const HETZNER: ProviderEntry = {
  title: "Hetzner",
  tokenVariable: "HCLOUD_TOKEN",
  tokenHelp: [
    "create it in the Hetzner console: the project, Security, API tokens, with Read & Write",
    "a project of its own for sitesolide keeps the token away from everything else you run at Hetzner",
  ],
  open: hetzner,
};
