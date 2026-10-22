import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onDemandPolicy, parseZoneNames } from "../../api/src/zone";
import { CLOUDFLARE } from "../cli/dns/cloudflare";
import { HOLDER_NAME, LOCK_NAME, RUN_DIR } from "../cli/caddy-lock";
import { SCRIPT_PATH } from "../cli/harden";
import { scriptLabels, scriptTag } from "../cli/steps";
import {
  CADDY_RESTART,
  caddyRestartScript,
  CLOUDFLARE_POLICY,
  isOnDemand,
  recognisedPolicy,
  TLS_ZONE_RESTARTED,
  shellAssignments,
  TLS_ZONE_FILE,
  TLS_ZONE_STATE_COMMAND,
  TLS_ZONE_STATES,
  tlsZoneCheck,
  tlsZoneContent,
  tlsZoneRun,
  policyPending,
  ZONE_NAMES_COMMAND,
  ZONE_NAMES_FILE,
  type TlsZoneMode,
} from "../cli/tls";

/**
 * The zone's TLS policy, /etc/caddy/tls-zone.caddy: its content, what setup's
 * step reads and runs, and the two commands bin/deploy-caddy.sh sends, the
 * scripts run here on a folder that stands in for the machine. Whether Caddy
 * reads the file as it read the policy written inline is cli-tls-caddy.test.ts's.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** What a script that only reads never says. */
const WRITES = ["install -", "mv -", "rm -", "chmod ", "chown ", "systemctl ", "caddy validate", "> "];
const ON_DEMAND = tlsZoneContent({ kind: "on-demand" });
const CLOUDFLARE_CONTENT = tlsZoneContent(CLOUDFLARE_POLICY);

const temporary: string[] = [];
afterEach(() => {
  while (temporary.length > 0) rmSync(temporary.pop()!, { recursive: true, force: true });
});

function folder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

