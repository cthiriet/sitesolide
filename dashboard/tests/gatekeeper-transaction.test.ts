import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateFragment } from "../borrowed/fragment";
import { readManifest, type Manifest } from "../borrowed/manifest";
import { fragmentIsProtected } from "../borrowed/portal";
import { MESSAGE_MAX } from "../src/secrets/portal";
import { MAX_PORTAL_MS } from "../src/secrets/protocol";
import { buildFragment, cookieName, installedCode } from "../borrowed/locks";
import { DOOR_PAGE_MARKER } from "../borrowed/page";
import type { Action } from "../src/gatekeeper/instance";
import type { Command, Permissions, GeneralMachine, ManifestRead } from "../src/gatekeeper/machine";
import { redact } from "../src/gatekeeper/real";
import type { ProbeResponse } from "../src/gatekeeper/probe";
import {
  TIMEOUTS,
  MARGIN_MS,
  boundMessage,
  run,
  caddyExtract,
  interruptedMessage,
  lockHeldMessage,
  worstDuration,
  type Result,
} from "../src/gatekeeper/transaction";

/**
 * The transaction against a simulated machine: every step can fail, and on
 * every failure the machine has to come back to the state it was in before,
 * Caddy included. The model of Caddy is minimal: it serves the block and the
 * preview locks read at its last successful reload; the site aimed at answers
 * through the portal if that block carries the guard, and with the door page,
 * a 401 that is not the portal's, if a stanza of the locks names it, unless
 * the request carries the stanza's code in its cookie.
 */

const ZONE = "test-zone.invalid";
const PERMISSIONS: Permissions = { uid: 1000, gid: 1000, mode: 0o644 };

