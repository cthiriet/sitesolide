import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  AZURE,
  DEFAULTS,
  discoverAzureCli,
  failureFrom,
  imageFor,
  keyProblem,
  keyRefusal,
  linuxOnDemand,
  loginFailure,
  operationFailure,
  rsaBits,
  SECURITY_RULES,
  WAITS,
  type AzureSku,
  type RetailPrice,
} from "../src/azure";
import { FAILURE_CODES, ownerNamed, ProviderError, WEB_SERVER, type Clock, type CreateRequest, type Provider, type ProviderContext, type PublicKey, type Report, type Workstation } from "../src/provider";
import { CLI_TOKEN, CLIENT, CLIENT_SECRET, createFake, SUBSCRIPTION, TENANT, type FakeAzure } from "../fakes/azure";

/**
 * The Azure provider, through `AZURE.open(...)`, against a local fake of
 * Microsoft Entra, Resource Manager and the retail price list
 * (fakes/azure.ts): the real ones are never called. The clock does not wait.
 *
 * Whatever the path, neither the client secret nor a token may appear in a
 * URL, a line reported, or a refusal: every run of this file adds what it
 * reported and every refusal to `printed`, read by the last test.
 */

/** Generated with ssh-keygen for bin/tests/cli-machine.test.ts; the private halves were deleted at once. */
const ED25519: PublicKey = {
  algorithm: "ssh-ed25519",
  blob: "AAAAC3NzaC1lZDI1NTE5AAAAICezpiOyiQWMYqOeL4S4OgE0T7Fq2bLHWUJ1afO4cczN",
  comment: "ada@workstation.test-zone.invalid",
  fingerprint: "a4:46:30:d5:fd:7e:1a:77:e5:ad:8d:21:4f:9a:3e:9e",
};
const RSA_2048 =
  "AAAAB3NzaC1yc2EAAAADAQABAAABAQDCdJWi+3KfOZP6ARBvtusfyCxfyZWSBpo1smBB7F0vcG1/HE9YixVmfSLEGo3ooja9G7Y/787HEek0wxExEwdaDMNBcSq/V1wRpZG9zimD7eKfiubJePOuG6P2ISfmJqZmAqd3BsWX7HLsZ7+zMZzKIIlgmHzfA2pX0k4r8FhA10aj4h78gcNk3CyAq7/d/AHkgvIepgtNv7zpPOjPEMbxtJSQN3dc3Sg/5nC4hsEPbWGvQt0uSjoyddTHrWxwcPOPfR7q88YMbJQHZD/k5grqCjN+hvQlylGk06z9rkR4sH9NJsEQiwIUaWUrpysY/DwJiu2EgUJjcImXfoU4ZC55";

/** An RSA public key blob of `bits` bits: the shape is all that is read. */
function rsaBlob(bits: number): string {
  const field = (value: Buffer) => {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(value.length);
    return Buffer.concat([size, value]);
  };
  const modulus = Buffer.alloc(bits / 8 + 1, 0xab);
  modulus[0] = 0;
  modulus[1] = 0x80;
  return Buffer.concat([field(Buffer.from("ssh-rsa")), field(Buffer.from([1, 0, 1])), field(modulus)]).toString("base64");
}

let fake: FakeAzure;
/** The owner every test opens the provider for, unless it says another: its expectations are sitesolide's names. */
const SITESOLIDE = ownerNamed("sitesolide");
const DEVBOX = ownerNamed("devbox");
/** Everything reported and refused, read by the last test. */
const printed: string[] = [];
/** Every token the fake handed out, across resets, and every value given to `context.secret`. */
const issued = new Set<string>();
const scrubbed = new Set<string>();

beforeAll(() => {
  fake = createFake();
});

afterAll(() => {
  fake.stop();
});

beforeEach(() => {
  fake.reset();
});

afterEach(() => {
  for (const token of fake.issued) issued.add(token);
});

function fakeClock(): Clock & { sleeps: number[] } {
  let now = Date.parse("2026-10-21T10:00:00Z");
  const sleeps: number[] = [];
  return { now: () => now, sleep: async (milliseconds: number) => void (sleeps.push(milliseconds), (now += milliseconds)), sleeps };
}

function credentialsOf(environment: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => key.startsWith("AZURE_")));
}

function open(environment: Record<string, string> = fake.environment, extra: Partial<ProviderContext> = {}): Provider {
  return AZURE.open({ owner: SITESOLIDE, credentials: credentialsOf(environment), environment, fetcher: fetch, clock: fakeClock(), secret: (value) => void scrubbed.add(value), ...extra });
}

/** The service principal's path, through the CLI's token instead. */
function cliEnvironment(): Record<string, string> {
  const { AZURE_TENANT_ID: _, AZURE_CLIENT_ID: __, AZURE_CLIENT_SECRET: ___, ...rest } = fake.environment;
  return { ...rest, AZURE_ACCESS_TOKEN: CLI_TOKEN };
}

function request(extra: Partial<CreateRequest> = {}): CreateRequest {
  return { name: "web", type: DEFAULTS.type, location: DEFAULTS.location, image: DEFAULTS.image, backups: false, key: ED25519, inbound: WEB_SERVER, ...extra };
}

type Outcome<T> = { value: T | null; error: ProviderError | null; lines: string[] };

async function attempt<T>(work: (report: Report) => Promise<T>): Promise<Outcome<T>> {
  const lines: string[] = [];
  try {
    const value = await work((line) => void lines.push(line));
    printed.push(...lines);
    return { value, error: null, lines };
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    printed.push(...lines, JSON.stringify(error.failure), error.message);
    return { value: null, error, lines };
  }
}

function create(extra: Partial<CreateRequest> = {}, provider = open()) {
  return attempt((report) => provider.create(request(extra), report));
}

function refused<T>(outcome: Outcome<T>): ProviderError {
  expect(outcome.error).not.toBeNull();
  expect(FAILURE_CODES.has(outcome.error!.failure.error)).toBe(true);
  return outcome.error!;
}

/** A request's path without the subscription it lives in. */
function short(path: string): string {
  return path.replace(`/subscriptions/${SUBSCRIPTION}`, "");
}

/** The requests that changed something at Resource Manager, as `METHOD /path`; the token requests apart. */
function writes(): string[] {
  return fake.requests.filter((entry) => entry.method !== "GET" && !entry.path.endsWith("/oauth2/v2.0/token")).map((entry) => `${entry.method} ${short(entry.path)}`);
}

// --- the pieces --------------------------------------------------------------------------------

describe("the addresses", () => {
  test("Azure's by default; another only over https, or http on the loopback", () => {
    const base = { AZURE_SUBSCRIPTION_ID: SUBSCRIPTION, AZURE_ACCESS_TOKEN: CLI_TOKEN };
    expect(() => open(base)).not.toThrow();
    for (const variable of ["SITESOLIDE_AZURE_API", "SITESOLIDE_AZURE_LOGIN", "SITESOLIDE_AZURE_PRICES"]) {
      for (const wrong of ["http://management.test-zone.invalid", "https://user:secret@management.test-zone.invalid", "https://management.test-zone.invalid/?x=1", "not an address"]) {
        let failure: ProviderError | null = null;
        try {
          open({ ...base, [variable]: wrong });
        } catch (error) {
          failure = error as ProviderError;
        }
        expect({ variable, wrong, code: failure?.failure.error }).toEqual({ variable, wrong, code: "provider-endpoint" });
      }
    }
  });
});

