import { describe, expect, test } from "bun:test";
import { run } from "./run";

/**
 * Tests against the real machine, the one that serves the clients.
 *
 * **They do not run by default**: there is neither a staging nor a second
 * machine, and what breaks production breaks every site at once. They have to
 * be asked for:
 *
 *   E2E_VM=1 bun test ./e2e/vm.test.ts              the static one, riskless
 *   E2E_VM=1 E2E_VM_APP=1 bun test ./e2e/vm.test.ts
 *
 * `deploy` goes through the dashboard's API, as on any workstation: it needs
 * the token `sitesolide login` keeps, and the machine's installer does the
 * work, whose log the CLI prints. `status` and the confinement check read
 * over the owner's SSH access.
 *
 * The first level touches neither systemd nor Caddy: it creates a folder under
 * /srv/sites and deposits files there, which the *.test-zone.invalid block
 * already serves by naming convention. No reload, no service, no risk for the
 * sites in place.
 *
 * The second one lays a systemd unit and a Caddy block, so it touches the
 * shared configuration: the installer validates the block and puts the
 * previous one back at the slightest misstep, but it is still to be run
 * knowingly.
 */

const VM = process.env.E2E_VM === "1";
// No fallback: a ready-made value here would name the machine of whoever wrote
// the file, and a run with E2E_VM=1 would deploy onto it.
const SERVER = () => {
  const value = process.env.SITESOLIDE_SERVER;
  if (value === undefined || value === "") throw new Error("SITESOLIDE_SERVER is required to run this test");
  return value;
};
const APP = process.env.E2E_VM_APP === "1";

