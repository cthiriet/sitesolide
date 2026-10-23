import { describe, expect, test } from "bun:test";
import * as envfile from "../cli/envfile";
import { RESERVED_ENV as MANIFEST_RESERVED_ENV } from "../cli/manifest";
import {
  BUILD_INHERITED,
  BUILD_INHERITED_PREFIXES,
  buildNameRefusal,
  checkKey,
  checkValue,
  hasNoncharacter,
  isBuildInherited,
  isVariableName,
  KEY_SHAPE,
  looksLikeSecretValue,
  MAX_KEY,
  MAX_VALUE_BYTES,
  PASSWORD_VARIABLE,
  RESERVED_ENV,
  RESERVED_NAMES,
  RESERVED_PREFIXES,
  RESERVED_SUFFIXES,
  reservedReason,
  SECRET_VALUE_PREFIXES,
  VALUE_LIKE_PREFIXES,
} from "../cli/variables";

describe("a variable's name", () => {
  test("letters, digits and underscores, not starting with a digit, 128 at most", () => {
    expect(KEY_SHAPE.source).toBe("^[A-Za-z_][A-Za-z0-9_]*$");
    expect(MAX_KEY).toBe(128);
    for (const name of ["A", "_", "API_KEY", "lower_case", "__proto__", "A".repeat(128)]) expect(isVariableName(name)).toBe(true);
    for (const name of ["", "1A", "A-B", "A B", "A.B", "A=B", "É", "A".repeat(129), 3, null, undefined, ["A"]]) {
      expect({ name, valid: isVariableName(name) }).toEqual({ name, valid: false });
    }
  });

  test("the reserved ones, in the steward's words", () => {
    expect(RESERVED_ENV).toEqual(["PORT", "DATA_DIR", "PUBLIC_DIR"]);
    expect(MANIFEST_RESERVED_ENV).toBe(RESERVED_ENV);
    expect(reservedReason("PORT")).toBe("PORT is set by the deployment, a secret would move the service elsewhere");
    for (const name of ["PATH", "path", "LD_PRELOAD", "NODE_OPTIONS", "https_proxy", "CREDENTIALS_DIRECTORY", "LC_ALL", "PYTHONPATH"]) {
      expect(reservedReason(name)).toBe(`${name} changes how the runtime behaves, not what the site does, and cannot be set here`);
    }
    for (const name of ["API_KEY", "DATABASE_URL", "PASSWORD_HASH"]) expect(reservedReason(name)).toBeNull();
    expect(RESERVED_NAMES).toContain("CREDENTIALS_DIRECTORY");
    expect(RESERVED_PREFIXES).toContain("SYSTEMD_");
    expect(RESERVED_SUFFIXES).toEqual(["_PROXY"]);
  });

  test("checkKey: the shape, the reserved names, what the unit sets", () => {
    expect(checkKey("")).toBe("the variable name is empty");
    expect(checkKey("A".repeat(129))).toBe("the variable name is longer than 128 characters");
    expect(checkKey("1A")).toBe("letters, digits and underscores, not starting with a digit");
    expect(checkKey("HOME")).toBe("HOME changes how the runtime behaves, not what the site does, and cannot be set here");
    expect(checkKey("API_URL", ["API_URL"])).toBe("API_URL is set by the service unit, a secret would silently override it");
    expect(checkKey("API_KEY", ["API_URL"])).toBeNull();
  });

  test("the password hash's variable", () => {
    expect(PASSWORD_VARIABLE).toBe("PASSWORD_HASH");
  });
});

describe("a variable's value", () => {
  test("checkValue: one line, no null byte, valid Unicode without noncharacter, 8 KiB, none quoted", () => {
    expect(MAX_VALUE_BYTES).toBe(8 * 1024);
    const planted = "sk_live_planted";
    const cases: [string, string | null][] = [
      [`${planted}\nx`, "the value must fit on one line"],
      [`${planted}\rx`, "the value must fit on one line"],
      [`${planted}\0`, "the value contains a null byte"],
      [`${planted}\ud800`, "the value is not valid Unicode"],
      [`${planted}﷐`, "the value holds a Unicode noncharacter, which systemd refuses"],
      [`${planted}${"x".repeat(MAX_VALUE_BYTES)}`, "the value is larger than 8 KiB"],
      ["é".repeat(MAX_VALUE_BYTES / 2), null],
      [`${"é".repeat(MAX_VALUE_BYTES / 2)}x`, "the value is larger than 8 KiB"],
      [`with spaces, 'quotes' "too" and $DOLLARS`, null],
    ];
    for (const [value, reason] of cases) {
      expect(checkValue(value)).toBe(reason);
      if (reason !== null) expect(reason).not.toContain(planted);
    }
  });

  test("hasNoncharacter: the code points systemd refuses beyond a strict decoder", () => {
    for (const value of ["﷐", "﷯", "￾", "￿", "\u{1fffe}", "\u{10ffff}"]) expect(hasNoncharacter(value)).toBe(true);
    for (const value of ["", "plain", "﷏", "ﷰ", "😀", "�"]) expect(hasNoncharacter(value)).toBe(false);
  });
});

