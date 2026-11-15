/**
 * The steward's inputs and outputs for the owner's passkeys: the registry,
 * root's alone in its state folder, and the projection laid for the portal.
 * An interface, so that the tests run the passkey routes on a throwaway tree.
 *
 * The careful primitives are the secrets routes' own: a bounded read that
 * follows no link, and an atomic write whose temporary file is created with
 * `O_EXCL | O_NOFOLLOW`. The projection goes where the access projection
 * goes, `root:site-portal 0640` in `/etc/sitesolide-portal`
 * (src/access/system.ts, `layForPortal`).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PASSKEYS_NAME } from "../../borrowed/passkeys";
import { layForPortal, type PortalFolderConfig, type PortalWrite } from "../access/system";
import { readBounded, writeAtomically } from "../secrets/system";
import { REGISTRY_MAX_BYTES, REGISTRY_NAME } from "./registry";

export type PasskeySystemConfig = PortalFolderConfig & { stateFolder: string };

/** The registry's text: null when there is none yet, `unreadable` when one is there and cannot be read whole. */
export type RegistryText = string | null | "unreadable";

export type PasskeySystem = {
  now: () => number;
  readRegistry: () => Promise<RegistryText>;
  writeRegistry: (text: string) => Promise<void>;
  /** Lays the projection for the portal, unless its folder or its group is missing. */
  writeProjection: (text: string) => Promise<PortalWrite>;
};

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export function createPasskeySystem(config: PasskeySystemConfig): PasskeySystem {
  const file = join(config.stateFolder, REGISTRY_NAME);
  return {
    now: () => Date.now(),

    async readRegistry() {
      try {
        const examination = readBounded(file, REGISTRY_MAX_BYTES);
        if (examination.kind === "absent") return null;
        return examination.bytes === null ? "unreadable" : decoder.decode(examination.bytes);
      } catch {
        return "unreadable";
      }
    },

    async writeRegistry(text) {
      mkdirSync(config.stateFolder, { recursive: true, mode: 0o700 });
      writeAtomically(config.stateFolder, REGISTRY_NAME, encoder.encode(text), { owner: null, mode: 0o600 });
    },

    writeProjection: async (text) => layForPortal(config, PASSKEYS_NAME, text),
  };
}
