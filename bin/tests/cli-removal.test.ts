import { describe, expect, test } from "bun:test";
import {
  PREVIOUS_DIR,
  isValidConfirmation,
  removalSteps,
  removalActions,
  leftToDo,
  ownershipReleaseCommand,
  readOwnershipRelease,
  removableSecrets,
  type RemovalStep,
  type ProjectToRemove,
} from "../cli/removal";
import { storeRemovalActions } from "../cli/store";

/**
 * What this file protects: the order and the reach of a removal.
 *
 * It is the only command of the CLI whose mistake cannot be caught up. A
 * backup holds the data of its last run at best: an `rm -rf` on the wrong
 * path, or a Caddy block left behind an erased folder, is paid for with a
 * lost site or a dead address.
 * Everything is tried here on strings, without a single command leaving.
 */

const project = (overrides: Partial<ProjectToRemove> = {}): ProjectToRemove => ({
  slug: "sample",
  isApplication: true,
  secrets: [],
  ...overrides,
});

describe("isValidConfirmation", () => {
  test("the slug typed again opens the removal", () => {
    expect(isValidConfirmation("sample", "sample")).toBe(true);
    expect(isValidConfirmation("  sample  ", "sample")).toBe(true);
  });

  test("another slug refuses it, and that is the case that matters", () => {
    // The way the accident happens: the command is run from the folder of a
    // project other than the one you believe you are removing.
    expect(isValidConfirmation("calendar", "sample")).toBe(false);
  });

  test("nothing, or an approximate flag, is not enough", () => {
    expect(isValidConfirmation(undefined, "sample")).toBe(false);
    expect(isValidConfirmation("", "sample")).toBe(false);
    expect(isValidConfirmation("yes", "sample")).toBe(false);
    expect(isValidConfirmation("--force", "sample")).toBe(false);
  });
});

