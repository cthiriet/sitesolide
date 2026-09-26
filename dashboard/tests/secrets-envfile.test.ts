import { describe, expect, test } from "bun:test";
import {
  MAX_KEY,
  MAX_VALUE_BYTES,
  parseEnv,
  parseEnvBytes,
  keys,
  encodeValue,
  unitEnvironment,
  set,
  remove,
  serialise,
  envValue,
  checkKey,
  checkValue,
  type EnvDocument,
} from "../src/secrets/envfile";

/** The document, or the test fails saying why the parse refused. */
function read(text: string): EnvDocument {
  const parsed = parseEnv(text);
  if (!parsed.ok) throw new Error(`refused line ${parsed.line}: ${parsed.reason}`);
  return parsed.document;
}

function refusal(text: string): { line: number; reason: string } {
  const parsed = parseEnv(text);
  if (parsed.ok) throw new Error("wrongly accepted");
  return parsed;
}

describe("parsing the accepted forms", () => {
  test("blank lines, comments and assignments, in order", () => {
    const document = read("# Mail\n\n; other\nSID=ID123\n  \n# end\nTOKEN='a b'\n");
    expect(document.lines.map((line) => line.kind)).toEqual([
      "comment",
      "empty",
      "comment",
      "assignment",
      "empty",
      "comment",
      "assignment",
    ]);
    expect(keys(document)).toEqual(["SID", "TOKEN"]);
    expect(envValue(document, "TOKEN")).toBe("a b");
    expect(envValue(document, "ABSENT")).toBeNull();
  });

  test("a comment can be preceded by whitespace", () => {
    expect(read("   # indented\n").lines[0]!.kind).toBe("comment");
  });

  test("bare value: `$`, `#`, `;`, `=` and the backtick are literal in it", () => {
    expect(envValue(read("A=x$HOME#;=`y`\n"), "A")).toBe("x$HOME#;=`y`");
  });

  test("an argon2 hash reads bare, the way systemd reads it", () => {
    const hash = "$argon2id$v=19$m=65536,t=2,p=1$c2VsIHNlbA$aGFjaGUgaGFjaGU";
    expect(envValue(read(`PASSWORD_HASH=${hash}\n`), "PASSWORD_HASH")).toBe(hash);
  });

  test("single quotes: everything is literal, backslash included", () => {
    expect(envValue(read(`A='\\n "x" $y'\n`), "A")).toBe('\\n "x" $y');
  });

  test("double quotes: systemd's four escapes", () => {
    expect(envValue(read('A="q\\" b\\\\ c\\` d\\$ e\'"\n'), "A")).toBe("q\" b\\ c` d$ e'");
  });

  test("the empty string in its three forms", () => {
    expect(envValue(read("A=\nB=''\nC=\"\"\n"), "A")).toBe("");
    expect(envValue(read("B=''\n"), "B")).toBe("");
    expect(envValue(read('C=""\n'), "C")).toBe("");
  });

  test("trailing whitespace is tolerated and stripped, outside quotes", () => {
    expect(envValue(read("A=abc  \t\n"), "A")).toBe("abc");
    expect(envValue(read("A=' x ' \n"), "A")).toBe(" x ");
  });

  test("a last line with no newline is read", () => {
    expect(envValue(read("A=1\nB=2"), "B")).toBe("2");
  });

  test("an empty file is an empty document", () => {
    expect(read("").lines).toEqual([]);
  });
});

