import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  createGuest,
  putAccess,
  putMember,
  putProjectMember,
  readAccess,
  readGuests,
  readMembers,
  readProjectMembers,
  readSharing,
  removeAccess,
  removeMember,
  removeProjectMember,
  replaceSharing,
  revokeGuest,
  setCreate,
  setGeneralAccess,
} from "../src/lib/api"
import type { AccessRole, EntryView, PersonView } from "../src/lib/types"
import { site } from "./factory"

/**
 * lib/api.ts over a fake of the dashboard's routes: the access routes as they
 * are, and the functions that keep the pages written before the access
 * registry working on them (Guests, Sharing, Members, a project's Members).
 * `fetch` is replaced for each test by a server in memory, which keeps the
 * people with access per project and records every request.
 */

const ZONE = "test-zone.invalid"
const NOW = 1_791_000_000_000

type Project = { entries: EntryView[]; restricted: boolean }

const server = {
  projects: {} as Record<string, Project>,
  creators: [] as string[],
  /** Projects this session may not read: 403, as for a person who is not their Admin. */
  forbidden: [] as string[],
  /** Every request answers 401: the session is gone. */
  signedOut: false,
  /** A refusal every change gets. */
  refuse: null as { status: number; error: string; message: string } | null,
  requests: [] as string[],
}

function entry(who: string, role: AccessRole = "visitor", fields: Partial<EntryView> = {}): EntryView {
  return { who, kind: who.startsWith("@") ? "domain" : "person", role, by: "owner", createdAt: NOW, updatedAt: NOW, password: null, ...fields }
}

function password(who: string, expiresAt: number | null, createdAt = NOW): EntryView {
  return entry(who, "visitor", { kind: "password", createdAt, password: { expiresAt, expired: false } })
}

const SIGN_IN = { configured: true, allowedDomains: ["acme.test"], admins: ["root@acme.test"], providerName: "Google" }

function accessPage(slug: string) {
  const host = `${slug}.${ZONE}`
  return {
    slug,
    host,
    url: `https://${host}/`,
    general: { access: "restricted", modifiable: true, reason: null },
    entries: server.projects[slug]!.entries,
    signIn: SIGN_IN,
    portal: { reading: "steward", writtenAt: NOW },
    code: null,
    you: { kind: "owner" },
    grantable: ["visitor", "viewer", "developer", "admin"],
    until: null,
    dashboardUrl: `https://dashboard.${ZONE}`,
    providerName: "Google",
  }
}

function peopleList(): PersonView[] {
  const people = new Map<string, PersonView>()
  const person = (who: string) => {
    const found = people.get(who) ?? { who, roles: {}, create: server.creators.includes(who), passwords: [], admin: false }
    people.set(who, found)
    return found
  }
  for (const [slug, project] of Object.entries(server.projects)) {
    for (const one of project.entries) {
      if (one.kind === "domain") continue
      person(one.who).roles[slug] = one.role
      if (one.password !== null) person(one.who).passwords.push({ slug, ...one.password })
    }
  }
  for (const creator of server.creators) person(creator)
  return [...people.values()]
}

