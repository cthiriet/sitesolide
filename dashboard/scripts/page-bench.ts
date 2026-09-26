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
 * - a simulated gatekeeper behind `/portal`, which takes six seconds: it puts
 *   up and takes away the door of `wheels` or of `bookshop`, always
 *   fails on `photos` and restores, refuses `roster` because Caddy's
 *   lock is held from the workstation, and refuses `library`, for which a
 *   backup of an interrupted action has remained: its state is unknown. The
 *   messages are those of the real gatekeeper and of the real steward,
 *   imported from src/;
 * - a fake portal on the loopback, which answers `/admin/guests` like
 *   `portal/src/admin.ts`;
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
 *   BENCH_NO_PORTAL=1     no portal: Guests says 502
 *   BENCH_EMPTY=1             no snapshot at all: the "No snapshot" state
 *   BENCH_SHOWCASE=1          the same fleet healed, for the README's screenshots
 *
 * The password is fixed and obvious, `demo`, since nothing here is real.
 */
import { mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { GUEST_DURATIONS, cleanLabel, type Guest } from "../borrowed/guests";
import { fixedRefusal } from "../src/gatekeeper/rules";
import { lockHeldMessage } from "../src/gatekeeper/transaction";
import { HASH_ONLY, PASSWORD_VARIABLE, MIN_PASSWORD } from "../src/secrets/scope";
import { INTERRUPTED_TRANSACTION_REASON } from "../src/secrets/portal";

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
      description: "Common door of the personal sites",
      start: "bun run server.ts",
      port: 3026,
      secrets: ["portal.env"],
    },
    unit: { memory: 29 * MB, peak: 64 * MB, limit: 128 * MB, sinceMs: 4 * DAY, cpu: 0.2 },
    bytes: 4 * MB,
    deployedMs: 4 * DAY,
  },
  {
    slug: "roster",
    manifest: {
      slug: "roster",
      description: "Staff roster",
      start: "bun run server.ts",
      port: 3045,
      secrets: ["roster.env"],
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
  const kept = "\tforward_auth @portal_guard 127.0.0.1:3026 {\n\t\turi /verifier\n\t}\n";
  const blocks: Record<string, string> = SHOWCASE ? {} : { "old-kiosk": "# forgotten block\n" };

  const folders = FOLDERS.map((d) => {
    blocks[d.slug] = `# ${d.slug}\n${d.portal === true ? kept : ""}`;
    let unit: Record<string, string> | null = null;
    if (d.unit !== null) {
      const { before, now: nsec } = counters(d.unit);
      cpu[d.slug] = before;
      const active = d.unit.active ?? "active";
      unit = {
        LoadState: "loaded",
        ActiveState: active,
        SubState: d.unit.subState ?? "running",
        MemoryCurrent: active === "active" ? String(d.unit.memory) : "[not set]",
        MemoryPeak: String(d.unit.peak),
        MemoryMax: String(d.unit.limit),
        NRestarts: String(d.unit.restarts ?? 0),
        ActiveEnterTimestamp: active === "active" ? `@${Math.floor((generatedAt - d.unit.sinceMs) / 1000)}` : "@0",
        CPUUsageNSec: active === "active" ? String(nsec) : "[not set]",
      };
    }
    return {
      slug: d.slug,
      manifest: d.manifest === null ? null : JSON.stringify(d.manifest),
      unit,
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
    // roster (3045) does not listen: it is looping.
    ports: SHOWCASE ? [3040, 3041, 3022, 3043, 3044, 3045, 3026] : [3040, 3041, 3022, 3043, 3044, 3026],
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

function isValidToken(requested: Record<string, unknown>): boolean {
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

const steward =
  process.env.BENCH_NO_STEWARD === "1"
    ? null
    : Bun.serve({
        unix: socket,
        routes: {
          "/projects": { GET: () => Response.json({ projects: PROJECTS.map(projectView) }) },
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

// --- The fake portal ---------------------------------------------------------

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

function draw(length: number, alphabet: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

const guests: Guest[] = [
  { id: "benchGuest000001", host: "cms.example.com", label: "Alice", createdAt: start - 6 * DAY - 19 * HOUR, expiresAt: start + 5 * HOUR, seenAt: start - 2 * HOUR },
  { id: "benchGuest000002", host: "calendar.example.com", label: "Example Accounting", createdAt: start - DAY, expiresAt: start + 6 * DAY, seenAt: null },
  { id: "benchGuest000003", host: "photos.example.com", label: "Bob and Carol", createdAt: start - 41 * DAY, expiresAt: null, seenAt: start - 3 * DAY },
  { id: "benchGuest000004", host: "library.example.com", label: "Dave, intern", createdAt: start - 32 * DAY, expiresAt: start - 2 * DAY, seenAt: start - 3 * DAY },
];

const portal =
  process.env.BENCH_NO_PORTAL === "1"
    ? null
    : Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        routes: {
          "/admin/guests": {
            GET: () => Response.json({ guests }),
            POST: async (req) => {
              const body = await readBody(req);
              const label = cleanLabel(body.label);
              if (label === null) return Response.json({ error: "invalid-label" }, { status: 400 });
              if (!GUEST_DURATIONS.some((choice) => choice.seconds === body.durationS)) {
                return Response.json({ error: "invalid-duration" }, { status: 400 });
              }
              const durationS = body.durationS as number | null;
              const now = Date.now();
              const invite: Guest = {
                id: draw(16, `${ALPHABET}_-`),
                host: text(body.host),
                label,
                createdAt: now,
                expiresAt: durationS === null ? null : now + durationS * 1000,
                seenAt: null,
              };
              guests.push(invite);
              const password = [0, 1, 2, 3].map(() => draw(4, ALPHABET)).join("-");
              return Response.json({ invite, password }, { status: 201 });
            },
          },
          "/admin/invites/:id": {
            DELETE: (req) => {
              const rank = guests.findIndex((invite) => invite.id === req.params.id);
              if (rank < 0) return Response.json({ error: "unknown-access" }, { status: 404 });
              guests.splice(rank, 1);
              return new Response(null, { status: 204 });
            },
          },
        },
        fetch: () => new Response("404", { status: 404 }),
      });

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
