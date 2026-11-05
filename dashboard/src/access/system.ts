/**
 * The access registry's inputs and outputs: the registry itself and the
 * portal's projection beside the assertion key. An interface, so that the
 * tests run the routes on a throwaway tree.
 */
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PROJECTION_NAME } from "../../borrowed/access";
import { layForPortal, type PortalWrite } from "../people/system";
import { readBounded, writeAtomically } from "../secrets/system";
import { REGISTRY_MAX_BYTES, REGISTRY_NAME } from "./protocol";

export type AccessSystemConfig = {
  /** /var/lib/sitesolide-steward */
  stateFolder: string;
  /** /etc/sitesolide-portal, where the projection lies beside the assertion key. */
  portalKeyFolder: string;
  /** /etc/group, to find the portal's group. */
  groupsFile: string;
  /** `site-portal`; empty, no `chown`, for the workstation. */
  portalGroup: string;
};

export type AccessSystem = {
  now: () => number;
  /** The projection's identity as it lies, inode, size and times; null when it is not there. */
  projectionStamp: () => string | null;
  /** The registry's text, null when there is none yet. Throws when it is there but cannot be read whole. */
  readRegistry: () => Promise<string | null>;
  writeRegistry: (text: string) => Promise<void>;
  /** Lays the portal's projection, unless its folder or the portal's group is missing. */
  writeProjection: (text: string) => Promise<PortalWrite>;
};

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const ROOT_ONLY = { owner: null, mode: 0o600 };

function readRootFile(path: string, max: number): string | null {
  const examination = readBounded(path, max);
  if (examination.kind === "absent") return null;
  if (examination.bytes === null) throw new Error(`${path} is not a plain file of a reasonable size`);
  return decoder.decode(examination.bytes);
}

export function createAccessSystem(config: AccessSystemConfig): AccessSystem {
  const registryFile = join(config.stateFolder, REGISTRY_NAME);
  const prepare = () => mkdirSync(config.stateFolder, { recursive: true, mode: 0o700 });

  const projectionFile = join(config.portalKeyFolder, PROJECTION_NAME);

  return {
    now: () => Date.now(),

    projectionStamp() {
      try {
        const info = lstatSync(projectionFile);
        return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      } catch {
        return null;
      }
    },

    readRegistry: async () => readRootFile(registryFile, REGISTRY_MAX_BYTES),
    async writeRegistry(text) {
      prepare();
      writeAtomically(config.stateFolder, REGISTRY_NAME, encoder.encode(text), ROOT_ONLY);
    },

    writeProjection: async (text) => layForPortal(config, PROJECTION_NAME, text),
  };
}
