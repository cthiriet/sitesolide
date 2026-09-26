import { describe, expect, test } from "bun:test";
import { directoryCommands } from "../sitesolide";

/**
 * The gestures `deploy` performs itself on the machine, on the first pass as
 * on the following ones.
 *
 * **They must be replayable without consequence**, since `deploy` no longer
 * asks anyone whether this is a first pass: it replays them every time. A
 * command that would fail the second time, or that would overwrite what it
 * laid down the first time, would turn the single command into a regression.
 *
 * The test reads the commands rather than running them: they carry `sudo` and
 * name /srv/sites, and nothing in this repository tries itself out on the
 * machine that serves the clients.
 */

/** The account that connects to the VM, hence the owner of the served files. */
const ACCOUNT = "me";

const APP = directoryCommands("budget", true, ACCOUNT);
const STATIC = directoryCommands("notes", false, ACCOUNT);

describe("the tree is laid down again without consequence", () => {
  test("no folder is created without -p", () => {
    // `mkdir` without -p fails on an existing folder, hence on the second pass.
    for (const command of [...APP, ...STATIC]) {
      if (command.includes("mkdir")) expect(command).toContain("mkdir -p");
    }
  });

  test("nothing erases, nothing moves", () => {
    // An rm or an mv here would carry off the service's data, which the
    // deployment never touches: only rsync --delete erases, and it only aims
    // at the code and the public files.
    for (const command of [...APP, ...STATIC]) {
      expect(command).not.toMatch(/\b(rm|mv|truncate)\b/);
    }
  });

  test("the data folder belongs to the service, and to it alone", () => {
    expect(APP.join("\n")).toContain(
      "chown -R site-budget:site-budget /srv/sites/budget/data",
    );
    // The code and the public files stay mine: a service that could rewrite
    // its own code would no longer be confined.
    expect(APP.join("\n")).toContain("chown me:me /srv/sites/budget /srv/sites/budget/app");
  });

  test("a static site creates neither app/ nor data/, and names no system user", () => {
    const all = STATIC.join("\n");
    expect(all).toContain("/srv/sites/notes/public");
    expect(all).not.toContain("/srv/sites/notes/app");
    expect(all).not.toContain("/srv/sites/notes/data");
    expect(all).not.toContain("site-notes");
  });

  test("the commands are identical from one call to the next", () => {
    // They depend neither on the clock nor on the state of the disk: two
    // deployments of the same manifest lay down exactly the same gestures.
    expect(directoryCommands("budget", true, ACCOUNT)).toEqual(APP);
  });
});
