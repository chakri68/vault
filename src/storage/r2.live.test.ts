import { afterAll, describe, expect, it } from "vitest";
import { equalBytes, newId, randomBytes } from "@/crypto/bytes";
import { INDEX_PATH, objectPath, sidecarPath } from "@/vault/index-model";
import { isNotFound, isPreconditionFailed } from "./provider";
import { R2StorageProvider } from "./r2";

/**
 * The R2 adapter against a real bucket.
 *
 * Opt-in, because it needs credentials and it writes. Everything else about this
 * adapter is covered by fake-r2.ts, with one exception that matters: a fake
 * cannot tell you whether a SigV4 signature satisfies Cloudflare. Recomputing
 * the signature in the fake would only reproduce this signer's own mistakes.
 * That question has exactly one authority, and this is how you ask it.
 *
 *   R2_LIVE=1 \
 *   R2_ACCOUNT_ID=… R2_BUCKET=family-vault-test \
 *   R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
 *   npx vitest run src/storage/r2.live.test.ts
 *
 * Point it at a disposable bucket. It writes under `objects/<fresh uuid>` and
 * `index.vault`, and removes what it wrote — but a crashed run can leave files
 * behind, and `index.vault` is a real path that a real vault uses.
 */
const live =
  process.env.R2_LIVE === "1" &&
  !!process.env.R2_ACCOUNT_ID &&
  !!process.env.R2_BUCKET &&
  !!process.env.R2_ACCESS_KEY_ID &&
  !!process.env.R2_SECRET_ACCESS_KEY;

const provider = live
  ? new R2StorageProvider({
      accountId: process.env.R2_ACCOUNT_ID!,
      bucket: process.env.R2_BUCKET!,
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    })
  : null;

/** everything this run created, so it can be taken away again */
const written = new Set<string>();
const caught = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

afterAll(async () => {
  if (provider && written.size) await provider.deleteMany([...written]).catch(() => {});
});

describe.skipIf(!live)("R2 adapter, against a real bucket", () => {
  it("authenticates — the signature is accepted by Cloudflare", async () => {
    await provider!.connect();
  });

  it("round-trips bytes, and the version token is a usable unquoted ETag", async () => {
    const id = newId();
    const path = objectPath(id);
    written.add(path);

    const data = randomBytes(64 * 1024);
    const { version } = await provider!.put(path, data, { ifNoneMatch: "*" });
    expect(version).toMatch(/^[0-9a-f]{32}$/); // md5 hex, no quotes, not multipart
    const back = await provider!.get(path);
    expect(equalBytes(back.data, data)).toBe(true);
    expect(back.version).toBe(version);
  });

  it("enforces compare-and-swap in the bucket, not in this process", async () => {
    const path = INDEX_PATH;
    written.add(path);
    await provider!.delete(path); // a previous run may have left one

    const first = randomBytes(2048);
    const { version } = await provider!.put(path, first, { ifNoneMatch: "*" });

    expect(isPreconditionFailed(await caught(provider!.put(path, randomBytes(16), { ifNoneMatch: "*" })))).toBe(true);
    expect(isPreconditionFailed(await caught(provider!.put(path, randomBytes(16), { ifMatch: "0".repeat(32) })))).toBe(true);
    expect(equalBytes((await provider!.get(path)).data, first)).toBe(true); // neither loser wrote anything

    const second = randomBytes(2048);
    const next = await provider!.put(path, second, { ifMatch: version });
    expect(next.version).not.toBe(version);
    expect(equalBytes((await provider!.get(path)).data, second)).toBe(true);
    expect(isPreconditionFailed(await caught(provider!.put(path, randomBytes(16), { ifMatch: version })))).toBe(true);
  });

  it("lists by prefix and reports sizes", async () => {
    const id = newId();
    const paths = [objectPath(id, 0), objectPath(id, 1), sidecarPath(id)];
    for (const p of paths) {
      written.add(p);
      await provider!.put(p, randomBytes(1024), { ifNoneMatch: "*" });
    }
    const found = await provider!.list(`objects/${id}`);
    expect(found.map((f) => f.path).sort()).toEqual([...paths].sort());
    expect(found.every((f) => f.size === 1024)).toBe(true);
    expect(found.every((f) => !f.version.includes('"'))).toBe(true);
  });

  it("deletes many in one request, and a missing key is not a failure", async () => {
    const id = newId();
    const paths = [objectPath(id, 0), objectPath(id, 1), sidecarPath(id)];
    for (const p of paths) await provider!.put(p, randomBytes(256), { ifNoneMatch: "*" });

    await provider!.deleteMany(paths);
    expect(await provider!.list(`objects/${id}`)).toEqual([]);
    expect(isNotFound(await caught(provider!.get(paths[0])))).toBe(true);
    await provider!.delete(paths[0]); // already gone
  });
});
