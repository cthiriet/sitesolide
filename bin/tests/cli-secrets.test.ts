import { describe, expect, test } from "bun:test";
import { dashboardAddress, decideSecret, readPresenceAnswer } from "../cli/secrets";
import { MARKER_ABSENT, MARKER_PRESENT } from "../cli/unit";

/**
 * What decides the fate of a secret, tried without a machine: the function
 * only receives a presence, and gives back an action.
 *
 * The rule held here is the one that costs the most to break: **the VM is the
 * authority**. `/etc/sitesolide` is managed from the *Secrets* section of the
 * dashboard, and `deploy` never pushes a secret: a deployment that replaced a
 * value laid down there would put back in service a key that has just been
 * changed, without any error saying so.
 */

/** The dashboard these tests aim at: a reserved zone, which resolves nowhere. */
const DASHBOARD_URL = dashboardAddress("test-zone.invalid");

describe("present on the VM", () => {
  test("nothing to do: the machine has the right one", () => {
    expect(decideSecret({ name: "calendar.env", onServer: true }, DASHBOARD_URL)).toEqual({ kind: "present" });
  });
});

describe("absent from the VM", () => {
  const refusal = decideSecret({ name: "calendar.env", onServer: false }, DASHBOARD_URL);

  test("refused, because the service would start up silently", () => {
    expect(refusal.kind).toBe("rejects");
    if (refusal.kind !== "rejects") return;
    expect(refusal.message).toBe("secret missing on the server: /etc/sitesolide/calendar.env");
    expect(refusal.details.join("\n")).toContain("silently");
  });

  test("the refusal points to the dashboard's Secrets section, then to deploy", () => {
    if (refusal.kind !== "rejects") throw new Error("expected a refusal");
    const text = refusal.details.join("\n");
    expect(text).toContain(`Secrets section of ${DASHBOARD_URL}`);
    expect(text).toContain("sitesolide deploy again");
  });

  test("nothing is ever pushed from the workstation", () => {
    // There used to be a third answer, `deposit`, fed from a copy of every
    // secret kept on the workstation. The decision has two answers now, and
    // neither sends anything.
    for (const onServer of [true, false]) {
      expect(["present", "rejects"]).toContain(decideSecret({ name: "calendar.env", onServer }, DASHBOARD_URL).kind);
    }
  });

  test("the refusal follows the dashboard address it is given", () => {
    const elsewhere = decideSecret({ name: "calendar.env", onServer: false }, dashboardAddress("other.test"));
    if (elsewhere.kind !== "rejects") throw new Error("expected a refusal");
    expect(elsewhere.details.join("\n")).toContain("https://dashboard.other.test");
  });
});

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
