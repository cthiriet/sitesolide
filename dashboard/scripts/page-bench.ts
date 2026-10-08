#!/usr/bin/env bun
/**
 * A bench for looking at the dashboard's page on the workstation, with data
 * that is fictitious but plausible. Nothing in it touches the VM, nor the real
 * portal, nor the real steward, nor `data/`.
 *
 *   cd dashboard
 *   bun run build                    # the page, in public/
 *   bun scripts/page-bench.ts         # http://localhost:4322, password: demo
 *
 * What the bench launches, in a temporary directory erased on stopping:
 *
 * - the real `server.ts`, with a test hash displayed at startup, its database
 *   in the temporary directory and an `state.json` rewritten every thirty
 *   seconds in the `Raw` format of `src/state.ts`: a dozen sites, static and
 *   app, a service that loops, a preview lock, sites behind the portal,
 *   discrepancies of both severities;
 * - a fake steward on a Unix socket, which follows `src/secrets/protocol.ts`
 *   and the real one's guard rails: every deployed site and its portal,
 *   variable files, one out of management, one missing, one pending restart,
 *   builder's files read as one block (private key and registry token
 *   write-only, with no size, public key readable), every `PASSWORD_HASH`
 *   (builder.env's included) that changes only through `/password` and is never
 *   restored, `dashboard.env` and `portal.env` which carry nothing but their
 *   hash, one log per site, and an unlocking by the same password;
 * - a simulated gatekeeper behind `/portal`, which takes six seconds: it
 *   restricts `wheels` or `bookshop` and makes them public again, always
 *   fails on `photos` and restores, refuses `roster` because Caddy's
 *   lock is held from the workstation, and refuses `library`, for which a
 *   backup of an interrupted action has remained: its state is unknown. The
 *   messages are those of the real gatekeeper and of the real steward,
 *   imported from src/;
 * - a fake portal on the loopback, which answers `/admin/sharing` with how
 *   people sign in, `/admin/access` like `portal/src/admin.ts`, and
 *   `/admin/audit` with sign-ins of every kind;
 * - access, with the steward's own access and sign-in routes
 *   (src/access/steward.ts, src/people/steward.ts) on the fake steward's
 *   socket, the registry made by the real migration from a `members.json`
 *   and a portal database from before it, written in the temporary
 *   directory: alice@example.com is a Developer on `cms`, an Admin on
 *   `calendar` and a Viewer on `photos`, bruno@example.com an Admin on `cms`
 *   and a Developer on `calendar`, chloe@example.com a Viewer on
 *   `calendar`, maya@example.com may create projects; people and a domain
 *   can open `cms` and `calendar`, and five password accesses are carried
 *   over. *Sign in with Google* on the sign-in page goes through the fake
 *   portal's `/admin/dashboard/flow` to a page of its own that signs in one
 *   of them, or stranger@example.com, whom the registry does not name, then back with a
 *   code the fake portal redeems for an assertion signed with the steward's
 *   key, as the real one does;
 * - with the dashboard's own audit of tokens and deployments, written below,
 *   the egress proxy's, the backups' and the steward's, every source of the
 *   Activity page has rows;
 * - a front end playing Caddy: `/api/*` to the service, the rest served from
 *   `public/` as `file_server` does, a directory's `index.html` included and a
 *   redirect from `/site` to `/site/`. It keeps production's order, where the
 *   service sees only `/api/*`, and stays useful beside the fallback of `bun
 *   run dev` (src/public.ts), which nevertheless serves the page the same way.
 *   For a route of the contract that `server.ts` would not carry yet, it
 *   relays it itself, after having the session checked by the service.
 *
 * Restarting `dashboard` from its secrets returns the verdict `scheduled`, then
 * really cuts the service for three seconds: the page must reconnect to it.
 *
 * Variables:
 *
 *   BENCH_PORT=4322          the front end's port, the service takes the next one
 *   BENCH_STALE=1           a snapshot ten minutes old, never rewritten
 *   BENCH_NO_STEWARD=1  no steward: Secrets and Access say 502
 *   BENCH_NO_PORTAL=1     no portal: the sign-in page offers no provider, Activity can't read it
 *   BENCH_NO_SSO=1        a portal with passwords only: everyone outside gets password access
 *   BENCH_OLD_PORTAL=1    a portal that still reads its own lists: Access says changes don't reach it
 *   BENCH_NO_EGRESS=1     no egress proxy: the Connectors page's activity says so, and Activity
 *   BENCH_EMPTY=1             no snapshot at all: the "No snapshot" state
 *   BENCH_SHOWCASE=1          the same fleet healed, for the README's screenshots
 *   BENCH_NO_BACKUPS=1        the backup component not installed
 *   BENCH_OLD_STEWARD=1       a steward from before the backups: `no such route`
 *
 * The password is fixed and obvious, `demo`, since nothing here is real.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { fixedRefusal } from "../src/gatekeeper/rules";
import { lockHeldMessage } from "../src/gatekeeper/transaction";
import { HASH_ONLY, PASSWORD_VARIABLE, MIN_PASSWORD } from "../src/secrets/scope";
import { INTERRUPTED_TRANSACTION_REASON } from "../src/secrets/portal";
import {
  EMPTY_CONNECTORS,
  EMPTY_GRANTS,
  OWNER_ACTOR,
  connectorViews,
  putConnector,
  removeConnector,
  setGrant,
  type ConnectorsFile,
  type GrantsFile,
} from "../borrowed/connectors";
import { benchBackupRoutes } from "./bench-backups";
import { readPrivateKey, signAssertion } from "../borrowed/assertion";
import { createMemberRoutes } from "../src/people/steward";
import { createAccessRoutes, createAccessStore } from "../src/access/steward";
import { createAccessSystem } from "../src/access/system";
import { mintRefusals, scopeText } from "../src/people/tokens";
import { may, needsUnlock, powerRefusal, type Power } from "../src/people/powers";
import { createMembersSystem } from "../src/people/system";

const PASSWORD = "demo";

/**
 * The bench's purpose is every trouble the page must know how to say. Asked
 * for a showcase, it heals the fleet instead: every service runs, every domain
 * is routed, every file is in order, the activity holds no failure. The README
 * shows this state, taken from the real page rather than drawn.
 */
const SHOWCASE = process.env.BENCH_SHOWCASE === "1";
const PORT = Number(process.env.BENCH_PORT ?? 4322);
const SERVICE_PORT = PORT + 1;
const PROJECT_ROOT = resolve(import.meta.dir, "..");
const PUBLIC = join(PROJECT_ROOT, "public");

const folder = mkdtempSync(join(tmpdir(), "page-bench-"));
const stateFile = join(folder, "state.json");
const socket = join(folder, "secretaire.sock");

const hash = await Bun.password.hash(PASSWORD, { algorithm: "argon2id" });
/** The hash of a password nobody knows, for the files that unlock nothing here. */
const otherHash = await Bun.password.hash(crypto.randomUUID(), { algorithm: "argon2id" });

const MB = 1024 * 1024;
const GB = 1024 * MB;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const start = Date.now();

// --- The snapshot ------------------------------------------------------------

type FakeUnit = {
  active?: string;
  subState?: string;
  memory: number;
  peak: number;
  limit: number;
  restarts?: number;
  sinceMs: number;
  /** Share of a core over the last minute, as a percentage. */
  cpu: number;
};

type FakeFolder = {
  slug: string;
  manifest: Record<string, unknown> | null;
  unit: FakeUnit | null;
  /** The other units of a project declaring several services, by unit name. */
  units?: Record<string, FakeUnit>;
  bytes: number;
  deployedMs: number;
  portal?: boolean;
};

const FOLDERS: FakeFolder[] = [
  {
    slug: "example.com",
    manifest: null,
    unit: { memory: 48 * MB, peak: 71 * MB, limit: 256 * MB, sinceMs: 12 * DAY, cpu: 0.4 },
    bytes: 9 * MB,
    deployedMs: 12 * DAY,
  },
  {
    slug: "calendar",
    manifest: {
      slug: "calendar",
      description: "Team calendar and bookings",
      start: "bun run server.ts",
      port: 3040,
      portal: true,
      portalExempt: ["/api/webhooks/*"],
      secrets: ["calendar.env", "calendar-webhook.env"],
    },
    unit: { memory: 61 * MB, peak: 88 * MB, limit: 256 * MB, sinceMs: 3 * DAY, cpu: 2.6 },
    bytes: 22 * MB,
    deployedMs: 3 * DAY,
    portal: true,
  },
  {
    slug: "wheels",
    manifest: {
      slug: "wheels",
      description: "Riverside Cycles, showcase site",
      domain: { name: "riverside-cycles.example", aliases: ["www.riverside-cycles.example"], active: true },
    },
    unit: null,
    bytes: 14 * MB,
    deployedMs: 26 * DAY,
  },
  {
    slug: "bakery-martin",
    manifest: {
      slug: "bakery-martin",
      description: "Martin Bakery, redesign under way",
      lock: true,
      domain: { name: "martin-bakery.example", active: false },
    },
    unit: null,
    bytes: 31 * MB,
    deployedMs: 2 * HOUR,
  },
  {
    slug: "bookshop",
    manifest: {
      slug: "bookshop",
      description: "Corner Bookshop",
      domain: { name: "corner-bookshop.example", active: true },
    },
    unit: null,
    bytes: 6 * MB,
    deployedMs: 40 * MINUTE,
  },
  {
    slug: "cms",
    manifest: {
      slug: "cms",
      description: "Content management",
      start: "bun run server.ts",
      port: 3043,
      portal: true,
      secrets: ["cms.env"],
    },
    unit: { memory: 198 * MB, peak: 221 * MB, limit: 256 * MB, sinceMs: 20 * HOUR, cpu: 5.1 },
    bytes: 48 * MB,
    deployedMs: 20 * HOUR,
    portal: true,
  },
  {
    slug: "dashboard",
    manifest: {
      slug: "dashboard",
      description: "The machine's dashboard",
      start: "bun run server.ts",
      port: 3022,
      memory: "128M",
      secrets: ["dashboard.env"],
    },
    unit: { memory: 41 * MB, peak: 97 * MB, limit: 128 * MB, sinceMs: 5 * HOUR, cpu: 0.3 },
    bytes: 3 * MB,
    deployedMs: 5 * HOUR,
  },
  {
    slug: "builder",
    manifest: {
      slug: "builder",
      description: "Build runner",
      start: "bun run server.ts",
      port: 3041,
      memory: "512M",
      secrets: ["builder.env"],
    },
    unit: { memory: 143 * MB, peak: 301 * MB, limit: 512 * MB, sinceMs: 9 * DAY, cpu: 3.4 },
    bytes: 186 * MB,
    deployedMs: 9 * DAY,
  },
  {
    slug: "library",
    manifest: {
      slug: "library",
      description: "Lending library",
      start: "bun run server.ts",
      port: 3044,
      portal: true,
      secrets: ["library.env"],
    },
    unit: { memory: 37 * MB, peak: 52 * MB, limit: 256 * MB, sinceMs: 6 * DAY, cpu: 0.8 },
    bytes: 12 * MB,
    deployedMs: 6 * DAY,
    portal: true,
  },
  {
    slug: "photos",
    manifest: { slug: "photos", description: "Family albums", portal: true },
    unit: null,
    bytes: 2.3 * GB,
    deployedMs: 15 * DAY,
    portal: true,
  },
  {
    slug: "portal",
    manifest: {
      slug: "portal",
      description: "Sign-in in front of the restricted sites",
      start: "bun run server.ts",
      port: 3026,
      secrets: ["portal.env"],
    },
    unit: { memory: 29 * MB, peak: 64 * MB, limit: 128 * MB, sinceMs: 4 * DAY, cpu: 0.2 },
    bytes: 4 * MB,
    deployedMs: 4 * DAY,
  },
  {
    slug: "lab",
    manifest: {
      slug: "lab",
      description: "A small AI lab: platform, API and model",
      services: {
        platform: { start: "/srv/sites/lab/app/.venv/bin/python -m lab.platform --port 3047", port: 3047 },
        api: { start: "/srv/sites/lab/app/.venv/bin/python -m lab.api --port 3048", port: 3048, routes: ["/v1/*"] },
        inference: {
          start: "/srv/sites/lab/app/.venv/bin/python -m lab.inference --port 3049",
          port: 3049,
          internal: true,
          memory: "768M",
        },
      },
    },
    unit: { memory: 47 * MB, peak: 49 * MB, limit: 256 * MB, sinceMs: 2 * HOUR, cpu: 0.3 },
    units: {
      "lab.api": { memory: 38 * MB, peak: 40 * MB, limit: 256 * MB, sinceMs: 2 * HOUR, cpu: 0.2 },
      "lab.inference": { memory: 237 * MB, peak: 239 * MB, limit: 768 * MB, sinceMs: 2 * HOUR, cpu: 1.4 },
    },
    bytes: 1.1 * GB,
    deployedMs: 2 * HOUR,
  },
  {
    slug: "roster",
    manifest: {
      slug: "roster",
      description: "Staff roster",
      start: "bun run server.ts",
      port: 3045,
      secrets: ["roster.env"],
      // Restricted in sitesolide.json, not in the live block: general access in disagreement.
      ...(SHOWCASE ? {} : { portal: true }),
    },
    unit: {
      active: "activating",
      subState: "auto-restart",
      memory: 0,
      peak: 34 * MB,
      limit: 256 * MB,
      restarts: 7,
      sinceMs: 0,
      cpu: 0,
    },
    bytes: 18 * MB,
    deployedMs: 25 * MINUTE,
  },
  {
    slug: "yoga-studio",
    manifest: {
      slug: "yoga-studio",
      description: "Yoga studio",
      domain: { name: "yoga-studio.example", active: false },
    },
    unit: null,
    bytes: 27 * MB,
    deployedMs: 60 * DAY,
  },
];