describe("what a secret looks like", () => {
  test("a provider's key, in the provider's own case", () => {
    for (const value of ["sk_live_x", "sk_test_x", "whsec_x", "sk-proj-x", "sk-ant-x", "AKIAx", "ASIAx", "ghp_x", "github_pat_x", "glpat-x", "xoxb-x", "SG.x", "hf_x", "dop_v1_x"]) {
      expect({ value, looks: looksLikeSecretValue(value) }).toEqual({ value, looks: true });
    }
    for (const value of ["pk_live_x", "pk_test_x", "SK_LIVE_KEY", "GHP_TOKEN", "AKI", "production", "https://x.test", ""]) {
      expect({ value, looks: looksLikeSecretValue(value) }).toEqual({ value, looks: false });
    }
  });

  test("where a name goes, Stripe's publishable live key is a value too", () => {
    expect(VALUE_LIKE_PREFIXES).toEqual([...SECRET_VALUE_PREFIXES, "pk_live"]);
    // What the CLI refused before these lists existed is still refused.
    for (const prefix of ["sk_", "rk_", "pk_live", "whsec_", "ghp_", "gho_", "github_pat_", "xox", "AKIA", "sst_", "glpat-"]) {
      expect(VALUE_LIKE_PREFIXES).toContain(prefix);
    }
  });
});

describe("the build's environment", () => {
  test("what every build inherits: locations, identity, terminal, language, toolchains, never NODE_ENV nor sitesolide's", () => {
    expect(BUILD_INHERITED_PREFIXES).toEqual(["LC_", "XDG_"]);
    for (const name of ["PATH", "HOME", "USER", "LANG", "TZ", "TMPDIR", "CI", "BUN_INSTALL", "NVM_DIR", "GOPATH", "CARGO_HOME", "DEVELOPER_DIR", "LC_ALL", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"]) {
      expect({ name, inherited: isBuildInherited(name) }).toEqual({ name, inherited: true });
    }
    // SSH_AUTH_SOCK names the agent whose keys log into the machine: never inherited.
    for (const name of ["NODE_ENV", "SITESOLIDE_TOKEN", "SITESOLIDE_BINARY", "AWS_SECRET_ACCESS_KEY", "NPM_TOKEN", "HTTPS_PROXY", "path", "SSH_AUTH_SOCK", "SSH_AGENT_PID"]) {
      expect({ name, inherited: isBuildInherited(name) }).toEqual({ name, inherited: false });
    }
    expect(BUILD_INHERITED.filter((name) => name.startsWith("SITESOLIDE_"))).toEqual([]);
    expect(new Set(BUILD_INHERITED).size).toBe(BUILD_INHERITED.length);
  });

  test("a build secret's name: a variable, not sitesolide's, not inherited, the refused one never quoted", () => {
    expect(buildNameRefusal("CMS_TOKEN")).toBeNull();
    expect(buildNameRefusal("NODE_ENV")).toBeNull();
    // A build that fetches a private dependency over SSH names the agent itself.
    expect(buildNameRefusal("SSH_AUTH_SOCK")).toBeNull();
    expect(buildNameRefusal("SITESOLIDE_TOKEN")).toBe("SITESOLIDE_TOKEN is sitesolide's own: a build never receives a SITESOLIDE_ variable");
    expect(buildNameRefusal("PATH")).toBe("PATH reaches every build from whoever deploys already: it needs no declaring");
    expect(buildNameRefusal("LC_ALL")).toBe("LC_ALL reaches every build from whoever deploys already: it needs no declaring");
    for (const name of ["sk-proj-planted", "", "1A", "A".repeat(129)]) {
      const refusal = buildNameRefusal(name);
      expect(refusal).toBe("letters, digits and underscores, not starting with a digit, 128 characters at most");
    }
  });
});

describe("one copy", () => {
  test("envfile.ts re-exports these rules, it does not copy them", () => {
    expect(envfile.checkKey).toBe(checkKey);
    expect(envfile.checkValue).toBe(checkValue);
    expect(envfile.reservedReason).toBe(reservedReason);
    expect(envfile.RESERVED_NAMES).toBe(RESERVED_NAMES);
    expect(envfile.RESERVED_PREFIXES).toBe(RESERVED_PREFIXES);
    expect(envfile.RESERVED_SUFFIXES).toBe(RESERVED_SUFFIXES);
    expect(envfile.MAX_KEY).toBe(MAX_KEY);
    expect(envfile.MAX_VALUE_BYTES).toBe(MAX_VALUE_BYTES);
  });

  test("variables.ts imports nothing: the manifest and the parser both read it", async () => {
    const source = await Bun.file(new URL("../cli/variables.ts", import.meta.url)).text();
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
