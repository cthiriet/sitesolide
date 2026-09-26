import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  MAX_CONTENT_BYTES,
  HASH_ONLY,
  MAX_FILE_BYTES,
  MIN_PASSWORD,
  PASSWORD_VARIABLE,
  expectedText,
  candidates,
  pathUnder,
  siteAccount,
  isSiteFolder,
  isPassword,
  kindOf,
  expectedMode,
  readContent,
  readSites,
  isAllowedMode,
  folderReason,
  outsideHashReason,
  unmanagedReason,
  newPasswordReason,
  previousReason,
  outsideHashRefusal,
  nameRefusal,
  restoreRefusal,
  checkContent,
  checkFile,
  checkSite,
  type Expected,
  type Declaration,
  type FolderInfo,
  type FileInfo,
  type Refusal,
  type Site,
} from "../src/secrets/scope";
import { LANDING_FOLDER } from "../src/config";

/**
 * A fake key's header, split so that a secret scanner reading this file does
 * not take it for a leaked one. At runtime it is whole.
 */
const KEY_HEADER = "-----BEGIN OPENSSH " + "PRIVATE KEY-----";

const SECRETS = "/etc/sitesolide";
const charOf = (code: number) => String.fromCharCode(code);

function manifest(slug: string, secrets: unknown, others: Record<string, unknown> = {}): string {
  return JSON.stringify({ slug, start: "bun server.ts", port: 3048, publicDir: "public", secrets, ...others });
}

/** The sites, with the names present in the secrets directory, as the steward lists them. */
function sitesFrom(entries: { folder: string; manifest: string | null }[], present: string[] = []): Map<string, Site> {
  return readSites(entries, present);
}

function filesOf(sites: Map<string, Site>, folder: string): string[] {
  return sites.get(folder)?.files.map((file) => file.name) ?? [];
}

describe("the sites", () => {
  test("a slug or the landing's directory, never `landing` itself", () => {
    for (const folder of ["cms", "builder", "dashboard", "portal", "test-zone.invalid", "a1-b2"]) expect(isSiteFolder(folder)).toBe(true);
    for (const folder of ["landing", "Cms", "..", ".", "cms.test", "-cms", "cms_x", ""]) expect(isSiteFolder(folder)).toBe(false);
  });

  test("the landing's account carries its label, not its directory", () => {
    expect(siteAccount("test-zone.invalid")).toBe("site-landing");
    expect(siteAccount("cms")).toBe("site-cms");
  });

  test("every site directory is listed, static, manifest-less or app, with no exclusion at all", () => {
    const sites = sitesFrom([
      { folder: "cms", manifest: manifest("cms", ["cms.env"]) },
      { folder: "dashboard", manifest: manifest("dashboard", ["dashboard.env"]) },
      { folder: "portal", manifest: manifest("portal", ["portal.env"]) },
      { folder: "builder", manifest: manifest("builder", ["builder.env"]) },
      { folder: "kanban", manifest: JSON.stringify({ slug: "kanban", publicDir: "public" }) },
      { folder: "test-zone.invalid", manifest: null },
      { folder: "landing", manifest: null },
      { folder: "Pas-un-slug", manifest: null },
    ]);
    expect([...sites.keys()]).toEqual(["builder", "cms", "dashboard", "kanban", "portal", "test-zone.invalid"]);
    expect(sites.get("kanban")).toMatchObject({ isStatic: true, files: [] });
    expect(sites.get("test-zone.invalid")).toMatchObject({ isStatic: false, manifest: null, files: [] });
    expect(filesOf(sites, "dashboard")).toEqual(["dashboard.env"]);
    expect(filesOf(sites, "portal")).toEqual(["portal.env"]);
    expect(filesOf(sites, "builder")).toEqual(["builder.env"]);
  });

  test("a manifest that is unreadable or names another slug declares nothing, but the site stays", () => {
    const sites = sitesFrom([
      { folder: "cms", manifest: "{not json" },
      { folder: "calendar", manifest: manifest("other", ["calendar.env"]) },
    ]);
    expect(sites.get("cms")).toMatchObject({ manifest: null, files: [], isStatic: false });
    expect(sites.get("calendar")?.manifest?.slug).toBe("other");
    expect(filesOf(sites, "calendar")).toEqual([]);
  });

  test("a static site declares no secrets: no unit would read them", () => {
    const sites = sitesFrom([{ folder: "showcase", manifest: JSON.stringify({ slug: "showcase", publicDir: "public", secrets: ["showcase.env"] }) }]);
    expect(filesOf(sites, "showcase")).toEqual([]);
  });

  test("a manifest declares only flat environment files, under its own prefix", () => {
    const sites = sitesFrom([
      {
        folder: "cms",
        manifest: manifest("cms", ["cms.env", "cms.env", "cms-webhook.env", "ses.env", "cms-ssh", "cms-secrets/x.env", "../cms.env", 42]),
      },
    ]);
    expect(filesOf(sites, "cms")).toEqual(["cms.env", "cms-webhook.env"]);
  });

  test("a manifest that no longer passes validate() is still read if it is readable", () => {
    const sites = sitesFrom([{ folder: "cms", manifest: manifest("cms", ["cms.env"], { unknownKey: true }) }]);
    expect(filesOf(sites, "cms")).toEqual(["cms.env"]);
  });
});

