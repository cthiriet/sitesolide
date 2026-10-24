import { describe, expect, test } from "bun:test";
import { readManifest, type Manifest } from "../borrowed/manifest";
import { CREDENTIALS_TMPFS_PAGES, MAX_ENV_LINE_BYTES, MAX_STORE_ENV_BYTES, MAX_STORE_FILE_BYTES, MAX_STORE_FILES, MAX_STORE_FILES_BYTES } from "../borrowed/store";
import type { Refusal, Site } from "../src/secrets/scope";
import {
  decodeFileContent,
  drawValue,
  envBytesRefusal,
  fileNameRefusal,
  filesRefusal,
  generateRefusal,
  readGenerateAsk,
  storeMay,
  storeNameRefusal,
  storeSlugRefusal,
  storeValueRefusal,
  storeView,
  type StoreState,
  type StoreViewInput,
} from "../src/secrets/store";

/**
 * The pure decisions of a project's store, without a VM: who may hold one,
 * which names and values it takes, what a file and the whole folder may
 * weigh, what a draw gives, and what the listing tells each requester. The steward applies
 * them (tests/secrets-steward.test.ts).
 */

const ZONE = "test-zone.invalid";
/** A value that must never come out of any answer built here. */
const CANARY = "canary-VALUE-never-out-7f3e";
const KEY_LIKE = "sk_live_canary_pasted_as_a_name";

function site(folder: string, manifest: Record<string, unknown> | null): Pick<Site, "folder" | "manifest" | "isStatic"> {
  const parsed = manifest === null ? null : (readManifest(JSON.stringify(manifest)).manifest ?? null);
  const isStatic = parsed !== null && parsed.slug === folder && typeof parsed.start !== "string" && parsed.services === undefined;
  return { folder, manifest: parsed, isStatic };
}

const APP = { start: "/usr/local/bin/bun run server.ts", port: 3040 };

describe("who may hold a store (rule 1)", () => {
  const owner = { requester: "owner" as const, creating: false, zone: ZONE };
  const person = { requester: "person" as const, creating: false, zone: ZONE };
  const token = { requester: "token" as const, creating: false, zone: ZONE };

  test("a deployed app, for the owner, a person and a token", () => {
    const shop = site("shop", { slug: "shop", ...APP, secrets: ["API_KEY"] });
    for (const context of [owner, person, token]) expect(storeSlugRefusal("shop", { ...context, site: shop })).toBeNull();
  });

  test("what is not a slug is invalid and never quoted, a value pasted in its place included", () => {
    for (const slug of [42, null, "", "Shop", "shop.test", "../etc", "-shop", KEY_LIKE, "a".repeat(64)]) {
      const refusal = storeSlugRefusal(slug, { ...owner, site: null });
      expect(refusal?.error).toBe("invalid");
      if (typeof slug === "string" && slug !== "") expect(refusal?.message).not.toContain(slug);
    }
  });

  test("the names that are no project's: landing, machine, a unit of the machine; storeless dashboard and portal, for the owner too", () => {
    for (const slug of ["landing", "machine", "caddy", "ssh", "sitesolide-steward", "systemd-journald", "www", "dashboard", "portal"]) {
      expect([slug, storeSlugRefusal(slug, { ...owner, site: null })?.error]).toEqual([slug, "out-of-scope"]);
    }
    expect(storeSlugRefusal("dashboard", { ...owner, site: null })?.message).toBe("dashboard keeps its password hash in dashboard.env, which its unit reads: it has no store");
    expect(storeSlugRefusal("landing", { ...owner, site: null })?.message).toBe("landing names the landing's account, never a project's store");
  });

  test("the platform's projects are the owner's alone", () => {
    const analytics = site("analytics", { slug: "analytics", ...APP });
    expect(storeSlugRefusal("analytics", { ...owner, site: analytics })).toBeNull();
    for (const context of [person, token]) {
      for (const slug of ["analytics", "api"]) {
        expect(storeSlugRefusal(slug, { ...context, site: site(slug, { slug, ...APP }) })).toEqual({ error: "out-of-scope", message: `${slug} belongs to the platform, which stays the owner's` });
      }
    }
  });

  test("a static site has no store, whoever asks", () => {
    const blog = site("blog", { slug: "blog", publicDir: "public", build: "bun run build" });
    for (const context of [owner, person, token]) {
      expect(storeSlugRefusal("blog", { ...context, site: blog })).toEqual({
        error: "out-of-scope",
        message: "a static site has no service to read a store; its build secrets stay with whoever deploys",
      });
    }
  });

  test("a folder whose manifest does not describe it: the owner's to lay ahead, nobody else's", () => {
    for (const manifest of [null, { slug: "other", ...APP }]) {
      const folder = site("shop", manifest);
      expect(storeSlugRefusal("shop", { ...owner, site: folder })).toBeNull();
      expect(storeSlugRefusal("shop", { ...person, site: folder })?.error).toBe("out-of-scope");
      expect(storeSlugRefusal("shop", { ...token, creating: true, site: folder })?.error).toBe("out-of-scope");
    }
  });

  test("ahead of a deployment: the owner, a token that may create the slug; never a person, nor another token", () => {
    expect(storeSlugRefusal("fresh", { ...owner, site: null })).toBeNull();
    expect(storeSlugRefusal("fresh", { ...token, creating: true, site: null })).toBeNull();
    expect(storeSlugRefusal("fresh", { ...token, site: null })).toEqual({ error: "not-found", message: "fresh is not a project deployed on this machine" });
    expect(storeSlugRefusal("fresh", { ...person, creating: true, site: null })).toEqual({ error: "not-found", message: "fresh is not a project deployed on this machine" });
  });
});

