/**
 * The hardening `sitesolide setup` applies to a fresh machine: what the
 * cloud-init file of 0.2 and earlier did at a first boot, done over ssh
 * instead, so that a machine from any provider gets it and a run can be
 * checked and repeated.
 *
 *   packages      sudo ufw fail2ban unattended-upgrades rsync git curl unzip, and nft;
 *                 fail2ban installed without being started
 *   account       the deploy account: sudo without a password, the operator's keys
 *   firewall      ufw: 22 (or the port ssh answers on), 80 and 443 in, the rest refused
 *   updates       unattended security updates, every day
 *   directories   /srv/sites, /srv/api, /srv/data
 *   ssh           no root login, no password: only once a login as the deploy account is proven
 *   fail2ban      enabled and running, last, the workstation's address spared for the run
 *
 * NO LOGIN AS AN ACCOUNT THAT DOES NOT EXIST. Until the account step has found
 * or made the deploy account, every check and every run goes through the
 * operator's session, and so does a dry run on a fresh machine, whose later
 * checks then read as missing rather than as so many refused logins. A first
 * run on Hetzner's Debian 13 logged twenty `Invalid user deploy` lines that
 * way, and fail2ban, started by its own package a step later, read them and
 * banned the workstation in the middle of the install: on 5 October 2026, the
 * run stopped at the packages with every following connection refused.
 *
 * Each step is a check that reads and a run that does only what the check
 * found missing, through the account setup is connected as, the operator:
 * root itself, or a sudoer through `sudo -n`. The scripts travel on standard
 * input to `sh -s`, never as arguments: nothing they carry shows in the
 * machine's process list, and no quoting of a path can break them.
 *
 * NO LOCKOUT. The ssh step comes last and changes sshd only after a NEW login
 * as the deploy account, with `sudo -n true`, has succeeded: if that proof
 * fails, sshd is not touched at all. The change itself is a drop-in checked
 * with `sshd -t` before the reload, withdrawn if refused. A safety net is
 * armed before the reload, as bin/deploy-loopback.sh does for its rule: a
 * transient timer that removes the drop-in two minutes later. Only a second
 * new login as the deploy account, after the reload, finding the settings in
 * effect, disarms it. Should anything go wrong in between, the connection
 * dropping included, root login and passwords come back on their own.
 *
 * The drop-in is named to be read first. sshd keeps the FIRST value it reads
 * for a keyword, and Debian includes sshd_config.d/*.conf at the top of
 * sshd_config, in lexical order: a provider's 50-cloud-init.conf that allows
 * passwords would win over a 99-hardening.conf. The check reads what sshd
 * actually applies, `sshd -T`, not the file setup wrote.
 */
import { checkScript, readCheck, StepFailure, type Check, type Step } from "./steps";

/** What one command on the machine gave back. */
export type Execution = { code: number; output: string; error: string };

/**
 * The machine, as setup reaches it over ssh: one command as one account, a new
 * connection every time, `input` on its standard input. `stream` shows the
 * output as it comes, for a long run; it is returned either way. Never throws:
 * a connection that fails is an exit code like any other.
 */
export type Machine = {
  exec(account: string, command: string, options?: { input?: string; stream?: boolean }): Promise<Execution>;
};

/**
 * A script run as root: `sh -s <tag>` when connected as root, `sudo -n sh -s
 * <tag>` otherwise, the script on standard input. The tag only names the
 * script, in the machine's process list and in the tests' fakes.
 */
export function asRoot(machine: Machine, account: string, tag: string, script: string, stream = false): Promise<Execution> {
  return machine.exec(account, account === "root" ? `sh -s ${tag}` : `sudo -n sh -s ${tag}`, { input: script, stream });
}

export type HardenContext = {
  machine: Machine;
  host: string;
  /** The account the hardening runs through: root, or a sudoer. It becomes the deploy account once ssh is closed to root. */
  operator: string;
  /** The account that deploys, and owns the served files. */
  deployUser: string;
  /** The port ssh answered on, which the firewall must keep open. */
  sshPort: number;
  /**
   * Whether the account step found the deploy account complete. Until then
   * nothing logs in as it: a login refused to an account that does not exist
   * is a line fail2ban counts against the workstation.
   */
  accountReady: boolean;
  /** The workstation's address as the machine sees it, the first field of $SSH_CONNECTION; null when unread. */
  clientAddress: string | null;
  /** The address fail2ban was told to spare for the run, to be withdrawn at its end; null when none. */
  ignoredAddress: string | null;
};

