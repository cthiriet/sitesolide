/**
 * AWS Signature Version 4, as the IAM User Guide describes it
 * (https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html),
 * with Bun's own HMAC and nothing else: aws.ts signs every EC2 call with it,
 * and the local fake checks the signatures it receives with the same code.
 * That the two agree proves nothing on its own, which is why the tests also
 * hold it to vectors of AWS's own test suite.
 *
 * The secret access key never leaves this file in any form but an HMAC: it
 * is neither part of the request nor of what the functions return.
 */

export type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  /** The session token of temporary credentials, sent as X-Amz-Security-Token and signed with the rest. */
  sessionToken?: string;
};

export const ALGORITHM = "AWS4-HMAC-SHA256";

/**
 * UriEncode as SigV4 defines it: every byte encoded but the unreserved
 * `A-Z a-z 0-9 - . _ ~`, in uppercase hex, a space as %20 and never as +.
 * encodeURIComponent leaves `! ' ( ) *` alone, which SigV4 encodes.
 */
export function uriEncode(value: string, keepSlash = false): string {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? encoded.replaceAll("%2F", "/") : encoded;
}

/** `20150830T123600Z`: the request's date, in UTC, as X-Amz-Date carries it. */
export function amzDate(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function sha256Hex(data: string): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function hmac(key: string | Uint8Array, data: string): Uint8Array {
  return new Bun.CryptoHasher("sha256", key).update(data).digest();
}

/** The canonical query string: each name and value encoded, sorted by name then value once encoded. */
export function canonicalQuery(search: string): string {
  const pairs = new URLSearchParams(search);
  return [...pairs]
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/** A header's value as SigV4 reads it: trimmed, inner runs of spaces made one. */
function canonicalValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export type SignInput = {
  method: string;
  /** The whole address, its query included. */
  url: string;
  /** The headers to sign, Host apart: it is taken from the address. */
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  /** Milliseconds since the epoch: the clock's, so that tests sign with a date of their own. */
  now: number;
};

/** The canonical request, the string to sign and the scope: kept apart for the tests and for the fake's check. */
export function signingParts(input: SignInput, date: string): { canonical: string; signedHeaders: string; scope: string; stringToSign: string } {
  const url = new URL(input.url);
  const headers: Record<string, string> = { host: url.host };
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = canonicalValue(value);
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonical = [
    input.method.toUpperCase(),
    // The path, each segment encoded once; EC2's is `/`.
    url.pathname === "" ? "/" : url.pathname.split("/").map((segment) => uriEncode(decodeURIComponent(segment))).join("/"),
    canonicalQuery(url.search),
    names.map((name) => `${name}:${headers[name]}\n`).join(""),
    signedHeaders,
    sha256Hex(input.body),
  ].join("\n");
  const scope = `${date.slice(0, 8)}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [ALGORITHM, date, scope, sha256Hex(canonical)].join("\n");
  return { canonical, signedHeaders, scope, stringToSign };
}

/** The signature itself, in lowercase hex. */
export function signature(secretAccessKey: string, scope: string, stringToSign: string): string {
  const [day = "", region = "", service = ""] = scope.split("/");
  const dateKey = hmac(`AWS4${secretAccessKey}`, day);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, "aws4_request");
  return new Bun.CryptoHasher("sha256", signingKey).update(stringToSign).digest("hex");
}

/**
 * The headers a signed request carries besides those given: X-Amz-Date,
 * X-Amz-Security-Token with temporary credentials, and Authorization. The
 * session token is signed too, as the canonical headers must list every
 * `x-amz-*` header sent.
 */
export function signRequest(input: SignInput): Record<string, string> {
  const date = amzDate(input.now);
  const token = input.credentials.sessionToken;
  const added: Record<string, string> = { "X-Amz-Date": date, ...(token === undefined || token === "" ? {} : { "X-Amz-Security-Token": token }) };
  const parts = signingParts({ ...input, headers: { ...input.headers, ...added } }, date);
  const signed = signature(input.credentials.secretAccessKey, parts.scope, parts.stringToSign);
  return {
    ...added,
    Authorization: `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${parts.scope}, SignedHeaders=${parts.signedHeaders}, Signature=${signed}`,
  };
}

/** An Authorization header read back: what the fake checks, and where the region is said. */
export function parseAuthorization(header: string | null): { accessKeyId: string; scope: string; region: string; service: string; signedHeaders: string[]; signature: string } | null {
  const match = /^AWS4-HMAC-SHA256 Credential=([^/,\s]+)\/([0-9]{8}\/([^/,\s]+)\/([^/,\s]+)\/aws4_request), ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/.exec(header ?? "");
  if (match === null) return null;
  return { accessKeyId: match[1]!, scope: match[2]!, region: match[3]!, service: match[4]!, signedHeaders: match[5]!.split(";"), signature: match[6]! };
}