describe("attaching a name to a site", () => {
  const folders = ["cms", "cms-tool", "builder", "test-zone.invalid", "calendar"];

  test("<slug>.env, <slug>-*, <slug>-secrets/<name>", () => {
    expect(candidates("cms.env", folders)).toEqual(["cms"]);
    expect(candidates("builder-ssh", folders)).toEqual(["builder"]);
    expect(candidates("builder-ssh.pub", folders)).toEqual(["builder"]);
    expect(candidates("builder-secrets/registry", folders)).toEqual(["builder"]);
    expect(candidates("cms-tool.env", folders)).toEqual(["cms", "cms-tool"]);
  });

  test("landing-* goes to the landing's directory, and to it alone", () => {
    expect(candidates("landing-mail.env", folders)).toEqual(["test-zone.invalid"]);
    expect(candidates("landing.env", folders)).toEqual(["test-zone.invalid"]);
    expect(candidates("landing-mail.env", [...folders, "landing"])).toEqual(["test-zone.invalid"]);
    expect(candidates("landing-mail.env", ["cms"])).toEqual([]);
  });

  test("the trap names designate no site", () => {
    for (const name of ["cms.prod.env", "cmsx.env", "cms", "other-cms.env", "test-zone.invalid.env", "cloudflare.env", "builder-secrets", "secrets/registry"]) {
      const found = candidates(name, folders);
      if (name === "builder-secrets") expect(found).toEqual(["builder"]);
      else expect(found).toEqual([]);
    }
    // A subdirectory attaches only by its exact name.
    expect(candidates("builder-other/registry", folders)).toEqual([]);
    expect(candidates("cms-tool-secrets/x", folders)).toEqual(["cms-tool"]);
  });

  test("declared by a single manifest among two prefixes: to that one", () => {
    const sites = sitesFrom([
      { folder: "cms", manifest: manifest("cms", ["cms.env", "cms-tool.env"]) },
      { folder: "cms-tool", manifest: manifest("cms-tool", []) },
    ]);
    expect(filesOf(sites, "cms")).toEqual(["cms.env", "cms-tool.env"]);
    expect(filesOf(sites, "cms-tool")).toEqual([]);
  });

  test("declared by two manifests: to neither", () => {
    const sites = sitesFrom([
      { folder: "cms", manifest: manifest("cms", ["cms.env", "cms-tool.env"]) },
      { folder: "cms-tool", manifest: manifest("cms-tool", ["cms-tool.env"]) },
      { folder: "library", manifest: manifest("library", ["library.env"]) },
    ]);
    expect(filesOf(sites, "cms")).toEqual(["cms.env"]);
    expect(filesOf(sites, "cms-tool")).toEqual([]);
    expect(filesOf(sites, "library")).toEqual(["library.env"]);
  });

  test("present but declared by no manifest, between two prefixes: to the most specific site", () => {
    const both = sitesFrom(
      [
        { folder: "cms", manifest: manifest("cms", []) },
        { folder: "cms-tool", manifest: manifest("cms-tool", []) },
      ],
      ["cms-tool.env"],
    );
    expect(filesOf(both, "cms-tool")).toEqual(["cms-tool.env"]);
    expect(filesOf(both, "cms")).toEqual([]);

    // Without the more specific site, the name goes to the one it still carries.
    const alone = sitesFrom([{ folder: "cms", manifest: manifest("cms", []) }], ["cms-tool.env"]);
    expect(filesOf(alone, "cms")).toEqual(["cms-tool.env"]);
  });

  test("a site that does not exist under /srv/sites receives nothing", () => {
    const sites = sitesFrom([{ folder: "cms", manifest: manifest("cms", ["cms.env"]) }], ["builder-ssh"]);
    expect([...sites.values()].flatMap((site) => site.files.map((file) => file.name))).toEqual(["cms.env"]);
  });
});