describe("names and values (rules 3 and 4)", () => {
  test("a name's shape, never quoted when it lacks one, nor when it starts like a key", () => {
    for (const name of [42, "", "1A", "A-B", "A B", `${CANARY}`, "x".repeat(129)]) {
      const refusal = storeNameRefusal("set", name, []);
      expect(refusal).toEqual({ error: "invalid", message: "set: not a variable name: letters, digits and underscores, not starting with a digit, 128 characters at most" });
    }
    for (const name of [KEY_LIKE, "AKIAIOSFODNN7EXAMPLE", "ghp_abc", "whsec_x", "pk_live_x"]) {
      const refusal = storeNameRefusal("generate", name, []);
      expect(refusal?.error).toBe("invalid");
      expect(refusal?.message).not.toContain(name);
    }
  });

  test("PASSWORD_HASH belongs to Change password, in every list", () => {
    for (const list of ["set", "remove", "generate", "name"] as const) {
      expect(storeNameRefusal(list, "PASSWORD_HASH", list === "remove" ? null : [])).toEqual({
        error: "out-of-scope",
        message: "PASSWORD_HASH is changed with Change password, in the dashboard's and the portal's files alone",
      });
    }
  });

  test("a set name: not reserved, not set by the manifest, the tree or a unit, which a store value would silently override", () => {
    expect(storeNameRefusal("set", "API_KEY", ["NODE_ENV", "PORT"])).toBeNull();
    expect(storeNameRefusal("set", "PATH", [])).toEqual({ error: "invalid", message: "set: PATH changes how the runtime behaves, not what the site does, and cannot be set here" });
    expect(storeNameRefusal("set", "PORT", [])?.message).toBe("set: PORT is set by the deployment, a secret would move the service elsewhere");
    expect(storeNameRefusal("set", "DEFAULT_SENDER", ["DEFAULT_SENDER"])?.message).toBe("set: DEFAULT_SENDER is set by the service unit, a secret would silently override it");
    // A removal repairs: a reserved name that got in by hand may go.
    expect(storeNameRefusal("remove", "PATH", null)).toBeNull();
  });

  test("a value on one line, valid, within 8 KiB, never quoted", () => {
    expect(storeValueRefusal("A", CANARY)).toBeNull();
    expect(storeValueRefusal("A", "")).toBeNull();
    for (const value of [`${CANARY}\nB=1`, `${CANARY}\r`, `${CANARY}\0`, `${CANARY}￿`, "x".repeat(8 * 1024 + 1), 42]) {
      const refusal = storeValueRefusal("A", value);
      expect(refusal?.error).toBe("invalid");
      expect(refusal?.message.startsWith("set: A: ")).toBe(true);
      expect(refusal?.message).not.toContain(CANARY);
    }
  });
});

