/**
 * Runs the real CLI, as it would run in a terminal.
 *
 * It is bin/sitesolide.ts of the sitesolide repository that executes, with the
 * project's folder as the current directory. The `--dry-run` mode is what
 * makes the test possible without touching the machine that serves the
 * clients.
 *
 * Only the machine is simulated. Even in a dry run, `deploy` reads on the VM
 * the deposited manifest, to know whether the dashboard has changed the site's
 * door: a dry run test therefore receives a simulated VM, empty by default,
 * whose ssh only answers readings and refuses all the rest. See fake-vm.ts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createFakeVm, type FakeVm } from "./fake-vm";

/** The folder of these tests, where the projects and the rejects live. */
export const TESTS_ROOT = import.meta.dir;

/** The repository's root, for the tests that read back what the CLI writes there. */
export const REPO = resolve(TESTS_ROOT, "..", "..", "..");

export const CLI = resolve(REPO, "bin", "sitesolide.ts");

/** The tests' zone: a reserved TLD, which resolves nowhere. */
export const TEST_ZONE = "test-zone.invalid";

/** The tests' contact address, under the same zone that does not resolve. */
export const TEST_EMAIL = `sample@${TEST_ZONE}`;

export type Result = {
  code: number;
  output: string;
  error: string;
  /** The order in which the two streams were written matters little: the tests read both. */
  all: string;
};

function dryRun(arguments_: string[]): boolean {
  return arguments_.includes("--dry-run");
}

/**
 * The VM of the dry run tests that do not ask for one of their own: no site
 * deployed, hence a first pass everywhere, as before `deploy` read the
 * machine. It is never filled, only its log grows.
 */
let emptyVm: FakeVm | null = null;

/**
 * `project` is relative to this folder, or absolute for a project copied
 * elsewhere by the test. `vm` imposes a simulated machine, including outside
 * the dry run mode: a real deployment fails there on the first write, refused.
 * `cli` runs a copy of the CLI laid in a test repository, so that it reads and
 * writes its deployment files somewhere other than in this repository. `env`
 * completes the environment, for example a HOME whose configuration aims at a
 * zone that does not resolve.
 */
export async function run(
  project: string,
  arguments_: string[],
  options: { vm?: FakeVm; cli?: string; env?: Record<string, string> } = {},
): Promise<Result> {
  const vm = options.vm ?? (dryRun(arguments_) ? (emptyVm ??= createFakeVm()) : null);

  const proc = Bun.spawn(["bun", options.cli ?? CLI, ...arguments_], {
    cwd: isAbsolute(project) ? project : join(TESTS_ROOT, project),
    stdout: "pipe",
    stderr: "pipe",
    // The CLI reads SITESOLIDE_SERVER and SITESOLIDE_ZONE like the repository's scripts. A
    // simulated test receives a name that does not resolve, and an ssh that
    // only accepts that name: that way, even a path that forgot the dry run
    // mode would not speak to the machine that serves the clients. The zone
    // follows the same rule, and has no more of a default: this one holds for
    // the tests, not for the CLI.
    env: { SITESOLIDE_ZONE: TEST_ZONE, SITESOLIDE_EMAIL: TEST_EMAIL, ...process.env, ...(vm === null ? {} : vm.env), ...options.env },
  });
  const [output, error] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, output, error, all: `${output}\n${error}` };
}
