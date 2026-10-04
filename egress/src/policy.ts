/**
 * What each project may do, read where it is decided: its manifest on the
 * machine for the hosts and the connectors it asks for, the connectors file
 * and the grants file for what the administrator lends.
 *
 * **Read on the request, not on a timer.** Each file is checked with one
 * `stat` per request and parsed again only when it changed, so that an
 * allowlist deployed a second ago, or a grant withdrawn from the dashboard,
 * applies to the very next connection. No root process copies anything for the
 * proxy: the manifests are 0644 in 0755 directories, deposited by `deploy`,
 * and the connectors files are readable by the proxy's group.
 *
 * **A project's own service cannot widen its list.** The manifest belongs to
 * the deployment account and its directory is bound read-only into the
 * service: what the proxy reads is what was deployed.
 *
 * **Only the two keys are read at runtime**, not the whole manifest judged
 * again. The proxy embeds the validation of the day it was built; a rule
 * added later to some other key must not cut a project's egress until the
 * proxy is rebuilt. An entry that does not read is skipped, which narrows and
 * never widens.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { egressPatterns, requestedConnectors, type HostPattern } from "../../bin/cli/egress";
import {
  CONNECTORS_FILE,
  GRANTS_FILE,
  EMPTY_CONNECTORS,
  EMPTY_GRANTS,
  parseConnectors,
  parseGrants,
  type ConnectorsFile,
  type GrantsFile,
} from "../../bin/cli/connectors";
import { isValidSlug, type Manifest } from "../../bin/cli/manifest";

/** What a project asked for, as its deployed manifest says. */
export type ProjectPolicy = { egress: HostPattern[]; connectors: string[] };

/**
 * The lent credentials. `error` says the file in place does not read: the
 * proxy then lends nothing from it, rather than a part of it.
 */
export type Lending = {
  connectors: ConnectorsFile;
  grants: GrantsFile;
  errors: string[];
};

/** No file of ours has a reason to be bigger. */
const MAX_FILE_BYTES = 1024 * 1024;

type Read = { key: string; text: string | null };

/**
 * A file's identity for the cache, and its text when it changed. Absent and
 * unreadable both read as no text: an absent connectors file lends nothing.
 */
function readIfChanged(path: string, previousKey: string | null): Read | null {
  let key: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) key = `unusable:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    else key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    key = "absent";
  }
  if (key === previousKey) return null;
  if (key === "absent" || key.startsWith("unusable:")) return { key, text: null };
  try {
    return { key, text: readFileSync(path, "utf8") };
  } catch {
    return { key: `unreadable:${key}`, text: null };
  }
}

export type Policy = {
  /** A project's policy, null when it has no manifest that reads. */
  project: (slug: string) => ProjectPolicy | null;
  /** The lent credentials, re-read if either file changed. */
  lending: () => Lending;
};

export function createPolicy(sitesDir: string, configDir: string): Policy {
  const manifests = new Map<string, { key: string; policy: ProjectPolicy | null }>();
  let connectorsKey: string | null = null;
  let grantsKey: string | null = null;
  let lending: Lending = { connectors: EMPTY_CONNECTORS, grants: EMPTY_GRANTS, errors: [] };
  let connectorsError: string | null = null;
  let grantsError: string | null = null;

  return {
    project(slug) {
      if (!isValidSlug(slug)) return null;
      const known = manifests.get(slug);
      const read = readIfChanged(join(sitesDir, slug, "sitesolide.json"), known?.key ?? null);
      if (read === null) return known?.policy ?? null;
      let policy: ProjectPolicy | null = null;
      if (read.text !== null) {
        try {
          const manifest = JSON.parse(read.text) as Manifest;
          // The folder decides who the project is, never the file's content.
          if (typeof manifest === "object" && manifest !== null && manifest.slug === slug) {
            policy = { egress: egressPatterns(manifest), connectors: requestedConnectors(manifest) };
          }
        } catch {
          policy = null;
        }
      }
      manifests.set(slug, { key: read.key, policy });
      return policy;
    },

    lending() {
      const connectorsRead = readIfChanged(join(configDir, CONNECTORS_FILE), connectorsKey);
      const grantsRead = readIfChanged(join(configDir, GRANTS_FILE), grantsKey);
      if (connectorsRead === null && grantsRead === null) return lending;

      let { connectors, grants } = lending;
      if (connectorsRead !== null) {
        connectorsKey = connectorsRead.key;
        const parsed = parseConnectors(connectorsRead.text ?? "");
        connectors = "file" in parsed ? parsed.file : EMPTY_CONNECTORS;
        connectorsError = "error" in parsed ? parsed.error : connectorsRead.key.startsWith("unreadable") ? `${CONNECTORS_FILE} cannot be read` : null;
      }
      if (grantsRead !== null) {
        grantsKey = grantsRead.key;
        const parsed = parseGrants(grantsRead.text ?? "");
        grants = "file" in parsed ? parsed.file : EMPTY_GRANTS;
        grantsError = "error" in parsed ? parsed.error : grantsRead.key.startsWith("unreadable") ? `${GRANTS_FILE} cannot be read` : null;
      }
      lending = {
        connectors,
        grants,
        errors: [connectorsError, grantsError].filter((error): error is string => error !== null),
      };
      return lending;
    },
  };
}