/**
 * A connection the machine refused or dropped, as ssh words it. Mid-run, the
 * likeliest cause is fail2ban, whose ban rejects every packet to the ssh port,
 * those of a session already open included.
 */
export const CONNECTION_LOST = /Connection refused|Connection timed out|Operation timed out|No route to host|Connection reset|Connection closed by remote host|kex_exchange_identification|Broken pipe/;

/** What to tell whoever finds the machine no longer answering ssh. */
export const BAN_ADVICE = [
  "fail2ban may have banned this workstation's address: a ban lasts 10 minutes by default (bantime), and refuses every connection to the ssh port meanwhile",
  "from the provider's console: sudo fail2ban-client status sshd lists the banned addresses, sudo fail2ban-client set sshd unbanip <address> lifts one",
  "wait for the ban to lapse, or lift it, then run the same command again: it resumes where it stopped",
];

/**
 * The PATH of every script: root's, whatever the account and the sudo
 * configuration hand down. ufw, sshd, useradd and nft live in /usr/sbin.
 */
export const SCRIPT_PATH = "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** A check run as root on the machine, read into a Check. */
export async function rootCheck(machine: Machine, account: string, tag: string, script: string): Promise<Check> {
  const execution = await asRoot(machine, account, tag, script);
  if (execution.code !== 0 && !/check: /.test(execution.output)) {
    return { state: "unreadable", reason: execution.error.trim().split("\n").at(-1) || `exit code ${execution.code}` };
  }
  return readCheck(execution.output, execution.error);
}

/** A run as root, streamed, that stops the step with the end of what it said when it fails. */
export async function rootRun(machine: Machine, account: string, tag: string, script: string, failure: string): Promise<void> {
  const execution = await asRoot(machine, account, tag, script, true);
  if (execution.code !== 0) {
    const said = `${execution.output}\n${execution.error}`.split("\n").filter((line) => line.trim() !== "").slice(-5);
    throw new StepFailure(`${failure} (exit code ${execution.code})`, said);
  }
}

/** A run script: the tag, root's PATH, and `set -e`. */
export function runScript(tag: string, body: string): string {
  return [`# sitesolide ${tag}`, "set -e", SCRIPT_PATH, body.trim(), ""].join("\n");
}

/** A check script with root's PATH, see checkScript. */
export function machineCheck(tag: string, conditions: Parameters<typeof checkScript>[1], prelude = ""): string {
  return checkScript(tag, conditions, [SCRIPT_PATH, prelude].filter((line) => line !== "").join("\n"));
}

/** A value quoted for sh: everything but the single quote, which is recomposed. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// --- packages ------------------------------------------------------------------

/**
 * The list cloud-init installed up to 0.2, and sudo, which a minimal image
 * may lack while every step after the hardening runs through it.
 */
export const PACKAGES = ["sudo", "ufw", "fail2ban", "unattended-upgrades", "rsync", "git", "curl", "unzip"] as const;

/**
 * apt waits for a lock held by the machine's own first-boot updates rather
 * than failing on it at once, and never asks anything.
 */
export const APT = "DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600";

export function packagesCheck(): string {
  return machineCheck("setup:packages:check", [
    ...PACKAGES.map((name) => ({ label: name, test: `dpkg-query -W -f='\${Status}' ${name} | grep -q 'ok installed'` })),
    // The loopback rule is an nftables table: bin/deploy-loopback.sh needs nft.
    { label: "nft", test: "command -v nft" },
  ]);
}

/**
 * fail2ban apart, under a policy-rc.d that forbids starting a service, the
 * way Debian's own image builders install packages: its package would start
 * it at once, and a fail2ban started before the deploy account's login is
 * proven reads the journal's recent failed logins and may ban the workstation
 * running this install. It is left installed, stopped and disabled; the
 * fail2ban step, after ssh, starts it. A policy-rc.d already in place, a
 * container's, is put back as it was, whatever happens to the install.
 */
