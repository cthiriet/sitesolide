import { describe, expect, test } from "bun:test"
import {
  ABSENT,
  currentAge,
  fromNow,
  dateTime,
  duration,
  guestDuration,
  ago,
  size,
  sizeOutOf,
} from "../src/lib/format"
import { GUEST_DURATIONS } from "../src/lib/guests"

const SECONDE = 1000
const MINUTE = 60 * SECONDE
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const GO = 1024 ** 3
const MO = 1024 ** 2

describe("sizes", () => {
  test("sizes move up a unit and keep a useful decimal", () => {
    expect(size(0)).toBe("0 B")
    expect(size(1023)).toBe("1023 B")
    expect(size(1024)).toBe("1.0 KB")
    expect(size(1536)).toBe("1.5 KB")
    expect(size(8_337_465_344)).toBe("7.8 GB")
  })

  test("a missing value is stated, it does not become zero", () => {
    expect(size(null)).toBe(ABSENT)
    expect(duration(null)).toBe(ABSENT)
    expect(ago(undefined)).toBe(ABSENT)
    expect(sizeOutOf(null, GO)).toBe(ABSENT)
  })

  test("a part and its whole share their unit when they can", () => {
    expect(sizeOutOf(1.9 * GO, 3.8 * GO)).toBe("1.9 of 3.8 GB")
    expect(sizeOutOf(61 * MO, 256 * MO)).toBe("61 of 256 MB")
  })

  test("two different units are both written", () => {
    expect(sizeOutOf(900 * MO, 3.8 * GO)).toBe("900 MB of 3.8 GB")
  })
})

describe("compact durations", () => {
  test("each scale has its letter, with no space", () => {
    expect(duration(30 * SECONDE)).toBe("30s")
    expect(duration(5 * MINUTE)).toBe("5m")
    expect(duration(2 * HOUR)).toBe("2h")
    expect(duration(13 * DAY)).toBe("13d")
  })

  test("hours run up to two days before moving on to days", () => {
    expect(duration(35 * HOUR)).toBe("35h")
    expect(duration(47 * HOUR)).toBe("47h")
    expect(duration(48 * HOUR)).toBe("2d")
  })

  test("a full scale moves to the next one rather than displaying 60", () => {
    expect(duration(59.6 * SECONDE)).toBe("1m")
    expect(duration(59.5 * MINUTE)).toBe("1h")
  })

  test("a negative gap never returns a negative duration", () => {
    expect(duration(-5 * MINUTE)).toBe("0s")
  })

  test("an access created just now for seven days still says seven days", () => {
    expect(fromNow(7 * DAY - 3 * SECONDE)).toBe("in 7d")
  })
})

describe("how long ago", () => {
  test("an age is stated with ago", () => {
    expect(ago(12 * SECONDE)).toBe("12s ago")
    expect(ago(9 * DAY)).toBe("9d ago")
  })

  test("an age of zero, very short or negative reads just now", () => {
    expect(ago(0)).toBe("just now")
    expect(ago(4 * SECONDE)).toBe("just now")
    expect(ago(-23 * HOUR)).toBe("just now")
  })
})

describe("snapshot age on the client side", () => {
  test("the age measured by the server ages with the time elapsed since reception", () => {
    expect(currentAge(12 * SECONDE, 1_000_000, 1_000_000)).toBe(12 * SECONDE)
    expect(currentAge(12 * SECONDE, 1_000_000, 1_000_000 + 4 * MINUTE)).toBe(12 * SECONDE + 4 * MINUTE)
  })

  /** The workstation's clock can go backwards: the displayed age must not grow younger for all that. */
  test("a clock going backwards takes nothing off the age", () => {
    expect(currentAge(12 * SECONDE, 1_000_000, 1_000_000 - MINUTE)).toBe(12 * SECONDE)
  })

  test("a negative age coming from the server still displays just now", () => {
    const age = currentAge(-23 * HOUR, 0, 30 * SECONDE)
    expect(age).toBeLessThan(0)
    expect(ago(age)).toBe("just now")
  })
})

describe("expiry dates", () => {
  test("an expiry carries the month, the day and the time", () => {
    expect(dateTime(Date.UTC(2026, 8, 22, 21, 3), "UTC")).toBe("Sep 22, 21:03")
    expect(dateTime(Date.UTC(2026, 0, 5, 9, 0), "UTC")).toBe("Jan 5, 09:00")
  })
})

describe("guest access durations", () => {
  /**
   * The portal supplies a label in French, which the page does not display: its
   * own is computed from the seconds, the only value the portal judges.
   */
  test("every duration in the menu gets an English label", () => {
    expect(GUEST_DURATIONS.map((option) => guestDuration(option.seconds))).toEqual([
      "24 hours",
      "7 days",
      "30 days",
      "No expiry",
    ])
  })

  test("a single hour is stated in the singular", () => {
    expect(guestDuration(3600)).toBe("1 hour")
  })
})