describe("the credentials", () => {
  const opening = (credentials: Record<string, string>) => {
    try {
      AZURE.open({ owner: SITESOLIDE, credentials, environment: fake.environment, fetcher: fetch, clock: fakeClock(), secret: () => {} });
      return null;
    } catch (error) {
      return (error as ProviderError).failure;
    }
  };

  test("the subscription, then a token or a service principal's three values", () => {
    expect(opening({ AZURE_ACCESS_TOKEN: CLI_TOKEN })).toMatchObject({ error: "no-provider-token", message: "no Azure subscription: set AZURE_SUBSCRIPTION_ID" });
    expect(opening({ AZURE_SUBSCRIPTION_ID: "not-a-subscription", AZURE_ACCESS_TOKEN: CLI_TOKEN })).toMatchObject({ message: "AZURE_SUBSCRIPTION_ID is not a subscription ID" });
    const partial = opening({ AZURE_SUBSCRIPTION_ID: SUBSCRIPTION, AZURE_TENANT_ID: TENANT, AZURE_CLIENT_ID: CLIENT });
    expect(partial).toMatchObject({ error: "no-provider-token", message: "no Azure credentials to sign in with: set AZURE_CLIENT_SECRET, or sign in with the Azure CLI (az login)" });
    expect(opening({ AZURE_SUBSCRIPTION_ID: SUBSCRIPTION, AZURE_ACCESS_TOKEN: CLI_TOKEN })).toBeNull();
    expect(opening({ AZURE_SUBSCRIPTION_ID: SUBSCRIPTION, AZURE_TENANT_ID: TENANT, AZURE_CLIENT_ID: CLIENT, AZURE_CLIENT_SECRET: CLIENT_SECRET })).toBeNull();
  });

  test("a value of the wrong shape is refused without being repeated", () => {
    const tenant = opening({ AZURE_SUBSCRIPTION_ID: SUBSCRIPTION, AZURE_TENANT_ID: "../evil", AZURE_CLIENT_ID: CLIENT, AZURE_CLIENT_SECRET: CLIENT_SECRET });
    expect(tenant?.error).toBe("no-provider-token");
    expect(JSON.stringify(tenant)).not.toContain(CLIENT_SECRET);
    const token = opening({ AZURE_SUBSCRIPTION_ID: SUBSCRIPTION, AZURE_ACCESS_TOKEN: 'quote"in a token' });
    expect(token).toMatchObject({ error: "no-provider-token", message: "what AZURE_ACCESS_TOKEN holds is not an access token" });
    expect(JSON.stringify(token)).not.toContain("quote");
  });

  test("each field's shape takes what Azure hands out, and a JWT of a few thousand characters", () => {
    const shape = (variable: string) => AZURE.credentials.find((field) => field.variable === variable)!.shape;
    expect(shape("AZURE_SUBSCRIPTION_ID").test(SUBSCRIPTION)).toBe(true);
    expect(shape("AZURE_TENANT_ID").test(TENANT)).toBe(true);
    expect(shape("AZURE_TENANT_ID").test("contoso.onmicrosoft.com")).toBe(true);
    expect(shape("AZURE_TENANT_ID").test("../evil")).toBe(false);
    expect(shape("AZURE_CLIENT_SECRET").test(CLIENT_SECRET)).toBe(true);
    expect(shape("AZURE_CLIENT_SECRET").test("with a space inside it")).toBe(false);
    expect(shape("AZURE_ACCESS_TOKEN").test(CLI_TOKEN)).toBe(true);
    expect(shape("AZURE_ACCESS_TOKEN").test(`${CLI_TOKEN}${"A".repeat(3000)}`)).toBe(true);
    expect(AZURE.credentials.filter((field) => field.secret).map((field) => field.variable)).toEqual(["AZURE_CLIENT_SECRET", "AZURE_ACCESS_TOKEN"]);
    expect(AZURE.credentials.filter((field) => field.optional !== true).map((field) => field.variable)).toEqual(["AZURE_SUBSCRIPTION_ID"]);
    // The service principal first: it is what a prompt asks for.
    expect(AZURE.alternatives).toEqual([["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"], ["AZURE_ACCESS_TOKEN"]]);
    const fields = new Map(AZURE.credentials.map((field) => [field.variable, field]));
    expect(AZURE.alternatives!.flat().every((variable) => fields.get(variable)?.optional === true)).toBe(true);
  });

  test("the defaults: Basv2 at Frankfurt, Debian 13, or the Azure CLI's own default location", () => {
    expect(AZURE.defaults({})).toEqual({ type: "Standard_B2als_v2", location: "germanywestcentral", image: "debian-13" });
    expect(AZURE.defaults({ AZURE_DEFAULTS_LOCATION: "francecentral" }).location).toBe("francecentral");
    expect(AZURE.defaults({ AZURE_DEFAULTS_LOCATION: "not a location!" }).location).toBe("germanywestcentral");
    expect(AZURE).toMatchObject({ name: "azure", backups: false, apiVariable: "SITESOLIDE_AZURE_API", docs: "docs/providers/azure.md" });
  });
});

describe("discover: the Azure CLI, signed in", () => {
  function workstation(answer: { code: number; stdout?: string }, environment: Record<string, string> = {}): Workstation & { calls: string[][] } {
    const calls: string[][] = [];
    return {
      environment,
      calls,
      run: async (argv) => (calls.push(argv), { code: answer.code, stdout: answer.stdout ?? "", stderr: "" }),
      readFile: () => null,
    };
  }
  const output = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ accessToken: CLI_TOKEN, expiresOn: "2026-10-21 11:00:00.000000", expires_on: 1792580400, subscription: SUBSCRIPTION, tenant: TENANT, tokenType: "Bearer", ...extra });

  test("a token for Resource Manager, with the subscription and its tenant", async () => {
    const station = workstation({ code: 0, stdout: output() });
    expect(await discoverAzureCli(station)).toEqual({
      source: "the Azure CLI, signed in",
      credentials: { AZURE_SUBSCRIPTION_ID: SUBSCRIPTION, AZURE_TENANT_ID: TENANT, AZURE_ACCESS_TOKEN: CLI_TOKEN },
    });
    expect(station.calls).toEqual([["az", "account", "get-access-token", "--resource", "https://management.azure.com/", "--output", "json"]]);
    expect(AZURE.discover).toBe(discoverAzureCli);
  });

  test("the subscription the environment names is asked for", async () => {
    const other = "11111111-2222-4333-8444-555555555555";
    const station = workstation({ code: 0, stdout: output({ subscription: other }) }, { AZURE_SUBSCRIPTION_ID: other });
    expect((await discoverAzureCli(station))?.credentials.AZURE_SUBSCRIPTION_ID).toBe(other);
    expect(station.calls[0]!.slice(-2)).toEqual(["--subscription", other]);
  });

  test("nothing when the CLI is missing, signed out, or answers something else", async () => {
    expect(await discoverAzureCli(workstation({ code: 127 }))).toBeNull();
    expect(await discoverAzureCli(workstation({ code: 1, stdout: "Please run 'az login' to setup account." }))).toBeNull();
    expect(await discoverAzureCli(workstation({ code: 0, stdout: "not json" }))).toBeNull();
    expect(await discoverAzureCli(workstation({ code: 0, stdout: output({ accessToken: "short" }) }))).toBeNull();
    expect(await discoverAzureCli(workstation({ code: 0, stdout: output({ subscription: "nope" }) }))).toBeNull();
  });
});

describe("the API's errors", () => {
  const said = (status: number, code: string, message = `the API says ${code}`, headers: Record<string, string> = {}) =>
    failureFrom(status, { error: { code, message } }, new Headers(headers), "create the virtual machine web").failure;

  test("each code gets its own, one of FAILURE_CODES", () => {
    const cases: [number, string, string, string][] = [
      [401, "InvalidAuthenticationToken", "The access token is invalid.", "provider-unauthenticated"],
      [401, "ExpiredAuthenticationToken", "The access token expiry UTC time is earlier than current UTC time.", "provider-unauthenticated"],
      [403, "AuthorizationFailed", "The client does not have authorization to perform action.", "provider-forbidden"],
      [403, "RequestDisallowedByPolicy", "Resource was disallowed by policy.", "provider-invalid"],
      [409, "MissingSubscriptionRegistration", "The subscription is not registered to use namespace 'Microsoft.Network'.", "provider-invalid"],
      [409, "SkuNotAvailable", "The requested VM size is currently not available in location.", "type-unavailable"],
      [409, "QuotaExceeded", "Operation results in exceeding quota limits of Core.", "provider-limit"],
      [409, "OperationNotAllowed", "Operation could not be completed as it results in exceeding approved standardBasv2Family Cores quota.", "provider-limit"],
      [409, "OperationNotAllowed", "The operation is not allowed while the machine is deallocated.", "provider-invalid"],
      [400, "PublicIPCountLimitReached", "Cannot create more than 10 public IP addresses for this subscription in this region.", "provider-limit"],
      [404, "ResourceGroupNotFound", "Resource group could not be found.", "provider-not-found"],
      [409, "AnotherOperationInProgress", "Another operation on this resource is in progress.", "provider-busy"],
      [409, "ResourceGroupBeingDeleted", "The resource group is being deleted.", "provider-busy"],
      [400, "InvalidParameter", "The value of parameter is invalid.", "provider-invalid"],
      [429, "TooManyRequests", "Too many requests.", "provider-rate-limited"],
      [500, "InternalServerError", "An internal error occurred.", "provider-failure"],
      [503, "ServiceUnavailable", "The service is unavailable.", "provider-failure"],
    ];
    for (const [status, code, message, ours] of cases) {
      const failure = said(status, code, message);
      expect({ status, code, ours: failure.error }).toEqual({ status, code, ours });
      expect(FAILURE_CODES.has(failure.error)).toBe(true);
    }
  });

  test("a refusal says the API's code and words, and what to do", () => {
    expect(said(403, "AuthorizationFailed", "no authorization")).toEqual({
      error: "provider-forbidden",
      message: "the credentials may not create the virtual machine web (403 AuthorizationFailed): no authorization",
      details: ["the credentials need the Contributor role on the subscription: in the portal, Subscriptions, the subscription, Access control (IAM); a role granted a moment ago takes a few minutes to apply"],
    });
    expect(said(401, "ExpiredAuthenticationToken").details?.[0]).toContain("about an hour");
    expect(said(429, "TooManyRequests", "slow down", { "Retry-After": "17" }).wait).toBe(17);
    const nested = failureFrom(400, { error: { code: "InvalidTemplate", message: "bad", details: [{ code: "InvalidParameter", message: "adminUsername is not allowed" }] } }, new Headers(), "create it").failure;
    expect(nested.details).toEqual(["InvalidParameter: adminUsername is not allowed"]);
  });

  test("an operation that ends Failed says why in the words of its code", () => {
    expect(operationFailure({ code: "AllocationFailed", message: "no capacity" }, "creation of the virtual machine web", "Failed").failure).toEqual({ error: "type-unavailable", message: "Azure's creation of the virtual machine web failed (AllocationFailed): no capacity" });
    expect(operationFailure({ code: "QuotaExceeded", message: "quota" }, "creation", "Failed").failure.error).toBe("provider-limit");
    expect(operationFailure({ code: "OSProvisioningTimedOut", message: "the guest did not report ready" }, "creation of the virtual machine web", "Failed").failure).toEqual({
      error: "action-failed",
      message: "Azure's creation of the virtual machine web failed: the guest did not report ready",
      details: ["OSProvisioningTimedOut"],
    });
  });

  test("Microsoft Entra's refusals of a service principal", () => {
    const entra = (status: number, error: string, code: number, description: string) =>
      loginFailure(status, { error, error_description: `AADSTS${code}: ${description}\r\nTrace ID: 0000\r\nCorrelation ID: 1111`, error_codes: [code] }, new Headers()).failure;
    expect(entra(401, "invalid_client", 7000215, "Invalid client secret provided.")).toEqual({
      error: "provider-unauthenticated",
      message: "Microsoft Entra refused the service principal (401 invalid_client): AADSTS7000215: Invalid client secret provided.",
      details: ["the client secret is wrong: copy its Value, not its Secret ID, from the app registration's Certificates & secrets"],
    });
    expect(entra(401, "invalid_client", 7000222, "The provided client secret keys are expired.").details?.[0]).toContain("expired");
    expect(entra(400, "invalid_request", 90002, "Tenant not found.").error).toBe("provider-unauthenticated");
    expect(entra(400, "unauthorized_client", 700016, "Application not found.").details?.[0]).toContain("AZURE_CLIENT_ID");
    expect(entra(400, "invalid_scope", 70011, "The scope is not valid.").error).toBe("provider-invalid");
    expect(loginFailure(429, null, new Headers({ "Retry-After": "5" })).failure).toMatchObject({ error: "provider-rate-limited", wait: 5 });
    expect(loginFailure(503, null, new Headers()).failure.error).toBe("provider-failure");
  });
});

