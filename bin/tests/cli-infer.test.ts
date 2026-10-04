import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUN, inferManifest, renderManifest, slugFromFolder, UV, type Inference } from "../cli/infer";
import { KNOWN_KEYS, validate, type Manifest } from "../cli/manifest";
import { needsPort } from "../cli/ports";

/**
 * What `sitesolide detect` infers from a folder, over the fixtures of
 * bin/tests/infer/ and the fixtures of the end-to-end tests that already stand
 * for a shape met for real.
 *
 * Two promises are held on every one of them: the manifest passes validate()
 * once deploy has given an app its port, and nothing is decided that the
 * folder does not say, the network and the secrets above all.
 */
const FIXTURES = join(import.meta.dir, "infer");
const E2E = join(import.meta.dir, "e2e", "projects");

const temporary: string[] = [];
afterEach(() => {
  for (const folder of temporary.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A copy of a fixture, for the tests that add what git would not keep, a .env. */
function copy(fixture: string): string {
  const folder = mkdtempSync(join(tmpdir(), "infer-"));
  temporary.push(folder);
  cpSync(fixture, folder, { recursive: true });
  return folder;
}

/** The inference, which must have recognised something. */
function inferred(folder: string, slug: string): Extract<Inference, { manifest: Manifest }> {
  const inference = inferManifest(folder, slug);
  if (inference.kind === "none") throw new Error(`nothing inferred: ${inference.reasons.join("; ")}`);
  return inference;
}

/** validate() as deploy will run it: an app with the port deploy is about to give it. */
function deployable(manifest: Manifest): string[] {
  return validate(needsPort(manifest) ? { ...manifest, port: 3042 } : manifest, "");
}

describe("the slug, from the folder's name", () => {
  test("lowercase, every other run of characters a dash, the ends trimmed", () => {
    expect(slugFromFolder("My Shop")).toBe("my-shop");
    expect(slugFromFolder("api_v2")).toBe("api-v2");
    expect(slugFromFolder("--Notes--")).toBe("notes");
    expect(slugFromFolder("shop.example.com")).toBe("shop-example-com");
  });

  test("accents are dropped rather than turned into dashes", () => {
    // Data, not prose: the accented name is what the test is about.
    expect(slugFromFolder("Ångström Über")).toBe("angstrom-uber");
  });

  test("63 characters at most, never ending on a dash once cut", () => {
    const slug = slugFromFolder(`${"a".repeat(62)}-b`)!;
    expect(slug).toBe("a".repeat(62));
    expect(slug.length).toBeLessThanOrEqual(63);
  });

  test("nothing usable, or the reserved landing, gives no slug", () => {
    expect(slugFromFolder("___")).toBeNull();
    expect(slugFromFolder("日本")).toBeNull();
    expect(slugFromFolder("Landing")).toBeNull();
  });

  test("nor a folder named after a service of the machine, which deploy would replace", () => {
    for (const name of ["caddy", "SSH", "www", "systemd-resolved", "sitesolide-gatekeeper"]) expect(slugFromFolder(name)).toBeNull();
    expect(slugFromFolder("caddy-notes")).toBe("caddy-notes");
  });
});

describe("a folder of files", () => {
  test("public/ with an index.html is served as it is", () => {
    const { kind, manifest } = inferred(join(FIXTURES, "static-public"), "folder");
    expect(kind).toBe("static");
    expect(manifest).toEqual({ slug: "folder", publicDir: "public" });
  });

  test("a public/ holding .git or a .env says they are never sent nor served", () => {
    const folder = copy(join(FIXTURES, "static-public"));
    mkdirSync(join(folder, "public", ".git"));
    writeFileSync(join(folder, "public", ".git", "config"), "[remote]");
    mkdirSync(join(folder, "public", "admin"));
    writeFileSync(join(folder, "public", "admin", ".env.production"), "SECRET=1");
    const { manifest, notes } = inferred(folder, "folder");
    expect(manifest).toEqual({ slug: "folder", publicDir: "public" });
    expect(notes).toContain("public/.git, public/admin/.env.production are never sent nor served: .git and .env files stay on this workstation");
  });

  test("a .env deeper in an app's code stays on the workstation too, and says so", () => {
    const folder = copy(join(FIXTURES, "bun-app"));
    mkdirSync(join(folder, "config"));
    writeFileSync(join(folder, "config", ".env.production"), "SECRET=1");
    const { manifest, notes } = inferred(folder, "bun-app");
    expect(manifest.exclude).toEqual(["node_modules", ".env*"]);
    expect(notes.join("\n")).toContain("config/.env.production stays on this workstation");
  });

  test("dist/ is found when public/ is absent", () => {
    expect(inferred(join(FIXTURES, "static-dist"), "built").manifest).toEqual({ slug: "built", publicDir: "dist" });
  });

  test("the repository's own example deploys as it is declared", () => {
    const { manifest } = inferred(join(import.meta.dir, "..", "..", "examples", "static-site"), "static-site");
    expect(manifest.publicDir).toBe("public");
  });

  test("an index.html at the root is recognised and refused: the root would serve .git with it", () => {
    const inference = inferManifest(join(FIXTURES, "root-index"), "root");
    expect(inference.kind).toBe("none");
    expect(inference.reasons.join(" ")).toContain(".git");
    expect(inference.reasons.join(" ")).toContain("move the site into public/");
  });

  test("a folder with nothing to deploy says what was looked for", () => {
    const inference = inferManifest(join(FIXTURES, "nothing"), "nothing");
    expect(inference.kind).toBe("none");
    expect(inference.reasons[0]).toContain("package.json");
  });
});

describe("a site a generator builds", () => {
  test("Vite: the build of the lockfile's manager, into dist/", () => {
    const { kind, manifest, notes } = inferred(join(FIXTURES, "vite-site"), "vite-site");
    expect(kind).toBe("static-build");
    expect(manifest).toEqual({ slug: "vite-site", description: "A Vite site, built into dist/", publicDir: "dist", build: "npm run build" });
    expect(notes.join(" ")).toContain("runs on this workstation");
  });

  test("Astro's start script is its development server: the site is still a folder of files", () => {
    const { kind, manifest } = inferred(join(FIXTURES, "astro-site"), "astro-site");
    expect(kind).toBe("static-build");
    expect(manifest.publicDir).toBe("dist");
    expect(manifest.start).toBeUndefined();
  });

  test("a build script and no generator: the folder of files already there is the one served", () => {
    const folder = copy(join(FIXTURES, "static-public"));
    writeFileSync(join(folder, "package.json"), JSON.stringify({ scripts: { build: "tailwindcss -o public/style.css" } }));
    const { kind, manifest, notes } = inferred(folder, "styled");
    expect(kind).toBe("static-build");
    expect(manifest).toEqual({ slug: "styled", publicDir: "public", build: "bun run build" });
    expect(notes.join(" ")).not.toContain("guess");
  });
});

describe("an app run by Bun", () => {
  test("a Bun server: run by the machine's Bun, its public/ served by Caddy, its dependencies installed there", () => {
    const { kind, manifest } = inferred(join(FIXTURES, "bun-app"), "bun-app");
    expect(kind).toBe("bun");
    expect(manifest).toEqual({
      slug: "bun-app",
      publicDir: "public",
      install: `${BUN} install --production`,
      start: `${BUN} run server.ts`,
      env: { NODE_ENV: "production" },
      exclude: ["node_modules"],
    });
  });

  test("scripts the install runs on the server, the package's own and its trusted dependencies', are said", () => {
    expect(inferred(join(FIXTURES, "bun-app"), "bun-app").notes.join(" ")).not.toContain("on the server, as the project's account");
    const folder = copy(join(FIXTURES, "bun-app"));
    const pkg = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"));
    writeFileSync(join(folder, "package.json"), JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, postinstall: "node fetch.js", prepare: "husky" }, trustedDependencies: ["sharp"] }));
    const notes = inferred(folder, "bun-app").notes.join("\n");
    expect(notes).toContain("package.json declares postinstall, prepare: the install runs them on the server, as the project's account, with the network");
    expect(notes).toContain("trustedDependencies lets sharp run their install scripts on the server");
  });

  test("no port: deploy chooses it on the server", () => {
    const { manifest, notes } = inferred(join(FIXTURES, "bun-app"), "bun-app");
    expect(manifest.port).toBeUndefined();
    expect(needsPort(manifest)).toBe(true);
    expect(notes.join(" ")).toContain("deploy picks a free one");
    // The code reads PORT: no note asking it to.
    expect(notes.join(" ")).not.toContain("does not seem to read PORT");
  });

  test("a variable that is not a secret is pointed at env, never filled in", () => {
    const { manifest, notes } = inferred(join(FIXTURES, "bun-app"), "bun-app");
    expect(notes.join(" ")).toContain("PUBLIC_URL");
    expect(manifest.env).toEqual({ NODE_ENV: "production" });
  });

  test("the repository's example Bun app", () => {
    const { kind, manifest } = inferred(join(import.meta.dir, "..", "..", "examples", "bun-app"), "bun-app");
    expect(kind).toBe("bun");
    expect(manifest.start).toBe(`${BUN} run server.ts`);
    expect(manifest.publicDir).toBe("public");
  });

  test("a server file alone, no package.json: Bun runs it as it is, nothing to install", () => {
    const { kind, manifest, notes } = inferred(join(E2E, "api-with-secret"), "sample-secret");
    expect(kind).toBe("bun");
    expect(manifest).toEqual({
      slug: "sample-secret",
      start: `${BUN} run server.ts`,
      env: { NODE_ENV: "production" },
      exclude: ["node_modules"],
    });
    expect(notes.find((line) => line.includes("API_KEY"))).toContain('"secrets": ["sample-secret.env"]');
  });

  test("a Node server runs under Bun, the runtime the machine carries, from the file its start script names", () => {
    const { kind, manifest, notes } = inferred(join(FIXTURES, "node-express"), "shop");
    expect(kind).toBe("node");
    expect(manifest.start).toBe(`${BUN} run server.js`);
    expect(manifest.description).toBe("An Express server that charges cards");
    expect(notes.join(" ")).toContain("runs under Bun");
  });
});