describe("sizes and files (rules 5 and 6)", () => {
  const encoder = new TextEncoder();

  test("the env: 256 KiB at most, and every line within what systemd starts with", () => {
    expect(envBytesRefusal(new Uint8Array(MAX_STORE_ENV_BYTES).fill(10))).toBeNull();
    expect(envBytesRefusal(new Uint8Array(MAX_STORE_ENV_BYTES + 1).fill(10))?.message).toBe("the store's env would grow beyond 256 KiB");
    const line = (length: number) => encoder.encode(`A=${"x".repeat(length - 2)}\nB=1\n`);
    expect(envBytesRefusal(line(MAX_ENV_LINE_BYTES))).toBeNull();
    expect(envBytesRefusal(line(MAX_ENV_LINE_BYTES + 1))?.message).toBe("a line of the store's env would be longer than systemd reads");
  });

  test("a file's name: no leading dot, no slash, 64 characters, no `..`; never quoted", () => {
    for (const name of ["gcp.json", "tls.key", "A", "a_b-c.d", "x".repeat(64)]) expect(fileNameRefusal(name)).toBeNull();
    for (const name of [".env", ".hidden", "sub/x", "../x", "a..b", "x".repeat(65), "", " x", "-x", 42, CANARY.replace(/-/g, "/")]) {
      const refusal = fileNameRefusal(name);
      expect(refusal?.error).toBe("invalid");
      if (typeof name === "string" && name !== "") expect(refusal?.message).not.toContain(name);
    }
  });

  test("its content: base64, strict, not empty, 64 KiB at most", () => {
    const bytes = (n: number) => new Uint8Array(n).fill(7);
    expect(decodeFileContent(bytes(3).toBase64())).toEqual({ bytes: bytes(3) });
    expect(decodeFileContent(bytes(MAX_STORE_FILE_BYTES).toBase64())).toEqual({ bytes: bytes(MAX_STORE_FILE_BYTES) });
    for (const content of [bytes(MAX_STORE_FILE_BYTES + 1).toBase64(), "", "aGk", "aGl=", "aG k=", "aGk=\n", "a-_b", 42, null]) {
      expect("refusal" in decodeFileContent(content)).toBe(true);
    }
  });

  test("the folder: 32 files and 512 KiB in all, the limits themselves accepted", () => {
    const files = (count: number, size: number) => Array.from({ length: count }, (_, i) => ({ name: `f${i}`, size }));
    expect(filesRefusal(files(MAX_STORE_FILES, 1))).toBeNull();
    expect(filesRefusal(files(MAX_STORE_FILES + 1, 1))?.message).toBe("the store would hold more than 32 files: remove one first");
    expect(filesRefusal(files(8, MAX_STORE_FILES_BYTES / 8))).toBeNull();
    expect(filesRefusal([...files(8, MAX_STORE_FILES_BYTES / 8), { name: "one-more", size: 1 }])?.message).toBe(
      "the store's files would weigh more than 512 KiB in all: remove one first",
    );
    // Within both, systemd's own budget holds by construction: 32 files cost at most 160 of its 256 pages.
    expect(MAX_STORE_FILES + MAX_STORE_FILES_BYTES / 4096).toBeLessThanOrEqual(CREDENTIALS_TMPFS_PAGES);
    // No refusal gives a size.
    expect(filesRefusal(files(MAX_STORE_FILES + 1, 4097))?.message).not.toMatch(/[0-9]{4,}/);
  });
});

