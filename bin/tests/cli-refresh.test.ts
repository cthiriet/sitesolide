import { describe, expect, test } from "bun:test";
import { DEFAULT_HINT, hintFor } from "../cli/hints";
import type { Manifest } from "../cli/manifest";
import {
  changedMeanwhile,
  foreignUnits,
  notDeployed,
  parseRefreshArguments,
  planUnits,
  readDeposited,
  REFRESH_USAGE,
  refusedManifest,
  stoppedAt,
  stoppedDetails,
  summaryFields,
  summaryLines,
  type ProjectReport,
} from "../cli/refresh";
import { earlierGenerations, generateUnits } from "../cli/unit";

/**
 * What `sitesolide refresh` decides, without a machine: its command line,
 * which deposited manifest it works from, which units it writes, and what it
 * says at the end. The wiring, against the fake machine, is
 * bin/tests/e2e/refresh.test.ts's.
 */

const PLACEHOLDERS = { slug: "shop", zone: "test-zone.invalid", contact: "" };
const SHOP: Manifest = { slug: "shop", start: "/usr/local/bin/bun run server.ts", port: 3050 };
const MIXED: Manifest = {
  slug: "shop",
  services: { web: { start: "/usr/local/bin/bun run server.ts", port: 3050 }, sync: { start: "/usr/local/bin/bun run sync.ts", schedule: "hourly" } },
};

describe("the command line", () => {
  test("one slug, or --all, with --dry-run and --json", () => {
    expect(parseRefreshArguments(["shop"])).toEqual({ target: { all: false, slug: "shop" }, dryRun: false });
    expect(parseRefreshArguments(["--all", "--dry-run", "--json"])).toEqual({ target: { all: true }, dryRun: true });
    expect(parseRefreshArguments(["--json", "shop", "--dry-run"])).toEqual({ target: { all: false, slug: "shop" }, dryRun: true });
  });

  test("anything else is refused with the usage, saying why", () => {
    const refused = (arguments_: string[]): string[] => {
      const parsed = parseRefreshArguments(arguments_);
      if (!("message" in parsed)) throw new Error(`accepted: ${arguments_.join(" ")}`);
      expect(parsed.message).toBe(REFRESH_USAGE);
      return parsed.details;
    };
    expect(refused([]).join("\n")).toContain("--all");
    expect(refused(["shop", "--all"]).join("\n")).toContain("not both");
    expect(refused(["shop", "blog"]).join("\n")).toContain("one project at a time");
    expect(refused(["Shop_2"]).join("\n")).toContain("Shop_2 is not a project's slug");
    expect(refused(["shop", "--yes"]).join("\n")).toContain("not an option of refresh: --yes");
    // --force is deploy's, which sends the code: refresh never replaces a unit edited by hand.
    expect(refused(["shop", "--force"]).join("\n")).toContain("sitesolide deploy --force");
  });
});

describe("the manifest the machine carries", () => {
  test("an app, a static site, or refused with the reason", () => {
    expect(readDeposited("shop", JSON.stringify(SHOP))).toEqual({ kind: "app", manifest: SHOP });
    expect(readDeposited("docs", JSON.stringify({ slug: "docs", publicDir: "public" }))).toMatchObject({ kind: "static" });
    const broken = readDeposited("shop", "{ not json");
    expect(broken.kind).toBe("refused");
    expect(broken.kind === "refused" && broken.reasons[0]).toContain("unreadable");
    const unknown = readDeposited("shop", JSON.stringify({ ...SHOP, colour: "blue" }));
    expect(unknown.kind === "refused" && unknown.reasons.join(" ")).toContain("colour: unknown key");
  });

  test("a manifest that names another project than its folder is refused: its units would be another's", () => {
    const other = readDeposited("blog", JSON.stringify(SHOP));
    expect(other).toEqual({ kind: "refused", reasons: ["/srv/sites/blog/sitesolide.json names shop, not blog"] });
  });
});

describe("which units are written", () => {
  const [main] = generateUnits(SHOP, PLACEHOLDERS);
  const text = main!.text;
  const previous = earlierGenerations(text).at(-1)!;
  const edited = text.replace("PrivateDevices=true\n", "");

  test("an earlier generation, or a missing unit, is written; a current one is not; one edited by hand is kept", () => {
    expect(planUnits([main!], [previous])).toMatchObject({ state: "outdated", mainKept: false });
    expect(planUnits([main!], [previous]).write.map((unit) => unit.path)).toEqual(["/etc/systemd/system/shop.service"]);
    expect(planUnits([main!], [""]).state).toBe("outdated");
    expect(planUnits([main!], [earlierGenerations(text)[0]!]).state).toBe("outdated");
    expect(planUnits([main!], [text])).toMatchObject({ state: "current", write: [], kept: [] });
    // Comments alone do not make a unit edited by hand.
    expect(planUnits([main!], [`# a note\n${text}`]).state).toBe("current");
    const kept = planUnits([main!], [edited]);
    expect(kept).toMatchObject({ state: "kept", write: [] });
    expect(kept.kept.map((unit) => unit.path)).toEqual(["/etc/systemd/system/shop.service"]);
  });

  test("in a project of several, each unit on its own, unless the main one was edited by hand: then none", () => {
    const units = generateUnits(MIXED, PLACEHOLDERS);
    const texts = units.map((unit) => unit.text);
    const older = texts.map((one) => earlierGenerations(one).at(-1)!);
    const secondary = planUnits(units, [texts[0]!, older[1]!, texts[2]!]);
    expect(secondary.state).toBe("outdated");
    expect(secondary.write.map((unit) => unit.unit)).toEqual(["shop.sync"]);
    const oneKept = planUnits(units, [older[0]!, texts[1]!.replace("PrivateDevices=true\n", ""), texts[2]!]);
    expect(oneKept.write.map((unit) => unit.unit)).toEqual(["shop"]);
    expect(oneKept.kept.map((unit) => unit.unit)).toEqual(["shop.sync"]);
    // The main unit is what starts the others: edited by hand, it may not want them as generated.
    const mainEdited = planUnits(units, [texts[0]!.replace("PrivateDevices=true\n", ""), older[1]!, older[2]!]);
    expect(mainEdited).toMatchObject({ state: "kept", mainKept: true, write: [] });
  });
});

