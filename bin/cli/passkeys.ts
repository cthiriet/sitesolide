/**
 * `sitesolide passkey`: the owner's passkeys, from the workstation, as root
 * on the machine over the owner's SSH, through the steward's owner socket.
 *
 *   sitesolide passkey              the passkeys, by name, never a key
 *   sitesolide passkey link         a one-time link that registers a passkey
 *   sitesolide passkey remove <id>  remove one, the last one included
 *
 * The link is the way in without a passkey: the first one, and the one
 * after every passkey was lost. It lives fifteen minutes, works once, and a
 * new one replaces it. It is printed here alone, never written to a file:
 * whoever holds it registers a passkey that signs in as the owner, so it
 * goes from this terminal straight into the owner's own browser.
 *
 * Removing the last passkey is root's alone, the dashboard refusing it: it
 * gives the dashboard's password back, the break-glass when every passkey
 * is gone and a link cannot be opened. See dashboard/src/passkeys/steward.ts.
 */
import { askSteward, ownerReadCommand, ownerWriteCommand, type Reading, type RunOnMachine } from "./access";
import type { Failure, Output } from "./remote";

export const PASSKEY_USAGE = [
  "sitesolide passkey               the owner's passkeys, by name and id",
  "   link                          a link that registers a passkey, valid 15 minutes, once",
  "   remove <id>                   remove one; the last one gives the dashboard's password back",
];

export type PasskeyRequest = { action: "list" } | { action: "link" } | { action: "remove"; id: string };

/** What the steward lists of a passkey: never its public key. */
export type PasskeyLine = { id: string; name: string; createdAt: number; lastUsedAt: number | null };

export type PasskeyList = { passkeys: PasskeyLine[]; readable: boolean };

export type PasskeyTransport = {
  list: () => Promise<Reading<PasskeyList>>;
  link: () => Promise<Reading<{ link: string; expiresAt: number }>>;
  remove: (id: string) => Promise<Reading<PasskeyList>>;
};

/** A credential id as the steward writes it: base64url, of a sane length. */
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{16,1400}$/;
/** The link's secret, as the dashboard's page reads it from the fragment. */
const LINK_SECRET = /^[A-Za-z0-9_-]{32,128}$/;

const OUTDATED = "the steward on the server does not keep passkeys yet: run sitesolide upgrade first";

function usage(message: string): Failure {
  return { error: "usage", message, details: PASSKEY_USAGE };
}

