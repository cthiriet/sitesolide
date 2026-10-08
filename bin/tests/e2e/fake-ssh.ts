/**
 * A fake ssh, laid at the head of the PATH by fake-vm.ts: what the tests
 * put in place of the machine that serves the clients.
 *
 * It only answers the tests' host, `sample@invalid.local`, and only the
 * commands it recognises word for word: the empty connection of
 * bin/deploy-caddy.sh, the reading of the deposited manifests, the lock shared
 * with the gatekeeper, the fingerprints, the list of the blocks in service,
 * and a deposited manifest or a unit, read as `deploy --compare` reads them.
 * **All the rest is refused**, writes included, and recorded: a code path that
 * forgot the dry run mode fails loudly instead of speaking to anything at all,
 * and the test reads the log back to make sure that not a single write was
 * even attempted.
 *
 * The reading of the manifests and the lock are not imitated: the script that
 * the CLI would send really runs, on the simulated VM's tree. It is that
 * script, and not a copy of its output, that the tests put to the test.
 *
 * The settings a test lays in the VM's folder are named by `SWITCHES`:
 *
 * - `accept`: the writes are recorded as `ACCEPTED <command>` and succeed
 *   without executing anything, except those that contain a line from
 *   `refuse`. That is what lets a real deployment go as far as the lock;
 * - `pause`: the command whose log line is this content waits for the file to
 *   disappear, after having recorded `PAUSE <line>`. `<line>#2` only aims at
 *   its second occurrence. That is what makes it possible to interrupt a
 *   gesture at a chosen place;
 * - `on-first-accepted.json`: `{ path, content }`, written into the VM at
 *   the first accepted write, then forgotten. It is the gatekeeper acting
 *   while a deployment is running;
 * - `answers.json`: pairs of `[pattern, output]`; an accepted command that
 *   contains the pattern prints the output, like a unit of the gatekeeper in
 *   progress;
 * - `system-units.json`: `{ <unit>: <file> }`, the units systemd knows from
 *   elsewhere than /etc/systemd/system, as a package's own;
 * - `access.json`: the steward's access registry, which `share` and `people`
 *   ask on the steward's owner socket, see `AccessRegistry`: answered from
 *   there, and changed there by an accepted write, judged by the steward's
 *   rules as far as the tests need them;
 * - `accounts`: the static accounts the machine carries, one passwd line each,
 *   which the reading of an account answers from; an accepted `useradd` adds
 *   its account there, so that the next reading finds it.
 *
 * `sitesolide setup`'s scripts, `sh -s <tag>` with the script on standard
 * input, are writes like any other: refused, or accepted and answered from
 * `answers.json`, their input read and never recorded.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readManifestsCommand, readManifestsScript } from "../../cli/portal-vm";
import {
  lockCommand,
  RUN_DIR,
  takeScript,
  releaseScript,
  takeoverScript,
  checkScript,
  type Who,
} from "../../cli/caddy-lock";
import { MARKER_ABSENT, MARKER_PRESENT } from "../../cli/unit";
import { GENERATOR_MARK, loopbackStateCommand, MARKER_DONE, unitOriginsCommand } from "../../cli/services";
import { egressStateCommand, EGRESS_MARKER } from "../../cli/egress";
import { ownerReadCommand, ownerWriteCommand, type EntryView, type PersonView, type Role } from "../../cli/access";
import { ownershipReleaseCommand } from "../../cli/removal";

export const TEST_HOST = "sample@invalid.local";

/** The files a test lays in the VM's folder to steer this fake ssh. */
export const SWITCHES = {
  accept: "accept",
  refuse: "refuse",
  pause: "pause",
  forcedAnswer: "forced-answer",
  onFirstAccepted: "on-first-accepted.json",
  answers: "answers.json",
  unitWithoutZone: "unit-without-zone",
  loopbackState: "loopback-state",
  egressState: "egress-state",
  firstInstall: "first-install",
  systemUnits: "system-units.json",
  access: "access.json",
  /** The steward's token ownership, `{ slug: tokenId }`, which a removal releases. */
  owners: "owners.json",
  accounts: "accounts",
} as const;

/**
 * An account as /etc/passwd carries it, made the way the deploy scripts make
 * theirs: a system uid, its own group, no home, no login shell.
 */