describe("removalActions", () => {
  test("the unit is stopped before its folder goes", () => {
    const actions = removalActions(project());
    const unit = actions.findIndex((g) => g.command.includes("systemctl disable"));
    const folder = actions.findIndex((g) => g.command.includes("rm -rf"));
    expect(unit).toBeGreaterThanOrEqual(0);
    expect(unit).toBeLessThan(folder);
  });

  test("the user goes after the folder that belongs to it", () => {
    // `userdel` before would leave files without an owner, which the next
    // system user would inherit on the same UID.
    const actions = removalActions(project());
    const folder = actions.findIndex((g) => g.command.includes("rm -rf"));
    const account = actions.findIndex((g) => g.command.includes("userdel"));
    expect(account).toBeGreaterThan(folder);
  });

  test("the folder aimed at is the project's one, and nothing above it", () => {
    // The irreversible gesture of the batch: a truncated path would erase
    // every site on the machine.
    const command = removalActions(project({ slug: "green-garden" }))
      .find((g) => g.command.startsWith("sudo rm -rf"))?.command;
    expect(command).toBe("sudo rm -rf /srv/sites/green-garden");
    expect(command).not.toBe("sudo rm -rf /srv/sites");
    expect(command).not.toContain("/srv/sites/ ");
  });

  test("a showcase has neither a unit nor a user to remove", () => {
    // It is served by the wildcard block from its publicDir: there never was a
    // service nor an account in its name. A store may have been made for its
    // slug all the same, before a first deployment: it goes too.
    const actions = removalActions(project({ isApplication: false }));
    expect(actions.some((g) => g.command.includes("systemctl"))).toBe(false);
    expect(actions.some((g) => g.command.includes("userdel"))).toBe(false);
    expect(actions.map((g) => g.command)).toEqual([
      "sudo rm -rf /srv/sites/sample",
      "sudo rm -rf /etc/sitesolide/projects/sample",
      "sudo rm -rf /var/lib/sitesolide-steward/precedents/projects/sample",
    ]);
  });

  test("every declared secret is removed, at its path under /etc/sitesolide", () => {
    const actions = removalActions(project({ secrets: ["sample.env", "sample-ses.env"] }));
    const commands = actions.map((g) => g.command);
    expect(commands).toContain("sudo rm -f /etc/sitesolide/sample.env");
    expect(commands).toContain("sudo rm -f /etc/sitesolide/sample-ses.env");
  });

  test("no declared file, no flat file touched in /etc/sitesolide: the project's store alone", () => {
    const actions = removalActions(project());
    expect(actions.filter((g) => g.command.includes("/etc/sitesolide")).map((g) => g.command)).toEqual(["sudo rm -rf /etc/sitesolide/projects/sample"]);
    expect(actions.filter((g) => g.command.includes("sitesolide-steward")).map((g) => g.command)).toEqual(["sudo rm -rf /var/lib/sitesolide-steward/precedents/projects/sample"]);
  });

  test("the project's store and its previous versions go after the served folder, before the account, whatever the manifest says", () => {
    for (const shape of [project(), project({ secrets: ["sample.env", "sample-ses.env"] }), project({ isApplication: false })]) {
      const commands = removalActions(shape).map((g) => g.command);
      const folder = commands.indexOf("sudo rm -rf /srv/sites/sample");
      const store = commands.indexOf("sudo rm -rf /etc/sitesolide/projects/sample");
      const previous = commands.indexOf("sudo rm -rf /var/lib/sitesolide-steward/precedents/projects/sample");
      const units = commands.findIndex((c) => c.includes("systemctl disable"));
      const account = commands.findIndex((c) => c.includes("userdel"));
      expect(store).toBeGreaterThan(folder);
      expect(previous).toBe(store + 1);
      // The units stopped first: none starts again without its files/ folder (I3').
      if (shape.isApplication) {
        expect(units).toBe(0);
        expect(account).toBe(commands.length - 1);
        expect(account).toBeGreaterThan(previous);
      }
      // Exactly the store module's two actions, titles included.
      const actions = removalActions(shape);
      expect(actions.slice(store, store + 2)).toEqual(storeRemovalActions("sample"));
    }
  });

  test("the store's paths are the project's own, and nothing above them", () => {
    const commands = removalActions(project({ slug: "green-garden" })).map((g) => g.command);
    expect(commands).toContain("sudo rm -rf /etc/sitesolide/projects/green-garden");
    expect(commands).toContain("sudo rm -rf /var/lib/sitesolide-steward/precedents/projects/green-garden");
    expect(commands.some((c) => /rm -rf? \/etc\/sitesolide(\/projects)?\/?$/.test(c))).toBe(false);
    expect(commands.some((c) => /rm -rf? \/var\/lib\/sitesolide-steward(\/precedents(\/projects)?)?\/?$/.test(c))).toBe(false);
  });

  test("a slug that is not a project's is refused before a single command is built", () => {
    // Each path is built from the slug, `rm -rf` the first: an empty slug
    // would name /srv/sites itself, a `..` the folder above it.
    for (const slug of ["", "..", "../etc", "a/b", "Sample", "sample ", "sample\nreboot", "-sample", "sample.env", "sample;reboot"]) {
      expect(() => removalActions(project({ slug }))).toThrow("not a project's slug");
      expect(() => removalSteps(project({ slug }), { block: true, isProtected: true })).toThrow("not a project's slug");
    }
    expect(() => removalActions(project({ slug: 42 as unknown as string }))).toThrow("not a project's slug");
  });

  test("the previous version of each secret goes with it", () => {
    // Left behind, it would wait in the dashboard for the next project of the
    // same name, with its predecessor's key.
    const commands = removalActions(project({ secrets: ["sample.env", "sample-ses.env"] })).map((g) => g.command);
    expect(PREVIOUS_DIR).toBe("/var/lib/sitesolide-steward/precedents");
    expect(commands).toContain("sudo rm -f /var/lib/sitesolide-steward/precedents/sample.env");
    expect(commands).toContain("sudo rm -f /var/lib/sitesolide-steward/precedents/sample-ses.env");
    expect(commands.some((c) => /rm -rf? \/var\/lib\/sitesolide-steward\/precedents\/?$/.test(c))).toBe(false);
  });

  test("the flat files a project left behind when it moved to its store go with it, each with its previous version, before the store", () => {
    const commands = removalActions(project({ secrets: ["sample.env"], leftovers: ["sample-ses.env", "sample.env", "sample-ses.env"] })).map((g) => g.command);
    // Each once, a name the manifest names too included.
    expect(commands.filter((c) => c === "sudo rm -f /etc/sitesolide/sample-ses.env")).toHaveLength(1);
    expect(commands.filter((c) => c === "sudo rm -f /etc/sitesolide/sample.env")).toHaveLength(1);
    expect(commands).toContain("sudo rm -f /var/lib/sitesolide-steward/precedents/sample-ses.env");
    const leftover = commands.indexOf("sudo rm -f /etc/sitesolide/sample-ses.env");
    expect(leftover).toBeGreaterThan(commands.indexOf("sudo rm -rf /srv/sites/sample"));
    expect(leftover).toBeLessThan(commands.indexOf("sudo rm -rf /etc/sitesolide/projects/sample"));
    // None given, none touched: the actions are those of before.
    expect(removalActions(project({ leftovers: [] }))).toEqual(removalActions(project()));
  });

  test("a leftover that is not a flat file's name is refused before a single command is built", () => {
    for (const name of ["", "..", "../etc/shadow", "a/b.env", "projects", "sample-secrets/x.env", "sample.env;reboot", "-sample.env", "SAMPLE_KEY"]) {
      expect(() => removalActions(project({ leftovers: [name] }))).toThrow("not a secret file's name");
    }
  });

  test("everything is taken up again without error after a failure halfway", () => {
    // An interrupted removal must be able to go to the end: a service already
    // stopped, a file already gone, an account already deleted are not
    // errors. Without that, the retry fails on its first step and leaves the
    // rest in place.
    for (const { command } of removalActions(project({ secrets: ["sample.env"] }))) {
      const tolerant =
        command.includes("|| true") || command.includes("rm -f") || command.includes("rm -rf");
      expect(tolerant).toBe(true);
    }
  });

  test("no gesture touches Caddy", () => {
    // The block goes through bin/deploy-caddy.sh, the only way that validates
    // before reloading and restores on failure. And never `caddy stop`, which
    // addresses the production's admin API whatever its --config: 23 minutes
    // of outage on 11 August 2026.
    for (const { command } of removalActions(project())) {
      expect(command).not.toContain("caddy");
    }
  });
});

