import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dashboardAddress,
  MACHINE_FILES,
  ownerRefusal,
  OWNERS_DONE,
  readPresenceAnswer,
  readSecretOwners,
  secretFileRefusal,
  secretOwnersCommand,
  type SecretOwner,
} from "../cli/secrets";
import { MARKER_ABSENT, MARKER_PRESENT } from "../cli/unit";

/**
 * What `deploy` checks of a secret file of the old form, tried without a
 * machine: its presence read, its owner, and whether the project may read it
 * at all. A missing file no longer stops anything: deploy says so, and the
 * service starts without its variables (see ensureSecrets in
 * bin/sitesolide.ts). What still stops is a file the project may not read.
 */

describe("the dashboard's address", () => {
  test("it follows the configuration's zone, and invents none", () => {
    // The dashboard is a project like any other, served under the machine's
    // zone. The function has no default zone, and cannot have one: a
    // ready-made value would send a user towards someone else's dashboard.
    // The dashboard is a project like any other: a test machine under another
    // zone serves it under that zone, and the refusal must point there.
    expect(dashboardAddress("sample.test")).toBe("https://dashboard.sample.test");
    expect(dashboardAddress("other.test")).toBe("https://dashboard.other.test");
  });
});

describe("what the VM answers", () => {
  test("the absence marker is recognised", () => {
    expect(readPresenceAnswer(`${MARKER_ABSENT}\n`)).toEqual({ kind: "absent" });
  });

  test("the presence marker is recognised", () => {
    expect(readPresenceAnswer(`${MARKER_PRESENT}\n`)).toEqual({ kind: "present" });
    expect(readPresenceAnswer(`  ${MARKER_PRESENT}  `)).toEqual({ kind: "present" });
  });

  test("an empty output is never an absence", () => {
    // An ssh that does not go through, a refused sudo: the output is empty,
    // and confusing it with "the file is not there" would make it deposit on
    // top of a secret in service.
    expect(readPresenceAnswer("")).toEqual({ kind: "unreadable" });
    expect(readPresenceAnswer("\n  \n")).toEqual({ kind: "unreadable" });
  });

  test("a message from the remote shell is neither an absence nor a presence", () => {
    expect(readPresenceAnswer("sudo: a password is required")).toEqual({ kind: "unreadable" });
    expect(readPresenceAnswer("permission denied")).toEqual({ kind: "unreadable" });
  });

  test("a well formed fingerprint no longer counts as presence", () => {
    // Only the presence is asked for: a fingerprint comes from a command other
    // than the one that was run, and concluding from it would be guessing.
    expect(readPresenceAnswer("a".repeat(64))).toEqual({ kind: "unreadable" });
    expect(readPresenceAnswer(`${"0123456789abcdef".repeat(4)}\n`)).toEqual({
      kind: "unreadable",
    });
  });

  test("a marker surrounded by anything else is not recognised", () => {
    // Two markers at once, or a marker followed by content, say that another
    // command has spoken: nothing lets us know which one to believe.
    expect(readPresenceAnswer(`${MARKER_PRESENT}\n${MARKER_ABSENT}\n`)).toEqual({
      kind: "unreadable",
    });
    expect(readPresenceAnswer(`${MARKER_PRESENT}\nKEY=value\n`)).toEqual({
      kind: "unreadable",
    });
    expect(readPresenceAnswer(`welcome\n${MARKER_ABSENT}`)).toEqual({ kind: "unreadable" });
  });

  test("case matters", () => {
    expect(readPresenceAnswer(MARKER_PRESENT.toLowerCase())).toEqual({ kind: "unreadable" });
    expect(readPresenceAnswer(MARKER_ABSENT.toLowerCase())).toEqual({ kind: "unreadable" });
  });
});

