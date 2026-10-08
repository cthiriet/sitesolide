/**
 * The steward's inputs and outputs for the members, and nothing else: the
 * registry, the sessions, the key pair, and what portal.env says of signing
 * in. An interface, so that the tests run the member routes on a throwaway
 * tree. The careful primitives, the bounded read and the atomic write, are
 * the secrets routes' own.
 *
 * Every file is root's but one: the portal's private key, which the steward
 * writes `root:site-portal 0640` into `/etc/sitesolide-portal`, a folder root
 * owns and the steward's unit makes writable. Nothing is written where the
 * portal or the dashboard could have laid a link: the atomic write creates
 * its temporary file with `O_EXCL | O_NOFOLLOW` and renames it onto the name.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanDomain, cleanEmail, readList } from "../../borrowed/sharing";
import { isValidSlug } from "../../borrowed/manifest";
import { envValue, parseEnvBytes } from "../secrets/envfile";
import { readBounded, readGroup, writeAtomically } from "../secrets/system";
import { PORTAL_KEY_NAME, PUBLIC_KEY_NAME } from "./protocol";

export type MembersSystemConfig = {
  /** /var/lib/sitesolide-steward */
  stateFolder: string;
  /** /srv/sites */
  sitesDir: string;
  /** /etc/sitesolide, where portal.env lives. */
  secretsFolder: string;
  /** /etc/sitesolide-portal */
  portalKeyFolder: string;
  /** /etc/group, to find the portal's group. */
  groupsFile: string;
  /**
   * The portal's group, `site-portal`. Empty: no `chown`, for the workstation,
   * where the account does not exist.
   */
  portalGroup: string;
};

/** What portal.env says of signing in with a provider. */
export type PortalSettings = { configured: boolean; allowedDomains: string[]; admins: string[]; providerName: string | null };

export type KeyWrite = "written" | "no-folder" | "no-group";

export type MembersSystem = {
  now: () => number;
  /** The registry's text, null when there is none. Throws when it is there but unreadable. */
  readRegistry: () => Promise<string | null>;
  writeRegistry: (text: string) => Promise<void>;
  /** The sessions' text, null when missing or unreadable: the book starts empty either way. */
  readBook: () => Promise<string | null>;
  writeBook: (text: string) => Promise<void>;
  readPublicKey: () => Promise<string | null>;
  writePublicKey: (text: string) => Promise<void>;
  readPortalKey: () => Promise<string | null>;
  /** Lays the portal's private key, unless its folder or its group is missing. */
  writePortalKey: (text: string) => Promise<KeyWrite>;
  readPortalSettings: () => Promise<PortalSettings>;
  /** Does the machine carry `/srv/sites/<slug>`? */
  projectExists: (slug: string) => boolean;
};

/** A registry, a book, a key: none of them has a reason to be bigger. */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENV_BYTES = 256 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const ROOT_ONLY = { owner: null, mode: 0o600 };

/** The text of a root file, null when absent; throws when it is there and cannot be read whole. */
function readRootFile(path: string): string | null {
  const examination = readBounded(path, MAX_FILE_BYTES);
  if (examination.kind === "absent") return null;
  if (examination.bytes === null) throw new Error(`${path} is not a plain file of a reasonable size`);
  return decoder.decode(examination.bytes);
}

/** The same, null when unreadable too. */
function readQuietly(path: string): string | null {
  try {
    return readRootFile(path);
  } catch {
    return null;
  }
}

/** The sign-in settings of portal.env, every value judged by the portal's own rules. */
export function portalSettings(bytes: Uint8Array | null): PortalSettings {
  const none: PortalSettings = { configured: false, allowedDomains: [], admins: [], providerName: null };
  if (bytes === null) return none;
  const parsed = parseEnvBytes(bytes);
  if (!parsed.ok) return none;
  const value = (name: string) => (envValue(parsed.document, name) ?? "").trim();
  return {
    configured: value("OIDC_ISSUER") !== "" && value("OIDC_CLIENT_ID") !== "" && value("OIDC_CLIENT_SECRET") !== "",
    allowedDomains: readList(value("OIDC_ALLOWED_DOMAINS"), cleanDomain).values,
    admins: readList(value("OIDC_ADMIN_EMAILS"), cleanEmail).values,
    // The name the button carries, when one is set; the portal names Google
    // and Microsoft from their issuer otherwise.
    providerName: /^[\x20-\x7e]{1,60}$/.test(value("OIDC_PROVIDER_NAME")) ? value("OIDC_PROVIDER_NAME") : /accounts\.google\.com/.test(value("OIDC_ISSUER")) ? "Google" : /login\.microsoftonline\.com/.test(value("OIDC_ISSUER")) ? "Microsoft" : null,
  };
}

export function createMembersSystem(config: MembersSystemConfig): MembersSystem {
  const registryFile = join(config.stateFolder, "members.json");
  const bookFile = join(config.stateFolder, "member-sessions.json");
  const publicFile = join(config.stateFolder, PUBLIC_KEY_NAME);
  const portalKeyFile = join(config.portalKeyFolder, PORTAL_KEY_NAME);
  const prepare = () => mkdirSync(config.stateFolder, { recursive: true, mode: 0o700 });

  return {
    now: () => Date.now(),

    readRegistry: async () => readRootFile(registryFile),
    async writeRegistry(text) {
      prepare();
      writeAtomically(config.stateFolder, "members.json", encoder.encode(text), ROOT_ONLY);
    },

    readBook: async () => readQuietly(bookFile),
    async writeBook(text) {
      prepare();
      writeAtomically(config.stateFolder, "member-sessions.json", encoder.encode(text), ROOT_ONLY);
    },

    readPublicKey: async () => readQuietly(publicFile),
    async writePublicKey(text) {
      prepare();
      writeAtomically(config.stateFolder, PUBLIC_KEY_NAME, encoder.encode(text), ROOT_ONLY);
    },

    readPortalKey: async () => readQuietly(portalKeyFile),
    async writePortalKey(text) {
      // The folder is bin/deploy-steward.sh's: a link or anything but a folder
      // of root's there, and nothing is written.
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
      writeAtomically(config.portalKeyFolder, PORTAL_KEY_NAME, encoder.encode(text), { owner, mode: 0o640 });
      return "written";
    },

    async readPortalSettings() {
      const examination = readBounded(join(config.secretsFolder, "portal.env"), MAX_ENV_BYTES);
      return portalSettings(examination.kind === "present" ? examination.bytes : null);
    },

    projectExists(slug) {
      return isValidSlug(slug) && existsSync(join(config.sitesDir, slug));
    },
  };
}
