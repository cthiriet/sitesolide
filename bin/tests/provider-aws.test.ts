import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AWS,
  CURATED_TYPES,
  DEFAULT_TYPE,
  discoverAws,
  failureFrom,
  FIREWALL_RULES,
  missingRules,
  short,
  WAITS,
} from "../cli/providers/aws";
import { amzDate, canonicalQuery, signRequest, uriEncode } from "../cli/providers/aws-sigv4";
import { items, parseXml, tagsOf, textAt, XmlError } from "../cli/providers/aws-xml";
import { ProviderError, type Clock, type CreateRequest, type Fetch, type Provider, type PublicKey, type Workstation } from "../cli/providers/provider";
import { createFake, createFakeAws, FAKE_ACCESS_KEY, FAKE_SECRET_KEY, type FakeAws, type Received } from "./fake-aws";

/**
 * The AWS provider, through AWS.open(), against a local fake of the EC2
 * Query API (fake-aws.ts) that checks every signature with its own copy of
 * the secret: the real API is never called. The clock does not wait.
 *
 * Whatever the path, no credential may appear in what the provider reports or
 * throws: every line and every refusal of this file is added to `printed`,
 * read by the last test.
 */

/** Generated for these tests with ssh-keygen; the private half was deleted at once. */
const BLOB = "AAAAC3NzaC1lZDI1NTE5AAAAICezpiOyiQWMYqOeL4S4OgE0T7Fq2bLHWUJ1afO4cczN";
const KEY: PublicKey = { algorithm: "ssh-ed25519", blob: BLOB, comment: "ada@workstation.test-zone.invalid", fingerprint: "a4:46:30:d5:fd:7e:1a:77:e5:ad:8d:21:4f:9a:3e:9e" };
const SESSION_TOKEN = "FwoGZXIvYXdzEFAKEsessionTOKEN0123456789abcdefghijklmnopqrstuvwxyz/+==";

const printed: string[] = [];
let fake: FakeAws;

beforeAll(() => {
  fake = createFakeAws();
});

afterAll(() => {
  fake.stop();
});

beforeEach(() => {
  fake.reset();
});

function request(overrides: Partial<CreateRequest> = {}): CreateRequest {
  return { name: "web", type: DEFAULT_TYPE, location: "eu-central-1", image: "debian-13", backups: false, key: KEY, ...overrides };
}

type Opened = { provider: Provider; lines: string[]; slept: number[]; clock: Clock; report: (line: string) => void };

function open(options: { environment?: Record<string, string>; credentials?: Record<string, string>; fetcher?: Fetch } = {}): Opened {
  let now = Date.parse("2026-10-21T10:00:00Z");
  const slept: number[] = [];
  const clock: Clock = {
    now: () => now,
    sleep: async (milliseconds) => {
      slept.push(milliseconds);
      now += milliseconds;
    },
  };
  const environment = { ...fake.environment, ...options.environment };
  const credentials = options.credentials ?? { AWS_ACCESS_KEY_ID: FAKE_ACCESS_KEY, AWS_SECRET_ACCESS_KEY: FAKE_SECRET_KEY };
  const lines: string[] = [];
  const provider = AWS.open({ credentials, environment, fetcher: options.fetcher ?? ((input, init) => fetch(input, init)), clock, secret: () => {} });
  const report = (line: string) => {
    lines.push(line);
    printed.push(line);
  };
  return { provider, lines, slept, clock, report };
}

/** The refusal a promise ends with, its message and details added to what was printed. */
async function refusal(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    printed.push(error.message, ...(error.failure.details ?? []));
    return error;
  }
  throw new Error("expected a refusal");
}

const actions = (received: Received[]) => received.map((entry) => entry.action);
const writes = () => actions(fake.writes());
const READS = ["DescribeRegions", "DescribeInstances", "DescribeInstanceTypes", "DescribeInstanceTypeOfferings", "DescribeImages", "DescribeVpcs", "DescribeSubnets", "DescribeKeyPairs", "DescribeSecurityGroups", "DescribeAddresses"];

// --- the signature --------------------------------------------------------------------------

describe("signature version 4", () => {
  // From AWS's SigV4 test suite, as botocore carries it (tests/unit/auth/aws4_testsuite).
  const suite = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
  const when = Date.UTC(2015, 7, 30, 12, 36, 0);

  test("post-x-www-form-urlencoded", () => {
    const signed = signRequest({ method: "POST", url: "https://example.amazonaws.com/", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "Param1=value1", region: "us-east-1", service: "service", credentials: suite, now: when });
    expect(signed.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a",
    );
    expect(signed["X-Amz-Date"]).toBe("20150830T123600Z");
  });

  test("get-vanilla-query-order-key-case", () => {
    const signed = signRequest({ method: "GET", url: "https://example.amazonaws.com/?Param2=value2&Param1=value1", headers: {}, body: "", region: "us-east-1", service: "service", credentials: suite, now: when });
    expect(signed.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    );
  });

  test("post-sts-header-before: the session token is sent and signed", () => {
    const token =
      "AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==";
    const signed = signRequest({ method: "POST", url: "https://example.amazonaws.com/", headers: {}, body: "", region: "us-east-1", service: "service", credentials: { ...suite, sessionToken: token }, now: when });
    expect(signed["X-Amz-Security-Token"]).toBe(token);
    expect(signed.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead",
    );
  });

  test("UriEncode: unreserved characters kept, everything else in uppercase hex, a space as %20", () => {
    expect(uriEncode("A-Z_a.z~09")).toBe("A-Z_a.z~09");
    expect(uriEncode("a b+c/d")).toBe("a%20b%2Bc%2Fd");
    expect(uriEncode("!'()*")).toBe("%21%27%28%29%2A");
    expect(uriEncode(String.fromCodePoint(0xe9))).toBe("%C3%A9");
    expect(uriEncode("a/b", true)).toBe("a/b");
    expect(canonicalQuery("?b=2&a=2&a=1")).toBe("a=1&a=2&b=2");
    expect(amzDate(Date.UTC(2026, 9, 21, 9, 5, 7, 123))).toBe("20261021T090507Z");
  });
});

// --- the XML reader -------------------------------------------------------------------------

describe("XML reader", () => {
  test("reads the documented answer, indented, its namespace and padded text", () => {
    const root = parseXml(`<DescribeKeyPairsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
    <requestId>59dbff89-35bd-4eac-99ed-be587EXAMPLE</requestId>
    <keySet>
      <item>
         <keyName>my-key-pair</keyName>
         <keyFingerprint>
            1f:51:ae:28:bf:89:e9:d8:1f:25:5d:37:2d:7d:b8:ca:9f:f5:f1:6f
         </keyFingerprint>
      </item>
   </keySet>
</DescribeKeyPairsResponse>`);
    expect(root.name).toBe("DescribeKeyPairsResponse");
    const pairs = items(root, "keySet");
    expect(pairs).toHaveLength(1);
    expect(textAt(pairs[0], "keyName")).toBe("my-key-pair");
    expect(textAt(pairs[0], "keyFingerprint")).toBe("1f:51:ae:28:bf:89:e9:d8:1f:25:5d:37:2d:7d:b8:ca:9f:f5:f1:6f");
    expect(textAt(root, "nextToken")).toBeNull();
  });

  test("reads the error document, entities, CDATA, comments and empty elements", () => {
    const root = parseXml(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Response><Errors><Error><Code>InvalidInstanceID.NotFound</Code><Message>The instance ID &apos;i-1a2b3c4d&apos; &lt;does&gt; not exist &amp; &#65;&#x42;</Message></Error></Errors><!-- a comment --><RequestID><![CDATA[ea966190<x>]]></RequestID><groupSet/></Response>`,
    );
    expect(textAt(root, "Errors", "Error", "Code")).toBe("InvalidInstanceID.NotFound");
    expect(textAt(root, "Errors", "Error", "Message")).toBe("The instance ID 'i-1a2b3c4d' <does> not exist & AB");
    expect(textAt(root, "RequestID")).toBe("ea966190<x>");
    expect(items(root, "groupSet")).toEqual([]);
    expect(tagsOf(parseXml("<item><tagSet><item><key>Name</key><value>web</value></item><item><key>empty</key><value/></item></tagSet></item>"))).toEqual({ Name: "web", empty: "" });
  });

  test("refuses a document type, an unknown entity, crossed tags, two roots and an unclosed element", () => {
    for (const source of [
      `<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>`,
      "<a>&nbsp;</a>",
      "<a><b></a></b>",
      "<a/><b/>",
      "<a><b>",
      "",
      "not xml at all",
    ]) {
      expect(() => parseXml(source)).toThrow(XmlError);
    }
  });
});

