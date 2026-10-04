import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRemoteProject } from "../cli/remote";
import { isInside, repositoryRoot, sourceRefusal } from "../cli/source";

/**
 * Where a manifest's `source` may lead: anywhere from the owner's sites
 * repository, only inside its own repository from anywhere else. A cloned
 * repository whose manifest says `"source": "../../.ssh"` would otherwise
 * have deploy run its build there and upload the folder.
 */

const temporary: string[] = [];
afterEach(() => {
  for (const folder of temporary.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A throwaway tree: `<root>/<path>` for each path, a folder unless it names a file. */
function tree(paths: string[]): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "source-")));
  temporary.push(root);
  for (const path of paths) {
    if (path.endsWith("/")) mkdirSync(join(root, path), { recursive: true });
    else {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), "x");
    }
  }
  return root;
}

describe("the repository a manifest belongs to", () => {
  test("the git repository around its folder, or the folder itself", () => {
    const root = tree(["clone/.git/", "clone/site/", "loose/"]);
    expect(repositoryRoot(join(root, "clone", "site"))).toBe(join(root, "clone"));
    expect(repositoryRoot(join(root, "loose"))).toBe(join(root, "loose"));
    expect(isInside(join(root, "clone", "a"), join(root, "clone"))).toBe(true);
    expect(isInside(join(root, "clone-other"), join(root, "clone"))).toBe(false);
    expect(isInside(join(root, "..clone"), root)).toBe(true);
  });
});

describe("a manifest outside the sites repository", () => {
  test("may point inside its own repository", () => {
    const root = tree(["clone/.git/", "clone/deploy/", "clone/code/"]);
    expect(sourceRefusal(join(root, "clone", "deploy"), join(root, "clone", "code"), null)).toBeNull();
  });

  test("may not climb out of it, nor out of a folder that is no repository", () => {
    const root = tree(["clone/.git/", "clone/deploy/", ".ssh/", "loose/", "beside/"]);
    expect(sourceRefusal(join(root, "clone", "deploy"), join(root, ".ssh"), null)).toContain("source leads outside the repository holding sitesolide.json");
    expect(sourceRefusal(join(root, "loose"), join(root, "beside"), null)).toContain(`is not under ${join(root, "loose")}`);
  });

  test("nor reach out through a link laid inside", () => {
    const root = tree(["clone/.git/", "outside/"]);
    symlinkSync(join(root, "outside"), join(root, "clone", "code"));
    expect(sourceRefusal(join(root, "clone"), join(root, "clone", "code"), null)).toContain(join(root, "outside"));
  });

  test("the token's path refuses it too, before anything is built or sent", () => {
    const root = tree(["clone/.git/", "clone/deploy/", "home/"]);
    writeFileSync(join(root, "clone", "deploy", "sitesolide.json"), JSON.stringify({ slug: "shop", source: "../../home", publicDir: "public" }));
    const read = readRemoteProject(join(root, "clone", "deploy"));
    expect("errors" in read && read.errors[0]).toContain("source leads outside the repository");
  });
});

describe("a manifest of the owner's sites repository", () => {
  test("points at the code it deploys, wherever it lives, as mini-lab does", () => {
    const root = tree(["sites/.git/", "sites/mini-lab/", "mini-lab/"]);
    expect(sourceRefusal(join(root, "sites", "mini-lab"), join(root, "mini-lab"), join(root, "sites"))).toBeNull();
    // The same manifest elsewhere is someone else's.
    expect(sourceRefusal(join(root, "sites", "mini-lab"), join(root, "mini-lab"), null)).not.toBeNull();
  });
});
