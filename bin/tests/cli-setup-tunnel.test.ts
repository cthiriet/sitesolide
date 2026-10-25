import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSetupArguments, REFUSALS, runSetup, type SetupOptions } from "../cli/setup";
import { NO_CREDENTIALS_EXIT, tunnelTarget } from "../cli/tunnel";
import { startCloudflareMock, type CloudflareMock } from "./cloudflare-mock";
import { bench, EDGE, EMAIL, HOST, printed, TOKEN, ZONE, type Bench } from "./setup-fakes";

/**
 * `sitesolide setup --tunnel`, the whole sequence, against the model machine
 * of setup-fakes.ts and the Cloudflare mock: the tunnel's step where its
 * connection is needed, the zone's records proxied CNAMEs, the firewall
 * closed to the web, a machine behind a NAT accepted, and the tunnel's
 * secret out of every output. bin/cli/tunnel.ts's own pieces are
 * cli-tunnel.test.ts's.
 */

const ID = "6f1c2b8e-1d3a-4c5b-9e7f-0a1b2c3d4e5f";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const SECRET = "c2VjcmV0LW9mLXRoZS10dW5uZWwtZm9yLXRlc3RzLW9ubHktMTIzNA==";
const HOME_ADDRESS = "192.168.1.40";

const HOMES: string[] = [];
let mock: CloudflareMock | null = null;

