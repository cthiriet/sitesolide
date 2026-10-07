/**
 * The step engine of `sitesolide setup`, and of `sitesolide upgrade`: a list of
 * steps, each with a check that only reads and a run that changes, gone
 * through in order.
 *
 * WHAT MAKES SETUP RESUMABLE, AND A NO-OP ON A MACHINE ALREADY INSTALLED. A
 * step whose check says done is not run, whatever happened before: a second
 * run on an installed machine therefore reads everything and changes nothing,
 * and a run after a failure finds the steps before the failing one done and
 * starts again at the one that failed. Nothing is kept on the workstation
 * about how far a run went: the machine itself says it, every time.
 *
 * WHAT A CHECK MUST NEVER DO IS GUESS. It answers done, missing with the
 * names of what is missing, or unreadable: a connection that failed, an
 * output it does not recognise. Unreadable stops the run before the step,
 * nothing changed: running a step on a reading that failed would redo, on a
 * machine in service, something that was already there.
 *
 * After a run, the check is asked again: a step that ran without error but
 * left something missing has failed, and says what. A step whose result no
 * check can see at once, DNS records the resolvers have not caught up with,
 * says so with `recheck: false`, and its run is then its own proof.
 *
 * The first failure stops the run: every step leans on the ones before it,
 * and the report names the step, the reason, and the command that shows more.
 *
 * Also here, the shape of a check written in shell: a list of conditions, each
 * with the name it is reported under, and a last line the engine reads. The
 * scripts travel on standard input, never in the arguments of a command.
 */

/** What a check found. */
export type Check =
  | { state: "done" }
  | { state: "missing"; missing: string[] }
  | { state: "unreadable"; reason: string };

/**
 * `done`: found done, not run. `ok`: run now, and checked. `skip`: left out of
 * this run, for a reason the report gives. `todo`: missing, in a run that
 * only checks. `fail`: the step that stopped the run.
 */
export type StepStatus = "done" | "ok" | "skip" | "todo" | "fail";

export type Step<C> = {
  id: string;
  title: string;
  /** Why the step is left out of this run, or null. */
  skip?: (context: C) => string | null;
  /** Reads, and only reads. */
  check: (context: C) => Promise<Check>;
  /**
   * Does what the check found missing. Throws a StepFailure to stop the run
   * with its reason; may return a line for the report.
   */
  run: (context: C, missing: string[]) => Promise<string | void>;
  /** False when the run is its own proof; the check is asked again otherwise. */
  recheck?: boolean;
  /** The command a person runs to see what went wrong. */
  inspect: (context: C) => string;
};

/** A step that could not do its work: why, and what else to read. */
export class StepFailure extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "StepFailure";
  }
}

export type StepReport = { step: string; title: string; status: StepStatus; detail: string | null };

export type Failure = { step: string; title: string; message: string; details: string[]; inspect: string };

export type Outcome = { reports: StepReport[]; failure: Failure | null };

export type EngineOptions<C> = {
  /** Checks every step and runs none: a dry run, or the question of whether everything is done. */
  checkOnly: boolean;
  /** Called once per step, as soon as its status is known. */
  report: (report: StepReport) => void;
  /** Called before a step runs, with what its check found missing. */
  starting?: (step: Step<C>, missing: string[]) => void;
  /** How a report words what a check found missing; `was missing: ...` unless given. */
  describe?: (missing: readonly string[]) => string;
};

function describe(error: unknown): { message: string; details: string[] } {
  if (error instanceof StepFailure) return { message: error.message, details: error.details };
  return { message: error instanceof Error ? error.message : String(error), details: [] };
}

/** `missing: a, b` for a report line. */
export function missingLine(missing: readonly string[]): string {
  return `was missing: ${missing.join(", ")}`;
}

/**
 * Goes through the steps in order. In a run that only checks, a step that is
 * not done, or whose check cannot be read, is `todo` and the next one is
 * checked all the same; in a real run, the first failure stops everything.
 */
