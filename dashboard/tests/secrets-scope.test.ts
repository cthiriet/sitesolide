import { describe, expect, test } from "bun:test";
import {
  HASH_ONLY,
  HASH_FILE_SETTINGS,
  MAX_FILE_BYTES,
  MIN_PASSWORD,
  PASSWORD_VARIABLE,
  PLATFORM_FILES,
  ROOT_FILES,
  EXPECTED_MODE,
  expectedText,
  pathUnder,
  siteAccount,
  isSiteFolder,
  isPassword,
  readSites,
  folderReason,
  outsideHashReason,
  unmanagedReason,
  newPasswordReason,
  previousReason,
  outsideHashRefusal,
  nameRefusal,
  restoreRefusal,
  checkFile,
  checkSite,
  type Expected,
  type Declaration,
  type FolderInfo,
  type FileInfo,
  type Refusal,
  type Site,
} from "../src/secrets/scope";
import { IDENTITY_VARIABLES } from "../borrowed/sharing";
import { LANDING_FOLDER } from "../src/config";

const SECRETS = "/etc/sitesolide";
const charOf = (code: number) => String.fromCharCode(code);

function manifest(slug: string, secrets: unknown, others: Record<string, unknown> = {}): string {
  return JSON.stringify({ slug, start: "bun server.ts", port: 3048, publicDir: "public", ...(secrets === undefined ? {} : { secrets }), ...others });
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
      { folder: "cms", manifest: manifest("cms", ["API_KEY"]) },
      { folder: "dashboard", manifest: manifest("dashboard", undefined) },
      { folder: "portal", manifest: manifest("portal", undefined) },
      { folder: "kanban", manifest: JSON.stringify({ slug: "kanban", publicDir: "public" }) },
      { folder: "test-zone.invalid", manifest: null },
      { folder: "landing", manifest: null },
      { folder: "Pas-un-slug", manifest: null },
    ]);
    expect([...sites.keys()]).toEqual(["cms", "dashboard", "kanban", "portal", "test-zone.invalid"]);
    expect(sites.get("kanban")).toMatchObject({ isStatic: true, files: [] });
    expect(sites.get("test-zone.invalid")).toMatchObject({ isStatic: false, manifest: null, files: [] });
    expect(sites.get("cms")).toMatchObject({ isStatic: false, files: [] });
  });

  test("a manifest that is unreadable or names another slug is kept as read, and the site stays", () => {
    const sites = sitesFrom([
      { folder: "cms", manifest: "{not json" },
      { folder: "calendar", manifest: manifest("other", ["API_KEY"]) },
    ]);
    expect(sites.get("cms")).toMatchObject({ manifest: null, files: [], isStatic: false });
    expect(sites.get("calendar")?.manifest?.slug).toBe("other");
    expect(filesOf(sites, "calendar")).toEqual([]);
  });

  test("a manifest that no longer passes validate() is still read if it is readable", () => {
    const sites = sitesFrom([{ folder: "cms", manifest: manifest("cms", undefined, { memory: "lots" }) }]);
    expect(sites.get("cms")?.manifest?.slug).toBe("cms");
  });
});