afterEach(async () => {
  await mock?.stop();
  mock = null;
  for (const home of HOMES.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A workstation's home, with the credentials file cloudflared tunnel create would have written. */
function home(): { folder: string; credentials: string } {
  const folder = mkdtempSync(join(tmpdir(), "setup-tunnel-home-"));
  HOMES.push(folder);
  const credentials = join(folder, `${ID}.json`);
  writeFileSync(credentials, JSON.stringify({ AccountTag: ACCOUNT, TunnelSecret: SECRET, TunnelID: ID }));
  return { folder, credentials };
}

function options(host: string, ...extra: string[]): SetupOptions {
  const parsed = parseSetupArguments([`root@${host}`, "--zone", ZONE, "--email", EMAIL, ...extra]);
  if ("message" in parsed) throw new Error(parsed.message);
  return parsed;
}

/** A machine at home: a private address on its default route, reached as such from the workstation. */
const AT_HOME = {
  ssh: `192.168.1.20 50000 ${HOME_ADDRESS} 22`,
  route4: JSON.stringify([{ dst: "default", gateway: "192.168.1.1", dev: "eth0" }]),
  route6: "[]",
  addresses: JSON.stringify([{ ifname: "eth0", addr_info: [{ family: "inet", local: HOME_ADDRESS, scope: "global" }] }]),
};

function world(records: Parameters<typeof startCloudflareMock>[0]["records"] = []): { b: Bench; folder: string; credentials: string; mock: CloudflareMock } {
  mock = startCloudflareMock({ token: TOKEN, zones: [{ id: "zone-1", name: ZONE }], records });
  const { folder, credentials } = home();
  return { b: bench(mock, folder, { facts: AT_HOME }), folder, credentials, mock };
}

async function setup(b: Bench, given: SetupOptions) {
  const print = printed();
  const code = await runSetup(given, b.deps(print));
  return { code, print, statuses: print.checks.map((report) => `${report.step}:${report.status}`) };
}

describe("a machine at home, behind a NAT", () => {
  test("refused without a tunnel, as before", async () => {
    const { b } = world();
    const r = await setup(b, options(HOME_ADDRESS));
    expect(r.code).toBe(1);
    expect(r.print.errors[0]!.message).toBe(REFUSALS.privateAddress(HOME_ADDRESS).message);
    expect(r.print.errors[0]!.details.join("\n")).toContain("--tunnel");
  });

  test("installed through its tunnel: the step where the sites' addresses are first asked, the records proxied CNAMEs, ssh alone open", async () => {
    const { b, folder, credentials, mock: m } = world();
    const r = await setup(b, options(HOME_ADDRESS, "--tunnel", credentials));
    expect(r.print.errors).toEqual([]);
    expect(r.code).toBe(0);
    const steps = r.statuses.map((status) => status.split(":")[0]);
    // After the zone's policy, before the wait for the records and the first
    // script that asks a site's public address.
    expect(steps.indexOf("tunnel")).toBe(steps.indexOf("dns-leftovers") + 1);
    expect(steps.indexOf("resolution")).toBe(steps.indexOf("tunnel") + 1);
    expect(r.statuses).toContain("tunnel:ok");
    expect(r.print.checks[0]!.detail).toContain(`served through the tunnel ${ID}`);

    // The records, proxied CNAMEs to the tunnel, the bare zone's included.
    expect(m.records.map((record) => `${record.name} ${record.type} ${record.content} ${record.proxied}`).sort()).toEqual([
      `*.${ZONE} CNAME ${tunnelTarget(ID)} true`,
      `${ZONE} CNAME ${tunnelTarget(ID)} true`,
    ]);

    // The firewall: ssh alone, the web's ports closed.
    const firewall = b.machine.calls.find((call) => call.tag === "setup:firewall:run")!;
    expect(firewall.input).toContain(`for port in 22; do ufw allow`);
    expect(firewall.input).toContain(`for port in 80 443; do ufw delete allow`);

    // The credentials went to the machine once, in the tunnel's run, and nowhere else.
    const carrying = b.machine.calls.filter((call) => call.input.includes(SECRET));
    expect(carrying.map((call) => call.tag)).toEqual(["setup:tunnel:run"]);
    expect(r.print.everything()).not.toContain(SECRET);
    expect(r.print.everything()).not.toContain(ACCOUNT);
    for (const task of b.kit.tasks) expect(JSON.stringify(task.environment)).not.toContain(SECRET);

    // The configuration names the tunnel, and nothing of its credentials.
    const config = JSON.parse(readFileSync(join(folder, ".config", "sitesolide", "config.json"), "utf8"));
    expect(config).toEqual({ server: `deploy@${HOME_ADDRESS}`, zone: ZONE, email: EMAIL, tunnel: ID });
    expect(r.print.lines.join("\n")).toContain(`tunnel     ${ID}`);
  });

  test("run again with no --tunnel, the configuration's tunnel holds and nothing changes", async () => {
    const { b, credentials, mock: m } = world();
    expect((await setup(b, options(HOME_ADDRESS, "--tunnel", credentials))).code).toBe(0);
    const runs = b.machine.runs().length;
    const writes = m.writes().length;
    const again = await setup(b, options(HOME_ADDRESS));
    expect(again.print.errors).toEqual([]);
    expect(again.code).toBe(0);
    expect(again.statuses).toContain("tunnel:done");
    expect(again.statuses).toContain("dns:done");
    expect(b.machine.runs().length).toBe(runs);
    expect(m.writes().length).toBe(writes);
  });

  test("a tunnel named by its id takes the credentials the machine holds; holding none, the step says what to give", async () => {
    const { b } = world();
    b.machine.failing.add("setup:tunnel:run");
    b.machine.failingCode.set("setup:tunnel:run", NO_CREDENTIALS_EXIT);
    const r = await setup(b, options(HOME_ADDRESS, "--tunnel", ID));
    expect(r.code).toBe(1);
    expect(r.print.errors[0]!.message).toBe(`setup stopped at tunnel: the machine holds no credentials for the tunnel ${ID}`);
    expect(r.print.errors[0]!.details.join("\n")).toContain(`--tunnel ~/.cloudflared/${ID}.json`);
    const run = b.machine.calls.find((call) => call.tag === "setup:tunnel:run")!;
    expect(run.input).toContain(`/etc/cloudflared/${ID}.json`);
    // Resumed once the machine holds them: the run takes them.
    const again = await setup(b, options(HOME_ADDRESS, "--tunnel", ID));
    expect(again.code).toBe(0);
    expect(again.statuses).toContain("tunnel:ok");
  });

  test("records that point at a machine stop the dns step, and --dns-replace makes them the tunnel's", async () => {
    const { b, credentials, mock: m } = world([
      { type: "A", name: ZONE, content: HOST, proxied: false, ttl: 1 },
      { type: "A", name: `*.${ZONE}`, content: HOST, proxied: false, ttl: 1 },
    ]);
    const r = await setup(b, options(HOME_ADDRESS, "--tunnel", credentials));
    expect(r.code).toBe(1);
    expect(r.print.errors[0]!.message).toBe("setup stopped at dns: records that point elsewhere");
    expect(m.writes()).toEqual([]);
    const replaced = await setup(b, options(HOME_ADDRESS, "--tunnel", credentials, "--dns-replace"));
    expect(replaced.code).toBe(0);
    expect(m.records.map((record) => record.type)).toEqual(["CNAME", "CNAME"]);
  });

  test("under --skip-dns, the two CNAMEs are listed, and the wait accepts the edge's answer", async () => {
    const { b, credentials, mock: m } = world();
    // Made by hand meanwhile, as the list asks.
    m.records.push({ id: "hand-1", type: "CNAME", name: ZONE, content: tunnelTarget(ID), proxied: true, ttl: 1 }, { id: "hand-2", type: "CNAME", name: `*.${ZONE}`, content: tunnelTarget(ID), proxied: true, ttl: 1 });
    const r = await setup(b, options(HOME_ADDRESS, "--tunnel", credentials, "--skip-dns"));
    expect(r.code).toBe(0);
    const listed = r.print.lines.filter((line) => line.includes("CNAME"));
    expect(listed).toHaveLength(2);
    expect(listed.every((line) => line.includes(`${tunnelTarget(ID)}   proxied`))).toBe(true);
    expect(await b.resolver.resolve(`x.${ZONE}`)).toEqual({ ipv4: [EDGE.ipv4], ipv6: [EDGE.ipv6] });
    expect(r.statuses).toContain("resolution:done");
  });
});

describe("what --tunnel refuses before anything leaves the workstation", () => {
  test("a zone whose DNS is not Cloudflare's", () => {
    const parsed = parseSetupArguments([`root@${HOME_ADDRESS}`, "--zone", ZONE, "--email", EMAIL, "--tunnel", ID, "--dns", "route53"]);
    expect(parsed).toEqual(REFUSALS.tunnelDns("route53"));
    expect(parseSetupArguments([`root@${HOME_ADDRESS}`, "--zone", ZONE, "--email", EMAIL, "--tunnel", ID, "--dns", "manual"])).toEqual(REFUSALS.tunnelDns("manual"));
  });

  test("a file it cannot read, or one that holds no tunnel's credentials, without a word of what it holds", async () => {
    const { b, folder } = world();
    const missing = await setup(b, options(HOME_ADDRESS, "--tunnel", join(folder, "absent.json")));
    expect(missing.code).toBe(1);
    expect(missing.print.errors[0]!.message).toContain("cannot read the tunnel's credentials");
    const wrong = join(folder, "wrong.json");
    writeFileSync(wrong, JSON.stringify({ AccountTag: ACCOUNT, TunnelSecret: SECRET }));
    const refused = await setup(b, options(HOME_ADDRESS, "--tunnel", wrong));
    expect(refused.code).toBe(1);
    expect(refused.print.errors[0]!.message).toContain("is not a tunnel's credentials: its TunnelID is missing");
    expect(refused.print.everything()).not.toContain(SECRET);
    // Nothing reached the machine.
    expect(b.machine.calls).toEqual([]);
  });
});