if (SHOWCASE) {
  for (const d of FOLDERS) {
    if (d.unit !== null) d.unit.cpu = Math.min(d.unit.cpu, 6);
    const domain = d.manifest?.domain as { active?: boolean } | undefined;
    if (domain !== undefined && d.slug !== "bakery-martin") domain.active = true;
  }
  const unit = (slug: string) => FOLDERS.find((d) => d.slug === slug)!.unit!;
  Object.assign(unit("roster"), { active: "active", subState: "running", memory: 44 * MB, peak: 61 * MB, restarts: 0, sinceMs: 25 * MINUTE, cpu: 0.6 });
  Object.assign(unit("cms"), { memory: 131 * MB, peak: 163 * MB });
}

/** A unit's accumulated processor time, in nanoseconds, before and now. */
function counters(unit: FakeUnit): { before: number; now: number } {
  const before = 3_600_000 * 1e6;
  return { before, now: before + (unit.cpu / 100) * MINUTE * 1e6 };
}

/**
 * The status the monitor would leave, copied by the collector
 * (monitor/src/status.ts): a customer domain whose certificate no longer
 * matches, a certificate renewal running late, a failed backup. Healed in the
 * showcase, where the monitor has nothing to say.
 */
function monitorStatus(generatedAt: number): string {
  const ago = (minutes: number) => generatedAt - minutes * MINUTE;
  const down = SHOWCASE
    ? []
    : [
        {
          id: "site:yoga-studio.example",
          kind: "site",
          label: "yoga-studio.example",
          severity: "critical",
          slug: "yoga-studio",
          summary: "https://yoga-studio.example/ did not answer: ERR_TLS_CERT_ALTNAME_INVALID",
          since: ago(14),
        },
        {
          id: "certificate:riverside-cycles.example",
          kind: "certificate",
          label: "riverside-cycles.example",
          severity: "warning",
          slug: "wheels",
          summary: `The certificate for riverside-cycles.example expires in 9 days, on ${new Date(generatedAt + 9.5 * 24 * 60 * MINUTE).toISOString().slice(0, 10)}`,
          since: ago(3 * 60),
        },
        {
          id: "backup",
          kind: "backup",
          label: "backups",
          severity: "warning",
          slug: null,
          summary: "The last backup run failed for photos, 5 h ago",
          since: ago(5 * 60),
        },
      ];
  return JSON.stringify({
    version: 1,
    generatedAt: ago(0.5),
    zone: "example.com",
    checks: 41,
    down,
    heartbeat: "ok",
    webhook: SHOWCASE ? "idle" : "ok",
    undelivered: 0,
  });
}

/**
 * The snapshot `analytics` would drop, copied by the collector.
 *
 * Three sites: one that receives people, one that is starting out, one that has
 * received nothing yet because its tag is not in place. The three states the
 * Audience section must know how to show.
 */