describe("the platform's own files (PLATFORM_FILES)", () => {
  const entries = [
    { folder: "dashboard", manifest: manifest("dashboard", undefined) },
    { folder: "portal", manifest: manifest("portal", undefined) },
    { folder: "cms", manifest: manifest("cms", ["API_KEY"]) },
    { folder: "test-zone.invalid", manifest: null },
  ];

  test("the dashboard's three and the portal's one, the dashboard's root's", () => {
    expect(PLATFORM_FILES).toEqual({ dashboard: ROOT_FILES, portal: ["portal.env"] });
    expect(ROOT_FILES).toEqual(["dashboard.env", "dashboard-monitor.env", "dashboard-backup.env"]);
    expect(EXPECTED_MODE).toBe(0o600);
  });

  test("<slug>.env is listed whether present or not: the unit reads it", () => {
    const sites = sitesFrom(entries, []);
    expect(filesOf(sites, "dashboard")).toEqual(["dashboard.env"]);
    expect(filesOf(sites, "portal")).toEqual(["portal.env"]);
  });

  test("the monitor's and the backups' files are listed once present, in the table's order", () => {
    expect(filesOf(sitesFrom(entries, ["dashboard-backup.env"]), "dashboard")).toEqual(["dashboard.env", "dashboard-backup.env"]);
    expect(filesOf(sitesFrom(entries, ["dashboard-backup.env", "dashboard-monitor.env", "dashboard.env"]), "dashboard")).toEqual(ROOT_FILES);
  });

  test("no other site lists a file, whatever its manifest declares or its name prefixes", () => {
    // Before the store, a project's flat files attached to it by its
    // manifest or by their name: neither attaches anything any more.
    const sites = sitesFrom(
      [
        ...entries,
        { folder: "builder", manifest: null },
        { folder: "nis2", manifest: manifest("nis2", ["nis2.env", "nis2-ses.env"]) },
        { folder: "dashboard-backup", manifest: manifest("dashboard-backup", ["dashboard-backup.env"]) },
      ],
      ["cms.env", "cms-webhook.env", "builder-ssh", "nis2.env", "nis2-ses.env", "landing-ses.env", "dashboard-backup.env", "stray.env"],
    );
    for (const folder of ["cms", "builder", "nis2", "dashboard-backup", "test-zone.invalid"]) expect({ folder, files: filesOf(sites, folder) }).toEqual({ folder, files: [] });
    expect(filesOf(sites, "dashboard")).toEqual(["dashboard.env", "dashboard-backup.env"]);
  });

  test("owner, mode and passwords follow from the table", () => {
    const sites = sitesFrom(entries, ["dashboard-monitor.env", "dashboard-backup.env"]);
    expect(sites.get("dashboard")!.files.map((file) => [file.name, expectedText(file.expected), file.passwords])).toEqual([
      ["dashboard.env", "root:root 0600", ["PASSWORD_HASH"]],
      ["dashboard-monitor.env", "root:root 0600", ["PASSWORD_HASH"]],
      ["dashboard-backup.env", "root:root 0600", ["PASSWORD_HASH"]],
    ]);
    expect(sites.get("portal")!.files.map((file) => [file.name, expectedText(file.expected)])).toEqual([["portal.env", "site-portal:site-portal 0600"]]);
  });

  test("a site of the table's name that is no directory of /srv/sites lists nothing", () => {
    const sites = sitesFrom([{ folder: "cms", manifest: manifest("cms", ["API_KEY"]) }], ["dashboard.env", "portal.env"]);
    expect([...sites.values()].flatMap((site) => site.files)).toEqual([]);
  });
});

