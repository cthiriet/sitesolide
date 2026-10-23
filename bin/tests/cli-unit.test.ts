import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownManifests } from "./manifests";
import { compareDirectives, sameDirectives } from "../cli/comparison";
import { hasStore, isApp, legacySecretFiles, readManifest, servicesOf, validate, type Manifest } from "../cli/manifest";
import { STORE_UNIT_LINES_AFTER, storeCredentials, storeEnvironmentFile } from "../cli/store";
import {
  projectPaths,
  decideUnit,
  earlierGenerations,
  generateUnit,
  generateUnits,
  isTimerUnit,
  readUnitAnswer,
  MARKER_ABSENT,
  MARKER_PRESENT,
  runningUnits,
  sandboxedInstallCommand,
  substitute,
  systemdRunArguments,
  systemUser,
  timerUnit,
  unitArgument,
  unitFileName,
  unitNames,
  watchedUnits,
  withoutBindLines,
  withoutStoreLines,
  withoutSyscallLines,
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
  "SystemCallArchitectures=native",
  "SystemCallFilter=@system-service",
  "SystemCallErrorNumber=EPERM",
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

  test("with a file of the old form, the file is loaded, the store after it, and the folder closed all the same", () => {
    // PID 1 reads EnvironmentFile before the walls go up (bench Q3): the
    // folder no longer has to stay visible to a project that reads a file.
    const unit = generateUnit({ ...APP, secrets: ["budget.env"] });
    expect(unit).toInclude("\nEnvironmentFile=-/etc/sitesolide/budget.env\nEnvironmentFile=-/etc/sitesolide/projects/budget/env\n");
    expect(unit).toInclude("\nInaccessiblePaths=-/etc/sitesolide\n");
  });

  test("the dash of EnvironmentFile is kept, on a flat file as on the store", () => {
    // Without it, a missing file makes the start fail and Restart=always makes
    // it loop. deploy warns of a missing variable instead, and an app that
    // cannot do without it stops at its start, which the stability check says.
    const unit = generateUnit({ ...APP, secrets: ["budget.env"] });
    for (const line of unit.split("\n").filter((line) => line.startsWith("EnvironmentFile="))) expect(line).toStartWith("EnvironmentFile=-/");
  });
});

/**
 * Synthetic manifests, one per shape a project can take, each valid: what the
 * store's lines are judged on, and what the earlier generations below were
 * captured from.
 */
const START = "/usr/local/bin/bun run server.ts";
const SYNTHETIC: Record<string, Manifest> = {
  none: { slug: "shop", start: START, port: 3022, env: { PUBLIC_URL: "https://{slug}.{zone}" } },
  legacy: { slug: "mail", start: START, port: 3023, network: "outbound", secrets: ["mail-ses.env", "mail-stripe.env"] },
  names: { slug: "cart", start: START, port: 3024, secrets: ["ADMIN_TOKEN", "STRIPE_SECRET_KEY"] },
  long: {
    slug: "engine",
    build: "bun run build",
    services: {
      api: { start: "/srv/sites/engine/app/api", port: 3040 },
      postgres: { start: "/usr/lib/postgresql/17/bin/postgres -D /srv/sites/engine/data/pg", internal: true, backup: { folder: "pg", command: "/bin/sh /srv/sites/engine/app/backup.sh" } },
    },
    secrets: { runtime: ["POSTGRES_PASSWORD"], files: ["gcp.json", "tls.key"], build: ["CMS_TOKEN"] },
  },
  multi: {
    slug: "lab",
    services: {
      web: { start: "/srv/sites/lab/app/web", port: 3050 },
      api: { start: "/srv/sites/lab/app/api", port: 3051, routes: ["/api/*"] },
      worker: { start: "/srv/sites/lab/app/worker", internal: true },
    },
    secrets: ["lab.env"],
  },
  scheduled: {
    slug: "news",
    services: {
      web: { start: "/srv/sites/news/app/web", port: 3060 },
      sync: { start: "/srv/sites/news/app/sync", schedule: "*:0/15", timeout: "15m" },
      queue: { start: "/srv/sites/news/app/queue", internal: true, cpu: "50%" },
    },
    secrets: ["FEED_TOKEN"],
  },
  anchored: {
    slug: "jobs",
    services: {
      report: { start: "/srv/sites/jobs/app/report", schedule: "daily" },
      cleanup: { start: "/srv/sites/jobs/app/cleanup", schedule: "Sun 03:00" },
    },
    secrets: { files: ["report.key"] },
  },
  dashboard: { slug: "dashboard", start: START, port: 3005, network: "outbound", env: { SITESOLIDE_ZONE: "{zone}" }, secrets: ["dashboard.env"] },
  portal: { slug: "portal", start: START, port: 3006, secrets: ["portal.env"] },
  static: { slug: "blog", build: "bun run build", publicDir: "dist", env: { PUBLIC_SITE_URL: "https://{slug}.{zone}" }, secrets: { build: ["CMS_TOKEN"] } },
} as Record<string, Manifest>;

const WITH_STORE = ["none", "legacy", "names", "long", "multi", "scheduled", "anchored"];
const STORELESS = ["dashboard", "portal"];
const placeholdersOf = (manifest: Manifest) => ({ slug: manifest.slug, zone: "test-zone.invalid", contact: "" });
const unitsOf = (name: string) => generateUnits(SYNTHETIC[name]!, placeholdersOf(SYNTHETIC[name]!));
/** The units that run a program of the project's: neither an anchor nor a timer. */
const serviceUnitsOf = (name: string) => {
  const manifest = SYNTHETIC[name]!;
  const services = new Set(servicesOf(manifest).map((service) => service.unit));
  return unitsOf(name).filter(({ unit }) => services.has(unit));
};
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