describe("what a file is expected to be", () => {
  const entries = [
    { folder: "builder", manifest: manifest("builder", ["builder.env"]) },
    { folder: "dashboard", manifest: manifest("dashboard", ["dashboard.env"]) },
    { folder: "test-zone.invalid", manifest: null },
    { folder: "cms", manifest: manifest("cms", ["cms.env"]) },
  ];

  test("owner, mode, kind and readability follow from the name and the site", () => {
    const sites = sitesFrom(entries, [
      "builder.env",
      "builder-ssh",
      "builder-ssh.pub",
      "builder-secrets/registry",
      "dashboard.env",
      "landing-mail.env",
    ]);
    const builder = sites.get("builder")!.files;
    expect(builder.map((f) => [f.name, f.kind, expectedText(f.expected), f.readable])).toEqual([
      ["builder.env", "variables", "site-builder:site-builder 0600", true],
      ["builder-ssh", "content", "site-builder:site-builder 0400", false],
      ["builder-ssh.pub", "content", "site-builder:site-builder 0444", true],
      ["builder-secrets/registry", "content", "site-builder:site-builder 0400", false],
    ]);
    expect(sites.get("dashboard")!.files[0]).toMatchObject({ expected: { owner: "root", group: "root", mode: 0o600 } });
    expect(sites.get("test-zone.invalid")!.files[0]).toMatchObject({ name: "landing-mail.env", expected: { owner: "site-landing" } });
    // Declared by its manifest and not present yet: the same expectation.
    expect(expectedText(sites.get("cms")!.files[0]!.expected)).toBe("site-cms:site-cms 0600");
  });

  test("the mode follows from the name alone", () => {
    // A registry used to say these line by line, and said nothing else.
    expect(expectedMode("cms.env")).toBe(0o600);
    expect(expectedMode("builder-ssh")).toBe(0o400);
    expect(expectedMode("builder-ssh.pub")).toBe(0o444);
    expect(expectedMode("builder-secrets/registry")).toBe(0o400);
  });

  test("a present name no site carries, hidden, or too deep, is nobody's", () => {
    const sites = sitesFrom(entries, ["cloudflare.env", "other.env", "cms-a/b/c", "cms-secrets/.cache", "../passwd"]);
    expect([...sites.values()].flatMap((site) => site.files.map((file) => file.name)).sort()).toEqual([
      "builder.env",
      "cms.env",
      "dashboard.env",
    ]);
  });

  test("the admitted modes", () => {
    expect(isAllowedMode(0o600, "variables")).toBe(true);
    expect(isAllowedMode(0o400, "variables")).toBe(true);
    expect(isAllowedMode(0o640, "variables")).toBe(false);
    expect(isAllowedMode(0o444, "content")).toBe(true);
    expect(isAllowedMode(0o440, "content")).toBe(true);
    for (const mode of [0o644 | 0o020, 0o602, 0o700, 0o4400, 0o1600, 0o000, 0o200]) expect(isAllowedMode(mode, "content")).toBe(false);
  });

});

