import { describe, expect, it } from "vitest";
import { importAesKey } from "@/crypto/aes";
import { equalBytes, newId, randomBytes } from "@/crypto/bytes";
import { generateVmk } from "@/crypto/envelopes";
import { VaultEngine } from "@/vault/engine";
import { INDEX_PATH, objectPath, sidecarPath } from "@/vault/index-model";
import { MemoryLocalStore } from "@/vault/local-store";
import { ProviderRemote, deleteObjectFiles } from "@/vault/remote";
import { FakeGitHub } from "./fake-github";
import { GitHubStorageProvider } from "./github";
import { isNotFound, isPreconditionFailed, isStorageUnavailable } from "./provider";

type Bytes = Uint8Array<ArrayBuffer>;
const cfg = { token: "test-token", owner: "family", repo: "vault-store", branch: "main" };
const make = (gh = new FakeGitHub()) => ({ gh, provider: new GitHubStorageProvider(cfg, gh.fetch) });
const caught = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe("GitHub adapter, against an in-memory Git Data API", () => {
  it("bootstraps an empty repository, then reads back what it wrote", async () => {
    const { gh, provider } = make();
    await provider.connect();
    expect(await provider.list()).toEqual([]);

    const data = randomBytes(5000);
    const { version } = await provider.put("index.vault", data, { ifNoneMatch: "*" });
    const back = await provider.get("index.vault");
    expect(equalBytes(back.data, data)).toBe(true);
    expect(back.version).toBe(version);
    expect(gh.messages[0]).toBe("vault: initialise store");
  });

  it("compare-and-swap: a stale version loses, create-only refuses to overwrite", async () => {
    const { provider } = make();
    const v1 = (await provider.put("index.vault", randomBytes(100), { ifNoneMatch: "*" })).version;
    const v2 = (await provider.put("index.vault", randomBytes(100), { ifMatch: v1 })).version;
    expect(v2).not.toBe(v1);

    expect(isPreconditionFailed(await caught(provider.put("index.vault", randomBytes(100), { ifMatch: v1 })))).toBe(true);
    expect(isPreconditionFailed(await caught(provider.put("index.vault", randomBytes(100), { ifNoneMatch: "*" })))).toBe(true);
    expect(isPreconditionFailed(await caught(provider.put("vault.json", randomBytes(10), { ifMatch: "nothing-there" })))).toBe(true);
    expect((await provider.get("index.vault")).version).toBe(v2);
  });

  it("someone else commits between our read and our ref update: rebases onto their head, never forces", async () => {
    const { gh, provider } = make();
    const v1 = (await provider.put("index.vault", randomBytes(100), { ifNoneMatch: "*" })).version;

    // they touch a *different* file mid-flight: our write is still valid, and must land on top of theirs
    const theirId = newId();
    let raced = false;
    gh.beforeRefUpdate = () => { if (!raced) { raced = true; gh.commitDirectly(objectPath(theirId), Buffer.from("theirs")); } };
    const ours = randomBytes(100);
    await provider.put("index.vault", ours, { ifMatch: v1 });
    expect(equalBytes((await provider.get("index.vault")).data, ours)).toBe(true);
    expect(Buffer.from((await provider.get(objectPath(theirId))).data).toString()).toBe("theirs"); // their commit survived
    expect(gh.forcePushes).toBe(0);

    // they touch the *same* file mid-flight: now our precondition is false, and we must lose
    const v2 = (await provider.get("index.vault")).version;
    raced = false;
    gh.beforeRefUpdate = () => { if (!raced) { raced = true; gh.commitDirectly("index.vault", Buffer.from("their index")); } };
    expect(isPreconditionFailed(await caught(provider.put("index.vault", randomBytes(100), { ifMatch: v2 })))).toBe(true);
    expect(Buffer.from((await provider.get("index.vault")).data).toString()).toBe("their index");
    expect(gh.forcePushes).toBe(0);
  });

  it("serialises its own concurrent writes instead of racing itself", async () => {
    const { gh, provider } = make();
    await provider.put("vault.json", randomBytes(10));
    const ids = Array.from({ length: 6 }, newId);
    await Promise.all(ids.map((id) => provider.put(objectPath(id), randomBytes(200), { ifNoneMatch: "*" })));
    expect((await provider.list("objects/")).map((f) => f.path).sort()).toEqual(ids.map((id) => objectPath(id)).sort());
    expect(gh.requests.filter((r) => r.method === "PATCH").length).toBe(7); // one ref update each, no retries
  });

  it("reads files past the 1 MB contents-API limit through the blob API", async () => {
    const { gh, provider } = make();
    const id = newId();
    const big = randomBytes(2_500_000);
    await provider.put(objectPath(id), big, { ifNoneMatch: "*" });
    gh.requests.length = 0;
    expect(equalBytes((await provider.get(objectPath(id))).data, big)).toBe(true);
    expect(gh.requests.some((r) => r.path.startsWith("/git/blobs/"))).toBe(true);
  });

  it("deletes a document's files in one commit, and deleting what's gone is not an error", async () => {
    const { gh, provider } = make();
    const id = newId();
    for (const p of [objectPath(id), objectPath(id, 1), sidecarPath(id)]) await provider.put(p, randomBytes(50) as Bytes);
    const before = gh.messages.length;
    await deleteObjectFiles(provider, id);
    expect(await provider.list(`objects/${id}`)).toEqual([]);
    expect(gh.messages.length).toBe(before + 1);
    await provider.delete(objectPath(id)); // already gone
    expect(isNotFound(await caught(provider.get(objectPath(id))))).toBe(true);
  });

  it("refuses a public repository, a read-only token, and any path off the allowlist", async () => {
    const pub = make(); pub.gh.isPrivate = false;
    expect(isStorageUnavailable(await caught(pub.provider.connect()))).toBe(true);
    const ro = make(); ro.gh.canPush = false;
    expect(isStorageUnavailable(await caught(ro.provider.connect()))).toBe(true);

    const { provider } = make();
    for (const bad of ["../secrets", "objects/passport-mom.pdf.vault", "/etc/passwd", "objects/../vault.json", ".github/workflows/x.yml"]) {
      await expect(provider.put(bad, randomBytes(4))).rejects.toThrow("path not allowed");
    }
    expect(() => new GitHubStorageProvider({ ...cfg, repo: "vault/../../other" })).toThrow();
  });

  it("never puts a filename, a person or an object id in a commit message (§7.3)", async () => {
    const gh = new FakeGitHub();
    const vmk = await importAesKey(generateVmk());
    const engine = new VaultEngine({ remote: new ProviderRemote(new GitHubStorageProvider(cfg, gh.fetch)), local: new MemoryLocalStore(), vmk });
    await engine.open();
    const { ids } = await engine.addDocuments([{
      content: randomBytes(3000), extension: "pdf", mimeType: "application/pdf",
      meta: { name: "Passport — Mom", ownerProfileIds: [], tags: ["travel"], category: "identity" },
    }]);
    await engine.updateMeta(ids[0], { name: "Passport — Amma" });
    await engine.sync();
    await engine.deletePermanently(ids[0]);
    await engine.sync();

    const log = gh.messages.join("\n");
    for (const needle of ["Passport", "Mom", "Amma", "travel", "identity", "pdf", ids[0], ids[0].slice(0, 8)]) {
      expect(log.includes(needle), needle).toBe(false);
    }
    expect(new Set(gh.messages)).toEqual(new Set([
      "vault: initialise store", "vault: update index", "vault: add object", "vault: remove object",
    ]));
  });

  it("runs the whole engine: two devices, a conflict, a rebuild with the index gone", async () => {
    const gh = new FakeGitHub();
    const vmk = await importAesKey(generateVmk());
    const device = async () => {
      const e = new VaultEngine({ remote: new ProviderRemote(new GitHubStorageProvider(cfg, gh.fetch)), local: new MemoryLocalStore(), vmk });
      await e.open();
      return e;
    };
    const mom = await device();
    const content = randomBytes(40_000);
    const { ids, synced } = await mom.addDocuments([{ content, extension: "jpg", mimeType: "image/jpeg", meta: { name: "Aadhaar", ownerProfileIds: [], tags: [] } }]);
    expect(synced).toBe(true);

    const dad = await device();
    await Promise.all([mom.updateMeta(ids[0], { name: "Aadhaar — Mom" }), dad.updateMeta(ids[0], { tags: ["id"] })]);
    for (const e of [mom, dad]) for (let i = 0; i < 20 && !(await e.sync()); i++) await new Promise((r) => setTimeout(r, 20));

    const fresh = await device();
    expect(fresh.index.entries[ids[0]].name).toBe("Aadhaar — Mom");
    expect(fresh.index.entries[ids[0]].tags).toEqual(["id"]);
    expect(equalBytes((await fresh.fetchDocument(ids[0])).content, content)).toBe(true);

    await new GitHubStorageProvider(cfg, gh.fetch).delete(INDEX_PATH);
    const rebuilt = new VaultEngine({ remote: new ProviderRemote(new GitHubStorageProvider(cfg, gh.fetch)), local: new MemoryLocalStore(), vmk });
    await rebuilt.open().catch(() => {});
    expect(await rebuilt.rebuild()).toEqual({ recovered: 1, unreadable: 0 });
    expect(rebuilt.index.entries[ids[0]].name).toBe("Aadhaar — Mom");
    expect(gh.forcePushes).toBe(0);
  });
});