async function answer(path: string, method: string, body: Record<string, any> | null): Promise<Response> {
  if (server.signedOut) return Response.json({ error: "no-session" }, { status: 401 })
  if (path === "/api/state") {
    const sites = Object.entries(server.projects).map(([slug, project]) =>
      site({ slug, address: `${slug}.${ZONE}`, portal: { wanted: project.restricted, installed: project.restricted, exemptions: [] } }),
    )
    sites.push(site({ slug: "open", address: `open.${ZONE}` }))
    return Response.json({ present: true, snapshot: { sites }, audience: {}, age: 0, stale: false })
  }
  if (path.startsWith("/api/access?slug=")) {
    const slug = decodeURIComponent(path.slice("/api/access?slug=".length))
    if (server.forbidden.includes(slug)) return Response.json({ error: "out-of-scope", message: `not an Admin of ${slug}` }, { status: 403 })
    return Response.json(accessPage(slug))
  }
  if (server.refuse !== null && method !== "GET") return Response.json(server.refuse, { status: server.refuse.status })
  if (path === "/api/access/entry") {
    const project = server.projects[body!.slug]!
    const existing = project.entries.find((one) => one.who === body!.who) ?? null
    if (method === "DELETE") {
      if (existing === null) return Response.json({ error: "not-found", message: `${body!.who} has no access` }, { status: 404 })
      project.entries = project.entries.filter((one) => one.who !== body!.who)
      return Response.json({ slug: body!.slug, entry: existing, change: "remove" })
    }
    const outside = !body!.who.startsWith("@") && !body!.who.endsWith("@acme.test")
    if (existing !== null) {
      const changed = { ...existing, role: body!.role, updatedAt: NOW + 1 }
      project.entries = project.entries.map((one) => (one.who === body!.who ? changed : one))
      return Response.json({ slug: body!.slug, entry: changed, change: existing.role === body!.role ? "none" : "role" })
    }
    const given = outside
      ? password(body!.who, body!.expiresInS === null ? null : NOW + (body!.expiresInS ?? 604_800) * 1000)
      : entry(body!.who, body!.role)
    project.entries = [...project.entries, given]
    return Response.json({ slug: body!.slug, entry: given, change: "add", ...(outside ? { password: "drawn-once" } : {}) }, { status: 201 })
  }
  if (path === "/api/access/general") return Response.json({ ok: true })
  if (path === "/api/people") {
    return Response.json({
      people: peopleList(),
      domains: [],
      signIn: SIGN_IN,
      available: true,
      reason: null,
      projects: Object.keys(server.projects),
      until: NOW + 60_000,
      dashboardUrl: `https://dashboard.${ZONE}`,
      providerName: "Google",
    })
  }
  if (path === "/api/people/person") {
    if (method === "PUT") {
      const had = server.creators.includes(body!.email)
      server.creators = body!.create ? [...new Set([...server.creators, body!.email])] : server.creators.filter((one) => one !== body!.email)
      const person = peopleList().find((one) => one.who === body!.email) ?? { who: body!.email, roles: {}, create: false, passwords: [], admin: false }
      return Response.json({ person, change: had === body!.create ? "none" : body!.create ? "create" : "remove" })
    }
    const person = peopleList().find((one) => one.who === body!.email)
    if (person === undefined) return Response.json({ error: "not-found", message: `${body!.email} has no access` }, { status: 404 })
    for (const project of Object.values(server.projects)) project.entries = project.entries.filter((one) => one.who !== body!.email)
    server.creators = server.creators.filter((one) => one !== body!.email)
    return Response.json({ person, change: "remove" })
  }
  return Response.json({ error: "not-found", message: "no such route" }, { status: 404 })
}

const realFetch = globalThis.fetch