describe("passwords", () => {
  /** The dashboard's hash file, its monitor's, and the portal's. */
  function declarations() {
    const sites = sitesFrom(
      [
        { folder: "dashboard", manifest: manifest("dashboard", undefined) },
        { folder: "portal", manifest: manifest("portal", undefined) },
      ],
      ["dashboard.env", "dashboard-monitor.env"],
    );
    const [dashboard, monitor] = sites.get("dashboard")!.files;
    return { dashboard: dashboard!, monitor: monitor!, portal: sites.get("portal")!.files[0]! };
  }

  test("PASSWORD_HASH is a password in every platform file", () => {
    expect(PASSWORD_VARIABLE).toBe("PASSWORD_HASH");
    const { dashboard, monitor, portal } = declarations();
    for (const declaration of [dashboard, monitor, portal]) {
      expect(declaration.passwords).toEqual(["PASSWORD_HASH"]);
      expect(isPassword(declaration, "PASSWORD_HASH")).toBe(true);
      expect(isPassword(declaration, "password_hash")).toBe(false);
      expect(isPassword(declaration, "TOKEN")).toBe(false);
    }
  });

  test("hash only: the dashboard and the portal carry nothing other than PASSWORD_HASH", () => {
    expect(HASH_ONLY).toEqual(["dashboard.env", "portal.env"]);
    const settings = "OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_ALLOWED_DOMAINS, OIDC_ADMIN_EMAILS, OIDC_PROVIDER_NAME";
    const held = { "dashboard.env": "PASSWORD_HASH", "portal.env": `PASSWORD_HASH and ${settings}` } as Record<string, string>;
    for (const name of HASH_ONLY) {
      for (const variable of ["STEWARD_SOCKET", "PORTAL_URL", "STATE_FILE", "OTHER", "DATA_DIR", "PORT", "PUBLIC_URL", "oidc_issuer"]) {
        const refusal = outsideHashRefusal(name, variable);
        expect(refusal?.error).toBe("out-of-scope");
        // The message says why, without quoting the name submitted.
        expect(refusal?.message).toBe(`${name} holds ${held[name]} only: any other variable would change how its service runs, not add a secret`);
      }
      // PASSWORD_HASH itself is refused elsewhere, as a password.
      expect(outsideHashRefusal(name, "PASSWORD_HASH")).toBeNull();
    }
    expect(outsideHashRefusal("dashboard-monitor.env", "STEWARD_SOCKET")).toBeNull();
    expect(outsideHashRefusal("dashboard-backup.env", "OTHER")).toBeNull();
  });

  test("the portal's sign-in settings, by name, in portal.env and nowhere else that is hash only", () => {
    expect(HASH_FILE_SETTINGS["portal.env"]).toEqual(IDENTITY_VARIABLES);
    for (const variable of IDENTITY_VARIABLES) {
      expect(outsideHashRefusal("portal.env", variable)).toBeNull();
      expect(outsideHashRefusal("dashboard.env", variable)?.error).toBe("out-of-scope");
    }
    const path = "/etc/sitesolide/portal.env";
    expect(outsideHashReason("portal.env", ["PASSWORD_HASH", "OIDC_ISSUER", "OIDC_CLIENT_SECRET"], path)).toBeNull();
    expect(outsideHashReason("portal.env", ["PASSWORD_HASH", "OIDC_ISSUER", "DATA_DIR"], path)).toContain("(DATA_DIR)");
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
    expect(outsideHashReason("dashboard-monitor.env", ["PASSWORD_HASH", "TOKEN"], path)).toBeNull();
  });

  test("restoring: never the dashboard nor the portal, never a version carrying a password", () => {
    const { dashboard, monitor, portal } = declarations();
    const refusal: Refusal = { error: "out-of-scope", message: "a password is only changed with Change password" };
    expect(restoreRefusal(dashboard, [])).toEqual(refusal);
    expect(restoreRefusal(portal, [])).toEqual(refusal);
    expect(restoreRefusal(monitor, ["TOKEN", "PASSWORD_HASH"])).toEqual(refusal);
    expect(restoreRefusal(monitor, ["TOKEN"])).toBeNull();
    expect(restoreRefusal(monitor, [])).toBeNull();
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
  const dashboard = sitesFrom([{ folder: "dashboard", manifest: manifest("dashboard", undefined) }], ["dashboard-monitor.env"]).get("dashboard")!;

  test("listed and well formed names pass", () => {
    for (const name of ["dashboard.env", "dashboard-monitor.env"]) {
      const verdict = checkFile(dashboard, name, SECRETS);
      expect("path" in verdict && verdict.path).toBe(`${SECRETS}/${name}`);
    }
  });

  test("traversals, separators, folders, null bytes and hidden names are out of scope", () => {
    const traps = [
      "../dashboard.env",
      "dashboard.env/..",
      "..",
      ".",
      "",
      "/etc/passwd",
      "dashboard/../../etc/shadow.env",
      "dashboard..env",
      "dashboard.env\0",
      "dashboard\\..\\x.env",
      "..%2fdashboard.env",
      "%2e%2e/dashboard.env",
      ".dashboard.env",
      "dashboard.env ",
      "dashboard*.env",
      "dashboard?.env",
      "dashboard[1].env",
      "keys/dashboard.key",
      "keys/../dashboard.env",
      "projects/cms/env",
      `dashboard${charOf(0xff0e)}${charOf(0xff0e)}env`,
      `dashboard-cafe${charOf(0x301)}.env`,
      `dashboard-caf${charOf(0xe9)}.env`,
      "x".repeat(200) + ".env",
    ];
    for (const name of traps) {
      const verdict = checkFile(dashboard, name, SECRETS);
      expect({ name, error: "refusal" in verdict && verdict.refusal.error }).toEqual({ name, error: "out-of-scope" });
    }
  });

  test("a name with a folder is refused as such: every platform file is flat", () => {
    for (const name of ["keys/dashboard.key", "projects/cms/env", "a/b"]) {
      expect(nameRefusal(name)).toEqual({ error: "out-of-scope", message: "a flat file name, with no folder" });
    }
  });

  test("a well formed name the site does not list is refused", () => {
    const verdict = checkFile(dashboard, "dashboard-backup.env", SECRETS);
    expect("refusal" in verdict && verdict.refusal.message).toBe("dashboard-backup.env is not one of the platform's files that dashboard lists");
    const other = checkFile(dashboard, "cms.env", SECRETS);
    expect("refusal" in other && other.refusal.error).toBe("out-of-scope");
  });

  test("what is not a string is invalid, not out of scope", () => {
    for (const name of [undefined, null, 42, ["dashboard.env"], { name: "dashboard.env" }]) {
      expect(nameRefusal(name)?.error).toBe("invalid");
    }
  });

  test("a refusal never throws", () => {
    for (const name of [undefined, Symbol("x"), `${charOf(0xd800)}.env`, `dashboard.${charOf(0xd800)}.env`, `keys/${charOf(0xd800)}`]) {
      expect(() => nameRefusal(name)).not.toThrow();
    }
  });
});

describe("resolved path", () => {
  test("one level exactly, never above nor below", () => {
    expect(pathUnder(SECRETS, "portal.env")).toBe("/etc/sitesolide/portal.env");
    expect(pathUnder(`${SECRETS}/`, "portal.env")).toBe("/etc/sitesolide/portal.env");
    expect(pathUnder(SECRETS, "keys/registry")).toBeNull();
    expect(pathUnder(SECRETS, "..")).toBeNull();
    expect(pathUnder(SECRETS, ".")).toBeNull();
    expect(pathUnder(SECRETS, "")).toBeNull();
    expect(pathUnder(SECRETS, "../sitesolide/portal.env")).toBeNull();
    expect(pathUnder(SECRETS, "../passwd")).toBeNull();
    expect(pathUnder(SECRETS, "a/b/c")).toBeNull();
    expect(pathUnder(SECRETS, "a/../b")).toBeNull();
    expect(pathUnder(SECRETS, "/etc/passwd")).toBeNull();
  });
});

describe("requested site", () => {
  const sites = sitesFrom([
    { folder: "cms", manifest: manifest("cms", ["API_KEY"]) },
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

  test("root expected: the command says so", () => {
    const aRoot: Expected = { owner: "root", group: "root", mode: 0o600 };
    expect(judge({ ...healthy, uid: 1001 }, { uid: 0, gid: 0 }, aRoot)).toContain("sudo chown root:root");
  });

  test("with no account check, uid and gid do not count", () => {
    expect(judge({ ...healthy, uid: 0, gid: 0 }, null)).toBeNull();
  });
});

describe("a store's folder", () => {
  const healthy: FolderInfo = { link: false, folder: true, uid: 0, mode: 0o755 };
  const path = "/etc/sitesolide/projects/cms";

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
 * Every platform file present has to land on its site with the expectation
 * the table gives, and any other file must land on none: what is not the
 * platform's is not the dashboard's to write. The cases that count: an app
 * project with a store, a showcase with no secret, the dashboard owned by
 * root, the portal, the landing that has no manifest, a file the landing's
 * old service still reads, and a file that belongs to no project.
 */
describe("a secrets directory against the sites it serves", () => {
  const PRESENT = ["blog.env", "dashboard.env", "dashboard-monitor.env", "landing-ses.env", "portal.env", "stray.env"];
  const staticManifest = (slug: string) => JSON.stringify({ slug, publicDir: "public" });
  const sites = sitesFrom(
    [
      { folder: "blog", manifest: manifest("blog", ["API_KEY"]) },
      { folder: "shop", manifest: staticManifest("shop") },
      { folder: "dashboard", manifest: manifest("dashboard", undefined) },
      { folder: "portal", manifest: manifest("portal", undefined) },
      // The landing serves the bare domain: its directory carries the zone's
      // name, and it has no manifest.
      { folder: LANDING_FOLDER, manifest: null },
    ],
    PRESENT,
  );
  const managed = new Map<string, { site: string; file: Declaration }>();
  for (const site of sites.values()) for (const file of site.files) managed.set(file.name, { site: site.folder, file });

  const EXPECTED: [string, string][] = [
    ["dashboard.env", "root:root 0600"],
    ["dashboard-monitor.env", "root:root 0600"],
    ["portal.env", "site-portal:site-portal 0600"],
  ];
  for (const [name, expected] of EXPECTED) {
    test(`${name} (${expected})`, () => {
      expect(expectedText(managed.get(name)!.file.expected)).toBe(expected);
    });
  }

  test("every file lands where it should", () => {
    expect(managed.get("dashboard.env")?.site).toBe("dashboard");
    expect(managed.get("dashboard-monitor.env")?.site).toBe("dashboard");
    // The portal carries nothing but its hash: another variable would
    // change what its service does.
    expect(managed.get("portal.env")?.file.passwords).toEqual(["PASSWORD_HASH"]);
    // A project keeps its secrets in its store: its name prefixes nothing here.
    expect(managed.has("blog.env")).toBe(false);
    // A file a hand-made service reads is the owner's to look after by hand.
    expect(managed.has("landing-ses.env")).toBe(false);
    // What belongs to no site is not the dashboard's.
    expect(managed.has("stray.env")).toBe(false);
    expect([...managed.keys()].sort()).toEqual(["dashboard-monitor.env", "dashboard.env", "portal.env"]);
  });
});