describe("what Azure takes", () => {
  const sku = (capabilities: Record<string, string>): AzureSku => ({ resourceType: "virtualMachines", name: "Standard_X", capabilities: Object.entries(capabilities).map(([name, value]) => ({ name, value })) });

  test("Ed25519 keys, and RSA keys of 2048 bits at least", () => {
    expect(rsaBits(RSA_2048)).toBe(2048);
    expect(rsaBits(rsaBlob(4096))).toBe(4096);
    expect(rsaBits(ED25519.blob)).toBeNull();
    expect(keyRefusal(ED25519)).toBeNull();
    expect(keyRefusal({ ...ED25519, algorithm: "ssh-rsa", blob: RSA_2048 })).toBeNull();
    expect(keyRefusal({ ...ED25519, algorithm: "ssh-rsa", blob: rsaBlob(1024) })).toMatchObject({ error: "provider-invalid", message: "Azure would not take the key: an RSA key needs 2048 bits at least, and this one has 1024 bits" });
    expect(keyRefusal({ ...ED25519, algorithm: "ecdsa-sha2-nistp256" })).toMatchObject({ message: "Azure would not take the key: only ssh-ed25519 and ssh-rsa keys are taken, not ecdsa-sha2-nistp256" });
  });

  test("the entry says the same of a key, in one line, for the command and the wizard to check before anything", () => {
    expect(AZURE.keyProblem).toBe(keyProblem);
    expect(keyProblem(ED25519)).toBeNull();
    expect(keyProblem({ ...ED25519, algorithm: "ssh-rsa", blob: RSA_2048 })).toBeNull();
    expect(keyProblem({ ...ED25519, algorithm: "ssh-rsa", blob: rsaBlob(4096) })).toBeNull();
    expect(keyProblem({ ...ED25519, algorithm: "ssh-rsa", blob: rsaBlob(1024) })).toBe("an RSA key needs 2048 bits at least, and this one has 1024 bits");
    expect(keyProblem({ ...ED25519, algorithm: "ecdsa-sha2-nistp256" })).toBe("only ssh-ed25519 and ssh-rsa keys are taken, not ecdsa-sha2-nistp256");
    expect(keyProblem({ ...ED25519, algorithm: "sk-ssh-ed25519@openssh.com" })).toBe("only ssh-ed25519 and ssh-rsa keys are taken, not sk-ssh-ed25519@openssh.com");
    for (const key of [ED25519, { ...ED25519, algorithm: "ssh-rsa", blob: rsaBlob(1024) }, { ...ED25519, algorithm: "ecdsa-sha2-nistp384" }]) {
      expect({ key: key.algorithm, refused: keyRefusal(key)?.message ?? null }).toEqual({ key: key.algorithm, refused: keyProblem(key) === null ? null : `Azure would not take the key: ${keyProblem(key)}` });
    }
    expect(keyProblem({ ...ED25519, algorithm: "ssh-rsa", blob: rsaBlob(1024) })).not.toContain("\n");
  });

  test("debian-13 is Debian's own image, UEFI where the size boots it, arm64 on arm", () => {
    expect(imageFor("debian-13", sku({ HyperVGenerations: "V1,V2", CpuArchitectureType: "x64" }))).toEqual({ publisher: "Debian", offer: "debian-13", sku: "13-gen2", version: "latest" });
    expect(imageFor("debian-13", sku({ HyperVGenerations: "V2", CpuArchitectureType: "Arm64" }))).toMatchObject({ sku: "13-arm64" });
    expect(imageFor("debian-13", sku({ HyperVGenerations: "V1" }))).toMatchObject({ sku: "13" });
    expect(imageFor("Debian:debian-12:12-gen2:0.20250101.1", sku({}))).toEqual({ publisher: "Debian", offer: "debian-12", sku: "12-gen2", version: "0.20250101.1" });
    expect(imageFor("ubuntu", sku({}))).toMatchObject({ error: "provider-invalid" });
    expect(imageFor("a:b:../c:d", sku({}))).toMatchObject({ error: "provider-invalid" });
  });

  test("the price list's line for a Linux machine paid by the hour", () => {
    const line: RetailPrice = { currencyCode: "USD", retailPrice: 0.0432, armRegionName: "germanywestcentral", armSkuName: "Standard_B2als_v2", productName: "Virtual Machines Basv2 Series", meterName: "B2als v2", skuName: "B2als v2", type: "Consumption", unitOfMeasure: "1 Hour", isPrimaryMeterRegion: true };
    expect(linuxOnDemand(line)).toBe(true);
    expect(linuxOnDemand({ ...line, productName: "Virtual Machines Basv2 Series Windows" })).toBe(false);
    expect(linuxOnDemand({ ...line, meterName: "B2als v2 Spot", skuName: "B2als v2 Spot" })).toBe(false);
    expect(linuxOnDemand({ ...line, meterName: "B2als v2 Low Priority", skuName: "B2als v2 Low Priority" })).toBe(false);
    expect(linuxOnDemand({ ...line, productName: "Basv2 Series Cloud Services" })).toBe(false);
    expect(linuxOnDemand({ ...line, type: "DevTestConsumption" })).toBe(false);
    expect(linuxOnDemand({ ...line, type: "Reservation" })).toBe(false);
  });

  test("the security group lets in ssh, http, https and ping from the Internet, in that order", () => {
    expect(SECURITY_RULES.map((entry) => [entry.name, entry.properties.priority, entry.properties.protocol, entry.properties.destinationPortRange, entry.properties.sourceAddressPrefix, entry.properties.access, entry.properties.direction])).toEqual([
      ["ssh", 100, "Tcp", "22", "Internet", "Allow", "Inbound"],
      ["http", 110, "Tcp", "80", "Internet", "Allow", "Inbound"],
      ["https", 120, "Tcp", "443", "Internet", "Allow", "Inbound"],
      ["ping", 130, "Icmp", "*", "Internet", "Allow", "Inbound"],
    ]);
  });
});

// --- create ------------------------------------------------------------------------------------

const TAGS = { "managed-by": "sitesolide", "sitesolide-machine": "web" };