describe("kind, readability and passwords", () => {
  test("the kind follows the extension", () => {
    expect(kindOf("cms.env")).toBe("variables");
    expect(kindOf("builder-secrets/x.env")).toBe("variables");
    expect(kindOf("builder-ssh")).toBe("content");
    expect(kindOf("builder-ssh.pub")).toBe("content");
    expect(kindOf("cms.env.bak")).toBe("content");
  });

  /** The dashboard, the portal, a site, and a builder content file. */
  function declarations() {
    const sites = sitesFrom(
      [
        { folder: "dashboard", manifest: manifest("dashboard", ["dashboard.env"]) },
        { folder: "portal", manifest: manifest("portal", ["portal.env"]) },
        { folder: "calendar", manifest: manifest("calendar", ["calendar.env"]) },
        { folder: "builder", manifest: manifest("builder", []) },
      ],
      ["dashboard.env", "builder-ssh"],
    );
    return {
      dashboard: sites.get("dashboard")!.files[0]!,
      portal: sites.get("portal")!.files[0]!,
      calendar: sites.get("calendar")!.files[0]!,
      key: sites.get("builder")!.files[0]!,
    };
  }

  test("PASSWORD_HASH is a password in every environment file, and nowhere else", () => {
    expect(PASSWORD_VARIABLE).toBe("PASSWORD_HASH");
    const { dashboard, portal, calendar, key } = declarations();
    for (const declaration of [dashboard, portal, calendar]) {
      expect(declaration.passwords).toEqual(["PASSWORD_HASH"]);
      expect(isPassword(declaration, "PASSWORD_HASH")).toBe(true);
      expect(isPassword(declaration, "password_hash")).toBe(false);
      expect(isPassword(declaration, "TOKEN")).toBe(false);
    }
    // A content file is handled as one block: it has no variable.
    expect(key.name).toBe("builder-ssh");
    expect(key.passwords).toEqual([]);
    expect(isPassword(key, "PASSWORD_HASH")).toBe(false);
  });

  test("hash only: the dashboard and the portal carry nothing other than PASSWORD_HASH", () => {
    expect(HASH_ONLY).toEqual(["dashboard.env", "portal.env"]);
    for (const name of HASH_ONLY) {
      for (const variable of ["STEWARD_SOCKET", "PORTAL_URL", "STATE_FILE", "OTHER"]) {
        const refusal = outsideHashRefusal(name, variable);
        expect(refusal?.error).toBe("out-of-scope");
        // The message says why, without quoting the name submitted.
        expect(refusal?.message).toBe(`${name} holds PASSWORD_HASH only: any other variable would change how its service runs, not add a secret`);
      }
      // PASSWORD_HASH itself is refused elsewhere, as a password.
      expect(outsideHashRefusal(name, "PASSWORD_HASH")).toBeNull();
    }
    expect(outsideHashRefusal("calendar.env", "STEWARD_SOCKET")).toBeNull();
    expect(outsideHashRefusal("cms.env", "OTHER")).toBeNull();
  });

  test("hash only: a file carrying anything else is unmanaged, and the reason names the variables", () => {
    const path = "/etc/sitesolide/dashboard.env";
    expect(outsideHashReason("dashboard.env", [], path)).toBeNull();
    expect(outsideHashReason("dashboard.env", ["PASSWORD_HASH"], path)).toBeNull();
    expect(outsideHashReason("dashboard.env", ["PASSWORD_HASH", "STEWARD_SOCKET"], path)).toBe(
      `holds variables other than PASSWORD_HASH (STEWARD_SOCKET), which would change how its service runs: remove them by hand from ${path}`,
    );
    const many = outsideHashReason("portal.env", ["A", "PASSWORD_HASH", "B", "C", "D", "E"], path)!;
    expect(many).toContain("(A, B, C and 2 more)");
    expect(outsideHashReason("calendar.env", ["PASSWORD_HASH", "TOKEN"], path)).toBeNull();
  });

  test("restoring: never the dashboard nor the portal, never a version carrying a password", () => {
    const { dashboard, portal, calendar, key } = declarations();
    const refusal: Refusal = { error: "out-of-scope", message: "a password is only changed with Change password" };
    expect(restoreRefusal(dashboard, [])).toEqual(refusal);
    expect(restoreRefusal(portal, [])).toEqual(refusal);
    expect(restoreRefusal(calendar, ["TOKEN", "PASSWORD_HASH"])).toEqual(refusal);
    expect(restoreRefusal(calendar, ["TOKEN"])).toBeNull();
    expect(restoreRefusal(calendar, [])).toBeNull();
    expect(restoreRefusal(key, [])).toBeNull();
  });

  test("a new password chosen by hand", () => {
    expect(newPasswordReason("x".repeat(MIN_PASSWORD))).toBeNull();
    expect(newPasswordReason("x".repeat(256))).toBeNull();
    expect(newPasswordReason("x".repeat(MIN_PASSWORD - 1))).toContain("at least 16");
    expect(newPasswordReason("x".repeat(257))).toContain("at most 256");
    expect(newPasswordReason(`${"x".repeat(20)}${charOf(0xd800)}`)).toContain("Unicode");
  });
});

