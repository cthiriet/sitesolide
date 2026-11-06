import { describe, expect, test } from "bun:test";
import { readManifest, setFormerSlugs, setSlug, validate } from "../cli/manifest";
import { followMachine, renamedTo, renameRefusal } from "../cli/rename";

const ZONE = "test-zone.invalid";
const manifest = (object: object) => `${JSON.stringify(object, null, 2)}\n`;
const NIS2 = manifest({ slug: "nis2", description: "Mail protection", port: 3035, start: "/usr/local/bin/bun run server.ts", domain: { name: "cybersolide.test-zone.example", active: true } });

describe("setSlug", () => {
  test("puts the new slug in place and the old one among the former names, every other key in its order", () => {
    const text = setSlug(NIS2, "cybersolide");
    expect(Object.keys(JSON.parse(text))).toEqual(["slug", "formerSlugs", "description", "port", "start", "domain"]);
    expect(readManifest(text).manifest).toMatchObject({ slug: "cybersolide", formerSlugs: ["nis2"], port: 3035 });
  });

  test("renamed twice keeps both former names, oldest first", () => {
    expect(readManifest(setSlug(setSlug(NIS2, "cybersolide"), "mailguard")).manifest?.formerSlugs).toEqual(["nis2", "cybersolide"]);
  });

  test("renamed back drops the name it takes again", () => {
    expect(readManifest(setSlug(setSlug(NIS2, "cybersolide"), "nis2")).manifest?.formerSlugs).toEqual(["cybersolide"]);
  });

  test("the same name changes nothing", () => {
    expect(readManifest(setSlug(NIS2, "nis2")).manifest?.formerSlugs).toBeUndefined();
  });
});

describe("validate, formerSlugs", () => {
  const errors = (object: object) => validate(readManifest(manifest(object)).manifest!, ZONE).filter((error) => error.startsWith("formerSlugs"));

  test("a list of slugs is accepted", () => {
    expect(errors({ slug: "cybersolide", formerSlugs: ["nis2"], publicDir: "public" })).toEqual([]);
  });

  test("the slug itself, a repeated name, a name that is no slug and an empty list are refused", () => {
    expect(errors({ slug: "cybersolide", formerSlugs: ["cybersolide"], publicDir: "public" })).toHaveLength(1);
    expect(errors({ slug: "cybersolide", formerSlugs: ["nis2", "nis2"], publicDir: "public" })).toHaveLength(1);
    expect(errors({ slug: "cybersolide", formerSlugs: ["Nis2"], publicDir: "public" })).toHaveLength(1);
    expect(errors({ slug: "cybersolide", formerSlugs: [], publicDir: "public" })).toHaveLength(1);
  });
});

describe("renameRefusal", () => {
  const machine = new Map([
    ["nis2", NIS2],
    ["blog", manifest({ slug: "blog", publicDir: "public" })],
    ["shop", manifest({ slug: "shop", formerSlugs: ["store"], publicDir: "public" })],
    ["closed", manifest({ slug: "closed", publicDir: "public", lock: true })],
  ]);

  test("a free name is accepted", () => {
    expect(renameRefusal("nis2", "cybersolide", machine, ZONE)).toBeNull();
  });

  test("a project the machine does not carry is refused", () => {
    expect(renameRefusal("missing", "cybersolide", machine, ZONE)).toContain("no project named missing");
  });

  test("a name another project has, or had, is refused", () => {
    expect(renameRefusal("nis2", "blog", machine, ZONE)).toContain("already the name");
    expect(renameRefusal("nis2", "store", machine, ZONE)).toContain("former name of shop");
  });

  test("a project takes back its own former name", () => {
    expect(renameRefusal("shop", "store", machine, ZONE)).toBeNull();
  });

  test("the platform's projects and names, the machine's names and a bad shape are refused", () => {
    expect(renameRefusal("nis2", "dashboard", machine, ZONE)).toContain("reserved");
    expect(renameRefusal("nis2", ZONE, machine, ZONE)).not.toBeNull();
    expect(renameRefusal("nis2", "caddy", machine, ZONE)).toContain("the machine already uses");
    expect(renameRefusal("nis2", "Cybersolide", machine, ZONE)).toContain("lowercase");
    expect(renameRefusal("nis2", "nis2", machine, ZONE)).toContain("already has that name");
    const platform = new Map([["portal", manifest({ slug: "portal", publicDir: "public" })]]);
    expect(renameRefusal("portal", "door", platform, ZONE)).toContain("platform's own");
  });

  test("a site that opens with a code is refused, and told what to do", () => {
    expect(renameRefusal("closed", "open", machine, ZONE)).toContain("Public or Restricted");
  });
});

describe("followMachine", () => {
  const renamed = setSlug(NIS2, "cybersolide");

  test("a checkout under a former name follows the project to its new name", () => {
    const followed = followMachine(NIS2, "nis2", new Map([["cybersolide", renamed]]));
    expect(followed.kind).toBe("renamed");
    if (followed.kind !== "renamed") return;
    expect(followed.to).toBe("cybersolide");
    expect(readManifest(followed.text).manifest).toMatchObject({ slug: "cybersolide", formerSlugs: ["nis2"], port: 3035 });
  });

  test("the machine's former names are written in, every one of them", () => {
    const twice = setSlug(renamed, "mailguard");
    const followed = followMachine(NIS2, "nis2", new Map([["mailguard", twice]]));
    expect(followed.kind === "renamed" && readManifest(followed.text).manifest?.formerSlugs).toEqual(["nis2", "cybersolide"]);
    // A checkout that has the new name but lost the list gets it back.
    const lost = setFormerSlugs(twice, undefined);
    const back = followMachine(lost, "mailguard", new Map([["mailguard", twice]]));
    expect(back.kind === "former" && readManifest(back.text).manifest?.formerSlugs).toEqual(["nis2", "cybersolide"]);
  });

  test("a project in its place, or a new one, is left as it is", () => {
    expect(followMachine(renamed, "cybersolide", new Map([["cybersolide", renamed]])).kind).toBe("same");
    expect(followMachine(NIS2, "nis2", new Map()).kind).toBe("same");
    expect(renamedTo(new Map([["blog", manifest({ slug: "blog", publicDir: "public" })]]), "nis2")).toBeNull();
  });
});
