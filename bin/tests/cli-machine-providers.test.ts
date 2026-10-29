import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { machine, PROVIDERS, type MachineDependencies } from "../cli/machine";
import type { OutputEvent } from "../cli/output";
import type { ProviderEntry, Workstation } from "../../clouds/src/provider";
import { eventOutput } from "../cli/remote";
import type { FakeProvider } from "../../clouds/fakes/fake-provider";

/**
 * `sitesolide machine create`, `list` and `destroy` through the command
 * itself, for every provider but Hetzner, which cli-machine.test.ts covers in
 * depth: each against its own local fake (clouds/fakes/<provider>.ts). What
 * is checked is what the command promises whatever the cloud: the order, the
 * labels, the waits, the account `next` names, a second run that writes
 * nothing, a destroy that leaves nothing of sitesolide's, and credentials that
 * never appear in anything printed. Each provider's own tests, in
 * provider-<name>.test.ts, check the rest against its API.
 */

const ED25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICezpiOyiQWMYqOeL4S4OgE0T7Fq2bLHWUJ1afO4cczN ada@workstation.test-zone.invalid";

/** The providers, by the name `--provider` takes, each with the module of its fake. */
const NAMES = ["digitalocean", "aws", "gcp", "azure", "vultr", "linode", "scaleway"] as const;

/** No provider CLI and no SSH agent; the key file opens without a passphrase, as ssh-keygen -y says. */
const nobody: Workstation = {
  environment: {},
  run: async (argv) => (argv[0] === "ssh-keygen" ? { code: 0, stdout: `${ED25519}\n`, stderr: "" } : { code: 127, stdout: "", stderr: "" }),
  readFile: () => null,
};

function fakeClock() {
  let now = Date.parse("2026-10-21T10:00:00Z");
  return { now: () => now, sleep: async (milliseconds: number) => void (now += milliseconds) };
}

type Run = { code: number; events: OutputEvent[]; text: string };

for (const name of NAMES) {
  describe(`machine --provider ${name}`, () => {
    let entry: ProviderEntry;
    let fake: FakeProvider;
    let home: string;
    const printed: string[] = [];

    beforeAll(async () => {
      entry = PROVIDERS[name]!;
      fake = ((await import(`../../clouds/fakes/${name}`)) as { createFake: () => FakeProvider }).createFake();
    });
    afterAll(() => {
      fake.stop();
      rmSync(home, { recursive: true, force: true });
    });
    beforeEach(() => {
      fake.reset();
      home = mkdtempSync(join(tmpdir(), `machine-${name}-`));
      mkdirSync(join(home, ".ssh"));
      writeFileSync(join(home, ".ssh", "id_ed25519.pub"), `${ED25519}\n`);
    });

    async function run(arguments_: string[], extra: Partial<MachineDependencies> = {}): Promise<Run> {
      const lines: string[] = [];
      const code = await machine(["machine", ...arguments_, "--provider", name, "--json"], {
        environment: fake.environment,
        home,
        output: eventOutput((line) => lines.push(line)),
        clock: fakeClock(),
        probe: async () => true,
        login: async () => true,
        workstation: nobody,
        interactive: false,
        ...extra,
      });
      printed.push(...lines);
      return { code, events: lines.map((line) => JSON.parse(line) as OutputEvent), text: lines.join("\n") };
    }

    // AWS's Query API posts its reads too: what counts there is the action.
    const action = (body: unknown): string => (typeof body === "string" ? (new URLSearchParams(body).get("Action") ?? "") : String((body as Record<string, unknown> | null)?.Action ?? ""));
    const writes = () => fake.requests.filter((request) => request.method !== "GET" && !/\/(oauth2|token)/.test(request.path) && !(name === "aws" && /^Describe/.test(action(request.body))));

    test("is registered, with its credentials, defaults and page", () => {
      expect(entry.name).toBe(name);
      expect(entry.credentials.length).toBeGreaterThan(0);
      expect(entry.docs).toBe(`docs/providers/${name}.md`);
      expect(entry.defaults({}).image).toBe("debian-13");
    });

    test("create, then a second create that writes nothing, then list, then destroy", async () => {
      const created = await run(["create", "--name", "web"]);
      const last = created.events.at(-1) as Extract<OutputEvent, { type: "result" }> & { machine: { name: string; managed: boolean; ipv4: string; login: string }; next: string; created: boolean };
      expect({ code: created.code, type: last.type }).toEqual({ code: 0, type: "result" });
      expect(last.created).toBe(true);
      expect(last.machine).toMatchObject({ name: "web", managed: true });
      expect(last.machine.ipv4).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(last.next).toStartWith(`sitesolide setup ${last.machine.login}@${last.machine.ipv4} `);
      if (last.machine.login !== "root") expect(last.next).toEndWith("--user deploy");

      const before = writes().length;
      const again = await run(["create", "--name", "web"]);
      expect(again.code).toBe(0);
      expect((again.events.at(-1) as unknown as { created: boolean }).created).toBe(false);
      expect(writes().length).toBe(before);

      const listed = await run(["list"]);
      expect((listed.events.at(-1) as unknown as { machines: { name: string }[] }).machines.map((machine) => machine.name)).toEqual(["web"]);

      const destroyed = await run(["destroy", "web", "--confirm", "web", "--delete-key"]);
      expect(destroyed.code).toBe(0);
      const after = await run(["list"]);
      expect((after.events.at(-1) as unknown as { machines: unknown[] }).machines).toEqual([]);
    });

    test("without credentials, refused before the API is asked anything, naming the variables", async () => {
      const bare = Object.fromEntries(Object.entries(fake.environment).filter(([variable]) => variable.startsWith("SITESOLIDE_")));
      const refused = await run(["list"], { environment: bare });
      expect(refused.code).toBe(1);
      const error = refused.events.at(-1) as Extract<OutputEvent, { type: "error" }>;
      expect(error.message).toContain(entry.credentials.find((field) => field.optional !== true)!.variable);
      expect(fake.requests).toEqual([]);
    });

    test("--backups is refused before anything when sitesolide does not turn them on there", async () => {
      if (entry.backups) return;
      const refused = await run(["create", "--name", "web", "--backups"]);
      expect(refused.code).toBe(1);
      expect(fake.requests).toEqual([]);
    });

    test("no credential ever appears in what was printed", () => {
      expect(printed.length).toBeGreaterThan(10);
      for (const secret of fake.secrets) expect(printed.filter((line) => line.includes(secret))).toEqual([]);
    });
  });
}