export function packagesRun(): string {
  const others = PACKAGES.filter((name) => name !== "fail2ban");
  return runScript(
    "setup:packages:run",
    `
${APT} update -q </dev/null
${APT} install -y -q ${others.join(" ")} </dev/null
# Only when missing: installed by default on Debian, where its own service stays
# disabled and never flushes the firewall's rules.
command -v nft >/dev/null 2>&1 || ${APT} install -y -q nftables </dev/null
if ! dpkg-query -W -f='\${Status}' fail2ban 2>/dev/null | grep -q 'ok installed'; then
  policy=/usr/sbin/policy-rc.d
  saved=""
  if [ -e "$policy" ]; then saved="$policy.sitesolide"; mv "$policy" "$saved"; fi
  restore_policy() { rm -f "$policy"; if [ -n "$saved" ]; then mv "$saved" "$policy"; saved=""; fi; }
  trap restore_policy EXIT
  printf '#!/bin/sh\\nexit 101\\n' > "$policy"
  chmod 755 "$policy"
  ${APT} install -y -q fail2ban </dev/null
  restore_policy
  trap - EXIT
  systemctl disable --now fail2ban >/dev/null 2>&1 </dev/null || true
fi
`,
  );
}

// --- the deploy account ----------------------------------------------------------

/**
 * Where the deploy account's keys live, and where those of the account setup
 * connects through are read from: none to copy when the two are one account.
 */
function keysPrelude(user: string, operator: string): string {
  const lines = [`home=$(getent passwd ${shellQuote(user)} | cut -d: -f6)`, 'keys="$home/.ssh/authorized_keys"'];
  if (operator !== user) lines.push(`source_keys="$(getent passwd ${shellQuote(operator)} | cut -d: -f6)/.ssh/authorized_keys"`);
  return lines.join("\n");
}

/** Every key line of the operator's file, comments and blank lines left out. */
const SOURCE_KEY_LINES = `grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$source_keys"`;

export function accountCheck(user: string, operator: string): string {
  const conditions = [
    { label: "account", test: `id -u ${shellQuote(user)}` },
    // Asked of sudo itself, as the account: whatever grants it, a group, a
    // file of cloud-init's or setup's own, what counts is that it works.
    { label: "passwordless-sudo", test: `sudo -u ${shellQuote(user)} sudo -n true` },
  ];
  if (operator !== user) {
    conditions.push({
      label: "ssh-keys",
      test: `[ -s "$keys" ] && { [ ! -f "$source_keys" ] || ! ${SOURCE_KEY_LINES} | while IFS= read -r line; do grep -qxF -- "$line" "$keys" || echo absent; done | grep -q absent; }`,
    });
  }
  return machineCheck("setup:account:check", conditions, keysPrelude(user, operator));
}

export function accountRun(user: string, operator: string): string {
  const name = shellQuote(user);
  return runScript(
    "setup:account:run",
    `
if ! id -u ${name} >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --groups sudo ${name}
  # useradd leaves the password locked, "!", and sshd refuses a key to a
  # locked account when PAM is off. "*" matches no password either, and is
  # not a lock: the account logs in by key, and by nothing else.
  usermod -p '*' ${name}
fi
# The rule is written beside the others, checked by visudo before it is moved
# in place: a sudoers file sudo cannot parse would refuse sudo to everyone.
if ! sudo -u ${name} sudo -n true >/dev/null 2>&1; then
  rule=/etc/sudoers.d/90-sitesolide-${user}
  printf '%s ALL=(ALL) NOPASSWD:ALL\\n' ${name} > "$rule.new"
  chmod 440 "$rule.new"
  visudo -cf "$rule.new" >/dev/null
  mv "$rule.new" "$rule"
fi
${keysPrelude(user, operator)}
group=$(id -gn ${name})
install -d -m 700 -o ${name} -g "$group" "$home/.ssh"
[ -f "$keys" ] || install -m 600 -o ${name} -g "$group" /dev/null "$keys"
${
  operator === user
    ? ""
    : `if [ -f "$source_keys" ]; then
  ${SOURCE_KEY_LINES} | while IFS= read -r line; do
    grep -qxF -- "$line" "$keys" || printf '%s\\n' "$line" >> "$keys"
  done
fi`
}
chown ${name}:"$group" "$keys"
chmod 600 "$keys"
`,
  );
}