describe("create", () => {
  test("an empty subscription: every check read first, then the group and what it holds, in order", async () => {
    const outcome = await create();
    expect(outcome.error).toBeNull();
    const firstWrite = fake.requests.findIndex((entry) => entry.method === "PUT");
    const reads = fake.requests.slice(0, firstWrite).map((entry) => `${entry.method} ${short(entry.path)}`);
    expect([...new Set(reads)]).toEqual([
      `POST /${TENANT}/oauth2/v2.0/token`,
      "GET /resourcegroups/sitesolide-web",
      "GET /locations",
      "GET /providers/Microsoft.Compute",
      "GET /providers/Microsoft.Network",
      "GET /providers/Microsoft.Compute/skus",
      "GET /api/retail/prices",
      "GET /providers/Microsoft.Compute/locations/germanywestcentral/usages",
      "GET /providers/Microsoft.Compute/locations/germanywestcentral/publishers/Debian/artifacttypes/vmimage/offers/debian-13/skus/13-gen2/versions",
    ]);
    expect(writes()).toEqual([
      "PUT /resourcegroups/sitesolide-web",
      "PUT /resourceGroups/sitesolide-web/providers/Microsoft.Network/networkSecurityGroups/web-nsg",
      "PUT /resourceGroups/sitesolide-web/providers/Microsoft.Network/virtualNetworks/web-vnet",
      "PUT /resourceGroups/sitesolide-web/providers/Microsoft.Network/publicIPAddresses/web-ip",
      "PUT /resourceGroups/sitesolide-web/providers/Microsoft.Network/networkInterfaces/web-nic",
      "PUT /resourceGroups/sitesolide-web/providers/Microsoft.Compute/virtualMachines/web",
      "PATCH /resourceGroups/sitesolide-web/providers/Microsoft.Compute/disks/web-osdisk/providers/Microsoft.Resources/tags/default",
    ]);

    // Every page of every list was read.
    const pages = (fragment: string) => fake.requests.filter((entry) => entry.method === "GET" && entry.path.endsWith(fragment)).length;
    expect(pages("/locations")).toBe(4);
    expect(pages("/providers/Microsoft.Compute/skus")).toBe(8);
    expect(pages("/usages")).toBe(3);
    expect(pages("/api/retail/prices")).toBeGreaterThan(1);

    // Everything carries the two tags, the disk Azure made too.
    expect(fake.groups.get("sitesolide-web")).toMatchObject({ location: "germanywestcentral", tags: TAGS });
    expect([...fake.resources.values()].map((resource) => [resource.type, resource.name, resource.tags])).toEqual([
      ["Microsoft.Network/networkSecurityGroups", "web-nsg", TAGS],
      ["Microsoft.Network/virtualNetworks", "web-vnet", TAGS],
      ["Microsoft.Network/publicIPAddresses", "web-ip", TAGS],
      ["Microsoft.Network/networkInterfaces", "web-nic", TAGS],
      ["Microsoft.Compute/virtualMachines", "web", TAGS],
      ["Microsoft.Compute/disks", "web-osdisk", TAGS],
    ]);

    const body = (fragment: string) => fake.requests.find((entry) => entry.method === "PUT" && entry.path.endsWith(fragment))!.body as Record<string, unknown>;
    expect(body("/networkSecurityGroups/web-nsg")).toEqual({ location: "germanywestcentral", tags: TAGS, properties: { securityRules: SECURITY_RULES } });
    expect(body("/publicIPAddresses/web-ip")).toEqual({ location: "germanywestcentral", tags: TAGS, sku: { name: "Standard", tier: "Regional" }, properties: { publicIPAllocationMethod: "Static", publicIPAddressVersion: "IPv4" } });
    expect(body("/virtualNetworks/web-vnet")).toMatchObject({ properties: { addressSpace: { addressPrefixes: ["10.0.0.0/16"] }, subnets: [{ name: "web-subnet", properties: { addressPrefix: "10.0.0.0/24" } }] } });
    expect(body("/networkInterfaces/web-nic")).toMatchObject({
      properties: {
        ipConfigurations: [{ properties: { subnet: { id: `/subscriptions/${SUBSCRIPTION}/resourceGroups/sitesolide-web/providers/Microsoft.Network/virtualNetworks/web-vnet/subnets/web-subnet` } } }],
        networkSecurityGroup: { id: `/subscriptions/${SUBSCRIPTION}/resourceGroups/sitesolide-web/providers/Microsoft.Network/networkSecurityGroups/web-nsg` },
      },
    });
    const vm = body("/virtualMachines/web");
    expect(vm).toEqual({
      location: "germanywestcentral",
      tags: TAGS,
      properties: {
        hardwareProfile: { vmSize: "Standard_B2als_v2" },
        storageProfile: {
          imageReference: { publisher: "Debian", offer: "debian-13", sku: "13-gen2", version: "latest" },
          osDisk: { name: "web-osdisk", createOption: "FromImage", deleteOption: "Delete", managedDisk: { storageAccountType: "StandardSSD_LRS" } },
        },
        osProfile: {
          computerName: "web",
          adminUsername: "sitesolide",
          linuxConfiguration: { disablePasswordAuthentication: true, ssh: { publicKeys: [{ path: "/home/sitesolide/.ssh/authorized_keys", keyData: `ssh-ed25519 ${ED25519.blob} ${ED25519.comment}` }] } },
        },
        networkProfile: { networkInterfaces: [{ id: `/subscriptions/${SUBSCRIPTION}/resourceGroups/sitesolide-web/providers/Microsoft.Network/networkInterfaces/web-nic`, properties: { primary: true } }] },
      },
    });
    // Created, never replaced; and nothing for cloud-init to run.
    expect(fake.requests.find((entry) => entry.method === "PUT" && entry.path.endsWith("/virtualMachines/web"))!.headers["if-none-match"]).toBe("*");
    expect(JSON.stringify(vm)).not.toMatch(/customData|userData|adminPassword/);

    expect(outcome.value).toMatchObject({
      created: true,
      machine: {
        provider: "azure",
        id: "sitesolide-web",
        name: "web",
        type: "Standard_B2als_v2",
        location: "germanywestcentral",
        status: "running",
        ipv4: "203.0.113.12",
        ipv6: null,
        ipv6Network: null,
        monthlyPrice: null,
        backups: false,
        managed: true,
        labels: TAGS,
        login: "sitesolide",
      },
    });
    expect(outcome.value!.resources.map((resource) => [resource.kind, resource.name, resource.reused])).toEqual([
      ["resource group", "sitesolide-web", false],
      ["network security group", "web-nsg", false],
      ["virtual network", "web-vnet", false],
      ["public IPv4", "web-ip", false],
      ["network interface", "web-nic", false],
      ["virtual machine", "web", false],
    ]);
    expect(outcome.value!.resources.every((resource) => !resource.id.includes(SUBSCRIPTION))).toBe(true);
  });

  test("the steps say what they do, with the size's price from the list", async () => {
    const { lines } = await create();
    expect(lines).toContain("-> resource group sitesolide-web");
    expect(lines).toContain("   none of that name yet");
    expect(lines).toContain("   Frankfurt, Germany");
    expect(lines).toContain("   Microsoft.Compute and Microsoft.Network: registered");
    expect(lines).toContain("   2 vCPU, 4 GB RAM, x86, 31.54 USD a month before VAT, list price; the disk and the address are billed beside it");
    expect(lines).toContain("-> image debian-13: Debian:debian-13:13-gen2:latest");
    expect(lines).toContain("   inbound tcp 22, 80, 443 and icmp, from the Internet; the rest dropped");
    expect(lines).toContain("-> virtual machine web");
    expect(lines).toContain("   in progress");
    expect(lines).toContain("   status: running");
    expect(lines).toContain("   tagged, as Azure creates it without the machine's tags");
    expect(lines.every((line) => /^(-> |   |!! )/.test(line))).toBe(true);
  });

  test("a second run finds everything and writes nothing", async () => {
    expect((await create()).error).toBeNull();
    fake.requests.length = 0;
    const again = await create();
    expect(again.value).toMatchObject({ created: false, machine: { status: "running", ipv4: "203.0.113.12", managed: true } });
    expect(writes()).toEqual([]);
    expect(again.value!.resources.map((resource) => [resource.kind, resource.reused])).toEqual([
      ["resource group", true],
      ["virtual machine", true],
    ]);
  });

  test("the Azure CLI's token is used as it is, with no sign-in", async () => {
    const outcome = await create({}, open(cliEnvironment()));
    expect(outcome.error).toBeNull();
    expect(fake.requests.some((entry) => entry.path.endsWith("/oauth2/v2.0/token"))).toBe(false);
    expect(fake.requests.filter((entry) => entry.path.startsWith("/subscriptions/")).every((entry) => entry.authorization === `Bearer ${CLI_TOKEN}`)).toBe(true);
  });

  test("a run that stopped halfway is finished: what it made is reused, the rest created", async () => {
    fake.addGroup("sitesolide-web", { tags: TAGS });
    fake.addResource("sitesolide-web", "Microsoft.Network", "networkSecurityGroups", "web-nsg", { tags: TAGS });
    fake.addResource("sitesolide-web", "Microsoft.Network", "virtualNetworks", "web-vnet", { tags: TAGS });
    const outcome = await create();
    expect(outcome.value?.created).toBe(true);
    expect(outcome.value!.resources.map((resource) => [resource.kind, resource.reused])).toEqual([
      ["resource group", true],
      ["network security group", true],
      ["virtual network", true],
      ["public IPv4", false],
      ["network interface", false],
      ["virtual machine", false],
    ]);
    expect(writes().map((write) => write.split("/").at(-1))).toEqual(["web-ip", "web-nic", "web", "default"]);
  });

  test("a group of that name sitesolide did not create is refused before anything is written", async () => {
    fake.addGroup("sitesolide-web", { location: "westeurope" });
    const error = refused(await create());
    expect(error.failure).toMatchObject({ error: "machine-exists", message: "a resource group named sitesolide-web exists in the subscription, and sitesolide did not create it for web" });
    expect(error.failure.details?.[0]).toBe("at westeurope, succeeded");
    expect(writes()).toEqual([]);

    fake.reset();
    fake.addGroup("sitesolide-web", { tags: { "managed-by": "sitesolide", "sitesolide-machine": "other" } });
    expect(refused(await create()).failure.error).toBe("machine-exists");
    expect(writes()).toEqual([]);
  });

  test("a resource of one of its names that sitesolide did not create, inside its group, stops everything", async () => {
    fake.addGroup("sitesolide-web", { tags: TAGS });
    fake.addResource("sitesolide-web", "Microsoft.Network", "networkSecurityGroups", "web-nsg");
    const nsg = refused(await create());
    expect(nsg.failure).toMatchObject({ error: "firewall-taken", message: "a network security group named web-nsg exists in the resource group sitesolide-web, and sitesolide did not create it" });
    expect(writes()).toEqual([]);

    fake.reset();
    fake.addGroup("sitesolide-web", { tags: TAGS });
    fake.addResource("sitesolide-web", "Microsoft.Network", "networkInterfaces", "web-nic", { tags: { "managed-by": "someone-else" } });
    expect(refused(await create()).failure).toMatchObject({ error: "machine-exists", message: "a network interface named web-nic exists in the resource group sitesolide-web, and sitesolide did not create it" });
    expect(writes()).toEqual([]);
  });

  test("a machine of ours at another location or of another size is said, and kept as it is", async () => {
    fake.addMachine("web", { location: "francecentral", size: "Standard_B2s_v2" });
    const outcome = await create();
    expect(outcome.value).toMatchObject({ created: false, machine: { location: "francecentral", type: "Standard_B2s_v2" } });
    expect(outcome.lines).toContain("!! it is at francecentral: --location only applies to a machine being created");
    expect(outcome.lines).toContain("!! it is Standard_B2s_v2: --type only applies to a machine being created");
    expect(writes()).toEqual([]);
  });

  test("a group of ours without its machine, at another location: the machine goes where the group is, and that is said", async () => {
    fake.addGroup("sitesolide-web", { tags: TAGS, location: "francecentral" });
    const outcome = await create();
    expect(outcome.value).toMatchObject({ created: true, machine: { location: "francecentral" } });
    expect(outcome.lines).toContain("!! the resource group is at francecentral, not germanywestcentral: the machine it lacks is created at francecentral; --location only applies to a resource group being created");
    const vm = fake.requests.find((entry) => entry.method === "PUT" && entry.path.endsWith("/virtualMachines/web"))!.body as { location: string };
    expect(vm.location).toBe("francecentral");
    expect(fake.requests.some((entry) => entry.path.includes("/locations/germanywestcentral/"))).toBe(false);
  });

  test("a machine of ours that is deallocated is said, never started", async () => {
    fake.addMachine("web", { power: "deallocated" });
    expect(refused(await create()).failure).toMatchObject({ error: "machine-off", message: "web exists but is deallocated" });
    expect(writes()).toEqual([]);
  });

  test("an OS disk left untagged by an interrupted run is tagged by the next", async () => {
    fake.addMachine("web", { diskTagged: false });
    expect((await create()).error).toBeNull();
    expect(writes()).toEqual(["PATCH /resourceGroups/sitesolide-web/providers/Microsoft.Compute/disks/web-osdisk/providers/Microsoft.Resources/tags/default"]);
  });

  test("a group being deleted is said, not reused", async () => {
    fake.addGroup("sitesolide-web", { tags: TAGS, state: "Deleting" });
    expect(refused(await create()).failure).toMatchObject({ error: "provider-busy", message: "Azure is deleting the resource group sitesolide-web" });
    expect(writes()).toEqual([]);
  });
});

