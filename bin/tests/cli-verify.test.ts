import { describe, expect, test } from "bun:test";
import { askAddress, VERIFY_RETRY_MS, WARM_UP_MS, type Answer } from "../cli/verify";

/**
 * The verification's attempts at a site's address, with a clock that does not
 * wait and an address that answers from a script: what is asked again, for
 * how long, what is said, and what is handed over at once.
 */

function fakeClock() {
  let now = 0;
  return { now: () => now, sleep: async (milliseconds: number) => void (now += milliseconds) };
}

/** Answers each attempt from the script, its last entry for every attempt after; an Error is thrown. */
function scripted(...script: (number | Error)[]) {
  const attempts: number[] = [];
  const clock = fakeClock();
  const ask = async (): Promise<Answer> => {
    attempts.push(clock.now());
    const next = script[Math.min(attempts.length, script.length) - 1]!;
    if (next instanceof Error) throw next;
    return { status: next, door: null };
  };
  const said: string[] = [];
  return { ask, clock, attempts, said, say: (line: string) => void said.push(line) };
}

const REFUSED = new Error("Unable to connect. Is the computer able to access the url?");

describe("askAddress, while the app behind Caddy is still starting", () => {
  for (const status of [502, 503, 504]) {
    test(`a ${status} is asked again, said once, and the answer that follows is handed over`, async () => {
      const site = scripted(status, status, 200);
      const asked = await askAddress(site.ask, 0, site.clock, site.say);
      expect(asked).toEqual({ status: 200, door: null, warmedUp: false });
      expect(site.attempts).toEqual([0, VERIFY_RETRY_MS, 2 * VERIFY_RETRY_MS]);
      expect(site.said).toEqual([`   ${status}: the app does not answer Caddy yet, as one still starting does; asking again for up to ${WARM_UP_MS / 1000} s`]);
    });
  }

  test("a 502 that lasts is handed over within the bound, marked as such", async () => {
    const site = scripted(502);
    const asked = await askAddress(site.ask, 0, site.clock, site.say);
    expect(asked).toEqual({ status: 502, door: null, warmedUp: true });
    expect(site.attempts.length).toBeGreaterThan(2);
    expect(site.attempts.at(-1)!).toBeLessThan(WARM_UP_MS);
    expect(site.said).toHaveLength(1);
  });

  test("a 502 that turns into a 404 hands the 404 over, judged as any other", async () => {
    const site = scripted(502, 404);
    expect(await askAddress(site.ask, 0, site.clock, site.say)).toEqual({ status: 404, door: null, warmedUp: false });
  });
});

describe("askAddress judges any other answer at once", () => {
  for (const status of [200, 401, 404, 500]) {
    test(`a ${status}: one attempt, nothing said`, async () => {
      const site = scripted(status);
      expect(await askAddress(site.ask, 0, site.clock, site.say)).toEqual({ status, door: null, warmedUp: false });
      expect(site.attempts).toEqual([0]);
      expect(site.said).toEqual([]);
    });
  }

  test("the portal's header is handed over with the status", async () => {
    const clock = fakeClock();
    const asked = await askAddress(async () => ({ status: 401, door: "connexion" }), 0, clock, () => {});
    expect(asked).toEqual({ status: 401, door: "connexion", warmedUp: false });
  });
});

describe("askAddress, when the address does not answer at all", () => {
  test("without patience, the failure is handed over at once", async () => {
    const site = scripted(REFUSED);
    expect(await askAddress(site.ask, 0, site.clock, site.say)).toEqual({ error: REFUSED });
    expect(site.attempts).toEqual([0]);
    expect(site.said).toEqual([]);
  });

  test("with patience, asked again until it runs out, said once", async () => {
    const site = scripted(REFUSED);
    expect(await askAddress(site.ask, 90_000, site.clock, site.say)).toEqual({ error: REFUSED });
    expect(site.attempts.at(-1)!).toBeLessThan(90_000);
    expect(site.said).toEqual(["   no answer yet: the zone is certified on demand, and the site's first certificate is obtained by this handshake; asking again for up to 90 s"]);
  });

  test("a first certificate, then an app still starting: each wait said once, the bound of the second counted from its first answer", async () => {
    const site = scripted(REFUSED, REFUSED, 502, 502, 200);
    expect(await askAddress(site.ask, 90_000, site.clock, site.say)).toEqual({ status: 200, door: null, warmedUp: false });
    expect(site.said).toHaveLength(2);
    expect(site.said[0]).toStartWith("   no answer yet:");
    expect(site.said[1]).toStartWith("   502: the app does not answer Caddy yet");
  });
});
