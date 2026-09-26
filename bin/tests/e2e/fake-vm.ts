/**
 * A simulated VM, on the workstation: a folder that stands in for /srv/sites,
 * /etc/caddy and /run/sitesolide-gatekeeper, and a PATH whose `ssh` and
 * `rsync` are fakes.
 *
 * `ssh` is fake-ssh.ts, which only answers the commands it recognises and
 * refuses all the rest; `rsync` always refuses. Both record what they were
 * asked in `logs`, which the tests read back: a write that was merely
 * attempted would show up there. `acceptWrites` lifts that refusal for
 * the tests that must let a gesture go further, without anything being
 * executed for all that.
 *
 * `SITESOLIDE_SERVER` is a name that does not resolve, and the fake ssh only accepts
 * that one: the two barriers hold together, as in run.ts.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOLDER_NAME, LOCK_NAME } from "../../cli/caddy-lock";
import { SWITCHES, TEST_HOST } from "./fake-ssh";

export type FakeVm = {
  /** The folder that stands in for the machine. */
  root: string;
  /** What the launched process must receive in its environment. */
  env: Record<string, string>;
  /** Deposits a manifest, like `deploy` or the dashboard's gatekeeper. */
  writeManifest(slug: string, content: string): void;
  /** Lays a block in service, like deploy-caddy.sh or the gatekeeper. */
  writeBlock(slug: string, content: string): void;
  /** Lays any file, `path` being absolute on the VM: `/etc/caddy/Caddyfile`. */
  writeFile(path: string, content: string): void;
  /** What the machine will answer to the reading of the manifests, in place of the script. */
  forceAnswer(output: string): void;
  /**
   * Lays the shared lock, as somebody else would have taken it: `holder`
   * null for a folder without a holder, `ageMs` to age it.
   */
  setLock(holder: string | null, ageMs?: number): void;
  /** The holder of the lock in place, `""` without a holder, null without a lock. */
  lock(): string | null;
  /** The writes succeed without executing anything, except those that contain a refused pattern. */
  acceptWrites(refused?: string[]): void;
  /** The command recorded by this line will wait for `resume()`. */
  pause(line: string): void;
  resume(): void;
  /** Writes this file on the VM at the first accepted write: the gatekeeper acting in the meantime. */
  onFirstAccepted(path: string, content: string): void;
  /** An accepted command that contains `pattern` prints `output`. */
  answer(pattern: string, output: string): void;
  /** The commands received, one per line: CONNECT, READ <pattern>, REFUSED <command>... */
  logs(): string[];
  cleanup(): void;
};

export function createFakeVm(): FakeVm {
  const root = mkdtempSync(join(tmpdir(), "fake-vm-"));
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const logs = join(root, "logs");
  const lockDir = join(root, "run", "sitesolide-gatekeeper", LOCK_NAME);

  const ssh = join(bin, "ssh");
  writeFileSync(ssh, `#!/bin/sh\nexec bun "${join(import.meta.dir, "fake-ssh.ts")}" "$@"\n`);
  const rsync = join(bin, "rsync");
  writeFileSync(
    rsync,
    [
      "#!/bin/sh",
      `if [ -e "${join(root, SWITCHES.accept)}" ]; then echo "ACCEPTED rsync $*" >> "${logs}"; exit 0; fi`,
      `echo "REFUSED rsync $*" >> "${logs}"`,
      'echo "fake rsync: refused" >&2',
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(ssh, 0o755);
  chmodSync(rsync, 0o755);

  const put = (path: string, content: string): void => {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  };

  return {
    root,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SITESOLIDE_SERVER: TEST_HOST,
      FAKE_VM: root,
    },
    writeManifest(slug, content) {
      put(join("srv", "sites", slug, "sitesolide.json"), content);
    },
    writeBlock(slug, content) {
      put(join("etc", "caddy", "sites", `${slug}.caddy`), content);
    },
    writeFile(path, content) {
      put(path, content);
    },
    forceAnswer(output) {
      writeFileSync(join(root, SWITCHES.forcedAnswer), output);
    },
    setLock(holder, ageMs = 0) {
      mkdirSync(lockDir, { recursive: true });
      if (holder !== null) writeFileSync(join(lockDir, HOLDER_NAME), `${holder}\n`);
      const when = new Date(Date.now() - ageMs);
      utimesSync(lockDir, when, when);
    },
    lock() {
      if (!existsSync(lockDir)) return null;
      const holder = join(lockDir, HOLDER_NAME);
      return existsSync(holder) ? readFileSync(holder, "utf8").trim() : "";
    },
    acceptWrites(refused = []) {
      writeFileSync(join(root, SWITCHES.accept), "");
      writeFileSync(join(root, SWITCHES.refuse), refused.map((pattern) => `${pattern}\n`).join(""));
    },
    pause(line) {
      writeFileSync(join(root, SWITCHES.pause), line);
    },
    resume() {
      rmSync(join(root, SWITCHES.pause), { force: true });
    },
    onFirstAccepted(path, content) {
      writeFileSync(join(root, SWITCHES.onFirstAccepted), JSON.stringify({ path, content }));
    },
    answer(pattern, output) {
      const file = join(root, SWITCHES.answers);
      const pairs = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Array<[string, string]>) : [];
      writeFileSync(file, JSON.stringify([...pairs, [pattern, output]]));
    },
    logs() {
      return existsSync(logs) ? readFileSync(logs, "utf8").split("\n").filter((line) => line !== "") : [];
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
