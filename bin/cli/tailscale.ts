/**
 * `sitesolide setup --tailscale`: the machine joins a tailnet, so that its
 * owner reaches OpenSSH over WireGuard and port 22 can be closed to the
 * Internet (bin/cli/ssh-access.ts, docs/ssh.md).
 *
 *   repository   pkgs.tailscale.com's apt repository for this Debian release,
 *                its key checked against the fingerprint below before apt trusts it
 *   package      tailscale, and tailscaled enabled and running
 *   joined       the tailnet, with a tag, through an auth key that never shows
 *
 * TAILSCALE SSH STAYS OFF. tailscaled can serve ssh itself, `--ssh`, which
 * answers in place of OpenSSH with the tailnet's ACLs as its only policy; it
 * had a run of flaws in 2026. The machine keeps OpenSSH, with its keys, its
 * drop-in and fail2ban, and the tailnet only carries the packets: `--ssh=false`
 * on every run, and the check refuses a machine where it is on.
 *
 * THE AUTH KEY. From TS_AUTHKEY, Tailscale's own variable, or from standard
 * input with `--tailscale-key-stdin`, and from nowhere else: an option would
 * show it in `ps` and the shell's history. It is asked for only when the
 * machine has not joined yet. It reaches the machine inside the script on
 * ssh's standard input, which writes it to a file of /run readable by root
 * alone, hands the file to `tailscale up --auth-key=file:`, and removes it:
 * it is never an argument there either. No line this step prints carries it.
 *
 * THE TAG. A tagged node's key does not expire, which is what keeps a server
 * from dropping off the tailnet after 180 days, and a tag is what the
 * tailnet's policy names to keep the server from opening connections to its
 * owner's own devices. The auth key must be allowed to apply it. The settings
 * the tailnet itself needs are in docs/ssh.md: they are its admin's, and no
 * command here can set them.
 *
 * MagicDNS stays off on the machine (`--accept-dns=false`): Caddy and the
 * egress proxy resolve through the system's resolvers, and a tailnet's DNS
 * answering for them would be one more party in the path of every
 * certificate and every outbound request.
 */
import { APT, machineCheck, runScript, shellQuote } from "./harden";
import { APT_KEYS, aptKeyScript } from "./pins";

/** A tag as Tailscale takes them: `tag:` and a name of letters, digits and dashes. */
export const TAILSCALE_TAG = /^tag:[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

/** The tag a machine joins with unless `--tailscale-tag` names another. */
export const DEFAULT_TAG = "tag:server";

/** What an auth key looks like: never printed, only recognised. */
export const AUTH_KEY = /^tskey-[A-Za-z0-9_-]{10,200}$/;

/** The variable the auth key is read from, Tailscale's own name for it. */
export const AUTH_KEY_VARIABLE = "TS_AUTHKEY";

export const TAILSCALE_KEYRING = APT_KEYS.tailscale.keyring;
export const TAILSCALE_LIST = "/etc/apt/sources.list.d/tailscale.list";

/** What a run says it did, read back for the report. */
export const TAILSCALE_SAID = { installed: "tailscale: installed", joined: "tailscale: joined" } as const;

/** Read only. */
export function tailscaleCheck(tag: string): string {
  if (!TAILSCALE_TAG.test(tag)) throw new Error(`not a Tailscale tag: ${tag}`);
  return machineCheck(
    "setup:tailscale:check",
    [
      { label: "tailscale-repository", test: `grep -qF 'signed-by=${TAILSCALE_KEYRING}' ${TAILSCALE_LIST}` },
      { label: "tailscale-installed", test: "command -v tailscale" },
      { label: "tailscaled-enabled", test: "systemctl is-enabled --quiet tailscaled" },
      { label: "tailscaled-active", test: "systemctl is-active --quiet tailscaled" },
      { label: "tailscale-joined", test: `printf '%s' "$status" | grep -Eq '"BackendState": *"Running"'` },
      { label: "tailscale-tagged", test: `printf '%s' "$status" | grep -qF '"${tag}"'` },
      { label: "tailscale-ssh-off", test: `! tailscale debug prefs 2>/dev/null | grep -Eq '"RunSSH": *true'` },
    ],
    'status=$(tailscale status --json --peers=false 2>/dev/null || true)',
  );
}

/**
 * The repository, the package, and the join when the machine has not joined
 * yet: `key` is then the auth key, null otherwise. Tailscale SSH is turned
 * off whatever the machine had.
 */
export function tailscaleRun(tag: string, key: string | null): string {
  if (!TAILSCALE_TAG.test(tag)) throw new Error(`not a Tailscale tag: ${tag}`);
  if (key !== null && !AUTH_KEY.test(key)) throw new Error("not an auth key");
  const join =
    key === null
      ? `echo "the machine has not joined a tailnet, and no auth key was given" >&2
  exit 3`
      : `umask 077
  key_file=$(mktemp /run/sitesolide-tailscale.XXXXXX)
  trap 'rm -f "$key_file"' EXIT
  cat > "$key_file" <<'KEY'
${key}
KEY
  tailscale up --auth-key="file:$key_file" --advertise-tags=${shellQuote(tag)} --ssh=false --accept-dns=false --accept-routes=false </dev/null
  rm -f "$key_file"
  trap - EXIT
  echo "${TAILSCALE_SAID.joined}"`;
  return runScript(
    "setup:tailscale:run",
    `
if ! grep -qF 'signed-by=${TAILSCALE_KEYRING}' ${TAILSCALE_LIST} 2>/dev/null; then
  . /etc/os-release
  case "\${VERSION_CODENAME:-}" in ''|*[!a-z]*) echo "no Debian codename in /etc/os-release" >&2; exit 1;; esac
${aptKeyScript(APT_KEYS.tailscale)}
  echo "deb [signed-by=${TAILSCALE_KEYRING}] https://pkgs.tailscale.com/stable/debian \${VERSION_CODENAME} main" > ${TAILSCALE_LIST}
fi
if ! command -v tailscale >/dev/null 2>&1; then
  ${APT} update -q </dev/null
  ${APT} install -y -q tailscale </dev/null
  echo "${TAILSCALE_SAID.installed}"
fi
systemctl enable --now tailscaled >/dev/null 2>&1 </dev/null
# tailscaled answers a few seconds after its start.
for attempt in $(seq 1 30); do
  tailscale status --json --peers=false 2>/dev/null </dev/null | grep -q '"BackendState"' && break
  sleep 1
done
if ! tailscale status --json --peers=false 2>/dev/null | grep -Eq '"BackendState": *"Running"'; then
  ${join}
fi
tailscale set --ssh=false --accept-dns=false </dev/null
`,
  );
}

/** Whether a run needs the auth key: the check found the machine outside a tailnet. */
export function needsAuthKey(missing: readonly string[]): boolean {
  return missing.includes("tailscale-joined") || missing.includes("tailscale-installed") || missing.includes("tailscaled-active");
}
