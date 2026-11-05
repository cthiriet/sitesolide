/**
 * What each project may reach, read where it is decided: its manifest on the
 * machine.
 *
 * **Read on the request, not on a timer.** The manifest is checked with one
 * `stat` per request and parsed again only when it changed, so that an
 * allowlist deployed a second ago applies to the very next connection. No
 * root process copies anything for the proxy: the manifests are 0644 in 0755
 * directories, deposited by `deploy`.
 *
 * **A project's own service cannot widen its list.** The manifest belongs to
 * the deployment account and its directory is bound read-only into the
 * service: what the proxy reads is what was deployed.
 *
 * **Only `egress` is read at runtime**, not the whole manifest judged again.
 * The proxy embeds the validation of the day it was built; a rule added later
 * to some other key must not cut a project's egress until the proxy is
 * rebuilt. An entry that does not read is skipped, which narrows and never
 * widens.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { egressPatterns, type HostPattern } from "../../bin/cli/egress";
import { isValidSlug, type Manifest } from "../../bin/cli/manifest";

/** What a project may reach, as its deployed manifest says. */
export type ProjectPolicy = { egress: HostPattern[] };

/** No manifest has a reason to be bigger. */
const MAX_FILE_BYTES = 1024 * 1024;

type Read = { key: string; text: string | null };

/**
 * A file's identity for the cache, and its text when it changed. Absent and
 * unreadable both read as no text: a project without a manifest that reads
 * reaches nothing.
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
};

export function createPolicy(sitesDir: string): Policy {
  const manifests = new Map<string, { key: string; policy: ProjectPolicy | null }>();

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
            policy = { egress: egressPatterns(manifest) };
          }
        } catch {
          policy = null;
        }
      }
      manifests.set(slug, { key: read.key, policy });
      return policy;
    },
  };
}