function text(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const OPEN = text({
  slug: "library",
  port: 3044,
  publicDir: "public",
  start: "/usr/local/bin/bun run server.ts",
  routes: ["/api/*"],
});
const CLOSED = text({
  slug: "cms",
  port: 3048,
  publicDir: "public",
  start: "/usr/local/bin/bun run server.ts",
  routes: ["/", "/hooks/*"],
  portal: true,
  portalExempt: ["/hooks/*"],
});

function blockOf(raw: string): string {
  return generateFragment(readManifest(raw).manifest!)!;
}

const OK: ProbeResponse = { code: 200, door: false, body: "" };
const DOOR: ProbeResponse = { code: 401, door: true, body: "<html>" };
/** The door page of a site that opens with a code: a 401 the portal did not write. */
const DOOR_PAGE: ProbeResponse = { code: 401, door: false, body: "<html>" };

/** Codes the tests draw, never one a draw could give by chance in another test. */
const CODE = "K7M2PQ";
const NEW_CODE = "W4XN8R";

/** The locks' fragment as the generator writes it, for these sites and codes. */
function locksFor(sites: Record<string, string>): string {
  return buildFragment(Object.entries(sites).map(([slug, code]) => ({ slug, host: `${slug}.${ZONE}`, lock: true, code })));
}

type Counter = (n: number) => boolean;

type Options = {
  slug?: string;
  manifest?: string | null;
  block?: string | null;
  /** Caddy's lock held by someone else. */
  lockHeld?: { who: string | null; since: number };
  lockRaised?: boolean;
  interrupted?: string;
  interruptedRaised?: boolean;
  sites?: string[];
  /** The calls that fail, numbered from 1. */
  validate?: Counter;
  reload?: Counter;
  start?: Counter;
  active?: Counter;
  writeManifest?: Counter;
  writeBlock?: Counter;
  saveBackup?: boolean;
  backupClearRaised?: boolean;
  portalNotReady?: boolean;
  /** What changes on disk during the preconditions, like a deployment. */
  duringPreconditions?: (disk: { manifest: ManifestRead | null; block: string | null }) => void;
  /** Replaces a host's answer; undefined keeps the model's own. */
  probeConfig?: (host: string, n: number, guarded: boolean, cookie?: string) => ProbeResponse | undefined;
  probeRaised?: boolean;
  /** The codes file, absent by default; an Error when it does not read. */
  codes?: string | null | Error;
  /** The locks' fragment in service, absent by default. */
  fragment?: string | null;
  /** Every other site's lock, `[slug, lock]`; the site aimed at comes with its manifest's. */
  lockSites?: [string, unknown][] | Error;
  /** The door page in place for the site aimed at. */
  doorPage?: string | null;
  writeCodes?: Counter;
  writeFragment?: Counter;
  /** The code each draw gives, in turn. */
  draws?: string[];
};

function simulate(options: Options = {}) {
  const slug = options.slug ?? "library";
  const initial = options.manifest === undefined ? OPEN : options.manifest;
  const disk: {
    manifest: ManifestRead | null;
    block: string | null;
    codes: string | null;
    fragment: string | null;
    doorPage: string | null;
  } = {
    manifest: initial === null ? null : { text: initial, permissions: PERMISSIONS },
    block: options.block === undefined ? (initial === null ? null : blockOf(initial)) : options.block,
    codes: options.codes instanceof Error || options.codes === undefined ? null : options.codes,
    fragment: options.fragment ?? null,
    doorPage: options.doorPage ?? null,
  };
  const served = { block: disk.block, fragment: disk.fragment };
  const draws = [...(options.draws ?? [CODE])];
  const calls: string[] = [];
  const log: string[] = [];
  const count = new Map<string, number>();
  const backups = new Map<string, unknown>();
  let clock = 1_800_000_000_000;
  let lockReleased = 0;

  function number(name: string): number {
    const n = (count.get(name) ?? 0) + 1;
    count.set(name, n);
    calls.push(name);
    return n;
  }
  const fails = (failure: Counter | undefined, n: number) => failure?.(n) === true;
  const command = (ok: boolean, output = ""): Command => ({ ok, output });

  const lockOf = (raw: string | null): unknown => (raw === null ? undefined : (JSON.parse(raw) as { lock?: unknown }).lock);

  const machine: GeneralMachine = {
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    log: (line) => log.push(line),
    takeLock: async () => {
      number("takeLock");
      if (options.lockRaised) throw new Error("EROFS");
      if (options.lockHeld) return { kind: "held", ...options.lockHeld };
      return {
        kind: "taken",
        release: () => {
          calls.push("release");
          lockReleased++;
        },
      };
    },
    interruptedTransaction: async () => {
      if (options.interruptedRaised) throw new Error("EACCES");
      return options.interrupted ?? null;
    },
    saveBackup: async (s, backup) => {
      number("saveBackup");
      if (options.saveBackup === false) throw new Error("disk full");
      backups.set(s, structuredClone(backup));
    },
    clearBackup: async (s) => {
      number("clearBackup");
      if (options.backupClearRaised) throw new Error("EBUSY");
      backups.delete(s);
    },
    readManifest: async () => {
      calls.push("readManifest");
      return disk.manifest === null ? null : { ...disk.manifest };
    },
    readBlock: async () => {
      calls.push("readBlock");
      return disk.block;
    },
    writeManifest: async (_s, newText, permissions) => {
      if (fails(options.writeManifest, number("writeManifest"))) throw new Error("EACCES");
      disk.manifest = { text: newText, permissions };
    },
    writeBlock: async (_s, newText) => {
      if (fails(options.writeBlock, number("writeBlock"))) throw new Error("EROFS");
      disk.block = newText;
    },
    removeBlock: async () => {
      number("removeBlock");
      disk.block = null;
    },
    validateCaddy: async () =>
      fails(options.validate, number("validate"))
        ? command(false, '{"level":"info"}\nError: adapting config using caddyfile: token=secret-token')
        : command(true, "Valid configuration"),
    reloadCaddy: async () => {
      if (fails(options.reload, number("reload"))) return command(false, "Job for caddy.service failed.");
      served.block = disk.block;
      served.fragment = disk.fragment;
      return command(true);
    },
    startCaddy: async () => {
      if (fails(options.start, number("start"))) return command(false, "start failed");
      served.block = disk.block;
      served.fragment = disk.fragment;
      return command(true);
    },
    isCaddyActive: async () => !fails(options.active, number("active")),
    servedSites: async () => {
      options.duringPreconditions?.(disk);
      return options.sites ?? ["test-zone.invalid", "calendar", slug];
    },
    probe: async (host, path, _timeout, cookie) => {
      const n = number(cookie === undefined ? `probe ${host}${path}` : `probe ${host}${path} with ${cookie}`);
      if (options.probeRaised && n > 1) throw new Error("socket exploded");
      if (path === "/sante") return options.portalNotReady ? { error: "ECONNREFUSED" } : { ...OK, body: '{"configure":true}' };
      const guarded = served.block !== null && fragmentIsProtected(served.block);
      const replaced = options.probeConfig?.(host, n, guarded, cookie);
      if (replaced !== undefined) return replaced;
      const named = host.endsWith(`.${ZONE}`) ? host.slice(0, -ZONE.length - 1) : null;
      const locked = named === null ? null : installedCode(served.fragment, named);
      if (host === `${slug}.${ZONE}` && guarded) return DOOR;
      if (locked !== null) return cookie === `${cookieName(named!)}=${locked}` ? OK : DOOR_PAGE;
      return OK;
    },
    restartCollector: async () => {
      number("collector");
      return command(true);
    },
    readCodes: async () => {
      if (options.codes instanceof Error) throw options.codes;
      return disk.codes;
    },
    writeCodes: async (newText) => {
      if (fails(options.writeCodes, number("writeCodes"))) throw new Error("EROFS");
      disk.codes = newText;
    },
    readLocksFragment: async () => disk.fragment,
    writeLocksFragment: async (newText) => {
      if (fails(options.writeFragment, number("writeFragment"))) throw new Error("ENOSPC");
      disk.fragment = newText;
    },
    removeLocksFragment: async () => {
      number("removeFragment");
      disk.fragment = null;
    },
    readLockSites: async () => {
      if (options.lockSites instanceof Error) throw options.lockSites;
      const others = (options.lockSites ?? []).filter(([name]) => name !== slug).map(([name, lock]) => ({ slug: name, lock }));
      return [...others, { slug, lock: lockOf(disk.manifest?.text ?? null) }].sort((a, b) => a.slug.localeCompare(b.slug));
    },
    readDoorPage: async () => disk.doorPage,
    writeDoorPage: async (_s, page) => {
      number("writeDoorPage");
      disk.doorPage = page;
    },
  };

  return {
    machine,
    disk,
    served,
    calls,
    log,
    backups,
    count: (name: string) => count.get(name) ?? 0,
    lockReleased: () => lockReleased,
    /** `true` restricts, `false` makes public, as the two actions before the code; or any action. */
    spawn: (action: boolean | Action): Promise<Result> =>
      run(machine, {
        slug,
        action: action === true ? "on" : action === false ? "off" : action,
        zone: ZONE,
        contact: "owner@test-zone.invalid",
        draw: () => draws.shift() ?? "Z9Z9Z9",
      }),
  };
}

/** Nothing moved, neither on disk nor in what Caddy serves. */
function unchanged(s: ReturnType<typeof simulate>, manifest: string, block: string | null) {
  expect(s.disk.manifest).toEqual({ text: manifest, permissions: PERMISSIONS });
  expect(s.disk.block).toBe(block);
  expect(s.served.block).toBe(block);
}

describe("success", () => {
  test("setting the portal: manifest, block, validation, reload, probe, reading", async () => {
    const s = simulate();
    const result = await s.spawn(true);

    expect(result).toMatchObject({ result: "ok", requested: true, installed: true });
    expect(result.message).toContain("portal set");
    expect(result.message).toContain("library.test-zone.invalid answers the portal's 401");
    expect(readManifest(s.disk.manifest!.text).manifest?.portal).toBe(true);
    expect(s.disk.manifest!.permissions).toEqual(PERMISSIONS);
    expect(fragmentIsProtected(s.served.block!)).toBe(true);

    // The order: validation of the configuration in place, backup, writes,
    // validation of the action, reload, reading.
    const order = ["saveBackup", "writeManifest", "writeBlock", "validate", "reload", "clearBackup", "collector"];
    expect(s.calls.filter((a) => order.includes(a))).toEqual([
      "validate",
      "saveBackup",
      "writeManifest",
      "writeBlock",
      "validate",
      "reload",
      "clearBackup",
      "collector",
    ]);
    expect(s.count("probe portal.test-zone.invalid/sante")).toBe(1);
    expect(s.backups.size).toBe(0);
    expect(s.lockReleased()).toBe(1);
  });

  test("removing the portal: block with no guard, exemptions kept", async () => {
    const s = simulate({ slug: "cms", manifest: CLOSED });
    const result = await s.spawn(false);

    expect(result).toMatchObject({ result: "ok", requested: false, installed: false });
    expect(result.message).toContain("cms.test-zone.invalid answers without the portal");
    const manifest = readManifest(s.disk.manifest!.text).manifest!;
    expect(manifest.portal).toBeUndefined();
    expect(manifest.portalExempt).toEqual(["/hooks/*"]);
    expect(fragmentIsProtected(s.served.block!)).toBe(false);
    // Removing does not ask whether the portal is ready.
    expect(s.count("probe portal.test-zone.invalid/sante")).toBe(0);
  });

  test("idempotent: the wanted state already in place, no write and no reload", async () => {
    const s = simulate({ slug: "cms", manifest: CLOSED });
    const result = await s.spawn(true);
    expect(result).toMatchObject({ result: "ok", requested: true, installed: true });
    for (const name of ["saveBackup", "writeManifest", "writeBlock", "validate", "reload", "collector"]) {
      expect({ name, n: s.count(name) }).toEqual({ name, n: 0 });
    }
    expect(s.lockReleased()).toBe(1);
  });

  test("the probe retries for as long as the timeout allows", async () => {
    // The first request after the reload can still leave under the old
    // configuration.
    const s = simulate({ probeConfig: (host, n) => (host === "library.test-zone.invalid" && n === 2 ? OK : undefined) });
    const result = await s.spawn(true);
    expect(result.result).toBe("ok");
    expect(s.count("probe library.test-zone.invalid/")).toBe(3);
  });

  test("a site that was already silent does not trigger a restore, it is named", async () => {
    const s = simulate({ probeConfig: (host) => (host === "calendar.test-zone.invalid" ? { error: "ECONNREFUSED" } : undefined) });
    const result = await s.spawn(true);
    expect(result.result).toBe("ok");
    expect(result.message).toContain("already not answering before: calendar.test-zone.invalid");
  });
});

describe("refusals, without touching anything", () => {
  const NOTHING = ["saveBackup", "writeManifest", "writeBlock", "removeBlock", "reload", "start"];

  function touchedNothing(s: ReturnType<typeof simulate>) {
    for (const name of NOTHING) expect({ name, n: s.count(name) }).toEqual({ name, n: 0 });
  }

  test("another gatekeeper holds the lock", async () => {
    const s = simulate({ lockHeld: { who: "gatekeeper", since: Date.UTC(2026, 8, 17, 14, 3, 12) } });
    const result = await s.spawn(true);
    expect(result).toMatchObject({ result: "rejects", requested: false, installed: false });
    expect(result.message).toBe("another portal change is in progress (since 14:03:12 UTC): try again in a moment");
    touchedNothing(s);
    expect(s.count("validate")).toBe(0);
    // Not taken, so not released: the other one's lock stays.
    expect(s.lockReleased()).toBe(0);
  });

  test("a workstation tool holds the lock: refusal, nothing touched and nothing released", async () => {
    const s = simulate({ lockHeld: { who: "deploy-caddy", since: Date.UTC(2026, 8, 17, 9, 5, 0) } });
    const result = await s.spawn(false);
    expect(result.result).toBe("rejects");
    expect(result.message).toBe(
      "Caddy is being changed from the workstation (deploy-caddy, since 09:05:00 UTC): try again in a moment",
    );
    touchedNothing(s);
    expect(s.count("validate")).toBe(0);
    expect(s.lockReleased()).toBe(0);
    expect(lockHeldMessage(null, 0)).toContain("(unknown holder, since 00:00:00 UTC)");
  });

  test("the lock cannot be taken: failure, nothing touched", async () => {
    const s = simulate({ lockRaised: true });
    const result = await s.spawn(true);
    expect(result).toMatchObject({ result: "failure", message: "cannot take the Caddy lock: EROFS, nothing was changed" });
    touchedNothing(s);
  });

  test("an interrupted transaction left its backup: what to check, and the command that clears it", async () => {
    const s = simulate({ interrupted: "calendar" });
    const result = await s.spawn(true);
    expect(result.result).toBe("rejects");
    expect(result.message).toBe(
      "a portal change of calendar was interrupted, state unknown: put back the files saved in " +
        "/run/sitesolide-gatekeeper/sauvegardes/calendar/ where they differ, then sudo systemctl reload caddy, " +
        "check that the sites answer, and sudo rm -r /run/sitesolide-gatekeeper/sauvegardes/calendar",
    );
    // The detail, each file and its destination, goes to the log.
    const detail = s.log.find((line) => line.includes("permissions.json"))!;
    expect(detail).toContain("sitesolide.json goes to /srv/sites/calendar/");
    expect(detail).toContain("calendar.caddy to /etc/caddy/sites/");
    expect(detail).toContain("apply with sudo systemctl reload caddy and nothing else");
    touchedNothing(s);
    expect(s.lockReleased()).toBe(1);
  });

  test("the message of a backup left behind fits under the page's limit, even for the longest slug", () => {
    for (const slug of ["a", "cms", "campaign-2026", "a".repeat(63)]) {
      const { message } = interruptedMessage(slug, "/run/sitesolide-gatekeeper");
      expect({ slug, long: message.length > MESSAGE_MAX }).toEqual({ slug, long: false });
      expect(message).toEndWith(`sudo rm -r /run/sitesolide-gatekeeper/sauvegardes/${slug}`);
    }
    expect(interruptedMessage("cms", "/run/sitesolide-gatekeeper").message).toContain("sudo systemctl reload caddy");
    expect(() => interruptedMessage("../etc", "/run/sitesolide-gatekeeper")).toThrow("invalid slug");
  });

  test("a block retouched by hand", async () => {
    const retouched = blockOf(OPEN).replace("\timport tls-zone", "\timport tls-zone\n\tbasic_auth");
    const s = simulate({ block: retouched });
    const result = await s.spawn(true);
    expect(result.result).toBe("rejects");
    expect(result.message).toContain("differs");
    touchedNothing(s);
    unchanged(s, OPEN, retouched);
    expect(s.lockReleased()).toBe(1);
  });

  test("the dashboard and a site with no manifest", async () => {
    const dashboard = readFileSync(join(import.meta.dir, "..", "sitesolide.json"), "utf8");
    const s = simulate({ slug: "dashboard", manifest: dashboard });
    expect((await s.spawn(true)).result).toBe("rejects");
    touchedNothing(s);
    const landing = simulate({ slug: "landing", manifest: null });
    expect((await landing.spawn(true)).result).toBe("rejects");
  });

  test("the portal is not ready", async () => {
    const s = simulate({ portalNotReady: true });
    const result = await s.spawn(true);
    expect(result.result).toBe("rejects");
    expect(result.message).toContain("portal is not ready");
    touchedNothing(s);
  });
});

describe("failures before the action, without touching anything", () => {
  test("Caddy inactive", async () => {
    const s = simulate({ active: (n) => n === 1 });
    const result = await s.spawn(true);
    expect(result).toMatchObject({ result: "failure", message: "Caddy is not active, nothing was changed" });
    expect(s.count("writeManifest")).toBe(0);
  });

  test("the configuration in place does not validate to begin with", async () => {
    const s = simulate({ validate: (n) => n === 1 });
    const result = await s.spawn(true);
    expect(result.result).toBe("failure");
    expect(result.message).toContain("already in place");
    expect(result.message).toContain("nothing was changed");
    expect(s.count("saveBackup")).toBe(0);
    unchanged(s, OPEN, blockOf(OPEN));
  });

  test("the backup fails", async () => {
    const s = simulate({ saveBackup: false });
    const result = await s.spawn(true);
    expect(result.result).toBe("failure");
    expect(result.message).toContain("backup failed: disk full, nothing was changed");
    expect(s.count("writeManifest")).toBe(0);
  });
});

describe("failure at every step of the action, and restore", () => {
  const ORIGINAL = blockOf(OPEN);

  test("writing the manifest: nothing changed, no rewrite and no reload", async () => {
    const s = simulate({ writeManifest: (n) => n === 1 });
    const result = await s.spawn(true);
    expect(result.result).toBe("failure");
    expect(result.message).toBe("write: EACCES; previous configuration restored");
    unchanged(s, OPEN, ORIGINAL);
    // Caddy never left the earlier configuration: no reload at all.
    expect(s.count("reload")).toBe(0);
    expect(s.count("writeManifest")).toBe(1);
    expect(s.count("clearBackup")).toBe(1);
    expect(s.count("collector")).toBe(1);
  });

  test("writing the block: the manifest already written is put back", async () => {
    const s = simulate({ writeBlock: (n) => n === 1 });
    const result = await s.spawn(true);
    expect(result).toMatchObject({ result: "failure", requested: false, installed: false });
    expect(result.message).toBe("write: EROFS; previous configuration restored");
    unchanged(s, OPEN, ORIGINAL);
    expect(s.count("writeManifest")).toBe(2);
    expect(s.count("reload")).toBe(0);
  });

  test("validation: restore, with no reload", async () => {
    const s = simulate({ validate: (n) => n === 2 });
    const result = await s.spawn(true);
    expect(result.result).toBe("failure");
    expect(result.message).toStartWith("validate: Error: adapting config");
    expect(result.message).toEndWith("previous configuration restored");
    unchanged(s, OPEN, ORIGINAL);
    expect(s.count("validate")).toBe(3);
    expect(s.count("reload")).toBe(0);
  });

  test("reload refused: restore, validation, reload", async () => {
    const s = simulate({ reload: (n) => n === 1 });
    const result = await s.spawn(true);
    expect(result.message).toBe("reload: Job for caddy.service failed.; previous configuration restored");
    unchanged(s, OPEN, ORIGINAL);
    expect(s.count("reload")).toBe(2);
  });

  test("Caddy stopped after the reload: the restore starts it again", async () => {
    // active: 1 before the action, 2 after the reload, 3 in the restore, 4 after.
    const s = simulate({ active: (n) => n === 2 || n === 3 });
    const result = await s.spawn(true);
    expect(result.message).toBe("reload: Caddy is no longer active; previous configuration restored");
    expect(s.count("start")).toBe(1);
    expect(s.count("reload")).toBe(1);
    unchanged(s, OPEN, ORIGINAL);
  });

  test("probe: the site does not answer through the portal", async () => {
    const s = simulate({ probeConfig: (host) => (host === "library.test-zone.invalid" ? OK : undefined) });
    const result = await s.spawn(true);
    expect(result.result).toBe("failure");
    expect(result.message).toBe(
      "probe: library.test-zone.invalid should answer the portal's 401, got 200; previous configuration restored",
    );
    unchanged(s, OPEN, ORIGINAL);
    expect(s.count("reload")).toBe(2);
    // The attempts fit within their timeout.
    expect(s.count("probe library.test-zone.invalid/")).toBeLessThanOrEqual(1 + TIMEOUTS.probes / TIMEOUTS.pause + 1);
  });

  test("probe: another site no longer answers", async () => {
    const s = simulate({
      probeConfig: (host, n) => (host === "calendar.test-zone.invalid" && n > 1 ? { code: 502, door: false, body: "" } : undefined),
    });
    const result = await s.spawn(true);
    expect(result.message).toBe("probe: no longer answering: calendar.test-zone.invalid 502; previous configuration restored");
    unchanged(s, OPEN, ORIGINAL);
  });

  test("an unforeseen exception during the probe also goes through the restore", async () => {
    const s = simulate({ probeRaised: true });
    const result = await s.spawn(true);
    expect(result.message).toBe("probe: socket exploded; previous configuration restored");
    unchanged(s, OPEN, ORIGINAL);
  });

  test("a removal that fails: the door comes back", async () => {
    const s = simulate({ slug: "cms", manifest: CLOSED, reload: (n) => n === 1 });
    const result = await s.spawn(false);
    expect(result).toMatchObject({ result: "failure", requested: true, installed: true });
    unchanged(s, CLOSED, blockOf(CLOSED));
  });
});

describe("the restore fails", () => {
  test("it says so in so many words, at the head of the message, and keeps the backup", async () => {
    // validate: 1 beforehand, 2 the action (failure), 3 the restore (failure).
    const s = simulate({ validate: (n) => n >= 2 });
    const result = await s.spawn(true);
    expect(result.result).toBe("failure");
    expect(result.message).toStartWith(
      "restore failed, check Caddy now, backup kept in /run/sitesolide-gatekeeper/sauvegardes/library/: validate: ",
    );
    expect(result.message).toContain("the restored configuration does not validate");
    expect(result.message.length).toBeLessThanOrEqual(MESSAGE_MAX);
    expect(s.count("clearBackup")).toBe(0);
    expect(s.backups.has("library")).toBe(true);
    // The dashboard has to see it as soon as possible.
    expect(s.count("collector")).toBe(1);
    expect(s.lockReleased()).toBe(1);
    expect(s.log.some((line) => line.includes("sudo rm -r /run/sitesolide-gatekeeper/sauvegardes/library"))).toBe(true);
  });

  test("reload refused twice", async () => {
    const s = simulate({ reload: () => true });
    const result = await s.spawn(true);
    expect(result.message).toBe(
      "restore failed, check Caddy now, backup kept in /run/sitesolide-gatekeeper/sauvegardes/library/: " +
        "reload: Job for caddy.service failed.; reload refused: Job for caddy.service failed.",
    );
    // The files did come back, it is Caddy that does not follow.
    expect(s.disk.manifest!.text).toBe(OPEN);
    expect(s.disk.block).toBe(blockOf(OPEN));
  });
});

describe("reading again just before writing", () => {
  const NOTHING = ["saveBackup", "writeManifest", "writeBlock", "removeBlock", "reload", "start"];

  test("the lock is taken before the first read of the manifest and the block", async () => {
    const s = simulate();
    await s.spawn(true);
    const firstReading = Math.min(s.calls.indexOf("readManifest"), s.calls.indexOf("readBlock"));
    expect(s.calls.indexOf("takeLock")).toBe(0);
    expect(firstReading).toBeGreaterThan(0);
    // And read again after the preconditions, just before the backup.
    const backup = s.calls.indexOf("saveBackup");
    expect(s.calls.slice(backup - 2, backup)).toEqual(["readManifest", "readBlock"]);
    // The lock is released only at the very end, after the final state is read.
    expect(s.calls.at(-1)).toBe("release");
  });

  test("a deployment finished during the preconditions is not overwritten", async () => {
    // The deployment changes the routes: new manifest and block, with no portal.
    const deployed = text({
      slug: "library",
      port: 3044,
      publicDir: "public",
      start: "/usr/local/bin/bun run server.ts",
      routes: ["/api/*", "/export/*"],
    });
    const s = simulate({
      duringPreconditions: (disk) => {
        disk.manifest = { text: deployed, permissions: PERMISSIONS };
        disk.block = blockOf(deployed);
      },
    });
    const result = await s.spawn(true);
    expect(result).toMatchObject({ result: "rejects", requested: false, installed: false });
    expect(result.message).toBe(
      "sitesolide.json, the Caddy block or the preview locks changed while the change was being prepared, nothing was changed: try again",
    );
    for (const name of NOTHING) expect({ name, n: s.count(name) }).toEqual({ name, n: 0 });
    expect(s.disk.manifest!.text).toBe(deployed);
    expect(s.disk.block).toBe(blockOf(deployed));
    expect(s.lockReleased()).toBe(1);
  });

  test("a deployment that already set the door: nothing to do, ok", async () => {
    const closed = text({ ...readManifest(OPEN).manifest!, portal: true });
    const s = simulate({
      duringPreconditions: (disk) => {
        disk.manifest = { text: closed, permissions: PERMISSIONS };
        disk.block = blockOf(closed);
      },
    });
    const result = await s.spawn(true);
    expect(result).toMatchObject({ result: "ok", message: "already restricted", requested: true, installed: true });
    for (const name of NOTHING) expect({ name, n: s.count(name) }).toEqual({ name, n: 0 });
  });

  test("a block retouched during the preconditions: the new plan refuses", async () => {
    const retouched = blockOf(OPEN).replace("\timport tls-zone", "\timport tls-zone\n\tbasic_auth");
    const s = simulate({
      duringPreconditions: (disk) => {
        disk.block = retouched;
      },
    });
    const result = await s.spawn(true);
    expect(result.result).toBe("rejects");
    expect(result.message).toContain("differs from what sitesolide.json generates");
    for (const name of NOTHING) expect({ name, n: s.count(name) }).toEqual({ name, n: 0 });
    expect(s.disk.block).toBe(retouched);
  });

  test("only the permissions changed: the action goes through, with the permissions read again", async () => {
    const fresh: Permissions = { uid: 1000, gid: 1000, mode: 0o640 };
    const s = simulate({
      duringPreconditions: (disk) => {
        disk.manifest = { text: disk.manifest!.text, permissions: fresh };
      },
    });
    const result = await s.spawn(true);
    expect(result.result).toBe("ok");
    expect(s.disk.manifest!.permissions).toEqual(fresh);
  });
});

describe("the lock is released on every path, exactly once", () => {
  const cas: [string, Options][] = [
    ["success", {}],
    ["nothing to do", { slug: "cms", manifest: CLOSED }],
    ["the plan refuses", { slug: "dashboard", manifest: readFileSync(join(import.meta.dir, "..", "sitesolide.json"), "utf8") }],
    ["unreadable backups", { interruptedRaised: true }],
    ["interrupted transaction", { interrupted: "calendar" }],
    ["Caddy inactive", { active: (n) => n === 1 }],
    ["portal not ready", { portalNotReady: true }],
    ["backup refused, and its erasure too", { saveBackup: false, backupClearRaised: true }],
    ["deployment during the preconditions", { duringPreconditions: (d) => void (d.block = null) }],
    ["failure then restore", { reload: (n) => n === 1 }],
    ["restore gone wrong", { validate: (n) => n >= 2 }],
    ["exception during the probe", { probeRaised: true }],
    ["erasing the backup refused after a success", { backupClearRaised: true }],
  ];
  for (const [name, options] of cas) {
    test(name, async () => {
      const s = simulate(options);
      await s.spawn(true);
      expect(s.lockReleased()).toBe(1);
      // Released last: nothing touches the disk or Caddy afterwards.
      expect(s.calls.at(-1)).toBe("release");
    });
  }
});

describe("messages and timeouts", () => {
  test("no secret from caddy's output is quoted if the machine redacted it", () => {
    const output = redact("Error: provision dns: token secret-token-1234 refused\n", ["secret-token-1234"]);
    expect(caddyExtract(output)).toBe("Error: provision dns: token [redacted] refused");
    expect(caddyExtract("")).toBe("no output");
    expect(caddyExtract(`Error: ${"x".repeat(400)}`)).toHaveLength(303);
  });

  test("the worst transaction fits under each unit's TimeoutStartSec, itself under MAX_PORTAL_MS", () => {
    for (const action of ["on", "off", "code", "renew"]) {
      const name = `sitesolide-gatekeeper-${action}@.service`;
      const unit = readFileSync(join(import.meta.dir, "..", "..", "infra", "gatekeeper", name), "utf8");
      const found = /^TimeoutStartSec=(\d+)s$/m.exec(unit);
      expect({ name, found: found !== null }).toEqual({ name, found: true });
      const timeoutMs = Number(found![1]) * 1000;
      expect(worstDuration() + MARGIN_MS).toBeLessThanOrEqual(timeoutMs);
      expect(timeoutMs).toBeLessThan(MAX_PORTAL_MS);
    }
  });

  test("a message too long for the page is cut in the middle, never replaced", () => {
    expect(boundMessage("short")).toBe("short");
    // A restore gone wrong is said at the head: it survives the cut.
    const rate = `restore failed, check Caddy now: validate: ${"x".repeat(400)}; the restored configuration does not validate: ${"y".repeat(300)}`;
    expect(boundMessage(rate)).toHaveLength(MESSAGE_MAX);
    expect(boundMessage(rate)).toStartWith("restore failed, check Caddy now: validate: ");
    expect(boundMessage(rate)).toEndWith("...");
    // So does the short conclusion of a successful restore.
    const restored = `validate: Error: ${"z".repeat(400)}; previous configuration restored`;
    expect(boundMessage(restored)).toHaveLength(MESSAGE_MAX);
    expect(boundMessage(restored)).toStartWith("validate: Error: zzz");
    expect(boundMessage(restored)).toEndWith("...; previous configuration restored");
    // And that of a refusal before the action, even when the quoted output carries a `; `.
    const refusal = `caddy validate refuses the configuration already in place: Error: a; b ${"v".repeat(400)}, nothing was changed`;
    expect(boundMessage(refusal)).toHaveLength(MESSAGE_MAX);
    expect(boundMessage(refusal)).toStartWith("caddy validate refuses the configuration already in place: ");
    expect(boundMessage(refusal)).toEndWith("..., nothing was changed");
  });

  test("a Caddy refusal quoted in full no longer makes the page say everything is restored", async () => {
    const s = simulate({ validate: (n) => n >= 2 });
    const machine: GeneralMachine = {
      ...s.machine,
      validateCaddy: async (timeout) => {
        const verdict = await s.machine.validateCaddy(timeout);
        return verdict.ok ? verdict : { ok: false, output: `Error: ${"w".repeat(400)}` };
      },
    };
    const result = await run(machine, { slug: "library", action: "on", zone: ZONE });
    expect(result.message.length).toBeLessThanOrEqual(MESSAGE_MAX);
    expect(result.message).toStartWith("restore failed, check Caddy now");
  });
});

/**
 * Anyone with the code: the same transaction, the preview locks written with
 * the manifest. The code is drawn here and nowhere else, and never leaves
 * through a message, the result or the log.
 */
describe("Anyone with the code", () => {
  const LOCKED = text({ ...readManifest(OPEN).manifest!, lock: true });
  const STATIC = text({ slug: "library", publicDir: "public" });
  const codesOf = (s: ReturnType<typeof simulate>) => JSON.parse(s.disk.codes ?? "{}") as Record<string, string>;

  /** Nothing said anywhere carries a code. */
  function quiet(s: ReturnType<typeof simulate>, result: Result, ...codes: string[]) {
    const said = [result.message, JSON.stringify(result), ...s.log].join("\n");
    for (const code of codes) expect({ code, said: said.includes(code) }).toEqual({ code, said: false });
  }

  test("from Public: the code drawn, the manifest, the codes, the door page, the fragment, one reload", async () => {
    const s = simulate();
    const result = await s.spawn("code");

    expect(result).toMatchObject({ result: "ok", requested: false, installed: false });
    expect(result.message).toBe(
      "code set: validated, reloaded, library.test-zone.invalid answers the door page's 401 and opens with its code, 3 other site(s) still answer",
    );
    expect(readManifest(s.disk.manifest!.text).manifest?.lock).toBe(true);
    expect(codesOf(s)).toEqual({ library: CODE });
    expect(installedCode(s.served.fragment, "library")).toBe(CODE);
    expect(s.disk.doorPage).toContain(DOOR_PAGE_MARKER);
    expect(s.disk.doorPage).toContain("owner@test-zone.invalid");
    // The block of an app does not change: the code lives in the locks.
    expect(s.disk.block).toBe(blockOf(OPEN));
    // The order: door page before Caddy reads anything, the backup, the manifest, the codes, the fragment.
    const order = ["writeDoorPage", "saveBackup", "writeManifest", "writeCodes", "writeFragment", "validate", "reload"];
    expect(s.calls.filter((a) => order.includes(a))).toEqual(["validate", "writeDoorPage", "saveBackup", "writeManifest", "writeCodes", "writeFragment", "validate", "reload"]);
    // Probed without a code, and with it.
    expect(s.count(`probe library.test-zone.invalid/ with ${cookieName("library")}=${CODE}`)).toBe(1);
    expect(s.count("probe portal.test-zone.invalid/sante")).toBe(0);
    quiet(s, result, CODE);
  });

  test("from Restricted: the portal off and the code on, in one transaction, one reload", async () => {
    const s = simulate({ slug: "cms", manifest: CLOSED });
    const result = await s.spawn("code");

    expect(result).toMatchObject({ result: "ok", requested: false, installed: false });
    expect(result.message).toStartWith("portal removed, code set: validated, reloaded, cms.test-zone.invalid answers the door page's 401");
    const manifest = readManifest(s.disk.manifest!.text).manifest!;
    expect(manifest.portal).toBeUndefined();
    expect(manifest.lock).toBe(true);
    expect(manifest.portalExempt).toEqual(["/hooks/*"]);
    expect(fragmentIsProtected(s.served.block!)).toBe(false);
    expect(installedCode(s.served.fragment, "cms")).toBe(CODE);
    expect(s.count("reload")).toBe(1);
    quiet(s, result, CODE);
  });

  test("back to Restricted: the code taken away and the portal put up, in one transaction", async () => {
    const s = simulate({
      manifest: LOCKED,
      block: blockOf(LOCKED),
      codes: `{"library":"${CODE}"}`,
      fragment: locksFor({ library: CODE }),
    });
    const result = await s.spawn("on");

    expect(result).toMatchObject({ result: "ok", requested: true, installed: true });
    expect(result.message).toStartWith("code removed, portal set: validated, reloaded, library.test-zone.invalid answers the portal's 401");
    const manifest = readManifest(s.disk.manifest!.text).manifest!;
    expect(manifest.portal).toBe(true);
    expect(manifest.lock).toBeUndefined();
    expect(codesOf(s)).toEqual({});
    expect(installedCode(s.served.fragment, "library")).toBeNull();
    expect(s.count("reload")).toBe(1);
    expect(s.count("probe portal.test-zone.invalid/sante")).toBe(1);
    quiet(s, result, CODE);
  });

  test("back to Public: the stanza gone, the site opens without a code", async () => {
    const s = simulate({ manifest: LOCKED, block: blockOf(LOCKED), codes: `{"library":"${CODE}","other":"${NEW_CODE}"}`, fragment: locksFor({ library: CODE, other: NEW_CODE }), lockSites: [["other", true]] });
    const result = await s.spawn("off");

    expect(result.result).toBe("ok");
    expect(result.message).toStartWith("code removed: validated, reloaded, library.test-zone.invalid answers without a code");
    expect(readManifest(s.disk.manifest!.text).manifest?.lock).toBeUndefined();
    // The other site keeps its code and its stanza.
    expect(codesOf(s)).toEqual({ other: NEW_CODE });
    expect(installedCode(s.served.fragment, "other")).toBe(NEW_CODE);
    expect(installedCode(s.served.fragment, "library")).toBeNull();
    quiet(s, result, CODE, NEW_CODE);
  });

  test("a new code: the old one stops opening the site, the new one opens it", async () => {
    const s = simulate({ manifest: LOCKED, block: blockOf(LOCKED), codes: `{"library":"${CODE}"}`, fragment: locksFor({ library: CODE }), draws: [NEW_CODE] });
    const result = await s.spawn("renew");

    expect(result.result).toBe("ok");
    expect(result.message).toStartWith("new code set: validated, reloaded, library.test-zone.invalid answers the door page's 401 and opens with the new code, not the old one");
    expect(codesOf(s)).toEqual({ library: NEW_CODE });
    expect(installedCode(s.served.fragment, "library")).toBe(NEW_CODE);
    // The manifest asked for the code already: untouched.
    expect(s.count("writeManifest")).toBe(0);
    expect(s.count(`probe library.test-zone.invalid/ with ${cookieName("library")}=${CODE}`)).toBe(1);
    quiet(s, result, CODE, NEW_CODE);
  });

  test("a new code is never the old one, even when the draw gives it back", async () => {
    const s = simulate({ manifest: LOCKED, block: blockOf(LOCKED), codes: `{"library":"${CODE}"}`, fragment: locksFor({ library: CODE }), draws: [CODE, NEW_CODE] });
    expect((await s.spawn("renew")).result).toBe("ok");
    expect(codesOf(s)).toEqual({ library: NEW_CODE });
  });

  test("a new code for a site that does not open with one: refused, nothing touched", async () => {
    const s = simulate();
    const result = await s.spawn("renew");
    expect(result).toMatchObject({ result: "rejects", message: "library does not open with a code: choose Anyone with the code first" });
    expect(s.count("writeCodes") + s.count("writeFragment") + s.count("reload")).toBe(0);
  });

  test("already open with its code: nothing for Caddy, the code kept, the door page put back", async () => {
    const s = simulate({ manifest: LOCKED, block: blockOf(LOCKED), codes: `{"library":"${CODE}"}`, fragment: locksFor({ library: CODE }) });
    const result = await s.spawn("code");
    expect(result).toMatchObject({ result: "ok", message: "already open with a code" });
    expect(s.count("reload") + s.count("validate") + s.count("writeCodes")).toBe(0);
    // The door page was missing: written again from the template.
    expect(s.count("writeDoorPage")).toBe(1);
    // A page the site placed itself, without the template's marker, is left alone.
    const own = simulate({ manifest: LOCKED, block: blockOf(LOCKED), codes: `{"library":"${CODE}"}`, fragment: locksFor({ library: CODE }), doorPage: "<p>Our own page</p>" });
    await own.spawn("code");
    expect(own.disk.doorPage).toBe("<p>Our own page</p>");
  });

  test("a code in force without the manifest asking for it: kept, so the link already sent still opens", async () => {
    const s = simulate({ codes: `{"library":"${CODE}"}`, fragment: locksFor({ library: CODE }) });
    const result = await s.spawn("code");
    expect(result.result).toBe("ok");
    expect(codesOf(s)).toEqual({ library: CODE });
    expect(readManifest(s.disk.manifest!.text).manifest?.lock).toBe(true);
  });

  test("a failure after the reload: manifest, codes and fragment come back, Caddy with them", async () => {
    // The site does not open with its code: the stanza is wrong, the action is undone.
    const s = simulate({ slug: "cms", manifest: CLOSED, probeConfig: (host, _n, _g, cookie) => (host === "cms.test-zone.invalid" && cookie !== undefined ? DOOR_PAGE : undefined) });
    const result = await s.spawn("code");
    expect(result.result).toBe("failure");
    expect(result.message).toBe("probe: cms.test-zone.invalid should open with its code, got 401; previous configuration restored");
    unchanged(s, CLOSED, blockOf(CLOSED));
    expect(s.disk.codes).toBe("{}\n");
    expect(s.disk.fragment).toBeNull();
    expect(s.served.fragment).toBeNull();
    expect(s.count("reload")).toBe(2);
    quiet(s, result, CODE);
  });

  test("an old code that still opens the site: the new code is undone", async () => {
    const s = simulate({
      manifest: LOCKED,
      block: blockOf(LOCKED),
      codes: `{"library":"${CODE}"}`,
      fragment: locksFor({ library: CODE }),
      draws: [NEW_CODE],
      probeConfig: (host, _n, _g, cookie) => (cookie === `${cookieName("library")}=${CODE}` ? OK : undefined),
    });
    const result = await s.spawn("renew");
    expect(result.message).toBe("probe: library.test-zone.invalid still opens with the code it replaced, got 200; previous configuration restored");
    expect(codesOf(s)).toEqual({ library: CODE });
    expect(installedCode(s.served.fragment, "library")).toBe(CODE);
    quiet(s, result, CODE, NEW_CODE);
  });

  test("writing the fragment fails: the codes and the manifest already written are put back", async () => {
    const s = simulate({ writeFragment: (n) => n === 1 });
    const result = await s.spawn("code");
    expect(result.message).toBe("write: ENOSPC; previous configuration restored");
    unchanged(s, OPEN, blockOf(OPEN));
    expect(s.disk.codes).toBe("{}\n");
    expect(s.count("reload")).toBe(0);
  });

  test("the backup holds the codes and the fragment from before", async () => {
    const s = simulate({ codes: `{"other":"${NEW_CODE}"}`, fragment: locksFor({ other: NEW_CODE }), lockSites: [["other", true]], reload: () => true });
    const result = await s.spawn("code");
    expect(result.message).toStartWith("restore failed");
    expect(s.backups.get("library")).toMatchObject({ locks: { codes: `{"other":"${NEW_CODE}"}`, fragment: locksFor({ other: NEW_CODE }) } });
  });

  test("a site on its own domain takes no code, a static site takes one but cannot be restricted", async () => {
    const domain = text({ ...readManifest(OPEN).manifest!, domain: { name: "library.example", active: true } });
    const s = simulate({ manifest: domain });
    const result = await s.spawn("code");
    expect(result.result).toBe("rejects");
    expect(result.message).toContain("serves its own domain, library.example, which a code would not close");

    const showcase = simulate({ manifest: STATIC, block: null });
    expect((await showcase.spawn("code")).result).toBe("ok");
    expect(showcase.disk.block).toBeNull();
    expect((await simulate({ manifest: STATIC, block: null }).spawn("on")).message).toBe("a static site cannot be restricted yet");
  });

  test("the codes file does not read: a code is refused, restricting a site with no code is not", async () => {
    const broken = new Error("/etc/caddy/locks-codes.json is a symbolic link");
    const s = simulate({ codes: broken });
    const result = await s.spawn("code");
    expect(result.result).toBe("rejects");
    expect(result.message).toContain("the codes file on the server does not read");
    expect(s.count("writeManifest")).toBe(0);

    const restricting = simulate({ codes: broken });
    expect((await restricting.spawn("on")).result).toBe("ok");
    expect(restricting.count("writeCodes") + restricting.count("writeFragment")).toBe(0);
  });

  test("another site asking for a code it does not have: the locks are not generated, nothing is touched", async () => {
    const s = simulate({ lockSites: [["other", true]] });
    const result = await s.spawn("code");
    expect(result.result).toBe("rejects");
    expect(result.message).toBe("the preview locks cannot be generated: other: lock requested without a valid code");
    expect(s.count("writeManifest") + s.count("writeCodes")).toBe(0);
  });

  test("a site that has nothing to do with the locks is restricted without reading them", async () => {
    const s = simulate({ lockSites: new Error("sitesolide.json unreadable") });
    expect((await s.spawn("on")).result).toBe("ok");
    expect(s.count("writeFragment")).toBe(0);
  });
});
