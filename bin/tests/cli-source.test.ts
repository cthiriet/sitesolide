import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRemoteProject } from "../cli/remote";
import { isInside, linksOut, publicRefusal, repositoryRoot, sourceRefusal } from "../cli/source";

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

describe("the public files of a cloned repository", () => {
  test("a publicDir that is a link out of the repository is refused, one inside it is not", () => {
    const root = tree(["home/.ssh/id_ed25519", "home/Code/clone/.git/", "home/Code/clone/site/index.html"]);
    const clone = join(root, "home", "Code", "clone");
    symlinkSync("../../.ssh", join(clone, "public"));
    expect(publicRefusal(clone, join(clone, "public"), null)).toContain(join(root, "home", ".ssh"));
    symlinkSync("site", join(clone, "inside"));
    expect(publicRefusal(clone, join(clone, "inside"), null)).toBeNull();
    // From the owner's sites repository, as `source`, anywhere.
    expect(publicRefusal(clone, join(clone, "public"), join(root, "home", "Code"))).toBeNull();
  });

  test("links among the public files that lead out of them are named, those inside are not", () => {
    const root = tree(["public/index.html", "public/v2/index.html", "public/assets/", "public/.git/"]);
    const folder = join(root, "public");
    symlinkSync("/etc/caddy/cloudflare.env", join(folder, "robots.txt"));
    symlinkSync("../../app/config.json", join(folder, "assets", "config.json"));
    symlinkSync("v2", join(folder, "latest"));
    symlinkSync("../v2/index.html", join(folder, "assets", "home.html"));
    // Never sent, so never read.
    symlinkSync("/etc/passwd", join(folder, ".git", "HEAD"));
    expect(linksOut(folder, (path) => path === ".git")).toEqual(["assets/config.json -> ../../app/config.json", "robots.txt -> /etc/caddy/cloudflare.env"]);
  });

  test("a link whose climb goes through another link is judged where the machine lands, not where its text reads", () => {
    // `up` lands on the public folder itself, four folders above where it
    // stands, and is the site's own. Read as text, `robots.txt` climbs four
    // folders from `a/b/c/d/up` and stays inside; the kernel follows `up`
    // first, and the same four climbs leave /srv/sites/<slug>/public for /,
    // where Caddy, which reads its group's files, served its own DNS token.
    const root = tree(["public/index.html", "public/a/b/c/d/", "public/x/y/"]);
    const folder = join(root, "public");
    symlinkSync("../../../..", join(folder, "a", "b", "c", "d", "up"));
    symlinkSync("a/b/c/d/up/../../../../etc/caddy/cloudflare.env", join(folder, "robots.txt"));
    // Two links that stay inside through one another travel as they did.
    symlinkSync("../..", join(folder, "x", "y", "top"));
    symlinkSync("x/y/top/index.html", join(folder, "home.html"));
    expect(linksOut(folder)).toEqual(["robots.txt -> a/b/c/d/up/../../../../etc/caddy/cloudflare.env"]);
  });

  test("a loop of links is named rather than walked for ever", () => {
    const root = tree(["public/index.html"]);
    const folder = join(root, "public");
    symlinkSync("b", join(folder, "a"));
    symlinkSync("a", join(folder, "b"));
    expect(linksOut(folder)).toEqual(["a -> b", "b -> a"]);
  });
});
