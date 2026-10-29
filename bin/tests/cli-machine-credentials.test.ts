import { describe, expect, test } from "bun:test";
import {
  credentialStatus,
  isValidChoice,
  looksLikeCredential,
  withoutSecrets,
  machine,
  nextCommand,
  parseStdinCredentials,
  resolveCredentials,
  scrubSecrets,
  waitForLogin,
  type MachineDependencies,
} from "../cli/machine";
import { REMOTE_HINTS } from "../cli/hints";
import type { Machine, ProviderEntry, Workstation } from "../../clouds/src/provider";
import type { OutputEvent } from "../cli/output";
import { eventOutput } from "../cli/remote";

/**
 * Where `sitesolide machine` takes credentials from, for a provider that
 * needs one token and for one that needs several, a key and its secret and a
 * project: the environment, standard input, or the provider's own CLI signed
 * in. The provider below is a stand-in that never opens: what is tested is
 * the reading, before any provider is asked anything.
 */

const KEY_ID = "AKIATESTKEY000000000";
const SECRET = "secret/with+signs=0123456789abcdefghij";
const PROJECT = "project-of-tests";

/** A provider that needs a key, its secret and a project, and whose CLI may hold all three. */
function stand(discovered: Record<string, string> | null = null): ProviderEntry {
  return {
    name: "stand",
    title: "Stand",
    credentials: [
      { variable: "STAND_KEY_ID", label: "key id", secret: true, shape: /^[A-Z0-9]{16,128}$/ },
      { variable: "STAND_SECRET", label: "secret key", secret: true, shape: /^[A-Za-z0-9/+=]{20,128}$/ },
      { variable: "STAND_PROJECT", label: "project", secret: false, shape: /^[a-z][a-z0-9-]{3,62}$/ },
      { variable: "STAND_SESSION", label: "session token", secret: true, shape: /^[A-Za-z0-9/+=]{16,2048}$/, optional: true },
    ],
    discover: async () => (discovered === null ? null : { source: "the stand CLI", credentials: discovered }),
    credentialHelp: ["make a key in the stand console"],
    docs: "docs/providers/stand.md",
    defaults: () => ({ type: "small", location: "here", image: "debian-13" }),
    backups: false,
    apiVariable: "SITESOLIDE_STAND_API",
    open: () => {
      throw new Error("never opened in these tests");
    },
  };
}

const nobody: Workstation = { environment: {}, run: async () => ({ code: 127, stdout: "", stderr: "" }), readFile: () => null };

describe("credentials from the environment", () => {
  test("every required variable set: used as they are, the secret ones to scrub", async () => {
    const found = await resolveCredentials(stand(), { stdin: false }, { environment: { STAND_KEY_ID: KEY_ID, STAND_SECRET: SECRET, STAND_PROJECT: PROJECT }, workstation: nobody });
    expect(found).toEqual({
      credentials: { STAND_KEY_ID: KEY_ID, STAND_SECRET: SECRET, STAND_PROJECT: PROJECT },
      source: "STAND_KEY_ID, STAND_SECRET, STAND_PROJECT",
      secrets: [KEY_ID, SECRET],
    });
  });

  test("one missing, and no CLI: refused, naming the variables, never their values", async () => {
    const found = await resolveCredentials(stand(), { stdin: false }, { environment: { STAND_KEY_ID: KEY_ID }, workstation: nobody });
    expect(found).toMatchObject({ error: "no-provider-token", message: "no Stand credentials: set STAND_SECRET, STAND_PROJECT, or pipe every value to --token-stdin as VARIABLE=value lines" });
    expect(JSON.stringify(found)).not.toContain(KEY_ID);
  });

  test("a value of the wrong shape is refused without being repeated", async () => {
    const found = await resolveCredentials(stand(), { stdin: false }, { environment: { STAND_KEY_ID: KEY_ID, STAND_SECRET: 'quote"in it', STAND_PROJECT: PROJECT }, workstation: nobody });
    expect(found).toMatchObject({ error: "no-provider-token", message: "what STAND_SECRET holds is not a Stand secret key: it has characters or a length a secret key never has" });
  });
});

