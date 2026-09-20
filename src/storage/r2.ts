import { createHash } from "node:crypto";
import {
  NotFoundError, PreconditionFailedError, type StorageProvider, type StoredItem,
  StorageUnavailableError, assertAllowedPath,
} from "./provider";
import { EMPTY_PAYLOAD_SHA256, type SigV4Credentials, sha256Hex, signRequest, uriEncode } from "./sigv4";

type Bytes = Uint8Array<ArrayBuffer>;

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** R2 ignores the region but SigV4 has to name one, and it has to be this. */
const REGION = "auto";
/** ListObjectsV2 and DeleteObjects both cap a page at 1000 keys. */
const PAGE = 1000;

/**
 * §7.1. A Cloudflare R2 bucket, over the S3 API.
 *
 * The compare-and-swap is R2's own: `If-Match` and `If-None-Match` on PutObject,
 * checked by the bucket, atomically. That is the whole reason this provider is
 * so much shorter than the GitHub one — there is no blob/tree/commit/ref dance
 * to emulate a conditional write with, and so no per-process write queue either,
 * because there is nothing to serialise. One request is one atomic write.
 *
 * A file's version token is its ETag, without the quotes R2 wraps it in. That
 * unquoting is load-bearing, not cosmetic: the client echoes the token back in
 * `if-match`, the API strips quotes from what arrives (server/api.ts), and the
 * write-auth HMAC is computed over the stripped value. Hand back a quoted ETag
 * and every authenticated write fails its MAC instead of its precondition.
 *
 * What is given up against GitHub: there is no multi-object transaction, so a
 * document's parts, its label and the index can't land in one write. Nothing
 * depends on that — content is immutable and written create-only *before* the
 * index names it, so the index CAS is the only thing that makes an object
 * visible, and a half-finished upload leaves unreferenced files that
 * findOrphans/rebuild already reconcile. And no version history, so no free
 * undelete; the trash is tombstones in the index and never relied on the store.
 */
export class R2StorageProvider implements StorageProvider {
  id = "r2";
  name = "Cloudflare R2";
  capabilities = { conditionalWrite: true, versioning: false, delete: true, list: true };

  private host: string;
  private credentials: SigV4Credentials;
  private verified = false;

