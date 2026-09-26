import { describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { REPO, run } from "./run";

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
 * The first level touches neither systemd nor Caddy: it creates a folder under
 * /srv/sites and deposits files there, which the *.test-zone.invalid block
 * already serves by naming convention. No reload, no service, no risk for the
 * sites in place.
 *
 * The second one lays a systemd unit and a Caddy fragment, so it touches the
 * shared configuration: it goes through bin/deploy-caddy.sh, which backs up,
 * validates and restores at the slightest misstep, but it is still to be run
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
    "a first deploy lays the user and the unit before the Caddy fragment",
    async () => {
      // The trace is erased first: what is measured is what this deployment
      // writes, not what a previous one had left. It used to be the test of
      // `sitesolide init`, removed on 28 August 2026: the command no longer
      // exists, the order it protected is still there, and it now lives inside
      // `deploy`.
      const trace = resolve(REPO, "infra", "projects", "sample-bun");
      rmSync(trace, { recursive: true, force: true });

      const r = await run("projects/bun-mixed", ["deploy"]);
      expect(r.code).toBe(0);
      expect(r.output).toContain("https://sample-bun.test-zone.invalid/ 200");

      // The fragment comes after the service, never before. Laid too early, it
      // would be picked up by the first bin/deploy-caddy.sh to come along,
      // including the one of ANOTHER project, and would deposit a block
      // proxying towards a port where nothing listens. Measured on 19 August
      // 2026: sample-secret, refused in the middle of its deployment for want
      // of a secret, still had its block in service, answering 502.
      const unit = r.output.indexOf("systemd unit");
      const service = r.output.indexOf("service restart");
      const fragment = r.output.indexOf("Caddy fragment");
      expect(unit).toBeGreaterThan(-1);
      expect(service).toBeGreaterThan(unit);
      expect(fragment).toBeGreaterThan(service);

      expect(readdirSync(trace).sort()).toEqual(["sample-bun.caddy", "sample-bun.service"]);
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
      expect(r.output).toContain("unchanged  /etc/systemd/system/sample-bun.service");
      expect(r.output).not.toContain("install the unit");
      expect(r.all).not.toContain("daemon-reload");
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
 * It is the reason for the preparation made by `deploy`. It is measured here
 * and nowhere else: in a dry run, no reading is done on the VM, so nothing
 * says whether the unit was really missing.
 *
 * The clean-up is the one from this folder's README, to be run afterwards.
 */
describe.skipIf(!VM || !APP)("first pass, with nothing prepared", () => {
  test(
    "deploy lays the user, the unit, the code and the fragment",
    async () => {
      const trace = resolve(REPO, "infra", "projects", "sample-api");
      rmSync(trace, { recursive: true, force: true });

      const r = await run("projects/fastapi-app", ["deploy"]);
      expect(r.code).toBe(0);
      expect(r.output).toContain("system user and directories");
      expect(r.output).toContain("install the unit");
      expect(r.output).toContain("https://sample-api.test-zone.invalid/ 200");

      // The trace of what the machine executes stays in the repository, even
      // for a project whose code lives elsewhere. The fragment is only written
      // there after the service has started, by deploy: both files are
      // therefore present.
      expect(readdirSync(trace).sort()).toEqual(["sample-api.caddy", "sample-api.service"]);
    },
    240000,
  );

  test(
    "the same deploy run again changes nothing any more",
    async () => {
      const r = await run("projects/fastapi-app", ["deploy"]);
      expect(r.code).toBe(0);
      expect(r.output).toContain("unchanged  /etc/systemd/system/sample-api.service");
      expect(r.output).not.toContain("install the unit");
    },
    240000,
  );
});

/**
 * A secret in place, against the machine. The `sample-secret` project carries a
 * file in /etc/sitesolide and a service that reads it; it is the only place
 * where the presence reading is measured, which the dry run mode never does.
 *
 * The VM is the authority: a secret present on the machine is left as it is,
 * and one that is missing stops the deployment with the dashboard to create it
 * in. The file is created on the machine beforehand, as the dashboard would.
 */
describe.skipIf(!VM || !APP)("a secret in place", () => {
  test(
    "deploy checks it is there, and pushes nothing",
    async () => {
      const r = await run("projects/api-with-secret", ["deploy"]);
      expect(r.code).toBe(0);
      expect(r.output).toContain("present  /etc/sitesolide/sample-secret.env");
      expect(r.error).not.toContain("read refused");
    },
    180000,
  );

  test(
    "run again, deploy finds it present and pushes nothing",
    async () => {
      const r = await run("projects/api-with-secret", ["deploy"]);
      expect(r.code).toBe(0);
      expect(r.output).toContain("present  /etc/sitesolide/sample-secret.env");
      expect(r.all).not.toContain("from the vault");
      expect(r.all).not.toContain("cannot tell whether");
    },
    180000,
  );
});