describe("the project's store, in every service unit", () => {
  test("the synthetic manifests are each what validate() accepts", () => {
    for (const [name, manifest] of Object.entries(SYNTHETIC)) expect({ name, errors: validate(manifest, "test-zone.invalid") }).toEqual({ name, errors: [] });
  });

  test.each(WITH_STORE)("%s: each service carries the four lines once, the store's env file after the old form's", (name) => {
    const slug = SYNTHETIC[name]!.slug;
    const services = serviceUnitsOf(name);
    expect(services.length).toBeGreaterThan(0);
    for (const { unit, text } of services) {
      const lines = text.split("\n");
      const once = (line: string) => lines.filter((written) => written === line).length;
      for (const line of [
        `EnvironmentFile=-/etc/sitesolide/projects/${slug}/env`,
        `LoadCredential=files:/etc/sitesolide/projects/${slug}/files`,
        "InaccessiblePaths=-/etc/sitesolide",
        "ProtectProc=invisible",
      ]) {
        expect({ unit, line, count: once(line) }).toEqual({ unit, line, count: 1 });
      }
      // The old form's files first, in the manifest's order, the store last:
      // systemd lets a later EnvironmentFile win (I4).
      const files = lines.filter((line) => line.startsWith("EnvironmentFile="));
      expect(files).toEqual([...legacySecretFiles(SYNTHETIC[name]!).map((file) => `EnvironmentFile=-/etc/sitesolide/${file}`), `EnvironmentFile=-/etc/sitesolide/projects/${slug}/env`]);
      expect(lines.filter((line) => line.startsWith("LoadCredential"))).toEqual([`LoadCredential=files:/etc/sitesolide/projects/${slug}/files`]);
    }
  });

  test("the lines come from the store module, in its words", () => {
    const text = serviceUnitsOf("long")[0]!.text;
    expect(text).toInclude(`\nEnvironmentFile=${storeEnvironmentFile("engine")}\nLoadCredential=${storeCredentials("engine")}\n`);
    expect(text).toInclude(`\n${STORE_UNIT_LINES_AFTER.join("\n")}\n`);
  });

  test("a project's units do not depend on its names or its files: setting one, or declaring one later, rewrites no unit", () => {
    const base = SYNTHETIC.long!;
    const without = generateUnits({ ...base, secrets: { build: ["CMS_TOKEN"] } } as Manifest, placeholdersOf(base));
    const other = generateUnits({ ...base, secrets: { runtime: ["OTHER", "MORE"], files: ["other.pem"], build: ["CMS_TOKEN"] } } as Manifest, placeholdersOf(base));
    expect(unitsOf("long")).toEqual(without);
    expect(other).toEqual(without);
    // The short form and none at all, alike.
    const shop = SYNTHETIC.none!;
    expect(generateUnits({ ...shop, secrets: ["API_KEY"] } as Manifest, placeholdersOf(shop))).toEqual(generateUnits(shop, placeholdersOf(shop)));
  });

  test.each([...WITH_STORE, ...STORELESS])("%s: no %%d, no credentials path, no PrivatePIDs, no ProcSubset, anywhere", (name) => {
    for (const { text } of unitsOf(name)) {
      expect(text).not.toInclude("%d");
      expect(text).not.toInclude("/run/credentials");
      expect(text).not.toMatch(/^(PrivatePIDs|ProcSubset|SetCredential|ImportCredential|LoadCredentialEncrypted)=/m);
      expect(text).not.toMatch(/^Environment=CREDENTIALS_DIRECTORY/m);
    }
  });

  test("an anchor and a timer run no program of the project's: they carry none of it, as before", () => {
    const anchored = Object.fromEntries(unitsOf("anchored").map(({ unit, text }) => [unit, text]));
    for (const unit of ["jobs", "jobs.report.timer", "jobs.cleanup.timer"]) {
      expect(anchored[unit]!).not.toMatch(/^(EnvironmentFile|LoadCredential|ProtectProc|InaccessiblePaths)=/m);
      expect(sha256(anchored[unit]!)).toBe(FINGERPRINTS_07.anchored![unit]!);
    }
    expect(anchored["jobs.report"]!).toInclude("\nLoadCredential=files:/etc/sitesolide/projects/jobs/files\n");
    const scheduled = Object.fromEntries(unitsOf("scheduled").map(({ unit, text }) => [unit, text]));
    expect(sha256(scheduled["news.sync.timer"]!)).toBe(FINGERPRINTS_07.scheduled!["news.sync.timer"]!);
    expect(scheduled["news.sync"]!).toInclude("\nProtectProc=invisible\n");
  });

  test.each(STORELESS)("%s keeps its flat file and its unit of 0.7, byte for byte (I10)", (name) => {
    const units = unitsOf(name);
    expect(Object.fromEntries(units.map(({ unit, text }) => [unit, sha256(text)]))).toEqual(FINGERPRINTS_07[name]!);
    for (const { text } of units) {
      expect(text).not.toMatch(/\/projects\/|^(LoadCredential|ProtectProc|InaccessiblePaths)=/m);
      expect(text).toInclude(`\nEnvironmentFile=-/etc/sitesolide/${name}.env\n`);
      expect(withoutStoreLines(text)).toBe(text);
    }
  });

  test("the platform's own dashboard and portal, as deployed, read no store", () => {
    const storeless = knownManifests().filter((known) => known.slug === "dashboard" || known.slug === "portal");
    expect(storeless.map((manifest) => manifest.slug).toSorted()).toEqual(["dashboard", "portal"]);
    for (const manifest of storeless) {
      for (const { text } of generateUnits(manifest, placeholdersOf(manifest))) expect(text).not.toMatch(/\/projects\/|^(LoadCredential|ProtectProc)=/m);
    }
  });

  test("a static site has no unit, and so nothing reads a store for it", () => {
    expect(unitsOf("static")).toEqual([]);
    expect(unitNames(SYNTHETIC.static!)).toEqual([]);
  });

  test("every known manifest's units render, each app's services reading its store unless storeless", () => {
    for (const manifest of knownManifests().filter(isApp)) {
      const services = new Set(servicesOf(manifest).map((service) => service.unit));
      const units = generateUnits(manifest, placeholdersOf(manifest));
      for (const { unit, text } of units.filter(({ unit }) => services.has(unit))) {
        expect({ unit, store: text.includes(`\nLoadCredential=files:/etc/sitesolide/projects/${manifest.slug}/files\n`) }).toEqual({ unit, store: hasStore(manifest) });
      }
    }
  });

  test("a file's name validate() refuses is never accepted by the generator, even past validate()", () => {
    // No file's name is written into the unit, which loads the whole folder:
    // the second barrier refuses what systemd would skip, flatten or misread.
    for (const files of [[".env"], ["sub/key.pem"], ["a..b"], ["key.pem\nUser=root"], ["x".repeat(65)]]) {
      expect(() => generateUnits({ ...APP, secrets: { files } } as Manifest)).toThrow("never written into a unit");
    }
    expect(() => generateUnits({ ...APP, secrets: { files: ["gcp.json", "tls.key"] } } as Manifest)).not.toThrow();
  });
});

/**
 * The units of 0.7, captured once from main (7534d29) before the store's
 * lines, for the synthetic manifests above: a sha256 of each unit's text.
 * withoutStoreLines must give each back from this release's text, byte for
 * byte, and decideUnit replace it without --force.
 */
const FINGERPRINTS_07: Record<string, Record<string, string>> = {
  none: { shop: "f4afd1acc3c4365c2d29d5f2df76f6599a6f268e0afefea95c487dcec454bb8c" },
  legacy: { mail: "e8dead339dfed7f8f3e148632db6957daf3d4ea351907f215dc8cc902f6ba2ef" },
  names: { cart: "d9b80c6ccdb6e88fe2410f5f9b790cf1f703728b0c028e6398916259f5b2491a" },
  long: {
    engine: "5340dc2c4d30549615200a19c8e688d0eee430a172d54096ad57dff2a13eb59e",
    "engine.postgres": "f929641b5597418610cfbe38f317a0b9c4de7a3be4f8c963ff64542c6a36682c",
  },
  multi: {
    lab: "de823e571f413d68340c4a63f696b44515c8c83f94a368de12f31e4699e0872d",
    "lab.api": "251d694fafa6ba127a3b9822dabfc340356bad7686b0290b2ad75705b95ebdd8",
    "lab.worker": "4896392ca0dd5cbdfc9509ebf318845d951b1eadc85e046c10ed29ce9cf9e654",
  },
  scheduled: {
    news: "77663103623921967dd4907048539932267fd99eeefafaf0f67a11af39e02a6d",
    "news.sync": "700e3ea8af84558d0b195e8befc5458d7d1c051ccc5aa4b4dcf052e8bbb406fb",
    "news.sync.timer": "eea89b8649ef39d9185df88bd426db79bd64939fb18a14ad79b820107018271e",
    "news.queue": "b4be4b13b726f492ab11af6c1e0d49dfcd9f5fc784676a34a67a28db22476bb3",
  },
  anchored: {
    jobs: "ba386ab3f1d5dd5622cb8f5c4f164264b2941f1a03941f6fc03d20d9d2b29406",
    "jobs.report": "4b15c764718610174e5680412ea3bf057e9794c6ccf9fa810e5856c08c247ae5",
    "jobs.report.timer": "f7c74e814067b7c1e5d757d28a7eff2bcbdae0a0f84bf8396e175932f600d09c",
    "jobs.cleanup": "90337f8d640892802e58f6f5655cc68149d365f8582a19f1657c96f96bc689fc",
    "jobs.cleanup.timer": "8dedc11e15de8e16fd1db2138add223c307dbfbb015a31755c49d2b6623c0617",
  },
  dashboard: { dashboard: "359ed49aa656ef7a1446c316c6bd6360ef57abb046110cbaf1478686c7f2b1ab" },
  portal: { portal: "8889d093cd3908cbdcc3df5c132980021cd047b33243d9e4c87183ef0b332de0" },
  static: {},
};

