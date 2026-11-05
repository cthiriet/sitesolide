import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatPattern } from "../../bin/cli/egress";
import { DATA_DIR } from "../src/config";
import { createPolicy } from "../src/policy";

function tree() {
  const root = mkdtempSync(join(DATA_DIR, "policy-"));
  const sites = join(root, "sites");
  mkdirSync(sites, { recursive: true });
  const manifest = (slug: string, content: object | string, mtime?: Date) => {
    mkdirSync(join(sites, slug), { recursive: true });
    const path = join(sites, slug, "sitesolide.json");
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
    if (mtime !== undefined) utimesSync(path, mtime, mtime);
  };
  return { root, sites, manifest, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("a project's policy", () => {
  test("read from its deployed manifest: the hosts it lists", () => {
    const t = tree();
    try {
      t.manifest("shop", { slug: "shop", port: 3040, start: "/x", egress: ["api.example.com", "*.Slack.com"] });
      const policy = createPolicy(t.sites).project("shop");
      expect(policy?.egress.map(formatPattern)).toEqual(["api.example.com", "*.slack.com"]);
    } finally {
      t.cleanup();
    }
  });

  test("a manifest deployed a moment ago applies to the next request", () => {
    const t = tree();
    try {
      t.manifest("shop", { slug: "shop", egress: ["api.example.com"] }, new Date(2026, 0, 1));
      const policy = createPolicy(t.sites);
      expect(policy.project("shop")?.egress.map(formatPattern)).toEqual(["api.example.com"]);
      t.manifest("shop", { slug: "shop", egress: ["api.example.com", "files.example.com"] }, new Date(2026, 0, 2));
      expect(policy.project("shop")?.egress.map(formatPattern)).toEqual(["api.example.com", "files.example.com"]);
    } finally {
      t.cleanup();
    }
  });

  test("no manifest, an unreadable one, or one naming another slug: no policy", () => {
    const t = tree();
    try {
      t.manifest("broken", "{");
      t.manifest("liar", { slug: "shop", egress: ["api.example.com"] });
      const policy = createPolicy(t.sites);
      expect(policy.project("absent")).toBeNull();
      expect(policy.project("broken")).toBeNull();
      expect(policy.project("liar")).toBeNull();
      expect(policy.project("../etc")).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  test("an entry that does not read narrows the list, never widens it", () => {
    const t = tree();
    try {
      t.manifest("shop", { slug: "shop", egress: ["api.example.com", "*", "10.0.0.1"] });
      const policy = createPolicy(t.sites).project("shop");
      expect(policy?.egress.map(formatPattern)).toEqual(["api.example.com"]);
    } finally {
      t.cleanup();
    }
  });

  test("a key the proxy does not read changes nothing, even one its validation would refuse", () => {
    const t = tree();
    try {
      t.manifest("shop", { slug: "shop", egress: ["api.example.com"], later: ["anything"] });
      expect(createPolicy(t.sites).project("shop")).toEqual({ egress: [{ wildcard: false, host: "api.example.com", port: null }] });
    } finally {
      t.cleanup();
    }
  });
});
