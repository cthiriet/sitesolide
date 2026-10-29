import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMOTE_HINTS } from "../cli/hints";
import { machine } from "../cli/machine";
import { eventOutput } from "../cli/remote";
import { createFakeGcp, type FakeGcp } from "../../clouds/fakes/gcp";

/**
 * `sitesolide machine create --provider gcp`, against the local fake of
 * Compute Engine (clouds/fakes/gcp.ts): what the command refuses before the
 * provider is opened. The provider's own tests are in clouds/tests/gcp.test.ts.
 */

/** Generated for these tests with ssh-keygen; the private half was deleted at once. */
const ED25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICezpiOyiQWMYqOeL4S4OgE0T7Fq2bLHWUJ1afO4cczN ada@workstation.test-zone.invalid";

let fake: FakeGcp;

beforeAll(() => {
  fake = createFakeGcp();
});

afterAll(() => {
  fake.stop();
});

test("a name Google Cloud would not take is refused before anything leaves", async () => {
  const home = mkdtempSync(join(tmpdir(), "machine-gcp-"));
  try {
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "id_ed25519.pub"), `${ED25519}\n`);
    const out: string[] = [];
    let now = Date.parse("2026-10-21T10:00:00Z");
    const code = await machine(["machine", "create", "--provider", "gcp", "--name", "1web", "--json"], {
      environment: fake.environment,
      home,
      output: eventOutput((line) => out.push(line)),
      clock: { now: () => now, sleep: async (milliseconds) => void (now += milliseconds) },
      workstation: { environment: {}, run: async () => ({ code: 127, stdout: "", stderr: "" }), readFile: () => null },
      interactive: false,
    });
    expect(code).toBe(1);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ type: "error", message: "Google Cloud would not take the name 1web: a name there starts with a letter", hint: REMOTE_HINTS["machine-name"]! });
    expect(fake.requests).toEqual([]);
    for (const value of fake.secrets) expect(out.join("\n")).not.toContain(value);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