describe("generate", () => {
  const counting = () => (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256);

  test("hex by default, 32 bytes; base64url without padding; 16 to 64 bytes", () => {
    expect(readGenerateAsk(undefined, undefined)).toEqual({ format: "hex", bytes: 32 });
    expect(readGenerateAsk("base64url", 16)).toEqual({ format: "base64url", bytes: 16 });
    for (const [format, bytes] of [["base64", 32], ["HEX", 32], ["hex", 15], ["hex", 65], ["hex", 32.5], ["hex", "32"]] as const) {
      expect("refusal" in readGenerateAsk(format, bytes)).toBe(true);
    }
    const hex = drawValue(counting(), { format: "hex", bytes: 32 });
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    for (const bytes of [16, 32, 33, 64]) {
      const value = drawValue(counting(), { format: "base64url", bytes });
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(value.length).toBe(Math.ceil((bytes * 4) / 3));
    }
  });

  test("a short random source throws rather than give a weak key", () => {
    expect(() => drawValue(() => new Uint8Array(8), { format: "hex", bytes: 32 })).toThrow();
  });

  test("a name the store holds is drawn again only with replace", () => {
    const already: Refusal = { error: "already-present", message: "SESSION is already set; --replace draws a new value in its place" };
    expect(generateRefusal("SESSION", new Set(["SESSION"]), false)).toEqual(already);
    expect(generateRefusal("SESSION", new Set(["SESSION"]), true)).toBeNull();
    expect(generateRefusal("SESSION", new Set(), false)).toBeNull();
  });
});

