/**
 * The rules of an environment variable's name and value, shared by the CLI,
 * the steward and the installer: one rule, one copy.
 *
 * They lived in dashboard/src/secrets/envfile.ts, which the CLI cannot import
 * (dashboard/borrowed/ is not in git, see bin/cli/remote.ts). Here, the
 * manifest's validation judges a declared secret's name by the very rule the
 * steward applies when the value is set, and the dashboard borrows this file
 * back (dashboard/scripts/borrow.ts).
 *
 * Pure, and importing nothing: bin/cli/manifest.ts and bin/cli/envfile.ts both
 * read it, and neither may be read back from here.
 */

/** A variable name, as systemd and every shell read one: moved from dashboard/src/secrets/envfile.ts. */
export const KEY_SHAPE: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A longer variable name is a mistake, not a need. */
export const MAX_KEY = 128;

/** 8 KiB in UTF-8 bytes. A PEM key fits in base64 on one line. */
export const MAX_VALUE_BYTES = 8 * 1024;

/**
 * Variables set by the unit generator, which a manifest cannot redefine: they
 * describe the served tree, and a value from the manifest would make the
 * service write somewhere other than its own directory. bin/cli/manifest.ts
 * re-exports it.
 */
export const RESERVED_ENV: readonly string[] = ["PORT", "DATA_DIR", "PUBLIC_DIR"];

/**
 * The names that change the way the runtime behaves, and not what the site
 * does: `LD_PRELOAD` loads a library into the process, `HTTPS_PROXY` sends its
 * TLS traffic through a third party, `NODE_TLS_REJECT_UNAUTHORIZED` makes it
 * blind to a forged certificate. Whole families rather than a list of names:
 * the next variable of Node or of glibc will not have to be added here to be
 * refused.
 *
 * Compared without regard to case: `http_proxy` is worth `HTTP_PROXY` for curl,
 * and `Path` must not get through where `PATH` is refused.
 */
export const RESERVED_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "ENV",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZDIR",
  "LOCPATH",
  "NLSPATH",
  "HOSTALIASES",
  "RES_OPTIONS",
  "LOCALDOMAIN",
  "NOTIFY_SOCKET",
  "MAINPID",
  "INVOCATION_ID",
  "JOURNAL_STREAM",
  "CREDENTIALS_DIRECTORY",
  "RUNTIME_DIRECTORY",
  "STATE_DIRECTORY",
  "CACHE_DIRECTORY",
  "LOGS_DIRECTORY",
  "CONFIGURATION_DIRECTORY",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "LANGUAGE",
  "TERM",
  "NO_PROXY",
];
export const RESERVED_PREFIXES: readonly string[] = [
  "LD_",
  "BUN_",
  "NODE_",
  "NPM_",
  "PYTHON",
  "PERL",
  "RUBY",
  "JAVA_",
  "SSL_",
  "OPENSSL_",
  "GCONV_",
  "GLIBC_",
  "MALLOC_",
  "XDG_",
  "BASH_",
  "SYSTEMD_",
  "LISTEN_",
  "WATCHDOG_",
  "LC_",
];
export const RESERVED_SUFFIXES: readonly string[] = ["_PROXY"];

/**
 * The variable only Change password writes, in the dashboard's and the
 * portal's files: the value of dashboard/src/secrets/scope.ts's own constant.
 */
export const PASSWORD_VARIABLE = "PASSWORD_HASH";

const encoder = new TextEncoder();

/**
 * Has this a variable name's shape? Only then may a message quote it: a value
 * pasted where a name goes would otherwise be sent back, into a terminal, an
 * agent's context or a log. The rule of dashboard/src/control/secrets.ts.
 */
export function isVariableName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_KEY && KEY_SHAPE.test(value);
}

/** Why a name is reserved, or null. */
export function reservedReason(key: string): string | null {
  // The variables the unit generator sets: this list is authoritative, the
  // manifest's validation reads the same one.
  if (RESERVED_ENV.includes(key)) return `${key} is set by the deployment, a secret would move the service elsewhere`;
  const uppercase = key.toUpperCase();
  const reserved =
    RESERVED_NAMES.includes(uppercase) ||
    RESERVED_PREFIXES.some((prefix) => uppercase.startsWith(prefix)) ||
    RESERVED_SUFFIXES.some((suffix) => uppercase.endsWith(suffix));
  return reserved ? `${key} changes how the runtime behaves, not what the site does, and cannot be set here` : null;
}

/**
 * The reason for a refusal, or null. `setByUnit`: what the unit sets
 * through `Environment=`, which a file read by `EnvironmentFile=` would
 * overwrite without anything reporting it, `PORT` or `DATA_DIR` included.
 */
export function checkKey(key: string, setByUnit: Iterable<string> = []): string | null {
  if (key.length === 0) return "the variable name is empty";
  if (key.length > MAX_KEY) return `the variable name is longer than ${MAX_KEY} characters`;
  if (!KEY_SHAPE.test(key)) return "letters, digits and underscores, not starting with a digit";
  const reserved = reservedReason(key);
  if (reserved !== null) return reserved;
  for (const set of setByUnit) {
    if (set === key) return `${key} is set by the service unit, a secret would silently override it`;
  }
  return null;
}

/** The reason for a refusal, or null. None of them quotes the value. */
export function checkValue(value: string): string | null {
  if (value.includes("\n") || value.includes("\r")) return "the value must fit on one line";
  if (value.includes("\0")) return "the value contains a null byte";
  // A lone surrogate half would be encoded as U+FFFD: what was written would
  // not be what was typed in.
  if (!value.isWellFormed()) return "the value is not valid Unicode";
  // Written, it would make systemd drop every variable of the file at the
  // next start, those of the other lines included (rule 9 of envfile.ts).
  if (hasNoncharacter(value)) return "the value holds a Unicode noncharacter, which systemd refuses";
  if (encoder.encode(value).length > MAX_VALUE_BYTES) return "the value is larger than 8 KiB";
  return null;
}

