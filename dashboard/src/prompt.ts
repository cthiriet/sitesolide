/**
 * A secret typed without echo, or read from a pipe, for the scripts that ask
 * for one: scripts/fingerprint.ts's password, the passphrase of `backup.js
 * decrypt`. Never as an argument, which would land in the shell's history and
 * in the process list of every user of the machine.
 */
export async function readSecret(prompt: string): Promise<string> {
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
