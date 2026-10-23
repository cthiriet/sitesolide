import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeValue } from "../cli/envfile";
import { isLegacySecretName, isValidFileName, isValidSecretName, MAX_DECLARED_FILES } from "../cli/manifest";
import {
  CREDENTIAL_ID,
  credentialBudgetRefusal,
  credentialName,
  credentialsFailure,
  CREDENTIALS_EXIT_STATUS,
  CREDENTIALS_PAGE_BYTES,
  CREDENTIALS_TMPFS_BYTES,
  CREDENTIALS_TMPFS_PAGES,
  encodeGenerated,
  GENERATE_DEFAULT_BYTES,
  GENERATE_FORMATS,
  GENERATE_MAX_BYTES,
  GENERATE_MIN_BYTES,
  MAX_ENV_LINE_BYTES,
  MAX_STORE_ENV_BYTES,
  MAX_STORE_FILE_BYTES,
  MAX_STORE_FILES,
  MAX_STORE_FILES_BYTES,
  readStorePrepareAnswer,
  SECRETS_FOLDER,
  slugHasStore,
  STORE_FILE_MODE,
  STORE_FOLDER_MODE,
  STORE_PREVIOUS_ROOT,
  STORE_READY,
  STORE_REFUSED,
  STORE_ROOT,
  STORE_UNIT_LINES_AFTER,
  storeCredentials,
  storeEnvironmentFile,
  storeFilePath,
  storePaths,
  storePrepareCommand,
  storeRemovalActions,
  workstationSecretsPath,
} from "../cli/store";
import { MAX_KEY, MAX_VALUE_BYTES } from "../cli/variables";

describe("where the store lives", () => {
  test("one folder per project, its env file and its files folder", () => {
    expect([SECRETS_FOLDER, STORE_ROOT, STORE_PREVIOUS_ROOT]).toEqual([
      "/etc/sitesolide",
      "/etc/sitesolide/projects",
      "/var/lib/sitesolide-steward/precedents/projects",
    ]);
    expect([STORE_FOLDER_MODE, STORE_FILE_MODE]).toEqual([0o700, 0o600]);
    expect(storePaths("shop")).toEqual({
      folder: "/etc/sitesolide/projects/shop",
      env: "/etc/sitesolide/projects/shop/env",
      files: "/etc/sitesolide/projects/shop/files",
    });
    expect(storePaths("shop", "/tmp/tree/projects").env).toBe("/tmp/tree/projects/shop/env");
    expect(storeFilePath("shop", "gcp.json")).toBe("/etc/sitesolide/projects/shop/files/gcp.json");
  });

  test("no path is ever built from a slug that is not one", () => {
    for (const slug of ["", "..", ".", "../etc", "a/b", "/", "Shop", "shop.env", "-shop", "a".repeat(64), "shop\n"]) {
      expect(() => storePaths(slug)).toThrow();
      expect(() => storeFilePath(slug, "gcp.json")).toThrow();
      expect(() => storeEnvironmentFile(slug)).toThrow();
      expect(() => storeCredentials(slug)).toThrow();
      expect(() => storePrepareCommand(slug)).toThrow();
      expect(() => storeRemovalActions(slug)).toThrow();
      expect(() => workstationSecretsPath("/home/u/.config/sitesolide/secrets", slug)).toThrow();
    }
    expect(() => storePaths(3 as unknown as string)).toThrow();
  });

  test("nor from a file name that is not one", () => {
    for (const name of ["", ".hidden", "..", "a..b", "sub/x", "../x", "x".repeat(65), "a b"]) {
      expect(() => storeFilePath("shop", name)).toThrow();
    }
  });

  test("a slug may have a store unless it is storeless", () => {
    expect(slugHasStore("shop")).toBe(true);
    expect(slugHasStore("analytics")).toBe(true);
    for (const slug of ["dashboard", "portal", "", "../x", "Shop"]) expect(slugHasStore(slug)).toBe(false);
  });

  test("the workstation's file of a project's build secrets", () => {
    expect(workstationSecretsPath("/home/u/.config/sitesolide/secrets", "crm")).toBe("/home/u/.config/sitesolide/secrets/crm.env");
    expect(workstationSecretsPath("/home/u/.config/sitesolide/secrets/", "crm")).toBe("/home/u/.config/sitesolide/secrets/crm.env");
  });
});

