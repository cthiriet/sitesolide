import { describe, expect, test } from "bun:test"
import {
  activeByHost,
  guestActivity,
  focusCandidates,
  activeCount,
  loadAdvice,
  endDate,
  lastVisit,
  deadline,
  plannedEnd,
  initialHost,
  siteGuests,
  closeOutcome,
  loadFailureReason,
  splitGuests,
  firstField,
  guestRefusal,
  canHaveGuests,
  sitesWithGuests,
  invitationText,
  validateInvitation,
} from "../src/lib/invitations"
import { GUEST_DURATIONS, LABEL_MAX } from "../src/lib/guests"
import { guest, site } from "./factory"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = 1_800_000_000_000

describe("order of the list", () => {
  test("the active ones by nearest expiry, the accesses with no expiry last", () => {
    const { active } = splitGuests(
      [
        guest({ id: "none", expiresAt: null }),
        guest({ id: "far", expiresAt: NOW + 30 * DAY }),
        guest({ id: "soon", expiresAt: NOW + 2 * HOUR }),
      ],
      NOW,
    )
    expect(active.map((i) => i.id)).toEqual(["soon", "far", "none"])
  })

  test("at equal expiry, alphabetical order of the name", () => {
    const { active } = splitGuests([guest({ label: "Zoe" }), guest({ label: "Adam" })], NOW)
    expect(active.map((i) => i.label)).toEqual(["Adam", "Zoe"])
  })

  test("the expired ones go apart, the most recently lapsed first", () => {
    const { active, expired } = splitGuests(
      [
        guest({ id: "old", expiresAt: NOW - 10 * DAY }),
        guest({ id: "live", expiresAt: NOW + DAY }),
        guest({ id: "recent", expiresAt: NOW - HOUR }),
      ],
      NOW,
    )
    expect(active.map((i) => i.id)).toEqual(["live"])
    expect(expired.map((i) => i.id)).toEqual(["recent", "old"])
  })

  /** The portal refuses an access as soon as `expiresAt` is no longer in the future: the page follows the same bound. */
  test("an access that lapses at the exact instant is expired", () => {
    expect(splitGuests([guest({ expiresAt: NOW })], NOW).expired).toHaveLength(1)
  })
})

describe("expiry", () => {
  test("with no expiry, distant, near, expired", () => {
    expect(deadline(guest({ expiresAt: null }), NOW)).toEqual({ text: "No expiry", tone: "none" })
    expect(deadline(guest({ expiresAt: NOW + 30 * DAY }), NOW)).toEqual({ text: "in 30d", tone: "normal" })
    expect(deadline(guest({ expiresAt: NOW + 5 * HOUR }), NOW)).toEqual({ text: "in 5h", tone: "soon" })
    expect(deadline(guest({ expiresAt: NOW - 3 * DAY }), NOW)).toEqual({
      text: "Expired 3d ago",
      tone: "expired",
    })
  })

  test("amber starts under twenty-four hours, not at twenty-four", () => {
    expect(deadline(guest({ expiresAt: NOW + DAY }), NOW).tone).toBe("normal")
    expect(deadline(guest({ expiresAt: NOW + DAY - MINUTE }), NOW).tone).toBe("soon")
  })

  test("the last visit, or never", () => {
    expect(lastVisit(guest({ seenAt: null }), NOW)).toBe("Never")
    expect(lastVisit(guest({ seenAt: NOW - 2 * HOUR }), NOW)).toBe("2h ago")
  })
})

describe("an access's activity", () => {
  test("the last visit or its absence, then the creation, on one line", () => {
    expect(guestActivity(guest({ seenAt: null, createdAt: NOW - DAY }), NOW)).toBe(
      "Never visited, created 24h ago",
    )
    expect(guestActivity(guest({ seenAt: NOW - 2 * HOUR, createdAt: NOW - 7 * DAY }), NOW)).toBe(
      "Visited 2h ago, created 7d ago",
    )
  })

  test("the active accesses are counted by host, without the expired ones, and nothing before the read", () => {
    const counts = activeByHost(
      [
        guest({ id: "a", host: "cms.test-zone.invalid", expiresAt: null }),
        guest({ id: "b", host: "cms.test-zone.invalid", expiresAt: NOW + HOUR }),
        guest({ id: "c", host: "cms.test-zone.invalid", expiresAt: NOW - HOUR }),
        guest({ id: "d", host: "calendar.test-zone.invalid", expiresAt: NOW - HOUR }),
        guest({ id: "e", host: "library.test-zone.invalid", expiresAt: null }),
      ],
      NOW,
    )
    expect(Object.fromEntries(counts)).toEqual({ "cms.test-zone.invalid": 2, "library.test-zone.invalid": 1 })
    expect(activeByHost(null, NOW).size).toBe(0)
  })

  test("the expiry as a date and time, and nothing with no expiry", () => {
    expect(endDate(guest({ expiresAt: Date.UTC(2026, 8, 22, 21, 3) }), "UTC")).toBe("Sep 22, 21:03")
    expect(endDate(guest({ expiresAt: null }), "UTC")).toBeNull()
  })

  test("the header's count only counts the active ones", () => {
    const { active } = splitGuests(
      [guest({ expiresAt: null }), guest({ expiresAt: NOW - HOUR }), guest({ expiresAt: NOW + HOUR })],
      NOW,
    )
    expect(activeCount(active.length)).toBe("2 active")
  })
})