describe("removalSteps", () => {
  /** Each step by what identifies it: BLOCK, or the remote command. */
  const read = (steps: RemovalStep[]): string[] =>
    steps.map((step) => (step.kind === "block" ? "BLOCK" : step.action.command));
  const indexIn = (steps: string[], pattern: string): number => steps.findIndex((step) => step.includes(pattern));

  test("an open site gives back its block first, before its service and its files", () => {
    // A block in front of a stopped service would answer 502 for as long as
    // the rest takes.
    const steps = read(removalSteps(project({ secrets: ["sample.env"] }), { block: true, isProtected: false }));
    expect(steps[0]).toBe("BLOCK");
    expect(steps.slice(1)).toEqual(removalActions(project({ secrets: ["sample.env"] })).map((g) => g.command));
  });

  test("behind the portal, the service and public/ go before the block", () => {
    // Once the block is gone, *.test-zone.invalid serves
    // /srv/sites/<slug>/public to everyone: during deploy-caddy.sh's check,
    // and forever if the command stops there.
    const steps = read(removalSteps(project({ secrets: ["sample.env"] }), { block: true, isProtected: true }));
    const service = indexIn(steps, "systemctl disable --now sample");
    const publicDir = steps.indexOf("sudo rm -rf /srv/sites/sample/public");
    const block = steps.indexOf("BLOCK");
    expect(service).toBe(0);
    expect(publicDir).toBe(1);
    expect(block).toBe(2);
  });

  test("behind the portal, the data and the deposited manifest wait for the block to be gone", () => {
    // The manifest tells a restarted removal that a block laid from the
    // dashboard is still to be removed; the data does not go on a failure of
    // the block.
    const steps = read(removalSteps(project({ secrets: ["sample.env"] }), { block: true, isProtected: true }));
    const block = steps.indexOf("BLOCK");
    expect(steps.indexOf("sudo rm -rf /srv/sites/sample")).toBeGreaterThan(block);
    expect(indexIn(steps, "/etc/sitesolide/sample.env")).toBeGreaterThan(block);
    expect(indexIn(steps, "userdel")).toBe(steps.length - 1);
    // Nothing is lost nor done twice by changing the order.
    expect(steps.filter((step) => step !== "BLOCK").toSorted()).toEqual(
      [...removalActions(project({ secrets: ["sample.env"] })).map((g) => g.command), "sudo rm -rf /srv/sites/sample/public"].toSorted(),
    );
  });

  test("a showcase behind the portal also removes its public files before the block", () => {
    const steps = read(removalSteps(project({ isApplication: false }), { block: true, isProtected: true }));
    expect(steps).toEqual([
      "sudo rm -rf /srv/sites/sample/public",
      "BLOCK",
      "sudo rm -rf /srv/sites/sample",
      "sudo rm -rf /etc/sitesolide/projects/sample",
      "sudo rm -rf /var/lib/sitesolide-steward/precedents/projects/sample",
    ]);
  });

  test("behind the portal, the store goes after the block, with the data, and before the account", () => {
    const steps = read(removalSteps(project({ secrets: ["sample.env"] }), { block: true, isProtected: true }));
    const block = steps.indexOf("BLOCK");
    const store = steps.indexOf("sudo rm -rf /etc/sitesolide/projects/sample");
    expect(store).toBeGreaterThan(block);
    expect(store).toBeGreaterThan(steps.indexOf("sudo rm -rf /srv/sites/sample"));
    expect(steps.indexOf("sudo rm -rf /var/lib/sitesolide-steward/precedents/projects/sample")).toBe(store + 1);
    expect(indexIn(steps, "userdel")).toBe(steps.length - 1);
  });

  test("with no block to remove, the gestures follow their ordinary order", () => {
    expect(read(removalSteps(project(), { block: false, isProtected: false }))).toEqual(
      removalActions(project()).map((g) => g.command),
    );
  });

  test("the command that removes public/ aims at that folder only", () => {
    const steps = read(removalSteps(project({ slug: "green-garden" }), { block: true, isProtected: true }));
    expect(steps).toContain("sudo rm -rf /srv/sites/green-garden/public");
    expect(steps.filter((step) => step.startsWith("sudo rm -rf /srv/sites")).toSorted()).toEqual([
      "sudo rm -rf /srv/sites/green-garden",
      "sudo rm -rf /srv/sites/green-garden/public",
    ]);
  });
});