// --- the firewall ------------------------------------------------------------------

/**
 * The port ssh answered on rather than 22 by habit: a machine whose sshd
 * listens elsewhere would be cut off by the first `ufw enable`.
 */
export function firewallPorts(sshPort: number): number[] {
  return [...new Set([sshPort, 80, 443])].sort((a, b) => a - b);
}

export function firewallCheck(sshPort: number): string {
  return machineCheck("setup:firewall:check", [
    { label: "ufw-active", test: "ufw status | grep -q '^Status: active'" },
    { label: "ufw-deny-incoming", test: "ufw status verbose | grep -q 'Default: deny (incoming)'" },
    ...firewallPorts(sshPort).map((port) => ({ label: `ufw-${port}`, test: `ufw status | grep -Eq '^${port}/tcp +ALLOW'` })),
  ]);
}

/**
 * The ports are opened before the default turns to deny, and both before
 * ufw is enabled: every command setup sends is a new connection, and one
 * refused between two lines would leave the script half run.
 */
export function firewallRun(sshPort: number): string {
  return runScript(
    "setup:firewall:run",
    `
for port in ${firewallPorts(sshPort).join(" ")}; do ufw allow "$port/tcp" >/dev/null </dev/null; done
ufw default deny incoming >/dev/null </dev/null
ufw default allow outgoing >/dev/null </dev/null
ufw --force enable >/dev/null </dev/null
`,
  );
}

// --- fail2ban, updates, directories ------------------------------------------------

export function fail2banCheck(): string {
  return machineCheck("setup:fail2ban:check", [
    { label: "fail2ban-enabled", test: "systemctl is-enabled --quiet fail2ban" },
    { label: "fail2ban-active", test: "systemctl is-active --quiet fail2ban" },
  ]);
}

export const FAIL2BAN_IGNORE = "/etc/fail2ban/jail.d/00-sitesolide-setup.conf";

/**
 * fail2ban started, the workstation's own address spared for the run.
 *
 * WHY SPARED BEFOREHAND RATHER THAN UNBANNED AFTERWARDS. A fail2ban that starts
 * reads the journal back over its findtime, and a ban there rejects every
 * packet to the ssh port, those of the session running this very script
 * included: an unban sent after the start races with the connection that
 * would send it. So the address goes into the sshd jail's ignoreip BEFORE the
 * start, in a file of jail.d, and the file is removed as soon as the jail
 * answers, so that nothing lasting exempts it on disk: the running jail keeps
 * the setting in memory. At the end of the run, success or failure,
 * `fail2banRelease` withdraws it from memory with delignoreip, without a
 * reload: a reload would read the journal back again, and could ban the
 * address then. Only an interrupted run leaves it in memory, until fail2ban's
 * next restart. Nothing already banned is unbanned, ever.
 *
 * `address` is null when the preflight could not read it: fail2ban then starts
 * with nothing spared, setup's own logins being all successful by then.
 */
export function fail2banRun(address: string | null): string {
  const spare =
    address === null
      ? ""
      : `mkdir -p /etc/fail2ban/jail.d
cat > ${FAIL2BAN_IGNORE} <<'JAIL'
# Laid by sitesolide setup for the time fail2ban starts, then removed.
[sshd]
ignoreip = 127.0.0.1/8 ::1 ${address}
JAIL`;
  return runScript(
    "setup:fail2ban:run",
    `
${spare}
systemctl enable fail2ban >/dev/null 2>&1 </dev/null
systemctl restart fail2ban </dev/null
ready=""
for attempt in $(seq 1 30); do
  if fail2ban-client status sshd >/dev/null 2>&1 </dev/null; then ready=yes; break; fi
  sleep 1
done
rm -f ${FAIL2BAN_IGNORE}
[ -n "$ready" ] || { echo "fail2ban runs, but its sshd jail did not answer within 30 seconds" >&2; exit 1; }
${address === null ? "" : `fail2ban-client get sshd ignoreip </dev/null | grep -qF -- '${address}' || echo "note: fail2ban does not list ${address} among the addresses it spares" >&2`}
`,
  );
}