describe("create refuses before writing", () => {
  test("a size Azure does not sell there, with the cheapest it does", async () => {
    const error = refused(await create({ type: "Standard_Z99" }));
    expect(error.failure.error).toBe("invalid-server-type");
    expect(error.failure.message).toBe("Standard_Z99 is not a size Azure sells at germanywestcentral");
    expect(error.failure.details?.slice(0, 4)).toEqual([
      "the sizes sitesolide offers that Azure sells at germanywestcentral, the cheapest first:",
      "Standard_B2pls_v2  2 vCPU, 4 GB RAM, arm, 28.03 USD a month before VAT",
      "Standard_B2als_v2  2 vCPU, 4 GB RAM, x86, 31.54 USD a month before VAT",
      "Standard_B2ls_v2   2 vCPU, 4 GB RAM, x86, 35.04 USD a month before VAT",
    ]);
    expect(writes()).toEqual([]);
  });

  test("a size sold but not to this subscription", async () => {
    fake.settings.restricted.add("Standard_B2als_v2");
    const error = refused(await create());
    expect(error.failure).toMatchObject({ error: "type-unavailable", message: "Azure does not sell Standard_B2als_v2 at germanywestcentral to this subscription (NotAvailableForSubscription)" });
    expect(error.failure.details).toContain("nothing had been created yet");
    expect(error.failure.details?.join("\n")).not.toContain("Standard_B2als_v2 ");
    expect(writes()).toEqual([]);
  });

  test("a location that is not one, with the locations", async () => {
    const error = refused(await create({ location: "atlantis" }));
    expect(error.failure).toMatchObject({ error: "invalid-location", message: "atlantis is not an Azure location this subscription can use" });
    expect(error.failure.details).toContain("germanywestcentral   Frankfurt, Germany");
    expect(error.failure.details?.join("\n")).not.toContain("edgelab1");
    expect(writes()).toEqual([]);
  });

  test("a family whose quota is spent", async () => {
    fake.settings.quota.standardBasv2Family = { limit: 0, used: 0 };
    const error = refused(await create());
    expect(error.failure).toMatchObject({ error: "provider-limit", message: "the subscription's quota of Standard Basv2 Family vCPUs at germanywestcentral is 0, 0 in use: Standard_B2als_v2 needs 2 vCPUs" });
    expect(writes()).toEqual([]);
  });

  test("an image Azure does not offer there", async () => {
    fake.settings.images.delete("Debian:debian-13:13-gen2");
    const error = refused(await create());
    expect(error.failure).toMatchObject({ error: "provider-invalid", message: "Azure offers no image Debian:debian-13:13-gen2:latest at germanywestcentral" });
    expect(writes()).toEqual([]);
    expect(refused(await create({ image: "ubuntu-24.04" })).failure.error).toBe("provider-invalid");
    expect(writes()).toEqual([]);
  });

  test("an arm size gets Debian's arm image", async () => {
    expect((await create({ type: "Standard_B2pls_v2" })).error).toBeNull();
    const vm = fake.requests.find((entry) => entry.method === "PUT" && entry.path.endsWith("/virtualMachines/web"))!.body as { properties: { storageProfile: { imageReference: { sku: string } } } };
    expect(vm.properties.storageProfile.imageReference.sku).toBe("13-arm64");
  });

  test("a key Azure does not take, and backups it does not make, before any request", async () => {
    const ecdsa = refused(await create({ key: { ...ED25519, algorithm: "ecdsa-sha2-nistp256" } }));
    expect(ecdsa.failure.message).toBe("Azure would not take the key: only ssh-ed25519 and ssh-rsa keys are taken, not ecdsa-sha2-nistp256");
    const backups = refused(await create({ backups: true }));
    expect(backups.failure).toMatchObject({ error: "provider-invalid", message: "sitesolide does not turn on Azure's own backups" });
    expect(fake.requests).toEqual([]);
  });

  test("credentials that may read but not create", async () => {
    fake.fail("PUT", /\/resourcegroups\/sitesolide-web$/, 403, "AuthorizationFailed", "The client does not have authorization to perform action 'Microsoft.Resources/subscriptions/resourcegroups/write'.");
    const error = refused(await create());
    expect(error.failure.error).toBe("provider-forbidden");
    expect(error.failure.details?.at(-1)).toBe("nothing had been created yet");
    expect(fake.groups.size).toBe(0);
  });
});

describe("create registers what the subscription never used", () => {
  test("Microsoft.Compute is registered, then waited for", async () => {
    fake.providers["microsoft.compute"] = "NotRegistered";
    const outcome = await create();
    expect(outcome.error).toBeNull();
    expect(writes()[0]).toBe("POST /providers/Microsoft.Compute/register");
    expect(outcome.lines).toContain("   Microsoft.Compute: registering for the subscription, as the portal and the Azure CLI do on a first machine");
    expect(outcome.lines).toContain("   Microsoft.Compute: registered");
    expect(fake.providers["microsoft.compute"]).toBe("Registered");
  });

  test("credentials that may not register are refused with nothing created", async () => {
    fake.providers["microsoft.network"] = "NotRegistered";
    fake.fail("POST", /\/register$/, 403, "AuthorizationFailed", "The client does not have authorization to perform action 'Microsoft.Network/register/action'.");
    expect(refused(await create()).failure.error).toBe("provider-forbidden");
    expect(fake.groups.size).toBe(0);
  });

  test("the registration's wait is bounded", async () => {
    fake.providers["microsoft.compute"] = "NotRegistered";
    fake.settings.registerPolls = 1_000_000;
    expect(refused(await create()).failure).toMatchObject({ error: "machine-timeout", message: `Azure is still registering Microsoft.Compute after ${WAITS.registerMs / 60_000} minutes` });
    expect(fake.groups.size).toBe(0);
  });
});