describe("file name", () => {
  const cms = sitesFrom(
    [{ folder: "cms", manifest: manifest("cms", ["cms.env", "cms-webhook.env"]) }],
    ["cms-secrets/key"],
  ).get("cms")!;

  test("declared and well formed names pass", () => {
    for (const name of ["cms.env", "cms-webhook.env", "cms-secrets/key"]) {
      const verdict = checkFile(cms, name, SECRETS);
      expect("path" in verdict && verdict.path).toBe(`${SECRETS}/${name}`);
    }
  });

  test("traversals, separators, null bytes and hidden names are out of scope", () => {
    const traps = [
      "../cms.env",
      "cms.env/..",
      "..",
      ".",
      "",
      "/etc/passwd",
      "cms/../../etc/shadow.env",
      "cms..env",
      "cms.env\0",
      "cms\\..\\x.env",
      "..%2fcms.env",
      "%2e%2e/cms.env",
      ".cms.env",
      "cms.env ",
      "cms*.env",
      "cms?.env",
      "cms[1].env",
      "cms-secrets/../cms.env",
      "cms-secrets/./key",
      "cms-secrets/.key",
      "cms-secrets//key",
      "cms-secrets/",
      "/cms-secrets/key",
      "cms-secrets/a/b",
      "cms-other/key",
      "secrets/key",
      `cms${charOf(0xff0e)}${charOf(0xff0e)}env`,
      `cms-cafe${charOf(0x301)}.env`,
      `cms-caf${charOf(0xe9)}.env`,
      "x".repeat(200) + ".env",
    ];
    for (const name of traps) {
      const verdict = checkFile(cms, name, SECRETS);
      expect("refusal" in verdict && verdict.refusal.error).toBe("out-of-scope");
    }
  });

  test("a well formed but undeclared name is refused", () => {
    const verdict = checkFile(cms, "cms-other.env", SECRETS);
    expect("refusal" in verdict && verdict.refusal.message).toContain("declared neither");
  });

  test("what is not a string is invalid, not out of scope", () => {
    for (const name of [undefined, null, 42, ["cms.env"], { name: "cms.env" }]) {
      expect(nameRefusal(name)?.error).toBe("invalid");
    }
  });

  test("a refusal never throws", () => {
    for (const name of [undefined, Symbol("x"), `${charOf(0xd800)}.env`, `cms.${charOf(0xd800)}.env`, `cms-secrets/${charOf(0xd800)}`]) {
      expect(() => nameRefusal(name)).not.toThrow();
    }
  });
});

