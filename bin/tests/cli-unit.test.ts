import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { knownManifests } from "./manifests";
import { isApp, type Manifest } from "../cli/manifest";
import {
  projectPaths,
  decideUnit,
  generateUnit,
  readUnitAnswer,
  MARKER_ABSENT,
  MARKER_PRESENT,
  substitute,
  systemUser,
} from "../cli/unit";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const APP: Manifest = { slug: "budget", port: 3022, start: "/usr/local/bin/bun run server.ts" };

/**
 * A unit actually in service, if there is one.
 *
 * The confinement test bears on the list below, which is the reference. A unit
 * generated from a real manifest adds a second witness to it: a manifest can
 * carry what the sample below does not, and the directives must hold there too.
 */
const WITNESS = knownManifests().find((manifest) => isApp(manifest));
const IN_SERVICE = WITNESS === undefined ? null : generateUnit(WITNESS);

const CONFINEMENT = [
  "NoNewPrivileges=true",
  "PrivateTmp=true",
  "PrivateDevices=true",
  "ProtectSystem=strict",
  "ProtectHome=true",
  "TemporaryFileSystem=/srv:ro",
  "ProtectKernelTunables=true",
  "ProtectKernelModules=true",
  "ProtectControlGroups=true",
  "RestrictNamespaces=true",
  "RestrictSUIDSGID=true",
  "RestrictRealtime=true",
  "LockPersonality=true",
  "UMask=0077",
];

describe("confinement", () => {
  test.skipIf(IN_SERVICE === null)("a unit generated from a real manifest carries the directives this test watches", () => {
    // Without this check, a directive renamed in systemd would make the list
    // below obsolete without anything saying so. It only runs where a unit has
    // already been deposited: a fresh install has none, and the list then
    // remains the only reference.
    //
    // PrivateDevices is set aside: a unit may remove it on purpose, saying
    // why, when its service needs a device.
    for (const directive of CONFINEMENT) {
      if (directive === "PrivateDevices=true") continue;
      expect(IN_SERVICE as string).toInclude(directive);
    }
  });

  test.each(CONFINEMENT)("the generated unit carries %s", (directive) => {
    expect(generateUnit(APP)).toInclude(directive);
  });

  test("the service only writes in its own data folder", () => {
    const unit = generateUnit(APP);
    const paths = projectPaths("budget");
    expect(unit).toInclude(`ReadWritePaths=${paths.dataDir}`);
    expect(unit).toInclude(`BindReadOnlyPaths=${paths.app}`);
    expect(unit).toInclude(`BindReadOnlyPaths=${paths.publicDir}`);
    expect(unit).toInclude(`BindPaths=${paths.dataDir}`);
  });

  test("does not re-expose any other project under /srv", () => {
    const unit = generateUnit(APP);
    for (const line of unit.split("\n")) {
      if (!line.startsWith("Bind")) continue;
      expect(line).toInclude("/srv/sites/budget/");
    }
  });

  test("runs under its own user, never root", () => {
    const unit = generateUnit(APP);
    expect(unit).toInclude(`User=${systemUser("budget")}`);
    expect(unit).not.toInclude("User=root");
  });
});

describe("memory", () => {
  test("MemoryMax is never left out", () => {
    // The machine has no swap: without a ceiling per service, a saturation
    // hands the whole machine over to the OOM killer instead of the culprit
    // alone.
    expect(generateUnit(APP)).toInclude("MemoryMax=256M");
  });

  test("the manifest can raise the ceiling", () => {
    expect(generateUnit({ ...APP, memory: "512M" })).toInclude("MemoryMax=512M");
  });
});

describe("network", () => {
  test("closed by default", () => {
    const unit = generateUnit(APP);
    expect(unit).toInclude("IPAddressDeny=any");
    expect(unit).toInclude("IPAddressAllow=localhost");
  });

  test("outbound lifts the network confinement, and only that", () => {
    const unit = generateUnit({ ...APP, network: "outbound" });
    expect(unit).not.toInclude("IPAddressDeny=any");
    // Everything else holds.
    for (const directive of CONFINEMENT) expect(unit).toInclude(directive);
  });
});

describe("secrets", () => {
  test("without a secret, the whole folder is closed to the service", () => {
    // Without this line, a service can list /etc/sitesolide and learn which
    // other sites have credentials.
    expect(generateUnit(APP)).toInclude("InaccessiblePaths=-/etc/sitesolide");
  });

  test("with a secret, the file is loaded and the directive removed", () => {
    const unit = generateUnit({ ...APP, secrets: ["budget.env"] });
    expect(unit).toInclude("EnvironmentFile=-/etc/sitesolide/budget.env");
    expect(unit).not.toInclude("InaccessiblePaths=-/etc/sitesolide");
  });

  test("the dash of EnvironmentFile is kept", () => {
    // Without it, a missing file makes the start fail and Restart=always makes
    // it loop. It is bin/sitesolide.ts that then refuses to restart.
    const unit = generateUnit({ ...APP, secrets: ["budget.env"] });
    expect(unit).toInclude("EnvironmentFile=-");
  });

});

describe("start-up", () => {
  test("the manifest's command is the one systemd executes", () => {
    const unit = generateUnit({ ...APP, start: ".venv/bin/python -m uvicorn app:api" });
    expect(unit).toInclude("ExecStart=.venv/bin/python -m uvicorn app:api");
  });

  test("the port and the folders arrive through the environment", () => {
    const unit = generateUnit(APP);
    expect(unit).toInclude("Environment=PORT=3022");
    expect(unit).toInclude("Environment=DATA_DIR=/srv/sites/budget/data");
    expect(unit).toInclude("Environment=PUBLIC_DIR=/srv/sites/budget/public");
  });
});

