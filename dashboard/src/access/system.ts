/**
 * The access registry's inputs and outputs: the registry itself and the
 * portal's projection in the portal's folder. An interface, so that the
 * tests run the routes on a throwaway tree. The careful primitives, the
 * bounded read and the atomic write, are the secrets routes' own.
 *
 * Every file is root's but what is laid for the portal, which the steward
 * writes `root:site-portal 0640` into `/etc/sitesolide-portal`, a folder root
 * owns and the steward's unit makes writable. Nothing is written where the
 * portal or the dashboard could have laid a link: the atomic write creates
 * its temporary file with `O_EXCL | O_NOFOLLOW` and renames it onto the name.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECTION_NAME } from "../../borrowed/access";
import { isValidSlug } from "../../borrowed/manifest";
import { readBounded, readGroup, writeAtomically } from "../secrets/system";
import { REGISTRY_MAX_BYTES, REGISTRY_NAME } from "./protocol";

/** Where the portal reads what the steward lays for it. */
export type PortalFolderConfig = {
  /** /etc/sitesolide-portal */
  portalKeyFolder: string;
  /** /etc/group, to find the portal's group. */
  groupsFile: string;
  /** `site-portal`; empty, no `chown`, for the workstation, where the account does not exist. */
  portalGroup: string;
};

export type AccessSystemConfig = PortalFolderConfig & {
  /** /var/lib/sitesolide-steward */
  stateFolder: string;
  /** /srv/sites */
  sitesDir: string;
};

/** A file laid for the portal, or why not: its folder or its group missing. */
export type PortalWrite = "written" | "no-folder" | "no-group";

export type AccessSystem = {
  now: () => number;
  /** The projection's identity as it lies, inode, size and times; null when it is not there. */
  projectionStamp: () => string | null;
  /** The registry's text, null when there is none yet. Throws when it is there but cannot be read whole. */
  readRegistry: () => Promise<string | null>;
  writeRegistry: (text: string) => Promise<void>;
  /** Lays the portal's projection, unless its folder or the portal's group is missing. */
  writeProjection: (text: string) => Promise<PortalWrite>;
  /** Does the machine carry `/srv/sites/<slug>`? */
  projectExists: (slug: string) => boolean;
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

/**
 * A file laid for the portal in its folder, the access projection or the
 * passkeys': `root:<portal group> 0640`, root writing it, the portal's
 * account reading it, the dashboard's not. The folder is
 * bin/deploy-steward.sh's: a link or anything but a folder there, or no
 * portal group yet, and nothing is written.
 */
export function layForPortal(config: PortalFolderConfig, name: string, text: string): PortalWrite {
  try {
    const folder = lstatSync(config.portalKeyFolder);
    if (!folder.isDirectory() || folder.isSymbolicLink()) return "no-folder";
  } catch {
    return "no-folder";
  }
  let owner: { uid: number; gid: number } | null = null;
  if (config.portalGroup !== "") {
    let gid: number | null = null;
    try {
      gid = readGroup(readFileSync(config.groupsFile, "utf8"), config.portalGroup);
    } catch {
      gid = null;
    }
    if (gid === null) return "no-group";
    owner = { uid: 0, gid };
  }
  writeAtomically(config.portalKeyFolder, name, encoder.encode(text), { owner, mode: 0o640 });
  return "written";
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

    projectExists(slug) {
      return isValidSlug(slug) && existsSync(join(config.sitesDir, slug));
    },
  };
}
