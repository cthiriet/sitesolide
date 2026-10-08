import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  createToken,
  putAccess,
  readAccess,
  readPeople,
  readTokens,
  removeAccess,
  removePerson,
  restartService,
  revokeToken,
  setCreate,
  setGeneralAccess,
} from "../src/lib/api"

/**
 * lib/api.ts calls the dashboard's routes as they are: each function, its
 * route, its method and its body, the session's cookie with it. `fetch` is
 * replaced by one that records every request and answers what the test sets.
 */

const requests: string[] = []
let next: { status: number; body: unknown } = { status: 200, body: {} }
const realFetch = globalThis.fetch

beforeEach(() => {
  requests.length = 0
  next = { status: 200, body: {} }
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? ` ${init.body}` : ""
    requests.push(`${init.method ?? "GET"} ${String(input)}${body} ${init.credentials ?? ""}`.trim())
    return Response.json(next.body, { status: next.status })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("the access routes", () => {
  test("each function, its route, its method and its body, with the session's cookie", async () => {
    await readAccess("kanban")
    await putAccess("kanban", "alice@acme.test", "developer")
    await putAccess("kanban", "eve@elsewhere.test", "visitor", 86_400)
    await putAccess("kanban", "zoe@elsewhere.test", "visitor", null)
    await removeAccess("kanban", "alice@acme.test")
    await setGeneralAccess("kanban", "public", "kanban")
    await readPeople()
    await setCreate("carol@acme.test", true)
    await removePerson("carol@acme.test")
    expect(requests).toEqual([
      "GET /api/access?slug=kanban same-origin",
      'PUT /api/access/entry {"slug":"kanban","who":"alice@acme.test","role":"developer"} same-origin',
      'PUT /api/access/entry {"slug":"kanban","who":"eve@elsewhere.test","role":"visitor","expiresInS":86400} same-origin',
      'PUT /api/access/entry {"slug":"kanban","who":"zoe@elsewhere.test","role":"visitor","expiresInS":null} same-origin',
      'DELETE /api/access/entry {"slug":"kanban","who":"alice@acme.test"} same-origin',
      'PUT /api/access/general {"slug":"kanban","access":"public","confirmation":"kanban"} same-origin',
      "GET /api/people same-origin",
      'PUT /api/people/person {"email":"carol@acme.test","create":true} same-origin',
      'DELETE /api/people/person {"email":"carol@acme.test"} same-origin',
    ])
  })

  test("a slug is encoded in the address; a refusal comes back as it stands; a service that does not answer is status 0", async () => {
    await readAccess("a&b")
    expect(requests).toEqual(["GET /api/access?slug=a%26b same-origin"])
    next = { status: 423, body: { error: "locked", message: "Unlock first" } }
    expect(await putAccess("kanban", "bob@acme.test", "admin")).toEqual({ status: 423, body: { error: "locked", message: "Unlock first" } })
    globalThis.fetch = (async () => {
      throw new Error("down")
    }) as unknown as typeof fetch
    expect(await readAccess("kanban")).toEqual({ status: 0, body: null })
  })
})

describe("the tokens and the restart", () => {
  test("Tokens reads and writes under /api/tokens; a restart goes to the Secrets section's route, for the owner and a person alike", async () => {
    await readTokens()
    await createToken({ label: "laptop", holder: "ada@acme.test", expiresAt: null, scope: { slugs: ["blog"], create: false, outbound: false, domain: false, public: false } })
    await createToken({ label: "agent", expiresAt: null, scope: { slugs: [], create: true, outbound: false, domain: false, public: false } })
    await revokeToken("abc")
    await restartService({ slug: "blog" })
    expect(requests).toEqual([
      "GET /api/tokens same-origin",
      'POST /api/tokens {"label":"laptop","holder":"ada@acme.test","expiresAt":null,"scope":{"slugs":["blog"],"create":false,"outbound":false,"domain":false,"public":false}} same-origin',
      'POST /api/tokens {"label":"agent","expiresAt":null,"scope":{"slugs":[],"create":true,"outbound":false,"domain":false,"public":false}} same-origin',
      'POST /api/tokens/revoke {"id":"abc"} same-origin',
      'POST /api/secrets/restart {"slug":"blog"} same-origin',
    ])
  })
})
