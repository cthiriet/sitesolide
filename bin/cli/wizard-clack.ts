/**
 * The setup wizard's prompts, drawn with Clack (@clack/prompts): the one
 * dependency the CLI carries at run time, bundled into the binary by
 * `bun build --compile`. Only bin/sitesolide.ts imports this file, and only
 * when the wizard runs: no script of the kit reaches it, so the unpacked kit,
 * which has no node_modules, never needs it.
 *
 * What it draws is bin/cli/wizard.ts's Prompter; the questions themselves,
 * and every decision, live there.
 *
 * Setup's own output keeps its contract here: a password goes to standard
 * error, framed so that it stays in the scrollback, and a script of the kit
 * still writes to the terminal as it does without the wizard.
 */
import * as clack from "@clack/prompts";
import { styleText } from "node:util";
import type { StepReport } from "./steps";
import { hintFor } from "./hints";
import type { SetupOutput } from "./setup";
import { Cancelled, type Prompter } from "./wizard";

/** The value of a prompt, or Cancelled thrown when the person cancelled it. */
function answered<T>(value: T | symbol): Exclude<T, symbol> {
  if (clack.isCancel(value) || typeof value === "symbol") throw new Cancelled();
  return value as Exclude<T, symbol>;
}

const dim = (text: string): string => styleText("dim", text);

/** Long lists, the zones of a large provider, are searched rather than scrolled. */
const SEARCH_FROM = 15;

function stepLine(report: StepReport): string {
  return `${report.title}${report.detail === null ? "" : `  ${dim(report.detail)}`}`;
}

/** Setup's lines, in the wizard's frame. */
function setupOutput(): SetupOutput {
  return {
    json: false,
    say: (line) => {
      if (line.trim() === "") return;
      if (line.startsWith("-> ")) return clack.log.step(line.slice(3));
      if (line.startsWith("!! ")) return clack.log.warn(line.slice(3));
      clack.log.message(dim(line.trim()), { spacing: 0 });
    },
    check: (report) => {
      if (report.status === "ok") return clack.log.success(stepLine(report));
      if (report.status === "done") return clack.log.success(dim(`${report.title}, already done${report.detail === null ? "" : `: ${report.detail}`}`));
      if (report.status === "skip") return clack.log.info(stepLine(report));
      if (report.status === "fail") return clack.log.error(stepLine(report));
      clack.log.warn(stepLine(report));
    },
    relay: (stream, line) => (stream === "stdout" ? process.stdout : process.stderr).write(`${dim("│")}  ${line}\n`),
    secret: (lines) => {
      const shown = lines.filter((line) => line.trim() !== "").map((line) => line.trim());
      clack.note(shown.join("\n"), "Store this now, it is shown once", { output: process.stderr });
    },
    error: (message, details) => {
      clack.log.error([message, ...details.map((line) => dim(line)), dim(hintFor(message))].join("\n"));
    },
    result: () => {},
  };
}

/**
 * A spinner while `work` runs. Not Clack's: its spinner puts the terminal in
 * raw mode and ends the process with code 0 on Ctrl+C or Escape, where the
 * wizard must stop as cancelled, with 130 and its last line. Here Ctrl+C
 * stays a signal, turned into Cancelled.
 */
async function wait<T>(message: string, work: () => Promise<T>, done: (result: T) => string): Promise<T> {
  const out = process.stdout;
  const animated = out.isTTY === true;
  const frames = ["◒", "◐", "◓", "◑"];
  let frame = 0;
  const draw = (): void => {
    out.write(`\r\x1b[2K${styleText("magenta", frames[frame++ % frames.length]!)}  ${message}`);
  };
  out.write(`${dim("│")}\n`);
  if (animated) {
    out.write("\x1b[?25l");
    draw();
  }
  const timer = animated ? setInterval(draw, 80) : null;
  let cancel: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(new Cancelled());
  });
  process.once("SIGINT", cancel);
  const end = (symbol: string, text: string): void => {
    if (timer !== null) clearInterval(timer);
    process.off("SIGINT", cancel);
    out.write(`${animated ? "\r\x1b[2K" : ""}${symbol}  ${text}\n${animated ? "\x1b[?25h" : ""}`);
  };
  try {
    const result = await Promise.race([work(), cancelled]);
    end(styleText("green", "◇"), done(result));
    return result;
  } catch (error) {
    end(styleText("red", error instanceof Cancelled ? "■" : "▲"), message);
    throw error;
  }
}

export function clackPrompter(): Prompter {
  return {
    intro: (title) => clack.intro(styleText("inverse", ` ${title} `)),
    outro: (text) => clack.outro(text),
    note: (lines, title) => clack.note(lines.join("\n"), title),
    step: (text) => clack.log.step(text),
    info: (text) => clack.log.info(text),
    warn: (text) => clack.log.warn(text),
    success: (text) => clack.log.success(text),
    error: (text, details = []) => clack.log.error([text, ...details.map((line) => dim(line))].join("\n")),

    async select(message, options, initial) {
      const choices = options.map((option) => ({ value: option.value, label: option.label, ...(option.hint === undefined ? {} : { hint: option.hint }) }));
      if (options.length >= SEARCH_FROM) {
        return answered(
          await clack.autocomplete({
            message,
            options: choices,
            maxItems: 10,
            placeholder: "type to search",
            ...(initial === undefined ? {} : { initialValue: initial }),
          }),
        );
      }
      return answered(await clack.select({ message, options: choices, maxItems: 12, ...(initial === undefined ? {} : { initialValue: initial }) }));
    },

    async text(message, options = {}) {
      return answered(
        await clack.text({
          message,
          ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
          ...(options.initial === undefined ? {} : { initialValue: options.initial }),
          ...(options.validate === undefined ? {} : { validate: (value) => options.validate!(value ?? "") }),
        }),
      );
    },

    async secret(message, validate) {
      return answered(await clack.password({ message, ...(validate === undefined ? {} : { validate: (value) => validate(value ?? "") }) }));
    },

    async confirm(message, initial = true) {
      return answered(await clack.confirm({ message, initialValue: initial }));
    },

    wait,

    task(title) {
      const log = clack.taskLog({ title, limit: 12 });
      return {
        line: (text) => log.message(text),
        succeed: (text) => log.success(text),
        fail: (text) => log.error(text, { showLog: true }),
      };
    },

    setupOutput,
  };
}
