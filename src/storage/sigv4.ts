import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4, enough of it for one bucket on one endpoint.
 *
 * R2 speaks the S3 API, and the S3 API authenticates with SigV4. The official
 * SDK would do this, but it is a large dependency for four operations, and the
 * signing itself is about sixty lines: hash the request into a canonical form,
 * derive a key from the secret scoped to (date, region, service), HMAC one
 * against the other.
 */

const ALGORITHM = "AWS4-HMAC-SHA256";

export const sha256Hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

/** What a GET or DELETE signs as its payload. Computed, not pasted, so a typo can't hide here. */
export const EMPTY_PAYLOAD_SHA256 = sha256Hex("");

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
}

/**
 * AWS's percent-encoding, which is not `encodeURIComponent`: the unreserved set
 * is exactly A-Za-z0-9-_.~ and everything else is encoded byte by byte in
 * uppercase hex. `encodeURIComponent` leaves !'()* alone, and a canonical
 * request that disagrees with the server about those is a 403 with no clue why.
 *
 * S3 signs the path without double-encoding, so `/` stays literal there.
 */
export function uriEncode(input: string, encodeSlash = true): string {
  let out = "";
  for (const ch of input) {
    if (ch.length === 1 && /[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else if (ch === "/" && !encodeSlash) out += "/";
    else {
      for (const b of new TextEncoder().encode(ch)) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** "20260920T124500Z" and its "20260920" prefix. */
function stamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = `${now.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function canonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join("&");
}

/** kSecret → kDate → kRegion → kService → kSigning. Each step keys the next. */
function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  let key: Buffer | string = `AWS4${secret}`;
  for (const part of [dateStamp, region, service, "aws4_request"]) {
    key = createHmac("sha256", key).update(part).digest();
  }
  return key as Buffer;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Signs one request and returns the URL and headers to send verbatim. `path`
 * must already be encoded (see `uriEncode`), because the signature covers the
 * exact bytes that go on the wire.
 */
export function signRequest(opts: {
  method: string;
  host: string;
  /** encoded, leading slash, e.g. "/my-bucket/objects/abc.vault" */
  path: string;
  query?: Record<string, string>;
  /** extra headers to send and sign; host and the x-amz-* pair are added here */
  headers?: Record<string, string>;
  payloadSha256: string;
  credentials: SigV4Credentials;
  now?: Date;
}): SignedRequest {
  const { method, host, path, payloadSha256, credentials: cred } = opts;
  const query = opts.query ?? {};
  const { amzDate, dateStamp } = stamps(opts.now ?? new Date());

  // Everything we send is signed. Nothing can be stripped or added in flight
  // without invalidating the signature — including the conditional headers that
  // carry the compare-and-swap.
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadSha256,
    "x-amz-date": amzDate,
  };
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (v !== undefined) headers[k.toLowerCase()] = v;
  }

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    method.toUpperCase(),
    path,
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadSha256,
  ].join("\n");

  const scope = `${dateStamp}/${cred.region}/${cred.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(cred.secretAccessKey, dateStamp, cred.region, cred.service))
    .update(stringToSign)
    .digest("hex");

  headers.authorization =
    `${ALGORITHM} Credential=${cred.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const qs = canonicalQuery(query);
  // `host` travels as the URL's authority; fetch sets it and rejects it as a header.
  delete (headers as { host?: string }).host;
  return { url: `https://${host}${path}${qs ? `?${qs}` : ""}`, headers };
}