describe("what the code says, and what is never decided for it", () => {
  test("a call out is pointed at, network stays closed", () => {
    const { manifest, notes } = inferred(join(FIXTURES, "node-express"), "shop");
    expect(manifest.network).toBeUndefined();
    const note = notes.find((line) => line.includes('"network": "outbound"'));
    expect(note).toBeDefined();
    expect(note).toContain("server.js:");
  });

  test("a secret read by the code is pointed at the dashboard, never declared nor filled in", () => {
    const { manifest, notes } = inferred(join(FIXTURES, "node-express"), "shop");
    expect(manifest.secrets).toBeUndefined();
    const note = notes.find((line) => line.includes("STRIPE_SECRET_KEY"));
    expect(note).toContain('"secrets": ["shop.env"]');
    expect(note).toContain("dashboard");
    // What is not a secret is told apart.
    expect(notes.find((line) => line.includes("CHECKOUT_MODE"))).toContain('"env"');
  });

  test("a .env never leaves the workstation", () => {
    const folder = copy(join(FIXTURES, "bun-app"));
    writeFileSync(join(folder, ".env"), "TOKEN=generated-by-the-test\n");
    writeFileSync(join(folder, ".env.local"), "OTHER=generated-by-the-test\n");
    const { manifest, notes } = inferred(folder, "bun-app");
    expect(manifest.exclude).toEqual(["node_modules", ".env*"]);
    expect(notes.join(" ")).toContain(".env, .env.local stay on this workstation");
  });

  test("the code's dependencies are not read as the code", () => {
    const folder = copy(join(FIXTURES, "bun-app"));
    mkdirSync(join(folder, "node_modules", "sdk"), { recursive: true });
    writeFileSync(join(folder, "node_modules", "sdk", "index.js"), 'fetch("https://api.example.com"); process.env.SDK_TOKEN;\n');
    const { notes } = inferred(folder, "bun-app");
    expect(notes.join(" ")).not.toContain("SDK_TOKEN");
    expect(notes.join(" ")).not.toContain('"network"');
  });
});

