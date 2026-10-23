/**
 * A project's build secrets: the names its manifest lists under
 * `secrets.build`, whose values are taken from whoever deploys, never from
 * the machine.
 *
 * The build runs on the workstation, with an environment made of an allow
 * list (buildEnv in ./kit): nothing of the deployer's reaches it unless it is
 * named. A name under `secrets.build` is how a build asks for one more: a
 * private CMS's token, a registry's. Its value is the deployer's environment's
 * first, then the workstation's file of the project,
 * `~/.config/sitesolide/secrets/<slug>.env`, read with the strict parser the
 * steward uses (./envfile), and only for the names declared.
 *
 * A missing name stops the deployment before anything is read on the machine
 * or sent: the remedy is local, and a build made without its secret would
 * publish a site built wrong. So does a file that does not parse, its line
 * number and reason said, never the line, which may hold a value.
 *
 * Pure but for readWorkstationSecrets, which reads the one file.
 */
import { stat } from "node:fs/promises";
import { envValue, parseEnvBytes } from "./envfile";

export type BuildSecretSource = "environment" | "workstation";

export type BuildSecretsResolution = {
  values: Record<string, string>;
  sources: { name: string; source: BuildSecretSource }[];
  missing: string[];
  /** The workstation file did not parse: line number and reason, never the line. */
  refusal: string | null;
};

/**
 * Each declared name's value: the environment's when it carries the name, an
 * empty value counting as set, else the workstation file's. The file is
 * parsed only when a name is left for it, and only declared names are taken
 * from it. `workstationText` is null when the file does not exist.
 */
export function resolveBuildSecrets(
  names: readonly string[],
  environment: Record<string, string | undefined>,
  workstationText: string | null,
): BuildSecretsResolution {
  const resolution: BuildSecretsResolution = { values: {}, sources: [], missing: [], refusal: null };
  const left: string[] = [];
  for (const name of names) {
    const value = Object.hasOwn(environment, name) ? environment[name] : undefined;
    if (value === undefined) {
      left.push(name);
      continue;
    }
    resolution.values[name] = value;
    resolution.sources.push({ name, source: "environment" });
  }
  if (left.length === 0) return resolution;
  if (workstationText === null) return { ...resolution, missing: left };
  const parsed = parseEnvBytes(new TextEncoder().encode(workstationText));
  if (!parsed.ok) {
    return { ...resolution, missing: left, refusal: parsed.line === 0 ? parsed.reason : `line ${parsed.line}: ${parsed.reason}` };
  }
  for (const name of left) {
    const value = envValue(parsed.document, name);
    if (value === null) {
      resolution.missing.push(name);
      continue;
    }
    resolution.values[name] = value;
    resolution.sources.push({ name, source: "workstation" });
  }
  // In the manifest's order, whichever source each came from.
  resolution.sources.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
  return resolution;
}

export type WorkstationRead = { kind: "absent" } | { kind: "text"; text: string } | { kind: "refused"; reason: string };

/**
 * The workstation file, decoded strictly: a byte that is not UTF-8 would
 * otherwise turn into U+FFFD, and the build get a value nobody wrote. Read
 * only when a build secret is left for it, or `run` asks for it. A folder
 * or anything else that does not read is refused, without its content.
 */
export async function readWorkstationSecrets(path: string): Promise<WorkstationRead> {
  let bytes: Uint8Array;
  try {
    // Bun.file says a folder does not exist: asked first, so that one is refused rather than taken for nothing.
    if (!(await stat(path)).isFile()) return { kind: "refused", reason: "it is not a file" };
    bytes = await Bun.file(path).bytes();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "refused", reason: `it does not read: ${code ?? "an error"}` };
  }
  try {
    return { kind: "text", text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { kind: "refused", reason: "it is not valid UTF-8" };
  }
}

/**
 * resolveBuildSecrets with the workstation file read only when a name is left
 * for it: a build whose secrets the environment carries never opens it. A
 * file that does not read is a refusal, as one that does not parse.
 */
export async function gatherBuildSecrets(names: readonly string[], environment: Record<string, string | undefined>, path: string): Promise<BuildSecretsResolution> {
  const needsFile = names.some((name) => !Object.hasOwn(environment, name) || environment[name] === undefined);
  if (!needsFile) return resolveBuildSecrets(names, environment, null);
  const read = await readWorkstationSecrets(path);
  if (read.kind === "refused") return { values: {}, sources: [], missing: [...names], refusal: read.reason };
  return resolveBuildSecrets(names, environment, read.kind === "text" ? read.text : null);
}

/** How a found secret is said: its name and where it came from, never its value. */
export function sourceLine(name: string, source: BuildSecretSource, path: string): string {
  return `build secret ${name} from ${source === "environment" ? "your environment" : path}`;
}

/** The refusal of a missing build secret: names alone, and what to do. */
export function missingBuildSecrets(missing: readonly string[], path: string): { message: string; details: string[] } {
  return {
    message: `build secrets missing: ${missing.join(", ")}`,
    details: [`export ${missing.length === 1 ? "it" : "them"}, or add ${missing.length === 1 ? "it" : "them"} to ${path}; nothing was sent`],
  };
}

/** The refusal of a workstation file that does not parse: where, and why, never the line. */
export function unreadableWorkstation(path: string, reason: string): { message: string; details: string[] } {
  return {
    message: `the build secrets file does not read: ${path}, ${reason}`,
    details: ["fix that line, one KEY=value per line, the value quoted if it holds a space; nothing was sent", "its content is never shown: a line may hold a value"],
  };
}
