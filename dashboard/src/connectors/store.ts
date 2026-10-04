/**
 * The connectors' two files on the machine, as the steward reads and writes
 * them: /etc/sitesolide-egress/connectors.json and grants.json.
 *
 * The same inputs and outputs as the secrets (src/secrets/system.ts), and the
 * same guarantees: a file is read without following a link and judged on its
 * owner and mode before its content, and written whole through a temporary file
 * and a rename, its owner and mode set before the first byte. The owner is
 * root and the group the proxy's, `root:sitesolide-egress 0640`: the proxy
 * reads, nobody else does, and only root rewrites. Root owns the folder, so
 * creating and renaming there needs no capability the steward does not have.
 *
 * A file that is there but not in that form is not rewritten: the page says
 * why, and the repair is made by hand, as for an unmanaged secret.
 */
import { lstatSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_FILE_MODE,
  CONNECTORS_FILE,
  GRANTS_FILE,
  parseConnectors,
  parseGrants,
  serializeConnectors,
  serializeGrants,
  type ConnectorsFile,
  type GrantsFile,
} from "../../borrowed/connectors";
import { isTemporary, readBounded, writeAtomically } from "../secrets/system";

/** No file of ours has a reason to be bigger. */
const MAX_FILE_BYTES = 1024 * 1024;

export type StoreConfig = {
  /** `/etc/sitesolide-egress`. */
  folder: string;
  /**
   * Root's uid, checked on the folder and the files, and the proxy's group,
   * given to the files and read on every call: the proxy may be installed
   * after the steward started. Null on the workstation, where those accounts
   * do not exist: neither check nor chown.
   */
  owners: { rootUid: number; gid: () => number | null } | null;
};

export type StoreReading =
  | { kind: "absent" }
  | { kind: "unmanaged"; reason: string }
  | { kind: "managed"; connectors: ConnectorsFile; grants: GrantsFile };

export type ConnectorStore = {
  read: () => StoreReading;
  /** Replaces what is given, leaves what is null as it is. */
  write: (connectors: ConnectorsFile | null, grants: GrantsFile | null) => void;
  /** The temporary files an abrupt stop left in the folder, removed. Returns their number. */
  clean: () => number;
};

const octal = (mode: number) => mode.toString(8).padStart(4, "0");

type Owners = { rootUid: number; gid: number } | null;

export function createConnectorStore(config: StoreConfig): ConnectorStore {
  /** The accounts to check and hand over; "absent" while the proxy's group does not exist. */
  function owners(): Owners | "absent" {
    if (config.owners === null) return null;
    const gid = config.owners.gid();
    return gid === null ? "absent" : { rootUid: config.owners.rootUid, gid };
  }

  function folderReason(accounts: Owners): string | null | "absent" {
    let stat;
    try {
      stat = lstatSync(config.folder);
    } catch {
      return "absent";
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return `${config.folder} is not a plain folder`;
    if (accounts !== null && stat.uid !== accounts.rootUid) return `${config.folder} is owned by uid ${stat.uid}, expected root`;
    if ((stat.mode & 0o022) !== 0) return `${config.folder} is ${octal(stat.mode & 0o7777)}, writable beyond root`;
    return null;
  }

  function readFile(name: string, accounts: Owners): { text: string } | { reason: string } {
    const examination = readBounded(join(config.folder, name), MAX_FILE_BYTES);
    if (examination.kind === "absent") return { text: "" };
    const { info, bytes } = examination;
    if (info.link || !info.regular || info.links > 1) return { reason: `${name} is not a plain file` };
    if (accounts !== null) {
      if (info.uid !== accounts.rootUid) return { reason: `${name} is owned by uid ${info.uid}, expected root` };
      if (info.gid !== accounts.gid) return { reason: `${name} has group ${info.gid}, expected the egress proxy's` };
      if (info.mode !== CONFIG_FILE_MODE) return { reason: `${name} is ${octal(info.mode)}, expected ${octal(CONFIG_FILE_MODE)}` };
    }
    if (bytes === null) return { reason: `${name} could not be read` };
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch {
      return { reason: `${name} is not UTF-8` };
    }
  }

  return {
    read() {
      const accounts = owners();
      if (accounts === "absent") return { kind: "absent" };
      const folder = folderReason(accounts);
      if (folder === "absent") return { kind: "absent" };
      if (folder !== null) return { kind: "unmanaged", reason: folder };
      const connectorsText = readFile(CONNECTORS_FILE, accounts);
      if ("reason" in connectorsText) return { kind: "unmanaged", reason: connectorsText.reason };
      const grantsText = readFile(GRANTS_FILE, accounts);
      if ("reason" in grantsText) return { kind: "unmanaged", reason: grantsText.reason };
      const connectors = parseConnectors(connectorsText.text);
      if ("error" in connectors) return { kind: "unmanaged", reason: connectors.error };
      const grants = parseGrants(grantsText.text);
      if ("error" in grants) return { kind: "unmanaged", reason: grants.error };
      return { kind: "managed", connectors: connectors.file, grants: grants.file };
    },

    write(connectors, grants) {
      const accounts = owners();
      if (accounts === "absent") throw new Error("the egress proxy's group does not exist");
      const permissions = { owner: accounts === null ? null : { uid: accounts.rootUid, gid: accounts.gid }, mode: CONFIG_FILE_MODE };
      const encoder = new TextEncoder();
      // The connectors first: a stop between the two leaves at worst a grant of
      // a connector that is gone, which lends nothing.
      if (connectors !== null) writeAtomically(config.folder, CONNECTORS_FILE, encoder.encode(serializeConnectors(connectors)), permissions);
      if (grants !== null) writeAtomically(config.folder, GRANTS_FILE, encoder.encode(serializeGrants(grants)), permissions);
    },

    clean() {
      let removed = 0;
      let names: string[] = [];
      try {
        names = readdirSync(config.folder);
      } catch {
        return 0;
      }
      for (const name of names) {
        if (!isTemporary(name)) continue;
        try {
          if (!lstatSync(join(config.folder, name)).isFile()) continue;
          unlinkSync(join(config.folder, name));
          removed++;
        } catch {
          // gone in the meantime
        }
      }
      return removed;
    },
  };
}