describe("a Python app", () => {
  test("FastAPI with uv: the module and the object found in the code, the port from systemd", () => {
    const { kind, manifest, reasons } = inferred(join(E2E, "fastapi-app"), "sample-api");
    expect(kind).toBe("python");
    expect(manifest.start).toBe(
      "/srv/sites/sample-api/app/.venv/bin/python -m uvicorn app.main:api --host 127.0.0.1 --port ${PORT}",
    );
    expect(manifest.install).toBe(`${UV} sync --frozen --no-dev --compile-bytecode --python-preference only-system`);
    expect(manifest.exclude).toEqual([".venv", "__pycache__"]);
    expect(manifest.description).toBe("Sample API deployed on sitesolide");
    expect(reasons).toContain("app.main:api in app/main.py");
  });

  test("Flask with gunicorn, from requirements.txt", () => {
    const { manifest, notes } = inferred(join(FIXTURES, "flask-app"), "flask-app");
    expect(manifest.start).toBe("/srv/sites/flask-app/app/.venv/bin/python -m gunicorn --bind 127.0.0.1:${PORT} app:app");
    expect(manifest.install).toContain("-r requirements.txt");
    expect(notes.find((line) => line.includes("DATABASE_URL"))).toContain("secrets");
    expect(notes.find((line) => line.includes('"network": "outbound"'))).toContain("app.py:");
  });

  test("Flask without gunicorn gets its development server, and says so", () => {
    const folder = copy(join(FIXTURES, "flask-app"));
    writeFileSync(join(folder, "requirements.txt"), "flask\n");
    const { manifest, notes } = inferred(folder, "flask-app");
    expect(manifest.start).toContain("-m flask --app app:app run --host 127.0.0.1 --port ${PORT}");
    expect(notes.join(" ")).toContain("development server");
  });

  test("a framework that is not inferred is refused, with what to do", () => {
    const inference = inferManifest(join(FIXTURES, "django-app"), "django-app");
    expect(inference.kind).toBe("none");
    expect(inference.reasons[0]).toContain("FastAPI or Flask");
  });
});