/** The workstation's address withdrawn from what the sshd jail spares, without a reload: see fail2banRun. */
export function fail2banRelease(address: string): string {
  return runScript("setup:fail2ban:release", `fail2ban-client set sshd delignoreip '${address}' >/dev/null </dev/null`);
}

/** The file cloud-init wrote up to 0.2, word for word: apt reads it, and so does unattended-upgrades. */
export const AUTO_UPGRADES = 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n';

export function updatesCheck(): string {
  return machineCheck("setup:updates:check", [
    { label: "update-lists", test: `apt-config dump | grep -qx 'APT::Periodic::Update-Package-Lists "1";'` },
    { label: "unattended-upgrade", test: `apt-config dump | grep -qx 'APT::Periodic::Unattended-Upgrade "1";'` },
  ]);
}

export function updatesRun(): string {
  return runScript(
    "setup:updates:run",
    `install -m 644 -o root -g root /dev/stdin /etc/apt/apt.conf.d/20auto-upgrades <<'APT'\n${AUTO_UPGRADES}APT`,
  );
}

/** What cloud-init made up to 0.2: the served sites, the shared service's releases, and its data. */
export const DIRECTORIES = ["/srv/sites", "/srv/api", "/srv/data"] as const;

export function directoriesCheck(): string {
  return machineCheck(
    "setup:directories:check",
    DIRECTORIES.map((path) => ({ label: path.slice(1).replaceAll("/", "-"), test: `test -d ${path}` })),
  );
}

export function directoriesRun(): string {
  return runScript("setup:directories:run", `install -d -m 755 -o root -g root ${DIRECTORIES.join(" ")}`);
}

// --- ssh ----------------------------------------------------------------------------

export const SSHD_DROP_IN = "/etc/ssh/sshd_config.d/00-sitesolide.conf";
/** The transient unit of the safety net, as the loopback rule has its own. */
export const SSH_SAFETY_UNIT = "sitesolide-ssh-rollback";
export const SSH_SAFETY_SECONDS = 120;

export const SSHD_SETTINGS = [
  ["PermitRootLogin", "no"],
  ["PasswordAuthentication", "no"],
  ["KbdInteractiveAuthentication", "no"],
] as const;

export const SSHD_CONTENT = [
  "# Laid by sitesolide setup: keys only, and no root login.",
  "#",
  "# Named to be read before every other file of this folder: sshd keeps the",
  "# first value it reads for a keyword, and a provider's file allowing",
  "# passwords must not win over this one. See bin/cli/harden.ts.",
  ...SSHD_SETTINGS.map(([key, value]) => `${key} ${value}`),
  "",
].join("\n");

export function sshCheck(): string {
  return machineCheck(
    "setup:ssh:check",
    SSHD_SETTINGS.map(([key, value]) => ({
      label: { PermitRootLogin: "root-login-off", PasswordAuthentication: "password-off", KbdInteractiveAuthentication: "keyboard-interactive-off" }[key],
      test: `printf '%s\\n' "$effective" | grep -qx '${key.toLowerCase()} ${value}'`,
    })),
    "effective=$(sshd -T 2>/dev/null)",
  );
}

/**
 * The change itself, sent once the proof has passed. A drop-in refused by
 * `sshd -t` is withdrawn, the previous one put back if there was one, and
 * nothing is reloaded. The safety net is armed before the reload, and only the
 * disarm below, run as the deploy account after a second proof, stops it.
 */