export function passwdLine(name: string, uid: number): string {
  return `${name}:x:${uid}:${uid}::/nonexistent:/usr/sbin/nologin`;
}

/** The accounts laid in the VM's folder, one passwd line each. */
export function readAccounts(vm: string): string[] {
  const file = join(vm, SWITCHES.accounts);
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line !== "") : [];
}

/** Adds an account to the VM, with the next system uid down from 999 unless one is given. */
export function addAccount(vm: string, name: string, uid?: number): void {
  const accounts = readAccounts(vm);
  if (accounts.some((line) => line.startsWith(`${name}:`))) return;
  appendFileSync(join(vm, SWITCHES.accounts), `${passwdLine(name, uid ?? 999 - accounts.length)}\n`);
}

/**
 * The steward's access registry as `share` and `people` find it on the owner
 * socket: answering with this release's routes, from before the registry
 * (`old`, a 404 `no such route`), or with no owner socket at all (`down`,
 * curl's 7). Per project, its general access as the machine carries it, null
 * when it is not deployed, and its people with access, as the steward shows
 * them; machine-wide, who may create projects.
 */
export type AccessRegistry = {
  state: "current" | "old" | "down";
  zone: string;
  signIn: { configured: boolean; allowedDomains: string[]; admins: string[]; providerName: string | null };
  portal: { reading: "steward" | "portal" | "unreadable" | "unknown"; writtenAt: number | null };
  projects: Record<string, { general: "public" | "restricted" | "code" | null; entries: EntryView[] }>;
  creators: string[];
};

/** What every change is dated, and the password a password access is given: the tests read both back. */
export const FAKE_NOW = 1_791_000_000_000;
export const FAKE_PASSWORD = "fake-password-for-tests-only";

/** kanban deployed and restricted, nobody on it, acme.test the company's domain, Google set up. */
export const DEFAULT_ACCESS: AccessRegistry = {
  state: "current",
  zone: "test-zone.invalid",
  signIn: { configured: true, allowedDomains: ["acme.test"], admins: [], providerName: "Google" },
  portal: { reading: "steward", writtenAt: FAKE_NOW },
  projects: { kanban: { general: "restricted", entries: [] } },
  creators: [],
};

const ROLE_ORDER: readonly Role[] = ["visitor", "viewer", "developer", "admin"];

/** The steward's answer to `GET /access?slug=`, from the registry. */
function accessAnswer(registry: AccessRegistry, slug: string): object {
  const project = registry.projects[slug]!;
  const host = `${slug}.${registry.zone}`;
  return {
    slug,
    host,
    url: `https://${host}/`,
    general: project.general === null ? null : { access: project.general, modifiable: project.general !== "code", reason: null },
    entries: project.entries,
    signIn: registry.signIn,
    portal: registry.portal,
  };
}

/** Everyone across projects, as `GET /people` answers. */
function peopleAnswer(registry: AccessRegistry): { people: PersonView[]; domains: { slug: string; domain: string }[]; signIn: AccessRegistry["signIn"] } {
  const people = new Map<string, PersonView>();
  const person = (who: string): PersonView => {
    const found = people.get(who) ?? { who, roles: {}, create: registry.creators.includes(who), passwords: [], admin: registry.signIn.admins.includes(who) };
    people.set(who, found);
    return found;
  };
  const domains: { slug: string; domain: string }[] = [];
  for (const [slug, project] of Object.entries(registry.projects)) {
    for (const entry of project.entries) {
      if (entry.kind === "domain") {
        domains.push({ slug, domain: entry.who });
        continue;
      }
      const one = person(entry.who);
      one.roles[slug] = entry.role;
      if (entry.password !== null) one.passwords.push({ slug, ...entry.password });
    }
  }
  for (const creator of registry.creators) person(creator);
  return { people: [...people.values()].sort((a, b) => a.who.localeCompare(b.who)), domains, signIn: registry.signIn };
}

/**
 * The commands the simulated VM accepts, besides the reading of the manifests.
 * The blocks in service whose site the machine no longer carries, word for word
 * as bin/deploy-caddy.sh sends it.
 */
