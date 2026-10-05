import { describe, expect, test } from "bun:test";
import { checkScript, readCheck, runSteps, scriptLabels, scriptTag, StepFailure, type Check, type Step, type StepReport } from "../cli/steps";

/**
 * The engine `sitesolide setup` goes through its steps with. What it promises
 * is what makes setup safe to run twice: a step found done is never run, a
 * failure stops everything after it, and a run is believed only once its check
 * says so.
 */

type World = { done: Set<string>; ran: string[]; failing: Set<string>; unreadable: Set<string>; lazy: Set<string> };

function world(done: string[] = []): World {
  return { done: new Set(done), ran: [], failing: new Set(), unreadable: new Set(), lazy: new Set() };
}

function step(id: string, extra: Partial<Step<World>> = {}): Step<World> {
  return {
    id,
    title: `the ${id} step`,
    check: async (w): Promise<Check> => {
      if (w.unreadable.has(id)) return { state: "unreadable", reason: "connection closed" };
      return w.done.has(id) ? { state: "done" } : { state: "missing", missing: [`${id}-thing`] };
    },
    run: async (w) => {
      w.ran.push(id);
      if (w.failing.has(id)) throw new StepFailure(`${id} broke`, ["the end of its output"]);
      // A lazy step runs without error and leaves its work undone.
      if (!w.lazy.has(id)) w.done.add(id);
    },
    inspect: () => `inspect ${id}`,
    ...extra,
  };
}

const STEPS = ["one", "two", "three"].map((id) => step(id));

async function go(w: World, checkOnly = false, steps: Step<World>[] = STEPS) {
  const reports: StepReport[] = [];
  const outcome = await runSteps(steps, w, { checkOnly, report: (report) => reports.push(report) });
  return { ...outcome, reports, statuses: reports.map((report) => `${report.step}:${report.status}`) };
}

describe("the step engine", () => {
  test("a fresh world: every step checked, run, and checked again", async () => {
    const w = world();
    const r = await go(w);
    expect(r.failure).toBeNull();
    expect(w.ran).toEqual(["one", "two", "three"]);
    expect(r.statuses).toEqual(["one:ok", "two:ok", "three:ok"]);
    expect(r.reports[0]!.detail).toBe("was missing: one-thing");
  });

  test("a world where everything is done: nothing runs at all", async () => {
    const w = world(["one", "two", "three"]);
    const r = await go(w);
    expect(w.ran).toEqual([]);
    expect(r.statuses).toEqual(["one:done", "two:done", "three:done"]);
  });

  test("a failure stops the run there, names the step, and the next run resumes at it", async () => {
    const w = world();
    w.failing.add("two");
    const first = await go(w);
    expect(first.statuses).toEqual(["one:ok", "two:fail"]);
    expect(first.failure).toEqual({ step: "two", title: "the two step", message: "two broke", details: ["the end of its output"], inspect: "inspect two" });
    expect(w.ran).toEqual(["one", "two"]);

    w.failing.clear();
    w.ran = [];
    const second = await go(w);
    expect(second.failure).toBeNull();
    expect(second.statuses).toEqual(["one:done", "two:ok", "three:ok"]);
    expect(w.ran).toEqual(["two", "three"]);
  });

  test("a run that leaves its work undone fails on the check that follows it", async () => {
    const w = world();
    w.lazy.add("one");
    const r = await go(w);
    expect(r.failure?.step).toBe("one");
    expect(r.failure?.message).toBe("ran, but still missing: one-thing");
    expect(w.ran).toEqual(["one"]);
  });

  test("a step whose run is its own proof is not checked again", async () => {
    const w = world();
    w.lazy.add("one");
    const r = await go(w, false, [step("one", { recheck: false }), step("two")]);
    expect(r.failure).toBeNull();
    expect(r.statuses).toEqual(["one:ok", "two:ok"]);
  });

  test("a check that cannot be read stops the run before that step runs", async () => {
    const w = world(["one"]);
    w.unreadable.add("two");
    const r = await go(w);
    expect(w.ran).toEqual([]);
    expect(r.failure?.step).toBe("two");
    expect(r.failure?.message).toContain("could not tell whether it is done: connection closed");
    expect(r.failure?.details).toContain("nothing was changed by this step");
  });

  test("a check that throws counts as unreadable, never as missing", async () => {
    const w = world();
    const broken = step("one", {
      check: async () => {
        throw new Error("ssh: connect to host refused");
      },
    });
    const r = await go(w, false, [broken]);
    expect(w.ran).toEqual([]);
    expect(r.failure?.message).toContain("ssh: connect to host refused");
  });

  test("a skipped step is neither checked nor run, and says why", async () => {
    const w = world();
    const r = await go(w, false, [step("one", { skip: () => "--minimal" }), step("two")]);
    expect(r.statuses).toEqual(["one:skip", "two:ok"]);
    expect(r.reports[0]!.detail).toBe("--minimal");
    expect(w.ran).toEqual(["two"]);
  });

  test("checking only runs nothing, and goes on past what is missing or unreadable", async () => {
    const w = world(["one"]);
    w.unreadable.add("three");
    const r = await go(w, true);
    expect(w.ran).toEqual([]);
    expect(r.failure).toBeNull();
    expect(r.statuses).toEqual(["one:done", "two:todo", "three:todo"]);
    expect(r.reports[2]!.detail).toBe("unreadable: connection closed");
  });
});

describe("a check written in shell", () => {
  const script = checkScript("setup:caddy:check", [
    { label: "caddy-package", test: "dpkg-query -W caddy" },
    { label: "cloudflare-module", test: "caddy list-modules | grep -q cloudflare" },
  ]);

  test("carries its tag, every condition, and the line the engine reads", () => {
    expect(scriptTag(script)).toBe("setup:caddy:check");
    expect(scriptLabels(script)).toEqual(["caddy-package", "cloudflare-module"]);
    // Every condition is tested, even after one failed: the report names all.
    expect(script).not.toContain("exit");
    expect(script.trimEnd().split("\n").at(-1)).toBe('if [ -z "$missing" ]; then echo "check: done"; else echo "check: missing$missing"; fi');
  });

  test("runs in a POSIX shell, and says exactly what failed", () => {
    const real = checkScript("setup:sample:check", [
      { label: "always", test: "true" },
      { label: "never", test: "false" },
      { label: "noisy", test: "echo something on stdout; echo and on stderr >&2; false" },
    ]);
    const shell = Bun.spawnSync(["sh", "-s"], { stdin: new TextEncoder().encode(real) });
    expect(shell.stdout.toString()).toBe("check: missing never noisy\n");
    expect(readCheck(shell.stdout.toString())).toEqual({ state: "missing", missing: ["never", "noisy"] });
  });

  test("refuses a label or a tag that would break the script", () => {
    expect(() => checkScript("setup:x:check", [{ label: "two words", test: "true" }])).toThrow();
    expect(() => checkScript("setup:x;rm:check", [{ label: "ok", test: "true" }])).toThrow();
  });

  test("an answer without the line is unreadable, never a guess", () => {
    expect(readCheck("check: done\n")).toEqual({ state: "done" });
    expect(readCheck("motd\ncheck: missing a b\n")).toEqual({ state: "missing", missing: ["a", "b"] });
    expect(readCheck("", "sudo: a password is required\n")).toEqual({ state: "unreadable", reason: "sudo: a password is required" });
    expect(readCheck("")).toEqual({ state: "unreadable", reason: "no answer" });
  });
});