describe("sites that can take guests", () => {
  const door = { wanted: true, installed: true, exemptions: [] }

  /** The rule of invitableHosts (src/guests.ts): the portal requested AND applied. */
  test("only a site that asks for the portal and whose block carries it takes a guest", () => {
    expect(canHaveGuests(site({ portal: door }))).toBe(true)
    expect(canHaveGuests(site({ portal: { ...door, installed: false } }))).toBe(false)
    expect(canHaveGuests(site({ portal: { ...door, wanted: false } }))).toBe(false)
    expect(canHaveGuests(site())).toBe(false)
  })

  test("those that can take guests by slug, the others set aside", () => {
    const sites = [
      site({ slug: "library", address: "library.test-zone.invalid", portal: door }),
      site({ slug: "wheels", address: "wheels.test-zone.invalid" }),
      site({ slug: "cms", address: "cms.test-zone.invalid", portal: door }),
      site({ slug: "kanban", address: "kanban.test-zone.invalid", portal: { ...door, installed: false } }),
    ]
    expect(sitesWithGuests(sites).map((s) => s.slug)).toEqual(["cms", "library"])
  })

  test("the site already chosen: the one asked for if it can take guests, the only one if there is just one, none otherwise", () => {
    const hosts = ["cms.test-zone.invalid", "library.test-zone.invalid"]
    expect(initialHost(hosts, "library.test-zone.invalid")).toBe("library.test-zone.invalid")
    expect(initialHost(hosts, "wheels.test-zone.invalid")).toBe("")
    expect(initialHost(hosts)).toBe("")
    expect(initialHost(["cms.test-zone.invalid"])).toBe("cms.test-zone.invalid")
    expect(initialHost(["cms.test-zone.invalid"], "elsewhere.test-zone.invalid")).toBe("cms.test-zone.invalid")
    expect(initialHost([])).toBe("")
  })
})

describe("a site's accesses", () => {
  test("only those of its host, split and sorted like the page", () => {
    const { active, expired } = siteGuests(
      [
        guest({ id: "elsewhere", host: "library.test-zone.invalid", expiresAt: NOW + HOUR }),
        guest({ id: "none", host: "cms.test-zone.invalid", expiresAt: null }),
        guest({ id: "soon", host: "cms.test-zone.invalid", expiresAt: NOW + HOUR }),
        guest({ id: "lapsed", host: "cms.test-zone.invalid", expiresAt: NOW - HOUR }),
      ],
      "cms.test-zone.invalid",
      NOW,
    )
    expect(active.map((i) => i.id)).toEqual(["soon", "none"])
    expect(expired.map((i) => i.id)).toEqual(["lapsed"])
  })

  test("a host with no access returns two empty lists", () => {
    expect(siteGuests([guest()], "cms.test-zone.invalid", NOW)).toEqual({ active: [], expired: [] })
  })
})

describe("focus after a removed row", () => {
  test("the following ones first, then the preceding ones going back up", () => {
    expect(focusCandidates(["a", "b", "c", "d"], "b")).toEqual(["c", "d", "a"])
    expect(focusCandidates(["a", "b", "c"], "c")).toEqual(["b", "a"])
    expect(focusCandidates(["a"], "a")).toEqual([])
  })

  test("an access already gone from the list leaves every row a candidate", () => {
    expect(focusCandidates(["a", "b"], "z")).toEqual(["a", "b"])
  })
})