export const LIST_BLOCKS =
  'for block in /etc/caddy/sites/*.caddy; do [ -e "$block" ] || continue; slug=$(basename "$block" .caddy); [ -d "/srv/sites/$slug" ] || echo "$slug.caddy"; done';
/** A block in service, read as `sitesolide deploy` reads it before anything leaves. */
const READ_BLOCK = new RegExp(
  `^if sudo test -f (/etc/caddy/sites/([a-z0-9-]+)\\.caddy); then echo ${MARKER_PRESENT}; sudo cat \\1; else echo ${MARKER_ABSENT}; fi$`,
);
/**
 * A deposited manifest or a unit, read the same way by `deploy --dry-run
 * --compare`, which measures what a deployment would change.
 */
const READ_FILE = new RegExp(
  `^if sudo test -f (/srv/sites/[a-z0-9-]+/sitesolide\\.json|/etc/systemd/system/[a-z0-9.-]+\\.service); then echo ${MARKER_PRESENT}; sudo cat \\1; else echo ${MARKER_ABSENT}; fi$`,
);
/** What bin/deploy-caddy.sh reads to tell a first install, before its guard. */
export const FIRST_INSTALL_FILES = "test -f /etc/caddy/sitesolide.env && test -f /etc/caddy/domaines.map";
/** The guard of bin/deploy-caddy.sh, which checks that the unit loads the zone variables. */
export const CADDY_ENV_UNIT = "systemctl show caddy --property=EnvironmentFiles --value";
const FINGERPRINT = /^sudo shasum -a 256 (\/etc\/caddy\/[A-Za-z0-9._\/-]+) 2>\/dev\/null$/;
// `caddy-lock` and its four verbs are what bin/cli/caddy-lock.ts writes into
// the remote script: they are read here, never chosen here.
const LOCK = /^sudo sh -c ': caddy-lock (take|retake|release|verify) ([^;']*);/;
/**
 * Whether a static account exists, word for word as bin/deploy-monitor.sh asks
 * it: dynamic accounts left out, the passwd line or `missing`.
 */
const ACCOUNT_READING = /^SYSTEMD_NSS_DYNAMIC_BYPASS=1 getent passwd ([a-z][a-z0-9-]*) \|\| echo missing$/;
/** An account made, its name last on the line, as every deploy script writes useradd. */
const USERADD = /\buseradd .* ([a-z][a-z0-9-]*)$/;
/** A script of `sitesolide setup` or `upgrade`, on standard input, named by its tag: see bin/cli/harden.ts. */
const SETUP_SCRIPT = /^(sudo -n )?sh -s (setup|upgrade):[a-z0-9-]+:[a-z]+$/;

