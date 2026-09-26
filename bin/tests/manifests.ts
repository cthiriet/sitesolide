/**
 * Every manifest the workstation knows: the platform's own services, and the
 * sites of the neighbouring repository when there is one.
 *
 * What the tests read where they used to read copies of the deployed units and
 * blocks. Those copies are gone, the units and blocks being generated from
 * these manifests at deploy time: a test that wants "what runs" reads the
 * manifests and generates, as the deployment does.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { projectsRepo } from "../cli/config";
import { readManifest, type Manifest } from "../cli/manifest";

const REPO_ROOT = join(import.meta.dir, "..", "..");

export function knownManifests(): Manifest[] {
  const roots = [REPO_ROOT, projectsRepo()].filter((root): root is string => root !== null && existsSync(root));
  const found: Manifest[] = [];
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(root, entry.name, "sitesolide.json");
      if (!existsSync(path)) continue;
      const { manifest } = readManifest(readFileSync(path, "utf8"));
      if (manifest !== undefined) found.push(manifest);
    }
  }
  return found;
}
