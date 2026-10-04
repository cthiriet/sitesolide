import { describe, expect, test } from "bun:test";
import { identify, parseProcNet } from "../src/proc-net";

/**
 * The kernel's answer, from a real Linux kernel: a container on the
 * workstation, nothing tried on the machine. Two accounts, the proxy's and a
 * project's, a listener as the first and a client as the second, then the
 * socket tables and the account database read as the proxy reads them.
 *
 * Opt-in, like the loopback rule's container test, because Docker is needed:
 *
 *   EGRESS_KERNEL_TEST=1 bun test tests/proc-kernel.test.ts
 *
 * Any image with busybox will do; EGRESS_KERNEL_IMAGE names another one than
 * alpine, for a workstation that already has it.
 */
const DOCKER = Bun.which("docker");
const IMAGE = process.env.EGRESS_KERNEL_IMAGE ?? "alpine:3.20";

const SCRIPT = `
set -e
adduser -D -u 998 sitesolide-egress
adduser -D -u 1031 site-shop
adduser -D -u 1032 site-blog
su -s /bin/sh sitesolide-egress -c "sleep 8 | nc -l -p 3128 -s 127.0.0.1 > /dev/null" &
su -s /bin/sh sitesolide-egress -c "sleep 8 | nc -l -p 3129 -s 127.0.0.1 > /dev/null" &
sleep 1
su -s /bin/sh site-shop -c "sleep 4 | nc -p 41234 127.0.0.1 3128" &
su -s /bin/sh site-blog -c "sleep 4 | nc -p 41300 127.0.0.1 3129" &
sleep 2
echo "--- tcp"
cat /proc/net/tcp
echo "--- tcp6"
cat /proc/net/tcp6 2>/dev/null || true
echo "--- passwd"
cat /etc/passwd
echo "--- end"
`;

function section(output: string, name: string): string {
  return output.split(`--- ${name}\n`)[1]?.split("\n--- ")[0] ?? "";
}

describe.skipIf(process.env.EGRESS_KERNEL_TEST !== "1" || DOCKER === null)("in a Linux kernel", () => {
  test("the uid of the caller's socket names its account, and nothing else does", () => {
    const run = Bun.spawnSync([DOCKER!, "run", "--rm", IMAGE, "sh", "-c", SCRIPT]);
    const output = run.stdout.toString();
    expect({ code: run.exitCode, error: run.stderr.toString() }).toEqual({ code: 0, error: "" });
    const tcp = section(output, "tcp");
    const tcp6 = section(output, "tcp6");
    const passwd = section(output, "passwd");
    const readings = { passwd: () => passwd, procNet: () => [tcp, tcp6] };

    // Docker Desktop and the machine both run little-endian kernels.
    expect(parseProcNet(tcp).length).toBeGreaterThan(3);
    expect(identify(readings, { remoteAddress: "127.0.0.1", remotePort: 41234, localAddress: "127.0.0.1", localPort: 3128 })).toEqual({
      kind: "project",
      slug: "shop",
      account: "site-shop",
    });
    expect(identify(readings, { remoteAddress: "127.0.0.1", remotePort: 41300, localAddress: "127.0.0.1", localPort: 3129 })).toEqual({
      kind: "project",
      slug: "blog",
      account: "site-blog",
    });
    // The proxy's own end of the same connection carries the proxy's uid, and
    // a port nobody holds names nobody.
    expect(identify(readings, { remoteAddress: "127.0.0.1", remotePort: 3128, localAddress: "127.0.0.1", localPort: 41234 })).toEqual({
      kind: "account",
      account: "sitesolide-egress",
    });
    expect(identify(readings, { remoteAddress: "127.0.0.1", remotePort: 41234, localAddress: "127.0.0.1", localPort: 3129 }).kind).toBe("unknown");
  }, 120_000);
});
