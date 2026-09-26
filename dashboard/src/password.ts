/**
 * The draw of the password that `scripts/fingerprint.ts` proposes.
 *
 * Pure: it returns text, touches nothing, and receives its source of randomness
 * as a parameter so that a test can impose the byte sequence and check the
 * exact output. It is the same discipline as `api/src/locks.ts`, and for the
 * same reason: a draw that cannot be replayed is a draw nobody checks.
 *
 * This password is not of the same order as a lock code. The code closes a
 * preview to a passing visitor and is worth thirty bits; this one opens the
 * view onto everything the machine carries, lock codes included. It goes into
 * a password manager and is not retyped: nothing therefore forces it to be
 * shortened.
 */

/**
 * Fifty-six characters, without `I`, `l`, `O`, `o`, `0` or `1`: the password is
 * read off the screen to be copied out, and those six are confused two by two
 * depending on the font.
 *
 * Its size does not divide 256, and that is accepted: `generatePassword`
 * draws by rejection rather than by modulo, which frees the alphabet from that
 * constraint. The lock code, for its part, bends to it because it holds to its
 * six characters that can be dictated over the telephone.
 */
export const ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

/** Six groups of four: 24 characters, that is about 139 bits. */
export const GROUPS = 6;
export const GROUP_LENGTH = 4;

/**
 * The dashes carry no entropy, they are in the same place every time. They
 * exist for the eye that copies it out, and they are part of the password:
 * what is displayed is what is pasted.
 */
export const SEPARATOR = "-";

export type RandomSource = (bytes: number) => Uint8Array;

const defaultRandom: RandomSource = (bytes) => crypto.getRandomValues(new Uint8Array(bytes));

/**
 * Safeguard against a source of randomness that would return only rejected
 * bytes: without it, the rejection loop would spin forever. With 56
 * characters, seven bytes out of eight are kept, and reaching it is impossible
 * with a real source.
 */
const MAX_ROUNDS = 64;

/**
 * Draws a password.
 *
 * **By rejection, and not by modulo.** A modulo biases the draw only if the
 * size of the alphabet divides 256; 56 does not divide it, and the first
 * characters would therefore come up more often than the last. The bytes beyond
 * the last whole multiple of 56, that is to say 224, are set aside and drawn
 * again: each character then comes up with the same probability, without the
 * alphabet having to count 32 or 64 characters.
 */
export function generatePassword(random: RandomSource = defaultRandom, groupCount: number = GROUPS): string {
  // The portal draws shorter ones for its guests, who copy them out; fewer than
  // four groups would no longer be worth a password drawn at random.
  if (!Number.isInteger(groupCount) || groupCount < 4) {
    throw new Error(`group count refused: ${groupCount}`);
  }

  const size = ALPHABET.length;
  const limit = Math.floor(256 / size) * size;
  const total = groupCount * GROUP_LENGTH;
  const characters: string[] = [];

  for (let round = 0; characters.length < total; round++) {
    if (round >= MAX_ROUNDS) {
      throw new Error("random source unusable: too many bytes discarded");
    }

    // Eight bytes of margin per pass, so as not to ask the source again on
    // every rejection.
    const wanted = total - characters.length + 8;
    const bytes = random(wanted);
    if (bytes.length < wanted) {
      throw new Error(`random source too short: ${bytes.length} bytes for ${wanted}`);
    }

    for (const byte of bytes) {
      if (byte >= limit) continue;
      characters.push(ALPHABET[byte % size]!);
      if (characters.length === total) break;
    }
  }

  const groups: string[] = [];
  for (let start = 0; start < total; start += GROUP_LENGTH) {
    groups.push(characters.slice(start, start + GROUP_LENGTH).join(""));
  }
  return groups.join(SEPARATOR);
}

/** What the draw is worth, said plainly to whoever copies out the password. */
export function entropyBits(groupCount: number = GROUPS): number {
  return Math.floor(groupCount * GROUP_LENGTH * Math.log2(ALPHABET.length));
}