/** The `tls` block of a policy, its comments left out: what Caddy reads of it. */
function block(content: string): string {
  return content
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

describe("tlsZoneContent", () => {
  test("Cloudflare's is the block the Caddyfile carried inline up to 0.6, under a header that says what it is", () => {
    expect(block(CLOUDFLARE_CONTENT)).toBe("tls {\n\tdns cloudflare {env.CLOUDFLARE_API_TOKEN}\n}\n");
    expect(CLOUDFLARE_CONTENT).toStartWith("# The served zone's TLS policy, imported by name by the (tls-zone) snippet of\n");
    expect(CLOUDFLARE_CONTENT).toContain("# Cloudflare: one certificate for the zone and one for its wildcard");
    expect(CLOUDFLARE_CONTENT).toContain("Laid by sitesolide setup");
  });

  test("setup's Cloudflare and the policy bin/deploy-caddy.sh lays are the same bytes", () => {
    // An upgraded machine then passes setup's check as it stands: setup run
    // again finds the file it would lay, and changes nothing.
    expect(tlsZoneContent({ kind: "dns", title: CLOUDFLARE.title, directive: CLOUDFLARE.caddy.directive })).toBe(CLOUDFLARE_CONTENT);
  });

  test("manual DNS turns on-demand issuance on, as the shared service reads it", () => {
    expect(block(ON_DEMAND)).toBe("tls {\n\ton_demand\n}\n");
    expect(ON_DEMAND).toContain(ZONE_NAMES_FILE);
    expect([isOnDemand(ON_DEMAND), onDemandPolicy(ON_DEMAND)]).toEqual([true, true]);
    expect([isOnDemand(CLOUDFLARE_CONTENT), onDemandPolicy(CLOUDFLARE_CONTENT)]).toEqual([false, false]);
  });

  test("a provider's block of its own is indented one tab per level, whatever it came with", () => {
    const content = tlsZoneContent({
      kind: "dns",
      title: "Azure DNS",
      directive: ["dns azure {", "\ttenant_id {env.AZURE_TENANT_ID}", "    client_secret {env.AZURE_CLIENT_SECRET}", "resource_group_name {env.AZURE_RESOURCE_GROUP}", "}", "propagation_timeout 5m"],
    });
    expect(block(content)).toBe(
      [
        "tls {",
        "\tdns azure {",
        "\t\ttenant_id {env.AZURE_TENANT_ID}",
        "\t\tclient_secret {env.AZURE_CLIENT_SECRET}",
        "\t\tresource_group_name {env.AZURE_RESOURCE_GROUP}",
        "\t}",
        "\tpropagation_timeout 5m",
        "}",
        "",
      ].join("\n"),
    );
    expect(content).toContain("# Azure DNS: one certificate");
  });

  const refused: Array<[string, readonly string[], string]> = [
    ["a newline", ["dns cloudflare {env.TOKEN}\n}\nimport /tmp/evil"], "newline"],
    ["a carriage return", ["dns cloudflare {env.TOKEN}\r"], "newline"],
    ["a control character", ["dns cloudflare\u0000 {env.TOKEN}"], "control character"],
    ["a double quote", ['dns cloudflare "{env.TOKEN}'], "quote"],
    ["a backquote", ["dns cloudflare `{env.TOKEN}`"], "quote"],
    ["a backslash", ["dns cloudflare {env.TOKEN}\\"], "backslash"],
    ["a comment", ["dns cloudflare {env.TOKEN} # {"], "#"],
    ["{$NAME}, substituted into the configuration", ["dns cloudflare {$CLOUDFLARE_API_TOKEN}"], "{$"],
    ["an import", ["dns cloudflare {env.TOKEN}", "import /etc/caddy/other.caddy"], "imports a file"],
    ["on_demand", ["dns cloudflare {env.TOKEN}", "on_demand"], "on_demand"],
    ["a brace that closes the tls block", ["dns cloudflare {env.TOKEN}", "}", "respond 200"], "closes the tls block"],
    ["a block left open", ["dns azure {", "tenant_id {env.T}"], "leaves a block open"],
    ["a brace in the middle of a line", ["dns cloudflare { api_token {env.T} }"], "neither opens nor closes"],
    ["a lowercase variable, not a placeholder this module reads", ["dns cloudflare {env.token}"], "neither opens nor closes"],
    ["a token written in", ["dns cloudflare 0123456789abcdefABCDEF0123456789abcdefAB"], "credential written in"],
    ["an access key written in", ["dns route53 {", "access_key_id AKIAIOSFODNN7EXAMPLE", "}"], "credential written in"],
    ["a long secret without a digit", ["dns route53 {", "secret_access_key wJalrXUtnFEMIKbPxRfiCYEXAMPLEKEYwJalrXUtnFEMI", "}"], "credential written in"],
    ["an empty line", ["dns cloudflare {env.TOKEN}", "  "], "empty"],
    ["no directive at all", [], "empty directive"],
    ["a first line that is not dns <module>", ["resolvers 1.1.1.1", "dns cloudflare {env.TOKEN}"], "starts with dns <module>"],
  ];
  for (const [what, directive, message] of refused) {
    test(`refuses a directive with ${what}`, () => {
      expect(() => tlsZoneContent({ kind: "dns", title: "Test", directive })).toThrow(message);
    });
  }

  test("refuses a title that would leave its comment line", () => {
    for (const title of ["", "Cloud\nflare", "Cloud\rflare", "x".repeat(61)]) {
      expect(() => tlsZoneContent({ kind: "dns", title, directive: CLOUDFLARE_POLICY.directive })).toThrow("is not a provider's title");
    }
  });
});

describe("tlsZoneCheck", () => {
  test("reads the file, its owner and mode, and its fingerprint, and only reads", () => {
    const script = tlsZoneCheck(CLOUDFLARE_CONTENT);
    expect(scriptTag(script)).toBe("setup:tls-zone:check");
    expect(scriptLabels(script)).toEqual(["tls-zone-file", "tls-zone-permissions", "tls-zone-same"]);
    expect(script).toContain(new Bun.CryptoHasher("sha256").update(CLOUDFLARE_CONTENT).digest("hex"));
    expect(script).toContain("'root:root 644'");
    for (const write of WRITES) expect(script).not.toContain(write);
  });

  test("with manual DNS, also wants the list of the zone's sites", () => {
    expect(scriptLabels(tlsZoneCheck(ON_DEMAND))).toEqual(["tls-zone-file", "tls-zone-permissions", "tls-zone-same", "zone-names", "no-wildcard"]);
  });
});

/**
 * A folder standing in for the machine: /etc/caddy, /srv/sites, and the
 * commands a run calls, as stubs that log what they were asked. `install`
 * copies, BSD's taking no /dev/stdin; `chown` does nothing.
 */
type Machine = { root: string; etc: string; sites: string; run: string; path: string; calls: () => string[]; lock: () => string | null; localize: (script: string) => string };

function machine(): Machine {
  const root = folder("tls-machine-");
  const etc = join(root, "etc", "caddy");
  const sites = join(root, "srv", "sites");
  const run = join(root, "run", "sitesolide-gatekeeper");
  const stubs = join(root, "stubs");
  mkdirSync(etc, { recursive: true });
  mkdirSync(sites, { recursive: true });
  mkdirSync(stubs);
  const log = join(root, "calls");
  const stub = (name: string, body: string): void => {
    writeFileSync(join(stubs, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(stubs, name), 0o755);
  };
  stub("install", 'while [ "$#" -gt 2 ]; do case "$1" in -m) mode="$2"; shift 2 ;; -o|-g) shift 2 ;; *) shift ;; esac; done\ncat "$1" > "$2" && chmod "$mode" "$2"');
  stub("chown", "exit 0");
  // A restart says who holds the Caddy lock at that moment, and fails while
  // `restart-fails` is there, `restart-hangs-up` hangs the script's session up.
  stub(
    "systemctl",
    [
      `if [ "$1" = restart ]; then echo "lock held by $(cat "${run}/${LOCK_NAME}/${HOLDER_NAME}" 2>/dev/null)" >> "${log}"; fi`,
      `if [ "$1" = restart ] && [ -e "${join(root, "restart-hangs-up")}" ]; then kill -HUP $PPID; exit 0; fi`,
      `if [ "$1" = restart ] && [ -e "${join(root, "restart-fails")}" ]; then exit 1; fi`,
      `[ "$1" != is-active ] || [ -e "${join(root, "active")}" ]`,
    ].join("\n"),
  );
  stub("caddy", `[ -e "${join(root, "valid")}" ]`);
  // Caddy's settling, three seconds on a machine, none here.
  stub("sleep", "exit 0");
  const path = `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`;
  return {
    root,
    etc,
    sites,
    run,
    path,
    lock: () => (existsSync(join(run, LOCK_NAME)) ? readFileSync(join(run, LOCK_NAME, HOLDER_NAME), "utf8").trim() : null),
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : []),
    localize: (script) =>
      script
        .replace(SCRIPT_PATH, `export PATH=${path}`)
        .replaceAll("/etc/caddy", etc)
        .replaceAll("/srv/sites", sites)
        .replaceAll("/var/lib/caddy", join(root, "var", "lib", "caddy"))
        .replaceAll(RUN_DIR, run)
        .replace(/^sudo sh -c '/, "sh -c '"),
  };
}

type Ran = { code: number; output: string; error: string };

/** A run script, on standard input, as setup sends it. */
function sh(script: string): Ran {
  const run = Bun.spawnSync(["sh", "-s"], { stdin: new TextEncoder().encode(script), stdout: "pipe", stderr: "pipe" });
  return { code: run.exitCode, output: run.stdout.toString(), error: run.stderr.toString() };
}

/** A command, as the remote shell runs an ssh argument, the stubs first on the PATH. */
function shCommand(m: Machine, command: string): Ran {
  const run = Bun.spawnSync(["sh", "-c", m.localize(command)], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: m.path } });
  return { code: run.exitCode, output: run.stdout.toString(), error: run.stderr.toString() };
}