beforeEach(() => {
  server.projects = {
    kanban: { restricted: true, entries: [] },
    blog: { restricted: true, entries: [] },
    draft: { restricted: false, entries: [] },
  }
  server.creators = []
  server.forbidden = []
  server.signedOut = false
  server.refuse = null
  server.requests = []
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const path = String(input)
    const method = init.method ?? "GET"
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, any>) : null
    server.requests.push(`${method} ${path}${body === null ? "" : ` ${init.body}`}`)
    return answer(path, method, body)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const changes = () => server.requests.filter((one) => !one.startsWith("GET "))

describe("the access routes", () => {
  test("each function, its route, its method and its body", async () => {
    expect((await readAccess("kanban")).status).toBe(200)
    await putAccess("kanban", "alice@acme.test", "developer")
    await putAccess("kanban", "eve@elsewhere.test", "visitor", 86_400)
    await putAccess("kanban", "zoe@elsewhere.test", "visitor", null)
    await removeAccess("kanban", "alice@acme.test")
    await setGeneralAccess("kanban", "public", "kanban")
    await setCreate("carol@acme.test", true)
    expect(server.requests).toEqual([
      "GET /api/access?slug=kanban",
      'PUT /api/access/entry {"slug":"kanban","who":"alice@acme.test","role":"developer"}',
      'PUT /api/access/entry {"slug":"kanban","who":"eve@elsewhere.test","role":"visitor","expiresInS":86400}',
      'PUT /api/access/entry {"slug":"kanban","who":"zoe@elsewhere.test","role":"visitor","expiresInS":null}',
      'DELETE /api/access/entry {"slug":"kanban","who":"alice@acme.test"}',
      'PUT /api/access/general {"slug":"kanban","access":"public","confirmation":"kanban"}',
      'PUT /api/people/person {"email":"carol@acme.test","create":true}',
    ])
  })

  test("a slug is encoded in the address, and a service that does not answer is status 0", async () => {
    await readAccess("a&b")
    expect(server.requests).toEqual(["GET /api/access?slug=a%26b"])
    globalThis.fetch = (async () => {
      throw new Error("down")
    }) as unknown as typeof fetch
    expect(await readAccess("kanban")).toEqual({ status: 0, body: null })
  })
})

describe("the Guests page, on password access", () => {
  test("the password access of every restricted project the session reads, newest first, each named by its project and who", async () => {
    server.projects.kanban!.entries = [password("eve@elsewhere.test", NOW + 1000, NOW - 10), entry("alice@acme.test", "developer")]
    server.projects.blog!.entries = [password("zoe@elsewhere.test", null, NOW)]
    server.projects.draft!.entries = [password("hidden@elsewhere.test", null)]
    const { status, body } = await readGuests()
    expect(status).toBe(200)
    expect(body!.guests).toEqual([
      { id: "blog:zoe@elsewhere.test", host: `blog.${ZONE}`, label: "zoe@elsewhere.test", createdAt: NOW, expiresAt: null, seenAt: null },
      { id: "kanban:eve@elsewhere.test", host: `kanban.${ZONE}`, label: "eve@elsewhere.test", createdAt: NOW - 10, expiresAt: NOW + 1000, seenAt: null },
    ])
    // A project not restricted is not asked.
    expect(server.requests.some((one) => one.includes("slug=draft"))).toBe(false)
  })

  test("a project the session may not read is left out; a session gone is 401", async () => {
    server.projects.kanban!.entries = [password("eve@elsewhere.test", null)]
    server.projects.blog!.entries = [password("zoe@elsewhere.test", null)]
    server.forbidden = ["blog"]
    expect((await readGuests()).body!.guests.map((guest) => guest.id)).toEqual(["kanban:eve@elsewhere.test"])
    server.signedOut = true
    expect(await readGuests()).toEqual({ status: 401, body: null })
  })

  test("a guest created is password access, Can open, for the duration chosen, the password once", async () => {
    const { status, body } = await createGuest(`kanban.${ZONE}`, "eve@elsewhere.test", 86_400)
    expect(status).toBe(201)
    expect(body).toEqual({
      guest: { id: "kanban:eve@elsewhere.test", host: `kanban.${ZONE}`, label: "eve@elsewhere.test", createdAt: NOW, expiresAt: NOW + 86_400_000, seenAt: null },
      password: "drawn-once",
    })
    expect(changes()).toEqual(['PUT /api/access/entry {"slug":"kanban","who":"eve@elsewhere.test","role":"visitor","expiresInS":86400}'])
  })

  test("a guest on a site that is not restricted is no-portal, asked of nobody; one inside the company's domains gets no password, and is refused", async () => {
    expect(await createGuest(`draft.${ZONE}`, "eve@elsewhere.test", null)).toEqual({ status: 400, body: { error: "no-portal" } as never })
    expect(changes()).toEqual([])
    const inside = await createGuest(`kanban.${ZONE}`, "alice@acme.test", null)
    expect(inside.status).toBe(400)
    server.refuse = { status: 423, error: "locked", message: "unlock first" }
    expect(await createGuest(`kanban.${ZONE}`, "bob@elsewhere.test", null)).toMatchObject({ status: 423, body: { error: "locked" } })
  })

  test("revoking takes the access away, 204 as before; an id that names no project is 404, asked of nobody", async () => {
    server.projects.kanban!.entries = [password("eve@elsewhere.test", null)]
    expect((await revokeGuest("kanban:eve@elsewhere.test")).status).toBe(204)
    expect(server.projects.kanban!.entries).toEqual([])
    expect(await revokeGuest("AAAAAAAAAAAAAAAA")).toEqual({ status: 404, body: { error: "unknown-access" } })
    expect((await revokeGuest("kanban:eve@elsewhere.test")).status).toBe(404)
    expect(changes()).toEqual(['DELETE /api/access/entry {"slug":"kanban","who":"eve@elsewhere.test"}', 'DELETE /api/access/entry {"slug":"kanban","who":"eve@elsewhere.test"}'])
  })
})

describe("the Sharing page, on people with access", () => {
  test("a policy per restricted project, read from its people and domains, the sign-in from the first", async () => {
    server.projects.kanban!.entries = [entry("bob@acme.test"), entry("alice@acme.test", "developer"), password("eve@elsewhere.test", null)]
    server.projects.blog!.entries = [entry("@acme.test"), entry("carol@acme.test", "visitor", { updatedAt: NOW + 5 })]
    const { status, body } = await readSharing()
    expect(status).toBe(200)
    expect(body!.sso).toEqual({ configured: true, providerName: "Google", portalUrl: null, admins: ["root@acme.test"], allowedDomains: ["acme.test"] })
    expect(body!.sites).toEqual([
      { host: `kanban.${ZONE}`, policy: { mode: "people", people: ["alice@acme.test", "bob@acme.test"], domains: [] }, updatedAt: NOW },
      { host: `blog.${ZONE}`, policy: { mode: "domain", people: ["carol@acme.test"], domains: ["acme.test"] }, updatedAt: NOW + 5 },
    ])
  })

  test("nothing restricted: nobody, and sign-in said not set up", async () => {
    server.projects = { draft: { restricted: false, entries: [] } }
    expect((await readSharing()).body).toEqual({ sso: { configured: false, providerName: null, portalUrl: null, admins: [], allowedDomains: [] }, sites: [] })
  })

  test("a policy sent whole becomes the changes it means: Can open given and taken away, a higher role and password access never touched", async () => {
    server.projects.kanban!.entries = [entry("bob@acme.test"), entry("alice@acme.test", "admin"), password("eve@elsewhere.test", null), entry("@old.test")]
    const { status, body } = await replaceSharing(`kanban.${ZONE}`, { mode: "domain", people: ["carol@acme.test", "alice@acme.test"], domains: ["acme.test"] })
    expect(status).toBe(200)
    expect(changes()).toEqual([
      'DELETE /api/access/entry {"slug":"kanban","who":"bob@acme.test"}',
      'DELETE /api/access/entry {"slug":"kanban","who":"@old.test"}',
      'PUT /api/access/entry {"slug":"kanban","who":"carol@acme.test","role":"visitor"}',
      'PUT /api/access/entry {"slug":"kanban","who":"@acme.test","role":"visitor"}',
    ])
    expect(body).toMatchObject({ host: `kanban.${ZONE}`, policy: { mode: "domain", people: ["alice@acme.test", "carol@acme.test"], domains: ["acme.test"] } })
    expect(server.projects.kanban!.entries.map((one) => [one.who, one.role])).toEqual([
      ["alice@acme.test", "admin"],
      ["eve@elsewhere.test", "visitor"],
      ["carol@acme.test", "visitor"],
      ["@acme.test", "visitor"],
    ])
  })

  test("back to the admins alone takes every Can open person and domain away; a site not restricted is no-portal; a refusal stops", async () => {
    server.projects.kanban!.entries = [entry("bob@acme.test"), entry("@acme.test")]
    expect((await replaceSharing(`kanban.${ZONE}`, { mode: "admins", people: ["bob@acme.test"], domains: ["acme.test"] })).body!.policy).toEqual({ mode: "admins", people: [], domains: [] })
    expect(server.projects.kanban!.entries).toEqual([])
    expect(await replaceSharing(`draft.${ZONE}`, { mode: "people", people: ["a@acme.test"], domains: [] })).toEqual({ status: 400, body: { error: "no-portal" } as never })
    server.refuse = { status: 403, error: "out-of-scope", message: "not yours" }
    expect(await replaceSharing(`kanban.${ZONE}`, { mode: "people", people: ["a@acme.test"], domains: [] })).toMatchObject({ status: 403, body: { error: "out-of-scope" } })
  })
})

describe("the Members page, on People", () => {
  test("the people with a role above Can open, or the right to create projects; Can open roles left out", async () => {
    server.projects.kanban!.entries = [entry("alice@acme.test", "developer"), entry("bob@acme.test"), password("eve@elsewhere.test", null)]
    server.projects.blog!.entries = [entry("alice@acme.test")]
    server.creators = ["carol@acme.test"]
    const { status, body } = await readMembers()
    expect(status).toBe(200)
    expect(body!.members.map((member) => [member.email, member.roles, member.create])).toEqual([
      ["alice@acme.test", { kanban: "developer" }, false],
      ["carol@acme.test", {}, true],
    ])
    expect(body).toMatchObject({ available: true, reason: null, signIn: { configured: true, allowedDomains: ["acme.test"] }, projects: ["kanban", "blog", "draft"], until: NOW + 60_000, providerName: "Google" })
  })

  test("a member's roles set: the ones named given, the ones no longer named taken away, then the create right", async () => {
    server.projects.kanban!.entries = [entry("alice@acme.test", "developer")]
    server.projects.blog!.entries = [entry("alice@acme.test", "viewer")]
    const { status, body } = await putMember("alice@acme.test", { kanban: "admin" }, true)
    expect(status).toBe(200)
    expect(body!.change).toBe("role")
    expect(changes()).toEqual([
      'PUT /api/access/entry {"slug":"kanban","who":"alice@acme.test","role":"admin"}',
      'DELETE /api/access/entry {"slug":"blog","who":"alice@acme.test"}',
      'PUT /api/people/person {"email":"alice@acme.test","create":true}',
    ])
    expect((await putMember("alice@acme.test", { kanban: "admin" }, true)).body!.change).toBe("none")
  })

  test("someone new is an invitation, 201; a refusal stops before the rest", async () => {
    expect(await putMember("dan@acme.test", { blog: "viewer" }, false)).toMatchObject({ status: 201, body: { change: "invite", member: { email: "dan@acme.test", roles: { blog: "viewer" }, create: false } } })
    server.refuse = { status: 423, error: "locked", message: "unlock first" }
    expect(await putMember("erin@acme.test", { blog: "viewer", kanban: "admin" }, true)).toMatchObject({ status: 423, body: { error: "locked" } })
    expect(changes().filter((one) => one.includes("erin"))).toEqual(['PUT /api/access/entry {"slug":"blog","who":"erin@acme.test","role":"viewer"}'])
  })

  test("removing a member takes them off every project, their roles said as they were", async () => {
    server.projects.kanban!.entries = [entry("alice@acme.test", "developer")]
    server.projects.blog!.entries = [entry("alice@acme.test")]
    const { status, body } = await removeMember("alice@acme.test")
    expect(status).toBe(200)
    expect(body!.member).toMatchObject({ email: "alice@acme.test", roles: { kanban: "developer" }, create: false })
    expect(changes()).toEqual(['DELETE /api/people/person {"email":"alice@acme.test"}'])
    expect(server.projects.kanban!.entries).toEqual([])
    expect((await removeMember("alice@acme.test")).status).toBe(404)
  })
})

describe("a project's Members section, on its people with access", () => {
  test("the people with a role above Can open there, never a domain nor password access", async () => {
    server.projects.kanban!.entries = [entry("alice@acme.test", "developer", { by: "bob@acme.test", updatedAt: NOW + 2 }), entry("bob@acme.test"), entry("@acme.test"), password("eve@elsewhere.test", null)]
    const { status, body } = await readProjectMembers("kanban")
    expect(status).toBe(200)
    expect(body).toEqual({
      slug: "kanban",
      members: [{ email: "alice@acme.test", role: "developer", invitedBy: "bob@acme.test", updatedAt: NOW + 2 }],
      signIn: { configured: true, allowedDomains: ["acme.test"] },
      dashboardUrl: `https://dashboard.${ZONE}`,
      providerName: "Google",
      until: null,
    })
    server.forbidden = ["kanban"]
    expect(await readProjectMembers("kanban")).toMatchObject({ status: 403, body: { error: "out-of-scope" } })
  })

  test("a role given is an invitation or a change; taken away, the entry goes", async () => {
    expect(await putProjectMember("kanban", "alice@acme.test", "viewer")).toMatchObject({ status: 201, body: { change: "invite", member: { email: "alice@acme.test", roles: { kanban: "viewer" } } } })
    expect(await putProjectMember("kanban", "alice@acme.test", "developer")).toMatchObject({ status: 200, body: { change: "role" } })
    expect(await putProjectMember("kanban", "alice@acme.test", "developer")).toMatchObject({ status: 200, body: { change: "none" } })
    expect(await removeProjectMember("kanban", "alice@acme.test")).toMatchObject({ status: 200, body: { change: "role", member: { email: "alice@acme.test", roles: {} } } })
    expect(server.projects.kanban!.entries).toEqual([])
    expect((await removeProjectMember("kanban", "alice@acme.test")).status).toBe(404)
  })
})
