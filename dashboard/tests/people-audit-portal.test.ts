import { describe, expect, test } from "bun:test";
import { portalReading, type PortalAdmin } from "../src/people/portal";

/**
 * What the steward, root, reads of the portal's answer to `GET /admin/access`.
 * The portal runs as site-portal, and the threat model assumes it can be
 * broken into: whatever it sends back, the steward must read no more of it
 * than such an answer ever weighs, or a portal answering a body of hundreds
 * of megabytes gets the steward killed under its MemoryMax at the next
 * Access page anyone opens, every unlock on the machine with it.
 */

const MIB = 1024 * 1024;

/** A portal whose answer streams `total` bytes of JSON-looking padding, counting what was pulled. */
function flooding(total: number): { portal: PortalAdmin; pulled: () => number } {
  let sent = 0;
  const chunk = new TextEncoder().encode(" ".repeat(MIB));
  const portal: PortalAdmin = {
    access: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent === 0) {
              const head = new TextEncoder().encode('{"reading":"steward","writtenAt":1,"padding":"');
              sent += head.byteLength;
              controller.enqueue(head);
              return;
            }
            if (sent >= total) {
              controller.enqueue(new TextEncoder().encode('"}'));
              controller.close();
              return;
            }
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  };
  return { portal, pulled: () => sent };
}

describe("the portal's answer, as root reads it", () => {
  test("a well-formed answer is read as before", async () => {
    const portal: PortalAdmin = { access: async () => Response.json({ reading: "steward", writtenAt: 42 }) };
    expect(await portalReading(portal)).toEqual({ reading: "steward", writtenAt: 42 });
  });

  test("an answer far larger than any the portal writes is cut short, never read whole, and says nothing", async () => {
    const { portal, pulled } = flooding(64 * MIB);
    expect(await portalReading(portal)).toEqual({ reading: "unknown", writtenAt: null });
    // A few kilobytes is what the portal ever answers; a chunk or two past
    // the bound, the stream's own read-ahead, is what reading in pieces
    // costs, never the sixty-four megabytes on offer.
    expect(pulled()).toBeLessThan(4 * MIB);
  });
});
