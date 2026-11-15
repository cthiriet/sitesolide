import { describe, expect, test } from "bun:test"
import {
  WARNING_THRESHOLD,
  CRITICAL_THRESHOLD,
  level,
  serviceLevel,
  usedShare,
  loadShare,
  loadTile,
  diskTile,
  memoryTile,
} from "../src/lib/gauges"
import type { RawMachine } from "../src/lib/types"

const GO = 1024 ** 3
const MO = 1024 ** 2

const machine: RawMachine = {
  memoryTotal: 3.8 * GO,
  memoryAvailable: 1.9 * GO,
  diskTotal: 38 * GO,
  diskFree: 21 * GO,
  load1: 0.42,
  load5: 0.35,
  load15: 0.3,
  cores: 2,
}

describe("used share", () => {
  test("the share is computed from what is left", () => {
    expect(usedShare(2, 10)).toBe(80)
    expect(usedShare(10, 10)).toBe(0)
    expect(usedShare(0, 10)).toBe(100)
  })

  test("an unknown or zero total returns nothing rather than a division", () => {
    expect(usedShare(null, 10)).toBeNull()
    expect(usedShare(2, null)).toBeNull()
    expect(usedShare(2, 0)).toBeNull()
  })

  /** An inconsistent reading must not return a bar that is negative or beyond one hundred. */
  test("the share stays between zero and one hundred", () => {
    expect(usedShare(20, 10)).toBe(0)
    expect(usedShare(-5, 10)).toBe(100)
  })
})

describe("load share", () => {
  test("a load is read against the number of cores", () => {
    expect(loadShare(2, 4)).toBe(50)
    expect(loadShare(4, 4)).toBe(100)
  })

  /** A machine can be loaded beyond its cores: the figure is not capped. */
  test("beyond the cores, the share goes past one hundred", () => {
    expect(loadShare(6, 4)).toBe(150)
  })

  test("with no known cores, there is nothing to compare against", () => {
    expect(loadShare(2, null)).toBeNull()
    expect(loadShare(null, 4)).toBeNull()
    expect(loadShare(2, 0)).toBeNull()
  })
})

describe("gauge colour", () => {
  test("below the first threshold, the bar stays normal", () => {
    expect(level(0)).toBe("normal")
    expect(level(WARNING_THRESHOLD - 1)).toBe("normal")
  })

  test("at the first threshold it warns, at the second it is critical", () => {
    expect(level(WARNING_THRESHOLD)).toBe("warn")
    expect(level(CRITICAL_THRESHOLD - 1)).toBe("warn")
    expect(level(CRITICAL_THRESHOLD)).toBe("critical")
    expect(level(150)).toBe("critical")
  })

  test("a missing measurement stays neutral", () => {
    expect(level(null)).toBe("normal")
  })
})

describe("a service's memory", () => {
  test("below the bounds, the bar stays neutral", () => {
    expect(serviceLevel(61 * MO, 88 * MO, 256 * MO)).toBe("normal")
  })

  /** The same bound as the server's discrepancy: the bar and the list say the same thing. */
  test("a peak at 80 % of the ceiling turns amber", () => {
    expect(serviceLevel(100 * MO, 204.8 * MO, 256 * MO)).toBe("warn")
    expect(serviceLevel(100 * MO, 204 * MO, 256 * MO)).toBe("normal")
  })

  test("memory beyond 90 % of the ceiling turns red, peak or no peak", () => {
    expect(serviceLevel(240 * MO, 240 * MO, 256 * MO)).toBe("critical")
    expect(serviceLevel(240 * MO, null, 256 * MO)).toBe("critical")
  })

  test("with no ceiling, there is nothing to compare", () => {
    expect(serviceLevel(4 * GO, 4 * GO, null)).toBe("normal")
    expect(serviceLevel(4 * GO, 4 * GO, 0)).toBe("normal")
  })
})

describe("the machine's tiles", () => {
  test("memory and disk are read as a used share", () => {
    expect(memoryTile(machine)).toEqual({
      heading: "Memory",
      percent: 50,
      value: "50%",
      detail: "1.9 of 3.8 GB used",
      level: "normal",
    })
    expect(diskTile(machine)).toMatchObject({ value: "45%", detail: "17 of 38 GB used" })
  })

  test("the load is read against the cores, and a single core is stated in the singular", () => {
    expect(loadTile(machine)).toMatchObject({ value: "21%", detail: "0.42 on 2 cores", level: "normal" })
    expect(loadTile({ ...machine, load1: 0.95, cores: 1 })).toMatchObject({
      value: "95%",
      detail: "0.95 on 1 core",
      level: "critical",
    })
  })

  test("a machine with no reading returns a hyphen, not a zero", () => {
    expect(memoryTile(null)).toMatchObject({ percent: null, value: "-", detail: "Not collected" })
    expect(loadTile({ ...machine, cores: null })).toMatchObject({ percent: null, value: "-" })
  })
})
