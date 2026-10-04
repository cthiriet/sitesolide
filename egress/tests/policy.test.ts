import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatPattern } from "../../bin/cli/egress";
import { EMPTY_CONNECTORS, putConnector, serializeConnectors } from "../../bin/cli/connectors";
import { DATA_DIR } from "../src/config";
import { createPolicy } from "../src/policy";

function tree() {
  const root = mkdtempSync(join(DATA_DIR, "policy-"));
  const sites = join(root, "sites");
  const config = join(root, "config");
  mkdirSync(sites, { recursive: true });
  mkdirSync(config, { recursive: true });
  const manifest = (slug: string, content: object | string, mtime?: Date) => {
    mkdirSync(join(sites, slug), { recursive: true });
    const path = join(sites, slug, "sitesolide.json");
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
    if (mtime !== undefined) utimesSync(path, mtime, mtime);
  };
  return { root, sites, config, manifest, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("a project's policy", () => {
  test("read from its deployed manifest: the hosts and the connectors it asks for", () => {
    const t = tree();
    try {
      t.manifest("shop", { slug: "shop", port: 3040, start: "/x", egress: ["api.example.com", "*.Slack.com"], connectors: ["chat"] });
      const policy = createPolicy(t.sites, t.config).project("shop");
      expect(policy?.egress.map(formatPattern)).toEqual(["api.example.com", "*.slack.com"]);
      expect(policy?.connectors).toEqual(["chat"]);
    } finally {
      t.cleanup();
    }
  });

  test("a manifest deployed a moment ago applies to the next request", () => {
    const t = tree();
    try {
      t.manifest("shop", { slug: "shop", egress: ["api.example.com"] }, new Date(2026, 0, 1));
      const policy = createPolicy(t.sites, t.config);
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
      const policy = createPolicy(t.sites, t.config);
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
      t.manifest("shop", { slug: "shop", egress: ["api.example.com", "*", "10.0.0.1"], connectors: ["chat", "Bad"] });
      const policy = createPolicy(t.sites, t.config).project("shop");
      expect(policy?.egress.map(formatPattern)).toEqual(["api.example.com"]);
      expect(policy?.connectors).toEqual(["chat"]);
    } finally {
      t.cleanup();
    }
  });
});

describe("the lent credentials", () => {
  test("absent files lend nothing, and say nothing is wrong", () => {
    const t = tree();
    try {
      const lending = createPolicy(t.sites, t.config).lending();
      expect(lending.connectors.connectors).toEqual({});
      expect(lending.grants.grants).toEqual([]);
      expect(lending.errors).toEqual([]);
    } finally {
      t.cleanup();
    }
  });

  test("re-read when a file changes, and nothing lent from a file that does not read", () => {
    const t = tree();
    try {
      const created = putConnector(EMPTY_CONNECTORS, { name: "chat", baseUrl: "https://chat.example.com", header: "Authorization", value: "Bearer test-0123" }, "2026-10-04T12:00:00.000Z", "owner");
      if ("error" in created) throw new Error(created.error);
      const path = join(t.config, "connectors.json");
      writeFileSync(path, serializeConnectors(created.file));
      utimesSync(path, new Date(2026, 0, 1), new Date(2026, 0, 1));
      const policy = createPolicy(t.sites, t.config);
      expect(Object.keys(policy.lending().connectors.connectors)).toEqual(["chat"]);

      writeFileSync(path, "{ not json");
      utimesSync(path, new Date(2026, 0, 2), new Date(2026, 0, 2));
      const lending = policy.lending();
      expect(lending.connectors.connectors).toEqual({});
      expect(lending.errors).toEqual(["connectors.json is not JSON"]);
    } finally {
      t.cleanup();
    }
  });
});