describe("resolved path", () => {
  test("at one or two levels exactly, never above", () => {
    expect(pathUnder(SECRETS, "cms.env")).toBe("/etc/sitesolide/cms.env");
    expect(pathUnder(`${SECRETS}/`, "cms.env")).toBe("/etc/sitesolide/cms.env");
    expect(pathUnder(SECRETS, "builder-secrets/registry")).toBe("/etc/sitesolide/builder-secrets/registry");
    expect(pathUnder(SECRETS, "..")).toBeNull();
    expect(pathUnder(SECRETS, ".")).toBeNull();
    expect(pathUnder(SECRETS, "")).toBeNull();
    expect(pathUnder(SECRETS, "../sitesolide/cms.env")).toBeNull();
    expect(pathUnder(SECRETS, "../passwd")).toBeNull();
    expect(pathUnder(SECRETS, "a/b/c")).toBeNull();
    expect(pathUnder(SECRETS, "a/../b")).toBeNull();
    expect(pathUnder(SECRETS, "/etc/passwd")).toBeNull();
  });
});

describe("requested site", () => {
  const sites = sitesFrom([
    { folder: "cms", manifest: manifest("cms", ["cms.env"]) },
    { folder: "test-zone.invalid", manifest: null },
  ]);

  test("existing, unknown, malformed", () => {
    expect("site" in checkSite(sites, "cms")).toBe(true);
    expect("site" in checkSite(sites, "test-zone.invalid")).toBe(true);
    for (const slug of ["calendar", "../cms", "CMS", "cms/", "landing", ""]) {
      const verdict = checkSite(sites, slug);
      expect("refusal" in verdict && verdict.refusal.error).toBe("out-of-scope");
    }
    const verdict = checkSite(sites, 3);
    expect("refusal" in verdict && verdict.refusal.error).toBe("invalid");
  });
});

describe("the state of a file that is present: exact owner and mode", () => {
  const healthy: FileInfo = { link: false, regular: true, links: 1, uid: 1001, gid: 1001, mode: 0o600, size: 40, modifiedAt: 0 };
  const account = { uid: 1001, gid: 1001 };
  const path = "/etc/sitesolide/cms.env";
  const expected: Expected = { owner: "site-cms", group: "site-cms", mode: 0o600 };
  const judge = (info: FileInfo, real: typeof account | null = account, a: Expected = expected) => unmanagedReason(info, a, real, path);

  test("healthy", () => {
    expect(judge(healthy)).toBeNull();
    expect(judge(healthy, null)).toBeNull();
  });

  test("link, not regular, several links, too big", () => {
    expect(judge({ ...healthy, link: true, regular: false })).toContain("symbolic");
    expect(judge({ ...healthy, regular: false })).toContain("regular");
    expect(judge({ ...healthy, links: 2 })).toContain("hard links");
    expect(judge({ ...healthy, size: MAX_FILE_BYTES + 1 })).toContain("larger");
  });

  test("another owner or another group: the reason gives the command", () => {
    expect(judge({ ...healthy, uid: 0 })).toBe("owned by uid 0, not site-cms: sudo chown site-cms:site-cms /etc/sitesolide/cms.env");
    expect(judge({ ...healthy, gid: 4 })).toBe("group gid 4, not site-cms: sudo chgrp site-cms /etc/sitesolide/cms.env");
  });

  test("any mode other than the expected one, more open or more closed, even with no account check", () => {
    for (const mode of [0o640, 0o604, 0o660, 0o644, 0o700 | 0o4000, 0o600 | 0o1000, 0o400, 0o200]) {
      const reason = judge({ ...healthy, mode }, null);
      expect(reason).toBe(`mode ${mode.toString(8).padStart(3, "0")}, expected 600: sudo chmod 600 /etc/sitesolide/cms.env`);
    }
  });

  test("a private key expected at 0400 and a public key at 0444", () => {
    const privateMode: Expected = { owner: "site-builder", group: "site-builder", mode: 0o400 };
    expect(judge({ ...healthy, mode: 0o400 }, account, privateMode)).toBeNull();
    expect(judge({ ...healthy, mode: 0o600 }, account, privateMode)).toContain("sudo chmod 400");
    const publicMode: Expected = { ...privateMode, mode: 0o444 };
    expect(judge({ ...healthy, mode: 0o444 }, account, publicMode)).toBeNull();
    expect(judge({ ...healthy, mode: 0o644 }, account, publicMode)).toContain("sudo chmod 444");
  });

  test("root expected: the command says so", () => {
    const aRoot: Expected = { owner: "root", group: "root", mode: 0o600 };
    expect(judge({ ...healthy, uid: 1001 }, { uid: 0, gid: 0 }, aRoot)).toContain("sudo chown root:root");
  });

  test("with no account check, uid and gid do not count", () => {
    expect(judge({ ...healthy, uid: 0, gid: 0 }, null)).toBeNull();
  });
});

