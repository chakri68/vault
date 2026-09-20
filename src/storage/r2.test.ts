import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { importAesKey } from "@/crypto/aes";
import { equalBytes, newId, randomBytes } from "@/crypto/bytes";
import { generateVmk } from "@/crypto/envelopes";
import { VaultEngine } from "@/vault/engine";
import { INDEX_PATH, objectPath, sidecarPath } from "@/vault/index-model";
import { MemoryLocalStore } from "@/vault/local-store";
import { ProviderRemote, deleteObjectFiles } from "@/vault/remote";
import { FakeR2 } from "./fake-r2";
import { isNotFound, isPreconditionFailed, isStorageUnavailable } from "./provider";
import { R2StorageProvider } from "./r2";
import { signRequest, uriEncode } from "./sigv4";

type Bytes = Uint8Array<ArrayBuffer>;

const cfg = {
  accountId: "c5137f93e1ad2ef8f8a230ec2ac1d57d",
  bucket: "vault-store",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret-example",
};
const make = (r2 = new FakeR2(cfg.bucket)) => ({ r2, provider: new R2StorageProvider(cfg, r2.fetch) });
const caught = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
const md5 = (d: Uint8Array) => createHash("md5").update(d).digest("hex");

describe("R2 adapter, against an in-memory S3 API", () => {
  it("connects, writes, and reads back the same bytes", async () => {
    const { provider } = make();
    await provider.connect();
    expect(await provider.list()).toEqual([]);

    const data = randomBytes(5000);
    const { version } = await provider.put(INDEX_PATH, data, { ifNoneMatch: "*" });
    const back = await provider.get(INDEX_PATH);
    expect(equalBytes(back.data, data)).toBe(true);
    expect(back.version).toBe(version);
  });

  /**
   * The load-bearing detail. server/api.ts strips quotes off an inbound
   * `if-match`, and the write-auth HMAC is computed over the stripped value, so a
   * quoted version token would fail every authenticated write's MAC rather than
   * its precondition — a confusing 403 a long way from here.
   */
  it("hands back an unquoted ETag as the version token", async () => {
    const { provider } = make();
    const data = randomBytes(64);
    const { version } = await provider.put(INDEX_PATH, data, { ifNoneMatch: "*" });
    expect(version).toBe(md5(data));
    expect(version).not.toMatch(/"/);
    expect((await provider.get(INDEX_PATH)).version).not.toMatch(/"/);
    expect((await provider.list())[0].version).not.toMatch(/"/);
  });

  it("enforces create-only and compare-and-swap", async () => {
    const { provider } = make();
    const first = randomBytes(100);
    const { version } = await provider.put(INDEX_PATH, first, { ifNoneMatch: "*" });

    // create-only loses against an existing file
    expect(isPreconditionFailed(await caught(provider.put(INDEX_PATH, randomBytes(100), { ifNoneMatch: "*" })))).toBe(true);
    // a stale version loses
    expect(isPreconditionFailed(await caught(provider.put(INDEX_PATH, randomBytes(100), { ifMatch: "0".repeat(32) })))).toBe(true);
    // the current version wins, and moves
    const second = randomBytes(100);
    const next = await provider.put(INDEX_PATH, second, { ifMatch: version });
    expect(next.version).not.toBe(version);
    expect(equalBytes((await provider.get(INDEX_PATH)).data, second)).toBe(true);
    // and the version we just replaced is now stale
    expect(isPreconditionFailed(await caught(provider.put(INDEX_PATH, randomBytes(10), { ifMatch: version })))).toBe(true);
  });

  it("loses a compare-and-swap to a writer that got there first", async () => {
    const { r2, provider } = make();
    const { version } = await provider.put(INDEX_PATH, randomBytes(50), { ifNoneMatch: "*" });
    // somebody else commits in the window between our read and our write
    r2.beforePut = async () => {
      r2.beforePut = null;
      await new R2StorageProvider(cfg, r2.fetch).put(INDEX_PATH, randomBytes(50), { ifMatch: version });
    };
    expect(isPreconditionFailed(await caught(provider.put(INDEX_PATH, randomBytes(50), { ifMatch: version })))).toBe(true);
  });

  it("treats a 409 conditional-write conflict as a failed CAS, so the caller refetches and retries", async () => {
    const { r2, provider } = make();
    r2.conflictNextPut = true;
    expect(isPreconditionFailed(await caught(provider.put(INDEX_PATH, randomBytes(50), { ifNoneMatch: "*" })))).toBe(true);
  });

  it("deletes, tolerates a missing key, and checks ifMatch when asked", async () => {
    const { provider } = make();
    const id = newId();
    const { version } = await provider.put(objectPath(id), randomBytes(200), { ifNoneMatch: "*" });

    await provider.delete(objectPath(newId())); // never existed
    expect(isPreconditionFailed(await caught(provider.delete(objectPath(id), { ifMatch: "0".repeat(32) })))).toBe(true);
    expect(await provider.list()).toHaveLength(1); // the failed precondition didn't delete it
    await provider.delete(objectPath(id), { ifMatch: version });
    expect(await provider.list()).toEqual([]);
  });

  it("removes every file of a document in one request", async () => {
    const { r2, provider } = make();
    const id = newId();
    for (let part = 0; part < 3; part++) await provider.put(objectPath(id, part), randomBytes(64), { ifNoneMatch: "*" });
    await provider.put(sidecarPath(id), randomBytes(64), { ifNoneMatch: "*" });
    await provider.put(INDEX_PATH, randomBytes(64), { ifNoneMatch: "*" });

    r2.requests.length = 0;
    await deleteObjectFiles(provider, id);
    expect(r2.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect((await provider.list()).map((i) => i.path)).toEqual([INDEX_PATH]);
  });

  it("pages through a listing and filters by prefix", async () => {
    const { r2, provider } = make();
    r2.pageSize = 2; // three pages for five objects
    const ids = [newId(), newId(), newId(), newId(), newId()].sort();
    for (const id of ids) await provider.put(objectPath(id), randomBytes(32), { ifNoneMatch: "*" });
    await provider.put(INDEX_PATH, randomBytes(32), { ifNoneMatch: "*" });

    const objects = await provider.list("objects/");
    expect(objects.map((i) => i.path)).toEqual(ids.map((id) => objectPath(id)));
    expect(objects.every((i) => i.size === 32)).toBe(true);
    expect(await provider.list("")).toHaveLength(6);
    // one prefixed listing reaches exactly one document's files
    expect(await provider.list(`objects/${ids[0]}`)).toHaveLength(1);
  });

  it("reports a missing key, a missing bucket and bad credentials distinguishably", async () => {
    const { r2, provider } = make();
    expect(isNotFound(await caught(provider.get(INDEX_PATH)))).toBe(true);

    r2.credentialsOk = false;
    const rejected = await caught(new R2StorageProvider(cfg, r2.fetch).connect());
    expect(isStorageUnavailable(rejected)).toBe(true);
    expect((rejected as Error).message).toMatch(/credentials.*InvalidAccessKeyId/);

    r2.credentialsOk = true;
    r2.exists = false;
    const gone = await caught(new R2StorageProvider(cfg, r2.fetch).connect());
    expect(isStorageUnavailable(gone)).toBe(true);
    expect((gone as Error).message).toMatch(/bucket not found/);
  });

  it("refuses a path outside the allowlist before it reaches the bucket", async () => {
    const { r2, provider } = make();
    await expect(provider.put("../escape", randomBytes(8) as Bytes, { ifNoneMatch: "*" })).rejects.toThrow("path not allowed");
    await expect(provider.get("secrets.txt")).rejects.toThrow("path not allowed");
    expect(r2.requests).toEqual([]);
  });

  it("rejects a configuration that isn't an account id and a bucket name", () => {
    expect(() => new R2StorageProvider({ ...cfg, accountId: "nope" })).toThrow("invalid R2 account id");
    expect(() => new R2StorageProvider({ ...cfg, bucket: "Not A Bucket" })).toThrow("invalid R2 bucket name");
  });

  /**
   * The point of this one: R2 has no multi-object write, so the engine's batch
   * path is unavailable and it falls back to writing content first, then the
   * index, then labels. That fallback is what every upload will use from now on.
   */
  it("runs the whole engine on the one-file-at-a-time path", async () => {
    const { r2, provider } = make();
    const remote = new ProviderRemote(provider);
    expect(await remote.stage({ kind: "index" }, randomBytes(8))).toBeNull(); // no staging on R2

    const vmk = await importAesKey(generateVmk());
    const engine = new VaultEngine({ remote, local: new MemoryLocalStore(), vmk });
    await engine.open();

    const { ids, synced } = await engine.addDocuments([
      { content: randomBytes(900), extension: "pdf", mimeType: "application/pdf", meta: { name: "Passport", ownerProfileIds: [], tags: [] } },
      { content: randomBytes(1200), extension: "pdf", mimeType: "application/pdf", meta: { name: "Lease", ownerProfileIds: [], tags: [] } },
    ]);
    expect(synced).toBe(true);
    for (const id of ids) {
      expect(r2.objects.has(objectPath(id))).toBe(true);
      expect(r2.objects.has(sidecarPath(id))).toBe(true);
    }
    expect(r2.objects.has(INDEX_PATH)).toBe(true);

    // a second engine on the same bucket sees both documents
    const other = new VaultEngine({ remote: new ProviderRemote(provider), local: new MemoryLocalStore(), vmk });
    await other.open();
    expect(Object.keys(other.index.entries).sort()).toEqual([...ids].sort());

    await engine.deletePermanently(ids[0]);
    await engine.sync();
    expect(r2.objects.has(objectPath(ids[0]))).toBe(false);
    expect(r2.objects.has(sidecarPath(ids[0]))).toBe(false);
    expect(r2.objects.has(objectPath(ids[1]))).toBe(true);
  });
});

describe("SigV4", () => {
  // AWS's unreserved set is exactly A-Za-z0-9-_.~ — narrower than encodeURIComponent's,
  // which leaves !'()* alone and would produce a canonical request the server disagrees with.
  it("percent-encodes AWS's way, not encodeURIComponent's", () => {
    expect(uriEncode("-_.~")).toBe("-_.~");
    expect(uriEncode("!'()*")).toBe("%21%27%28%29%2A");
    expect(uriEncode("a/b")).toBe("a%2Fb");
    expect(uriEncode("a/b", false)).toBe("a/b");
    expect(uriEncode(" ")).toBe("%20");
    expect(uriEncode("é")).toBe("%C3%A9"); // encoded per UTF-8 byte
  });

  const base = {
    method: "PUT",
    host: "acct.r2.cloudflarestorage.com",
    path: "/vault-store/index.vault",
    payloadSha256: "a".repeat(64),
    credentials: { accessKeyId: "AKID", secretAccessKey: "secret", region: "auto", service: "s3" },
    now: new Date("2026-09-20T12:45:00Z"),
  };
  const sign = (over: Partial<typeof base> & { headers?: Record<string, string>; query?: Record<string, string> } = {}) =>
    signRequest({ ...base, ...over });

  it("scopes the credential to the date, auto and s3, and signs host and the x-amz pair", () => {
    const { headers, url } = sign();
    expect(url).toBe("https://acct.r2.cloudflarestorage.com/vault-store/index.vault");
    expect(headers.authorization).toContain("Credential=AKID/20260920/auto/s3/aws4_request");
    expect(headers.authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
    expect(headers["x-amz-date"]).toBe("20260920T124500Z");
    expect(headers["x-amz-content-sha256"]).toBe("a".repeat(64));
    expect(headers.host).toBeUndefined(); // fetch sets it from the URL and rejects it as a header
  });

  it("covers the conditional headers, so a compare-and-swap can't be stripped in flight", () => {
    const withIfMatch = sign({ headers: { "if-match": '"abc"' } });
    expect(withIfMatch.headers.authorization).toContain("SignedHeaders=host;if-match;x-amz-content-sha256;x-amz-date");
    expect(signature(withIfMatch.headers.authorization)).not.toBe(signature(sign({ headers: { "if-match": '"def"' } }).headers.authorization));
  });

  it("changes the signature when any signed input changes, and repeats it when none do", () => {
    const of = (o: Parameters<typeof sign>[0]) => signature(sign(o).headers.authorization);
    const baseline = of({});
    expect(of({})).toBe(baseline); // deterministic for a fixed clock
    expect(of({ method: "GET" })).not.toBe(baseline);
    expect(of({ path: "/vault-store/vault.json" })).not.toBe(baseline);
    expect(of({ payloadSha256: "b".repeat(64) })).not.toBe(baseline);
    expect(of({ query: { "list-type": "2" } })).not.toBe(baseline);
    expect(of({ now: new Date("2026-09-21T12:45:00Z") })).not.toBe(baseline);
    expect(of({ credentials: { ...base.credentials, secretAccessKey: "other" } })).not.toBe(baseline);
  });

  it("sorts the query string canonically", () => {
    expect(sign({ query: { prefix: "objects/", "list-type": "2" } }).url)
      .toBe("https://acct.r2.cloudflarestorage.com/vault-store/index.vault?list-type=2&prefix=objects%2F");
  });
});

const signature = (authorization: string) => /Signature=([0-9a-f]+)/.exec(authorization)![1];