function audience(generatedAt: number): string {
  const day = (daysBack: number) => new Date(generatedAt - daysBack * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  /**
   * A month as a small business sees it: busier on weekdays, quiet on Sundays,
   * a slow climb, day-to-day noise, and a spike the day a flyer went out. The
   * shape is then scaled so that the days add up to the totals the page shows
   * beside them. Seeded, so that every run of the bench draws the same month.
   */
  const curve = (
    totals: { visits: number; views: number },
    shape: { seed: number; growth: number; since?: number; spike?: { daysBack: number; boost: number } },
  ) => {
    let state = shape.seed;
    const random = () => {
      // mulberry32: small, and the same sequence on every machine.
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // Sunday to Saturday.
    const week = [0.5, 1.12, 1.18, 1.12, 1.06, 0.94, 0.62];
    const weights = Array.from({ length: 30 }, (_, index) => {
      const daysBack = 29 - index;
      if (shape.since !== undefined && daysBack > shape.since) return { visits: 0, views: 0 };
      const weekday = new Date(generatedAt - daysBack * DAY).getUTCDay();
      const trend = 1 + (shape.growth * index) / 29;
      const noise = 0.88 + random() * 0.24;
      let boost = 1;
      if (shape.spike !== undefined && daysBack === shape.spike.daysBack) boost = shape.spike.boost;
      if (shape.spike !== undefined && daysBack === shape.spike.daysBack - 1) boost = 1 + (shape.spike.boost - 1) / 3;
      const visits = (week[weekday] ?? 1) * trend * noise * boost;
      return { visits, views: visits * (1.8 + random() * 0.6) };
    });
    const scale = (key: "visits" | "views", total: number) => {
      const sum = weights.reduce((acc, w) => acc + w[key], 0);
      const values = weights.map((w) => (sum === 0 ? 0 : Math.round((w[key] * total) / sum)));
      // The rounding error goes to the busiest day, so that the sum is exact.
      const busiest = values.indexOf(Math.max(...values));
      values[busiest] = (values[busiest] ?? 0) + total - values.reduce((acc, v) => acc + v, 0);
      return values;
    };
    const visits = scale("visits", totals.visits);
    const views = scale("views", totals.views);
    return visits.map((v, index) => ({ day: day(29 - index), views: Math.max(views[index] ?? 0, v), visits: v }));
  };

  const lines = (values: [string, number][]) => values.map(([value, total]) => ({ value, total }));

  return JSON.stringify({
    generatedAt: generatedAt - 20_000,
    timeZone: "Europe/London",
    days: 30,
    from: day(29),
    to: day(0),
    sites: {
      "wheels": {
        totals: { views: 2417, visits: 1148, bounces: 402, timedViews: 1502, seconds: 128671 },
        days: curve({ visits: 1148, views: 2417 }, { seed: 7, growth: 0.45, spike: { daysBack: 9, boost: 1.65 } }),
        rankings: {
          path: lines([["/", 902], ["/projects", 641], ["/contact", 388], ["/repairs", 311], ["/pricing", 175]]),
          entry: lines([["/", 714], ["/projects", 249], ["/contact", 185]]),
          source: lines([["Google", 508], ["direct", 344], ["Yellow Pages", 141], ["trades-directory.example", 92], ["LinkedIn", 63]]),
          campaign: lines([["autumn-flyer", 84]]),
          device: lines([["mobile", 701], ["bureau", 338], ["tablette", 109]]),
          browser: lines([["Chrome", 502], ["Safari", 431], ["Firefox", 128], ["Edge", 87]]),
          system: lines([["iOS", 388], ["Android", 327], ["Windows", 271], ["macOS", 162]]),
          language: lines([["en", 1021], ["fr", 87], ["de", 40]]),
          host: lines([["riverside-cycles.example", 1908], ["wheels.example.com", 509]]),
        },
      },
      "yoga-studio": {
        totals: { views: 63, visits: 41, bounces: 29, timedViews: 38, seconds: 1824 },
        days: curve({ visits: 41, views: 63 }, { seed: 11, growth: 0.6, since: 12 }),
        rankings: {
          path: lines([["/", 44], ["/classes", 19]]),
          entry: lines([["/", 41]]),
          source: lines([["direct", 27], ["Google", 14]]),
          device: lines([["mobile", 33], ["bureau", 8]]),
          browser: lines([["Safari", 24], ["Chrome", 17]]),
          system: lines([["iOS", 24], ["Android", 11], ["Windows", 6]]),
          language: lines([["en", 41]]),
          host: lines([["yoga-studio.example", 63]]),
        },
      },
      "bakery-martin": {
        totals: { views: 0, visits: 0, bounces: 0, timedViews: 0, seconds: 0 },
        days: curve({ visits: 0, views: 0 }, { seed: 1, growth: 0 }),
        rankings: {},
      },
    },
  });
}

function reading(now: number) {
  const generatedAt = process.env.BENCH_STALE === "1" ? start - 10 * MINUTE : now;
  const cpu: Record<string, number> = {};
  // The current stanza hands the site who is in; outside the showcase, photos
  // keeps the one from before identities, for the Sharing section to say so.
  const earlier = "\tforward_auth @portal_guard 127.0.0.1:3026 {\n\t\turi /verifier\n\t}\n";
  const current =
    "\troute {\n\t\trequest_header -X-Sitesolide*\n\t\trequest_header -X_sitesolide*\n" +
    "\t\tforward_auth @portal_guard 127.0.0.1:3026 {\n\t\t\turi /verifier\n" +
    "\t\t\tcopy_headers X-Sitesolide-User X-Sitesolide-User-Name X-Sitesolide-Role\n\t\t}\n\t}\n";
  const kept = (slug: string) => (!SHOWCASE && slug === "photos" ? earlier : current);
  const blocks: Record<string, string> = SHOWCASE ? {} : { "old-kiosk": "# forgotten block\n" };

  // What systemctl show would return for a fake unit, its CPU counter kept
  // under `key` for the next reading's rate.
  const raw = (key: string, fake: FakeUnit): Record<string, string> => {
    const { before, now: nsec } = counters(fake);
    cpu[key] = before;
    const active = fake.active ?? "active";
    return {
      LoadState: "loaded",
      ActiveState: active,
      SubState: fake.subState ?? "running",
      MemoryCurrent: active === "active" ? String(fake.memory) : "[not set]",
      MemoryPeak: String(fake.peak),
      MemoryMax: String(fake.limit),
      NRestarts: String(fake.restarts ?? 0),
      ActiveEnterTimestamp: active === "active" ? `@${Math.floor((generatedAt - fake.sinceMs) / 1000)}` : "@0",
      CPUUsageNSec: active === "active" ? String(nsec) : "[not set]",
    };
  };

  const folders = FOLDERS.map((d) => {
    blocks[d.slug] = `# ${d.slug}\n${d.portal === true ? kept(d.slug) : ""}`;
    const unit = d.unit === null ? null : raw(d.slug, d.unit);
    const units =
      d.units === undefined
        ? undefined
        : Object.fromEntries(Object.entries(d.units).map(([name, fake]) => [name, raw(name, fake)]));
    return {
      slug: d.slug,
      manifest: d.manifest === null ? null : JSON.stringify(d.manifest),
      unit,
      units,
      bytes: Math.round(d.bytes),
      deployed: generatedAt - d.deployedMs,
    };
  });

  return {
    generated: generatedAt,
    zone: "example.com",
    folders,
    codes: JSON.stringify({ "bakery-martin": "K7PX3M" }),
    domains:
      "\triverside-cycles.example wheels\n\twww.riverside-cycles.example wheels\n\tyoga-studio.example yoga-studio\n" +
      (SHOWCASE ? "\tcorner-bookshop.example bookshop\n" : ""),
    audience: audience(generatedAt),
    monitor: monitorStatus(generatedAt),
    // roster (3045) does not listen: it is looping.
    ports: SHOWCASE
      ? [3040, 3041, 3022, 3043, 3044, 3045, 3026, 3047, 3048, 3049]
      : [3040, 3041, 3022, 3043, 3044, 3026, 3047, 3048, 3049],
    blocks,
    machine: {
      memoryTotal: 11.6 * GB,
      memoryAvailable: (SHOWCASE ? 5.9 : 4.2) * GB,
      diskTotal: 120 * GB,
      diskFree: 71 * GB,
      load1: 1.3,
      load5: 1.05,
      load15: 0.9,
      cores: 6,
    },
    previous: { generated: generatedAt - MINUTE, cpu },
  };
}

async function writeState() {
  if (process.env.BENCH_EMPTY === "1") return;
  await Bun.write(stateFile, JSON.stringify(reading(Date.now())));
}

await writeState();
const stateTimer = process.env.BENCH_STALE === "1" ? null : setInterval(() => void writeState(), 30_000);

// --- The fake steward --------------------------------------------------------
//
// It follows `src/secrets/protocol.ts`: every deployed site is a project,
// static or app, with its files and its portal. Its rules are those of a bench,
// plausible without being the real steward's: the page must depend only on its
// answers.

type FakeFile = {
  name: string;
  kind: "variables" | "content";
  state: "managed" | "absent" | "unmanaged";
  reason: string | null;
  expected: string;
  readable: boolean;
  variables: Map<string, string>;
  passwords: string[];
  content: string;
  modifiedAt: number | null;
  previous: { variables: Map<string, string>; content: string } | null;
  wait: boolean;
};

type FakeService = { state: string; subState: string; startedAt: number | null };

type FakeProject = {
  slug: string;
  service: FakeService | null;
  files: FakeFile[];
  modifiable: boolean;
  reason: string | null;
};

function file(slug: string, partial: Partial<FakeFile> & { name: string }): FakeFile {
  const account = slug === "example.com" ? "site-landing" : `site-${slug}`;
  return {
    kind: "variables",
    state: "managed",
    reason: null,
    expected: `${account}:${account} 0600`,
    readable: true,
    variables: new Map(),
    passwords: [],
    content: "",
    modifiedAt: start - 3 * DAY,
    previous: null,
    wait: false,
    ...partial,
  };
}

const FAKE_PRIVATE_KEY = [
  // Split so that a secret scanner reading this file does not take a fake
  // key for a leaked one: at runtime the header is whole.
  "-----BEGIN OPENSSH " + "PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
  "QyNTUxOQAAACBwYWdlLWJlbmNoLWZha2Uta2V5LW5vdC1hLXJlYWwta2V5LWF0LWFsbAAA",
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n");

/** Each site's files; a site missing from here has none. */
const FILES: Record<string, FakeFile[]> = {
  calendar: [
    file("calendar", {
      name: "calendar.env",
      variables: new Map([
        ["MAIL_ACCOUNT_ID", "bench-fake-account-id"],
        ["MAIL_AUTH_TOKEN", "bench-fake-auth-token"],
        ["SMTP_PASSWORD", "bench-smtp-password"],
      ]),
      modifiedAt: start - 4 * DAY,
    }),
    file("calendar", { name: "calendar-webhook.env", state: "absent", modifiedAt: null }),
  ],
  cms: [
    file("cms", {
      name: "cms.env",
      variables: new Map([
        ["CMS_TOKEN", "tok_bench_7f3a9c2e1b8d4f6a0e5c"],
        ["DATABASE_KEY", "bench_db_key_0123456789abcdef"],
      ]),
      modifiedAt: start - 35 * MINUTE,
      previous: { variables: new Map([["CMS_TOKEN", "tok_bench_old"]]), content: "" },
      wait: true,
    }),
  ],
  dashboard: [
    file("dashboard", {
      name: "dashboard.env",
      expected: "root:root 0600",
      variables: new Map([[PASSWORD_VARIABLE, hash]]),
      passwords: [PASSWORD_VARIABLE],
      modifiedAt: start - 12 * DAY,
    }),
  ],
  builder: [
    file("builder", {
      name: "builder.env",
      variables: new Map([
        ["GITHUB_TOKEN", "fake_github_token_bench"],
        ["NPM_TOKEN", "fake_npm_token_bench"],
        // The hash of its own password: as everywhere, Change password only.
        [PASSWORD_VARIABLE, otherHash],
      ]),
      passwords: [PASSWORD_VARIABLE],
      modifiedAt: start - 9 * DAY,
    }),
    file("builder", {
      name: "builder-ssh",
      kind: "content",
      expected: "site-builder:site-builder 0400",
      readable: false,
      content: FAKE_PRIVATE_KEY,
      modifiedAt: start - 40 * DAY,
    }),
    file("builder", {
      name: "builder-ssh.pub",
      kind: "content",
      expected: "site-builder:site-builder 0444",
      content: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHBhZ2UtYmVuY2gtZmFrZS1rZXktaGVyZS14eA builder@sitesolide\n",
      modifiedAt: start - 40 * DAY,
    }),
    file("builder", {
      name: "builder-secrets/registry",
      kind: "content",
      expected: "site-builder:site-builder 0400",
      readable: false,
      content: "bench-fake-registry-token\n",
      modifiedAt: start - 6 * DAY,
      previous: { variables: new Map(), content: "bench-old-token\n" },
    }),
  ],
  library: [
    file("library", {
      name: "library.env",
      state: "unmanaged",
      reason: "Line 2 starts with export, which systemd reads but the steward doesn't rewrite.",
      modifiedAt: start - 12 * DAY,
    }),
  ],
  portal: [
    file("portal", {
      name: "portal.env",
      // Hash only, like dashboard.env; belonging to its site, though, not to root.
      variables: new Map([[PASSWORD_VARIABLE, otherHash]]),
      passwords: [PASSWORD_VARIABLE],
      modifiedAt: start - 30 * DAY,
    }),
  ],
  roster: [
    file("roster", {
      name: "roster.env",
      variables: new Map([["MAIL_KEY", "mk_bench00000000"]]),
      modifiedAt: start - 26 * MINUTE,
      previous: { variables: new Map([["MAIL_KEY", "mk_benchold"]]), content: "" },
    }),
  ],
  "example.com": [
    file("example.com", {
      name: "landing-mail.env",
      variables: new Map([
        ["AWS_ACCESS_KEY_ID", "FAKEBENCHACCESSKEYID"],
        ["AWS_SECRET_ACCESS_KEY", "bench/secret/key/ses/0000000000000000"],
        ["AWS_REGION", "us-east-1"],
      ]),
      modifiedAt: start - 12 * DAY,
    }),
  ],
};

if (SHOWCASE) {
  for (const files of Object.values(FILES)) {
    for (const f of files) {
      if (f.state !== "managed") Object.assign(f, { state: "managed", reason: null, modifiedAt: start - 5 * DAY });
      if (f.name === "calendar-webhook.env") f.variables = new Map([["WEBHOOK_SECRET", "bench-fake-webhook-secret"]]);
      if (f.name === "library.env") f.variables = new Map([["LIBRARY_KEY", "bench-fake-library-key"]]);
      f.wait = false;
    }
  }
}

/**
 * What the gatekeeper refuses to change, and why, in the real one's words
 * (src/gatekeeper/rules.ts): the portal, the dashboard, the landing with no
 * manifest. The bench does not copy the rest of the rules: a static site
 * changes its door there, so that the wait and the success can be watched on
 * `wheels`.
 */
const UNTOUCHABLE: Record<string, string> = Object.fromEntries(
  ["portal", "dashboard", "example.com"].map((slug) => [slug, fixedRefusal(slug, null) ?? "the portal of this site cannot be changed"]),
);

/**
 * An interrupted action whose backup has remained: the real steward offers
 * nothing more on this site and says so, until a human has looked.
 */
if (!SHOWCASE) UNTOUCHABLE.library = INTERRUPTED_TRANSACTION_REASON;

/** The site whose change the gatekeeper always fails to check, and restores. */
const FAILING_SITE = "photos";

/**
 * The site on which the gatekeeper finds Caddy's lock held from the
 * workstation: refusal from the gatekeeper, nothing changes. The real lock
 * counts for every site; the bench confines it to one so as to keep the other
 * actions to watch.
 */
const LOCK_HELD_SITE = "roster";

const PROJECTS: FakeProject[] = FOLDERS.map((d) => ({
  slug: d.slug,
  service:
    d.unit === null
      ? null
      : {
          state: d.unit.active ?? "active",
          subState: d.unit.subState ?? "running",
          startedAt: (d.unit.active ?? "active") === "active" ? start - d.unit.sinceMs : null,
        },
  files: FILES[d.slug] ?? [],
  modifiable: !(d.slug in UNTOUCHABLE),
  reason: UNTOUCHABLE[d.slug] ?? null,
}));

type LogRow = {
  a: number;
  operation: string;
  result: "ok" | "rejects" | "failure";
  /** Absent: the owner's, as on a journal from before members. */
  actor?: string;
  member?: string | null;
  slug: string | null;
  file: string | null;
  variable: string | null;
  detail: string | null;
};

const log: LogRow[] = [
  { a: start - 4 * DAY, operation: "unlock", result: "ok", slug: null, file: null, variable: null, detail: null },
  { a: start - 4 * DAY + MINUTE, operation: "set", result: "ok", slug: "calendar", file: "calendar.env", variable: "SMTP_PASSWORD", detail: null },
  { a: start - 6 * DAY, operation: "replace", result: "ok", slug: "builder", file: "builder-secrets/registry", variable: null, detail: null },
  { a: start - 40 * MINUTE, operation: "unlock", result: "rejects", slug: null, file: null, variable: null, detail: "refused" },
  { a: start - 38 * MINUTE, operation: "unlock", result: "ok", slug: null, file: null, variable: null, detail: null },
  { a: start - 35 * MINUTE, operation: "set", result: "ok", slug: "cms", file: "cms.env", variable: "CMS_TOKEN", detail: null },
  { a: start - 26 * MINUTE, operation: "set", result: "ok", slug: "roster", file: "roster.env", variable: "MAIL_KEY", detail: null },
  { a: start - 25 * MINUTE, operation: "restart", result: "ok", slug: "roster", file: null, variable: null, detail: "looping" },
  { a: start - 24 * MINUTE, operation: "set", result: "rejects", slug: "roster", file: "roster.env", variable: null, detail: "invalid" },
  // The action whose backup remained on `library`: the gatekeeper wrote nothing of its result.
  { a: start - 3 * HOUR, operation: "portal", result: "failure", slug: "library", file: null, variable: null, detail: "off, failed" },
];

if (SHOWCASE) {
  const kept = log.filter((entry) => entry.result === "ok" && entry.detail !== "looping");
  log.splice(0, log.length, ...kept);
}

function record(entry: Omit<LogRow, "a">) {
  log.push({ a: Date.now(), ...entry });
}

let token: { value: string; expiresAt: number } | null = null;
let failures = 0;
let waitEnd = 0;

function refusal(status: number, error: string, message: string, extra: object = {}) {
  return Response.json({ error, message, ...extra }, { status: status });
}

/**
 * A file that carries a hash, in its current version or in the previous one, or
 * that carries nothing else: it is never restored, as at the real steward's
 * (`restoreRefusal`).
 */
function carriesPassword(f: FakeFile): boolean {
  if (HASH_ONLY.includes(f.name)) return true;
  return f.variables.has(PASSWORD_VARIABLE) || (f.previous?.variables.has(PASSWORD_VARIABLE) ?? false);
}

function fileView(f: FakeFile) {
  const managed = f.state === "managed";
  return {
    name: f.name,
    kind: f.kind,
    state: f.state,
    reason: f.reason,
    expected: f.expected,
    readable: f.readable,
    variables: managed && f.kind === "variables" ? [...f.variables.keys()] : [],
    passwords: managed ? f.passwords.filter((name) => f.variables.has(name)) : [],
    // The size of a write-only file does not come out: a key's says its algorithm.
    bytes: managed && f.kind === "content" && f.readable ? new TextEncoder().encode(f.content).byteLength : null,
    modifiedAt: f.modifiedAt,
    previous: f.previous !== null && !carriesPassword(f),
    restartPending: f.wait,
  };
}

function portalOf(slug: string) {
  const d = FOLDERS.find((candidate) => candidate.slug === slug);
  const requested = d?.manifest?.portal === true;
  return { requested, installed: d?.portal === true };
}

function projectView(p: FakeProject) {
  // The name `unitOf` of src/state.ts returns, without `.service`, like the real steward.
  const unit = p.slug === "example.com" ? "sitesolide-landing" : p.slug;
  return {
    slug: p.slug,
    service: p.service === null ? null : { unit, ...p.service },
    files: p.files.map(fileView),
    portal: { ...portalOf(p.slug), modifiable: p.modifiable, reason: p.reason },
  };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as unknown;
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * What a member's request carries once the bench's steward judged their role
 * (see `memberAction`): the fake routes below take it for an unlock, as the
 * real steward hands a member's request to the very operations of the owner's.
 */
const MEMBER_PASS = `member-${crypto.randomUUID()}`;

function isValidToken(requested: Record<string, unknown>): boolean {
  if (requested.token === MEMBER_PASS) return true;
  return token !== null && requested.token === token.value && Date.now() < token.expiresAt;
}

function projectOf(requested: Record<string, unknown>): FakeProject | Response {
  const project = PROJECTS.find((p) => p.slug === requested.slug);
  return project ?? refusal(404, "not-found", "No such site on this server.");
}

function locate(requested: Record<string, unknown>): { project: FakeProject; file: FakeFile } | Response {
  const project = projectOf(requested);
  if (project instanceof Response) return project;
  const found = project.files.find((f) => f.name === requested.file);
  if (found === undefined) return refusal(404, "not-found", "No such file.");
  return { project, file: found };
}

/** The common skeleton of the writes: token, place, action, then the trace and the pending restart. */
async function writeTo(
  req: Request,
  operation: string,
  action: (place: { project: FakeProject; file: FakeFile }, requested: Record<string, unknown>) => Response | null,
): Promise<Response> {
  const requested = await readBody(req);
  if (!isValidToken(requested)) return refusal(401, "locked", "Locked.");
  const place = locate(requested);
  if (place instanceof Response) return place;
  const refuse = action(place, requested);
  const variable = typeof requested.variable === "string" ? requested.variable : null;
  if (refuse !== null) {
    record({ operation, result: "rejects", slug: place.project.slug, file: place.file.name, variable, detail: "invalid" });
    return refuse;
  }
  place.file.modifiedAt = Date.now();
  place.file.wait = place.project.service !== null;
  record({ operation, result: "ok", slug: place.project.slug, file: place.file.name, variable, detail: null });
  return Response.json({ file: fileView(place.file) });
}

function keepPrevious(f: FakeFile) {
  f.previous = { variables: new Map(f.variables), content: f.content };
}

/** A drawn password, of four readable groups, with no ambiguous character. */
function drawPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const letters = [...bytes].map((byte) => alphabet[byte % alphabet.length]);
  return [0, 5, 10, 15].map((rank) => letters.slice(rank, rank + 5).join("")).join("-");
}

try {
  unlinkSync(socket);
} catch {}

// --- The team's tokens, as the steward's control routes keep them -----------

type BenchToken = {
  id: string;
  label: string;
  email: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
  scope: { slugs: string[]; create: boolean; outbound: boolean; domain: boolean; public: boolean };
  owned: string[];
  /** The member who minted it, null for the owner's. */
  member: string | null;
};

const teamTokens: BenchToken[] = [
  { id: "a1b2c3d4e5f6", label: "Alice's laptop", email: "alice@example.com", createdAt: start - 12 * DAY, expiresAt: start + 78 * DAY, revokedAt: null, lastUsedAt: start - 3 * HOUR, scope: { slugs: ["cms"], create: true, outbound: false, domain: false, public: false }, owned: ["notes"], member: null },
  { id: "0f1e2d3c4b5a", label: "Release agent", email: "agent@example.com", createdAt: start - 40 * DAY, expiresAt: start + 4 * DAY, revokedAt: null, lastUsedAt: start - DAY, scope: { slugs: ["calendar"], create: false, outbound: true, domain: false, public: true }, owned: [], member: null },
  { id: "9a8b7c6d5e4f", label: "Bob, contractor", email: "bob@example.com", createdAt: start - 90 * DAY, expiresAt: null, revokedAt: start - 20 * DAY, lastUsedAt: start - 21 * DAY, scope: { slugs: [], create: true, outbound: false, domain: false, public: false }, owned: ["mockups"], member: null },
  // A person's own, minted from her Tokens page: a Developer on cms, an Admin on calendar.
  { id: "c0ffee123456", label: "Alice's agent", email: "alice@example.com", createdAt: start - 2 * DAY, expiresAt: start + 88 * DAY, revokedAt: null, lastUsedAt: start - 5 * HOUR, scope: { slugs: ["calendar"], create: false, outbound: true, domain: false, public: false }, owned: [], member: "alice@example.com" },
];

// The control API's history, written by the service's own store in its data
// directory before it starts: a child process, so that DATA_DIR is the
// bench's when src/config.ts freezes it.
Bun.spawnSync(
  [
    "bun",
    "-e",
    `const { openDatabase } = await import("./src/database");
     const { createControlStore } = await import("./src/control/store");
     const store = createControlStore(openDatabase(process.env.DATA_DIR + "/dashboard.db"));
     const start = ${start};
     const rows = [
       ["0123456789abcdef00000001", "a1b2c3d4e5f6", "alice@example.com", "notes", "succeeded", 1, start - 3 * 3600000, null],
       ["0123456789abcdef00000002", "0f1e2d3c4b5a", "agent@example.com", "calendar", "failed", 0, start - 26 * 3600000, "install-failed: bun install --production failed (exit 1): nothing served was changed"],
       ["0123456789abcdef00000003", "a1b2c3d4e5f6", "alice@example.com", "cms", "succeeded", 0, start - 50 * 3600000, null],
     ];
     const audit = [
       { at: start - 20 * 86400000, actor: "owner", action: "token.revoke", target: null, detail: { id: "9a8b7c6d5e4f", label: "Bob, contractor", email: "bob@example.com" } },
       { at: start - 12 * 86400000, actor: "owner", action: "token.create", target: null, detail: { id: "a1b2c3d4e5f6", label: "Alice's laptop", email: "alice@example.com", expiresAt: start + 78 * 86400000, scope: { slugs: ["cms"], create: true, outbound: false, domain: false, public: false } } },
     ];
     for (const [id, tokenId, email, slug, state, creating, at, message] of rows) {
       store.createDeployment({ id, tokenId, email, slug, creating: creating === 1, manifest: "{}", createdAt: at });
       store.markRunning(id, at + 2000);
       store.finish(id, state, at + 60000, message);
       audit.push({ at: at + 2000, actor: "token:" + tokenId, action: "deploy.start", target: slug, detail: { email, deployment: id } });
       audit.push({ at: at + 60000, actor: "token:" + tokenId, action: state === "succeeded" ? "deploy.success" : "deploy.failure", target: slug, detail: { email, deployment: id, error: message === null ? undefined : "install-failed" } });
     }
     // In the order of time, as the service writes them: the ids grow with it.
     for (const entry of audit.sort((a, b) => a.at - b.at)) store.recordAudit(entry);`,
  ],
  { cwd: PROJECT_ROOT, env: { ...process.env, DATA_DIR: folder }, stdout: "inherit", stderr: "inherit" },
);

// --- The people who sign in, with the steward's own routes -------------------------
//
// The registry, the sessions and the key pair in the temporary directory, the
// projects those of the snapshot, the portal's settings the fake portal's. A
// restart is simulated, and recorded in the steward's log under the person.

const membersState = join(folder, "members-state");
const portalKeyFolder = join(folder, "portal-key");
mkdirSync(membersState, { recursive: true });
mkdirSync(portalKeyFolder, { recursive: true });

/** How people sign in on the bench: Google, unless BENCH_NO_SSO asks for a portal with passwords only. */
const sso =
  process.env.BENCH_NO_SSO === "1"
    ? { configured: false, providerName: null, portalUrl: null, admins: [] as string[], allowedDomains: [] as string[] }
    : {
        configured: true,
        providerName: "Google",
        portalUrl: "https://portal.example.com",
        admins: ["owner@example.com"],
        allowedDomains: ["example.com"],
      };

// The stores from before the registry, which the real migration carries over
// at the first read: alice's roles in members.json, and a portal database
// whose sharing let people and a domain in, and whose guests had passwords.
const portalData = join(folder, "portal-data");
mkdirSync(portalData, { recursive: true });
writeFileSync(
  join(membersState, "members.json"),
  JSON.stringify({
    members: [
      { email: "alice@example.com", roles: { cms: "developer", calendar: "admin", photos: "viewer" }, create: false, invitedBy: "owner", createdAt: start - 20 * DAY, updatedAt: start - 20 * DAY },
      { email: "bruno@example.com", roles: { calendar: "developer", cms: "admin" }, create: false, invitedBy: "owner", createdAt: start - 12 * DAY, updatedAt: start - 3 * DAY },
      { email: "chloe@example.com", roles: { calendar: "viewer" }, create: false, invitedBy: "alice@example.com", createdAt: start - 4 * DAY, updatedAt: start - 4 * DAY },
      { email: "maya@example.com", roles: {}, create: true, invitedBy: "owner", createdAt: start - 2 * DAY, updatedAt: start - 2 * DAY },
    ],
  }),
);
{
  // A fixture, written once and read once by the migration's checked copy.
  const fixture = new Database(join(portalData, "portal.db"), { create: true, strict: true });
  fixture.run("CREATE TABLE invites (id TEXT PRIMARY KEY, hote TEXT NOT NULL, libelle TEXT NOT NULL, empreinte TEXT NOT NULL UNIQUE, cree_a INTEGER NOT NULL, expire_a INTEGER, vu_a INTEGER)");
  fixture.run("CREATE TABLE sharing (host TEXT PRIMARY KEY, mode TEXT NOT NULL, people TEXT NOT NULL, domains TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  const hashOf = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const invite = fixture.query("INSERT INTO invites (id, hote, libelle, empreinte, cree_a, expire_a, vu_a) VALUES (?, ?, ?, ?, ?, ?, NULL)");
  invite.run("benchGuest000001", "cms.example.com", "client@example.org", hashOf("bench one"), start - 6 * DAY - 19 * HOUR, start + 5 * HOUR);
  invite.run("benchGuest000002", "calendar.example.com", "Example Accounting", hashOf("bench two"), start - DAY, start + 6 * DAY);
  invite.run("benchGuest000005", "calendar.example.com", "auditor@partner.example", hashOf("bench five"), start - 3 * DAY, start + 14 * HOUR);
  invite.run("benchGuest000003", "photos.example.com", "Bob and Carol", hashOf("bench three"), start - 41 * DAY, null);
  invite.run("benchGuest000004", "library.example.com", "Dave, intern", hashOf("bench four"), start - 32 * DAY, start - 2 * DAY);
  const policy = fixture.query("INSERT INTO sharing (host, mode, people, domains, updated_at) VALUES (?, ?, ?, ?, ?)");
  policy.run("cms.example.com", "people", JSON.stringify(["alice@example.com", "editor@example.com"]), "[]", start - 2 * DAY);
  policy.run("calendar.example.com", "domain", "[]", JSON.stringify(["example.com"]), start - 9 * DAY);
  fixture.close();
}

const benchJournal = async (event: { operation: string; result: "ok" | "rejects"; actor: string; member: string | null; slug?: string; detail: string | null }) =>
  record({ operation: event.operation, result: event.result, actor: event.actor, member: event.member, slug: event.slug ?? null, file: null, variable: null, detail: event.detail });

const accessStore = createAccessStore({
  system: createAccessSystem({ stateFolder: membersState, portalKeyFolder, groupsFile: "/etc/group", portalGroup: "", portalDataFolder: portalData }, false),
  zone: "example.com",
  hostOf: (slug) => `${slug}.example.com`,
  journal: benchJournal,
});

const memberRoutes = createMemberRoutes({
  system: {
    ...createMembersSystem({
      stateFolder: membersState,
      sitesDir: join(folder, "no-sites"),
      secretsFolder: join(folder, "no-secrets"),
      portalKeyFolder,
      groupsFile: "/etc/group",
      portalGroup: "",
    }),
    projectExists: (slug) => FOLDERS.some((one) => one.slug === slug),
    readPortalSettings: async () => ({ configured: sso.configured, allowedDomains: sso.allowedDomains, admins: sso.admins, providerName: sso.providerName }),
  },
  access: accessStore,
  zone: "example.com",
  readBody: async (req, fields) => {
    const body = await readBody(req);
    return Object.keys(body).every((key) => fields.includes(key)) ? body : refusal(400, "invalid", "unexpected field in the request body");
  },
  journal: benchJournal,
  restart: async (_req, slug, actor, allowed) => {
    await Bun.sleep(1500);
    if (!(await allowed())) return refusal(403, "out-of-scope", `${actor} may no longer restart ${slug}`);
    record({ operation: "restart", result: "ok", actor, member: actor, slug, file: null, variable: null, detail: "active, active/running, 0 restarts" });
    return Response.json({ verdict: { kind: "active", state: "active", subState: "running", restarts: 0 } });
  },
});

const accessRoutes = createAccessRoutes({
  store: accessStore,
  zone: "example.com",
  hostOf: (slug) => `${slug}.example.com`,
  projectExists: (slug) => FOLDERS.some((one) => one.slug === slug),
  signIn: async () => ({ configured: sso.configured, allowedDomains: sso.allowedDomains, admins: sso.admins, providerName: sso.providerName }),
  general: async (slug) => {
    const found = FOLDERS.find((one) => one.slug === slug);
    if (found === undefined) return null;
    const view = PROJECTS.find((project) => project.slug === slug);
    const restricted = view !== undefined && projectView(view).portal.requested === true && projectView(view).portal.installed === true;
    return { access: restricted ? "restricted" : "public", modifiable: true, reason: null };
  },
  portalReading: async () => ({ reading: process.env.BENCH_OLD_PORTAL === "1" ? "portal" : "steward", writtenAt: Date.now() }),
  isUnlocked: async (value) => isValidToken({ token: value }),
  readBody: async (req, fields) => {
    const body = await readBody(req);
    return Object.keys(body).every((key) => fields.includes(key)) ? body : refusal(400, "invalid", "unexpected field in the request body");
  },
  journal: benchJournal,
  journalRefusal: benchJournal,
  authorize: memberRoutes.authorize,
  leave: memberRoutes.leave,
});

/**
 * A member's work on their projects, as src/people/actions.ts judges it: the
 * session, the member's unlock where the power needs one, the role, then the
 * owner's fake operation. Enough for the page; the real decisions are tested
 * in tests/people-actions.test.ts.
 */
function memberAction(power: Power, operation: (req: Request) => Response | Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    const body = await readBody(req);
    const principal = await memberRoutes.authorize(body.session, needsUnlock(power) ? body.token : null);
    if (principal instanceof Response) return principal;
    const slug = text(body.slug);
    const role = Object.hasOwn(principal.roles, slug) ? principal.roles[slug]! : null;
    if (!may(role, power)) return refusal(403, "out-of-scope", powerRefusal(principal.email, role, slug, power));
    const { session: _session, token: _token, ...rest } = body;
    return operation(new Request(req.url, { method: req.method, body: JSON.stringify({ ...rest, token: MEMBER_PASS }) }));
  };
}

/** A member's projects in the Secrets section, write-only to a Developer. */
async function memberProjects(req: Request): Promise<Response> {
  const body = await readBody(req);
  const principal = await memberRoutes.authorize(body.session, null);
  if (principal instanceof Response) return principal;
  const projects = PROJECTS.filter((p) => may(principal.roles[p.slug] ?? null, "secrets.list")).map((p) => {
    const view = projectView(p);
    return may(principal.roles[p.slug] ?? null, "secrets.read")
      ? view
      : { ...view, files: view.files.map((file: Record<string, unknown>) => ({ ...file, readable: false, previous: false, bytes: null })) };
  });
  return Response.json({ projects, until: await memberRoutes.unlockedUntil(body.session) });
}

const steward =
  process.env.BENCH_NO_STEWARD === "1"
    ? null
    : Bun.serve({
        unix: socket,
        routes: {
          ...memberRoutes.dashboard,
          ...accessRoutes.dashboard,
          "/members/secrets/projects": { POST: memberProjects },
          // The owner's fake routes, judged by role first: see memberAction.
          ...(() => {
            // Through the bench's own socket: the owner's route, as it stands.
            const owner = (path: string, method: string) => async (req: Request) =>
              fetch(`http://steward${path}`, { unix: socket, method, headers: { "Content-Type": "application/json" }, body: await req.text() });
            return {
              "/members/secrets/value": { POST: memberAction("secrets.read", owner("/value", "POST")) },
              "/members/secrets/variable": { PUT: memberAction("secrets.write", owner("/variable", "PUT")), DELETE: memberAction("secrets.write", owner("/variable", "DELETE")) },
              "/members/secrets/file": { POST: memberAction("secrets.write", owner("/file", "POST")) },
              "/members/secrets/restore": { POST: memberAction("secrets.restore", owner("/restore", "POST")) },
              "/members/secrets/content": { POST: memberAction("secrets.read", owner("/content", "POST")), PUT: memberAction("secrets.write", owner("/content", "PUT")) },
              "/members/portal": { POST: memberAction("door", owner("/portal", "POST")) },
            };
          })(),
          // The backups, their troubles and a simulated restore: scripts/bench-backups.ts.
          ...benchBackupRoutes({ start, folders: FOLDERS, isValidToken }),
          "/projects": { GET: () => Response.json({ projects: PROJECTS.map(projectView) }) },
          "/team/tokens": {
            GET: () => Response.json({ tokens: [...teamTokens].sort((a, b) => b.createdAt - a.createdAt) }),
            POST: async (req) => {
              const requested = await readBody(req);
              if (!isValidToken(requested)) return refusal(401, "locked", "locked, unlock again");
              const scope = requested.scope as BenchToken["scope"];
              if (scope.slugs.includes("dashboard")) return refusal(400, "invalid", "scope.slugs: dashboard is reserved for the platform: pick another slug");
              const created: BenchToken = {
                id: draw(12, "0123456789abcdef"),
                label: text(requested.label),
                email: text(requested.email).toLowerCase(),
                createdAt: Date.now(),
                expiresAt: typeof requested.expiresAt === "number" ? requested.expiresAt : null,
                revokedAt: null,
                lastUsedAt: null,
                scope,
                owned: [],
                member: null,
              };
              teamTokens.push(created);
              return Response.json({ token: created, secret: `sst_${draw(43, ALPHABET)}` }, { status: 201 });
            },
          },
          // A member's own tokens, judged by the real rules (src/people/tokens.ts) on her session and unlock.
          "/team/member/list": {
            POST: async (req) => {
              const requested = await readBody(req);
              const principal = await memberRoutes.authorize(requested.session, null);
              if (principal instanceof Response) return principal;
              return Response.json({
                tokens: [...teamTokens].filter((token) => token.member === principal.email).sort((a, b) => b.createdAt - a.createdAt),
                rights: { roles: principal.roles, create: principal.create },
                until: await memberRoutes.unlockedUntil(requested.session),
              });
            },
          },
          "/team/member/tokens": {
            POST: async (req) => {
              const requested = await readBody(req);
              const principal = await memberRoutes.authorize(requested.session, requested.token);
              if (principal instanceof Response) return principal;
              const scope = requested.scope as BenchToken["scope"];
              const refusals = mintRefusals(scope, { email: principal.email, roles: principal.roles, create: principal.create });
              if (refusals.length > 0) return refusal(403, "out-of-scope", refusals.join("; "), { details: refusals });
              const created: BenchToken = {
                id: draw(12, "0123456789abcdef"),
                label: text(requested.label),
                email: principal.email,
                createdAt: Date.now(),
                expiresAt: typeof requested.expiresAt === "number" ? requested.expiresAt : null,
                revokedAt: null,
                lastUsedAt: null,
                scope,
                owned: [],
                member: principal.email,
              };
              teamTokens.push(created);
              record({ operation: "token.create", result: "ok", actor: principal.email, member: principal.email, slug: null, file: null, variable: null, detail: `${created.id}: ${scopeText(scope)}` });
              return Response.json({ token: created, secret: `sst_${draw(43, ALPHABET)}` }, { status: 201 });
            },
          },
          "/team/member/revoke": {
            POST: async (req) => {
              const requested = await readBody(req);
              const principal = await memberRoutes.authorize(requested.session, null);
              if (principal instanceof Response) return principal;
              const found = teamTokens.find((candidate) => candidate.id === requested.id && candidate.member === principal.email);
              if (found === undefined) return refusal(404, "not-found", "no such token of yours");
              found.revokedAt ??= Date.now();
              return Response.json({ token: found });
            },
          },
          "/team/revoke": {
            POST: async (req) => {
              const requested = await readBody(req);
              const found = teamTokens.find((candidate) => candidate.id === requested.id);
              if (found === undefined) return refusal(404, "not-found", "no such token");
              found.revokedAt ??= Date.now();
              return Response.json({ token: found });
            },
          },
          "/log": {
            GET: (req) => {
              const slug = new URL(req.url).searchParams.get("slug");
              const entries = slug === null ? log : log.filter((entry) => entry.slug === slug);
              return Response.json({ entries: [...entries].reverse().slice(0, 50) });
            },
          },
          "/unlock": {
            POST: async (req) => {
              const remaining = waitEnd - Date.now();
              if (remaining > 0) return refusal(429, "too-many-attempts", "Too many attempts.", { wait: Math.ceil(remaining / 1000) });
              const { password } = await readBody(req);
              if (!(await Bun.password.verify(text(password) || " ", hash))) {
                failures += 1;
                record({ operation: "unlock", result: "rejects", slug: null, file: null, variable: null, detail: "refused" });
                if (failures >= 3) {
                  waitEnd = Date.now() + 5000 * 2 ** (failures - 3);
                  return refusal(429, "too-many-attempts", "Too many attempts.", { wait: Math.ceil((waitEnd - Date.now()) / 1000) });
                }
                return refusal(401, "refused", "Wrong password.");
              }
              failures = 0;
              token = { value: crypto.randomUUID(), expiresAt: Date.now() + 10 * MINUTE };
              record({ operation: "unlock", result: "ok", slug: null, file: null, variable: null, detail: null });
              return Response.json({ token: token.value, expiresAt: token.expiresAt });
            },
          },
          "/lock": {
            POST: () => {
              token = null;
              record({ operation: "lock", result: "ok", slug: null, file: null, variable: null, detail: null });
              return new Response(null, { status: 204 });
            },
          },
          "/value": {
            POST: async (req) => {
              const requested = await readBody(req);
              if (!isValidToken(requested)) return refusal(401, "locked", "Locked.");
              const place = locate(requested);
              if (place instanceof Response) return place;
              const name = text(requested.variable);
              if (place.file.kind !== "variables") {
                return refusal(400, "invalid", `${place.file.name} is managed as a whole, replace its content instead`);
              }
              if (name === PASSWORD_VARIABLE) {
                return refusal(403, "out-of-scope", `${name} is never read back, change it with Change password`);
              }
              const value = place.file.variables.get(name);
              if (value === undefined) return refusal(404, "not-found", "No such variable.");
              record({ operation: "read", result: "ok", slug: place.project.slug, file: place.file.name, variable: name, detail: null });
              await Bun.sleep(250);
              return Response.json({ value });
            },
          },
          "/variable": {
            PUT: (req) =>
              writeTo(req, "set", ({ file: f }, requested) => {
                if (f.state !== "managed" || f.kind !== "variables") return refusal(409, "unmanaged", "This file is not managed.");
                const name = text(requested.variable);
                const value = text(requested.value);
                if (name === PASSWORD_VARIABLE) {
                  return refusal(403, "out-of-scope", `${name} is a password hash, change it with Change password`);
                }
                if (HASH_ONLY.includes(f.name)) {
                  return refusal(
                    403,
                    "out-of-scope",
                    `${f.name} holds ${PASSWORD_VARIABLE} only: any other variable would change how its service runs, not add a secret`,
                  );
                }
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
                  return refusal(400, "invalid", "Use letters, digits and underscores, not starting with a digit.");
                }
                if (/[\n\r\0]/.test(value)) return refusal(400, "invalid", "A value fits on one line.");
                keepPrevious(f);
                f.variables.set(name, value);
                return null;
              }),
            DELETE: (req) =>
              writeTo(req, "remove", ({ file: f }, requested) => {
                const name = text(requested.variable);
                if (name === PASSWORD_VARIABLE) {
                  return refusal(403, "out-of-scope", `${name} is a password hash, change it with Change password`);
                }
                if (!f.variables.has(name)) return refusal(404, "not-found", "No such variable.");
                keepPrevious(f);
                f.variables.delete(name);
                return null;
              }),
          },
          "/file": {
            POST: (req) =>
              writeTo(req, "create", ({ file: f }) => {
                if (f.state !== "absent") return refusal(409, "already-present", "This file already exists.");
                f.state = "managed";
                return null;
              }),
          },
          "/restore": {
            POST: (req) =>
              writeTo(req, "restore", ({ file: f }) => {
                // Before anything else: restoring would make valid again the password just changed.
                if (carriesPassword(f)) return refusal(403, "out-of-scope", "a password is only changed with Change password");
                if (f.previous === null) return refusal(404, "not-found", `no previous version of ${f.name}`);
                const current = { variables: f.variables, content: f.content };
                f.variables = f.previous.variables;
                f.content = f.previous.content;
                f.previous = current;
                return null;
              }),
          },
          "/content": {
            POST: async (req) => {
              const requested = await readBody(req);
              if (!isValidToken(requested)) return refusal(401, "locked", "Locked.");
              const place = locate(requested);
              if (place instanceof Response) return place;
              const f = place.file;
              if (f.kind !== "content") return refusal(400, "invalid", `${f.name} is an environment file, change its variables instead`);
              if (!f.readable) return refusal(403, "out-of-scope", `${f.name} is write-only, it can be replaced but never read back`);
              if (f.state !== "managed") return refusal(409, "unmanaged", "This file is not managed.");
              record({ operation: "read", result: "ok", slug: place.project.slug, file: f.name, variable: null, detail: null });
              await Bun.sleep(250);
              return Response.json({ content: f.content });
            },
            PUT: (req) =>
              writeTo(req, "replace", ({ file: f }, requested) => {
                if (f.kind !== "content") return refusal(400, "invalid", `${f.name} holds variables, not a single content.`);
                if (f.state !== "managed") return refusal(409, "unmanaged", "This file is not managed.");
                const content = text(requested.content);
                if (new TextEncoder().encode(content).byteLength > 64 * 1024) return refusal(400, "invalid", "Up to 64 KB.");
                if (content.includes("\0")) return refusal(400, "invalid", "A null byte can't be written.");
                keepPrevious(f);
                f.content = content;
                return null;
              }),
          },
          "/password": {
            POST: async (req) => {
              const requested = await readBody(req);
              if (!isValidToken(requested)) return refusal(401, "locked", "Locked.");
              const place = locate(requested);
              if (place instanceof Response) return place;
              const { project, file: f } = place;
              const name = text(requested.variable);
              if (f.kind !== "variables" || name !== PASSWORD_VARIABLE) {
                return refusal(403, "out-of-scope", `only ${PASSWORD_VARIABLE} changes here`);
              }
              const chosen = typeof requested.newPassword === "string" ? requested.newPassword : null;
              if (chosen !== null && chosen.length < MIN_PASSWORD) {
                return refusal(400, "invalid", `the new password must be at least ${MIN_PASSWORD} characters long`);
              }
              if (!(await Bun.password.verify(text(requested.dashboardPassword) || " ", hash))) {
                record({ operation: "password", result: "rejects", slug: project.slug, file: f.name, variable: name, detail: "wrong password" });
                return refusal(401, "refused", "wrong password");
              }
              const password = chosen ?? drawPassword();
              // The old hash is not kept: it may be the one that leaked.
              f.previous = null;
              // The bench keeps `demo` to unlock and to sign in: only the displayed hash changes.
              f.variables.set(name, await Bun.password.hash(password, { algorithm: "argon2id" }));
              if (!f.passwords.includes(name)) f.passwords.push(name);
              f.modifiedAt = Date.now();
              f.wait = project.service !== null;
              record({ operation: "password", result: "ok", slug: project.slug, file: f.name, variable: name, detail: null });
              return Response.json({ file: fileView(f), password: chosen === null ? password : null });
            },
          },
          "/portal": {
            POST: async (req) => {
              const requested = await readBody(req);
              if (!isValidToken(requested)) return refusal(401, "locked", "Locked.");
              const project = projectOf(requested);
              if (project instanceof Response) return project;
              if (typeof requested.active !== "boolean") return refusal(400, "invalid", "active must be a boolean");
              const active = requested.active;
              const direction = active ? "on" : "off";
              const trace = (result: "ok" | "rejects" | "failure", detail: string) =>
                record({ operation: "portal", result, slug: project.slug, file: null, variable: null, detail });
              // The real steward, before launching the gatekeeper: the rule, then the confirmation.
              if (!project.modifiable) {
                trace("rejects", "out-of-scope");
                return refusal(403, "out-of-scope", project.reason ?? "the portal of this site cannot be changed");
              }
              if (!active && requested.confirmation !== project.slug) {
                trace("rejects", "invalid");
                return refusal(400, "invalid", `type ${project.slug} to confirm removing the portal`);
              }

              // The gatekeeper, from here on: the refusals and failures are its own.
              const address = `${project.slug}.example.com`;
              if (project.slug === LOCK_HELD_SITE) {
                await Bun.sleep(400);
                trace("rejects", `${direction}, rejects`);
                return refusal(409, "unmanaged", lockHeldMessage("deploy-caddy", Date.now() - 40_000));
              }
              const before = portalOf(project.slug);
              if (before.requested === active && before.installed === active) {
                await Bun.sleep(400);
                trace("ok", `${direction}, ok`);
                const detail = active ? "already behind the portal" : "already open, no portal";
                return Response.json({ portal: { ...before, modifiable: true, reason: null }, detail });
              }
              await Bun.sleep(6000);
              if (project.slug === FAILING_SITE) {
                trace("failure", `${direction}, failed`);
                const problem = active ? `${address} should answer the portal's 401, got 502` : `${address} does not answer, got 502`;
                return refusal(500, "failure", `probe: ${problem}; previous configuration restored`);
              }
              const folder = FOLDERS.find((candidate) => candidate.slug === project.slug);
              if (folder !== undefined) {
                folder.portal = active;
                if (folder.manifest !== null) {
                  if (active) folder.manifest.portal = true;
                  else delete folder.manifest.portal;
                }
                await writeState();
              }
              trace("ok", `${direction}, ok`);
              const others = FOLDERS.length - 1;
              const checked = active ? `${address} answers the portal's 401` : `${address} answers without the portal`;
              const detail = `${active ? "portal set" : "portal removed"}: validated, reloaded, ${checked}, ${others} other site(s) still answer`;
              return Response.json({ portal: { ...portalOf(project.slug), modifiable: true, reason: null }, detail });
            },
          },
          // The egress proxy's connectors, through the real rules of
          // bin/cli/connectors.ts on files kept in memory.
          "/connectors": { GET: () => Response.json(connectorsView()) },
          "/connector": {
            PUT: async (req) => {
              const requested = await readBody(req);
              if (!isValidToken(requested)) return refusal(401, "locked", "Locked.");
              await Bun.sleep(400);
              const value = requested.value === null ? null : text(requested.value);
              const result = putConnector(connectorsFile, { name: requested.name, baseUrl: requested.baseUrl, header: requested.header, value }, new Date().toISOString(), OWNER_ACTOR);
              if ("error" in result) return refusal(400, "invalid", result.error);
              connectorsFile = result.file;
              egressRows.unshift(egressRow("owner", "connector.update", text(requested.name), { change: result.created ? "created" : "updated" }));
              return Response.json(connectorsView());
            },
            DELETE: async (req) => {
              const requested = await readBody(req);
              if (!isValidToken(requested)) return refusal(401, "locked", "Locked.");
              const name = text(requested.name);
              if (requested.confirmation !== name) return refusal(400, "invalid", `type ${name} to confirm removing the connector`);
              const result = removeConnector(connectorsFile, grantsFile, name, new Date().toISOString(), OWNER_ACTOR);
              if ("error" in result) return refusal(404, "not-found", result.error);
              connectorsFile = result.connectors;
              grantsFile = result.grants;
              egressRows.unshift(egressRow("owner", "connector.update", name, { change: "removed" }));
              return Response.json(connectorsView());
            },
          },
          "/grant": {
            PUT: async (req) => {
              const requested = await readBody(req);
              if (!isValidToken(requested)) return refusal(401, "locked", "Locked.");
              const granted = requested.granted === true;
              if (granted && !FOLDERS.some((folder) => folder.slug === requested.slug)) {
                return refusal(403, "out-of-scope", "not a site deployed under /srv/sites");
              }
              const result = setGrant(grantsFile, connectorsFile, requested.slug, requested.connector, granted, new Date().toISOString(), OWNER_ACTOR);
              if ("error" in result) return refusal(400, "invalid", result.error);
              grantsFile = result.file;
              if (result.changed) egressRows.unshift(egressRow("owner", "connector.grant", text(requested.slug), { connector: requested.connector, granted }));
              return Response.json(connectorsView());
            },
          },
          "/restart": {
            POST: async (req) => {
              const requested = await readBody(req);
              if (!isValidToken(requested)) return refusal(401, "locked", "Locked.");
              const project = projectOf(requested);
              if (project instanceof Response) return project;
              if (project.service === null) return refusal(400, "invalid", `${project.slug} has no service: Caddy serves its files.`);
              // The dashboard itself: the answer leaves first, the restart follows, and the relay answering cuts out.
              if (project.slug === "dashboard") {
                for (const f of project.files) f.wait = false;
                record({ operation: "restart", result: "ok", slug: project.slug, file: null, variable: null, detail: "scheduled" });
                setTimeout(() => void restartDashboard(), 800);
                return Response.json({ verdict: { kind: "scheduled", state: "active", subState: "running", restarts: 0 } });
              }
              await Bun.sleep(2500);
              // roster always loops, the others come back up.
              const loop = project.slug === "roster";
              const verdict = loop
                ? { kind: "looping", state: "activating", subState: "auto-restart", restarts: 4 }
                : { kind: "active", state: "active", subState: "running", restarts: 0 };
              if (!loop) {
                project.service = { state: "active", subState: "running", startedAt: Date.now() };
                for (const f of project.files) f.wait = false;
              }
              record({ operation: "restart", result: "ok", slug: project.slug, file: null, variable: null, detail: verdict.kind });
              return Response.json({ verdict });
            },
          },
        },
        fetch: () => refusal(404, "not-found", "Unknown route."),
      });

// --- The audits --------------------------------------------------------------

/**
 * A page of an audit read by id, newest first, as the portal and the egress
 * proxy answer `?limit=&before=`: the rows older than `before`, `limit` at most.
 */
function page<T extends { id: number }>(rows: readonly T[], params: URLSearchParams): T[] {
  const limit = Math.min(500, Number(params.get("limit") ?? 100));
  const before = Number(params.get("before") ?? Number.MAX_SAFE_INTEGER);
  return rows.filter((row) => row.id < before).slice(0, limit);
}

/**
 * The portal's audit: sign-ins of every kind, one refused, guests, sharing
 * changes, in the shape of portal/src/database.ts. Never a password, as there.
 */
let portalEventId = 0;
function portalEvent(actor: string, action: string, target: string | null, detail: object | null, at: number) {
  portalEventId += 1;
  return { id: portalEventId, at: new Date(at).toISOString(), actor, action, target, detail };
}
const portalEvents = [
  portalEvent("owner", "sharing.update", "calendar.example.com", { mode: "domain", previousMode: "admins", peopleAdded: [], peopleRemoved: [], domainsAdded: ["example.com"], domainsRemoved: [] }, start - 9 * DAY),
  // A colleague opening the calendar through the day, for a week: enough rows
  // for the Activity page to need more than one page.
  ...Array.from({ length: 7 * 14 }, (_, index) => {
    const day = 7 - Math.floor(index / 14);
    return portalEvent("bob@example.com", "portal.signin", "calendar.example.com", { method: "oidc", role: "member" }, start - day * DAY + (8 + (index % 14)) * HOUR);
  }),
  portalEvent("owner", "sharing.update", "cms.example.com", { mode: "people", previousMode: "people", peopleAdded: ["editor@example.org"], peopleRemoved: [], domainsAdded: [], domainsRemoved: [] }, start - 2 * DAY),
  portalEvent("guest:benchGuest000001", "portal.signin", "cms.example.com", { method: "guest" }, start - 2 * HOUR),
  portalEvent("owner", "portal.signin", "photos.example.com", { method: "password", count: 3 }, start - 90 * MINUTE),
  portalEvent("eve@elsewhere.example.net", "portal.signin_failed", "cms.example.com", { method: "oidc", reason: "not-shared" }, start - 50 * MINUTE),
  portalEvent("anonymous", "portal.signin_failed", "library.example.com", { method: "password" }, start - 30 * MINUTE),
  portalEvent("alice@example.com", "portal.signin", "cms.example.com", { method: "oidc", role: "member" }, start - 18 * MINUTE),
  portalEvent("owner@example.com", "portal.signin", "calendar.example.com", { method: "oidc", role: "admin" }, start - 6 * MINUTE),
  portalEvent("alice@example.com", "portal.signout", "cms.example.com", null, start - 4 * MINUTE),
]
  .filter((event) => !SHOWCASE || event.action !== "portal.signin_failed")
  .reverse();

// --- The fake egress proxy ---------------------------------------------------

/**
 * The connectors and grants as the steward would find them in
 * /etc/sitesolide-egress, and the proxy's audit, all in memory. The values are
 * placeholders made for the bench.
 */
let connectorsFile: ConnectorsFile = EMPTY_CONNECTORS;
for (const [name, baseUrl, header] of [
  ["slack", "https://slack.com/api", "Authorization"],
  ["github", "https://api.github.com/repos/example", "Authorization"],
] as const) {
  const created = putConnector(connectorsFile, { name, baseUrl, header, value: `Bearer bench-placeholder-${name}` }, new Date(start - 9 * DAY).toISOString(), OWNER_ACTOR);
  if ("file" in created) connectorsFile = created.file;
}
let grantsFile: GrantsFile = EMPTY_GRANTS;
for (const [slug, name] of [["cms", "slack"], ["roster", "github"], ["retired-tool", "slack"]] as const) {
  const granted = setGrant(grantsFile, connectorsFile, slug, name, true, new Date(start - 6 * DAY).toISOString(), OWNER_ACTOR);
  if ("file" in granted) grantsFile = granted.file;
}
/** Who asks, as the deployed manifests would say. */
const CONNECTOR_REQUESTS = [
  { slug: "cms", connectors: ["slack"] },
  { slug: "lab", connectors: ["github", "slack"] },
  { slug: "roster", connectors: ["github", "mail"] },
];

function connectorsView() {
  return {
    installed: true,
    state: "managed",
    reason: null,
    connectors: connectorViews(connectorsFile),
    grants: grantsFile.grants,
    requests: CONNECTOR_REQUESTS,
    sites: FOLDERS.map((folder) => folder.slug).sort(),
  };
}

let egressRowId = 0;
function egressRow(actor: string, action: string, target: string | null, detail: object, at = Date.now()) {
  egressRowId += 1;
  return { id: egressRowId, at: new Date(at).toISOString(), actor, action, target, detail: JSON.stringify(detail) };
}
// Oldest first, so that ids grow with time as the proxy's own do.
const egressRows = [
  egressRow("owner", "connector.update", "github", { change: "created", baseUrl: "https://api.github.com/repos/example", header: "Authorization" }, start - 9 * DAY),
  egressRow("owner", "connector.grant", "roster", { connector: "github", granted: true }, start - 6 * DAY),
  egressRow("system", "egress.denied", "roster", { destination: "metadata.example.com:443", reason: "resolves to a cloud metadata address", count: 1 }, start - 5 * HOUR),
  egressRow("system", "connector.use", "roster", { connector: "github", count: 5, failures: 2, statuses: { "2xx": 3, "5xx": 2 } }, start - 2 * HOUR),
  egressRow("system", "egress.denied", "lab", { destination: "pastebin.com:443", reason: "not in the list", count: 7 }, start - 12 * MINUTE),
  egressRow("system", "connector.use", "cms", { connector: "slack", count: 42, failures: 0, statuses: { "2xx": 42 } }, start - 3 * MINUTE),
].sort((a, b) => b.id - a.id);

const egress =
  process.env.BENCH_NO_EGRESS === "1"
    ? null
    : Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        routes: {
          // Newest first, by pages, like egress/src/connectors.ts: the Activity page goes back with `before`.
          "/audit": { GET: (req) => Response.json({ rows: page([...egressRows].sort((a, b) => b.id - a.id), new URL(req.url).searchParams) }) },
          "/status": {
            GET: () => Response.json({ connectors: Object.keys(connectorsFile.connectors).length, grants: grantsFile.grants.length, errors: [], started: new Date(start).toISOString(), openTunnels: 3 }),
          },
        },
        fetch: () => new Response("404", { status: 404 }),
      });