describe("subdirectory", () => {
  const healthy: FolderInfo = { link: false, folder: true, uid: 0, mode: 0o755 };
  const path = "/etc/sitesolide/builder-secrets";

  test("a real directory, owned by root, closed to writes by others", () => {
    expect(folderReason(healthy, 0, path)).toBeNull();
    expect(folderReason({ ...healthy, mode: 0o700 }, 0, path)).toBeNull();
    expect(folderReason({ ...healthy, uid: 998 }, null, path)).toBeNull();
  });

  test("the refusals", () => {
    expect(folderReason({ ...healthy, link: true, folder: false }, 0, path)).toContain("symbolic link");
    expect(folderReason({ ...healthy, folder: false }, 0, path)).toContain("not a folder");
    expect(folderReason({ ...healthy, uid: 998 }, 0, path)).toBe(`${path} is owned by uid 998, not root: sudo chown root:root ${path}`);
    expect(folderReason({ ...healthy, mode: 0o775 }, 0, path)).toContain("sudo chmod go-w");
    expect(folderReason({ ...healthy, mode: 0o757 }, 0, path)).toContain("writable by other accounts");
  });
});

describe("content", () => {
  const encoder = new TextEncoder();

  test("a UTF-8 text reads back identical, byte order mark and Windows line ending included", () => {
    const text = `${charOf(0xfeff)}${KEY_HEADER}\r\nabc\n`;
    const parsed = readContent(encoder.encode(text));
    expect("text" in parsed && encoder.encode(parsed.text)).toEqual(encoder.encode(text));
  });

  test("invalid UTF-8 or null byte: unmanaged", () => {
    expect(readContent(new Uint8Array([0x41, 0xff]))).toEqual({ reason: "not valid UTF-8 text" });
    expect(readContent(new Uint8Array([0x41, 0x00, 0x42]))).toEqual({ reason: "contains a null byte" });
  });

  test("a submitted content: well formed, no null byte, 64 KiB at most in bytes", () => {
    expect(checkContent("")).toBeNull();
    expect(checkContent("a".repeat(MAX_CONTENT_BYTES))).toBeNull();
    expect(checkContent("a".repeat(MAX_CONTENT_BYTES + 1))).toContain("64 KiB");
    // Two bytes per character: the bound counts bytes, not characters.
    expect(checkContent(charOf(0xe9).repeat(MAX_CONTENT_BYTES / 2 + 1))).toContain("64 KiB");
    expect(checkContent("a\0b")).toContain("null byte");
    expect(checkContent(`key${charOf(0xdc00)}`)).toContain("Unicode");
  });
});