/** The request the arguments make, or what is wrong with them. Nothing is sent before this passes. */
export function readPasskeyArguments(arguments_: string[]): PasskeyRequest | Failure {
  const rest = (arguments_[0] === "passkey" ? arguments_.slice(1) : arguments_).filter((argument) => argument !== "--json");
  const option = rest.find((argument) => argument.startsWith("-"));
  if (option !== undefined) return usage(`${option}: not an option of sitesolide passkey`);
  if (rest.length === 0 || (rest.length === 1 && rest[0] === "list")) return { action: "list" };
  if (rest[0] === "link") return rest.length === 1 ? { action: "link" } : usage("sitesolide passkey link takes nothing more");
  if (rest[0] === "remove") {
    if (rest.length !== 2) return usage("sitesolide passkey remove takes one passkey's id, as sitesolide passkey lists it");
    const id = rest[1]!;
    if (!CREDENTIAL_ID.test(id)) return { error: "invalid", message: `${id} is not a passkey's id, as sitesolide passkey lists it: nothing was changed` };
    return { action: "remove", id };
  }
  return usage(`${rest[0]}: not a subcommand of sitesolide passkey`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readList(body: Record<string, unknown>): PasskeyList | null {
  if (!Array.isArray(body.passkeys) || typeof body.readable !== "boolean") return null;
  const passkeys: PasskeyLine[] = [];
  for (const one of body.passkeys) {
    if (!isObject(one) || typeof one.id !== "string" || typeof one.name !== "string" || typeof one.createdAt !== "number") return null;
    passkeys.push({ id: one.id, name: one.name, createdAt: one.createdAt, lastUsedAt: typeof one.lastUsedAt === "number" ? one.lastUsedAt : null });
  }
  return { passkeys, readable: body.readable };
}

const unreadable = (what: string): { ok: false; failure: Failure } => ({ ok: false, failure: { error: "failure", message: `the steward's ${what} does not read` } });

/** The owner's transport: root's curl on the owner socket, every body on standard input. */
export function sshPasskeys(run: RunOnMachine): PasskeyTransport {
  const words = { outdated: OUTDATED, unchanged: true };
  const listed = (read: Reading<Record<string, unknown>>): Reading<PasskeyList> => {
    if (!read.ok) return read;
    const list = readList(read.value);
    return list === null ? unreadable("list of passkeys") : { ok: true, value: list };
  };
  return {
    list: async () => listed(await askSteward(run, ownerReadCommand("/passkeys"), undefined, { outdated: OUTDATED, unchanged: false })),
    async link() {
      const read = await askSteward(run, ownerWriteCommand("POST", "/passkeys/link"), "{}", words);
      if (!read.ok) return read;
      const { link, expiresAt } = read.value;
      if (typeof link !== "string" || !LINK_SECRET.test(link) || typeof expiresAt !== "number") return unreadable("link");
      return { ok: true, value: { link, expiresAt } };
    },
    remove: async (id) => listed(await askSteward(run, ownerWriteCommand("DELETE", "/passkeys/credential"), JSON.stringify({ id }), words)),
  };
}

/** A date as a person reads it, in UTC. */
function day(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function describe(list: PasskeyList): string[] {
  if (!list.readable) return ["   the server cannot read its list of passkeys: nobody signs in with one until root repairs it"];
  if (list.passkeys.length === 0) return ["   no passkey: the dashboard's password signs in", "   register one: sitesolide passkey link"];
  return [
    ...list.passkeys.map((one) => `   ${one.name}  added ${day(one.createdAt)}, ${one.lastUsedAt === null ? "never used" : `last used ${day(one.lastUsedAt)}`}  id ${one.id}`),
    ...(list.passkeys.length === 1 ? ["   only one: register a second on another device, or losing it leaves this command as the way back in"] : []),
  ];
}

/** `sitesolide passkey`, the transport handed in. */
export async function passkeys(arguments_: string[], dashboardUrl: string, transport: PasskeyTransport, output: Output): Promise<number> {
  const request = readPasskeyArguments(arguments_);
  if ("error" in request) {
    output.failed(request);
    return 1;
  }
  if (request.action === "link") {
    const minted = await transport.link();
    if (!minted.ok) {
      output.failed(minted.failure);
      return 1;
    }
    const url = `${dashboardUrl}/#passkey=${minted.value.link}`;
    output.say(`-> a link that registers a passkey for the owner of ${dashboardUrl}, over SSH, as the owner`);
    output.say(`   ${url}`);
    output.say(`   valid until ${day(minted.value.expiresAt)}, once; a new link replaces this one`);
    output.say("   open it in your own browser alone: whoever opens it first signs in as the owner");
    output.succeeded("passkey", { action: "link", url, expiresAt: minted.value.expiresAt });
    return 0;
  }
  const read = request.action === "list" ? await transport.list() : await transport.remove(request.id);
  if (!read.ok) {
    output.failed(read.failure);
    return 1;
  }
  output.say(`-> passkeys of the owner of ${dashboardUrl}, over SSH, as the owner`);
  if (request.action === "remove") output.say(`   removed ${request.id}`);
  for (const line of describe(read.value)) output.say(line);
  output.succeeded("passkey", { action: request.action, passkeys: read.value.passkeys, readable: read.value.readable, changed: request.action === "remove" });
  return 0;
}