describe("credentials from the provider's own CLI", () => {
  test("used when the environment lacks a required one; the environment's project still wins", async () => {
    const entry = stand({ STAND_KEY_ID: KEY_ID, STAND_SECRET: SECRET, STAND_PROJECT: "project-of-the-cli" });
    const found = await resolveCredentials(entry, { stdin: false }, { environment: { STAND_PROJECT: PROJECT }, workstation: nobody });
    expect(found).toEqual({ credentials: { STAND_KEY_ID: KEY_ID, STAND_SECRET: SECRET, STAND_PROJECT: PROJECT }, source: "the stand CLI", secrets: [KEY_ID, SECRET] });
  });

  test("a secret is never taken half from the environment and half from the CLI", async () => {
    const entry = stand({ STAND_KEY_ID: "AKIATHECLIKEY0000000", STAND_SECRET: SECRET, STAND_PROJECT: PROJECT });
    const found = await resolveCredentials(entry, { stdin: false }, { environment: { STAND_KEY_ID: KEY_ID }, workstation: nobody });
    expect(found).toMatchObject({ credentials: { STAND_KEY_ID: "AKIATHECLIKEY0000000" } });
  });

  test("not asked at all when the environment is complete", async () => {
    let asked = false;
    const entry = { ...stand(), discover: async () => ((asked = true), null) };
    await resolveCredentials(entry, { stdin: false }, { environment: { STAND_KEY_ID: KEY_ID, STAND_SECRET: SECRET, STAND_PROJECT: PROJECT }, workstation: nobody });
    expect(asked).toBe(false);
  });

  test("said by `credentialStatus` with where they come from", async () => {
    expect(await credentialStatus(stand({ STAND_KEY_ID: KEY_ID, STAND_SECRET: SECRET, STAND_PROJECT: PROJECT }), { environment: {}, workstation: nobody })).toEqual({ found: true, source: "the stand CLI" });
    expect(await credentialStatus(stand(), { environment: {}, workstation: nobody })).toEqual({ found: false, source: null });
  });
});

describe("credentials in more than one form", () => {
  /** A project, then a token, or an email and a key: Google's shape. */
  const forms: ProviderEntry = {
    ...stand(),
    credentials: [
      { variable: "FORM_PROJECT", label: "project", secret: false, shape: /^[a-z][a-z0-9-]{3,62}$/ },
      { variable: "FORM_TOKEN", label: "access token", secret: true, shape: /^[A-Za-z0-9._-]{16,2048}$/, optional: true },
      { variable: "FORM_EMAIL", label: "service account email", secret: false, shape: /^\S+@\S+$/, optional: true },
      { variable: "FORM_KEY", label: "private key", secret: true, shape: /^[\s\S]{16,8192}$/, optional: true },
    ],
    alternatives: [["FORM_TOKEN"], ["FORM_EMAIL", "FORM_KEY"]],
  };

  test("complete with the project and either form; the first form is what a prompt asks", async () => {
    const token = await resolveCredentials(forms, { stdin: false }, { environment: { FORM_PROJECT: PROJECT, FORM_TOKEN: "a-token-of-the-right-shape" }, workstation: nobody });
    expect(token).toMatchObject({ credentials: { FORM_PROJECT: PROJECT, FORM_TOKEN: "a-token-of-the-right-shape" } });
    const key = await resolveCredentials(forms, { stdin: false }, { environment: { FORM_PROJECT: PROJECT, FORM_EMAIL: "robot@test-zone.invalid", FORM_KEY: "a-private-key-of-the-right-shape" }, workstation: nobody });
    expect(key).toMatchObject({ source: "FORM_PROJECT, FORM_EMAIL, FORM_KEY" });
    const half = await resolveCredentials(forms, { stdin: false }, { environment: { FORM_PROJECT: PROJECT, FORM_EMAIL: "robot@test-zone.invalid" }, workstation: nobody });
    expect(half).toMatchObject({ message: "no Stand access token: set FORM_TOKEN, or pipe every value to --token-stdin as VARIABLE=value lines" });
  });

  test("the project alone sends the command to the CLI for the rest, the project of the environment kept", async () => {
    const entry = { ...forms, discover: async () => ({ source: "the forms CLI", credentials: { FORM_PROJECT: "project-of-the-cli", FORM_TOKEN: "a-token-the-cli-printed" } }) };
    expect(await resolveCredentials(entry, { stdin: false }, { environment: { FORM_PROJECT: PROJECT }, workstation: nobody })).toMatchObject({
      credentials: { FORM_PROJECT: PROJECT, FORM_TOKEN: "a-token-the-cli-printed" },
      source: "the forms CLI",
    });
  });

  test("a bare line on standard input is never guessed to be one field among several", () => {
    expect(parseStdinCredentials(forms, "a-token-of-the-right-shape\n")).toMatchObject({ error: "no-provider-token" });
  });
});