describe("create undoes what it made when the order fails", () => {
  const SUGGESTED = [
    "the sizes sitesolide offers that Azure sells at germanywestcentral, the cheapest first:",
    "Standard_B2pls_v2  2 vCPU, 4 GB RAM, arm, 28.03 USD a month before VAT",
    "Standard_B2ls_v2   2 vCPU, 4 GB RAM, x86, 35.04 USD a month before VAT",
    "Standard_B2ps_v2   2 vCPU, 8 GB RAM, arm, 56.06 USD a month before VAT",
    "Standard_B2as_v2   2 vCPU, 8 GB RAM, x86, 63.07 USD a month before VAT",
    "Standard_B2s_v2    2 vCPU, 8 GB RAM, x86, 70.08 USD a month before VAT",
    "Standard_D2ls_v5   2 vCPU, 4 GB RAM, x86, 73.73 USD a month before VAT",
  ];

  test("a size Azure cannot place right now: what to try instead, and the group deleted whole", async () => {
    fake.fail("PUT", /\/virtualMachines\/web$/, 409, "SkuNotAvailable", "The requested VM size is currently not available in location 'germanywestcentral'.");
    const outcome = await create();
    const error = refused(outcome);
    expect(error.failure).toEqual({
      error: "type-unavailable",
      message: "Azure would not create Standard_B2als_v2 at germanywestcentral (SkuNotAvailable): The requested VM size is currently not available in location 'germanywestcentral'.",
      details: [...SUGGESTED, "or try another --location", "deleted the resource group sitesolide-web this run had created, and everything in it"],
    });
    expect(writes().at(-1)).toBe("DELETE /resourcegroups/sitesolide-web");
    expect(fake.groups.size).toBe(0);
    expect(fake.resources.size).toBe(0);
    expect(outcome.lines).toContain("-> undo what this run created");
  });

  test("an allocation that fails while Azure runs it counts the same", async () => {
    fake.settings.failVm = { code: "AllocationFailed", message: "Allocation failed. We do not have sufficient capacity for the requested VM size in this region." };
    const error = refused(await create());
    expect(error.failure.error).toBe("type-unavailable");
    expect(error.failure.message).toBe("Azure would not create Standard_B2als_v2 at germanywestcentral (AllocationFailed): Allocation failed. We do not have sufficient capacity for the requested VM size in this region.");
    expect(error.failure.details?.at(-1)).toBe("deleted the resource group sitesolide-web this run had created, and everything in it");
    expect(fake.groups.size).toBe(0);
  });

  test("a quota the order runs into, and any other failure, are undone too", async () => {
    fake.fail("PUT", /\/virtualMachines\/web$/, 409, "OperationNotAllowed", "Operation could not be completed as it results in exceeding approved Total Regional Cores quota.");
    const quota = refused(await create());
    expect(quota.failure.error).toBe("provider-limit");
    expect(quota.failure.details?.at(-1)).toBe("deleted the resource group sitesolide-web this run had created, and everything in it");

    fake.reset();
    fake.settings.failVm = { code: "OSProvisioningTimedOut", message: "OS Provisioning for VM 'web' did not finish in the allotted time." };
    const provisioning = refused(await create());
    expect(provisioning.failure).toMatchObject({ error: "action-failed", message: "Azure's creation of the virtual machine web failed: OS Provisioning for VM 'web' did not finish in the allotted time." });
    expect(fake.groups.size).toBe(0);
  });

  test("an address the subscription's quota refuses is a limit, and the group goes", async () => {
    fake.fail("PUT", /\/publicIPAddresses\/web-ip$/, 400, "PublicIPCountLimitReached", "Cannot create more than 10 public IP addresses for this subscription in this region.");
    const error = refused(await create());
    expect(error.failure.error).toBe("provider-limit");
    expect(error.failure.message).toBe("Azure refused to create the public IPv4 web-ip (400 PublicIPCountLimitReached): Cannot create more than 10 public IP addresses for this subscription in this region.");
    expect(error.failure.details?.[0]).toContain("Networking");
    expect(error.failure.details?.at(-1)).toBe("deleted the resource group sitesolide-web this run had created, and everything in it");
    expect(fake.groups.size).toBe(0);
  });

  test("a machine that appears between the read and the order is never overwritten", async () => {
    fake.fail("PUT", /\/virtualMachines\/web$/, 412, "PreconditionFailed", "The resource already exists.");
    expect(refused(await create()).failure).toMatchObject({ error: "machine-exists", message: "a virtual machine named web appeared in the resource group sitesolide-web while this run created it" });
    expect(writes().some((write) => write.startsWith("DELETE"))).toBe(false);
    expect(fake.groups.has("sitesolide-web")).toBe(true);
  });

  test("what an earlier run made is never undone: only this run's resources go, the last first", async () => {
    fake.addGroup("sitesolide-web", { tags: TAGS });
    fake.addResource("sitesolide-web", "Microsoft.Network", "networkSecurityGroups", "web-nsg", { tags: TAGS });
    fake.fail("PUT", /\/virtualMachines\/web$/, 409, "SkuNotAvailable", "not available");
    const error = refused(await create());
    expect(error.failure.details?.slice(-3)).toEqual([
      "deleted the network interface web-nic this run had created",
      "deleted the public IPv4 web-ip this run had created",
      "deleted the virtual network web-vnet this run had created",
    ]);
    expect(writes().filter((write) => write.startsWith("DELETE")).map((write) => write.split("/").at(-1))).toEqual(["web-nic", "web-ip", "web-vnet"]);
    expect(fake.groups.has("sitesolide-web")).toBe(true);
    expect([...fake.resources.values()].map((resource) => resource.name)).toEqual(["web-nsg"]);
  });

  test("a deletion that fails while undoing leaves the group for the next run", async () => {
    fake.fail("PUT", /\/virtualMachines\/web$/, 409, "SkuNotAvailable", "not available");
    fake.fail("DELETE", /\/resourcegroups\/sitesolide-web$/, 500, "InternalServerError", "internal error");
    const error = refused(await create());
    expect(error.failure.details?.at(-1)).toBe("left the resource group sitesolide-web: the next run finds it and reuses it, or `sitesolide machine destroy` removes it");
    expect(fake.groups.has("sitesolide-web")).toBe(true);

    // The next run, with a size Azure places, reuses all of it.
    const next = await create({ type: "Standard_B2ls_v2" });
    expect(next.value?.created).toBe(true);
    expect(next.value!.resources.filter((resource) => resource.reused).map((resource) => resource.kind)).toEqual(["resource group", "network security group", "virtual network", "public IPv4", "network interface"]);
  });
});