/** The 0.7 unit of `legacy` above, as main generated it: a flat file read, and /etc/sitesolide left visible. */
const MAIL_07 = `# Service of project mail, generated by bin/sitesolide.ts from its
# sitesolide.json. Do not edit by hand: the next deployment overwrites it.
#
# Isolation: dedicated user with no shell, system mounted read only,
# writing allowed in the project's data folder alone. A compromised
# project can read neither the landing nor the other sites.

[Unit]
Description=Project mail
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=site-mail
Group=site-mail
WorkingDirectory=/srv/sites/mail/app

Environment=PORT=3023
Environment=DATA_DIR=/srv/sites/mail/data
Environment=PUBLIC_DIR=/srv/sites/mail/public
EnvironmentFile=-/etc/sitesolide/mail-ses.env
EnvironmentFile=-/etc/sitesolide/mail-stripe.env

ExecStart=/usr/local/bin/bun run server.ts
Restart=always
RestartSec=2

# What the service writes belongs to it alone.
UMask=0077

# Confinement
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/sites/mail/data

# /srv is replaced by an empty mount, then only this project's folders
# are exposed again in it: the service cannot read the landing nor the
# other sites, even if their Unix permissions allowed it.
TemporaryFileSystem=/srv:ro
BindReadOnlyPaths=/srv/sites/mail/app
BindReadOnlyPaths=/srv/sites/mail/public
BindPaths=/srv/sites/mail/data

# This project reads its own file in /etc/sitesolide: InaccessiblePaths
# is not laid here, or systemd could not hand the file to it.

ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
# The system calls of a service, and none that changes the machine: no
# mount, module, reboot, swap, clock or tracing. Any other fails with EPERM.
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
MemoryMax=256M

# network: outbound. This project reaches an outside API; the network
# confinement is lifted, everything else holds.

# Listens on its own port, and on none of the machine's others.
SocketBindAllow=tcp:3023
SocketBindDeny=2019
SocketBindDeny=3000-3099
SocketBindDeny=3128-3129

[Install]
WantedBy=multi-user.target
`;

/** The 0.7 unit of `none` above: no secret, /etc/sitesolide closed. */
const SHOP_07 = `# Service of project shop, generated by bin/sitesolide.ts from its
# sitesolide.json. Do not edit by hand: the next deployment overwrites it.
#
# Isolation: dedicated user with no shell, system mounted read only,
# writing allowed in the project's data folder alone. A compromised
# project can read neither the landing nor the other sites.

[Unit]
Description=Project shop
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=site-shop
Group=site-shop
WorkingDirectory=/srv/sites/shop/app

Environment=PORT=3022
Environment=DATA_DIR=/srv/sites/shop/data
Environment=PUBLIC_DIR=/srv/sites/shop/public
Environment=PUBLIC_URL=https://shop.test-zone.invalid

ExecStart=/usr/local/bin/bun run server.ts
Restart=always
RestartSec=2

# What the service writes belongs to it alone.
UMask=0077

# Confinement
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/srv/sites/shop/data

# /srv is replaced by an empty mount, then only this project's folders
# are exposed again in it: the service cannot read the landing nor the
# other sites, even if their Unix permissions allowed it.
TemporaryFileSystem=/srv:ro
BindReadOnlyPaths=/srv/sites/shop/app
BindReadOnlyPaths=/srv/sites/shop/public
BindPaths=/srv/sites/shop/data

# No secret for this project: the whole folder is closed to it, which
# hides from it even the names of the files.
InaccessiblePaths=-/etc/sitesolide

ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
# The system calls of a service, and none that changes the machine: no
# mount, module, reboot, swap, clock or tracing. Any other fails with EPERM.
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
MemoryMax=256M

# The only client of this service is Caddy, on the loopback.
#
# THIS BLOCKING ALSO CUTS DNS OFF. This machine's resolvers are those
# of the hosting provider, hence external. Measured on 19 August 2026
# in a transient unit carrying these very two lines:
#
#   to a name        curl: (6) Could not resolve host
#   to an IP         curl: (28) Connection timed out, after the full delay
#   to 127.0.0.1     200, the loopback goes through
#
# Both messages mislead: the first sends one hunting a DNS outage, the
# second a slowness of the remote service. The cure is neither to tinker
# with /etc/resolv.conf nor to lengthen a delay, it is network: outbound
# in the project's sitesolide.json.
IPAddressDeny=any
IPAddressAllow=localhost

# Listens on its own port, and on none of the machine's others.
SocketBindAllow=tcp:3022
SocketBindDeny=2019
SocketBindDeny=3000-3099
SocketBindDeny=3128-3129

[Install]
WantedBy=multi-user.target
`;