/**
 * U+FDD0 to U+FDEF, and U+xxFFFE and U+xxFFFF in every plane: the code points
 * systemd's `unichar_is_valid` refuses beyond what a strict decoder does.
 */
const NONCHARACTER =
  /[﷐-﷯￾￿\u{1FFFE}\u{1FFFF}\u{2FFFE}\u{2FFFF}\u{3FFFE}\u{3FFFF}\u{4FFFE}\u{4FFFF}\u{5FFFE}\u{5FFFF}\u{6FFFE}\u{6FFFF}\u{7FFFE}\u{7FFFF}\u{8FFFE}\u{8FFFF}\u{9FFFE}\u{9FFFF}\u{AFFFE}\u{AFFFF}\u{BFFFE}\u{BFFFF}\u{CFFFE}\u{CFFFF}\u{DFFFE}\u{DFFFF}\u{EFFFE}\u{EFFFF}\u{FFFFE}\u{FFFFF}\u{10FFFE}\u{10FFFF}]/u;

/** Does this text hold a code point systemd refuses in a variables file? */
export function hasNoncharacter(value: string): boolean {
  return NONCHARACTER.test(value);
}

// --- What a secret looks like ------------------------------------------------

/**
 * How a provider's secret key begins: Stripe's secret and restricted keys and
 * its webhook secret, OpenAI's and Anthropic's keys, GitHub's and GitLab's
 * tokens, Slack's, AWS's access keys, sitesolide's own tokens, npm's,
 * SendGrid's, Hugging Face's, Shopify's, DigitalOcean's.
 *
 * Refused as a value in a manifest's `env`, which is committed, and as a name
 * on the CLI, where a key pasted in place of a name would become a name,
 * journaled for good and listed to every Developer of the project. Compared
 * in the provider's own case: `SK_LIVE_KEY` is a variable, `sk_live_` a key.
 *
 * A guard against a slip, not a boundary: the boundary is that the machine
 * never returns a value.
 */
export const SECRET_VALUE_PREFIXES: readonly string[] = [
  "sk_",
  "sk-proj-",
  "sk-ant-",
  "sk-svcacct-",
  "rk_",
  "whsec_",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "glpat-",
  "xox",
  "AKIA",
  "ASIA",
  "sst_",
  "npm_",
  "SG.",
  "hf_",
  "shpat_",
  "dop_v1_",
];

/**
 * What a value pasted where a name goes may start with: the keys above, and
 * Stripe's publishable live key, which is no secret (an `env` value may hold
 * it) but no variable name either.
 */
export const VALUE_LIKE_PREFIXES: readonly string[] = [...SECRET_VALUE_PREFIXES, "pk_live"];

/** Does this value start like a provider's secret key? See SECRET_VALUE_PREFIXES. */
export function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

// --- The build's environment -------------------------------------------------

/**
 * What every build inherits from whoever deploys, by exact name: where things
 * are, who runs, how the terminal and the language are set, and where each
 * toolchain keeps its installation and its caches. Nothing else of the
 * deployer's environment reaches the build: a variable it needs beyond these,
 * a proxy or a registry's token, is named under `secrets.build`.
 *
 * `NODE_ENV` is deliberately absent: the manifest's `env` sets it, and a
 * workstation's `development` must not leak into a production build. So is
 * `SSH_AUTH_SOCK`: the agent it names holds the keys that log into the
 * machine, as the account that deploys with sudo, and a build is the folder's
 * own code, often a clone nobody has read. A build that needs the agent, to
 * fetch a private dependency over SSH, names it under `secrets.build`.
 * deploy.sh carries a copy of these two lists, which its test holds equal to
 * this one.
 */
export const BUILD_INHERITED: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "CI",
  "BUN_INSTALL",
  "NVM_DIR",
  "NVM_BIN",
  "VOLTA_HOME",
  "PNPM_HOME",
  "COREPACK_HOME",
  "GOPATH",
  "GOROOT",
  "GOCACHE",
  "GOMODCACHE",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "JAVA_HOME",
  "ANDROID_HOME",
  "PYENV_ROOT",
  "UV_CACHE_DIR",
  "DENO_DIR",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "SDKROOT",
  "DEVELOPER_DIR",
];

/** The same, by prefix: the locale's categories and the XDG folders. */
export const BUILD_INHERITED_PREFIXES: readonly string[] = ["LC_", "XDG_"];

/** The prefix of sitesolide's own variables, which never reach a build. */
const PLATFORM_PREFIX = "SITESOLIDE_";

/** Does every build inherit this variable from whoever deploys? */
export function isBuildInherited(name: string): boolean {
  return BUILD_INHERITED.includes(name) || BUILD_INHERITED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Why a name may not be a build secret, or null: not a variable name, one of
 * sitesolide's own, or one every build inherits already. A name that is not
 * a variable name is not quoted back.
 */
export function buildNameRefusal(name: string): string | null {
  if (!isVariableName(name)) return `letters, digits and underscores, not starting with a digit, ${MAX_KEY} characters at most`;
  if (name.startsWith(PLATFORM_PREFIX)) return `${name} is sitesolide's own: a build never receives a ${PLATFORM_PREFIX} variable`;
  if (isBuildInherited(name)) return `${name} reaches every build from whoever deploys already: it needs no declaring`;
  return null;
}
