import { describe, expect, test } from "bun:test";
import { missingByProject, readMissingSecrets } from "../src/secrets/missing";
import { MISSING_SECRET_SEVERITY, storeMissing, type StoreFileView, type StoreView } from "../borrowed/store-protocol";

function file(name: string, state: StoreFileView["state"], declared = true, reason: string | null = null): StoreFileView {
  return { name, state, declared, reason, bytes: null, modifiedAt: null, restartPending: false };
}

function store(missing: string[], files: StoreFileView[] = []): Pick<StoreView, "missing" | "files"> {
  return { missing, files };
}

describe("what a store lacks", () => {
  test("the declared names with no value, and the declared files absent or empty, never one nothing declares", () => {
    const view = store(["DATABASE_KEY"], [file("gcp.json", "missing"), file("tls.key", "missing", true, "empty"), file("old.pem", "missing", false), file("ok.json", "set")]);
    expect(storeMissing(view)).toEqual({ runtime: ["DATABASE_KEY"], files: ["gcp.json", "tls.key"] });
  });

  test("is a warning: the deployment goes on, and the service starts without it", () => {
    expect(MISSING_SECRET_SEVERITY).toBe("warning");
  });

  test("by project, those that lack nothing left out, a project with no store too", () => {
    const found = missingByProject([
      { slug: "cms", store: store(["DATABASE_KEY"]) as StoreView },
      { slug: "shop", store: store([]) as StoreView },
      { slug: "photos", store: null },
    ]);
    expect([...found]).toEqual([["cms", { runtime: ["DATABASE_KEY"], files: [] }]]);
  });
});

describe("the steward's listing", () => {
  const steward = (answer: () => Promise<Response>) => ({ readProjects: answer });

  test("read for its names", async () => {
    const listing = { projects: [{ slug: "cms", store: store(["DATABASE_KEY"], [file("gcp.json", "missing")]) }, { slug: "photos", store: null }] };
    const found = await readMissingSecrets(steward(async () => Response.json(listing)));
    expect(found === null ? null : [...found]).toEqual([["cms", { runtime: ["DATABASE_KEY"], files: ["gcp.json"] }]]);
  });

  test("an older steward, whose projects carry no store, lacks nothing", async () => {
    const found = await readMissingSecrets(steward(async () => Response.json({ projects: [{ slug: "cms" }] })));
    expect(found === null ? null : found.size).toBe(0);
  });

  test("unreachable, refused or unreadable: null, and the snapshot goes out without them", async () => {
    expect(await readMissingSecrets(steward(async () => Promise.reject(new Error("ECONNREFUSED"))))).toBeNull();
    expect(await readMissingSecrets(steward(async () => Response.json({ error: "failure" }, { status: 500 })))).toBeNull();
    expect(await readMissingSecrets(steward(async () => new Response("not json")))).toBeNull();
    expect(await readMissingSecrets(steward(async () => Response.json({ projects: "none" })))).toBeNull();
  });

  test("a project whose store is not a listing's is left aside, not the whole listing", async () => {
    const listing = { projects: [{ slug: "cms", store: { missing: "DATABASE_KEY" } }, { slug: "shop", store: store(["CMS_TOKEN"]) }] };
    const found = await readMissingSecrets(steward(async () => Response.json(listing)));
    expect(found === null ? null : [...found.keys()]).toEqual(["shop"]);
  });
});