describe("declared variables and description", () => {
  test("the manifest's variables add to the three already laid", () => {
    const unit = generateUnit({ ...APP, env: { NODE_ENV: "production" } });
    expect(unit).toInclude("Environment=NODE_ENV=production");
    expect(unit).toInclude("Environment=PORT=3022");
  });

  test("the description replaces the default label", () => {
    // This is what `systemctl status` displays: without the field, a generated
    // unit would lose the little that the hand written one said.
    expect(generateUnit({ ...APP, description: "Booking tool" })).toInclude(
      "Description=Booking tool",
    );
    expect(generateUnit(APP)).toInclude("Description=Project budget");
  });
});

/**
 * What `deploy` does with a project's unit, tried without a machine.
 *
 * The decision carries all the risk of the single command: `deploy` now lays
 * the unit itself, and nothing must be able to make it replace the one that
 * keeps a service running. It happened once the other way round, with a Caddy
 * fragment laid too early on 19 August 2026.
 */
describe("what deploy does with the unit", () => {
  const GENERATED = generateUnit(APP);

  test("absent from the machine: it is laid down", () => {
    expect(decideUnit({ installed: "", generated: GENERATED, replace: false })).toBe("install");
  });

  test("a file of nothing but whitespace counts as absent", () => {
    expect(decideUnit({ installed: "\n  \n", generated: GENERATED, replace: false })).toBe(
      "install",
    );
  });

  test("identical: nothing is deposited, nothing is reloaded", () => {
    // This is what makes `deploy` idempotent: the second pass touches neither
    // systemd nor the file.
    expect(
      decideUnit({ installed: GENERATED, generated: GENERATED, replace: false }),
    ).toBe("present");
  });

  test("different: reported and left in place", () => {
    // A unit in service may remove PrivateDevices on purpose, saying why: a
    // deployment that replaced it would cut off the microphone without anyone
    // having asked for it.
    const handWritten = GENERATED.replace("PrivateDevices=true\n", "");
    expect(decideUnit({ installed: handWritten, generated: GENERATED, replace: false })).toBe(
      "diverged",
    );
  });

  test("--force is the only gesture that switches to the generated one", () => {
    const handWritten = GENERATED.replace("PrivateDevices=true\n", "");
    expect(decideUnit({ installed: handWritten, generated: GENERATED, replace: true })).toBe(
      "install",
    );
  });

  test("--force on an identical unit deposits nothing again", () => {
    expect(decideUnit({ installed: GENERATED, generated: GENERATED, replace: true })).toBe(
      "present",
    );
  });
});

/**
 * The reading of the unit laid on the machine. It is through it that `deploy`
 * knows whether it is dealing with a first pass, so it decides what it
 * replaces.
 */
describe("what the machine answers about its unit", () => {
  test("the absence marker is recognised", () => {
    expect(readUnitAnswer(`${MARKER_ABSENT}\n`)).toEqual({ kind: "absent" });
  });

  test("the file comes after the marker, as it is", () => {
    const unit = generateUnit(APP);
    const reading = readUnitAnswer(`${MARKER_PRESENT}\n${unit}`);
    expect(reading).toEqual({ kind: "present", content: unit });
    // The comparison that follows is exact: one character added or removed
    // here would make an identical unit look different, at every deployment.
    if (reading.kind !== "present") return;
    expect(decideUnit({ installed: reading.content, generated: unit, replace: false })).toBe(
      "present",
    );
  });

  test("an empty output is never an absence", () => {
    // A refused sudo gives back the same emptiness as a non existent file:
    // confusing them would replace a hand written unit with the generated one,
    // silently.
    expect(readUnitAnswer("")).toEqual({ kind: "unreadable" });
    expect(readUnitAnswer("sudo: a password is required\n")).toEqual({ kind: "unreadable" });
  });

  test("an empty but present unit is not an absence", () => {
    // The marker comes first rather than in place of an empty output,
    // precisely for this case.
    expect(readUnitAnswer(`${MARKER_PRESENT}\n`)).toEqual({ kind: "present", content: "" });
  });
});

describe("placeholders", () => {
  const WITH = { slug: "budget", zone: "test-zone.invalid", contact: "me@test-zone.invalid" };

  test("each placeholder takes its value", () => {
    expect(substitute("https://{slug}.{zone}", WITH)).toBe("https://budget.test-zone.invalid");
    expect(substitute("{contact}", WITH)).toBe("me@test-zone.invalid");
  });

  test("an empty zone stays visible rather than making a wrong address", () => {
    // https://budget. would read as an address, and nothing would say it is
    // wrong; {zone} left in place says a setting is missing.
    expect(substitute("https://{slug}.{zone}", { ...WITH, zone: "" })).toBe("https://budget.{zone}");
  });

  test("an empty contact is an answer, not a gap", () => {
    // The contact is optional. Left as {contact}, the portal received a value
    // and the door page of a locked preview offered to write to "{contact}".
    expect(substitute("{contact}", { ...WITH, contact: "" })).toBe("");
  });

  test("a unit generated without a contact carries an empty variable", () => {
    const unit = generateUnit(
      { ...APP, env: { SITESOLIDE_CONTACT: "{contact}" } },
      { slug: "budget", zone: "test-zone.invalid", contact: "" },
    );
    expect(unit).toContain("Environment=SITESOLIDE_CONTACT=\n");
    expect(unit).not.toContain("{contact}");
  });
});