describe("a Go app", () => {
  test("cross-compiled on the workstation for the server, the binary started from app/", () => {
    const { kind, manifest } = inferred(join(FIXTURES, "go-service"), "shop");
    expect(kind).toBe("go");
    expect(manifest).toEqual({
      slug: "shop",
      publicDir: "public",
      build: "CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o shop .",
      start: "/srv/sites/shop/app/shop",
    });
  });

  test("a main package under cmd/, and a server that ignores PORT, which is said", () => {
    const { manifest, notes } = inferred(join(FIXTURES, "go-cmd"), "api");
    expect(manifest.build).toBe("CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o api ./cmd/server");
    expect(notes.join(" ")).toContain("does not seem to read PORT");
  });
});

describe("a name that would go into a command", () => {
  // A folder or a file name is the folder's own text, and the build runs in a
  // shell on the workstation that holds root SSH to the machine.
  const unsafe = "$(touch pwned)";

  test("a Go command under cmd/ is declined, never put into go build", () => {
    const folder = copy(join(FIXTURES, "go-cmd"));
    cpSync(join(folder, "cmd", "server"), join(folder, "cmd", unsafe), { recursive: true });
    rmSync(join(folder, "cmd", "server"), { recursive: true });
    const inference = inferManifest(folder, "go-cmd");
    expect(inference.kind).toBe("none");
    expect(inference.reasons.join(" ")).toContain("would go into a command");
    expect(JSON.stringify(inference)).not.toContain("go build");
  });

  test("a Python module in such a folder, and a server file named so, likewise", () => {
    const python = copy(join(FIXTURES, "flask-app"));
    mkdirSync(join(python, unsafe));
    cpSync(join(python, "app.py"), join(python, unsafe, "app.py"));
    rmSync(join(python, "app.py"));
    expect(inferManifest(python, "flask-app")).toMatchObject({ kind: "none", reasons: [expect.stringContaining("would go into a command")] });

    const javascript = copy(join(FIXTURES, "bun-app"));
    const pkg = JSON.parse(readFileSync(join(javascript, "package.json"), "utf8"));
    cpSync(join(javascript, "server.ts"), join(javascript, "a;b.ts"));
    rmSync(join(javascript, "server.ts"));
    writeFileSync(join(javascript, "package.json"), JSON.stringify({ ...pkg, main: "a;b.ts" }));
    // With its public/, the folder still reads as the files it serves; without, as nothing.
    expect(inferManifest(javascript, "bun-app")).toMatchObject({ kind: "static", manifest: { publicDir: "public" } });
    rmSync(join(javascript, "public"), { recursive: true });
    expect(inferManifest(javascript, "bun-app")).toMatchObject({ kind: "none", reasons: [expect.stringContaining("would go into a command")] });
  });
});

describe("every inferred manifest", () => {
  const folders = [
    ...["static-public", "static-dist", "vite-site", "astro-site", "bun-app", "node-express", "flask-app", "go-service", "go-cmd"].map((name) =>
      join(FIXTURES, name),
    ),
    ...["fastapi-app", "simple-site", "bun-mixed", "api-with-secret"].map((name) => join(E2E, name)),
  ];

  for (const folder of folders) {
    test(`passes validate() once deploy has given it its port: ${folder.split("/").slice(-2).join("/")}`, () => {
      const { manifest } = inferred(folder, "inferred");
      expect(deployable(manifest)).toEqual([]);
      // Never a key the CLI would refuse as a typo, never a guessed secret or network.
      expect(Object.keys(manifest).every((key) => KNOWN_KEYS.includes(key))).toBe(true);
      expect(manifest.secrets).toBeUndefined();
      expect(manifest.network).toBeUndefined();
    });
  }
});

describe("the manifest written", () => {
  test("keys in the documented order, two spaces, a final line break", () => {
    const text = renderManifest({ exclude: ["node_modules"], start: "/usr/local/bin/bun run server.ts", slug: "shop", publicDir: "public" });
    expect(text).toBe(
      '{\n  "slug": "shop",\n  "publicDir": "public",\n  "start": "/usr/local/bin/bun run server.ts",\n  "exclude": [\n    "node_modules"\n  ]\n}\n',
    );
  });
});