describe("parsing: what makes the file unmanaged", () => {
  const cases: [string, string, number][] = [
    ["export", "export A=1\n", 1],
    ["bare continuation", "A=abc\\\nB=1\n", 1],
    ["single quote across several lines", "A='abc\ndef'\n", 1],
    ["unclosed double quote", 'A="abc\n', 1],
    ["concatenation after a quote", "A='x'y\n", 1],
    ["concatenation of two quoted parts", "A='x'\"y\"\n", 1],
    ["duplicate key", "A=1\nB=2\nA=3\n", 3],
    ["carriage return", "A=1\r\nB=2\r\n", 1],
    ["null byte", "A=1\nB=x\0y\n", 2],
    ["invalid key", "1A=1\n", 1],
    ["key with a dash", "A-B=1\n", 1],
    ["whitespace before the key", "  A=1\n", 1],
    ["whitespace before the equals", "A =1\n", 1],
    ["whitespace after the equals", "A= 1\n", 1],
    ["bare value with a space", "A=a b\n", 1],
    ["bare value with a quote", "A=a\"b\n", 1],
    ["bare value with a backslash", "A=a\\b\n", 1],
    ["unknown escape inside double quotes", 'A="a\\nb"\n', 1],
    ["line with no equals", "A=1\nANYTHING\n", 2],
    ["comment ending in a backslash", "# a\\\nA=1\n", 1],
    ["byte order mark", "\ufeffA=1\n", 1],
  ];

  for (const [name, text, line] of cases) {
    test(name, () => {
      expect(refusal(text).line).toBe(line);
    });
  }

  test("a key that is too long", () => {
    expect(refusal(`${"A".repeat(MAX_KEY + 1)}=1\n`).line).toBe(1);
  });

  test("the reason never quotes the line's content", () => {
    const token = "fake_live_VERY_SECRET";
    for (const text of [`${token}\n`, `A=${token} x\n`, `A='${token}\n`, `export A=${token}\n`]) {
      expect(refusal(text).reason).not.toContain(token);
    }
  });

  test("invalid UTF-8 is refused, never replaced", () => {
    const bytes = new Uint8Array([0x41, 0x3d, 0xff, 0x0a]);
    const parsed = parseEnvBytes(bytes);
    expect(parsed.ok).toBe(false);
  });

  test("valid UTF-8 passes through the bytes", () => {
    const parsed = parseEnvBytes(new TextEncoder().encode("A='cafe \u00e9'\n"));
    expect(parsed.ok && envValue(parsed.document, "A")).toBe("cafe \u00e9");
  });
});

describe("rewriting", () => {
  const ORIGINAL = "# Mail, to renew\nSID=ID1\n\n# the token\nTOKEN=old   \n; end\n";

  test("replacing keeps the position, the comments and the other lines' raw text", () => {
    const after = serialise(set(read(ORIGINAL), "TOKEN", "new"));
    expect(after).toBe("# Mail, to renew\nSID=ID1\n\n# the token\nTOKEN=new\n; end\n");
  });

  test("a new key goes to the end", () => {
    const after = serialise(set(read(ORIGINAL), "REGION", "eu-west-3"));
    expect(after).toBe(`${ORIGINAL}REGION=eu-west-3\n`);
  });

  test("removing does not touch the neighbours", () => {
    expect(serialise(remove(read(ORIGINAL), "SID"))).toBe("# Mail, to renew\n\n# the token\nTOKEN=old   \n; end\n");
  });

  test("removing a missing key changes nothing", () => {
    expect(serialise(remove(read(ORIGINAL), "MISSING"))).toBe(ORIGINAL);
  });

  test("untouched text comes back identical, with a final newline added", () => {
    expect(serialise(read(ORIGINAL))).toBe(ORIGINAL);
    expect(serialise(read("A=1"))).toBe("A=1\n");
    expect(serialise(read(""))).toBe("");
  });

  test("poser throws on a malformed value or key rather than write two lines", () => {
    expect(() => set(read(""), "A", "x\nB=injected")).toThrow();
    expect(() => set(read(""), "A B", "x")).toThrow();
  });

  test("the original document is not modified", () => {
    const document = read(ORIGINAL);
    set(document, "TOKEN", "other");
    remove(document, "SID");
    expect(serialise(document)).toBe(ORIGINAL);
  });
});