// --- create ---------------------------------------------------------------------------------

describe("create", () => {
  test("on an empty account: everything read first, then the key pair, the security group, the address, the instance, the association", async () => {
    const { provider, lines, report } = open();
    const outcome = await provider.create(request(), report);

    expect(outcome.created).toBe(true);
    expect(writes()).toEqual(["ImportKeyPair", "CreateSecurityGroup", "AuthorizeSecurityGroupIngress", "AllocateAddress", "RunInstances", "AssociateAddress"]);
    const firstWrite = fake.requests.findIndex((entry) => !entry.action.startsWith("Describe"));
    for (const read of READS) expect(actions(fake.requests.slice(0, firstWrite))).toContain(read);
    expect(new Set(fake.requests.map((entry) => entry.region))).toEqual(new Set(["eu-central-1", "eu-west-3", "us-east-1"]));

    const region = fake.region("eu-central-1");
    const tags = { Name: "web", "managed-by": "sitesolide", "sitesolide-machine": "web" };
    expect(region.keyPairs).toHaveLength(1);
    expect(region.keyPairs[0]!).toMatchObject({ name: "sitesolide-web", tags });
    // The comment, which may name a person or a host, stays on the workstation.
    const imported = fake.requests.find((entry) => entry.action === "ImportKeyPair")!;
    expect(atob(imported.body.PublicKeyMaterial!)).toBe(`ssh-ed25519 ${BLOB}`);

    const group = region.groups.find((candidate) => candidate.name === "sitesolide-web")!;
    expect(group.tags).toEqual(tags);
    expect(group.rules.map((rule) => `${rule.protocol} ${rule.from} ${rule.to} ${rule.cidr}`).sort()).toEqual(FIREWALL_RULES.map((rule) => `${rule.protocol} ${rule.from} ${rule.to} ${rule.cidr}`).sort());
    expect(group.rules.map((rule) => rule.cidr)).not.toContain("10.0.0.0/8");

    expect(region.addresses).toHaveLength(1);
    const address = region.addresses[0]!;
    expect(address.tags).toEqual(tags);

    expect(region.instances).toHaveLength(1);
    const instance = region.instances[0]!;
    const debian = region.images.find((image) => image.name === "debian-13-amd64-20261017-2634")!;
    expect(instance).toMatchObject({ type: "t3.small", imageId: debian.id, state: "running", keyName: "sitesolide-web", groupIds: [group.id], tags, publicIp: address.publicIp, zone: "eu-central-1a" });
    expect(instance.metadata).toEqual({ HttpTokens: "required", HttpEndpoint: "enabled" });
    expect(address.instanceId).toBe(instance.id);
    const volume = region.volumes.find((candidate) => candidate.id === instance.volumeIds[0])!;
    expect(volume).toMatchObject({ size: 20, type: "gp3", deleteOnTermination: true, encrypted: true, tags, device: "/dev/xvda" });

    const order = fake.requests.find((entry) => entry.action === "RunInstances")!.body;
    expect(order.ClientToken).toMatch(/^sitesolide-[0-9a-f]{48}$/);
    expect(Object.keys(order).some((name) => name.startsWith("UserData"))).toBe(false);
    expect(fake.requests.find((entry) => entry.action === "AssociateAddress")!.body.AllowReassociation).toBe("false");

    expect(outcome.machine).toMatchObject({
      provider: "aws",
      id: instance.id,
      name: "web",
      type: "t3.small",
      location: "eu-central-1",
      status: "running",
      ipv4: address.publicIp,
      ipv6: null,
      monthlyPrice: null,
      backups: false,
      managed: true,
      login: "admin",
    });
    expect(outcome.resources.map((resource) => `${resource.kind} ${resource.reused}`)).toEqual(["key pair false", "security group false", "elastic ip false", "instance false"]);
    expect(lines).toContain("-> key pair");
    expect(lines).toContain(`   sitesolide-web, imported (${KEY.fingerprint})`);
    expect(lines).toContain("   debian-13-amd64-20261017-2634 (" + debian.id + ")");
    expect(lines.filter((line) => line.startsWith("!!"))).toEqual([]);
  });

  test("a second run finds the machine it created and writes nothing", async () => {
    const first = await open().provider.create(request(), () => {});
    fake.requests.length = 0;
    const { provider, lines, report } = open();
    const second = await provider.create(request(), report);
    expect(second.created).toBe(false);
    expect(second.machine.id).toBe(first.machine.id);
    expect(second.machine.ipv4).toBe(first.machine.ipv4);
    expect(writes()).toEqual([]);
    expect(lines).toContain("   already created by sitesolide: t3.small at eu-central-1, running");
  });

  test("a machine found in another region is returned with a warning, never created twice", async () => {
    await open().provider.create(request({ location: "us-east-1" }), () => {});
    fake.requests.length = 0;
    const { provider, lines, report } = open();
    const outcome = await provider.create(request(), report);
    expect(outcome.created).toBe(false);
    expect(outcome.machine.location).toBe("us-east-1");
    expect(lines).toContain("!! it is t3.small at us-east-1: --type and --location only apply to a machine being created");
    expect(writes()).toEqual([]);
  });

  test("a run that stopped before the association finishes it with the address already allocated", async () => {
    await open().provider.create(request(), () => {});
    const region = fake.region("eu-central-1");
    const address = region.addresses[0]!;
    Object.assign(address, { instanceId: null, associationId: null });
    region.instances[0]!.publicIp = "198.51.100.10";
    fake.requests.length = 0;
    const outcome = await open().provider.create(request(), () => {});
    expect(outcome.created).toBe(false);
    expect(writes()).toEqual(["AssociateAddress"]);
    expect(outcome.machine.ipv4).toBe(address.publicIp);
    expect(region.addresses).toHaveLength(1);
  });

  test("an order whose answer was lost is made again with the same token, and AWS returns the same instance", async () => {
    // The instance is created, then the answer never comes; the next run does
    // not see it by its tag yet, as the API's eventual consistency allows.
    fake.settings.instanceInvisible = 1;
    const losing: Fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (String(init?.body ?? "").includes("Action=RunInstances")) throw new TypeError("the connection was reset");
      return response;
    };
    const lost = await refusal(open({ fetcher: losing }).provider.create(request(), () => {}));
    expect(lost.failure.error).toBe("provider-unreachable");
    expect(lost.failure.details?.join("\n")).toContain("whether AWS created the instance is not known");
    // Asked again until its deadline, the same token each time: one instance.
    const sent = writes();
    expect(sent.slice(0, 5)).toEqual(["ImportKeyPair", "CreateSecurityGroup", "AuthorizeSecurityGroupIngress", "AllocateAddress", "RunInstances"]);
    expect(new Set(sent.slice(4))).toEqual(new Set(["RunInstances"]));
    expect(new Set(fake.requests.filter((entry) => entry.action === "RunInstances").map((entry) => entry.body.ClientToken)).size).toBe(1);
    expect(fake.region("eu-central-1").instances).toHaveLength(1);

    fake.requests.length = 0;
    const { provider, lines, report } = open();
    const outcome = await provider.create(request(), report);
    expect(outcome.created).toBe(true);
    expect(writes()).toEqual(["RunInstances", "AssociateAddress"]);
    expect(fake.region("eu-central-1").instances).toHaveLength(1);
    expect(fake.region("eu-central-1").addresses).toHaveLength(1);
    expect(lines).toContain("   sitesolide-web, already in eu-central-1 (a4:46:30:d5:fd:7e:1a:77:e5:ad:8d:21:4f:9a:3e:9e), reused");
    expect(lines).toContain("   already created by sitesolide, reused");
  });

  test("an earlier run's security group without its rules gets the missing ones", async () => {
    const group = fake.addGroup("eu-central-1", { name: "sitesolide-web", tags: { "managed-by": "sitesolide", "sitesolide-machine": "web" }, rules: [{ protocol: "tcp", from: 22, to: 22, cidr: "0.0.0.0/0", description: "ssh" }] });
    await open().provider.create(request(), () => {});
    expect(writes()).toEqual(["ImportKeyPair", "AuthorizeSecurityGroupIngress", "AllocateAddress", "RunInstances", "AssociateAddress"]);
    expect(group.rules).toHaveLength(FIREWALL_RULES.length);
    expect(missingRules(parseXml("<item><ipPermissions/></item>"))).toHaveLength(FIREWALL_RULES.length);
  });

  test("rules a lost answer already added are passed over, the others added one at a time", async () => {
    fake.fail("AuthorizeSecurityGroupIngress", 400, "InvalidPermission.Duplicate", 'the specified rule "peer: 0.0.0.0/0, TCP, from port: 22, to port: 22, ALLOW" already exists');
    await open().provider.create(request(), () => {});
    const group = fake.region("eu-central-1").groups.find((candidate) => candidate.name === "sitesolide-web")!;
    expect(group.rules).toHaveLength(FIREWALL_RULES.length);
    expect(writes().filter((action) => action === "AuthorizeSecurityGroupIngress")).toHaveLength(1 + FIREWALL_RULES.length);
  });

  test("a key already in the region, under any name, is reused", async () => {
    fake.addKeyPair("eu-central-1", { name: "ada-laptop", publicKey: `ssh-ed25519 ${BLOB}` });
    const outcome = await open().provider.create(request(), () => {});
    expect(writes()).not.toContain("ImportKeyPair");
    expect(fake.region("eu-central-1").instances[0]!.keyName).toBe("ada-laptop");
    expect(outcome.resources[0]).toMatchObject({ kind: "key pair", name: "ada-laptop", reused: true });
  });

  test("a key name taken by another key gets a name of its own", async () => {
    fake.addKeyPair("eu-central-1", { name: "sitesolide-web", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    await open().provider.create(request(), () => {});
    expect(fake.region("eu-central-1").keyPairs.map((pair) => pair.name)).toEqual(["sitesolide-web", "sitesolide-web-a44630d5"]);
  });

  test("the API's eventual consistency is waited out: a group or an instance unknown for a moment", async () => {
    fake.settings.groupInvisible = 1;
    fake.settings.instanceInvisible = 2;
    const { provider, slept, report } = open();
    const outcome = await provider.create(request(), report);
    expect(outcome.machine.status).toBe("running");
    expect(actions(fake.requests).filter((action) => action === "AuthorizeSecurityGroupIngress")).toHaveLength(2);
    expect(slept.length).toBeGreaterThan(0);
  });

  test("an order that meets a key pair or a group not known everywhere yet is asked again, with the same token", async () => {
    fake.settings.keyInvisible = 2;
    fake.settings.groupInvisibleAtRun = 1;
    const { provider, lines, report } = open();
    const outcome = await provider.create(request(), report);
    expect(outcome.created).toBe(true);
    const orders = fake.requests.filter((entry) => entry.action === "RunInstances");
    expect(orders).toHaveLength(4);
    expect(new Set(orders.map((entry) => entry.body.ClientToken)).size).toBe(1);
    expect(fake.region("eu-central-1").instances).toHaveLength(1);
    expect(lines).toContain("   AWS answered InvalidKeyPair.NotFound: trying again");
  });

  test("an arm64 type gets Debian's arm64 image", async () => {
    await open().provider.create(request({ type: "t4g.small" }), () => {});
    const region = fake.region("eu-central-1");
    expect(region.images.find((image) => image.id === region.instances[0]!.imageId)!.name).toBe("debian-13-arm64-20261017-2634");
  });

  test("a type sold in some zones only lands in a zone that sells it", async () => {
    await open().provider.create(request({ type: "m7a.large" }), () => {});
    expect(fake.region("eu-central-1").instances[0]!.zone).toBe("eu-central-1b");
  });
});

// --- refusals before anything is written -----------------------------------------------------

describe("create refuses before writing anything", () => {
  const cases: [string, () => void, Partial<CreateRequest>, string][] = [
    ["an instance of that name sitesolide did not create, in any region", () => void fake.addInstance("us-east-1", { tags: { Name: "web" } }), {}, "machine-exists"],
    ["a security group of that name sitesolide did not create", () => void fake.addGroup("eu-central-1", { name: "sitesolide-web" }), {}, "firewall-taken"],
    ["a type AWS does not have", () => {}, { type: "t9.huge" }, "invalid-server-type"],
    ["a type the region does not sell", () => {}, { location: "eu-west-3" }, "invalid-server-type"],
    ["a type of an architecture Debian does not publish", () => {}, { type: "mac2.metal" }, "invalid-server-type"],
    ["a region the account has not enabled", () => {}, { location: "ap-southeast-7" }, "invalid-location"],
    ["a region AWS does not have", () => {}, { location: "eu-nowhere-9" }, "invalid-location"],
    ["a region written wrong", () => {}, { location: "Frankfurt" }, "invalid-location"],
    ["no default VPC", () => void (fake.region("eu-central-1").vpcs.length = 0), {}, "no-default-vpc"],
    ["no default subnet", () => void (fake.region("eu-central-1").subnets.length = 0), {}, "no-default-vpc"],
    ["no default subnet in a zone that sells the type", () => void fake.region("eu-central-1").subnets.splice(2, 1), { type: "c7i.large" }, "type-unavailable"],
    ["no Debian image for the architecture", () => void fake.region("eu-central-1").images.splice(2, 1), { type: "t4g.small" }, "invalid-image"],
    ["an image that is neither debian-13 nor an AMI", () => {}, { image: "ubuntu-24.04" }, "invalid-image"],
    ["an AMI the region does not have", () => {}, { image: "ami-0123456789abcdef0" }, "invalid-image"],
    ["a key AWS does not import", () => {}, { key: { ...KEY, algorithm: "ecdsa-sha2-nistp256" } }, "no-ssh-key"],
    ["a security key AWS does not import", () => {}, { key: { ...KEY, algorithm: "sk-ssh-ed25519@openssh.com" } }, "no-ssh-key"],
  ];
  for (const [name, arrange, overrides, code] of cases) {
    test(name, async () => {
      arrange();
      const { provider, report } = open();
      const refused = await refusal(provider.create(request(overrides), report));
      expect(refused.failure.error).toBe(code);
      expect(writes()).toEqual([]);
    });
  }

  test("a refused type lists the types sold there instead", async () => {
    const refused = await refusal(open().provider.create(request({ location: "eu-west-3" }), () => {}));
    expect(refused.message).toBe("t3.small is not an instance type AWS sells at eu-west-3");
    expect(refused.failure.details?.[0]).toBe("types sold at eu-west-3, roughly cheapest first:");
    expect(refused.failure.details?.[1]).toStartWith("t4g.small");
    expect(refused.failure.details?.join("\n")).not.toContain("t3a.");
  });

  test("the instance sitesolide did not create is described, and never touched", async () => {
    const other = fake.addInstance("us-east-1", { tags: { Name: "web", team: "data" } });
    const refused = await refusal(open().provider.create(request(), () => {}));
    expect(refused.failure.details?.[0]).toBe(`${other.id}, t3.small at us-east-1, running, ${other.publicIp}`);
    expect(other.tags).toEqual({ Name: "web", team: "data" });
  });

  test("two machines of one name, in two regions, are refused as ambiguous", async () => {
    const tags = { Name: "web", "managed-by": "sitesolide", "sitesolide-machine": "web" };
    fake.addInstance("eu-central-1", { tags });
    fake.addInstance("us-east-1", { tags });
    expect((await refusal(open().provider.create(request(), () => {}))).failure.error).toBe("machine-ambiguous");
    expect((await refusal(open().provider.find("web"))).failure.error).toBe("machine-ambiguous");
    expect(writes()).toEqual([]);
  });

  test("a machine sitesolide created that is stopped is left stopped", async () => {
    fake.addInstance("eu-central-1", { state: "stopped", tags: { Name: "web", "managed-by": "sitesolide", "sitesolide-machine": "web" } });
    expect((await refusal(open().provider.create(request(), () => {}))).failure.error).toBe("machine-off");
    expect(writes()).toEqual([]);
  });
});

// --- values never said back unshaped ---------------------------------------------------------

describe("what a person typed is said back only when it has the shape it should", () => {
  const PASTED = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYzzPASTEDSECRET";

  for (const [what, overrides, code] of [
    ["a region", { location: PASTED }, "invalid-location"],
    ["a type", { type: PASTED }, "invalid-server-type"],
    ["an image", { image: PASTED }, "invalid-image"],
  ] as const) {
    test(`${what} that is not one is not repeated, nor sent`, async () => {
      const { provider, lines, report } = open();
      const refused = await refusal(provider.create(request(overrides), report));
      expect(refused.failure.error).toBe(code);
      const said = [refused.message, ...(refused.failure.details ?? []), ...lines].join("\n");
      expect(said).not.toContain(PASTED.slice(0, 12));
      expect(JSON.stringify(fake.requests)).not.toContain(PASTED.slice(0, 12));
      expect(writes()).toEqual([]);
    });
  }

  test("a value of the right shape is named", async () => {
    const refused = await refusal(open().provider.create(request({ image: "debian-12" }), () => {}));
    expect(refused.message).toBe("the image given, debian-12, is not one sitesolide can order at AWS");
  });

  test("a long message of the API is cut between two words, never inside one", () => {
    const token = "AQoDYXdzEJr0123456789TOKENLIKEabcdefghijklmnop";
    const said = `${"word ".repeat(78)}${token} and more after it`;
    const cut = short(said);
    expect(cut.length).toBeLessThanOrEqual(404);
    expect(cut).not.toContain(token.slice(0, 6));
    expect(cut).toEndWith("word ...");
    expect(short("x".repeat(600))).toBe("(a message too long to show)");
    expect(short("short enough")).toBe("short enough");
    const refused = failureFrom(403, "UnauthorizedOperation", said, new Headers(), "do it");
    expect(refused.message).not.toContain(token.slice(0, 6));
  });

  test("the key AWS would refuse is said before anything leaves, by the entry and by create", () => {
    expect(AWS.keyProblem?.(KEY)).toBeNull();
    expect(AWS.keyProblem?.({ ...KEY, algorithm: "ssh-rsa" })).toBeNull();
    expect(AWS.keyProblem?.({ ...KEY, algorithm: "ecdsa-sha2-nistp256" })).toBe("AWS imports ed25519 and RSA keys only, and this one is ecdsa-sha2-nistp256");
    expect(AWS.keyProblem?.({ ...KEY, algorithm: "sk-ssh-ed25519@openssh.com" })).toBe("AWS imports ed25519 and RSA keys only, and this one is sk-ssh-ed25519@openssh.com");
  });
});

// --- a refused order -------------------------------------------------------------------------

describe("an order AWS refuses", () => {
  test("no capacity: what this run created is deleted again, and other types are suggested", async () => {
    fake.fail("RunInstances", 500, "InsufficientInstanceCapacity", "We currently do not have sufficient t3.small capacity in the Availability Zone you requested (eu-central-1a).");
    const { provider, lines, report } = open();
    const refused = await refusal(provider.create(request(), report));
    expect(refused.failure.error).toBe("type-unavailable");
    expect(refused.message).toStartWith("AWS would not create t3.small at eu-central-1a (500 InsufficientInstanceCapacity)");
    expect(writes()).toEqual(["ImportKeyPair", "CreateSecurityGroup", "AuthorizeSecurityGroupIngress", "AllocateAddress", "RunInstances", "ReleaseAddress", "DeleteSecurityGroup", "DeleteKeyPair"]);
    const region = fake.region("eu-central-1");
    expect(region.keyPairs).toEqual([]);
    expect(region.addresses).toEqual([]);
    expect(region.groups.map((group) => group.name)).toEqual(["default"]);
    expect(region.instances).toEqual([]);
    expect(refused.failure.details).toContain("deleted the key pair sitesolide-web this run had created");
    expect(refused.failure.details).toContain("or try another --location");
    expect(lines).toContain("-> undo what this run created");
  });

  test("an account on the Free plan: the default type is taken", async () => {
    fake.settings.freePlan = true;
    const outcome = await open().provider.create(request(), () => {});
    expect(outcome.machine.type).toBe("t3.small");
  });

  test("an account on the Free plan refuses a type that is not eligible: the eligible ones are listed, and the upgrade", async () => {
    fake.settings.freePlan = true;
    const refused = await refusal(open().provider.create(request({ type: "t3a.small" }), () => {}));
    expect(refused.failure.error).toBe("type-unavailable");
    expect(refused.message).toStartWith("the account is on AWS's Free plan, which refuses t3a.small (400 InvalidParameterCombination)");
    const details = refused.failure.details ?? [];
    expect(details[0]).toBe("the types the Free plan takes at eu-central-1:");
    const listed = details.slice(1, details.indexOf("or upgrade the account: Billing console, Upgrade plan")).map((line) => line.split(/\s+/)[0]);
    expect(listed).toEqual(["t3.micro", "t4g.micro", "t3.small", "t4g.small", "c7i-flex.large", "m7i-flex.large"]);
    expect(details).toContain("deleted the key pair sitesolide-web this run had created");
    expect(fake.region("eu-central-1").addresses).toEqual([]);
  });

  test("what an earlier run made is kept", async () => {
    fake.addKeyPair("eu-central-1", { name: "sitesolide-web", publicKey: `ssh-ed25519 ${BLOB}`, tags: { "managed-by": "sitesolide", "sitesolide-machine": "web" } });
    fake.fail("RunInstances", 400, "VcpuLimitExceeded", "You have requested more vCPU capacity than your current vCPU limit of 0 allows.");
    const refused = await refusal(open().provider.create(request(), () => {}));
    expect(refused.failure.error).toBe("provider-limit");
    expect(fake.region("eu-central-1").keyPairs.map((pair) => pair.name)).toEqual(["sitesolide-web"]);
    expect(writes()).not.toContain("DeleteKeyPair");
    expect(refused.failure.details).toContain("deleted the security group sitesolide-web this run had created");
  });

  test("a failure on AWS's side for a moment is waited out, the order asked again", async () => {
    fake.fail("RunInstances", 503, "Unavailable", "The server is overloaded and can't handle the request.");
    const outcome = await open().provider.create(request(), () => {});
    expect(outcome.created).toBe(true);
    expect(writes().filter((action) => action === "RunInstances")).toHaveLength(2);
    expect(fake.region("eu-central-1").instances).toHaveLength(1);
  });

  test("a failure on AWS's side that lasts leaves everything for the next run, which finishes the order", async () => {
    fake.fail("RunInstances", 503, "Unavailable", "The server is overloaded and can't handle the request.", { times: 1000 });
    const refused = await refusal(open().provider.create(request(), () => {}));
    expect(refused.failure.error).toBe("provider-failure");
    expect(writes()).not.toContain("ReleaseAddress");
    expect(refused.failure.details?.join("\n")).toContain("nothing was deleted");
    expect(refused.failure.details?.join("\n")).toContain("`sitesolide machine destroy web --provider aws --delete-key` removes them");
    fake.heal();
    fake.requests.length = 0;
    const outcome = await open().provider.create(request(), () => {});
    expect(outcome.created).toBe(true);
    expect(writes()).toEqual(["RunInstances", "AssociateAddress"]);
  });

  test("a refusal before the order undoes what came before it", async () => {
    fake.fail("AllocateAddress", 400, "AddressLimitExceeded", "The maximum number of addresses has been reached.");
    const refused = await refusal(open().provider.create(request(), () => {}));
    expect(refused.failure.error).toBe("provider-limit");
    expect(writes()).toEqual(["ImportKeyPair", "CreateSecurityGroup", "AuthorizeSecurityGroupIngress", "AllocateAddress", "DeleteSecurityGroup", "DeleteKeyPair"]);
  });
});

// --- list and find ---------------------------------------------------------------------------

describe("list and find", () => {
  const ours = (name: string) => ({ Name: name, "managed-by": "sitesolide", "sitesolide-machine": name });

  test("list shows the machines sitesolide created, in every region, and nothing else", async () => {
    fake.settings.pageSize = 1;
    fake.settings.emptyFirstPage = true;
    fake.addInstance("eu-central-1", { tags: ours("web") });
    fake.addInstance("eu-central-1", { tags: ours("shop") });
    fake.addInstance("eu-central-1", { tags: { Name: "theirs" } });
    fake.addInstance("eu-central-1", { tags: ours("gone"), state: "terminated" });
    fake.addInstance("us-east-1", { tags: ours("api") });
    fake.addInstance("ap-southeast-7", { tags: ours("hidden") });
    const machines = await open().provider.list();
    expect(machines.map((machine) => `${machine.name} ${machine.location}`)).toEqual(["api us-east-1", "shop eu-central-1", "web eu-central-1"]);
    expect(machines.every((machine) => machine.managed && machine.login === "admin")).toBe(true);
    // Every page was read, the empty first one and those after it.
    expect(fake.requests.filter((entry) => entry.action === "DescribeInstances" && entry.region === "eu-central-1")).toHaveLength(3);
  });

  test("a region the credentials may not read is skipped; the home region may not be", async () => {
    fake.addInstance("eu-central-1", { tags: ours("web") });
    fake.region("us-east-1").forbidden = true;
    expect((await open().provider.list()).map((machine) => machine.name)).toEqual(["web"]);
    fake.region("eu-central-1").forbidden = true;
    expect((await refusal(open().provider.list())).failure.error).toBe("provider-forbidden");
  });

  test("find returns the machine of that name, ours or not; a terminated one that left nothing is gone", async () => {
    const { provider } = open();
    expect(await provider.find("web")).toBeNull();
    fake.addInstance("eu-west-3", { tags: { Name: "web" } });
    expect((await provider.find("web"))?.managed).toBe(false);
    fake.addInstance("eu-central-1", { tags: ours("old"), state: "terminated" });
    expect(await provider.find("old")).toBeNull();
    expect(writes()).toEqual([]);
  });

  test("what a run left without an instance is an incomplete machine, in any region; a key pair alone is not listed", async () => {
    const address = fake.addAddress("eu-west-3", { tags: ours("half") });
    fake.addGroup("us-east-1", { name: "sitesolide-half", tags: ours("half") });
    fake.addKeyPair("eu-central-1", { name: "sitesolide-keyonly", publicKey: `ssh-ed25519 ${BLOB}`, tags: ours("keyonly") });
    fake.addInstance("eu-central-1", { tags: ours("web") });
    // Addresses of a live machine are its own, not leftovers.
    fake.addAddress("eu-central-1", { tags: ours("web") });
    const { provider } = open();
    const machines = await provider.list();
    expect(machines.map((machine) => `${machine.name} ${machine.status}`)).toEqual(["half incomplete", "web running"]);
    expect(machines[0]).toMatchObject({ name: "half", location: "eu-west-3", ipv4: address.publicIp, managed: true, login: "admin", type: "no instance" });
    expect(await provider.find("half")).toMatchObject({ status: "incomplete", location: "eu-west-3", managed: true });
    // destroy --delete-key still reaches a key pair kept on its own.
    expect(await provider.find("keyonly")).toMatchObject({ status: "incomplete", location: "eu-central-1", ipv4: null });
    expect(writes()).toEqual([]);
  });
});

// --- destroy ---------------------------------------------------------------------------------

describe("destroy", () => {
  test("terminates the instance, then releases its address and deletes its security group; the key stays", async () => {
    const created = await open().provider.create(request(), () => {});
    fake.requests.length = 0;
    const { provider, lines, report } = open();
    const machine = (await provider.find("web"))!;
    const outcome = await provider.destroy(machine, { deleteKey: false }, report);
    const region = fake.region("eu-central-1");
    expect(outcome.removed).toEqual([`instance web (${created.machine.ipv4})`, `elastic IP ${created.machine.ipv4}`, "security group sitesolide-web"]);
    expect(outcome.kept).toEqual(["key pair sitesolide-web: other machines may be created with it; --delete-key deletes it"]);
    // The group was still held by the terminated instance's interface once.
    expect(writes()).toEqual(["TerminateInstances", "ReleaseAddress", "DeleteSecurityGroup", "DeleteSecurityGroup"]);
    expect(region.instances[0]!.state).toBe("terminated");
    expect(region.volumes).toEqual([]);
    expect(region.addresses).toEqual([]);
    expect(region.groups.map((group) => group.name)).toEqual(["default"]);
    expect(region.keyPairs).toHaveLength(1);
    expect(lines).toContain("   state: terminated");
  });

  test("--delete-key deletes the key pair imported for this machine, and no other", async () => {
    await open().provider.create(request(), () => {});
    const other = fake.addKeyPair("eu-central-1", { name: "sitesolide-api", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", tags: { "managed-by": "sitesolide", "sitesolide-machine": "api" } });
    const { provider, report } = open();
    const outcome = await provider.destroy((await provider.find("web"))!, { deleteKey: true }, report);
    expect(outcome.removed).toContain("key pair sitesolide-web");
    expect(fake.region("eu-central-1").keyPairs).toEqual([other]);
  });

  test("keeps what sitesolide did not create, and a group another instance uses", async () => {
    await open().provider.create(request(), () => {});
    const region = fake.region("eu-central-1");
    const instance = region.instances[0]!;
    // Someone associated an address of theirs, and attached our group elsewhere.
    const ours = region.addresses[0]!;
    Object.assign(ours, { instanceId: null, associationId: null });
    const theirs = fake.addAddress("eu-central-1", { instanceId: instance.id });
    const group = region.groups.find((candidate) => candidate.name === "sitesolide-web")!;
    fake.addInstance("eu-central-1", { tags: { Name: "other" }, groupIds: [group.id] });
    fake.requests.length = 0;
    const { provider, lines, report } = open();
    const outcome = await provider.destroy((await provider.find("web"))!, { deleteKey: false }, report);
    expect(outcome.removed).toContain(`elastic IP ${ours.publicIp}`);
    expect(outcome.kept).toContain(`elastic IP ${theirs.publicIp}: sitesolide did not allocate it; AWS bills it until it is released from the console`);
    expect(outcome.kept.some((line) => line.startsWith("security group sitesolide-web: still used by"))).toBe(true);
    expect(region.addresses).toEqual([theirs]);
    expect(region.groups.some((candidate) => candidate.id === group.id)).toBe(true);
    expect(lines.some((line) => line.startsWith("!! elastic IP"))).toBe(true);
  });

  test("what was created for the machine is found by its tag, even after its Name changed", async () => {
    await open().provider.create(request(), () => {});
    const region = fake.region("eu-central-1");
    region.instances[0]!.tags.Name = "renamed";
    const { provider, report } = open();
    const outcome = await provider.destroy((await provider.find("renamed"))!, { deleteKey: true }, report);
    expect(outcome.removed).toHaveLength(4);
    expect(region.addresses).toEqual([]);
    expect(region.keyPairs).toEqual([]);
    expect(region.groups.map((group) => group.name)).toEqual(["default"]);
  });

  test("an instance sitesolide did not create is refused, and nothing is written", async () => {
    const theirs = fake.addInstance("eu-central-1", { tags: { Name: "web" } });
    const { provider, report } = open();
    const machine = (await provider.find("web"))!;
    expect(machine.managed).toBe(false);
    const refused = await refusal(provider.destroy({ ...machine, managed: true }, { deleteKey: true }, report));
    expect(refused.failure.error).toBe("machine-not-managed");
    expect(writes()).toEqual([]);
    expect(theirs.state).toBe("running");
  });

  test("a destroy interrupted after the termination is finished from what the machine left", async () => {
    await open().provider.create(request(), () => {});
    // Terminated, as AWS does it: its address let go.
    fake.region("eu-central-1").instances[0]!.state = "terminated";
    Object.assign(fake.region("eu-central-1").addresses[0]!, { instanceId: null, associationId: null });
    fake.requests.length = 0;
    const { provider, lines, report } = open();
    const machine = (await provider.find("web"))!;
    expect(machine.status).toBe("incomplete");
    const outcome = await provider.destroy(machine, { deleteKey: false }, report);
    expect(writes()).not.toContain("TerminateInstances");
    expect(outcome.removed.some((line) => line.startsWith("elastic IP"))).toBe(true);
    expect(lines).toContain("-> web has no instance: what was created for it goes");
  });

  test("an incomplete machine is destroyed in every region where it left something; the wizard's next order reuses it first", async () => {
    // Run 1 ends with its outcome unknown; run 2 reuses the address, and its order is refused.
    fake.fail("RunInstances", 503, "Unavailable", "The server is overloaded and can't handle the request.", { times: 1000 });
    await refusal(open().provider.create(request(), () => {}));
    fake.heal();
    fake.fail("RunInstances", 400, "VcpuLimitExceeded", "You have requested more vCPU capacity than your current vCPU limit of 0 allows.");
    const refused = await refusal(open().provider.create(request(), () => {}));
    const region = fake.region("eu-central-1");
    const address = region.addresses[0]!;
    expect(refused.failure.details).toContain("this run had created nothing");
    expect(refused.failure.details).toContain(`left by an earlier run, and kept: key pair sitesolide-web; security group sitesolide-web; elastic IP ${address.publicIp}, billed by the hour while it exists`);
    expect(refused.failure.details).toContain("`sitesolide machine destroy web --provider aws --delete-key` removes them, if you give up on this machine");
    // An address left in another region by an earlier attempt there.
    const elsewhere = fake.addAddress("eu-west-3", { tags: { "managed-by": "sitesolide", "sitesolide-machine": "web" } });

    const { provider, report } = open();
    expect((await provider.list()).map((machine) => `${machine.name} ${machine.status} ${machine.ipv4}`)).toEqual([`web incomplete ${address.publicIp}`]);
    const machine = (await provider.find("web"))!;
    fake.requests.length = 0;
    const outcome = await provider.destroy(machine, { deleteKey: true }, report);
    expect(writes()).not.toContain("TerminateInstances");
    expect(outcome.removed).toEqual([`elastic IP ${address.publicIp}`, `elastic IP ${elsewhere.publicIp} at eu-west-3`, "security group sitesolide-web", "key pair sitesolide-web"]);
    expect(region.addresses).toEqual([]);
    expect(fake.region("eu-west-3").addresses).toEqual([]);
    expect(region.keyPairs).toEqual([]);
    expect(await provider.list()).toEqual([]);
  });

  test("a volume a person attached goes with the instance when it is marked so, and is named; one that stays is kept and said", async () => {
    await open().provider.create(request(), () => {});
    const instance = fake.region("eu-central-1").instances[0]!;
    const data = fake.addVolume("eu-central-1", instance.id, { device: "/dev/sdf", deleteOnTermination: true });
    const kept = fake.addVolume("eu-central-1", instance.id, { device: "/dev/sdg", deleteOnTermination: false });
    const { provider, report } = open();
    const outcome = await provider.destroy((await provider.find("web"))!, { deleteKey: false }, report);
    expect(outcome.removed).toContain(`volume ${data.id} (/dev/sdf), attached to web: deleted with it`);
    expect(outcome.kept).toContain(`volume ${kept.id} (/dev/sdg): AWS kept it after the instance, and bills it until it is deleted from the console`);
    expect(outcome.removed.filter((line) => line.startsWith("volume"))).toHaveLength(1);
  });

  test("a security group held past the wait is kept and said", async () => {
    await open().provider.create(request(), () => {});
    fake.settings.groupHeld = 10_000;
    const { provider, slept, report } = open();
    const outcome = await provider.destroy((await provider.find("web"))!, { deleteKey: false }, report);
    expect(outcome.kept).toContain("security group sitesolide-web: AWS still says it is in use");
    expect(slept.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(WAITS.groupMs + WAITS.terminatedMs + 2 * WAITS.pollMs);
  });
});

// --- waits -----------------------------------------------------------------------------------

describe("waits are bounded", () => {
  test("an instance that never runs ends in machine-timeout, without waiting", async () => {
    fake.settings.runningPolls = Number.POSITIVE_INFINITY;
    const { provider, slept, report } = open();
    const refused = await refusal(provider.create(request(), report));
    expect(refused.failure.error).toBe("machine-timeout");
    const waited = slept.reduce((sum, value) => sum + value, 0);
    expect(waited).toBeGreaterThanOrEqual(WAITS.runningMs);
    expect(waited).toBeLessThanOrEqual(WAITS.runningMs + WAITS.pollMs);
  });

  test("an instance that never terminates ends in machine-timeout", async () => {
    await open().provider.create(request(), () => {});
    fake.settings.terminatePolls = Number.POSITIVE_INFINITY;
    const { provider, report } = open();
    const refused = await refusal(provider.destroy((await provider.find("web"))!, { deleteKey: false }, report));
    expect(refused.failure.error).toBe("machine-timeout");
    expect(refused.failure.details?.[0]).toContain("run the same destroy again");
  });

  test("a rate limit met while waiting is waited out, and said once", async () => {
    fake.fail("DescribeInstances", 503, "RequestLimitExceeded", "Request limit exceeded.", { times: 3, match: (body) => body["InstanceId.1"] !== undefined });
    const { provider, lines, report } = open();
    const outcome = await provider.create(request(), report);
    expect(outcome.machine.status).toBe("running");
    expect(lines.filter((line) => line.includes("trying again"))).toEqual(["   AWS answered RequestLimitExceeded: trying again"]);
  });

  test("a rate limit met outside a wait is a refusal that says how long to wait", async () => {
    fake.fail("DescribeInstances", 503, "RequestLimitExceeded", "Request limit exceeded.", { region: "eu-central-1" });
    const refused = await refusal(open().provider.create(request(), () => {}));
    expect(refused.failure.error).toBe("provider-rate-limited");
    expect(refused.failure.wait).toBe(10);
    expect(writes()).toEqual([]);
  });
});

// --- errors ----------------------------------------------------------------------------------

describe("errors", () => {
  test("credentials AWS does not recognise", async () => {
    const wrongSecret = await refusal(open({ credentials: { AWS_ACCESS_KEY_ID: FAKE_ACCESS_KEY, AWS_SECRET_ACCESS_KEY: "wrongSecretKey0123456789abcdefghijklmnop/+" } }).provider.list());
    expect(wrongSecret.failure.error).toBe("provider-unauthenticated");
    expect(wrongSecret.message).toContain("SignatureDoesNotMatch");
    const wrongKey = await refusal(open({ credentials: { AWS_ACCESS_KEY_ID: "AKIAWRONGWRONG012345", AWS_SECRET_ACCESS_KEY: FAKE_SECRET_KEY } }).provider.list());
    expect(wrongKey.failure.error).toBe("provider-unauthenticated");
  });

  test("temporary credentials carry their session token, signed", async () => {
    fake.settings.sessionToken = SESSION_TOKEN;
    expect((await refusal(open().provider.list())).failure.error).toBe("provider-unauthenticated");
    const machines = await open({ credentials: { AWS_ACCESS_KEY_ID: FAKE_ACCESS_KEY, AWS_SECRET_ACCESS_KEY: FAKE_SECRET_KEY, AWS_SESSION_TOKEN: SESSION_TOKEN } }).provider.list();
    expect(machines).toEqual([]);
    const last = fake.requests.at(-1)!;
    expect(last.headers["x-amz-security-token"]).toBe(SESSION_TOKEN);
    expect(last.headers.authorization).toContain("SignedHeaders=content-type;host;x-amz-date;x-amz-security-token");
  });

  test("every request is a signed POST to the region's endpoint, its parameters in the body", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const recording: Fetch = (input, init) => {
      seen.push({ url: input, init });
      return fetch(input, init);
    };
    await open({ fetcher: recording }).provider.create(request(), () => {});
    for (const { url, init } of seen) {
      expect(url).toBe(`${fake.url}/`);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(fake.requests.every((entry) => entry.search === "" && entry.body.Version === "2016-11-15")).toBe(true);
  });

  test("the API's error codes map onto the CLI's", () => {
    const headers = new Headers();
    const code = (status: number, name: string) => failureFrom(status, name, "said", headers, "do it").failure.error;
    expect(code(401, "AuthFailure")).toBe("provider-unauthenticated");
    expect(code(400, "RequestExpired")).toBe("provider-unauthenticated");
    expect(code(403, "UnauthorizedOperation")).toBe("provider-forbidden");
    expect(code(401, "OptInRequired")).toBe("provider-forbidden");
    expect(code(503, "RequestLimitExceeded")).toBe("provider-rate-limited");
    expect(code(400, "VcpuLimitExceeded")).toBe("provider-limit");
    expect(code(400, "AddressLimitExceeded")).toBe("provider-limit");
    expect(code(500, "InsufficientInstanceCapacity")).toBe("provider-unavailable");
    expect(code(400, "Unsupported")).toBe("provider-unavailable");
    expect(code(400, "InvalidKeyPair.Duplicate")).toBe("provider-name-taken");
    expect(code(400, "DependencyViolation")).toBe("provider-busy");
    expect(code(400, "InvalidVpcID.NotFound")).toBe("provider-not-found");
    expect(code(500, "InternalError")).toBe("provider-failure");
    expect(code(503, "Unavailable")).toBe("provider-failure");
    expect(code(400, "InvalidParameterValue")).toBe("provider-invalid");
    expect(failureFrom(400, "UnauthorizedOperation", "x".repeat(2000), headers, "do it").message.length).toBeLessThan(500);
  });

  test("an answer that is not the API's, a proxy's error page, an unreachable endpoint", async () => {
    const answering = (status: number, body: string): Fetch => async () => new Response(body, { status });
    expect((await refusal(open({ fetcher: answering(200, "<html>hello</html>") }).provider.list())).failure.error).toBe("provider-unreadable");
    expect((await refusal(open({ fetcher: answering(200, "<DescribeVpcsResponse/>") }).provider.list())).failure.error).toBe("provider-unreadable");
    expect((await refusal(open({ fetcher: answering(403, "<html>forbidden</html>") }).provider.list())).failure.error).toBe("provider-unreadable");
    expect((await refusal(open({ fetcher: answering(502, "<html>bad gateway</html>") }).provider.list())).failure.error).toBe("provider-failure");
    const unreachable: Fetch = async () => {
      throw new TypeError("Unable to connect");
    };
    expect((await refusal(open({ fetcher: unreachable }).provider.list())).failure.error).toBe("provider-unreachable");
  });

  test("the API's address is https, or http on the loopback, and nothing more", () => {
    for (const address of ["http://ec2.test-zone.invalid", "https://user:pass@ec2.test-zone.invalid", "https://ec2.test-zone.invalid/?x=1", "not an address"]) {
      expect(() => open({ environment: { SITESOLIDE_AWS_API: address } })).toThrow(ProviderError);
    }
  });
});

// --- the credentials -------------------------------------------------------------------------

describe("credentials", () => {
  test("never in an address, a body or a line; the access key ID only in the Authorization header", async () => {
    fake.settings.sessionToken = SESSION_TOKEN;
    const credentials = { AWS_ACCESS_KEY_ID: FAKE_ACCESS_KEY, AWS_SECRET_ACCESS_KEY: FAKE_SECRET_KEY, AWS_SESSION_TOKEN: SESSION_TOKEN };
    const { provider, report } = open({ credentials });
    await provider.create(request(), report);
    await provider.list();
    await provider.destroy((await provider.find("web"))!, { deleteKey: true }, report);
    await refusal(provider.create(request({ type: "t9.huge" }), report));
    expect(fake.requests.length).toBeGreaterThan(20);
    for (const entry of fake.requests) {
      const everything = JSON.stringify(entry);
      expect(everything).not.toContain(FAKE_SECRET_KEY);
      expect(`${entry.url} ${JSON.stringify(entry.body)}`).not.toContain(FAKE_ACCESS_KEY);
      expect(`${entry.url} ${JSON.stringify(entry.body)}`).not.toContain(SESSION_TOKEN);
      const { authorization, "x-amz-security-token": token, ...rest } = entry.headers;
      expect(authorization).toContain(`Credential=${FAKE_ACCESS_KEY}/`);
      expect(token).toBe(SESSION_TOKEN);
      expect(JSON.stringify(rest)).not.toContain(FAKE_ACCESS_KEY);
    }
  });

  test("discover asks the aws CLI, and takes only what has the shape of credentials", async () => {
    const asked: string[][] = [];
    const workstation = (code: number, stdout: string, environment: Record<string, string> = {}): Workstation => ({
      environment,
      async run(argv) {
        asked.push(argv);
        return { code, stdout, stderr: "" };
      },
      readFile: () => null,
    });
    const exported = JSON.stringify({ Version: 1, AccessKeyId: FAKE_ACCESS_KEY, SecretAccessKey: FAKE_SECRET_KEY, SessionToken: SESSION_TOKEN, Expiration: "2026-10-21T11:00:00+00:00" });
    expect(await discoverAws(workstation(0, exported, { AWS_PROFILE: "sitesolide" }))).toEqual({
      source: "the aws CLI, profile sitesolide",
      credentials: { AWS_ACCESS_KEY_ID: FAKE_ACCESS_KEY, AWS_SECRET_ACCESS_KEY: FAKE_SECRET_KEY, AWS_SESSION_TOKEN: SESSION_TOKEN },
    });
    expect(asked[0]).toEqual(["aws", "configure", "export-credentials", "--format", "process"]);
    expect(await discoverAws(workstation(0, JSON.stringify({ Version: 1, AccessKeyId: FAKE_ACCESS_KEY, SecretAccessKey: FAKE_SECRET_KEY })))).toEqual({
      source: "the aws CLI",
      credentials: { AWS_ACCESS_KEY_ID: FAKE_ACCESS_KEY, AWS_SECRET_ACCESS_KEY: FAKE_SECRET_KEY },
    });
    // Not installed, not signed in, or something else than credentials.
    expect(await discoverAws(workstation(127, ""))).toBeNull();
    expect(await discoverAws(workstation(255, exported))).toBeNull();
    expect(await discoverAws(workstation(0, "not json"))).toBeNull();
    expect(await discoverAws(workstation(0, JSON.stringify({ Version: 2, AccessKeyId: FAKE_ACCESS_KEY, SecretAccessKey: FAKE_SECRET_KEY })))).toBeNull();
    expect(await discoverAws(workstation(0, JSON.stringify({ Version: 1, AccessKeyId: "lower case", SecretAccessKey: FAKE_SECRET_KEY })))).toBeNull();
    // A profile name that could say anything is not repeated.
    expect((await discoverAws(workstation(0, exported, { AWS_PROFILE: "a b\nc" })))?.source).toBe("the aws CLI");
  });

  test("the entry: three fields, all secret, the session token optional; no backups", () => {
    expect(AWS.name).toBe("aws");
    expect(AWS.backups).toBe(false);
    expect(AWS.apiVariable).toBe("SITESOLIDE_AWS_API");
    expect(AWS.credentials.map((field) => [field.variable, field.secret, field.optional === true])).toEqual([
      ["AWS_ACCESS_KEY_ID", true, false],
      ["AWS_SECRET_ACCESS_KEY", true, false],
      ["AWS_SESSION_TOKEN", true, true],
    ]);
    expect(AWS.credentials[0]!.shape.test(FAKE_ACCESS_KEY)).toBe(true);
    expect(AWS.credentials[1]!.shape.test(FAKE_SECRET_KEY)).toBe(true);
    expect(AWS.credentials[2]!.shape.test(SESSION_TOKEN)).toBe(true);
    expect(AWS.credentials[1]!.shape.test("has spaces in it, not a secret key")).toBe(false);
    expect(existsSync(join(import.meta.dir, "..", "..", AWS.docs))).toBe(true);
    expect(AWS.defaults({})).toEqual({ type: "t3.small", location: "eu-central-1", image: "debian-13" });
    expect(AWS.defaults({ AWS_DEFAULT_REGION: "eu-west-3" }).location).toBe("eu-west-3");
    expect(AWS.defaults({ AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "eu-west-3" }).location).toBe("us-east-1");
  });

  test("the shared fake has what every provider's fake has", () => {
    const shared = createFake();
    try {
      expect(shared.environment.SITESOLIDE_AWS_API).toStartWith("http://127.0.0.1:");
      expect(shared.secrets).toEqual([FAKE_ACCESS_KEY, FAKE_SECRET_KEY]);
      expect(shared.requests).toEqual([]);
    } finally {
      shared.stop();
    }
  });
});

// --- the wizard ------------------------------------------------------------------------------

describe("wizard", () => {
  test("locations: the enabled regions, the default first, said by city and country", async () => {
    const choices = await open().provider.locations();
    expect(choices).toEqual([
      { value: "eu-central-1", label: "Frankfurt, DE", hint: "eu-central-1" },
      { value: "eu-west-3", label: "Paris, FR", hint: "eu-west-3" },
      { value: "us-east-1", label: "N. Virginia, US", hint: "us-east-1" },
    ]);
    expect((await open({ environment: { AWS_REGION: "eu-west-3" } }).provider.locations())[0]!.value).toBe("eu-west-3");
    expect(writes()).toEqual([]);
  });

  test("types: the curated ones sold in the region, the default first, with their size", async () => {
    const choices = await open().provider.types("eu-central-1");
    expect(choices[0]).toEqual({ value: "t3.small", label: "t3.small  2 vCPU, 2 GB RAM, 20 GB disk", hint: "burstable CPU, Free Tier eligible" });
    expect(choices.find((choice) => choice.value === "t4g.small")?.label).toBe("t4g.small  2 vCPU, 2 GB RAM, 20 GB disk, arm64");
    expect(choices.find((choice) => choice.value === "m7i-flex.large")).toEqual({ value: "m7i-flex.large", label: "m7i-flex.large  2 vCPU, 8 GB RAM, 20 GB disk", hint: "Free Tier eligible" });
    expect(choices.find((choice) => choice.value === "m7i.large")).toEqual({ value: "m7i.large", label: "m7i.large  2 vCPU, 8 GB RAM, 20 GB disk" });
    // The types a Free plan account may order come first.
    expect(choices.slice(0, 4).every((choice) => choice.hint?.includes("Free Tier eligible"))).toBe(true);
    expect(choices.map((choice) => choice.value)).toEqual(CURATED_TYPES);
    expect(choices.length).toBeLessThanOrEqual(12);
    const paris = await open().provider.types("eu-west-3");
    expect(paris.map((choice) => choice.value).some((value) => value.startsWith("t3a."))).toBe(false);
    expect(writes()).toEqual([]);
  });
});

// --- last: nothing printed carried a credential ----------------------------------------------

test("no credential reached any line or refusal of this file", () => {
  expect(printed.length).toBeGreaterThan(50);
  for (const line of printed) {
    expect(line).not.toContain(FAKE_SECRET_KEY);
    expect(line).not.toContain(FAKE_ACCESS_KEY);
    expect(line).not.toContain(SESSION_TOKEN);
  }
});
