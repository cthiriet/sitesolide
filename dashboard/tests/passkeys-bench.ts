/**
 * A steward with the owner's passkeys on a throwaway tree: the real routes,
 * the real registry and projection files, and a clock the tests move. The
 * passkey tests of the steward and of the dashboard's relay share it.
 */
import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPasskeySystem } from "../src/passkeys/system";
import { createSteward, type StewardHandler } from "../src/secrets/steward";
import { createSystem } from "../src/secrets/system";

export const ZONE = "test-zone.invalid";
export const DASHBOARD = `https://dashboard.${ZONE}`;
export const PASSWORD = "the dashboard's password, drawn at random";

const toClean: string[] = [];
afterEach(() => {
  for (const folder of toClean.splice(0)) rmSync(folder, { recursive: true, force: true });
});

export type Bench = {
  clock: { t: number };
  state: string;
  portal: string;
  call: (method: string, path: string, body?: unknown) => Promise<Response>;
  owner: (method: string, path: string, body?: unknown) => Promise<Response>;
  handler: StewardHandler;
};

export async function mount(): Promise<Bench> {
  const root = mkdtempSync(join(tmpdir(), "steward-passkeys-"));
  toClean.push(root);
  const [sites, secrets, units, state, caddy, gatekeeper, portal] = ["sites", "secrets", "units", "state", "caddy", "gatekeeper", "portal"].map((name) => join(root, name));
  for (const folder of [sites, secrets, units, state, caddy, gatekeeper, portal]) mkdirSync(folder!, { recursive: true });
  const hash = await Bun.password.hash(PASSWORD, { algorithm: "bcrypt", cost: 4 });
  writeFileSync(join(secrets!, "dashboard.env"), `PASSWORD_HASH=${hash}\n`, { mode: 0o600 });
  writeFileSync(join(root, "passwd"), "root:x:0:0:root:/root:/bin/sh\n");
  const clock = { t: 1_800_000_000_000 };
  const real = createSystem({
    sitesDir: sites!,
    secretsFolder: secrets!,
    unitsFolder: units!,
    stateFolder: state!,
    hashFile: join(secrets!, "dashboard.env"),
    accountsFile: join(root, "passwd"),
    caddyFolder: caddy!,
    gatekeeperFolder: gatekeeper!,
    codesFile: join(root, "locks-codes.json"),
    locksFragment: join(root, "verrous.caddy"),
    systemctl: "/path/that/does/not/exist",
  });
  const passkeySystem = createPasskeySystem({ stateFolder: state!, portalKeyFolder: portal!, groupsFile: join(root, "group"), portalGroup: "" });
  const handler = createSteward(
    { ...real, now: () => clock.t },
    { secretsFolder: secrets!, checkAccounts: false, passkeys: { system: { ...passkeySystem, now: () => clock.t }, zone: ZONE } },
  );
  await handler.startPasskeys();
  const request = (method: string, path: string, body?: unknown) => new Request(`http://steward${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return {
    clock,
    state: state!,
    portal: portal!,
    handler,
    call: (method, path, body) => handler(request(method, path, body)),
    owner: (method, path, body) => handler.owner(request(method, path, body)),
  };
}

export async function json<T = unknown>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