describe("credentials on standard input", () => {
  test("a single token alone on its line, for a provider that needs one", () => {
    const single: ProviderEntry = { ...stand(), credentials: [{ variable: "ONE_TOKEN", label: "token", secret: true, shape: /^[a-z0-9-]{16,}$/ }] };
    expect(parseStdinCredentials(single, "a-token-of-sixteen-chars\n")).toEqual({ ONE_TOKEN: "a-token-of-sixteen-chars" });
  });

  test("VARIABLE=value lines otherwise, as an environment file holds them, export and quotes allowed", () => {
    expect(parseStdinCredentials(stand(), `export STAND_KEY_ID=${KEY_ID}\nSTAND_SECRET="${SECRET}"\n# a comment\nSTAND_PROJECT=${PROJECT}\n`)).toEqual({
      STAND_KEY_ID: KEY_ID,
      STAND_SECRET: SECRET,
      STAND_PROJECT: PROJECT,
    });
  });

  test("a variable the provider does not read is refused, its value never repeated", () => {
    const refused = parseStdinCredentials(stand(), `STAND_KEY_ID=${KEY_ID}\nOTHER_SECRET=${SECRET}\n`);
    expect(refused).toMatchObject({ error: "no-provider-token", message: "standard input names a variable Stand does not read" });
    expect(JSON.stringify(refused)).not.toContain(SECRET);
  });

  test("standard input is read alone: the environment adds nothing to it", async () => {
    const found = await resolveCredentials(stand(), { stdin: true }, { environment: { STAND_PROJECT: PROJECT }, stdin: async () => `STAND_KEY_ID=${KEY_ID}\nSTAND_SECRET=${SECRET}\n`, workstation: nobody });
    expect(found).toMatchObject({ error: "no-provider-token", message: "standard input lacks STAND_PROJECT" });
  });
});

describe("what a child process is handed", () => {
  test("no provider's secret, no Cloudflare or sitesolide token, and a PATH of absolute folders only", () => {
    const clean = withoutSecrets({
      PATH: ".:./node_modules/.bin:/usr/bin::/bin",
      HOME: "/home/ada",
      AWS_PROFILE: "work",
      HCLOUD_TOKEN: "an-hcloud-token-0000000000000000",
      AWS_SECRET_ACCESS_KEY: SECRET,
      CLOUDFLARE_API_TOKEN: "cloudflare-token-0123456789abcdef",
      SITESOLIDE_TOKEN: "sst_0123456789abcdef",
      GOOGLE_CLOUD_PROJECT: PROJECT,
    });
    expect(clean).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/ada", AWS_PROFILE: "work", GOOGLE_CLOUD_PROJECT: PROJECT });
  });
});

describe("a credential pasted as a type, a location or an image", () => {
  test("has the shape no provider's name has, and is refused without being repeated", async () => {
    expect(looksLikeCredential("cx23")).toBe(false);
    expect(looksLikeCredential("ami-0123456789abcdef0")).toBe(false);
    expect(looksLikeCredential("Standard_B2als_v2")).toBe(false);
    const token = "a".repeat(64);
    expect(looksLikeCredential(token)).toBe(true);
    const lines: string[] = [];
    expect(await machine(["machine", "create", "--provider", "hetzner", "--name", "web", "--type", token, "--json"], { environment: {}, output: eventOutput((line) => lines.push(line)) })).toBe(1);
    expect(lines.join("\n")).not.toContain(token);
  });
});

describe("the names of images", () => {
  test("an Azure URN, a Scaleway UUID and an Akamai id are images, not credentials", () => {
    for (const image of ["Debian:debian-13:13-gen2:latest", "a7f47d5c-ffec-43b4-942e-32df38a7824a", "linode/debian13", "ami-0123456789abcdef0"]) {
      expect({ image, ok: isValidChoice(image, "image") && !looksLikeCredential(image) }).toEqual({ image, ok: true });
    }
    // A type or a location never takes a colon or a slash.
    expect(isValidChoice("Debian:debian-13", "type")).toBe(false);
    expect(isValidChoice("linode/debian13", "location")).toBe(false);
  });
});