export async function runSteps<C>(steps: readonly Step<C>[], context: C, options: EngineOptions<C>): Promise<Outcome> {
  const reports: StepReport[] = [];
  const describeMissing = options.describe ?? missingLine;
  const record = (step: Step<C>, status: StepStatus, detail: string | null): void => {
    const report = { step: step.id, title: step.title, status, detail };
    reports.push(report);
    options.report(report);
  };
  const fail = (step: Step<C>, message: string, details: string[]): Outcome => {
    record(step, "fail", message);
    return { reports, failure: { step: step.id, title: step.title, message, details, inspect: step.inspect(context) } };
  };

  for (const step of steps) {
    const reason = step.skip?.(context) ?? null;
    if (reason !== null) {
      record(step, "skip", reason);
      continue;
    }

    let found: Check;
    try {
      found = await step.check(context);
    } catch (error) {
      found = { state: "unreadable", reason: describe(error).message };
    }
    if (found.state === "done") {
      record(step, "done", null);
      continue;
    }
    if (options.checkOnly) {
      record(step, "todo", found.state === "missing" ? describeMissing(found.missing) : `unreadable: ${found.reason}`);
      continue;
    }
    if (found.state === "unreadable") {
      return fail(step, `could not tell whether it is done: ${found.reason}`, ["nothing was changed by this step"]);
    }

    options.starting?.(step, found.missing);
    let said: string | void;
    try {
      said = await step.run(context, found.missing);
    } catch (error) {
      const { message, details } = describe(error);
      return fail(step, message, details);
    }

    if (step.recheck !== false) {
      let after: Check;
      try {
        after = await step.check(context);
      } catch (error) {
        after = { state: "unreadable", reason: describe(error).message };
      }
      if (after.state === "missing") return fail(step, `ran, but still missing: ${after.missing.join(", ")}`, []);
      if (after.state === "unreadable") return fail(step, `ran, but could not be checked afterwards: ${after.reason}`, []);
    }
    record(step, "ok", typeof said === "string" ? said : describeMissing(found.missing));
  }
  return { reports, failure: null };
}

// --- checks written in shell -------------------------------------------------

/** One thing a check verifies: a shell test, and the name it is reported under when it fails. */
export type Condition = { label: string; test: string };

const LABEL = /^[a-z0-9][a-z0-9:@.-]*$/;
/** `setup:<step>:<verb>`, or `upgrade:<component>:<verb>` for `sitesolide upgrade`'s own checks. */
const TAG = /^(setup|upgrade):[a-z0-9-]+:[a-z]+$/;

/**
 * The script a check sends: every condition tested, its output thrown away,
 * and one last line that says what failed. Every condition is tested even
 * after one has failed, so that the report names everything missing at once.
 *
 * `prelude` defines what the conditions share, a function or a variable; it
 * must print nothing.
 */
export function checkScript(tag: string, conditions: readonly Condition[], prelude = ""): string {
  if (!TAG.test(tag)) throw new Error(`unexpected tag: ${tag}`);
  for (const { label } of conditions) {
    if (!LABEL.test(label)) throw new Error(`unexpected label: ${label}`);
  }
  return [
    `# sitesolide ${tag}`,
    'missing=""',
    ...(prelude === "" ? [] : [prelude]),
    ...conditions.map(({ label, test }) => `{ ${test}; } >/dev/null 2>&1 || missing="$missing ${label}"`),
    'if [ -z "$missing" ]; then echo "check: done"; else echo "check: missing$missing"; fi',
    "",
  ].join("\n");
}

/** The labels a check script reports, in order: what a fake machine reads to answer it. */
export function scriptLabels(script: string): string[] {
  return [...script.matchAll(/\|\| missing="\$missing ([a-z0-9][a-z0-9:@.-]*)"/g)].map((match) => match[1]!);
}

/** The tag a script carries on its first line. */
export function scriptTag(script: string): string | null {
  return /^# sitesolide ((?:setup|upgrade):[a-z0-9-]+:[a-z]+)\n/.exec(script)?.[1] ?? null;
}

/**
 * What a check's output says. Only its last `check:` line counts: a shell
 * that printed something else, or nothing at all, gives an unreadable answer
 * rather than a guess.
 */
export function readCheck(output: string, error = ""): Check {
  const lines = output.split("\n").map((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line === "check: done") return { state: "done" };
    const missing = /^check: missing (.+)$/.exec(line);
    if (missing !== null) return { state: "missing", missing: missing[1]!.split(" ").filter((label) => label !== "") };
  }
  const said = error.trim().split("\n").filter((line) => line !== "").at(-1);
  return { state: "unreadable", reason: said ?? "no answer" };
}