// --- The fake portal ---------------------------------------------------------

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

function draw(length: number, alphabet: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

/** The bench's sign-ins in flight: a flow until a user is picked, a code until it is redeemed. */
const benchFlows = new Map<string, { binding: string; returnTo: string; reauth: boolean }>();
const benchCodes = new Map<string, { binding: string; returnTo: string; email: string; reauth: boolean }>();
/** The fake portal's own address, where the browser goes to sign in; set once it listens. */
let portalAddress = "";

const portal =
  process.env.BENCH_NO_PORTAL === "1"
    ? null
    : Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        routes: {
          // How people sign in, and what the portal reads its access from,
          // like portal/src/admin.ts.
          "/admin/sharing": { GET: () => Response.json({ sso, sites: [] }) },
          "/admin/access": { GET: () => Response.json({ reading: process.env.BENCH_OLD_PORTAL === "1" ? "portal" : "steward", writtenAt: Date.now() }) },
          "/admin/audit": { GET: (req) => Response.json({ events: page(portalEvents, new URL(req.url).searchParams) }) },

          // A member's sign-in, as portal/src/dashboard.ts: the flow sealed
          // around the dashboard's binding, a page of the bench's own in the
          // provider's place, and the code redeemed for a signed assertion.
          "/admin/dashboard/flow": {
            POST: async (req) => {
              if (!sso.configured) return Response.json({ error: "not-offered", message: "no provider" }, { status: 404 });
              const body = await readBody(req);
              const id = draw(24, ALPHABET);
              benchFlows.set(id, { binding: text(body.binding), returnTo: text(body.returnTo).startsWith("/") ? text(body.returnTo) : "/", reauth: body.reauth === true });
              return Response.json({ start: `${portalAddress}/oidc/start?flow=${id}` });
            },
          },
          "/oidc/start": (req) => {
            const flow = new URL(req.url).searchParams.get("flow") ?? "";
            if (!benchFlows.has(flow)) return new Response("unknown flow", { status: 400 });
            const choice = (email: string, label: string) => `<p><a href="/oidc/pick?flow=${flow}&email=${encodeURIComponent(email)}">Sign in as ${label}</a></p>`;
            return new Response(
              `<!doctype html><meta charset="utf-8"><title>Bench provider</title><h1>Bench identity provider</h1>${choice("alice@example.com", "alice@example.com: Admin of calendar, Developer of cms, Viewer of photos")}${choice("bruno@example.com", "bruno@example.com: Admin of cms, Developer of calendar")}${choice("chloe@example.com", "chloe@example.com: Viewer of calendar")}${choice("stranger@example.com", "stranger@example.com, no role anywhere")}`,
              { headers: { "Content-Type": "text/html; charset=utf-8" } },
            );
          },
          "/oidc/pick": (req) => {
            const params = new URL(req.url).searchParams;
            const flow = benchFlows.get(params.get("flow") ?? "");
            if (flow === undefined) return new Response("unknown flow", { status: 400 });
            benchFlows.delete(params.get("flow")!);
            const code = draw(43, ALPHABET);
            benchCodes.set(code, { ...flow, email: params.get("email") ?? "" });
            return new Response(null, { status: 303, headers: { Location: `${publicAddress}/api/sso/complete?code=${code}` } });
          },
          "/admin/dashboard/redeem": {
            POST: async (req) => {
              const body = await readBody(req);
              const minted = benchCodes.get(text(body.code));
              benchCodes.delete(text(body.code));
              if (minted === undefined || minted.binding !== body.binding) return Response.json({ error: "wrong-browser", message: "expired" }, { status: 400 });
              const key = readPrivateKey(readFileSync(join(portalKeyFolder, "assertion.key"), "utf8"));
              if (key === null) return Response.json({ error: "no-key", message: "no key" }, { status: 503 });
              const nowS = Math.floor(Date.now() / 1000);
              // A member's unlock: the bench's page stands for a forced sign-in, fresh, and says so.
              const reauth = minted.reauth === true;
              return Response.json({
                assertion: await signAssertion(key, { email: minted.email, name: null, authTime: nowS, reauth }, nowS),
                returnTo: minted.returnTo,
                reauth,
              });
            },
          },
        },
        fetch: () => new Response("404", { status: 404 }),
      });