describe("disjoint from every name of the old form, by construction", () => {
  /** The old form's names: a flat file, or one level under a folder ending in -secrets (scope.ts's nameRefusal). */
  const legacyShape = (name: string): boolean =>
    isValidSecretName(name) || /^[A-Za-z0-9][A-Za-z0-9._-]*-secrets\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);

  const legacy = [
    "crm.env",
    "nis2-ses.env",
    "nis2-stripe.env",
    "dashboard.env",
    "dashboard-monitor.env",
    "landing-ses.env",
    "projects.env",
    "projects-x.env",
    "shop-secrets/gcp.json",
    "projects-secrets/env",
    "projects-secrets/files",
  ];

  test("no legacy name resolves under the store's root", () => {
    for (const name of legacy) {
      expect(legacyShape(name)).toBe(true);
      expect(`${SECRETS_FOLDER}/${name}`.startsWith(`${STORE_ROOT}/`)).toBe(false);
    }
    // `projects` itself is a folder, and no longer reads as a file of the old form.
    expect(isLegacySecretName("projects")).toBe(false);
  });

  test("no store path has a legacy name's shape", () => {
    for (const slug of ["shop", "nis2-ses", "projects", "a"]) {
      const { folder, env, files } = storePaths(slug);
      for (const path of [STORE_ROOT, folder, env, files, storeFilePath(slug, "gcp.json"), storeFilePath(slug, "x.env")]) {
        const name = path.slice(SECRETS_FOLDER.length + 1);
        expect({ name, legacy: name !== "projects" && legacyShape(name) }).toEqual({ name, legacy: false });
      }
    }
  });

  test("the journal's labels are no legacy name either", () => {
    for (const label of ["store/gcp.json", "store/x.env"]) expect(legacyShape(label)).toBe(false);
  });
});

describe("what a unit reads", () => {
  test("the env file, last and optional, and the credentials folder", () => {
    expect(storeEnvironmentFile("shop")).toBe("-/etc/sitesolide/projects/shop/env");
    expect(storeCredentials("shop")).toBe("files:/etc/sitesolide/projects/shop/files");
    expect(CREDENTIAL_ID).toBe("files");
    expect(STORE_UNIT_LINES_AFTER).toEqual(["InaccessiblePaths=-/etc/sitesolide", "ProtectProc=invisible"]);
  });

  test("a file reaches the service as files_<name>", () => {
    expect(credentialName("gcp.json")).toBe("files_gcp.json");
    expect(credentialName("tls.key")).toBe("files_tls.key");
  });

  test("243 is worded once, for every reader of an exit status", () => {
    expect(CREDENTIALS_EXIT_STATUS).toBe(243);
    expect(credentialsFailure("shop.api", "shop")).toBe(
      "shop.api could not load its secret files (243/CREDENTIALS): the store's files folder is missing, or its files are too large; sitesolide refresh shop lays the folder again",
    );
  });
});

