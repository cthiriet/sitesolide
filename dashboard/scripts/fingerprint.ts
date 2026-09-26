#!/usr/bin/env bun
/**
 * Draws a strong password, displays it, and displays its argon2id hash.
 *
 *   bun scripts/fingerprint.ts             draws a password and displays it
 *   bun scripts/fingerprint.ts --typed    hashes the one you type
 *
 * The password is displayed once: store it in your password manager before
 * closing the window. Nothing here writes it to disk, logs it or contacts
 * anything at all.
 *
 * The hash goes out alone on standard output, the rest on standard error: the
 * password stays readable on the screen while the hash is carried away.
 * bin/dashboard-password.sh does exactly that, and puts it on the machine, in
 * /etc/sitesolide/dashboard.env, without writing it anywhere on the way.
 *
 * The service holds only the hash, never the password.
 *
 * `--typed` exists for a password you have already chosen. It is then typed
 * without echo and never passed as an argument: an argument lands in the
 * shell's history and in the process list of every user of the machine.
 */
import { entropyBits, generatePassword } from "../src/password";

async function readSecret(prompt: string): Promise<string> {
  process.stderr.write(prompt);

  const entry = process.stdin;
  if (!entry.isTTY) {
    // Comes through a pipe, which suits a script:
    // printf %s "$p" | bun scripts/fingerprint.ts --typed
    const chunks: Uint8Array[] = [];
    for await (const chunk of entry) chunks.push(chunk as Uint8Array);
    process.stderr.write("\n");
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }

  entry.setRawMode(true);
  entry.resume();
  let value = "";
  for await (const chunk of entry) {
    for (const character of (chunk as Uint8Array).toString()) {
      // Ctrl-C and Ctrl-D exit without displaying anything.
      if (character === "\u0003" || character === "\u0004") {
        entry.setRawMode(false);
        process.stderr.write("\n");
        process.exit(1);
      }
      if (character === "\r" || character === "\n") {
        entry.setRawMode(false);
        entry.pause();
        process.stderr.write("\n");
        return value;
      }
      if (character === "\u007f" || character === "\b") {
        value = value.slice(0, -1);
        continue;
      }
      value += character;
    }
  }
  entry.setRawMode(false);
  process.stderr.write("\n");
  return value;
}

/** The password typed in, with its confirmation when somebody is at the keyboard. */
async function typeIn(): Promise<string> {
  const password = await readSecret("password (no echo): ");
  if (password === "") {
    process.stderr.write("empty, nothing was hashed\n");
    process.exit(1);
  }

  // Only when somebody is typing. A password that came through a pipe cannot be
  // asked for again, the input being exhausted by the first read, and there is
  // nothing to make up for in any case: the confirmation exists for the typing
  // mistake one does not see.
  if (process.stdin.isTTY === true) {
    const again = await readSecret("again: ");
    if (again !== password) {
      process.stderr.write("the two differ, nothing was hashed\n");
      process.exit(1);
    }
  }
  return password;
}

const typed = process.argv.includes("--typed");
const password = typed ? await typeIn() : generatePassword();

// argon2id with Bun's default settings, the ones src/auth.ts checks.
const hash = await Bun.password.hash(password, "argon2id");

// The hash is read back before being announced. What this script displays is
// the only thing that will open the dashboard: if the two did not correspond,
// the fault would show only at the first refused sign-in, after the deployment,
// on a password already stored and the only copy of the right one lost.
if (!(await Bun.password.verify(password, hash))) {
  process.stderr.write("the hash does not verify its own password, nothing is displayed\n");
  process.exit(1);
}

if (!typed) {
  process.stderr.write(
    [
      "",
      `  password   ${password}`,
      `             drawn at random, about ${entropyBits()} bits`,
      "",
      "  Store it now: it cannot be found again.",
      "",
      "",
    ].join("\n"),
  );
}

// On standard output alone, so that `bun scripts/fingerprint.ts | pbcopy` carries
// the hash away and nothing else.
console.log(hash);