describe("whose secret file it is", () => {
  test("a project declares its own files alone", () => {
    expect(secretFileRefusal("shop", "shop.env")).toBeNull();
    expect(secretFileRefusal("shop", "shop-smtp.env")).toBeNull();
    expect(secretFileRefusal("shop", "shop-key.pem")).toBeNull();
    expect(secretFileRefusal("shop", "cms.env")).toContain("cms.env is not named after shop");
    expect(secretFileRefusal("shop", "shopping.env")).toContain("is not named after shop");
    expect(secretFileRefusal("shop", "api.env")).not.toBeNull();
  });

  test("the machine's own files are root's, the dashboard's by their name alone", () => {
    for (const name of MACHINE_FILES) {
      expect(secretFileRefusal("thief", name)).toContain("belongs to the machine");
      expect(secretFileRefusal("dashboard", name)).toBeNull();
    }
    // A slug named after one of them takes nothing either.
    expect(secretFileRefusal("dashboard-backup", "dashboard-backup.env")).toContain("belongs to the machine");
  });

  test("a more specific site deployed on the machine keeps the files named after it", () => {
    expect(secretFileRefusal("acme", "acme-crm.env", ["acme-crm", "blog"])).toContain("acme-crm.env belongs to acme-crm");
    expect(secretFileRefusal("acme", "acme-crm-smtp.env", ["acme-crm", "acme-crm-smtp"])).toContain("belongs to acme-crm-smtp");
    expect(secretFileRefusal("acme", "acme.env", ["acme-crm"])).toBeNull();
    // A less specific one keeps nothing of this project's, nor does itself.
    expect(secretFileRefusal("acme-crm", "acme-crm.env", ["acme", "acme-crm"])).toBeNull();
  });

  test("the list of the machine's files is the steward's", () => {
    // Read as text: dashboard/src/secrets/scope.ts imports dashboard/borrowed/, which git does not keep.
    const source = readFileSync(join(import.meta.dir, "..", "..", "dashboard", "src", "secrets", "scope.ts"), "utf8");
    const declared = /export const ROOT_FILES = (\[[^\]]*\]);/.exec(source)?.[1];
    expect(declared).toBeDefined();
    expect(JSON.parse(declared!)).toEqual([...MACHINE_FILES]);
  });
});

describe("who owns a declared file on the machine", () => {
  test("the reading names each file once, then its marker, or reads as nothing", () => {
    const names = ["shop.env", "shop-key.pem", "shop-old.env"];
    const command = secretOwnersCommand(names);
    expect(command.startsWith("sudo sh -c 'for f in shop.env shop-key.pem shop-old.env; do")).toBe(true);
    expect(() => secretOwnersCommand(["shop.env; reboot"])).toThrow("not a secret file's name");
    const read = readSecretOwners(`shop.env site-shop\nshop-key.pem other\nshop-old.env absent\n${OWNERS_DONE}\n`, names);
    expect(read).toEqual(
      new Map<string, SecretOwner>([
        ["shop.env", { kind: "file", owner: "site-shop" }],
        ["shop-key.pem", { kind: "other" }],
        ["shop-old.env", { kind: "absent" }],
      ]),
    );
    // A refused sudo prints nothing; a cut answer, a name twice or one not asked are no answer.
    expect(readSecretOwners("", names)).toBeNull();
    expect(readSecretOwners(`shop.env site-shop\n${OWNERS_DONE}\n`, names)).toBeNull();
    expect(readSecretOwners(`shop.env site-shop\nshop.env root\nshop-key.pem other\nshop-old.env absent\n${OWNERS_DONE}\n`, names)).toBeNull();
    expect(readSecretOwners(`cms.env site-cms\nshop.env site-shop\nshop-key.pem other\nshop-old.env absent\n${OWNERS_DONE}\n`, names)).toBeNull();
  });

  test("a project reads a file present on the machine only when its own account owns it", () => {
    expect(ownerRefusal("shop", "shop.env", { kind: "absent" })).toBeNull();
    expect(ownerRefusal("shop", "shop.env", { kind: "file", owner: "site-shop" })).toBeNull();
    expect(ownerRefusal("landing-mail", "landing-mail.env", { kind: "file", owner: "site-landing" })).toBe(
      "/etc/sitesolide/landing-mail.env is already on the machine and belongs to site-landing, not site-landing-mail: a project reads its own files alone",
    );
    expect(ownerRefusal("shop", "shop.env", { kind: "file", owner: "root" })).toContain("belongs to root");
    expect(ownerRefusal("shop", "shop.env", { kind: "other" })).toContain("is not a plain file");
    // The dashboard's hash is root's by design.
    expect(ownerRefusal("dashboard", "dashboard.env", { kind: "file", owner: "root" })).toBeNull();
    expect(ownerRefusal("dashboard", "dashboard-extra.env", { kind: "file", owner: "root" })).toContain("belongs to root");
  });
});