describe("the secrets, scrubbed", () => {
  test("the longest first, so that a secret holding a shorter one leaves nothing of itself", () => {
    expect(scrubSecrets("x 12345678SECRETTAIL y", ["12345678", "12345678SECRETTAIL"])).toBe("x [token] y");
  });

  test("as they are, and as JSON escapes them", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----\n";
    expect(scrubSecrets(`said ${key} and ${JSON.stringify({ key })}`, [key])).toBe('said [token] and {"key":"[token]"}');
  });

  test("never a value shorter than eight characters, which would mangle every line", () => {
    expect(scrubSecrets("a short one: root", ["root"])).toBe("a short one: root");
  });
});

describe("after create", () => {
  const made: Machine = {
    provider: "aws",
    id: "i-0",
    name: "web",
    type: "t3.small",
    location: "eu-west-3",
    status: "running",
    ipv4: "203.0.113.7",
    ipv6: null,
    ipv6Network: null,
    monthlyPrice: null,
    backups: false,
    managed: true,
    labels: {},
    login: "admin",
  };

  test("setup connects as the account the image lets in, and makes deploy all the same", () => {
    expect(nextCommand(made)).toBe("sitesolide setup admin@203.0.113.7 --zone <your zone> --email <you> --user deploy");
    expect(nextCommand({ ...made, login: "root" })).toBe("sitesolide setup root@203.0.113.7 --zone <your zone> --email <you>");
  });

  test("the login is waited for, bounded, after port 22 answers", async () => {
    let now = 0;
    const clock = { now: () => now, sleep: async (milliseconds: number) => void (now += milliseconds) };
    let tries = 0;
    const said: string[] = [];
    await waitForLogin("admin", "203.0.113.7", async () => ++tries >= 3, clock, (line) => said.push(line));
    expect(tries).toBe(3);
    expect(said).toEqual(["   admin logs in with the key, after 10 s"]);
    await expect(waitForLogin("admin", "203.0.113.7", async () => false, clock, () => {})).rejects.toMatchObject({ failure: { error: "login-timeout" } });
  });

  test("an SSH agent that does not sign, waiting for its owner's approval, is said once, and named when the wait ends", async () => {
    let now = 0;
    const clock = { now: () => now, sleep: async (milliseconds: number) => void (now += milliseconds) };
    let tries = 0;
    const said: string[] = [];
    await waitForLogin("root", "203.0.113.7", async () => (++tries >= 4 ? true : "agent"), clock, (line) => said.push(line));
    expect(said).toHaveLength(2);
    expect(said[0]).toStartWith("!! the SSH agent did not sign with the key for root@203.0.113.7: a password manager's agent, 1Password's for one, asks you to approve");
    const refused = await waitForLogin("root", "203.0.113.7", async () => "agent", clock, () => {}).catch((error: unknown) => error);
    expect(refused).toMatchObject({ failure: { error: "login-timeout", message: "no login to root@203.0.113.7 within 4 minutes: the SSH agent did not sign with the key" } });
    expect((refused as { failure: { details: string[] } }).failure.details.join("\n")).toContain("approve each use of a key");
  });
});

describe("machine providers", () => {
  test("lists every provider, whether credentials are at hand and where from, never their value", async () => {
    const lines: string[] = [];
    const dependencies: MachineDependencies = { environment: { HCLOUD_TOKEN: "an-hcloud-token-0000000000000000" }, output: eventOutput((line) => lines.push(line)), workstation: nobody };
    expect(await machine(["machine", "providers", "--json"], dependencies)).toBe(0);
    const last = JSON.parse(lines.at(-1)!) as Extract<OutputEvent, { type: "result" }> & { providers: { name: string; credentials: boolean; source: string | null }[] };
    expect(last.providers.find((provider) => provider.name === "hetzner")).toMatchObject({ credentials: true, source: "HCLOUD_TOKEN" });
    expect(lines.join("\n")).not.toContain("an-hcloud-token-0000000000000000");
  });

  test("takes no option but --json", async () => {
    const lines: string[] = [];
    expect(await machine(["machine", "providers", "--provider", "hetzner", "--json"], { environment: {}, output: eventOutput((line) => lines.push(line)) })).toBe(1);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ type: "error", message: "--provider: not an option of sitesolide machine providers", hint: REMOTE_HINTS["machine-option"]! });
  });
});