describe("round trip", () => {
  const TRAPS = [
    "",
    "simple",
    "a$b",
    "$HOME",
    "back\\slash",
    "end\\",
    "an'apostrophe",
    'the "quote"',
    `both ' and "`,
    "`command`",
    "#hash",
    "a#b",
    ";semicolon",
    "a=b=c",
    " leading space",
    "trailing space ",
    "  both  ",
    "tab\tinside",
    "caf\u00e9 \u2603 \u{1F510}",
    "$'\\\"`",
    "' \\\" $ ` #",
    "https://example.com/path?a=1&b=2",
    "-----BEGIN KEY----- base64+/=",
  ];

  for (const value of TRAPS) {
    test(`reads back ${JSON.stringify(value)}`, () => {
      const text = serialise(set(read("# header\nOTHER=1\n"), "KEY", value));
      const reread = read(text);
      expect(envValue(reread, "KEY")).toBe(value);
      expect(envValue(reread, "OTHER")).toBe("1");
      // And the text produced is stable: rewriting it changes nothing.
      expect(serialise(set(reread, "KEY", value))).toBe(text);
    });
  }

  test("the form chosen is the simplest one", () => {
    expect(encodeValue("AC_1.2:3,4@5%6+7=8/9-0")).toBe("AC_1.2:3,4@5%6+7=8/9-0");
    expect(encodeValue("a b")).toBe("'a b'");
    expect(encodeValue("$x")).toBe("'$x'");
    expect(encodeValue(`l'x "y" $z`)).toBe(`"l'x \\"y\\" \\$z"`);
  });
});

describe("key and value rules", () => {
  test("the shape of a key", () => {
    expect(checkKey("MAIL_TOKEN")).toBeNull();
    expect(checkKey("_private")).toBeNull();
    expect(checkKey("")).not.toBeNull();
    expect(checkKey("1A")).not.toBeNull();
    expect(checkKey("A-B")).not.toBeNull();
    expect(checkKey("A B")).not.toBeNull();
    expect(checkKey("A".repeat(MAX_KEY))).toBeNull();
    expect(checkKey("A".repeat(MAX_KEY + 1))).not.toBeNull();
  });

  test("the reserved names, by family and regardless of case", () => {
    const runtime = [
      "PATH",
      "Path",
      "HOME",
      "USER",
      "LOGNAME",
      "SHELL",
      "ENV",
      "TMPDIR",
      "TZDIR",
      "LOCPATH",
      "HOSTALIASES",
      "RES_OPTIONS",
      "NOTIFY_SOCKET",
      "CREDENTIALS_DIRECTORY",
      "CURL_CA_BUNDLE",
      "REQUESTS_CA_BUNDLE",
      "LANGUAGE",
      "TERM",
      "LD_PRELOAD",
      "ld_library_path",
      "BUN_OPTIONS",
      "NODE_OPTIONS",
      // The two the review let through: the service's TLS traffic diverted,
      // then accepted on a fake certificate.
      "HTTPS_PROXY",
      "https_proxy",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "NODE_EXTRA_CA_CERTS",
      "HTTP_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "no_proxy",
      "NPM_CONFIG_REGISTRY",
      "PYTHONPATH",
      "PERL5LIB",
      "RUBYOPT",
      "JAVA_TOOL_OPTIONS",
      "SSL_CERT_FILE",
      "OPENSSL_CONF",
      "GCONV_PATH",
      "GLIBC_TUNABLES",
      "MALLOC_ARENA_MAX",
      "XDG_CONFIG_HOME",
      "BASH_ENV",
      "SYSTEMD_LOG_LEVEL",
      "LISTEN_FDS",
      "WATCHDOG_USEC",
      "LC_ALL",
    ];
    for (const key of runtime) {
      expect(checkKey(key)).toContain("changes how the runtime behaves");
    }
    for (const key of ["PORT", "DATA_DIR", "PUBLIC_DIR"]) {
      expect(checkKey(key)).toContain("set by the deployment");
    }
    // Neighbours, not reserved.
    for (const key of ["PATHS", "BUNDLE", "OLD_PATH", "NODEJS_VERSION", "MAIL_AUTH_TOKEN", "PROXY_URL", "TERMINAL_ID"]) {
      expect(checkKey(key)).toBeNull();
    }
  });

  test("a key set by the unit is refused", () => {
    expect(checkKey("DEFAULT_SENDER", ["NODE_ENV", "DEFAULT_SENDER"])).toContain("service unit");
    expect(checkKey("DEFAULT_SENDER", [])).toBeNull();
    // A unit key that also belongs to a reserved family gives the stronger reason.
    expect(checkKey("NODE_ENV", ["NODE_ENV"])).toContain("runtime");
  });

  test("the values", () => {
    expect(checkValue("")).toBeNull();
    expect(checkValue("a\nb")).not.toBeNull();
    expect(checkValue("a\rb")).not.toBeNull();
    expect(checkValue("a\0b")).not.toBeNull();
    expect(checkValue("\ud800")).not.toBeNull();
    expect(checkValue("x".repeat(MAX_VALUE_BYTES))).toBeNull();
    expect(checkValue("x".repeat(MAX_VALUE_BYTES + 1))).not.toBeNull();
    // The bound is in bytes: 4096 two-byte characters make exactly 8 KiB.
    expect(checkValue("\u00e9".repeat(MAX_VALUE_BYTES / 2))).toBeNull();
    expect(checkValue("\u00e9".repeat(MAX_VALUE_BYTES / 2 + 1))).not.toBeNull();
  });

  test("no reason quotes the value", () => {
    const value = `SECRET-${"z".repeat(MAX_VALUE_BYTES)}`;
    expect(checkValue(value)).not.toContain("SECRET");
    expect(checkValue("SECRET\nX")).not.toContain("SECRET");
  });
});