describe("the units 0.7 laid, replaced without --force", () => {
  test("the inline units are what the fingerprints say: captured from main, not from this generator", () => {
    expect(sha256(MAIL_07)).toBe(FINGERPRINTS_07.legacy!.mail!);
    expect(sha256(SHOP_07)).toBe(FINGERPRINTS_07.none!.shop!);
  });

  test("a unit 0.7 laid is installed against this release's, with and without a flat file", () => {
    const [mail] = unitsOf("legacy");
    const [shop] = unitsOf("none");
    expect(decideUnit({ installed: MAIL_07, generated: mail!.text, replace: false })).toBe("install");
    expect(decideUnit({ installed: SHOP_07, generated: shop!.text, replace: false })).toBe("install");
    // What 0.7 lacks and this release adds, directive by directive.
    expect(compareDirectives(MAIL_07, mail!.text)).toEqual({
      lost: [],
      added: ["EnvironmentFile=-/etc/sitesolide/projects/mail/env", "LoadCredential=files:/etc/sitesolide/projects/mail/files", "InaccessiblePaths=-/etc/sitesolide", "ProtectProc=invisible"],
    });
    expect(compareDirectives(SHOP_07, shop!.text)).toEqual({
      lost: [],
      added: ["EnvironmentFile=-/etc/sitesolide/projects/shop/env", "LoadCredential=files:/etc/sitesolide/projects/shop/files", "ProtectProc=invisible"],
    });
  });

  test.each(Object.keys(FINGERPRINTS_07))("%s: withoutStoreLines gives back each unit of 0.7, byte for byte", (name) => {
    expect(Object.fromEntries(unitsOf(name).map(({ unit, text }) => [unit, sha256(withoutStoreLines(text))]))).toEqual(FINGERPRINTS_07[name]!);
  });

  test.each(Object.keys(FINGERPRINTS_07))("%s: each unit of 0.7, of 0.6 and from before is the generator's own", (name) => {
    for (const { unit, text } of unitsOf(name)) {
      // Byte for byte the 0.7 text, by the fingerprints above.
      const of07 = withoutStoreLines(text);
      for (const earlier of [of07, withoutSyscallLines(of07), withoutBindLines(withoutSyscallLines(of07))]) {
        // Never diverged: present when nothing changed for this unit, a timer or an anchor.
        const action = decideUnit({ installed: earlier, generated: text, replace: false });
        expect({ unit, action }).toEqual({ unit, action: sameDirectives(earlier, text) ? "present" : "install" });
      }
    }
  });

  test("a unit 0.7 laid and edited by hand since still stops the deployment", () => {
    const [mail] = unitsOf("legacy");
    const [shop] = unitsOf("none");
    expect(decideUnit({ installed: `${MAIL_07}LimitNOFILE=4096\n`, generated: mail!.text, replace: false })).toBe("diverged");
    expect(decideUnit({ installed: SHOP_07.replace("PrivateDevices=true\n", ""), generated: shop!.text, replace: false })).toBe("diverged");
    // Its flat file dropped by hand, or one added, is no release's either.
    expect(decideUnit({ installed: MAIL_07.replace("EnvironmentFile=-/etc/sitesolide/mail-stripe.env\n", ""), generated: mail!.text, replace: false })).toBe("diverged");
    expect(decideUnit({ installed: SHOP_07.replace("Environment=PUBLIC_URL", "EnvironmentFile=-/etc/sitesolide/other.env\nEnvironment=PUBLIC_URL"), generated: shop!.text, replace: false })).toBe("diverged");
    expect(decideUnit({ installed: `${MAIL_07}LimitNOFILE=4096\n`, generated: mail!.text, replace: true })).toBe("install");
  });

  test("a unit of this release with one of the store's lines taken off by hand is no release's", () => {
    const [mail] = unitsOf("legacy");
    for (const line of ["ProtectProc=invisible", "LoadCredential=files:/etc/sitesolide/projects/mail/files", "EnvironmentFile=-/etc/sitesolide/projects/mail/env", "InaccessiblePaths=-/etc/sitesolide"]) {
      const edited = mail!.text.replace(`${line}\n`, "");
      expect({ line, action: decideUnit({ installed: edited, generated: mail!.text, replace: false }) }).toEqual({ line, action: "diverged" });
    }
  });

  test("a unit this release laid is present: nothing is laid again", () => {
    for (const name of [...WITH_STORE, ...STORELESS]) {
      for (const { unit, text } of unitsOf(name)) expect({ unit, action: decideUnit({ installed: text, generated: text, replace: false }) }).toEqual({ unit, action: "present" });
    }
  });

  test("the generations, newest first, the two of before the store last", () => {
    const [mail] = unitsOf("legacy");
    const text = mail!.text;
    const generations = earlierGenerations(text);
    expect(generations).toEqual([
      withoutStoreLines(text),
      withoutSyscallLines(withoutStoreLines(text)),
      withoutBindLines(withoutSyscallLines(withoutStoreLines(text))),
      withoutSyscallLines(text),
      withoutBindLines(withoutSyscallLines(text)),
    ]);
    expect(generations[0]).toBe(MAIL_07);
  });

  test("withoutStoreLines takes off the store's lines and nothing else, and once", () => {
    const [mail] = unitsOf("legacy");
    const [shop] = unitsOf("none");
    for (const text of [mail!.text, shop!.text]) {
      const before = withoutStoreLines(text);
      expect(before).not.toMatch(/projects\/|LoadCredential|ProtectProc|PID 1/);
      expect(withoutStoreLines(before)).toBe(before);
    }
    // A text of another making loses those directives alone, its comments kept.
    const handWritten = "[Service]\n# mine\nEnvironmentFile=-/etc/sitesolide/projects/x/env\nLoadCredential=files:/etc/sitesolide/projects/x/files\nLoadCredential=key:/etc/ssl/key.pem\nProtectProc=invisible\nInaccessiblePaths=-/etc/sitesolide\n";
    expect(withoutStoreLines(handWritten)).toBe("[Service]\n# mine\nLoadCredential=key:/etc/ssl/key.pem\nInaccessiblePaths=-/etc/sitesolide\n");
    // With a flat file still read, InaccessiblePaths goes too: 0.7 laid it only without one.
    expect(withoutStoreLines(`${handWritten}EnvironmentFile=-/etc/sitesolide/x.env\n`)).toBe("[Service]\n# mine\nLoadCredential=key:/etc/ssl/key.pem\nEnvironmentFile=-/etc/sitesolide/x.env\n");
    // A file under a folder of the old form is not a flat one.
    expect(withoutStoreLines(`${handWritten}EnvironmentFile=-/etc/sitesolide/x-secrets/y.env\n`)).toInclude("InaccessiblePaths=-/etc/sitesolide\n");
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

describe("what a manifest can no longer write into its unit", () => {
  test("a % is the percent sign itself, never a specifier systemd expands", () => {
    const unit = generateUnit({ ...APP, description: "100% %h", start: "/bin/date +%s", env: { FORMAT: "%Y-%m-%d" } });
    expect(unit).toInclude("Description=100%% %%h");
    expect(unit).toInclude("ExecStart=/bin/date +%%s");
    expect(unit).toInclude("Environment=FORMAT=%%Y-%%m-%%d");
  });

  test("a text without % comes out as it always did", () => {
    // Every unit in service: escaping must not make one of them diverge.
    for (const manifest of knownManifests().filter(isApp)) {
      for (const { text } of generateUnits(manifest)) expect(text).not.toInclude("%%");
    }
  });

  test("what validate() refuses is never written, even past validate()", () => {
    // The second barrier, for a manifest that reached the generator without
    // the validation: a start run as root, a variable set past the rules on
    // names, a directive added after a secret's name or a description.
    for (const manifest of [
      { ...APP, start: "+/bin/sh -c id" },
      { ...APP, start: "!/bin/sh -c id" },
      { ...APP, start: "/bin/app\nUser=root" },
      { ...APP, env: { NODE_ENV: "x DATA_DIR=/srv/sites/other/data" } },
      { ...APP, secrets: ["budget.env\nExecStartPre=+/bin/sh -c id"] },
      { ...APP, description: "notes\\" },
      { slug: "budget", services: { web: { start: "/bin/web", port: 3040 }, api: { start: "+/bin/api", port: 3041, routes: ["/api/*"] } } },
    ] as Manifest[]) {
      expect(() => generateUnits(manifest)).toThrow("never written into a unit");
    }
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

describe("install over SSH, in the service's walls", () => {
  const command = sandboxedInstallCommand("budget", "deploy");

  test("as the project's account, through systemd-run, with the walls the installer gives a token", () => {
    expect(command).toStartWith("sudo sh -c 'chown -hR site-budget:site-budget /srv/sites/budget/app && \"/usr/bin/systemd-run\"");
    for (const property of [
      '"-p" "User=site-budget"',
      '"-p" "NoNewPrivileges=yes"',
      '"-p" "ProtectSystem=strict"',
      '"-p" "TemporaryFileSystem=/srv:ro"',
      '"-p" "BindPaths=/srv/sites/budget/app:/srv/sites/budget/app" "-p" "ReadWritePaths=/srv/sites/budget/app"',
      '"-p" "InaccessiblePaths=-/etc/sitesolide"',
      '"-p" "IPAddressDeny=localhost"',
      // The loopback refused, but a port of the machine could still be held
      // for the install's fifteen minutes: the portal's, which then could
      // not start again.
      '"-p" "SocketBindDeny=2019"',
      '"-p" "SocketBindDeny=3000-3099"',
      '"-p" "SocketBindDeny=3128-3129"',
      '"-p" "WorkingDirectory=/srv/sites/budget/app"',
      '"-p" "RuntimeMaxSec=900"',
      '"--expand-environment=no"',
      '"-E" "HOME=/tmp"',
    ]) {
      expect(command).toContain(property);
    }
    // The same line the installer builds, word for word.
    const line = systemdRunArguments({
      slug: "budget",
      purpose: "install",
      command: ["/bin/sh", "-s"],
      stdin: null,
      binds: [{ source: "/srv/sites/budget/app", target: "/srv/sites/budget/app" }],
      workingDirectory: "/srv/sites/budget/app",
      network: true,
      timeoutS: 900,
      memory: "1G",
    });
    expect(command).toContain(line.map((argument) => `"${argument}"`).join(" "));
  });

  test("the install command is never in it: it travels on standard input, to sh -s", () => {
    expect(command).toContain('"/bin/sh" "-s";');
  });

  test("app/ goes back to the deployment account whatever the install's outcome, links never followed", () => {
    expect(command).toEndWith("; code=$?; chown -hR deploy:deploy /srv/sites/budget/app; exit $code'");
  });

  test("the shell runs it as written: against a fake sudo, chown and systemd-run, an install that fails", () => {
    const root = mkdtempSync(join(tmpdir(), "sitesolide-install-"));
    try {
      mkdirSync(join(root, "bin"));
      writeFileSync(join(root, "bin", "sudo"), `#!/bin/sh\nexec "$@"\n`, { mode: 0o755 });
      writeFileSync(join(root, "bin", "chown"), `#!/bin/sh\necho "chown $*" >> "${root}/calls"\n`, { mode: 0o755 });
      // systemd-run stands for itself: it runs the script it reads on
      // standard input, then fails the way a failing install does.
      const fake = join(root, "systemd-run");
      writeFileSync(fake, `#!/bin/sh\nsh -s >> "${root}/calls"\nexit 3\n`, { mode: 0o755 });
      const script = command.replace(/^sudo sh -c '/, "").replace(/'$/, "").replace('"/usr/bin/systemd-run"', `"${fake}"`);
      const proc = Bun.spawnSync(["sh", "-c", script], { stdin: new TextEncoder().encode("echo installed\n"), env: { PATH: `${join(root, "bin")}:/usr/bin:/bin` } });
      expect(proc.exitCode).toBe(3);
      expect(readFileSync(join(root, "calls"), "utf8").split("\n").filter((line) => line !== "")).toEqual([
        "chown -hR site-budget:site-budget /srv/sites/budget/app",
        "installed",
        "chown -hR deploy:deploy /srv/sites/budget/app",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses an account or a slug that could leave the quotes", () => {
    expect(() => sandboxedInstallCommand("budget", "deploy'; reboot")).toThrow();
    expect(() => sandboxedInstallCommand("budget; reboot", "deploy")).toThrow();
  });
});

describe("workers, scheduled services and their timers", () => {
  const PLACEHOLDERS = { slug: "lab", zone: "test-zone.invalid", contact: "" };
  /** A front, a sync every quarter of an hour, and a queue consumer, written in that order. */
  const MIXED: Manifest = {
    slug: "lab",
    services: {
      web: { start: "/srv/sites/lab/app/web", port: 3050 },
      sync: { start: "/srv/sites/lab/app/sync", schedule: "*:0/15", timeout: "15m" },
      queue: { start: "/srv/sites/lab/app/queue", internal: true, cpu: "50%" },
    },
  };
  /** Every service scheduled: the main unit is an anchor. */
  const ANCHORED: Manifest = {
    slug: "lab",
    services: {
      report: { start: "/srv/sites/lab/app/report", schedule: "daily" },
      cleanup: { start: "/srv/sites/lab/app/cleanup", schedule: "Sun 03:00" },
    },
  };
  const units = generateUnits(MIXED, PLACEHOLDERS);
  const text = (unit: string): string => units.find((generated) => generated.unit === unit)!.text;

  test("main first, then each other service, a scheduled one followed by its timer", () => {
    expect(units.map((generated) => generated.unit)).toEqual(["lab", "lab.sync", "lab.sync.timer", "lab.queue"]);
    expect(unitNames(MIXED)).toEqual(["lab", "lab.sync", "lab.sync.timer", "lab.queue"]);
  });

  test("the main unit wants the timer, never the scheduled service, and starts after what runs for good alone", () => {
    expect(text("lab")).toInclude("\nWants=lab.sync.timer lab.queue.service\n");
    expect(text("lab")).toInclude("\nAfter=lab.queue.service\n");
    expect(text("lab")).not.toInclude("lab.sync.service");
    expect(text("lab")).toInclude("[Install]\nWantedBy=multi-user.target");
    // A server keeps the machine's defaults, line for line.
    expect(text("lab")).toInclude("Type=simple\n");
    expect(text("lab")).toInclude("\nRestart=always\nRestartSec=2\n\n");
    expect(text("lab")).not.toMatch(/^(CPUWeight|TasksMax|CPUQuota|StartLimitIntervalSec)=/m);
  });

  test("a worker: no port, restarted for good with a growing delay, and yielding the processor to the sites", () => {
    const queue = text("lab.queue");
    expect(queue).not.toInclude("PORT=");
    expect(queue).toInclude("Environment=DATA_DIR=/srv/sites/lab/data\n");
    expect(queue).toInclude("PartOf=lab.service\n");
    expect(queue).toMatch(/\[Unit\][^[]*\nStartLimitIntervalSec=0\n/);
    expect(queue).toInclude("Type=simple\n");
    expect(queue).toInclude("\nRestart=always\nRestartSec=2\nRestartSteps=8\nRestartMaxDelaySec=5min\n");
    expect(queue).toInclude("\nCPUWeight=20\nTasksMax=512\nCPUQuota=50%\n");
    expect(queue).not.toMatch(/^\[Install\]$/m);
    expect(queue).toInclude("IPAddressDeny=any");
  });

  test("a scheduled service: started by its timer, run to its end, never restarted, stopped past its timeout", () => {
    const sync = text("lab.sync");
    expect(sync).not.toInclude("PORT=");
    expect(sync).toInclude("PartOf=lab.service\n");
    expect(sync).toInclude("# Started by its timer, and stopped or restarted with the project's main unit.\n");
    expect(sync).toInclude("Type=exec\n");
    expect(sync).toInclude("\nRestart=no\nRuntimeMaxSec=15m\n");
    expect(sync).not.toInclude("Restart=always");
    expect(sync).toInclude("\nCPUWeight=20\nTasksMax=512\n");
    expect(sync).not.toInclude("CPUQuota");
    expect(sync).not.toInclude("StartLimitIntervalSec");
    expect(sync).not.toMatch(/^\[Install\]$/m);
    expect(sync).toInclude("# No [Install]: started by its timer.");
    expect(sync).toInclude("ExecStart=/srv/sites/lab/app/sync\n");
    // An hour unless the service says otherwise.
    const plain = generateUnits({ slug: "lab", services: { web: { start: "/x", port: 3050 }, sync: { start: "/y", schedule: "hourly" } } }, PLACEHOLDERS);
    expect(plain[1]!.text).toInclude("\nRuntimeMaxSec=1h\n");
  });

  test("its timer: the schedule as written, a missed run made up at boot, on time to the second, and nothing else", () => {
    expect(text("lab.sync.timer")).toBe(
      [
        "# Timer of project lab, generated by bin/sitesolide.ts from its",
        "# sitesolide.json. Do not edit by hand: the next deployment overwrites it.",
        "",
        "[Unit]",
        "Description=Project lab, schedule of service sync",
        "# Started by the project's main unit, and stopped or restarted with it.",
        "PartOf=lab.service",
        "",
        "[Timer]",
        "OnCalendar=*:0/15",
        "Persistent=true",
        "AccuracySec=1s",
        "",
      ].join("\n"),
    );
  });

  test("every service scheduled: the main unit is an anchor that runs nothing, as the project's account, and wants the timers", () => {
    const anchored = generateUnits(ANCHORED, PLACEHOLDERS);
    expect(anchored.map((generated) => generated.unit)).toEqual(["lab", "lab.report", "lab.report.timer", "lab.cleanup", "lab.cleanup.timer"]);
    const anchor = anchored[0]!.text;
    expect(anchor).toInclude("generated by bin/sitesolide.ts");
    expect(anchor).toInclude("\nWants=lab.report.timer lab.cleanup.timer\n");
    expect(anchor).not.toInclude("After=");
    for (const line of ["Type=oneshot", "RemainAfterExit=yes", "ExecStart=/bin/true", "User=site-lab", "Group=site-lab", "WorkingDirectory=/srv/sites/lab/app", "PrivateNetwork=true", "NoNewPrivileges=true"]) {
      expect(anchor).toInclude(`\n${line}\n`);
    }
    expect(anchor).toInclude("[Install]\nWantedBy=multi-user.target\n");
    expect(generateUnit(ANCHORED, PLACEHOLDERS)).toBe(anchor);
    for (const { unit, text: secondary } of anchored.slice(1)) {
      expect({ unit, partOf: secondary.includes("\nPartOf=lab.service\n") }).toEqual({ unit, partOf: true });
    }
  });

  test("what deploy restarts, and what it watches after the restart", () => {
    expect(runningUnits(MIXED)).toEqual(["lab", "lab.sync.timer", "lab.queue"]);
    expect(watchedUnits(MIXED)).toEqual(["lab", "lab.queue"]);
    expect(unitNames(ANCHORED)).toEqual(["lab", "lab.report", "lab.report.timer", "lab.cleanup", "lab.cleanup.timer"]);
    expect(runningUnits(ANCHORED)).toEqual(["lab", "lab.report.timer", "lab.cleanup.timer"]);
    // The anchor runs nothing, a timer neither: nothing to watch.
    expect(watchedUnits(ANCHORED)).toEqual([]);
    // A project of servers alone: every unit, as before.
    expect(unitNames(APP)).toEqual(["budget"]);
    expect(runningUnits(APP)).toEqual(["budget"]);
    expect(watchedUnits(APP)).toEqual(["budget"]);
    expect(unitNames({ slug: "notes", publicDir: "dist" })).toEqual([]);
  });

  test("a timer is named with its suffix, a service without, and each is given to systemctl and laid in its file", () => {
    expect(isTimerUnit("lab.sync.timer")).toBe(true);
    expect(isTimerUnit("lab.sync")).toBe(false);
    expect(isTimerUnit("lab")).toBe(false);
    expect(timerUnit(servicesOf(MIXED)[1]!)).toBe("lab.sync.timer");
    expect(unitArgument("lab")).toBe("lab");
    expect(unitArgument("lab.sync")).toBe("lab.sync.service");
    expect(unitArgument("lab.sync.timer")).toBe("lab.sync.timer");
    expect(unitFileName("lab")).toBe("lab.service");
    expect(unitFileName("lab.sync")).toBe("lab.sync.service");
    expect(unitFileName("lab.sync.timer")).toBe("lab.sync.timer");
  });

  test("cpu caps a server too, which keeps every other default", () => {
    const capped = generateUnit({ ...APP, cpu: "150%" }, { slug: "budget", zone: "test-zone.invalid", contact: "" });
    expect(capped).toInclude("\nMemoryMax=256M\nCPUQuota=150%\n");
    expect(capped).not.toInclude("CPUWeight");
    expect(capped).toInclude("Environment=PORT=3022\n");
  });

  test("a schedule, a timeout or a cpu validate() refuses is never written, even past validate()", () => {
    const broken = (service: Record<string, unknown>): Manifest => ({ slug: "lab", services: { web: { start: "/x", port: 3050 }, sync: { start: "/y", ...service } } as Manifest["services"] });
    expect(() => generateUnits(broken({ schedule: "daily\nExecStartPre=/bin/sh" }), PLACEHOLDERS)).toThrow(/never written/);
    expect(() => generateUnits(broken({ schedule: "daily", timeout: "infinity" }), PLACEHOLDERS)).toThrow(/never written/);
    expect(() => generateUnits(broken({ internal: true, cpu: "50%\nUser=root" }), PLACEHOLDERS)).toThrow(/never written/);
  });

  test("a slug, a service name or a memory validate() refuses is never written into a unit, even past validate()", () => {
    // The same second barrier as above, for the three fields that still name
    // or bound the unit itself and reach it unescaped: a `\n` in any of them
    // adds a directive systemd obeys as root, `User=root` the worst of them.
    // The anchor and the secondary units embed the slug and the service names
    // too, so a project of scheduled services alone must refuse them as well.
    const unit = { slug: "lab", start: "/usr/local/bin/bun x", port: 3050 } as Manifest;
    expect(() => generateUnits({ ...unit, slug: "lab\nUser=root" }, PLACEHOLDERS)).toThrow(/never written/);
    expect(() => generateUnits({ ...unit, memory: "256M\nUser=root" }, PLACEHOLDERS)).toThrow(/never written/);
    const named = (name: string, extra: Record<string, unknown> = {}): Manifest => ({ slug: "lab", services: { [name]: { start: "/x", port: 3050, ...extra } } } as Manifest);
    expect(() => generateUnits(named("web\nUser=root"), PLACEHOLDERS)).toThrow(/never written/);
    expect(() => generateUnits(named("web", { memory: "256M\nExecStartPre=+/bin/sh" }), PLACEHOLDERS)).toThrow(/never written/);
    // All scheduled: the anchor's Wants= would otherwise carry the bad name.
    const anchored: Manifest = { slug: "lab", services: { "sync\nUser=root": { start: "/x", schedule: "daily" } } } as Manifest;
    expect(() => generateUnits(anchored, PLACEHOLDERS)).toThrow(/never written/);
  });
});

describe("the units of servers, as they were before workers existed", () => {
  /**
   * A server's unit is byte for byte what the generator wrote before workers
   * and scheduled services: a single byte of difference would make every unit
   * in service read as diverged, and each project's next deployment refuse
   * without --force. The fingerprints below were taken from the e2e fixtures
   * with the generator of the release before them; a change here is a change
   * to every unit on every machine, to be made on purpose.
   *
   * The bind lines, the system-call filter and the store's lines are the
   * only such changes since, and decideUnit and the installer replace a unit
   * that lacks them alone: the fingerprints are those of the text without
   * any of them, which is what a machine carries until each project's next
   * deployment.
   */
  const FINGERPRINTS: Record<string, Record<string, string>> = {
    "bun-mixed": { "sample-bun": "add7fdc8d713e6954cf1e1456d63ff2a5a97b8f49c80149a9eac2a450900ca46" },
    "multi-service": {
      "sample-lab": "6a9b54567d9bebc3fd3db56dcdd8c4ae5604e3613f6f8f26ba3b54abadae9786",
      "sample-lab.api": "fc6ce37f51ecccbcc4b4e26ac891a10bbbc96d9d4fef00e736990dfc405cc9ee",
      "sample-lab.worker": "faca45fbdecdeecdf51d9d6c608bab2972966ecd14abbc294188dbc9435a6aef",
    },
  };

  test.each(Object.keys(FINGERPRINTS))("projects/%s generates the same units, to the byte", (fixture) => {
    const { manifest } = readManifest(readFileSync(join(REPO_ROOT, "bin", "tests", "e2e", "projects", fixture, "sitesolide.json"), "utf8"));
    const generated = generateUnits(manifest!, { slug: manifest!.slug, zone: "test-zone.invalid", contact: "sample@test-zone.invalid" });
    const fingerprints = Object.fromEntries(
      generated.map(({ unit, text }) => [unit, new Bun.CryptoHasher("sha256").update(withoutBindLines(withoutSyscallLines(withoutStoreLines(text)))).digest("hex")]),
    );
    expect(fingerprints).toEqual(FINGERPRINTS[fixture]!);
  });

  /** The same units as 0.6 wrote them, with the bind lines: taken with the generator of v0.6.1, and 0.7 wrote the same. */
  const FINGERPRINTS_06: Record<string, Record<string, string>> = {
    "bun-mixed": { "sample-bun": "a313ca46ef19bc85bcc16e984acd26825319a4e7a9ce8e1b0d3aaed22e231490" },
    "multi-service": {
      "sample-lab": "f8803f356470b6d7f6dddebca9f3f3d1d9a4b89d4db39e00093a92ce7fe0cfef",
      "sample-lab.api": "e2d055b78c3c2723734bc3a51fc0ef4077a0fd41a8bbcc212dedc30f83cffce0",
      "sample-lab.worker": "e77575a31050a4656084c79771fb7b7bf0e980306fd1e95c5475700cdd34033f",
    },
  };

  test.each(Object.keys(FINGERPRINTS_06))("projects/%s, without the store's lines and the system-call filter, is what 0.6 generated, to the byte", (fixture) => {
    const { manifest } = readManifest(readFileSync(join(REPO_ROOT, "bin", "tests", "e2e", "projects", fixture, "sitesolide.json"), "utf8"));
    const generated = generateUnits(manifest!, { slug: manifest!.slug, zone: "test-zone.invalid", contact: "sample@test-zone.invalid" });
    const fingerprints = Object.fromEntries(generated.map(({ unit, text }) => [unit, new Bun.CryptoHasher("sha256").update(withoutSyscallLines(withoutStoreLines(text))).digest("hex")]));
    expect(fingerprints).toEqual(FINGERPRINTS_06[fixture]!);
  });
});

describe("the ports a service may listen on", () => {
  /**
   * A project's account may bind any free port of the loopback, and the
   * loopback rule only judges who connects, never who answers: Caddy, which
   * may reach every port from 3000 to 3099, connects to whoever listens there.
   * A compromised app that waits for the portal's port to come free, during an
   * upgrade, answered every forward_auth with the identity of its choosing and
   * received the owner's password typed on a sign-in page; on the egress
   * proxy's ports, every project's outgoing requests and connectors' bodies;
   * on a neighbour's port while it restarts, that site's visitors.
   */
  const LAB: Manifest = {
    slug: "lab",
    services: {
      web: { start: "/srv/sites/lab/app/web", port: 3050 },
      queue: { start: "/srv/sites/lab/app/queue", internal: true },
      sync: { start: "/srv/sites/lab/app/sync", schedule: "hourly" },
    },
  } as Manifest;
  const PLACEHOLDERS = { slug: "lab", zone: "test-zone.invalid", contact: "" };
  const units = Object.fromEntries(generateUnits(LAB, PLACEHOLDERS).map(({ unit, text }) => [unit, text]));
  const DENIED = ["SocketBindDeny=2019", "SocketBindDeny=3000-3099", "SocketBindDeny=3128-3129"];

  test("a server listens on its own port, and on none of the machine's others", () => {
    const web = units["lab"]!;
    expect(web).toInclude("\nSocketBindAllow=tcp:3050\n");
    for (const line of DENIED) expect(web).toInclude(`\n${line}\n`);
  });

  test("a worker and a scheduled service listen on none of them, not even a sibling's", () => {
    for (const unit of ["lab.queue", "lab.sync"]) {
      expect(units[unit]!).not.toInclude("SocketBindAllow=");
      for (const line of DENIED) expect(units[unit]!).toInclude(`\n${line}\n`);
    }
  });

  test("a single server's unit carries them too, network outbound or not", () => {
    for (const manifest of [APP, { ...APP, network: "outbound" } as Manifest]) {
      const text = generateUnit(manifest);
      expect(text).toInclude("\nSocketBindAllow=tcp:3022\n");
      for (const line of DENIED) expect(text).toInclude(`\n${line}\n`);
    }
  });

  test("a unit a release before them generated is the generator's own and replaced without --force", () => {
    const generated = generateUnit(APP);
    const previous = generated
      .split("\n")
      .filter((line) => !line.startsWith("SocketBind") && !line.startsWith("SystemCall"))
      .join("\n");
    expect(decideUnit({ installed: previous, generated, replace: false })).toBe("install");
    // One edited by hand besides still stops the deployment.
    expect(decideUnit({ installed: `${previous}\nLimitNOFILE=4096\n`, generated, replace: false })).toBe("diverged");
  });
});

describe("the system calls a service may make", () => {
  /**
   * Every service runs under systemd's `@system-service` set, as the
   * platform's own services do: no mount, module, reboot, swap, clock or
   * tracing. A call outside it fails with EPERM rather than killing the
   * process, so that a runtime probing for one goes on without it.
   */
  const LAB: Manifest = {
    slug: "lab",
    services: {
      web: { start: "/srv/sites/lab/app/web", port: 3050 },
      queue: { start: "/srv/sites/lab/app/queue", internal: true },
      sync: { start: "/srv/sites/lab/app/sync", schedule: "hourly" },
    },
  } as Manifest;
  const PLACEHOLDERS = { slug: "lab", zone: "test-zone.invalid", contact: "" };
  const FILTER = ["SystemCallArchitectures=native", "SystemCallFilter=@system-service", "SystemCallErrorNumber=EPERM"];

  test("a server, a worker and a scheduled service each carry the filter, once", () => {
    const units = generateUnits(LAB, PLACEHOLDERS).filter(({ unit }) => !isTimerUnit(unit));
    expect(units.map(({ unit }) => unit)).toEqual(["lab", "lab.queue", "lab.sync"]);
    for (const { text } of units) {
      for (const line of FILTER) expect(text.split("\n").filter((written) => written === line)).toEqual([line]);
    }
  });

  test("network outbound, egress or secrets change nothing to it", () => {
    for (const manifest of [
      { ...APP, network: "outbound" },
      { ...APP, egress: ["api.example.com"] },
      { ...APP, secrets: ["budget.env"] },
    ] as Manifest[]) {
      for (const line of FILTER) expect(generateUnit(manifest)).toInclude(`\n${line}\n`);
    }
  });

  test("an anchor and a timer, which run no program of the project's, carry none of it", () => {
    const anchored: Manifest = { slug: "jobs", services: { nightly: { start: "/srv/sites/jobs/app/run", schedule: "daily" } } } as Manifest;
    const units = Object.fromEntries(generateUnits(anchored, { ...PLACEHOLDERS, slug: "jobs" }).map(({ unit, text }) => [unit, text]));
    expect(units["jobs"]!).not.toInclude("SystemCall");
    expect(units["jobs.nightly.timer"]!).not.toInclude("SystemCall");
    expect(units["jobs.nightly"]!).toInclude("\nSystemCallFilter=@system-service\n");
  });

  test("withoutSyscallLines takes off the block and nothing else", () => {
    const generated = generateUnit(APP);
    const before = withoutSyscallLines(generated);
    expect(before).not.toInclude("SystemCall");
    expect(before).not.toInclude("# The system calls of a service");
    expect(before.split("\n").length).toBe(generated.split("\n").length - 5);
    expect(withoutSyscallLines(before)).toBe(before);
  });

  test("a unit 0.6 generated, with the bind lines and without the filter, is replaced without --force", () => {
    const generated = generateUnit(APP);
    expect(decideUnit({ installed: withoutSyscallLines(generated), generated, replace: false })).toBe("install");
  });

  test("a unit from before 0.6, without either, is replaced without --force", () => {
    const generated = generateUnit(APP);
    expect(decideUnit({ installed: withoutBindLines(withoutSyscallLines(generated)), generated, replace: false })).toBe("install");
  });

  test("a unit edited by hand still stops the deployment, filter or not", () => {
    const generated = generateUnit(APP);
    expect(decideUnit({ installed: `${withoutSyscallLines(generated)}\nLimitNOFILE=4096\n`, generated, replace: false })).toBe("diverged");
    // Its filter taken off by hand, the bind lines kept, is no release's.
    const unfiltered = generated
      .split("\n")
      .filter((line) => line !== "SystemCallFilter=@system-service")
      .join("\n");
    expect(decideUnit({ installed: unfiltered, generated, replace: false })).toBe("diverged");
    expect(decideUnit({ installed: unfiltered, generated, replace: true })).toBe("install");
  });

  test("a unit already carrying it is present, and nothing is laid", () => {
    const generated = generateUnit(APP);
    expect(decideUnit({ installed: generated, generated, replace: false })).toBe("present");
  });
});

describe("a unit the previous manifest generated is the generator's own", () => {
  const PLACES = { slug: "sitemedic", zone: "test-zone.invalid", contact: "" };
  const LEGACY: Manifest = { slug: "sitemedic", start: "/usr/local/bin/bun run server.ts", port: 3040, secrets: ["sitemedic-ses.env", "sitemedic-stripe.env"] };
  const NAMES: Manifest = { ...LEGACY, secrets: ["AWS_ACCESS_KEY_ID", "STRIPE_SECRET_KEY"] };
  const unitOf = (manifest: Manifest) => generateUnits(manifest, PLACES)[0]!.text;

  test("M5: the unit of the old form's manifest, by this release or 0.7, is replaced by the names manifest's without --force", () => {
    const previous = unitOf(LEGACY);
    const generated = unitOf(NAMES);
    // What the platform laid at the previous deployment: this release's unit, or 0.7's.
    for (const installed of [previous, ...earlierGenerations(previous)]) {
      expect(decideUnit({ installed, generated, replace: false })).toBe("diverged");
      expect(decideUnit({ installed, generated, replace: false, previous })).toBe("install");
    }
  });

  test("a changed port, memory or env replaces the unit the previous manifest made", () => {
    for (const changed of [{ ...NAMES, port: 3041 }, { ...NAMES, memory: "512M" }, { ...NAMES, env: { REGION: "eu-west-3" } }] as Manifest[]) {
      expect(decideUnit({ installed: unitOf(NAMES), generated: unitOf(changed), replace: false, previous: unitOf(NAMES) })).toBe("install");
    }
  });

  test("a unit edited by hand is kept still, the previous manifest's or not; none on the machine decides as before", () => {
    const previous = unitOf(LEGACY);
    const generated = unitOf(NAMES);
    expect(decideUnit({ installed: `${previous}LimitNOFILE=4096\n`, generated, replace: false, previous })).toBe("diverged");
    expect(decideUnit({ installed: previous.replace("PrivateDevices=true\n", ""), generated, replace: false, previous })).toBe("diverged");
    expect(decideUnit({ installed: previous, generated, replace: false, previous: null })).toBe("diverged");
    expect(decideUnit({ installed: previous, generated, replace: true, previous: null })).toBe("install");
    // A unit equal to what the new manifest makes stays present, whatever came before.
    expect(decideUnit({ installed: generated, generated, replace: false, previous })).toBe("present");
  });

  test("a hand edit that only repeats or reorders the files read stays: it decides which value wins", () => {
    const previous = unitOf(LEGACY);
    const generated = unitOf({ ...LEGACY, port: 3041 });
    const files = previous.split("\n").filter((line) => line.startsWith("EnvironmentFile="));
    expect(files.length).toBeGreaterThan(2);
    const lines = previous.split("\n");
    // The first file named again last, so that its values win over the second's.
    const repeated = [...lines.slice(0, lines.lastIndexOf(files.at(-1)!) + 1), files[0]!, ...lines.slice(lines.lastIndexOf(files.at(-1)!) + 1)].join("\n");
    // The two legacy files swapped.
    const swapped = lines.map((line) => (line === files[0] ? files[1]! : line === files[1] ? files[0]! : line)).join("\n");
    for (const installed of [repeated, swapped]) {
      expect(installed).not.toBe(previous);
      expect(decideUnit({ installed, generated, replace: false, previous })).toBe("diverged");
      expect(decideUnit({ installed, generated, replace: true, previous })).toBe("install");
      // As a release before the store wrote it, edited the same way: kept too.
      expect(decideUnit({ installed: withoutStoreLines(installed), generated: previous, replace: false })).toBe("diverged");
      // The same manifest: kept as it is, nothing replaced.
      expect(decideUnit({ installed, generated: previous, replace: false })).toBe("present");
    }
    // Untouched, it is still the generator's own.
    expect(decideUnit({ installed: previous, generated, replace: false, previous })).toBe("install");
    expect(decideUnit({ installed: withoutStoreLines(previous), generated: previous, replace: false })).toBe("install");
  });
});
