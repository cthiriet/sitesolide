import { describe, expect, test } from "bun:test";
import {
  PREVIOUS_DIR,
  isValidConfirmation,
  removalSteps,
  removalActions,
  leftToDo,
  type RemovalStep,
  type ProjectToRemove,
} from "../cli/removal";

/**
 * What this file protects: the order and the reach of a removal.
 *
 * It is the only command of the CLI whose mistake cannot be caught up. The VM
 * has no backup: an `rm -rf` on the wrong path, or a Caddy block left behind
 * an erased folder, is paid for with a lost site or a dead address.
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
    // service nor an account in its name.
    const actions = removalActions(project({ isApplication: false }));
    expect(actions.some((g) => g.command.includes("systemctl"))).toBe(false);
    expect(actions.some((g) => g.command.includes("userdel"))).toBe(false);
    expect(actions.map((g) => g.command)).toEqual(["sudo rm -rf /srv/sites/sample"]);
  });

  test("every declared secret is removed, at its path under /etc/sitesolide", () => {
    const actions = removalActions(project({ secrets: ["sample.env", "sample-ses.env"] }));
    const commands = actions.map((g) => g.command);
    expect(commands).toContain("sudo rm -f /etc/sitesolide/sample.env");
    expect(commands).toContain("sudo rm -f /etc/sitesolide/sample-ses.env");
  });

  test("no declared secret, no file touched in /etc/sitesolide", () => {
    const actions = removalActions(project());
    expect(actions.some((g) => g.command.includes("/etc/sitesolide"))).toBe(false);
    expect(actions.some((g) => g.command.includes("sitesolide-steward"))).toBe(false);
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
    expect(steps).toEqual(["sudo rm -rf /srv/sites/sample/public", "BLOCK", "sudo rm -rf /srv/sites/sample"]);
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
