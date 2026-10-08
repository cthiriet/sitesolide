import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFragment } from "../cli/fragment";
import type { Manifest } from "../cli/manifest";
import { fragmentIsProtected } from "../cli/portal";
import {
  accessOf,
  generalOf,
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
    expect(portalFromManifest(reading.manifests.get("cms")!)).toEqual({ kind: "read", portal: true, lock: false });
    expect(portalFromManifest(reading.manifests.get("vineyard")!)).toEqual({ kind: "read", portal: false, lock: false });
  });

  test("a single site: present, or absent when the machine does not know it", () => {
    const root = join(TMP_ROOT, "one");
    deposit(root, "cms", JSON_CMS);
    expect(readDepositedManifest(readIn(root, "cms"), "cms")).toEqual({ kind: "present", portal: true, lock: false });
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

describe("what a deposited manifest says about its general access", () => {
  test("the portal restricts, the lock asks for a code, the absence of both opens", () => {
    expect(portalFromManifest('{"slug":"cms","portal":true}')).toEqual({ kind: "read", portal: true, lock: false });
    expect(portalFromManifest('{"slug":"cms","lock":true}')).toEqual({ kind: "read", portal: false, lock: true });
    expect(portalFromManifest('{"slug":"cms"}')).toEqual({ kind: "read", portal: false, lock: false });
  });

  test("another value is unreadable rather than guessed", () => {
    // `false` is not what the gatekeeper writes, and "yes" would read both
    // ways: neither of the two decides to open a site.
    for (const value of [false, "yes", 1, null, "true"]) {
      expect(portalFromManifest(JSON.stringify({ slug: "cms", portal: value })).kind).toBe("unreadable");
      expect(portalFromManifest(JSON.stringify({ slug: "cms", lock: value })).kind).toBe("unreadable");
    }
  });

  test("the three general accesses and their two fields, one way and back", () => {
    for (const access of ["public", "restricted", "code"] as const) expect(accessOf(generalOf(access))).toBe(access);
    expect(generalOf("code")).toEqual({ portal: false, lock: true });
  });

  test("what is not a JSON object is unreadable", () => {
    for (const raw of ["", "{not json", "[]", "null", '"cms"']) {
      expect(portalFromManifest(raw).kind).toBe("unreadable");
    }
  });

  test("another site's manifest, deposited in this folder, is unreadable for deploy", () => {
    expect(portalFromManifest('{"slug":"other","portal":true}', "cms").kind).toBe("unreadable");
    // The guard only knows the folder, and reads the door as it is.
    expect(portalFromManifest('{"slug":"other","portal":true}')).toEqual({ kind: "read", portal: true, lock: false });
  });

  test("the rest of the manifest is not judged: an unknown key says nothing about the door", () => {
    expect(portalFromManifest('{"slug":"cms","portal":true,"newKey":1}', "cms")).toEqual({
      kind: "read",
      portal: true,
      lock: false,
    });
  });
});

/** The two fields of each general access. */
const G = {
  public: { portal: false, lock: false },
  restricted: { portal: true, lock: false },
  code: { portal: false, lock: true },
} as const;
const ACCESSES = ["public", "restricted", "code"] as const;
const present = (access: (typeof ACCESSES)[number]) => ({ kind: "present" as const, ...G[access] });

describe("the general access that deploy applies", () => {
  test("a first deployment takes the repository's value, whichever it is", () => {
    for (const local of ACCESSES) {
      expect(decidePortal("fresh", G[local], { kind: "absent" })).toEqual({ kind: "repository", ...G[local] });
    }
  });

  test("the same value on both sides changes nothing", () => {
    for (const value of ACCESSES) {
      expect(decidePortal("cms", G[value], present(value))).toEqual({ kind: "repository", ...G[value] });
    }
  });

  test("changed on the machine, from the dashboard or with sitesolide lock: the VM wins, whichever way", () => {
    for (const local of ACCESSES) {
      for (const machine of ACCESSES.filter((one) => one !== local)) {
        expect(decidePortal("cms", G[local], present(machine))).toEqual({ kind: "dashboard", ...G[machine] });
      }
    }
  });

  test("an unreadable reading stops the deployment, whichever the repository says", () => {
    for (const local of ACCESSES) {
      const decision = decidePortal("cms", G[local], { kind: "unreadable", reason: "not valid JSON" });
      expect(decision.kind).toBe("rejects");
      if (decision.kind !== "rejects") return;
      expect(decision.message).toContain("cannot tell whether the general access of cms");
      expect(decision.details.join("\n")).toContain("/srv/sites/cms/sitesolide.json: not valid JSON");
      expect(decision.details.join("\n")).toContain("nothing was sent");
    }
  });

  test("the announcement says the general access, that the manifest is rewritten, and that it must be committed", () => {
    expect(switchAnnouncement(G.restricted, false).title).toBe(
      "general access was set to Restricted from the dashboard; sitesolide.json updated, commit it",
    );
    expect(switchAnnouncement(G.public, false).title).toBe(
      "general access was set to Public from the dashboard; sitesolide.json updated, commit it",
    );
    expect(switchAnnouncement(G.code, false).title).toBe(
      "general access was set to Anyone with the code from the dashboard; sitesolide.json updated, commit it",
    );
  });

  test("in a dry run, the announcement does not claim to have rewritten anything", () => {
    const { title } = switchAnnouncement(G.restricted, true);
    expect(title).toContain("general access was set to Restricted from the dashboard");
    expect(title).not.toContain("updated,");
    expect(title).toContain("commit it");
  });
});

/**
 * The gesture that deposits the local manifest as it is: the domain. It does
 * not take back the VM's general access, so it would erase it.
 */
describe("the guard of the domain", () => {
  test("same general access on both sides, site open or with a code: the gesture goes through", () => {
    for (const access of ["public", "code"] as const) {
      expect(guardDepositedManifest("vineyard", G[access], present(access), "domain")).toEqual({ kind: "agreed" });
    }
  });

  test("a site absent from the machine has nothing to lose", () => {
    expect(guardDepositedManifest("fresh", G.public, { kind: "absent" }, "domain")).toEqual({ kind: "agreed" });
  });

  test("changed from the dashboard, the deposit would undo it: refusal that points to deploy", () => {
    for (const [local, machine] of [["restricted", "public"], ["public", "code"], ["code", "public"]] as const) {
      const agreement = guardDepositedManifest("vineyard", G[local], present(machine), "domain");
      expect(agreement.kind).toBe("rejects");
      if (agreement.kind !== "rejects") return;
      expect(agreement.message).toBe(
        "general access of vineyard changed from the dashboard: run `sitesolide deploy` in its folder first",
      );
      expect(agreement.details.join("\n")).toContain("nothing was written");
    }
  });

  test("an own domain on a site behind the portal: it comes off from the dashboard first", () => {
    for (const local of ["public", "restricted"] as const) {
      const agreement = guardDepositedManifest("vineyard", G[local], present("restricted"), "domain");
      expect(agreement.kind).toBe("rejects");
      if (agreement.kind !== "rejects") return;
      expect(agreement.message).toBe("vineyard is restricted: make it public from the dashboard's Access section first");
      expect(agreement.details).toContain("a restricted site cannot switch to its own domain yet");
      // The local manifest that still asks for the door will have to catch up.
      expect(agreement.details.some((line) => line.includes("sitesolide deploy"))).toBe(local === "restricted");
    }
  });

  test("an unreadable reading authorises nothing", () => {
    const agreement = guardDepositedManifest("vineyard", G.public, { kind: "unreadable", reason: "not valid JSON" }, "domain");
    expect(agreement.kind).toBe("rejects");
    if (agreement.kind !== "rejects") return;
    expect(agreement.message).toContain("cannot tell whether the general access of vineyard");
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
      "general access of cms changed from the dashboard: run `sitesolide deploy` in its folder first",
    );
    expect(guard.lines[1]).toContain("the repository block is restricted");
  });

  test("a block open in the repository, a site closed from the dashboard: refusal", () => {
    // The case that counts the most: depositing this block would serve the
    // site in the clear.
    const guard = guardPortals([block(open)], output({ tool: { slug: "tool", portal: true } }));
    expect(guard.kind).toBe("rejects");
    if (guard.kind !== "rejects") return;
    expect(guard.lines[0]).toBe(
      "general access of tool changed from the dashboard: run `sitesolide deploy` in its folder first",
    );
    expect(guard.lines[1]).toContain("the server's manifest is restricted");
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
      "general access of cms changed from the dashboard: run `sitesolide deploy` in its folder first",
      "general access of tool changed from the dashboard: run `sitesolide deploy` in its folder first",
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
    expect(readManifestAmongAll(ALL, "cms")).toEqual({ kind: "present", portal: true, lock: false });
    expect(readManifestAmongAll(ALL, "tool")).toEqual({ kind: "absent" });
    expect(readManifestAmongAll(ALL, "stale").kind).toBe("unreadable");
    expect(readManifestAmongAll("MANIFEST cms\n", "cms").kind).toBe("unreadable");
  });

  test("the same general access, or no manifest at all, lets the deposit happen", () => {
    for (const access of ACCESSES) expect(confirmDoorUnderLock("cms", G[access], present(access))).toEqual({ kind: "agreed" });
    expect(confirmDoorUnderLock("cms", G.restricted, { kind: "absent" })).toEqual({ kind: "agreed" });
  });

  test("a general access changed since the first reading stops everything, whichever way", () => {
    // Open at the start, closed from the dashboard during the build:
    // depositing the manifest and the block from the start would reopen the
    // site.
    expect(confirmDoorUnderLock("cms", G.public, present("restricted"))).toMatchObject({
      kind: "rejects",
      message: "general access of cms changed from the dashboard during this deploy: run `sitesolide deploy` again",
      details: ["this deploy was applying Public, the server now has Restricted", "neither the manifest nor the Caddy block was deposited"],
    });
    // A code set meanwhile: the manifest leaving would drop it, the code left in force.
    expect(confirmDoorUnderLock("cms", G.public, present("code"))).toMatchObject({
      kind: "rejects",
      details: ["this deploy was applying Public, the server now has Anyone with the code", "neither the manifest nor the Caddy block was deposited"],
    });
    expect(confirmDoorUnderLock("cms", G.restricted, present("public")).kind).toBe("rejects");
    expect(confirmDoorUnderLock("cms", G.code, present("restricted")).kind).toBe("rejects");
  });

  test("an unreadable reading authorises nothing", () => {
    expect(confirmDoorUnderLock("cms", G.restricted, { kind: "unreadable", reason: "cut" })).toMatchObject({
      kind: "rejects",
      message: "cannot tell whether the general access of cms was changed from the dashboard",
    });
  });
});
