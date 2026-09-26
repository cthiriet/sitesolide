import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFragment } from "../cli/fragment";
import type { Manifest } from "../cli/manifest";
import { fragmentIsProtected } from "../cli/portal";
import {
  switchAnnouncement,
  readManifestsCommand,
  confirmDoorUnderLock,
  decidePortal,
  guardDepositedManifest,
  guardPortals,
  readDepositedManifest,
  readManifestAmongAll,
  readDepositedManifests,
  portalFromManifest,
  readManifestsScript,
  type RepoBlock,
} from "../cli/portal-vm";

/**
 * The portal of a deployed site is laid down from the dashboard, and the VM is
 * the authority.
 *
 * What decides is here: the reading of the deposited manifests, the door that
 * `deploy` applies, and the guard of bin/deploy-caddy.sh. A mistake in one of
 * these three would silently reopen a site that the dashboard closed. The
 * tests that run the CLI and the script on a simulated VM live in
 * e2e/portal-vm.test.ts.
 */

const TMP_ROOT = mkdtempSync(join(tmpdir(), "portal-vm-"));
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

/** The reading script, run for real on a tree on the workstation. */
function readIn(root: string, pattern: string): string {
  const reading = Bun.spawnSync(["sh", "-c", readManifestsScript(pattern, root)]);
  expect(reading.exitCode).toBe(0);
  return reading.stdout.toString();
}

function deposit(root: string, slug: string, content: string): void {
  mkdirSync(join(root, slug), { recursive: true });
  writeFileSync(join(root, slug, "sitesolide.json"), content);
}

const JSON_CMS = JSON.stringify({ slug: "cms", start: "bun run server.ts", port: 3048, portal: true }, null, 2);

describe("the remote reading", () => {
  test("the command passes the whole script to sudo, without a single quote inside", () => {
    for (const pattern of ["*", "cms"]) {
      const command = readManifestsCommand(pattern);
      expect(command.startsWith("sudo sh -c '")).toBe(true);
      expect(command.endsWith("'")).toBe(true);
      expect(command.slice("sudo sh -c '".length, -1)).not.toContain("'");
    }
  });

  test("a slug that is not one never enters the command", () => {
    // The pattern is glued into a string that the remote shell interprets.
    for (const pattern of ["../etc", "cms;reboot", "a b", "", "*/.."]) {
      expect(() => readManifestsCommand(pattern)).toThrow();
    }
  });

  test("the script reads every manifest, skips a folder that has none, and ends with DONE", () => {
    const root = join(TMP_ROOT, "all");
    deposit(root, "cms", `${JSON_CMS}\n`);
    // Without a trailing newline: the end marker must not stick to it.
    deposit(root, "vineyard", '{"slug":"vineyard","publicDir":"public"}');
    mkdirSync(join(root, "test-zone.invalid"), { recursive: true });

    const reading = readDepositedManifests(readIn(root, "*"));
    expect(reading.kind).toBe("read");
    if (reading.kind !== "read") return;
    expect([...reading.manifests.keys()]).toEqual(["cms", "vineyard"]);
    expect(portalFromManifest(reading.manifests.get("cms")!)).toEqual({ kind: "read", portal: true });
    expect(portalFromManifest(reading.manifests.get("vineyard")!)).toEqual({ kind: "read", portal: false });
  });

  test("a single site: present, or absent when the machine does not know it", () => {
    const root = join(TMP_ROOT, "one");
    deposit(root, "cms", JSON_CMS);
    expect(readDepositedManifest(readIn(root, "cms"), "cms")).toEqual({ kind: "present", portal: true });
    expect(readDepositedManifest(readIn(root, "fresh"), "fresh")).toEqual({ kind: "absent" });
  });

  test("a machine without a single site answers DONE, and nothing else", () => {
    const root = join(TMP_ROOT, "empty");
    mkdirSync(root, { recursive: true });
    expect(readDepositedManifests(readIn(root, "*"))).toEqual({ kind: "read", manifests: new Map() });
  });
});

