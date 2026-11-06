import { describe, expect, test } from "bun:test";
import { judgeProbe } from "../src/checks";

describe("a site its owner turned off", () => {
  test("its 503 is no failure, another 503 still is", () => {
    expect(judgeProbe("blog.test-zone.invalid", "blog", { status: 503, off: true }).verdict).toBe("ok");
    expect(judgeProbe("blog.test-zone.invalid", "blog", { status: 503 }).verdict).toBe("fail");
  });
});