describe("what it says", () => {
  const report = (slug: string, state: ProjectReport["state"]): ProjectReport => ({
    slug,
    state,
    write: [],
    current: [],
    kept: [],
    reasons: [],
    url: null,
    status: null,
  });
  const reports = [report("alpha", "current"), report("bravo", "kept"), report("charlie", "refused"), report("delta", "static"), report("echo", "refreshed")];

  test("the summary, by state, in the order the projects were taken", () => {
    expect(summaryFields(reports)).toEqual({ refreshed: ["echo"], outdated: [], current: ["alpha"], kept: ["bravo"], refused: ["charlie"], static: ["delta"] });
    expect(summaryLines(reports, false)).toEqual([
      "refreshed: echo",
      "already current: alpha",
      "kept, edited by hand: bravo",
      "refused, nothing changed: charlie",
      "static, no unit to refresh: delta",
    ]);
    expect(summaryLines([report("alpha", "current")], false)).toEqual(["nothing was written", "already current: alpha"]);
    expect(summaryLines([report("echo", "outdated")], true)).toEqual(["would be refreshed: echo"]);
    expect(summaryLines([report("alpha", "current")], true)).toEqual(["nothing would be written", "already current: alpha"]);
  });

  test("a stop names what was written for the project it stopped at, what came before, and what was not reached", () => {
    expect(stoppedDetails({ slug: "foxtrot", written: [], restarted: false }, reports, ["golf"])).toEqual([
      "nothing was written for foxtrot",
      "refreshed before it: echo",
      "already current: alpha",
      "kept, edited by hand: bravo",
      "refused, nothing changed: charlie",
      "static, no unit to refresh: delta",
      "not reached, left as they are: golf",
    ]);
    const restarted = stoppedDetails({ slug: "foxtrot", written: ["/etc/systemd/system/foxtrot.service"], restarted: true }, [], ["golf"]);
    expect(restarted[0]).toBe("written for foxtrot: /etc/systemd/system/foxtrot.service");
    expect(restarted[1]).toContain("sitesolide logs");
    expect(restarted[2]).toBe("refreshed before it: none");
    // One project asked for: nothing before it, nothing after, nothing more to say.
    const alone = stoppedDetails({ slug: "foxtrot", written: ["/etc/systemd/system/foxtrot.service"], restarted: false }, [], []);
    expect(alone).toHaveLength(2);
    expect(alone[1]).toContain("not restarted");
  });

  test("every refusal refresh words has a hint of its own, and none sends to --force", () => {
    const messages = [
      REFRESH_USAGE,
      refusedManifest("shop"),
      foreignUnits("shop"),
      notDeployed("shop"),
      `${stoppedAt("shop")}${changedMeanwhile("shop")}`,
      `${stoppedAt("shop")}https://shop.test-zone.invalid/ unreachable: Unable to connect`,
      `${stoppedAt("shop")}a service fell after its restart`,
      `${stoppedAt("shop")}failed (1): ssh deploy@203.0.113.10 sudo systemctl restart shop`,
      `${stoppedAt("shop")}write refused: /etc/systemd/system/shop.service`,
      `${stoppedAt("shop")}Caddy is being changed by deploy since 10:00:00 UTC; try again in a moment`,
      `${stoppedAt("shop")}cannot take the Caddy lock: no answer`,
      `${stoppedAt("shop")}cannot tell whether /etc/systemd/system/shop.service is there`,
    ];
    for (const message of messages) {
      const hint = hintFor(message);
      expect({ message, covered: hint !== DEFAULT_HINT }).toEqual({ message, covered: true });
      expect(hint).not.toMatch(/re-run with --force|run .*--force/);
    }
    expect(hintFor(`${stoppedAt("shop")}Caddy is being changed by deploy since 10:00:00 UTC; try again in a moment`)).toContain("wait a minute");
    expect(hintFor(`${stoppedAt("shop")}cannot tell whether /etc/systemd/system/shop.service is there`)).toContain("nothing was changed");
    expect(hintFor(`${stoppedAt("shop")}a service fell after its restart`)).toContain("sitesolide logs");
    expect(hintFor(refusedManifest("shop"))).toContain("sitesolide deploy");
  });
});