describe("previous version", () => {
  const healthy: FileInfo = { link: false, regular: true, links: 1, uid: 1001, gid: 1001, mode: 0o600, size: 40, modifiedAt: 0 };

  test("at the same uid as the expected account, it can be restored", () => {
    expect(previousReason(healthy, { uid: 1001, gid: 1001 }, "site-cms")).toBeNull();
    expect(previousReason(healthy, null, "site-cms")).toBeNull();
  });

  test("from another uid, that of an earlier site with the same name, it is refused", () => {
    expect(previousReason({ ...healthy, uid: 998 }, { uid: 1001, gid: 1001 }, "site-cms")).toContain("uid 998");
  });

  test("a link, several links or too big are refused", () => {
    expect(previousReason({ ...healthy, link: true, regular: false }, null, "site-cms")).not.toBeNull();
    expect(previousReason({ ...healthy, links: 2 }, null, "site-cms")).not.toBeNull();
    expect(previousReason({ ...healthy, size: 1024 * 1024 }, null, "site-cms")).not.toBeNull();
  });
});

/**
 * A secrets directory confronted with the sites it serves.
 *
 * Every file present has to land on a site with the expectation that follows
 * from its name, and a file no site carries must land on none. It is the rule
 * that decides what the steward agrees to write. The cases that count: an app
 * project, a showcase with no secret, the dashboard owned by root, the landing
 * that has no manifest, and a file that belongs to no project.
 */
describe("a secrets directory against the sites it serves", () => {
  const PRESENT = ["blog.env", "dashboard.env", "landing-mail.env", "portal.env", "stray.env"];
  const staticManifest = (slug: string) => JSON.stringify({ slug, publicDir: "public" });
  const sites = sitesFrom(
    [
      { folder: "blog", manifest: manifest("blog", ["blog.env"]) },
      { folder: "shop", manifest: staticManifest("shop") },
      { folder: "dashboard", manifest: manifest("dashboard", ["dashboard.env"]) },
      { folder: "portal", manifest: manifest("portal", ["portal.env"]) },
      // The landing serves the bare domain: its directory carries the zone's
      // name, and it has no manifest.
      { folder: LANDING_FOLDER, manifest: null },
    ],
    PRESENT,
  );
  const managed = new Map<string, { site: string; file: Declaration }>();
  for (const site of sites.values()) for (const file of site.files) managed.set(file.name, { site: site.folder, file });

  const EXPECTED: [string, string][] = [
    ["blog.env", "site-blog:site-blog 0600"],
    ["dashboard.env", "root:root 0600"],
    ["landing-mail.env", "site-landing:site-landing 0600"],
    ["portal.env", "site-portal:site-portal 0600"],
  ];
  for (const [name, expected] of EXPECTED) {
    test(`${name} (${expected})`, () => {
      expect(expectedText(managed.get(name)!.file.expected)).toBe(expected);
    });
  }

  test("every file lands where it should", () => {
    // A `landing-` prefix goes to the zone's directory, which has no manifest.
    expect(managed.get("landing-mail.env")?.site).toBe(LANDING_FOLDER);
    expect(managed.get("dashboard.env")?.site).toBe("dashboard");
    expect(managed.get("blog.env")?.site).toBe("blog");
    // The portal carries nothing but its hash: another variable would
    // change what its service does.
    expect(managed.get("portal.env")?.file.passwords).toEqual(["PASSWORD_HASH"]);
    // What belongs to no site is not the dashboard's.
    expect(managed.has("stray.env")).toBe(false);
    // A showcase with no secret carries no file.
    expect([...managed.values()].some((entry) => entry.site === "shop")).toBe(false);
  });
});
