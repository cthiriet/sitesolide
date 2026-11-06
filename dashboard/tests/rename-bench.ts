/**
 * The bench of the runs that change a project as a whole, a rename, turning
 * it off, on, removing it: the installer's bench, a project deployed on it
 * for real by the pipeline, and `usermod`, `groupmod` standing in as scripts
 * that edit the bench's passwd and group.
 */
import { afterEach, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstallRequest, Scope } from "../src/control/protocol";
import { runPipeline } from "../src/installer/pipeline";
import { createRenameHost } from "../src/installer/rename-host";
import { commandsOf, createBench as newBench, file, hostOf, stageBundle, ZONE, type Bench, type BenchOptions } from "./installer-bench";

export const DEPLOYMENT = "0123456789abcdef01234567";
export const NOW = Date.now();
export const PUBLIC: Scope = { slugs: [], create: true, outbound: false, domain: true, public: true };
export const APP = { slug: "nis2", port: 3035, start: "/usr/local/bin/bun run server.ts", publicDir: "public", secrets: ["STRIPE_SECRET_KEY"] };
export const FILES = [file("app/server.ts", "Bun.serve({})"), file("public/index.html", "<h1>nis2</h1>")];

const benches: Bench[] = [];
afterEach(() => {
  for (const bench of benches.splice(0)) bench.cleanup();
});

/** The bench, with the scripts usermod and groupmod become. */
export function createBench(options: BenchOptions = {}): Bench {
  const bench = newBench(options);
  benches.push(bench);
  writeFileSync(join(bench.root, "group"), "root:x:0:\n");
  // The new name second, the old one last, `-d <home>` between them for an account whose home follows.
  const edit = (file: string) =>
    `#!/bin/sh\nset -e\nNEW="$2"\nfor OLD in "$@"; do :; done\ngrep -q "^$OLD:" "${join(bench.root, file)}" || { echo "no such account $OLD" >&2; exit 6; }\nsed -i.bak "s#^$OLD:#$NEW:#" "${join(bench.root, file)}"\n[ "$3" = "-d" ] && sed -i.bak "s#^\\($NEW:[^:]*:[^:]*:[^:]*:[^:]*:\\)[^:]*#\\1$4#" "${join(bench.root, file)}"\nexit 0\n`;
  writeFileSync(join(bench.root, "stubs", "usermod"), edit("passwd"), { mode: 0o755 });
  writeFileSync(join(bench.root, "stubs", "groupmod"), edit("group"), { mode: 0o755 });
  return bench;
}

export async function deploy(bench: Bench, manifest: object = APP): Promise<void> {
  stageBundle(bench, DEPLOYMENT, FILES);
  const request: InstallRequest = {
    deployment: DEPLOYMENT,
    slug: (manifest as { slug: string }).slug,
    requestedAt: NOW,
    token: { id: "aaaaaaaaaaaa", email: "ada@test-zone.invalid", member: null },
    scope: PUBLIC,
    creating: true,
    manifest: JSON.stringify(manifest),
  };
  const outcome = await runPipeline(hostOf(bench), request, { zone: ZONE, runFolder: bench.run });
  expect(outcome.ok).toBe(true);
  // The group useradd would have made beside the account.
  writeFileSync(join(bench.root, "group"), `${readFileSync(join(bench.root, "group"), "utf8")}site-${request.slug}:x:2000:\n`);
  bench.events.length = 0;
}

export function renameHost(bench: Bench) {
  const installer = hostOf(bench);
  return createRenameHost({
    installer,
    sitesDir: bench.sites,
    secretsFolder: bench.secrets,
    storePreviousFolder: bench.previous,
    accountsFile: join(bench.root, "passwd"),
    domainTableFile: join(bench.root, "domaines.map"),
    usermod: join(bench.root, "stubs", "usermod"),
    groupmod: join(bench.root, "stubs", "groupmod"),
    systemctl: commandsOf(bench).systemctl,
  });
}

