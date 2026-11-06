import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISABLED_ANSWER, DISABLED_HEADER, disabledFragment, isDisabledBlock } from "../cli/fragment";
import { lifecycleRefusal } from "../cli/lifecycle";
import { readManifest, setDisabled, validate } from "../cli/manifest";
import { renameRefusal } from "../cli/rename";

const ZONE = "test-zone.invalid";
const text = (object: object) => `${JSON.stringify(object, null, 2)}\n`;
const BLOG = text({ slug: "blog", publicDir: "public" });
const SHOP = text({ slug: "shop", start: "/usr/local/bin/bun run server.ts", port: 3002, domain: { name: "shop.example", aliases: ["www.shop.example"], active: true } });

describe("disabled, in the manifest", () => {
  test("written by setDisabled, true or absent, and nothing else", () => {
    const off = setDisabled(BLOG, true);
    expect(readManifest(off).manifest?.disabled).toBe(true);
    expect(readManifest(setDisabled(off, false)).manifest?.disabled).toBeUndefined();
    expect(validate(readManifest(off).manifest!, ZONE)).toEqual([]);
    expect(validate(readManifest(text({ slug: "blog", publicDir: "public", disabled: false })).manifest!, ZONE).some((error) => error.startsWith("disabled"))).toBe(true);
  });
});

describe("lifecycleRefusal", () => {
  const machine = new Map([
    ["blog", BLOG],
    ["off", setDisabled(text({ slug: "off", publicDir: "public" }), true)],
    ["closed", text({ slug: "closed", publicDir: "public", lock: true })],
    ["dashboard", text({ slug: "dashboard", publicDir: "public" })],
  ]);

  test("a project on is turned off, one off is turned on, either is removed", () => {
    expect(lifecycleRefusal("disable", "blog", machine, ZONE)).toBeNull();
    expect(lifecycleRefusal("enable", "off", machine, ZONE)).toBeNull();
    expect(lifecycleRefusal("remove", "blog", machine, ZONE)).toBeNull();
    expect(lifecycleRefusal("remove", "off", machine, ZONE)).toBeNull();
  });

  test("twice the same, a project not there, the platform's own and a site with a code are refused", () => {
    expect(lifecycleRefusal("disable", "off", machine, ZONE)).toContain("already turned off");
    expect(lifecycleRefusal("enable", "blog", machine, ZONE)).toContain("already on");
    expect(lifecycleRefusal("disable", "missing", machine, ZONE)).toContain("no project named missing");
    expect(lifecycleRefusal("remove", "dashboard", machine, ZONE)).toContain("platform's own");
    expect(lifecycleRefusal("remove", "closed", machine, ZONE)).toContain("Public or Restricted");
  });

  test("a project turned off is not renamed", () => {
    expect(renameRefusal("off", "gone", machine, ZONE)).toContain("turn it on first");
  });
});

describe("the block of a project turned off", () => {
  test("names its preview and its domain switched on, and answers a 503 on each", () => {
    const block = disabledFragment(readManifest(setDisabled(SHOP, true)).manifest!);
    expect(block).toContain("shop.{$SITESOLIDE_ZONE} {");
    expect(block).toContain("shop.example, www.shop.example {");
    expect(block.match(new RegExp(`respond "${DISABLED_ANSWER}" 503`, "g"))).toHaveLength(2);
    expect(block).not.toContain("reverse_proxy");
    expect(isDisabledBlock(block)).toBe(true);
    // A domain not switched on is not claimed: no certificate is asked for it.
    const inactive = disabledFragment({ ...readManifest(SHOP).manifest!, domain: { name: "shop.example" } });
    expect(inactive).not.toContain("shop.example {");
  });

  const CADDY = Bun.which("caddy");
  test.skipIf(CADDY === null)("is a configuration Caddy reads, with the snippets every block imports", () => {
    const folder = mkdtempSync(join(tmpdir(), "disabled-caddy-"));
    try {
      const caddyfile = join(folder, "Caddyfile");
      writeFileSync(
        caddyfile,
        ["(commun) {", "\tencode gzip", "}", "(tls-zone) {", "\ttls internal", "}", disabledFragment(readManifest(setDisabled(SHOP, true)).manifest!)].join("\n"),
      );
      const adapted = Bun.spawnSync([CADDY!, "adapt", "--config", caddyfile, "--adapter", "caddyfile"], { env: { ...process.env, SITESOLIDE_ZONE: ZONE } });
      expect(adapted.exitCode).toBe(0);
      const json = adapted.stdout.toString();
      expect(json).toContain('"status_code":503');
      expect(json).toContain(DISABLED_HEADER);
      expect(json).toContain(`shop.${ZONE}`);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
