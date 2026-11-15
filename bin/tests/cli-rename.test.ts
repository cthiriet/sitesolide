import { describe, expect, test } from "bun:test";
import { readManifest, setSlug, validate } from "../cli/manifest";
import { renameRefusal } from "../cli/rename";

const ZONE = "test-zone.invalid";
const manifest = (object: object) => `${JSON.stringify(object, null, 2)}\n`;
const OLDSITE = manifest({ slug: "oldsite", description: "Mail protection", port: 3035, start: "/usr/local/bin/bun run server.ts", domain: { name: "cybersolide.test-zone.example", active: true } });

describe("setSlug", () => {
  test("puts the new slug in place and the old one among the former names, every other key in its order", () => {
    const text = setSlug(OLDSITE, "cybersolide");
    expect(Object.keys(JSON.parse(text))).toEqual(["slug", "formerSlugs", "description", "port", "start", "domain"]);
    expect(readManifest(text).manifest).toMatchObject({ slug: "cybersolide", formerSlugs: ["oldsite"], port: 3035 });
  });

  test("renamed twice keeps both former names, oldest first", () => {
    expect(readManifest(setSlug(setSlug(OLDSITE, "cybersolide"), "mailguard")).manifest?.formerSlugs).toEqual(["oldsite", "cybersolide"]);
  });

  test("renamed back drops the name it takes again", () => {
    expect(readManifest(setSlug(setSlug(OLDSITE, "cybersolide"), "oldsite")).manifest?.formerSlugs).toEqual(["cybersolide"]);
  });

  test("the same name changes nothing", () => {
    expect(readManifest(setSlug(OLDSITE, "oldsite")).manifest?.formerSlugs).toBeUndefined();
  });
});

describe("validate, formerSlugs", () => {
  const errors = (object: object) => validate(readManifest(manifest(object)).manifest!, ZONE).filter((error) => error.startsWith("formerSlugs"));

  test("a list of slugs is accepted", () => {
    expect(errors({ slug: "cybersolide", formerSlugs: ["oldsite"], publicDir: "public" })).toEqual([]);
  });

  test("the slug itself, a repeated name, a name that is no slug and an empty list are refused", () => {
    expect(errors({ slug: "cybersolide", formerSlugs: ["cybersolide"], publicDir: "public" })).toHaveLength(1);
    expect(errors({ slug: "cybersolide", formerSlugs: ["oldsite", "oldsite"], publicDir: "public" })).toHaveLength(1);
    expect(errors({ slug: "cybersolide", formerSlugs: ["Oldsite"], publicDir: "public" })).toHaveLength(1);
    expect(errors({ slug: "cybersolide", formerSlugs: [], publicDir: "public" })).toHaveLength(1);
  });
});

describe("renameRefusal", () => {
  const machine = new Map([
    ["oldsite", OLDSITE],
    ["blog", manifest({ slug: "blog", publicDir: "public" })],
    ["shop", manifest({ slug: "shop", formerSlugs: ["store"], publicDir: "public" })],
    ["closed", manifest({ slug: "closed", publicDir: "public", lock: true })],
  ]);

  test("a free name is accepted", () => {
    expect(renameRefusal("oldsite", "cybersolide", machine, ZONE)).toBeNull();
  });

  test("a project the machine does not carry is refused", () => {
    expect(renameRefusal("missing", "cybersolide", machine, ZONE)).toContain("no project named missing");
  });

  test("a name another project has, or had, is refused", () => {
    expect(renameRefusal("oldsite", "blog", machine, ZONE)).toContain("already the name");
    expect(renameRefusal("oldsite", "store", machine, ZONE)).toContain("former name of shop");
  });

  test("a project takes back its own former name", () => {
    expect(renameRefusal("shop", "store", machine, ZONE)).toBeNull();
  });

  test("the platform's projects and names, the machine's names and a bad shape are refused", () => {
    expect(renameRefusal("oldsite", "dashboard", machine, ZONE)).toContain("reserved");
    expect(renameRefusal("oldsite", ZONE, machine, ZONE)).not.toBeNull();
    expect(renameRefusal("oldsite", "caddy", machine, ZONE)).toContain("the machine already uses");
    expect(renameRefusal("oldsite", "Cybersolide", machine, ZONE)).toContain("lowercase");
    expect(renameRefusal("oldsite", "oldsite", machine, ZONE)).toContain("already has that name");
    const platform = new Map([["portal", manifest({ slug: "portal", publicDir: "public" })]]);
    expect(renameRefusal("portal", "door", platform, ZONE)).toContain("platform's own");
  });

  test("a site that opens with a code is refused, and told what to do", () => {
    expect(renameRefusal("closed", "open", machine, ZONE)).toContain("Public or Restricted");
  });
});