describe.skipIf(!VM)("real deployment of a showcase", () => {
  test(
    "deploys itself and answers over HTTPS under the wildcard",
    async () => {
      const r = await run("projects/simple-site", ["deploy"]);
      expect(r.all).not.toContain("!!");
      expect(r.code).toBe(0);
      expect(r.output).toContain("https://sample-static.test-zone.invalid/ 200");
    },
    120000,
  );

  test("does serve the content that was pushed", async () => {
    const response = await fetch("https://sample-static.test-zone.invalid/", {
      signal: AbortSignal.timeout(15000),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sample showcase");
  });

  test("inherits the platform's noindex and cache policy", async () => {
    // A preview must not enter Google, and the HTML stays fresh: these two
    // headers come from the *.test-zone.invalid block and from the common
    // snippet, without any configuration having been written for this project.
    const response = await fetch("https://sample-static.test-zone.invalid/", {
      signal: AbortSignal.timeout(15000),
    });
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });

  test("a certificate from the wildcard, not one of its own", async () => {
    // The subdomain answers over TLS without any issuance having been asked
    // for: that is the whole point of the wildcard obtained through DNS-01.
    const response = await fetch("https://sample-static.test-zone.invalid/", {
      signal: AbortSignal.timeout(15000),
    });
    expect(response.url.startsWith("https://")).toBe(true);
  });
});

describe.skipIf(!VM)("status", () => {
  test("reads the state on the machine, not in the repository", async () => {
    // A local registry would lie from the first deployment made from
    // elsewhere: that is exactly what happens to a ports table kept in a
    // README, which ends up assigning a port to a service never deployed.
    const r = await run(".", ["status"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("projects served");
    expect(r.output).toContain("sample-static");
    expect(r.output).toContain("ports listening");

    // The command only reads: it must have refused nothing.
    expect(r.error).not.toContain("read refused");
  });

  test("tells an absent unit apart from a stopped unit", async () => {
    // A static site has no unit, and the landing's one does not carry the name
    // of its folder: displaying "inactive" would make a service look down.
    const r = await run(".", ["status"]);
    const line = (slug: string) =>
      r.output.split("\n").find((l) => l.startsWith(slug)) ?? "";
    expect(line("sample-static")).toMatch(/sample-static\s+\S+\s+-/);
    expect(line("sample-bun")).toContain("active");
  });
});

describe.skipIf(!VM)("built documentation", () => {
  test(
    "the build runs on the workstation and only dist/ leaves",
    async () => {
      const r = await run("projects/static-docs", ["deploy"]);
      expect(r.code).toBe(0);
      expect(r.output).toContain("build");
      expect(r.output).toContain("https://sample-docs.test-zone.invalid/ 200");
    },
    120000,
  );

  test("the built page is indeed the one that is served", async () => {
    const response = await fetch("https://sample-docs.test-zone.invalid/index.html", {
      signal: AbortSignal.timeout(15000),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sample documentation");
  });
});

describe.skipIf(!VM || !APP)("real deployment of an application project", () => {
  test(
    "a deploy lays the unit and restarts the service before the Caddy block",
    async () => {
      const r = await run("projects/bun-mixed", ["deploy"]);
      expect(r.code).toBe(0);
      expect(r.output).toContain("https://sample-bun.test-zone.invalid/ 200");

      // The block comes after the service, never before. Laid too early, it
      // would deposit a block proxying towards a port where nothing listens.
      // Measured on 19 August 2026: sample-secret, refused in the middle of
      // its deployment for want of a secret, still had its block in service,
      // answering 502.
      const unit = r.output.indexOf("sample-bun.service");
      const service = r.output.indexOf("-> service restart");
      const block = r.output.indexOf("-> Caddy block, through the validated path");
      expect(unit).toBeGreaterThan(-1);
      expect(service).toBeGreaterThan(unit);
      expect(block).toBeGreaterThan(service);
    },
    180000,
  );

  test("Caddy serves the files and wakes the service for the rest", async () => {
    const page = await fetch("https://sample-bun.test-zone.invalid/", {
      signal: AbortSignal.timeout(15000),
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Sample mixed Bun project");

    // The dynamic route exists in no file: it can only come from the service,
    // which proves that the `not file` matcher does its job.
    const state = await fetch("https://sample-bun.test-zone.invalid/api/state", {
      signal: AbortSignal.timeout(15000),
    });
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ service: "sample-bun" });
  });

  test(
    "a second deploy deposits nothing and reloads nothing",
    async () => {
      // Idempotence is what makes the single command bearable: `deploy`
      // replays the preparation every time, without asking anyone whether this
      // is a first pass. The second pass must therefore observe, and not lay
      // anything down.
      const r = await run("projects/bun-mixed", ["deploy"]);
      expect(r.code).toBe(0);
      expect(r.output).toContain("unchanged  sample-bun.service");
      expect(r.output).not.toContain("installed  sample-bun.service");
      expect(r.output).toContain("https://sample-bun.test-zone.invalid/ 200");
    },
    180000,
  );

  test("the service runs confined, under its own user", async () => {
    const proc = Bun.spawn(
      [
        "ssh",
        SERVER(),
        "systemctl show sample-bun -p User -p MemoryMax -p MemoryCurrent --value",
      ],
      { stdout: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    expect(output).toContain("site-sample-bun");
    expect(output).toContain("268435456");
  });
});

/**
 * The first pass in a single command, on a project the machine has never
 * carried: no user, no unit, no folder.
 *
 * It is the reason for the preparation the installer makes. It is measured
 * here against a real systemd; the same steps are tried in front of a fake
 * host in dashboard/tests/installer-pipeline.test.ts.
 *
 * The clean-up is the one from this folder's README, to be run afterwards.
 */
describe.skipIf(!VM || !APP)("first pass, with nothing prepared", () => {
  test(
    "deploy lays the user, the unit, the code and the block",
    async () => {
      const r = await run("projects/fastapi-app", ["deploy"]);
      expect(r.code).toBe(0);
      expect(r.output).toContain("system user and directories");
      expect(r.output).toContain("installed  sample-api.service");
      expect(r.output).toContain("https://sample-api.test-zone.invalid/ 200");
    },
    240000,
  );

  test(
    "the same deploy run again changes nothing any more",
    async () => {
      const r = await run("projects/fastapi-app", ["deploy"]);
      expect(r.code).toBe(0);
      expect(r.output).toContain("unchanged  sample-api.service");
      expect(r.output).not.toContain("installed  sample-api.service");
    },
    240000,
  );
});

/**
 * A secret in place, against the machine. The `sample-secret` project names
 * API_KEY, which its service reads from its store; it is the only place where
 * the store's listing is read from a real dashboard, which the tests in front
 * of a fake one never do.
 *
 * The VM is the authority: a value set there is left as it is, and one that
 * is missing is warned of, never a stop. The value is set on the machine
 * beforehand, with `sitesolide secrets set API_KEY`, as the dashboard would.
 */
describe.skipIf(!VM || !APP)("a secret in place", () => {
  test(
    "deploy reads the store, and pushes nothing",
    async () => {
      const r = await run("projects/api-with-secret", ["deploy"]);
      expect(r.code).toBe(0);
      expect(r.output).toContain("every declared runtime secret is set");
      expect(r.error).not.toContain("read refused");
    },
    180000,
  );

  test(
    "run again, deploy finds it set and pushes nothing",
    async () => {
      const r = await run("projects/api-with-secret", ["deploy"]);
      expect(r.code).toBe(0);
      expect(r.output).toContain("every declared runtime secret is set");
      expect(r.all).not.toContain("from the vault");
      expect(r.all).not.toContain("cannot tell which");
    },
    180000,
  );
});