describe("systemd's budget for a unit's credentials", () => {
  const id = (name: string) => `files_${name}`.length;

  test("bytes: sizes and ids together, 1 MiB at most", () => {
    expect([CREDENTIALS_TMPFS_BYTES, CREDENTIALS_TMPFS_PAGES, CREDENTIALS_PAGE_BYTES]).toEqual([1_048_576, 256, 4096]);
    expect(credentialBudgetRefusal([])).toBeNull();
    // Two files exactly at the limit, counting their ids, within the pages.
    const half = CREDENTIALS_TMPFS_BYTES / 2;
    const at = [
      { name: "a.bin", size: half - id("a.bin") },
      { name: "b.bin", size: half - id("b.bin") },
    ];
    expect(credentialBudgetRefusal(at)).toBeNull();
    expect(credentialBudgetRefusal([at[0]!, { ...at[1]!, size: at[1]!.size - 1 }])).toBeNull();
    const over = [at[0]!, { ...at[1]!, size: at[1]!.size + 1 }];
    const refusal = credentialBudgetRefusal(over);
    expect(refusal).toContain("243/CREDENTIALS");
    // No size, no name: a size is the owner's alone to see.
    expect(refusal).not.toContain("a.bin");
    expect(refusal).not.toContain(String(over[1]!.size));
  });

  test("pages: one at least per file, 256 at most", () => {
    const files = (count: number, size: number) => Array.from({ length: count }, (_, rank) => ({ name: `f${rank}`, size }));
    expect(credentialBudgetRefusal(files(256, 0))).toBeNull();
    expect(credentialBudgetRefusal(files(257, 0))).not.toBeNull();
    expect(credentialBudgetRefusal(files(128, 4097))).toBeNull();
    expect(credentialBudgetRefusal(files(129, 4097))).not.toBeNull();
    // Far under the bytes: only the pages decide.
    const mixed = [...files(200, 1), ...files(28, 4097).map((file) => ({ ...file, name: `g${file.name}` }))];
    expect(credentialBudgetRefusal(mixed)).toBeNull();
    expect(credentialBudgetRefusal([...mixed.slice(0, -1), { name: "last", size: 2 * 4096 + 1 }])).not.toBeNull();
  });

  test("what the store's own bounds allow always fits", () => {
    expect([MAX_STORE_FILES, MAX_STORE_FILE_BYTES, MAX_STORE_FILES_BYTES, MAX_STORE_ENV_BYTES]).toEqual([32, 64 * 1024, 512 * 1024, 256 * 1024]);
    expect(MAX_STORE_FILES).toBe(MAX_DECLARED_FILES);
    // The worst case: as many files as allowed, names of 64 characters, the
    // content spread so that each file rounds up to one more page.
    const longest = "x".repeat(64);
    expect(isValidFileName(longest)).toBe(true);
    const size = Math.floor(MAX_STORE_FILES_BYTES / MAX_STORE_FILES);
    expect(size).toBeLessThanOrEqual(MAX_STORE_FILE_BYTES);
    const worst = Array.from({ length: MAX_STORE_FILES }, (_, rank) => ({ name: `${longest.slice(0, 62)}${String(rank).padStart(2, "0")}`, size: size + (rank === 0 ? 1 : 0) - (rank === 1 ? 1 : 0) }));
    expect(credentialBudgetRefusal(worst)).toBeNull();
    expect(credentialBudgetRefusal(Array.from({ length: MAX_STORE_FILES }, (_, rank) => ({ name: `${longest.slice(0, 62)}${rank}`, size: MAX_STORE_FILE_BYTES })))).not.toBeNull();
  });

  test("a line of the env file stays far under what fails a start", () => {
    expect(MAX_ENV_LINE_BYTES).toBe(131_071);
    // The longest line the steward can write: the longest name, a value of
    // 8 KiB every byte of which is escaped inside double quotes.
    expect(MAX_KEY + 1 + 2 + 2 * MAX_VALUE_BYTES).toBeLessThan(MAX_ENV_LINE_BYTES);
  });
});