portalAddress = portal === null ? "" : `http://127.0.0.1:${portal.port}`;

// The key pair, and the registry made from the stores above by the real migration.
await memberRoutes.ensureKeys();
await accessStore.ensure();

// --- The service -------------------------------------------------------------

const publicAddress = `http://localhost:${PORT}`;

function startService() {
  return Bun.spawn(["bun", "server.ts"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(SERVICE_PORT),
      PUBLIC_URL: publicAddress,
      PASSWORD_HASH: hash,
      // The snapshot's zone: without it, the landing's folder is not
      // recognised, and its address reads example.com.example.com.
      SITESOLIDE_ZONE: "example.com",
      DATA_DIR: folder,
      STATE_FILE: stateFile,
      STEWARD_SOCKET: socket,
      // A closed port when the portal is cut off: the page must say 502.
      PORTAL_URL: portal === null ? "http://127.0.0.1:9" : `http://127.0.0.1:${portal.port}`,
      // The same for the egress proxy: a closed port, and the page says it.
      EGRESS_URL: egress === null ? "http://127.0.0.1:9" : `http://127.0.0.1:${egress.port}`,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
}

let service = startService();
let stopping = false;

/**
 * The restart of the dashboard asked for from its own secrets: the service
 * stops, stays cut off for a few seconds, and comes back with the same
 * database. The sessions survive, the unlocking token does not, as in
 * production.
 */
async function restartDashboard() {
  console.log("  bench: restarting the dashboard");
  service.kill();
  await service.exited;
  await Bun.sleep(3000);
  if (!stopping) service = startService();
}

// --- The front end, playing Caddy --------------------------------------------

/**
 * What `file_server` returns for a path: the file, the `index.html` of a
 * directory asked for with its trailing slash, a redirect to the trailing slash
 * for a directory asked for without one, or nothing.
 */
function serveFile(url: URL): Response {
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return new Response("400", { status: 400 });
  }
  const target = normalize(join(PUBLIC, path));
  if (!target.startsWith(PUBLIC)) return new Response("404", { status: 404 });

  let infos: ReturnType<typeof statSync> | undefined;
  try {
    infos = statSync(target);
  } catch {
    return new Response("404: not found", { status: 404 });
  }
  if (infos.isDirectory()) {
    if (!url.pathname.endsWith("/")) {
      return new Response(null, { status: 308, headers: { Location: `${url.pathname}/${url.search}` } });
    }
    const index = join(target, "index.html");
    try {
      statSync(index);
    } catch {
      return new Response("404: not found", { status: 404 });
    }
    return new Response(Bun.file(index), { headers: { "Cache-Control": "no-cache" } });
  }
  return new Response(Bun.file(target), { headers: { "Cache-Control": "no-cache" } });
}

/** The routes of the contract that the relay might not carry yet, and the fields they relay. */
const NEW_ROUTES: Record<string, { methods: string[]; fields: string[] }> = {
  "/api/secrets/content": { methods: ["POST", "PUT"], fields: ["slug", "file", "content"] },
  "/api/secrets/password": { methods: ["POST"], fields: ["slug", "file", "variable", "dashboardPassword", "newPassword"] },
  "/api/secrets/portal": { methods: ["POST"], fields: ["slug", "active", "confirmation"] },
};

/**
 * A fallback relay, for a `server.ts` that would not carry a route of the
 * contract yet: the front end checks the origin and the session with the real
 * service, then reaches the fake steward with its live token. It only serves if
 * the service answered 404 or 405: an up-to-date relay keeps the upper hand.
 */
async function fallbackRelay(req: Request, url: URL, body: ArrayBuffer | undefined): Promise<Response> {
  if (steward === null) return Response.json({ error: "failure", message: "Can't reach the steward." }, { status: 502 });
  if (req.method !== "GET" && req.headers.get("origin") !== publicAddress) {
    return Response.json({ error: "origin-refused" }, { status: 403 });
  }
  const state = await fetch(`http://127.0.0.1:${SERVICE_PORT}/api/secrets`, { headers: { cookie: req.headers.get("cookie") ?? "" } });
  if (state.status === 401) return Response.json({ error: "no-session" }, { status: 401 });
  const dashboard = (await state.json().catch(() => null)) as { to?: number | null } | null;
  if (dashboard?.to == null || token === null) {
    return Response.json({ error: "locked", message: "Unlock secrets first." }, { status: 423 });
  }
  const route = NEW_ROUTES[url.pathname];
  const received = body === undefined ? {} : (JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>);
  const requested: Record<string, unknown> = { token: token.value };
  for (const field of route?.fields ?? []) if (field in received) requested[field] = received[field];
  const response = await fetch(`http://localhost${url.pathname.replace("/api/secrets", "")}`, {
    unix: socket,
    method: req.method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requested),
  });
  if (response.status === 401) {
    const refuse = (await response.json()) as { error?: string };
    if (refuse.error === "locked") return Response.json({ error: "locked", message: "Unlock secrets first." }, { status: 423 });
    return Response.json(refuse, { status: 401 });
  }
  return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json" } });
}