describe("leftToDo", () => {
  test("the site's code is never deleted by the CLI", () => {
    // It lives in another repository, under git: `git rm -r` does it better,
    // and the history keeps the site recoverable. A deployment command that
    // erases sources is a tool you no longer dare to run.
    const rest = leftToDo("green-garden", null);
    expect(rest[0]).toContain("git rm -r green-garden");
  });

  test("a known path is taken up as it is", () => {
    expect(leftToDo("green-garden", "../sitesolide-sites/green-garden")[0])
      .toContain("../sitesolide-sites/green-garden");
  });

  test("a credential the workstation keeps for it is recalled", () => {
    // The machine's copy goes with the removal; one kept in the workstation's
    // vault, an API token a tool presents, would outlive the site unnoticed.
    expect(leftToDo("sample", null).join(" ")).toContain("vault");
  });
});

describe("the token that created it", () => {
  test("root asks the steward's owner socket, the slug on standard input, never on the command line", () => {
    expect(ownershipReleaseCommand()).toBe(
      "sudo curl -sS --max-time 10 -X DELETE -H 'Content-Type: application/json' --data-binary @- -w '\\n%{http_code}\\n' --unix-socket /run/sitesolide-steward-owner/owner.sock http://steward/tokens/project",
    );
  });

  test("the steward's answers, read whole, never thrown", () => {
    const ok = (body: object, status = 200) => ({ code: 0, output: `${JSON.stringify(body)}\n${status}\n`, error: "" });
    expect(readOwnershipRelease(ok({ slug: "shop", forgotten: "aaaaaaaaaaaa" }))).toEqual({ kind: "released", token: "aaaaaaaaaaaa", access: 0 });
    expect(readOwnershipRelease(ok({ slug: "shop", forgotten: "aaaaaaaaaaaa", access: 3 }))).toEqual({ kind: "released", token: "aaaaaaaaaaaa", access: 3 });
    expect(readOwnershipRelease(ok({ slug: "shop", forgotten: null, access: 2 }))).toEqual({ kind: "none", access: 2 });
    expect(readOwnershipRelease(ok({ slug: "shop", forgotten: null, access: -1 }))).toEqual({ kind: "none", access: 0 });
    expect(readOwnershipRelease(ok({ slug: "shop", forgotten: null }))).toEqual({ kind: "none", access: 0 });
    expect(readOwnershipRelease(ok({ error: "not-found", message: "no such route" }, 404))).toEqual({ kind: "outdated" });
    expect(readOwnershipRelease({ code: 7, output: "", error: "curl: (7) Couldn't connect" })).toEqual({ kind: "outdated" });
    expect(readOwnershipRelease(ok({ error: "busy", message: "shop is still on the machine" }, 409))).toEqual({ kind: "failed", reason: "shop is still on the machine" });
    expect(readOwnershipRelease({ code: 255, output: "", error: "ssh: connect" })).toEqual({ kind: "failed", reason: "ssh: connect" });
    expect(readOwnershipRelease({ code: 0, output: "garbage", error: "" }).kind).toBe("failed");
  });
});