describe("generate", () => {
  test("the formats and the bounds", () => {
    expect(GENERATE_FORMATS).toEqual(["hex", "base64url"]);
    expect([GENERATE_DEFAULT_BYTES, GENERATE_MIN_BYTES, GENERATE_MAX_BYTES]).toEqual([32, 16, 64]);
  });

  test("hex: two lowercase digits a byte", () => {
    expect(encodeGenerated(new Uint8Array([0xfb, 0xff, 0x00, 0x10]), "hex")).toBe("fbff0010");
    for (const length of [GENERATE_MIN_BYTES, GENERATE_DEFAULT_BYTES, GENERATE_MAX_BYTES]) {
      const value = encodeGenerated(crypto.getRandomValues(new Uint8Array(length)), "hex");
      expect(value).toMatch(new RegExp(`^[0-9a-f]{${2 * length}}$`));
    }
  });

  test("base64url: the URL alphabet, without padding", () => {
    expect(encodeGenerated(new Uint8Array([0xfb, 0xff]), "base64url")).toBe("-_8");
    for (const length of [GENERATE_MIN_BYTES, GENERATE_DEFAULT_BYTES, 33, GENERATE_MAX_BYTES]) {
      const value = encodeGenerated(crypto.getRandomValues(new Uint8Array(length)), "base64url");
      expect(value).toMatch(new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((4 * length) / 3)}}$`));
    }
  });

  test("both are written bare in an env file", () => {
    const bytes = new Uint8Array(256).map((_, rank) => rank);
    for (const format of GENERATE_FORMATS) {
      const value = encodeGenerated(bytes, format);
      expect(encodeValue(value)).toBe(value);
    }
  });

  test("refuses a format it does not know", () => {
    expect(() => encodeGenerated(new Uint8Array(16), "base32" as "hex")).toThrow();
  });
});

describe("the command that lays the store's folders", () => {
  test("its text: the three folders, the link refusal, the markers, nothing else", () => {
    const command = storePrepareCommand("shop");
    expect(command.startsWith("sudo sh -c ': store-prepare shop; set -eu; umask 077; ")).toBe(true);
    expect(command.endsWith("'")).toBe(true);
    // One quoted script: no single quote inside it.
    expect(command.slice("sudo sh -c '".length, -1)).not.toContain("'");
    expect(command).toContain("for p in /etc/sitesolide/projects /etc/sitesolide/projects/shop /etc/sitesolide/projects/shop/files; do");
    expect(command).toContain('if [ -L "$p" ] || { [ -e "$p" ] && [ ! -d "$p" ]; }; then echo "STORE-REFUSED $p"; exit 3; fi');
    expect(command).toContain('mkdir -m 700 "$p"');
    expect(command).toContain('chown root:root "$p"; chmod 700 "$p"');
    expect(command).toContain('echo "STORE-READY $made"');
    const paths = [...command.matchAll(/\/[A-Za-z0-9/_.-]+/g)].map((match) => match[0]);
    expect(new Set(paths)).toEqual(
      new Set([
        "/etc/sitesolide/projects",
        "/etc/sitesolide/projects/shop",
        "/etc/sitesolide/projects/shop/files",
        "/var/lib/sitesolide-steward/precedents/projects/shop",
      ]),
    );
    // The previous versions are dropped only on the project folder's creation.
    expect(command).toContain('if [ "$p" = /etc/sitesolide/projects/shop ]; then rm -rf /var/lib/sitesolide-steward/precedents/projects/shop; made=created; fi');
    // Never the env file nor a file of the store.
    expect(command).not.toContain("/env");
  });

  describe("run on a throwaway tree", () => {
    const tree = mkdtempSync(join(tmpdir(), "store-prepare-"));
    afterAll(() => rmSync(tree, { recursive: true, force: true }));
    let round = 0;

    /** The script as root would run it, its paths moved into a fresh tree, and chown, which needs root, left out. */
    function prepare(slug: string, setup: (root: string) => void = () => {}): { output: string; status: number; root: string } {
      const root = join(tree, String(round++));
      mkdirSync(join(root, "etc", "sitesolide"), { recursive: true });
      setup(root);
      const script = storePrepareCommand(slug)
        .slice("sudo sh -c '".length, -1)
        .replaceAll(STORE_ROOT, join(root, STORE_ROOT))
        .replaceAll(STORE_PREVIOUS_ROOT, join(root, STORE_PREVIOUS_ROOT))
        .replaceAll('chown root:root "$p"', ': chown "$p"');
      const run = Bun.spawnSync(["sh", "-c", script], { stdout: "pipe", stderr: "pipe" });
      return { output: run.stdout.toString(), status: run.exitCode, root };
    }

    test("makes the three folders, 0700, and says it made the store", () => {
      const { output, status, root } = prepare("shop");
      expect({ output, status }).toEqual({ output: "STORE-READY created\n", status: 0 });
      for (const folder of [STORE_ROOT, `${STORE_ROOT}/shop`, `${STORE_ROOT}/shop/files`]) {
        const stat = lstatSync(join(root, folder));
        expect(stat.isDirectory()).toBe(true);
        expect(stat.mode & 0o777).toBe(0o700);
      }
      expect(existsSync(join(root, STORE_ROOT, "shop", "env"))).toBe(false);
      expect(readStorePrepareAnswer(output)).toEqual({ kind: "ready", created: true });
    });

    test("drops a removed project's previous versions when it makes its folder, never otherwise", () => {
      const previous = (root: string) => join(root, STORE_PREVIOUS_ROOT, "shop");
      const fresh = prepare("shop", (root) => {
        mkdirSync(previous(root), { recursive: true });
        writeFileSync(join(previous(root), "env"), "OLD=1\n");
      });
      expect(fresh.output).toBe("STORE-READY created\n");
      expect(existsSync(previous(fresh.root))).toBe(false);

      const kept = prepare("shop", (root) => {
        mkdirSync(join(root, STORE_ROOT, "shop"), { recursive: true });
        writeFileSync(join(root, STORE_ROOT, "shop", "env"), "A=1\n");
        mkdirSync(previous(root), { recursive: true });
        writeFileSync(join(previous(root), "env"), "OLD=1\n");
      });
      // files/ deleted by hand comes back; the store, its env and its previous versions stay.
      expect(kept.output).toBe("STORE-READY present\n");
      expect(lstatSync(join(kept.root, STORE_ROOT, "shop", "files")).isDirectory()).toBe(true);
      expect(existsSync(join(kept.root, STORE_ROOT, "shop", "env"))).toBe(true);
      expect(existsSync(join(previous(kept.root), "env"))).toBe(true);
      expect(readStorePrepareAnswer(kept.output)).toEqual({ kind: "ready", created: false });
    });

    test("refuses a link or something that is no folder, at each of the three, and goes no further", () => {
      const parts = [STORE_ROOT, `${STORE_ROOT}/shop`, `${STORE_ROOT}/shop/files`];
      for (const [rank, part] of parts.entries()) {
        for (const kind of ["link", "file"] as const) {
          const { output, status, root } = prepare("shop", (root) => {
            for (const parent of parts.slice(0, rank)) mkdirSync(join(root, parent), { recursive: true });
            if (kind === "link") {
              mkdirSync(join(root, "elsewhere"));
              symlinkSync(join(root, "elsewhere"), join(root, part));
            } else {
              writeFileSync(join(root, part), "");
            }
          });
          expect({ part, kind, status }).toEqual({ part, kind, status: 3 });
          expect(output).toBe(`STORE-REFUSED ${join(root, part)}\n`);
          // Nothing was made past the refused one.
          for (const later of parts.slice(rank + 1)) expect(existsSync(join(root, later))).toBe(false);
        }
      }
    });
  });

  test("its answer: a marker or nothing read", () => {
    expect(STORE_READY).toBe("STORE-READY");
    expect(STORE_REFUSED).toBe("STORE-REFUSED");
    expect(readStorePrepareAnswer("STORE-READY created\n")).toEqual({ kind: "ready", created: true });
    expect(readStorePrepareAnswer("STORE-READY present")).toEqual({ kind: "ready", created: false });
    expect(readStorePrepareAnswer("sudo: unable to resolve host x\nSTORE-READY present\n")).toEqual({ kind: "ready", created: false });
    expect(readStorePrepareAnswer("STORE-REFUSED /etc/sitesolide/projects/shop/files\n")).toEqual({ kind: "refused", path: "/etc/sitesolide/projects/shop/files" });
    expect(readStorePrepareAnswer("STORE-REFUSED /etc/sitesolide/projects")).toEqual({ kind: "refused", path: "/etc/sitesolide/projects" });
    for (const output of ["", "\n", "STORE-READY", "STORE-READY maybe", "STORE-READY created\nsomething else", "STORE-REFUSED /etc/passwd", "STORE-REFUSED ", "READY created"]) {
      expect({ output, read: readStorePrepareAnswer(output) }).toEqual({ output, read: { kind: "unreadable" } });
    }
  });
});

describe("removal", () => {
  test("the store and its previous versions, whatever the manifest says", () => {
    expect(storeRemovalActions("shop")).toEqual([
      { title: "remove the project's store of secrets", command: "sudo rm -rf /etc/sitesolide/projects/shop" },
      { title: "remove the previous versions of its store kept by the dashboard", command: "sudo rm -rf /var/lib/sitesolide-steward/precedents/projects/shop" },
    ]);
  });
});