if (import.meta.main) {
  const vm = process.env.FAKE_VM ?? "";
  const arguments_ = process.argv.slice(2);
  let i = 0;
  while (i < arguments_.length && arguments_[i]!.startsWith("-")) {
    i += arguments_[i] === "-o" ? 2 : 1;
  }
  const host = arguments_[i] ?? "";
  const command = arguments_.slice(i + 1).join(" ");

  const record = (line: string): void => {
    if (vm !== "") appendFileSync(join(vm, "logs"), `${line}\n`);
  };
  const refuse = (reason: string): never => {
    record(`REFUSED ${command}`);
    console.error(`fake ssh: ${reason}: ${command}`);
    process.exit(255);
  };
  /** Records, then waits if the test asked for a pause on this line. */
  const receive = async (line: string): Promise<void> => {
    record(line);
    const pause = join(vm, SWITCHES.pause);
    if (!existsSync(pause)) return;
    const asked = readFileSync(pause, "utf8").trim();
    const [, target = asked, rank = "1"] = /^(.*)#([0-9]+)$/.exec(asked) ?? [];
    if (target !== line) return;
    const seen = readFileSync(join(vm, "logs"), "utf8").split("\n").filter((past) => past === line).length;
    if (seen !== Number(rank)) return;
    record(`PAUSE ${line}`);
    const deadline = Date.now() + 20_000;
    while (existsSync(pause) && Date.now() < deadline) await Bun.sleep(25);
  };

  if (vm === "" || !existsSync(vm)) refuse("FAKE_VM is not a directory");
  if (host !== TEST_HOST) refuse(`${host} is not the test host`);

  const pattern = /^sudo sh -c 'for f in \/srv\/sites\/([a-z0-9*-]+)\/sitesolide\.json;/.exec(command)?.[1];
  let expected = "";
  try {
    expected = pattern === undefined ? "" : readManifestsCommand(pattern);
  } catch {
    refuse("unexpected reading pattern");
  }
  if (pattern !== undefined && command === expected) {
    await receive(`READ ${pattern}`);
    // An answer imposed by the test: the one of a refused sudo or of a cut
    // connection, which the real script would never produce here.
    const forced = join(vm, SWITCHES.forcedAnswer);
    if (existsSync(forced)) {
      process.stdout.write(readFileSync(forced, "utf8"));
      process.exit(0);
    }
    const script = readManifestsScript(pattern, join(vm, "srv", "sites"));
    const reading = Bun.spawnSync(["sh", "-c", script], { stdout: "inherit", stderr: "inherit" });
    process.exit(reading.exitCode ?? 1);
  }

  const lock = LOCK.exec(command);
  if (lock !== null) {
    const [, action = "", parameters = ""] = lock;
    const [who = "", pid = "", ...rest] = parameters.split(" ");
    const build = (root: string): string => {
      switch (action) {
        case "take":
          return takeScript(who as Who, Number(pid), root);
        case "retake":
          return takeoverScript(who as Who, Number(pid), rest.join(" ") === "-" ? null : rest.join(" "), root);
        case "release":
          return releaseScript(parameters, root);
        default:
          return checkScript(parameters, root);
      }
    };
    let recognised = false;
    try {
      recognised = command === lockCommand(build(RUN_DIR));
    } catch {
      recognised = false;
    }
    if (!recognised) refuse("unexpected lock command");
    await receive(`LOCK ${action} ${who}`);
    const execution = Bun.spawnSync(["sh", "-c", build(join(vm, "run", "sitesolide-gatekeeper"))], {
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exit(execution.exitCode ?? 1);
  }

  if (command === "true") {
    record("CONNECT");
    process.exit(0);
  }
  // Whether the account a unit names exists, read before a deploy script
  // makes it. A reading, hence always answered: from the accounts the test
  // lays and those an accepted useradd made, none otherwise.
  const accountName = ACCOUNT_READING.exec(command)?.[1];
  if (accountName !== undefined) {
    record(`ACCOUNT ${accountName}`);
    const line = readAccounts(vm).find((entry) => entry.startsWith(`${accountName}:`));
    process.stdout.write(`${line ?? "missing"}\n`);
    process.exit(0);
  }
  // Where the loopback rule stands, read before a project with several
  // services pushes anything. A reading, hence always answered: the rule this
  // repository lays, unless the test lays the state it wants.
  if (command === loopbackStateCommand()) {
    record("LOOPBACK");
    const laid = join(vm, SWITCHES.loopbackState);
    const state = existsSync(laid) ? readFileSync(laid, "utf8").trim() : "set";
    process.stdout.write(`${state}\n${MARKER_DONE}\n`);
    process.exit(0);
  }
  // Where the egress proxy stands, read before a project that declares
  // `egress` or `connectors` pushes anything. Running, unless the test lays
  // the state it wants.
  if (command === egressStateCommand()) {
    record("EGRESS");
    const laid = join(vm, SWITCHES.egressState);
    const state = existsSync(laid) ? readFileSync(laid, "utf8").trim() : "active";
    process.stdout.write(`${state}\n${EGRESS_MARKER}\n`);
    process.exit(0);
  }
  // What systemd knows of the units a deployment is about to lay, read before
  // anything is written. A unit the simulated VM carries under
  // /etc/systemd/system is read from there; any other is unknown to systemd,
  // unless the test lays it in SWITCHES.systemUnits, as a package's own unit.
  const origins = /^sudo sh -c 'for u in ([a-z0-9. -]+); do .*\/srv\/sites\/([a-z0-9-]+)\//.exec(command);
  if (origins !== null) {
    const units = origins[1]!.split(" ");
    let recognised = false;
    try {
      recognised = command === unitOriginsCommand(origins[2]!, units);
    } catch {
      recognised = false;
    }
    if (!recognised) refuse("unexpected reading of the units");
    record(`UNITS ${units[0]}`);
    const laidFile = join(vm, SWITCHES.systemUnits);
    const laid = existsSync(laidFile) ? (JSON.parse(readFileSync(laidFile, "utf8")) as Record<string, string>) : {};
    for (const unit of units) {
      const own = `/etc/systemd/system/${unit}.service`;
      const fragment = laid[unit] ?? (existsSync(join(vm, own)) ? own : "");
      const text = fragment !== "" && existsSync(join(vm, fragment)) ? readFileSync(join(vm, fragment), "utf8") : "";
      const generated = text.includes(GENERATOR_MARK) ? "yes" : "no";
      const project = text.includes(`/srv/sites/${origins[2]}/`) ? "yes" : "no";
      process.stdout.write(`UNIT ${unit} ${fragment === "" ? "not-found" : "loaded"} ${generated} ${project} ${fragment === "" ? "-" : fragment}\n`);
    }
    process.stdout.write(`${MARKER_DONE}\n`);
    process.exit(0);
  }
  const fingerprint = FINGERPRINT.exec(command);
  if (fingerprint !== null) {
    // The fingerprint of the simulated VM's file if it exists, nothing
    // otherwise: a missing file looks like one to deposit, as on the real
    // machine.
    record("FINGERPRINT");
    const file = join(vm, fingerprint[1]!);
    if (existsSync(file)) {
      const digest = new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");
      process.stdout.write(`${digest}  ${fingerprint[1]}\n`);
    }
    process.exit(0);
  }
  // Whether the zone file and the domain table are laid, which bin/deploy-caddy.sh
  // reads before its guard to tell a first install. A reading, hence always
  // answered: a machine already installed, unless the test lays the switch.
  if (command === FIRST_INSTALL_FILES) {
    record("FIRST_INSTALL");
    process.exit(existsSync(join(vm, SWITCHES.firstInstall)) ? 1 : 0);
  }
  // The guard of bin/deploy-caddy.sh: does Caddy's unit load the zone
  // variables? A reading, hence always accepted. The simulated VM answers like
  // a correctly laid machine; a test that wants to see the guard refuse lays
  // the file named by SWITCHES.unitWithoutZone.
  if (command === CADDY_ENV_UNIT) {
    record("UNIT_ENV");
    if (!existsSync(join(vm, SWITCHES.unitWithoutZone))) {
      process.stdout.write("/etc/caddy/cloudflare.env /etc/caddy/sitesolide.env\n");
    }
    process.exit(0);
  }
  if (command === LIST_BLOCKS) {
    record("BLOCKS");
    const folder = join(vm, "etc", "caddy", "sites");
    const names = existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith(".caddy")) : [];
    const orphans = names.filter((name) => !existsSync(join(vm, "srv", "sites", name.slice(0, -".caddy".length))));
    process.stdout.write(orphans.map((name) => `${name}\n`).join(""));
    process.exit(0);
  }
  // The steward's access registry, asked as root on its owner socket. A
  // reading is always answered, from the registry the test lays; a change is
  // a write, refused unless the test accepts writes, then judged and applied
  // as the steward would, and recorded with the body that came on standard
  // input, never in the arguments.
  const accessFile = join(vm, SWITCHES.access);
  const registry = (): AccessRegistry => (existsSync(accessFile) ? (JSON.parse(readFileSync(accessFile, "utf8")) as AccessRegistry) : structuredClone(DEFAULT_ACCESS));
  const answerOwner = (state: AccessRegistry["state"]): void => {
    if (state === "down") {
      console.error("curl: (7) Failed to connect to steward port 80 after 0 ms: Couldn't connect to server");
      process.exit(7);
    }
    if (state === "old") {
      process.stdout.write(`${JSON.stringify({ error: "not-found", message: "no such route" })}\n404\n`);
      process.exit(0);
    }
  };
  const answer = (status: number, body: object): never => {
    process.stdout.write(`${JSON.stringify(body)}\n${status}\n`);
    process.exit(0);
  };
  const refusal = (status: number, error: string, message: string): never => answer(status, { error, message });

  const readSlug = /^sudo curl .*http:\/\/steward\/access\?slug=([a-z0-9.-]+)'$/.exec(command)?.[1];
  if (readSlug !== undefined && command === ownerReadCommand(`/access?slug=${readSlug}`)) {
    record(`ACCESS GET ${readSlug}`);
    const current = registry();
    answerOwner(current.state);
    if (!Object.hasOwn(current.projects, readSlug)) refusal(404, "not-found", `${readSlug} is not deployed on this machine`);
    answer(200, accessAnswer(current, readSlug));
  }
  if (command === ownerReadCommand("/people")) {
    record("PEOPLE GET");
    const current = registry();
    answerOwner(current.state);
    answer(200, peopleAnswer(current));
  }
  if (command === ownerWriteCommand("PUT", "/access/entry") || command === ownerWriteCommand("DELETE", "/access/entry")) {
    if (!existsSync(join(vm, SWITCHES.accept))) refuse("command refused by the simulated server");
    const method = command === ownerWriteCommand("PUT", "/access/entry") ? "PUT" : "DELETE";
    const body = await Bun.stdin.text();
    record(`ACCESS ${method} ${body}`);
    const current = registry();
    answerOwner(current.state);
    const asked = JSON.parse(body) as { slug: string; who: string; role?: Role; expiresInS?: number | null };
    const project = current.projects[asked.slug];
    if (project === undefined) refusal(404, "not-found", `${asked.slug} is not deployed on this machine`);
    const existing = project!.entries.find((entry) => entry.who === asked.who) ?? null;
    const save = (): void => writeFileSync(accessFile, JSON.stringify(current));
    if (method === "DELETE") {
      if (existing === null) refusal(404, "not-found", `${asked.who} has no access to ${asked.slug}`);
      project!.entries = project!.entries.filter((entry) => entry.who !== asked.who);
      save();
      answer(200, { slug: asked.slug, entry: existing!, change: "remove" });
    }
    const role = asked.role ?? "visitor";
    const domain = asked.who.startsWith("@");
    if (domain && role !== "visitor") refusal(400, "invalid", `${asked.who}: a domain can only open the site (Can open); give people roles one by one`);
    if (existing?.password != null && role !== "visitor") {
      refusal(403, "out-of-scope", `${asked.who} has password access, which opens the site and nothing more: remove it first to give them a role`);
    }
    const inside = current.signIn.configured && (current.signIn.allowedDomains.length === 0 || current.signIn.allowedDomains.includes(asked.who.slice(asked.who.lastIndexOf("@") + 1)));
    const outside = !domain && !inside && (existing === null || existing.password !== null);
    if (outside && ROLE_ORDER.indexOf(role) > 0) refusal(400, "invalid", `${asked.who} can only be given Can open, with password access: ${asked.who.slice(asked.who.lastIndexOf("@") + 1)} is not among the company's domains`);
    const drawn = outside && existing === null;
    const expiresInS = asked.expiresInS === undefined ? 7 * 24 * 3600 : asked.expiresInS;
    const entry: EntryView = {
      who: asked.who,
      kind: domain ? "domain" : drawn || existing?.password != null ? "password" : "person",
      role,
      by: existing?.by ?? "owner",
      createdAt: existing?.createdAt ?? FAKE_NOW,
      updatedAt: FAKE_NOW,
      password: drawn ? { expiresAt: expiresInS === null ? null : FAKE_NOW + expiresInS * 1000, expired: false } : (existing?.password ?? null),
    };
    const change = existing === null ? "add" : existing.role === role ? "none" : "role";
    if (change !== "none") {
      project!.entries = [...project!.entries.filter((one) => one.who !== asked.who), entry];
      save();
    }
    answer(change === "add" ? 201 : 200, { slug: asked.slug, entry: change === "none" ? existing! : entry, change, ...(drawn ? { password: FAKE_PASSWORD } : {}) });
  }
  if (command === ownerWriteCommand("PUT", "/people/person")) {
    if (!existsSync(join(vm, SWITCHES.accept))) refuse("command refused by the simulated server");
    const body = await Bun.stdin.text();
    record(`PEOPLE PUT ${body}`);
    const current = registry();
    answerOwner(current.state);
    const asked = JSON.parse(body) as { email: string; create: boolean };
    const had = current.creators.includes(asked.email);
    current.creators = asked.create ? [...new Set([...current.creators, asked.email])] : current.creators.filter((one) => one !== asked.email);
    writeFileSync(accessFile, JSON.stringify(current));
    const person = peopleAnswer(current).people.find((one) => one.who === asked.email) ?? { who: asked.email, roles: {}, create: false, passwords: [], admin: false };
    answer(200, { person, change: had === asked.create ? "none" : asked.create ? "create" : "remove" });
  }
  // The steward's owner socket again: a removed project's token ownership
  // released and its people with access dropped, the slug on standard input,
  // recorded with it.
  if (command === ownershipReleaseCommand()) {
    if (!existsSync(join(vm, SWITCHES.accept))) refuse("command refused by the simulated server");
    const body = await Bun.stdin.text();
    record(`OWNERSHIP DELETE ${body}`);
    const ownersFile = join(vm, SWITCHES.owners);
    const owners = existsSync(ownersFile) ? (JSON.parse(readFileSync(ownersFile, "utf8")) as Record<string, string>) : {};
    const { slug } = JSON.parse(body) as { slug: string };
    const forgotten = Object.hasOwn(owners, slug) ? owners[slug]! : null;
    delete owners[slug];
    writeFileSync(ownersFile, JSON.stringify(owners));
    const current = registry();
    const access = Object.hasOwn(current.projects, slug) ? current.projects[slug]!.entries.length : 0;
    if (access > 0) {
      delete current.projects[slug];
      writeFileSync(accessFile, JSON.stringify(current));
    }
    process.stdout.write(`${JSON.stringify({ slug, forgotten, access })}\n200\n`);
    process.exit(0);
  }

  const block = READ_BLOCK.exec(command);
  if (block !== null) {
    record(`BLOCK ${block[2]}`);
    const file = join(vm, block[1]!);
    process.stdout.write(existsSync(file) ? `${MARKER_PRESENT}\n${readFileSync(file, "utf8")}` : `${MARKER_ABSENT}\n`);
    process.exit(0);
  }
  const file = READ_FILE.exec(command);
  if (file !== null) {
    record(`FILE ${file[1]}`);
    const path = join(vm, file[1]!);
    process.stdout.write(existsSync(path) ? `${MARKER_PRESENT}\n${readFileSync(path, "utf8")}` : `${MARKER_ABSENT}\n`);
    process.exit(0);
  }

  if (existsSync(join(vm, SWITCHES.accept))) {
    const refused = existsSync(join(vm, SWITCHES.refuse))
      ? readFileSync(join(vm, SWITCHES.refuse), "utf8").split("\n").filter((line) => line !== "")
      : [];
    if (!refused.some((refusedPattern) => command.includes(refusedPattern))) {
      await receive(`ACCEPTED ${command}`);
      // An account made is there for the next reading, as on a machine.
      const made = USERADD.exec(command)?.[1];
      if (made !== undefined) addAccount(vm, made);
      // `sitesolide setup` sends its scripts on standard input to `sh -s
      // <tag>`: read and dropped, never recorded, since one of them carries
      // the Cloudflare token. The tag on the command line says which it was.
      if (command.includes("/dev/stdin") || SETUP_SCRIPT.test(command)) await Bun.stdin.text();
      // A script handed to `sh -s` on standard input, an install's: recorded,
      // so that a test sees it travelled there and not in the arguments.
      if (command.includes('"/bin/sh" "-s"')) record(`STDIN ${(await Bun.stdin.text()).trimEnd()}`);
      const answers = join(vm, SWITCHES.answers);
      if (existsSync(answers)) {
        const pairs = JSON.parse(readFileSync(answers, "utf8")) as Array<[string, string]>;
        for (const [answerPattern, output] of pairs) {
          if (command.includes(answerPattern)) process.stdout.write(output);
        }
      }
      const action = join(vm, SWITCHES.onFirstAccepted);
      if (existsSync(action)) {
        const { path, content } = JSON.parse(readFileSync(action, "utf8")) as { path: string; content: string };
        rmSync(action);
        mkdirSync(dirname(join(vm, path)), { recursive: true });
        writeFileSync(join(vm, path), content);
      }
      process.exit(0);
    }
  }
  refuse("command refused by the simulated server");
}