const front = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  // The simulated gatekeeper takes a few seconds, a restart too.
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return serveFile(url);
    const upstream = new URL(url.pathname + url.search, `http://127.0.0.1:${SERVICE_PORT}`);
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    let response: Response;
    try {
      response = await fetch(upstream, { method: req.method, headers: req.headers, body: body, redirect: "manual" });
    } catch {
      return new Response("502: service unreachable", { status: 502 });
    }
    const fresh = NEW_ROUTES[url.pathname];
    if (fresh?.methods.includes(req.method) && (response.status === 404 || response.status === 405)) {
      return fallbackRelay(req, url, body);
    }
    return response;
  },
});

console.log("");
console.log(`  page bench        ${publicAddress}`);
console.log(`  password          ${PASSWORD}`);
console.log(`  PASSWORD_HASH     ${hash}`);
console.log(`  folder            ${folder}`);
console.log(`  steward           ${steward === null ? "off" : socket}`);
console.log(`  portal            ${portal === null ? "off" : `127.0.0.1:${portal.port}`}`);
console.log("");

function stop() {
  stopping = true;
  if (stateTimer !== null) clearInterval(stateTimer);
  service.kill();
  void front.stop(true);
  void steward?.stop(true);
  void portal?.stop(true);
  rmSync(folder, { recursive: true, force: true });
  process.exit(0);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