describe("an answer we do not recognise authorises nothing", () => {
  const unreadable: Array<[string, string]> = [
    ["empty: a refused sudo or an ssh that does not go through", ""],
    ["without DONE: the connection cut on the way", `MANIFEST cms\n${JSON_CMS}\nEND cms\n`],
    ["a manifest without its end", `MANIFEST cms\n${JSON_CMS}\nDONE\n`],
    ["a foreign line", `a foreign banner line\nDONE\n`],
    ["the markers of another reading", "PRESENT\n{}\n"],
    ["a site named twice", `MANIFEST cms\n{}\nEND cms\nMANIFEST cms\n{}\nEND cms\nDONE\n`],
    ["something after DONE", "DONE\nMANIFEST cms\n"],
  ];

  test.each(unreadable)("%s", (_, output) => {
    expect(readDepositedManifests(output).kind).toBe("unreadable");
    expect(readDepositedManifest(output, "cms").kind).toBe("unreadable");
  });

  test("an answer that speaks of another site says nothing about this one", () => {
    const output = `MANIFEST other\n{"slug":"other"}\nEND other\nDONE\n`;
    expect(readDepositedManifest(output, "cms").kind).toBe("unreadable");
  });
});

describe("what a deposited manifest says about the door", () => {
  test("true closes, the absence opens", () => {
    expect(portalFromManifest('{"slug":"cms","portal":true}')).toEqual({ kind: "read", portal: true });
    expect(portalFromManifest('{"slug":"cms"}')).toEqual({ kind: "read", portal: false });
  });

  test("another value is unreadable rather than guessed", () => {
    // `false` is not what the gatekeeper writes, and "yes" would read both
    // ways: neither of the two decides to open a site.
    for (const value of [false, "yes", 1, null, "true"]) {
      expect(portalFromManifest(JSON.stringify({ slug: "cms", portal: value })).kind).toBe("unreadable");
    }
  });

  test("what is not a JSON object is unreadable", () => {
    for (const raw of ["", "{not json", "[]", "null", '"cms"']) {
      expect(portalFromManifest(raw).kind).toBe("unreadable");
    }
  });

  test("another site's manifest, deposited in this folder, is unreadable for deploy", () => {
    expect(portalFromManifest('{"slug":"other","portal":true}', "cms").kind).toBe("unreadable");
    // The guard only knows the folder, and reads the door as it is.
    expect(portalFromManifest('{"slug":"other","portal":true}')).toEqual({ kind: "read", portal: true });
  });

  test("the rest of the manifest is not judged: an unknown key says nothing about the door", () => {
    expect(portalFromManifest('{"slug":"cms","portal":true,"newKey":1}', "cms")).toEqual({
      kind: "read",
      portal: true,
    });
  });
});

