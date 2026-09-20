import { createHash } from "node:crypto";

/**
 * An in-memory stand-in for the slice of the S3 API that R2 implements and this
 * adapter uses: conditional PutObject, GetObject, HeadBucket/HeadObject,
 * DeleteObject, DeleteObjects, and a paginated ListObjectsV2.
 *
 * Test-only. It exists because the adapter's risk is concentrated in
 * compare-and-swap semantics, and those deserve tests that don't need a bucket
 * or a network.
 *
 * What it does NOT do is verify the SigV4 signature — recomputing it here would
 * only reproduce the signer's own mistakes. It checks the parts of a signed
 * request that can be checked independently: that the Authorization header is
 * present and scoped correctly, and that `x-amz-content-sha256` is the real hash
 * of the body it arrived with, which is the SigV4 bug that actually happens.
 * Whether the signature satisfies Cloudflare is a question only Cloudflare can
 * answer; see the live smoke test.
 */
interface Stored {
  data: Buffer;
  etag: string;
  modified: string;
}

export class FakeR2 {
  objects = new Map<string, Stored>();
  requests: Array<{ method: string; key: string; query: string }> = [];
  /** the bucket the adapter is configured for */
  bucket: string;
  /** flip to 404 every request, as a missing or invisible bucket does */
  exists = true;
  /** flip to 403, as bad keys or a bad signature do */
  credentialsOk = true;
  /** force pagination without needing a thousand objects */
  pageSize = 1000;
  /** runs just before a PUT is applied: the place to make someone else win the race */
  beforePut: (() => void | Promise<void>) | null = null;
  /** R2 declining to pick a winner between two racing conditional writes */
  conflictNextPut = false;

  constructor(bucket = "vault-store") {
    this.bucket = bucket;
  }

  private xml(status: number, body: string): Response {
    return new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
      status,
      headers: { "content-type": "application/xml" },
    });
  }

  private error(status: number, code: string): Response {
    return this.xml(status, `<Error><Code>${code}</Code></Error>`);
  }

  private static md5(data: Buffer): string {
    return createHash("md5").update(data).digest("hex");
  }

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const parsed = new URL(url);
    const headers = new Headers(init.headers as HeadersInit);
    const body = init.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);

    if (!headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 Credential=")) {
      return this.error(403, "AccessDenied");
    }
    if (!/\/auto\/s3\/aws4_request,/.test(headers.get("authorization")!)) {
      return this.error(403, "SignatureDoesNotMatch");
    }
    // the hash the signature was computed over has to be the hash of what arrived
    if (headers.get("x-amz-content-sha256") !== createHash("sha256").update(body).digest("hex")) {
      return this.error(403, "XAmzContentSHA256Mismatch");
    }
    if (!headers.get("x-amz-date")) return this.error(403, "AccessDenied");
    if (!this.credentialsOk) return this.error(403, "InvalidAccessKeyId");

    const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (segments[0] !== this.bucket) return this.error(404, "NoSuchBucket");
    const key = segments.slice(1).join("/");
    this.requests.push({ method, key, query: parsed.search });
    if (!this.exists) return this.error(404, "NoSuchBucket");

    if (!key) {
      if (method === "HEAD") return new Response(null, { status: 200 });
      if (method === "GET") return this.list(parsed);
      if (method === "POST" && parsed.searchParams.has("delete")) return this.deleteObjects(body, headers);
      return this.error(405, "MethodNotAllowed");
    }

    switch (method) {
      case "GET":
      case "HEAD": {
        const found = this.objects.get(key);
        if (!found) return this.error(404, "NoSuchKey");
        return new Response(method === "HEAD" ? null : new Uint8Array(found.data), {
          status: 200,
          headers: { etag: `"${found.etag}"`, "content-length": String(found.data.length) },
        });
      }
      case "PUT":
        return this.put(key, body, headers);
      case "DELETE":
        this.objects.delete(key);
        return new Response(null, { status: 204 });
      default:
        return this.error(405, "MethodNotAllowed");
    }
  };

  private async put(key: string, body: Buffer, headers: Headers): Promise<Response> {
    await this.beforePut?.();
    if (this.conflictNextPut) {
      this.conflictNextPut = false;
      return this.error(409, "ConditionalRequestConflict");
    }
    const current = this.objects.get(key);
    const ifNoneMatch = headers.get("if-none-match");
    const ifMatch = headers.get("if-match");
    if (ifNoneMatch === "*" && current) return this.error(412, "PreconditionFailed");
    if (ifMatch !== null) {
      const want = ifMatch.replace(/^"|"$/g, "");
      if (!current || current.etag !== want) return this.error(412, "PreconditionFailed");
    }
    const etag = FakeR2.md5(body);
    this.objects.set(key, { data: body, etag, modified: new Date().toISOString() });
    return new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
  }

  private list(parsed: URL): Response {
    const prefix = parsed.searchParams.get("prefix") ?? "";
    const after = parsed.searchParams.get("continuation-token");
    const limit = Math.min(Number(parsed.searchParams.get("max-keys") ?? this.pageSize), this.pageSize);

    const all = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = after ? all.indexOf(after) + 1 : 0;
    const page = all.slice(start, start + limit);
    const truncated = start + limit < all.length;

    const contents = page
      .map((k) => {
        const o = this.objects.get(k)!;
        return `<Contents><Key>${escapeXml(k)}</Key><LastModified>${o.modified}</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.data.length}</Size></Contents>`;
      })
      .join("");
    return this.xml(
      200,
      `<ListBucketResult><Name>${this.bucket}</Name><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>` +
        (truncated ? `<NextContinuationToken>${escapeXml(page[page.length - 1])}</NextContinuationToken>` : "") +
        `${contents}</ListBucketResult>`,
    );
  }

  private deleteObjects(body: Buffer, headers: Headers): Response {
    if (headers.get("content-md5") !== createHash("md5").update(body).digest("base64")) {
      return this.error(400, "InvalidDigest");
    }
    const keys = [...body.toString("utf8").matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) => unescapeXml(m[1]));
    for (const k of keys) this.objects.delete(k);
    return this.xml(200, "<DeleteResult></DeleteResult>");
  }
}

const escapeXml = (t: string) =>
  t.replace(/[<>&"']/g, (ch) => `&${{ "<": "lt", ">": "gt", "&": "amp", '"': "quot", "'": "apos" }[ch]};`);

const unescapeXml = (t: string) =>
  t.replace(
    /&(lt|gt|amp|quot|apos);/g,
    (_, e: string) => ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" })[e]!,
  );