describe("the secret files a removal deletes", () => {
  test("only the project's own: the machine's and another site's are kept, and said", () => {
    const chosen = removableSecrets("shop", ["shop.env", "shop-smtp.env", "dashboard.env", "dashboard-backup.env", "cms.env", "shop-admin.env"], ["shop", "cms", "shop-admin"]);
    expect(chosen.removed).toEqual(["shop.env", "shop-smtp.env"]);
    expect(chosen.kept).toEqual([
      "kept: dashboard.env belongs to the machine, root's, and no project reads it",
      "kept: dashboard-backup.env belongs to the machine, root's, and no project reads it",
      "kept: cms.env is not named after shop: a project reads shop.env and shop-<name> files alone",
      "kept: shop-admin.env belongs to shop-admin, deployed on the machine",
    ]);
    // A file named after the project that another account owns stays too.
    const owned = removableSecrets("shop", ["shop.env", "shop-mail.env"], [], new Map([["shop-mail.env", { kind: "file", owner: "site-shopkeeper" } as const]]));
    expect(owned).toEqual({ removed: ["shop.env"], kept: ["kept: /etc/sitesolide/shop-mail.env is already on the machine and belongs to site-shopkeeper, not site-shop: a project reads its own files alone"] });
    const commands = removalActions(project({ slug: "shop", secrets: chosen.removed })).map((action) => action.command);
    expect(commands.filter((command) => command.includes("/etc/sitesolide/"))).toEqual(["sudo rm -f /etc/sitesolide/shop.env", "sudo rm -f /etc/sitesolide/shop-smtp.env", "sudo rm -rf /etc/sitesolide/projects/shop"]);
  });
});