describe("the door that deploy applies", () => {
  test("a first deployment takes the repository's value, open or closed", () => {
    for (const local of [true, false]) {
      expect(decidePortal("fresh", local, { kind: "absent" })).toEqual({ kind: "repository", portal: local });
    }
  });

  test("the same value on both sides changes nothing", () => {
    for (const value of [true, false]) {
      expect(decidePortal("cms", value, { kind: "present", portal: value })).toEqual({
        kind: "repository",
        portal: value,
      });
    }
  });

  test("the dashboard closed the site: the VM wins", () => {
    expect(decidePortal("cms", false, { kind: "present", portal: true })).toEqual({
      kind: "dashboard",
      portal: true,
    });
  });

  test("the dashboard reopened the site: the VM wins too", () => {
    expect(decidePortal("cms", true, { kind: "present", portal: false })).toEqual({
      kind: "dashboard",
      portal: false,
    });
  });

  test("an unreadable reading stops the deployment, in both directions", () => {
    for (const local of [true, false]) {
      const decision = decidePortal("cms", local, { kind: "unreadable", reason: "not valid JSON" });
      expect(decision.kind).toBe("rejects");
      if (decision.kind !== "rejects") return;
      expect(decision.message).toContain("cannot tell whether the portal of cms");
      expect(decision.details.join("\n")).toContain("/srv/sites/cms/sitesolide.json: not valid JSON");
      expect(decision.details.join("\n")).toContain("nothing was sent");
    }
  });

  test("the announcement says the direction, that the manifest is rewritten, and that it must be committed", () => {
    expect(switchAnnouncement(true, false).title).toBe(
      "portal was turned on from the dashboard; sitesolide.json updated, commit it",
    );
    expect(switchAnnouncement(false, false).title).toBe(
      "portal was turned off from the dashboard; sitesolide.json updated, commit it",
    );
  });

  test("in a dry run, the announcement does not claim to have rewritten anything", () => {
    const { title } = switchAnnouncement(true, true);
    expect(title).toContain("portal was turned on from the dashboard");
    expect(title).not.toContain("updated,");
    expect(title).toContain("commit it");
  });
});

/**
 * The gestures that deposit the local manifest as it is: the lock and the
 * domain. They do not take back the VM's door, so they would erase it.
 */
describe("the guard of the lock and the domain", () => {
  const present = (portal: boolean) => ({ kind: "present" as const, portal });

  test("same door on both sides, site open: the three gestures go through", () => {
    for (const action of ["lock", "unlock", "domain"] as const) {
      expect(guardDepositedManifest("vineyard", false, present(false), action)).toEqual({ kind: "agreed" });
    }
  });

  test("a site absent from the machine has nothing to lose", () => {
    for (const action of ["lock", "unlock", "domain"] as const) {
      expect(guardDepositedManifest("fresh", false, { kind: "absent" }, action)).toEqual({ kind: "agreed" });
    }
  });

  test("reopened from the dashboard, the deposit would close it: refusal that points to deploy", () => {
    for (const action of ["lock", "unlock", "domain"] as const) {
      const agreement = guardDepositedManifest("vineyard", true, present(false), action);
      expect(agreement.kind).toBe("rejects");
      if (agreement.kind !== "rejects") return;
      expect(agreement.message).toBe(
        "portal of vineyard changed from the dashboard: run `sitesolide deploy` in its folder first",
      );
      expect(agreement.details.join("\n")).toContain("nothing was written");
    }
  });

  test("closed from the dashboard, removing the lock would erase the door: refusal that points to deploy", () => {
    const agreement = guardDepositedManifest("vineyard", false, present(true), "unlock");
    expect(agreement.kind).toBe("rejects");
    if (agreement.kind !== "rejects") return;
    expect(agreement.message).toBe(
      "portal of vineyard changed from the dashboard: run `sitesolide deploy` in its folder first",
    );
  });

  test("a lock on a site behind the portal: the door comes off from the dashboard first", () => {
    // validate() forbids the two together: `deploy` would not be enough.
    for (const local of [false, true]) {
      const agreement = guardDepositedManifest("vineyard", local, present(true), "lock");
      expect(agreement.kind).toBe("rejects");
      if (agreement.kind !== "rejects") return;
      expect(agreement.message).toBe("vineyard is behind the portal: turn it off from the dashboard first");
      expect(agreement.details).toContain("a site behind the portal takes no preview lock");
      // The local manifest that still asks for the door will have to catch up.
      expect(agreement.details.some((line) => line.includes("sitesolide deploy"))).toBe(local);
    }
  });

  test("an own domain on a site behind the portal: same refusal", () => {
    const agreement = guardDepositedManifest("vineyard", false, present(true), "domain");
    expect(agreement.kind).toBe("rejects");
    if (agreement.kind !== "rejects") return;
    expect(agreement.message).toBe("vineyard is behind the portal: turn it off from the dashboard first");
    expect(agreement.details).toContain("a site behind the portal cannot switch to its own domain yet");
  });

  test("an unreadable reading authorises no gesture", () => {
    for (const action of ["lock", "unlock", "domain"] as const) {
      const agreement = guardDepositedManifest("vineyard", false, { kind: "unreadable", reason: "not valid JSON" }, action);
      expect(agreement.kind).toBe("rejects");
      if (agreement.kind !== "rejects") return;
      expect(agreement.message).toContain("cannot tell whether the portal of vineyard");
    }
  });
});