describe("copied invitation", () => {
  test("the address, the password and the expiry, one per line", () => {
    expect(
      invitationText("forum.test-zone.invalid", "Xith-G4r4-nRJs-uDMV", Date.UTC(2026, 8, 22, 21, 3), "UTC"),
    ).toBe("https://forum.test-zone.invalid\nPassword: Xith-G4r4-nRJs-uDMV\nValid until Sep 22, 21:03")
  })

  test("with no expiry, no empty line and no invented date", () => {
    expect(invitationText("cms.test-zone.invalid", "Xith-G4r4-nRJs-uDMV", null)).toBe(
      "https://cms.test-zone.invalid\nPassword: Xith-G4r4-nRJs-uDMV",
    )
  })
})

describe("chosen duration", () => {
  test("the exact end date, or the absence of an expiry", () => {
    expect(plannedEnd(7 * 24 * 3600, Date.UTC(2026, 8, 15, 21, 3), "UTC")).toBe("Ends Sep 22, 21:03.")
    expect(plannedEnd(null, NOW)).toBe("Stays valid until you revoke it.")
  })

  test("every duration the portal accepts is stated", () => {
    for (const option of GUEST_DURATIONS) {
      expect(plannedEnd(option.seconds, NOW, "UTC")).toMatch(/^(Ends \w{3} \d{1,2}, \d{2}:\d{2}\.|Stays valid until you revoke it\.)$/)
    }
  })
})

describe("closing the password screen", () => {
  test("with no copy, the first click warns and the second closes", () => {
    expect(closeOutcome(false, false)).toBe("warn")
    expect(closeOutcome(false, true)).toBe("closeButton")
  })

  test("after a copy, the first click closes", () => {
    expect(closeOutcome(true, false)).toBe("closeButton")
  })
})

describe("form validation", () => {
  const hosts = ["forum.test-zone.invalid", "cms.test-zone.invalid"]

  test("a complete form goes through", () => {
    expect(validateInvitation("cms.test-zone.invalid", "Alice", hosts)).toEqual({})
  })

  test("with no site chosen, the site field is at fault", () => {
    expect(validateInvitation("", "Alice", hosts)).toEqual({ site: "Choose a site." })
    expect(validateInvitation("elsewhere.test-zone.invalid", "Alice", hosts)).toEqual({ site: "Choose a site." })
  })

  test("a name that is empty, too long or on two lines is refused, as the portal would refuse it", () => {
    expect(validateInvitation("cms.test-zone.invalid", "   ", hosts)).toEqual({ label: "Enter the guest's name." })
    expect(validateInvitation("cms.test-zone.invalid", "a".repeat(LABEL_MAX + 1), hosts).label).toContain(
      String(LABEL_MAX),
    )
    expect(validateInvitation("cms.test-zone.invalid", "Alice\nBob", hosts).label).toBeDefined()
  })

  test("the two faults are stated together", () => {
    expect(Object.keys(validateInvitation("", "", hosts)).sort()).toEqual(["label", "site"])
  })

  test("focus goes to the first faulty field in form order", () => {
    expect(firstField(validateInvitation("", "", hosts))).toBe("site")
    expect(firstField({ duration: "x", label: "y" })).toBe("label")
    expect(firstField({})).toBeNull()
  })
})

describe("portal refusal", () => {
  test("every known code falls back on its field", () => {
    expect(guestRefusal(400, { error: "no-portal" }).field).toBe("site")
    expect(guestRefusal(400, { error: "invalid-label" }).field).toBe("label")
    expect(guestRefusal(400, { error: "invalid-duration" }).field).toBe("duration")
    expect(guestRefusal(404, { error: "unknown-access" })).toEqual({
      field: null,
      message: "This access no longer exists.",
    })
  })

  test("a downed network and an unreachable portal are told apart", () => {
    expect(guestRefusal(0, null).message).toBe("Can't reach the dashboard.")
    expect(guestRefusal(502, { error: "portal-unreachable" }).message).toBe("Can't reach the portal.")
    expect(loadFailureReason(0)).toBe("Can't reach the dashboard.")
    expect(loadFailureReason(502)).toBe("Can't reach the portal.")
  })

  test("the advice follows the reason: the connection, or the portal's service", () => {
    expect(loadAdvice(loadFailureReason(0)).command).toBeNull()
    expect(loadAdvice(loadFailureReason(0)).text).toContain("connection")
    expect(loadAdvice(loadFailureReason(502)).command).toBe("systemctl status portal")
  })

  test("an unknown code is shown as it is rather than vanishing", () => {
    expect(guestRefusal(418, { error: "teapot" }).message).toBe("Refused (418: teapot).")
    expect(guestRefusal(500, null).message).toBe("Refused (500).")
  })
})