describe("the listing", () => {
  const manifest = (secrets: unknown, extra: Record<string, unknown> = {}): Manifest =>
    readManifest(JSON.stringify({ slug: "shop", ...APP, env: { NODE_ENV: "production", PUBLIC_URL: "https://shop.example.test" }, secrets, ...extra })).manifest!;
  const T = 1_800_000_000_000;
  const emptyStore: StoreState = { exists: true, refusal: null, env: { kind: "absent" }, files: [], previous: false };
  const input = (partial: Partial<StoreViewInput>): StoreViewInput => ({
    slug: "shop",
    manifest: manifest({ runtime: ["API_KEY", "SESSION", "WEBHOOK"], files: ["gcp.json", "tls.key"], build: ["CMS_TOKEN"] }),
    store: emptyStore,
    unitReadsStore: true,
    startedUs: T * 1000,
    may: storeMay({ kind: "owner", restore: true }),
    owner: true,
    ...partial,
  });

  test("each name's source: the store, else none; missing are the declared ones the store lacks", () => {
    const view = storeView(
      input({
        store: { ...emptyStore, env: { kind: "managed", values: new Map([["API_KEY", CANARY], ["EXTRA", CANARY]]), modifiedAt: T - 1000 } },
      }),
    );
    expect(view.variables).toEqual([
      { name: "API_KEY", source: "store", declared: true },
      { name: "SESSION", source: "none", declared: true },
      { name: "WEBHOOK", source: "none", declared: true },
      { name: "EXTRA", source: "store", declared: false },
    ]);
    expect(view.missing).toEqual(["SESSION", "WEBHOOK"]);
    expect(view.build).toEqual(["CMS_TOKEN"]);
    expect(view.public).toEqual([
      { name: "NODE_ENV", value: "production" },
      { name: "PUBLIC_URL", value: "https://shop.example.test" },
    ]);
    expect(JSON.stringify(view)).not.toContain(CANARY);
  });

  test("a manifest that declares no secret misses nothing, and what the store holds is listed undeclared", () => {
    const view = storeView(
      input({ manifest: manifest(undefined), store: { ...emptyStore, env: { kind: "managed", values: new Map([["A", CANARY]]), modifiedAt: T } } }),
    );
    expect(view.missing).toEqual([]);
    expect(view.variables).toEqual([{ name: "A", source: "store", declared: false }]);
    expect(view.files).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(CANARY);
  });

  test("files: declared and present, set, missing, empty, unmanaged; their size to the owner alone", () => {
    const store: StoreState = {
      ...emptyStore,
      files: [
        { name: "gcp.json", kind: "managed", size: 2345, modifiedAt: T - 5000 },
        { name: "undeclared.pem", kind: "managed", size: 0, modifiedAt: T - 5000 },
        { name: "linked", kind: "unmanaged", reason: "symbolic link", modifiedAt: null },
      ],
    };
    const owner = storeView(input({ store }));
    expect(owner.files).toEqual([
      { name: "gcp.json", state: "set", declared: true, reason: null, bytes: 2345, modifiedAt: T - 5000, restartPending: false },
      { name: "tls.key", state: "missing", declared: true, reason: null, bytes: null, modifiedAt: null, restartPending: false },
      { name: "linked", state: "unmanaged", declared: false, reason: "symbolic link", bytes: null, modifiedAt: null, restartPending: false },
      { name: "undeclared.pem", state: "missing", declared: false, reason: "empty", bytes: 0, modifiedAt: T - 5000, restartPending: false },
    ]);
    const developer = storeView(input({ store, owner: false, may: storeMay({ kind: "person", restore: false }) }));
    expect(developer.files.map((file) => file.bytes)).toEqual([null, null, null, null]);
  });

  test("a restart is pending when the env or a file changed after the main service started; never for an anchor", () => {
    const store: StoreState = { ...emptyStore, env: { kind: "managed", values: new Map(), modifiedAt: T - 10 }, files: [{ name: "gcp.json", kind: "managed", size: 1, modifiedAt: T + 10 }] };
    expect(storeView(input({ store })).restartPending).toBe(true);
    expect(storeView(input({ store, startedUs: (T + 20) * 1000 })).restartPending).toBe(false);
    expect(storeView(input({ store, startedUs: null })).restartPending).toBe(false);
    expect(storeView(input({ store })).modifiedAt).toBe(T - 10);
  });

  test("the store's state, and its previous version told to whoever may restore it", () => {
    expect(storeView(input({ store: { ...emptyStore, exists: false } })).state).toBe("absent");
    expect(storeView(input({ store: { ...emptyStore, refusal: "/etc/sitesolide/projects/shop is a symbolic link" } }))).toMatchObject({
      state: "unmanaged",
      reason: "/etc/sitesolide/projects/shop is a symbolic link",
    });
    expect(storeView(input({ store: { ...emptyStore, env: { kind: "unmanaged", reason: "line 2: invalid variable name", modifiedAt: T } } }))).toMatchObject({
      state: "unmanaged",
      reason: "env: line 2: invalid variable name",
    });
    const kept = { ...emptyStore, previous: true };
    expect(storeView(input({ store: kept })).previous).toBe(true);
    expect(storeView(input({ store: kept, may: storeMay({ kind: "person", restore: true }), owner: false })).previous).toBe(true);
    expect(storeView(input({ store: kept, may: storeMay({ kind: "person", restore: false }), owner: false })).previous).toBe(false);
    expect(storeView(input({ store: kept, may: storeMay({ kind: "token", restore: false }), owner: false })).previous).toBe(false);
  });

  test("what may be done, by requester", () => {
    expect(storeMay({ kind: "owner", restore: true })).toEqual({ write: true, reveal: true, restore: true });
    expect(storeMay({ kind: "ssh", restore: true })).toEqual({ write: true, reveal: false, restore: true });
    expect(storeMay({ kind: "person", restore: true })).toEqual({ write: true, reveal: false, restore: true });
    expect(storeMay({ kind: "person", restore: false })).toEqual({ write: true, reveal: false, restore: false });
    expect(storeMay({ kind: "token", restore: true })).toEqual({ write: true, reveal: false, restore: false });
  });

});

/** A refusal is a value: never an exception, whatever is thrown at it. */
describe("never throws", () => {
  test("on what a compromised dashboard could send", () => {
    const odd: unknown[] = [undefined, null, {}, [], 0, true, "__proto__", "constructor", "\0", "é".repeat(200)];
    for (const value of odd) {
      expect(() => storeSlugRefusal(value, { requester: "token", creating: true, zone: ZONE, site: null })).not.toThrow();
      expect(() => storeNameRefusal("set", value, [])).not.toThrow();
      expect(() => fileNameRefusal(value)).not.toThrow();
      expect(() => decodeFileContent(value)).not.toThrow();
      expect(() => readGenerateAsk(value, value)).not.toThrow();
    }
    const refusal: Refusal | null = storeNameRefusal("set", "__proto__", []);
    expect(refusal).toBeNull();
  });
});