describe("the guard of deploy-caddy.sh", () => {
  const open: Manifest = { slug: "tool", start: "bun run server.ts", port: 3030, publicDir: "public" };
  const closed: Manifest = { slug: "cms", start: "bun run server.ts", port: 3048, publicDir: "public", portal: true };

  /** The block as `deploy` writes it, read the way the script reads it. */
  function block(manifest: Manifest): RepoBlock {
    return { slug: manifest.slug, isProtected: fragmentIsProtected(generateFragment(manifest)!) };
  }

  function output(manifests: Record<string, object | string>): string {
    const parts = Object.entries(manifests).map(
      ([slug, content]) =>
        `MANIFEST ${slug}\n${typeof content === "string" ? content : JSON.stringify(content)}\n\nEND ${slug}\n`,
    );
    return `${parts.join("")}DONE\n`;
  }

  test("the generated blocks carry the door of their manifest", () => {
    // The guard reads the door in the block with fragmentIsProtected: that is
    // what makes it comparable to the manifest.
    expect(block(closed).isProtected).toBe(true);
    expect(block(open).isProtected).toBe(false);
  });

  test("blocks in agreement with the machine go through, and name the closed sites", () => {
    const guard = guardPortals(
      [block(closed), block(open)],
      output({ cms: { slug: "cms", portal: true }, tool: { slug: "tool" } }),
    );
    expect(guard).toEqual({ kind: "agreed", protectedSlugs: ["cms"] });
  });

  test("a block closed in the repository, a site reopened from the dashboard: refusal", () => {
    // Depositing this block would close again a site that the dashboard has
    // just reopened.
    const guard = guardPortals([block(closed)], output({ cms: { slug: "cms" } }));
    expect(guard.kind).toBe("rejects");
    if (guard.kind !== "rejects") return;
    expect(guard.lines[0]).toBe(
      "portal of cms changed from the dashboard: run `sitesolide deploy` in its folder first",
    );
    expect(guard.lines[1]).toContain("the repository block is behind the portal");
  });

  test("a block open in the repository, a site closed from the dashboard: refusal", () => {
    // The case that counts the most: depositing this block would serve the
    // site in the clear.
    const guard = guardPortals([block(open)], output({ tool: { slug: "tool", portal: true } }));
    expect(guard.kind).toBe("rejects");
    if (guard.kind !== "rejects") return;
    expect(guard.lines[0]).toBe(
      "portal of tool changed from the dashboard: run `sitesolide deploy` in its folder first",
    );
    expect(guard.lines[1]).toContain("the server's manifest is behind the portal");
  });

  test("every site in disagreement is named, not only the first one", () => {
    const guard = guardPortals(
      [block(open), block(closed)],
      output({ cms: { slug: "cms" }, tool: { slug: "tool", portal: true } }),
    );
    expect(guard.kind).toBe("rejects");
    if (guard.kind !== "rejects") return;
    const refusals = guard.lines.filter((line) => !line.startsWith(" "));
    expect(refusals).toEqual([
      "portal of cms changed from the dashboard: run `sitesolide deploy` in its folder first",
      "portal of tool changed from the dashboard: run `sitesolide deploy` in its folder first",
    ]);
  });

  test("a block without a deposited manifest goes through: the site is not deployed yet", () => {
    // `deploy` lays the door of a protected site before its manifest: on the
    // first pass, the machine has nothing to contradict.
    expect(guardPortals([block(closed)], output({}))).toEqual({ kind: "agreed", protectedSlugs: [] });
  });

  test("a site closed from the dashboard without a block in the repository goes through, and it is named", () => {
    // A static site protected from the dashboard: its block only exists on the
    // VM, the script does not touch it and must not present it as one to
    // remove.
    const guard = guardPortals([block(open)], output({ tool: { slug: "tool" }, vineyard: { slug: "vineyard", portal: true } }));
    expect(guard).toEqual({ kind: "agreed", protectedSlugs: ["vineyard"] });
  });

  test("the block that SITESOLIDE_REMOVE names is not confronted: it is on its way out", () => {
    const guard = guardPortals([block(closed)], output({ cms: { slug: "cms" } }), "cms.caddy");
    expect(guard.kind).toBe("agreed");
  });

  test("an unreadable answer stops everything", () => {
    for (const raw of ["", `MANIFEST cms\n{}\nEND cms\n`, "PRESENT\n"]) {
      const guard = guardPortals([block(open)], raw);
      expect(guard.kind).toBe("rejects");
      if (guard.kind !== "rejects") return;
      expect(guard.lines[0]).toContain("cannot read the manifests deposited on the server");
    }
  });

  test("an unreadable deposited manifest stops everything, even without a block in the repository", () => {
    // It could be the one of a site whose door can no longer be read.
    const guard = guardPortals([block(open)], output({ tool: { slug: "tool" }, vineyard: "{not json" }));
    expect(guard.kind).toBe("rejects");
    if (guard.kind !== "rejects") return;
    expect(guard.lines[0]).toContain("cannot read /srv/sites/vineyard/sitesolide.json");
  });
});

