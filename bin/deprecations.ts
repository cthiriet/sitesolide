#!/usr/bin/env bun
/**
 * Reports a site's uses of deprecated APIs.
 *
 * `tsc --noEmit` says nothing about them: a deprecation is a suggestion
 * diagnostic, produced by the language service, the one the editor consults.
 * Without this check, it is only seen on the screen of whoever opens the file,
 * and never in integration.
 *
 *   bin/deprecations.ts ../sitesolide-sites/landing
 *   bin/deprecations.ts ../sitesolide-sites/shop
 *
 * Exits 1 as soon as a use is found, so that bin/test.sh counts it as a
 * failure, and 2 if the check itself could not run.
 */
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

/** 6385: deprecated use. 6387: deprecated signature. */
const CODES = new Set([6385, 6387]);

const argument = process.argv[2];
if (!argument) {
  console.error("usage: bin/deprecations.ts <site-folder>");
  process.exit(2);
}

const site = resolve(argument);

let ts: typeof import("typescript");
try {
  // The compiler comes from the site under examination, never from a global
  // install: each site is self-contained, including on its TypeScript version.
  ts = createRequire(join(site, "package.json"))("typescript");
} catch {
  console.error(`typescript not found in ${site}: run bun install`);
  process.exit(2);
}

const raw = ts.readConfigFile(join(site, "tsconfig.json"), ts.sys.readFile);
if (raw.error) {
  console.error(ts.flattenDiagnosticMessageText(raw.error.messageText, " "));
  process.exit(2);
}

const config = ts.parseJsonConfigFileContent(raw.config, ts.sys, site);
if (config.errors.length > 0) {
  for (const error of config.errors) {
    console.error(ts.flattenDiagnosticMessageText(error.messageText, " "));
  }
  process.exit(2);
}

// Only the files declared by the tsconfig are examined: the deprecations of the
// dependencies are none of the site's business.
const service = ts.createLanguageService({
  getScriptFileNames: () => config.fileNames,
  getScriptVersion: () => "1",
  getScriptSnapshot: (name) => {
    const content = ts.sys.readFile(name);
    return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
  },
  getCurrentDirectory: () => site,
  getCompilationSettings: () => config.options,
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
});

const program = service.getProgram();
if (!program) {
  console.error(`analysis impossible for ${site}`);
  process.exit(2);
}

let total = 0;
for (const file of config.fileNames) {
  const source = program.getSourceFile(file);
  if (!source) continue;

  for (const diagnostic of service.getSuggestionDiagnostics(file)) {
    if (!CODES.has(diagnostic.code) || diagnostic.start === undefined) continue;

    const { line } = source.getLineAndCharacterOfPosition(diagnostic.start);
    const excerpt = source.text.slice(diagnostic.start, diagnostic.start + (diagnostic.length ?? 0));
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    console.log(`${file.replace(`${site}/`, "")}:${line + 1}  ${excerpt}  ${message}`);
    total++;
  }
}

if (total > 0) {
  console.log(`${total} deprecated use(s)`);
  process.exit(1);
}

console.log("no deprecated use");