describe("what the unit sets and reads", () => {
  const UNIT = [
    "[Unit]",
    "Description=Environment=TRAP=1 in the description",
    "",
    "[Service]",
    "Environment=PORT=3048",
    "Environment=DATA_DIR=/srv/sites/cms/data",
    'Environment="NODE_ENV=production" \'DEFAULT_SENDER=a b\'',
    "# Environment=COMMENTED=1",
    "EnvironmentFile=-/etc/sitesolide/cms.env",
    "EnvironmentFile=/etc/sitesolide/cms-other.env",
    "ExecStart=/usr/local/bin/bun run server.ts",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ].join("\n");

  test("the keys of the [Service] section only, comments excluded", () => {
    expect(unitEnvironment(UNIT).keys.sort()).toEqual(["DATA_DIR", "DEFAULT_SENDER", "NODE_ENV", "PORT"]);
  });

  test("the files, with or without a dash", () => {
    expect(unitEnvironment(UNIT).files).toEqual([
      { path: "/etc/sitesolide/cms.env", optional: true },
      { path: "/etc/sitesolide/cms-other.env", optional: false },
    ]);
  });

  test("an empty assignment resets the list, as systemd does", () => {
    const text = "[Service]\nEnvironment=A=1\nEnvironment=\nEnvironment=B=2\nEnvironmentFile=/x\nEnvironmentFile=\n";
    expect(unitEnvironment(text)).toEqual({ keys: ["B"], values: ["2"], files: [] });
  });

  test("the values, which say where a service opens its own secrets", () => {
    const text = [
      "[Service]",
      "Environment=PORT=3041",
      "Environment=BUILDER_SECRETS_DIR=/etc/sitesolide/builder-secrets",
      'Environment="KEY=/etc/sitesolide/builder-ssh" EMPTY=',
      "EnvironmentFile=-/etc/sitesolide/builder.env",
    ].join("\n");
    expect(unitEnvironment(text).values).toEqual(["3041", "/etc/sitesolide/builder-secrets", "/etc/sitesolide/builder-ssh", ""]);
  });

  test("a line continued by a backslash", () => {
    expect(unitEnvironment("[Service]\nEnvironment=A=1 \\\n  B=2\n").keys.sort()).toEqual(["A", "B"]);
  });

  test("extensions put end to end are read as a sequence of sections", () => {
    const text = `${UNIT}\n[Service]\nEnvironment=ADDED=1\n`;
    expect(unitEnvironment(text).keys).toContain("ADDED");
  });
});