export function sshRun(): string {
  return runScript(
    "setup:ssh:run",
    `
drop_in=${SSHD_DROP_IN}
mkdir -p /etc/ssh/sshd_config.d
systemctl stop ${SSH_SAFETY_UNIT}.timer ${SSH_SAFETY_UNIT}.service >/dev/null 2>&1 || true
rm -f "$drop_in.before"
if [ -f "$drop_in" ]; then cp "$drop_in" "$drop_in.before"; fi
install -m 644 -o root -g root /dev/stdin "$drop_in" <<'SSHD'
${SSHD_CONTENT}SSHD
[ -d /run/sshd ] || install -d -m 755 /run/sshd
if ! sshd -t </dev/null; then
  if [ -f "$drop_in.before" ]; then mv "$drop_in.before" "$drop_in"; else rm -f "$drop_in"; fi
  echo "sshd -t refused the configuration: the drop-in was withdrawn, nothing was reloaded" >&2
  exit 1
fi
rm -f "$drop_in.before"
systemd-run --quiet --unit=${SSH_SAFETY_UNIT} --on-active=${SSH_SAFETY_SECONDS} /bin/sh -c "rm -f $drop_in; systemctl reload ssh || true" </dev/null
systemctl reload ssh </dev/null
`,
  );
}

export function sshDisarm(): string {
  return runScript(
    "setup:ssh:disarm",
    `
systemctl stop ${SSH_SAFETY_UNIT}.timer ${SSH_SAFETY_UNIT}.service >/dev/null 2>&1 || true
! systemctl is-active --quiet ${SSH_SAFETY_UNIT}.timer
`,
  );
}

/** The proof: a new login as the deploy account, and sudo without a password there. */
export const PROOF = "sudo -n true";

// --- the steps ----------------------------------------------------------------------

function inspect(context: HardenContext, command: string): string {
  return `ssh ${context.operator}@${context.host} ${shellQuote(command)}`;
}

export function hardeningSteps<C extends HardenContext>(): Step<C>[] {
  const check = (tag: string, script: (context: C) => string) => (context: C) => rootCheck(context.machine, context.operator, tag, script(context));
  return [
    {
      id: "packages",
      title: "base packages",
      check: check("setup:packages:check", () => packagesCheck()),
      run: (context) => rootRun(context.machine, context.operator, "setup:packages:run", packagesRun(), "apt-get refused the packages"),
      inspect: (context) => inspect(context, "sudo tail -n 50 /var/log/apt/term.log"),
    },
    {
      id: "account",
      title: "deploy account",
      check: async (context) => {
        const found = await rootCheck(context.machine, context.operator, "setup:account:check", accountCheck(context.deployUser, context.operator));
        context.accountReady = found.state === "done";
        return found;
      },
      run: async (context) => {
        await rootRun(context.machine, context.operator, "setup:account:run", accountRun(context.deployUser, context.operator), `the account ${context.deployUser} could not be completed`);
        return `${context.deployUser}: sudo without a password, ${context.operator === context.deployUser ? "its own keys" : `the keys of ${context.operator}`}`;
      },
      inspect: (context) => inspect(context, `id ${context.deployUser}; sudo -l -U ${context.deployUser}`),
    },
    {
      id: "firewall",
      title: "firewall",
      check: check("setup:firewall:check", (context) => firewallCheck(context.sshPort)),
      run: async (context) => {
        await rootRun(context.machine, context.operator, "setup:firewall:run", firewallRun(context.sshPort), "ufw refused the rules");
        return `ufw: ${firewallPorts(context.sshPort).join(", ")} in, the rest refused`;
      },
      inspect: (context) => inspect(context, "sudo ufw status verbose"),
    },
    {
      id: "updates",
      title: "security updates",
      check: check("setup:updates:check", () => updatesCheck()),
      run: (context) => rootRun(context.machine, context.operator, "setup:updates:run", updatesRun(), "the automatic updates could not be set"),
      inspect: (context) => inspect(context, "apt-config dump | grep Periodic"),
    },
    {
      id: "directories",
      title: "directories",
      check: check("setup:directories:check", () => directoriesCheck()),
      run: (context) => rootRun(context.machine, context.operator, "setup:directories:run", directoriesRun(), "the directories could not be made"),
      inspect: (context) => inspect(context, `ls -ld ${DIRECTORIES.join(" ")}`),
    },
    {
      id: "ssh",
      title: "ssh: keys only, no root",
      // sshd closed already, and the operator another account than the deploy
      // one, a sudoer's: the deploy account's login is proven here, once it is
      // known to exist, before any step logs in as it.
      check: async (context) => {
        const found = await rootCheck(context.machine, context.operator, "setup:ssh:check", sshCheck());
        if (found.state !== "done" || context.operator === context.deployUser || !context.accountReady) return found;
        if ((await context.machine.exec(context.deployUser, PROOF)).code !== 0) return { state: "missing", missing: ["deploy-login"] };
        context.operator = context.deployUser;
        return found;
      },
      run: async (context, missing) => {
        if (missing.length === 1 && missing[0] === "deploy-login") {
          throw new StepFailure(`no login as ${context.deployUser}@${context.host} could be proven`, [
            `ssh ${context.deployUser}@${context.host} '${PROOF}' must work before setup goes on as that account`,
          ]);
        }
        return closeSsh(context);
      },
      inspect: (context) => `ssh ${context.deployUser}@${context.host} 'sudo sshd -T | grep -E "^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication) "'`,
    },
    {
      id: "fail2ban",
      title: "fail2ban",
      check: check("setup:fail2ban:check", () => fail2banCheck()),
      run: async (context) => {
        // Recorded before the run, so that a run failing half way still has
        // its ignore withdrawn at the end.
        context.ignoredAddress = context.clientAddress;
        await rootRun(context.machine, context.operator, "setup:fail2ban:run", fail2banRun(context.clientAddress), "fail2ban did not start");
        return context.clientAddress === null ? "running" : `running, ${context.clientAddress} spared until the end of this run`;
      },
      inspect: (context) => inspect(context, "sudo journalctl -u fail2ban -n 50"),
    },
  ];
}

