/**
 * A fake ssh, laid at the head of the PATH by fake-vm.ts: what the tests
 * put in place of the machine that serves the clients.
 *
 * It only answers the tests' host, `sample@invalid.local`, and only the
 * commands it recognises word for word: the empty connection of
 * bin/deploy-caddy.sh, the reading of the deposited manifests, the lock shared
 * with the gatekeeper, the fingerprints and the list of the blocks in service.
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
 *   progress.
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
} as const;

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
/** The guard of bin/deploy-caddy.sh, which checks that the unit loads the zone variables. */
export const CADDY_ENV_UNIT = "systemctl show caddy --property=EnvironmentFiles --value";
const FINGERPRINT = /^sudo shasum -a 256 (\/etc\/caddy\/[A-Za-z0-9._\/-]+) 2>\/dev\/null$/;
// `caddy-lock` and its four verbs are what bin/cli/caddy-lock.ts writes into
// the remote script: they are read here, never chosen here.
const LOCK = /^sudo sh -c ': caddy-lock (take|retake|release|verify) ([^;']*);/;

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
  const block = READ_BLOCK.exec(command);
  if (block !== null) {
    record(`BLOCK ${block[2]}`);
    const file = join(vm, block[1]!);
    process.stdout.write(existsSync(file) ? `${MARKER_PRESENT}\n${readFileSync(file, "utf8")}` : `${MARKER_ABSENT}\n`);
    process.exit(0);
  }

  if (existsSync(join(vm, SWITCHES.accept))) {
    const refused = existsSync(join(vm, SWITCHES.refuse))
      ? readFileSync(join(vm, SWITCHES.refuse), "utf8").split("\n").filter((line) => line !== "")
      : [];
    if (!refused.some((refusedPattern) => command.includes(refusedPattern))) {
      await receive(`ACCEPTED ${command}`);
      if (command.includes("/dev/stdin")) await Bun.stdin.text();
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