describe("the door read again under the lock", () => {
  const ALL = `MANIFEST cms\n${JSON_CMS}\nEND cms\nMANIFEST stale\n{not json\nEND stale\nDONE\n`;

  test("a site's manifest is read within the reading of them all, even if another one is unreadable", () => {
    // The other one will be refused by the guard of the blocks, not by this
    // one's door.
    expect(readManifestAmongAll(ALL, "cms")).toEqual({ kind: "present", portal: true });
    expect(readManifestAmongAll(ALL, "tool")).toEqual({ kind: "absent" });
    expect(readManifestAmongAll(ALL, "stale").kind).toBe("unreadable");
    expect(readManifestAmongAll("MANIFEST cms\n", "cms").kind).toBe("unreadable");
  });

  test("the same door, or no manifest at all, lets the deposit happen", () => {
    expect(confirmDoorUnderLock("cms", true, { kind: "present", portal: true })).toEqual({ kind: "agreed" });
    expect(confirmDoorUnderLock("cms", false, { kind: "present", portal: false })).toEqual({ kind: "agreed" });
    expect(confirmDoorUnderLock("cms", true, { kind: "absent" })).toEqual({ kind: "agreed" });
  });

  test("a door changed since the first reading stops everything, in both directions", () => {
    // Open at the start, closed from the dashboard during the build:
    // depositing the manifest and the block from the start would reopen the
    // site.
    expect(confirmDoorUnderLock("cms", false, { kind: "present", portal: true })).toMatchObject({
      kind: "rejects",
      message: "portal of cms changed from the dashboard during this deploy: run `sitesolide deploy` again",
      details: ["this deploy was turning the portal off, the server now has it on", "neither the manifest nor the Caddy block was deposited"],
    });
    expect(confirmDoorUnderLock("cms", true, { kind: "present", portal: false }).kind).toBe("rejects");
  });

  test("an unreadable reading authorises nothing", () => {
    expect(confirmDoorUnderLock("cms", true, { kind: "unreadable", reason: "cut" })).toMatchObject({
      kind: "rejects",
      message: "cannot tell whether the portal of cms was changed from the dashboard",
    });
  });
});