/**
 * The ssh step's run, in the only order that cannot lock anyone out: the
 * proof, the change, a second proof that reads the change in effect, the
 * disarm. From the change on, every command goes through the deploy account:
 * root may no longer log in.
 */
export async function closeSsh(context: HardenContext): Promise<string> {
  const server = `${context.deployUser}@${context.host}`;
  const proof = await context.machine.exec(context.deployUser, PROOF);
  if (proof.code !== 0) {
    throw new StepFailure(`no login as ${server} could be proven: sshd was left exactly as it was`, [
      `ssh ${server} '${PROOF}' failed: ${proof.error.trim().split("\n").at(-1) || `exit code ${proof.code}`}`,
      "root login and passwords stay open until that login works",
    ]);
  }

  const change = await asRoot(context.machine, context.operator, "setup:ssh:run", sshRun(), true);
  if (change.code !== 0) {
    const said = `${change.output}\n${change.error}`.split("\n").filter((line) => line.trim() !== "").slice(-3);
    throw new StepFailure("sshd refused the change", [...said, `if the reload went through, the safety net withdraws ${SSHD_DROP_IN} within ${SSH_SAFETY_SECONDS / 60} minutes`]);
  }
  context.operator = context.deployUser;

  const after = await rootCheck(context.machine, context.deployUser, "setup:ssh:check", sshCheck());
  if (after.state !== "done") {
    throw new StepFailure(`after the reload, ${after.state === "missing" ? `still missing: ${after.missing.join(", ")}` : `the login as ${server} failed: ${after.reason}`}`, [
      `the safety net withdraws ${SSHD_DROP_IN} within ${SSH_SAFETY_SECONDS / 60} minutes: root login and passwords come back on their own`,
      "a directive placed before the Include line of /etc/ssh/sshd_config wins over the drop-in",
    ]);
  }
  const disarm = await asRoot(context.machine, context.deployUser, "setup:ssh:disarm", sshDisarm());
  if (disarm.code !== 0) {
    throw new StepFailure("the safety net could not be disarmed", [
      `within ${SSH_SAFETY_SECONDS / 60} minutes it withdraws ${SSHD_DROP_IN}, and root login and passwords come back`,
      "run setup again afterwards: it closes them again",
    ]);
  }
  return `root login and passwords off, proven through ${server}`;
}
