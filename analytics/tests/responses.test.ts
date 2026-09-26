import { describe, expect, test } from "bun:test";
import { acknowledge, HEADERS, plainText } from "../src/responses";

describe("the common headers", () => {
  test("are those the Caddyfile sets on the whole host", () => {
    // `src/responses.ts` copies them so that the local server behaves like
    // production, and tests/manifest.test.ts compares the two lists.
    const response = plainText("x", 404);
    for (const [name, value] of Object.entries(HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });
});

describe("ingestion's acknowledgement", () => {
  test("returns nothing, and says nothing of the origin", async () => {
    // The browser never reads this response: `sendBeacon` does not hand it back
    // to the script. An origin header would let any page read what this service
    // answers, without serving anyone.
    const response = acknowledge();
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("access-control-allow-origin")).toBe(null);
  });
});