describe("the waits", () => {
  test("bounded, on the clock; what Azure is still making is left for the next run", async () => {
    fake.settings.operationPolls = 1_000_000;
    const clock = fakeClock();
    const started = Date.now();
    const error = refused(await create({}, open(fake.environment, { clock })));
    expect(error.failure).toMatchObject({ error: "machine-timeout", message: `Azure's creation of the network security group web-nsg still runs after ${WAITS.operationMs / 60_000} minutes` });
    expect(error.failure.details?.at(-1)).toBe("nothing was undone: the next run picks it up where it stands, and `sitesolide machine destroy web --provider azure` removes it all");
    expect(writes().some((write) => write.startsWith("DELETE"))).toBe(false);
    expect(clock.now() - Date.parse("2026-10-21T10:00:00Z")).toBeGreaterThanOrEqual(WAITS.operationMs);
    expect(Date.now() - started).toBeLessThan(10_000);

    // The same command picks it all up, waiting first for what Azure is still making.
    fake.settings.operationPolls = 2;
    for (const operation of fake.operations.values()) operation.needed = operation.polls + 3;
    const resumed = await create();
    expect(resumed.value?.created).toBe(true);
    expect(resumed.lines).toContain("   already created by sitesolide, reused; Azure is still at it (updating)");
    expect(resumed.value!.resources.filter((resource) => resource.reused).map((resource) => resource.kind)).toEqual(["resource group", "network security group"]);
  });

  test("Retry-After sets the pace, within a minute", async () => {
    fake.settings.retryAfter = "30";
    const clock = fakeClock();
    expect((await create({}, open(fake.environment, { clock }))).error).toBeNull();
    expect(clock.sleeps).toContain(30_000);
    expect(clock.sleeps.every((pause) => pause >= 1_000 && pause <= WAITS.longestPollMs)).toBe(true);

    fake.reset();
    fake.settings.retryAfter = "3600";
    const capped = fakeClock();
    expect((await create({}, open(fake.environment, { clock: capped }))).error).toBeNull();
    expect(Math.max(...capped.sleeps)).toBe(WAITS.longestPollMs);
  });

  test("a failure that says later is shrugged off once warned; one that says no ends the wait", async () => {
    fake.fail("GET", /\/operations\//, 503, "ServiceUnavailable", "The service is unavailable.");
    const tolerated = await create();
    expect(tolerated.error).toBeNull();
    expect(tolerated.lines).toContain("!! Azure failed to follow creation of the network security group web-nsg (503 ServiceUnavailable): The service is unavailable.: still waiting");

    fake.reset();
    fake.fail("GET", /\/operations\//, 403, "AuthorizationFailed", "no authorization to read operations");
    expect(refused(await create()).failure.message).toBe("the credentials may not follow creation of the network security group web-nsg (403 AuthorizationFailed): no authorization to read operations");
  });

  test("an address to follow elsewhere than the API is not followed, and the token does not go there", async () => {
    fake.settings.foreignOperation = true;
    const error = refused(await create());
    expect(error.failure).toMatchObject({ error: "provider-unreadable", message: "127.0.0.1:" + new URL(fake.url).port + " gave an address at operations.test-zone.invalid to follow, while trying to follow creation of the network security group web-nsg: it is not followed" });
    expect(fake.groups.size).toBe(0);
  });

  test("the service principal's token is exchanged again before it expires", async () => {
    fake.settings.tokenLifetime = 400;
    fake.settings.retryAfter = "60";
    expect((await create()).error).toBeNull();
    expect(fake.issued.length).toBeGreaterThan(1);
    const presented = new Set(fake.requests.filter((entry) => entry.path.startsWith("/subscriptions/")).map((entry) => entry.authorization));
    expect([...presented].every((value) => fake.issued.some((token) => value === `Bearer ${token}`))).toBe(true);
    expect(fake.issued.every((token) => scrubbed.has(token))).toBe(true);
  });
});

describe("the API's refusals, as create reports them", () => {
  test("a token Azure does not know, or no longer takes", async () => {
    const other = `${CLI_TOKEN.slice(0, -4)}AAAA`;
    const unknown = refused(await create({}, open({ ...cliEnvironment(), AZURE_ACCESS_TOKEN: other })));
    expect(unknown.failure).toMatchObject({ error: "provider-unauthenticated", message: "Azure refused the credentials (401 InvalidAuthenticationToken): The access token is invalid." });

    fake.expire(CLI_TOKEN);
    const expired = refused(await create({}, open(cliEnvironment())));
    expect(expired.failure.details?.[0]).toContain("about an hour");
  });

  test("the secret goes in the Basic header; refused there, once more in the form, as MSAL sends it", async () => {
    expect((await create()).error).toBeNull();
    const basic = fake.requests.filter((entry) => entry.path.endsWith("/oauth2/v2.0/token"));
    expect(basic).toHaveLength(1);
    expect(basic[0]!.authorization).toStartWith("Basic ");

    fake.reset();
    fake.settings.basicAccepted = false;
    const outcome = await create();
    expect(outcome.error).toBeNull();
    const tries = fake.requests.filter((entry) => entry.path.endsWith("/oauth2/v2.0/token"));
    expect(tries).toHaveLength(2);
    expect(tries[0]!.authorization).toStartWith("Basic ");
    expect(String(tries[0]!.body)).not.toContain("client_secret");
    expect(tries[1]!.authorization).toBeNull();
    const form = new URLSearchParams(String(tries[1]!.body));
    expect([...form.keys()]).toEqual(["grant_type", "scope", "client_id", "client_secret"]);
    expect(form.get("client_id")).toBe(CLIENT);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    for (const entry of tries) expect(entry.url).not.toContain(CLIENT_SECRET);
    expect(fake.issued).toHaveLength(1);
  });

  test("a wrong secret is tried both ways, then refused with Entra's reason", async () => {
    const wrong = refused(await create({}, open({ ...fake.environment, AZURE_CLIENT_SECRET: "Wr0ng~secret.value_0000000000" })));
    expect(wrong.failure.details).toEqual(["the client secret is wrong: copy its Value, not its Secret ID, from the app registration's Certificates & secrets"]);
    const tries = fake.requests.filter((entry) => entry.path.endsWith("/oauth2/v2.0/token"));
    expect(tries.map((entry) => (entry.authorization === null ? "post" : "basic"))).toEqual(["basic", "post"]);
    // Any other refusal is not tried again.
    fake.requests.length = 0;
    refused(await create({}, open({ ...fake.environment, AZURE_TENANT_ID: "99999999-2222-4333-8444-555555555555" })));
    expect(fake.requests.filter((entry) => entry.path.endsWith("/oauth2/v2.0/token"))).toHaveLength(1);
  });

  test("a service principal Microsoft Entra refuses", async () => {
    const wrong = refused(await create({}, open({ ...fake.environment, AZURE_CLIENT_SECRET: "Wr0ng~secret.value_0000000000" })));
    expect(wrong.failure).toMatchObject({ error: "provider-unauthenticated", message: "Microsoft Entra refused the service principal (401 invalid_client): AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID." });
    const tenant = refused(await create({}, open({ ...fake.environment, AZURE_TENANT_ID: "99999999-2222-4333-8444-555555555555" })));
    expect(tenant.failure).toMatchObject({ error: "provider-unauthenticated", details: ["no tenant of that ID: check AZURE_TENANT_ID"] });
    expect(writes()).toEqual([]);
  });

  test("a rate limit says how long to wait; a failure on Azure's side says so", async () => {
    fake.fail("GET", /\/resourcegroups\/sitesolide-web$/, 429, "TooManyRequests", "The request is being throttled.", { headers: { "Retry-After": "17" } });
    expect(refused(await create()).failure).toMatchObject({ error: "provider-rate-limited", wait: 17 });
    fake.fail("GET", /\/locations$/, 500, "InternalServerError", "An internal error occurred.");
    expect(refused(await create()).failure).toMatchObject({ error: "provider-failure", message: "Azure failed to read the locations (500 InternalServerError): An internal error occurred." });
  });

  test("an API that does not answer, or answers something else", async () => {
    const closed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = closed.port;
    closed.stop(true);
    const unreachable = refused(await create({}, open({ ...cliEnvironment(), SITESOLIDE_AZURE_API: `http://127.0.0.1:${port}` })));
    expect(unreachable.failure.error).toBe("provider-unreachable");

    const html = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<html>hello</html>", { headers: { "Content-Type": "text/html" } }) });
    const htmlPort = html.port;
    const unreadable = refused(await create({}, open({ ...cliEnvironment(), SITESOLIDE_AZURE_API: `http://127.0.0.1:${htmlPort}` })));
    html.stop(true);
    expect(unreadable.failure).toMatchObject({ error: "provider-unreadable", message: `127.0.0.1:${htmlPort} answered 200 with something that is not Azure's API, while trying to read the resource group sitesolide-web` });
  });

  test("a price list that does not answer leaves the prices out and stops nothing", async () => {
    fake.settings.pricesUp = false;
    const outcome = await create();
    expect(outcome.error).toBeNull();
    expect(outcome.lines).toContain("   2 vCPU, 4 GB RAM, x86");
  });
});

// --- list and find ------------------------------------------------------------------------------

describe("list and find", () => {
  test("the machines sitesolide created, from every page, and nothing else", async () => {
    for (const name of ["web", "staging", "api", "docs", "shop"]) fake.addMachine(name);
    fake.addGroup("sitesolide-database");
    fake.addGroup("mail", { tags: { "managed-by": "someone-else" } });
    fake.addGroup("other", { tags: { "managed-by": "sitesolide", "sitesolide-machine": "other" } });
    fake.addGroup("sitesolide-half", { tags: { "managed-by": "sitesolide", "sitesolide-machine": "half" } });
    const listed = await open().list();
    expect(listed.map((machine) => [machine.name, machine.status, machine.managed])).toEqual([
      ["web", "running", true],
      ["staging", "running", true],
      ["api", "running", true],
      ["docs", "running", true],
      ["shop", "running", true],
      ["half", "incomplete", true],
    ]);
    expect(listed[0]).toMatchObject({ type: "Standard_B2als_v2", location: "germanywestcentral", ipv4: "203.0.113.10", login: "sitesolide" });
    const pages = fake.requests.filter((entry) => short(entry.path) === "/resourcegroups");
    expect(pages.length).toBe(4);
    expect(new URLSearchParams(pages[0]!.search).get("$filter")).toBe("tagName eq 'managed-by' and tagValue eq 'sitesolide'");
    expect(writes()).toEqual([]);
  });

  test("find: ours, somebody else's, or none", async () => {
    fake.addMachine("web");
    fake.addGroup("sitesolide-mail");
    const provider = open();
    expect(await provider.find("web")).toMatchObject({ name: "web", managed: true, status: "running" });
    expect(await provider.find("mail")).toMatchObject({ name: "mail", managed: false, type: "unknown", status: "succeeded", ipv4: null });
    expect(await provider.find("absent")).toBeNull();
    expect(writes()).toEqual([]);
  });
});

// --- destroy ------------------------------------------------------------------------------------

describe("destroy", () => {
  test("the group goes, with everything in it, once Azure says it has", async () => {
    fake.addMachine("web");
    const provider = open();
    const machine = (await provider.find("web"))!;
    const outcome = await attempt((report) => provider.destroy(machine, { deleteKey: false }, report));
    expect(outcome.value).toEqual({
      removed: [
        "resource group sitesolide-web",
        "network security group web-nsg",
        "virtual network web-vnet",
        `public IPv4 web-ip (${machine.ipv4})`,
        "network interface web-nic",
        "virtual machine web",
        "disk web-osdisk",
      ],
      kept: [],
    });
    expect(writes()).toEqual(["DELETE /resourcegroups/sitesolide-web"]);
    expect(fake.requests.filter((entry) => entry.path.includes("/operationresults/")).length).toBe(3);
    expect(fake.groups.size).toBe(0);
    expect(fake.resources.size).toBe(0);
    expect(outcome.lines).toContain("   Azure holds no key of its own: it was written into the machine, and went with it");
    expect(outcome.lines).not.toContain("   --delete-key: nothing to delete");
  });

  test("--delete-key has nothing to delete", async () => {
    fake.addMachine("web");
    const provider = open();
    const outcome = await attempt(async (report) => provider.destroy((await provider.find("web"))!, { deleteKey: true }, report));
    expect(outcome.lines).toContain("   --delete-key: nothing to delete");
  });

  test("the OS disk Azure made with the machine is the machine's, tagged or not yet", async () => {
    fake.addMachine("web", { diskTagged: false });
    const provider = open();
    const outcome = await attempt(async (report) => provider.destroy((await provider.find("web"))!, { deleteKey: false }, report));
    expect(outcome.error).toBeNull();
    expect(fake.groups.size).toBe(0);
  });

  test("a data disk attached to the machine since, in the portal, is not the machine's: nothing is deleted", async () => {
    fake.addMachine("web", { diskTagged: false });
    const vm = [...fake.resources.values()].find((resource) => resource.type === "Microsoft.Compute/virtualMachines")!;
    fake.addResource("sitesolide-web", "Microsoft.Compute", "disks", "web_DataDisk_0", { managedBy: vm.id, properties: { provisioningState: "Succeeded", diskSizeGB: 128 } });
    const provider = open();
    const error = refused(await attempt(async (report) => provider.destroy((await provider.find("web"))!, { deleteKey: false }, report)));
    expect(error.failure).toMatchObject({ error: "machine-not-managed", message: "the resource group sitesolide-web holds resources sitesolide did not create" });
    expect(error.failure.details?.[0]).toBe("disk web_DataDisk_0");
    // The untagged OS disk is the machine's, and is not named.
    expect(error.failure.details?.join("\n")).not.toContain("web-osdisk");
    expect(writes()).toEqual([]);
    expect(fake.resources.size).toBe(7);
  });

  test("an untagged disk lying loose in the group stops the deletion too", async () => {
    fake.addMachine("web");
    fake.addResource("sitesolide-web", "Microsoft.Compute", "disks", "spare");
    const provider = open();
    const error = refused(await attempt(async (report) => provider.destroy((await provider.find("web"))!, { deleteKey: false }, report)));
    expect(error.failure.details?.[0]).toBe("disk spare");
    expect(writes()).toEqual([]);
  });

  test("a group holding something sitesolide did not create is not deleted", async () => {
    fake.addMachine("web");
    fake.addResource("sitesolide-web", "Microsoft.Network", "publicIPAddresses", "someone-elses-ip");
    const provider = open();
    const error = refused(await attempt(async (report) => provider.destroy((await provider.find("web"))!, { deleteKey: false }, report)));
    expect(error.failure).toMatchObject({ error: "machine-not-managed", message: "the resource group sitesolide-web holds resources sitesolide did not create" });
    expect(error.failure.details?.[0]).toBe("public IPv4 someone-elses-ip");
    expect(writes()).toEqual([]);
  });

  test("a group without the tags is never deleted, even when asked", async () => {
    fake.addGroup("sitesolide-web");
    const provider = open();
    const machine = { ...(await provider.find("web"))!, managed: true };
    expect(refused(await attempt((report) => provider.destroy(machine, { deleteKey: false }, report))).failure.error).toBe("machine-not-managed");
    expect(writes()).toEqual([]);
  });

  test("a group already gone says so", async () => {
    fake.addMachine("web");
    const provider = open();
    const machine = (await provider.find("web"))!;
    fake.groups.clear();
    const outcome = await attempt((report) => provider.destroy(machine, { deleteKey: false }, report));
    expect(outcome.value).toEqual({ removed: [], kept: [] });
    expect(outcome.lines).toContain("   already gone");
  });

  test("the deletion's wait is bounded", async () => {
    fake.addMachine("web");
    fake.settings.deletePolls = 1_000_000;
    const provider = open();
    const error = refused(await attempt(async (report) => provider.destroy((await provider.find("web"))!, { deleteKey: false }, report)));
    expect(error.failure).toMatchObject({ error: "machine-timeout", message: `Azure's deletion of the resource group sitesolide-web still runs after ${WAITS.deleteMs / 60_000} minutes` });
  });
});

// --- the wizard ---------------------------------------------------------------------------------

describe("the wizard's lists", () => {
  test("the locations: the default first, Europe next, recommended physical regions only", async () => {
    expect(await open().locations()).toEqual([
      { value: "germanywestcentral", label: "Frankfurt, Germany", hint: "Germany West Central" },
      { value: "northeurope", label: "Ireland, Europe", hint: "North Europe" },
      { value: "westeurope", label: "Netherlands, Europe", hint: "West Europe" },
      { value: "francecentral", label: "Paris, France", hint: "France Central" },
      { value: "eastus", label: "Virginia, United States", hint: "East US" },
    ]);
    expect(writes()).toEqual([]);
  });

  test("the sizes: the default first, then the cheapest, with their monthly list price", async () => {
    const sizes = await open().types("germanywestcentral");
    expect(sizes.length).toBeLessThanOrEqual(12);
    expect(sizes.slice(0, 4)).toEqual([
      { value: "Standard_B2als_v2", label: "Standard_B2als_v2", hint: "2 vCPU, 4 GB RAM, x86, 31.54 USD a month before VAT" },
      { value: "Standard_B2pls_v2", label: "Standard_B2pls_v2", hint: "2 vCPU, 4 GB RAM, arm, 28.03 USD a month before VAT" },
      { value: "Standard_B2ls_v2", label: "Standard_B2ls_v2", hint: "2 vCPU, 4 GB RAM, x86, 35.04 USD a month before VAT" },
      { value: "Standard_B2ps_v2", label: "Standard_B2ps_v2", hint: "2 vCPU, 8 GB RAM, arm, 56.06 USD a month before VAT" },
    ]);
    expect(sizes.map((size) => size.value)).not.toContain("Standard_B2ats_v2");
    expect(sizes.map((size) => size.value)).not.toContain("Standard_A1_v2");
    // The price list was asked without any credential.
    const prices = fake.requests.filter((entry) => entry.path === "/api/retail/prices");
    expect(prices.length).toBeGreaterThan(0);
    expect(prices.every((entry) => entry.authorization === null)).toBe(true);
    expect(writes()).toEqual([]);
  });

  test("a size not sold to this subscription is left out; without prices the order is the list's", async () => {
    fake.settings.restricted.add("germanywestcentral/Standard_B2pls_v2");
    fake.settings.pricesUp = false;
    const sizes = await open().types("germanywestcentral");
    expect(sizes.map((size) => size.value)).not.toContain("Standard_B2pls_v2");
    expect(sizes[0]).toEqual({ value: "Standard_B2als_v2", label: "Standard_B2als_v2", hint: "2 vCPU, 4 GB RAM, x86" });
  });

  test("a location sold few sizes offers few, and a name that is not one is refused", async () => {
    expect((await open().types("germanynorth")).map((size) => size.value)).toEqual(["Standard_B2als_v2"]);
    let failure: ProviderError | null = null;
    try {
      await open().types("../../evil");
    } catch (error) {
      failure = error as ProviderError;
    }
    expect(failure?.failure.error).toBe("invalid-location");
  });
});

// --- two owners ---------------------------------------------------------------------------------

describe("two owners in one subscription", () => {
  const devbox = () => open(fake.environment, { owner: DEVBOX });
  const DEVBOX_TAGS = { "managed-by": "devbox", "devbox-machine": "web" };

  test("a machine of one name for each owner, side by side in two groups, each listed by its owner alone", async () => {
    fake.addMachine("web");
    const outcome = await create({}, devbox());
    expect(outcome.error).toBeNull();
    expect(fake.groups.get("devbox-web")).toMatchObject({ tags: DEVBOX_TAGS });
    expect(writes().length).toBeGreaterThan(0);
    expect(writes().every((write) => /\/resource[gG]roups\/devbox-web(\/|$)/.test(write))).toBe(true);
    const vm = fake.requests.find((entry) => entry.method === "PUT" && entry.path.endsWith("/devbox-web/providers/Microsoft.Compute/virtualMachines/web"))!.body as { tags: unknown; properties: { osProfile: { adminUsername: string } } };
    expect(vm.tags).toEqual(DEVBOX_TAGS);
    expect(vm.properties.osProfile.adminUsername).toBe("devbox");
    expect(outcome.value!.machine).toMatchObject({ id: "devbox-web", managed: true, labels: DEVBOX_TAGS, login: "devbox" });

    expect((await devbox().list()).map((machine) => machine.id)).toEqual(["devbox-web"]);
    expect((await open().list()).map((machine) => machine.id)).toEqual(["sitesolide-web"]);
    const filters = fake.requests.filter((entry) => short(entry.path) === "/resourcegroups").map((entry) => new URLSearchParams(entry.search).get("$filter"));
    expect(new Set(filters)).toEqual(new Set(["tagName eq 'managed-by' and tagValue eq 'devbox'", "tagName eq 'managed-by' and tagValue eq 'sitesolide'"]));
  });

  test("another owner's machine is out of reach: not listed, not found, not destroyed", async () => {
    fake.addMachine("web");
    const provider = devbox();
    expect(await provider.list()).toEqual([]);
    expect(await provider.find("web")).toBeNull();
    // Handed the other owner's machine, it looks for a group of its own, which is not there.
    const theirs = (await open().find("web"))!;
    const outcome = await attempt((report) => provider.destroy(theirs, { deleteKey: true }, report));
    expect(outcome.value).toEqual({ removed: [], kept: [] });
    expect(writes()).toEqual([]);
    expect(fake.groups.has("sitesolide-web")).toBe(true);
  });

  test("a group of its name that another owner tagged is never adopted, changed nor deleted", async () => {
    fake.addGroup("devbox-web", { tags: TAGS });
    const error = refused(await create({}, devbox()));
    expect(error.failure).toMatchObject({ error: "machine-exists", message: "a resource group named devbox-web exists in the subscription, and devbox did not create it for web" });
    expect(error.failure.details?.[1]).toBe("it lacks the tags managed-by=devbox and devbox-machine=web: nothing was created, nothing was changed");
    const provider = devbox();
    expect(await provider.list()).toEqual([]);
    const found = (await provider.find("web"))!;
    expect(found).toMatchObject({ id: "devbox-web", managed: false });
    const destroyed = refused(await attempt((report) => provider.destroy({ ...found, managed: true }, { deleteKey: false }, report)));
    expect(destroyed.failure).toMatchObject({ error: "machine-not-managed", message: "the resource group devbox-web was not created by devbox for web" });
    expect(writes()).toEqual([]);
    expect(fake.groups.get("devbox-web")?.tags).toEqual(TAGS);
  });

  test("an owner whose name Azure refuses for an account is refused before any request", async () => {
    const error = refused(await create({}, open(fake.environment, { owner: ownerNamed("admin") })));
    expect(error.failure).toMatchObject({ error: "provider-unsupported", message: "Azure refuses admin as the name of the machine's account, which is the owner's name" });
    expect(fake.requests).toEqual([]);
  });
});

// --- what this provider is not asked --------------------------------------------------------------

describe("what Azure is not asked here is refused before any request", () => {
  const cases: [string, Partial<CreateRequest>, string][] = [
    ["no key", { key: null }, "no-ssh-key"],
    ["a user-data", { userData: "#cloud-config\n" }, "provider-unsupported"],
    ["inbound rules other than a web server's", { inbound: [{ protocol: "tcp", port: 22, sources: ["0.0.0.0/0", "::/0"] }] }, "provider-unsupported"],
    ["the size of the disk", { disk: { gb: 50 } }, "provider-unsupported"],
    ["nested virtualization", { nestedVirtualization: true }, "provider-unsupported"],
    ["the account the key logs into", { login: "dev" }, "provider-unsupported"],
  ];
  for (const [what, extra, code] of cases) {
    test(what, async () => {
      const error = refused(await create(extra));
      expect(error.failure.error).toBe(code);
      expect(error.failure.details).toContain("nothing was created");
      expect(fake.requests).toEqual([]);
    });
  }
});

// --- the credentials never leave their headers --------------------------------------------------

describe("the credentials", () => {
  test("the secret only in the token request's Basic header, the token only in a Bearer header", async () => {
    expect((await create()).error).toBeNull();
    const login = fake.requests.filter((entry) => entry.path.endsWith("/oauth2/v2.0/token"));
    expect(login).toHaveLength(1);
    expect(login[0]!.path).toBe(`/${TENANT}/oauth2/v2.0/token`);
    expect(login[0]!.authorization).toBe(`Basic ${btoa(`${CLIENT}:${encodeURIComponent(CLIENT_SECRET)}`)}`);
    expect(String(login[0]!.body)).toBe("grant_type=client_credentials&scope=https%3A%2F%2Fmanagement.azure.com%2F.default");
    for (const entry of fake.requests) {
      expect(entry.url).not.toContain(CLIENT_SECRET);
      expect(JSON.stringify(entry.body ?? "")).not.toContain(CLIENT_SECRET);
      for (const token of fake.issued) expect(entry.url).not.toContain(token);
    }
  });

  test("nothing reported or refused by this file carried a credential", () => {
    for (const token of fake.issued) issued.add(token);
    const text = printed.join("\n");
    expect(printed.length).toBeGreaterThan(100);
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain(CLI_TOKEN);
    expect(issued.size).toBeGreaterThan(0);
    for (const token of issued) expect(text).not.toContain(token);
  });
});