  constructor(
    private cfg: R2Config,
    /** swapped for an in-memory R2 in tests */
    private fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
  ) {
    // account and bucket come from server env only; nothing a client sends can retarget the store
    if (!/^[0-9a-f]{32}$/.test(cfg.accountId)) throw new Error("invalid R2 account id");
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(cfg.bucket)) throw new Error("invalid R2 bucket name");
    this.host = `${cfg.accountId}.r2.cloudflarestorage.com`;
    this.credentials = {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: REGION,
      service: "s3",
    };
  }

  get location(): string {
    return this.cfg.bucket;
  }

  // ───────────────────────── http ─────────────────────────

  /** Encoded once, then used for both the signature and the URL: they must agree byte for byte. */
  private encodedPath(key?: string): string {
    return `/${uriEncode(this.cfg.bucket)}${key ? `/${uriEncode(key, false)}` : ""}`;
  }

  private async send(opts: {
    method: string;
    key?: string;
    query?: Record<string, string>;
    body?: Bytes;
    headers?: Record<string, string>;
  }): Promise<Response> {
    const body = opts.body;
    const signed = signRequest({
      method: opts.method,
      host: this.host,
      path: this.encodedPath(opts.key),
      query: opts.query,
      headers: opts.headers,
      payloadSha256: body ? sha256Hex(body) : EMPTY_PAYLOAD_SHA256,
      credentials: this.credentials,
    });

    let res: Response;
    try {
      res = await this.fetchImpl(signed.url, {
        method: opts.method,
        headers: signed.headers,
        body: body ? (body as Uint8Array as BodyInit) : undefined,
        cache: "no-store",
      });
    } catch (e) {
      // fetch throws a bare "fetch failed" and buries the reason — ECONNRESET, a
      // socket timeout, DNS — one or more `cause` levels down. Without this, every
      // network fault looks identical and there is nothing to act on.
      throw Object.assign(new StorageUnavailableError(`could not reach Cloudflare R2: ${causeChain(e)}`), { cause: e });
    }

    // 403 is how R2 reports both a bad key and a bad signature; neither is retryable.
    if (res.status === 401 || res.status === 403) {
      throw new StorageUnavailableError(`R2 rejected the credentials${await errorCode(res)}`);
    }
    if (res.status === 429) throw new StorageUnavailableError("R2 is rate limiting this bucket");
    if (res.status >= 500) throw new StorageUnavailableError("Cloudflare R2 is having trouble");
    return res;
  }

  // ───────────────────────── lifecycle ─────────────────────────

  /**
   * HeadBucket. It says the bucket exists and the credentials can reach it.
   *
   * Unlike the GitHub provider this cannot check that the store isn't world
   * readable: whether a bucket has a public r2.dev URL or a custom domain
   * attached is Cloudflare-API state, invisible over the S3 API. Buckets are
   * private when created and the setup notes say to leave them that way.
   * Encryption is the control either way; a public store is an acceptable-use
   * problem, not a disclosure.
   */
  async connect(): Promise<void> {
    if (this.verified) return;
    const res = await this.send({ method: "HEAD" });
    if (res.status === 404) throw new StorageUnavailableError("bucket not found, or the credentials can't see it");
    if (!res.ok) throw new StorageUnavailableError();
    this.verified = true;
  }

  async isConnected(): Promise<boolean> {
    return this.connect().then(() => true, () => false);
  }

  async disconnect(): Promise<void> {
    this.verified = false;
  }

  // ───────────────────────── reads ─────────────────────────

  async get(path: string): Promise<{ data: Bytes; version: string }> {
    assertAllowedPath(path);
    const res = await this.send({ method: "GET", key: path });
    if (res.status === 404) throw new NotFoundError(path);
    if (!res.ok) throw new StorageUnavailableError();
    return { data: new Uint8Array(await res.arrayBuffer()) as Bytes, version: etag(res.headers.get("etag")) };
  }

  async list(prefix = ""): Promise<StoredItem[]> {
    const out: StoredItem[] = [];
    let token: string | undefined;
    // A page is 1000 keys. GitHub answered a whole listing in one recursive tree
    // call but capped out at 100k entries; this just keeps going.
    do {
      const query: Record<string, string> = { "list-type": "2", "max-keys": String(PAGE) };
      if (prefix) query.prefix = prefix;
      if (token) query["continuation-token"] = token;

      const res = await this.send({ method: "GET", query });
      if (!res.ok) throw new StorageUnavailableError();
      const xml = await res.text();

      for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
        const key = tag(block, "Key");
        if (key === null) continue;
        out.push({
          path: key,
          size: Number(tag(block, "Size") ?? 0),
          version: etag(tag(block, "ETag")),
          modifiedAt: tag(block, "LastModified") ?? undefined,
        });
      }
      token = tag(xml, "IsTruncated") === "true" ? (tag(xml, "NextContinuationToken") ?? undefined) : undefined;
    } while (token);
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  // ───────────────────────── writes ─────────────────────────

  async put(
    path: string,
    data: Bytes,
    opts?: { ifMatch?: string; ifNoneMatch?: "*"; contentType?: string },
  ): Promise<{ version: string }> {
    assertAllowedPath(path);
    const headers: Record<string, string> = { "content-type": opts?.contentType ?? "application/octet-stream" };
    // back into the quoted form R2 speaks
    if (opts?.ifMatch !== undefined) headers["if-match"] = `"${opts.ifMatch}"`;
    if (opts?.ifNoneMatch) headers["if-none-match"] = "*";

    const res = await this.send({ method: "PUT", key: path, body: data, headers });
    // 412: the precondition was false. 409: two conditional writes to one key
    // raced inside R2 and it declined to pick a winner. Both mean "refetch,
    // merge, try again", which is what the caller does with a failed CAS.
    if (res.status === 412 || res.status === 409) throw new PreconditionFailedError();
    if (!res.ok) throw new StorageUnavailableError();

    // PutObject echoes the new ETag. It should be the MD5 of what we just sent
    // (single-shot upload, no multipart), so fall back to computing it rather
    // than handing back an empty version token.
    const given = etag(res.headers.get("etag"));
    return { version: given || createHash("md5").update(data).digest("hex") };
  }

  /**
   * R2's DeleteObject takes no conditional headers, so `ifMatch` is checked with
   * a HEAD first. That is not atomic: a write landing between the two wins and
   * gets deleted anyway. No caller passes `ifMatch` here — every delete in the
   * app is unconditional, gated on the index version one level up — so this is
   * interface upkeep rather than a path anything walks.
   */
  async delete(path: string, opts?: { ifMatch?: string }): Promise<void> {
    assertAllowedPath(path);
    if (opts?.ifMatch !== undefined) {
      const head = await this.send({ method: "HEAD", key: path });
      if (head.status === 404) return; // already gone is not a failure
      if (!head.ok) throw new StorageUnavailableError();
      if (etag(head.headers.get("etag")) !== opts.ifMatch) throw new PreconditionFailedError();
    }
    const res = await this.send({ method: "DELETE", key: path });
    // S3 deletes are idempotent: a missing key is a 204, and a 404 would be too.
    if (!res.ok && res.status !== 404) throw new StorageUnavailableError();
  }

  /**
   * Every part and the sidecar of one document, in one request. Not a
   * transaction — R2 has none — but one round trip and one billed operation
   * instead of N, and a partial result is just files the index already stopped
   * naming.
   */
  async deleteMany(paths: string[]): Promise<void> {
    paths.forEach(assertAllowedPath);
    for (let i = 0; i < paths.length; i += PAGE) {
      const chunk = paths.slice(i, i + PAGE);
      const body = new TextEncoder().encode(
        `<Delete><Quiet>true</Quiet>${chunk.map((p) => `<Object><Key>${escapeXml(p)}</Key></Object>`).join("")}</Delete>`,
      ) as Bytes;
      const res = await this.send({
        method: "POST",
        query: { delete: "" },
        body,
        // DeleteObjects is the one S3 call that still wants the legacy body digest
        headers: { "content-md5": createHash("md5").update(body).digest("base64") },
      });
      if (!res.ok) throw new StorageUnavailableError();
    }
  }
}

/** Flattens an error's `cause` chain into "fetch failed ← ECONNRESET", which is the part worth reading. */
function causeChain(e: unknown): string {
  const seen: string[] = [];
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    const o = cur as { message?: string; code?: string; cause?: unknown };
    const part = o.code ?? o.message;
    if (part) seen.push(part);
    cur = o.cause;
  }
  return [...new Set(seen)].join(" ← ") || "unknown";
}

/** ETag → version token: unquote, and drop the weak-validator prefix if one ever shows up. */
function etag(raw: string | null): string {
  return (raw ?? "").replace(/^W\//, "").replace(/^"|"$/g, "");
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? unescapeXml(m[1]) : null;
}

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", "#39": "'" };

function unescapeXml(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#39);/g, (_, e: string) => XML_ENTITIES[e]);
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (ch) => `&${{ "<": "lt", ">": "gt", "&": "amp", '"': "quot", "'": "apos" }[ch]};`);
}

/** The S3 error code out of a failure body, for a message that says something. */
async function errorCode(res: Response): Promise<string> {
  const code = tag(await res.clone().text().catch(() => ""), "Code");
  return code ? ` (${code})` : "";
}