describe("policyPending", () => {
  test("true only when a Caddy that runs the policy file would get another policy, which tls-zone restarts it for", () => {
    const m = machine();
    const pending = (content: string) => shCommand(m, policyPending(content)).code === 0;
    // As setup lays it: the fingerprint is the content's, its paths unmoved.
    writeFileSync(join(m.etc, "tls-zone.caddy"), CLOUDFLARE_CONTENT);
    // A Caddyfile from before the policy file: no restart comes from tls-zone.
    writeFileSync(join(m.etc, "Caddyfile"), "(tls-zone) {\n\ttls {\n\t\tdns cloudflare {env.CLOUDFLARE_API_TOKEN}\n\t}\n}\n");
    writeFileSync(join(m.root, "active"), "");
    expect(pending(ON_DEMAND)).toBe(false);
    writeFileSync(join(m.etc, "Caddyfile"), `(tls-zone) {\n\timport ${join(m.etc, "tls-zone.caddy")}\n}\n`);
    expect(pending(ON_DEMAND)).toBe(true);
    expect(pending(CLOUDFLARE_CONTENT)).toBe(false);
    rmSync(join(m.root, "active"));
    expect(pending(ON_DEMAND)).toBe(false);
  });
});

describe("tlsZoneRun", () => {
  /** A machine in service: the Caddyfile imports the policy, Caddy is active, validation passes unless told. */
  function inService(m: Machine, policy: string | null, valid = true): void {
    writeFileSync(join(m.etc, "Caddyfile"), `(tls-zone) {\n\timport ${join(m.etc, "tls-zone.caddy")}\n}\n`);
    writeFileSync(join(m.etc, "sitesolide.env"), "SITESOLIDE_ZONE=test-zone.invalid\n");
    if (policy !== null) writeFileSync(join(m.etc, "tls-zone.caddy"), policy);
    writeFileSync(join(m.root, "active"), "");
    if (valid) writeFileSync(join(m.root, "valid"), "");
  }
  const restarts = (m: Machine) => m.calls().filter((call) => call === "systemctl restart caddy").length;

  test("on a first install: the file laid, root:root 0644 asked, Caddy left alone", () => {
    const m = machine();
    const r = sh(m.localize(tlsZoneRun(CLOUDFLARE_CONTENT)));
    expect(r.error).toBe("");
    expect(r.code).toBe(0);
    // The paths of its comments moved with the machine's folder, nothing else.
    expect(readFileSync(join(m.etc, "tls-zone.caddy"), "utf8")).toBe(m.localize(CLOUDFLARE_CONTENT));
    expect(m.calls().filter((call) => call.startsWith("install"))).toEqual([`install -m 644 -o root -g root /dev/stdin ${m.etc}/.tls-zone.caddy.new`]);
    expect(m.calls().some((call) => call.startsWith("systemctl restart") || call.startsWith("caddy"))).toBe(false);
    expect(existsSync(join(m.etc, ".tls-zone.caddy.new"))).toBe(false);
    // Nothing restarts, nothing to race: no lock taken.
    expect(existsSync(m.run)).toBe(false);
  });

  test("a new policy on a Caddy in service: validated, then Caddy restarted, the lock held across, and said", () => {
    const m = machine();
    inService(m, CLOUDFLARE_CONTENT);
    const r = sh(m.localize(tlsZoneRun(ON_DEMAND, 4242)));
    expect(r.code).toBe(0);
    expect(r.output).toContain(TLS_ZONE_RESTARTED);
    const calls = m.calls();
    expect(calls.indexOf("systemctl restart caddy")).toBeGreaterThan(calls.findIndex((call) => call.startsWith("caddy validate")));
    // A restart, which loads a new binary and a new environment file: never a reload, never caddy stop or start.
    expect(calls.some((call) => /^systemctl reload|^caddy (stop|start)\b/.test(call))).toBe(false);
    expect(calls.find((call) => call.startsWith("lock held by"))).toMatch(/^lock held by setup 4242 [0-9]+$/);
    expect(m.lock()).toBeNull();
    expect(readFileSync(join(m.etc, "tls-zone.caddy"), "utf8")).toBe(m.localize(ON_DEMAND));
  });

  test("the policy the machine already holds: its owner and mode set again, no restart", () => {
    const m = machine();
    inService(m, m.localize(ON_DEMAND));
    const r = sh(m.localize(tlsZoneRun(ON_DEMAND)));
    expect(r.code).toBe(0);
    expect(r.output).toContain("already holds this policy");
    expect(restarts(m)).toBe(0);
    expect(m.calls().some((call) => call.startsWith("caddy validate"))).toBe(false);
    expect(m.lock()).toBeNull();
  });

  test("a Caddy lock held elsewhere stops it before any write", () => {
    const m = machine();
    inService(m, CLOUDFLARE_CONTENT);
    mkdirSync(join(m.run, LOCK_NAME), { recursive: true });
    const holder = `deploy 777 ${Date.now()}`;
    writeFileSync(join(m.run, LOCK_NAME, HOLDER_NAME), `${holder}\n`);
    const r = sh(m.localize(tlsZoneRun(ON_DEMAND, 4242)));
    expect(r.code).toBe(1);
    expect(r.error).toContain(`Caddy is being changed by ${holder}: nothing was changed`);
    expect(readFileSync(join(m.etc, "tls-zone.caddy"), "utf8")).toBe(CLOUDFLARE_CONTENT);
    expect(m.calls().some((call) => call.startsWith("install") || call.startsWith("caddy") || call.startsWith("systemctl restart"))).toBe(false);
    // Somebody else's lock is never handed back.
    expect(m.lock()).toBe(holder);
  });

  test("refused by caddy validate: the previous policy back, no restart, the lock handed back", () => {
    const m = machine();
    inService(m, CLOUDFLARE_CONTENT, false);
    const r = sh(m.localize(tlsZoneRun(ON_DEMAND)));
    expect(r.code).toBe(1);
    expect(r.error).toContain("the previous one is back, Caddy was not restarted");
    expect(readFileSync(join(m.etc, "tls-zone.caddy"), "utf8")).toBe(CLOUDFLARE_CONTENT);
    expect(restarts(m)).toBe(0);
    expect(m.lock()).toBeNull();
  });

  test("a restart that fails: the previous policy back, and Caddy restarted with it", () => {
    const m = machine();
    inService(m, CLOUDFLARE_CONTENT);
    writeFileSync(join(m.root, "restart-fails"), "");
    const r = sh(m.localize(tlsZoneRun(ON_DEMAND)));
    expect(r.code).toBe(1);
    expect(r.error).toContain("nor with the previous one put back");
    expect(readFileSync(join(m.etc, "tls-zone.caddy"), "utf8")).toBe(CLOUDFLARE_CONTENT);
    expect(restarts(m)).toBe(2);
    expect(m.lock()).toBeNull();
  });

  test("a Caddy that does not stay active after its restart counts as a failed restart", () => {
    const m = machine();
    inService(m, CLOUDFLARE_CONTENT);
    // Active when asked before the restart, never after it.
    const stubs = join(m.root, "stubs");
    writeFileSync(join(stubs, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> "${join(m.root, "calls")}"\nif [ "$1" = restart ]; then touch "${join(m.root, "restarted")}"; fi\n[ "$1" != is-active ] || [ ! -e "${join(m.root, "restarted")}" ]\n`);
    const r = sh(m.localize(tlsZoneRun(ON_DEMAND)));
    expect(r.code).toBe(1);
    expect(readFileSync(join(m.etc, "tls-zone.caddy"), "utf8")).toBe(CLOUDFLARE_CONTENT);
  });

  test("a new file that did not exist is removed again on a failure", () => {
    const m = machine();
    inService(m, null, false);
    const r = sh(m.localize(tlsZoneRun(ON_DEMAND)));
    expect(r.code).toBe(1);
    expect(existsSync(join(m.etc, "tls-zone.caddy"))).toBe(false);
  });

  /** Caddy's storage holding the zone's wildcard and its apex, as a provider's DNS challenge left them. */
  function certificates(m: Machine): { wildcard: string; apex: string; library: string } {
    const library = join(m.root, "var", "lib", "caddy");
    const issuer = join(library, ".local", "share", "caddy", "certificates", "acme-v02.api.letsencrypt.org-directory");
    for (const name of ["wildcard_.test-zone.invalid", "test-zone.invalid"]) {
      mkdirSync(join(issuer, name), { recursive: true });
      writeFileSync(join(issuer, name, `${name}.crt`), "a certificate\n");
    }
    return { wildcard: join(issuer, "wildcard_.test-zone.invalid", "wildcard_.test-zone.invalid.crt"), apex: join(issuer, "test-zone.invalid", "test-zone.invalid.crt"), library };
  }
  const leftAside = (library: string) => readdirSync(library).filter((name) => name.startsWith("sitesolide-wildcards"));

  test("turning to certificates on demand sets the zone's wildcard aside, which nothing would renew, and keeps the apex", () => {
    const m = machine();
    inService(m, CLOUDFLARE_CONTENT);
    const held = certificates(m);
    const r = sh(m.localize(tlsZoneRun(ON_DEMAND)));
    expect(r.code).toBe(0);
    expect(r.output).toContain("wildcard_.test-zone.invalid set aside: a certificate on demand never renews a wildcard");
    expect(existsSync(held.wildcard)).toBe(false);
    expect(existsSync(held.apex)).toBe(true);
    expect(restarts(m)).toBe(1);
    // Gone for good once Caddy runs without it: its key does not linger.
    expect(leftAside(held.library)).toEqual([]);
  });

  test("the wildcard comes back with the previous policy, refused by validation or by the restart", () => {
    for (const failure of ["validate", "restart"] as const) {
      const m = machine();
      inService(m, CLOUDFLARE_CONTENT, failure !== "validate");
      if (failure === "restart") writeFileSync(join(m.root, "restart-fails"), "");
      const held = certificates(m);
      const r = sh(m.localize(tlsZoneRun(ON_DEMAND)));
      expect(r.code).toBe(1);
      expect(readFileSync(join(m.etc, "tls-zone.caddy"), "utf8")).toBe(CLOUDFLARE_CONTENT);
      expect(readFileSync(held.wildcard, "utf8")).toBe("a certificate\n");
      expect(leftAside(held.library)).toEqual([]);
    }
  });

  test("the policy already in place, a wildcard still held: set aside all the same, and Caddy restarted without it", () => {
    const m = machine();
    inService(m, m.localize(ON_DEMAND));
    const held = certificates(m);
    const r = sh(m.localize(tlsZoneRun(ON_DEMAND)));
    expect(r.code).toBe(0);
    expect(r.output).not.toContain("already holds this policy");
    expect(r.output).toContain(TLS_ZONE_RESTARTED);
    expect(existsSync(held.wildcard)).toBe(false);
    expect(readFileSync(join(m.etc, "tls-zone.caddy"), "utf8")).toBe(m.localize(ON_DEMAND));
  });

  test("a provider's policy sets nothing aside", () => {
    const m = machine();
    inService(m, m.localize(ON_DEMAND));
    const held = certificates(m);
    expect(sh(m.localize(tlsZoneRun(CLOUDFLARE_CONTENT))).code).toBe(0);
    expect(existsSync(held.wildcard)).toBe(true);
  });

  test("a session hung up during the restart: the previous policy back, the lock handed back", () => {
    const m = machine();
    inService(m, CLOUDFLARE_CONTENT);
    writeFileSync(join(m.root, "restart-hangs-up"), "");
    const r = sh(m.localize(tlsZoneRun(ON_DEMAND, 4242)));
    expect(r.code).toBe(129);
    expect(readFileSync(join(m.etc, "tls-zone.caddy"), "utf8")).toBe(CLOUDFLARE_CONTENT);
    expect(m.lock()).toBeNull();
    expect(existsSync(join(m.etc, ".tls-zone.caddy.new"))).toBe(false);
  });

  test("with manual DNS, the zone's sites listed beside it", () => {
    const m = machine();
    for (const site of ["kanban", "portal"]) mkdirSync(join(m.sites, site));
    const r = sh(m.localize(tlsZoneRun(ON_DEMAND)));
    expect(r.code).toBe(0);
    expect([...parseZoneNames(readFileSync(join(m.etc, "zone-names"), "utf8"))]).toEqual(["kanban", "portal"]);
  });

  test("refuses a content the heredoc could cut short", () => {
    expect(() => tlsZoneRun(`tls {\n}\nTLS_ZONE\nrm -rf /\n`)).toThrow("not what tlsZoneContent writes");
    expect(() => tlsZoneRun("tls {\n}")).toThrow("not what tlsZoneContent writes");
  });
});

describe("caddyRestartScript", () => {
  /** The platform's Caddyfile in service, Caddy active, validation passing unless told. */
  function platform(m: Machine, valid = true): void {
    writeFileSync(join(m.etc, "Caddyfile"), "{$SITESOLIDE_ZONE} {\n}\n");
    writeFileSync(join(m.etc, "sitesolide.env"), "SITESOLIDE_ZONE=test-zone.invalid\n");
    writeFileSync(join(m.root, "active"), "");
    if (valid) writeFileSync(join(m.root, "valid"), "");
  }

  test("Caddy in service: validated, restarted under the lock, active after, and said with the reason", () => {
    const m = machine();
    platform(m);
    const script = caddyRestartScript("new DNS credentials", 4242);
    expect(scriptTag(script)).toBe("setup:caddy-restart:run");
    const r = sh(m.localize(script));
    expect(r.code).toBe(0);
    expect(r.output.trim()).toBe(`${CADDY_RESTART.restarted} (new DNS credentials)`);
    const calls = m.calls();
    expect(calls.indexOf("systemctl restart caddy")).toBeGreaterThan(calls.findIndex((call) => call.startsWith("caddy validate")));
    expect(calls.find((call) => call.startsWith("lock held by"))).toMatch(/^lock held by setup 4242 [0-9]+$/);
    expect(m.lock()).toBeNull();
  });

  test("Caddy not active, or not with the platform's Caddyfile: nothing done, and said", () => {
    for (const prepare of [(m: Machine) => platform(m), (m: Machine) => writeFileSync(join(m.etc, "Caddyfile"), ":80 {\n}\n")]) {
      const m = machine();
      prepare(m);
      if (existsSync(join(m.root, "active"))) rmSync(join(m.root, "active"));
      const r = sh(m.localize(caddyRestartScript("new DNS credentials")));
      expect(r.code).toBe(0);
      expect(r.output).toStartWith(CADDY_RESTART.skipped);
      expect(m.calls().some((call) => call.startsWith("systemctl restart") || call.startsWith("caddy"))).toBe(false);
      expect(existsSync(m.run)).toBe(false);
    }
  });

  test("refused by caddy validate: not restarted, a failure, the lock handed back", () => {
    const m = machine();
    platform(m, false);
    const r = sh(m.localize(caddyRestartScript("new DNS credentials")));
    expect(r.code).toBe(1);
    expect(r.error).toContain("not restarted (new DNS credentials): caddy validate refuses");
    expect(m.calls()).not.toContain("systemctl restart caddy");
    expect(m.lock()).toBeNull();
  });

  test("a Caddy lock held elsewhere: nothing done", () => {
    const m = machine();
    platform(m);
    mkdirSync(join(m.run, LOCK_NAME), { recursive: true });
    writeFileSync(join(m.run, LOCK_NAME, HOLDER_NAME), `gatekeeper 1 ${Date.now()}\n`);
    const r = sh(m.localize(caddyRestartScript("new DNS credentials")));
    expect(r.code).toBe(1);
    expect(r.error).toContain("Caddy is being changed by gatekeeper 1");
    expect(m.calls().some((call) => call.startsWith("caddy validate") || call === "systemctl restart caddy")).toBe(false);
  });

  test("a restart that fails says where to look", () => {
    const m = machine();
    platform(m);
    writeFileSync(join(m.root, "restart-fails"), "");
    const r = sh(m.localize(caddyRestartScript("new DNS credentials")));
    expect(r.code).toBe(1);
    expect(r.error).toContain("sudo journalctl -u caddy");
    expect(m.lock()).toBeNull();
  });

  test("a reason is words, never anything a shell would read", () => {
    for (const reason of ["", "x".repeat(121), 'a"b', "a`b`", "a$b", "a\nb", "a'b"]) {
      expect(() => caddyRestartScript(reason)).toThrow("is not a reason");
    }
  });
});

describe("ZONE_NAMES_COMMAND", () => {
  /** Folders of every kind /srv/sites may hold, the landing's named after the zone. */
  function lay(sites: string): void {
    for (const site of ["portal", "kanban", "dashboard", "test-zone.invalid", "Upper", "under_score", "-dash", "dash-", "a1", "x".repeat(64)]) mkdirSync(join(sites, site));
    writeFileSync(join(sites, "file-not-a-folder"), "");
    // A name holding a newline is skipped whole, never split into two labels,
    // and a link is no site, whatever it points at.
    mkdirSync(join(sites, "evil\nstolen"));
    symlinkSync(join(sites, "kanban"), join(sites, "linked"));
  }

  test("with manual DNS, lists every folder that is one DNS label, sorted, in a file renamed into place", () => {
    const m = machine();
    lay(m.sites);
    writeFileSync(join(m.etc, "tls-zone.caddy"), ON_DEMAND);
    const r = shCommand(m, ZONE_NAMES_COMMAND);
    expect(r.error).toBe("");
    expect(r.code).toBe(0);
    expect(r.output).toBe("zone-names: 4 site(s) under the zone\n");
    const written = readFileSync(join(m.etc, "zone-names"), "utf8");
    expect(written.split("\n").filter((line) => line !== "" && !line.startsWith("#"))).toEqual(["a1", "dashboard", "kanban", "portal"]);
    expect([...parseZoneNames(written)]).toEqual(["a1", "dashboard", "kanban", "portal"]);
    expect(m.calls()).toEqual([`chown root:root ${join(m.etc, ".zone-names.new")}`]);
    expect(existsSync(join(m.etc, ".zone-names.new"))).toBe(false);
    // Again, the same file: nothing else accumulates.
    expect(shCommand(m, ZONE_NAMES_COMMAND).code).toBe(0);
    expect(readFileSync(join(m.etc, "zone-names"), "utf8")).toBe(written);
  });

  test("with a provider's policy, or none, writes nothing and says so", () => {
    for (const policy of [CLOUDFLARE_CONTENT, null]) {
      const m = machine();
      lay(m.sites);
      if (policy !== null) writeFileSync(join(m.etc, "tls-zone.caddy"), policy);
      const r = shCommand(m, ZONE_NAMES_COMMAND);
      expect(r.code).toBe(0);
      expect(r.output).toBe("zone-names: the zone is not certified on demand, nothing written\n");
      expect(existsSync(join(m.etc, "zone-names"))).toBe(false);
    }
  });

  test("an empty /srv/sites gives an empty list, not a failure", () => {
    const m = machine();
    writeFileSync(join(m.etc, "tls-zone.caddy"), ON_DEMAND);
    const r = shCommand(m, ZONE_NAMES_COMMAND);
    expect(r.code).toBe(0);
    expect(r.output).toBe("zone-names: 0 site(s) under the zone\n");
    expect(parseZoneNames(readFileSync(join(m.etc, "zone-names"), "utf8")).size).toBe(0);
  });

  test("travels as one line with no single quote inside, as an ssh argument", () => {
    expect(ZONE_NAMES_COMMAND).not.toContain("\n");
    expect(ZONE_NAMES_COMMAND.slice("sudo sh -c '".length, -1)).not.toContain("'");
  });
});

describe("TLS_ZONE_STATE_COMMAND", () => {
  function state(policy: string | null, credentials: string | null): string {
    const m = machine();
    if (policy !== null) writeFileSync(join(m.etc, "tls-zone.caddy"), policy);
    if (credentials !== null) writeFileSync(join(m.etc, "cloudflare.env"), credentials);
    return shCommand(m, TLS_ZONE_STATE_COMMAND.replaceAll("sudo ", "")).output.trim();
  }

  test("tells the four states apart, and only reads", () => {
    expect(state(ON_DEMAND, null)).toBe(TLS_ZONE_STATES.onDemand);
    expect(state(CLOUDFLARE_CONTENT, "CLOUDFLARE_API_TOKEN=x\n")).toBe(TLS_ZONE_STATES.dns);
    expect(state(null, "CLOUDFLARE_API_TOKEN=a-token\n")).toBe(TLS_ZONE_STATES.cloudflare);
    // Leading blanks and quotes, which systemd reads, are a token all the same.
    expect(state(null, "  CLOUDFLARE_API_TOKEN=a-token\n")).toBe(TLS_ZONE_STATES.cloudflare);
    expect(state(null, '\tCLOUDFLARE_API_TOKEN="a-token"\n')).toBe(TLS_ZONE_STATES.cloudflare);
    expect(state(null, 'CLOUDFLARE_API_TOKEN=""\n')).toBe(TLS_ZONE_STATES.none);
    // An empty token is no Cloudflare machine, nor is an empty file or none.
    expect(state(null, "CLOUDFLARE_API_TOKEN=\n")).toBe(TLS_ZONE_STATES.none);
    expect(state(null, "")).toBe(TLS_ZONE_STATES.none);
    expect(state(null, null)).toBe(TLS_ZONE_STATES.none);
    for (const write of WRITES) expect(TLS_ZONE_STATE_COMMAND).not.toContain(write);
  });
});

describe("a policy file that is there but holds no policy", () => {
  // Caddy validates all of these, and would put the zone under its default
  // issuers, where the wildcard cannot renew: the state reading stops on them.
  const header = CLOUDFLARE_CONTENT.split("tls {")[0]!;
  const broken: Array<[string, string]> = [
    ["empty", ""],
    ["its header alone", header],
    ["cut short before its closing brace", CLOUDFLARE_CONTENT.slice(0, CLOUDFLARE_CONTENT.lastIndexOf("}"))],
    ["a tls block with neither dns nor on_demand", `${header}tls {\n\tkey_type p384\n}\n`],
    ["on_demand outside any tls block", "on_demand\n"],
  ];
  for (const [what, content] of broken) {
    test(`${what}: unrecognised, by the machine's reading and by recognisedPolicy`, () => {
      const m = machine();
      writeFileSync(join(m.etc, "tls-zone.caddy"), content);
      writeFileSync(join(m.etc, "cloudflare.env"), "CLOUDFLARE_API_TOKEN=a-token\n");
      expect(shCommand(m, TLS_ZONE_STATE_COMMAND.replaceAll("sudo ", "")).output.trim()).toBe(TLS_ZONE_STATES.unrecognised);
      expect(recognisedPolicy(content)).toBeNull();
    });
  }

  test("every policy tlsZoneContent writes is recognised, as what it is", () => {
    expect(recognisedPolicy(CLOUDFLARE_CONTENT)).toBe("dns");
    expect(recognisedPolicy(ON_DEMAND)).toBe("on-demand");
    const azure = tlsZoneContent({ kind: "dns", title: "Azure DNS", directive: ["dns azure {", "tenant_id {env.AZURE_TENANT_ID}", "}"] });
    expect(recognisedPolicy(azure)).toBe("dns");
    const m = machine();
    writeFileSync(join(m.etc, "tls-zone.caddy"), azure);
    expect(shCommand(m, TLS_ZONE_STATE_COMMAND.replaceAll("sudo ", "")).output.trim()).toBe(TLS_ZONE_STATES.dns);
  });
});

describe("what the scripts evaluate", () => {
  test("gives back every value to the byte, Cloudflare's policy included", () => {
    const dir = folder("tls-shell-");
    writeFileSync(join(dir, "assignments"), shellAssignments());
    const run = Bun.spawnSync(["bash", "-c", `eval "$(cat ${join(dir, "assignments")})"; printf '%s' "$TLS_ZONE_CLOUDFLARE"; printf '\\0%s' "$TLS_ZONE_STATE_COMMAND" "$ZONE_NAMES_COMMAND" "$TLS_ZONE_FILE"`], { stdout: "pipe" });
    expect(run.stdout.toString().split("\0")).toEqual([CLOUDFLARE_CONTENT, TLS_ZONE_STATE_COMMAND, ZONE_NAMES_COMMAND, TLS_ZONE_FILE]);
  });

  test("bin/deploy-caddy.sh and bin/generate-domains.sh read them from the module, and the module runs", () => {
    for (const name of ["deploy-caddy.sh", "generate-domains.sh"]) {
      expect(readFileSync(join(REPO_ROOT, "bin", name), "utf8")).toContain('eval "$(bun "$REPO_ROOT/bin/cli/tls.ts")"');
    }
    const run = Bun.spawnSync(["bun", join(REPO_ROOT, "bin", "cli", "tls.ts")], { stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString()).toBe(`${shellAssignments()}\n`);
  });

  test("the Caddyfile's snippet imports the file by name", () => {
    const caddyfile = readFileSync(join(REPO_ROOT, "infra", "caddy", "Caddyfile"), "utf8");
    expect(caddyfile).toContain(`(tls-zone) {\n\timport ${TLS_ZONE_FILE}\n}\n`);
    expect(caddyfile).not.toContain("dns cloudflare");
  });
});

describe("TlsZoneMode", () => {
  test("is what setup hands from a DNS entry, read only", () => {
    const mode: TlsZoneMode = { kind: "dns", title: CLOUDFLARE.title, directive: CLOUDFLARE.caddy.directive };
    expect(tlsZoneContent(mode)).toBe(CLOUDFLARE_CONTENT);
  });
});
