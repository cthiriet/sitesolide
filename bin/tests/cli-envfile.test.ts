/**
 * The parser of a file systemd reads with EnvironmentFile=, now in bin/cli and
 * borrowed back by the dashboard. Its full tests stay with the steward that
 * writes the files, in dashboard/tests/secrets-envfile.test.ts: this one only
 * checks that the CLI's copy reads as they expect, without the dashboard.
 */
import { describe, expect, test } from "bun:test";
import {
  checkKey,
  checkValue,
  encodeValue,
  envValue,
  keys,
  MAX_KEY,
  MAX_VALUE_BYTES,
  parseEnv,
  parseEnvBytes,
  remove,
  RESERVED_NAMES,
  RESERVED_PREFIXES,
  RESERVED_SUFFIXES,
  reservedReason,
  serialise,
  set,
  unitEnvironment,
  type EnvDocument,
  type EnvLine,
  type EnvParse,
  type UnitEnvFile,
  type UnitEnvironment,
} from "../cli/envfile";

function read(text: string): EnvDocument {
  const parsed: EnvParse = parseEnv(text);
  if (!parsed.ok) throw new Error(`refused line ${parsed.line}: ${parsed.reason}`);
  return parsed.document;
}

describe("the CLI's copy of the parser", () => {
  test("reads the subset it manages, and rewrites it identically", () => {
    const text = "# comment\n\nA=plain\nB='with spaces'\nC=\"it's\"\nD=\n";
    const document = read(text);
    expect(keys(document)).toEqual(["A", "B", "C", "D"]);
    expect(envValue(document, "B")).toBe("with spaces");
    expect(envValue(document, "C")).toBe("it's");
    expect(envValue(document, "D")).toBe("");
    expect(serialise(document)).toBe(text);
    const lines: EnvLine[] = document.lines;
    expect(lines.map((line) => line.kind)).toEqual(["comment", "empty", "assignment", "assignment", "assignment", "assignment"]);
  });

  test("refuses what it could not rewrite, by line, never quoting it", () => {
    const planted = "sk_live_planted";
    for (const [text, line] of [
      [`A=1\nexport B=${planted}\n`, 2],
      [`A = ${planted}\n`, 1],
      [`A=${planted} x\n`, 1],
      [`A=1\nA=${planted}\n`, 2],
      [`A=${planted}\r\n`, 1],
    ] as const) {
      const parsed = parseEnv(text);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.line).toBe(line);
        expect(parsed.reason).not.toContain(planted);
      }
    }
    expect(parseEnvBytes(new Uint8Array([0x41, 0x3d, 0xff]))).toEqual({ ok: false, line: 0, reason: "the file is not valid UTF-8, systemd would ignore all of it" });
  });

  test("sets and removes a variable in place", () => {
    const document = set(set(read("A=1\nB=2\n"), "A", "new value"), "C", "it's $x");
    expect(serialise(document)).toBe("A='new value'\nB=2\nC=\"it's \\$x\"\n");
    expect(serialise(remove(document, "B"))).toBe("A='new value'\nC=\"it's \\$x\"\n");
    expect(() => set(document, "1A", "x")).toThrow();
    expect(() => set(document, "A", "a\nb")).toThrow();
    expect(encodeValue("abc-DEF_0123")).toBe("abc-DEF_0123");
  });

  test("reads the environment a unit sets and the files it loads", () => {
    const unit = "[Service]\nEnvironment=PORT=3040 DATA_DIR=/srv/sites/shop/data\nEnvironmentFile=-/etc/sitesolide/shop.env\n";
    const environment: UnitEnvironment = unitEnvironment(unit);
    const files: UnitEnvFile[] = environment.files;
    expect(environment.keys).toEqual(["PORT", "DATA_DIR"]);
    expect(files).toEqual([{ path: "/etc/sitesolide/shop.env", optional: true }]);
  });

  test("keeps every export it had, the rules re-exported from variables.ts", () => {
    expect(MAX_KEY).toBe(128);
    expect(MAX_VALUE_BYTES).toBe(8192);
    expect(RESERVED_NAMES).toContain("PATH");
    expect(RESERVED_PREFIXES).toContain("LD_");
    expect(RESERVED_SUFFIXES).toEqual(["_PROXY"]);
    expect(reservedReason("PATH")).not.toBeNull();
    expect(checkKey("API_KEY")).toBeNull();
    expect(checkValue("x")).toBeNull();
  });

  test("imports nothing from the manifest, which the store's module reads: no cycle", async () => {
    const source = await Bun.file(new URL("../cli/envfile.ts", import.meta.url)).text();
    const imports = [...source.matchAll(/^(?:import|export)[^;]*?from "([^"]+)"/gms)].map((match) => match[1]);
    expect(imports).toEqual(["./variables", "./variables"]);
  });
});
