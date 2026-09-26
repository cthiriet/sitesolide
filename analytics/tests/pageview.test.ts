import { describe, expect, test } from "bun:test";
import { isValidHost, readDuration, readView, normalizePath } from "../src/pageview";
import { PATH_MAX } from "../src/schema";

/**
 * The body of a signal is written by a web page, so by anyone: it is the only
 * place in the service where a datum enters without having been checked, and
 * every test here holds a refusal.
 */
const VIEW = {
  h: "vineyard.test-zone.invalid",
  p: "/pricing",
  r: "https://www.google.com/",
  s: null,
  c: null,
  w: 390,
  j: "abc123",
};

describe("readView", () => {
  test("accepts an ordinary signal", () => {
    const parsed = readView(VIEW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.host).toBe("vineyard.test-zone.invalid");
    expect(parsed.value.path).toBe("/pricing");
    expect(parsed.value.width).toBe(390);
  });

  test("refuses what is not an object", () => {
    for (const body of [null, "plainText", 42, [], undefined]) {
      expect(readView(body).ok).toBe(false);
    }
  });

  test("refuses a host that is not one", () => {
    for (const h of ["", "not a host", "../etc", "a".repeat(300), "<script>", 42]) {
      expect(readView({ ...VIEW, h }).ok).toBe(false);
    }
  });

  test("accepts a host in upper case, and files it in lower case", () => {
    const parsed = readView({ ...VIEW, h: "Vineyard.Test-Zone.INVALID" });
    expect(parsed.ok && parsed.value.host).toBe("vineyard.test-zone.invalid");
  });

  test("strips the port, which a site served locally declares", () => {
    const parsed = readView({ ...VIEW, h: "localhost:3000" });
    expect(parsed.ok && parsed.value.host).toBe("localhost");
  });

  test("refuses a path that does not start with a slash", () => {
    for (const p of ["pricing", "https://elsewhere.test/x", "", 7]) {
      expect(readView({ ...VIEW, p }).ok).toBe(false);
    }
  });

  test("refuses a path that carries a control byte", () => {
    // JSON carries them perfectly in escaped form, and a row of the dashboard
    // that contained some would cut off its own display.
    expect(readView({ ...VIEW, p: "/pricing\nX-Injected: 1" }).ok).toBe(false);
    expect(readView({ ...VIEW, p: `/pricing${String.fromCharCode(0)}` }).ok).toBe(false);
  });

  test("refuses a token that does not have the expected form", () => {
    for (const j of ["", "a".repeat(64), "token with space", "j/../x", 1]) {
      expect(readView({ ...VIEW, j }).ok).toBe(false);
    }
  });

  test("tolerates a missing or absurd width, the view having taken place", () => {
    // The agent will take over to classify the device: it is not a ground for
    // refusal.
    for (const w of [undefined, null, 0, -5, "large", Number.NaN]) {
      const parsed = readView({ ...VIEW, w });
      expect(parsed.ok).toBe(true);
      expect(parsed.ok && parsed.value.width).toBe(null);
    }
  });

  test("tolerates a missing referrer", () => {
    const parsed = readView({ ...VIEW, r: undefined });
    expect(parsed.ok && parsed.value.referrer).toBe("");
  });
});

describe("normalizePath", () => {
  test("leaves the root intact", () => {
    expect(normalizePath("/")).toBe("/");
  });

  test("strips the trailing slash, which designates the same page", () => {
    expect(normalizePath("/pricing/")).toBe("/pricing");
    expect(normalizePath("/a/b//")).toBe("/a/b");
  });

  test("keeps the case, which counts on a file server", () => {
    expect(normalizePath("/Pricing")).toBe("/Pricing");
  });

  test("bounds the length to what the column accepts", () => {
    expect(normalizePath(`/${"a".repeat(PATH_MAX * 2)}`)).toHaveLength(PATH_MAX);
  });
});

describe("isValidHost", () => {
  test("accepts the forms a deployed site can take", () => {
    for (const host of ["vineyard.test-zone.invalid", "vineyard-modern.test", "localhost", "a.b.c.d.test"]) {
      expect(isValidHost(host)).toBe(true);
    }
  });

  test("refuses what is not a domain name", () => {
    for (const host of ["", "-vineyard.test", "vineyard-.test", "vineyard..test", "VINEYARD.test", "a".repeat(254)]) {
      expect(isValidHost(host)).toBe(false);
    }
  });
});

describe("readDuration", () => {
  test("accepts an ordinary departure", () => {
    const parsed = readDuration({ j: "abc123", d: 42.6 });
    expect(parsed.ok && parsed.value).toEqual({ token: "abc123", seconds: 43 });
  });

  test("refuses a duration that is not a finite and positive number", () => {
    for (const d of [-1, "42", null, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(readDuration({ j: "abc123", d }).ok).toBe(false);
    }
  });

  test("refuses a malformed token", () => {
    expect(readDuration({ j: "", d: 10 }).ok).toBe(false);
    expect(readDuration({ d: 10 }).ok).toBe(false);
  });
});
